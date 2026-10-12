import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Mention } from "@docmost/editor-ext";
import {
  LINK_CLICK_EVENT,
  type LinkClickDetail,
} from "./link-click-event";

// `mainExtensions` reaches the app entry through its node views, whose module
// scope mounts the app on a #root that jsdom does not have; only the
// `queryClient` export is needed (same stub as extensions.code-yjs-key.test.ts).
vi.mock("@/main.tsx", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient() };
});

import { mainExtensions } from "@/features/editor/extensions/extensions";

// Test-environment artifact: here `@docmost/editor-ext` resolves to its
// CommonJS build, which loads its own copy of prosemirror-state, so its
// unnamed plugins and the ESM ones draw keys from two counters — and the FIRST
// unnamed plugin of each copy is "plugin$", which ProseMirror rejects as a
// duplicate key. Taking the ESM copy's first key up front keeps the two
// sequences apart (the ESM side creates many more unnamed plugins per editor).
new Plugin({});

// The link mark exactly as the page editor configures it: the real
// LinkExtension with the click plugin and the client's renderHTML.
const ClientLink = mainExtensions.find((ext: any) => ext.name === "link");

// A mention like the page editor's: an atom node view whose DOM holds its own
// <a> (MentionView renders a router Link), outside any link mark.
const AnchorMention = Mention.extend({
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("span");
      const anchor = document.createElement("a");
      anchor.setAttribute("href", "/s/eng/p/mentioned-m1");
      anchor.textContent = node.attrs.label;
      dom.appendChild(anchor);
      return { dom };
    };
  },
});

const editors: Editor[] = [];

function makeEditor(): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [Document, Paragraph, Text, ClientLink, AnchorMention],
    content: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "internal",
              marks: [
                {
                  type: "link",
                  attrs: { href: "/s/eng/p/target-abc1", internal: true },
                },
              ],
            },
            { type: "text", text: " and " },
            {
              type: "mention",
              attrs: {
                id: "m-1",
                label: "Mentioned",
                entityType: "page",
                entityId: "page-1",
                slugId: "m1",
              },
            },
          ],
        },
      ],
    },
  });
  editors.push(editor);
  return editor;
}

function anchorWithText(editor: Editor, text: string): HTMLAnchorElement {
  const anchor = Array.from(editor.view.dom.querySelectorAll("a")).find(
    (a) => a.textContent === text,
  );
  if (!anchor) throw new Error(`no <a> with text ${text}`);
  return anchor;
}

// Clicks `target` and returns whether the editor default-prevented the click
// plus the link events that reached the document.
function click(target: Element): {
  prevented: boolean;
  events: LinkClickDetail[];
} {
  const events: LinkClickDetail[] = [];
  let prevented = false;
  const onLink = (e: Event) =>
    events.push((e as CustomEvent<LinkClickDetail>).detail);
  // Runs after the editor's own handler (the click bubbles from view.dom):
  // record the editor's verdict, then cancel the click so jsdom does not try
  // to follow the anchor.
  const onClick = (e: Event) => {
    prevented = e.defaultPrevented;
    e.preventDefault();
  };
  document.addEventListener(LINK_CLICK_EVENT, onLink);
  document.addEventListener("click", onClick);
  try {
    target.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    return { prevented, events };
  } finally {
    document.removeEventListener(LINK_CLICK_EVENT, onLink);
    document.removeEventListener("click", onClick);
  }
}

afterEach(() => {
  for (const editor of editors.splice(0)) {
    const element = editor.view.dom.parentElement;
    editor.destroy();
    element?.remove();
  }
  vi.restoreAllMocks();
});

describe("link click plugin (real Editor, client link extension)", () => {
  it("a click on a link mark's <a> dispatches one link event with its href/internal and prevents the default", () => {
    const editor = makeEditor();
    const anchor = anchorWithText(editor, "internal");

    const { prevented, events } = click(anchor);

    expect(prevented).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].href).toBe("/s/eng/p/target-abc1");
    expect(events[0].internal).toBe(true);
    expect(events[0].anchor).toBe(anchor);
    expect(events[0].editor).toBe(editor);
  });

  it("a click on a mention's own <a> dispatches nothing and leaves the default alone", () => {
    const editor = makeEditor();
    const anchor = anchorWithText(editor, "Mentioned");

    const { prevented, events } = click(anchor);

    expect(events).toHaveLength(0);
    expect(prevented).toBe(false);
  });

  it("a posAtDOM failure is not a link click: nothing is dispatched or prevented", () => {
    const editor = makeEditor();
    const anchor = anchorWithText(editor, "internal");
    vi.spyOn(editor.view, "posAtDOM").mockImplementation(() => {
      throw new Error("detached DOM");
    });

    const { prevented, events } = click(anchor);

    expect(events).toHaveLength(0);
    expect(prevented).toBe(false);
  });
});
