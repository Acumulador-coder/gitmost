// Break the editor-ext import chain (share.service -> collaboration.util ->
// @docmost/editor-ext -> @tiptap/core) that is unresolvable in this jest env.
// jsonToMarkdown is never reached here (the share tool fails before rendering).
jest.mock('../../collaboration/collaboration.util', () => ({
  jsonToMarkdown: () => '',
}));

import { Logger } from '@nestjs/common';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { PublicShareChatService } from './public-share-chat.service';
import { PublicShareChatToolsService } from './tools/public-share-chat-tools.service';

/**
 * AI-1 / AI-5: the anonymous share assistant charges the workspace token budget
 * for every COMPLETED step, including when the visitor disconnects mid-turn
 * (the controller aborts the turn on socket close). Before the fix the usage was
 * recorded only in `onFinish`, which after an abort carries an empty usage, so
 * an abandoned turn was charged 0 tokens and the daily budget never filled up.
 * On a Stop after the first step the SDK fires BOTH onAbort and onFinish; the
 * charge must still land exactly once per completed step.
 */

class FakeSocket {
  chunks: string[] = [];
  statusCode = 200;
  writableEnded = false;
  destroyed = false;
  headersSent = false;
  writeHead(): this {
    this.headersSent = true;
    return this;
  }
  setHeader(): void {}
  removeHeader(): void {}
  getHeader(): undefined {
    return undefined;
  }
  flushHeaders(): void {}
  write(chunk: unknown): boolean {
    this.chunks.push(
      typeof chunk === 'string' ? chunk : Buffer.from(chunk as never).toString('utf8'),
    );
    return true;
  }
  end(chunk?: unknown): void {
    if (chunk) this.write(chunk);
    this.writableEnded = true;
  }
  on(): this {
    return this;
  }
  once(): this {
    return this;
  }
}

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

/**
 * Step 1: one getSharePage tool call (billed 100 in + 20 out), which makes the
 * SDK run a step 2. Step 2: billed 150 in + 30 out when `hangSecondStep` is
 * false; otherwise it streams a partial text and then hangs until the turn is
 * aborted (like a real provider whose fetch is cancelled).
 */
function twoStepModel(hangSecondStep: boolean): {
  model: MockLanguageModelV3;
  secondStepStarted: Promise<void>;
} {
  let call = 0;
  let markStarted!: () => void;
  const secondStepStarted = new Promise<void>((r) => (markStarted = r));
  const model = new MockLanguageModelV3({
    doStream: async ({ abortSignal }) => {
      call++;
      if (call === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start' as const, warnings: [] },
              { type: 'tool-input-start' as const, id: 't1', toolName: 'getSharePage' },
              { type: 'tool-input-end' as const, id: 't1' },
              {
                type: 'tool-call' as const,
                toolCallId: 't1',
                toolName: 'getSharePage',
                input: '{"pageId":"p-other"}',
              },
              {
                type: 'finish' as const,
                finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
                usage: usage(100, 20),
              },
            ],
          }),
        };
      }
      markStarted();
      if (!hangSecondStep) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start' as const, warnings: [] },
              { type: 'text-start' as const, id: '2' },
              { type: 'text-delta' as const, id: '2', delta: 'Done.' },
              { type: 'text-end' as const, id: '2' },
              {
                type: 'finish' as const,
                finishReason: { unified: 'stop' as const, raw: 'stop' },
                usage: usage(150, 30),
              },
            ],
          }),
        };
      }
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: '2' });
            controller.enqueue({ type: 'text-delta', id: '2', delta: 'partial' });
            abortSignal?.addEventListener('abort', () =>
              controller.error(
                abortSignal.reason ?? new DOMException('aborted', 'AbortError'),
              ),
            );
          },
        }),
      };
    },
  });
  return { model, secondStepStarted };
}

function makeService(): {
  svc: PublicShareChatService;
  record: jest.Mock;
} {
  const svc = Object.create(PublicShareChatService.prototype);
  const logger = new Logger('test');
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  // A real share toolset whose share boundary rejects the page: the tool call
  // yields a classified tool error, which still lets the SDK run step 2.
  svc.tools = new PublicShareChatToolsService(
    { resolveReadableSharePage: jest.fn().mockResolvedValue(null) } as never,
    {} as never,
    {} as never,
  );
  svc.logger = logger;
  const record = jest.fn().mockResolvedValue(undefined);
  svc.tokenBudget = { record };
  return { svc, record };
}

async function startTurn(
  svc: PublicShareChatService,
  model: MockLanguageModelV3,
  signal: AbortSignal,
): Promise<FakeSocket> {
  const socket = new FakeSocket();
  await svc.stream({
    workspaceId: 'ws1',
    shareId: 'share1',
    share: { id: 'share1', pageId: 'p1', sharedPage: { id: 'p1', title: 'Docs' } },
    openedPage: null,
    messages: [
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'read it' }] } as never,
    ],
    res: { raw: socket } as never,
    signal,
    model: model as never,
    role: null,
  });
  return socket;
}

// Bounded poll (never a fixed sleep) so a regression fails instead of hanging.
async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('public share assistant token charge on abort (AI-1 / AI-5)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('charges the completed step when the visitor leaves mid-turn', async () => {
    const { svc, record } = makeService();
    const { model, secondStepStarted } = twoStepModel(true);
    const ac = new AbortController();
    const socket = await startTurn(svc, model, ac.signal);

    await secondStepStarted;
    // The controller aborts the turn when the anonymous socket closes.
    ac.abort();
    await waitFor(() => socket.writableEnded);
    // Let any late terminal callback (onFinish after onAbort) run.
    await new Promise((r) => setTimeout(r, 50));

    // Step 1 (100 in + 20 out) is charged exactly once; the in-flight step 2 is
    // not reported by the SDK and cannot be charged.
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith('ws1', 120);
  });

  it('charges every step of a turn that runs to completion, once each', async () => {
    const { svc, record } = makeService();
    const { model } = twoStepModel(false);
    const socket = await startTurn(svc, model, new AbortController().signal);

    await waitFor(() => socket.writableEnded);
    await new Promise((r) => setTimeout(r, 50));

    expect(record.mock.calls).toEqual([
      ['ws1', 120],
      ['ws1', 180],
    ]);
  });
});
