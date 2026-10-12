import { Injectable, Logger } from '@nestjs/common';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import {
  PageEmbeddingRepo,
  PageEmbeddingChunkRow,
} from '@docmost/db/repos/ai-chat/page-embedding.repo';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { InjectKysely } from 'nestjs-kysely';
import { executeTx } from '@docmost/db/utils';
import { AiService } from '../../../integrations/ai/ai.service';
import { EmbeddingGenerationService } from '../../../integrations/ai/embedding-generation.service';
import { EmbeddingReindexProgressService } from '../../../integrations/ai/embedding-reindex-progress.service';
import { AiEmbeddingNotConfiguredException } from '../../../integrations/ai/ai-embedding-not-configured.exception';
import {
  describeProviderError,
  isFatalProviderError,
} from '../../../integrations/ai/ai-error.util';
import { jsonToText } from '../../../collaboration/collaboration.util';

// NOTE: the `page_embeddings.embedding` column is now dimension-agnostic
// (bare pgvector `vector`, see migration 20260617T140000), so the indexer
// stores WHATEVER dimension the configured model returns and records it per row
// in `model_dimensions`. There is no fixed-dimension guard any more; search
// compares only same-dimension rows. Trade-off: a dimension-agnostic column has
// no ANN index, so retrieval is a seq scan with `<=>` (fine at wiki scale).

// RecursiveCharacterTextSplitter settings. ~1000 chars per chunk with 200 char
// overlap is a reasonable default for prose retrieval (§6.7 stage D).
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;

// A single page taking longer than this during a bulk reindex is logged at
// WARN as an early "slow page" signal. There is no per-page cap: each embeddings
// request (at most 32 chunks) is bounded by AI_EMBEDDING_TIMEOUT_MS.
const SLOW_PAGE_MS = 30_000;

/**
 * A bulk reindex run finished, but SOME pages failed to embed (a TEI timeout, a
 * 429/500, a poison page). The target generation has holes, so the pointer is not
 * flipped (see runReindex) and the workspace stays in the swap window — ~2x the
 * pgvector rows, `semantic.state: 'stale'`, and on a MODEL change lexical-only
 * search.
 *
 * Thrown out of the run so BullMQ fails the job and RETRIES it with backoff (the
 * reindex jobs are enqueued with `attempts: 3` + exponential backoff — the AI_QUEUE
 * default is `attempts: 1`, so every enqueue site sets it explicitly). A retry is
 * safe: the start GC keeps [active, target] and the per-page replace is
 * fingerprint-scoped, so a re-run re-writes the same rows and re-attempts the
 * failed pages. After the last attempt the job stays failed and the old
 * generation keeps serving with coverage `stale`.
 */
export class PartialReindexError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly failed: number,
    readonly total: number,
  ) {
    super(
      `Partial reindex for workspace ${workspaceId}: ${failed}/${total} page(s) failed ` +
        `to embed, so the target generation is incomplete and the active generation ` +
        `was NOT flipped. Retrying the run (it is idempotent).`,
    );
    this.name = 'PartialReindexError';
  }
}

/**
 * Vector-RAG indexer (§6.7 stage D / §14[M1]). Turns a page's plain text into
 * chunk embeddings and persists them so the `semanticSearch` agent tool can do
 * cosine ANN retrieval.
 *
 * Everything is workspace-scoped. Reindex HARD-replaces a page's rows (delete +
 * insert in one transaction) so search never serves stale vectors.
 */
@Injectable()
export class EmbeddingIndexerService {
  private readonly logger = new Logger(EmbeddingIndexerService.name);

  constructor(
    private readonly pageRepo: PageRepo,
    private readonly pageEmbeddingRepo: PageEmbeddingRepo,
    private readonly aiService: AiService,
    private readonly reindexProgress: EmbeddingReindexProgressService,
    private readonly generation: EmbeddingGenerationService,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  /**
   * (Re)build the embeddings for a single page.
   *
   * No-ops quietly when embeddings are unconfigured (so the queue never dies on
   * an unconfigured workspace). Any embedding dimension is accepted; the only
   * defensive skip is a page whose chunks somehow yield mixed vector lengths.
   * Deleted/empty pages have their rows purged and return.
   *
   * New rows are always written with the TARGET fingerprint (the live config's).
   * The delete half of the delete+insert replace is FINGERPRINT-SCOPED while a
   * swap is in flight, so an edit during a reindex never removes the page's
   * still-served ACTIVE-generation rows.
   *
   * `activeFingerprint` lets the bulk run pass the pointer it resolved ONCE, so a
   * 1000-page run does not re-read the workspace settings 1000 times. The
   * event-driven single-page path (page edited/created) omits it and resolves it
   * itself.
   *
   * Returns the number of chunk rows written (0 = purged / no-op / unconfigured) —
   * the bulk run counts the pages that really produced a chunk, which is the
   * coverage denominator recorded at the flip.
   */
  async reindexPage(
    pageId: string,
    activeFingerprint?: string,
  ): Promise<number> {
    const page = await this.pageRepo.findById(pageId, {
      includeContent: true,
      includeTextContent: true,
    });

    if (!page) {
      // The page row is gone; nothing references its embeddings to delete by
      // workspace, and the FK cascade already removed them. Nothing to do.
      this.logger.debug(`reindexPage: page ${pageId} not found, skipping`);
      return 0;
    }

    const { workspaceId, spaceId } = page;

    // Deleted page -> drop its embeddings and stop. UNSCOPED on purpose: a page
    // that no longer exists must vanish from EVERY generation, including the one
    // currently being served.
    if (page.deletedAt) {
      await this.pageEmbeddingRepo.deleteByPage(pageId, workspaceId);
      return 0;
    }

    // Prefer heading-breadcrumb chunks: each chunk is prefixed with its heading
    // path ("Page Title > H1 > H2") so the breadcrumb is embedded AND stored in
    // `content`. Walk the
    // ProseMirror JSON — NOT the markdown text — so a `#` inside a fenced code
    // block is never mistaken for a heading. Degrades to the plain-text path on
    // any error / unknown structure (returns null).
    const breadcrumbChunks = page.content
      ? await this.safeBuildBreadcrumbChunks(page.content, page.title)
      : null;

    // Fall back to plain text when breadcrumb chunking is unavailable.
    const fallbackText =
      breadcrumbChunks && breadcrumbChunks.length > 0
        ? null
        : this.extractText(page);

    // Empty page (neither path produced content) -> remove any prior embeddings
    // so search returns nothing. UNSCOPED (like the deleted-page purge): a page
    // with no content must not be served from ANY generation.
    if (
      (!breadcrumbChunks || breadcrumbChunks.length === 0) &&
      (!fallbackText || fallbackText.trim().length === 0)
    ) {
      await this.pageEmbeddingRepo.deleteByPage(pageId, workspaceId);
      return 0;
    }

    // Resolve the embeddings provider WITHOUT crashing the queue when
    // unconfigured. #530: resolveEmbeddingProvider prefers the workspace provider
    // and falls back to the GLOBAL env provider (TEI sidecar), and yields the
    // doc-prefix + the active fingerprint stored per row so search filters by the
    // active generation.
    let provider: Awaited<ReturnType<AiService['resolveEmbeddingProvider']>>;
    try {
      provider = await this.aiService.resolveEmbeddingProvider(workspaceId);
    } catch (err) {
      if (err instanceof AiEmbeddingNotConfiguredException) {
        // No embeddings provider for this workspace: NO-OP (§6.7). The page can
        // be indexed later once a provider is configured.
        this.logger.debug(
          `reindexPage: embeddings not configured for workspace ${workspaceId}, skipping page ${pageId}`,
        );
        return 0;
      }
      throw err;
    }

    // #599: the fingerprint the NEW rows carry is always the live config's (the
    // TARGET generation). Resolve the ACTIVE pointer to decide the delete scope
    // below (the bulk run supplies it, so it is read once per run, not per page).
    // The model id is recorded per row (provenance) AND at the flip, so a reader can
    // tell whether the served generation's rows share the query's embedding space.
    const targetFingerprint = provider.fingerprint;
    const modelName = provider.modelId;
    const active =
      activeFingerprint ??
      (
        await this.generation.generationForTarget(
          workspaceId,
          targetFingerprint,
          modelName,
        )
      ).active;

    // Use breadcrumb chunks when available; otherwise chunk the plain text.
    let chunks: string[];
    if (breadcrumbChunks && breadcrumbChunks.length > 0) {
      chunks = breadcrumbChunks;
    } else {
      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: CHUNK_SIZE,
        chunkOverlap: CHUNK_OVERLAP,
      });
      chunks = await splitter.splitText(fallbackText as string);
    }
    if (chunks.length === 0) {
      await this.pageEmbeddingRepo.deleteByPage(pageId, workspaceId);
      return 0;
    }

    // #530: prepend the provider's DOC prefix to each chunk (e5-style
    // "passage: "; empty for a non-e5 provider) so stored vectors live in the
    // same prefixed space as a prefixed query, then embed with the RESOLVED
    // provider model (which may be the global TEI sidecar, not a workspace one).
    const prefixedChunks = provider.docPrefix
      ? chunks.map((c) => provider.docPrefix + c)
      : chunks;
    const vectors = await this.aiService.embedWithModel(
      provider.model,
      workspaceId,
      prefixedChunks,
    );

    // The column is dimension-agnostic, so ANY model dimension is stored as-is.
    // Defensive sanity check only: all chunks of ONE page come from the SAME
    // model and must share a dimension. A page that yields mixed lengths would
    // poison the per-dimension search filter, so skip it with a warning rather
    // than insert inconsistent rows.
    const expectedDim = vectors[0]?.length;
    if (expectedDim != null) {
      const mixed = vectors.find((v) => v.length !== expectedDim);
      if (mixed) {
        this.logger.warn(
          `reindexPage: mixed embedding dimensions (${expectedDim} vs ${mixed.length}) ` +
            `for workspace ${workspaceId}; skipping page ${pageId}.`,
        );
        return 0;
      }
    }

    const rows = this.buildChunkRows(
      chunks,
      vectors,
      { pageId, workspaceId, spaceId },
      modelName,
      targetFingerprint,
    );

    // HARD replace in one transaction: delete then insert so search never returns
    // stale vectors for this page.
    //
    // During a swap the delete is scoped to the generation being rewritten (the
    // target): the page's ACTIVE rows are what search still serves. Outside a swap
    // active === target and the scope is dropped, so the replace also reclaims the
    // page's rows from any other generation (notably legacy NULL-fingerprint rows).
    const deleteScope =
      active === targetFingerprint ? undefined : [targetFingerprint];

    await executeTx(this.db, async (trx) => {
      await this.pageEmbeddingRepo.deleteByPage(
        pageId,
        workspaceId,
        trx,
        deleteScope,
      );
      await this.pageEmbeddingRepo.insertChunks(rows, trx);
    });

    this.logger.debug(
      `reindexPage: indexed ${rows.length} chunk(s) for page ${pageId}`,
    );
    return rows.length;
  }

  /**
   * (Re)build embeddings for the EMBEDDABLE page set of a workspace — the set
   * countEmbeddablePages counts (getEmbeddablePageIds / `embeddablePredicate`):
   * non-empty textContent, OR ProseMirror `content` JSON with at least one text
   * node, OR an already-stored embedding row (so a page that lost its text is
   * visited and its stale rows cleared). Iterating this set keeps the live
   * `total` equal to the steady-state denominator. Used by the bulk reindex
   * (WORKSPACE_CREATE_EMBEDDINGS: AI Search enabled, or "Reindex now").
   *
   * Skips the whole batch when no embeddings provider is configured. Pages are
   * processed sequentially, each isolated in try/catch.
   *
   * The run owns a fingerprint transition, in this order:
   *
   *   1. pin the TARGET (the live config's fingerprint) and read the ACTIVE
   *      pointer. Every row the run writes carries the target, and the pointer may
   *      only ever be flipped ONTO it.
   *   2. GC at the START: keep {active, target} only — reclaims older generations,
   *      legacy NULL-fingerprint rows, and the partial output of a superseded run.
   *      Idempotent.
   *   3. reindex every embeddable page into the TARGET generation. The active
   *      generation keeps serving search meanwhile, at the cost of a transient ~2x
   *      pgvector footprint (documented on deleteOtherGenerations).
   *   4. ATOMIC FLIP, only after zero failures AND only if the config still
   *      resolves to this run's target (EmbeddingGenerationService.completeRun). A
   *      fatal provider abort throws before this line. If the config moved on
   *      mid-run, completeRun throws StaleReindexTargetError and the BullMQ retry
   *      builds the new target — the enqueue from that config change was deduped
   *      against this run, so the retry is the only thing that builds it.
   *
   * Legacy NULL-fingerprint rows take the same path: the first run writes the
   * workspace under the target fingerprint, flips, and the GC reclaims the NULLs.
   *
   * The WHOLE run is serialised per workspace by a Postgres advisory lock
   * (EmbeddingGenerationService.runExclusive). The BullMQ jobId dedupe is not
   * enough: a stalled job is re-dispatched while the original still runs, and two
   * overlapping runs destroy each other's generations. A second run skips.
   */
  async reindexWorkspace(workspaceId: string): Promise<void> {
    const ran = await this.generation.runExclusive(workspaceId, () =>
      this.runReindex(workspaceId),
    );
    if (!ran) {
      this.logger.warn(
        `reindexWorkspace: another reindex run is already in flight for workspace ` +
          `${workspaceId}; skipping this one (its work is being done by the run that ` +
          `holds the lock).`,
      );
    }
  }

  /** The body of a reindex run; always executed under the per-workspace run lock. */
  private async runReindex(workspaceId: string): Promise<void> {
    // #599 (review F2) — the instant this run STARTED, recorded with the coverage
    // numbers at the flip. It is what lets the coverage rule tell the pages this run
    // measured from the pages that appeared/changed afterwards, so the run's frozen
    // chunk-less gap can never excuse a brand-new un-embedded page. Taken BEFORE the
    // first page is read (not at the flip): a page edited mid-run must land on the
    // "changed since" side, or its re-embedding would be excused by a measurement
    // that never saw it.
    const coverageAt = new Date();

    // The whole run is wrapped so the per-workspace progress record is ALWAYS
    // cleared in the finally — on success, on a fatal-provider abort, on an
    // unconfigured early-return, or on any unexpected throw — so a failed run
    // never leaves a stuck "reindexing" state (the status then falls back to the
    // steady-state DB coverage count). A placeholder record may already exist
    // (seeded at enqueue time); the finally cleans that too.
    try {
      // #530: resolve via the same path reindexPage uses (workspace provider, else
      // the global TEI sidecar) so a global-only deployment is NOT skipped.
      // #599: its fingerprint is this run's TARGET generation.
      let targetFingerprint: string;
      let targetModel: string;
      try {
        const provider =
          await this.aiService.resolveEmbeddingProvider(workspaceId);
        targetFingerprint = provider.fingerprint;
        // Recorded with the pointer at the flip: it is what lets a reader detect a
        // MODEL change (a different embedding space) as opposed to a mere
        // revision/prefix change (the same space) — #599 D2.
        targetModel = provider.modelId;
      } catch (err) {
        if (err instanceof AiEmbeddingNotConfiguredException) {
          this.logger.log(
            `reindexWorkspace: embeddings not configured for workspace ${workspaceId}, skipping`,
          );
          return;
        }
        throw err;
      }

      // The pointer the readers currently serve (== target on a fresh instance,
      // i.e. no swap window). Read ONCE and threaded into every reindexPage call.
      const { active, swapping } = await this.generation.generationForTarget(
        workspaceId,
        targetFingerprint,
        targetModel,
      );

      // GC at the START of the swap: at most 2 generations survive — the one being
      // served and the one being built (cap 2, acceptance 5). Idempotent.
      await this.generation.gcGenerations(
        workspaceId,
        Array.from(new Set([active, targetFingerprint])),
      );

      if (swapping) {
        this.logger.log(
          `reindexWorkspace: fingerprint swap for workspace ${workspaceId}: ` +
            `active=${active} -> target=${targetFingerprint} (old generation keeps serving search until the flip)`,
        );
      }

      // Iterate the EMBEDDABLE set (same predicate as countEmbeddablePages), not
      // every non-deleted page, so `total` equals the steady-state denominator and
      // the live counter climbs 0 -> total. See reindexWorkspace for the set.
      const pageIds = await this.pageRepo.getEmbeddablePageIds(workspaceId);
      const total = pageIds.length;
      const startedAt = Date.now();
      // Publish the live run progress over this same set (done reset to 0). The
      // counter increments once per iterated page and reaches exactly `total`,
      // which equals countEmbeddablePages — the steady-state denominator.
      await this.reindexProgress.start(workspaceId, total);
      this.logger.log(
        `reindexWorkspace: starting reindex of ${total} page(s) for workspace ${workspaceId}`,
      );

      let failed = 0;
      // Pages that really produced >= 1 chunk. This — NOT the raw embeddable count
      // — is the coverage denominator recorded at the flip: a page whose only
      // content is a math block / an image passes the (optimistic) embeddable
      // predicate but yields no chunk, so counting it would keep the coverage state
      // pinned at `stale` forever (#599).
      let produced = 0;
      for (let i = 0; i < total; i++) {
        const pageId = pageIds[i];
        const position = i + 1;
        // Log BEFORE the await: if the embedding call hangs, this is the last line
        // in the log and it names the exact page that is stuck.
        this.logger.log(
          `reindexWorkspace: [${position}/${total}] indexing page ${pageId} (workspace ${workspaceId})`,
        );
        const pageStartedAt = Date.now();
        try {
          // Rows are written under the TARGET fingerprint; `active` is passed so
          // the per-page replace scopes its delete correctly during a swap.
          const chunks = await this.reindexPage(pageId, active);
          if (chunks > 0) produced++;
          // Count this page as processed (matches the [position/total] log).
          await this.reindexProgress.increment(workspaceId);
          const elapsed = Date.now() - pageStartedAt;
          if (elapsed >= SLOW_PAGE_MS) {
            this.logger.warn(
              `reindexWorkspace: [${position}/${total}] page ${pageId} took ${elapsed}ms`,
            );
          }
        } catch (err) {
          // A fatal provider error (invalid/missing key, no credits) recurs
          // identically on EVERY remaining page. Abort the whole batch instead of
          // issuing hundreds of doomed requests against the provider. Do NOT count
          // it as processed — the run aborts here (the finally clears progress).
          if (isFatalProviderError(err)) {
            this.logger.error(
              `reindexWorkspace: aborting at [${position}/${total}] for workspace ` +
                `${workspaceId} — fatal provider error, remaining pages would fail ` +
                `identically: ${describeProviderError(err)}`,
            );
            throw err;
          }
          // Per-page isolation: one non-fatal failure (incl. an embedding timeout)
          // must not abort the whole batch. A handled failure still advances the
          // counter (matches the [position/total] log, so done reaches total).
          failed++;
          await this.reindexProgress.increment(workspaceId);
          this.logger.error(
            `reindexWorkspace: [${position}/${total}] failed to reindex page ${pageId} ` +
              `after ${Date.now() - pageStartedAt}ms: ${describeProviderError(err)}`,
          );
        }
      }

      this.logger.log(
        `reindexWorkspace: done for workspace ${workspaceId}: ` +
          `${total - failed}/${total} indexed, ${failed} failed in ${Date.now() - startedAt}ms`,
      );

      // A run with ANY failed page is not a full reindex: the TARGET generation has
      // holes. Flipping would let the post-flip GC (keep = [target]) destroy the old
      // generation, including the only rows of the failed pages, and coverage would
      // report `full`. So no flip: the old generation keeps serving, coverage stays
      // `stale`, and the run THROWS so BullMQ retries it with backoff (the per-page
      // replace is fingerprint-scoped, so a re-run is idempotent). After the job's
      // `attempts` the workspace stays in this safe state.
      if (failed > 0) {
        this.logger.warn(
          `reindexWorkspace: NOT flipping the active generation for workspace ` +
            `${workspaceId}: ${failed}/${total} page(s) failed, so the target ` +
            `generation ${targetFingerprint} is incomplete. The previous generation ` +
            `(${active}) keeps serving search and semantic.state stays 'stale'. ` +
            `Failing the job so it is RETRIED (the run is idempotent).`,
        );
        throw new PartialReindexError(workspaceId, failed, total);
      }

      // The run completed IN FULL. ONE settings write moves the active pointer onto
      // the target and records `produced` (pages that really produced a chunk),
      // `total` (pages the run considered embeddable) and `coverageAt` (run start)
      // — only if the config STILL resolves to this run's target. On a flip
      // completeRun also GCs the superseded generation.
      //
      // When the config did move on, completeRun THROWS StaleReindexTargetError and
      // the throw is left to propagate: the BullMQ retry re-resolves the provider
      // and builds the current target. The reindex the config change tried to
      // enqueue was de-duplicated against this job, so nothing else would.
      await this.generation.completeRun({
        workspaceId,
        target: targetFingerprint,
        targetModel,
        coverageTotal: produced,
        coverageEmbeddable: total,
        coverageAt,
      });
    } finally {
      // Always remove the progress record so the status reverts to the DB count.
      await this.reindexProgress.clear(workspaceId);
    }
  }

  /** Purge ALL embeddings for a workspace (WORKSPACE_DELETE_EMBEDDINGS). */
  async removeWorkspace(workspaceId: string): Promise<void> {
    await this.pageEmbeddingRepo.deleteByWorkspace(workspaceId);
  }

  /** Remove all embeddings for a deleted page (used by the delete path). */
  async removePage(pageId: string, workspaceId: string): Promise<void> {
    await this.pageEmbeddingRepo.deleteByPage(pageId, workspaceId);
  }

  /**
   * Get the page's plain text. Prefers the stored `textContent`; falls back to
   * extracting text from the ProseMirror JSON `content` when textContent is
   * absent (e.g. older rows).
   */
  private extractText(page: {
    textContent?: string | null;
    content?: unknown;
  }): string {
    if (typeof page.textContent === 'string' && page.textContent.length > 0) {
      return page.textContent;
    }
    if (page.content) {
      try {
        return jsonToText(page.content as never) ?? '';
      } catch {
        return '';
      }
    }
    return '';
  }

  /**
   * Map chunk strings + vectors to insertable rows. Breadcrumb-prefixed chunks
   * are NOT verbatim substrings of any source text, so chunkStart is a running
   * cumulative offset (sum of previous chunk lengths) rather than an indexOf
   * position. These offsets are informational provenance only — search returns
   * `content` and never slices by offset. chunkIndex stays a global monotonic
   * index.
   */
  private buildChunkRows(
    chunks: string[],
    vectors: number[][],
    ids: { pageId: string; workspaceId: string; spaceId: string },
    modelName: string,
    fingerprint: string | null,
  ): PageEmbeddingChunkRow[] {
    const rows: PageEmbeddingChunkRow[] = [];
    let cursor = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = vectors[i];
      if (!embedding) continue;
      const chunkStart = cursor;
      cursor += chunk.length;
      rows.push({
        pageId: ids.pageId,
        workspaceId: ids.workspaceId,
        spaceId: ids.spaceId,
        // Page-body chunk: no attachment.
        attachmentId: null,
        chunkIndex: i,
        chunkStart,
        chunkLength: chunk.length,
        content: chunk,
        // Provenance for a future re-index sweep on model change.
        modelName,
        modelDimensions: embedding.length,
        // #530: the active generation fingerprint this row belongs to.
        fingerprint,
        embedding,
      });
    }
    return rows;
  }

  /**
   * Thin try/catch wrapper around buildBreadcrumbChunks. Any failure (malformed
   * structure, unknown node type, etc.) returns null so the caller degrades
   * gracefully to the plain-text chunking path.
   */
  private async safeBuildBreadcrumbChunks(
    contentJson: unknown,
    pageTitle: string | null,
  ): Promise<string[] | null> {
    try {
      return await this.buildBreadcrumbChunks(contentJson, pageTitle);
    } catch {
      return null;
    }
  }

  /**
   * Build heading-breadcrumb chunks by walking the ProseMirror JSON document.
   *
   * Each section (the body following a heading) is split with the same 1000/200
   * RecursiveCharacterTextSplitter, and every resulting piece is prefixed with
   * its heading path ("Page Title > H1 > H2"). Walking the JSON — not markdown
   * text — means a `#` inside a fenced code block is never treated as a heading
   * (ProseMirror heading nodes are explicit).
   *
   * Returns null when `contentJson` is not an object with an array `content`, so
   * the caller falls back to plain-text chunking.
   */
  private async buildBreadcrumbChunks(
    contentJson: unknown,
    pageTitle: string | null,
  ): Promise<string[] | null> {
    const doc = contentJson as { content?: unknown };
    if (
      typeof contentJson !== 'object' ||
      contentJson === null ||
      !Array.isArray(doc.content)
    ) {
      return null;
    }

    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: CHUNK_SIZE,
      chunkOverlap: CHUNK_OVERLAP,
    });

    const out: string[] = [];
    const stack: { level: number; text: string }[] = [];
    let buffer = '';

    // Flush the accumulated body as one or more chunks under the CURRENT crumb.
    const flush = async (): Promise<void> => {
      if (buffer.trim().length === 0) {
        buffer = '';
        return;
      }
      const crumb = [pageTitle, ...stack.map((s) => s.text)]
        .filter((s) => typeof s === 'string' && s.trim().length > 0)
        .join(' > ');
      const pieces = await splitter.splitText(buffer);
      for (const piece of pieces) {
        out.push(crumb ? `${crumb}\n\n${piece}` : piece);
      }
      buffer = '';
    };

    let processed = 0;
    for (const block of doc.content as Array<{
      type?: string;
      attrs?: { level?: number };
    }>) {
      // Hand the event loop back every 100 blocks: this loop is CPU-bound and
      // its awaits resolve as microtasks, so on a giant page health checks, HTML
      // and collab traffic would otherwise wait until the whole page is chunked.
      if (++processed % 100 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (block?.type === 'heading') {
        // Flush the preceding body under the crumb in effect BEFORE this
        // heading, then update the heading stack.
        await flush();
        const level =
          typeof block.attrs?.level === 'number' ? block.attrs.level : 1;
        // Pop deeper-or-equal headings: a new H2 replaces a prior H2/H3/...
        while (stack.length > 0 && stack[stack.length - 1].level >= level) {
          stack.pop();
        }
        const headingText = jsonToText({
          type: 'doc',
          content: [block],
        } as never).trim();
        if (headingText.length > 0) {
          stack.push({ level, text: headingText });
        }
      } else {
        const blockText = jsonToText({
          type: 'doc',
          content: [block],
        } as never);
        buffer = buffer.length > 0 ? `${buffer}\n${blockText}` : blockText;
      }
    }

    // Flush any trailing body after the last heading.
    await flush();

    return out;
  }
}
