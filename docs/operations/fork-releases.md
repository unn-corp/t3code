# Fork releases

How `unn-corp/t3code` builds, validates, publishes, withdraws, and recovers its own nightly and
stable releases. Upstream's [release process](./release.md) publishes npm, web, relay, AUR, and
announcement targets and is guarded off in this fork. The fork pipeline publishes only GitHub
releases in this repository. Device behavior (what an installation does with a release) is in the
[maintenance guide](./fork-maintenance.md) and the user [updating guide](../user/updating.md).

**Status.** The workflow, scripts, and tests are implemented. Scheduled publication waits for
`FORK_RELEASES_ENABLED=true`, the [baseline](#baseline), and the [commissioning checklist](#commissioning).
An explicit manual nightly with both `publish=true` and `commission=true` can publish a candidate for
hardware verification while schedules stay disabled. Required coordinator, updater, retained-runtime,
and recovery-helper checks still must all pass; missing or failed safety evidence blocks every release.

## What a release is

| Item           | Rule                                                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tag            | `fork-v<version>`. Never `v*`: upstream's release workflow triggers on `v*`.                                                                              |
| Stable version | Independent of upstream. First `1.0.0`, then the next patch. A version is consumed by a draft or withdrawn release too and is never reused.               |
| Nightly        | `<next stable>-nightly.<YYYYMMDD>.<run>`, for example `1.0.1-nightly.20261006.42`. Semver orders it below the stable it leads to.                         |
| Schedule       | Nightly daily at 07:23 UTC. Stable Sundays at 08:23 UTC.                                                                                                  |
| Stable source  | The newest nightly whose four checks were all true at least 24 hours ago and that is newer than the nightly the previous stable came from. Not telemetry. |
| Stable build   | Rebuilds the nightly's exact commit under the stable version; it does not rename the nightly's binaries.                                                  |
| Commit pin     | Nightly builds `github.sha`, fixed by GitHub when the run is triggered. A queued run keeps its own commit. Stable takes the commit from its source.       |

### Assets

Every release carries exactly these, all listed with `sha256` and `bytes` in `fork-release.json`
(the exact schema in `packages/contracts/src/forkRelease.ts`, which this pipeline never changes):

- Windows x64 NSIS installer (`T3-Code-<v>-x64.exe`), its blockmap, and the channel feed
  (`latest.yml` or `nightly.yml`).
- Linux x64 AppImage (`T3-Code-<v>-x86_64.AppImage`) and Debian package (`T3-Code-<v>-amd64.deb`).
  Both are `desktop` assets for `linux-x64`. Devices tell them apart by exact suffix
  (`forkDesktopAssetFor` in `packages/shared`), so a Debian install is never offered an AppImage.
  The AppImage blockmap and `<channel>-linux.yml` feed ship with them.
- Server archives for Linux x64 (`t3-<v>-linux-x64.tar.gz`) and Windows x64
  (`t3-<v>-win32-x64.zip`). The Windows installer embeds the Linux archive as its WSL runtime; the
  build records the digest of the file it embeds and assembly requires it to equal the shipped
  Linux archive exactly.
- Android: the normal APK and a recovery APK (see [Android](#android)).
- Recovery helper, one per platform (see [Recovery helper](#recovery-helper)).
- `SHA256SUMS` over the two server archives (the format the shell installers verify) and
  `fork-release.json`.

Windows signing is optional (Azure Trusted Signing secrets); Android signing is mandatory.

### Trust boundary

There is no separate signed index. A device trusts the GitHub HTTPS release origin, the platform
signatures on installers and APKs, and the digests recorded in `fork-release.json`. A digest
detects corruption and substitution after the manifest was written; it does not authenticate
who wrote the manifest. Do not describe hashes as authentication.

### Eligibility

A release is a candidate only if it is published (not a draft), not withdrawn, has a decodable
manifest whose tag matches its version, has every manifest asset at its recorded size, has all four
checks true, is not a duplicate of an earlier release of the same version or the same commit and
channel, and its recovery APK is a distinct source with a higher installation code and the same
signer. Devices never downgrade: stable devices take only stable releases, nightly devices follow
nightlies but take a stable that outranks them. The rules live in
`scripts/fork-release-policy.ts` and are tested there.

## Pipeline

`.github/workflows/fork-release.yml`, one run at a time (`concurrency: fork-release`, queued runs
kept, a publisher never cancelled):

1. **plan** pins the commit, version, tag, and predecessor, uploads the plan, and skips cleanly when
   there is nothing to release. It fails closed when there is no eligible predecessor and no
   [baseline](#baseline).
2. **reserve_android_codes** allocates one normal code and a recovery code for every frozen retained
   source identity (rehearsals read it and claim nothing). Published runs upload the allocation
   receipt; assembly rejects APK codes that differ from it.
3. **build_bundle**, **desktop_linux_x64**, **desktop_win_x64** (the reusable
   `release-desktop.yml`, GitHub-hosted runners, no relay, Clerk, or tracing configuration),
   **android**, and **recovery_helper** build from the pinned commit.
4. **assemble** verifies every artifact, feed reference, the embedded WSL archive, and both APKs,
   flattens the payload, and writes `SHA256SUMS`. It also downloads and verifies the predecessor.
5. **validate** runs install, update, and recovery on `linux-x64`, `windows-x64`, and `android`.
   **suites** runs the safety suites (below). Both write receipts.
6. **manifest** computes the four checks from the receipts and writes `fork-release.json`. It fails
   if any check is false.
7. **publish** is the only job that writes releases (with code reservation). It creates a complete
   draft, downloads every asset back and compares it with the manifest, rechecks that the tag,
   commit, and source nightly are still eligible, and only then publishes.

Orchestration scripts always run from the commit that defines the workflow. Builds, the recovery
helper, and the safety suites run from the pinned commit, and each confirms its checkout is exactly
that commit.

If the Windows CLI archive smoke check fails, the fork retains a `diagnostic-cli-win-x64` workflow
artifact for one day. Use it to reproduce the failed standalone binary in an isolated fixture;
it is excluded from release assembly, and the failed check still prevents publication. The artifact
contains packaged binaries only, with no fixture data or test logs. Run **Fork Windows CLI diagnostic**
on `main` with that failed run’s numeric `run_id` and exact `expected_version` to exercise the same
archive with current diagnostics on `windows-2025`. This manual job uses read-only repository/actions
permissions and an isolated home; its result is diagnostic evidence, not a release validation receipt.
The smoke probe requires an actual HTTP 200 within 90 seconds on a clean Windows runner or 30 seconds
on Linux. It reports startup elapsed time and redacts pairing credentials from failed startup output;
this cold-start allowance does not change coordinator activity or ownership deadlines.
Use **Fork Windows safety diagnostic** on `main` to rerun all three required Windows safety suites
with individual assertion failures retained for three days, plus the recovery helper's real
snapshot/restore proof. Select `scope: helper` to diagnose just that proof. It has read-only
permissions, produces no eligibility receipts, and does not allocate Android codes or rebuild
application payloads. Windows directory ACL setup has a bounded 30-second cold-start allowance;
failure still blocks startup or snapshot creation and does not loosen activity/ownership checks.
**Fork package diagnostic** takes a failed release's numeric `run_id` and runs current package
validation against its retained candidate and predecessor on clean Linux and Windows runners.
It writes no receipts and cannot publish. Use it to correct validation tooling before rebuilding.
Linux AppImage feeds retain electron-builder’s per-file `blockMapSize`. Assembly verifies the embedded
size trailer, raw-deflated block-map structure, and block ranges as well as the whole payload’s size
and digest. An absent external AppImage `.blockmap` is allowed when the map is embedded; a malformed
or mismatched embedded map blocks publication.
An intentionally skipped extra-recovery matrix must not skip validation or safety suites. Those jobs
use explicit prerequisite results, and **Verify release completion** fails if a planned candidate lacks
successful assembly, validation, suites, or manifest composition. Requested publication must also
succeed; rehearsals must leave publication skipped. A green build job alone is not a completed release.
It reserves no Android codes. A corrected candidate still needs the complete release workflow.

### Hardware commissioning rebuilds

Ordinary nightly planning skips a source commit that already has a nightly, including manual runs;
scheduled duplicate suppression stays in place. For the one hardware proof that needs multiple
release versions from the same source, use a manual `workflow_dispatch` for **nightly** with both
`publish=true` and `commission=true` while `FORK_RELEASES_ENABLED` is still false. The workflow only
admits that combination for publication. A source with no prior same-source nightly follows the
ordinary first-release plan and its verified predecessor or baseline. Repeating a source requires an
already published, fully eligible nightly for that exact pinned commit, binds its tag/version/commit
into the plan, uses it as the recovery predecessor, and rechecks that it remains the newest eligible
same-source nightly just before publication. A draft, withdrawn, partial, invalid, or concurrent same-source record blocks
the rebuild. Every normal build, recovery APK, signature, immutable tag, emulator/package check,
and release safety receipt still goes through the usual gates.

For the real update/recovery proof, publish normal A, then commissioning normal B from the same
source with a higher Android code. Install B, use its paired recovery APK to restore A, then publish
commissioning normal C from that source using a fresh workflow run. C is bound to B and retains
both B and A recovery identities. With C in the trusted feed, Resume on restored A must select and
install C at its higher code. This mode exists only to establish the hardware commissioning proof;
it does not enable scheduled publication. After the proof, use the normal release policy and enable
scheduled publishing separately.

### What each check means

`build` is true when assembly passed. `install`, `update`, and `recovery` are each true only when
both kinds of evidence exist for exactly this candidate. A missing, failing, substituted, or stale
receipt of either kind makes the check false, and a false check blocks publication.

Archive startup checks use private scratch homes and coordinator namespaces. Windows keeps its
OS ACL and PowerShell utilities available while excluding developer Node and provider directories
from the test process's PATH; removing those OS prerequisites prevents safe runtime registration.
Package validation uses the same isolated environment and startup deadlines. Linux validation
installs the desktop's required runtime libraries and probes AppImage's bundled Electron Node
runtime explicitly, without needing a display. Windows installers target the check's scratch
directory; package versions come from the installed `app.asar`, rather than another installation.
The immutable baseline has no Windows server archive: its verified NSIS payload's actual bundled
Electron and `server.asar` start the predecessor data home before replacement and after snapshot
restoration. Subsequent ordinary predecessors require their Windows server archive.

**Package validation** (`scripts/fork-release-validate.ts`, receipts bind to the payload digest and
the predecessor's digest):

| Target        | Install                                                                                                                                                                                         | Update                                                                                                              | Recovery                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `linux-x64`   | Server archive reports its version and serves; AppImage unpacks with updater config and its runtime version probe starts; `.deb` installs with updater config and the `deb` package-type marker | Predecessor then candidate `.deb` through dpkg, and the server archive replaced in place over a preserved data home | Candidate then predecessor `.deb`; predecessor binary and the pre-update data snapshot restored, later writes dropped       |
| `windows-x64` | Server archive serves; NSIS installer installs silently at the right version                                                                                                                    | Predecessor then candidate installer, then the same archive replacement                                             | Candidate then predecessor installer, then the same restore                                                                 |
| `android`     | Normal APK installs on an emulator and launches                                                                                                                                                 | Predecessor then candidate with `adb install -r`, same first-install time                                           | Android refuses the predecessor's lower code; the recovery APK replaces the candidate in place at the predecessor's version |

**Safety suites** (`scripts/fork-release-suites.ts`, run from a clean checkout of the pinned
commit, receipts bound to that commit and to the payload digest):

| Suite             | Targets                | Covers                                                                                                                                                                                      | Required by               |
| ----------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `coordinator`     | linux-x64, windows-x64 | Work admission and idle windows, the coordination store and fencing, multi-home snapshots, the update/recovery transaction and its commit boundary, the controller, and the recovery helper | install, update, recovery |
| `host-runtime`    | linux-x64, windows-x64 | Actual server registration, database startup fencing, work/restart admission, operator permissions, and launcher health boundaries                                                          | install, update, recovery |
| `desktop-updater` | linux-x64, windows-x64 | The desktop update state machine, channels, remote update flow, and adapters                                                                                                                | update, recovery          |
| `client-updates`  | linux-x64              | Shared client waiting and recovery controls, host capability guards, device grouping, Android bridge, upload admission, and restored automation review                                      | update, recovery          |
| `native-android`  | android                | APK verification, install guard and transaction, release manifest and client, eligibility, reconciliation, recovery cache, update store                                                     | update, recovery          |

The commands, the exact required test files and JUnit classes, and the check mapping are code, not
configuration. A receipt records a digest of its suite specification and a receipt for any other
specification does not count; every required file must have run at least one test and all must have
passed (none skipped). Removing or renaming a required test fails publication until the list is
changed in a reviewed commit.

**What this does not prove.** The package rows are external operations (dpkg, the NSIS installer,
`adb`, archive replacement). They show the shipped bytes install, upgrade in place, and roll back.
They are never the whole proof: no check can be true on them alone. The in-product path (stopped
agents, admission, snapshot, trial, health receipt, commit or restore) is covered by the coordinator
and updater suites, which exercise the transaction and controller logic against fixture homes and
runtimes. Android also has a real-emulator interaction gate for its WebView health, native recovery,
Settings holds, and local-work admission. It does not yet prove PackageInstaller confirmation or
process-death/reboot recovery. Drive the live update and recovery on
real hardware during [commissioning](#commissioning), and keep adding coordinator integration tests
to the `coordinator` suite's required list as they land.

## Android

- **Identity.** Package `com.devotek.t3code.pwa`, one signing key. `FORK_ANDROID_SIGNER_SHA256` pins
  the release certificate; every APK is verified against it with `apksigner` and `aapt2`, and must
  not be debuggable.
- **Installation codes.** A single serial counter across both channels. Each release reserves a
  contiguous range for its normal APK and all recovery APKs, above the highest published/draft code
  and prior reservation. The builder writes a durable `fork-android-code-range-<start>-<end>` tag,
  then atomically claims the canonical `fork-android-code-<start>` tag. The canonical claim
  arbitrates runs with different range lengths; a crash or losing race leaves its full range burned.
  **Never delete reservation tags.** Assembly checks each APK against the uploaded allocation
  receipt. Codes are checked against the 2,147,483,647 maximum.
- **Recovery APKs.** The manifest retains the primary predecessor plus the newest two eligible exact
  normal-build identities per channel and a required promotion source, deduplicated by version and
  commit. Each is rebuilt with `--kind recovery` and a unique code above the release normal code.
  Extra recovery builds use the current builder against the exact retained source checkout. The
  finite retained set guarantees recovery for those identities; deeper historical rollback and
  unpublished baseline upgrades may require manual bootstrap. Every recovery source must itself
  contain the updater, or the helper refuses to build it.
- **Build helper contract** (`scripts/build-android-pwa.ts`, owned by the Android developer). Each
  APK is built into its own `--output-dir` and the helper writes `metadata.json` beside it:
  `format 1`, `packageName`, `versionName`, `versionCode`, `sourceCommit`, `signerSha256`,
  `updaterProtocol`, `apkSha256`, `kind`, `assetName`, `bytes`. The workflow passes `--kind`,
  `--version-name`, `--version-code`/`--normal-version-code`, `--source-commit`, `--source-dir` (the
  predecessor checkout), `--expect-signer`, and `--asset-name`. The metadata is a claim: assembly
  re-reads package, codes, signer, and digest from the APK itself and only takes `updaterProtocol`
  from the sidecar.
- **Signing material** exists only inside the `android` job, in a private temp file removed in an
  `always()` step.

## Recovery helper

The release builder bundles `packages/shared/src/forkRecoveryHelperMain.ts` as
`t3-recovery-helper-linux-x64.mjs` and `t3-recovery-helper-windows-x64.mjs`. Each platform also
ships its matching Node runtime: `t3-recovery-node-linux-x64` or
`t3-recovery-node-windows-x64.exe`. These four assets carry recorded digests and sizes in the
manifest. The installer retains its platform's pair in owner-only recovery storage outside the
application directory and records the absolute runtime/helper paths in its recovery command.
Recovery does not require a system Node install or a working Electron installation.

The builder copies the Node 24-or-newer x64 runtime from the matching platform runner, bundles
all helper dependencies, and runs `--self-test` with that copied runtime from a neutral directory.
The helper must snapshot, modify, and restore isolated fixture data with the real coordinator
implementation, verify the result, and print `recovery-helper-protocol=1`. Missing implementation,
wrong platform, missing runtime, failed restoration, or a substituted protocol blocks publication.
Platform system libraries remain OS prerequisites; commissioning must execute the retained pair
on supported Windows, Linux, and Steam Deck installations with the main app unavailable.

### Recover a desktop without opening its main UI

Use the retained pair named in `<desktop data base>/maintenance/recovery/current.json`.
Its `nodePath` and `helperPath` are absolute paths outside the application. The desktop's
held-startup message also prints the command and retained install-plan path. Verify the pair
against the recorded release digests before running it; never download a replacement helper
from an unrelated origin. The first baseline may have no prior installer to restore.

Start with `status` and `options`. Supply the exact coordinator directory from the retained
install plan and, for Windows/WSL, the desktop's `maintenance/wsl-members.json`. Copy the
transaction ID, every home ID, and every restore timestamp from `options`; do not guess a cutoff.
These commands are templates: replace the recorded paths and identifiers before running them.
In PowerShell, put `&` before the quoted executable path.

```sh
"/recorded/nodePath" "/recorded/helperPath" status --coordinator "/recorded/coordinatorDirectory"
"/recorded/nodePath" "/recorded/helperPath" options --coordinator "/recorded/coordinatorDirectory" --members "/recorded/maintenance/wsl-members.json"
"/recorded/nodePath" "/recorded/helperPath" recover --coordinator "/recorded/coordinatorDirectory" --members "/recorded/maintenance/wsl-members.json" --transaction "RECORDED_TRANSACTION" --confirm "HOME_ID=RESTORE_CUTOFF" --confirm "WSL_HOME_ID=WSL_RESTORE_CUTOFF" --desktop-plan "/recorded/maintenance/handoff/RECORDED_TRANSACTION-install.json.consumed"
```

Use one `--confirm` per affected home; omit the WSL entry and `--members` when no WSL member
is recorded. The explicit confirmations authorize older data restoration. The helper rechecks
all activity, ownership, plan authorization, installers, cached runtime, and capacity before
mutation. It preserves a verified rescue copy of current data, restores every affected home
while admission remains held, and only then launches the previous binary's installer and runtime.
Exit zero means the handoff was launched; health verification and durable commit must still finish
before work is admitted. Restored automation stays held for its separate review and the build is pinned.

Both `.json` and `.json.consumed` retained install plans are accepted, but each newly authorized
handoff mode is usable once within its transaction. A copied plan cannot replace the application
after that transaction finishes. If launching the handoff fails after restoration, keep the fence
and use the exact `handoff --plan` command printed by the helper; do not restart unrelated runtimes,
delete the journal, or retry with an arbitrary installer. Missing or mismatched payloads fail closed.

Two prior verified builds have retained installers and restore points. Older journals can remain
for diagnosis or data-only recovery; their presence does not promise a usable prior binary. An
additional desktop instance with another home must close after its agents stop. Standalone,
development, and managed-service participants still block on activity, but their homes are excluded
from a desktop restore unless the transaction actually replaces their runtime.

## Baseline

The first updater-equipped build is installed by hand, so the first release has nothing to update
from or recover to unless it is recorded. The baseline is published as a release tagged
`fork-baseline` (never `fork-v*`, so no device or installer selects it) carrying
`fork-baseline.json`, a Windows installer, a Linux AppImage and `.deb`, the Linux server archive, and
the baseline APK under canonical names. It is used as the predecessor only until a pipeline release is
eligible.

The manual **Fork manual updater baseline** workflow in `.github/workflows/fork-baseline.yml`
builds the complete 1.0.0 baseline on GitHub-hosted Linux/Windows runners. Pin a full commit
already on `main` and a `fork-android-code-N` reservation owned by that commit. It uses the same
desktop packaging and Android verification as the release workflow. Publication is optional;
when requested it verifies a complete draft and downloads it back before publishing the
`fork-baseline` prerelease. A failed run removes only its own unpublished draft; published
baselines are never replaced. Draft lookup uses the releases list: GitHub’s tag endpoint can return 404
for an unpublished draft. This workflow has no schedule and writes no normal release manifest.
The first nightly previews 1.0.1 so it outranks the hand-installed 1.0.0 baseline; subsequent stable
promotion uses that same next-patch floor. A baseline does not satisfy normal release eligibility.
Pinned release builders supply `APP_BUILD_COMMIT` after source validation and package-version
alignment; that expected version edit must not label official artifacts as local source changes.
Desktop package metadata retains the full commit required by updater identity verification.

The published `fork-baseline` desktop packages predate that full-commit metadata fix and cannot
cache their previous installer through the normal release feed. Their terminal subscriptions also
prevent the idle window from completing. Bootstrap those desktops manually onto the first eligible
nightly after all local work has stopped; do not remove leases, alter the idle clock, or manufacture
an installed-build record. Prove desktop in-product update and recovery between eligible nightlies.
The baseline remains immutable and is still the recorded predecessor for package validation and
the first Android recovery APK. Its presence alone does not commission automatic delivery.

Registered participants must attest activity protocol 3. An older standalone/development runtime
can block a newer desktop even when its old status reports idle. Let all its work finish, verify
process termination, then update and restart that runtime manually; it never updates its own binary
automatically. A Windows parent verifies this marker in every WSL status response before relaying
idle state. Missing markers are bootstrap blockers, not permission to use legacy admission.
Failed or incomplete process reads preserve prior children. If the owner exits with unresolved
activity, the coordinator retains that uncertainty; a replacement runtime's own process census is
insufficient to clear it. Investigate the recorded owner and children before any external stopped-work
installation. Never remove leases or registry records just to make an update proceed.

1. Build the baseline from an updater-equipped commit and keep the same signing key as the phone's
   installed app. Never uninstall to bring a phone onto it.
2. Pack and prove it (needs the Android SDK build tools):

   ```bash
   node scripts/fork-release.ts baseline-pack --version <version> --commit <full-sha> \
     --windows-installer <exe> --linux-appimage <AppImage> --linux-deb <deb> \
     --linux-server <tar.gz> --apk <apk> --pinned-signer <sha256> --out baseline
   ```

   This copies the files under canonical names, writes `fork-baseline.json` with real digests, then
   verifies every byte and that the APK reports the recorded package, installation code, and signer. It
   writes `baseline.proof.json`; a non-empty `problems` list means do not publish.

3. Publish it as a prerelease named `fork-baseline` with the `baseline/` files as assets.
4. Re-verify any time with `node scripts/fork-release.ts baseline-verify --input baseline`.

The proof shows the baseline files are what they claim. It does not show the baseline installs; the
first rehearsal's update and recovery validations do, because they install the baseline and update from
it.

## Commissioning

Do these in order. Each is outside the repository.

1. **Variables and secrets** (repository settings):

   | Name                                                             | Kind     | Used by                        |
   | ---------------------------------------------------------------- | -------- | ------------------------------ |
   | `FORK_ANDROID_KEYSTORE_BASE64`, `FORK_ANDROID_KEYSTORE_PASSWORD` | secret   | `android` job only             |
   | `FORK_ANDROID_SIGNER_SHA256`                                     | variable | pinned release certificate     |
   | `FORK_ANDROID_KEY_ALIAS`                                         | variable | optional, defaults to `t3-pwa` |
   | `AZURE_*` Trusted Signing set                                    | secret   | optional Windows signing       |
   | `FORK_RELEASES_ENABLED`                                          | variable | leave unset until step 6       |

2. Turn on **immutable releases** in repository settings so published assets and tags cannot be
   replaced even by a mistake.
3. Publish the [baseline](#baseline).
4. Verify the recovery helper and its retained Node pair pass their self-test on both platforms.
5. **Rehearse.** Run the workflow manually from `main` with channel `nightly` and publish off. It
   builds and validates everything, writes `fork-release.json`, and publishes nothing; it also does not
   claim any Android code. Download the `fork-release-final` artifact and read the receipts. Repeat for
   `stable` once an eligible nightly exists.
6. **Hardware pass.** Manually run `nightly` with both `publish=true` and `commission=true` to
   publish a complete, validated candidate to the trusted GitHub feed. A rehearsal artifact or draft
   cannot be installed through the in-product updater. Keep `FORK_RELEASES_ENABLED` unset or false.
   On real Windows/Linux desktops, verify that active registered agents defer installation; let work
   finish normally before updating. On the phone, verify the foreground and local-operation guards.
   Exercise both in-product update and native/external recovery, preserving connections and data.
   This is the proof no automated check here provides.
7. Set `FORK_RELEASES_ENABLED` to `true`. Scheduled runs then publish, and a manual run publishes only
   with the `publish` input. Withdraw any bad release (below) and keep the variable unset to stop
   automatic publication.

## Operating

**Manual run.** Actions, Fork release, Run workflow, from `main`. `commit` (nightly only) must be on
`main`. `publish` defaults to off. Before automatic publishing is commissioned, only an explicit
nightly with both `publish=true` and `commission=true` may publish. This does not skip validation or
enable scheduled runs; stable publication still requires the commissioned gate.

**Withdraw or restore.** Actions, Fork release withdrawal, with the version and a reason. Withdrawing
rewrites only the release notes (a marker line) so devices and installers stop offering it; the tag,
assets, and manifest are untouched, and installations that already took it are not rolled back. A
publish in progress rechecks eligibility immediately before publishing, so a withdrawal made during the
build takes effect. Restore removes the marker only after every asset re-verifies against the manifest.
Releases are never deleted or overwritten.

**Diagnosing a failed run.**

| Failure                                            | Likely cause                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| plan: no eligible updater-equipped release         | No baseline published yet                                                                  |
| android: signing or signer pin                     | Secrets missing, wrong key, or `FORK_ANDROID_SIGNER_SHA256` not the release certificate    |
| recovery APK build: predecessor cannot be recovery | Predecessor lacks the native updater; publish a newer baseline                             |
| assemble: asset or feed problem                    | Missing or extra file, feed digest or size mismatch, embedded WSL archive differs          |
| recovery_helper: self-test or runtime failure      | Check the retained helper/Node pair, platform, digests, permissions, and restore self-test |
| validate / suites: red or missing receipt          | Read the receipt JSON in the `receipts-*` and `suite-receipts-*` artifacts                 |
| manifest: required checks not all true             | A receipt is missing, for other bytes or source, or for a different specification          |
| publish: no longer publishable                     | The tag or commit was taken, or the source nightly was withdrawn during the build          |

Artifacts are kept 7 days (candidate, receipts) and 1 day (JS bundle). Releases and reservation tags
are kept indefinitely. Devices keep two previous verified builds and their restore points.

## External and manual paths

- **Shell installers** (`scripts/install.sh`, `scripts/install.ps1`) discover `fork-v*` tags and
  validate `fork-release.json`, the checks, freshness, and `SHA256SUMS` before installing. They cannot
  see whether agents are active; use the in-product controls on a machine with running work. The Linux
  installer needs **Python 3** to validate the JSON metadata correctly.
- **Desktop update discovery.** electron-updater's GitHub provider assumes `v`-prefixed tags and
  cannot see `fork-v*`. Devices select releases from `fork-release.json` and download the exact asset
  it names; the `latest.yml` and `nightly.yml` feeds are published for completeness and verified at
  assembly, but are not what the fork's controller reads.
- **Cannot launch the app or APK.** Use the recovery helper for the host and the recovery shortcut for
  Android as described in the [updating guide](../user/updating.md). Reinstall manually from a
  verified release with the same signing identity; never uninstall the APK or clear its storage.
- **Pairing, drafts, queued work, and the signing identity** are preserved by every path above; a
  restore of an older database after writes were admitted is never silent.

## Verifying changes to this pipeline

Scoped checks only; the workflow itself is verified by a rehearsal.

```bash
cd scripts
vp test run --config ../vite.config.ts --dir . fork-release   # policy, assets, GitHub flow, suites, helper, validation, workflows
npx tsc --noEmit -p tsconfig.json
vp lint fork-release*.ts && vp fmt fork-release*.ts ../.github/workflows/fork-release*.yml
```

Run workflow lint before every publishing rehearsal. Focused workflow checks have passed locally; the GitHub runner rehearsal is still required.

Workflow lint uses actionlint 1.7.12. Its parser predates `concurrency.queue`; only that specific
diagnostic is excluded after checking [GitHub’s current concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
`queue: max` retains up to 100 waiting runs; excess runs are rejected by GitHub.

### Android interaction gate and fixture isolation

The Android install receipt also requires all eleven `UpdaterSmokeInstrumentation` scenarios
from the signed test APK built from the pinned candidate source. The test APK is a separate CI
artifact and is excluded from normal and recovery feeds. The validator requires
`FORK_VALIDATION_ANDROID_SERIAL=emulator-5554` (or another explicitly selected emulator) and
`FORK_VALIDATION_ANDROID_TEST_APK` naming that artifact; it rejects physical-device serials.
Each install/update/recovery check starts a fresh emulator package fixture, then verifies in-place
replacement within that check. This prevents the candidate installed by the preceding check from
making the next predecessor install an Android downgrade. Fixture resets apply only to the named
throwaway emulator. They are never part of a user update or recovery procedure.
