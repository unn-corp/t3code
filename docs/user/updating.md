# Updating this fork

Our Android APK, desktop installers, and managed server archives come from
[unn-corp/t3code releases](https://github.com/unn-corp/t3code/releases). They are
separate from upstream T3 distribution and its Expo/store mobile application.
The fork release pipeline must first be commissioned with a verified updater
baseline; a scheduled workflow being present does not mean a new release is available.

## Choose the device

**Settings → General → App updates → This device** controls the client you are
using. It remains local even when Settings is scoped to another environment.
Choose Stable or Nightly, enable automatic installation, check/download, inspect
waiting reasons, install a verified build, or pin the current build. Existing
fork devices are bootstrapped onto Nightly; fresh stable installers use Stable. For a
bootstrap blocker, choose **Review installations**, verify every known fork desktop,
service, standalone, and development installation for this OS user runs a compatible fork build
and is registered, then confirm the review. Unknown activity and missing capabilities
continue to block installation.
**Settings → General → About** shows the client identity and links to App updates.
Android displays its source version separately from its installation sequence.

The main label is **Arcwright Code 0.0.45 · Arcwright build 35 · Nightly**, for example.
The T3 version identifies the upstream code included; the Arcwright number identifies
our build. About retains the exact upstream and Arcwright commits and the installer
release for diagnosis. Android's installation sequence is separate: recovery installs
older source using a higher Android code. Historical builds with unknown upstream
provenance show only their Arcwright counter rather than guessing a T3 version.

Desktop sidebar update controls and **Check for Updates** in the application
menu open this same status surface. Downloads are not ready to install until
verification completes. Release history links to this fork.

**Settings → Connections → Environments → Updates for [host]** controls that
named host. Its channel, automatic installation policy, version, blockers, and
recovery options are independent of the client. Desktop replacement can affect
both Windows and WSL homes; review the affected homes rather than assuming one
connection means one database. Standalone and development runtimes participate
in activity checks but do not replace their own binaries automatically.

Conversation update notices identify the host. A protocol mismatch requires
updating the side named by the notice. Available releases, waiting, installation,
verification, and failure are different states. Stop remains an agent action;
an updater never stops work to obtain an installation window.
Compatibility notices compare the included T3 versions, independently of Arcwright
release availability. An internal `1.x` installer number does not make a `0.0.45`
host incompatible by itself.

**Update all** groups explicit coordinator identities. One device's replacement
targets are requested separately and serialized while independent devices can progress.
Connections to the same replacement target share a request. Offline or
blocked devices report their own result. Keep the client open to see status;
closing it does not authorize a bypass of the host's admission checks.

## Updating from a terminal

Run `t3 update` for the running server's home, or pass `--base-dir` for another home.
It requests the same maintenance controller as App updates, prints waiting reasons, and
never bypasses agent admission. `--channel nightly` changes that home's saved channel;
a pin remains until explicitly resumed. An optional version must match the freshly verified
staged target. `--yes` does not skip safety or operating-system approval, and
`--allow-downgrade` cannot replace the recorded recovery process.

Standalone, development, and older installations need the manual stopped-work bootstrap
procedure; this command does not rewrite their executable or restart them as a fallback.

## Cloud VM environments

For a fresh Linux cloud VM without systemd, use the fork's
[cloud setup helper](../../scripts/cloud-environment.py) and keep
[install.sh](../../scripts/install.sh) beside it. Choose a new private data directory
and an available loopback port:

```sh
python3 scripts/cloud-environment.py setup --home /path/to/new-t3-cloud-home --port 13882 --name 'Squidhub (Personal) — Codex Cloud'
```

See [Codex Cloud setup](./cloud-environments.md) for preparing the reusable image,
task startup, routing, pairing, and Claude sign-in. `setup` combines initialization
and launch; use `init` alone when preparing a fresh home without starting it.
With an exported account list, prefer `--repository owner/repository` plus
`--accounts --owner-account` to derive `repository (Owner) — Codex Cloud`.
`--name` saves an explicit label for restarts and updates; use a runtime
with repository-label support. Initialization installs a verified Nightly release; `--version` selects an exact
initial release instead. It refuses an existing directory and does not import
credentials, conversations, or projects. Start runs the managed launcher in the
foreground, so keep that process alive. Register the VM checkout as a project
and sign in to its providers through the usual setup. The VM's process home and
T3 data directory must be writable; all fork runtimes for the same OS user must
share the device coordinator. Do not create a separate maintenance namespace
for each environment to avoid its activity checks.

Establish the private HTTP/WebSocket route and pair this environment through
**Settings → Connections → Add environment**. In Connections, open its **Updates**
controls, complete **Review installations** for the VM's known fork runtimes, then
use **Check and download** and **Install**. **Update all** requests updates for the
connected hosts. Each host retains its own activity checks, channel, pin, and
recovery state. New cloud homes have **Automatic installation** enabled by default;
installation still waits for the installations review and all activity checks.
Use `setup --auto off` or `init --auto off` for manual updates instead. The saved preference survives
restarts; starting an environment does not change it or an existing home's choice.

If an older managed Linux release rolls back with `scope-quiesce-failed` because
its native Organization launch broker was not provisioned, finish the installation
review and wait for its normal idle window. From a verified corrected release's
CLI, run `t3 maintenance scope-broker --base-dir /path/to/the/existing/home` with
the existing coordinator namespace. This provisions only the native broker for
that verified idle home. Retry the running environment's normal update afterward;
the command neither activates the newer CLI build nor grants installation admission.
It refuses active or unknown work, a different coordinator/home, and an update in
progress. Preserve the existing home and credentials; do not skip the quiescence
barrier or replace its installed runtime manually.

From the VM's terminal, the helper exposes the same controller:

```sh
python3 scripts/cloud-environment.py status --home /path/to/t3-cloud-home
python3 scripts/cloud-environment.py update --home /path/to/t3-cloud-home
python3 scripts/cloud-environment.py auto-update --home /path/to/t3-cloud-home --auto on
```

Use `auto-update` while the managed server is running to change its saved preference;
`--auto off` disables it and `--auto on` enables it for an existing managed home.
The host checks and downloads eligible releases periodically even when
the T3 client is closed. Installation waits for all registered work to finish,
five idle minutes, and a 15-second countdown. A new turn, tool, background task,
approval wait, open terminal, or unknown activity blocks installation and resets
the countdown. Pins and unresolved installation/recovery blockers still apply.

The update command does not reinstall files or force a restart. It follows the
saved policy and reports waiting reasons. Provider logins outside the T3 home
still need separate preservation. A cloud task ending can remove its runtime and
state; this helper does not keep the VM alive or reconnect its private tunnel.
An existing standalone VM, including the original Squidhub experiment, needs a
separate stopped-work transition before it can use managed updates. Do not run
initialization over its home.

## Why installation waits

All agent work in registered fork runtimes belonging to that local OS user must be stopped,
including desktop, background services, standalone, development, and explicitly
connected WSL runtimes. Work includes child/delegated agents, compaction,
approval waits, provider background tasks, tools, commands, and cancellation
still awaiting termination. A quiet conversation or completed parent is not
proof that work stopped. Unknown participants block installation. An open terminal shell
also blocks because commands can run without child processes; close it after its work finishes.
An older registered runtime can also block because it lacks the current process
activity checks. Let its work finish before upgrading it manually. Standalone and
development servers require that manual step; confirming the installation review
does not upgrade their safety checks.
An additional desktop instance using a different data home blocks desktop replacement;
close that instance after its work stops. Managed services remain activity participants,
but desktop replacement does not restore their databases.

The coordinator requires five idle minutes, acquires its interprocess admission
lock, fences new work, and checks every participant again. Desktop automatic
installation also waits for input inactivity and unfinished uploads, then shows
a cancellable 15-second countdown. Drafts and queued messages remain saved.
A fresh release eligibility check and enough space for recovery are required.

Android runs no coding-agent server. APK replacement waits until the phone has
been backgrounded for two minutes and its browser automation, uploads, and
native operations finish. Remote host agents can continue. Android may require
**Allow from this source** permission and a system installation confirmation;
waiting for either is shown explicitly. Denying permission does not clear connections.
On the native recovery screen, **Open Android update confirmation** opens a pending system
prompt directly, so finding the notification is optional. Android still requires its own approval.

Older launchers and missing safety capabilities show bootstrap guidance.
Other OS users, unrelated applications, and unregistered old installations are
outside the coordinator's enforceable boundary. Register known fork runtimes
before enabling automatic installation. External ADB, package managers, and
manually executed installers cannot universally be intercepted: stop all fork
work and verify process termination before using those paths.

Failures remain blocked until you explicitly retry or choose a superseding
build. Network checks back off. A withdrawn release does not cause an automatic
downgrade; normal installation rechecks whether the exact build remains eligible.

## Recover a previous build

Open **App updates → Recovery → Review [version]**, or the named host's update
controls in Connections. The confirmation names the device, current/target
builds, affected homes, compatibility, restore cutoffs, storage, and pairing
consequences. Opening the confirmation and submitting it both retrieve fresh
recovery state. A changed snapshot invalidates the confirmation.

Recovery currently requires explicit acknowledgement of older data restoration.
Being able to read a restore point does not prove the previous binary can read today's
database, so binary-only reversion is not offered without that compatibility proof. The
coordinator verifies a rescue copy of current data and required assets before
restoring; all selected homes are restored before the older runtime starts.
Changes after each displayed cutoff will not appear in restored data. Older
session state can require re-pairing. Recovery files contain private conversation
state and credentials; exporting them is an explicit user action.

After destructive restoration, **Review restored automation** links to
**Settings → Scheduled tasks**. Restored schedules, queues, and replayable work
remain held until reviewed. Return to that host’s update controls and choose
**Confirm automation review** only after reviewing its schedules and queued work.
This releases the automation hold and eligible work may start. **Resume updates** clears the recovered build's pin;
it does not resume agent work. The previous build stays pinned until that action.

Two previous verified builds and their restore points are retained. Recovery
requires additional space per filesystem and a safety margin of the greater of
10% of required additional bytes or 1 GiB. Insufficient space blocks recovery;
the last usable recovery point is never deleted to make room.

The OS-accessible desktop/server recovery helper lives outside the replaced
application directory. Follow the exact paths and commands in the
[fork release runbook](../operations/fork-releases.md). Android recovery is
available natively before WebView loading, through its recovery shortcut or
notification. A recovery APK uses the same package/key and a higher installation
sequence while identifying its older source separately. Never uninstall or
clear app storage to recover: doing so can remove saved connection links.
If the APK cannot launch, use the runbook's external signed recovery download.
Cached verified artifacts can support manual offline recovery; normal offline
installation waits for a fresh eligibility check.

## Browser PWA and upstream mobile

A browser PWA uses **App updates → Reload the app from the server** to refresh
cached web files. Pairing, environments, and settings are retained. This does
not replace native Android code; the control is hidden in the fork APK.

The separate upstream React Native/Expo application keeps store/Expo client
delivery. Its environment maintenance uses shared server compatibility checks;
it does not acquire this fork's native APK updater. See the
[Android fork guide](./android-fork.md) for our APK and Tailscale connections.

## Crash recovery and providers

**Continue threads after restarts** applies to supported crash/machine-restart
recovery, not an update safety bypass. Fork updates wait for stopped work.
Starting the application again is still required; terminal processes and
provider sessions have their own restart limits.

Provider CLI updates in **Settings → Providers** are separate from fork app
releases. Their controls target the selected environment and require its operate
permission. Read the provider's own restart guidance.

## Manual backups

Stop the server and use an explicit home and a new private output directory:

```sh
t3 backup create --home-dir "$HOME/.t3" --output /path/to/new-backup
t3 backup restore --input /path/to/new-backup --home-dir /path/to/restored-t3
```

The backup includes conversation state, settings, themes, attachments, browser
artifacts, and credentials in that T3 home. Project files/worktrees and provider
credentials outside it need separate backups. Restore refuses an existing
destination. Do not open an older runtime against newer data without a proven
compatibility decision; review restored schedules before allowing work.
Automatic updater snapshots and transaction recovery follow the stronger
multi-home boundaries in [server update architecture](../internals/server-updates.md).

If Android reports recovered safety state, restart the phone and finish any pending
Android installer before reviewing update settings. A readable backup can predate
a pending operation, so the app keeps installation blocked until that check passes.
Android Settings screens and unfinished phone page navigations also hold installation.
Enable notifications and the **App updates** notification channel before installing so Android’s confirmation can reach
you while the app is in the background. Native recovery links to this permission.

In **Settings → General → App updates**, use **Open App updates notification settings**
to enable that channel. Native recovery offers the same route when the bundled interface cannot load.
