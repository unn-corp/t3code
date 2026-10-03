import { AuthAccessWriteScope, EnvironmentId } from "@t3tools/contracts";
import type {
  LocalTeamAccountAction,
  LocalTeamAccountResult,
} from "@t3tools/client-runtime/state/localTeamAccount";
import type { LocalTeamAccountState } from "@t3tools/contracts/teamSpaces";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const { command, openExternal } = vi.hoisted(() => ({ command: vi.fn(), openExternal: vi.fn() }));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal } }),
}));
vi.mock("../../state/localTeamAccount", () => ({ localTeamAccountCommand: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => command }));
vi.mock("../../state/session", () => ({
  useEnvironmentSessionState: () => ({
    data: { authenticated: true, scopes: [AuthAccessWriteScope] },
  }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironment: () => null,
}));
vi.mock("./settingsLayout", () => ({ SettingsSection: () => null }));
vi.mock("./settingsSearch", () => ({ searchableSetting: () => ({}) }));
import { TeamsConnection } from "./TeamsConnection";

const environmentId = EnvironmentId.make("local");
let renderer: ReactTestRenderer | null;
let state: LocalTeamAccountState;
const success = (value: LocalTeamAccountResult) => ({ _tag: "Success", value });
const pending = (serviceUrl: string): LocalTeamAccountState => ({
  ...state,
  serviceUrl,
  flow: {
    id: "flow",
    status: "pending",
    userCode: "ABCD-EFGH",
    verificationUri: "https://accounts.example.test/device",
    verificationUriComplete: "https://accounts.example.test/device?user_code=ABCD-EFGH",
    expiresAt: Date.now() + 60000,
  },
});
const submit = () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} });
const signIn = () =>
  renderer!.root
    .findAllByType("button")
    .find((button) => button.children.includes("Sign in to Teams"));

beforeEach(() => {
  renderer = null;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  command.mockReset();
  openExternal.mockReset().mockResolvedValue(undefined);
  state = {
    generation: "first",
    serviceUrl: "https://teams.example.test",
    account: null,
    flow: null,
    message: null,
  };
  command.mockImplementation(async ({ input }: { input: LocalTeamAccountAction }) => {
    if (input.action === "state") return success({ action: "state", state });
    if (input.action === "start") {
      state = pending(input.serviceUrl);
      return success({ action: "state", state });
    }
    throw new Error(`Unexpected action: ${input.action}`);
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("starts configured Teams sign-in without editing a URL and displays browser approval", async () => {
  await act(async () => {
    renderer = create(<TeamsConnection environmentId={environmentId} />);
  });
  expect(signIn()?.props.disabled).toBe(false);
  expect(renderer!.root.findByType("details").props.open).toBeUndefined();
  expect(openExternal).not.toHaveBeenCalled();
  await act(async () => submit());
  expect(openExternal).toHaveBeenCalledExactlyOnceWith(
    "https://accounts.example.test/device?user_code=ABCD-EFGH",
  );
  const start = command.mock.calls.find(([call]) => call.input.action === "start");
  expect(start?.[0]).toMatchObject({
    environmentId,
    input: { action: "start", serviceUrl: "https://teams.example.test" },
  });
  expect(signIn()).toBeUndefined();
  expect(renderer!.root.findByType("strong").children).toEqual(["ABCD-EFGH"]);
  expect(renderer!.root.findByType("a").props.href).toBe(
    "https://accounts.example.test/device?user_code=ABCD-EFGH",
  );
});

it("offers custom setup when no host default exists and uses the entered origin", async () => {
  state = { ...state, serviceUrl: null };
  await act(async () => {
    renderer = create(<TeamsConnection environmentId={environmentId} />);
  });
  expect(renderer!.root.findByType("details").props.open).toBe(true);
  expect(signIn()?.props.disabled).toBe(true);
  await act(async () => {
    renderer!.root.findByType("input").props.onChange({
      target: { value: "https://custom.example.test" },
      currentTarget: { value: "https://custom.example.test" },
    });
  });
  expect(signIn()?.props.disabled).toBe(false);
  await act(async () => submit());
  expect(command.mock.calls.find(([call]) => call.input.action === "start")?.[0].input).toEqual({
    action: "start",
    serviceUrl: "https://custom.example.test",
  });
});

it("drops a custom draft when the selected environment changes", async () => {
  await act(async () => {
    renderer = create(<TeamsConnection environmentId={environmentId} />);
  });
  await act(async () => {
    renderer!.root.findByType("input").props.onChange({
      target: { value: "https://old-custom.example.test" },
      currentTarget: { value: "https://old-custom.example.test" },
    });
  });
  state = { ...state, generation: "second", serviceUrl: "https://new.example.test" };
  // Changing environments remounts the account and fences drafts and pending reads.
  await act(async () => {
    renderer!.update(<TeamsConnection environmentId={EnvironmentId.make("remote")} />);
  });
  await act(async () => submit());
  expect(command.mock.calls.find(([call]) => call.input.action === "start")?.[0].input).toEqual({
    action: "start",
    serviceUrl: "https://new.example.test",
  });
});

it("keeps approval available when the browser opener fails and never opens on reload", async () => {
  openExternal.mockRejectedValue(new Error("No browser available"));
  await act(async () => {
    renderer = create(<TeamsConnection environmentId={environmentId} />);
  });
  await act(async () => submit());
  expect(renderer!.root.findByType("a").props.href).toContain("user_code=ABCD-EFGH");
  expect(openExternal).toHaveBeenCalledTimes(1);
  await act(async () => {
    renderer!.unmount();
    renderer = create(<TeamsConnection environmentId={environmentId} />);
  });
  expect(renderer!.root.findByType("strong").children).toEqual(["ABCD-EFGH"]);
  expect(openExternal).toHaveBeenCalledTimes(1);
});

it("does not open a browser for a late sign-in result from the previous environment", async () => {
  let finish!: (value: ReturnType<typeof success>) => void;
  const response = new Promise<ReturnType<typeof success>>((resolve) => {
    finish = resolve;
  });
  command.mockImplementation(async ({ input }: { input: LocalTeamAccountAction }) =>
    input.action === "start" ? response : success({ action: "state", state }),
  );
  await act(async () => {
    renderer = create(<TeamsConnection environmentId={environmentId} />);
  });
  await act(async () => submit());
  await act(async () => {
    renderer!.update(<TeamsConnection environmentId={EnvironmentId.make("remote")} />);
  });
  await act(async () => {
    finish(success({ action: "state", state: pending("https://old.example.test") }));
  });
  expect(openExternal).not.toHaveBeenCalled();
  expect(signIn()?.props.disabled).toBe(false);
});
