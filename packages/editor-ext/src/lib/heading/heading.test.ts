import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { joinBackward, setBlockType, splitBlock } from "@tiptap/pm/commands";
import type { Command, Plugin } from "@tiptap/pm/state";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { DecorationSet } from "@tiptap/pm/view";
import { UniqueID } from "../unique-id";
import { Heading } from "./heading";

// The Heading extension keeps its copy-link widgets in PLUGIN STATE and updates
// them incrementally: `apply` maps the previous set and rebuilds only the
// headings a transaction's changed ranges touch (a doc-neutral transaction
// reuses the set as-is). The invariant pinned here: after EVERY transaction the
// incremental set is equivalent to what `init` builds from scratch for the
// resulting doc — one widget per heading with content.size > 1, at the end of
// its content, keyed `heading-link-<id>`. Transactions go through the real
// EditorState (so UniqueID's appendTransaction re-ids split nodes as it does in
// the editor).

const editors: Editor[] = [];
afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

type Widget = { from: number; key: string };

const normalize = (set: DecorationSet): Widget[] =>
  set
    .find()
    .map((d) => ({ from: d.from, key: (d as any).spec.key as string }))
    .sort((a, b) => a.from - b.from || a.key.localeCompare(b.key));

const h = (id: string, text: string, level = 1) => ({
  type: "heading",
  attrs: { id, level },
  content: text ? [{ type: "text", text }] : [],
});
const p = (id: string, text: string) => ({
  type: "paragraph",
  attrs: { id },
  content: text ? [{ type: "text", text }] : [],
});

function setup(content: any[]) {
  const editor = new Editor({
    extensions: [
      Document,
      Paragraph,
      Text,
      Heading,
      UniqueID.configure({ types: ["heading", "paragraph"] }),
    ],
    content: { type: "doc", content },
  });
  editors.push(editor);
  let state = editor.state;
  // The Heading plugin has no key: it is the one plugin whose state is a DecorationSet.
  const candidates = state.plugins.filter(
    (pl) => pl.getState(state) instanceof DecorationSet,
  );
  expect(candidates).toHaveLength(1);
  const plugin: Plugin<DecorationSet> = candidates[0];

  const widgets = () => normalize(plugin.getState(state)!);
  const fresh = (s: EditorState) =>
    normalize(plugin.spec.state!.init({} as any, s));
  const expectInSync = () => expect(widgets()).toEqual(fresh(state));

  const ctx = {
    get state() {
      return state;
    },
    plugin,
    widgets,
    keys: () => widgets().map((w) => w.key),
    // Applies a transaction and checks the invariant right away.
    dispatch(tr: any) {
      state = state.apply(tr);
      expectInSync();
    },
    // Runs a ProseMirror command with the cursor at `cursor`.
    run(cmd: Command, cursor: number) {
      state = state.apply(
        state.tr.setSelection(TextSelection.create(state.doc, cursor)),
      );
      expect(cmd(state, (tr) => ctx.dispatch(tr))).toBe(true);
    },
    // Start of the block with this id (its content starts at pos + 1).
    posOf(id: string) {
      let found = -1;
      state.doc.descendants((node, pos) => {
        if (node.attrs.id === id) found = pos;
        return found < 0;
      });
      expect(found).toBeGreaterThanOrEqual(0);
      return found;
    },
  };
  expectInSync();
  return ctx;
}

const doc4 = () => [
  h("h1", "Alpha"),
  p("p1", "body"),
  h("h2", "Beta", 2),
  p("p2", "tail"),
];

describe("Heading link widgets: incremental plugin state == fresh build", () => {
  it("starts with one widget per heading at the end of its content", () => {
    const ctx = setup(doc4());
    expect(ctx.widgets()).toEqual([
      { from: 6, key: "heading-link-h1" },
      { from: 18, key: "heading-link-h2" },
    ]);
  });

  it("(1) typing characters inside a heading (start, middle, end)", () => {
    const ctx = setup(doc4());
    const start = ctx.posOf("h1") + 1;
    ctx.dispatch(ctx.state.tr.insertText("X", start));
    ctx.dispatch(ctx.state.tr.insertText("Y", start + 3));
    const end = ctx.posOf("h1") + ctx.state.doc.child(0).nodeSize - 1;
    ctx.dispatch(ctx.state.tr.insertText("Z", end)); // right at the widget
    expect(ctx.state.doc.child(0).textContent).toBe("XAlYphaZ");
    ctx.dispatch(ctx.state.tr.insertText("!", ctx.posOf("h2") + 2));
  });

  it("(2) Enter splits a heading in the middle and at its end", () => {
    const ctx = setup(doc4());
    ctx.run(splitBlock, ctx.posOf("h1") + 3); // "Al" | "pha"
    expect(ctx.state.doc.child(1).type.name).toBe("heading");
    expect(new Set(ctx.keys()).size).toBe(3); // UniqueID re-ided the tail

    const h2 = ctx.posOf("h2");
    ctx.run(splitBlock, h2 + ctx.state.doc.nodeAt(h2)!.nodeSize - 1);
  });

  it("(3) Backspace joins a paragraph into a heading, and a heading into a paragraph", () => {
    const ctx = setup(doc4());
    // Heading after a paragraph: its text merges into the paragraph, so the
    // block carrying its widget position is no longer a heading.
    ctx.run(joinBackward, ctx.posOf("h2") + 1);
    expect(ctx.state.doc.child(1).textContent).toBe("bodyBeta");
    expect(ctx.keys()).toEqual(["heading-link-h1"]);

    // Paragraph after a heading: the heading grows, its widget moves to the end.
    ctx.run(joinBackward, ctx.posOf("p1") + 1);
    expect(ctx.state.doc.child(0).type.name).toBe("heading");
    expect(ctx.state.doc.child(0).textContent).toBe("AlphabodyBeta");
  });

  it("(4) converts heading -> paragraph and paragraph -> heading", () => {
    const ctx = setup(doc4());
    ctx.run(setBlockType(ctx.state.schema.nodes.paragraph), ctx.posOf("h1") + 2);
    expect(ctx.keys()).toEqual(["heading-link-h2"]);

    ctx.run(
      setBlockType(ctx.state.schema.nodes.heading, { level: 3 }),
      ctx.posOf("p2") + 2,
    );
    expect(ctx.widgets()).toHaveLength(2);
  });

  it("(5) a heading shortened to <= 1 character loses its widget and gets it back", () => {
    const ctx = setup(doc4());
    const lastChar = () => {
      const pos = ctx.posOf("h2");
      return pos + ctx.state.doc.nodeAt(pos)!.nodeSize - 1;
    };
    for (const expected of ["Bet", "Be"]) {
      ctx.dispatch(ctx.state.tr.delete(lastChar() - 1, lastChar()));
      expect(ctx.state.doc.nodeAt(ctx.posOf("h2"))!.textContent).toBe(expected);
      expect(ctx.keys()).toContain("heading-link-h2");
    }
    ctx.dispatch(ctx.state.tr.delete(lastChar() - 1, lastChar())); // "B"
    expect(ctx.keys()).not.toContain("heading-link-h2");
    ctx.dispatch(ctx.state.tr.delete(lastChar() - 1, lastChar())); // ""
    expect(ctx.keys()).not.toContain("heading-link-h2");

    ctx.dispatch(ctx.state.tr.insertText("B", lastChar()));
    expect(ctx.keys()).not.toContain("heading-link-h2");
    ctx.dispatch(ctx.state.tr.insertText("e", lastChar()));
    expect(ctx.keys()).toContain("heading-link-h2");
  });

  it("(6) a multi-step transaction across two headings", () => {
    const ctx = setup(doc4());
    const tr = ctx.state.tr;
    const h1 = ctx.posOf("h1");
    const h2 = ctx.posOf("h2");
    tr.insertText("!!", h2 + 5); // end of "Beta"
    tr.delete(h1 + 1, h1 + 3); // "Alpha" -> "pha"
    tr.insertText("Z", tr.mapping.map(h2 + 1)); // "ZBeta!!"
    // A cross-block delete: from inside h1 to inside p1, merging p1 into h1.
    tr.delete(h1 + 2, tr.mapping.map(ctx.posOf("p1") + 3));
    expect(tr.steps.length).toBe(4);

    ctx.dispatch(tr);
    expect(ctx.state.doc.child(0).textContent).toBe("pdy");
    expect(ctx.state.doc.child(1).textContent).toBe("ZBeta!!");
    expect(ctx.keys()).toEqual(["heading-link-h1", "heading-link-h2"]);
  });

  it("(7) a selection-only transaction returns the identical set", () => {
    const ctx = setup(doc4());
    const before = ctx.plugin.getState(ctx.state);
    const next = ctx.state.apply(
      ctx.state.tr
        .setSelection(TextSelection.create(ctx.state.doc, ctx.posOf("h2") + 2))
        .setMeta("anything", true),
    );
    expect(ctx.plugin.getState(next)).toBe(before);
  });

  it("(8) a heading id change via setNodeMarkup re-keys its widget", () => {
    const ctx = setup(doc4());
    const pos = ctx.posOf("h1");
    const node = ctx.state.doc.nodeAt(pos)!;
    ctx.dispatch(
      ctx.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: "renamed" }),
    );
    expect(ctx.keys()).toEqual(["heading-link-renamed", "heading-link-h2"]);
  });

  // KNOWN BUG (not fixed here): an AttrStep (tr.setNodeAttribute) has an EMPTY
  // StepMap, so `changedRanges()` yields nothing and `apply` keeps the widget
  // keyed with the OLD id — whose toDOM closure also copies a link to the old
  // id. Nothing in the editor issues AttrSteps on headings today (tiptap's
  // updateAttributes and UniqueID use setNodeMarkup), so it is latent.
  it.fails("a heading id change via setNodeAttribute (AttrStep) re-keys its widget", () => {
    const ctx = setup(doc4());
    ctx.dispatch(ctx.state.tr.setNodeAttribute(ctx.posOf("h1"), "id", "renamed"));
    expect(ctx.keys()).toContain("heading-link-renamed");
  });
});
