import { useQuery, UseQueryResult } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { getMyInfo } from "@/features/user/services/user-service";
import { ICurrentUser } from "@/features/user/types/user.types";
import { currentUserAtom } from "@/features/user/atoms/current-user-atom";

export default function useCurrentUser(): UseQueryResult<ICurrentUser> {
  // Seed the query from the persisted current-user so the very first frame
  // already has status:'success' (isLoading false), letting UserProvider pass
  // its `/me` gate (user-provider.tsx) before `/me` answers. The whole
  // ICurrentUser is seeded (identity + workspace + role): staleness is bounded to
  // a single RTT (refetchOnMount:'always' refetches immediately), and the server
  // stays authoritative — a click on a stale affordance returns 403.
  //
  // With `initialData` react-query reports status:'success' but keeps
  // `isFetched:false` (dataUpdateCount stays 0) until the real `/me` resolves —
  // useRedirectIfAuthenticated relies on exactly that to avoid a login loop.
  // `staleTime:0` + `refetchOnMount:"always"` keep the seed a first-frame
  // placeholder.
  //
  // With NO persisted user (first visit / post-logout) we fall back to the plain
  // query (isLoading true → the empty gate).
  const persistedUser = useAtomValue(currentUserAtom);
  const seed = persistedUser ? persistedUser : undefined;

  return useQuery({
    queryKey: ["currentUser"],
    queryFn: async () => {
      return await getMyInfo();
    },
    ...(seed
      ? {
          initialData: seed,
          staleTime: 0,
          refetchOnMount: "always" as const,
        }
      : {}),
  });
}
