import {
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';

// Mock the AI SDK so we can PROVE no provider call is made for the turn we are
// about to reject. The race rejection happens at runHooks.begin(), long before
// any streamText/generateText, so these never resolve a real model.
jest.mock('ai', () => ({
  streamText: jest.fn(),
  generateText: jest.fn(),
  convertToModelMessages: jest.fn(() => []),
  stepCountIs: jest.fn(() => () => false),
}));

import { streamText, generateText } from 'ai';
import { AiChatService } from './ai-chat.service';
import { RunAlreadyActiveError } from './ai-chat-run.service';
// Spied as a MODULE so we observe the exact arguments the service threads into
// the replay budgeter — the wiring the helper unit tests cannot see (#555 item 2).
import * as historyBudget from './history-budget';
import {
  resolveReplayBudget,
  resolveEffectiveReplayThreshold,
} from './history-budget';

/**
 * Race coverage for the "one active run per chat" guard. Two simultaneous POST
 * /ai-chat/stream on the same chat both pass the controller's cheap pre-check,
 * so the loser's run-row INSERT hits the partial unique index; beginRun surfaces
 * RunAlreadyActiveError and stream() turns it into a 409 before any AI call.
 */
describe('AiChatService.stream — concurrent-run race rejection (#184)', () => {
  const streamTextMock = streamText as unknown as jest.Mock;
  const generateTextMock = generateText as unknown as jest.Mock;

  beforeEach(() => {
    streamTextMock.mockReset();
    generateTextMock.mockReset();
  });

  // Minimal service whose only reachable deps before begin() are aiChatRepo
  // (resolve the existing chat) — everything past begin must remain untouched.
  function makeService(beginImpl: () => Promise<unknown>) {
    const aiChatMessageRepo = { insert: jest.fn() };
    const aiChatRepo = {
      // An existing chat: stream keeps the supplied chatId and skips creation.
      findById: jest.fn(async () => ({ id: 'chat-1', workspaceId: 'ws-1' })),
      insert: jest.fn(),
    };
    const svc = new AiChatService(
      {} as never, // ai
      aiChatRepo as never,
      aiChatMessageRepo as never,
      {} as never, // aiChatPageSnapshotRepo
      {} as never, // aiSettings
      {} as never, // tools
      {} as never, // mcpClients
      {} as never, // aiAgentRoleRepo
      {} as never, // pageRepo
      {} as never, // pageAccess
      { isAiChatDeferredToolsEnabled: () => false, isAiChatFinalStepLockdownEnabled: () => false, isAiChatViewImageEnabled: () => false } as never, // environment
    );
    const begin = jest.fn(beginImpl);
    return { svc, begin, aiChatRepo, aiChatMessageRepo };
  }

  const baseArgs = (begin: jest.Mock) => ({
    user: { id: 'user-1' } as never,
    workspace: { id: 'ws-1' } as never,
    sessionId: 'sess-1',
    body: { chatId: 'chat-1', messages: [] } as never,
    res: { raw: {} } as never,
    signal: new AbortController().signal,
    model: {} as never,
    role: null,
    runHooks: {
      begin,
      onAssistantSeeded: jest.fn(),
      onStep: jest.fn(),
      onSettled: jest.fn(),
    } as never,
  });

  it('rejects the racer with a 409 ConflictException BEFORE any AI call, and never persists an untracked turn', async () => {
    // begin loses the unique-index race -> RunAlreadyActiveError.
    const { svc, begin, aiChatMessageRepo } = makeService(() => {
      throw new RunAlreadyActiveError('chat-1');
    });

    const promise = svc.stream(baseArgs(begin));

    await expect(promise).rejects.toBeInstanceOf(ConflictException);
    await promise.catch((err: ConflictException) => {
      expect(err.getStatus()).toBe(409);
      expect((err.getResponse() as { code?: string }).code).toBe(
        'A_RUN_ALREADY_ACTIVE',
      );
    });

    // The decisive assertions: the rejected racer spent NO tokens and left NO
    // untracked turn behind.
    expect(begin).toHaveBeenCalledTimes(1);
    expect(streamTextMock).not.toHaveBeenCalled();
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(aiChatMessageRepo.insert).not.toHaveBeenCalled();
  });
});

/**
 * Run-detach wiring: `effectiveSignal = handle.signal` after runHooks.begin,
 * then passed to streamText as `abortSignal`. That is what makes a run survive a
 * browser disconnect; a socket-bound signal would pass every other test while
 * breaking Stop + durability. These tests pin the signal streamText consumes on
 * both paths.
 */
describe('AiChatService.stream — abortSignal wiring (#184 F3)', () => {
  const streamTextMock = streamText as unknown as jest.Mock;

  // A streamText result stub: the post-call drain + pipe are no-ops here; we only
  // care WHICH abortSignal streamText was handed.
  function makeStreamResult() {
    return {
      consumeStream: jest.fn(),
      pipeUIMessageStreamToResponse: jest.fn(),
    };
  }

  // A raw-response stub sufficient for the post-streamText wiring
  // (stripStreamingHopByHopHeaders binds writeHead; startSseHeartbeat registers
  // close/finish listeners; flushHeaders is belt-and-braces).
  function makeRes() {
    return {
      raw: {
        writeHead: jest.fn(),
        write: jest.fn(),
        once: jest.fn(),
        on: jest.fn(),
        flushHeaders: jest.fn(),
        writableEnded: false,
        destroyed: false,
      },
    };
  }

  // Wire only the deps reached on the way to streamText: resolve the existing
  // chat, persist the user + seed the assistant row, load (empty) history, the
  // admin settings, an empty external toolset + Docmost toolset.
  function makeService() {
    const aiChatRepo = {
      findById: jest.fn(async () => ({ id: 'chat-1', workspaceId: 'ws-1' })),
      insert: jest.fn(),
    };
    const aiChatMessageRepo = {
      insert: jest.fn(async () => ({ id: 'msg-1' })),
      findAllByChat: jest.fn(async () => []),
      update: jest.fn(async () => ({ id: 'msg-1' })),
      finalizeOwner: jest.fn(async () => ({ id: 'msg-1' })),
      findStreamingWithTerminalRun: jest.fn(async () => []),
    };
    const aiSettings = { resolve: jest.fn(async () => ({})) };
    const tools = { forUser: jest.fn(async () => ({})) };
    const mcpClients = {
      toolsFor: jest.fn(async () => ({
        tools: {},
        clients: [],
        outcomes: [],
        instructions: [],
      })),
    };
    const svc = new AiChatService(
      {} as never, // ai
      aiChatRepo as never,
      aiChatMessageRepo as never,
      {} as never, // aiChatPageSnapshotRepo
      aiSettings as never,
      tools as never,
      mcpClients as never,
      {} as never, // aiAgentRoleRepo
      {} as never, // pageRepo (openPage undefined -> never touched)
      {} as never, // pageAccess
      { isAiChatDeferredToolsEnabled: () => false, isAiChatFinalStepLockdownEnabled: () => false, isAiChatViewImageEnabled: () => false } as never, // environment
    );
    return { svc, aiChatMessageRepo };
  }

  const body = {
    chatId: 'chat-1',
    messages: [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    ],
  };

  beforeEach(() => {
    streamTextMock.mockReset();
    streamTextMock.mockImplementation(() => makeStreamResult());
    jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined as never);
  });

  afterEach(() => jest.restoreAllMocks());

  it('happy path (run-wrapped): streamText is driven with abortSignal === handle.signal (the RUN signal, NOT the socket)', async () => {
    const { svc } = makeService();
    const runController = new AbortController();
    const runSignal = runController.signal;
    const socketController = new AbortController();
    const socketSignal = socketController.signal;

    const begin = jest.fn(async () => ({ runId: 'run-1', signal: runSignal }));
    await svc.stream({
      user: { id: 'user-1' } as never,
      workspace: { id: 'ws-1' } as never,
      sessionId: 'sess-1',
      body: body as never,
      res: makeRes() as never,
      signal: socketSignal,
      model: {} as never,
      role: null,
      runHooks: {
        begin,
        onAssistantSeeded: jest.fn(),
        onStep: jest.fn(),
        onSettled: jest.fn(),
      } as never,
    });

    expect(begin).toHaveBeenCalledTimes(1);
    expect(streamTextMock).toHaveBeenCalledTimes(1);
    // The agent loop's abort is wired to the RUN, so a browser disconnect (which
    // aborts only `socketSignal`) cannot end the turn. The signal handed to
    // streamText is AbortSignal.any([effectiveSignal, degenerationController.signal]),
    // not identity-equal to `runSignal`, so assert behaviour: aborting the socket
    // does not abort it, aborting the run does.
    const passed = streamTextMock.mock.calls[0][0].abortSignal as AbortSignal;
    expect(passed).not.toBe(socketSignal);
    expect(passed.aborted).toBe(false);
    socketController.abort?.();
    // A socket abort must not reach a run-wrapped turn.
    expect(passed.aborted).toBe(false);
    // A run abort must.
    runController.abort();
    expect(passed.aborted).toBe(true);
  });

  it('legacy path (no runHooks): streamText is driven with the SOCKET signal', async () => {
    const { svc } = makeService();
    const socketController = new AbortController();
    const socketSignal = socketController.signal;

    await svc.stream({
      user: { id: 'user-1' } as never,
      workspace: { id: 'ws-1' } as never,
      sessionId: 'sess-1',
      body: body as never,
      res: makeRes() as never,
      signal: socketSignal,
      model: {} as never,
      role: null,
      // No runHooks -> the turn stays socket-bound.
    });

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    // The passed signal is AbortSignal.any([socketSignal, degeneration]), so assert
    // behaviour: a socket abort reaches it.
    const passed = streamTextMock.mock.calls[0][0].abortSignal as AbortSignal;
    expect(passed.aborted).toBe(false);
    socketController.abort();
    expect(passed.aborted).toBe(true);
  });

  /**
   * streamText's terminal callbacks carry the run lifecycle:
   *   onStepFinish -> runHooks.onStep(runId, stepCount)
   *   onFinish     -> runHooks.onSettled(runId, 'completed')   (dominant path)
   *   onAbort      -> runHooks.onSettled(runId, 'aborted')
   *   onError      -> runHooks.onSettled(runId, 'error', cause)
   * makeStreamResult() ignores the streamText options, so these callbacks never
   * fire on their own. Capture the options streamText was handed and invoke each
   * callback, asserting the run hooks fire with the right args.
   */
  // Drive stream() to the point streamText is called, capturing the options object
  // (which carries onStepFinish/onFinish/onError/onAbort) and the run hooks.
  async function captureStreamCallbacks() {
    const { svc, aiChatMessageRepo } = makeService();
    let capturedOpts: any;
    streamTextMock.mockImplementation((opts: any) => {
      capturedOpts = opts;
      return makeStreamResult();
    });
    const runHooks = {
      begin: jest.fn(async () => ({
        runId: 'run-1',
        signal: new AbortController().signal,
      })),
      onAssistantSeeded: jest.fn(),
      onStep: jest.fn(),
      onSettled: jest.fn(),
    };
    await svc.stream({
      user: { id: 'user-1' } as never,
      workspace: { id: 'ws-1' } as never,
      sessionId: 'sess-1',
      body: body as never,
      res: makeRes() as never,
      signal: new AbortController().signal,
      model: {} as never,
      role: null,
      runHooks: runHooks as never,
    });
    expect(capturedOpts).toBeDefined();
    return { capturedOpts, runHooks, aiChatMessageRepo };
  }

  it('F9: onStepFinish bumps the run step count, onFinish settles the run "completed" (the dominant autonomous-run path)', async () => {
    const { capturedOpts, runHooks } = await captureStreamCallbacks();

    // A finished step -> onStep(runId, finishedStepCount).
    capturedOpts.onStepFinish({ text: 'step one', toolCalls: [], content: [] });
    expect(runHooks.onStep).toHaveBeenCalledWith('run-1', 1);
    capturedOpts.onStepFinish({ text: 'step two', toolCalls: [], content: [] });
    expect(runHooks.onStep).toHaveBeenLastCalledWith('run-1', 2);

    // The success terminal callback settles the run.
    await capturedOpts.onFinish({
      text: 'done',
      finishReason: 'stop',
      totalUsage: {},
      usage: {},
      steps: [],
    });
    // #487: onFinish passes the (undefined) error slot so a message-finalize
    // failure could error-mark the run; on the success path it is undefined.
    expect(runHooks.onSettled).toHaveBeenCalledWith(
      'run-1',
      'completed',
      undefined,
    );
  });

  it('F9: onAbort settles the run "aborted"', async () => {
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined as never);
    const { capturedOpts, runHooks } = await captureStreamCallbacks();

    await capturedOpts.onAbort({ steps: [] });
    expect(runHooks.onSettled).toHaveBeenCalledWith('run-1', 'aborted');
  });

  it('F9: onError settles the run "error" carrying the provider cause', async () => {
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined as never);
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined as never);
    const { capturedOpts, runHooks } = await captureStreamCallbacks();

    await capturedOpts.onError({ error: new Error('provider exploded') });
    expect(runHooks.onSettled).toHaveBeenCalledWith(
      'run-1',
      'error',
      expect.stringContaining('provider exploded'),
    );
  });

  // #490/#520 reactive branch: a provider CONTEXT-OVERFLOW 400 in onError is
  // classified, records a distinguishable cause, and stamps the consecutive-overflow
  // COUNTER (metadata.replayOverflowCount) so the NEXT turn's budgeter trims with
  // escalating aggression (the recovery that un-bricks the chat). This is a fresh
  // chat (empty history -> prior streak 0), so the first overflow stamps count 1.
  it('#490/#520: a context-overflow 400 stamps replayOverflowCount=1 on the finalized row', async () => {
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined as never);
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined as never);
    const { capturedOpts, aiChatMessageRepo } = await captureStreamCallbacks();

    const overflow = Object.assign(new Error('too large'), {
      statusCode: 400,
      message:
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 214000 tokens. Please reduce the length.",
    });
    await capturedOpts.onError({ error: overflow });

    // The seed row exists (finalizeOwner is the owner-write path).
    expect(aiChatMessageRepo.finalizeOwner).toHaveBeenCalled();
    const calls = aiChatMessageRepo.finalizeOwner.mock.calls as any[][];
    const patch = calls[calls.length - 1][2] as {
      status: string;
      metadata: Record<string, unknown>;
    };
    expect(patch.status).toBe('error');
    // First overflow on a fresh chat -> k = prior(0) + 1 = 1.
    expect(patch.metadata.replayOverflowCount).toBe(1);
    // The boolean `replayOverflow` stamp is not written (the counter replaces it).
    expect('replayOverflow' in patch.metadata).toBe(false);
    expect(patch.metadata.error).toContain('контекстное окно');
  });

  it('#490/#520: a non-overflow error does NOT stamp the overflow counter', async () => {
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined as never);
    const { capturedOpts, aiChatMessageRepo } = await captureStreamCallbacks();
    await capturedOpts.onError({ error: new Error('network reset') });
    const calls = aiChatMessageRepo.finalizeOwner.mock.calls as any[][];
    const patch = calls[calls.length - 1][2] as {
      status: string;
      metadata: Record<string, unknown>;
    };
    expect('replayOverflowCount' in patch.metadata).toBe(false);
    expect('replayOverflow' in patch.metadata).toBe(false);
  });
});

/**
 * The begin-failure branch. stream() wraps runHooks.begin in try/catch with two
 * branches:
 *   - RunAlreadyActiveError  -> 409 ConflictException (pinned above).
 *   - any other begin failure -> ServiceUnavailableException(A_RUN_BEGIN_FAILED)
 *     before the first byte, before any user row is persisted and before
 *     streamText runs (an untracked run could not be stopped).
 */
describe('AiChatService.stream — begin-failure fails the turn (#184 F14 / #486)', () => {
  const streamTextMock = streamText as unknown as jest.Mock;

  function makeStreamResult() {
    return {
      consumeStream: jest.fn(),
      pipeUIMessageStreamToResponse: jest.fn(),
    };
  }

  function makeRes() {
    return {
      raw: {
        writeHead: jest.fn(),
        write: jest.fn(),
        once: jest.fn(),
        on: jest.fn(),
        flushHeaders: jest.fn(),
        writableEnded: false,
        destroyed: false,
      },
    };
  }

  // Same harness as the F3 abortSignal block, but it also exposes
  // aiChatMessageRepo so we can assert the user turn IS persisted (the turn really
  // streamed) despite begin() blowing up.
  function makeService() {
    const aiChatRepo = {
      findById: jest.fn(async () => ({ id: 'chat-1', workspaceId: 'ws-1' })),
      insert: jest.fn(),
    };
    const aiChatMessageRepo = {
      insert: jest.fn(async () => ({ id: 'msg-1' })),
      findAllByChat: jest.fn(async () => []),
      update: jest.fn(async () => ({ id: 'msg-1' })),
      finalizeOwner: jest.fn(async () => ({ id: 'msg-1' })),
      findStreamingWithTerminalRun: jest.fn(async () => []),
    };
    const aiSettings = { resolve: jest.fn(async () => ({})) };
    const tools = { forUser: jest.fn(async () => ({})) };
    const mcpClients = {
      toolsFor: jest.fn(async () => ({
        tools: {},
        clients: [],
        outcomes: [],
        instructions: [],
      })),
    };
    const svc = new AiChatService(
      {} as never, // ai
      aiChatRepo as never,
      aiChatMessageRepo as never,
      {} as never, // aiChatPageSnapshotRepo
      aiSettings as never,
      tools as never,
      mcpClients as never,
      {} as never, // aiAgentRoleRepo
      {} as never, // pageRepo
      {} as never, // pageAccess
      { isAiChatDeferredToolsEnabled: () => false, isAiChatFinalStepLockdownEnabled: () => false, isAiChatViewImageEnabled: () => false } as never, // environment
    );
    return { svc, aiChatMessageRepo };
  }

  const body = {
    chatId: 'chat-1',
    messages: [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    ],
  };

  beforeEach(() => {
    streamTextMock.mockReset();
    streamTextMock.mockImplementation(() => makeStreamResult());
    jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined as never);
  });

  afterEach(() => jest.restoreAllMocks());

  it('a PLAIN begin() failure (NOT RunAlreadyActiveError) FAILS the turn with a 503 A_RUN_BEGIN_FAILED before the first byte — NO untracked stream (#486)', async () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined as never);

    const { svc, aiChatMessageRepo } = makeService();
    const socketController = new AbortController();
    const socketSignal = socketController.signal;

    // A transient, NON-race begin failure (e.g. a non-unique DB error inserting
    // the run row). This is the `else` branch of the begin try/catch.
    const begin = jest.fn(async () => {
      throw new Error('insert failed');
    });

    const promise = svc.stream({
      user: { id: 'user-1' } as never,
      workspace: { id: 'ws-1' } as never,
      sessionId: 'sess-1',
      body: body as never,
      res: makeRes() as never,
      signal: socketSignal,
      model: {} as never,
      role: null,
      runHooks: {
        begin,
        onAssistantSeeded: jest.fn(),
        onStep: jest.fn(),
        onSettled: jest.fn(),
      } as never,
    });

    // NEW POLICY: the turn is REJECTED with a 503 A_RUN_BEGIN_FAILED (not a 409,
    // and NOT swallowed into an untracked stream).
    await expect(promise).rejects.toBeInstanceOf(ServiceUnavailableException);
    const err = (await promise.catch(
      (e) => e,
    )) as ServiceUnavailableException;
    expect(err.getStatus()).toBe(503);
    expect(err.getResponse()).toMatchObject({ code: 'A_RUN_BEGIN_FAILED' });

    expect(begin).toHaveBeenCalledTimes(1);

    // It logged the fail-the-turn line.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('failing the turn'),
      expect.anything(),
    );

    // Fail-fast: the turn NEVER streamed — no user row persisted, no streamText
    // call, so no orphan/untracked run was left behind.
    expect(aiChatMessageRepo.insert).not.toHaveBeenCalled();
    expect(streamTextMock).not.toHaveBeenCalled();
  });
});

/**
 * Service-level wiring of the escalating ×0.5^k replay-threshold recovery. The
 * pure helpers (`resolveEffectiveReplayThreshold`,
 * `lastAssistantReplayOverflowCount`, `trimHistoryForReplay`) are unit-tested
 * alone; this pins how stream() threads them:
 *   1. read the consecutive-overflow count `k` from the persisted history;
 *   2. pass `resolveEffectiveReplayThreshold(base, k)` (not the base budget) to
 *      `trimHistoryForReplay`;
 *   3. when `k > 0` the prior turn's `contextTokens` is stale, so pass
 *      `undefined` to force the char-estimate path; when `k === 0` pass it on.
 * Spies on the budgeter at the module seam, driven from real history rows.
 */
describe('AiChatService.stream — aggressive-threshold ×0.5 wiring provenance (#555 item 2 / #490/#520)', () => {
  const streamTextMock = streamText as unknown as jest.Mock;

  function makeStreamResult() {
    return {
      consumeStream: jest.fn(),
      pipeUIMessageStreamToResponse: jest.fn(),
    };
  }

  function makeRes() {
    return {
      raw: {
        writeHead: jest.fn(),
        write: jest.fn(),
        once: jest.fn(),
        on: jest.fn(),
        flushHeaders: jest.fn(),
        writableEnded: false,
        destroyed: false,
      },
    };
  }

  // A minimal persisted history whose LAST assistant row carries the given
  // metadata (the overflow counter + the provider contextTokens fact).
  function makeService(
    history: Array<Record<string, unknown>>,
    chatContextWindowRaw: unknown,
  ) {
    const aiChatRepo = {
      findById: jest.fn(async () => ({ id: 'chat-1', workspaceId: 'ws-1' })),
      insert: jest.fn(),
    };
    const aiChatMessageRepo = {
      insert: jest.fn(async () => ({ id: 'msg-1' })),
      findAllByChat: jest.fn(async () => history),
      update: jest.fn(async () => ({ id: 'msg-1' })),
      finalizeOwner: jest.fn(async () => ({ id: 'msg-1' })),
      findStreamingWithTerminalRun: jest.fn(async () => []),
    };
    const aiSettings = {
      resolve: jest.fn(async () => ({ chatContextWindowRaw })),
    };
    const tools = { forUser: jest.fn(async () => ({})) };
    const mcpClients = {
      toolsFor: jest.fn(async () => ({
        tools: {},
        clients: [],
        outcomes: [],
        instructions: [],
      })),
    };
    const svc = new AiChatService(
      {} as never, // ai
      aiChatRepo as never,
      aiChatMessageRepo as never,
      {} as never, // aiChatPageSnapshotRepo
      aiSettings as never,
      tools as never,
      mcpClients as never,
      {} as never, // aiAgentRoleRepo
      {} as never, // pageRepo
      {} as never, // pageAccess
      {
        isAiChatDeferredToolsEnabled: () => false,
        isAiChatFinalStepLockdownEnabled: () => false,
        isAiChatViewImageEnabled: () => false,
      } as never, // environment
    );
    return { svc };
  }

  const body = {
    chatId: 'chat-1',
    messages: [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    ],
  };

  async function driveStream(svc: AiChatService) {
    await svc.stream({
      user: { id: 'user-1' } as never,
      workspace: { id: 'ws-1' } as never,
      sessionId: 'sess-1',
      body: body as never,
      res: makeRes() as never,
      signal: new AbortController().signal,
      model: {} as never,
      role: null,
      runHooks: {
        begin: jest.fn(async () => ({
          runId: 'run-1',
          signal: new AbortController().signal,
        })),
        onAssistantSeeded: jest.fn(),
        onStep: jest.fn(),
        onSettled: jest.fn(),
      } as never,
    });
  }

  beforeEach(() => {
    streamTextMock.mockReset();
    streamTextMock.mockImplementation(() => makeStreamResult());
    jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined as never);
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined as never);
  });

  afterEach(() => jest.restoreAllMocks());

  it('k>0: reads the prior overflow count, applies the ESCALATED threshold, and DROPS the stale prior contextTokens (undefined) — the priorOverflowed provenance', async () => {
    const raw = '40000';
    const base = resolveReplayBudget(raw).thresholdTokens as number;
    const k = 2;
    const expected = resolveEffectiveReplayThreshold(base, k) as number;
    // Sanity: the escalation MUST actually differ from the base, else the assertion
    // below could not tell "applied the escalation" from "applied the base".
    expect(expected).toBeLessThan(base);

    const effSpy = jest.spyOn(historyBudget, 'resolveEffectiveReplayThreshold');
    const trimSpy = jest.spyOn(historyBudget, 'trimHistoryForReplay');

    // Last assistant row: 2 consecutive overflows + a STALE provider contextTokens
    // that the recovery path must ignore.
    const { svc } = makeService(
      [
        {
          id: 'a1',
          role: 'assistant',
          content: 'prior answer',
          metadata: { replayOverflowCount: k, contextTokens: 999_999 },
        },
      ],
      raw,
    );
    await driveStream(svc);

    // (1) k is read from the persisted row and (2) fed to the escalation helper.
    expect(effSpy).toHaveBeenCalledWith(base, k);
    // (2)+(3): the escalated threshold is applied to the trim, and the stale prior
    // contextTokens is dropped (undefined) because k>0.
    expect(trimSpy).toHaveBeenCalledWith(
      expect.any(Array),
      expected,
      undefined,
    );
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });

  it('k===0 (control): no escalation (base threshold) and the prior contextTokens IS passed through — the provenance is asymmetric', async () => {
    const raw = '40000';
    const base = resolveReplayBudget(raw).thresholdTokens as number;
    const priorContextTokens = 12_345;

    const trimSpy = jest.spyOn(historyBudget, 'trimHistoryForReplay');

    // A cleanly-finished last assistant turn: no overflow counter, a real prior
    // contextTokens fact.
    const { svc } = makeService(
      [
        {
          id: 'a1',
          role: 'assistant',
          content: 'prior answer',
          metadata: { contextTokens: priorContextTokens },
        },
      ],
      raw,
    );
    await driveStream(svc);

    // No overflow -> the base budget is used verbatim AND the provider fact is
    // threaded through (NOT dropped). This is the other arm of the provenance:
    // if the service dropped the prior on the normal path too, this fails.
    expect(trimSpy).toHaveBeenCalledWith(
      expect.any(Array),
      base,
      priorContextTokens,
    );
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });
});
