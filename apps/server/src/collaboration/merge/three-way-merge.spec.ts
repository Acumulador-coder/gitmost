import { diff3PlanWithConflicts, type Pick } from './three-way-merge';
import {
  createDiffBudget,
  MERGE_DIFF_WORK_BUDGET,
  MergeBudgetExceededError,
} from './lcs';

// Materialize a plan into the merged key sequence for assertion.
function apply(plan: Pick[], live: string[], target: string[]): string[] {
  return plan.map((p) => (p.src === 'live' ? live[p.index] : target[p.index]));
}

const merge = (o: string[], a: string[], b: string[]): string[] =>
  apply(diff3PlanWithConflicts(o, a, b).picks, a, b);

describe('diff3PlanWithConflicts (block-level three-way merge)', () => {
  it('identical on all three sides -> unchanged (all from live)', () => {
    const plan = diff3PlanWithConflicts(
      ['1', '2', '3'],
      ['1', '2', '3'],
      ['1', '2', '3'],
    ).picks;
    expect(plan.every((p) => p.src === 'live')).toBe(true);
    expect(apply(plan, ['1', '2', '3'], ['1', '2', '3'])).toEqual(['1', '2', '3']);
  });

  it('git changed a block the human did not -> takes git', () => {
    expect(merge(['1', '2', '3'], ['1', '2', '3'], ['1', '9', '3'])).toEqual([
      '1',
      '9',
      '3',
    ]);
  });

  it('human changed a block git did not -> KEEPS the human edit (the core 3-way win)', () => {
    expect(merge(['1', '2', '3'], ['1', 'H', '3'], ['1', '2', '3'])).toEqual([
      '1',
      'H',
      '3',
    ]);
  });

  // Bug #2 observability: diff3PlanWithConflicts reports SAME-BLOCK conflicts so
  // the caller can surface the "git wins" loss (log + history pin) instead of
  // dropping the human side silently.
  describe('diff3PlanWithConflicts (same-block conflict reporting)', () => {
    it('reports 0 conflicts when sides changed DIFFERENT blocks (clean merge)', () => {
      const r = diff3PlanWithConflicts(
        ['1', '2', '3'],
        ['H', '2', '3'],
        ['1', '2', 'G'],
      );
      expect(r.conflicts).toBe(0);
      expect(apply(r.picks, ['H', '2', '3'], ['1', '2', 'G'])).toEqual([
        'H',
        '2',
        'G',
      ]);
    });

    it('reports 1 conflict and git wins when BOTH rewrote the SAME block', () => {
      const r = diff3PlanWithConflicts(
        ['1', '2', '3'],
        ['1', 'H', '3'], // human rewrote block 2
        ['1', 'G', '3'], // git rewrote block 2
      );
      expect(r.conflicts).toBe(1);
      // Git wins the contested block; the human 'H' is NOT in the picks.
      expect(apply(r.picks, ['1', 'H', '3'], ['1', 'G', '3'])).toEqual([
        '1',
        'G',
        '3',
      ]);
    });

    it('does NOT count a git-only region (no human content to lose) as a conflict', () => {
      const r = diff3PlanWithConflicts(
        ['1', '2', '3'],
        ['1', '2', '3'], // human unchanged
        ['1', '9', '3'], // git rewrote block 2
      );
      expect(r.conflicts).toBe(0);
    });
  });

  it('human and git changed DIFFERENT blocks -> both preserved', () => {
    // human rewrote block 1, git rewrote block 3.
    expect(merge(['1', '2', '3'], ['H', '2', '3'], ['1', '2', 'G'])).toEqual([
      'H',
      '2',
      'G',
    ]);
  });

  it('human inserted a block AND git changed a different block -> both preserved', () => {
    expect(
      merge(['1', '2', '3'], ['1', '1.5', '2', '3'], ['1', '2', 'G']),
    ).toEqual(['1', '1.5', '2', 'G']);
  });

  it('both changed the SAME block -> conflict resolves to git', () => {
    expect(merge(['1', '2', '3'], ['1', 'H', '3'], ['1', 'G', '3'])).toEqual([
      '1',
      'G',
      '3',
    ]);
  });

  it('both made the SAME edit -> that edit (no duplication)', () => {
    expect(merge(['1', '2', '3'], ['1', 'X', '3'], ['1', 'X', '3'])).toEqual([
      '1',
      'X',
      '3',
    ]);
  });

  it('human deleted a block git left alone -> deletion preserved', () => {
    expect(merge(['1', '2', '3'], ['1', '3'], ['1', '2', '3'])).toEqual([
      '1',
      '3',
    ]);
  });

  it('git deleted a block the human left alone -> deletion applied', () => {
    expect(merge(['1', '2', '3'], ['1', '2', '3'], ['1', '3'])).toEqual([
      '1',
      '3',
    ]);
  });

  it('both deleted the same block -> gone (no conflict)', () => {
    expect(merge(['1', '2', '3'], ['1', '3'], ['1', '3'])).toEqual(['1', '3']);
  });

  it('git appended a trailing block -> appended', () => {
    expect(merge(['1', '2'], ['1', '2'], ['1', '2', '3'])).toEqual([
      '1',
      '2',
      '3',
    ]);
  });

  it('human appended a trailing block git did not -> kept', () => {
    expect(merge(['1', '2'], ['1', '2', '3'], ['1', '2'])).toEqual([
      '1',
      '2',
      '3',
    ]);
  });

  it('empty base, git provides content (brand-new page body) -> git content', () => {
    expect(merge([], [], ['1', '2'])).toEqual(['1', '2']);
  });

  it('git changed block 1, human edited block 3, far apart -> both kept', () => {
    expect(
      merge(
        ['a', 'b', 'c', 'd', 'e'],
        ['a', 'b', 'c', 'd', 'E'],
        ['A', 'b', 'c', 'd', 'e'],
      ),
    ).toEqual(['A', 'b', 'c', 'd', 'E']);
  });
});

// GL-1 — both sides inserted at the same gap: both inserts survive.
describe('diff3PlanWithConflicts: concurrent inserts at one gap (GL-1)', () => {
  it('keeps both, live first then git, with no conflict', () => {
    const r = diff3PlanWithConflicts(
      ['A', 'B', 'E'],
      ['A', 'B', 'H', 'E'],
      ['A', 'B', 'C', 'E'],
    );
    expect(r.conflicts).toBe(0);
    expect(apply(r.picks, ['A', 'B', 'H', 'E'], ['A', 'B', 'C', 'E'])).toEqual(
      ['A', 'B', 'H', 'C', 'E'],
    );
  });

  it('a block both sides inserted appears once', () => {
    expect(
      merge(['A', 'B'], ['A', 'X', 'Y', 'B'], ['A', 'Y', 'Z', 'B']),
    ).toEqual(['A', 'X', 'Y', 'Z', 'B']);
  });
});

// Ignorable (empty-projection) live blocks against git changes.
describe('diff3PlanWithConflicts with isIgnorable', () => {
  const isIgnorable = (key: string) => key === '';

  it('an ignorable-only live insert at the git insertion point: 0 conflicts, both kept', () => {
    const live = ['A', '', 'B'];
    const target = ['A', 'G', 'B'];
    const r = diff3PlanWithConflicts(['A', 'B'], live, target, isIgnorable);
    expect(r.conflicts).toBe(0);
    expect(apply(r.picks, live, target)).toEqual(['A', '', 'G', 'B']);
  });

  it('an ignorable-only live insert inside a git rewrite is dropped: 0 conflicts', () => {
    const live = ['A', 'B', '', 'C', 'D'];
    const target = ['A', 'X', 'D'];
    const r = diff3PlanWithConflicts(
      ['A', 'B', 'C', 'D'],
      live,
      target,
      isIgnorable,
    );
    expect(r.conflicts).toBe(0);
    expect(apply(r.picks, live, target)).toEqual(['A', 'X', 'D']);
  });

  it('an ignorable-only live insert away from git changes is kept', () => {
    const live = ['A', '', 'B', 'C'];
    const target = ['A', 'B', 'X'];
    const r = diff3PlanWithConflicts(['A', 'B', 'C'], live, target, isIgnorable);
    expect(r.conflicts).toBe(0);
    expect(apply(r.picks, live, target)).toEqual(['A', '', 'B', 'X']);
  });

  it('a live hunk mixing an ignorable block with a real edit is still a conflict', () => {
    const live = ['A', '', 'B2'];
    const target = ['A', 'B3'];
    const r = diff3PlanWithConflicts(['A', 'B'], live, target, isIgnorable);
    expect(r.conflicts).toBe(1);
    expect(apply(r.picks, live, target)).toEqual(['A', 'B3']);
  });
});

// GL-2 — the alignment cost is bounded by the size of the change, not the page.
describe('diff3PlanWithConflicts work budget (GL-2)', () => {
  const page = (n: number, prefix = 'block') =>
    Array.from({ length: n }, (_, i) => `${prefix} ${i}`);

  it('one changed block on a 10k-block page: a replace pick, near-zero alignment work', () => {
    const base = page(10_000);
    const target = base.slice();
    target[5_000] = 'changed';
    const budget = createDiffBudget();
    const r = diff3PlanWithConflicts(base, base, target, undefined, budget);

    expect(r.conflicts).toBe(0);
    const fromGit = r.picks.filter((p) => p.src === 'target');
    expect(fromGit).toEqual([
      { src: 'target', index: 5_000, replaces: { base: 5_000, live: 5_000 } },
    ]);
    expect(r.picks).toHaveLength(10_000);
    expect(MERGE_DIFF_WORK_BUDGET - budget.remaining).toBeLessThan(100);
  });

  it('a full rewrite of a 5k-block page aligns without spending the budget', () => {
    const base = page(5_000);
    const target = page(5_000, 'rewritten');
    const budget = createDiffBudget();
    const r = diff3PlanWithConflicts(base, base, target, undefined, budget);
    expect(apply(r.picks, base, target)).toEqual(target);
    expect(MERGE_DIFF_WORK_BUDGET - budget.remaining).toBeLessThan(100);
  });

  it('an alignment over the budget is refused with a specific error, before any plan', () => {
    const base = page(5_000);
    const target = base.slice().reverse();
    expect(() => diff3PlanWithConflicts(base, base, target)).toThrow(
      MergeBudgetExceededError,
    );
    expect(() => diff3PlanWithConflicts(base, base, target)).toThrow(
      /block diff of 5000 vs 5000 blocks exceeds the remaining merge work budget/,
    );
  });
});
