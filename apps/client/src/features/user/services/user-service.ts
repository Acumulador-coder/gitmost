import api from "@/lib/api-client";
import { ICurrentUser, IUser } from "@/features/user/types/user.types";
import { OFFLINE_CRITICAL_REQUEST_CONFIG } from "@/lib/config";

export async function getMyInfo(): Promise<ICurrentUser> {
  // #641, part 5 — offline-critical: a per-request timeout so a hung /me settles
  // instead of leaving UserProvider gated on a request that never resolves.
  const req = await api.post<ICurrentUser>(
    "/users/me",
    undefined,
    OFFLINE_CRITICAL_REQUEST_CONFIG,
  );
  return req.data as ICurrentUser;
}

export async function updateUser(data: Partial<IUser>): Promise<IUser> {
  const req = await api.post<IUser>("/users/update", data);
  return req.data as IUser;
}
