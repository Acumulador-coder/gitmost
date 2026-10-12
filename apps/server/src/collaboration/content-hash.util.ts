import { createHash } from 'node:crypto';

/**
 * The one place a page-content hash is computed. Both the server-side CAS base
 * hash (readLiveIfLoaded / replaceIfMatch) and the
 * `/pages/info?includeContentHash` read path go through here, so a read and a
 * later write can never disagree on normalization.
 *
 * sha256(hex) over a CANONICAL serialization of the ProseMirror JSON — object
 * keys recursively sorted, no insignificant whitespace. The input MUST be the
 * output of `TiptapTransformer.fromYdoc(doc, 'default')`, never the raw
 * `page.content`: the transformer materializes attrs like `indent:0`, so
 * `fromYdoc(toYdoc(x)) !== x`, and hashing raw content gives a permanent false
 * 409.
 *
 * The hash is opaque to clients: the MCP client only echoes it back.
 */
export function pageContentHash(pmJson: unknown): string {
  return createHash('sha256').update(canonicalStringify(pmJson)).digest('hex');
}

/**
 * Deterministic, whitespace-free JSON serialization with recursively sorted
 * object keys. `undefined` object properties are dropped (JSON.stringify parity);
 * arrays keep their order (order is meaningful in a PM doc); primitives and
 * `null` serialize as ordinary JSON.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    // Match JSON.stringify: a property whose value is `undefined` is omitted.
    if (v === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${canonicalStringify(v)}`);
  }
  return `{${parts.join(',')}}`;
}
