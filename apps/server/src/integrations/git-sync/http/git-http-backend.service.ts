import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadGitSync } from '../git-sync.loader';
import { EnvironmentService } from '../../environment/environment.service';

/** The parsed first part of a CGI response: the HTTP status + header pairs. */
export interface ParsedCgiResponse {
  statusCode: number;
  /** Lower-cased? No — keep header names verbatim as git http-backend emits. */
  headers: Array<[string, string]>;
}

/**
 * Parse the CGI header block emitted by `git http-backend` into an HTTP status
 * and a list of header pairs. The input is ONLY the header text (everything up
 * to, but not including, the blank-line separator) — the binary body is split
 * off by the caller on the raw Buffer (never stringified).
 *
 * CGI semantics (RFC 3875 §6): a `Status: <code> <reason>` header sets the HTTP
 * status (default 200 when absent). Every other header is forwarded verbatim.
 * Header lines are `Name: value`; a line without a ':' is ignored defensively.
 *
 * Pure + framework-free so it is unit-testable in isolation.
 */
export function parseCgiResponse(headerBlock: string): ParsedCgiResponse {
  let statusCode = 200;
  const headers: Array<[string, string]> = [];

  // Header lines may be separated by CRLF or LF; split on either.
  const lines = headerBlock.split(/\r?\n/);
  for (const line of lines) {
    if (line.length === 0) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue; // not a header line — ignore defensively
    const name = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (name.toLowerCase() === 'status') {
      // `Status: 404 Not Found` — the leading integer is the HTTP status code.
      const code = parseInt(value, 10);
      if (Number.isFinite(code) && code >= 100 && code <= 599) {
        statusCode = code;
      }
      continue; // never forward the CGI Status header itself
    }
    headers.push([name, value]);
  }

  return { statusCode, headers };
}

/**
 * Split a raw CGI response buffer at the first blank-line boundary
 * (`\r\n\r\n` or `\n\n`). Returns the header text and the remaining body bytes.
 * Returns null when no blank-line separator is present (a malformed response).
 *
 * Pure (operates on Buffers, never stringifies the body) so it is testable.
 */
export function splitCgiBuffer(
  buf: Buffer,
): { headerText: string; body: Buffer } | null {
  // Prefer the CRLF separator; fall back to bare LF.
  let idx = buf.indexOf('\r\n\r\n');
  let sepLen = 4;
  if (idx === -1) {
    idx = buf.indexOf('\n\n');
    sepLen = 2;
  }
  if (idx === -1) return null;
  const headerText = buf.subarray(0, idx).toString('utf8');
  const body = buf.subarray(idx + sepLen);
  return { headerText, body };
}

/** A parsed git smart-HTTP request, resolved by the controller/handler. */
export interface GitHttpBackendRequest {
  /** The space id (the on-disk vault dir name == GIT_PROJECT_ROOT child). */
  spaceId: string;
  /** The subpath after `<spaceId>.git/`, e.g. `info/refs` or `git-receive-pack`. */
  subpath: string;
  /** REQUEST_METHOD — `GET` or `POST`. */
  method: string;
  /** Raw query string WITHOUT the leading '?', e.g. `service=git-receive-pack`. */
  queryString: string;
  /** Content-Type header value (may be empty for GET). */
  contentType: string;
  /** The Git-Protocol request header value, or undefined when absent. */
  gitProtocol?: string;
  /** Content-Encoding request header (e.g. `gzip`), or undefined when absent.
   * git gzips RPC bodies >1KiB; http-backend only inflates when HTTP_CONTENT_ENCODING
   * is present, so it MUST be forwarded or a non-trivial `git pull` fails with
   * `fatal: expected 'packfile'` (review #4). */
  contentEncoding?: string;
  /** Authenticated user email — used as REMOTE_USER (reflog identity). */
  remoteUser: string;
}

/**
 * Bridges an HTTP git smart-protocol request to `git http-backend` (the CGI that
 * implements the entire smart-HTTP protocol: info/refs, upload-pack,
 * receive-pack, protocol v2, dumb fallback). We do NOT reimplement pkt-line.
 *
 * The Fastify reply is hijacked by the caller; this service streams the request
 * body to the child's stdin and writes the child's CGI response (status +
 * headers parsed from the leading header block, then the raw binary body) to the
 * Node response. Errors before any output produce a 500. Credentials are never
 * logged.
 */
/**
 * Build the `git http-backend` CGI environment overlay for one request (the
 * variables layered on top of `vaultGitEnv`'s cwd-isolated base). Pure so the
 * PATH_INFO / REMOTE_USER / conditional GIT_PROTOCOL wiring is unit-testable
 * without spawning git.
 *
 * PATH_INFO is the repo-relative CGI path. The vault is a bare repo on disk at
 * `<dataDir>/<spaceId>` (no `.git` suffix on disk), so the
 * repo directory git http-backend must resolve is `<spaceId>` — NOT
 * `<spaceId>.git`. The URL carries the conventional `.git` suffix (stripped by
 * parseGitPath into `spaceId`); re-appending it here would point the CGI at a
 * non-existent `<dataDir>/<spaceId>.git` and every fetch/push would 404.
 */
export function buildGitBackendCgiEnv(
  parsed: GitHttpBackendRequest,
  projectRoot: string,
): Record<string, string> {
  const cgiEnv: Record<string, string> = {
    GIT_PROJECT_ROOT: projectRoot,
    GIT_HTTP_EXPORT_ALL: '1', // authz is done by us; no git-daemon-export-ok file
    PATH_INFO: `/${parsed.spaceId}/${parsed.subpath}`,
    REQUEST_METHOD: parsed.method,
    QUERY_STRING: parsed.queryString,
    CONTENT_TYPE: parsed.contentType,
    REMOTE_USER: parsed.remoteUser,
  };
  // GIT_PROTOCOL is only set when the client sent the Git-Protocol header.
  if (parsed.gitProtocol) {
    cgiEnv.GIT_PROTOCOL = parsed.gitProtocol;
  }
  // HTTP_CONTENT_ENCODING must be forwarded so git http-backend inflates a
  // gzip'd RPC body (git compresses receive-pack/upload-pack bodies >1KiB).
  // Without it a non-trivial `git pull` negotiation fails deterministically with
  // `fatal: expected 'packfile'` (review #4). The body is piped to stdin as-is
  // (no upstream decompression), so the CGI must do the inflate.
  if (parsed.contentEncoding) {
    cgiEnv.HTTP_CONTENT_ENCODING = parsed.contentEncoding;
  }
  return cgiEnv;
}

/**
 * Concurrency budget for spawned `git http-backend` children. Every
 * smart-HTTP request spawns one child (an upload-pack in turn runs pack-objects),
 * so without a budget N parallel fetches mean N processes. Over budget the
 * request is answered 503 + Retry-After with the reason, and nothing is spawned.
 */
export const GIT_BACKEND_MAX_CONCURRENT_PER_SPACE = 4;
export const GIT_BACKEND_MAX_CONCURRENT_TOTAL = 16;
/** Retry-After (seconds) sent with an over-budget 503. */
const GIT_BACKEND_BUSY_RETRY_AFTER_S = '5';

/**
 * The most child output buffered while waiting for the end of the CGI header
 * block. git's headers are a few hundred bytes; past this the child is killed
 * and the request answered 500.
 */
export const GIT_BACKEND_CGI_HEADER_MAX_BYTES = 64 * 1024;

/**
 * After a forced termination, how often the child's process group is probed,
 * and how long after the SIGTERM it may live before the request is released
 * anyway (with an ERROR).
 */
const GIT_BACKEND_GROUP_PROBE_MS = 50;
export const GIT_BACKEND_GROUP_EXIT_MAX_MS = 5_000;

@Injectable()
export class GitHttpBackendService {
  private readonly logger = new Logger(GitHttpBackendService.name);

  /** Live backend slots: process-wide and per space (a zero entry is deleted). */
  private activeTotal = 0;
  private readonly activePerSpace = new Map<string, number>();

  constructor(private readonly environmentService: EnvironmentService) {}

  /**
   * Reserve one backend slot for `spaceId`. Returns null on success, or the
   * human-readable reason the request is over budget (nothing reserved).
   */
  private tryAcquireSlot(spaceId: string): string | null {
    const perSpace = this.activePerSpace.get(spaceId) ?? 0;
    if (perSpace >= GIT_BACKEND_MAX_CONCURRENT_PER_SPACE) {
      return (
        `too many concurrent git requests for this space ` +
        `(limit ${GIT_BACKEND_MAX_CONCURRENT_PER_SPACE})`
      );
    }
    if (this.activeTotal >= GIT_BACKEND_MAX_CONCURRENT_TOTAL) {
      return (
        `too many concurrent git requests on this server ` +
        `(limit ${GIT_BACKEND_MAX_CONCURRENT_TOTAL})`
      );
    }
    this.activePerSpace.set(spaceId, perSpace + 1);
    this.activeTotal += 1;
    return null;
  }

  /** Release a slot taken by tryAcquireSlot (called exactly once per slot). */
  private releaseSlot(spaceId: string): void {
    const perSpace = (this.activePerSpace.get(spaceId) ?? 0) - 1;
    if (perSpace > 0) this.activePerSpace.set(spaceId, perSpace);
    else this.activePerSpace.delete(spaceId);
    this.activeTotal = Math.max(0, this.activeTotal - 1);
  }

  /**
   * Spawn `git http-backend` for one request and bridge it to the raw Node
   * request/response. Resolves when the response has been fully written (the
   * child exited and its output was flushed), or after a 500 was sent on an
   * early failure. Never rejects — push ingestion relies on this resolving so
   * the lock-held cycle body can run afterwards.
   *
   * `signal` (optional) is the git-sync per-space lock's lost-lock abort signal.
   * A receive-pack writes `main`, so if the lock lapses mid-push
   * (heartbeat CAS miss / Redis outage) the signal fires and we kill the child —
   * preventing it from continuing to write the vault while another replica
   * may have taken over the lock and started a cycle.
   *
   * The child is also killed when the client goes away before it finished, and
   * every child holds a slot of the concurrency budget for its whole life (over
   * budget -> 503 with the reason, nothing spawned).
   */
  async run(
    parsed: GitHttpBackendRequest,
    rawReq: IncomingMessage,
    rawRes: ServerResponse,
    signal?: AbortSignal,
  ): Promise<void> {
    const { vaultGitEnv, PUSH_BUDGET } = await loadGitSync();
    // The request body forwarded to the child is cut at the push byte budget:
    // git writes the whole pack to disk before the pre-receive hook checks it.
    const maxBodyBytes = PUSH_BUDGET.totalBytes;
    const projectRoot = this.environmentService.getGitSyncDataDir();
    // Build the CGI env from the engine's cwd-isolated base (strips GIT_DIR /
    // GIT_WORK_TREE), then layer the http-backend CGI variables. PATH is
    // preserved (vaultGitEnv already copies process.env, so PATH carries
    // through).
    const env = vaultGitEnv(buildGitBackendCgiEnv(parsed, projectRoot));
    // A git-receive-pack runs under the per-space lock, so its watchdog is a
    // HARD cap: a stalled push can never hold the lock longer than this. Every
    // other request (upload-pack, ref advertisements) gets an IDLE watchdog that
    // is re-armed on every chunk of child output, so an honest long clone over a
    // slow link is not killed while a stalled one still is.
    const hardCap =
      parsed.method === 'POST' && parsed.subpath === 'git-receive-pack';
    const timeoutMs = this.environmentService.getGitSyncBackendTimeoutMs();

    return new Promise<void>((resolve) => {
      let settled = false;
      // Whether this request holds a concurrency-budget slot (released in done()).
      let slotHeld = false;
      // Set once the child exists so the abort handler can target it.
      let onAbort: (() => void) | null = null;
      // Detaches the client-disconnect / drain listeners on the raw req/res.
      let detachResponseListeners: (() => void) | null = null;
      // The watchdog timer; cleared centrally in done() so EVERY settle path
      // (close, error, timeout, abort, client disconnect) tears it down once.
      let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
      // `groupGone` (a forced termination, see terminateChild): the request is
      // finished at once (`settled` stops every handler), but the slot is freed
      // and run() resolves — so the caller's space lock is released — only once
      // the child's process group is gone.
      const done = (groupGone?: Promise<void>) => {
        if (settled) return;
        settled = true;
        if (watchdogTimer) clearTimeout(watchdogTimer);
        // Detach the abort listener so a later lock loss does not fire into a
        // request that already finished.
        if (onAbort) {
          signal?.removeEventListener('abort', onAbort);
          onAbort = null;
        }
        if (detachResponseListeners) {
          detachResponseListeners();
          detachResponseListeners = null;
        }
        const release = () => {
          if (slotHeld) {
            slotHeld = false;
            this.releaseSlot(parsed.spaceId);
          }
          resolve();
        };
        if (groupGone) void groupGone.then(release);
        else release();
      };

      // Reject early if the lock was already lost before we even spawned: do not
      // start writing the vault after a possible lock takeover.
      if (signal?.aborted) {
        if (!rawRes.headersSent) this.send500(rawRes, 'lock-lost');
        else
          try {
            rawRes.end();
          } catch {
            /* ignore */
          }
        return done();
      }

      // The client may already be gone (e.g. it disconnected while the push
      // waited for the space lock): there is nobody to serve, spawn nothing.
      if (rawRes.destroyed) {
        this.logger.warn(
          `git http-backend not started for space ${parsed.spaceId}: the ` +
            `client disconnected before the request was served`,
        );
        return done();
      }

      // Concurrency budget: refuse with 503 + the reason when over it.
      const refusal = this.tryAcquireSlot(parsed.spaceId);
      if (refusal) {
        this.send503(rawRes, parsed.spaceId, refusal);
        return done();
      }
      slotHeld = true;

      let child: ReturnType<typeof spawn>;
      try {
        // `detached`: the child leads its own process group, shared with the
        // git processes it starts (receive-pack, index-pack, unpack-objects),
        // so terminateChild can signal them all. Not unref'd: run() still
        // waits for the child's 'close'.
        child = spawn('git', ['http-backend'], { env, detached: true });
      } catch (err) {
        this.send500(rawRes, 'spawn-failed', err);
        return done();
      }

      // Lost-lock abort: the per-space lock lapsed mid-request. Kill the child so
      // a receive-pack stops writing `main` before another replica
      // (which may now hold the lock) starts a cycle. Same kill+finish path the
      // watchdog uses (extracted into terminateChild).
      onAbort = () => {
        this.terminateChild(
          child,
          parsed.spaceId,
          rawRes,
          headerParsed,
          'lock-lost',
          'git http-backend aborted (git-sync lock lost mid-request); killing child',
          done,
        );
      };
      signal?.addEventListener('abort', onAbort);

      // Watchdog: a client that opens git-receive-pack and stalls keeps the
      // child alive forever, so run() never resolves and (because this runs
      // inside withSpaceLock) the per-space lock is held + heartbeat-refreshed
      // indefinitely. Bound the request: on expiry kill the child, send a clean
      // 500 if nothing was sent yet, and settle the promise. A receive-pack gets
      // a hard cap (armed once); everything else an idle window re-armed on each
      // stdout chunk (see `hardCap`). `.unref()` so the timer never keeps the
      // event loop alive; ALWAYS cleared in done().
      const armWatchdog = () => {
        if (watchdogTimer) clearTimeout(watchdogTimer);
        watchdogTimer = setTimeout(() => {
          this.terminateChild(
            child,
            parsed.spaceId,
            rawRes,
            headerParsed,
            'timeout',
            hardCap
              ? `git http-backend git-receive-pack for space ${parsed.spaceId} ` +
                  `exceeded the ${timeoutMs}ms hard cap; killing child`
              : `git http-backend for space ${parsed.spaceId} made no progress ` +
                  `for ${timeoutMs}ms; killing child`,
            done,
          );
        }, timeoutMs);
        watchdogTimer.unref?.();
      };
      armWatchdog();

      // Client disconnect: the response closing before it finished, or the
      // request body aborting before it completed, means nobody will read the
      // output — kill the child instead of letting it run to completion. A
      // normal finish ('close' after writableFinished, or the request 'close'
      // after the body was fully read) is ignored. There is nobody to send a 500
      // to, so the response is just ended (responseStarted = true).
      const onClientGone = (what: string) => {
        if (settled) return;
        this.terminateChild(
          child,
          parsed.spaceId,
          rawRes,
          true,
          'client-disconnected',
          `git http-backend for space ${parsed.spaceId}: ${what} before the ` +
            `request finished; killing child`,
          done,
        );
      };
      const onResponseClose = () => {
        if (!rawRes.writableFinished) onClientGone('the client disconnected');
      };
      const onRequestClose = () => {
        if (!rawReq.complete) onClientGone('the request body was aborted');
      };
      rawRes.on('close', onResponseClose);
      rawReq.on('close', onRequestClose);

      // Accumulate stdout until we have the full CGI header block, then write the
      // parsed status/headers and start streaming the remaining body bytes.
      let headerParsed = false;
      let pending: Buffer = Buffer.alloc(0);

      // Backpressure: when the response buffer is full, pause the child's
      // stdout until the client drains it, so a slow reader never makes the pack
      // accumulate in this process's memory (the child blocks on its pipe
      // instead). Chunks for a response that already ended or whose client is
      // gone are dropped.
      let awaitingDrain = false;
      const onDrain = () => {
        awaitingDrain = false;
        child.stdout?.resume();
      };
      const writeBody = (chunk: Buffer): void => {
        if (chunk.length === 0) return;
        if (rawRes.writableEnded || rawRes.destroyed) return;
        if (!rawRes.write(chunk) && !awaitingDrain) {
          awaitingDrain = true;
          child.stdout?.pause();
          rawRes.once('drain', onDrain);
        }
      };
      // Counts the request body bytes forwarded to the child (POST only).
      let onBodyData: ((chunk: Buffer) => void) | null = null;
      detachResponseListeners = () => {
        rawRes.off('close', onResponseClose);
        rawReq.off('close', onRequestClose);
        rawRes.off('drain', onDrain);
        if (onBodyData) rawReq.off('data', onBodyData);
      };

      const flushHeadersAndBody = (chunk: Buffer): void => {
        pending = Buffer.concat([pending, chunk]);
        const split = splitCgiBuffer(pending);
        if (!split) {
          // Header block not complete yet; never buffer more than the cap.
          if (pending.length > GIT_BACKEND_CGI_HEADER_MAX_BYTES) {
            const buffered = pending.length;
            pending = Buffer.alloc(0);
            this.terminateChild(
              child,
              parsed.spaceId,
              rawRes,
              false,
              'cgi-header-too-large',
              `git http-backend for space ${parsed.spaceId} emitted ` +
                `${buffered} bytes without ending its CGI header block ` +
                `(limit ${GIT_BACKEND_CGI_HEADER_MAX_BYTES}); killing child`,
              done,
              'error',
            );
          }
          return;
        }
        headerParsed = true;
        const { statusCode, headers } = parseCgiResponse(split.headerText);
        rawRes.statusCode = statusCode;
        for (const [name, value] of headers) {
          rawRes.setHeader(name, value);
        }
        pending = Buffer.alloc(0);
        writeBody(split.body);
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        // The request already settled (watchdog / abort / disconnect): nothing
        // more is forwarded, and the watchdog must not be re-armed.
        if (settled) return;
        // Progress re-arms the idle watchdog (never the receive-pack hard cap).
        if (!hardCap) armWatchdog();
        if (headerParsed) {
          writeBody(chunk);
        } else {
          flushHeadersAndBody(chunk);
        }
      });
      // A stream 'error' (e.g. EPIPE when the client aborts mid-response) is an
      // EventEmitter 'error' with no listener -> Node rethrows it as an uncaught
      // exception and crashes the process. Swallow + log it (never echo to the
      // client); child.on('close')/'error' below drives the actual cleanup.
      child.stdout?.on('error', (err) => {
        this.logger.warn(`git http-backend stdout stream error: ${err.message}`);
      });

      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        // Capture for diagnostics; never echo to the client. http-backend writes
        // CGI errors here. We do NOT log the request body or any credentials.
        if (stderr.length < 8192) stderr += chunk.toString('utf8');
      });
      child.stderr?.on('error', (err) => {
        this.logger.warn(`git http-backend stderr stream error: ${err.message}`);
      });

      child.on('error', (err) => {
        // The request already settled (watchdog / abort / disconnect finished
        // the response): only record the late child error.
        if (settled) {
          this.logger.warn(
            `git http-backend for space ${parsed.spaceId} errored after the ` +
              `request settled: ${err.name}: ${err.message}`,
          );
          return;
        }
        // The watchdog timer is cleared centrally in done().
        if (!headerParsed && !rawRes.headersSent) {
          this.send500(rawRes, 'child-error', err);
        } else {
          // Output already started — we can only terminate the stream.
          try {
            rawRes.end();
          } catch {
            /* ignore */
          }
        }
        done();
      });

      child.on('close', (code) => {
        // A forced termination (watchdog / abort / disconnect) already finished
        // the response and logged why; the killed child's exit is expected.
        if (settled) return;
        // The watchdog timer is cleared centrally in done().
        if (!headerParsed && !rawRes.headersSent) {
          // The child exited before emitting a complete CGI header block.
          this.logger.error(
            `git http-backend produced no valid response (exit ${code}) for ` +
              `space ${parsed.spaceId}; stderr: ${stderr.trim().slice(0, 500)}`,
          );
          this.send500(rawRes, 'no-output');
        } else {
          try {
            rawRes.end();
          } catch {
            /* ignore */
          }
        }
        done();
      });

      // Pipe the request body to the child's stdin. For GET there is no body, so
      // end stdin immediately. We pipe `rawReq` (the raw Node stream) directly so
      // large pushes are streamed, not buffered.
      if (parsed.method === 'POST') {
        // Registered BEFORE the pipe, so it sees each chunk first: the chunk that
        // crosses the budget is cut off (stdin destroyed) before it is forwarded.
        let bodyBytes = 0;
        onBodyData = (chunk: Buffer) => {
          if (settled) return;
          bodyBytes += chunk.length;
          if (bodyBytes <= maxBodyBytes) return;
          rawReq.unpipe(child.stdin!);
          child.stdin?.destroy();
          if (!headerParsed && !rawRes.headersSent) {
            this.send413(
              rawRes,
              parsed.spaceId,
              `Push refused: the request body exceeds the git-sync push ` +
                `budget of ${maxBodyBytes} bytes.`,
            );
          }
          this.terminateChild(
            child,
            parsed.spaceId,
            rawRes,
            true,
            'body-over-budget',
            `git http-backend for space ${parsed.spaceId}: the request body ` +
              `reached ${bodyBytes} bytes, over the ${maxBodyBytes}-byte push ` +
              `budget; killing child`,
            done,
          );
        };
        rawReq.on('data', onBodyData);
        rawReq.pipe(child.stdin!);
        rawReq.on('error', () => {
          try {
            child.stdin?.end();
          } catch {
            /* ignore */
          }
        });
      } else {
        child.stdin?.end();
      }
      // Swallow EPIPE etc. on the child's stdin so a client disconnect does not
      // crash the process.
      child.stdin?.on('error', () => {
        /* ignore broken-pipe on stdin */
      });
    });
  }

  /**
   * Kill the child's whole process group (SIGTERM, then SIGKILL after a grace
   * period if it ignores the term) — not just `git http-backend`, whose
   * receive-pack would otherwise keep updating `main` after the space lock was
   * released — and finish the HTTP response cleanly at once, then settle once
   * the group is gone (`waitForGroupExit`), so run() does not resolve, and the
   * space lock is not released, while a git process of it may still update
   * `main`. A group already gone (ESRCH on the
   * SIGTERM) settles at once. Shared by the
   * forced-termination paths — the watchdog timeout, the lost-lock abort, the
   * client disconnect, the CGI header cap and the body budget — which differ
   * ONLY by the log line (and its level) and the send500 `reason`. If no
   * response has started a clean 500 is sent; otherwise the
   * in-flight stream is just ended. Never throws (a thrown kill/end would crash
   * the request).
   */
  private terminateChild(
    child: ReturnType<typeof spawn>,
    spaceId: string,
    rawRes: ServerResponse,
    responseStarted: boolean,
    send500Reason: string,
    logMessage: string,
    done: (groupGone?: Promise<void>) => void,
    logLevel: 'warn' | 'error' = 'warn',
  ): void {
    this.logger[logLevel](logMessage);
    // Unset when the SIGTERM found no group: nothing left to wait for.
    let groupGone: Promise<void> | undefined;
    try {
      process.kill(-child.pid, 'SIGTERM');
      // Escalate to SIGKILL shortly after in case SIGTERM is ignored.
      const sigkill = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* ignore */
        }
      }, 2000);
      sigkill.unref?.();
      groupGone = this.waitForGroupExit(child, spaceId);
    } catch {
      /* ignore */
    }
    // Nothing more is forwarded after a forced termination. Destroying stdout
    // also releases a pipe paused for backpressure, which would otherwise keep
    // the killed child's buffered output (and its 'close') pending forever.
    child.stdout?.destroy();
    if (!responseStarted && !rawRes.headersSent) {
      this.send500(rawRes, send500Reason);
    } else {
      try {
        rawRes.end();
      } catch {
        /* ignore */
      }
    }
    done(groupGone);
  }

  /**
   * Resolve once `child`'s whole process group is gone: after the child itself
   * exited ('exit' or 'close', so it is reaped and no longer counts in its
   * group), `process.kill(-pid, 0)` is probed every GIT_BACKEND_GROUP_PROBE_MS
   * until it fails with ESRCH. A group still alive GIT_BACKEND_GROUP_EXIT_MAX_MS
   * after the SIGTERM is logged at ERROR, naming the space and pid, and the
   * wait ends anyway. Never rejects.
   */
  private waitForGroupExit(
    child: ReturnType<typeof spawn>,
    spaceId: string,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let finished = false;
      let probeTimer: ReturnType<typeof setTimeout> | undefined;
      const onExit = () => {
        child.off('exit', onExit);
        child.off('close', onExit);
        probe();
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(capTimer);
        if (probeTimer) clearTimeout(probeTimer);
        child.off('exit', onExit);
        child.off('close', onExit);
        resolve();
      };
      const probe = () => {
        if (finished) return;
        try {
          process.kill(-child.pid, 0);
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === 'ESRCH') return finish();
        }
        probeTimer = setTimeout(probe, GIT_BACKEND_GROUP_PROBE_MS);
        probeTimer.unref?.();
      };
      const capTimer = setTimeout(() => {
        this.logger.error(
          `git http-backend for space ${spaceId}: its process group ` +
            `${child.pid} is still alive ${GIT_BACKEND_GROUP_EXIT_MAX_MS}ms ` +
            `after SIGTERM; releasing the request anyway — a git process of ` +
            `it may still write the vault`,
        );
        finish();
      }, GIT_BACKEND_GROUP_EXIT_MAX_MS);
      capTimer.unref?.();
      if (child.exitCode !== null || child.signalCode !== null) probe();
      else {
        child.on('exit', onExit);
        child.on('close', onExit);
      }
    });
  }

  /** Send a clean 500 without leaking credentials or the request body. */
  private send500(rawRes: ServerResponse, reason: string, err?: unknown): void {
    const message = err instanceof Error ? err.message : undefined;
    this.logger.error(
      `git http-backend failed (${reason})${message ? `: ${message}` : ''}`,
    );
    try {
      if (!rawRes.headersSent) {
        rawRes.statusCode = 500;
        rawRes.setHeader('Content-Type', 'text/plain');
      }
      rawRes.end('Internal server error');
    } catch {
      /* ignore */
    }
  }

  /** Answer a request whose body is over the push byte budget 413 + why. */
  private send413(
    rawRes: ServerResponse,
    spaceId: string,
    message: string,
  ): void {
    try {
      rawRes.statusCode = 413;
      rawRes.setHeader('Content-Type', 'text/plain');
      rawRes.end(message);
    } catch (err) {
      this.logger.error(
        `git http-backend: failed to send the 413 for space ${spaceId}: ${
          err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        }`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }

  /**
   * Answer an over-budget request 503 + Retry-After. The body names the reason
   * (git shows a text/plain error body to the user); the operator gets a warn.
   */
  private send503(
    rawRes: ServerResponse,
    spaceId: string,
    reason: string,
  ): void {
    this.logger.warn(
      `git http-backend refused for space ${spaceId}: ${reason}`,
    );
    try {
      if (!rawRes.headersSent) {
        rawRes.statusCode = 503;
        rawRes.setHeader('Content-Type', 'text/plain');
        rawRes.setHeader('Retry-After', GIT_BACKEND_BUSY_RETRY_AFTER_S);
      }
      rawRes.end(`git-sync busy: ${reason}; retry shortly`);
    } catch (err) {
      this.logger.error(
        `git http-backend: failed to send the 503 for space ${spaceId}: ${
          err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        }`,
        err instanceof Error ? err.stack : undefined,
      );
    }
  }
}
