/**
 * Semantic canonicalization of ProseMirror/TipTap documents for the round-trip
 * idempotency check (SPEC §11: compare a CANONICALIZED form rather than raw
 * bytes).
 *
 * `markdownToProseMirror` reconstructs schema DEFAULT attributes (e.g.
 * `indent: 0` where the source omitted it) and regenerates per-block ids on
 * every import. A raw deep-equal of the source doc against the re-imported doc
 * therefore diverges even when the two are semantically identical. This module
 * normalizes a document so that two semantically-equal docs compare deep-equal
 * regardless of block ids and absent-vs-explicit-default-null attributes.
 *
 * The schema defaults come from the converter's own schema (editor-ext's
 * `documentExtensions` plus the converter `OVERRIDES`, `docmost-schema.ts`), so
 * there is no hand-kept list to drift from it.
 */
import { getSchema } from "@tiptap/core";
import { docmostExtensions } from "./docmost-schema.js";
import { convertProseMirrorToMarkdown } from "./markdown-converter.js";

type DefaultsByType = Record<string, Record<string, unknown>>;

let schemaDefaults: { nodes: DefaultsByType; marks: DefaultsByType } | null =
  null;

/**
 * The NON-NULL attribute defaults of every node and mark type of the converter
 * schema, keyed by type → { attr: defaultValue }. Built once from
 * `docmostExtensions`.
 *
 * `canonicalizeAttrs` already treats an absent attr as equivalent to an explicit
 * `null`/`undefined`, but these attributes default to a NON-null value, so import
 * fills them in even when the source omitted them. Dropping a value equal to its
 * default keeps "absent ≡ explicit default"; a non-default value (e.g.
 * `orderedList.start: 5`) is kept.
 */
function defaultsFor(
  kind: "nodes" | "marks",
  type: string,
): Record<string, unknown> | undefined {
  if (!schemaDefaults) {
    const schema = getSchema(docmostExtensions as any);
    const collect = (types: Record<string, { spec: any }>): DefaultsByType => {
      const out: DefaultsByType = {};
      for (const [name, t] of Object.entries(types)) {
        const attrs: Record<string, unknown> = {};
        for (const [attr, spec] of Object.entries<any>(t.spec.attrs ?? {})) {
          if (spec?.default !== null && spec?.default !== undefined) {
            attrs[attr] = spec.default;
          }
        }
        if (Object.keys(attrs).length > 0) out[name] = attrs;
      }
      return out;
    };
    schemaDefaults = {
      nodes: collect(schema.nodes as any),
      marks: collect(schema.marks as any),
    };
  }
  return schemaDefaults[kind][type];
}

/** Value equality for an attr default (defaults may be arrays/objects). */
function equalsDefault(value: unknown, def: unknown): boolean {
  if (value === def) return true;
  return (
    typeof value === "object" &&
    typeof def === "object" &&
    JSON.stringify(value) === JSON.stringify(def)
  );
}

/**
 * Prune an `attrs` object in place on a fresh copy: drop keys whose value is
 * `null` or `undefined` (an absent attribute and an explicit default of `null`
 * are semantically equivalent here). Optionally also drop a node-level `id`
 * (block ids are regenerated on import, SPEC §11). ALSO drop any attr whose
 * value equals the node/mark `type`'s NON-null schema default (`defaultsFor`),
 * so "attr absent" ≡ "attr at its default value" — without this, the
 * import-materialized `link.target`/`comment.resolved`/`orderedList.start`/
 * diagram `align` defaults would be a phantom diff. Every non-default attribute
 * value is KEPT (level, language, src, href, commentId, width, a non-default
 * `start`/`align`, ...).
 *
 * Returns the pruned attrs object, or `undefined` if nothing meaningful is
 * left (so the caller can drop the `attrs` key entirely: `{attrs:{}}` ≡ no
 * attrs).
 */
function canonicalizeAttrs(
  attrs: Record<string, unknown>,
  dropId: boolean,
  type: string | undefined,
): Record<string, unknown> | undefined {
  // `dropId` is true exactly for node attrs (marks keep every attr).
  const defaults = type ? defaultsFor(dropId ? "nodes" : "marks", type) : undefined;
  const out: Record<string, unknown> = {};
  // Stable key order so a JSON.stringify of the canonical form is comparable
  // regardless of the input's key order.
  for (const key of Object.keys(attrs).sort()) {
    // Block ids are regenerated on import; drop them on NODE attrs only.
    if (dropId && key === "id") continue;
    const value = attrs[key];
    // Absent ≡ explicit-default-null/undefined.
    if (value === null || value === undefined) continue;
    // Absent ≡ explicit known non-null default (e.g. link.target="_blank").
    // A non-default value (e.g. orderedList.start=5) does NOT match, so it is
    // kept. The `comment` mark's `commentId` is never a default, so it always
    // survives (SPEC §3); only its `resolved: false` default is normalized away.
    if (defaults && key in defaults && equalsDefault(value, defaults[key])) {
      continue;
    }
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Return a DEEP COPY of a ProseMirror node tree, canonicalized so that two
 * semantically-equal documents compare deep-equal. Rules (applied recursively
 * to the node, its `content`, and its `marks`):
 *
 *  1. Remove node-level `attrs.id` (regenerated on import). Mark attrs are NOT
 *     touched for `id` (marks carry no block id; only their meaningful attrs).
 *  2. In any `attrs` object (node OR mark) drop keys whose value is `null`/
 *     `undefined` (absent ≡ explicit default null) OR equals that node/mark
 *     type's non-null schema default (absent ≡ explicit default).
 *     Keep every non-default value. The type is passed into the attrs
 *     normalizer so it can look up the schema defaults.
 *  3. If an `attrs` object becomes empty after pruning, drop the `attrs` key.
 *  4. Preserve `marks` (including the `comment` mark and its `commentId` — a
 *     meaningful anchor per SPEC §3; never strip it).
 *  5. Preserve `text`, `type`, and `content` order exactly.
 *  6. Never mutate the input.
 */
export function canonicalizeContent(node: any): any {
  if (Array.isArray(node)) {
    return node.map((child) => canonicalizeContent(child));
  }
  if (node === null || typeof node !== "object") {
    // Primitive leaf (string/number/boolean/null): returned as-is.
    return node;
  }

  // A node is a mark when it has a `type` but never carries block `content`
  // and lives inside a `marks` array. We cannot tell from the node alone, so
  // we distinguish at the recursion site: node `attrs` drop `id`, mark `attrs`
  // do not. This is handled by passing a `dropId` flag down for the `attrs`
  // key specifically (nodes) vs the `marks[].attrs` path (marks).
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(node)) {
    if (key === "attrs" && node.attrs && typeof node.attrs === "object") {
      // Node-level attrs: drop the block id, null/undefined attrs, and any
      // attr at this node type's non-null schema default.
      const canon = canonicalizeAttrs(
        node.attrs as Record<string, unknown>,
        true,
        typeof node.type === "string" ? node.type : undefined,
      );
      if (canon !== undefined) out.attrs = canon;
      // else: drop the `attrs` key entirely (rule 3).
    } else if (key === "marks" && Array.isArray(node.marks)) {
      // Marks: keep them all (incl. comment); canonicalize their attrs but do
      // NOT drop `id` (a mark's `id` would be a meaningful attr, not a block
      // id). An empty marks array is dropped so `marks:[]` ≡ no marks.
      const marks = (node.marks as any[]).map((mark) => canonicalizeMark(mark));
      if (marks.length > 0) out.marks = marks;
    } else {
      out[key] = canonicalizeContent(node[key]);
    }
  }
  return out;
}

/**
 * Canonicalize a single mark: keep `type`, prune its `attrs` (null/undefined
 * AND non-null schema defaults dropped, empty attrs removed) but NEVER drop a
 * mark's attribute as a "block id" — marks have no block id, only meaningful
 * attrs (href, commentId, color, level, ...). Meaningful NON-default attrs
 * survive (the `comment` mark's `commentId` is never a default, so it always
 * survives — SPEC §3); only known defaults like `link.target="_blank"`,
 * `link.rel="noopener…"` and `comment.resolved=false` are normalized away.
 */
function canonicalizeMark(mark: any): any {
  if (mark === null || typeof mark !== "object") return mark;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(mark)) {
    if (key === "attrs" && mark.attrs && typeof mark.attrs === "object") {
      const canon = canonicalizeAttrs(
        mark.attrs as Record<string, unknown>,
        false,
        typeof mark.type === "string" ? mark.type : undefined,
      );
      if (canon !== undefined) out.attrs = canon;
    } else {
      out[key] = canonicalizeContent(mark[key]);
    }
  }
  return out;
}

/**
 * Deep structural equality of two values that is key-order-insensitive.
 * Used to compare canonical forms. (`canonicalizeContent` already emits
 * `attrs` in a stable key order, but the top-level node keys preserve input
 * order, so we compare structurally rather than by string.)
 */
function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return false;

  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);
  if (aIsArr !== bIsArr) return false;

  if (aIsArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

/**
 * True when two ProseMirror documents are semantically equal: equal after
 * canonicalization (block ids stripped, absent-vs-default-null normalized).
 */
export function docsCanonicallyEqual(a: any, b: any): boolean {
  return deepEqual(canonicalizeContent(a), canonicalizeContent(b));
}

/**
 * The markdown projection of ONE top-level block: the canonical converter's
 * markdown for a doc holding only that block — exactly what a git vault keeps
 * of it. Two blocks with the same projection are "equal up to markdown losses":
 * they differ only in what markdown cannot carry (block ids, `indent`, callout
 * `icon`, table `colwidth`/cell colours, …), with no per-attribute list to keep
 * in sync with the schema.
 *
 * Stable without a re-parse: the converter's P2 property (README, property
 * suite) makes the first export a byte fixpoint, so the projection of a block
 * and of its markdown re-import are equal.
 *
 * The block is projected on its own, so a footnote reference renders as `^[]`
 * and the bodies live in the projection of the `footnotesList` block.
 */
export function markdownBlockKey(block: any): string {
  return convertProseMirrorToMarkdown({ type: "doc", content: [block] });
}

/**
 * Whether a block projection is empty: the block (an empty paragraph, the
 * editor's trailing paragraph) carries nothing markdown keeps, so it can never
 * be part of a git change.
 */
export function isIgnorableBlockKey(key: string): boolean {
  return key.trim() === "";
}

/**
 * The ONE equivalence predicate "equal up to markdown losses": two documents
 * are equal when their non-ignorable top-level block projections
 * (`markdownBlockKey`) are equal, in order. This is the equality the git-sync
 * body merge keys its blocks by, so a body this predicate calls equal to the
 * live page merges with zero operations.
 */
export function docsEqualUpToMarkdown(a: any, b: any): boolean {
  const keys = (doc: any): string[] =>
    (Array.isArray(doc?.content) ? doc.content : [])
      .map(markdownBlockKey)
      .filter((key: string) => !isIgnorableBlockKey(key));
  const ka = keys(a);
  const kb = keys(b);
  return ka.length === kb.length && ka.every((key, i) => key === kb[i]);
}
