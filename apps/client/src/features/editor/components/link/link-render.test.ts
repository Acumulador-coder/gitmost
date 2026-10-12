import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";

// `mainExtensions` reaches the app entry through its node views, whose module
// scope mounts the app on a #root that jsdom does not have; only the
// `queryClient` export is needed (same stub as extensions.code-yjs-key.test.ts).
vi.mock("@/main.tsx", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient() };
});

import { mainExtensions } from "@/features/editor/extensions/extensions";

// Test-environment artifact (see link-click-plugin.test.ts): the CommonJS
// editor-ext build and the ESM code draw unnamed plugin keys from two
// prosemirror-state copies, both starting at "plugin$".
new Plugin({});

// The link mark exactly as the page editor configures it.
const ClientLink = mainExtensions.find((ext: any) => ext.name === "link");

/**
 * Links render as plain <a> through the link mark's renderHTML. The DOM href is
 * what middle-click, "open in new tab" and "copy link address" use, so it must
 * be the address the UI points at: on a public share an internal link goes to
 * the shared copy (an anonymous visitor cannot open the private app URL) and a
 * schemeless external link is normalized. And only attributes the client
 * computes reach the DOM — a document-supplied class (e.g. Mantine's
 * `position: fixed; inset: 0` overlay class) would turn the link into a
 * full-screen click trap.
 */

type LinkAttrs = Record<string, unknown>;

const editors: Editor[] = [];

function renderLinks(
  pathname: string,
  links: LinkAttrs[],
  editable: boolean,
): HTMLAnchorElement[] {
  window.history.pushState({}, "", pathname);
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    editable,
    extensions: [Document, Paragraph, Text, ClientLink],
    content: {
      type: "doc",
      content: links.map((attrs, i) => ({
        type: "paragraph",
        content: [
          {
            type: "text",
            text: `link ${i}`,
            marks: [{ type: "link", attrs }],
          },
        ],
      })),
    },
  });
  editors.push(editor);
  return Array.from(editor.view.dom.querySelectorAll("a"));
}

afterEach(() => {
  for (const editor of editors.splice(0)) {
    const element = editor.view.dom.parentElement;
    editor.destroy();
    element?.remove();
  }
  window.history.pushState({}, "", "/");
});

const INTERNAL = { href: "/s/eng/p/target-abc1", internal: true };
const SCHEMELESS = { href: "www.example.com" };

describe("link mark DOM on a public share route", () => {
  it.each([true, false])(
    "an internal link points at the shared copy of the page (editable=%s)",
    (editable) => {
      const [a] = renderLinks("/share/sh1/p/x-1", [INTERNAL], editable);
      expect(a.getAttribute("href")).toBe("/share/sh1/p/untitled-abc1");
      expect(a.getAttribute("data-internal")).toBe("true");
      expect(a.hasAttribute("target")).toBe(false);
      expect(a.hasAttribute("rel")).toBe(false);
    },
  );

  it("a share without its id in the URL maps to the id-less share route", () => {
    const [a] = renderLinks("/share/p/x-1", [INTERNAL], false);
    expect(a.getAttribute("href")).toBe("/share/p/untitled-abc1");
  });

  it("a schemeless external link is normalized, not left relative", () => {
    const [a] = renderLinks("/share/sh1/p/x-1", [SCHEMELESS], false);
    expect(a.getAttribute("href")).toBe("https://www.example.com/");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow");
  });
});

describe("link mark DOM in the app", () => {
  it.each([true, false])(
    "an internal link keeps its app href and an external one is normalized (editable=%s)",
    (editable) => {
      const [internal, external] = renderLinks(
        "/s/eng/p/a-1",
        [INTERNAL, SCHEMELESS],
        editable,
      );
      expect(internal.getAttribute("href")).toBe("/s/eng/p/target-abc1");
      expect(external.getAttribute("href")).toBe("https://www.example.com/");
    },
  );

  it("a script URL is not rendered as a navigable href", () => {
    const [a] = renderLinks(
      "/s/eng/p/a-1",
      [{ href: "javascript:alert(document.cookie)" }],
      false,
    );
    expect(a.getAttribute("href")).toBe("");
  });
});

describe("link mark DOM ignores document-supplied attributes", () => {
  const TRAP = {
    href: "https://attacker.example/phish",
    class: "m_3d7bc908",
    rel: "opener",
    target: "_self",
    title: "Read the docs",
  };

  it.each([
    ["/share/sh1/p/x-1", false],
    ["/s/eng/p/a-1", true],
    ["/s/eng/p/a-1", false],
  ])(
    "on %s (editable=%s): no class, safe rel/target, title kept as text",
    (pathname, editable) => {
      const [a] = renderLinks(pathname as string, [TRAP], editable as boolean);
      expect(a.hasAttribute("class")).toBe(false);
      expect(a.getAttribute("rel")).toBe("noopener noreferrer nofollow");
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("title")).toBe("Read the docs");
      expect(a.getAttribute("href")).toBe("https://attacker.example/phish");
    },
  );
});
