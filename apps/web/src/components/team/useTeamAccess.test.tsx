import { EnvironmentId } from "@t3tools/contracts";
import type {
  LocalTeamAccountAction,
  LocalTeamAccountResult,
} from "@t3tools/client-runtime/state/localTeamAccount";
import type { TeamDirectory } from "@t3tools/contracts/teamSpaces";
import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const { command } = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock("../../state/localTeamAccount", () => ({ localTeamAccountCommand: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => command }));
import { useTeamAccess } from "./useTeamAccess";
let access: ReturnType<typeof useTeamAccess>;
let renderer: ReactTestRenderer | null;
function Probe({ environmentId }: { environmentId: EnvironmentId }) {
  const current = useTeamAccess(environmentId);
  useEffect(() => {
    access = current;
  });
  return null;
}
const a = EnvironmentId.make("a");
const b = EnvironmentId.make("b");
const outsider: TeamDirectory = {
  role: null,
  canCreateProjects: false,
  canInviteMembers: false,
  members: [],
  invites: [],
};
const owner: TeamDirectory = {
  ...outsider,
  role: "owner",
  canCreateProjects: true,
  canInviteMembers: true,
};
const account = (generation: string): LocalTeamAccountResult => ({
  action: "state",
  state: {
    generation,
    account: { subject: generation, displayName: generation, canCreateProjects: true },
    flow: null,
    message: null,
    serviceUrl: "https://teams.example.test",
  },
});
const success = (value: LocalTeamAccountResult) => ({ _tag: "Success", value });
const deferred = <A,>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
};
beforeEach(() => {
  renderer = null;
  command.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("aborts retired account reads and discards a late old-environment roster", async () => {
  const oldRoster = deferred<ReturnType<typeof success>>();
  let oldSignal: AbortSignal | undefined;
  command.mockImplementation(
    async ({
      environmentId,
      input,
    }: {
      environmentId: EnvironmentId;
      input: LocalTeamAccountAction;
    }) => {
      if (input.action === "state") return success(account(environmentId));
      if (input.action === "teamDirectory") {
        if (environmentId === a) {
          oldSignal = input.signal;
          return oldRoster.promise;
        }
        return success({ action: "teamDirectory", generation: b, directory: outsider });
      }
      return success({ action: "projects", generation: environmentId, spaces: [] });
    },
  );
  await act(async () => {
    renderer = create(<Probe environmentId={a} />);
  });
  expect(access.directory).toBeNull();
  await act(async () => {
    renderer!.update(<Probe environmentId={b} />);
  });
  expect(oldSignal?.aborted).toBe(true);
  expect(access.state?.account?.subject).toBe(b);
  expect(access.directory).toEqual(outsider);
  await act(async () => {
    oldRoster.resolve(success({ action: "teamDirectory", generation: a, directory: owner }));
  });
  expect(access.directory).toEqual(outsider);
  expect(access.spaces).toEqual([]);
});

it("clears old access immediately on refresh and rejects mixed account generations", async () => {
  let mixed = false;
  const nextAccount = deferred<ReturnType<typeof success>>();
  command.mockImplementation(async ({ input }: { input: LocalTeamAccountAction }) => {
    if (input.action === "state") return mixed ? nextAccount.promise : success(account("first"));
    if (input.action === "teamDirectory")
      return success({ action: "teamDirectory", generation: "first", directory: owner });
    return success({ action: "projects", generation: "first", spaces: [] });
  });
  await act(async () => {
    renderer = create(<Probe environmentId={a} />);
  });
  expect(access.directory?.canInviteMembers).toBe(true);
  mixed = true;
  let refresh!: Promise<void>;
  act(() => {
    refresh = access.refresh();
  });
  expect(access.directory).toBeNull();
  expect(access.token).toBe("");
  await act(async () => {
    nextAccount.resolve(success(account("second")));
    await refresh;
  });
  expect(access.directory).toBeNull();
  expect(access.spaces).toEqual([]);
  expect(access.state).toBeNull();
  expect(access.error).toContain("account changed");
});

it("uses the loaded generation for roster changes and reloads owner capabilities", async () => {
  let changed = false;
  command.mockImplementation(async ({ input }: { input: LocalTeamAccountAction }) => {
    if (input.action === "state") return success(account("loaded"));
    if (input.action === "teamDirectory")
      return success({
        action: "teamDirectory",
        generation: "loaded",
        directory: changed ? outsider : owner,
      });
    if (input.action === "teamCommand") {
      expect(input.generation).toBe("loaded");
      changed = true;
      return success({ action: "teamCommand", generation: "loaded", result: {} });
    }
    return success({ action: "projects", generation: "loaded", spaces: [] });
  });
  await act(async () => {
    renderer = create(<Probe environmentId={a} />);
  });
  expect(access.directory?.canCreateProjects).toBe(true);
  await act(async () => {
    await access.teamCommand({ action: "removeMember", userId: "loaded" });
  });
  expect(access.directory).toEqual(outsider);
  expect(access.busy).toBe(false);
});

it("does not restore an invitation code when its mutation finishes after an environment switch", async () => {
  const invitation = deferred<ReturnType<typeof success>>();
  command.mockImplementation(
    async ({
      environmentId,
      input,
    }: {
      environmentId: EnvironmentId;
      input: LocalTeamAccountAction;
    }) => {
      if (input.action === "state") return success(account(environmentId));
      if (input.action === "teamDirectory")
        return success({
          action: "teamDirectory",
          generation: environmentId,
          directory: environmentId === a ? owner : outsider,
        });
      if (input.action === "teamCommand") return invitation.promise;
      return success({ action: "projects", generation: environmentId, spaces: [] });
    },
  );
  await act(async () => {
    renderer = create(<Probe environmentId={a} />);
  });
  let mutation!: Promise<void>;
  act(() => {
    mutation = access.teamCommand({ action: "invite", email: "fixture@example.test" });
  });
  await act(async () => {
    renderer!.update(<Probe environmentId={b} />);
  });
  await act(async () => {
    invitation.resolve(
      success({ action: "teamCommand", generation: a, result: { token: "c".repeat(64) } }),
    );
    await mutation;
  });
  expect(access.directory).toEqual(outsider);
  expect(access.token).toBe("");
  expect(access.state?.account?.subject).toBe(b);
});
