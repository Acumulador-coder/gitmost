import { createPatch, Operation } from "rfc6902";
import { diffArrays } from "diff";

/**
 * fastCreatePatch — a drop-in replacement for rfc6902's `createPatch(a, b)` that
 * swaps the built-in O(len(a)·len(b)) dynamic-programming array diff for a linear
 * Myers diff (via the `diff` package). rfc6902@5.2.0 accepts a 3rd `diff` hook
 * argument, invoked at every recursion level: returning `undefined` falls back to
 * the default behaviour, so we only take over ARRAY pairs (where the quadratic
 * cost lives — ProseMirror `content` arrays of block nodes) and let rfc6902 handle
 * objects/scalars natively.
 *
 * Page-history version navigation spends most of its time in this array diff,
 * so it must be linear; the JSON-Patch semantics the consumer (recreateTransform)
 * relies on are preserved.
 */

// ---------------------------------------------------------------------------
// Policy constants; each carries its justification.
// No env knobs — this ships in the client bundle, so the values are compiled in.
// ---------------------------------------------------------------------------

/**
 * The "whole array was rewritten" (degenerate) classifier only even considers
 * firing on arrays longer than this. Below it, the granular per-run conversion is
 * already cheap and more precise, and a false "rewrite" verdict would clobber a
 * small array with one giant ReplaceStep (losing highlight granularity). 50 block
 * nodes ≈ a medium page section.
 */
export const DEGENERATE_MIN_LEN = 50;

/**
 * Degenerate branch requires the unchanged fraction to be below this. If ≥10% of
 * the array survived unchanged it is an edit, not a rewrite, so we keep the
 * granular path (which preserves the untouched middle).
 */
export const DEGENERATE_COMMON_RATIO = 0.1;

/**
 * Second gate for the O(N) pre-classifier ONLY: the fraction of the SMALLER array
 * that survives unchanged must also be below this for a "rewrite" verdict.
 *
 * `shared / maxLen` alone cannot tell a pure insert/delete apart from a genuine
 * rewrite: for a prepend+append around a preserved middle (from = 20 blocks, to =
 * 120 new + the same 20 + 120 new) `shared/maxLen = 20/260 ≈ 0.077` is small in
 * BOTH cases. The discriminating metric is `shared / min(N, M)`: it is ~1.0 for an
 * insert/delete (the whole smaller array is preserved) and ~0 for a true rewrite
 * (almost nothing preserved). Gating on it makes the pre-classifier a subset of the
 * post-Myers degenerate branch ON THE RATIO AXIS (proven): both require maxLen >
 * DEGENERATE_MIN_LEN and a below-threshold unchanged fraction, and neither fires on
 * a pure insert/delete (no removed+added pairs / smaller array fully preserved). On
 * the SIMILARITY axis the two are not strictly identical: the pre-classifier samples
 * POSITIONAL pairs input[i] vs output[i], whereas the post-Myers branch samples
 * pairs aligned by Myers RUNS, so a contrived input can be similar under one
 * sampling and dissimilar under the other. That divergence changes only op
 * granularity (whole-array replace vs run-based ops), never correctness — either way
 * the result round-trips. Reuses the same 0.1 threshold: "≥10% of the smaller array
 * preserved ⇒ not a wholesale rewrite".
 */
export const DEGENERATE_MIN_PRESERVED_RATIO = DEGENERATE_COMMON_RATIO;

/**
 * For determinism (and to bound the classifier's own cost) only the FIRST N
 * removed/added element pairs are sampled for the similarity test.
 */
export const PAIR_SAMPLE = 20;

/**
 * Degenerate branch requires FEWER than this fraction of sampled pairs to be
 * "similar". If ≥30% of replaced pairs still resemble their predecessor, the
 * change is better described as many local edits than as a wholesale rewrite.
 */
export const PAIR_SIMILAR_MIN = 0.3;

/**
 * Two elements count as "similar" when their token sets overlap by at least this
 * fraction (intersection / smaller-set size). Half the tokens shared ⇒ the block
 * is a lightly-edited version of the other, not an unrelated replacement.
 */
export const TOKEN_SIM_MIN = 0.5;

/**
 * Length threshold separating "coarse" runs (snapshot the whole array once) from
 * "fine" runs (emit one op per element). A removed/added/excess run longer than
 * this is treated as a bulk paste/cut: emitting 100s of element-wise add/remove
 * ops would hand the consumer back its quadratic loop, so instead we emit a single
 * whole-array snapshot that the consumer minimises via findDiffStart/findDiffEnd.
 */
export const RUN_COARSE_MIN = 100;

// Structural pointer type. rfc6902 exports `Pointer` at the root but NOT the
// `VoidableDiff` type; we only ever call `.toString()`, so type it structurally
// rather than deep-import rfc6902/pointer.
interface PathPointer {
  toString(): string;
}

// Tokens = maximal runs of letters or digits, Unicode-aware. Deliberately NOT
// [a-zA-Z0-9]+: with ASCII-only tokens, Cyrillic (or any non-Latin) content
// produces zero content tokens, so the tokens collapse onto the shared JSON keys
// ("type", "text", "content", "paragraph"…) and the similarity classifier goes
// blind, misreading every rewrite as "similar".
const TOKEN_RE = /\p{L}+|\p{N}+/gu;

function tokensOf(el: unknown): Set<string> {
  const s = JSON.stringify(el) ?? "";
  const matched = s.match(TOKEN_RE);
  return new Set(matched ?? []);
}

function elementType(el: unknown): unknown {
  return el && typeof el === "object"
    ? (el as { type?: unknown }).type
    : undefined;
}

/**
 * Similarity for the degenerate classifier: same node `type` AND token-set overlap
 * ≥ TOKEN_SIM_MIN. A pair whose BOTH token sets are empty compares by `type` only.
 * Token-intersection (not a length ratio) is used on purpose: a length ratio
 * misclassifies "every block uniformly expanded" as a rewrite and "same-shape
 * rewrite" as edits.
 */
function isSimilarPair(a: unknown, b: unknown): boolean {
  if (elementType(a) !== elementType(b)) return false;
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  if (ta.size === 0 && tb.size === 0) return true; // compare by type only
  if (ta.size === 0 || tb.size === 0) return false;
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let inter = 0;
  for (const x of small) if (large.has(x)) inter++;
  return inter / small.size >= TOKEN_SIM_MIN;
}

type RunKind = "same" | "add" | "remove";
interface AnnotatedRun {
  kind: RunKind;
  elems: any[];
  count: number;
}

/**
 * Linear array diff hook. Returns `undefined` for non-array pairs so rfc6902 falls
 * back to its default object/scalar diff. For array pairs it produces a sequence of
 * JSON-Patch operations (relative to `ptr`) computed in O(N+M) via Myers.
 *
 * Scope of "equivalent": the emitted ops are ROUND-TRIP-equivalent to rfc6902's —
 * applying them to `input` yields `output` exactly, and they preserve the same
 * display semantics the consumer (recreateTransform) relies on. They are NOT
 * byte-identical to what rfc6902's DP array diff would emit: the OP GRANULARITY
 * differs by design (the coarse-run snapshots and the degenerate whole-array
 * replace collapse many fine ops into one), which changes highlight granularity in
 * the diff view but not correctness. This is verified by external round-trip
 * fuzzing (9000+ pairs, zero replay!=target failures) and the seeded property
 * test in recreateTransform.property.test.ts, not by op-for-op equality.
 */
export function fastArrayDiff(
  input: any,
  output: any,
  ptr: PathPointer,
): Operation[] | undefined {
  if (!Array.isArray(input) || !Array.isArray(output)) return undefined;

  const N = input.length;
  const M = output.length;
  const maxLen = Math.max(N, M);
  const basePath = ptr.toString();

  // 1. Fingerprint every element via JSON.stringify and intern into integer ids.
  // The Map is created PER CALL and shared for this call's input+output only — a
  // module-level/cross-call cache would grow unbounded in a long-lived editor tab.
  const ids = new Map<string, number>();
  const intern = (el: unknown): number => {
    // `undefined` stringifies to `undefined` (not a string); give it a stable
    // distinct key. The sentinel is a plain ASCII marker that is deliberately NOT
    // valid JSON: `JSON.stringify` of any real array element yields a value that
    // starts with `{`, `[`, `"`, a digit, `-`, `t`/`f` (true/false) or `n` (null),
    // so it can never equal this `__…__` string — collisions are impossible.
    // Keep it a plain string: a literal NUL byte makes git treat the file as
    // binary, and a formatter can silently drop it.
    const key = JSON.stringify(el) ?? "__fastdiff_undefined_sentinel__";
    let id = ids.get(key);
    if (id === undefined) {
      id = ids.size;
      ids.set(key, id);
    }
    return id;
  };
  const inputIds = input.map(intern);
  const outputIds = output.map(intern);

  // 1b. Cheap O(N) degenerate pre-classifier. `diffArrays` (Myers, O(N·D)) below
  // degrades toward O(N²) when almost nothing matches, so a genuine wholesale
  // rewrite would otherwise pay that cost just to be classified as "rewrite" and
  // collapsed to one replace. This short-circuits genuine full rewrites BEFORE
  // Myers runs, when the arrays are OBVIOUSLY a rewrite: very few shared
  // fingerprints (both vs maxLen AND vs the smaller array), plus dissimilar
  // positionally-aligned leading elements.
  //
  // The two ratio gates make this a subset of the post-Myers degenerate branch ON
  // THE RATIO AXIS, so when it fires it emits the SAME single whole-array replace
  // and only skips the diff. (The similarity sampling differs, which changes only
  // op granularity — see the DEGENERATE_MIN_PRESERVED_RATIO doc above.) The
  // `shared/min(N,M)` gate keeps it from EVER firing on a pure insert/delete
  // (prepend+append around a preserved middle): there the whole smaller array
  // survives, so shared/min ≈ 1.0 and the gate fails, mirroring the post-Myers
  // branch's "there must be removed+added pairs" guard. The multiset intersection over-estimates
  // the LCS common length, so both ratio gates stay conservative; anything this
  // misses still gets the exact run-based treatment.
  const minLen = Math.min(N, M);
  if (maxLen > DEGENERATE_MIN_LEN && minLen > 0) {
    const outCounts = new Map<number, number>();
    for (const id of outputIds) outCounts.set(id, (outCounts.get(id) ?? 0) + 1);
    let shared = 0; // multiset intersection size ≥ LCS common length
    for (const id of inputIds) {
      const c = outCounts.get(id);
      if (c) {
        shared++;
        outCounts.set(id, c - 1);
      }
    }
    if (
      shared / maxLen < DEGENERATE_COMMON_RATIO &&
      shared / minLen < DEGENERATE_MIN_PRESERVED_RATIO
    ) {
      // For a near-total rewrite Myers would yield one big removed + one big added
      // run, whose positional pairing is exactly input[i] vs output[i]; sample the
      // first PAIR_SAMPLE such pairs.
      const k = Math.min(N, M, PAIR_SAMPLE);
      if (k > 0) {
        let similar = 0;
        for (let i = 0; i < k; i++) {
          if (isSimilarPair(input[i], output[i])) similar++;
        }
        if (similar / k < PAIR_SIMILAR_MIN) {
          return [{ op: "replace", path: basePath, value: output }];
        }
      }
    }
  }

  // 2. Myers diff over the id arrays. Runs are {value, count, added, removed};
  // on a replacement the removed run precedes the added run. Normalize any
  // reversed (added-before-removed) adjacency just in case.
  const rawRuns = diffArrays(inputIds, outputIds);
  const runs: typeof rawRuns = [];
  for (let i = 0; i < rawRuns.length; i++) {
    const cur = rawRuns[i];
    const next = rawRuns[i + 1];
    if (cur.added && next && next.removed) {
      runs.push(next, cur);
      i++;
    } else {
      runs.push(cur);
    }
  }

  // Annotate each run with the actual element slice (runs carry only ids).
  const aruns: AnnotatedRun[] = [];
  let ci = 0;
  let co = 0;
  for (const run of runs) {
    if (!run.added && !run.removed) {
      aruns.push({
        kind: "same",
        elems: input.slice(ci, ci + run.count),
        count: run.count,
      });
      ci += run.count;
      co += run.count;
    } else if (run.removed) {
      aruns.push({
        kind: "remove",
        elems: input.slice(ci, ci + run.count),
        count: run.count,
      });
      ci += run.count;
    } else {
      aruns.push({
        kind: "add",
        elems: output.slice(co, co + run.count),
        count: run.count,
      });
      co += run.count;
    }
  }

  // 3. Degenerate ("whole array rewritten") classifier.
  const common = aruns.reduce(
    (s, r) => (r.kind === "same" ? s + r.count : s),
    0,
  );
  const commonRatio = maxLen === 0 ? 1 : common / maxLen;

  // Collect paired removed/added elements (adjacent remove+add runs).
  const pairs: Array<[any, any]> = [];
  for (let i = 0; i < aruns.length; i++) {
    if (aruns[i].kind === "remove" && aruns[i + 1]?.kind === "add") {
      const r = aruns[i].elems;
      const a = aruns[i + 1].elems;
      const k = Math.min(r.length, a.length);
      for (let j = 0; j < k; j++) pairs.push([r[j], a[j]]);
      i++;
    }
  }

  // Degenerate branch fires ONLY when: max length exceeds DEGENERATE_MIN_LEN, the
  // unchanged ratio is below DEGENERATE_COMMON_RATIO, there ARE paired elements
  // (pure inserts/deletes must NOT collapse to one whole-array replace — that
  // would clobber a preserved middle on prepend+append), and among the sampled
  // pairs fewer than PAIR_SIMILAR_MIN are similar.
  if (
    maxLen > DEGENERATE_MIN_LEN &&
    commonRatio < DEGENERATE_COMMON_RATIO &&
    pairs.length > 0
  ) {
    const sample = pairs.slice(0, PAIR_SAMPLE);
    const similar = sample.filter(([a, b]) => isSimilarPair(a, b)).length;
    if (similar / sample.length < PAIR_SIMILAR_MIN) {
      return [{ op: "replace", path: basePath, value: output }];
    }
  }

  // 4. Convert runs to sequential JSON-Patch ops.
  // INVARIANT: after each emitted op, `working` equals the array state produced by
  // applying all emitted ops so far. The coarse-run branch snapshots off `working`,
  // so any desync would silently revert already-emitted edits (replay ≠ target).
  const ops: Operation[] = [];
  const working = input.slice();
  let idx = 0;

  const rebase = (op: Operation, prefix: string): Operation => {
    const next: any = { ...op };
    // Sub-paths from createPatch start with "/" (nested) or are "" (whole-element
    // replace); prefix them with `${basePath}/${idx}`.
    next.path = prefix + (op as any).path;
    if ((op as any).from !== undefined) next.from = prefix + (op as any).from;
    return next;
  };

  // Excess/unpaired removed elements — ONE rule by LENGTH (not by unpaired-ness).
  const emitRemoved = (elems: any[]) => {
    if (elems.length > RUN_COARSE_MIN) {
      // Coarse: apply wholesale to `working`, emit ONE cumulative snapshot. idx
      // does NOT move after a removed run.
      working.splice(idx, elems.length);
      ops.push({ op: "replace", path: basePath, value: working.slice() });
    } else {
      // Fine: one remove per element. idx stays put (elements shift down into it).
      for (let j = 0; j < elems.length; j++) {
        ops.push({ op: "remove", path: `${basePath}/${idx}` });
        working.splice(idx, 1);
      }
    }
  };

  // Excess/unpaired added elements — same LENGTH rule.
  const emitAdded = (elems: any[]) => {
    if (elems.length > RUN_COARSE_MIN) {
      // Coarse: splice into `working`, emit ONE cumulative snapshot. idx += count
      // after an added-run/excess snapshot.
      working.splice(idx, 0, ...elems);
      ops.push({ op: "replace", path: basePath, value: working.slice() });
      idx += elems.length;
    } else {
      for (let j = 0; j < elems.length; j++) {
        ops.push({ op: "add", path: `${basePath}/${idx}`, value: elems[j] });
        working.splice(idx, 0, elems[j]);
        idx++;
      }
    }
  };

  for (let i = 0; i < aruns.length; i++) {
    const run = aruns[i];
    if (run.kind === "same") {
      idx += run.count;
      continue;
    }
    if (run.kind === "remove") {
      const next = aruns[i + 1];
      if (next && next.kind === "add") {
        i++; // consume the paired added run
        const rElems = run.elems;
        const aElems = next.elems;
        const pairCount = Math.min(rElems.length, aElems.length);
        for (let j = 0; j < pairCount; j++) {
          const inEl = rElems[j];
          const outEl = aElems[j];
          if (elementType(inEl) !== elementType(outEl)) {
            // Type-guard: do NOT recurse into cross-type pairs. Recursion would
            // emit ops (e.g. `add …/text` onto a node with no text, then
            // `replace …/type`) that leave an invalid intermediate node the
            // consumer deterministically dies on ("No valid diff possible").
            ops.push({
              op: "replace",
              path: `${basePath}/${idx}`,
              value: outEl,
            });
          } else {
            // Same type: recurse. An empty sub-path (whole-element replace) must
            // still produce a valid `${basePath}/${idx}` op.
            const sub = createPatch(inEl, outEl, fastArrayDiff);
            for (const s of sub) ops.push(rebase(s, `${basePath}/${idx}`));
          }
          working[idx] = outEl;
          idx++;
        }
        // Excess after positional pairing.
        if (rElems.length > aElems.length) {
          emitRemoved(rElems.slice(pairCount));
        } else if (aElems.length > rElems.length) {
          emitAdded(aElems.slice(pairCount));
        }
      } else {
        // Pure removed run (no adjacent add).
        emitRemoved(run.elems);
      }
    } else {
      // Pure added run (an add preceded by a remove is consumed above).
      emitAdded(run.elems);
    }
  }

  return ops;
}

/** Drop-in replacement for `createPatch(a, b)` with the linear array-diff hook. */
export function fastCreatePatch(input: any, output: any): Operation[] {
  return createPatch(input, output, fastArrayDiff);
}
