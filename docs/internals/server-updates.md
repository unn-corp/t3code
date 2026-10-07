# Server updates

Every way of installing or reversing a build on a device (App updates in the web or desktop UI, a
remote client's RPC, `t3 maintenance`, MCP, the desktop's automatic gate) calls one controller,
[`createForkMaintenanceController`](../../packages/shared/src/forkMaintenanceController.ts). It owns
status, policy, eligibility, the install transaction and recovery. Platform behavior (download,
launching trial runtimes, WSL homes) arrives as ports, so no entry point can install with weaker
checks than another. The legacy `server.updateServer*` / `commitDesktopUpdate` RPCs now refuse with a
pointer to App updates: they were a second install path that bypassed the coordinator.

Updates never stop agents. Activity blocks installation; it is never an input to "stop and update".
`continueRunningThreads` is retired for the same reason. Crash and restart continuation (below) is a
different feature and is unchanged.

## The device coordinator

A host-local, per-OS-user directory ([`CoordinatorStore`](../../packages/shared/src/forkMaintenanceStore.ts))
holds one registry of every fork runtime, one admission fence, work leases, the transaction
journals, receipts, and the recovery cache. It lives outside any app directory and T3 home, so it is
one view of the device even when several homes exist (Windows plus WSL distributions, a desktop and a
background service, development servers). Constraints that are easy to get wrong:

- **Participants are separate from data homes.** A participant is a running process and states its
  activity; a home is a directory an update replaces. Only desktop and launcher-managed service
  runtimes are binary update targets. Standalone and development runtimes block installation while
  they run and are never replaced. The home is the directory that _contains_ `userdata`, canonicalized.
- **Liveness is process creation identity**, not PID or a heartbeat. A stale heartbeat is never proof of
  exit, and a reused PID is a different process. An unreadable owner or lock blocks; locks are not stolen
  on a timeout (`t3 maintenance repair-lock` removes one whose owner is proven exited).
- **Processes a runtime started outlive it as blockers.** Terminals, provider CLIs and background
  commands are reported with the runtime's observations; if the runtime exits first, its registration
  is kept as an orphan tombstone until each is verified gone. The complete owned-process census is
  retained without a count cap. A stale, failed, partial or unreadable census is unknown activity and
  cannot erase the last known descendants. If an observed child PID cannot be tied to a creation
  identity, an unknown-identity tombstone remains until a later OS check proves the PID gone or
  resolves it to a concrete creation identity. If the old runtime exited while its census was unknown
  and no child PID was recorded, a replacement's census of its own process tree cannot prove the old
  tree empty; the device remains blocked until the offline `t3 maintenance attest-orphan` procedure
  verifies the exact exited owner and every recorded child, and an operator confirms unrecorded work
  was checked. That command refuses a live runtime or transaction fence and removes only the named
  orphan; it never terminates work.
- **A fresh live process must be explained.** Every live process in a current diagnostics census blocks
  unless it is the exact creation identity of a registered, still-running provider server root; that
  exemption never covers the provider's children. A terminal shell stays a `commands` blocker even
  when its metadata says it has no child command, because a shell can run work in its own PID and
  telemetry cannot prove it is waiting at the prompt. Close a terminal after its work finishes; the
  updater never closes it or infers idle from a shell name. A census row whose PID is confirmed exited
  is dropped, while an unreadable identity remains unknown activity.
- **Registration precedes database opening.** On supported update platforms, a coordinator open,
  lock, or registry-read failure refuses runtime startup even if no transaction journal exists. Running
  without registration after a transient error would hide work from peers whose next check succeeds.
  Only unsupported OSes retain the non-updating unavailable mode.
- **Unknown is never idle.** Every activity source is required in the composition (projection runtime
  set, delegated and subagent deliveries, organization work, Architect requests, terminals, repository
  clones, descendants), and one that cannot be read blocks as `unknown-participant`.
  Host capabilities and registry attestations also carry an activity-census protocol marker. New clients
  require the current marker before sending installation, policy, or recovery requests; older host
  capabilities remain readable but receive manual-bootstrap guidance. A participant written by an older
  runtime without the marker blocks admission until that runtime exits or rejoins with current census
  semantics; a legacy writer may erase markers while it is running, which safely blocks the device.
  Windows process creation identities are read in bounded PowerShell batches (at most 256 numeric PIDs
  and an 8 KB command payload per invocation), with at most four batches active and a 10 second timeout
  per batch. Only the first proof of a new Windows runtime’s own identity permits 30 seconds, to
  accommodate a cold PowerShell startup; recurring owner and activity reads retain the 10 second
  bound. An unreadable initial identity still refuses startup before opening the database. Exact UTC
  `StartTime` ticks remain the persisted identity. Each PID is classified as present, absent, or unreadable; a timeout,
  missing row, or malformed row is unreadable and keeps admission blocked. Fresh descendant collection,
  lease cleanup, and child reconciliation use batches, splitting oversized trees rather than truncating
  them or spawning one PowerShell process per child while holding the registry lock.
- **Idle means five stopped minutes** for every participant, then the fence is taken and every
  participant must re-observe it (`frozenFor`) before the transaction starts. Held queues are not
  activity and are never cleared.
- **Admission is atomic with the fence.** `register` validates the fence in the same critical section, so
  a runtime that read "no fence" an instant earlier is still refused. A runtime started by the
  transaction itself presents a one-use capability bound to its exact home, consumed in that same section.
- **Start is gated before the database opens.** `SqlitePersistence.layerConfig` runs the host gate
  first; a refused runtime never creates, opens or migrates a database. Unsupported OSes retain
  ordinary operation with no capability advertised; on supported update platforms, a process-identity
  error refuses startup and installation fails closed.
- **Writes are held, not just orchestrator commands.** RPC authorization takes a work lease for every
  method whose scope is not a read scope (derived from the scope table, so a new write is covered by
  default); terminal event/metadata, provider-auth-state subscriptions, and preview host registration
  check admission when opened but do not hold a lease for their long-lived observer stream. Preview
  input, picking, frame updates and focus changes remain leased as active page work/state changes.
  ChatGPT handoff and Codex callback subscriptions start or receive OAuth work, so they retain
  leases while the flow is active. A global HTTP middleware leases every non-GET request, except
  the exact browser trace-ingestion POST: it holds a passive lease while the bounded upload runs, so
  fencing cannot overlap it, without treating diagnostic export as agent activity or restarting the
  idle window. Other uploads and pairing remain active writes. Orchestrator dispatch and provider turn
  start hold leases too. Each storage-cleanup sweep takes an active lease at execution time, so
  evidence and worktree removal cannot overlap snapshots or restoration. Maintenance methods are exempt so a fenced device can be observed and recovered.

The capability (`forkMaintenance` on the environment descriptor) is advertised only by a runtime that
joined the coordinator. Absence means in-product installation is unavailable, never a legacy install.

## The transaction

Recovery discovery must tolerate homes that cannot currently be verified, including the local
backend before it registers during a cold desktop start. Omit the entire recovery option until all
its restore points are readable; never return a partial home set or let historical recovery discovery
abort ordinary startup. Recovery admission still revalidates the exact option and all selected homes.

[`transaction.ts`](../../packages/shared/src/forkMaintenanceTransaction.ts) is a durable, resumable state
machine over a journal that is fsynced and renamed at every phase. A process that dies mid-update (the
desktop installs by exiting; the launcher replaces the service child) is resumed by the next process from
the journal alone:

`fenced → snapshotted → trial → verified → committed`, or from `trial` to `restoring → restored →
restore-verified`. `aborted` is a pre-trial boundary: nothing live changed.

- All homes are snapshotted before any trial. A snapshot is the state directory except rebuildable
  runtime artifacts (an explicit exclusion list, not an allowlist, so new state is preserved by default),
  copied with SQLite's online backup, hashed, private (POSIX modes; an ACL on Windows, and failing to
  apply it fails the snapshot), and verified before it is reported. Symbolic links are refused.
  Conversation evidence under `userdata` is included in capacity accounting and restore/rescue copies.
  Automatic update and recovery fail closed when the `userdata` root is a symlink or junction, because
  restore swaps that literal directory; move it back to a normal directory with the runtime stopped
  before retrying.
- Capacity is aggregated per physical filesystem and includes rescue copies and staged artifacts, with one
  margin per filesystem. It is checked before the fence and again while quiescent.
  Cohort checks retrieve each home's capacity requirement and combine homes on the same device within
  their owning OS. WSL device numbers are scoped to the explicitly registered distribution; a missing
  or invalid requirement blocks admission rather than falling back to separate per-home checks.
- Commit requires a health receipt for every home, written by the trial runtime itself after migrations,
  live routes and a projection read-back. The coordinator refuses to release the fence unless the journal is
  durably `committed`, `restore-verified` or `aborted`, so no adapter can admit writes ahead of the commit.
- A failed trial restores the whole affected set, then verifies the restored runtimes _before_ releasing
  admission. A restore or verification failure keeps the fence held. A commit-write error is ambiguous, so
  it never restores; resume reads the journal and finishes. After admission has been released, older data
  is only ever restored by explicit recovery.
- A target whose install failed on this device is remembered by artifact digest and never retried
  automatically, and restored schedules and queues stay held until a person reviews them.
- Manual installation is bound to the digest the person reviewed, rechecks eligibility against fresh release
  data at install time, and uses the same blockers as automatic installation.

## Launcher-managed services

The [stable launcher](../../apps/server/src/serviceLauncher.ts) is the only process that survives a
runtime swap. The controller runs inside the service (`MaintenanceService`), stages the exact version
(archive digest checked against `fork-release.json`, not just `SHA256SUMS`), takes the fence, snapshots, and
asks the launcher for the update with a one-use trial capability. The launcher passes that capability only to
that update's trial child, strips any inherited one, and advertises `maintenance-trial` in the child context.
An older launcher lacks it, so in-product installation is blocked until `t3 service install` upgrades it.

The launcher's own commit boundary is unchanged and ordered _after_ the receipt: the trial records its health
receipt, then reports `prepared`, then the launcher commits the version, then the trial's controller commits
the journal and releases admission. A crash between those steps never loses data: the launcher's database
rollback and the coordinator's restore point both exist, and each state is recoverable from durable records.

A service that starts after its owner exited resolves the transaction **before the database opens**
([`serviceStartupRecovery.ts`](../../apps/server/src/maintenance/serviceStartupRecovery.ts)): a transaction that never
reached the trial is aborted; one the launcher committed is adopted so its receipts can be verified and committed;
one the launcher rolled back restores the snapshot now, because replacing files under an open database corrupts it,
and is adopted so the restored runtime records its own receipt. A failed restoration blocks startup. Only a service
runtime may adopt, only when the owner's process is provably gone.

The launcher's database snapshot (main file, WAL, shared-memory file) remains, taken once per update after
the old child exits and kept until commit. Attachments and other files outside SQLite are covered by the
coordinator's restore points, not by the launcher.

## Desktop and WSL

The desktop app is the single controller for a desktop-managed device. A desktop-managed server proxies
`getMaintenanceStatus` / policy / action / recovery to it over the telemetry control channel (correlated
request and response), and records no state of its own. Desktop updates stop the bundled backends, so the
transaction resumes in the new build from the journal.

Windows and WSL form one cohort by **explicit membership** ([`forkMaintenanceWsl.ts`](../../packages/shared/src/forkMaintenanceWsl.ts)),
never inferred from addresses or `wsl.exe -l`. A distribution has its own coordinator registry (its processes are
invisible to Windows), so its Windows parent drives it only through `wsl.exe -d <distro> -- <t3> maintenance`:
`home` verbs (snapshot, rescue, restore, capacity, list) and `fence` verbs (freeze held remotely by the parent,
journal mirroring, trial capability, release). A member that cannot answer fails the whole cohort; none is skipped.
Journals record WSL homes as `wsl:<distro>:<home>`, and the parent mirrors the journal into each member so its
remotely held fence can only be released against a durable terminal phase.

## Recovery

Recovery is explicit and local; the destructive RPC needs `access:write`, the exact recorded option id, every home's
restore timestamp, and an acknowledgement that newer data is given up. The CLI additionally requires typing the option
id again. `t3 maintenance` reaches the running server's one controller through a loopback endpoint authorized by an
owner-only token file in the home, so it cannot become a second, weaker path.
Windows protection replaces the maintenance directory's DACL with the current user's SID before
creating the token; POSIX modes do not protect Windows files. Existing explicit grants are removed
along with inherited grants. Permission enforcement failures prevent issuing a credential.

The importable recovery service lives in [`forkRecoveryHelper.ts`](../../packages/shared/src/forkRecoveryHelper.ts).
Only [`forkRecoveryHelperMain.ts`](../../packages/shared/src/forkRecoveryHelperMain.ts) invokes it as an executable.
Keep process exit and command dispatch in that separate entry: inlined `import.meta.url` guards can
otherwise run the helper when the bundled server imports its maintenance service.

When the application is broken, the external helper,
cached outside the app directory with its own Node runtime ([`forkRecoveryCache.ts`](../../packages/shared/src/forkRecoveryCache.ts):
digest-checked, owner-only, executable, and self-tested from a neutral directory with isolated home,
temporary storage, and coordinator paths), runs the same services. Proof processes use the retained
Node runtime rather than a developer or system Node. Linux uses an empty `PATH`; Windows retains
only its OS tools and account identity so private ACL enforcement can run. Neither proof inherits
provider credentials or developer tool paths. The helper performs:
cohort-wide admission and the five-minute idle window, a check that no runtime (a live trial owner included) or orphaned process
owns any affected home, capacity with rescue copies, verified rescue copies of every home, then the restore. It stops at
`restored`: it never writes a health receipt, never marks a runtime verified, and never releases the fence. The next healthy start
verifies the restored runtimes, pins the reverted build, holds restored automation for review, and only then releases admission.
Any failure leaves the fence held.

A matching restored desktop must bootstrap its backend configuration before resuming health
verification. Treat `restored` as a provisional startup, just like a new-build trial: configure
exposure and its real port, start the restored runtimes under their one-use capabilities, then
verify asynchronously. Resuming restoration inside startup admission would call the backend pool
before exposure is configured, leaving port zero and preventing the very health receipt it awaits.
This ordering never releases the write fence early. See
[`maintenanceCore.ts`](../../apps/desktop/src/maintenance/maintenanceCore.ts) and its restored-startup regression.

`recover --desktop-plan <retained install plan>` also replaces a main binary that cannot start, which a data-only restore
cannot fix. The ordering is the invariant: the plan, both installer payloads and the cached helper/Node pair are verified
before any data changes (the plan must be the private install plan of that exact journal, written for this coordinator, and agree
with the owner and digests the controller recorded in `desktopHandoffs.install`; the previous build's installer digest comes from
that record, never from the previous build identity, which can be a legacy value). Only after every home is rescued and
restored does the helper record the `revert` authorization on the recovery journal (owner is this process, payloads swapped), write
the revert plan beside the retained one, and start the cached helper detached to wait for this process to exit and then replace
the binary. It never releases the fence; a healthy prior runtime does, as above. A launch that fails after restoring leaves the
authorization recorded and prints the exact `handoff --plan` command to run.

## Crash and restart continuation

Separate from updates. Restart continuation is an environment-owned preference, off by default. The
[v2 recovery service](../../apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts)
requires matching durable run, provider thread, session, and native resume identity.
Queued runs never started, so recovery holds them and continues the run they wait
behind. A finished run qualifies only when the restart cancelled its background work;
its continuation tells the provider what will not report back.

Recovery retires effects tied to the lost process and records continuation intent
in the durable outbox. That intent survives another restart before provider startup.
Continuation effects wait for activation; a slow provider must not delay the server's
readiness or the launcher's commit boundary. Graceful shutdown captures intent before
closing providers, then reconciles after ingestion has stopped so a late completion
cannot be overwritten by a stale cancellation.

The [continuation handler](../../apps/server/src/orchestration-v2/RestartContinuation.ts)
rechecks the preference, archive state, provider selection, newer user work, a stop
the user requested, and maintenance turns such as `/compact` before dispatching. Stable
command and message IDs prevent duplicate submissions after an outbox retry. Codex
resumes without adding provider prompt text unless the turn lost background work;
other adapters receive the continuation message through their normal turn path.

Delegated tasks (`delegate_task` child threads) are reconciled as their own threads,
never as the parent's background work. The orchestrator settles child results and
completion deliveries in a startup pass after reconciliation, because the terminal-run
listener ignores reconciliation's cancellations. A cancelled child whose restart
continuation is still pending in the outbox is not a result yet; the continuation's run
settles it, or the handler settles it when it declines to continue. Schedulers wait for
activation so they cannot start runs that reconciliation would then cancel.

## What is not commissioned

Behavior verified by tests in this repository is described above. Not yet verified on real devices, and therefore not a
claim: the Windows ACL path of snapshots and the recovery cache on a real NTFS volume, `wsl.exe` invocation against a real
distribution, a Debian `.deb` authorization prompt, macOS (the coordinator reports itself unavailable there), and the full
sequence on an installed AppImage and NSIS build. The desktop controller, IPC and Electron updater adapters are tracked with the
desktop app. No automatic publishing may be enabled before the update and recovery validation passes on those targets.
