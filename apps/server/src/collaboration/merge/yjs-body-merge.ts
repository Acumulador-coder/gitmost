import * as Y from 'yjs';
import { updateYFragment, yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import {
  isIgnorableBlockKey,
  markdownBlockKey,
} from '@docmost/prosemirror-markdown';

import { getDocumentSchema } from '../collaboration.util';
import { diff3PlanWithConflicts, Pick } from './three-way-merge';
import { createDiffBudget, lcsMatches } from './lcs';

/**
 * Block-level merge of an incoming (git) page body into a LIVE Yjs document.
 *
 * Diff the two documents at TOP-LEVEL BLOCK granularity (an LCS over each
 * block's markdown projection, `blockKey`) and apply only the minimal
 * operations. Blocks with the same projection on both sides are left UNTOUCHED,
 * so a human editing one paragraph is unaffected when git changes another, and
 * an unchanged re-sync is a no-op (zero Yjs operations). Yjs then CRDT-merges
 * the minimal ops with any concurrent edits.
 *
 * A THREE-WAY merge (live vs incoming vs base) runs whenever the engine passes
 * the body at the last export (`baseMarkdown` from refs/docmost/last-export): a
 * block both sides changed is a conflict resolved to git, with the prior state
 * preserved in page history. Without a base (a brand-new file) it falls back to
 * a 2-way merge. Unchanged resyncs and edits to different blocks are lossless in
 * both modes.
 */

type XmlNode = Y.XmlElement | Y.XmlText | Y.XmlHook;

/**
 * The comparison key of a top-level block: its markdown projection
 * (`markdownBlockKey` from the canonical converter). The live Yjs document is
 * lossless while the base and the git body are rebuilt from markdown, so the
 * two sides are compared by what markdown keeps of them — a live block equals
 * its git twin whenever they differ only in what markdown cannot carry (the
 * block `id`, `indent`, a callout `icon`, table `colwidth`/cell colours,
 * schema-default attributes, an erased empty text). There is no hand-kept list
 * of such attributes to drift from the converter: whatever the converter drops
 * is, by construction, not part of the key. A block whose projection is empty
 * (an empty paragraph) is ignorable (`isIgnorableBlockKey`).
 *
 * Known limitation: two distinct blocks with the same projection share a key,
 * so when git deletes one of them the LCS may drop the OTHER live instance. The
 * visible result is identical, but an in-flight human edit on the dropped
 * instance could be lost.
 */
export function blockKey(node: unknown): string {
  return markdownBlockKey(yBlockToJson(node));
}

/**
 * ProseMirror JSON of one top-level Yjs block, through y-prosemirror's own
 * Y→JSON serializer (the one `TiptapTransformer.fromYdoc` uses for the whole
 * document; it only reads `toArray()` of what it is given).
 */
function yBlockToJson(node: unknown): any {
  return yXmlFragmentToProsemirrorJSON({ toArray: () => [node] } as any)
    .content[0];
}

/** Blocks projected between two yields while keys are computed ahead of a merge. */
const KEY_CHUNK = 200;

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/**
 * `blockKey` of every top-level block of `frag`, computed in chunks that yield
 * to the event loop between them (AGENTS invariant 3: projecting a 10k-block
 * page is tens of milliseconds of synchronous CPU). For a fragment nobody else
 * mutates meanwhile (a git body or base built for this merge).
 */
export async function fragmentKeysYielding(
  frag: Y.XmlFragment,
  signal?: AbortSignal,
): Promise<string[]> {
  const kids = frag.toArray();
  const keys: string[] = [];
  for (let i = 0; i < kids.length; i++) {
    if (i > 0 && i % KEY_CHUNK === 0) {
      await yieldToEventLoop();
      signal?.throwIfAborted();
    }
    keys.push(blockKey(kids[i]));
  }
  return keys;
}

/**
 * `blockKey`s of a LIVE fragment, primed ahead of the merge transaction in
 * yielding chunks and kept valid against edits that land meanwhile: a deep
 * observer marks every top-level block an update touches, and `keysOf`
 * recomputes only those (and blocks inserted since) synchronously, inside the
 * transaction. `dispose()` MUST be called (it removes the observer).
 */
export class LiveBlockKeys {
  private readonly keys = new WeakMap<object, string>();
  private readonly stale = new WeakSet<object>();
  private readonly observer = (events: Array<Y.YEvent<any>>): void => {
    for (const event of events) {
      let type: any = event.target;
      while (type && type.parent && type.parent !== this.frag) {
        type = type.parent;
      }
      if (type && type.parent === this.frag) this.stale.add(type);
    }
  };

  constructor(private readonly frag: Y.XmlFragment) {
    frag.observeDeep(this.observer);
  }

  async prime(signal?: AbortSignal): Promise<void> {
    const kids = this.frag.toArray();
    for (let i = 0; i < kids.length; i++) {
      if (i > 0 && i % KEY_CHUNK === 0) {
        await yieldToEventLoop();
        signal?.throwIfAborted();
      }
      this.keys.set(kids[i], blockKey(kids[i]));
    }
  }

  /** Keys of `kids` (the fragment's CURRENT children, read in the same tick). */
  keysOf(kids: unknown[]): string[] {
    return kids.map((kid) => {
      const cached = this.stale.has(kid as object)
        ? undefined
        : this.keys.get(kid as object);
      return cached ?? blockKey(kid);
    });
  }

  dispose(): void {
    this.frag.unobserveDeep(this.observer);
  }
}

/**
 * Deep-clone a detached/owned Yjs XML node into a fresh node that can be inserted
 * into ANOTHER document (Yjs types are bound to their doc, so cross-doc moves are
 * impossible — we rebuild). Preserves nodeName, attributes, text+marks (via the
 * XmlText delta) and the full child subtree.
 */
export function cloneXmlNode(node: XmlNode): Y.XmlElement | Y.XmlText {
  if (node instanceof Y.XmlText) {
    const t = new Y.XmlText();
    const delta = node.toDelta();
    if (delta.length) t.applyDelta(delta);
    return t;
  }
  if (node instanceof Y.XmlElement) {
    const el = new Y.XmlElement(node.nodeName);
    const attrs = node.getAttributes() as Record<string, unknown>;
    for (const k of Object.keys(attrs)) el.setAttribute(k, attrs[k] as string);
    const kids = node.toArray().map((c) => cloneXmlNode(c as XmlNode));
    if (kids.length) el.insert(0, kids);
    return el;
  }
  // Best-effort for any other node type (XmlHook — does not occur in the
  // Docmost block schema): an empty paragraph so the merge never crashes.
  return new Y.XmlElement('paragraph');
}

type Op = { op: 'keep' } | { op: 'del' } | { op: 'ins'; bi: number };

/**
 * LCS-based edit script turning sequence `a` (live block keys) into `b` (incoming
 * block keys): a run of keep/del/ins ops. The alignment is bounded by `budget`
 * (see `lcs.ts`): it throws `MergeBudgetExceededError` instead of allocating
 * an n×m table.
 */
export function diffBlocks(
  a: string[],
  b: string[],
  budget = createDiffBudget(),
): Op[] {
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  for (const [x, y] of lcsMatches(a, b, budget)) {
    while (i < x) {
      ops.push({ op: 'del' });
      i++;
    }
    while (j < y) {
      ops.push({ op: 'ins', bi: j });
      j++;
    }
    ops.push({ op: 'keep' });
    i++;
    j++;
  }
  while (i < a.length) {
    ops.push({ op: 'del' });
    i++;
  }
  while (j < b.length) {
    ops.push({ op: 'ins', bi: j });
    j++;
  }
  return ops;
}

/**
 * Keys for `kids`: the precomputed ones when given (they MUST belong to exactly
 * these children, read in the same synchronous section), else computed here.
 */
function keysFor(kids: unknown[], given: string[] | undefined, side: string) {
  if (!given) return kids.map(blockKey);
  if (given.length !== kids.length) {
    throw new Error(
      `git-sync merge: ${given.length} precomputed ${side} keys for ` +
        `${kids.length} ${side} blocks`,
    );
  }
  return given;
}

/** Run `fn` as ONE Yjs transaction of `frag`'s document (nested-safe). */
function inTransaction<T>(frag: Y.XmlFragment, fn: () => T): T {
  let result!: T;
  if (frag.doc) {
    frag.doc.transact(() => {
      result = fn();
    });
  } else {
    result = fn();
  }
  return result;
}

/**
 * Merge `target` block children into `live`, mutating `live` in place with the
 * minimal set of inserts/deletes, as one Yjs transaction. Returns the number of
 * block operations applied (0 == content already identical). `keys` may carry
 * precomputed `blockKey`s of both sides (see `keysFor`).
 */
export function mergeXmlFragments(
  live: Y.XmlFragment,
  target: Y.XmlFragment,
  keys: { live?: string[]; target?: string[] } = {},
): number {
  const liveKids = live.toArray();
  const targetKids = target.toArray();
  const liveKeys = keysFor(liveKids, keys.live, 'live');
  const targetKeys = keysFor(targetKids, keys.target, 'target');

  const ops = diffBlocks(liveKeys, targetKeys);

  return inTransaction(live, () => {
    let cursor = 0; // index into the LIVE fragment as we mutate it
    let applied = 0;
    for (const op of ops) {
      if (op.op === 'keep') {
        cursor++;
      } else if (op.op === 'del') {
        live.delete(cursor, 1); // remove the live block at the cursor; do not advance
        applied++;
      } else {
        live.insert(cursor, [cloneXmlNode(targetKids[op.bi] as XmlNode)]);
        cursor++;
        applied++;
      }
    }
    return applied;
  });
}

/** Outcome of a 3-way block merge: ops applied + same-block conflict count. */
export interface Merge3WayResult {
  /**
   * Number of block operations applied to `live`: inserts, deletes and
   * in-place updates of a live block git changed.
   */
  applied: number;
  /**
   * Regions where the human AND git rewrote the SAME base block. The rule is
   * deterministic (GIT WINS the region), so the human's version of those blocks
   * is dropped from the live doc. `conflicts > 0` is the OBSERVABLE signal the
   * caller uses to LOG the loss and pin the human baseline to page history (so it
   * is recoverable), instead of the edit vanishing silently.
   */
  conflicts: number;
}

const isElementJson = (n: any): boolean =>
  n != null && typeof n === 'object' && !Array.isArray(n) && n.type !== 'text';

/** Attribute equality where absent and null are the same. */
function sameAttr(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Structural signature of a node with every `id` attribute left out. */
function withoutIds(node: any): string {
  return JSON.stringify(node, (k, v) => (k === 'id' ? undefined : v));
}

/**
 * Pair `target` children with `base` children (both parsed from markdown):
 * the common prefix and suffix by structure, and the middle index by index when
 * both middles have the same length. Returns target index -> base index.
 */
function pairChildren(base: any[], target: any[]): Map<number, number> {
  const pairs = new Map<number, number>();
  let p = 0;
  while (
    p < base.length &&
    p < target.length &&
    withoutIds(base[p]) === withoutIds(target[p])
  ) {
    pairs.set(p, p);
    p++;
  }
  let s = 0;
  while (
    s < base.length - p &&
    s < target.length - p &&
    withoutIds(base[base.length - 1 - s]) ===
      withoutIds(target[target.length - 1 - s])
  ) {
    pairs.set(target.length - 1 - s, base.length - 1 - s);
    s++;
  }
  if (base.length - p - s === target.length - p - s) {
    for (let k = p; k < target.length - s; k++) pairs.set(k, k);
  }
  return pairs;
}

/**
 * `target` — a git block replacing a live block whose projection equals the
 * base — with the live block's attributes that the markdown projection loses
 * carried over, at every level where the three trees line up (table rows and
 * cells, list items, callout children, ...): an attribute git left as the base
 * had it while live holds it differently is one git could not see (`indent`,
 * callout `icon`, cell `colwidth`/`backgroundColor`, ...), so live's value
 * stays. An attribute git changed keeps git's value. The `id` comes from live
 * wherever live has one: the base and git ids are fresh per markdown import,
 * never content.
 */
function carryOver(live: any, base: any, target: any): any {
  if (
    !isElementJson(live) ||
    !isElementJson(base) ||
    !isElementJson(target) ||
    live.type !== base.type ||
    base.type !== target.type
  ) {
    return target;
  }
  const liveAttrs = live.attrs ?? {};
  const baseAttrs = base.attrs ?? {};
  const attrs: Record<string, unknown> = { ...(target.attrs ?? {}) };
  for (const k of new Set([
    ...Object.keys(liveAttrs),
    ...Object.keys(baseAttrs),
  ])) {
    if (k === 'id') continue;
    if (
      !sameAttr(liveAttrs[k], baseAttrs[k]) &&
      sameAttr(attrs[k], baseAttrs[k])
    ) {
      if (liveAttrs[k] == null) delete attrs[k];
      else attrs[k] = liveAttrs[k];
    }
  }
  if (liveAttrs.id != null) attrs.id = liveAttrs.id;
  const out = { ...target, attrs };
  const lc: any[] = live.content ?? [];
  const bc: any[] = base.content ?? [];
  const tc: any[] = target.content ?? [];
  if (lc.length === bc.length && tc.length > 0) {
    const pairs = pairChildren(bc, tc);
    out.content = tc.map((t, j) => {
      const b = pairs.get(j);
      return b === undefined ? t : carryOver(lc[b], bc[b], t);
    });
  }
  return out;
}

type Step =
  | { kind: 'keep'; live: number }
  | { kind: 'update'; live: number; node: any }
  | { kind: 'insert'; target: number };

/**
 * The plan's picks as apply steps. A git block that replaces an unchanged live
 * block of the same type becomes an IN-PLACE update of that live block
 * (`updateYFragment`: only the changed attributes, children and text ranges
 * are touched), so the live block keeps its identity, its lossy attributes
 * (`carryOver`) and any concurrent client edit outside the changed range
 * (GL-5); anything else is inserted as a clone. Built entirely before the
 * first mutation, so a failure here leaves the live doc untouched.
 */
function planSteps(
  picks: Pick[],
  liveKids: unknown[],
  baseKids: unknown[],
  targetKids: unknown[],
): Step[] {
  const schema = getDocumentSchema();
  const steps: Step[] = picks.map((p): Step => {
    if (p.src === 'live') return { kind: 'keep', live: p.index };
    const liveEl = p.replaces ? liveKids[p.replaces.live] : undefined;
    const baseEl = p.replaces ? baseKids[p.replaces.base] : undefined;
    const targetEl = targetKids[p.index];
    if (
      liveEl instanceof Y.XmlElement &&
      baseEl instanceof Y.XmlElement &&
      targetEl instanceof Y.XmlElement &&
      liveEl.nodeName === targetEl.nodeName &&
      baseEl.nodeName === targetEl.nodeName
    ) {
      const json = carryOver(
        yBlockToJson(liveEl),
        yBlockToJson(baseEl),
        yBlockToJson(targetEl),
      );
      return {
        kind: 'update',
        live: p.replaces!.live,
        node: schema.nodeFromJSON(json),
      };
    }
    return { kind: 'insert', target: p.index };
  });
  // The applier walks live once, front to back.
  let last = -1;
  for (const step of steps) {
    if (step.kind === 'insert') continue;
    if (step.live <= last) {
      throw new Error(
        `git-sync merge plan does not keep live blocks in order (live block ` +
          `${step.live} after ${last}); refusing to apply it`,
      );
    }
    last = step.live;
  }
  return steps;
}

/**
 * THREE-WAY block merge: reconcile `live` toward `target` using `base` (the
 * last-synced common ancestor) so a block only the human changed is KEPT and a
 * block only git changed is taken. Conflicts (both changed the same block)
 * resolve to git; their count is returned so the caller can log that git won a
 * same-block edit, whose prior state stays recoverable via page history.
 *
 * `diff3PlanWithConflicts` computes the merged block order (picks from live or
 * target, bounded by one work budget — over it, `MergeBudgetExceededError` is
 * thrown before anything changes); the steps are then applied to `live` as ONE
 * Yjs transaction: untouched live blocks stay the same instances, a block git
 * changed is updated in place (`planSteps`), and only genuinely new blocks are
 * inserted. `keys` may carry precomputed `blockKey`s of the three sides (the
 * caller computes them ahead of its transaction, see `fragmentKeysYielding` /
 * `LiveBlockKeys`).
 */
export function mergeXmlFragments3WayWithStats(
  live: Y.XmlFragment,
  target: Y.XmlFragment,
  base: Y.XmlFragment,
  keys: { live?: string[]; target?: string[]; base?: string[] } = {},
): Merge3WayResult {
  const liveKids = live.toArray();
  const targetKids = target.toArray();
  const baseKids = base.toArray();
  const liveKeys = keysFor(liveKids, keys.live, 'live');
  const targetKeys = keysFor(targetKids, keys.target, 'target');
  const baseKeys = keysFor(baseKids, keys.base, 'base');

  const { picks, conflicts } = diff3PlanWithConflicts(
    baseKeys,
    liveKeys,
    targetKeys,
    isIgnorableBlockKey,
  );
  const steps = planSteps(picks, liveKids, baseKids, targetKids);

  const applied = inTransaction(live, () => {
    let cursor = 0; // index into the LIVE fragment as we mutate it
    let li = 0; // next not-yet-visited block of the original live sequence
    let ops = 0;
    // Live blocks the plan does not keep are deleted as the walk passes them.
    const dropUntil = (end: number): void => {
      while (li < end) {
        live.delete(cursor, 1);
        li++;
        ops++;
      }
    };
    for (const step of steps) {
      if (step.kind === 'insert') {
        live.insert(cursor, [cloneXmlNode(targetKids[step.target] as XmlNode)]);
        cursor++;
        ops++;
        continue;
      }
      dropUntil(step.live);
      if (step.kind === 'update') {
        updateYFragment(
          live.doc,
          liveKids[step.live] as Y.XmlElement,
          step.node,
          { mapping: new Map(), isOMark: new Map() } as any,
        );
        ops++;
      }
      cursor++;
      li++;
    }
    dropUntil(liveKids.length);
    return ops;
  });

  return { applied, conflicts };
}
