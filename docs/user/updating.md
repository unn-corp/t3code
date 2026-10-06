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
service, standalone, and development installation for this OS user uses the baseline
and is registered, then confirm the review. Unknown activity and missing capabilities
continue to block installation.
**Settings → General → About** shows the client identity and links to App updates.
Android displays its source version separately from its installation sequence.

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

**Update all** groups explicit coordinator identities. One device's replacement
targets are requested separately and serialized while independent devices can progress.
Connections to the same replacement target share a request. Offline or
blocked devices report their own result. Keep the client open to see status;
closing it does not authorize a bypass of the host's admission checks.

## Why installation waits

All registered fork runtimes belonging to that local OS user must be stopped,
including desktop, background services, standalone, development, and explicitly
connected WSL runtimes. Work includes child/delegated agents, compaction,
approval waits, provider background tasks, tools, commands, and cancellation
still awaiting termination. A quiet conversation or completed parent is not
proof that work stopped. Unknown participants block installation.
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
