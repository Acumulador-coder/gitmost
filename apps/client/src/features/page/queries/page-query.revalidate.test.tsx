import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { IPage, IPageInput } from "@/features/page/types/page.types";

// The app singleton, built with the SAME global query defaults as main.tsx
// (importing the real @/main.tsx would run ReactDOM.createRoot, which has no
// DOM root in jsdom). Those defaults — refetchOnMount:false + staleTime 5 min —
// are exactly what usePageQuery must override, so the hook has to be exercised
// under them. The hook writes its cross-key aliases into this same client, as
// it does in the app.
vi.mock("@/main.tsx", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  return {
    queryClient: new QueryClient({
      defaultOptions: {
        queries: {
          refetchOnMount: false,
          refetchOnWindowFocus: false,
          retry: false,
          staleTime: 5 * 60 * 1000,
        },
      },
    }),
  };
});

// Only the network is faked. Each response carries a per-page fetch counter in
// its title, so a render can tell the cached copy from the revalidated one.
const fetches = vi.hoisted(() => ({ byPage: new Map<string, number>() }));

vi.mock("@/features/page/services/page-service", () => ({
  getPageById: vi.fn(async (input: Partial<IPageInput>) => {
    const n = (fetches.byPage.get(input.pageId) ?? 0) + 1;
    fetches.byPage.set(input.pageId, n);
    return {
      id: `id-${input.pageId}`,
      slugId: input.pageId,
      title: `${input.pageId} #${n}`,
      permissions: { canEdit: true, hasRestriction: false },
    } as IPage;
  }),
}));

import { queryClient } from "@/main.tsx";
import { getPageById } from "@/features/page/services/page-service";
import { usePageQuery } from "./page-query";

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

// In-app navigation A -> B -> A keeps <Page /> (and its useQuery observer)
// mounted and only switches the query key. Opening A again — within the 5-minute
// window its cached data would otherwise count as fresh — must still revalidate
// it: the page view grants edit rights only after its own fetch of the page
// (isFetchedAfterMount), and the page-meta boot cache reconciles from it (#563).
describe("usePageQuery — every open of a page revalidates it", () => {
  beforeEach(() => {
    queryClient.clear();
    fetches.byPage.clear();
    vi.mocked(getPageById).mockClear();
  });

  it("refetches page A when the view switches back to it (A -> B -> A)", async () => {
    const { result, rerender } = renderHook(
      ({ pageId }: { pageId: string }) => usePageQuery({ pageId }),
      { wrapper, initialProps: { pageId: "slugA" } },
    );

    await waitFor(() => {
      expect(result.current.isFetchedAfterMount).toBe(true);
      expect(result.current.isFetching).toBe(false);
    });
    expect(result.current.data?.title).toBe("slugA #1");

    rerender({ pageId: "slugB" });
    await waitFor(() => {
      expect(result.current.data?.title).toBe("slugB #1");
      expect(result.current.isFetchedAfterMount).toBe(true);
      expect(result.current.isFetching).toBe(false);
    });

    rerender({ pageId: "slugA" });
    // A's cached copy renders at once; its revalidation runs in the background
    // and has not landed yet, so THIS view has not fetched A since the switch.
    expect(result.current.data?.title).toBe("slugA #1");
    expect(result.current.isFetchedAfterMount).toBe(false);
    expect(result.current.isFetching).toBe(true);

    await waitFor(() => {
      expect(result.current.data?.title).toBe("slugA #2");
      expect(result.current.isFetchedAfterMount).toBe(true);
      expect(result.current.isFetching).toBe(false);
    });

    const fetchedIds = vi
      .mocked(getPageById)
      .mock.calls.map(([input]) => input.pageId);
    expect(fetchedIds).toEqual(["slugA", "slugB", "slugA"]);
  });
});
