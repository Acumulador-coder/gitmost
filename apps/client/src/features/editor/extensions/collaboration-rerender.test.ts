import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { StarterKit } from "@tiptap/starter-kit";
import { ProsemirrorBinding, ySyncPluginKey } from "@tiptap/y-tiptap";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

// `extensions.ts` reaches the app entry through its node views, whose module
// scope mounts the app on a #root that jsdom does not have; only the
// `queryClient` export is needed (same stub as extensions.code-yjs-key.test.ts).
vi.mock("@/main.tsx", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient() };
});

import { collabExtensions } from "./extensions";

/**
 * Tripwire for CollaborationWithoutRerenderOnReconfigure, which relies on a
 * y-tiptap internal: the ySync plugin view rebuilds the whole doc through
 * `binding._forceRerender()` whenever it is created, and ProseMirror re-creates
 * every plugin view on each registerPlugin / unregisterPlugin. The override
 * keeps that rebuild for the FIRST view creation only. If a y-tiptap upgrade
 * renames the method or stops calling it, these assertions fail instead of
 * the override silently doing nothing.
 */

const editors: Editor[] = [];

function makeCollabEditor(): Editor {
  const ydoc = new Y.Doc();
  const provider = { document: ydoc, awareness: new Awareness(ydoc) };
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [
      StarterKit.configure({ undoRedo: false }),
      ...collabExtensions(provider as any, { name: "Tester" } as any),
    ],
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  vi.restoreAllMocks();
});

describe("y-tiptap tripwire: the doc is rebuilt only on the first view creation", () => {
  it("the ySync binding still has a _forceRerender method", () => {
    const editor = makeCollabEditor();
    const binding = ySyncPluginKey.getState(editor.state)?.binding;

    expect(binding).toBeInstanceOf(ProsemirrorBinding);
    expect(typeof binding._forceRerender).toBe("function");
  });

  it("the first view creation calls _forceRerender; later registerPlugin / unregisterPlugin do not", () => {
    const forceRerender = vi.spyOn(
      ProsemirrorBinding.prototype,
      "_forceRerender",
    );
    const editor = makeCollabEditor();
    expect(forceRerender).toHaveBeenCalledTimes(1);

    const key = new PluginKey("tripwireReconfigure");
    editor.registerPlugin(new Plugin({ key }));
    editor.unregisterPlugin(key);
    editor.registerPlugin(new Plugin({ key }));

    expect(forceRerender).toHaveBeenCalledTimes(1);
    // The swap is undone after each re-creation: the binding keeps its method.
    const binding = ySyncPluginKey.getState(editor.state)?.binding;
    expect(typeof binding._forceRerender).toBe("function");
  });
});
