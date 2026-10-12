/**
 * Longest-common-subsequence alignment of two sequences of opaque string keys,
 * shared by the two-way block diff (`yjs-body-merge.diffBlocks`) and the
 * three-way planner (`three-way-merge.lcsPairs`).
 *
 * Size budget (AGENTS invariant 1/3): the old implementation filled a full
 * (n+1)×(m+1) table — a one-block edit on a 9,000-block page cost ~82M cells,
 * synchronously, on the collab event loop. This one:
 *   1. trims the common prefix and suffix (a typical git edit leaves almost the
 *      whole page outside the middle);
 *   2. drops from the middle every block whose key does not occur on the
 *      other side at all (it can never be matched), so rewritten blocks cost
 *      nothing and a full rewrite aligns trivially;
 *   3. aligns what remains with Myers' linear-space O((N+M)·D) algorithm
 *      (D = edit distance), on interned integer ids so each compare is O(1)
 *      instead of a compare of two long block keys;
 *   4. counts every diagonal probe and snake step against `budget.remaining`
 *      and throws `MergeBudgetExceededError` once it is spent — the caller
 *      refuses the write with that reason instead of freezing the process.
 * Memory is O(N+M) per call; no n² table is ever allocated.
 */

/** Work units (diagonal probes + snake steps) one merge may spend on alignment. */
export const MERGE_DIFF_WORK_BUDGET = 2_000_000;

/** A mutable work budget shared by every alignment one merge performs. */
export interface DiffBudget {
  remaining: number;
}

export function createDiffBudget(units = MERGE_DIFF_WORK_BUDGET): DiffBudget {
  return { remaining: units };
}

/**
 * Thrown when aligning the blocks would cost more than the merge's work budget.
 * The message names the sizes involved so the refusal is specific in the logs.
 */
export class MergeBudgetExceededError extends Error {
  constructor(aLength: number, bLength: number, budgetUnits: number) {
    super(
      `block diff of ${aLength} vs ${bLength} blocks exceeds the remaining ` +
        `merge work budget of ${budgetUnits} units (too many changed blocks ` +
        `to align safely on the event loop)`,
    );
    this.name = 'MergeBudgetExceededError';
  }
}

/**
 * Matched index pairs `[i, j]` (a[i] === b[j]) of a longest common subsequence
 * of `a` and `b`, in increasing order of both indices.
 */
export function lcsMatches(
  a: string[],
  b: string[],
  budget: DiffBudget = createDiffBudget(),
): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  const n = a.length;
  const m = b.length;

  // 1. Common prefix and suffix: emitted without any alignment work.
  let lo = 0;
  while (lo < n && lo < m && a[lo] === b[lo]) {
    pairs.push([lo, lo]);
    lo++;
  }
  let aHi = n;
  let bHi = m;
  while (aHi > lo && bHi > lo && a[aHi - 1] === b[bHi - 1]) {
    aHi--;
    bHi--;
  }
  const suffixLength = n - aHi;

  // 2. Myers over the middle, on interned ids.
  if (aHi > lo && bHi > lo) {
    const ids = new Map<string, number>();
    const intern = (key: string): number => {
      let id = ids.get(key);
      if (id === undefined) {
        id = ids.size;
        ids.set(key, id);
      }
      return id;
    };
    const aIds: number[] = [];
    for (let i = lo; i < aHi; i++) aIds.push(intern(a[i]));
    const bIds: number[] = [];
    for (let j = lo; j < bHi; j++) bIds.push(intern(b[j]));
    const inA = new Uint8Array(ids.size);
    for (const id of aIds) inA[id] = 1;
    const inB = new Uint8Array(ids.size);
    for (const id of bIds) inB[id] = 1;
    // Positions (in a / b) of the blocks whose key both sides have.
    const aPos: number[] = [];
    for (let i = 0; i < aIds.length; i++) if (inB[aIds[i]]) aPos.push(i);
    const bPos: number[] = [];
    for (let j = 0; j < bIds.length; j++) if (inA[bIds[j]]) bPos.push(j);
    if (aPos.length > 0 && bPos.length > 0) {
      const ai = Int32Array.from(aPos, (i) => aIds[i]);
      const bi = Int32Array.from(bPos, (j) => bIds[j]);
      const startBudget = budget.remaining;
      const middle = myers(ai, bi, budget);
      if (middle === null) {
        throw new MergeBudgetExceededError(n, m, startBudget);
      }
      for (const [i, j] of middle) pairs.push([aPos[i] + lo, bPos[j] + lo]);
    }
  }

  for (let k = 0; k < suffixLength; k++) {
    pairs.push([aHi + k, bHi + k]);
  }
  return pairs;
}

type Range = { aLo: number; aHi: number; bLo: number; bHi: number };
type Task = { range: Range } | { emit: Array<[number, number]> };

/**
 * Linear-space Myers (middle-snake divide and conquer) with an explicit task
 * stack (no recursion, so a large edit cannot overflow the call stack). Returns
 * the matched pairs in increasing order, or null when the budget ran out.
 */
function myers(
  a: Int32Array,
  b: Int32Array,
  budget: DiffBudget,
): Array<[number, number]> | null {
  const out: Array<[number, number]> = [];
  const size = a.length + b.length + 2;
  const vf = new Int32Array(2 * size + 1);
  const vb = new Int32Array(2 * size + 1);
  const stack: Task[] = [
    { range: { aLo: 0, aHi: a.length, bLo: 0, bHi: b.length } },
  ];

  while (stack.length) {
    const task = stack.pop()!;
    if ('emit' in task) {
      for (const p of task.emit) out.push(p);
      continue;
    }
    let { aLo, aHi, bLo, bHi } = task.range;
    // Trim this sub-range's common prefix/suffix.
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
      out.push([aLo, bLo]);
      aLo++;
      bLo++;
    }
    const suffix: Array<[number, number]> = [];
    while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) {
      aHi--;
      bHi--;
      suffix.push([aHi, bHi]);
    }
    suffix.reverse();
    if (aLo === aHi || bLo === bHi) {
      for (const p of suffix) out.push(p);
      continue;
    }
    const snake = middleSnake(a, aLo, aHi, b, bLo, bHi, vf, vb, size, budget);
    if (snake === null) return null;
    const [x, y, u, v] = snake;
    const snakePairs: Array<[number, number]> = [];
    for (let k = 0; k < u - x; k++) snakePairs.push([x + k, y + k]);
    // LIFO: push in reverse emission order.
    if (suffix.length) stack.push({ emit: suffix });
    stack.push({ range: { aLo: u, aHi, bLo: v, bHi } });
    if (snakePairs.length) stack.push({ emit: snakePairs });
    stack.push({ range: { aLo, aHi: x, bLo, bHi: y } });
  }
  return out;
}

/**
 * The middle snake of a[aLo,aHi) vs b[bLo,bHi): returns [x, y, u, v] in
 * absolute indices — the snake runs from (x, y) to (u, v) on one diagonal —
 * or null when the budget ran out. Both ranges are non-empty and their first
 * and last elements differ (the caller trims them).
 */
function middleSnake(
  a: Int32Array,
  aLo: number,
  aHi: number,
  b: Int32Array,
  bLo: number,
  bHi: number,
  vf: Int32Array,
  vb: Int32Array,
  offset: number,
  budget: DiffBudget,
): [number, number, number, number] | null {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const delta = n - m;
  const odd = (delta & 1) !== 0;
  const maxD = Math.ceil((n + m) / 2);
  vf[offset + 1] = 0;
  vb[offset + 1] = 0;
  let remaining = budget.remaining;
  for (let d = 0; d <= maxD; d++) {
    // Forward pass: furthest-reaching d-paths from (0, 0).
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && vf[offset + k - 1] < vf[offset + k + 1])
          ? vf[offset + k + 1]
          : vf[offset + k - 1] + 1;
      let y = x - k;
      const x0 = x;
      while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
        x++;
        y++;
      }
      remaining -= 1 + x - x0;
      if (remaining < 0) {
        budget.remaining = remaining;
        return null;
      }
      vf[offset + k] = x;
      if (odd && k >= delta - (d - 1) && k <= delta + (d - 1)) {
        if (x + vb[offset + delta - k] >= n) {
          budget.remaining = remaining;
          return [aLo + x0, bLo + x0 - k, aLo + x, bLo + y];
        }
      }
    }
    // Backward pass: furthest-reaching d-paths from (n, m), on reversed input.
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && vb[offset + k - 1] < vb[offset + k + 1])
          ? vb[offset + k + 1]
          : vb[offset + k - 1] + 1;
      let y = x - k;
      const x0 = x;
      while (x < n && y < m && a[aHi - 1 - x] === b[bHi - 1 - y]) {
        x++;
        y++;
      }
      remaining -= 1 + x - x0;
      if (remaining < 0) {
        budget.remaining = remaining;
        return null;
      }
      vb[offset + k] = x;
      if (!odd && delta - k >= -d && delta - k <= d) {
        if (x + vf[offset + delta - k] >= n) {
          budget.remaining = remaining;
          return [aHi - x, bHi - y, aHi - x0, bHi - (x0 - k)];
        }
      }
    }
  }
  // Unreachable for non-empty ranges: a d-path with d <= ceil((n+m)/2) always
  // meets its reverse counterpart.
  throw new Error(
    `block alignment found no middle snake for ${n} vs ${m} blocks`,
  );
}
