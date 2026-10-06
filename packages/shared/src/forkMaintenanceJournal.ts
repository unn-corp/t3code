import * as Schema from "effect/Schema";

/**
 * Durable transaction boundaries. A journal is the only record the next process
 * trusts; every phase is persisted (fsync + atomic rename) before the step it
 * names begins to matter.
 *
 * update:   fenced → snapshotted → trial → verified → committed
 *                                     └→ restoring → restored → restore-verified
 * recovery: fenced → snapshotted(rescued) → restoring → restored → restore-verified
 * `aborted` is a pre-trial boundary: no live data was touched.
 */
export const MaintenancePhase = Schema.Literals([
  "fenced",
  "snapshotted",
  "trial",
  "verified",
  "committed",
  "restoring",
  "restored",
  "restore-verified",
  "restore-failed",
  "aborted",
]);
export type MaintenancePhase = typeof MaintenancePhase.Type;

const Build = Schema.Struct({
  version: Schema.String,
  artifactSha256: Schema.String,
  commit: Schema.optionalKey(Schema.String),
});

export const MaintenanceJournal = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["update", "recovery"]),
  phase: MaintenancePhase,
  /** Canonical data-home identifiers. Affected homes, not activity participants. */
  homes: Schema.Array(Schema.String),
  snapshots: Schema.Record(Schema.String, Schema.String),
  /** Verified copies of current data taken before any destructive restore. */
  rescues: Schema.Record(Schema.String, Schema.String),
  receipts: Schema.Record(Schema.String, Schema.String),
  restoredReceipts: Schema.Record(Schema.String, Schema.String),
  previous: Build,
  target: Schema.NullOr(Build),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  failure: Schema.NullOr(Schema.String),
  /** Exact binary handoffs authorized by the controller, including legacy build-to-installer mapping. */
  desktopHandoffs: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        owner: Schema.Struct({ pid: Schema.Int, started: Schema.String }),
        artifactSha256: Schema.String,
        counterpartSha256: Schema.NullOr(Schema.String),
      }),
    ),
  ),
});
export type MaintenanceJournal = typeof MaintenanceJournal.Type;

export const decodeJournal = Schema.decodeUnknownSync(MaintenanceJournal);

/** Phases after which admission may be released without further proof. */
export const RELEASABLE_PHASES: ReadonlySet<MaintenancePhase> = new Set([
  "committed",
  "restore-verified",
  "aborted",
]);

/** Phases where trial or restored runtimes may still own the homes. */
export const IN_FLIGHT_PHASES: ReadonlySet<MaintenancePhase> = new Set([
  "fenced",
  "snapshotted",
  "trial",
  "verified",
  "restoring",
  "restored",
  "restore-failed",
]);

export function newJournal(input: {
  readonly id: string;
  readonly kind: MaintenanceJournal["kind"];
  readonly homes: ReadonlyArray<string>;
  readonly previous: MaintenanceJournal["previous"];
  readonly target: MaintenanceJournal["target"];
  readonly now: number;
  readonly snapshots?: Readonly<Record<string, string>>;
}): MaintenanceJournal {
  return {
    id: input.id,
    kind: input.kind,
    phase: "fenced",
    homes: [...input.homes],
    snapshots: { ...input.snapshots },
    rescues: {},
    receipts: {},
    restoredReceipts: {},
    previous: input.previous,
    target: input.target,
    createdAt: input.now,
    updatedAt: input.now,
    failure: null,
  };
}
