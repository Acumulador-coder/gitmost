/**
 * A converter worker thread of `ConverterPool` (./convert-pool.ts): runs the
 * synchronous markdown <-> ProseMirror conversions off the caller's event loop.
 * The converter package installs its jsdom DOM when it loads, so that DOM
 * lives here, in the worker.
 *
 * Imports only packages and types: test runners start this file from its
 * TypeScript source, with Node stripping the types, where a relative module
 * import would not resolve.
 */
import { parentPort } from "node:worker_threads";
import {
  ConverterLossError,
  convertProseMirrorToMarkdown,
  markdownToProseMirror,
} from "@docmost/prosemirror-markdown";
import type {
  ConvertReply,
  ConvertRequest,
  SerializedError,
} from "./convert-pool.js";

async function run(request: ConvertRequest): Promise<string> {
  if (request.op === "markdownToProseMirror") {
    return JSON.stringify(
      await markdownToProseMirror(request.markdown, request.options),
    );
  }
  // The normalize-on-write fixpoint (DESIGN.md §11), export -> import -> export:
  // idempotent for already-stable content, and where the converter's known
  // one-pass asymmetries converge. git-sync is the LOSSLESS mirror, so the
  // serializer runs in strict mode: a node or mark it has no case for throws a
  // ConverterLossError instead of being written lossily.
  const content =
    request.docJson === undefined ? undefined : JSON.parse(request.docJson);
  const md1 = convertProseMirrorToMarkdown(content, { strict: true });
  const doc2 = await markdownToProseMirror(md1);
  return convertProseMirrorToMarkdown(doc2, { strict: true });
}

function serializeError(err: unknown): SerializedError {
  if (!(err instanceof Error)) return { name: "Error", message: String(err) };
  return {
    name: err.name,
    message: err.message,
    stack: err.stack,
    ...(err instanceof ConverterLossError
      ? { kind: err.kind, typeName: err.typeName }
      : {}),
  };
}

const port = parentPort;
if (port === null) {
  throw new Error("convert-worker.ts must run as a worker thread");
}
port.on("message", (request: ConvertRequest) => {
  run(request).then(
    (result) => {
      const reply: ConvertReply = { id: request.id, ok: true, result };
      port.postMessage(reply);
    },
    (err: unknown) => {
      const reply: ConvertReply = {
        id: request.id,
        ok: false,
        error: serializeError(err),
      };
      port.postMessage(reply);
    },
  );
});
