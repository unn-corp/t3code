# Maintaining this fork

This guide owns the retained behavior of `unn-corp/t3code`. Follow the linked user guides for
operation and the implementation links when changing a feature. Upstream mobile in `apps/mobile`
is a separate Expo/store client; it does not build or update our APK.

The initial audit compared the committed fork with its recorded upstream integrations, including
`87eacfc6c4`, `01a14ef2bc`, and the tested integration at `01b0f9e896`. It also included the local
Android, browser-sharing, and documentation changes. An upstream merge is not evidence that every
fork feature shipped upstream. Recheck both `git log --first-parent` and `git diff upstream/main HEAD`
when revisiting ownership; avoid treating an old merge-base file list as the current divergence.

## Android client

**Behavior and reason.** A standalone APK bundles the shared web client and native phone features.
It keeps environment pairing on the phone and primarily reaches hosts over Tailscale. Android does
not run the coding-agent server or a Tailscale daemon inside the APK.

**Entry points.** Launch T3 Code; use Settings → Connections to pair each host. The Android
[guide](../user/android-fork.md) covers installation and everyday routes. The
[runbook](./android-pwa.md) owns signing, build commands, editing, and isolated verification.

**Ownership.** [MainActivity.java](../../apps/android-pwa/app/src/main/java/com/devotek/t3code/pwa/MainActivity.java)
owns the shell and origin boundary; [build.gradle](../../apps/android-pwa/app/build.gradle) and
[build-android-pwa.ts](../../scripts/build-android-pwa.ts) own packaging. Shared connections live in
[client-runtime](../../packages/client-runtime/src). Web native adapters live in
[android](../../apps/web/src/android).

**Verification and coupling.** The native browser instrumentation and Java unit tests described in
the runbook cover release APK behavior. Test in-place, same-key installation and preserved
connections, system permission changes, cover/unfolded dimensions, and live resize. Changes to
shared Settings or client-runtime require an APK rebuild. Never uninstall to upgrade; losing the
signing identity prevents normal in-place replacement.

## Phone alerts

**Behavior and entry.** Settings → General → Android notifications controls system notifications
and background host connections. The APK maintains authenticated host WebSockets through a native
foreground service; it does not use upstream cloud push delivery.

**Ownership.** [NativeNotifications.java](../../apps/android-pwa/app/src/main/java/com/devotek/t3code/pwa/NativeNotifications.java),
[AgentNotificationService.java](../../apps/android-pwa/app/src/main/java/com/devotek/t3code/pwa/AgentNotificationService.java),
and [NotificationCredentials.java](../../apps/android-pwa/app/src/main/java/com/devotek/t3code/pwa/NotificationCredentials.java)
own permission, alert lifecycle, and encrypted credentials. The
[Android notification runbook](./android-notifications.md) covers operational limits.

**Verification and coupling.** Test completion/input/failure while locked, notification tap to the
correct environment/thread, denied permission, lost connectivity, and duplicate suppression.
Host ticket/subscription changes affect the service. Android force-stop and system restrictions
can require reopening the app; preserve encrypted credentials when updating native storage.

## Phone browser and temporary Tailscale shares

**Behavior and entry.** Open a thread → right panel → Add panel surface → Browser. The APK uses a
separate native WebView and phone-local automation; remote page content receives no application
bridges. Temporary localhost shares belong to browser tabs and expire after one hour without an
actual page navigation. Closing the last owner also releases its share.

**Ownership.** [NativeBrowser.java](../../apps/android-pwa/app/src/main/java/com/devotek/t3code/pwa/NativeBrowser.java)
and [BrowserPolicy.java](../../apps/android-pwa/app/src/main/java/com/devotek/t3code/pwa/BrowserPolicy.java)
own phone execution. [PreviewView.tsx](../../apps/web/src/components/preview/PreviewView.tsx),
[Manager.ts](../../apps/server/src/preview/Manager.ts),
[PortPublisher.ts](../../apps/server/src/preview/PortPublisher.ts), and
[TemporaryShareProxy.ts](../../apps/server/src/preview/TemporaryShareProxy.ts) own host sharing and
cleanup. The [Android runbook](./android-pwa.md) documents routing and deployment.

**Verification and coupling.** [PortPublisher.test.ts](../../apps/server/src/preview/PortPublisher.test.ts)
and [TemporaryShareProxy.test.ts](../../apps/server/src/preview/TemporaryShareProxy.test.ts) cover
ownership, real visits versus probes/assets, expiry, HTTP/WebSocket forwarding, restart cleanup,
and failed teardown retry. Test phone foreground/lock transitions and real-time resize. Both host
and APK must support the sharing capability; old hosts do not receive guessed Tailscale URLs.
Tailscale Serve must be available on the host. Do not remove unrelated Serve configuration.

## Responsive composer, sidebar, and glance rail

**Behavior and reason.** Touch layouts keep composer actions singular when collapsed, preserve
drafts, reserve sidebar drag-grip space while visible, and resize across the phone's two screens.
The glance rail adds project scope, usage, and quick access without replacing thread controls.
Dictation holds client installation through microphone permission, recording, decoding, and
transcription; cancelling releases that hold only after the pending operation ends.

**Ownership and entry.** The conversation composer is
[ChatComposer.tsx](../../apps/web/src/components/chat/ChatComposer.tsx) with
[ComposerPrimaryActions.tsx](../../apps/web/src/components/chat/ComposerPrimaryActions.tsx).
Sidebar behavior is shared by [Sidebar.tsx](../../apps/web/src/components/Sidebar.tsx),
[LegacySidebar.tsx](../../apps/web/src/components/LegacySidebar.tsx), their pointer/drag helpers,
and [GlanceRail.tsx](../../apps/web/src/components/GlanceRail.tsx).
[OpenWhisprVoiceInput.tsx](../../apps/web/src/components/chat/OpenWhisprVoiceInput.tsx)
uses the shared client-operation guard; its [interaction tests](../../apps/web/src/components/chat/OpenWhisprVoiceInput.test.tsx)
cover denied admission, cancelled permission acquisition, and pending transcription.

**Verification and coupling.** Keep the corresponding component, pointer, drag, and draft tests
with these modules. Verify keyboard and touch interaction, one Send/microphone/prompt, opening
sidebar without width jumps, drafts across collapse, reduced motion, screen readers, and live
fold/unfold resize. Upstream composer/sidebar refactors can incorporate equivalent fixes; compare
actual behavior before reapplying a patch. Shared web changes ship in desktop/PWA and only reach
Android after rebuilding its bundle.

## Stop, commands, and run recovery

**Behavior and reason.** Stop must remain reachable while work or cancellation is pending.
A settled parent does not prove its commands, delegated work, or provider children terminated.
Stopping Codex work also pauses its goal; restart recovery and cancellation have separate semantics.

**Ownership.** [ComposerPrimaryActions.tsx](../../apps/web/src/components/chat/ComposerPrimaryActions.tsx),
[ProviderTurnControlService.ts](../../apps/server/src/orchestration-v2/ProviderTurnControlService.ts),
[RunExecutionService.ts](../../apps/server/src/orchestration-v2/RunExecutionService.ts), and provider
adapters own the path. [ProviderRuntimeRecoveryService.ts](../../apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts)
owns restart reconciliation. Pending background work stays observable after a root turn settles.

**Verification and coupling.** Use control-service, recovery regression, and run-execution tests;
exercise approval waits, compaction, background commands, child agents, lost provider transport,
and cancellation awaiting process termination. Keep Stop prominent in update notices. Provider
SDK changes require reviewing process ownership and terminal-event behavior, not only UI state.

## Organizations and automation dashboard

**Behavior and entry.** Organizations provides guided Architect setup, durable bounded autonomous
work, budgets, recovery, and repository/GitHub synchronization. The agent dashboard provides
reviews, findings, implementation work, and scheduled maintenance. These are retained fork domains,
not evidence that equivalent upstream surfaces exist.

**Ownership.** Follow [Organizations architecture](../internals/organizations.md),
[Organizations user guide](../user/organizations.md),
[dashboard user guide](../user/agent-dashboard.md), and
[review operations](./agent-dashboard-reviews.md). Implementations live in
[organizations](../../apps/server/src/organizations) and
[agentDashboard](../../apps/server/src/agentDashboard).

**Verification and coupling.** Domain tests cover durable authorization, budgets, stopped work,
reconciliation, review/implementation scheduling, and credential redaction. Test new schedulers
against device maintenance fencing. Provider-role/model defaults and upstream orchestration event
changes require reviewing adapters and contracts. Restoring old data must not silently replay
schedules, queues, or standing work authorization.

## Checkpoints and model compatibility

**Behavior and reason.** Fork fixes avoid rehashing Git LFS files while capturing checkpoints,
recover stale Codex shadow-home entries, and support the fork's configured model/role shapes.

**Ownership and verification.** [checkpointing](../../apps/server/src/checkpointing) owns repository
state; [provider](../../apps/server/src/provider) and
[orchestration adapters](../../apps/server/src/orchestration-v2/Adapters) own provider compatibility.
Run the relevant checkpoint/provider regression tests when syncing upstream. Model availability
comes from the live provider catalog, not a documentation snapshot. Confirm whether upstream has
incorporated equivalent behavior before retaining compatibility patches.

## Updates and recovery

**Ownership.** Additive wire contracts live in
[maintenance.ts](../../packages/contracts/src/maintenance.ts). Host ownership, activity admission,
and durable transaction boundaries live in [maintenance](../../apps/server/src/maintenance).
[AppUpdateSettings.tsx](../../apps/web/src/components/settings/AppUpdateSettings.tsx) is the desktop
client's canonical update control; About shows identity. Browser cache reload belongs to
[PwaAppUpdateSettings.tsx](../../apps/web/src/components/settings/PwaAppUpdateSettings.tsx) and is
hidden in the APK because it cannot replace native code. Release history and CLI installers target
this fork.

**Implementation and commissioning.** Coordinator services, multi-home transactions, desktop
and Android controllers, shared UI controls, native recovery, external recovery helpers, and fork
release workflows are implemented with focused verification. A complete signed manual baseline is
available; automatic publishing and production rollout remain uncommissioned. The release rehearsal and hardware update/recovery checks must pass
before enabling automatic publishing. Existing installations need the known-good updater baseline
and explicit device bootstrap before participating. A successful source test is not a hardware
installation receipt.

**Verification.** [forkMaintenanceAdmission.test.ts](../../packages/shared/src/forkMaintenanceAdmission.test.ts),
[forkMaintenanceStore.test.ts](../../packages/shared/src/forkMaintenanceStore.test.ts), and
[forkMaintenanceTransaction.test.ts](../../packages/shared/src/forkMaintenanceTransaction.test.ts) cover stale/unknown
participants, live ownership, launch races, five-minute idle windows, capacity, all-home snapshots,
WSL health failure, interrupted restoration, and the durable commit/write-admission boundary.
[Desktop maintenance tests](../../apps/desktop/src/maintenance/DesktopForkMaintenance.test.ts)
exercise its controller and startup recovery; [handoff tests](../../packages/shared/src/forkDesktopHandoff.test.ts)
exercise replacement after the recorded owner exits. Native guard/storage tests and isolated
`UpdaterSmokeInstrumentation` cover Android. Release suites bind required tests and package
receipts to the exact candidate commit and payload.

**UI maintenance.** [AppUpdateSettings.tsx](../../apps/web/src/components/settings/AppUpdateSettings.tsx)
and [ForkUpdateControls.tsx](../../apps/web/src/components/settings/ForkUpdateControls.tsx) own
client presentation; the state controller and host controller own requests. Shared presentation
keeps the phase, blocker details, and failure alert distinct so Settings does not repeat the same
status or error. Affected local homes use the client’s actual platform name; WSL homes keep
their separate distribution labels. Packaged updater identity requires the full source commit in
build metadata, even though the UI abbreviates it for display.
[HostUpdateSettings.tsx](../../apps/web/src/components/settings/HostUpdateSettings.tsx) presents
named environments in Connections. [hostUpdateBatcher.ts](../../apps/web/src/state/hostUpdateBatcher.ts)
serializes distinct replacement targets under their explicit coordinator ID and coalesces aliases
by the controller's affected-home identity; [its tests](../../apps/web/src/state/hostUpdateBatcher.test.ts)
cover aliases, separate homes, independent devices, offline results, and retry. Both sidebars
use [ForkSidebarUpdateStatus.tsx](../../apps/web/src/components/sidebar/ForkSidebarUpdateStatus.tsx),
and the application menu opens the canonical settings surface. Conversation notices use
[ComposerHostMaintenanceStatus.tsx](../../apps/web/src/components/chat/ComposerHostMaintenanceStatus.tsx).
Recovery and restored-automation review have separate dialogs and interaction tests. When these
surfaces move, update Settings search, navigation, both sidebars, user routes, and the relevant
interaction tests together. Electron/native/host services retain installation authority; UI adapters
do not duplicate admission logic.

## Keeping this guide accurate

Update this guide and the appropriate user/runbook/architecture page in the same change whenever
behavior, UI location, ownership, build requirements, or compatibility changes. Keep obsolete
instructions out of live guides. Link meaningful verification scenarios and tests; do not substitute
a file inventory for feature ownership. Before an upstream merge lands, check retained behavior,
shared contracts, both sidebars, all update entry points, APK origin boundaries, and operating docs.
Use isolated data/coordinator namespaces and Luna agents for delegated testing and review.
