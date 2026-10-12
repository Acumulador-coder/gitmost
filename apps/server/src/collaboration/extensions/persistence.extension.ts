import {
  afterUnloadDocumentPayload,
  Extension,
  onChangePayload,
  onDisconnectPayload,
  onLoadDocumentPayload,
  onStatelessPayload,
  onStoreDocumentPayload,
} from '@hocuspocus/server';
import * as Y from 'yjs';
import { Injectable, Logger } from '@nestjs/common';
import { TiptapTransformer } from '@hocuspocus/transformer';
import {
  flushPendingStore,
  getPageId,
  isEmptyParagraphDoc,
  jsonToText,
  tiptapExtensions,
} from '../collaboration.util';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageHistoryRepo } from '@docmost/db/repos/page/page-history.repo';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { executeTx } from '@docmost/db/utils';
import { InjectQueue } from '@nestjs/bullmq';
import { QueueJob, QueueName } from '../../integrations/queue/constants';
import { ProvenanceSource } from '../../core/auth/dto/jwt-payload';
import { Queue } from 'bullmq';
import {
  extractMentions,
  extractUserMentions,
} from '../../common/helpers/prosemirror/utils';
import { isDeepStrictEqual } from 'node:util';
import {
  IPageHistoryJob,
  IPageMentionNotificationJob,
} from '../../integrations/queue/constants/queue.interface';
import { Page } from '@docmost/db/types/entity.types';
import { CollabHistoryService } from '../services/collab-history.service';
import {
  EMBED_DEBOUNCE_MS,
  IDLE_INTERVAL_AGENT,
  IDLE_INTERVAL_USER,
  IDLE_MAX_WAIT_AGENT,
  IDLE_MAX_WAIT_USER,
  PageHistoryKind,
} from '../constants';
import { TransclusionService } from '../../core/page/transclusion/transclusion.service';
import {
  observeCollabLoad,
  observeCollabStore,
} from '../../integrations/metrics/metrics.registry';
import { hasTransclusionFamilyNodes } from '../../core/page/transclusion/utils/transclusion-prosemirror.util';
import { EnvironmentService } from '../../integrations/environment/environment.service';

/**
 * #251 — wire format of the client→server stateless message that signals a
 * deliberate page clear. The client (IntentionalClear editor extension) sends
 * `{ type: INTENTIONAL_CLEAR_MESSAGE_TYPE }`; the document is taken from the
 * connection, not the payload, so the signal cannot be aimed at another page.
 */
export const INTENTIONAL_CLEAR_MESSAGE_TYPE = 'intentional-clear';

/**
 * Wire format of the client→server "save a version" signal. Sent by the
 * human (Cmd+S / Save button) and by the agent's explicit save tool over the
 * SAME stateless channel. The intentionality tier ('manual' vs 'agent') is
 * derived SERVER-SIDE from the signed connection actor, never from this
 * payload, so a version's type is unforgeable. The document is taken from the
 * connection (not the payload), so the signal cannot be aimed at another page.
 */
export const SAVE_VERSION_MESSAGE_TYPE = 'save-version';

/**
 * Wire format of the server→client REPLY to a save-version signal, sent
 * over the same stateless channel. `version.saved` means a version was created or
 * promoted; `version.skipped` is a TERMINAL "nothing was pinned" reply for the two
 * reachable no-op cases (an effectively-empty page, or the page row is gone) so the
 * client resolves at once instead of waiting out its ack timeout and misreporting a
 * healthy server as unreachable. EXACTLY ONE of these is broadcast per handled
 * save. The MCP client duplicates these literals (it cannot import server code) —
 * keep the two in sync (see packages/mcp/src/lib/collaboration.ts).
 */
export const VERSION_SAVED_MESSAGE_TYPE = 'version.saved';
export const VERSION_SKIPPED_MESSAGE_TYPE = 'version.skipped';

/**
 * How long an intentional-clear signal stays "pending" before it is
 * ignored. The signal is set on the clearing keystroke but consumed by the
 * DEBOUNCED onStoreDocument, so the TTL must comfortably exceed the collab
 * store debounce window (hocuspocus is configured with maxDebounce = 45s in
 * collaboration.gateway.ts). 60s leaves a margin while keeping the window for a
 * stale flag small; on top of the TTL, any non-empty store immediately drops a
 * pending flag (see onStoreDocument), so a "cleared then retyped" sequence can
 * never leave a usable flag behind.
 *
 * Fail-safe limitation: the flag lives only in this node's process memory. If
 * document ownership moves to another node, or this node restarts, between the
 * stateless signal and the debounced store, the flag is lost and the clear is
 * NOT applied — the store-side empty-guard keeps the non-empty DB content.
 */
export const INTENTIONAL_CLEAR_TTL_MS = 60_000;

/**
 * Resolve the provenance source for a coalesced snapshot.
 *
 * The snapshot is tagged 'agent' if any agent edit landed in the coalescing
 * window (sticky marker) OR if the current writer is the agent; otherwise
 * 'user'. Pure so the §15 H2 marker logic is unit-testable in isolation.
 */
export function resolveSource(
  stickyTouched: boolean,
  contextActor?: string,
): ProvenanceSource {
  // An EXPLICIT current-write actor is authoritative for THIS write and wins
  // over the sticky-agent fallback. Order: explicit 'agent' > explicit
  // 'git-sync' > sticky agent marker > plain human 'user'. The git-sync case
  // must NOT be masked by the sticky marker, or the PageChangeListener
  // loop-guard (which keys on lastUpdatedSource === 'git-sync') would re-export
  // git-sync's own writes (#14). Explicit agent still wins so a window that
  // mixed an agent edit stays tagged 'agent'.
  if (contextActor === 'agent') return 'agent';
  if (contextActor === 'git-sync') return 'git-sync';
  if (stickyTouched) return 'agent';
  return 'user';
}

/**
 * Compute the BullMQ job id + delay for a page's trailing idle-flush
 * autosnapshot. Pure so the timing is unit-testable.
 *
 * Humans and the agent share one idle pipeline (intentional agent points arrive
 * via the explicit save-version signal). The job id is the bare `page.id`, so a
 * page has at most one pending idle job; the caller removes-and-re-adds it on
 * every store to keep it debounced to the trailing edge of an edit burst. The
 * window differs by source only: the agent flushes sooner than a human.
 */
export function computeHistoryJob(
  page: Pick<Page, 'id'>,
  source: string,
  // Epoch ms of the FIRST edit in the current burst (when the pending idle job
  // was first armed). Used to enforce the max-wait ceiling so a continuous
  // editing session cannot re-arm the trailing timer forever. `now` is injectable
  // for tests; both default to a live clock / no ceiling when omitted.
  burstStart?: number,
  now: number = Date.now(),
): { jobId: string; delay: number } {
  const isAgent = source === 'agent';
  const interval = isAgent ? IDLE_INTERVAL_AGENT : IDLE_INTERVAL_USER;
  const maxWait = isAgent ? IDLE_MAX_WAIT_AGENT : IDLE_MAX_WAIT_USER;

  let delay = interval;
  if (burstStart !== undefined) {
    // Time already elapsed since the burst's first edit; the snapshot must fire
    // no later than `maxWait` after that, so shrink the trailing delay to the
    // remaining budget (never negative, so BullMQ fires it promptly).
    const remaining = burstStart + maxWait - now;
    delay = Math.max(0, Math.min(interval, remaining));
  }
  return { jobId: page.id, delay };
}

@Injectable()
export class PersistenceExtension implements Extension {
  private readonly logger = new Logger(PersistenceExtension.name);
  private contributors: Map<string, Set<string>> = new Map();
  // Sticky agent-edit marker (§15 H2): a coalesced snapshot may mix human and
  // agent edits. We accumulate "an agent touched this document during the
  // coalescing window" per document and OR it across all edits in the window,
  // so the snapshot is marked 'agent' regardless of who wrote last.
  private agentTouched: Map<string, boolean> = new Map();
  // Epoch ms of the FIRST edit in the current idle-flush burst. Keyed by
  // documentName (not page.id) so it is cleaned in afterUnloadDocument with the
  // other per-document maps; otherwise pages that were never manually saved
  // would keep their entry forever. Set when the idle job is first armed, read
  // for the max-wait ceiling in computeHistoryJob, cleared on unload or when a
  // manual save cancels the idle job.
  //
  // Process-local, like `contributors` / `agentTouched`: a restart or an
  // ownership move loses the marker, so a session straddling it can wait up to
  // ~2× the cap for its idle snapshot. It only delays a safety-net
  // autosnapshot; manual saves are unaffected.
  private idleBurstStart: Map<string, number> = new Map();
  // #251 — per-document "intentional clear pending" flags. Keyed by
  // documentName, value = expiry timestamp (ms). Set by onStateless when the
  // client reports a deliberate clear; consumed once by the next
  // onStoreDocument empty-guard branch. This is the per-EDIT channel the
  // per-connection context cannot provide (a clear is an edit event, but the
  // store is debounced and connection context is fixed at authentication).
  private intentionalClear: Map<string, number> = new Map();
  // CO-5 — per-document context of the latest human/agent edit not yet stored.
  // Hocuspocus keeps ONE pending store per document and an immediate git-sync
  // store replaces it, so an edit that lands while git-sync writes would be
  // stored under the git-sync context: attributed to the service user and
  // skipped by the git-sync loop-guard (never exported). Set by onChange (git
  // writes carry no user, so they never set it), consumed by every store,
  // dropped on unload like the maps above.
  private lastEditContext: Map<string, any> = new Map();

  constructor(
    private readonly pageRepo: PageRepo,
    private readonly pageHistoryRepo: PageHistoryRepo,
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.AI_QUEUE) private aiQueue: Queue,
    @InjectQueue(QueueName.HISTORY_QUEUE) private historyQueue: Queue,
    @InjectQueue(QueueName.NOTIFICATION_QUEUE) private notificationQueue: Queue,
    private readonly collabHistory: CollabHistoryService,
    private readonly transclusionService: TransclusionService,
    private readonly environmentService: EnvironmentService,
  ) {}

  async onLoadDocument(data: onLoadDocumentPayload) {
    const { documentName, document } = data;
    const pageId = getPageId(documentName);

    // #402 — the early return below (live doc already non-empty) does NOT touch
    // the DB, so it is deliberately NOT timed. We only observe the real DB-load
    // work, and only on each real-load return, tagged by the loaded doc size.
    if (!document.isEmpty('default')) {
      return;
    }

    const startedAt = performance.now();
    const page = await this.pageRepo.findById(pageId, {
      includeContent: true,
      includeYdoc: true,
    });

    if (!page) {
      this.logger.warn('page not found');
      return;
    }

    // #401 fix 2 — apply the DB state DIRECTLY into the hook's target document
    // (`document` === `data.document`) and return undefined. When onLoadDocument
    // returns undefined, hocuspocus keeps the mutated hook document as-is; only
    // when the hook RETURNS a Y.Doc does hocuspocus re-`applyUpdate(document,
    // encodeStateAsUpdate(returned))` — a second full encode+apply of the whole
    // (e.g. 315KB) state on every cold load. Mutating in place performs a single
    // apply and avoids the throwaway `new Y.Doc()` allocation.
    if (page.ydoc) {
      this.logger.debug(`ydoc loaded from db: ${pageId}`);

      const dbState = new Uint8Array(page.ydoc);

      Y.applyUpdate(document, dbState);
      observeCollabLoad(dbState.length, (performance.now() - startedAt) / 1000);
      return;
    }

    // if no ydoc state in db convert json in page.content to Ydoc.
    if (page.content) {
      this.logger.debug(`converting json to ydoc: ${pageId}`);

      const ydoc = TiptapTransformer.toYdoc(
        page.content,
        'default',
        tiptapExtensions,
      );

      // Encode the converted doc once; the bytes serve both the size label and
      // the single apply into the hook document.
      const encoded = Y.encodeStateAsUpdate(ydoc);
      Y.applyUpdate(document, encoded);
      observeCollabLoad(
        encoded.byteLength,
        (performance.now() - startedAt) / 1000,
      );
      return;
    }

    // No persisted state: the hook document is already a fresh empty Y.Doc, so
    // leave it untouched and return undefined (no re-encode of an empty doc).
    this.logger.debug(`creating fresh ydoc: ${pageId}`);
    observeCollabLoad(0, (performance.now() - startedAt) / 1000);
    return;
  }

  /**
   * When the LAST editor disconnects, flush any pending (debounced) store to the
   * DB immediately instead of waiting out the `debounce` window. The collab
   * server runs with `unloadImmediately: false` (collaboration.gateway), so
   * Hocuspocus does not flush on a last-client disconnect; a quick edit-then-
   * close would leave the edit only in the in-memory Y.Doc while git-sync
   * mirrors the stale DB body to the vault.
   *
   * Only on the LAST disconnect (`clientsCount === 0`), only for a fully-loaded
   * doc, and only when a store is pending (`isDebounced`). `executeNow` runs the
   * SAME payload Hocuspocus scheduled (preserving the edit's context/actor) and
   * clears the timer.
   */
  async onDisconnect(data: onDisconnectPayload) {
    // Gated on git-sync: the flush exists for git-sync (the vault must not
    // mirror a stale DB body), and git-sync is fully inert when it is off, so
    // the debounced store keeps its stock behavior then.
    if (!this.environmentService.isGitSyncEnabled()) return;
    const { instance, document, documentName, clientsCount } = data;
    if (clientsCount > 0) return;
    if (!document || document.isLoading) return;
    try {
      await flushPendingStore(instance, documentName);
    } catch (err) {
      this.logger.error(
        `onDisconnect flush failed for ${documentName}: ` +
          (err instanceof Error ? err.message : String(err)),
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  async onStoreDocument(data: onStoreDocumentPayload) {
    // #355 — time the full store (persist + post-store side effects) into
    // collab_store_duration_seconds. #402 — also tag by document size bucket.
    // No-op when METRICS_PORT is unset.
    const startedAt = performance.now();
    // Default 0 so a throw before storeDocument returns still records a
    // (smallest-bucket) observation rather than dropping the timing entirely.
    let bytes = 0;
    try {
      bytes = await this.storeDocument(data);
    } finally {
      observeCollabStore(bytes, (performance.now() - startedAt) / 1000);
    }
  }

  /**
   * Persist the document. Returns the serialized ydoc byte size (used as the
   * store histogram's size_bucket). The single Y.encodeStateAsUpdate below is
   * the ONLY serialization — its byteLength is reused for the label (no second
   * encode).
   */
  private async storeDocument(data: onStoreDocumentPayload): Promise<number> {
    const { documentName, document, context } = data;

    const pageId = getPageId(documentName);

    const tiptapJson = TiptapTransformer.fromYdoc(document, 'default');

    const ydocState = Buffer.from(Y.encodeStateAsUpdate(document));

    let textContent = null;

    try {
      textContent = jsonToText(tiptapJson);
    } catch (err) {
      this.logger.warn('jsonToText' + err?.['message']);
    }

    let page: Page = null;
    const editingUserIds = this.consumeContributors(documentName);
    // CO-5 — who this store is attributed to. A git-sync store that also
    // carries a human/agent edit made since the last store (it replaced that
    // edit's pending store) is attributed to that edit's author, so the edit is
    // neither credited to the git-sync service user nor hidden from the git
    // export by the loop-guard. Every other store keeps its own context.
    const pendingEdit = this.consumeLastEditContext(documentName);
    const attribution =
      context?.actor === 'git-sync' && pendingEdit ? pendingEdit : context;
    // Sticky agent marker: 'agent' if any agent edit landed in this window, OR
    // if the current writer is the agent (covers a store with no prior onChange
    // agent event in the same window).
    // Provenance precedence: agent > git-sync > user (see resolveSource). A
    // 'git-sync' store is NOT given an immediate history snapshot — it is
    // debounced like a human edit (a git-sync write is a block-level merge into
    // the live doc, so it reads like an incremental human edit, not a bulk
    // import that would warrant its own immediate snapshot).
    const lastUpdatedSource = resolveSource(
      this.consumeAgentTouched(documentName),
      attribution?.actor,
    );
    // Consume the intentional-clear flag ONCE, before the retry loop.
    // consumeIntentionalClear always deletes the in-memory entry and a tx
    // rollback cannot restore it, so consuming inside the loop would turn a
    // retry into a BLOCKED write. Every store consumes the flag here regardless
    // of emptiness, so a non-empty store drops a pending flag (the
    // cleared-then-retyped case).
    const allowIntentionalClear = this.consumeIntentionalClear(documentName);
    // git-sync's explicit clear authorization (see the empty-guard below). It
    // covers exactly ONE store — the merge's own — so it is taken off the shared
    // direct-connection context here, once, before the retry loop; the same
    // connection's disconnect store then takes the normal empty-guard.
    const gitSyncClear = context?.gitSyncIntentionalClear === true;
    if (gitSyncClear) context.gitSyncIntentionalClear = false;

    // Persist with a small bounded retry. The in-memory Y.Doc is the only copy
    // of the latest edit until this hook returns: hocuspocus unloads the doc
    // right after onStoreDocument resolves (storeDocumentHooks' finally ->
    // unloadDocument), so a swallowed transient DB error would lose the edit.
    // On total failure `page` is cleared so the post-store side effects (badge
    // broadcast, history snapshot) never report a save that didn't happen.
    const MAX_STORE_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_STORE_ATTEMPTS; attempt++) {
      try {
        await executeTx(this.db, async (trx) => {
          page = await this.pageRepo.findById(pageId, {
            withLock: true,
            includeContent: true,
            trx,
          });

          if (!page) {
            this.logger.error(`Page with id ${pageId} not found`);
            return;
          }

          if (isDeepStrictEqual(tiptapJson, page.content)) {
            page = null;
            return;
          }

          // Store-side empty-guard: a momentarily-empty live Y.Doc (a
          // client/agent glitch, a bad merge, an emptied transclusion) must NOT
          // overwrite non-empty persisted content.
          //
          // The one legitimate empty-over-non-empty write is a user who
          // deliberately clears the page. That intent arrives out-of-band as a
          // stateless message and is read only on this empty-incoming branch, so
          // the worst a forged signal can do is clear a page the connection may
          // already edit. The flag was consumed once before the retry loop
          // (`allowIntentionalClear`).
          const incomingEmpty = isEmptyParagraphDoc(tiptapJson as any);
          // A git-sync store may clear the page ONLY with the explicit
          // `gitSyncIntentionalClear` context flag, which gitSyncWriteBody sets
          // when git's body is empty AND a non-empty merge base proves the file
          // was cleared in git (consumed above). The 'git-sync' actor alone is
          // not enough: an empty merge result without that proof (a stale export
          // merged into a new page) wiped live text, so every other git-sync
          // store takes the normal guard. Mirrors the #251 allowance.
          if (
            incomingEmpty &&
            page.content &&
            !isEmptyParagraphDoc(page.content as any)
          ) {
            if (allowIntentionalClear || gitSyncClear) {
              this.logger.debug(
                `Intentional clear for ${pageId}: persisting empty doc over ` +
                  `non-empty content (${gitSyncClear ? 'git-sync' : 'user-signalled'})`,
              );
              // fall through — the empty write is allowed.
            } else {
              this.logger.warn(
                `Skipping store for ${pageId}: empty live doc would overwrite ` +
                  `non-empty persisted content`,
              );
              page = null;
              return;
            }
          }

          let contributorIds = undefined;
          try {
            const existingContributors = page.contributorIds || [];
            contributorIds = Array.from(
              new Set([
                ...existingContributors,
                ...editingUserIds,
                page.creatorId,
              ]),
            );
          } catch (err) {
            //this.logger.debug('Contributors error:' + err?.['message']);
          }

          // Boundary snapshot on ANY source transition. When the store flips the
          // page's provenance (user↔agent↔git), pin the OUTGOING state as its own
          // history version before the incoming source overwrites it. `page`
          // still holds the old content/provenance here, so saveHistory(page)
          // captures it tagged with its own source, kind='boundary'. The incoming
          // content is snapshotted later by the idle job. Skip if the page is
          // effectively empty or the latest snapshot already equals this state
          // (isDeepStrictEqual). For git-sync this keeps a same-block human edit
          // lost to git recoverable (SPEC §9). A git-sync merge store attributed
          // to a pending human/agent edit is still a git merge over that
          // baseline, so it pins too.
          if (
            page.lastUpdatedSource &&
            (page.lastUpdatedSource !== lastUpdatedSource ||
              (context?.actor === 'git-sync' &&
                page.lastUpdatedSource !== 'git-sync'))
          ) {
            // pageHistory.pageId is uuid-typed; use page.id (never the doc-name
            // slugId) so a `page.<slugId>` doc cannot throw 22P02 here (#260).
            const lastHistory = await this.pageHistoryRepo.findPageLastHistory(
              page.id,
              { includeContent: true, trx },
            );
            const baselineMissing =
              !lastHistory ||
              !isDeepStrictEqual(lastHistory.content, page.content);
            if (!isEmptyParagraphDoc(page.content as any) && baselineMissing) {
              await this.pageHistoryRepo.saveHistory(page, {
                contributorIds: page.contributorIds ?? undefined,
                kind: 'boundary',
                trx,
              });
            }
          }

          await this.pageRepo.updatePage(
            {
              content: tiptapJson,
              textContent: textContent,
              ydoc: ydocState,
              lastUpdatedById: attribution.user.id,
              // Human stays the responsible author; these annotate the source.
              lastUpdatedSource,
              lastUpdatedAiChatId: attribution?.aiChatId ?? null,
              // The external-MCP api_key behind this content edit (null for a
              // human or the internal AI agent), threaded from the connection
              // context (set in authentication.extension). saveHistory copies it
              // onto every snapshot of this page.
              lastUpdatedApiKeyId: attribution?.apiKeyId ?? null,
              contributorIds: contributorIds,
            },
            pageId,
            trx,
          );

          this.logger.debug(`Page updated: ${pageId} - SlugId: ${page.slugId}`);
        });
        break;
      } catch (err) {
        this.logger.error(
          `Failed to update page ${pageId} (attempt ${attempt}/${MAX_STORE_ATTEMPTS})`,
          err,
        );
        // The write failed and rolled back; clear the partially-assigned `page`
        // so the post-store success branch below is skipped (no false "saved"
        // broadcast / history snapshot for content that was never persisted).
        page = null;
        if (attempt < MAX_STORE_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 50));
        }
      }
    }

    if (page) {
      document.broadcastStateless(
        JSON.stringify({
          type: 'page.updated',
          updatedAt: new Date().toISOString(),
          // Provenance for a future live badge; 'user' for human edits.
          source: lastUpdatedSource,
          lastUpdatedById: attribution?.user?.id,
          lastUpdatedBy: attribution?.user
            ? {
                id: attribution.user?.id,
                name: attribution.user?.name,
                avatarUrl: attribution.user?.avatarUrl,
              }
            : undefined,
        }),
      );

      // Use the canonical page UUID (page.id), not the doc-name id, which may be
      // a slugId for a `page.<slugId>` doc: the transclusion/reference syncs
      // write uuid-typed columns.
      //
      // Skip the three sync SELECTs when neither the new nor the previously
      // persisted content has any transclusion/reference/pageEmbed node:
      // nothing to insert, and (the DB mirrors the old content) nothing to
      // delete. Otherwise run the idempotent sync so removals are reconciled.
      if (
        hasTransclusionFamilyNodes(tiptapJson) ||
        hasTransclusionFamilyNodes(page.content)
      ) {
        await this.syncTransclusion(page.id, page.workspaceId, tiptapJson);
      }
    }

    if (page) {
      // Key contributors by the page UUID so they MATCH the PAGE_HISTORY job,
      // which is enqueued with page.id and pops contributors by page.id (#260).
      await this.collabHistory.addContributors(page.id, editingUserIds);

      const mentions = extractMentions(tiptapJson);

      const userMentions = extractUserMentions(mentions);
      const oldMentions = page.content ? extractMentions(page.content) : [];
      const oldMentionedUserIds = extractUserMentions(oldMentions).map(
        (m) => m.entityId,
      );

      // #348 — only enqueue when the mentioned-user set actually GAINED a member.
      // The processor (processPageMention) already no-ops when every current
      // mention was present before (newMentions.length === 0), so skipping the
      // enqueue in that case is behavior-identical and avoids piling up no-op jobs
      // on every save of a page that merely CONTAINS (unchanged) mentions.
      const oldMentionedUserIdSet = new Set(oldMentionedUserIds);
      const hasNewMentionedUser = userMentions.some(
        (m) => !oldMentionedUserIdSet.has(m.entityId),
      );

      if (hasNewMentionedUser) {
        await this.notificationQueue.add(QueueJob.PAGE_MENTION_NOTIFICATION, {
          userMentions: userMentions.map((m) => ({
            userId: m.entityId,
            mentionId: m.id,
            creatorId: m.creatorId,
          })),
          oldMentionedUserIds,
          // Canonical UUID, never the doc-name slugId (#260).
          pageId: page.id,
          spaceId: page.spaceId,
          workspaceId: page.workspaceId,
        } as IPageMentionNotificationJob);
      }

      await this.aiQueue.add(
        QueueJob.PAGE_CONTENT_UPDATED,
        {
          // Canonical UUID: the embedding reindex resolves pages by uuid, so a
          // slugId here threw Postgres 22P02 invalid-uuid (#260).
          pageIds: [page.id],
          workspaceId: page.workspaceId,
        },
        // #348 — coalesce re-embeds during active editing. A stable per-page
        // jobId + delay means repeated saves within EMBED_DEBOUNCE_MS collapse
        // to one delayed job instead of one expensive re-embed per save. The
        // worker reads the current page state at run time, so last content wins.
        // BullMQ forbids ':' in custom job ids (Redis key separator), so '-' is
        // used; page.id is a UUID, so the id is unique per page. removeOnComplete
        // (queue.module) frees the id after each run so the next window re-arms.
        { jobId: `embed-${page.id}`, delay: EMBED_DEBOUNCE_MS },
      );

      await this.enqueuePageHistory(page, documentName, lastUpdatedSource);
    }

    // #402 — report the serialized size for the store histogram's size_bucket.
    // ydocState is always computed above (there is no earlier no-write return in
    // this method), so this reflects the doc that was serialized this store.
    return ydocState.byteLength;
  }

  /**
   * Receive the client's deliberate-clear signal. Records a short-lived,
   * single-use pending flag for the originating document so the next
   * onStoreDocument may let one empty-over-non-empty write through the guard.
   *
   * Hardening: read-only connections cannot arm the flag, and the document is
   * taken from the connection (`data.documentName`), never the payload, so a
   * client cannot target a page it isn't editing. The flag only ever RELAXES
   * the guard for an empty write (a clear); it can never force or alter a
   * non-empty write, so it is not a guard bypass for normal content.
   */
  async onStateless(data: onStatelessPayload) {
    const { connection, documentName, payload } = data;

    if (connection?.readOnly) return;

    let message: { type?: string } | undefined;
    try {
      message = JSON.parse(payload);
    } catch {
      return; // unrelated / malformed stateless message
    }

    // #370 — explicit "save a version" (human Cmd+S / agent save tool). Edit
    // rights are already enforced by the readOnly reject above (a reader can't
    // create a version), exactly as intentional-clear requires.
    if (message?.type === SAVE_VERSION_MESSAGE_TYPE) {
      await this.handleSaveVersion(data);
      return;
    }

    if (message?.type !== INTENTIONAL_CLEAR_MESSAGE_TYPE) return;

    this.intentionalClear.set(
      documentName,
      Date.now() + INTENTIONAL_CLEAR_TTL_MS,
    );
  }

  /**
   * Persist an intentional version from the live in-memory ydoc.
   *
   * One stateless path serves BOTH the human and the agent; the tier is derived
   * SERVER-SIDE from the signed connection actor ('agent' → 'agent', anything
   * else → 'manual'), so the version type cannot be spoofed by the client. We
   * take the fresh ydoc from the collab process memory and run it through the
   * EXISTING store path first (so pages.content/ydoc reflect the exact content
   * being versioned — a REST endpoint would race the up-to-10s-stale page row),
   * then snapshot it into page_history with the intentional kind.
   *
   * Promote-not-dup: if the latest history row already holds this exact content
   * and it is an autosave (idle/boundary/legacy-null), upgrade its kind in place
   * instead of duplicating a heavy content row; if it is already 'manual', it is
   * a no-op (the client shows an "already saved" toast). Otherwise a fresh
   * version row is written, popping the aggregated contributors from Redis.
   */
  private async handleSaveVersion(data: onStatelessPayload): Promise<void> {
    const { connection, document, documentName } = data;
    const context = connection?.context;
    const pageId = getPageId(documentName);
    // Unforgeable: 'agent' only for a signed agent connection, else 'manual'.
    const kind: PageHistoryKind =
      context?.actor === 'agent' ? 'agent' : 'manual';

    // Flush the live ydoc through the normal store path so the page row + ydoc
    // hold exactly what we are about to version (also fires the idle enqueue we
    // supersede below, plus any source-transition boundary). onStoreDocument
    // only needs document/documentName/context.
    await this.onStoreDocument({
      document,
      documentName,
      context,
    } as onStoreDocumentPayload);

    let result:
      | { historyId: string; kind: PageHistoryKind; alreadySaved: boolean }
      | undefined;
    // #370 F2 — set when there is nothing to version (empty page / page gone), so
    // the tail broadcasts a terminal `version.skipped` instead of staying silent
    // and forcing the client to time out. Mutually exclusive with `result`.
    let skipped: 'empty' | 'page-not-found' | undefined;

    // The contributor set popped from Redis (destructive SPOP) must be restored
    // if the version row does not durably land. executeTx COMMITS after the
    // callback, so a commit abort rejects OUTSIDE the inner try/catch, after the
    // SPOP, while the INSERT rolls back; onStateless does not retry. Track the
    // popped set (keyed by the page UUID, never the doc-name id, which may be a
    // slugId) and restore it in the outer catch; addContributors is an
    // idempotent SADD. versionedPageId is also used below to remove the
    // superseded idle job by its jobId (page.id).
    let poppedForRestore: string[] = [];
    let versionedPageId: string | undefined;

    try {
      await executeTx(this.db, async (trx) => {
        const page = await this.pageRepo.findById(pageId, {
          withLock: true,
          includeContent: true,
          trx,
        });
        if (!page) {
          // The page row is gone (deleted/never persisted). Nothing to version —
          // record it so the tail sends a terminal skip reply (#370 F2).
          skipped = 'page-not-found';
          return;
        }
        versionedPageId = page.id;
        // Never version an effectively-empty page (mirrors the processor's
        // first-history guard); there is nothing intentional to pin. Record the
        // skip so the client gets a terminal reply rather than a timeout (#370 F2).
        if (isEmptyParagraphDoc(page.content as any)) {
          skipped = 'empty';
          return;
        }

        const lastHistory = await this.pageHistoryRepo.findPageLastHistory(
          page.id,
          { includeContent: true, trx },
        );

        if (
          lastHistory &&
          isDeepStrictEqual(lastHistory.content, page.content)
        ) {
          // Content is already snapshotted. Promote-not-dup.
          if (lastHistory.kind === 'manual') {
            result = {
              historyId: lastHistory.id,
              kind: 'manual',
              alreadySaved: true,
            };
            return;
          }
          await this.pageHistoryRepo.updateHistoryKind(
            lastHistory.id,
            kind,
            trx,
          );
          result = { historyId: lastHistory.id, kind, alreadySaved: false };
          return;
        }

        // Fresh version row. Pop the contributors aggregated since the last
        // snapshot (SPOP); restore them if the write fails so they aren't lost.
        const contributorIds = await this.collabHistory.popContributors(
          page.id,
        );
        poppedForRestore = contributorIds;
        try {
          const saved = await this.pageHistoryRepo.saveHistory(page, {
            contributorIds,
            kind,
            trx,
          });
          result = { historyId: saved.id, kind, alreadySaved: false };
        } catch (err) {
          await this.collabHistory.addContributors(page.id, contributorIds);
          poppedForRestore = [];
          throw err;
        }
      });
    } catch (err) {
      // A throw here means the tx did NOT commit (callback threw, or the commit
      // itself failed and rolled back). If we popped contributors and the inner
      // catch did not already restore them, restore now so attribution is not
      // lost — onStateless has no retry to recover it. Restore by the page UUID
      // the pop was keyed under (versionedPageId is always set before the pop).
      if (poppedForRestore.length && versionedPageId) {
        await this.collabHistory.addContributors(
          versionedPageId,
          poppedForRestore,
        );
      }
      throw err;
    }

    // Housekeeping: this explicit version supersedes the page's pending idle
    // autosnapshot, so cancel it and end the current idle burst so the next edit
    // starts a fresh max-wait window. Remove the idle job by its REAL jobId
    // (page.id UUID — computeHistoryJob arms it under page.id), not the raw
    // doc-name id which may be a slugId for a `page.<slugId>` doc (#260), or the
    // remove silently misses. The burst marker is keyed by documentName (like its
    // sibling per-document maps), and is also cleaned in afterUnloadDocument.
    if (versionedPageId) {
      await this.historyQueue.remove(versionedPageId).catch(() => undefined);
    }
    this.idleBurstStart.delete(documentName);

    // EXACTLY ONE terminal reply per handled save (#370 F2): a real save/promote
    // broadcasts `version.saved`; the two no-op early returns (empty page / page
    // gone) broadcast `version.skipped` so the client never waits out its ack
    // timeout. A genuine failure threw above and rejected before reaching here.
    if (result) {
      document.broadcastStateless(
        JSON.stringify({
          type: VERSION_SAVED_MESSAGE_TYPE,
          historyId: result.historyId,
          kind: result.kind,
          alreadySaved: result.alreadySaved,
        }),
      );
    } else if (skipped) {
      document.broadcastStateless(
        JSON.stringify({
          type: VERSION_SKIPPED_MESSAGE_TYPE,
          reason: skipped,
        }),
      );
    }
  }

  async onChange(data: onChangePayload) {
    const documentName = data.documentName;
    const userId = data.context?.user?.id;

    if (!userId) return;

    if (!this.contributors.has(documentName)) {
      this.contributors.set(documentName, new Set());
    }

    this.contributors.get(documentName).add(userId);

    // CO-5 — remember who made the latest not-yet-stored edit (see the map).
    this.lastEditContext.set(documentName, data.context);

    // Sticky agent marker: once an agent connection touches the document in the
    // coalescing window, keep it marked until the next snapshot consumes it.
    if (data.context?.actor === 'agent') {
      this.agentTouched.set(documentName, true);
    }
  }

  async afterUnloadDocument(data: afterUnloadDocumentPayload) {
    const documentName = data.documentName;
    this.contributors.delete(documentName);
    this.agentTouched.delete(documentName);
    this.intentionalClear.delete(documentName);
    this.lastEditContext.delete(documentName);
    // #370 — drop the idle-burst marker with the other per-document maps so it
    // cannot accumulate across the process lifetime for never-manually-saved
    // pages. The pending idle job (if any) is a self-expiring BullMQ delayed job.
    this.idleBurstStart.delete(documentName);
  }

  private consumeContributors(documentName: string): string[] {
    const contributorSet = this.contributors.get(documentName);
    if (!contributorSet) return [];
    const userIds = [...contributorSet];
    this.contributors.delete(documentName);
    return userIds;
  }

  /** Read and clear the context of the latest not-yet-stored edit (CO-5). */
  private consumeLastEditContext(documentName: string): any {
    const editContext = this.lastEditContext.get(documentName);
    this.lastEditContext.delete(documentName);
    return editContext;
  }

  /** Read and clear the sticky agent-touched flag for this coalescing window. */
  private consumeAgentTouched(documentName: string): boolean {
    const touched = this.agentTouched.get(documentName) ?? false;
    this.agentTouched.delete(documentName);
    return touched;
  }

  /**
   * #251 — read and clear the intentional-clear flag for this document. Returns
   * true only if a flag was pending AND still within its TTL. Always deletes the
   * entry so the signal is strictly single-use (one clear → one allowed empty
   * write); an expired flag is treated as absent (guard still blocks).
   */
  private consumeIntentionalClear(documentName: string): boolean {
    const expiry = this.intentionalClear.get(documentName);
    this.intentionalClear.delete(documentName);
    return expiry !== undefined && Date.now() < expiry;
  }

  private async enqueuePageHistory(
    page: Page,
    documentName: string,
    lastUpdatedSource: string,
  ): Promise<void> {
    // Trailing idle debounce with a max-wait ceiling. One pending idle job per
    // page (jobId = page.id); every store removes the pending delayed job and
    // re-adds it, so the snapshot lands `delay` after edits go quiet. remove()
    // on a delayed job deletes it (0 if absent, no throw); if the job is already
    // ACTIVE, the add de-dups and the processor's isDeepStrictEqual gate
    // collapses duplicate content.
    //
    // The FIRST arm of a burst records `burstStart`; computeHistoryJob shrinks
    // the delay to the remaining max-wait budget. A marker older than THIS
    // TIER's max-wait means the previous idle job already fired — start a fresh
    // window. It must be the same source-specific max-wait computeHistoryJob
    // uses (agent 5m / user 10m): a user ceiling would leave an agent burst's
    // marker stale for 5..10m and force delay=0 (one idle row per store).
    const maxWait =
      lastUpdatedSource === 'agent' ? IDLE_MAX_WAIT_AGENT : IDLE_MAX_WAIT_USER;
    const now = Date.now();
    // Keyed by documentName (see the map declaration) so afterUnloadDocument can
    // clean it; the queue jobId stays page.id (computeHistoryJob) as required.
    let burstStart = this.idleBurstStart.get(documentName);
    if (burstStart === undefined || now - burstStart >= maxWait) {
      burstStart = now;
      this.idleBurstStart.set(documentName, burstStart);
    }

    const { jobId, delay } = computeHistoryJob(
      page,
      lastUpdatedSource,
      burstStart,
      now,
    );

    // Remove-then-add resets the timer to the trailing edge of the burst. Race:
    // if the delayed job goes ACTIVE between these two awaits, remove() is a
    // no-op (BullMQ won't remove a locked job) and add() with the existing jobId
    // is dropped, so this store re-arms nothing. The next store re-arms a fresh
    // job, and isDeepStrictEqual collapses duplicates; only edits after the job
    // went active in the LAST store of a session get no trailing snapshot until
    // the next edit (manual save and source-transition boundaries still cover
    // them).
    //
    // Do not unify with the embed debounce above (aiQueue.add of
    // PAGE_CONTENT_UPDATED): that one uses a stable jobId and no remove(),
    // relying on BullMQ coalescing, because a re-embed only needs to run once
    // eventually. This one removes-then-adds to push the delay back on every
    // store (a true debounce), which coalescing cannot do.
    await this.historyQueue.remove(jobId).catch(() => undefined);

    await this.historyQueue.add(
      QueueJob.PAGE_HISTORY,
      { pageId: page.id, kind: 'idle' } as IPageHistoryJob,
      { jobId, delay },
    );
  }

  /**
   * Refresh `page_transclusions` and `page_transclusion_references` to match
   * the page's current content. Runs outside the page-write transaction and
   * isolates each call so a failure here cannot affect the page save itself.
   * The diff is idempotent — the next save converges if a round drops anything.
   */
  private async syncTransclusion(
    pageId: string,
    workspaceId: string,
    tiptapJson: unknown,
  ): Promise<void> {
    try {
      await this.transclusionService.syncPageTransclusions(
        pageId,
        workspaceId,
        tiptapJson,
      );
    } catch (err) {
      this.logger.error(
        { err, pageId },
        'Failed to sync transclusions for page',
      );
    }
    try {
      await this.transclusionService.syncPageReferences(
        pageId,
        workspaceId,
        tiptapJson,
      );
    } catch (err) {
      this.logger.error(
        { err, pageId },
        'Failed to sync transclusion references for page',
      );
    }
    try {
      await this.transclusionService.syncPageTemplateReferences(
        pageId,
        workspaceId,
        tiptapJson,
      );
    } catch (err) {
      this.logger.error(
        { err, pageId },
        'Failed to sync page template references for page',
      );
    }
  }
}
