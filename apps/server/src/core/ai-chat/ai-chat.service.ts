import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { FastifyReply } from 'fastify';
import {
  streamText,
  generateText,
  convertToModelMessages,
  stepCountIs,
  type UIMessage,
  type ModelMessage,
  type LanguageModel,
  type PrepareStepResult,
} from 'ai';
import { AiService } from '../../integrations/ai/ai.service';
import { AiSettingsService } from '../../integrations/ai/ai-settings.service';
import { describeProviderError } from '../../integrations/ai/ai-error.util';
import { AiChatRepo } from '@docmost/db/repos/ai-chat/ai-chat.repo';
import { AiChatMessageRepo } from '@docmost/db/repos/ai-chat/ai-chat-message.repo';
import { AiChatRunStepRepo } from '@docmost/db/repos/ai-chat/ai-chat-run-step.repo';
import { AiChatPageSnapshotRepo } from '@docmost/db/repos/ai-chat/ai-chat-page-snapshot.repo';
import { AiChatPageBindingRepo } from '@docmost/db/repos/ai-chat/ai-chat-page-binding.repo';
import { AiAgentRoleRepo } from '@docmost/db/repos/ai-agent-roles/ai-agent-roles.repo';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageAccessService } from '../page/page-access/page-access.service';
import {
  User,
  Workspace,
  AiChatMessage,
  AiAgentRole,
} from '@docmost/db/types/entity.types';
import {
  AiChatToolsService,
  type ViewImageCache,
  type ViewImageCacheEntry,
} from './tools/ai-chat-tools.service';
import { McpClientsService } from './external-mcp/mcp-clients.service';
import {
  MCP_FAILURES_CAP,
  MCP_FAILURE_REASON_MAX,
} from './external-mcp/mcp.constants';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { AiChatStreamRegistryService } from './ai-chat-stream-registry.service';
import { buildSystemPrompt } from './ai-chat.prompt';
import {
  CORE_TOOL_KEYS,
  CORE_TOOL_SET,
  LOAD_TOOLS_NAME,
  makeLoadToolsTool,
  buildExternalToolCatalog,
} from './tools/tool-tiers';
import {
  RunAlreadyActiveError,
  AiChatRunService,
} from './ai-chat-run.service';
import { inAppToolCallCapMs } from './tools/ai-chat-tools.service';
import { computePageChange } from './page-change/page-change.util';
import {
  sanitizeSelection,
  type SelectionContext,
} from './tools/current-page.util';
import { roleModelOverride } from './roles/role-model-config';
import {
  resolveReplayBudget,
  resolveEffectiveReplayThreshold,
  isContextOverflowError,
  trimHistoryForReplay,
} from './history-budget';
import {
  startSseHeartbeat,
  stripStreamingHopByHopHeaders,
} from './sse-resilience';
import {
  isDegenerateOutput,
  truncateDegeneratedTail,
  shouldCheckDegeneration,
} from './output-degeneration';
import { incAiChatBindSkipped } from '../../integrations/metrics/metrics.registry';

// Max agent steps per turn. One step = one model generation; a step that calls
// tools is followed by another step carrying the tool results. Raised from 8 so
// multi-search research questions are not cut off mid-investigation, then from 20
// to 50 (#444) so read-heavy turns (e.g. dozens of searchInPage sweeps) do not
// exhaust the budget before acting.
const MAX_AGENT_STEPS = 50;

// How many steps before the LAST one the step-budget warning starts firing
// (#444). At MAX-STEP_BUDGET_WARNING_LEAD .. MAX-2 the model is told to stop
// exploring and start acting, with the remaining count decreasing each step; the
// last step (MAX-1) has its own final nudge / lockdown instead (see
// prepareAgentStep).
const STEP_BUDGET_WARNING_LEAD = 6;

// Wall-clock ceiling for building the external MCP toolset in the per-turn setup
// phase (before streamText owns the lifecycle). A backstop above the per-server
// CONNECT_TIMEOUT_MS in mcp-clients.service: servers connect concurrently, so the
// per-server bound normally fires first; this only catches a total build stall.
const MCP_TOOLSET_BUILD_DEADLINE_MS = 60_000;

// System-prompt addendum injected ONLY on the final step (see prepareAgentStep).
// It forbids further tool calls and tells the model to synthesize the best
// answer it can from what it already gathered, so a tool-heavy turn never ends
// empty.
const FINAL_STEP_INSTRUCTION =
  'You have reached the maximum number of tool-use steps for this turn. ' +
  'Do NOT call any more tools. Using only the information already gathered, ' +
  "write the most complete, useful final answer you can now, in the user's " +
  'language. If the information is incomplete, say so explicitly: summarize ' +
  'what you found, what is still missing, and give your best partial conclusion.';

// Soft final-step nudge, used when the final-step lockdown toggle is OFF (the
// default). Unlike FINAL_STEP_INSTRUCTION it leaves toolChoice untouched, so the
// model is never forced into a tool-less state mid-work; it only asks for a final
// text summary.
const FINAL_STEP_NUDGE =
  'This is the LAST step of this turn. Write your final answer to the user now.\n' +
  'You may still call tools, but the turn ends after this step either way —\n' +
  'prefer finishing with a clear text summary of what was done and what remains.';

// Synthetic marker appended in onFinish when a step-exhausted turn produced no
// text at all, so the exhausted-without-answer state is explicit to the user and,
// on replay, to the model. Not localized: it is stored verbatim in the assistant
// row's `content` and replayed as-is, so it stays a plain English sentence.
const STEP_LIMIT_NO_ANSWER_MARKER =
  '(Step limit reached — no final answer was produced; the work may be ' +
  'unfinished. Reply "continue" to let the agent carry on.)';

// Reason recorded in ai_chat_runs.error / the assistant row when the token-
// degeneration detector (#444) aborts a run. Distinct from a user Stop (no error)
// and from a server restart ('streaming' -> swept to 'aborted' with no message).
const OUTPUT_DEGENERATION_ERROR =
  'Output degeneration detected (repeated token loop)';

// Prefix recorded on the assistant row when the provider rejected the turn for
// CONTEXT OVERFLOW (#490): the replayed history exceeded the model's window. The
// row is ALSO stamped `metadata.replayOverflowCount` (the consecutive-overflow
// counter, #520) so the NEXT turn's budgeter trims with escalating aggression (the
// reactive recovery — the overflowing turn had no usage signal to trigger
// preventive trimming, so the classified 400 is what un-bricks it).
export const CONTEXT_OVERFLOW_ERROR_PREFIX =
  'Диалог превысил контекстное окно модели; история будет агрессивно ' +
  'сокращена на следующем ходу.';

/**
 * Compute the step-budget warning text, or '' when this step is outside the
 * warning band. The warning fires on steps
 * MAX_AGENT_STEPS-STEP_BUDGET_WARNING_LEAD .. MAX_AGENT_STEPS-2 (not the last
 * step, which has its own final nudge/lockdown). `N` is the number of tool-use
 * steps still remaining (`MAX_AGENT_STEPS - 1 - stepNumber`). Pure.
 */
export function stepBudgetWarning(stepNumber: number): string {
  const isLastStep = stepNumber >= MAX_AGENT_STEPS - 1;
  const inBand = stepNumber >= MAX_AGENT_STEPS - STEP_BUDGET_WARNING_LEAD;
  if (isLastStep || !inBand) return '';
  const remaining = MAX_AGENT_STEPS - 1 - stepNumber;
  return (
    `Only ${remaining} tool-use steps remain in this turn. Stop exploring and start acting now\n` +
    '(make the edits / create the comments / produce results). Leave room to finish\n' +
    'with a final text answer.'
  );
}

// Pure: decide per-step overrides.
//   1. Final step, by `finalStepLockdownEnabled`:
//      - ON: force a text-only answer (toolChoice 'none' + FINAL_STEP_INSTRUCTION);
//        this takes precedence over the deferred-tool narrowing below.
//      - OFF (default): toolChoice is untouched, tools stay available on the last
//        step; FINAL_STEP_NUDGE is appended to `system` and the `activeTools`
//        narrowing still applies.
//   2. Step-budget warning: on steps in the warning band (not the last) append
//      stepBudgetWarning(...) to `system`.
//   3. Deferred tool visibility: when `deferredEnabled`, expose only the CORE
//      tools + loadTools + whatever loadTools has activated (`activatedTools`) via
//      `activeTools`. Deferred tools stay in the <tool_catalog> until loaded.
//
// `system` is concatenated, because a bare per-step `system` override replaces the
// whole system prompt. `activatedTools` is a Set grown by loadTools and owned by
// the streaming loop; this function only reads it.
//
// At AI SDK v7 the per-step `system` field is renamed to `instructions`; on v6
// (`^6.0.134`) `system` is correct.
export function prepareAgentStep(
  stepNumber: number,
  system: string,
  activatedTools: ReadonlySet<string> | readonly string[] = [],
  deferredEnabled = false,
  finalStepLockdownEnabled = false,
):
  | { toolChoice: 'none'; system: string }
  | { activeTools: string[]; system?: string }
  | { system: string }
  | undefined {
  const isLastStep = stepNumber >= MAX_AGENT_STEPS - 1;

  // Legacy final-step lockdown (toggle ON): text-only synthesis. WINS over the
  // deferred narrowing AND drops tools for this step.
  if (isLastStep && finalStepLockdownEnabled) {
    return {
      toolChoice: 'none',
      system: `${system}\n\n${FINAL_STEP_INSTRUCTION}`,
    };
  }

  // Compute the extra system text for this step: the soft final nudge on the last
  // step (toggle OFF), or the step-budget warning in the warning band. At most one
  // of these applies (stepBudgetWarning returns '' on the last step).
  const extra = isLastStep ? FINAL_STEP_NUDGE : stepBudgetWarning(stepNumber);
  const systemForStep = extra ? `${system}\n\n${extra}` : undefined;

  // Deferred tool loading: narrow this step's visible tools to CORE + loadTools +
  // the tools already activated this turn. Applies on EVERY step incl. the last
  // (toggle OFF), so the model keeps its core tools available while being nudged
  // to finish. Return `system` alongside `activeTools` when we have extra text.
  if (deferredEnabled) {
    const activated = Array.isArray(activatedTools)
      ? activatedTools
      : [...activatedTools];
    const activeTools = [...CORE_TOOL_KEYS, LOAD_TOOLS_NAME, ...activated];
    return systemForStep ? { activeTools, system: systemForStep } : { activeTools };
  }

  // Deferred OFF: all tools stay active; only append the extra system text (if any).
  return systemForStep ? { system: systemForStep } : undefined;
}

export {
  MAX_AGENT_STEPS,
  STEP_BUDGET_WARNING_LEAD,
  FINAL_STEP_INSTRUCTION,
  FINAL_STEP_NUDGE,
  STEP_LIMIT_NO_ANSWER_MARKER,
  OUTPUT_DEGENERATION_ERROR,
};

// #588: the fixed instruction that accompanies an injected viewImage image so the
// model knows the following image part is the one it just requested.
const VIEW_IMAGE_INJECT_TEXT =
  'Below is the image from your viewImage call. Assess it.';

/**
 * Build the ephemeral user-role message that carries a viewImage image to the
 * model. v6 image-part shape is `{ type:'image', image:<base64>, mediaType }`
 * (the field is `mediaType`, NOT `mimeType`). It is injected via prepareStep's
 * `messages` override for the current step only and never persisted
 * (buildStepParts reads step.toolResults, not `messages`).
 */
export function userImageMessage(img: ViewImageCacheEntry): ModelMessage {
  return {
    role: 'user',
    content: [
      { type: 'text', text: VIEW_IMAGE_INJECT_TEXT },
      { type: 'image', image: img.data, mediaType: img.mediaType },
    ],
  };
}

/**
 * Has the model produced assistant text on a step AFTER the step containing
 * `toolCallId`? Used to evict a viewImage cache entry: once the model has spoken
 * about the image it is no longer re-injected (and re-billed) on every step.
 * Returns false while the call is not yet among the finished steps, so the image
 * keeps being injected until a genuine text step follows. Pure.
 */
export function modelSpokeAboutItAfter(
  toolCallId: string,
  steps: ReadonlyArray<StepLike> | undefined,
): boolean {
  if (!steps || steps.length === 0) return false;
  let callIdx = -1;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const inCalls = (s.toolCalls ?? []).some(
      (c) => c.toolCallId === toolCallId,
    );
    const inContent = (s.content ?? []).some(
      (p) =>
        (p.type === 'tool-call' || p.type === 'tool-result') &&
        p.toolCallId === toolCallId,
    );
    if (inCalls || inContent) {
      callIdx = i;
      break;
    }
  }
  if (callIdx === -1) return false;
  for (let i = callIdx + 1; i < steps.length; i++) {
    if ((steps[i].text ?? '').trim().length > 0) return true;
  }
  return false;
}

/**
 * Build the per-step `messages` override that injects every still-live cached
 * viewImage image as an ephemeral trailing user message, and evict any entry the
 * model has already spoken about (see modelSpokeAboutItAfter). Returns `base`
 * (prepareAgentStep's {activeTools|toolChoice|system}) with `messages` added, so a
 * toolChoice:'none' lockdown step still carries the image; returns `base`
 * unchanged when there is nothing to inject. Mutates `cache` (eviction).
 */
export function injectViewImages(
  base: ReturnType<typeof prepareAgentStep>,
  opts: {
    messages: ReadonlyArray<ModelMessage>;
    steps: ReadonlyArray<StepLike> | undefined;
  },
  cache: ViewImageCache,
): PrepareStepResult {
  if (cache.size === 0) return base;
  const injected: ModelMessage[] = [];
  for (const [toolCallId, img] of cache) {
    injected.push(userImageMessage(img));
    // Evict AFTER queuing this step's injection (inject-then-delete): the step
    // whose prepareStep first observes "the model has spoken" still gets the image
    // once more (never starve the synthesis step), then future steps skip it.
    if (modelSpokeAboutItAfter(toolCallId, opts.steps)) cache.delete(toolCallId);
  }
  if (injected.length === 0) return base;
  return {
    ...(base ?? {}),
    messages: [...opts.messages, ...injected],
  };
}

// Pure, unit-testable post-processing for a model-generated title (#199): trim
// whitespace, strip a single pair of surrounding quotes the model often adds,
// drop a trailing period, and hard-cap the length to the page-title column.
export function cleanGeneratedTitle(text: string): string {
  return text
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\.+$/, '')
    .trim()
    .slice(0, 255);
}

/**
 * Pure: is THIS turn an interrupt-resume, i.e. does it directly follow a user
 * interruption of the previous assistant turn? The client "send now" flag is only
 * a hint, confirmed against history so a spoofed/stale flag cannot inject the
 * interrupt note onto an ordinary turn.
 *
 * `history` is oldest -> newest with the just-inserted user row as its tail. True
 * only when the client said so AND the preceding assistant turn ended unfinished:
 * 'aborted', or still 'streaming' (onAbort has not finalized it yet).
 */
export function isInterruptResume(
  history: Array<{
    role: string;
    status?: string | null;
    metadata?: unknown;
  }>,
  clientInterrupted: boolean | undefined,
): boolean {
  if (clientInterrupted !== true) return false;
  const prev = history[history.length - 2];
  if (prev?.role !== 'assistant') return false;
  // #487: a reconcile STAMP (metadata.finalizeFailed) is NOT a genuine user
  // interruption — the previous turn's process died and a reconcile settled the
  // row as 'aborted'. Treating it as an interrupt-resume would inject a false
  // "you were interrupted" note. Exclude any finalizeFailed row.
  const meta = prev.metadata as { finalizeFailed?: unknown } | null | undefined;
  if (meta && meta.finalizeFailed === true) return false;
  return prev.status === 'aborted' || prev.status === 'streaming';
}

/**
 * Whether two timestamps refer to the SAME instant (#274 page-change fast path).
 * The snapshot's `pageUpdatedAt` comes back from Postgres as a Date, the live
 * page's `updatedAt` is a Date too; compare by epoch millis so a value that
 * round-tripped through the driver as a string still matches. Either side
 * missing => treat as different (fall through to the diff, never a false skip).
 */
export function sameInstant(
  a: Date | string | null | undefined,
  b: Date | string | null | undefined,
): boolean {
  if (a == null || b == null) return false;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return false;
  return ta === tb;
}

/**
 * Race `work` against an abort signal AND a wall-clock deadline, so a hung
 * external-MCP toolset build during the pre-streamText setup phase can NEITHER
 * wedge the turn NOR make it un-stoppable, and the run always finalizes. It
 *  - resolves with `work`'s value when it settles first;
 *  - REJECTS EARLY if `signal` aborts (with `signal.reason` when that is an Error,
 *    else a generic `Error('aborted')`) — so an explicit Stop is honored mid-setup;
 *  - REJECTS EARLY if `deadlineMs` elapses (defense-in-depth backstop);
 *  - invokes `onLateResolve(value)` when `work` settles AFTER the race was already
 *    lost, so the caller can release any resources that abandoned value owns
 *    (e.g. close leased MCP clients that would otherwise leak their sockets).
 *
 * A rejection handler is attached to `work` so a late rejection is never an
 * unhandledRejection; the timer is unref'd and cleared once the race settles.
 */
export function raceAgainstAbortAndTimeout<T>(
  work: Promise<T>,
  signal: AbortSignal,
  deadlineMs: number,
  onLateResolve?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        signal.reason instanceof Error ? signal.reason : new Error('aborted'),
      );
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`setup timed out after ${deadlineMs}ms`));
    }, deadlineMs);
    // Do not keep the process alive just for this setup-deadline timer.
    timer.unref?.();
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    work.then(
      (value) => {
        if (settled) {
          // The race was already lost (abort/deadline): hand the abandoned value to
          // the caller so it can release the resources that value owns.
          onLateResolve?.(value);
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (err: unknown) => {
        // A late rejection after the race is already handled — swallow so it is
        // never an unhandledRejection.
        if (settled) return;
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * Payload accepted from the client `useChat` POST body. We do NOT bind a strict
 * DTO (the global ValidationPipe whitelist would strip the useChat-specific
 * fields), so this is a loose shape parsed straight off `req.body`.
 */
export interface AiChatStreamBody {
  chatId?: string;
  // The agent role selected by the client. Honoured ONLY when creating a new
  // chat (no valid chatId) — it is persisted to ai_chats.role_id and is
  // immutable afterwards. For existing chats the role is read from the chat row,
  // never from this field, so it cannot be swapped per-turn.
  roleId?: string | null;
  // The page the user is currently viewing (client-supplied), or null on a
  // non-page route. Used ONLY as prompt context so the agent knows what "this
  // page" refers to; the page itself is never fetched server-side here. The id
  // is attacker-controllable but harmless: the agent reads/writes via its
  // CASL-enforced page tools, which 403 on a page the user cannot access.
  //
  // `selection` is the user's editor selection snapshotted client-side at send
  // time. It is CLIENT-controlled and UNTRUSTED (the body is parsed without a DTO);
  // `sanitizeSelection` type-checks and caps it before the model sees it.
  openPage?: { id?: string; title?: string; selection?: unknown } | null;
  // Set by the client "send now" action (#198): this turn immediately follows a
  // user interruption of the previous turn. A hint only — the server re-confirms
  // it against persisted history (`isInterruptResume`) before injecting the
  // interrupt note, so a spoofed/stale flag on an ordinary turn is ignored.
  interrupted?: boolean;
  // #487: server-side supersede CAS. When present, this POST asks the server to
  // STOP the run `supersede.runId` (which the client saw as the chat's active run)
  // and, once it has settled, start THIS turn in its place. The server validates
  // the target against the chat and answers 400 (wrong chat) / 409
  // SUPERSEDE_TARGET_MISMATCH / 409 SUPERSEDE_TIMEOUT, or proceeds normally
  // (degrade / ready). Absent => an ordinary send (rejected with 409
  // A_RUN_ALREADY_ACTIVE if a run is already active on the chat).
  supersede?: { runId?: string } | null;
  // useChat sends the full UIMessage list; the last one is the new user turn.
  messages?: UIMessage[];
}

/**
 * Optional run-lifecycle hooks. When supplied, the turn is wrapped in a
 * server-side RUN: `begin` is called once the chat id is known and returns the
 * run's AbortSignal (decoupled from the HTTP socket), and the lifecycle callbacks
 * persist the run's progress and terminal status. Absent => the turn is bound to
 * the caller's `signal` and `runId` is undefined (only test harnesses omit it).
 */
export interface AiChatRunHooks {
  // Called once the chat id is resolved; returns the run handle whose `signal`
  // drives the agent loop's abort. Returning null disables run tracking (the
  // turn falls back to the passed-in socket signal).
  begin(chatId: string): Promise<{ runId: string; signal: AbortSignal } | null>;
  onAssistantSeeded?(
    runId: string,
    assistantMessageId: string,
  ): Promise<void> | void;
  onStep?(runId: string, stepCount: number): void;
  onSettled?(
    runId: string,
    status: 'completed' | 'error' | 'aborted',
    error?: string,
  ): Promise<void> | void;
}

export interface AiChatStreamArgs {
  user: User;
  workspace: Workspace;
  sessionId: string;
  body: AiChatStreamBody;
  res: FastifyReply;
  signal: AbortSignal;
  // Run-lifecycle hooks (#184). When present the turn becomes a detached,
  // durable RUN whose abort is governed by the run (explicit stop), not the
  // socket; when absent (test harnesses only) the turn is bound to `signal`.
  runHooks?: AiChatRunHooks;
  // Resolved by the controller BEFORE res.hijack(), so an unconfigured provider
  // (AiNotConfiguredException -> 503) surfaces as clean JSON before streaming.
  // For a role with a model override this already carries the override-resolved
  // model (or the controller threw a 503 if the override driver was unconfigured).
  model: LanguageModel;
  // The agent role to apply this turn, pre-resolved by the controller from the
  // chat row (existing chat) or the request body (new chat). null => universal
  // assistant. Carried here so the turn never re-loads it.
  role: AiAgentRole | null;
  // #487: true when this turn was started by SUPERSEDING a still-live previous run
  // (the controller ran the supersede CAS to a `ready` result). Adds the
  // SUPERSEDE_NOTE to the system prompt (the previous run's last ops may still be
  // applying — no side-effect quiescence). Absent on an ordinary send.
  superseded?: boolean;
}

/**
 * Per-user AI chat orchestration.
 *
 * Message persistence shape (ai_chat_messages):
 *  - `role`        : 'user' | 'assistant'
 *  - `content`     : the message's plain text (assistant final text; user text).
 *                    The migration column is `text`, so plain text is stored.
 *  - `tool_calls`  : jsonb — the assistant's tool steps/calls/results for this
 *                    turn (trace; also surfaced in the UI as an action log).
 *  - `metadata`    : jsonb — the assistant message's reconstructable UIMessage
 *                    `parts` plus finishReason/usage, so multi-turn tool history
 *                    can be rebuilt for `convertToModelMessages`.
 */
@Injectable()
export class AiChatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiChatService.name);

  constructor(
    private readonly ai: AiService,
    private readonly aiChatRepo: AiChatRepo,
    private readonly aiChatMessageRepo: AiChatMessageRepo,
    private readonly aiChatPageSnapshotRepo: AiChatPageSnapshotRepo,
    private readonly aiSettings: AiSettingsService,
    private readonly tools: AiChatToolsService,
    private readonly mcpClients: McpClientsService,
    private readonly aiAgentRoleRepo: AiAgentRoleRepo,
    private readonly pageRepo: PageRepo,
    private readonly pageAccess: PageAccessService,
    // Reads the AI_CHAT_DEFERRED_TOOLS toggle (#332). Injected last so existing
    // positional constructor callers (tests) only append one stub.
    private readonly environment: EnvironmentService,
    // #184 phase 1.5 run-stream registry. OPTIONAL so existing positional
    // constructions (int-specs) compile unchanged; Nest always injects the real
    // provider in production. Only ever touched on the run-wrapped path.
    private readonly streamRegistry?: AiChatStreamRegistryService,
    // #487: the run lifecycle service, for the periodic + opportunistic reconcile
    // (zombie re-drive + stale-run abort). OPTIONAL so positional test
    // constructions compile unchanged; Nest always injects the real singleton, so
    // reconcile sees the SAME in-memory active/zombie maps the runner mutates.
    private readonly aiChatRunService?: AiChatRunService,
    // Per-step INSERT into the steps table. Optional so positional constructions
    // in int-specs compile; when absent the per-step path falls back to the
    // full-row `metadata.parts` flush.
    private readonly aiChatRunStepRepo?: AiChatRunStepRepo,
    // #665: the mutable page->chat binding repo. The server is the BIRTH writer —
    // it upserts the binding right after the FIRST user message of a chat sent from
    // a page. OPTIONAL and injected LAST so existing positional constructions
    // (int-specs) compile unchanged; absent => the birth-bind is silently skipped
    // (no crash), present in production (Nest injects the singleton).
    private readonly aiChatPageBindingRepo?: AiChatPageBindingRepo,
  ) {}

  // #487: periodic reconcile timer (single-process phase 1). Started in
  // onModuleInit, cleared in onModuleDestroy.
  private reconcileTimer?: ReturnType<typeof setInterval>;

  /**
   * Startup sweep: any assistant row left 'streaming' belongs to a turn whose
   * process died. Flip it to 'aborted' (keeping the steps already persisted).
   * Best-effort: a sweep failure is logged and never blocks startup.
   */
  async onModuleInit(): Promise<void> {
    try {
      const swept = await this.aiChatMessageRepo.sweepStreaming();
      if (swept > 0) {
        this.logger.log(
          `Startup sweep: marked ${swept} dangling 'streaming' assistant ` +
            `message(s) as 'aborted'.`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Startup sweep of dangling 'streaming' messages failed: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }

    // #487: start the PERIODIC reconcile (was boot-only). It heals both directions
    // of the run<->message lifecycle asymmetry that a boot sweep alone left to the
    // NEXT restart. Single-process phase 1: the in-memory active/zombie maps are
    // authoritative, so "no live entry" is a safe primary gate.
    const staleMs = this.reconcileStalenessMs();
    // boot-warn if the per-call cap is configured so high the derived staleness is
    // unusually long (a stale run then lingers longer before reconcile aborts it).
    if (staleMs > 30 * 60 * 1000) {
      this.logger.warn(
        `#487 reconcile staleness is ${Math.round(staleMs / 60000)}min ` +
          `(derived from max(2 x per-call cap, 15min)); a per-call cap this high ` +
          `delays stale-run recovery. Review AI_CHAT_INAPP_TOOL_CALL_CAP_MS.`,
      );
    }
    const intervalMs = this.reconcileIntervalMs();
    this.reconcileTimer = setInterval(() => {
      void this.reconcile().catch((err) => {
        this.logger.warn(
          `Periodic reconcile failed: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
      });
    }, intervalMs);
    this.reconcileTimer.unref?.();
  }

  /** #487: stop the periodic reconcile timer on shutdown. */
  onModuleDestroy(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
  }

  /**
   * #487: reconcile staleness threshold X — a run/message is only a "no live
   * runner" abort candidate once UNTOUCHED past this. Derived as
   * max(2 x per-call cap, 15min): 2x the longest legitimate single tool call plus
   * a floor, so a marathon turn making steady progress (updatedAt bumped each
   * step) is never swept.
   */
  private reconcileStalenessMs(): number {
    return Math.max(2 * inAppToolCallCapMs(), 15 * 60 * 1000);
  }

  /** #487: how often the periodic reconcile runs (env-tunable, default 2min). */
  private reconcileIntervalMs(): number {
    const raw = Number(process.env.AI_CHAT_RECONCILE_INTERVAL_MS);
    return Number.isFinite(raw) && raw > 0 ? raw : 2 * 60 * 1000;
  }

  /**
   * Periodic bidirectional reconcile. Runs the clauses in order; each is
   * best-effort. Single-process: the run service's in-memory maps are
   * authoritative for "live entry".
   *
   *  (a) re-drive ZOMBIE runs (a terminal write that gave up) — apply the intended
   *      status via the conditional UPDATE;
   *  (b) message 'streaming' + its RUN terminal -> stamp the message by the run's
   *      status (succeeded-run + stuck row -> 'aborted'+finalizeFailed, NOT
   *      'completed' with empty parts — the final text lived only in the dead
   *      process's memory, a documented loss);
   *  (c) run active + NO live entry + NO zombie + stale -> aborted (the run
   *      service applies the "no entry" primary gate + last-progress staleness);
   *  (d) message 'streaming' + age>X + NO active run on the chat -> aborted
   *      (historical-row safety, double-gated).
   */
  async reconcile(): Promise<void> {
    const staleMs = this.reconcileStalenessMs();

    // (a) zombie re-drive.
    if (this.aiChatRunService) {
      for (const runId of this.aiChatRunService.zombieRunIds()) {
        try {
          await this.aiChatRunService.settleZombie(runId);
        } catch (err) {
          this.logger.warn(
            `Reconcile (a) zombie ${runId} re-drive failed: ${
              err instanceof Error ? err.message : 'unknown error'
            }`,
          );
        }
      }
    }

    // (b) message streaming + run terminal -> stamp message by run status.
    try {
      const stuck = await this.aiChatMessageRepo.findStreamingWithTerminalRun();
      for (const s of stuck) {
        // succeeded-run -> 'aborted' (NOT 'completed'-empty); failed -> 'error';
        // aborted -> 'aborted'. All via the finalizeFailed stamp.
        const status = s.runStatus === 'failed' ? 'error' : 'aborted';
        await this.aiChatMessageRepo.stampTerminalIfStreaming(
          s.messageId,
          s.workspaceId,
          status,
        );
      }
    } catch (err) {
      this.logger.warn(
        `Reconcile (b) message<-run failed: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }

    // (c) stale active run with no live runner -> aborted.
    if (this.aiChatRunService) {
      try {
        await this.aiChatRunService.reconcileStaleRuns(staleMs);
      } catch (err) {
        this.logger.warn(
          `Reconcile (c) stale-run abort failed: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
      }
    }

    // (d) historical streaming row, no active run on the chat, stale -> aborted.
    try {
      await this.aiChatMessageRepo.sweepStreamingWithoutActiveRun(staleMs);
    } catch (err) {
      this.logger.warn(
        `Reconcile (d) historical-row sweep failed: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

  /**
   * #487: OPPORTUNISTIC single-chat reconcile at the start of a turn (beginRun /
   * supersede path), so a user who returns to a chat with a stuck streaming row
   * (its run already terminal) sees it settled WITHOUT waiting for the periodic
   * job. Best-effort — a failure NEVER fails the turn (swallowed by the caller).
   */
  async reconcileChat(chatId: string, workspaceId: string): Promise<void> {
    const stuck = await this.aiChatMessageRepo.findStreamingWithTerminalRun(50, {
      chatId,
      workspaceId,
    });
    for (const s of stuck) {
      const status = s.runStatus === 'failed' ? 'error' : 'aborted';
      await this.aiChatMessageRepo.stampTerminalIfStreaming(
        s.messageId,
        s.workspaceId,
        status,
      );
    }
  }

  /**
   * Resolve the agent role that applies to this stream request, scoped to the
   * workspace and soft-delete aware. For an EXISTING chat the role is read from
   * `ai_chats.role_id` (authoritative — never from the body). For a NEW chat
   * (no valid chatId) the role comes from the request body's `roleId`. Returns
   * null for the universal assistant or when the referenced role is missing /
   * soft-deleted.
   */
  async resolveRoleForRequest(
    workspace: Workspace,
    body: AiChatStreamBody,
  ): Promise<AiAgentRole | null> {
    let roleId: string | null | undefined;
    if (body.chatId) {
      const chat = await this.aiChatRepo.findById(body.chatId, workspace.id);
      // A valid existing chat fixes the role from its own row.
      if (chat) roleId = chat.roleId;
      else roleId = body.roleId; // stale chatId => treated as a new chat
    } else {
      roleId = body.roleId;
    }
    if (!roleId) return null;
    // A disabled or soft-deleted role falls back to the universal assistant: it
    // must not apply its persona/model override even to a chat that was bound to
    // it earlier. findLiveEnabled enforces this (live + enabled + workspace
    // scope), server-authoritatively, for both the new-chat (body.roleId) and
    // existing-chat (chat.role_id) paths — the single shared invariant.
    return (
      (await this.aiAgentRoleRepo.findLiveEnabled(roleId, workspace.id)) ?? null
    );
  }

  /**
   * Resolve the chat language model for the workspace, applying the role's
   * optional model override. Exposed so the controller can resolve it BEFORE
   * res.hijack(): an unconfigured provider (incl. a role pointing at an
   * unconfigured driver) throws AiNotConfiguredException there and returns a
   * clean 503 instead of breaking mid-stream.
   */
  getChatModel(
    workspaceId: string,
    role?: AiAgentRole | null,
  ): Promise<LanguageModel> {
    return this.ai.getChatModel(workspaceId, roleModelOverride(role));
  }

  /**
   * Validate the client-supplied open page and return its AUTHORITATIVE identity
   * ({ id, title }) or null. The client controls BOTH the id and the title in the
   * request body, so neither is trusted: the id must resolve to a real page in
   * THIS workspace that the user may read, and the title is taken from the DB row
   * (never the client) so the model can't be told it is "on Page A" while the id
   * points at page B (#159). Fail-closed — any missing / foreign / inaccessible
   * page, or any non-Forbidden access-check fault, returns null.
   */
  private async resolveOpenPageContext(
    openPage:
      | { id?: string; title?: string; selection?: unknown }
      | null
      | undefined,
    workspace: Workspace,
    user: User,
  ): Promise<{
    id: string;
    title: string;
    updatedAt: Date;
    selection: SelectionContext | null;
  } | null> {
    const candidatePageId = openPage?.id;
    if (!candidatePageId) return null;
    const page = await this.pageRepo.findById(candidatePageId);
    if (!page || page.workspaceId !== workspace.id) return null;
    try {
      await this.pageAccess.validateCanView(page, user);
    } catch (e) {
      // A ForbiddenException is the expected "user cannot read this page" case;
      // log anything else (e.g. a DB error) so a real fault is not masked.
      if (!(e instanceof ForbiddenException)) {
        this.logger.warn(
          `open page access check failed: ${
            e instanceof Error ? e.message : 'unknown error'
          }`,
        );
      }
      return null;
    }
    // updatedAt feeds the per-turn page-change fast path (unchanged instant =>
    // skip the render + diff).
    //
    // The sanitized selection is attached only on a successful resolve: the
    // fail-closed branches above return null for the whole context, so a selection
    // never outlives a foreign/missing/deleted page.
    return {
      id: page.id,
      title: page.title ?? '',
      updatedAt: page.updatedAt,
      selection: sanitizeSelection(openPage?.selection),
    };
  }

  /**
   * Per-turn page-change detection. The agent rebuilds its context from the DB
   * each turn and cannot otherwise tell that the user hand-edited the open page,
   * so it could overwrite those edits. Compares the page's current Markdown with
   * the snapshot taken at the end of the previous turn (`snapshotOpenPage`) and
   * returns `{ title, diff }` for `buildSystemPrompt` as an ephemeral note.
   *
   * Returns null for: no open page, no snapshot, updatedAt unchanged, or an empty
   * diff after normalization. Any fault is logged and downgraded to null.
   */
  private async detectPageChange(
    chatId: string,
    openPageContext: { id: string; title: string; updatedAt: Date } | null,
    workspace: Workspace,
    user: User,
    sessionId: string,
  ): Promise<{ title: string; diff: string } | null> {
    if (!openPageContext) return null;
    try {
      const snapshot = await this.aiChatPageSnapshotRepo.findByChatPage(
        chatId,
        openPageContext.id,
        workspace.id,
      );
      // No snapshot yet => first turn on this page; there is nothing to diff
      // against. onFinish seeds it; the note starts from the NEXT turn.
      if (!snapshot) return null;
      // Fast path: the page has not been touched since the snapshot instant, so
      // nothing changed — skip the render + diff entirely.
      if (sameInstant(snapshot.pageUpdatedAt, openPageContext.updatedAt)) {
        return null;
      }
      // Render the current page the SAME way the snapshot end was rendered, so
      // pure formatting never registers as a change.
      const currentMd = await this.tools.exportPageMarkdown(
        user,
        sessionId,
        workspace.id,
        chatId,
        openPageContext.id,
      );
      const change = computePageChange(snapshot.contentMd, currentMd);
      if (!change.changed) return null;
      return {
        title: openPageContext.title || 'Untitled',
        diff: change.diff,
      };
    } catch (err) {
      this.logger.warn(
        `page-change detection skipped (chat ${chatId}): ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return null;
    }
  }

  /**
   * Write the end-of-turn snapshot for the open page: its Markdown after all of
   * the agent's edits this turn, plus updated_at. The agent's own edits are baked
   * in, so the next turn's diff isolates what a human changed. Best-effort — any
   * fault skips the write.
   *
   * updated_at is read BEFORE exporting, so the stored updated_at is never newer
   * than the stored content: the fast path can only be too conservative (an extra
   * diff), never falsely skip. Reading it after the export could pair a newer
   * updated_at with older content and skip a real edit.
   */
  private async snapshotOpenPage(
    chatId: string,
    pageId: string,
    workspace: Workspace,
    user: User,
    sessionId: string,
  ): Promise<void> {
    try {
      const freshPage = await this.pageRepo.findById(pageId);
      // Page deleted during the turn (or somehow foreign) => don't write.
      if (!freshPage || freshPage.workspaceId !== workspace.id) return;
      // Fast-path (#490): if a snapshot already exists at THIS page version
      // (same updated_at instant), its content is already current — skip the full
      // Markdown export + upsert entirely. A turn that did NOT touch the open page
      // (the common case) thus does no snapshot work. This mirrors the read-side
      // fast path in detectPageChange (sameInstant): both trust that a page edit
      // bumps updated_at. When the agent (or a human) DID edit the page this turn,
      // updated_at advanced, so this does not match and we re-export as before.
      const existing = await this.aiChatPageSnapshotRepo.findByChatPage(
        chatId,
        pageId,
        workspace.id,
      );
      if (existing && sameInstant(existing.pageUpdatedAt, freshPage.updatedAt)) {
        return;
      }
      const currentMd = await this.tools.exportPageMarkdown(
        user,
        sessionId,
        workspace.id,
        chatId,
        pageId,
      );
      await this.aiChatPageSnapshotRepo.upsert({
        chatId,
        pageId,
        workspaceId: workspace.id,
        contentMd: currentMd,
        pageUpdatedAt: freshPage.updatedAt,
      });
    } catch (err) {
      this.logger.warn(
        `page snapshot skipped (chat ${chatId}): ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }

  async stream({
    user,
    workspace,
    sessionId,
    body,
    res,
    signal,
    model,
    role,
    runHooks,
    superseded,
  }: AiChatStreamArgs): Promise<void> {
    // Resolve / create the chat. A new chat is created when no valid chatId is
    // supplied or the supplied one does not belong to this workspace.
    let isNewChat = false;
    let chatId = body.chatId;
    // Persisted chat-level metadata bag (#490): read once here so the deferred-tool
    // activation set can be seeded from the previous turn. Undefined for a new chat.
    let chatMetadata: Record<string, unknown> | undefined;
    if (chatId) {
      const existing = await this.aiChatRepo.findById(chatId, workspace.id);
      if (!existing) {
        chatId = undefined;
      } else {
        chatMetadata = (existing.metadata ?? undefined) as
          | Record<string, unknown>
          | undefined;
      }
    }
    // The open page the client sent is attacker-controllable — both its id and
    // its title. Resolve it once against the DB (workspace-scoped + access-checked)
    // and use that identity everywhere below: the system prompt, getCurrentPage,
    // and the new-chat history origin. Null when no page is open or it is foreign
    // / inaccessible / missing.
    const openPageContext = await this.resolveOpenPageContext(
      body.openPage,
      workspace,
      user,
    );

    if (!chatId) {
      // The history-list origin is the validated open page (see above):
      // persisting an unvalidated id would leak a title via the chat-list join,
      // or violate the page_id FK on insert (this runs after res.hijack(), so a
      // DB error would break the stream).
      const originPageId: string | null = openPageContext?.id ?? null;
      // ORPHAN-ON-BEGIN-FAILURE tradeoff (#486, B3): the chat row is inserted
      // HERE, before runHooks.begin below. If begin fails (e.g. a 503 / run-slot
      // rejection) the turn aborts before the client is told this new chatId, so
      // an empty chat is left behind and a retry mints ANOTHER one. We accept this
      // over reordering: begin needs a chatId to bind the run to, and inserting
      // the chat first keeps the id stable + the FK/history-join invariants above
      // intact. Orphan empty chats are cheap and swept by normal chat cleanup.
      const chat = await this.aiChatRepo.insert({
        creatorId: user.id,
        workspaceId: workspace.id,
        // Bind the chat to the resolved role (if any) at creation time. The role
        // is immutable afterwards (later turns read it from this column).
        roleId: role?.id ?? null,
        // Validated above: a real, readable page in this workspace, else null.
        pageId: originPageId,
      });
      chatId = chat.id;
      isNewChat = true;
    }

    // Start the durable RUN now that the chat id is known. Its `signal` is the
    // user's explicit stop, not the HTTP socket, so a browser disconnect does not
    // end the turn. Without runHooks the turn is socket-bound and `runId` is
    // undefined.
    let runId: string | undefined;
    let effectiveSignal = signal;
    if (runHooks) {
      try {
        const handle = await runHooks.begin(chatId);
        if (handle) {
          runId = handle.runId;
          effectiveSignal = handle.signal;
        }
      } catch (err) {
        // RACE BACKSTOP: the run-row INSERT lost the chat's single active slot
        // (the partial unique index rejected it). This is the AUTHORITATIVE
        // concurrency gate — the controller's pre-check is only a fast-path, and a
        // request that slipped past it must NOT proceed. Reject the turn with a
        // 409 NOW, BEFORE any AI/provider call: no tokens are spent and no
        // untracked turn streams. (Matches the controller's pre-check 409.)
        if (err instanceof RunAlreadyActiveError) {
          throw new ConflictException({
            message: 'An agent run is already in progress for this chat',
            code: 'A_RUN_ALREADY_ACTIVE',
          });
        }
        // Any other run-start failure must fail the turn: a turn without a run-row
        // cannot be stopped (/stop can't see it, disconnect doesn't abort it) and
        // the one-run-per-chat gate would admit a second run. Reject before the
        // first byte (no user row, no MCP lease yet) so the controller's
        // post-hijack catch turns this HttpException into a 503.
        this.logger.error(
          `Failed to begin agent run (chat ${chatId}); failing the turn`,
          err as Error,
        );
        throw new ServiceUnavailableException({
          message:
            'Could not start the agent run. This is usually temporary — please try again.',
          code: 'A_RUN_BEGIN_FAILED',
          // Self-describe the status in the body: the controller's post-hijack
          // catch writes getResponse() verbatim onto the raw socket, and an
          // object-arg HttpException does NOT inject statusCode. Without it the
          // client's 503 classifier (which reads the body JSON) could not see the
          // status. With it present, the client's A_RUN_BEGIN_FAILED branch (which
          // runs strictly before the generic-503 branch) shows "temporary, retry".
          statusCode: 503,
        });
      }
    }

    // #487: opportunistic single-chat reconcile — settle any streaming row on this
    // chat whose run is already terminal BEFORE this turn's history load, so the
    // user never waits on the periodic job and the new turn's model history is not
    // polluted by a stuck 'streaming' row. Best-effort: it must NEVER fail the turn.
    try {
      await this.reconcileChat(chatId, workspace.id);
    } catch (err) {
      this.logger.debug(
        `Opportunistic reconcile for chat ${chatId} failed (ignored): ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }

    try {
      // Extract the incoming user turn (the last user message from useChat).
      const incoming = lastUserMessage(body.messages);
      const incomingText = uiMessageText(incoming);

      // Sanitize client-supplied parts on receipt. The client only sends a single
      // text part; any other part (most dangerously a tool-part in
      // `input-available` state) would be persisted and replayed through
      // convertToModelMessages on every later turn, and a malformed one makes
      // that throw on every turn. Drop non-whitelisted parts with a warn.
      const sanitizedParts = sanitizeUserParts(incoming?.parts, (type) =>
        this.logger.warn(
          `Dropping unsupported user message part '${type}' on chat ${chatId}`,
        ),
      );

      // Rebuild the conversation from persisted history (not the client payload)
      // and convert it to model messages BEFORE persisting the user row, so a
      // conversion failure cannot leave a duplicate user row behind on retry.
      // `findAllByChat` returns oldest -> newest with a 5000-row memory backstop
      // (on overflow it keeps the newest rows and warns).
      const oldHistory = await this.aiChatMessageRepo.findAllByChat(
        chatId,
        workspace.id,
      );
      // Hydrate assistant rows from the steps table before the replay map. A
      // mid-run row carries only a step marker (metadata.parts:[]) with its parts
      // in `ai_chat_run_steps`; the terminal callbacks assemble inline parts, but
      // a hard crash (SIGKILL/OOM) fires none, and without this the partial
      // tool calls/results/text would drop out of the model's replay. Mirrors the
      // controller's withReconstructedParts (same predicate + helper). Skipped when
      // the optional repo is absent.
      let replayHistory = oldHistory;
      if (this.aiChatRunStepRepo) {
        const needy = oldHistory.filter(
          (r) => r.role === 'assistant' && !rowHasInlineParts(r),
        );
        if (needy.length > 0) {
          const stepsByMessage = await this.aiChatRunStepRepo.findByMessageIds(
            needy.map((r) => r.id),
            workspace.id,
          );
          replayHistory = hydrateAssistantParts(oldHistory, stepsByMessage);
        }
      }
      const uiMessages: Array<Omit<UIMessage, 'id'> & { id: string }> = [
        ...replayHistory.map(rowToUiMessage),
        {
          id: 'pending-user',
          role: 'user',
          parts: (sanitizedParts && sanitizedParts.length > 0
            ? sanitizedParts
            : textPart(incomingText)) as UIMessage['parts'],
        },
      ];
      // convertToModelMessages is async in ai@6.0.134 (returns Promise<ModelMessage[]>).
      // Resilient (#489): a single poisoned row in the OLD history is isolated via
      // per-row conversion and degraded to plain text with a "[tool context
      // omitted]" marker rather than 500-ing the whole turn (silent loss of tool
      // context is not acceptable — the model must see the truncation).
      let messages = await convertHistoryResilient(uiMessages, (index, err) =>
        this.logger.warn(
          `Degraded unconvertible history row ${index} on chat ${chatId} to text: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        ),
      );

      // Persist the user message only AFTER a successful conversion (#489).
      await this.aiChatMessageRepo.insert({
        chatId,
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        content: incomingText,
        // jsonb column: UIMessage parts are JSON-serializable at runtime but not
        // structurally `JsonValue`, so cast through unknown. Persist the SANITIZED
        // parts (never the raw client parts) so the row is always convertible.
        metadata: (sanitizedParts ? { parts: sanitizedParts } : null) as never,
      });

      // Birth bind: on the FIRST saved user message of this chat sent from a page,
      // point that page's binding at this chat. The gate is
      // `oldHistory.length === 0` (loaded without the row just inserted), not
      // `isNewChat`: a chat orphaned when runHooks.begin failed has isNewChat=false
      // on its retry but must still bind. Later turns never rebind.
      //
      // The bound page is `openPageContext.id` — the VALIDATED page the message was
      // sent from (not `ai_chats.page_id`): on an orphan retry from another page Y
      // we bind Y ("the page you're standing on"), while page_id stays the birth
      // page X as provenance. `openPageContext === null` (off a document) => no write.
      //
      // Written AFTER the message insert (so "bound => the chat has >= 1 message"),
      // and fail-SOFT (NOT transactional): a binding-write failure must never roll
      // back the user's message or fail the turn. Worst case is "message saved, page
      // still points at the old chat" — the declared safe degradation.
      if (
        oldHistory.length === 0 &&
        openPageContext &&
        this.aiChatPageBindingRepo
      ) {
        try {
          await this.aiChatPageBindingRepo.upsert(
            user.id,
            openPageContext.id,
            chatId,
          );
        } catch (err) {
          this.logger.warn(
            `Birth page-binding failed for chat ${chatId} on page ${openPageContext.id} (reason=birth_bind_failed): ${
              err instanceof Error ? err.message : 'unknown error'
            }`,
          );
          incAiChatBindSkipped('birth_bind_failed');
        }
      }

      // Interrupt-resume detection: confirm the client "send now" hint against the
      // persisted history. The aborted turn's partial parts are already in
      // `messages` (hydrated from the steps table above).
      // Append the new user turn (shape-only) so index -2 is the prior assistant.
      const interrupted = isInterruptResume(
        [...oldHistory, { role: 'user', status: null, metadata: null }],
        body.interrupted,
      );

      // Per-turn page-change detection (#274): if the open page was hand-edited by
      // the user since the agent's last turn ended, compute the unified diff so the
      // system prompt can warn the agent its copy is stale (else it overwrites those
      // edits). Best-effort (null on the fast path / first turn / any fault) — never
      // blocks the turn. Snapshot is (re)written at turn end in onFinish below.
      const pageChanged = await this.detectPageChange(
        chatId,
        openPageContext,
        workspace,
        user,
        sessionId,
      );

      // The model is resolved by the controller before hijack (clean 503 path).
      // Here we only need the admin-configured system prompt.
      const resolved = await this.aiSettings.resolve(workspace.id);

      // History-replay token budget (#490). The full conversation is replayed to
      // the provider every turn, so a long chat eventually 400s on the context
      // window — forever. Bound the REPLAYED history (never the persisted rows).
      // PRIMARY signal is the provider's own fact: the last turn's contextTokens.
      const replayBudget = resolveReplayBudget(resolved?.chatContextWindowRaw);
      if (replayBudget.usedDefault) {
        // The default fires precisely for installs with NO configured window —
        // the ones that hit terminal overflow. Warn so it is observable.
        this.logger.warn(
          `AI chat (chat ${chatId}): no chatContextWindow configured; ` +
            `applying the default replay budget (${replayBudget.thresholdTokens} tokens).`,
        );
      }
      // Last turn's provider-reported context size (authoritative when present).
      const priorContextTokens = lastAssistantContextTokens(oldHistory);
      // Reactive recovery (#490/#520): `k` = how many CONSECUTIVE preceding turns
      // were rejected for context overflow (stamped by onError). Each consecutive
      // overflow trims MORE aggressively (resolveEffectiveReplayThreshold scales the
      // budget by 0.5**k, clamped at the floor) so recovery ESCALATES until the
      // history fits — the overflowing turn produced no usage signal, so a single
      // fixed cut may not shrink enough when the real model window is small. This is
      // what un-bricks a chat that keeps 400'ing on the context window.
      const priorOverflowCount = lastAssistantReplayOverflowCount(oldHistory);
      const effectiveThreshold = resolveEffectiveReplayThreshold(
        replayBudget.thresholdTokens,
        priorOverflowCount,
      );
      // #520 Option B: recovery MAY cut the replay budget BELOW the admin-configured
      // window when the provider keeps proving non-fit (the anti-brick invariant of
      // the reactive branch beats a config that a 400 has disproved). Surface it so
      // the admin sees their window is factually too large, and mark the turn so the
      // UI/telemetry can show it. Only true when actually below (not on in-budget
      // escalation edge cases); k>0 implies below for any budget >= 2 tokens.
      const replayBelowConfiguredBudget =
        replayBudget.thresholdTokens != null &&
        effectiveThreshold != null &&
        effectiveThreshold < replayBudget.thresholdTokens;
      if (priorOverflowCount > 0) {
        if (replayBelowConfiguredBudget) {
          this.logger.warn(
            `AI chat (chat ${chatId}): configured replay budget ` +
              `(${replayBudget.thresholdTokens} tokens) does not fit the model — ` +
              `replaying BELOW it at ${effectiveThreshold} tokens after ` +
              `${priorOverflowCount} consecutive context overflow(s) ` +
              `(escalation level ${priorOverflowCount}). Lower chatContextWindow ` +
              `to match the model's real context window.`,
          );
        } else {
          this.logger.warn(
            `AI chat (chat ${chatId}): ${priorOverflowCount} consecutive context ` +
              `overflow(s); applying escalated aggressive replay budget ` +
              `(${effectiveThreshold} tokens).`,
          );
        }
      }
      const preTrim = trimHistoryForReplay(
        messages,
        effectiveThreshold,
        // A prior OVERFLOW means the provider count is stale/absent — force the
        // char-estimate path by ignoring priorContextTokens on recovery.
        priorOverflowCount > 0 ? undefined : priorContextTokens,
      );
      messages = preTrim.messages;
      // Observability (#490): record the budgeter's decision on the turn so the UI
      // can surface "replay truncated at N tokens". Threaded into flushAssistant.
      const replayTrimmedToTokens: number | undefined = preTrim.trimmed
        ? preTrim.estimatedTokens
        : undefined;
      if (preTrim.trimmed) {
        this.logger.log(
          `AI chat (chat ${chatId}): replay history trimmed to ~${preTrim.estimatedTokens} ` +
            `tokens (budget ${replayBudget.thresholdTokens}).`,
        );
      }

      // Build the external MCP toolset FIRST so the system prompt can carry each
      // connected server's admin-authored guidance. A down/slow external server
      // never crashes the turn — toolsFor skips it and records the outcome. The
      // returned client handles MUST be closed in onFinish/onError/onAbort. Docmost
      // tools take precedence on a name clash (external ones are namespaced).
      let external: Awaited<ReturnType<McpClientsService['toolsFor']>> = {
        tools: {},
        clients: [],
        outcomes: [],
        instructions: [],
      };
      // #686 P4 (observability): the external-MCP connection failures surfaced to
      // the client (via the chatStreamMetadata seam) AND persisted into the
      // assistant message metadata. Populated from `external.outcomes` after a
      // build, or a single synthetic record when the whole build fails below.
      let mcpFailures: McpFailureRecord[] = [];
      try {
        // Bound the toolset build by the run's abort signal and a wall-clock
        // deadline: streamText's terminal callbacks do not govern this setup phase,
        // so a hung build would otherwise hang the turn at step 0 and ignore Stop.
        // On a late resolve, release the abandoned toolset's leases — c.close()
        // decrements the cache entry's refcount (the cache owns and closes the
        // transports on TTL/evict).
        external = await raceAgainstAbortAndTimeout(
          // #686: the toolset is per-user — admin servers ∪ THIS user's personal
          // servers. `user.id` is REQUIRED (the cache is always keyed per-user).
          this.mcpClients.toolsFor(workspace.id, user.id),
          effectiveSignal,
          MCP_TOOLSET_BUILD_DEADLINE_MS,
          (late) => {
            void Promise.all(
              late.clients.map((c) => c.close().catch(() => undefined)),
            );
          },
        );
        // Surface per-server connect failures (ok:false outcomes), capped.
        mcpFailures = buildMcpFailures(external.outcomes);
      } catch (err) {
        // An explicit Stop reached the run's signal during setup: re-throw so the
        // outer catch finalizes the run as aborted. Without `runId` (begin returned
        // no handle, `effectiveSignal` is the bare socket signal) warn and proceed.
        if (runId && effectiveSignal.aborted) {
          throw err;
        }
        // Otherwise a down/slow server (build timeout or other fault) must never
        // break the turn: proceed with Docmost-only tools. Never log URLs/headers —
        // short message only.
        this.logger.warn(
          `External MCP toolset unavailable: ${
            err instanceof Error ? err.message : 'unknown error'
          }`,
        );
        // #686 P4: a TOTAL build failure yields no per-server outcomes, so
        // synthesize one record — otherwise a whole external toolset silently
        // vanishing would leave no signal (ARCH INVARIANT #10). The turn still
        // proceeds on Docmost-only tools.
        mcpFailures = [
          {
            name: '(external toolset)',
            reason: `build failed: ${truncateMcpReason(
              err instanceof Error ? err.message : 'unknown error',
            )}`,
          },
        ];
      }

      // Close every external client exactly once across the terminal callbacks.
      // Defined before the prompt/toolset are built so that if buildSystemPrompt
      // or forUser throws after toolsFor took the lease, the lease is still
      // released (otherwise its refCount stays >= 1 and sockets leak). Close
      // errors are swallowed.
      let clientsClosed = false;
      const closeExternalClients = async (): Promise<void> => {
        if (clientsClosed) return;
        clientsClosed = true;
        await Promise.all(
          external.clients.map((c) =>
            c.close().catch((closeErr) => {
              this.logger.warn(
                `Failed to close external MCP client: ${
                  closeErr instanceof Error ? closeErr.message : 'unknown error'
                }`,
              );
            }),
          ),
        );
      };

      // Turn-end snapshot of the open page, run exactly once across the terminal
      // callbacks — including onError/onAbort: write tools commit edits during a
      // step, so an edit followed by an abort still bumps page.updatedAt, and a
      // stale snapshot would make the next turn report the agent's own edit as a
      // user edit. Best-effort; skipped when no page is open.
      let snapshotWritten = false;
      const snapshotTurnEnd = async (): Promise<void> => {
        if (snapshotWritten) return;
        snapshotWritten = true;
        if (!openPageContext) return;
        await this.snapshotOpenPage(
          chatId,
          openPageContext.id,
          workspace,
          user,
          sessionId,
        );
      };

      // Build the system prompt + Docmost toolset. If either throws after the
      // external MCP lease was taken above, release the lease before rethrowing so
      // the leased transports are not leaked (#185 review).
      // Deferred tool loading toggle (#332). When ON, the model sees a compact
      // <tool_catalog> and only CORE tools + loadTools are active each step; other
      // tools (fat/rare in-app tools + ALL external MCP tools) load on demand. When
      // OFF, every tool is active and nothing below changes.
      const deferredEnabled = this.environment.isAiChatDeferredToolsEnabled();
      // Final-step lockdown toggle (#444). Default OFF: the last step keeps its
      // tools and gets only a soft nudge (prepareAgentStep), and the token-
      // degeneration detector (onChunk below) is the anti-babble guard. ON =
      // legacy tool-stripping lockdown on the last step.
      const finalStepLockdownEnabled =
        this.environment.isAiChatFinalStepLockdownEnabled();

      // viewImage vision tool. Default OFF. The same flag gates both the tool
      // registration (forUser) and the prepareStep image injection. `viewImageCache`
      // is a per-run Map shared by reference with viewImage.execute (which stores
      // the image keyed by toolCallId) — not experimental_context, which the SDK
      // treats as immutable inside execute. prepareStep injects each image as an
      // ephemeral user message on every later step until the model has spoken.
      const viewImageEnabled = this.environment.isAiChatViewImageEnabled();
      const viewImageCache: ViewImageCache = new Map();

      let system: string;
      let docmostTools: Awaited<ReturnType<AiChatToolsService['forUser']>>;
      try {
        // Assemble the deferred catalog for the system prompt: hand-written lines
        // for the in-app deferred tools + a derived line for each external MCP tool
        // (also deferred by default). Only built when the feature is enabled.
        const toolCatalog = deferredEnabled
          ? [
              ...(await this.tools.getInAppDeferredCatalog()),
              ...buildExternalToolCatalog(external.tools),
            ]
          : [];

        system = buildSystemPrompt({
          workspace,
          adminPrompt: resolved?.systemPrompt,
          // The role (pre-resolved by the controller) REPLACES the persona layer;
          // the safety framework is still appended by buildSystemPrompt.
          roleInstructions: role?.instructions,
          // Server-validated open page (authoritative title), not the client value.
          openedPage: openPageContext,
          // Guidance only for servers that connected and yielded ≥1 callable tool.
          mcpInstructions: external.instructions,
          // History-confirmed interrupt-resume flag (#198): adds the interrupt note
          // so the model treats the partial answer above as cut off, not finished.
          interrupted,
          // #487: this turn superseded a still-live run — warn the model the
          // previous run's last ops may still be applying (no quiescence).
          superseded,
          // Detected between-turns human edit to the open page (#274): adds the
          // page_changed note + unified diff so the agent doesn't overwrite it.
          pageChanged,
          // Deferred tool loading (#332): renders the <tool_catalog> block (only
          // when enabled + non-empty) so the model can activate deferred tools.
          deferredToolsEnabled: deferredEnabled,
          toolCatalog,
        });

        // Pass the resolved chatId so the write tools can mint provenance tokens
        // (access + collab) carrying { actor:'agent', aiChatId: chatId }, making
        // agent REST/collab writes attributable and non-spoofable (§6.5/§6.6).
        docmostTools = await this.tools.forUser(
          user,
          sessionId,
          workspace.id,
          chatId,
          // Same server-validated open page used by the system prompt above;
          // exposed to the model via getCurrentPage so page identity (and the
          // AUTHORITATIVE title) survives prompt mangling / client title spoofing.
          openPageContext,
          // #588: gate + the per-run cache viewImage.execute writes into (read by
          // prepareStep below to inject the image). Off => tool not registered.
          viewImageEnabled,
          viewImageCache,
        );
      } catch (err) {
        await closeExternalClients();
        throw err;
      }

      // Base toolset: external MCP tools + Docmost in-app tools (Docmost wins on a
      // name clash — external are namespaced, so no clash is expected).
      const baseTools = { ...external.tools, ...docmostTools };

      // Deferred tool loading state, scoped to this streaming loop:
      //  - `activatedTools`: a per-call Set seeded from the chat's persisted
      //    metadata.activatedTools; loadTools.execute adds to it, prepareAgentStep
      //    reads it, turn end persists it back.
      //  - `validDeferredNames`: every non-core tool (in-app deferred + all external
      //    MCP tools, by namespaced name). loadTools rejects any name outside it.
      const validDeferredNames = new Set<string>(
        Object.keys(baseTools).filter((k) => !CORE_TOOL_SET.has(k)),
      );
      // Seed from the persisted set (only when deferred loading is enabled),
      // intersected with the current valid names so an allowlist/role change never
      // resurrects a tool that no longer exists.
      const activatedTools = new Set<string>(
        deferredEnabled
          ? seedActivatedTools(chatMetadata, validDeferredNames)
          : [],
      );
      // Add the loadTools meta-tool ONLY when the feature is enabled; when off the
      // toolset and behavior are exactly as before.
      const tools = deferredEnabled
        ? {
            ...baseTools,
            [LOAD_TOOLS_NAME]: makeLoadToolsTool(activatedTools, validDeferredNames),
          }
        : baseTools;

      // #490: persist the (deterministically ordered) activation set back onto the
      // chat metadata at turn end, so the NEXT turn seeds from it. Once-guarded and
      // skipped when nothing new was activated (the set equals its seed) so an
      // ordinary turn adds no extra write. Preserves other metadata keys.
      let activatedToolsPersisted = false;
      const persistActivatedTools = async (): Promise<void> => {
        if (!deferredEnabled || activatedToolsPersisted || !chatId) return;
        activatedToolsPersisted = true;
        const current = [...activatedTools].sort();
        const seeded = seedActivatedTools(chatMetadata, validDeferredNames).sort();
        if (current.length === 0 || current.join(' ') === seeded.join(' ')) {
          return; // nothing new activated -> no write
        }
        try {
          await this.aiChatRepo.update(
            chatId,
            {
              metadata: {
                ...(chatMetadata ?? {}),
                activatedTools: current,
              },
            } as never,
            workspace.id,
          );
        } catch (err) {
          this.logger.warn(
            `Failed to persist activated tools (chat ${chatId}): ${
              err instanceof Error ? err.message : 'unknown error'
            }`,
          );
        }
      };

      // Accumulate the turn's streamed output so a provider error / disconnect can
      // persist the PARTIAL answer the user already saw — the SDK's onError/onAbort
      // callbacks don't hand us the in-progress text. `capturedSteps` holds finished
      // steps (tool calls + their text); `inProgressText` holds the text streamed in
      // the CURRENT, not-yet-finished step, reset whenever a step finishes.
      const capturedSteps: StepLike[] = [];
      let inProgressText = '';

      // Per-turn step->parts memo (#490): shared across every flushAssistant call
      // this turn so each finished step's (large) output is JSON-stringified ONCE,
      // not re-stringified on every subsequent onStepFinish flush (was O(N²)).
      const partsCache: StepPartsCache = new WeakMap();

      // Token-degeneration guard: when the final-step lockdown is OFF, a runaway
      // repetition loop is aborted via this controller, unioned with the run/socket
      // signal below. The detector runs on `inProgressText` in onChunk, every
      // ~DEGENERATION_CHECK_STEP bytes of growth.
      const degenerationController = new AbortController();
      let degenerationDetected = false;
      let lastDegenerationCheckLen = 0;

      // Step-granular durability: create the assistant row upfront as 'streaming',
      // UPDATE it as each step finishes and finalize it on the terminal callback.
      // If the process dies mid-turn the finished steps survive and the startup
      // sweep flips the row to 'aborted'. A failed upfront insert leaves
      // assistantId undefined; the per-step/terminal updates then no-op and the
      // turn still streams.
      let assistantId: string | undefined;
      try {
        const seed = flushAssistant([], '', 'streaming', { pageChanged });
        const seeded = await this.aiChatMessageRepo.insert({
          chatId,
          workspaceId: workspace.id,
          userId: user.id,
          role: 'assistant',
          content: seed.content,
          // jsonb columns: cast through never (same as the user insert above).
          toolCalls: (seed.toolCalls ?? null) as never,
          metadata: seed.metadata as never,
          status: seed.status,
        });
        assistantId = seeded?.id;
      } catch (err) {
        this.logger.error(
          `Failed to insert upfront assistant row (chat ${chatId}, workspace ${workspace.id})`,
          err as Error,
        );
      }

      // Link the assistant message (the #183 projection) to its run (#184), so a
      // reconnecting client can resolve the run's output. Best-effort.
      if (runId && assistantId) {
        try {
          await runHooks?.onAssistantSeeded?.(runId, assistantId);
        } catch (err) {
          this.logger.warn(
            `Failed to link assistant row to run ${runId}: ${
              err instanceof Error ? err.message : 'unknown error'
            }`,
          );
        }
      }

      // Per-step (non-terminal) update: persist the finished steps when a step
      // ends; keeps status 'streaming'. A failed update is logged and swallowed.
      // Returns `stepsPersisted` on a confirmed write, else null; the caller
      // rotates the run-stream registry ring only on non-null, so a failed persist
      // never rotates away a step nobody has.
      const updateStreaming = async (): Promise<number | null> => {
        if (!assistantId) return null;
        // Cheap short-circuit once the turn is finalized (see `finalized` below).
        // The AUTHORITATIVE guard is `onlyIfStreaming` on the UPDATE: a late
        // fire-and-forget step update could still be in flight on another pool
        // connection when finalize runs, so the SQL `WHERE status='streaming'`
        // (not this flag) is what prevents it clobbering the terminal row.
        if (finalized) return null;
        // The count derives from capturedSteps.length at THIS instant, so the
        // returned value is EXACTLY the persisted `stepsPersisted` the ring rotates
        // on (whether we take the append-persist path or the legacy fallback).
        const stepsPersisted = capturedSteps.length;
        try {
          if (this.aiChatRunStepRepo) {
            // #492 APPEND-PERSIST: write only THIS finished step's parts to the
            // steps table (O(step) WAL), then bump the row's CHEAP step marker —
            // NO growing `metadata.parts` blob (that O(n²) full-row rewrite is
            // exactly what this removes). The full `metadata.parts` is assembled
            // once at finalize; a mid-run resume seed is reconstructed from the
            // step rows (reconstructRunParts). The INSERT is idempotent
            // (ON CONFLICT DO NOTHING), so a re-fired step never doubles the parts.
            const index = stepsPersisted - 1;
            if (index >= 0) {
              const stepParts = assistantParts(
                [capturedSteps[index]],
                '',
                partsCache,
              );
              await this.aiChatRunStepRepo.insertStep(
                assistantId,
                workspace.id,
                index,
                stepParts,
              );
            }
            // Marker UPDATE: advance stepsPersisted + keep the toolTrace era marker
            // (bumps updatedAt so the delta poll observes the step, and carries the
            // frontier a resuming client attaches from). Scoped onlyIfStreaming so a
            // late marker never clobbers the terminal finalize.
            await this.aiChatMessageRepo.update(
              assistantId,
              workspace.id,
              { metadata: stepMarkerMetadata(stepsPersisted) },
              { onlyIfStreaming: true },
            );
          } else {
            // Legacy fallback (no steps table wired — positional test builds): the
            // pre-#492 full-row flush, so parts still land inline on the row.
            const flushed = flushAssistant(capturedSteps, '', 'streaming', {
              pageChanged,
              partsCache,
            });
            await this.aiChatMessageRepo.update(
              assistantId,
              workspace.id,
              flushed,
              { onlyIfStreaming: true },
            );
          }
          return stepsPersisted;
        } catch (err) {
          this.logger.warn(
            `Failed to update streaming assistant row: ${
              err instanceof Error ? err.message : 'unknown error'
            }`,
          );
          return null;
        }
      };

      // Serialize the per-step updates (#183 review): onStepFinish fires them
      // without await, so two could otherwise commit out of order on different pool
      // connections (step N landing after N+1). Chaining each onto the previous
      // keeps the persisted row monotonic with step order; each link short-circuits
      // on `finalized`, so a tail of late updates is cheap.
      let stepUpdateChain: Promise<void> = Promise.resolve();

      // Terminal finalize: write the completed/error/aborted row exactly once
      // across the mutually-exclusive onFinish/onError/onAbort callbacks. The
      // once-gate closes only after a successful write, which is retried a bounded
      // number of times; on give-up the gate stays open and the periodic reconcile
      // settles the row. Returns whether the write landed, so the caller can
      // error-mark the run (the run is finalized regardless).
      let finalized = false;
      const FINALIZE_MSG_MAX_ATTEMPTS = 3;
      const finalizeAssistant = async (
        flushed: AssistantFlush,
      ): Promise<boolean> => {
        if (finalized) return true;
        const plan = planFinalizeAssistant(assistantId);
        let lastError: unknown;
        for (let attempt = 1; attempt <= FINALIZE_MSG_MAX_ATTEMPTS; attempt++) {
          try {
            // Shared dispatch (see applyFinalize): conditionally UPDATE the upfront
            // row (owner-write priority), or — when the upfront insert failed (kind
            // 'insert') — INSERT the terminal row as the only safety against losing
            // the turn entirely.
            await applyFinalize(
              this.aiChatMessageRepo,
              plan,
              { chatId, workspaceId: workspace.id, userId: user.id },
              flushed,
            );
            finalized = true; // gate closes ONLY after a successful write
            return true;
          } catch (err) {
            lastError = err;
            this.logger.warn(
              `Assistant message finalize attempt ${attempt}/${FINALIZE_MSG_MAX_ATTEMPTS} ` +
                `failed (kind=${plan.kind}): ${
                  err instanceof Error ? err.message : 'unknown error'
                }`,
            );
            if (attempt < FINALIZE_MSG_MAX_ATTEMPTS) {
              await new Promise((r) => setTimeout(r, 50 * attempt));
            }
          }
        }
        // Gave up: leave the gate OPEN (no in-process second settler exists — the
        // terminal callbacks are mutually exclusive) and log. The periodic reconcile
        // settles the stranded row; a late owner-write is impossible for this turn,
        // so the reconcile stamp (aborted+finalizeFailed) is the final state.
        this.logger.error(
          `Assistant message finalize GAVE UP after ${FINALIZE_MSG_MAX_ATTEMPTS} ` +
            `attempts (row left 'streaming', chat ${chatId}); reconcile will settle it`,
          lastError as Error,
        );
        return false;
      };

      // NOTE: streamText is synchronous in v6 — do NOT await it. A synchronous
      // failure here (or in pipe below) would skip the terminal callbacks, so the
      // catch releases the leased external clients to avoid a connection leak.
      let result: ReturnType<typeof streamText>;
      try {
        result = streamText({
          model,
          system,
          messages,
          tools,
          // Pin the AI SDK per-request retry budget explicitly instead of relying
          // on its default (which is also 2). Connection arithmetic per turn:
          // (1 + maxRetries=2) × (1 + AI_STREAM_PRE_RESPONSE_RETRIES) network
          // connects worst-case — the two retry layers compose, so making the SDK
          // side explicit keeps that ceiling visible and pinned against SDK-default
          // drift.
          maxRetries: 2,
          // No maxOutputTokens cap on the agent: tool-call arguments (e.g. a full
          // page body for the write tools) are emitted as OUTPUT tokens, so a fixed
          // cap would truncate complex tool calls mid-argument. Let the model use its
          // natural per-step budget. (Cost/credit limits are an account concern, not
          // something to enforce by silently breaking the agent.)
          stopWhen: stepCountIs(MAX_AGENT_STEPS),
          // Forced finalization: reserve the LAST allowed step for a text-only
          // answer. Without this, a turn that spends all its steps on tool calls
          // ends with no assistant text (an empty turn). prepareAgentStep forbids
          // further tool calls and appends a synthesis instruction on that step,
          // concatenated onto the original `system` so the persona is preserved.
          prepareStep: (opts) => {
            const base = prepareAgentStep(
              opts.stepNumber,
              system,
              activatedTools,
              deferredEnabled,
              finalStepLockdownEnabled,
            );
            // #588: when viewImage is enabled, inject each still-live cached image
            // as an ephemeral trailing user message on EVERY step after its call
            // (so the model sees it on intermediate tool steps AND the final
            // synthesis step, incl. a toolChoice:'none' lockdown step), evicting an
            // entry once the model has spoken about it. When off, `base` is returned
            // untouched — no injection. The disjoint-key merge preserves base's
            // activeTools/toolChoice/system so the image rides to synthesis.
            if (!viewImageEnabled) return base;
            return injectViewImages(base, opts, viewImageCache);
          },
          // #184: the RUN's signal (explicit-stop) when a run wraps this turn, else
          // the socket-bound signal (no run). A browser disconnect never aborts a
          // run by itself (#714: the controller stops a new chat's run via the run
          // signal when its client left before the first frame). #444: UNION it
          // with the internal degeneration signal so a detected token-loop aborts
          // the run too (AbortSignal.any — Node 20.3+).
          abortSignal: AbortSignal.any([
            effectiveSignal,
            degenerationController.signal,
          ]),
          onChunk: ({ chunk }) => {
            // 'text-delta' is the assistant's prose; tool-call args are separate chunk
            // types — so this mirrors exactly what streams to the client.
            if (chunk.type === 'text-delta') {
              inProgressText += chunk.text;
              // Token-degeneration guard (#444). Throttled: only re-run the pure
              // rules once the text has grown ~DEGENERATION_CHECK_STEP bytes since
              // the last check, so the tail heuristics cost is amortized. On a
              // trigger, abort the run ONCE with a distinguishable reason.
              if (
                !degenerationDetected &&
                shouldCheckDegeneration(
                  inProgressText.length,
                  lastDegenerationCheckLen,
                )
              ) {
                lastDegenerationCheckLen = inProgressText.length;
                if (isDegenerateOutput(inProgressText)) {
                  degenerationDetected = true;
                  this.logger.warn(
                    `AI chat stream aborted (chat ${chatId}): ${OUTPUT_DEGENERATION_ERROR}`,
                  );
                  degenerationController.abort(
                    new Error(OUTPUT_DEGENERATION_ERROR),
                  );
                }
              }
            }
          },
          onStepFinish: (step) => {
            // The finished step's full text is now in `step.text`; fold it in and reset
            // the in-progress accumulator for the next step.
            capturedSteps.push(step as StepLike);
            inProgressText = '';
            // Reset the degeneration-check watermark too (#486): it tracks a byte
            // offset INTO inProgressText, so once that resets to '' a stale (large)
            // mark makes `inProgressText.length - lastDegenerationCheckLen` go
            // negative and the throttled detector stays silent until a later step's
            // text re-grows past the old offset — a whole degenerate step could slip
            // through undetected. Zeroing it re-arms the check from the next byte.
            lastDegenerationCheckLen = 0;
            // Persist this finished step (text + tool calls + results) when it
            // ends. Not awaited, but serialized via stepUpdateChain so writes commit
            // in step order. On a confirmed persist, rotate the run-stream registry
            // ring to drop the on-disk steps (stamp < stepsPersisted); a null
            // return rotates nothing.
            stepUpdateChain = stepUpdateChain.then(async () => {
              const persisted = await updateStreaming();
              if (persisted != null && runId) {
                this.streamRegistry?.confirmPersistedStep(
                  chatId,
                  runId,
                  persisted,
                );
              }
            });
            // #184: persist the run's progress (finished-step count). Fire-and-
            // forget; the hook swallows its own errors.
            if (runId) runHooks?.onStep?.(runId, capturedSteps.length);
          },
          onFinish: async ({ text, finishReason, totalUsage, usage, steps }) => {
            // Finalize the upfront row to 'completed' with the final text,
            // cumulative usage and full UIMessage parts. `inProgressText` is '' here
            // (the last step already finished). Final-step usage
            // (usage.input+output) ≈ the conversation's current context size,
            // distinct from totalUsage. `content` concatenates every step's text;
            // the UI and export render from `metadata.parts`.
            //
            // Empty-turn mitigation (lockdown OFF): if the turn used all its steps
            // without producing any text, append STEP_LIMIT_NO_ANSWER_MARKER as the
            // trailing text. `stepCountIs(MAX_AGENT_STEPS)` surfaces as
            // finishReason 'tool-calls' (or another cap), so this keys off "no text
            // produced" rather than a finishReason.
            const producedText = (steps as StepLike[]).some((s) => s.text?.trim());
            const stepExhausted = steps.length >= MAX_AGENT_STEPS;
            const emptyTurnMarker =
              !producedText && stepExhausted ? STEP_LIMIT_NO_ANSWER_MARKER : '';
            const msgOk = await finalizeAssistant(
              flushAssistant(steps as StepLike[], emptyTurnMarker, 'completed', {
                finishReason: finishReason as string,
                usage: totalUsage as StreamUsage,
                contextTokens:
                  (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) ||
                  undefined,
                // Max context window for the chat header badge denominator;
                // resolved from the admin-configured provider settings (in
                // closure scope here). Omitted/0 = no limit.
                maxContextTokens: resolved?.chatContextWindow,
                pageChanged,
                partsCache,
                replayTrimmedToTokens,
                // #520 Option B: mark the turn when recovery replayed BELOW the
                // configured budget (only when it actually did).
                replayBelowConfiguredBudget:
                  replayBelowConfiguredBudget || undefined,
                // #686 P4: persist the external-MCP failures for this turn.
                mcpFailures,
              }),
            );
            // #184/#487: the RUN is finalized ALWAYS (never gated on the message).
            // If the message finalize GAVE UP, error-mark the run so the asymmetry
            // "run succeeded / message streaming forever" cannot arise; the
            // periodic reconcile then settles the stuck message from this run.
            if (runId) {
              await runHooks?.onSettled?.(
                runId,
                msgOk ? 'completed' : 'error',
                msgOk
                  ? undefined
                  : 'Assistant message could not be persisted (finalize failed).',
              );
            }
            // Turn end (#274): snapshot the open page's current Markdown (after all
            // of the agent's edits this turn) so the NEXT turn can diff against it
            // and detect edits a human made in between. Self-clearing — the agent's
            // own edits are baked in — and this also SEEDS the snapshot on the first
            // turn. Runs once across every terminal path (see snapshotTurnEnd).
            await snapshotTurnEnd();
            // #490: persist the deferred-tool activation set for the next turn.
            await persistActivatedTools();

            // Release the external MCP clients leased for this turn. Runs after
            // both turn-end writes: observers (the turn-lifecycle integration test,
            // operators) treat the lease release as "turn finished". Both writes
            // swallow their own errors, so neither can skip this release.
            await closeExternalClients();

            // Generate the chat title for a freshly created chat AFTER the stream's
            // provider call has completed — NOT concurrently with it. The z.ai coding
            // endpoint stalls one of two concurrent requests to the same plan, which
            // black-holed the chat stream (~300s headers timeout) when title
            // generation raced it. Running it here (solo, fire-and-forget) avoids the
            // race; never block the turn on it, swallow any error.
            if (isNewChat && incomingText) {
              void this.generateTitle(chatId, workspace.id, incomingText).catch(
                (err) => {
                  this.logger.warn(
                    `Title generation failed: ${(err as Error)?.message ?? err}`,
                  );
                },
              );
            }
          },
          onError: async ({ error }) => {
            // NestJS Logger.error(message, stack?, context?): pass the real message
            // (with statusCode when present) + the stack string, not the Error
            // object, so the actual provider cause is clearly logged. Reuse the
            // shared formatter so provider error formatting stays unified.
            const e = error as { stack?: string };
            // #490 reactive branch: classify a CONTEXT-OVERFLOW rejection (the
            // replayed history exceeded the model window). The overflowing turn had
            // no prior usage to trigger preventive trimming, so we record a clear,
            // distinguishable cause AND stamp the row so the NEXT turn's budgeter
            // trims aggressively — the reactive recovery that un-bricks the chat.
            const overflow = isContextOverflowError(error);
            const providerError = describeProviderError(error, String(error));
            const errorText = overflow
              ? `${CONTEXT_OVERFLOW_ERROR_PREFIX} (${providerError})`
              : providerError;
            this.logger.error(`AI chat stream error: ${errorText}`, e?.stack);
            // Finalize the PARTIAL answer streamed before the failure (text + any
            // finished tool steps) WITH the error in metadata, so the turn shows what
            // the user already saw plus the cause — not just a bare error. Status
            // 'error' (#183).
            await finalizeAssistant(
              flushAssistant(capturedSteps, inProgressText, 'error', {
                error: errorText,
                pageChanged,
                partsCache,
                replayTrimmedToTokens,
                // #520: escalate the consecutive-overflow counter so the NEXT turn
                // trims MORE aggressively (0.5**k). k grows by 1 each consecutive
                // overflow; a clean finalize omits the field, resetting it to 0.
                replayOverflowCount: overflow
                  ? priorOverflowCount + 1
                  : undefined,
                // #520 Option B: mark the turn when THIS replay was already below the
                // configured budget (only when it actually was).
                replayBelowConfiguredBudget:
                  replayBelowConfiguredBudget || undefined,
                // #686 P4: persist the external-MCP failures for this turn.
                mcpFailures,
              }),
            );
            // #184: settle the RUN as failed, carrying the provider/transport cause.
            if (runId) await runHooks?.onSettled?.(runId, 'error', errorText);
            // Advance the page snapshot even on failure (#274): an agent edit that
            // committed before the error must be baked into the snapshot, or the
            // next turn would mis-report it as a user edit.
            await snapshotTurnEnd();
            // #490: persist the deferred-tool activation set for the next turn.
            await persistActivatedTools();
            // Released last — see the onFinish path for why the order matters.
            await closeExternalClients();
          },
          onAbort: async ({ steps }) => {
            // #444: distinguish a degeneration abort (our internal controller) from
            // a user Stop / disconnect. On degeneration we truncate the runaway tail
            // before persist (so hundreds of KB of garbage never reach the DB /
            // replay) and record it as an ERROR with a clear, distinguishable reason
            // — NOT a bare 'aborted' (a user Stop) and NOT a swept 'streaming' (a
            // server restart).
            if (degenerationDetected) {
              const truncated = truncateDegeneratedTail(inProgressText);
              await finalizeAssistant(
                flushAssistant(capturedSteps, truncated, 'error', {
                  error: OUTPUT_DEGENERATION_ERROR,
                  pageChanged,
                  partsCache,
                  // #686 P4: persist the external-MCP failures for this turn.
                  mcpFailures,
                }),
              );
              if (runId)
                await runHooks?.onSettled?.(
                  runId,
                  'error',
                  OUTPUT_DEGENERATION_ERROR,
                );
              await snapshotTurnEnd();
              // #490: persist the deferred-tool activation set for the next turn.
              await persistActivatedTools();
              // Released last — see the onFinish path for why the order matters.
              await closeExternalClients();
              return;
            }
            const partialChars =
              capturedSteps.reduce((n, s) => n + (s.text?.length ?? 0), 0) +
              inProgressText.length;
            // Unlike onError/onFinish, this terminal path otherwise writes nothing, so
            // an aborted turn (client disconnect / proxy drop / stop()) would be
            // invisible in the logs. Log it (warn) so the abort is traceable.
            this.logger.warn(
              `AI chat stream aborted (chat ${chatId}) after ${steps.length} ` +
                `step(s), ${partialChars} chars partial text; persisting partial turn.`,
            );
            await finalizeAssistant(
              flushAssistant(capturedSteps, inProgressText, 'aborted', {
                pageChanged,
                partsCache,
                // #686 P4: persist the external-MCP failures for this turn.
                mcpFailures,
              }),
            );
            // #184: settle the RUN as aborted (an explicit user stop reached the
            // run's signal; a disconnect does not abort a run-wrapped turn).
            if (runId) await runHooks?.onSettled?.(runId, 'aborted');
            // Advance the page snapshot even on abort (#274): an agent edit that
            // committed before the client disconnect / stop() must be baked into the
            // snapshot, or the next turn would mis-report it as a user edit.
            await snapshotTurnEnd();
            // #490: persist the deferred-tool activation set for the next turn.
            await persistActivatedTools();
            // Released last — see the onFinish path for why the order matters.
            await closeExternalClients();
          },
        });

        // Drain the stream independently of the client socket so the turn runs to
        // completion (or abort) and the terminal callbacks fire, releasing the
        // per-turn object graph and leased MCP clients. Without it a disconnect
        // leaves a dead socket as the only reader, backpressure stalls the stream
        // and the turn stays in memory (AI SDK v6 "Handling client disconnects").
        // Fire-and-forget; errors are already logged by streamText's onError.
        void result.consumeStream({ onError: () => undefined });

        // Stream the UI-message protocol straight to the hijacked Node response.
        // Without onError the AI SDK masks the cause ('An error occurred.'); surface
        // the real provider message (it never contains the API key).
        //
        // The SDK's default headers already include `x-accel-buffering: no`,
        // `content-type: text/event-stream` and `cache-control: no-cache`;
        // `headers` is passed explicitly anyway (prepareHeaders only fills absent
        // headers). DEPLOYMENT: the reverse proxy MUST NOT buffer this route
        // (nginx honours x-accel-buffering; also set `proxy_buffering off;
        // proxy_cache off;` for /api/ai-chat/stream; traefik does not buffer).
        // Scrub the SDK's hop-by-hop Connection header before it writes the head (Safari/HTTP2).
        stripStreamingHopByHopHeaders(res.raw);
        // Running sum of per-step usage (v6 `finish-step.usage` is per-step). Sent
        // as the cumulative authoritative usage so the client never jumps DOWN.
        let cumulativeStepUsage: ChatStreamUsage | undefined;
        result.pipeUIMessageStreamToResponse(res.raw, {
          // #184 phase 1.5: both fields are gated on `runId` (present only for a
          // durable run); without a run the wire carries no start.messageId.
          ...(runId
            ? {
                // Tee the SSE frames into the run-stream registry so late tabs can
                // attach (replay + live tail).
                consumeSseStream: ({
                  stream,
                }: {
                  stream: ReadableStream<string>;
                }) =>
                  this.streamRegistry?.bind(
                    chatId,
                    runId!,
                    assistantId,
                    stream,
                  ),
                // Stamp the persisted assistant row's DB id onto the streamed
                // message so every tab renders the SAME id as the DB row (id-based
                // reconciliation). Seeding is best-effort: when it failed, let the
                // client generate the id.
                ...(assistantId
                  ? { generateMessageId: () => assistantId }
                  : {}),
              }
            : {}),
          headers: { 'X-Accel-Buffering': 'no' },
          // Attach the authoritative chatId on the `start` part so the client adopts
          // the real chat id at the first chunk instead of guessing the newest chat
          // in its list. `messageMetadata` runs on `start`, `finish-step` and
          // `finish` (ai@6).
          //
          // `finish-step.usage` is per-step in v6 and the client replaces
          // metadata.usage, so send the running cumulative sum (it converges to
          // `finish.totalUsage`) instead of letting the counter jump down.
          messageMetadata: ({ part }) => {
            const p = part as StreamMetadataPart;
            if (p.type === 'finish-step') {
              cumulativeStepUsage = accumulateStepUsage(
                cumulativeStepUsage,
                normalizeStreamUsage(p.usage),
              );
            }
            return chatStreamMetadata(
              p,
              chatId,
              cumulativeStepUsage,
              runId,
              // #686 P4: deliver the external-MCP failures on the `start` part.
              mcpFailures,
            );
          },
          // Stream reasoning (thinking) parts to the client so the live counter can
          // estimate reasoning tokens from streamed text. v6 default is already
          // true; set explicitly so the intent survives any future SDK default
          // change. Providers that don't emit reasoning text still surface the
          // count via the authoritative `usage.reasoningTokens` on finish-step.
          sendReasoning: true,
          onError: (error: unknown) => {
            // Reuse the shared formatter so provider error formatting stays
            // unified between the log line and the streamed error message.
            return describeProviderError(error, 'AI stream error');
          },
        });

        // Force the status line + headers onto the socket NOW (before the model's
        // first token), so the proxy sees the response start immediately even if the
        // provider's first chunk is delayed. writeToServerResponse already called
        // writeHead synchronously above; flushHeaders is a belt-and-braces no-op once
        // headers are sent, and is guarded for response-likes that lack it.
        res.raw.flushHeaders?.();
        // Heartbeat: keep the SSE stream progressing during silent tool/think gaps (Safari/proxy idle timeout).
        startSseHeartbeat(res.raw, 15_000);
      } catch (err) {
        // Synchronous failure before/while wiring the stream: the terminal
        // callbacks will not run, so release the leased external clients here and
        // re-throw for the controller to surface on the socket.
        await closeExternalClients();
        throw err;
      }
    } catch (err) {
      // #184 safety net (see the opening comment): settle the run on ANY failure
      // before streamText's callbacks own the lifecycle, so the run row never
      // stays 'running' forever (which would 409 every later turn in this chat).
      // finalizeRun (onSettled) is idempotent — a settle here and a settle from a
      // streamText callback collapse to a single terminal write.
      if (runId) {
        // #184 phase 1.5: a failure here means the tee `done` will never arrive,
        // so release the registry entry's subscribers explicitly — otherwise an
        // attached tab hangs forever.
        this.streamRegistry?.abortEntry(chatId, runId);
        // Distinguish an explicit Stop (the run's signal aborted during setup) from
        // a real failure, so the run settles with the correct terminal status
        // instead of always 'error'. onSettled/finalizeRun is idempotent, so this
        // is safe even if a streamText callback also settles the run.
        const settleStatus = effectiveSignal.aborted ? 'aborted' : 'error';
        await runHooks?.onSettled?.(
          runId,
          settleStatus,
          settleStatus === 'aborted'
            ? undefined
            : err instanceof Error
              ? err.message
              : 'Agent run failed before streaming started',
        );
      }
      throw err;
    }
  }

  /**
   * One-shot page-title generation from a note's content. No tools, no
   * streaming; returns the title instead of writing it (the client applies it via
   * /pages/update, which enforces edit permission). The content is truncated to
   * keep the prompt cheap. Throws AiNotConfiguredException (503) if AI is
   * unconfigured.
   */
  async generatePageTitle(
    workspaceId: string,
    content: string,
  ): Promise<string> {
    const model = await this.ai.getChatModel(workspaceId);
    const { text } = await generateText({
      model,
      system:
        'You generate a single concise, descriptive title for a note based on ' +
        'its content. Reply with the title only — at most 8 words, no quotes, ' +
        'no trailing punctuation, written in the same language as the note.',
      prompt: content.slice(0, 8000),
    });
    return cleanGeneratedTitle(text);
  }

  /**
   * Cheap, non-blocking title generation from the first user message. Uses
   * generateText (async) and writes the result back onto the chat row. Any
   * failure is caught by the caller — title is best-effort cosmetic metadata.
   */
  private async generateTitle(
    chatId: string,
    workspaceId: string,
    firstMessage: string,
  ): Promise<void> {
    const model = await this.ai.getChatModel(workspaceId);
    const { text } = await generateText({
      model,
      system:
        'Generate a short, descriptive chat title (max 6 words) for the ' +
        "user's first message. Reply with the title only — no quotes, no " +
        'punctuation at the end.',
      prompt: firstMessage.slice(0, 2000),
    });
    const title = text
      .trim()
      .replace(/^["']|["']$/g, '')
      .slice(0, 120);
    if (title) {
      await this.aiChatRepo.update(chatId, { title }, workspaceId);
    }
  }
}

/** Shape of the AI SDK v6 LanguageModelUsage we forward to the client. The SDK
 *  exposes `reasoningTokens` both as a (deprecated) top-level field and under
 *  `outputTokenDetails.reasoningTokens`; we normalize to a single field so the
 *  client gets one stable usage shape regardless of provider/SDK version. */
interface StreamUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  outputTokenDetails?: { reasoningTokens?: number };
}

/** A streamed part the messageMetadata callback can receive (only the fields we read). */
interface StreamMetadataPart {
  type: string;
  usage?: StreamUsage;
  totalUsage?: StreamUsage;
}

/** Authoritative usage we attach to a streamed assistant message's metadata. */
export interface ChatStreamUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
}

/** Normalize an AI SDK usage object to our flat client-facing shape, resolving
 *  reasoning tokens from either the new `outputTokenDetails` or the deprecated
 *  top-level field. Returns undefined for a missing usage object. */
function normalizeStreamUsage(
  usage: StreamUsage | undefined,
): ChatStreamUsage | undefined {
  if (!usage) return undefined;
  const reasoningTokens =
    usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    reasoningTokens,
  };
}

/** Sum a (normalized) per-step usage into a running cumulative usage. v6's
 *  `finish-step.usage` is PER-STEP, so the caller accumulates across steps; the
 *  cumulative sum converges to the turn's `totalUsage` (no down-jump on the
 *  client). Returns undefined only when both sides are absent. Pure. */
export function accumulateStepUsage(
  acc: ChatStreamUsage | undefined,
  step: ChatStreamUsage | undefined,
): ChatStreamUsage | undefined {
  if (!acc) return step;
  if (!step) return acc;
  const add = (a?: number, b?: number): number | undefined =>
    a == null && b == null ? undefined : (a ?? 0) + (b ?? 0);
  return {
    inputTokens: add(acc.inputTokens, step.inputTokens),
    outputTokens: add(acc.outputTokens, step.outputTokens),
    totalTokens: add(acc.totalTokens, step.totalTokens),
    reasoningTokens: add(acc.reasoningTokens, step.reasoningTokens),
  };
}

/**
 * One external-MCP connection failure surfaced to the client and persisted.
 * `name` is the server's display name (or `(external toolset)` for a total build
 * failure); `reason` is a short, non-sensitive cause (never a URL/header).
 */
export interface McpFailureRecord {
  name: string;
  reason: string;
}

/** Truncate a failure reason to the shared per-reason budget (#686). */
export function truncateMcpReason(reason: string): string {
  const r = typeof reason === 'string' ? reason : String(reason ?? '');
  return r.length > MCP_FAILURE_REASON_MAX
    ? r.slice(0, MCP_FAILURE_REASON_MAX)
    : r;
}

/**
 * Build the capped external-MCP failure list from a turn's per-server outcomes
 * (#686 P4): ONLY the `ok:false` outcomes, at most {@link MCP_FAILURES_CAP} of
 * them, each reason truncated to {@link MCP_FAILURE_REASON_MAX} chars (ARCH
 * INVARIANT #1 — a bounded payload). A hostile/verbose provider error therefore
 * can never dominate the delivered/persisted metadata.
 */
export function buildMcpFailures(
  outcomes:
    | ReadonlyArray<{ name?: string; ok?: boolean; reason?: string }>
    | undefined,
): McpFailureRecord[] {
  if (!Array.isArray(outcomes)) return [];
  const out: McpFailureRecord[] = [];
  for (const o of outcomes) {
    if (!o || o.ok !== false) continue;
    out.push({
      name: typeof o.name === 'string' ? o.name : '',
      reason: truncateMcpReason(o.reason ?? 'unavailable'),
    });
    if (out.length >= MCP_FAILURES_CAP) break;
  }
  return out;
}

/**
 * Metadata for the streamed assistant UI message. The AI SDK calls
 * `messageMetadata` on the `start`, `finish-step` and `finish` parts:
 *  - `start`        -> `{ chatId }` so the client adopts the real chat id at the
 *                      first chunk (see adopt-chat-id.ts).
 *  - `finish-step`  -> `{ usage }`, the cumulative usage so far (the caller passes
 *                      the running sum, since v6 per-step usage is not cumulative).
 *  - `finish`       -> `{ usage }` from the turn's `totalUsage`.
 * Any other part type contributes no metadata. Pure.
 */
export function chatStreamMetadata(
  part: StreamMetadataPart,
  chatId: string,
  cumulativeStepUsage?: ChatStreamUsage,
  // #184: the active run's id, attached alongside `chatId` on the `start` part so
  // the client learns the run it can reconnect to / stop. Omitted when the turn
  // is not run-wrapped (no runHooks — test harnesses only).
  runId?: string,
  // #686 P4: external-MCP connection failures for this turn, delivered on the
  // `start` part so the client can show which external tools are unavailable.
  // Omitted when the list is empty (unchanged wire for the common no-failure case).
  mcpFailures?: ReadonlyArray<McpFailureRecord>,
):
  | { chatId: string; runId?: string; mcpFailures?: McpFailureRecord[] }
  | { usage: ChatStreamUsage }
  | undefined {
  if (part.type === 'start') {
    const base = runId ? { chatId, runId } : { chatId };
    return mcpFailures && mcpFailures.length > 0
      ? { ...base, mcpFailures: [...mcpFailures] }
      : base;
  }
  if (part.type === 'finish-step') {
    return cumulativeStepUsage ? { usage: cumulativeStepUsage } : undefined;
  }
  if (part.type === 'finish') {
    const usage = normalizeStreamUsage(part.totalUsage);
    return usage ? { usage } : undefined;
  }
  return undefined;
}

/**
 * The provider-reported context size of the most recent assistant turn, read from
 * its persisted `metadata.contextTokens` (#490 replay budgeter's PRIMARY signal —
 * the provider's own fact, not an estimate). Returns undefined for a chat with no
 * assistant turn yet, or one whose last turn recorded no usage (e.g. it errored),
 * in which case the budgeter falls back to the char-estimate.
 */
export function lastAssistantContextTokens(
  history: ReadonlyArray<AiChatMessage>,
): number | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const row = history[i];
    if (row.role !== 'assistant') continue;
    const meta = (row.metadata ?? {}) as { contextTokens?: unknown };
    const n = meta.contextTokens;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
  }
  return undefined;
}

/**
 * Seed the per-turn deferred-tool activation set from a chat's persisted
 * metadata, intersected with the current valid deferred names so a changed
 * allowlist / role never resurrects a tool that no longer exists. A non-array
 * stored value is ignored.
 */
export function seedActivatedTools(
  metadata: Record<string, unknown> | undefined,
  validDeferredNames: ReadonlySet<string>,
): string[] {
  const stored = metadata?.activatedTools;
  if (!Array.isArray(stored)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of stored) {
    if (typeof name === 'string' && validDeferredNames.has(name) && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * How many consecutive recent turns were rejected for context overflow: `k`, read
 * from the most recent assistant row's `metadata.replayOverflowCount` (incremented
 * by onError on each consecutive overflow, reset to 0 on a clean finalize). The
 * next turn feeds it to {@link resolveEffectiveReplayThreshold} to trim with
 * escalating aggression. Only the last assistant row matters.
 *
 * A row with the boolean stamp (`replayOverflow: true`, no count) reads as k=1.
 */
export function lastAssistantReplayOverflowCount(
  history: ReadonlyArray<AiChatMessage>,
): number {
  for (let i = history.length - 1; i >= 0; i--) {
    const row = history[i];
    if (row.role !== 'assistant') continue;
    const meta = (row.metadata ?? {}) as {
      replayOverflowCount?: unknown;
      replayOverflow?: unknown;
    };
    if (typeof meta.replayOverflowCount === 'number') {
      // Guard against a corrupt/negative persisted value.
      return meta.replayOverflowCount > 0
        ? Math.floor(meta.replayOverflowCount)
        : 0;
    }
    // Back-compat: legacy boolean stamp -> one overflow (0.5× cut).
    return meta.replayOverflow === true ? 1 : 0;
  }
  return 0;
}

/** The last message with role 'user' from a useChat payload, if any. */
function lastUserMessage(
  messages: UIMessage[] | undefined,
): UIMessage | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return messages[i];
  }
  return undefined;
}

/** Concatenate the text parts of a UIMessage into a plain string. */
function uiMessageText(message: UIMessage | undefined): string {
  if (!message?.parts) return '';
  return message.parts
    .filter((p): p is { type: 'text'; text: string } => p?.type === 'text')
    .map((p) => p.text)
    .join('');
}

/** Build a single text part array (or empty when there is no text). */
function textPart(text: string): Array<{ type: 'text'; text: string }> {
  return text ? [{ type: 'text', text }] : [];
}

/**
 * Part types accepted on an incoming user turn. The client only sends a single
 * text part; anything else (most dangerously a tool-part in `input-available`
 * state) would be persisted and replayed through `convertToModelMessages` on
 * every later turn.
 */
const ALLOWED_USER_PART_TYPES: ReadonlySet<string> = new Set(['text']);

/**
 * Keep only whitelisted parts on a client-supplied user message; report each
 * dropped part's type via `onDrop` (the caller warns). Returns `undefined` when
 * nothing survives (no parts / none whitelisted), so the caller persists a null
 * metadata rather than an empty-parts object. Never throws.
 */
export function sanitizeUserParts(
  parts: UIMessage['parts'] | undefined,
  onDrop: (type: string) => void,
): UIMessage['parts'] | undefined {
  if (!Array.isArray(parts)) return undefined;
  const kept = parts.filter((p) => {
    const type =
      typeof (p as { type?: unknown })?.type === 'string'
        ? (p as { type: string }).type
        : '';
    if (ALLOWED_USER_PART_TYPES.has(type)) return true;
    onDrop(type || '(unknown)');
    return false;
  });
  return kept.length > 0 ? (kept as UIMessage['parts']) : undefined;
}

/** Marker for a history row whose tool parts could not be replayed (#489). */
export const TOOL_CONTEXT_OMITTED_MARKER = '[tool context omitted]';

/**
 * Synthetic error text for a tool call that neither returned a result nor threw
 * a `tool-error` — i.e. it was interrupted mid-step (an abort / server restart).
 * Shared by `assistantParts` (the replayed `output-error` part) and
 * `serializeSteps` (the `{ kind: 'interrupted' }` trace element) so the replay
 * text and the trace stay in lockstep (#490).
 */
export const TOOL_CALL_INCOMPLETE_TEXT = 'Tool call did not complete.';

/**
 * Convert persisted UI history to model messages, tolerating a single poisoned
 * row. `convertToModelMessages` throws if ANY row is malformed, which would fail
 * every turn of the chat. On a batch failure, convert per row: a bad row is
 * degraded to its readable text plus a `[tool context omitted]` marker (the model
 * must see that its tool context was truncated). AI SDK v6 keeps a tool call and
 * its result in the same assistant UIMessage, so per-row conversion preserves
 * call/result pairing.
 */
export async function convertHistoryResilient(
  uiMessages: Array<Omit<UIMessage, 'id'> & { id: string }>,
  onDegrade: (index: number, err: unknown) => void,
): Promise<ModelMessage[]> {
  try {
    return await convertToModelMessages(uiMessages as UIMessage[]);
  } catch {
    const out: ModelMessage[] = [];
    for (let i = 0; i < uiMessages.length; i++) {
      const m = uiMessages[i];
      try {
        out.push(...(await convertToModelMessages([m as UIMessage])));
      } catch (err) {
        onDegrade(i, err);
        const text = uiMessageText(m as UIMessage);
        const degraded = text
          ? `${text}\n\n${TOOL_CONTEXT_OMITTED_MARKER}`
          : TOOL_CONTEXT_OMITTED_MARKER;
        out.push({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: degraded,
        } as ModelMessage);
      }
    }
    return out;
  }
}

/**
 * Minimal shapes of the AI SDK v6 step objects we read to rebuild UIMessage
 * parts (see ai@6.0.134 `StepResult`: `text`, `toolCalls` -> TypedToolCall,
 * `toolResults` -> TypedToolResult). Typed loosely so this survives provider
 * variation; only the fields we persist are referenced.
 */
type StepLike = {
  text?: string;
  toolCalls?: ReadonlyArray<{
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
  }>;
  toolResults?: ReadonlyArray<{
    toolCallId?: string;
    toolName?: string;
    output?: unknown;
  }>;
  // ai@6.0.134: a tool that THREW surfaces as a `tool-error` content part
  // ({ type:'tool-error', toolCallId, toolName, input, error }), NOT as a
  // `toolResults` entry (which holds only successes). Read from here so failed
  // calls are persisted with their real error instead of being dropped.
  content?: ReadonlyArray<{
    type?: string;
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
    error?: unknown;
  }>;
};

/**
 * Compaction tunables for persisted tool outputs. Read tools return whole pages;
 * their outputs live in `metadata.parts` and are re-sent to the provider on every
 * later turn. Outputs are kept FULL up to MAX_TOOL_OUTPUT_BYTES: a model that
 * sees a truncation marker in its own history re-reads the page. Only an output
 * above the cap is compacted, preserving its shape and the small scalar fields
 * (id/title/pageId) the client reads to render citations.
 */
// Only an output whose JSON serialization exceeds this is compacted; anything
// smaller is stored and replayed verbatim (returned unchanged, by identity).
const MAX_TOOL_OUTPUT_BYTES = 200_000;
// Inside the backstop path only (i.e. once the whole output already exceeded
// MAX_TOOL_OUTPUT_BYTES), a string longer than this is reduced to a leading
// preview; normal outputs never reach this branch.
const TOOL_OUTPUT_STRING_LIMIT = 600;
// Number of leading characters kept from a truncated string.
const TOOL_OUTPUT_STRING_PREVIEW = 500;
// Maximum number of array elements kept; the rest are summarized by a marker.
const TOOL_OUTPUT_ARRAY_LIMIT = 50;
// Beyond this nesting depth a subtree is replaced with a marker, bounding the
// recursion and the size of pathological deeply-nested payloads.
const TOOL_OUTPUT_MAX_DEPTH = 8;

/**
 * Recursively compact a single tool output before it is persisted. Preserves the
 * value's kind and its keys/scalars (so the client can still extract
 * id/title/pageId citations from `part.output`); only long strings, long arrays
 * and very deep subtrees are shrunk. Returns a plain JSON-serializable value.
 */
export function compactToolOutput(output: unknown): unknown {
  // Fast path: nothing to do for null/undefined or non-serializable values.
  if (output === null || output === undefined) return output;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(output);
  } catch {
    // Non-serializable (e.g. circular): return unchanged, never throw here.
    return output;
  }
  // JSON.stringify returns undefined for values like a bare function/symbol.
  if (serialized === undefined) return output;
  // Below the size threshold: return the original unchanged (by identity).
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_TOOL_OUTPUT_BYTES) {
    return output;
  }
  return compactValue(output, 0);
}

/** Recursive worker for compactToolOutput; see the constants above for limits. */
function compactValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    if (value.length > TOOL_OUTPUT_STRING_LIMIT) {
      return `${value.slice(0, TOOL_OUTPUT_STRING_PREVIEW)}…[${
        value.length - TOOL_OUTPUT_STRING_PREVIEW
      } chars omitted from stored chat history to bound replay size — call the tool again to read the full output]`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    const kept = value
      .slice(0, TOOL_OUTPUT_ARRAY_LIMIT)
      .map((el) => compactValue(el, depth + 1));
    if (value.length > TOOL_OUTPUT_ARRAY_LIMIT) {
      // Append a marker summarizing the dropped tail so the size is bounded
      // while signalling that the array was longer.
      kept.push({
        _truncated: true,
        omittedItems: value.length - TOOL_OUTPUT_ARRAY_LIMIT,
      });
    }
    return kept;
  }
  if (typeof value === 'object' && value !== null) {
    if (depth >= TOOL_OUTPUT_MAX_DEPTH) {
      return { _truncated: true, note: 'nested content omitted for replay' };
    }
    // Rebuild the object preserving keys (keeps id/title/pageId), compacting
    // each value one level deeper.
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = compactValue(v, depth + 1);
    }
    return out;
  }
  // Numbers, booleans, etc.: nothing to shrink.
  return value;
}

/**
 * Extract a bounded string message from a `tool-error` part's `error` field for
 * persistence and history replay. The field may be an `Error`, a string, or an
 * arbitrary object, so pull a message robustly. The result is passed through
 * `compactValue` so a very long error honors the SAME truncation limits the file
 * already applies to tool outputs (no new limit is introduced here).
 */
function normalizeToolError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : error != null &&
            typeof (error as { message?: unknown }).message === 'string'
          ? (error as { message: string }).message
          : String(error);
  return compactValue(message, 0) as string;
}

/**
 * Per-turn memo for {@link assistantParts}: a step's rebuilt parts keyed by the
 * step object's identity. Finished steps keep a stable reference across flushes,
 * and `compactToolOutput` stringifies each (often 50–200 KB) output, so without
 * the memo every flush re-stringifies every prior step. WeakMap so a turn's steps
 * are GC'd with the turn.
 */
export type StepPartsCache = WeakMap<object, Array<Record<string, unknown>>>;

/** Build the parts for ONE step (text + a part per tool call). Pure. */
function buildStepParts(step: StepLike): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  if (step.text) {
    parts.push({ type: 'text', text: step.text });
  }
  // Index this step's results by tool call id to pair calls with outputs.
  const resultsById = new Map<string, unknown>();
  for (const r of step.toolResults ?? []) {
    if (r.toolCallId) resultsById.set(r.toolCallId, r.output);
  }
  // Index this step's THROWN tool failures (ai@6 `tool-error` content parts)
  // by tool call id, so a call that failed replays with its real error text.
  const errorsById = new Map<string, unknown>();
  for (const part of step.content ?? []) {
    if (part.type === 'tool-error' && part.toolCallId) {
      errorsById.set(part.toolCallId, part.error);
    }
  }
  for (const call of step.toolCalls ?? []) {
    if (!call.toolName || !call.toolCallId) continue;
    const hasResult = resultsById.has(call.toolCallId);
    if (hasResult) {
      // output-available: the tool returned; the next turn replays its result.
      parts.push({
        type: `tool-${call.toolName}`,
        toolCallId: call.toolCallId,
        state: 'output-available',
        input: call.input,
        output: compactToolOutput(resultsById.get(call.toolCallId)),
      });
    } else if (errorsById.has(call.toolCallId)) {
      // The tool THREW: replay the REAL error so the model on the next turn
      // knows WHY the call failed (and does not blindly repeat it). An
      // output-error round-trips through convertToModelMessages as a balanced
      // tool-call + tool-result, keeping the rebuilt history valid.
      parts.push({
        type: `tool-${call.toolName}`,
        toolCallId: call.toolCallId,
        state: 'output-error',
        input: call.input,
        errorText: normalizeToolError(errorsById.get(call.toolCallId)),
      });
    } else {
      // No paired result AND no tool-error (e.g. aborted mid-step). Persisting
      // a bare tool-call (input-available) would replay as an unpaired call and
      // throw MissingToolResultsError on the next turn (convertToModelMessages
      // emits no tool-result for it). Emit a SYNTHETIC paired result instead:
      // an output-error round-trips through convertToModelMessages as a
      // balanced tool-call + tool-result, keeping the rebuilt history valid.
      parts.push({
        type: `tool-${call.toolName}`,
        toolCallId: call.toolCallId,
        state: 'output-error',
        input: call.input,
        errorText: TOOL_CALL_INCOMPLETE_TEXT,
      });
    }
  }
  return parts;
}

/**
 * Rebuild the full UIMessage `parts` for an assistant turn from the SDK steps, so
 * multi-turn history replays prior tool calls/results to the model. Per step:
 * the step's text part (if any), then a static `tool-${name}` part per tool call —
 * `output-available` when the tool returned, or a synthetic `output-error` when it
 * did not, so the call is never persisted unpaired (a bare `input-available`
 * replays as an unpaired call and throws MissingToolResultsError). Falls back to a
 * single `text` part from `fallbackText` when the steps carry no text.
 */
export function assistantParts(
  steps: ReadonlyArray<StepLike> | undefined,
  fallbackText: string,
  cache?: StepPartsCache,
): UIMessage['parts'] {
  const parts: Array<Record<string, unknown>> = [];
  for (const step of steps ?? []) {
    // Memoize per step object (#490): a finished step is immutable and keeps its
    // reference across flushes, so its parts (and the costly output stringify) are
    // built exactly once per turn. A cache miss (or no cache) just rebuilds.
    let stepParts = cache?.get(step as object);
    if (!stepParts) {
      stepParts = buildStepParts(step);
      cache?.set(step as object, stepParts);
    }
    parts.push(...stepParts);
  }
  const sawText = parts.some((p) => p.type === 'text');
  if (!sawText && fallbackText) {
    // No per-step text (e.g. a single final block): append the final text after
    // any tool parts so the natural call -> result -> answer order is preserved.
    parts.push({ type: 'text', text: fallbackText });
  }
  return parts as UIMessage['parts'];
}

/**
 * Map a persisted message row back to a UIMessage. User messages restore their
 * stored parts when available; assistant messages restore the reconstructable
 * parts from metadata, falling back to a single text part from `content`.
 */
export function rowToUiMessage(row: AiChatMessage): Omit<UIMessage, 'id'> & {
  id: string;
} {
  const role = row.role === 'assistant' ? 'assistant' : 'user';
  const meta = (row.metadata ?? {}) as { parts?: UIMessage['parts'] };
  const parts =
    Array.isArray(meta.parts) && meta.parts.length > 0
      ? meta.parts
      : textPart(row.content ?? '');
  return { id: row.id, role, parts: parts as UIMessage['parts'] };
}

/**
 * Cheap step-marker metadata for the per-step UPDATE. Advances `stepsPersisted`
 * (the resume attach frontier) and keeps `toolTraceVersion`, without the `parts`
 * blob (parts live in the steps table; the full `metadata.parts` is assembled at
 * finalize by flushAssistant). `parts: []` is the discriminator that routes
 * reconstruction to the steps table.
 */
export function stepMarkerMetadata(
  stepsPersisted: number,
): Record<string, unknown> {
  return { parts: [], toolTraceVersion: 2, stepsPersisted };
}

/**
 * Whether an assistant row carries its full UI parts inline (`metadata.parts`).
 * True for every finished row and for old full-row streaming snapshots; false
 * for a mid-run row whose per-step parts live in `ai_chat_run_steps`. The
 * reconstruct seam branches on this.
 */
export function rowHasInlineParts(row: { metadata?: unknown }): boolean {
  const meta = (row.metadata ?? {}) as { parts?: unknown };
  return Array.isArray(meta.parts) && meta.parts.length > 0;
}

/**
 * Concatenate persisted per-step parts (in `stepIndex` order) into the turn's UI
 * parts. Reproduces EXACTLY what flushAssistant → assistantParts would have
 * written to `metadata.parts` for those finished steps, since each step row stored
 * `assistantParts([step])` at persist time.
 */
export function assembleStepParts(
  stepRows: ReadonlyArray<{ stepIndex: number; parts: unknown }>,
): UIMessage['parts'] {
  const parts: Array<Record<string, unknown>> = [];
  for (const step of [...stepRows].sort((a, b) => a.stepIndex - b.stepIndex)) {
    if (Array.isArray(step.parts)) {
      parts.push(...(step.parts as Array<Record<string, unknown>>));
    }
  }
  return parts as UIMessage['parts'];
}

/**
 * The single backend-switch seam: given an assistant row and its step rows,
 * return the turn's UI `parts` + persisted step count, reading from the row when
 * it carries inline parts and from the steps table otherwise. The consumers
 * (attach seed, delta poll, export) go through this / {@link hydrateAssistantParts}
 * so they never branch on the storage shape.
 */
export function reconstructRunParts(
  row: { metadata?: unknown; content?: string | null },
  stepRows: ReadonlyArray<{ stepIndex: number; parts: unknown }>,
): { parts: UIMessage['parts']; stepsPersisted: number } {
  if (rowHasInlineParts(row)) {
    const meta = row.metadata as {
      parts: UIMessage['parts'];
      stepsPersisted?: number;
    };
    return {
      parts: meta.parts,
      stepsPersisted:
        typeof meta.stepsPersisted === 'number'
          ? meta.stepsPersisted
          : stepRows.length,
    };
  }
  if (stepRows.length > 0) {
    return {
      parts: assembleStepParts(stepRows),
      stepsPersisted: stepRows.length,
    };
  }
  // No inline parts and no step rows: an old-era seed / empty streaming row. Fall
  // back to a single text part from `content` (mirrors rowToUiMessage).
  return {
    parts: textPart(row.content ?? '') as UIMessage['parts'],
    stepsPersisted: 0,
  };
}

/**
 * Fill each assistant row's `metadata.parts` from its step rows when the row
 * does not carry them inline (a mid-run row), so consumers that read
 * `metadata.parts` off the raw row (client seed/poll, Markdown export) see the
 * reconstructed parts. Other rows pass through untouched. Pure: returns new row
 * objects, never mutates the inputs.
 */
export function hydrateAssistantParts<
  T extends { id: string; role?: string; metadata?: unknown },
>(
  rows: ReadonlyArray<T>,
  stepsByMessage: Map<
    string,
    ReadonlyArray<{ stepIndex: number; parts: unknown }>
  >,
): T[] {
  return rows.map((row) => {
    if (row.role !== 'assistant' || rowHasInlineParts(row)) return row;
    const steps = stepsByMessage.get(row.id);
    if (!steps || steps.length === 0) return row;
    return {
      ...row,
      metadata: {
        ...((row.metadata ?? {}) as Record<string, unknown>),
        parts: assembleStepParts(steps),
      },
    };
  });
}

/**
 * The persisted-row patch shape produced by {@link flushAssistant}. It is the
 * SAME shape the assistant repo insert/update consume (content + toolCalls +
 * metadata) plus the lifecycle `status` column added in #183.
 */
export interface AssistantFlush {
  content: string;
  toolCalls: unknown;
  metadata: Record<string, unknown>;
  status: 'streaming' | 'completed' | 'error' | 'aborted';
}

/**
 * Pure decision for the terminal finalize: UPDATE the upfront row when
 * `assistantId` exists, else INSERT a fresh terminal row so the turn is not lost.
 * Returns `{ kind: 'update', id }` or `{ kind: 'insert' }`.
 */
export function planFinalizeAssistant(
  assistantId: string | undefined,
): { kind: 'update'; id: string } | { kind: 'insert' } {
  return assistantId ? { kind: 'update', id: assistantId } : { kind: 'insert' };
}

/** The repo surface the terminal finalize needs (structural — the real repo and
 *  a test mock both satisfy it). */
export interface FinalizeRepo {
  insert(insertable: Record<string, unknown>): Promise<unknown>;
  // #487: the OWNER terminal write is CONDITIONAL (status='streaming' OR
  // metadata.finalizeFailed) so the owner overwrites a reconcile stamp but never
  // an already-proper terminal row (owner-write priority).
  finalizeOwner(
    id: string,
    workspaceId: string,
    patch: AssistantFlush,
  ): Promise<unknown>;
}

/**
 * Apply a finalize `plan` with the terminal `flushed` payload: conditionally
 * UPDATE the upfront row (owner-write priority), or INSERT a fresh terminal row.
 * Shared by finalizeAssistant and its test. No error handling — the caller wraps
 * and retries it.
 */
export async function applyFinalize(
  repo: FinalizeRepo,
  plan: { kind: 'update'; id: string } | { kind: 'insert' },
  base: { chatId: string; workspaceId: string; userId: string },
  flushed: AssistantFlush,
): Promise<void> {
  if (plan.kind === 'update') {
    await repo.finalizeOwner(plan.id, base.workspaceId, flushed);
    return;
  }
  await repo.insert({
    chatId: base.chatId,
    workspaceId: base.workspaceId,
    userId: base.userId,
    role: 'assistant',
    content: flushed.content,
    toolCalls: flushed.toolCalls ?? null,
    metadata: flushed.metadata,
    status: flushed.status,
  });
}

/**
 * Deep-strip NUL characters (`\u0000`) from every string in a value, returning
 * the SAME reference when nothing changed (so the no-NUL common case allocates
 * nothing). Postgres rejects a NUL in BOTH `text` and `jsonb` columns ("invalid
 * input syntax for type json" / "unsupported Unicode escape sequence"), so a
 * stray NUL in model output or a tool result — e.g. a truncated multibyte read
 * of a web page — otherwise fails EVERY persist of the assistant row, silently
 * dropping that turn's content from the DB while the live stream still shows it.
 * Applied at the flushAssistant choke point so content + toolCalls + metadata are
 * all covered. Exported for the unit test.
 */
export function stripNulChars<T>(value: T): T {
  if (typeof value === 'string') {
    return (value.includes('\u0000')
      ? value.replaceAll('\u0000', '')
      : value) as T;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const s = stripNulChars(v);
      if (s !== v) changed = true;
      return s;
    });
    return (changed ? out : value) as T;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const s = stripNulChars(v);
      if (s !== v) changed = true;
      out[k] = s;
    }
    return (changed ? out : value) as T;
  }
  return value;
}

/**
 * Pure assistant-row builder. Given the turn's finished steps, the in-progress
 * text and the lifecycle status, returns the row patch to persist. The same path
 * runs for the upfront insert (empty steps, 'streaming'), every per-step update
 * and the terminal finalize, so it must stay a pure function (no `this`, no IO).
 *
 * `metadata.parts` is assistantParts over the finished steps plus the in-progress
 * text as a trailing text part. `finishReason`, `error`, `usage`, `contextTokens`
 * and `maxContextTokens` are attached only when provided.
 */
export function flushAssistant(
  capturedSteps: ReadonlyArray<StepLike> | undefined,
  inProgressText: string,
  status: 'streaming' | 'completed' | 'error' | 'aborted',
  extra?: {
    finishReason?: string;
    usage?: ChatStreamUsage | StreamUsage | undefined;
    contextTokens?: number;
    maxContextTokens?: number;
    error?: string;
    pageChanged?: { title: string; diff: string } | null;
    // Per-turn step->parts memo (#490): pass the SAME cache on every flush of a
    // turn so each finished step's output is stringified once, not once per flush.
    partsCache?: StepPartsCache;
    // #490 observability: when the replay budgeter trimmed this turn's history,
    // the (estimated) token size it trimmed to — the UI can show "replay truncated
    // at N tokens". Omitted when nothing was trimmed.
    replayTrimmedToTokens?: number;
    // #490/#520 reactive branch: the consecutive context-overflow count for THIS
    // turn (prior streak + 1) when the provider rejected it for context overflow.
    // Stamped into metadata so the NEXT turn's budgeter trims with escalating
    // aggression (0.5**k). Omitted (undefined) on a clean turn, which resets k to 0.
    replayOverflowCount?: number;
    // #520 Option B observability: true when recovery replayed this turn's history
    // BELOW the admin-configured budget (the configured window did not fit and the
    // anti-brick invariant cut past it). Omitted on a normal in-budget replay so the
    // flag marks ONLY the "config is factually too large" case.
    replayBelowConfiguredBudget?: boolean;
    // #686 P4: the external-MCP connection failures for this turn (capped by
    // buildMcpFailures). Persisted so history / the UI can show which external
    // tools were unavailable. Omitted when there were none.
    mcpFailures?: ReadonlyArray<McpFailureRecord>;
  },
): AssistantFlush {
  const finished = capturedSteps ?? [];
  const stepsText = finished.map((s) => s.text ?? '').join('');
  const trailing = inProgressText ?? '';
  // assistantParts emits text parts only for FINISHED steps; append the
  // in-progress step's text (the partial answer cut off by an error/abort, or
  // simply not yet flushed mid-stream) as the last text part so the persisted
  // parts match what streamed to the client.
  const parts = assistantParts(
    finished,
    '',
    extra?.partsCache,
  ) as unknown as Array<Record<string, unknown>>;
  if (trailing) parts.push({ type: 'text', text: trailing });

  const metadata: Record<string, unknown> = {
    parts: parts as unknown as UIMessage['parts'],
    // Era marker for the `tool_calls` trace shape (#490): v2 stores outcome flags
    // ({ ok } / { error, kind }) and NO tool output (the output lives once in
    // `parts`). Old rows have no marker and the legacy { output } shape; a
    // dual-shape query branches on this. Old rows are deliberately NOT migrated.
    toolTraceVersion: 2,
    // Step marker: the number of FINISHED steps whose parts are in this row,
    // derived from `finished` in the same flush, so it can never disagree with the
    // persisted parts. The registry rotates its ring only on a confirmed persist
    // of step N, and attach slices the tail at "step > N". Not `run.stepCount`:
    // recordStep is fire-and-forget and can race ahead of the parts write. The
    // in-progress trailing text is not a finished step and is not counted.
    stepsPersisted: finished.length,
  };
  // finishReason: prefer an explicit one; else derive a sensible value from the
  // terminal status (so onError/onAbort records keep their historical reason).
  if (extra?.finishReason) {
    metadata.finishReason = extra.finishReason;
  } else if (status === 'error' || status === 'aborted') {
    metadata.finishReason = status;
  }
  if (extra?.usage !== undefined) {
    metadata.usage =
      normalizeStreamUsage(extra.usage as StreamUsage) ?? extra.usage;
  }
  if (extra?.contextTokens) metadata.contextTokens = extra.contextTokens;
  if (extra?.maxContextTokens)
    metadata.maxContextTokens = extra.maxContextTokens;
  if (extra?.replayTrimmedToTokens)
    metadata.replayTrimmedToTokens = extra.replayTrimmedToTokens;
  if (extra?.replayOverflowCount && extra.replayOverflowCount > 0)
    metadata.replayOverflowCount = extra.replayOverflowCount;
  if (extra?.replayBelowConfiguredBudget)
    metadata.replayBelowConfiguredBudget = true;
  // #686 P4: persist the (already-capped) external-MCP failure list. Only when
  // non-empty so a clean turn's metadata is unchanged.
  if (extra?.mcpFailures && extra.mcpFailures.length > 0)
    metadata.mcpFailures = [...extra.mcpFailures];
  if (extra?.error) metadata.error = extra.error;
  // Persist the page-change diff the agent saw this turn (#274 observability),
  // so history / the Markdown export can show what the user changed. Only when
  // a non-empty diff was actually injected into the prompt this turn.
  if (extra?.pageChanged && extra.pageChanged.diff?.trim().length) {
    metadata.pageChanged = {
      title: extra.pageChanged.title,
      diff: extra.pageChanged.diff,
    };
  }

  // Strip NUL chars from the whole row before persisting: Postgres rejects a NUL
  // in both the `content` (text) and `toolCalls`/`metadata` (jsonb) columns, and a
  // single stray NUL in model/tool output would otherwise fail EVERY write of this
  // row and silently drop the turn's content from the DB (see stripNulChars).
  return stripNulChars({
    content: stepsText + trailing,
    toolCalls: serializeSteps(finished),
    metadata,
    status,
  });
}

/**
 * Reduce SDK step objects to a compact, JSON-serializable trace for the
 * `tool_calls` column — trace format **v2**. Per call it stores only metadata,
 * never the tool OUTPUT: the output lives once, in `metadata.parts`, which is
 * what the model replays and the UI/export render.
 *
 * Element shapes (paired per call, in order):
 *  - `{ toolName, input }`                       — the call
 *  - `{ toolName, ok: true }`                     — it returned a result (success)
 *  - `{ toolName, error, kind: 'thrown' }`        — it threw a `tool-error`
 *  - `{ toolName, error, kind: 'interrupted' }`   — no result and no throw (an
 *      abort / server restart mid-step). `kind` keeps the synthetic
 *      "Tool call did not complete." distinguishable from a real hard-fail. The
 *      distinction is structural (an `errorsById` hit vs the synthetic fallback),
 *      not a per-tool classifier — soft failures stay in `metadata.parts` outputs.
 *
 * Rows carry `metadata.toolTraceVersion: 2` (set by {@link flushAssistant}) so a
 * query can branch on the trace shape; v1 rows are not migrated. See
 * docs/reading-ai-logs.md.
 */
export function serializeSteps(
  steps: ReadonlyArray<{
    toolCalls?: ReadonlyArray<{
      toolCallId?: string;
      toolName?: string;
      input?: unknown;
    }>;
    toolResults?: ReadonlyArray<{ toolCallId?: string; toolName?: string }>;
    content?: ReadonlyArray<{
      type?: string;
      toolCallId?: string;
      toolName?: string;
      error?: unknown;
    }>;
  }>,
): unknown {
  const calls: Array<
    | { toolName?: string; input?: unknown }
    | { toolName?: string; ok: true }
    | { toolName?: string; error: string; kind: 'thrown' | 'interrupted' }
  > = [];
  for (const step of steps ?? []) {
    // Index this step's results + thrown errors by tool call id, so each call is
    // paired with its outcome (mirrors assistantParts' pairing exactly).
    const resultIds = new Set<string>();
    for (const r of step.toolResults ?? []) {
      if (r.toolCallId) resultIds.add(r.toolCallId);
    }
    const errorsById = new Map<string, unknown>();
    for (const part of step.content ?? []) {
      if (part.type === 'tool-error' && part.toolCallId) {
        errorsById.set(part.toolCallId, part.error);
      }
    }
    for (const call of step.toolCalls ?? []) {
      calls.push({ toolName: call.toolName, input: call.input });
      if (call.toolCallId && resultIds.has(call.toolCallId)) {
        // Success: the output itself lives in metadata.parts, not here.
        calls.push({ toolName: call.toolName, ok: true });
      } else if (call.toolCallId && errorsById.has(call.toolCallId)) {
        // Hard fail: the tool threw. Persist the real (bounded) reason.
        calls.push({
          toolName: call.toolName,
          error: normalizeToolError(errorsById.get(call.toolCallId)),
          kind: 'thrown',
        });
      } else {
        // Neither a result nor a throw: interrupted mid-step (abort/restart).
        // Marked structurally so it never inflates a thrown-error count.
        calls.push({
          toolName: call.toolName,
          error: TOOL_CALL_INCOMPLETE_TEXT,
          kind: 'interrupted',
        });
      }
    }
  }
  return calls.length > 0 ? calls : null;
}
