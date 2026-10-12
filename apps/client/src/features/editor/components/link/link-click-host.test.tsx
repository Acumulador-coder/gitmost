import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";

// The page queries import `queryClient` from the app entry, whose module scope
// mounts the app on a #root that jsdom does not have.
vi.mock("@/main.tsx", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return { queryClient: new QueryClient() };
});

import LinkClickHost from "./link-click-host";
import { LINK_CLICK_EVENT, type LinkClickDetail } from "./link-click-event";

/**
 * The single app-wide host every editor's link clicks go to: the link click
 * plugin prevents the browser default on EVERY link click, so a broken host
 * leaves every link in the app dead. Driven here through the real event, under
 * a real router.
 */

let current: { pathname: string; hash: string };
let navigateTo: (to: string) => void;

// Reads the router state the host navigates, and lets a test navigate.
function RouterProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    current = { pathname: location.pathname, hash: location.hash };
    navigateTo = navigate;
  });
  return null;
}

function renderHost(initialPath: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <MantineProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <LinkClickHost />
          <RouterProbe />
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>,
  );
}

function fakeEditor(isEditable: boolean): LinkClickDetail["editor"] {
  return {
    isEditable,
    view: { posAtDOM: () => 1 },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as LinkClickDetail["editor"];
}

function clickLink(opts: {
  href: string;
  internal?: boolean;
  editable?: boolean;
}): void {
  const anchor = document.createElement("a");
  anchor.textContent = "the link";
  document.body.appendChild(anchor);
  const detail: LinkClickDetail = {
    editor: fakeEditor(opts.editable ?? false),
    anchor,
    href: opts.href,
    internal: opts.internal ?? false,
  };
  act(() => {
    document.dispatchEvent(new CustomEvent(LINK_CLICK_EVENT, { detail }));
  });
}

let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // jsdom implements no scrolling.
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView =
    scrollIntoView as unknown as Element["scrollIntoView"];
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("LinkClickHost — read-only editors navigate", () => {
  it("an internal link in the app navigates within the app", () => {
    renderHost("/s/eng/p/a-1");
    clickLink({ href: "/s/eng/p/other-xyz", internal: true });
    expect(current.pathname).toBe("/s/eng/p/other-xyz");
  });

  it("an internal link on a public share navigates to the shared copy", () => {
    renderHost("/share/sh1/p/x-1");
    clickLink({ href: "/s/eng/p/other-xyz", internal: true });
    expect(current.pathname).toBe("/share/sh1/p/untitled-xyz");
  });

  it("an #anchor on the current page scrolls to it without leaving the page", () => {
    renderHost("/s/eng/p/a-1");
    const heading = document.createElement("h2");
    heading.id = "sec";
    document.body.appendChild(heading);

    clickLink({ href: "/s/eng/p/a-1#sec", internal: true });

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(heading);
    expect(current.pathname).toBe("/s/eng/p/a-1");
    expect(current.hash).toBe("#sec");
  });

  it("an external link opens a new window without opener or referrer", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderHost("/s/eng/p/a-1");

    clickLink({ href: "www.example.com" });

    expect(open).toHaveBeenCalledWith(
      "https://www.example.com/",
      "_blank",
      "noopener,noreferrer",
    );
    expect(current.pathname).toBe("/s/eng/p/a-1");
  });
});

describe("LinkClickHost — editable editors open the popover", () => {
  it("a click opens the link popover instead of navigating, and a route change closes it", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    renderHost("/s/eng/p/a-1");

    clickLink({ href: "https://example.com/docs", editable: true });

    expect(screen.getByText("https://example.com/docs")).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
    expect(current.pathname).toBe("/s/eng/p/a-1");

    act(() => navigateTo("/s/eng/p/b-2"));

    expect(screen.queryByText("https://example.com/docs")).toBeNull();
  });
});
