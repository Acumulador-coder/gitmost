/**
 * The converter worker pool: git-sync's markdown <-> ProseMirror conversions
 * run here, on worker threads, never on the caller's event loop (AGENTS
 * invariants 1 and 3).
 *
 * A conversion is synchronous CPU work (marked, a jsdom DOM and tiptap's
 * `generateJSON`): importing a 9,060-block page takes 7 s and more. On the API
 * event loop that froze HTTP, health checks and every AI-chat stream of the
 * process for each changed page of a pull or a push. So:
 *
 *   - every call has an INPUT BUDGET in bytes, checked before any work: over
 *     it the call is refused with the sizes in its message (for the caller a
 *     per-page failure, retried next cycle) and no worker is involved;
 *   - every call has a wall-clock DEADLINE counted from submission: a call
 *     still queued when it passes is dropped, a call still running has its
 *     worker TERMINATED (the only way to stop synchronous work) and the next
 *     call gets a fresh worker;
 *   - a call takes the cycle's AbortSignal: aborted, it is dropped from the
 *     queue or its worker is terminated the same way, and it rejects with a
 *     `CycleAbortedError` (./abort.ts);
 *   - the conversions, and the jsdom DOM they build, stay inside the workers;
 *     the calling thread only moves JSON / markdown text in and out.
 *
 * Callers keep the converter's async signatures: `markdownToProseMirror` here
 * takes and returns what the converter's does, `stabilizePageBody`
 * (./stabilize.ts) runs the normalize-on-write pass on the pool.
 */
import { availableParallelism } from "node:os";
import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import {
  ConverterLossError,
  type MarkdownImportOptions,
} from "@docmost/prosemirror-markdown";
import { CycleAbortedError } from "./abort.js";

/** Largest markdown text one conversion takes, in UTF-8 bytes. */
export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;

/**
 * Largest ProseMirror document, as JSON text in UTF-8 bytes, one stabilization
 * takes (about the JSON a markdown text of `MAX_MARKDOWN_BYTES` imports to).
 */
export const MAX_DOC_JSON_BYTES = 10 * 1024 * 1024;

/**
 * Wall-clock deadline of one call, queue wait included. A conversion of
 * `MAX_MARKDOWN_BYTES` takes about 30 s on a fast machine.
 */
export const CONVERT_DEADLINE_MS = 120_000;

/** One request to a converter worker. */
export type ConvertRequest =
  | {
      id: number;
      op: "markdownToProseMirror";
      markdown: string;
      options?: MarkdownImportOptions;
    }
  | {
      id: number;
      op: "stabilizePageBody";
      /** The document as JSON text; undefined for an undefined document. */
      docJson: string | undefined;
    };

/** An error as it crosses the thread boundary. */
export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  /** `ConverterLossError` fields, so the caller gets that class back. */
  kind?: "node" | "mark";
  typeName?: string;
}

/**
 * A worker's reply: ProseMirror JSON text (`markdownToProseMirror`) or the
 * markdown body (`stabilizePageBody`), or the error the conversion threw.
 */
export type ConvertReply =
  | { id: number; ok: true; result: string }
  | { id: number; ok: false; error: SerializedError };

export interface ConverterPoolOptions {
  /** Most worker threads alive at once; spawned on demand. */
  size: number;
  /** See `CONVERT_DEADLINE_MS`. */
  deadlineMs: number;
  /** See `MAX_MARKDOWN_BYTES`. */
  maxMarkdownBytes: number;
  /** See `MAX_DOC_JSON_BYTES`. */
  maxDocJsonBytes: number;
}

interface Task {
  request: ConvertRequest;
  /** What the call does, for its error messages. */
  what: string;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  /** The worker running it; null while queued. */
  slot: Slot | null;
  /** The caller's signal and the listener that cancels the call on abort. */
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface Slot {
  worker: Worker;
  task: Task | null;
}

/**
 * A pool of converter worker threads. Workers start on demand up to `size`, run
 * one call at a time each, and are unref'd while idle so they never keep the
 * process alive by themselves.
 */
export class ConverterPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Task[] = [];
  private nextId = 1;
  private entry: URL | null = null;

  constructor(private readonly options: ConverterPoolOptions) {}

  /** The converter's `markdownToProseMirror`, run on a worker. */
  async markdownToProseMirror(
    markdown: string,
    options?: MarkdownImportOptions,
    signal?: AbortSignal,
  ): Promise<any> {
    const bytes = Buffer.byteLength(markdown, "utf8");
    if (bytes > this.options.maxMarkdownBytes) {
      throw new Error(
        `markdown -> ProseMirror conversion refused: the markdown is ${bytes} ` +
          `bytes, over the ${this.options.maxMarkdownBytes}-byte budget`,
      );
    }
    const json = await this.run(
      { id: this.nextId++, op: "markdownToProseMirror", markdown, options },
      `markdown -> ProseMirror conversion of ${bytes} bytes`,
      signal,
    );
    return JSON.parse(json);
  }

  /** The normalize-on-write markdown body of a page (./stabilize.ts), run on a worker. */
  async stabilizePageBody(
    content: unknown,
    signal?: AbortSignal,
  ): Promise<string> {
    const docJson = content === undefined ? undefined : JSON.stringify(content);
    const bytes = docJson === undefined ? 0 : Buffer.byteLength(docJson, "utf8");
    if (bytes > this.options.maxDocJsonBytes) {
      throw new Error(
        `ProseMirror -> markdown export refused: the document is ${bytes} ` +
          `bytes of JSON, over the ${this.options.maxDocJsonBytes}-byte budget`,
      );
    }
    return this.run(
      { id: this.nextId++, op: "stabilizePageBody", docJson },
      `ProseMirror -> markdown export of a ${bytes}-byte document`,
      signal,
    );
  }

  private async run(
    request: ConvertRequest,
    what: string,
    signal?: AbortSignal,
  ): Promise<string> {
    this.entry ??= await workerEntry();
    if (signal?.aborted) throw new CycleAbortedError(`the ${what}`, signal.reason);
    return new Promise<string>((resolve, reject) => {
      const task: Task = {
        request,
        what,
        resolve,
        reject,
        slot: null,
        timer: setTimeout(() => this.expire(task), this.options.deadlineMs),
      };
      if (signal) {
        task.signal = signal;
        task.onAbort = () => this.cancel(task);
        signal.addEventListener("abort", task.onAbort, { once: true });
      }
      this.queue.push(task);
      this.dispatch();
    });
  }

  /** Stop the deadline timer and the abort listener of a call that settles. */
  private settle(task: Task): void {
    clearTimeout(task.timer);
    if (task.onAbort) task.signal?.removeEventListener("abort", task.onAbort);
  }

  /** The caller's signal aborted `task`: drop it, or terminate its worker. */
  private cancel(task: Task): void {
    this.settle(task);
    const slot = task.slot;
    if (slot === null) {
      this.queue.splice(this.queue.indexOf(task), 1);
    } else {
      // As at the deadline: forget the worker, then terminate it.
      slot.task = null;
      this.slots.splice(this.slots.indexOf(slot), 1);
      void slot.worker.terminate();
    }
    task.reject(new CycleAbortedError(`the ${task.what}`, task.signal?.reason));
    // After the signal's other listeners ran: the calls queued behind this one
    // under the same signal are dropped first, not handed a fresh worker.
    queueMicrotask(() => this.dispatch());
  }

  /** Hand queued calls to idle workers, starting workers up to `size`. */
  private dispatch(): void {
    while (this.queue.length > 0) {
      const slot =
        this.slots.find((s) => s.task === null) ??
        (this.slots.length < this.options.size ? this.spawn() : undefined);
      if (slot === undefined) return;
      const task = this.queue.shift()!;
      slot.task = task;
      task.slot = slot;
      slot.worker.ref();
      slot.worker.postMessage(task.request);
    }
  }

  private spawn(): Slot {
    const entry = this.entry!;
    const worker = new Worker(
      entry,
      // The TypeScript source (test runs): Node versions before 22.18 strip
      // types only behind this flag, later ones accept it as a no-op.
      extname(entry.pathname) === ".ts"
        ? { execArgv: ["--experimental-strip-types"] }
        : undefined,
    );
    const slot: Slot = { worker, task: null };
    worker.unref();
    worker.on("message", (reply: ConvertReply) => this.onReply(slot, reply));
    worker.on("error", (err: Error) => this.onWorkerDown(slot, err));
    worker.on("exit", (code: number) =>
      this.onWorkerDown(slot, new Error(`the worker exited with code ${code}`)),
    );
    this.slots.push(slot);
    return slot;
  }

  private onReply(slot: Slot, reply: ConvertReply): void {
    const task = slot.task;
    if (task === null || task.request.id !== reply.id) return;
    this.settle(task);
    slot.task = null;
    slot.worker.unref();
    if (reply.ok) task.resolve(reply.result);
    else task.reject(toError(reply.error));
    this.dispatch();
  }

  /** The deadline of `task` passed. */
  private expire(task: Task): void {
    const late = `${task.what} exceeded its ${this.options.deadlineMs} ms deadline`;
    this.settle(task);
    const slot = task.slot;
    if (slot === null) {
      this.queue.splice(this.queue.indexOf(task), 1);
      task.reject(new Error(`${late} while waiting for a converter worker`));
      return;
    }
    // Forget the worker before terminating it: its `exit` event then finds no
    // slot to clean up.
    this.slots.splice(this.slots.indexOf(slot), 1);
    void slot.worker.terminate();
    task.reject(new Error(`${late}; its worker thread was terminated`));
    this.dispatch();
  }

  /** A worker crashed or exited on its own: fail its call, replace it on demand. */
  private onWorkerDown(slot: Slot, err: Error): void {
    const i = this.slots.indexOf(slot);
    if (i < 0) return;
    this.slots.splice(i, 1);
    const task = slot.task;
    if (task !== null) {
      this.settle(task);
      task.reject(
        new Error(`${task.what} failed, its converter worker died: ${err.message}`, {
          cause: err,
        }),
      );
    }
    this.dispatch();
  }
}

/**
 * The worker script next to this module: `convert-worker.js` in the build,
 * `convert-worker.ts` when a test runner executes the TypeScript sources (the
 * worker's Node strips its types, see `spawn`). `__filename` exists only where a
 * runner provides it (vitest, and jest, which loads these sources as
 * CommonJS); the ESM build takes its URL from ./module-url.ts, a module of its
 * own because `import.meta` is a syntax error in that CommonJS form.
 */
async function workerEntry(): Promise<URL> {
  const self =
    typeof __filename === "string"
      ? pathToFileURL(__filename)
      : new URL((await import("./module-url.js")).moduleUrl);
  const ext = extname(self.pathname) === ".ts" ? ".ts" : ".js";
  return new URL(`./convert-worker${ext}`, self);
}

/** Rebuild a worker's error on this side, `ConverterLossError` as itself. */
function toError(e: SerializedError): Error {
  const err =
    e.name === "ConverterLossError" && e.kind !== undefined && e.typeName !== undefined
      ? new ConverterLossError(e.kind, e.typeName)
      : Object.assign(new Error(e.message), { name: e.name });
  if (e.stack !== undefined) err.stack = e.stack;
  return err;
}

/** The pool git-sync's conversions run on. */
export const converterPool = new ConverterPool({
  size: Math.max(1, Math.min(2, availableParallelism() - 1)),
  deadlineMs: CONVERT_DEADLINE_MS,
  maxMarkdownBytes: MAX_MARKDOWN_BYTES,
  maxDocJsonBytes: MAX_DOC_JSON_BYTES,
});

/**
 * The converter's `markdownToProseMirror` (same signature and result, plus the
 * caller's optional AbortSignal), run on `converterPool`: over-budget input, a
 * missed deadline, an abort or a converter error rejects with the reason.
 */
export function markdownToProseMirror(
  markdownContent: string,
  options?: MarkdownImportOptions,
  signal?: AbortSignal,
): Promise<any> {
  return converterPool.markdownToProseMirror(markdownContent, options, signal);
}
