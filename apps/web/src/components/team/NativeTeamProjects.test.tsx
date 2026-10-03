import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { LocalTeamFilesControl } from "@t3tools/contracts/teamFiles";
import { act, type PropsWithChildren, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
const { files, account, access } = vi.hoisted(() => ({
  files: vi.fn(),
  account: vi.fn(),
  access: {
    state: { generation: "same-generation", account: { subject: "creator" } } as {
      generation: string;
      account: { subject: string };
    } | null,
    directory: { canCreateProjects: true, members: [] },
    spaces: [],
    revision: 0,
    busy: false,
    error: "",
    refresh: vi.fn(),
    invalidate: vi.fn(),
  },
}));
vi.mock("./useTeamAccess", () => ({ useTeamAccess: () => access }));
vi.mock("../../state/localTeamAccount", () => ({ localTeamAccountCommand: "account" }));
vi.mock("../../state/teamProjects", () => ({
  teamProjects: { files: "files" },
  sharedProjectSourceScope: vi.fn(),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "files" ? files : account),
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: vi.fn() }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironmentId: () => EnvironmentId.make("preview-environment"),
}));
vi.mock("../../connection/useDesktopLocalBootstraps", () => ({
  useDesktopLocalBootstraps: () => [],
}));
vi.mock("../../localApi", () => ({ readLocalApi: () => ({ dialogs: { pickFolder: picker } }) }));
const picker = vi.fn();
vi.mock("../../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({ handleNewThread: vi.fn() }),
}));
vi.mock("../../lib/utils", () => ({ randomUUID: () => "01234567-89ab-4def-89ab-0123456789ab" }));
vi.mock("./ProjectMembers", () => ({ ProjectMembers: () => null }));
vi.mock("../settings/TeamsConnection", () => ({
  TeamsConnectionContent: () => <span>Team sign-in form</span>,
}));
vi.mock("../ui/input", () => ({ Input: (props: ComponentProps<"input">) => <input {...props} /> }));
vi.mock("../ui/button", () => ({
  Button: (props: ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("../ui/dialog", () => {
  const Wrapper = ({ children }: PropsWithChildren) => children;
  return {
    Dialog: Wrapper,
    DialogPopup: Wrapper,
    DialogHeader: Wrapper,
    DialogTitle: Wrapper,
    DialogPanel: Wrapper,
  };
});
import { NativeTeamProjectDialog, useTeamProjectDialog } from "./NativeTeamProjects";
let renderer: ReactTestRenderer | null = null;
afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
    useTeamProjectDialog.getState().close();
  });
  vi.unstubAllGlobals();
});

it("reloads Share preflight on a same-generation refresh and submits the newly reviewed commit", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const environmentId = EnvironmentId.make("preview-environment");
  const projectId = ProjectId.make("preview-project");
  let commit = "a".repeat(40);
  access.revision = 0;
  files.mockImplementation(async ({ input }: { input: LocalTeamFilesControl }) => ({
    _tag: "Success",
    value: input.action === "preview" ? { branch: "main", commit } : { projectId },
  }));
  account.mockResolvedValue({ _tag: "Success", value: { action: "state", state: access.state } });
  await act(async () => {
    useTeamProjectDialog.getState().open({ action: "share", environmentId, projectId });
    renderer = create(<NativeTeamProjectDialog />);
  });
  act(() =>
    renderer!.root.findByType("input").props.onChange({ target: { value: "Shared project" } }),
  );
  // Model a batched refresh: directory and generation never commit a transient null.
  commit = "b".repeat(40);
  access.revision++;
  await act(async () => renderer!.update(<NativeTeamProjectDialog />));
  expect(files.mock.calls.filter(([call]) => call.input.action === "preview")).toHaveLength(2);
  const upload = renderer!.root
    .findAllByType("button")
    .find((button) => button.children.includes("Upload and share project"))!;
  expect(upload.props.disabled).toBe(false);
  await act(async () => upload.props.onClick());
  expect(files.mock.calls.find(([call]) => call.input.action === "share")?.[0]).toMatchObject({
    environmentId,
    input: {
      action: "share",
      projectId,
      name: "Shared project",
      expectedBranch: "main",
      expectedCommit: "b".repeat(40),
    },
  });
});

it("chooses a checkout folder with the native picker and preserves it on cancel", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { desktopBridge: { getWslState: async () => null } });
  picker.mockResolvedValueOnce("/home/test/new-project").mockResolvedValueOnce(null);
  await act(async () => {
    useTeamProjectDialog
      .getState()
      .open({ action: "create", environmentId: EnvironmentId.make("preview-environment") });
    renderer = create(<NativeTeamProjectDialog />);
  });
  const browse = () =>
    renderer!.root.findAllByType("button").find((b) => b.children.includes("Browse..."))!;
  await act(async () => browse().props.onClick());
  const folder = () =>
    renderer!.root.findAllByType("input").find((i) => i.props.id === "team-checkout-directory")!;
  expect(folder().props.value).toBe("/home/test/new-project");
  await act(async () => browse().props.onClick());
  expect(folder().props.value).toBe("/home/test/new-project");
  expect(picker).toHaveBeenLastCalledWith({ initialPath: "/home/test/new-project" });
});

it("keeps account loading inside the project dialog without flashing the sign-in form", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const signedIn = access.state;
  try {
    access.state = null;
    await act(async () => {
      useTeamProjectDialog
        .getState()
        .open({ action: "open", environmentId: EnvironmentId.make("preview-environment") });
      renderer = create(<NativeTeamProjectDialog />);
    });
    expect(renderer!.root.findAllByType("span")).toHaveLength(0);
    expect(renderer!.root.findByProps({ role: "status" }).children).toContain(
      "Loading team access...",
    );
    access.state = signedIn;
    await act(async () => renderer!.update(<NativeTeamProjectDialog />));
    expect(renderer!.root.findAllByType("span")).toHaveLength(0);
    expect(useTeamProjectDialog.getState().target?.action).toBe("open");
  } finally {
    access.state = signedIn;
  }
});
