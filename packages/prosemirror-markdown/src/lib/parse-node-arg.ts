// The model sometimes serializes a ProseMirror node arg as a JSON string
// instead of an object. Normalize: parse a string to an object (throwing on
// invalid JSON), pass an object through unchanged. Shared by patchNode /
// insertNode (and the analogous updatePageJson content parsing).
//
// It lives in the converter package because both `@docmost/mcp` (ESM) and the
// CommonJS server app import it; the server cannot import `@docmost/mcp`
// (ESM-only, no declaration files).
export function parseNodeArg(
  node: unknown,
  errMsg = "node was a string but not valid JSON",
): unknown {
  if (typeof node === "string") {
    try {
      return JSON.parse(node);
    } catch {
      throw new Error(errMsg);
    }
  }
  return node;
}
