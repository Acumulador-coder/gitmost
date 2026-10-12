// Unit tests for the pure CGI-response helpers used by GitHttpBackendService.
// The header/body split MUST treat the body as binary (Buffer) and never
// stringify it; the Status: header sets the HTTP status (default 200).
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

// Mock the spawn boundary so run() never launches a real `git http-backend`; the
// fake child lets us drive every stdout/stderr/error/close branch by hand.
jest.mock('node:child_process', () => ({ spawn: jest.fn() }));
// vaultGitEnv just builds the CGI env overlay; stub it to a passthrough so the
// service runs without the real engine. The service loads it at runtime via the
// `loadGitSync()` bridge (the ESM `@docmost/git-sync` package cannot be
// `require()`d under jest), so we mock that loader rather than the package.
// PUSH_BUDGET is shrunk so a test can cross the body budget with small chunks.
jest.mock('../git-sync.loader', () => ({
  loadGitSync: jest.fn(async () => ({
    vaultGitEnv: (overlay: Record<string, string>) => overlay,
    PUSH_BUDGET: { files: 10, fileBytes: 1024, totalBytes: 1024 },
  })),
}));
/** The mocked PUSH_BUDGET.totalBytes above. */
const BODY_BUDGET = 1024;

import {
  parseCgiResponse,
  splitCgiBuffer,
  buildGitBackendCgiEnv,
  GitHttpBackendService,
  GIT_BACKEND_MAX_CONCURRENT_PER_SPACE,
  GIT_BACKEND_MAX_CONCURRENT_TOTAL,
  GIT_BACKEND_CGI_HEADER_MAX_BYTES,
  GIT_BACKEND_GROUP_EXIT_MAX_MS,
} from './git-http-backend.service';
import { Logger } from '@nestjs/common';
import type { GitHttpBackendRequest } from './git-http-backend.service';

const spawnMock = spawn as unknown as jest.Mock;

/**
 * Fake child pids: unique, and far above any real pid, so an escalation timer
 * that fires after process.kill was restored signals no real process group.
 */
let nextFakePid = 2_000_000_000;

/** Every fake child by pid, so the process.kill stub can act on its group. */
const fakeChildren = new Map<number, any>();

/** A fake `git http-backend` child: EventEmitter + stdout/stderr/stdin streams. */
function fakeChild() {
  const child = new EventEmitter() as any;
  // stdout is paused/resumed for backpressure and destroyed on a forced kill.
  child.stdout = Object.assign(new EventEmitter(), {
    pause: jest.fn(),
    resume: jest.fn(),
    destroy: jest.fn(),
  });
  child.stderr = new EventEmitter();
  // stdin is written/ended/piped to; capture the calls, swallow nothing.
  child.stdin = Object.assign(new EventEmitter(), {
    end: jest.fn(),
    write: jest.fn(),
    destroy: jest.fn(),
  });
  // A forced termination signals the child's process group (process.kill on
  // -pid, stubbed in the suite by fakeGroupKill) — never the child alone,
  // recorded here.
  child.pid = nextFakePid++;
  child.kill = jest.fn();
  // Not exited yet, like a live ChildProcess.
  child.exitCode = null;
  child.signalCode = null;
  // A git process of the group outliving the child (a receive-pack still
  // running): the group then keeps answering kill(-pid, 0).
  child.groupOutlivesChild = false;
  fakeChildren.set(child.pid, child);
  return child;
}

/**
 * The suite's process.kill stub. A signal to a fake child's group ends the
 * child ('exit'); `kill(-pid, 0)` answers while the child or its
 * `groupOutlivesChild` process lives and throws ESRCH once the group is gone.
 */
function fakeGroupKill(pid: number, signal?: string | number): true {
  const child = fakeChildren.get(-pid);
  const childAlive =
    !!child && child.exitCode === null && child.signalCode === null;
  if (signal === 0) {
    if (childAlive || child?.groupOutlivesChild) return true;
    throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
  }
  if (childAlive) {
    child.signalCode = signal;
    child.emit('exit', null, signal);
  }
  return true;
}

/** The signals a forced termination sent to `child`'s process group. */
function groupSignals(child: any): string[] {
  return (process.kill as unknown as jest.Mock).mock.calls
    .filter(([pid, signal]) => pid === -child.pid && signal !== 0)
    .map(([, signal]) => signal);
}

/** A fake raw Node ServerResponse capturing status/headers/body/end. */
function fakeRes() {
  const res: any = Object.assign(new EventEmitter(), {
    headersSent: false,
    writableEnded: false,
    writableFinished: false,
    destroyed: false,
    statusCode: 200,
    // What write() reports (false = the response buffer is full).
    writeReturns: true,
    _headers: {} as Record<string, string>,
    _written: [] as Buffer[],
  });
  res.setHeader = jest.fn((name: string, value: string) => {
    res._headers[name] = value;
  });
  res.write = jest.fn((chunk: Buffer) => {
    res._written.push(chunk);
    return res.writeReturns;
  });
  res.end = jest.fn((chunk?: Buffer | string) => {
    if (chunk !== undefined) res._written.push(chunk as Buffer);
    res.writableEnded = true;
  });
  return res;
}

/** A fake raw Node IncomingMessage (GET => no body piped). */
function fakeReq() {
  const req = new EventEmitter() as any;
  req.pipe = jest.fn();
  req.unpipe = jest.fn();
  // A GET has no body, so it is complete from the start.
  req.complete = true;
  return req;
}

/** Simulate the client going away: the socket closes before the response finished. */
function disconnect(res: any) {
  res.destroyed = true;
  res.emit('close');
}

const baseRequest: GitHttpBackendRequest = {
  spaceId: 'space-1',
  subpath: 'info/refs',
  method: 'GET',
  queryString: 'service=git-upload-pack',
  contentType: '',
  remoteUser: 'alice@example.com',
};

function buildService(backendTimeoutMs = 120000) {
  const env = {
    getGitSyncDataDir: jest.fn(() => '/vaults'),
    // The watchdog timeout for the spawned git http-backend. Tests inject a tiny
    // value (or use fake timers) to drive the timeout branch.
    getGitSyncBackendTimeoutMs: jest.fn(() => backendTimeoutMs),
  };
  return new GitHttpBackendService(env as any);
}

// `run()` now awaits the async `loadGitSync()` bridge before it spawns the
// child, so the spawn (and its stream-handler wiring) happens one microtask
// after `run()` is called. These tests drive the fake child synchronously, so
// flush the microtask queue first to let `run()` reach the spawn.
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('GitHttpBackendService.run', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    // Forced terminations signal the child's process group: record them.
    jest.spyOn(process, 'kill').mockImplementation(fakeGroupKill);
  });
  afterEach(() => jest.restoreAllMocks());

  it('(a) responds 500 when the child errors before any headers were written', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const service = buildService();
    const res = fakeRes();

    const p = service.run(baseRequest, fakeReq(), res);
    await flush();
    // Emit a child 'error' before any stdout -> 500, headers not already sent.
    child.emit('error', new Error('ENOENT spawn git'));
    await p;

    expect(res.statusCode).toBe(500);
    expect(res._headers['Content-Type']).toBe('text/plain');
    expect(res.end).toHaveBeenCalledWith('Internal server error');
  });

  it('(a) responds 500 when the child closes before a complete CGI header block', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const service = buildService();
    const res = fakeRes();

    const p = service.run(baseRequest, fakeReq(), res);
    await flush();
    // stderr diagnostics, then a close with no valid CGI output -> 500.
    child.stderr.emit('data', Buffer.from('fatal: boom'));
    child.emit('close', 128);
    await p;

    expect(res.statusCode).toBe(500);
    expect(res.end).toHaveBeenCalledWith('Internal server error');
  });

  it('(b) parses the CGI header block, sets status/headers, writes the body', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const service = buildService();
    const res = fakeRes();

    const p = service.run(baseRequest, fakeReq(), res);
    await flush();
    // A full CGI response: status line + header + blank line + body.
    child.stdout.emit(
      'data',
      Buffer.from(
        'Status: 200 OK\r\nContent-Type: application/x-git-upload-pack-advertisement\r\n\r\nPACKBODY',
        'utf8',
      ),
    );
    child.emit('close', 0);
    await p;

    expect(res.statusCode).toBe(200);
    expect(res._headers['Content-Type']).toBe(
      'application/x-git-upload-pack-advertisement',
    );
    expect(Buffer.concat(res._written.map((c) => Buffer.from(c))).toString()).toContain(
      'PACKBODY',
    );
    expect(res.writableEnded).toBe(true);
  });

  it('(c) swallows a stdout stream error (EPIPE) without throwing or 500ing', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const service = buildService();
    const res = fakeRes();
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');

    const p = service.run(baseRequest, fakeReq(), res);
    await flush();
    // The stdout 'error' handler must absorb this — no unhandled throw, no 500.
    expect(() => child.stdout.emit('error', new Error('EPIPE'))).not.toThrow();
    expect(() => child.stderr.emit('error', new Error('EPIPE'))).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    expect(res.statusCode).not.toBe(500);

    // Let run() settle so the promise does not dangle.
    child.emit('close', 0);
    await p;
  });

  it('(d) timeout: a child that never closes is killed and a 500 is sent', async () => {
    // The child never emits stdout/close (a stalled git-receive-pack). With a
    // tiny injected watchdog timeout the run() promise must still resolve: the
    // child is killed and a clean 500 is sent (no headers were sent yet).
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const service = buildService(5); // 5ms watchdog
    const res = fakeRes();
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');

    // run() resolves only via the watchdog firing (no close/error emitted).
    await service.run(baseRequest, fakeReq(), res);

    expect(groupSignals(child)).toContain('SIGTERM');
    expect(warnSpy).toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(res.end).toHaveBeenCalledWith('Internal server error');
  });

  it('(d) timeout watchdog is cleared on a normal close (no kill, no 500)', async () => {
    // A normal request that completes well within the watchdog window must NOT be
    // killed and must NOT trip the timeout 500 — the timer is cleared on close.
    jest.useFakeTimers();
    try {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      const service = buildService(120000);
      const res = fakeRes();

      const p = service.run(baseRequest, fakeReq(), res);
      // loadGitSync resolves on a real microtask; advance it under fake timers.
      await Promise.resolve();
      await Promise.resolve();

      child.stdout.emit(
        'data',
        Buffer.from('Status: 200 OK\r\nContent-Type: text/plain\r\n\r\nOK', 'utf8'),
      );
      child.emit('close', 0);
      await p;

      // The watchdog never fired even if we advance past its window.
      jest.advanceTimersByTime(200000);
      expect(groupSignals(child)).toEqual([]);
      expect(res.statusCode).toBe(200);
    } finally {
      jest.useRealTimers();
    }
  });

  it('spawn throwing synchronously -> 500 (spawn-failed)', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('spawn EACCES');
    });
    const service = buildService();
    const res = fakeRes();

    await service.run(baseRequest, fakeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(res.end).toHaveBeenCalledWith('Internal server error');
  });

  it('(abort) an ALREADY-aborted signal -> no spawn, 500 lock-lost', async () => {
    // The per-space lock was already lost before run() reached the spawn: we must
    // NOT start writing the vault after a possible lock takeover.
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const service = buildService();
    const res = fakeRes();

    const controller = new AbortController();
    controller.abort();
    await service.run(baseRequest, fakeReq(), res, controller.signal);

    expect(spawnMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(res.end).toHaveBeenCalledWith('Internal server error');
  });

  it('(abort) a live signal aborted mid-request -> child SIGTERM + response closed', async () => {
    // The lock lapses mid-push: the abort fires, the child is killed (SIGTERM,
    // then SIGKILL on escalation), and the response is finished.
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const service = buildService();
    const res = fakeRes();
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');

    const controller = new AbortController();
    const p = service.run(baseRequest, fakeReq(), res, controller.signal);
    await flush(); // let run() reach the spawn + wire the abort listener
    controller.abort();
    await p;

    expect(groupSignals(child)).toContain('SIGTERM');
    expect(warnSpy).toHaveBeenCalled();
    // No headers were sent before the abort -> a clean 500 is sent and ended.
    expect(res.statusCode).toBe(500);
    expect(res.writableEnded).toBe(true);
  });

  it('(no-output) the empty-response error log names the space', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const service = buildService();
    const errorSpy = jest.spyOn(Logger.prototype, 'error');

    const p = service.run(baseRequest, fakeReq(), fakeRes());
    await flush();
    child.emit('close', 128);
    await p;

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('for space space-1; stderr'),
    );
  });

  // --- client disconnect kills the child ------------------------------------
  describe('client disconnect', () => {
    it('the response closing before it finished kills the child and settles', async () => {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      const service = buildService();
      const res = fakeRes();

      const p = service.run(baseRequest, fakeReq(), res);
      await flush();
      child.stdout.emit(
        'data',
        Buffer.from('Status: 200 OK\r\nContent-Type: x\r\n\r\npartial', 'utf8'),
      );
      disconnect(res);
      await p;

      expect(groupSignals(child)).toContain('SIGTERM');
      // A paused-for-backpressure pipe must not keep the killed child alive.
      expect(child.stdout.destroy).toHaveBeenCalled();
      // Nobody to answer: no 500 is attempted on the dead response.
      expect(res.statusCode).toBe(200);
    });

    it('a request body aborted mid-upload kills the child', async () => {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      const service = buildService();
      const req = fakeReq();
      req.complete = false; // a POST whose body is still streaming

      const p = service.run(
        { ...baseRequest, method: 'POST', subpath: 'git-upload-pack' },
        req,
        fakeRes(),
      );
      await flush();
      req.emit('close');
      await p;

      expect(groupSignals(child)).toContain('SIGTERM');
    });

    it('a NORMAL request/response close is not a disconnect (no kill)', async () => {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      const service = buildService();
      const req = fakeReq();
      const res = fakeRes();

      const p = service.run(
        { ...baseRequest, method: 'POST', subpath: 'git-upload-pack' },
        req,
        res,
      );
      await flush();
      // The body was fully read (complete) — Node emits the request 'close'.
      req.emit('close');
      child.stdout.emit(
        'data',
        Buffer.from('Status: 200 OK\r\n\r\nOK', 'utf8'),
      );
      child.emit('close', 0);
      await p;
      // The finished response closes normally afterwards.
      res.writableFinished = true;
      res.emit('close');

      expect(groupSignals(child)).toEqual([]);
    });

    it('a client that is already gone before the spawn -> nothing is spawned', async () => {
      spawnMock.mockReturnValue(fakeChild());
      const service = buildService();
      const res = fakeRes();
      res.destroyed = true;

      await service.run(baseRequest, fakeReq(), res);

      expect(spawnMock).not.toHaveBeenCalled();
    });
  });

  // --- concurrency budget -----------------------------------------------------
  describe('concurrency budget', () => {
    it(`refuses the request over the per-space budget (${GIT_BACKEND_MAX_CONCURRENT_PER_SPACE}) with 503 + reason, then frees the slot on exit`, async () => {
      const children: any[] = [];
      spawnMock.mockImplementation(() => {
        const c = fakeChild();
        children.push(c);
        return c;
      });
      const service = buildService();

      const running: Promise<void>[] = [];
      for (let i = 0; i < GIT_BACKEND_MAX_CONCURRENT_PER_SPACE; i++) {
        running.push(service.run(baseRequest, fakeReq(), fakeRes()));
      }
      await flush();
      expect(spawnMock).toHaveBeenCalledTimes(
        GIT_BACKEND_MAX_CONCURRENT_PER_SPACE,
      );

      const over = fakeRes();
      await service.run(baseRequest, fakeReq(), over);
      expect(spawnMock).toHaveBeenCalledTimes(
        GIT_BACKEND_MAX_CONCURRENT_PER_SPACE,
      );
      expect(over.statusCode).toBe(503);
      expect(over._headers['Retry-After']).toBeDefined();
      expect(String(over._written.join(''))).toContain('for this space');

      // Another space is not affected by this space's budget.
      const otherSpace = service.run(
        { ...baseRequest, spaceId: 'space-2' },
        fakeReq(),
        fakeRes(),
      );
      await flush();
      expect(spawnMock).toHaveBeenCalledTimes(
        GIT_BACKEND_MAX_CONCURRENT_PER_SPACE + 1,
      );

      // One child exits -> its slot is released and a new request is served.
      children[0].emit('close', 0);
      await running[0];
      const next = service.run(baseRequest, fakeReq(), fakeRes());
      await flush();
      expect(spawnMock).toHaveBeenCalledTimes(
        GIT_BACKEND_MAX_CONCURRENT_PER_SPACE + 2,
      );

      for (const c of children) c.emit('close', 0);
      await Promise.all([...running, otherSpace, next]);
    });

    it(`refuses the request over the global budget (${GIT_BACKEND_MAX_CONCURRENT_TOTAL}) with 503`, async () => {
      const children: any[] = [];
      spawnMock.mockImplementation(() => {
        const c = fakeChild();
        children.push(c);
        return c;
      });
      const service = buildService();

      // Spread over spaces so no per-space budget is hit first.
      const running: Promise<void>[] = [];
      for (let i = 0; i < GIT_BACKEND_MAX_CONCURRENT_TOTAL; i++) {
        running.push(
          service.run(
            { ...baseRequest, spaceId: `space-${i}` },
            fakeReq(),
            fakeRes(),
          ),
        );
      }
      await flush();

      const over = fakeRes();
      await service.run(
        { ...baseRequest, spaceId: 'space-fresh' },
        fakeReq(),
        over,
      );
      expect(spawnMock).toHaveBeenCalledTimes(GIT_BACKEND_MAX_CONCURRENT_TOTAL);
      expect(over.statusCode).toBe(503);
      expect(String(over._written.join(''))).toContain('on this server');

      for (const c of children) c.emit('close', 0);
      await Promise.all(running);
    });
  });

  // --- backpressure ---------------------------------------------------------------
  it('(backpressure) pauses the child stdout when the response is full and resumes on drain', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const service = buildService();
    const res = fakeRes();

    const p = service.run(baseRequest, fakeReq(), res);
    await flush();
    child.stdout.emit(
      'data',
      Buffer.from('Status: 200 OK\r\n\r\nfirst', 'utf8'),
    );
    expect(child.stdout.pause).not.toHaveBeenCalled();

    res.writeReturns = false; // the client stopped reading
    child.stdout.emit('data', Buffer.from('second'));
    expect(child.stdout.pause).toHaveBeenCalledTimes(1);
    expect(child.stdout.resume).not.toHaveBeenCalled();

    res.writeReturns = true;
    res.emit('drain');
    expect(child.stdout.resume).toHaveBeenCalledTimes(1);

    child.emit('close', 0);
    await p;
    expect(res.writableEnded).toBe(true);
  });

  // --- request body budget (PUSH_BUDGET.totalBytes) ---------------------------------
  describe('request body budget', () => {
    const push = {
      ...baseRequest,
      method: 'POST',
      subpath: 'git-receive-pack',
      queryString: '',
    };

    it('a body over the budget is cut before the crossing chunk: child killed, 413 with the reason', async () => {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      const service = buildService();
      const req = fakeReq();
      req.complete = false;
      const res = fakeRes();
      const warnSpy = jest.spyOn(Logger.prototype, 'warn');

      const p = service.run(push, req, res);
      await flush();
      expect(req.pipe).toHaveBeenCalledWith(child.stdin);

      req.emit('data', Buffer.alloc(BODY_BUDGET - 1));
      expect(groupSignals(child)).toEqual([]);
      expect(child.stdin.destroy).not.toHaveBeenCalled();

      req.emit('data', Buffer.alloc(2));
      await p;

      expect(req.unpipe).toHaveBeenCalledWith(child.stdin);
      expect(child.stdin.destroy).toHaveBeenCalled();
      expect(groupSignals(child)).toContain('SIGTERM');
      expect(res.statusCode).toBe(413);
      expect(res._headers['Content-Type']).toBe('text/plain');
      expect(res.end).toHaveBeenCalledWith(
        expect.stringContaining(`push budget of ${BODY_BUDGET} bytes`),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          new RegExp(`space space-1: the request body reached ${BODY_BUDGET + 1} bytes`),
        ),
      );
    });

    it('a body over the budget after the response started only ends the response', async () => {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      const service = buildService();
      const req = fakeReq();
      req.complete = false;
      const res = fakeRes();

      const p = service.run(push, req, res);
      await flush();
      child.stdout.emit('data', Buffer.from('Status: 200 OK\r\n\r\nx', 'utf8'));
      req.emit('data', Buffer.alloc(BODY_BUDGET + 1));
      await p;

      expect(groupSignals(child)).toContain('SIGTERM');
      expect(res.statusCode).toBe(200);
      expect(res.writableEnded).toBe(true);
      expect(res.end).not.toHaveBeenCalledWith(
        expect.stringContaining('push budget'),
      );
    });

    it('a body within the budget is not cut', async () => {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      const service = buildService();
      const req = fakeReq();
      const res = fakeRes();

      const p = service.run(push, req, res);
      await flush();
      req.emit('data', Buffer.alloc(BODY_BUDGET));
      child.stdout.emit('data', Buffer.from('Status: 200 OK\r\n\r\nok', 'utf8'));
      child.emit('close', 0);
      await p;

      expect(groupSignals(child)).toEqual([]);
      expect(child.stdin.destroy).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(200);
    });
  });

  // --- CGI header buffer cap -----------------------------------------------------
  it(`output past ${GIT_BACKEND_CGI_HEADER_MAX_BYTES} bytes without a header terminator -> child killed, 500, ERROR log`, async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const service = buildService();
    const res = fakeRes();
    const errorSpy = jest.spyOn(Logger.prototype, 'error');

    const p = service.run(baseRequest, fakeReq(), res);
    await flush();
    child.stdout.emit('data', Buffer.alloc(GIT_BACKEND_CGI_HEADER_MAX_BYTES, 'a'));
    expect(groupSignals(child)).toEqual([]);
    child.stdout.emit('data', Buffer.from('a'));
    await p;

    expect(groupSignals(child)).toContain('SIGTERM');
    expect(res.statusCode).toBe(500);
    expect(res.end).toHaveBeenCalledWith('Internal server error');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        new RegExp(
          `space space-1 emitted ${GIT_BACKEND_CGI_HEADER_MAX_BYTES + 1} bytes ` +
            `without ending its CGI header block`,
        ),
      ),
    );
  });

  // --- watchdog: idle for reads, hard cap for receive-pack -----------------------
  describe('watchdog', () => {
    beforeEach(() => {
      // Keep setImmediate real so flush() still lets run() reach the spawn.
      jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    });
    afterEach(() => jest.useRealTimers());

    it('an upload-pack that keeps producing output is NOT killed (idle window re-armed)', async () => {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      const service = buildService(1000);

      const p = service.run(
        { ...baseRequest, method: 'POST', subpath: 'git-upload-pack' },
        fakeReq(),
        fakeRes(),
      );
      await flush();
      child.stdout.emit('data', Buffer.from('Status: 200 OK\r\n\r\n', 'utf8'));
      // 3 s of total runtime, never 1 s without output.
      for (let i = 0; i < 6; i++) {
        jest.advanceTimersByTime(500);
        child.stdout.emit('data', Buffer.from('pack-bytes'));
      }
      expect(groupSignals(child)).toEqual([]);

      // Silence for the whole idle window -> killed.
      jest.advanceTimersByTime(1000);
      expect(groupSignals(child)).toContain('SIGTERM');
      await p;
    });

    it('a receive-pack keeps the HARD cap: output does not extend it', async () => {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      const service = buildService(1000);

      const p = service.run(
        { ...baseRequest, method: 'POST', subpath: 'git-receive-pack' },
        fakeReq(),
        fakeRes(),
      );
      await flush();
      jest.advanceTimersByTime(900);
      child.stdout.emit('data', Buffer.from('Status: 200 OK\r\n\r\nx', 'utf8'));
      expect(groupSignals(child)).toEqual([]);
      jest.advanceTimersByTime(100);
      expect(groupSignals(child)).toContain('SIGTERM');
      await p;
    });
  });

  // --- the kill reaches the receive-pack, not just http-backend -------------------
  describe('process group', () => {
    beforeEach(() => {
      // Keep setImmediate real so flush() still lets run() reach the spawn.
      jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    });
    afterEach(() => jest.useRealTimers());

    it('spawns the child as a process-group leader and kills the whole group: SIGTERM, then SIGKILL', async () => {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      const service = buildService();
      const controller = new AbortController();

      const p = service.run(
        { ...baseRequest, method: 'POST', subpath: 'git-receive-pack' },
        fakeReq(),
        fakeRes(),
        controller.signal,
      );
      await flush();
      expect(spawnMock).toHaveBeenCalledWith(
        'git',
        ['http-backend'],
        expect.objectContaining({ detached: true }),
      );

      controller.abort();
      await p;
      expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
      jest.advanceTimersByTime(2000);
      expect(groupSignals(child)).toEqual(['SIGTERM', 'SIGKILL']);
      // Never the child alone: its receive-pack would keep running.
      expect(child.kill).not.toHaveBeenCalled();
    });

    /** A receive-pack run whose child's receive-pack outlives http-backend. */
    async function killedReceivePack() {
      const child = fakeChild();
      child.groupOutlivesChild = true;
      spawnMock.mockReturnValue(child);
      const service = buildService();
      const res = fakeRes();
      const controller = new AbortController();
      let resolved = false;
      const p = service
        .run(
          { ...baseRequest, method: 'POST', subpath: 'git-receive-pack' },
          fakeReq(),
          res,
          controller.signal,
        )
        .then(() => {
          resolved = true;
        });
      await flush();
      controller.abort();
      return { child, res, p, isResolved: () => resolved };
    }

    it('after a forced kill, run() resolves only once the whole group is gone; the response is finished at once', async () => {
      const { child, res, p, isResolved } = await killedReceivePack();

      // The response is finished at once...
      expect(res.statusCode).toBe(500);
      expect(res.writableEnded).toBe(true);
      // ...but run() waits while the group still answers kill(-pid, 0).
      jest.advanceTimersByTime(1_000);
      await flush();
      expect(isResolved()).toBe(false);

      // The receive-pack exits: the next probe finds the group gone.
      child.groupOutlivesChild = false;
      jest.advanceTimersByTime(50);
      await p;
      expect(isResolved()).toBe(true);
    });

    it(`a group still alive ${GIT_BACKEND_GROUP_EXIT_MAX_MS} ms after the SIGTERM is released anyway, with an ERROR naming the space and pid`, async () => {
      const errorSpy = jest.spyOn(Logger.prototype, 'error');
      const { child, p, isResolved } = await killedReceivePack();

      jest.advanceTimersByTime(GIT_BACKEND_GROUP_EXIT_MAX_MS - 1);
      await flush();
      expect(isResolved()).toBe(false);
      expect(groupSignals(child)).toEqual(['SIGTERM', 'SIGKILL']);

      jest.advanceTimersByTime(1);
      await p;
      expect(isResolved()).toBe(true);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `space space-1: its process group ${child.pid} is still alive`,
        ),
      );
    });
  });
});

describe('buildGitBackendCgiEnv', () => {
  const base = {
    spaceId: 'space-1',
    subpath: 'info/refs',
    method: 'GET',
    queryString: 'service=git-upload-pack',
    contentType: '',
    remoteUser: 'alice@example.com',
  };

  it('points PATH_INFO at the vault dir (no .git suffix)', () => {
    // The vault lives at <root>/<spaceId> (no .git suffix), so PATH_INFO must be
    // /<spaceId>/<subpath>. A `.git` suffix would make git http-backend resolve
    // <root>/<spaceId>.git and 404 every fetch/push.
    const env = buildGitBackendCgiEnv(base, '/vaults');
    expect(env.PATH_INFO).toBe('/space-1/info/refs');
    expect(env.PATH_INFO).not.toContain('.git');
    expect(env.GIT_PROJECT_ROOT).toBe('/vaults');
  });

  it('forwards method/query/content-type/remote-user and exports all repos', () => {
    const env = buildGitBackendCgiEnv(
      { ...base, method: 'POST', subpath: 'git-receive-pack', contentType: 'application/x-git-receive-pack-request', queryString: '' },
      '/vaults',
    );
    expect(env.REQUEST_METHOD).toBe('POST');
    expect(env.PATH_INFO).toBe('/space-1/git-receive-pack');
    expect(env.CONTENT_TYPE).toBe('application/x-git-receive-pack-request');
    expect(env.REMOTE_USER).toBe('alice@example.com');
    expect(env.GIT_HTTP_EXPORT_ALL).toBe('1');
  });

  it('sets GIT_PROTOCOL only when the client sent the header', () => {
    expect(buildGitBackendCgiEnv(base, '/vaults').GIT_PROTOCOL).toBeUndefined();
    expect(
      buildGitBackendCgiEnv({ ...base, gitProtocol: 'version=2' }, '/vaults')
        .GIT_PROTOCOL,
    ).toBe('version=2');
  });
});

describe('parseCgiResponse', () => {
  it('defaults to status 200 with no Status header', () => {
    const r = parseCgiResponse('Content-Type: application/x-git-upload-pack-result');
    expect(r.statusCode).toBe(200);
    expect(r.headers).toEqual([
      ['Content-Type', 'application/x-git-upload-pack-result'],
    ]);
  });

  it('honors a Status header and does not forward it', () => {
    const r = parseCgiResponse('Status: 404 Not Found\nContent-Type: text/plain');
    expect(r.statusCode).toBe(404);
    expect(r.headers).toEqual([['Content-Type', 'text/plain']]);
  });

  it('parses multiple headers and trims whitespace', () => {
    const r = parseCgiResponse(
      'Status: 403 Forbidden\r\nContent-Type:  text/plain \r\nX-Foo:  bar ',
    );
    expect(r.statusCode).toBe(403);
    expect(r.headers).toEqual([
      ['Content-Type', 'text/plain'],
      ['X-Foo', 'bar'],
    ]);
  });

  it('ignores malformed (colon-less) lines defensively', () => {
    const r = parseCgiResponse('Content-Type: text/plain\ngarbage-line\nX-A: b');
    expect(r.statusCode).toBe(200);
    expect(r.headers).toEqual([
      ['Content-Type', 'text/plain'],
      ['X-A', 'b'],
    ]);
  });

  it('ignores an out-of-range Status code and keeps the default', () => {
    const r = parseCgiResponse('Status: not-a-number\nContent-Type: text/plain');
    expect(r.statusCode).toBe(200);
  });

  it('treats the Status header case-insensitively', () => {
    const r = parseCgiResponse('status: 500 Boom');
    expect(r.statusCode).toBe(500);
    expect(r.headers).toEqual([]);
  });
});

describe('splitCgiBuffer', () => {
  it('splits on a CRLF blank line and keeps the body as bytes', () => {
    const buf = Buffer.concat([
      Buffer.from('Status: 200 OK\r\nContent-Type: text/plain\r\n\r\n', 'utf8'),
      Buffer.from([0x00, 0x01, 0x02, 0xff]),
    ]);
    const split = splitCgiBuffer(buf);
    expect(split).not.toBeNull();
    expect(split!.headerText).toBe('Status: 200 OK\r\nContent-Type: text/plain');
    expect(Array.from(split!.body)).toEqual([0x00, 0x01, 0x02, 0xff]);
  });

  it('splits on a bare LF blank line', () => {
    const buf = Buffer.from('Content-Type: text/plain\n\nhello', 'utf8');
    const split = splitCgiBuffer(buf);
    expect(split).not.toBeNull();
    expect(split!.headerText).toBe('Content-Type: text/plain');
    expect(split!.body.toString('utf8')).toBe('hello');
  });

  it('returns an empty body when nothing follows the separator', () => {
    const buf = Buffer.from('Content-Type: text/plain\r\n\r\n', 'utf8');
    const split = splitCgiBuffer(buf);
    expect(split).not.toBeNull();
    expect(split!.body.length).toBe(0);
  });

  it('returns null when there is no blank-line separator yet', () => {
    const buf = Buffer.from('Content-Type: text/plain\r\nincomplete', 'utf8');
    expect(splitCgiBuffer(buf)).toBeNull();
  });
});
