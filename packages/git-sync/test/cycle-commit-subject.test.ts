import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupVaults,
  git,
  gitAvailable,
  setupVault,
  ts,
  type FakePage,
} from "./cycle-realgit-helpers";

// The subject of the commit an export puts on `main` names what changed in the
// wiki, counted on the commit itself: a full pass that re-reads every page (after
// a restart the export keys are gone) still names only the pages that changed.

const A = "019f2a00-0000-7000-8000-00000000000a";
const B = "019f2a00-0000-7000-8000-00000000000b";
const C = "019f2a00-0000-7000-8000-00000000000c";
const D = "019f2a00-0000-7000-8000-00000000000d";
const T0 = "2026-10-01T00:00:00.000Z";

const page = (id: string, title: string): FakePage => ({
  id,
  slugId: title.toLowerCase(),
  title,
  parentPageId: null,
  updatedAt: T0,
  text: `${title} body`,
});

describe("runCycle — the export commit's subject", () => {
  let available = false;

  beforeAll(async () => {
    available = await gitAvailable();
  });

  afterEach(cleanupVaults);

  it("names the edited and deleted pages, not every page the export read", async () => {
    if (!available) return;
    const h = await setupVault([page(A, "A"), page(B, "B"), page(C, "C"), page(D, "D")]);
    const subject = () => git(h.root, "log", "-1", "--format=%s", "main");
    const edit = (id: string) => {
      const p = h.pages.find((x) => x.id === id)!;
      p.text = `${p.text} edited`;
      p.updatedAt = ts();
    };
    const remove = (id: string) => h.pages.splice(h.pages.findIndex((x) => x.id === id), 1);

    expect(await subject()).toBe("docmost: edit 4 page(s)");

    // A restart loses the export keys: the cycle reads all four pages.
    h.exportKeys.clear();
    edit(A);
    await h.cycle();
    expect(await subject()).toBe("docmost: edit 1 page(s)");

    remove(B);
    await h.cycle();
    expect(await subject()).toBe("docmost: delete 1 page(s)");

    edit(C);
    remove(D);
    await h.cycle();
    expect(await subject()).toBe("docmost: edit 1 page(s), delete 1 page(s)");
  });
});
