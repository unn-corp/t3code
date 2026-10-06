import { describe, expect, it } from "@effect/vitest";
import {
  CURRENT_ACTIVITY_PROTOCOL,
  capacityShortfalls,
  participantBlockers,
  type MaintenanceParticipant,
} from "./forkMaintenanceAdmission.ts";

const participant = (overrides: Partial<MaintenanceParticipant> = {}): MaintenanceParticipant => ({
  id: "p1",
  label: "Development runtime",
  kind: "development",
  owner: { pid: 42, started: "boot:123" },
  homes: ["/fixture/dev"],
  updateTarget: false,
  parentId: null,
  observedAt: 600_000,
  idleSince: 0,
  frozenFor: null,
  trialFor: null,
  descendants: [],
  orphaned: false,
  blockers: [],
  activityProtocol: CURRENT_ACTIVITY_PROTOCOL,
  ...overrides,
});
describe("device admission", () => {
  it("does not trust a legacy participant's idle attestation", () => {
    const legacy = { ...participant() };
    delete (legacy as { activityProtocol?: number }).activityProtocol;
    const future = participant({ activityProtocol: CURRENT_ACTIVITY_PROTOCOL + 1 });
    const previous = participant({ activityProtocol: CURRENT_ACTIVITY_PROTOCOL - 1 });
    for (const entry of [legacy, previous, future])
      expect(participantBlockers([entry], 600_000)).toEqual([
        expect.objectContaining({
          participantId: "p1",
          reason: "unknown-participant",
          label: expect.stringContaining("current process activity census"),
        }),
      ]);
  });
  it("requires explicit participants and fresh observations even after a long idle window", () => {
    expect(participantBlockers([], 600_000)[0]?.reason).toBe("bootstrap");
    expect(participantBlockers([participant({ observedAt: 500_000 })], 600_000)[0]?.reason).toBe(
      "unknown-participant",
    );
  });
  it("includes development and standalone participants without making them update targets", () => {
    const active = participant({
      blockers: [
        { participantId: "p1", reason: "commands", label: "Waiting for command termination" },
      ],
    });
    expect(participantBlockers([active], 600_000)[0]?.reason).toBe("commands");
    expect(active.updateTarget).toBe(false);
  });
  it("requires five stopped minutes and acknowledgement of the exact transaction", () => {
    expect(participantBlockers([participant({ idleSince: 400_000 })], 600_000)[0]?.reason).toBe(
      "idle-window",
    );
    expect(
      participantBlockers([participant({ frozenFor: "old" })], 600_000, "new")[0]?.reason,
    ).toBe("unknown-participant");
    expect(participantBlockers([participant({ frozenFor: "new" })], 600_000, "new")).toEqual([]);
  });
  it("exempts only the transaction's own trial runtime from idleness, never another transaction's", () => {
    const trial = participant({
      trialFor: "new",
      idleSince: null,
      frozenFor: null,
      blockers: [{ participantId: "p1", reason: "commands", label: "x" }],
    });
    expect(participantBlockers([trial], 600_000, "new")).toEqual([]);
    expect(participantBlockers([{ ...trial, trialFor: "old" }], 600_000, "new")[0]?.reason).toBe(
      "commands",
    );
  });
  it("keeps a participant blocking after its owner exited while its descendants still run", () => {
    const orphan = participant({
      orphaned: true,
      label: "Desktop server",
      descendants: [{ pid: 9, started: "x", label: "terminal" }],
      blockers: [],
    });
    expect(participantBlockers([orphan], 600_000)[0]).toMatchObject({
      reason: "commands",
      label: "A process started by Desktop server is still running after it exited.",
    });
  });
  it("checks filesystem-specific additional capacity, including the one GiB minimum", () => {
    expect(
      capacityShortfalls([
        { filesystem: "C:", requiredAdditionalBytes: 10, availableBytes: 1024 ** 3 },
      ]),
    ).toEqual(["C:"]);
    expect(
      capacityShortfalls([
        {
          filesystem: "WSL",
          requiredAdditionalBytes: 20 * 1024 ** 3,
          availableBytes: 21 * 1024 ** 3,
        },
      ]),
    ).toEqual(["WSL"]);
    expect(
      capacityShortfalls([
        { filesystem: "/", requiredAdditionalBytes: 10, availableBytes: 1024 ** 3 + 10 },
      ]),
    ).toEqual([]);
    expect(
      capacityShortfalls([
        { filesystem: "?", requiredAdditionalBytes: NaN, availableBytes: Infinity },
      ]),
    ).toEqual(["?"]);
  });
});
