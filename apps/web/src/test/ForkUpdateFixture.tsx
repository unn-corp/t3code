/** Isolated UI verification only: no server, installer, provider, or user home is touched. */
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ForkUpdateStatus } from "@t3tools/contracts";
import { ForkUpdateController } from "../state/forkUpdates";
import { ForkUpdateControls } from "../components/settings/ForkUpdateControls";
import { SettingsSection } from "../components/settings/settingsLayout";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import "../index.css";
const build = {
  version: "1.0.0-nightly.20261005.1",
  commit: "a".repeat(40),
  artifactSha256: "b".repeat(64),
  channel: "nightly" as const,
};
let status: ForkUpdateStatus = {
  coordinatorId: "isolated-ui-fixture",
  phase: "waiting",
  policy: { channel: "nightly", automaticInstallation: false, pinnedBuild: null },
  currentBuild: build,
  targetBuild: { ...build, version: "1.0.0-nightly.20261005.2" },
  blockers: [{ participantId: "dev", reason: "commands", label: "Fixture development command" }],
  recoveryOptions: [
    {
      id: "previous-build",
      transactionId: "fixture-tx",
      build: { ...build, version: "1.0.0-nightly.20261004.1", artifactSha256: "c".repeat(64) },
      homes: [
        {
          id: "windows",
          label: "Windows home",
          restoreTimestamp: "2026-10-04T12:00:00Z",
          binaryCompatible: false,
          additionalBytes: 1024 ** 3,
          requiresPairing: true,
        },
        {
          id: "wsl",
          label: "WSL home",
          restoreTimestamp: "2026-10-04T12:00:01Z",
          binaryCompatible: false,
          additionalBytes: 2 * 1024 ** 3,
          requiresPairing: false,
        },
      ],
      requiresDataRestore: true,
    },
  ],
  transactionId: null,
  automationReviewRequired: false,
  installable: true,
};
const controller = new ForkUpdateController({
  status: async () => status,
  policy: async (patch) => {
    status = { ...status, policy: { ...status.policy, ...patch } };
    localStorage.setItem("fixture-policy", JSON.stringify(status.policy));
    return status;
  },
  action: async (input) => {
    if (input.action === "check") return status;
    if (input.action === "confirm-bootstrap") {
      status = {
        ...status,
        blockers: status.blockers.filter((blocker) => blocker.reason !== "bootstrap"),
      };
      return status;
    }
    if (input.action === "acknowledge-automation-review") {
      status = { ...status, automationReviewRequired: false };
      return status;
    }
    if (input.action === "cancel-countdown") {
      status = { ...status, countdown: null };
      return status;
    }
    if (status.blockers.length) return status;
    status = { ...status, phase: "verifying" };
    window.setTimeout(() => {
      status = { ...status, phase: "completed" };
      controller.accept(status);
    }, 500);
    return status;
  },
  recover: async (input) => {
    if (!input.acknowledgeDataRestore)
      throw new Error("Fixture restoration needs acknowledgement.");
    status = {
      ...status,
      phase: "pinned",
      currentBuild: status.recoveryOptions[0]!.build,
      policy: { ...status.policy, pinnedBuild: status.recoveryOptions[0]!.build.artifactSha256 },
      automationReviewRequired: true,
    };
    return status;
  },
});
function Fixture() {
  return (
    <AppAtomRegistryProvider>
      <main className="mx-auto max-w-3xl p-4">
        <p className="mb-4">Isolated updater UI fixture — no installers or user data.</p>
        <button
          className="mb-4 rounded border p-2"
          onClick={() => {
            status = { ...status, phase: "staged", blockers: [] };
            controller.accept(status);
          }}
        >
          Simulate stopped fixture work
        </button>
        <button
          className="mb-4 rounded border p-2"
          onClick={() => {
            status = {
              ...status,
              phase: "waiting",
              blockers: [
                {
                  participantId: "coordinator",
                  reason: "bootstrap",
                  label: "Review all registered fixture installations",
                },
              ],
            };
            controller.accept(status);
          }}
        >
          Simulate bootstrap review
        </button>
        <SettingsSection id="app-updates" title="App updates">
          <ForkUpdateControls controller={controller} device="This device" />
        </SettingsSection>
      </main>
    </AppAtomRegistryProvider>
  );
}
const rootRoute = createRootRoute();
const route = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Fixture });
const router = createRouter({
  routeTree: rootRoute.addChildren([route]),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
