# Maintaining this fork

This guide owns the retained behavior of `unn-corp/t3code`. Follow the linked user guides for
operation and the implementation links when changing a feature. Upstream mobile in `apps/mobile`
is a separate Expo/store client; it does not build or update our APK.

The initial audit compared the committed fork with its recorded upstream integrations, including
`87eacfc6c4`, `01a14ef2bc`, and the tested integration at `01b0f9e896`. It also included the local
Android, browser-sharing, and documentation changes. An upstream merge is not evidence that every
fork feature shipped upstream. Recheck `git log --first-parent` and compare the fork with the full
upstream commit recorded in `fork-upstream.json` when revisiting ownership; avoid treating an old
merge-base file list or a moving remote branch as the current divergence.

## Integrating upstream

Follow the [mandatory merge rules](../../AGENTS.md#mandatory-rules-for-upstream-merges). Record the
pre-merge fork commit and pin the incoming upstream commit before resolving conflicts. Use the
feature sections below to trace every affected retained feature through its contracts, runtime
wiring, clients, persistence, and checks. Audit clean merges, moves, and deletions as well as
conflict hunks; missing startup wiring or a renamed service can break a feature without a conflict.

Upstream equivalents may replace fork implementations after equivalent behavior is verified on
the affected surfaces and connection modes. Update ownership links and required release-suite
paths when implementations move. Run focused checks against isolated data, obtain the independent
Luna reviews required by `AGENTS.md`, and update provenance and affected guidance in the same change.
Publishing and installing require the build, update, and recovery gates on that exact source;
hardware validation that has not run must remain explicit. Source integration must not disturb
running chats or enable scheduled releases.

Published migration IDs are compatibility identities. Follow the
[migration upgrade guide](../orchestration-v2/migration-upgrades.md) when upstream and fork histories
assign different schemas to the same ID, and retain the history-preservation and failure tests.
Never renumber installed fork history to make an upstream merge appear current.

The vendored `.repos` trees stay outside fork release checkouts. If an upstream reference tree
contains Git submodule entries, preserve their root-relative registration in `.gitmodules`, with
initialization disabled. GitHub checkout's credential cleanup traverses these entries even during
a sparse checkout; missing root metadata can stop every build before dependency installation.

## Product branding

The fork is named **Arcwright Code** across web, Electron, the standalone Android APK, and
Expo mobile variants. The transparent masters in [assets/arcwright](../../assets/arcwright)
own the wordmark and AC lightning mark; [the asset guide](../../assets/README.md) explains
regeneration and verification. Linux desktop registration uses content-derived icon filenames so KDE and other desktop caches do not retain a previous logo. Keep pre-ready and URL-handler registration on the same icon identity.

Header images, launchers, splash screens, notifications, and
widgets must use these shared outputs. Keep installed package IDs, signing identities, URL
schemes, legacy data folders, and recovery artifact names compatible when changing display names.
Installed Android, Windows and Linux application names are exactly **Arcwright Code**. Channel
and Arcwright build identity belong in About and App updates. Development desktops retain the
`(Dev)` label. Windows keeps its previous channel-specific executable filename so already
recorded updater/recovery handoffs still relaunch it; NSIS shortcuts and uninstall metadata use
the clean product name. Do not change those executable paths without a handoff migration.

## Android client

**Behavior and reason.** A standalone APK bundles the shared web client and native phone features.
It keeps environment pairing on the phone and primarily reaches hosts over Tailscale. Android does
not run the coding-agent server or a Tailscale daemon inside the APK.

**Entry points.** The Android launcher opens the conversation workspace and its mobile thread list;
the web index route keeps this APK behavior separate from the desktop's automatic draft landing.
Explicit notification routes and Android activity restoration retain their destinations.
Use Settings → Connections to pair each host. The Android
[guide](../user/android-fork.md) covers installation and everyday routes. The
[runbook](./android-pwa.md) owns signing, build commands, editing, and isolated verification.

**Ownership.** [MainActivity.java](../../apps/android-pwa/app/src/main/java/com/devotek/t3code/pwa/MainActivity.java)
owns the shell and origin boundary; [build.gradle](../../apps/android-pwa/app/build.gradle) and
[build-android-pwa.ts](../../scripts/build-android-pwa.ts) own packaging. The retained phone automation host uses the native bridge and server broker; desktop browser
automation uses upstream's `DesktopBrowserHost` channel rather than the retired renderer automation
IPC. When updating browser contracts, check both paths and keep temporary Tailscale shares
under the one-hour idle lease. Shared connections live in
[client-runtime](../../packages/client-runtime/src). Web native adapters live in
[android](../../apps/web/src/android).

**Verification and coupling.** The native browser instrumentation and Java unit tests described in
the runbook cover release APK behavior. Test in-place, same-key installation and preserved
connections, system permission changes, cover/unfolded dimensions, and live resize. Changes to
shared Settings or client-runtime require an APK rebuild. Never uninstall to upgrade; losing the
signing identity prevents normal in-place replacement.
Pairing QR scanning uses the bundled web client and the shell's existing camera permission
boundary. Verify desktop QR decoding, permission denial, and camera release on cancellation;
check the camera on a phone before commissioning the APK.

## Phone alerts

**Behavior and entry.** Settings → General → Android notifications controls system notifications
and background host connections. The APK maintains authenticated host WebSockets through a native
foreground service; it does not use upstream cloud push delivery. Automatic alerts are suppressed
while any client on a mutually paired environment remains visible on an awake display. Focus and
input inactivity do not release suppression. Hidden/minimized/sleeping clients do; consumed alerts
do not replay later. Updater confirmations and explicit Send test remain available.

**Ownership.** [NativeNotifications.java](../../apps/android-pwa/app/src/main/java/com/devotek/t3code/pwa/NativeNotifications.java),
[AgentNotificationService.java](../../apps/android-pwa/app/src/main/java/com/devotek/t3code/pwa/AgentNotificationService.java),
and [NotificationCredentials.java](../../apps/android-pwa/app/src/main/java/com/devotek/t3code/pwa/NotificationCredentials.java)
own permission, alert lifecycle, and encrypted credentials. The
[Android notification runbook](./android-pwa.md#background-alerts) covers operational limits.

Connection-service refreshes must not repost healthy status notifications. The
[connection status tests](../../apps/android-pwa/app/src/test/java/com/devotek/t3code/pwa/ConnectionNotificationStateTest.java)
cover repeated refresh, healthy host changes, loss/recovery, and required service startup.

**Verification and coupling.** Test completion/input/failure while locked, notification tap to the
correct environment/thread, denied permission, lost connectivity, and duplicate suppression.
[NetworkNotificationPresenceTest](../../apps/android-pwa/app/src/test/java/com/devotek/t3code/pwa/NetworkNotificationPresenceTest.java),
[PhoneAlertQueueTest](../../apps/android-pwa/app/src/test/java/com/devotek/t3code/pwa/PhoneAlertQueueTest.java),
and [ClientVisibility.test.ts](../../apps/desktop/src/notifications/ClientVisibility.test.ts) cover
cross-host lease expiry, reconnect waiting, stale alerts, unfocused visible windows, and native
Windows display notifications. Desktop `ClientVisibility`, web `backgroundActivityReporter`, and
native `NetworkNotificationPresence` own the suppression boundary. Verify minimize/restore and
screen sleep on each OS; missing Linux display APIs and browser PWAs retain conservative visibility.
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
cleanup. Desktop/headless automation and recordings now use the host's
[ServerBrowser.ts](../../apps/server/src/preview/ServerBrowser.ts) and desktop CDP channel.
Desktop page text insertion belongs to the attached tab's WebContents, without switching the
visible tab or desktop focus. [DesktopBrowserHost.test.ts](../../apps/desktop/src/preview/DesktopBrowserHost.test.ts)
covers two-tab draft isolation and failed insertion without retrying into another guest. Root
keyboard events require that same guest to have desktop focus; otherwise they fail with instructions
to select the requested tab or operate its DOM controls, without moving focus or replaying input.
The server encodes recordings, enforces the attachment size limit, and persists conversation
attachments; the retired Electron renderer upload helper is no longer an admission boundary.
[ServerBrowser.test.ts](../../apps/server/src/preview/ServerBrowser.test.ts) covers broker routing and
persisted recording bytes and is required by the host-runtime release suite. The phone host retains
its separately advertised native operations and does not advertise recording support.
[RpcAuthorization.ts](../../apps/server/src/auth/RpcAuthorization.ts) and
[forkExtraWs.ts](../../apps/server/src/forkExtraWs.ts) share the host admission rules: browser host
registration checks admission when attached; browser commands, element picking, frame writes, and
session resume hold work leases until they finish. The [admission tests](../../apps/server/src/auth/RpcAuthorization.maintenance.test.ts)
cover this observer/work boundary. The [Android runbook](./android-pwa.md) documents routing and deployment.

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
Grouped repository grips use
[Sidebar.repositoryDrag.ts](../../apps/web/src/components/Sidebar.repositoryDrag.ts) and the
shared pointer lifecycle. Drop destinations include each group's heading, active conversation
rows and adjacent viewport padding; touch grips are larger without changing the sidebar width.
Touch and keyboard reordering persist through the existing local project-order store.
The legacy sidebar retains its dnd-kit project sorting. Keep repository destinations distinct
from thread state drops, and cancel a pending gesture when search replaces the list or a window
resizes. [Repository gesture tests](../../apps/web/src/components/Sidebar.repositoryDrag.test.ts)
cover physical members moving together, release positions, clicks, and interrupted gestures.
The empty-draft headline in [ChatView.tsx](../../apps/web/src/components/ChatView.tsx) participates
in layout with the composer: the whole stack centers when it fits and scrolls below the header
when the keyboard reduces available height. Fixed header controls share the safe-area top inset
with the flow header; breadcrumb space must reserve the full control cluster. Verify long
project/thread names, short keyboard-sized viewports, and the mobile sidebar wordmark alongside
the existing cover/unfolded resize checks.
[OpenWhisprVoiceInput.tsx](../../apps/web/src/components/chat/OpenWhisprVoiceInput.tsx)
uses the shared client-operation guard; its [interaction tests](../../apps/web/src/components/chat/OpenWhisprVoiceInput.test.tsx)
cover denied admission, cancelled permission acquisition, and pending transcription.
Desktop preview annotations use the same recorder in
[PreviewAnnotationEditor.tsx](../../apps/web/src/components/preview/PreviewAnnotationEditor.tsx).
The app-root modal owns a frozen screenshot and extracted element metadata, independently of the
preview tab's navigation or lifetime. The typed snapshot IPC captures both in the desktop process;
the inspected page never owns the editor or microphone. Keep the draft, original thread, marks,
and comment in the IndexedDB-backed [editor store](../../apps/web/src/previewAnnotationEditorStore.ts)
so app reloads restore completed captures. Escape, backdrop clicks, and Close request discard
approval; only explicit discard or successful attachment/submission clears the session. Capture
and attachment failures must leave the modal open. Unmounting cancels dictation and late transcripts
cannot update another session. Keep capture, persistence, dismissal, and send regression tests
alongside these modules.

Preview-page microphone permissions are separate from the annotation editor's recorder.
[MicrophonePermission.ts](../../apps/desktop/src/preview/MicrophonePermission.ts), installed by
[BrowserSession.ts](../../apps/desktop/src/preview/BrowserSession.ts), prompts only for top-level,
audio-only requests from any HTTP(S) webpage origin. Chromium's secure-context requirements
still apply. Keep each origin's saved choice independent and preserve legacy loopback choices.
Both Electron handlers enforce the exact requested origin and media type; video, mixed requests,
and subframes remain denied. Store Allow/Deny in the partition's own storage directory, keep
incognito choices in memory, and reset choices during profile site-data clearing. Reject opaque
and non-web origins. Keep profile isolation, persistence, navigation-during-prompt, and
camera-denial checks in [MicrophonePermission.test.ts](../../apps/desktop/src/preview/MicrophonePermission.test.ts).

**Verification and coupling.** Keep the corresponding component, pointer, drag, and draft tests
with these modules. Verify keyboard and touch interaction, one Send/microphone/prompt, opening
sidebar without width jumps, drafts across collapse, reduced motion, screen readers, and live
fold/unfold resize. Upstream composer/sidebar refactors can incorporate equivalent fixes; compare
actual behavior before reapplying a patch. Shared web changes ship in desktop/PWA and only reach
Android after rebuilding its bundle.

The APK native container zeroes handled bars/cutout/IME insets before forwarding updates to WebView;
see [shell inset maintenance](./android-pwa.md#shell-insets-and-folded-layouts). Verify native header
alignment and keyboard hide after live fold changes as well as browser viewport tests.

## Direct message replies

**Behavior and ownership.** Web/desktop and the fork Android web bundle expose
right-click/touch Reply, a persisted composer quote, and a focused reply-thread
dialog. [MessageReplies.tsx](../../apps/web/src/components/chat/MessageReplies.tsx)
and [messageReplies.ts](../../packages/shared/src/messageReplies.ts) own the UI
and graph traversal. V2 message context holds links; the event sink links assistant
output, and `t3_message_reply` lets live agents choose earlier user messages.
The [composer guide](../user/composer.md#reply-to-a-message) describes use and the
[internals guide](../internals/composer-context-references.md#direct-message-replies)
describes persistence and bounded history reads. React Native UI is uncommissioned.

**Verification and coupling.** Keep reply graph, composer persistence, UI action,
SQL pagination/index, canonical target, queued edit, cycle rejection, provider
projection, and MCP ownership tests with this feature. New paired hosts must ship
the reply-chain RPC and MCP tool. Compare upstream reply semantics before merging
future context, timeline, composer, and tool refactors; do not drop assistant
context or flatten a focused thread into the whole transcript.

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

Top-level automatic-work policies in Settings → Automation default off, including scheduled
repository review, Continuous Improvement, product opportunity discovery, Decision Follow-up,
pull request rollups, and inactive worktree cleanup. Preserve explicitly saved opt-ins when
decoding settings; manual dashboard actions remain available while scheduled automation is off.

**Verification and coupling.** Domain tests cover durable authorization, budgets, stopped work,
reconciliation, review/implementation scheduling, and credential redaction. Test new schedulers
against device maintenance fencing and the persisted restored-automation review hold; the server
runtime context must carry its singleton admission service into server-scoped layers. Keep the
[automatic security scheduler](../../apps/server/src/agentDashboard/AgentDashboardSecurityScheduler.test.ts),
[review worker](../../apps/server/src/agentDashboard/AgentDashboardReviewJobService.test.ts),
[activated Organization work](../../apps/server/src/organizations/OrganizationLiveWorkExecutor.test.ts),
and [maintenance policy](../../apps/server/src/maintenance/MaintenanceCoordinator.test.ts)
regressions with their domain suites.
Provider-role/model defaults and upstream orchestration event changes require reviewing adapters
and contracts. Restoring old data must not silently replay schedules, queues, or standing work
authorization.

## Experimental Codex Cloud integration

**Behavior and delivery.** A compatible T3 server inside a Codex Cloud VM supports
ordinary environment-local conversations through a private HTTP/WebSocket route.
Live Squidhub commissioning verified Claude and owner-only Personal Codex chats;
clarity-relay also verified independent Personal sign-in, completed Codex turns,
and conversation persistence across a Browser reload. Unnamed and Work remain
uncommissioned. Tunnel provisioning and VM lifecycle remain experimental, and
pairing a test Browser does not pair the user's desktop profile. See
[user setup](../user/cloud-environments.md) and
[network architecture](../internals/remote.md#cloud-vm-environments).

The [Linux VM setup helper](../../scripts/cloud-environment.py) initializes only
a fresh private home with the verified fork installer and runs the native service
launcher without an OS service manager. It enables existing per-host maintenance
controls; `setup` combines fresh initialization and managed launch, while
status/update/auto-update call the same authenticated operator controller.
`setup/init --repository` with the account list and confirmed owner derives
`repository (Owner) — Codex Cloud`; `--name` accepts an explicit name instead.
Both store a repository label, passed as `T3CODE_ENVIRONMENT_LABEL`
to the launcher and every restarted runtime. Server descriptor naming resolves
that override before host discovery, leaving the persisted environment ID intact.
It requires delivery of the updated server label resolver as well as the helper;
older release archives still publish their discovered hostname.
`export-accounts` reads a source settings file and exports only Codex provider IDs,
labels, and enabled preferences. `setup/init --accounts` requires a confirmed
`--owner-account` ID and seeds only that owner by default, including its new-chat
and text-generation selections. `--include-account` explicitly opts additional
IDs into fresh setup; later additions use the existing Providers flow. When the
default `codex` slot is not selected, its legacy configuration is disabled so
registry hydration cannot silently add an enabled ambient-login provider. All
selected entries use a VM-local shared workspace home; separate browser sign-ins and
the existing protected provider credential stores own their sessions. No host
paths, environment variables, or credentials are exported. Subsequent starts
preserve provider changes. The helper's tests cover export privacy, malformed
lists, owner selection, explicit extras, fresh seeding, and refusal to rewrite
configured homes. An isolated live Squidhub VM verified owner-only Personal
selection, independent managed browser sign-in, a completed GPT-6-Luna turn,
and a follow-up after pairing through the private route. Unnamed, Work, and
multi-account Codex authentication and inference remain uncommissioned.
Client environment naming belongs to the shared connection catalog and its
web/desktop/fork Android Connections menu and upstream mobile details. Overrides
are device-local presentation data, survive discovery/route refresh, and never
replace the registry's live connection target. Server naming remains the default
for clients without an override. Removing a saved environment forgets its name.
Fresh cloud homes seed the native update policy with automatic installation on
(or `init --auto off`), without confirming bootstrap review. Later policy changes
persist through that controller, retain pins and all activity blockers, and are
never rewritten by a subsequent start. It never
replaces an existing home, fabricates launcher context, or bypasses activity,
snapshot, trial, health, or recovery admission. Verify its fresh-home refusal,
recorded-version selection, duplicate-start lock, and owned-process shutdown with
`python3 scripts/cloud-environment.test.py`. Initial managed-launch commissioning
used isolated Linux state; transition of the existing Squidhub server and a live
cloud binary replacement remain uncommissioned. See
[cloud environment updates](../user/updating.md#cloud-vm-environments) and the
[Codex Cloud setup runbook](../user/cloud-environments.md). Reusable image preparation
and task startup are documented separately; tunnel provisioning, client pairing,
and account/VM lifecycle automation remain uncommissioned.

Native Linux server startup also provisions the detached Organization launch
broker. Preserve its bootstrap in `cli/server.ts` and command registration in
`binCli.ts`; the launcher cannot quiesce scopes without it. Keep the native broker
CLI/quiescence regression in `OrganizationScopeLaunchBrokerCli.test.ts` and guarded
older-home provisioning tests in `maintenance/scopeBrokerBootstrap.test.ts` with
release update verification. The supported `maintenance scope-broker` operation
uses a verified corrected CLI only to provision that broker for an existing idle
managed home; it does not install that CLI's build or relax update admission.

**Ownership and verification.** The [managed setup helper](../../scripts/cloud-environment.py)
owns fresh VM setup and managed launch. Ordinary environment connections and
provider adapters own pairing, account isolation, conversation execution, and
maintenance admission. The former Cloud tasks panel, controller worker service,
and their RPC/MCP transports have been removed. Existing saved controller data
is not migrated into VM conversations or deleted from installed data homes.
Run the helper's focused tests and normal connection/provider suites when changing
these paths. Do not commission by starting a development server against the
installed T3 data home.

## Checkpoints and model compatibility

**Behavior and reason.** Fork fixes avoid rehashing Git LFS files while capturing checkpoints,
recover stale Codex shadow-home entries, and support the fork's configured model/role shapes.
T3-owned Git subprocesses share a budget of eight total commands and two heavy commands, with
heavy commands serialized per checkout, including commands with extended or unlimited deadlines.
Automatic status refreshes pause under storage pressure and can be disabled per project.
Checkpoints can be disabled independently, preserving existing rollback points; this removes
file rollback and automatic change summaries for new turns. These controls ship in web, desktop,
the fork APK's web bundle, and upstream mobile. Rebuilding the APK is required to deliver them there.

**Ownership and verification.** [checkpointing](../../apps/server/src/checkpointing) owns repository
state; [provider](../../apps/server/src/provider) and
[orchestration adapters](../../apps/server/src/orchestration-v2/Adapters) own provider compatibility.
Run the relevant checkpoint/provider regression tests when syncing upstream. Model availability
comes from the live provider catalog, not a documentation snapshot. Confirm whether upstream has
incorporated equivalent behavior before retaining compatibility patches.
`ClaudeAdapterV2` continuation turns drain the wake buffer before the turn becomes active and stop
replaying once a live result has closed the turn; otherwise a race leaves an agent-created run
`running` forever and every follow-up message stays queued. Keep the wake-race regression test.
The Git budget and refresh policy are owned by [vcs](../../apps/server/src/vcs) and
[background](../../apps/server/src/background); checkpoint policy is enforced by the V2
[CheckpointService](../../apps/server/src/orchestration-v2/CheckpointService.ts). Retain their focused
budget, pause/recovery, inheritance, and checkpoint-disable tests when syncing upstream. These
limits cover T3-owned commands; provider shells and other applications have separate process owners.

## Conversation evidence retention

Conversation evidence media uses chat-read authorization and signed exact-file URLs on the
connected environment, including Tailscale. The server validates the physical per-conversation
directory before signing; other host media continues to require filesystem-read permission.
Keep these boundaries covered in `AssetAccess.test.ts`, `RpcAuthorization.test.ts`, and
the client's asset URL and media routing tests.

**Behavior and entry.** Settings → Storage → Conversation evidence controls environment-wide
cleanup when a conversation is archived or its evidence reaches the chosen age. Both policies
start disabled. Saved agent browser screenshots and claimed recordings are owned by their
conversation. Agents receive instructions and the `t3_evidence_directory` tool for other temporary
outputs; arbitrary shell writes are not redirected. Permanent deliverables belong outside this
storage. Legacy browser captures and desktop-local recording copies retain their separate policy.

**Ownership and coupling.** [ConversationEvidence.ts](../../apps/server/src/assets/ConversationEvidence.ts)
owns safe per-conversation paths and file capture; [storageCleanup.ts](../../apps/server/src/storageCleanup.ts)
owns retention and waits for active runs, background tasks, and shell processes to stop. Cleanup
sweeps use the host admission lease, and evidence is included in update restore points and rescue copies. Shared
[Storage settings](../../apps/web/src/components/settings/StorageSettings.tsx) reach web, desktop,
and the fork APK; the APK needs a rebuilt web bundle. Upstream mobile has its own Storage route.
Older hosts omit the capability and do not receive evidence settings. Existing installations need
an updated host before captures use the new storage.

**Verification.** [Evidence service tests](../../apps/server/src/assets/ConversationEvidence.test.ts),
[cleanup tests](../../apps/server/src/storageCleanup.test.ts), and the MCP preview/registration tests
cover conversation ownership, upload retries, archive and age policies, busy-thread protection,
and safe cleanup boundaries. Deleted conversations remain eligible for age cleanup. Removing
files invalidates their evidence links; unarchiving cannot restore them. Uploaded message
attachments, conversation history, and project files remain outside these policies.

## Discord bridge

**Delivery and entry.** The host server can mirror linked agent threads to Discord and accept
messages from configured author IDs. It is configured only through the server's
`discordBridge` settings and secret store; there is no client Settings screen. The bridge runs in
the server process, including when the operator reaches that host over Tailscale. The
[Discord guide](../internals/discord-bridge.md) documents token storage, channel permissions,
allowlists, REST polling, and the activity data sent to Discord.

**Ownership.** [DiscordBridge.ts](../../apps/server/src/discord/Layers/DiscordBridge.ts) observes
committed v2 events and runs the inbound poller; [DiscordRestClient.ts](../../apps/server/src/discord/DiscordRestClient.ts)
owns REST requests; [DiscordBridgeLinks.ts](../../apps/server/src/persistence/DiscordBridgeLinks.ts)
persists thread links, message chunks, and inbound cursors. The bridge applies the shared
maintenance and restored-automation admission policy to each outbound write and inbound message.
Outbound events waiting on maintenance are retained only in the serial in-memory queue and are
lost if the host process restarts before they run.

**Verification and coupling.** [DiscordBridge.integration.test.ts](../../apps/server/src/discord/Layers/DiscordBridge.integration.test.ts)
uses the actual SQLite link repository to verify the durable cursor survives dispatch failure,
maintenance holds block both inbound and outbound writes, and a held outbound item retries after
admission reopens. Keep oldest-first polling from moving the cursor past an unconsumed message.
This is host functionality, not an APK or cloud-push feature.

## Updates and recovery

Maintenance uses the `active-runtime` projection selector; restart recovery keeps
`runtime`, which also reconciles ready provider sessions. A ready session alone is
not active work. Keep one shared `IdleProcessRoots` service at server scope so
spawn sites and the collector use the same exact PID/creation identity registry.
Only a verified provider root is exempt: terminal shells, unregistered helper
children (including a lingering code-mode host), reused PIDs, and unknown process
observations still hold installation. A completed turn does not prove those
children have exited; never stop sessions or clear their records to obtain admission.

GitHub feed rate limits are different from ordinary network failures. Respect the
controller's `nextCheckAt` for desktop automatic checks; four-minute wakeups do not
override the normal four-hour feed cadence or failure backoff. Explicit checks can
run sooner unless GitHub's enforced cooldown is still active. Respect the
advertised reset time and `Retry-After` delay, keep the staged artifact, and report
an offline blocker while the cooldown is active. Repeated manual checks and install
requests must not consume more requests during that period. Installation still
requires a fresh eligible release listing afterward; cached metadata never admits
an update when the release origin cannot be checked.

### Resolve an unknown orphan after offline verification

An orphan created by an incomplete process census can remain blocked even when no child PID was
recorded. Use this procedure only for recovery from an already stopped runtime, never to stop live
agent work to make an update proceed. When their work has finished, exit every T3 client and
server on the device, then inspect the local coordinator records:

```sh
t3 maintenance orphans --json
```

Check the recorded owner identities, every listed child, and any active transaction fence. Also inspect
the host process list and verify there is no unrecorded T3, provider, terminal, or agent work. The
attestation command rechecks that the exact owner and every registered runtime owner have exited, that
known children are gone, and that no transaction fence is active. It removes only the named orphan.
An unknown-identity child PID must be absent; a reused or still-running PID is refused. A stale owner
identity, missing confirmation, unreadable process identity, or any live runtime is refused.

Copy `id`, `owner.pid`, and `owner.started` for the exact orphan from the JSON output, then type the
required acknowledgment exactly:

```sh
t3 maintenance attest-orphan \
  --participant 'PARTICIPANT_ID' \
  --owner-pid OWNER_PID \
  --owner-started 'OWNER_CREATION_IDENTITY' \
  --confirm 'I checked for unrecorded processes'
```

This command never terminates a process or removes a transaction fence. If work is still active, wait
for it to finish. If process identity cannot be read, keep the device blocked and resolve the host
problem before retrying.

**Ownership.** Additive wire contracts live in
[maintenance.ts](../../packages/contracts/src/maintenance.ts). Host ownership, activity admission,
and durable transaction boundaries live in [maintenance](../../apps/server/src/maintenance).
[AppUpdateSettings.tsx](../../apps/web/src/components/settings/AppUpdateSettings.tsx) is the desktop
client's canonical update control; About shows identity. Browser cache reload belongs to
[PwaAppUpdateSettings.tsx](../../apps/web/src/components/settings/PwaAppUpdateSettings.tsx) and is
hidden in the APK because it cannot replace native code. Release history and CLI installers target
this fork.

**Arcwright version ownership.** The displayed T3 base comes from
[`fork-upstream.json`](../../fork-upstream.json); the separate Arcwright counter identifies
our build. [`buildVersion.ts`](../../packages/shared/src/buildVersion.ts) owns shared labels,
with the native equivalent in `VersionLabels.java`. Keep compatibility checks separate from
installer ordering and fork release availability. Maintain provenance when integrating upstream,
and retain immutable historical installer identities. See
[version provenance and history](./fork-releases.md#version-provenance-and-history) for build
ownership, label tests, and release-title cleanup rules.

**Implementation and commissioning.** Coordinator services, multi-home transactions, desktop
and Android controllers, shared UI controls, native recovery, external recovery helpers, and fork
release workflows are implemented with focused verification. The initial fenced journal is durably
written under the coordinator lock before the registry publishes its fence; a journal left by an
interrupted fence acquisition is inert, and an unexplained fence remains blocked. A complete signed manual baseline is
available; automatic publishing and production rollout remain uncommissioned. The release rehearsal and hardware update/recovery checks must pass
before enabling automatic publishing. Existing installations need the known-good updater baseline
and explicit device bootstrap before participating. A successful source test is not a hardware
installation receipt.

Desktop activity reporting is owned by
[maintenancePolling.ts](../../apps/desktop/src/maintenance/maintenancePolling.ts), started by
`DesktopForkMaintenance`. Its observation loop must remain independent of serialized updater
actions: installation waits for a fresh post-fence observation from the desktop itself. The
[polling regression tests](../../apps/desktop/src/maintenance/maintenancePolling.test.ts) hold
the controller busy beyond the stale threshold and verify both acknowledgement and detection of
new work. Include this scenario when changing updater scheduling or admission.

`maintenanceCore` also records both committed updates and verified recoveries in the installed-build
identity. Recovery must adopt the journal's predecessor digest and increment the installation sequence;
the record is outside restored userdata. Verify that the current digest matches the recovery pin and
that Resume retains the separate automation-review hold.

The native Android recovery screen also opens a pending Android installation confirmation directly.
`RecoveryActivity`, `UpdateEngine`, and `UpdateNotifications` own this route. Verify it with both
normal and recovery APKs, including a dismissed notification and a restarted app process; the
button must open the existing app-owned installer session and must never submit another install.

While an Android installation request waits, native `UpdateEngine.statusTarget` must name the
exact requested artifact, including a cached rollback when a newer normal update is staged. The
web adapter disables a second install action until that request finishes or is cancelled. Keep
[UpdateEngineStatusTargetTest.java](../../apps/android-pwa/app/src/test/java/com/devotek/t3code/pwa/UpdateEngineStatusTargetTest.java)
and [updates.test.ts](../../apps/web/src/android/updates.test.ts) in the release verification for
selected-target identity and pending-request controls.

Android updater persistence belongs to `UpdateStore`. Its backup must be written separately while
the committed primary stays readable, then the new primary is atomically renamed over it. Package
replacement can terminate any lifecycle write; moving the primary away before committing the new
file produces a false corruption hold. `UpdateStoreTest` verifies interrupted commits preserve the
installer session and recovery pin. See [state and restart verification](./android-pwa.md#state-pins-and-restart-verification).

The native recovery page can also discard explicitly confirmed orphaned Android installer
sessions after backup recovery. `InstallerSessions` and `InstallerSessionsTest` own identity,
ownership, inactivity, and stale-dialog checks; `UpdateEngine` revalidates before cancellation.
This repair leaves the safety hold and update policy paused until the normal reboot/settings review.

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
and the application menu opens the canonical settings surface. Host notices and machine
compatibility/update actions live in the shared sidebar footer through
[SidebarHostUpdateNotices.tsx](../../apps/web/src/components/sidebar/SidebarHostUpdateNotices.tsx),
including remote web/APK environments. The composer and conversation details do not render
update cards. Host notices use the selected thread/draft environment, falling back to the primary
environment outside a conversation; the machine list retains independent update targets.
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

## Copy-on-write worktrees

The CLI `t3 update` adapter in
[`coordinatedUpdate.ts`](../../apps/server/src/maintenance/coordinatedUpdate.ts) uses the running
home's operator credential and maintenance controller. It cannot install from an unrelated release
index, repoint a launcher independently, or use a legacy service restart as a fallback. Maintain
[`CLI admission tests`](../../apps/server/src/cli/update.test.ts) in the host-runtime release suite.

**Delivery.** Implemented in source; desktop and APK release delivery has not been commissioned.

**Behavior and entry.** Settings → Source control → Space-efficient worktrees is an opt-in
server setting. The host probes mandatory file cloning on the worktree filesystem; incompatible
hosts show a disabled control with the reason in web, desktop, the fork APK, and upstream mobile.
A clean checkout base shares unchanged data across new worktrees. Existing worktrees are not
converted, and engine caches remain separate.

**Ownership.** [WorktreeStorage.ts](../../apps/server/src/vcs/WorktreeStorage.ts) owns filesystem
probing, the per-repository checkout cache, and cached disk measurements. The glance rail
requests active-worktree usage only while open, on the thread's environment. Btrfs uses optional
unprivileged `btrfs-progs` for exclusive/shared data; other filesystems use labeled allocation
estimates (Windows uses logical file size). Shared Git objects are outside this measurement.
[GitVcsDriverCore.ts](../../apps/server/src/vcs/GitVcsDriverCore.ts)
initializes independent Git indexes and reconciles the base with the requested tree for UI,
MCP, and background creation paths. The shared client compatibility rule uses the selected
server's advertised support, never the client device's filesystem.

**Verification and coupling.** Focused storage and Git worktree tests cover clean indexes,
cross-commit deletions, independent edits, tracked-only caching, cache replacement, and unsupported
hosts. Custom checkout filters and external attributes bypass reuse; submodule initialization
continues through Git. Shared web changes require rebuilding the fork APK to ship there.
