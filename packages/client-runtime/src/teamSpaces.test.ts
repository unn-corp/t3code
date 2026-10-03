import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createTeamClient, createTeamSessionTokenGetter } from "./teamSpaces.ts";

const fetch = vi.fn<typeof globalThis.fetch>();
beforeEach(() => {
  fetch.mockReset();
  vi.stubGlobal("fetch", fetch);
});
afterEach(() => vi.unstubAllGlobals());
describe("team control service authentication", () => {
  it("sends the current Clerk token only to the configured service and decodes the result", async () => {
    fetch.mockResolvedValue(Response.json({ spaces: [] }));
    const getToken = vi.fn(async () => "test-clerk-token");
    const client = createTeamClient("https://teams.example.test", getToken);
    expect(await client.list()).toEqual({ spaces: [] });
    const [input, init] = fetch.mock.calls[0]!;
    expect(String(input)).toBe("https://teams.example.test/api/team/spaces");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-clerk-token");
    expect(init?.cache).toBe("no-store");
    expect(getToken).toHaveBeenCalledOnce();
  });
  it("denies requests without a session and preserves access-denied messages", async () => {
    fetch.mockResolvedValue(Response.json({ error: "sign_in_required" }, { status: 403 }));
    await expect(
      createTeamClient("https://teams.example.test", async () => null).list(),
    ).rejects.toThrow("Sign in to access team projects.");
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      createTeamClient("https://teams.example.test", async () => "expired-token").list(),
    ).rejects.toThrow("Sign in again to access team projects.");
  });
});

it("uses team roster endpoints separately from project authorization metadata", async () => {
  const client = createTeamClient("https://teams.example.test", async () => "clerk-token");
  fetch.mockResolvedValueOnce(
    Response.json({
      role: "member",
      canCreateProjects: true,
      canInviteMembers: false,
      members: [],
      invites: [],
    }),
  );
  expect((await client.teamDirectory()).role).toBe("member");
  fetch.mockResolvedValueOnce(Response.json({}));
  await client.teamCommand({ action: "accept", token: "b".repeat(64) });
  fetch.mockResolvedValueOnce(
    Response.json({
      role: "owner",
      creatorId: "creator",
      canManageMembers: false,
      canInviteMembers: false,
      availableMembers: [],
      members: [],
      invites: [],
    }),
  );
  expect((await client.memberDirectory("a".repeat(32))).canManageMembers).toBe(false);
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    "https://teams.example.test/api/team/team-directory",
    "https://teams.example.test/api/team/team-command",
    `https://teams.example.test/api/team/projects/${"a".repeat(32)}/member-directory`,
  ]);
  expect(await new Response(fetch.mock.calls[1]?.[1]?.body).json()).toEqual({
    action: "accept",
    token: "b".repeat(64),
  });
  for (const [, init] of fetch.mock.calls)
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer clerk-token");
});

it("does not issue a passive roster request after cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    createTeamClient("https://teams.example.test", async () => "clerk-token").teamDirectory(
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it("does not POST a retired mutation after deferred token acquisition completes", async () => {
  let finish!: (token: string) => void;
  const pendingToken = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const controller = new AbortController();
  fetch.mockResolvedValue(Response.json({ spaceId: "a".repeat(32) }));
  const request = createTeamClient("https://teams.example.test", () => pendingToken).command(
    { action: "create", name: "Old account intent" },
    controller.signal,
  );
  controller.abort();
  finish("replacement-account-token");
  await expect(request).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects an old session intent if identity changes during token acquisition", async () => {
  let finish!: (token: string) => void;
  const token = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const oldSession = { id: "session-old", user: { id: "user-old" }, getToken: vi.fn(() => token) };
  const replacement = {
    id: "session-new",
    user: { id: "user-new" },
    getToken: vi.fn(async () => "replacement-token"),
  };
  let current = oldSession;
  const client = createTeamClient(
    "https://teams.example.test",
    createTeamSessionTokenGetter({
      userId: oldSession.user.id,
      sessionId: oldSession.id,
      session: oldSession,
      currentSession: () => current,
    }),
  );
  const request = client.teamCommand({ action: "invite", email: "old-intent@example.test" });
  expect(oldSession.getToken).toHaveBeenCalledOnce();
  current = replacement;
  finish("replacement-account-token");
  await expect(request).rejects.toThrow("sign-in changed");
  expect(replacement.getToken).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("rejects a retired session before reading a token and permits a new explicitly bound session", async () => {
  const oldSession = {
    id: "session-old",
    user: { id: "user-old" },
    getToken: vi.fn(async () => "old-token"),
  };
  const current = {
    id: "session-new",
    user: { id: "user-new" },
    getToken: vi.fn(async () => "new-token"),
  };
  const oldClient = createTeamClient(
    "https://teams.example.test",
    createTeamSessionTokenGetter({
      userId: oldSession.user.id,
      sessionId: oldSession.id,
      session: oldSession,
      currentSession: () => current,
    }),
  );
  await expect(oldClient.command({ action: "create", name: "Old intent" })).rejects.toThrow(
    "sign-in changed",
  );
  expect(oldSession.getToken).not.toHaveBeenCalled();
  expect(current.getToken).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockResolvedValue(Response.json({ spaceId: "a".repeat(32) }));
  const newClient = createTeamClient(
    "https://teams.example.test",
    createTeamSessionTokenGetter({
      userId: current.user.id,
      sessionId: current.id,
      session: current,
      currentSession: () => current,
    }),
  );
  await newClient.command({ action: "create", name: "New intent" });
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
    "Bearer new-token",
  );
});

it("cancels deferred roster mutations and project ticket grants on session retirement", async () => {
  for (const action of ["roster", "ticket"] as const) {
    let finish!: (token: string) => void;
    const pendingToken = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const controller = new AbortController();
    const client = createTeamClient("https://teams.example.test", () => pendingToken);
    const request =
      action === "roster"
        ? client.teamCommand({ action: "invite", email: "fixture@example.test" }, controller.signal)
        : client.ticket("a".repeat(32), controller.signal);
    controller.abort();
    finish("new-token");
    await expect(request).rejects.toThrow();
  }
  expect(fetch).not.toHaveBeenCalled();
});
