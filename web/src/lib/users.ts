// Synthetic identities for source illustration only; never use for authorization.
export const APP_USERS = [
  // dkHandles: DraftKings usernames this person plays under. Used to auto-detect
  // the true owner of an uploaded entry-history file so it can't be misfiled by
  // the "Upload as" dropdown. Match is case-insensitive.
  { id: "11111111-1111-1111-1111-111111111111", handle: "example_a",   display: "Example A",   role: "admin" as const,  dkHandles: ["example-player-a"] },
  { id: "22222222-2222-2222-2222-222222222222", handle: "example_b",  display: "Example B",  role: "member" as const, dkHandles: ["example-player-b"] },
  { id: "33333333-3333-3333-3333-333333333333", handle: "example_c", display: "Example C", role: "member" as const, dkHandles: [] as string[] },
];

export type AppUserHandle = (typeof APP_USERS)[number]["handle"];

export function userIdFromHandle(handle: string): string | null {
  return APP_USERS.find((u) => u.handle === handle)?.id ?? null;
}

/** Resolve a DraftKings account handle (e.g. "example-player-a") to an app user id. */
export function userFromDkHandle(dkHandle: string | null | undefined) {
  if (!dkHandle) return null;
  const needle = dkHandle.trim().toLowerCase();
  if (!needle) return null;
  return (
    APP_USERS.find((u) => u.dkHandles.some((h) => h.toLowerCase() === needle)) ?? null
  );
}

export function userByHandle(handle: string) {
  return APP_USERS.find((u) => u.handle === handle) ?? null;
}
