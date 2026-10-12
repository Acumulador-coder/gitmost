import { useEffect } from "react";
import {
  useQuery,
  useQueryClient,
  UseQueryResult,
} from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { jwtDecode } from "jwt-decode";
import { getCollabToken, verifyUserToken } from "../services/auth-service";
import { ICollabToken, IVerifyUserToken } from "../types/auth.types";
import { isAxiosError } from "axios";
import { userAtom } from "@/features/user/atoms/current-user-atom";

export function useVerifyUserTokenQuery(
  verify: IVerifyUserToken,
): UseQueryResult<any, Error> {
  return useQuery({
    queryKey: ["verify-token", verify],
    queryFn: () => verifyUserToken(verify),
    enabled: !!verify.token,
    staleTime: 0,
  });
}

/**
 * The collab token is cached PER USER. The session cookie belongs to the
 * browser, so after a user switch in another tab a stale tab would otherwise
 * keep opening collab sessions with the previous user's cached token.
 */
export function collabTokenQueryKey(userId: string | undefined) {
  return ["collab-token", userId] as const;
}

/**
 * Fetch a collab token for `userId`. The server issues it for whoever holds the
 * cookie NOW, so a token minted for another user (the sign-in changed in
 * another tab) is refused rather than cached under `userId`'s key.
 */
export async function getCollabTokenForUser(
  userId: string | undefined,
): Promise<ICollabToken> {
  const result = await getCollabToken();
  if (!result?.token) return result;
  let sub: string | undefined;
  try {
    sub = jwtDecode<{ sub?: string }>(result.token).sub;
  } catch (err) {
    throw new Error(`The collab token cannot be decoded: ${String(err)}`);
  }
  if (sub !== userId) {
    throw new Error(
      `The collab token was issued for user ${sub}, not for the signed-in user ${userId}: the sign-in changed in another tab`,
    );
  }
  return result;
}

export function useCollabToken(): UseQueryResult<ICollabToken, Error> {
  const userId = useAtomValue(userAtom)?.id;
  const queryClient = useQueryClient();

  // On a user change (sign-in, sign-out, or a switch in another tab) drop
  // every other user's cached token.
  useEffect(() => {
    queryClient.removeQueries({
      queryKey: ["collab-token"],
      predicate: (query) => query.queryKey[1] !== userId,
    });
  }, [queryClient, userId]);

  return useQuery({
    queryKey: collabTokenQueryKey(userId),
    queryFn: () => getCollabTokenForUser(userId),
    enabled: !!userId,
    staleTime: 20 * 60 * 60 * 1000, //20hrs
    //refetchInterval: 12 * 60 * 60 * 1000, // 12hrs
    //refetchIntervalInBackground: true,
    refetchOnMount: true,
    //@ts-ignore
    retry: (failureCount, error) => {
      if (isAxiosError(error) && error.response.status === 404) {
        return false;
      }
      return 10;
    },
    retryDelay: (retryAttempt) => {
      // Exponential backoff: 5s, 10s, 20s, etc.
      return 5000 * Math.pow(2, retryAttempt - 1);
    },
  });
}
