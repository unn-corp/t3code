# Codex Cloud environments in T3

Use a cloud task's VM as a T3 environment to start ordinary Codex or Claude chats that work
in its repository. The VM owns the files, provider session, conversations, and
checkpoints. This integration is experimental. The server setup is scripted;
the private outbound tunnel and task lifecycle still require an operator.

Follow the [user provisioning flow](#user-provisioning-and-handoff), then
[prepare tools](#prepare-reusable-tools-before-publishing),
[start the server](#start-a-task-and-run-the-server), and
[commission the route and devices](#agent-commissioning-and-device-checklist).
Finish with the [handoff record](#final-handoff-record). For an existing connection,
use [reconnection and renewal](#reconnection-renewal-and-replacement).

## Naming and account defaults

Use **`repository (Account) — Codex Cloud`** for the published ChatGPT environment
and its T3 connection. Examples: `Squidhub (Personal) — Codex Cloud`,
`clarity-relay (Personal) — Codex Cloud`, and `api (Work) — Codex Cloud`.
Use the GitHub repository's actual name and the owning account's T3 display name.
For duplicate repository names, qualify the repository with its GitHub owner in
the manually chosen name. Add a task suffix after `Codex Cloud` only when several
VMs from the same published environment must run at once.

The account in the name identifies who owns the published Cloud environment.
Only that Codex account is prepared by default. If the user requests more
accounts, prepare exactly that list and record one default chat account; multiple
configured accounts do not mean multiple simultaneous defaults. The helper
initially selects the owner. If a different configured account should be the chat
default, change it through normal T3 settings after pairing. Extra accounts do not
change the VM's owner or its name. Each account needs independent sign-in in the VM.
Claude uses its own subscription sign-in. Names are labels, not proof of identity.

Keep the published environment name/ID, owning ChatGPT account, running task URL/ID,
T3 server ID, actual checkout path, configured accounts, and requested devices in
the commissioning record. A new task has a separate runtime identity; a runtime ID
reported in a chat may differ from the published configuration identifier. Never
claim an ID is launchable merely because it was supplied or appears in a CLI catalog.

## User provisioning and handoff

1. Sign in to the owning ChatGPT account. Open **Settings → Codex Cloud →
   Environments → Create environment**, or **Work in → Cloud → Select environment
   → Create environment**. Connect GitHub if asked, select the repository, and
   choose **Get started**. Wait for checkout and dependency preparation.
2. Set the standard name. In **Advanced → VPN**, add Tailscale. Enter a Tailscale
   **auth key** with **Reusable** and **Ephemeral** enabled. Generate it in the
   Tailscale admin console, with the intended tag and access grants. Enter the key
   directly in the VPN field; do not paste it in a chat or use an application
   network-secret placeholder for the VPN credential. Record its expiry for renewal.
3. Choose unrestricted internet access, if permitted and desired, or allow the
   exact destinations needed for installers, releases, repository dependencies,
   provider APIs, private services, and the private T3 gateway. Check tailnet
   grants as well as Cloud domain policy. Workspace restrictions may still apply.
   Preserve the managed HTTP/HTTPS proxy when testing; an allowlist does not
   establish connectivity by itself.
4. Ask the agent to help prepare T3's tools and the repository's application
   configuration using the sections below. Resolve missing dependencies and
   access, then review the prepared configuration, **Save**, and **Publish**.
   Do this before provider sign-in, task-local SSH keys, or T3 pairing state.
5. Start a new task from that published environment. Ask its chat to report the
   environment identifier(s), task URL, selected repository, and actual checkout
   path, without secrets. If it cannot provide a published identifier, copy the
   environment settings URL. Keep runtime IDs separately from published IDs.
6. Give that information to the T3 setup agent together with the owning account,
   desired Codex accounts/default, requested devices, local checkout/configuration
   choices, and whether Claude should be connected. The agent commissions this
   running VM; publishing alone does not start a continuously reachable T3 host.

These creation, VPN, and publishing controls follow the
[current OpenAI environment guide](https://learn.chatgpt.com/docs/environments/cloud-environments).
Use [Tailscale's auth-key guide](https://tailscale.com/docs/features/access-control/auth-keys)
for key management. The earlier
[Tailscale article](https://tailscale.com/blog/codex-cloud-tailscale) describes the
network boundary; use current OpenAI documentation for current DNS support.

Copy this non-secret handoff and fill in the fields you know:

```text
Set up this running VM as a T3 environment.
Repository: unn-corp/clarity-relay
Published environment name: clarity-relay (Personal) — Codex Cloud
Environment ID or settings URL: <reported ID or copied URL>
Cloud task URL/runtime ID: <running task, if available>
Owning ChatGPT account: Personal
Default Codex chat account: Personal
Additional Codex accounts: none
Devices to connect: desktop and Android phone
Local repository path: <path, or not available>
Copy application configuration: <no, or selected files/variable names>
Configuration destination: <environment variables, network secrets, or personal vault>
Claude subscription: <yes or no>
Private gateway: <known host/HTTPS origin, or ask the operator to provision one>
```

The setup agent should infer fields already supplied and ask only for missing
choices. Bundle the initial questions: repository and environment identity;
owner, additional accounts and one default; devices; local checkout and whether
selected application configuration should be copied; Claude; private gateway.
Do not ask for passwords, auth keys, OAuth codes, or secret values in chat.

## Application configuration and secrets

Ask whether the repository exists locally and whether the user wants selected
application variables transferred. A local copy is optional; do not block setup
if the user has none. Inspect `.env.example`, setup documentation, and variable
**names** first. Confirm the source files/keys and destination before reading or
transferring secret values. Offer selective copying rather than importing every
local variable. Exclude PC-specific paths, local proxy overrides, local database
addresses, T3 credentials, provider login files, and SSH keys. Replace localhost
service addresses with verified tailnet or cloud addresses where needed.

Use the environment's **Manage** control beside the intended configuration type:

| Destination           | When to use it                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Environment variables | Programs must read the actual value locally, including application configuration and credentials used outside proxy substitution.                                   |
| Network secrets       | An HTTPS service credential can be substituted by the proxy for its exact allowed destinations. Programs receive a placeholder, not a usable local credential file. |
| Personal vault        | Values should belong to the individual user's tasks rather than the shared environment. Select the requested key and applicable environments.                       |

See [OpenAI's configuration guidance](https://learn.chatgpt.com/docs/environments/cloud-environments#configure-environment-variables-and-network-secrets)
for the destination types and current delivery rules. Network-secret substitution
uses HTTPS on port 443; it is not a general replacement for direct application
variables. Provider browser sessions remain independent of application secrets.

When authorized and supported tools are available, help transfer the selected
values through the normal configuration UI without exposing values in chat,
screenshots, command logs, or Git. If that cannot be done privately, identify the
required keys and give the user exact UI steps to enter their values themselves.
Preserve existing entries and resolve collisions with the user instead of silently
overwriting them. Do not hand-edit hidden ChatGPT state or bypass sign-in/CAPTCHA.

Test required configuration by checking whether the application can use it,
without printing values. Keep secrets out of the published filesystem. If an
application requires a local `.env` file, materialize it privately in the running
task after publishing, keep it out of Git, and do not republish that task state.
Save changed environment configuration and republish when needed, then verify in
a fresh task; an existing task retains its own state.

## Prepare reusable tools before publishing

In the Cloud setup conversation, ask Codex to prepare the tools with this prompt:

```text
Prepare this repository for ordinary T3 Codex and Claude chats inside cloud tasks.
Keep the repository's existing setup. Install Python 3, curl or wget, tar,
and sha256sum or shasum. Install Codex CLI and Claude Code using their supported installers.
Place matching trusted copies of cloud-environment.py and install.sh from
unn-corp/t3code in /opt/t3-cloud-tools, creating that directory if permitted,
or use a writable tool directory and record its actual path instead.
Use the reviewed helper files supplied by the operator; do not invent a
download URL or assume an unpublished file exists on GitHub.
Verify the tools. Record dependency installation in the Install script.
Record the task startup instructions below in the Start skill.
Do not start T3, sign in providers, initialize a T3 data home, create pairing
credentials, or save tunnel keys before publishing the reusable environment.
Report the actual helper location and repository checkout location.
```

To prepare the owning Codex account automatically in every fresh VM,
export their names, IDs, and enabled preferences once on the machine where those
accounts are configured. Supply the actual settings path if your T3 home differs:

```sh
python3 scripts/cloud-environment.py export-accounts \
  --settings "$HOME/.t3/userdata/settings.json" \
  --output /tmp/t3-cloud-accounts.json
```

The export reads settings without changing them and excludes credentials,
environment variables, and machine-specific provider configuration. It refuses
to overwrite an existing output file. Transfer this account list with the helper
files and place it at `/opt/t3-cloud-tools/accounts.json`, or record its actual
path. The list can be reused in published environments because it contains no
login sessions. Setup selects the owner from this list rather than creating every
listed account. Use its provider ID, not its display name: for example, Personal
may have the ID `codex`, while Work may have `codex_work`. Check the exported file
for your actual IDs. Export a new list when you add or rename accounts; existing
VM accounts keep their own saved settings.

Supply the helper and its matching [installer](../../scripts/install.sh) from this
checkout until this change is distributed. The operator can package both with
this guide for transfer to the VM:

```sh
tar -czf /tmp/t3-cloud-setup.tar.gz \
  scripts/cloud-environment.py scripts/install.sh docs/user/cloud-environments.md
```

The helpers need no T3 source build or Node/npm installation. Provider CLIs have their own
installation requirements. Review the prepared files and publish the environment
before signing in. Configure the permitted installer, release, provider, and
private gateway destinations in Cloud network settings. Honor the managed proxy;
successful access to a tailnet host does not establish a client-to-VM route.

OpenAI's [current environment guide](https://learn.chatgpt.com/docs/environments/cloud-environments)
describes Install script, Start skill, publishing, and saved state. New tasks use
the published filesystem; existing tasks retain their own state. The
[legacy guide](https://learn.chatgpt.com/docs/environments/cloud-environment) uses
setup/maintenance scripts instead. Follow the UI for the environment you actually
created; legacy setup exports and setup-only secrets do not carry into its agent
phase. Network-secret placeholders are not local CLI login files or SSH keys.

## Start a task and run the server

Start a task in the published environment on its owning account. Use a private,
writable T3 data directory outside the repository; each new task needs a fresh
home and T3 identity. Keep it out of the reusable snapshot. With the helpers at
the prepared path, one command installs a verified release and starts the managed
launcher with automatic updates enabled:

```sh
python3 /opt/t3-cloud-tools/cloud-environment.py setup \
  --home /tmp/t3-cloud-task-home --port 13882 --repository unn-corp/Squidhub \
  --accounts /opt/t3-cloud-tools/accounts.json --owner-account codex
```

With `--accounts`, `--owner-account` is required. Setup creates only that named
Codex provider, selects it for new chats and application text generation, and
disables the fallback Codex CLI provider when it is not among the selected
accounts. Complete the owner's browser sign-in in this VM. Disabled preferences
remain disabled; enable the account in Providers before using it if necessary.
For manual provider configuration, omit `--accounts` and `--repository`, and pass
the standard name with `--name` instead. Account selection applies only
to fresh setup; it never overwrites accounts in an existing home.

Additional accounts are optional. After pairing, select this VM in **Settings →
Providers**, add a Codex account, and complete its separate browser sign-in. To
prepare an additional account during fresh setup instead, append
`--include-account codex_work` using its actual provider ID; repeat the option for
each account you explicitly want. Adding accounts during setup retains the owner
as the default. Selected accounts share a VM-local workspace home while T3 keeps
their managed credentials separate. You can change the default later in Settings.

Use `--repository owner/repository` with `--accounts --owner-account` to derive
`repository (Owner) — Codex Cloud` automatically. This names the environment in
connections, selection, pairing, and host update controls. The owner display name
comes from the non-secret account list; extra accounts do not alter it. Choose
`--name` instead for an explicit standard name, a qualified repository name, or a
task suffix. The two options cannot be combined. The helper saves the name for
every subsequent `start`
and runtime update. It changes the display label, not the environment ID or which
repository a project opens. Without either naming option, normal host naming remains available.
This requires a fork runtime containing repository-label support; an older runtime
does not gain that support by installing the helper alone.

You can also rename an already paired VM from **Settings → Connections →
environment actions → Rename environment**, for example `Squidhub (Personal) — Codex Cloud`.
This saves a name on the current device and works with older VM servers. It
survives client reloads and leaves chats running. Use **Use server name** to reset
it. Other devices keep their own saved names; the helper's saved name sets the server's default
for every newly paired client.

Substitute the recorded helper path if different. The command stays in the
foreground; the task's startup runner must keep it alive. It refuses an existing
home. To resume the same task after its launcher has stopped, use `start` with
that home. Repeating `setup` never resets conversations or saved update choices.
Use `--auto off` at setup for manual updates, or `--version` for an exact initial
fork release. No live server is replaced by this command.

For a reusable Start skill, use these instructions:

```text
Start the managed T3 environment for this task using the prepared helper.
Verify the repository checkout path, writable process home, and private T3 home.
On initial setup use --repository with the actual repository and exported owning
account, or use --name to pass the explicit name
'Squidhub (Personal) — Codex Cloud'. On subsequent starts use its saved name.
If the operator supplied a non-secret account list, pass its actual path with
--accounts and the confirmed owning provider ID with --owner-account on fresh
setup. Prepare only the owner unless the operator explicitly asks for additional
accounts with --include-account. Do not infer ownership from a renamed T3 label.
For a fresh task run setup; for an existing configured home run start only if
its launcher is stopped. Never reinitialize an existing or partially configured
home, import another task's T3 identity, or restart a working server.
Keep the launcher process alive and retain its PID and private log location.
Keep every T3 runtime for this OS user on the same maintenance coordinator.
Honor the provided proxy and keep operator loopback requests local.
Immediately establish a new task-local administrative operator session through
the normal startup pairing flow, before its initial five-minute grant expires.
Keep that session private. Issue a fresh unused link only when its intended
client is ready to connect; never copy another task's or device's credentials.
Establish only the operator-provisioned private outbound HTTP/WebSocket route.
If no route is provisioned, report that requirement instead of exposing a port.
Wait for T3's environment descriptor through that route and report its ID,
the endpoint, and the checkout path. Supply a fresh one-time pairing link
privately through the normal pairing flow; never publish it in repository files.
Do not report ready until the route is reachable and pairing succeeds.
```

If the Cloud image's process home is read-only, the operator must supply a writable
process home consistently for all T3/provider processes before launch. Claude can
use a writable `CLAUDE_CONFIG_DIR`; configure it before starting T3 so login and
agent execution use the same location. Keep those credentials task-local.

## Connect and verify in T3

The operator must provision a private outbound tunnel that carries **both HTTP and
WebSocket** traffic to this VM's loopback port. The Squidhub prototype used reverse
SSH inside a private HTTPS WebSocket bridge through the managed proxy. That bridge
is not yet a reusable provisioning feature. The setup helper does not install
SSH keys, configure Tailscale routes, create tunnels, or automatically pair clients.
Allocate a separate endpoint for each simultaneously running VM.

A Tailscale auth key gives Cloud tasks outbound access; it does not expose a T3
port to desktop or phone. Verify the return route independently. For this prototype,
the gateway host must stay online even when the user's client device sleeps.
Record tunnel ownership, expiry/renewal, and the gateway dependency. A domain
allowlist and a Cloud-to-tailnet HTTP response are not proof of native T3 readiness.

The operator must arrange these parts of the route before pairing:

| Part                     | Required result                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Gateway host             | A reachable tailnet host with a private HTTPS origin; record which host must remain online.                                     |
| VM outbound connection   | An approved connection through the managed proxy back to that gateway; use task-local credentials and record the owned process. |
| Reverse forwarding       | A distinct gateway endpoint forwarding HTTP and WebSocket traffic to this VM's loopback T3 port.                                |
| Destination verification | The public remote descriptor reports the same T3 server ID as the VM's loopback descriptor.                                     |
| Client access            | Each requested device can reach the gateway, use a compatible client, and complete its own T3 pairing.                          |

The reverse SSH/WebSocket arrangement used in the trials is an operator-provisioned
prototype, not a tunnel installed by `cloud-environment.py`. Reuse a verified
gateway where available, but allocate a separate reverse port and HTTPS endpoint
for each live VM. Record the mapping before changing routes, and preserve other
environments on the host. Keep reverse-tunnel credentials in the task, restrict
their forwarding to that task's endpoint, and verify the gateway's identity.
Do not import another VM's private key or T3 home into this task.

Verify the public descriptor from the VM's loopback and from the device-facing
gateway. Substitute the recorded ports and real private gateway hostname:

```sh
curl --noproxy 127.0.0.1 --fail --silent --show-error http://127.0.0.1:13882/.well-known/t3/environment
curl --fail --silent --show-error https://gateway.example.com/.well-known/t3/environment
```

Run the first command inside the VM. Run the second from a requested client or
its reachable host, honoring the relevant proxy/network setup. Only the loopback
request bypasses the proxy. Compare server ID,
version, and capabilities; these descriptor checks contain no pairing credential.
Then verify a live T3 connection and conversation. An HTTP 200 cannot establish
that the WebSocket path or provider inference works.

1. Paste the fresh full pairing URL into **Settings → Connections → Add environment**
   in the T3 client you intend to use. A pairing in the test Browser profile does
   not also connect the desktop profile.
2. Verify the connection shows the saved repository/account name. On that
   environment, add the actual cloud checkout as a project and start a new chat.
3. Select the cloud environment in **Settings → Providers**. Connect the owning
   Codex account through browser sign-in, choosing the matching ChatGPT account
   and workspace. Sign in any explicitly added accounts separately. Connect
   Claude with its subscription sign-in.
   Complete these sign-ins after starting the task; publishing a signed-in image
   would share its credentials with future tasks.
4. Send a harmless prompt to each requested Codex account and, if requested, Claude,
   asking it to run `pwd` and `git rev-parse --show-toplevel`.
   Confirm both name the cloud checkout, then send a follow-up in the same chat.
5. Open this host's **Connections → Updates → Review installations** and review
   its known fork runtimes. Automatic installation remains blocked until that
   review and the [idle checks](./updating.md#why-installation-waits) pass.

## Agent commissioning and device checklist

Carry out supported setup steps with the user's supplied choices. Use the normal
Cloud conversation, configuration UI, T3 settings, and device controls when they
are available. Prepare scripts, instructions, and private handoff materials before
asking the user to perform an unavailable UI step. A supplied ID alone does not
give the agent remote shell access or a supported environment-launch API; never
claim provisioning or device pairing succeeded without verifying it.

Before reporting the environment ready:

- Verify the owning ChatGPT account and actual repository checkout in the running
  task. Check branch and Git status; local uncommitted files are not automatically
  transferred from the user's PC. Arrange Git authentication and the desired
  save/export workflow when needed, without pushing merely to test connectivity.
- Prepare the latest eligible compatible T3 runtime using the fresh-home helper.
  Verify the standard server name, or apply the same connection alias on each
  requested client if its server lacks naming support. Record the actual installed
  version and confirm each client supports its protocol/channel.
- Establish the private return route and verify the remote descriptor's T3 ID.
  Complete the requested accounts' independent sign-ins; let the user complete
  any password, CAPTCHA, or consent step. Select one default chat account and
  verify a completed read-only turn for every requested provider. If Claude was
  requested, install and sign it in too; Codex authentication does not cover Claude.
- Register the actual VM checkout as a T3 project. Verify `pwd`, Git root, a
  follow-up, and history after reload. Check required application configuration
  without displaying its values.
- Pair every requested device independently using the reachable gateway origin.
  Keep each device's one-time link unused until that device pairs. Verify the
  saved connection, standard name, correct project, and access to the same history.
  Report paired, pending, and unavailable devices explicitly.
- Confirm update policy is enabled by default, review known installations, and
  inspect maintenance admission. Zero chat turns alone is insufficient: unknown
  activity, Cloud processes, or an unregistered tunnel can still block installation.
  Preserve these checks and the user's explicit update choices. Keep all six
  automatic-work policies off unless the user separately enabled them.
- Leave the verified VM and route available. Provide non-secret identities,
  devices/status, versions, required host dependencies, credential renewal dates,
  and steps to resume or replace the task. Never publish its signed-in runtime state.

For the phone, install a compatible T3 client and connect its Tailscale app to the
correct tailnet first. Verify phone-to-gateway HTTPS access and tailnet grants.
In this fork's Android app, use **Settings → Connections → Add environment** and
paste its fresh full pairing URL. Pairing is separate from VPN access; there is
no automatic tailnet-wide device registration. The
[Android connection guide](./android-fork.md#connect-over-tailscale) describes the
client setup. Desktop and other clients also require their own saved connection;
web Browser pairing is not desktop pairing.

If the agent can operate a requested device through supported app controls, help
pair it there. Otherwise supply that device's fresh link privately and the exact
UI steps. Do not write a running client's settings database directly or silently
copy another device's bearer credentials. Check the final connection on the device
when access becomes available. The setup helper does not implement a multi-device
pairing wizard, gateway provisioning, or Cloud task lifecycle management.

### First administrative connection and device links

Establish the first administrative connection immediately after starting the VM.
Its native startup pairing grant is single-use and expires after five minutes.
An operator can redeem it through the normal VM-local `/api/auth/browser-session`
flow, verify the new session with `/api/auth/session`, then issue a fresh unused
grant through `/api/auth/pairing-token`. Preserve the verified session's permitted
administrative scopes, including `access:write`, when preparing an operator link
that must create further device links. A standard device grant does not grant
that permission. This creates a new session in this VM; it does not copy a PC's
or another VM's login.

Transfer the unused grant privately to the intended client, using the verified
gateway origin and matching T3 server ID. Operator automation can use an
encrypted handoff and a private local file; keep plaintext URLs, callback codes,
cookies, and keys out of chats, screenshots, command arguments, and logs. All
session files belong to the private running task after publication, never the
reusable published filesystem.

Once the VM's web client is paired, use **Connections → Create link** for each
additional client. Create each link just before that device connects and leave
it unused until then; it also expires after five minutes. An authenticated
operator can issue a fresh link without restarting T3. The standalone `pair`
command may refuse admission while the managed server owns its home; use the
authenticated pairing flow instead of bypassing admission.

If the initial grant expires before any administrative session exists, an
authorized operator can perform an orderly restart of the **same installed
build and configured T3 home**. First verify every real T3 runtime is known and
idle, with no active turns, tools, PTYs, leases, pending or organization work,
unknown activity, maintenance fence, active transaction, or countdown. Send
SIGTERM only to the original helper PID whose ownership and start identity were
recorded; let its normal lifecycle stop its managed children and release the home lock. Stop if a child,
home owner, or orphan remains uncertain. Resume with the recorded helper's
`start`, preserving the process home, provider configuration, coordinator,
tunnel, and saved data, then immediately redeem the new startup grant privately.
This recovery does not install an update, rerun `setup`, or reset the home.

Each new VM needs one browser sign-in for each account you want to use there.
Returning to the same VM retains its sessions; expired or revoked sessions need
reauthorization. T3's existing remote sign-in flow can open authorization on the
primary client and hand the fresh session to the destination VM. Each VM owns
its subsequent token renewal; the setup account list never copies login tokens.
If remote ChatGPT sign-in finishes on a localhost callback page that cannot
reach the VM, return to that VM's sign-in panel and enter the final redirect URL
in its **ChatGPT sign-in redirect URL** field, then choose **Connect** in that
form. Transfer this short-lived URL directly through the private UI; for operator
automation, use a private file handoff to fill that existing field. The setup
helper does not automate OAuth. Never paste the URL into a chat. Complete the
pending flow promptly, and start a new sign-in if it expires. A browser's
existing ChatGPT login alone does not sign the VM's provider in. Confirm T3 shows
the intended account signed in, then verify a harmless turn in its cloud project.
OpenAI documents [VM credential ownership](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
and [separate account sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).
Several VMs using one account draw from that account's applicable usage limits;
creating more environments does not create separate quotas.

Verify a harmless completed Codex turn for every connected account before relying
on it. Live trials verified Claude in Squidhub and fresh owner-only Personal
setups in Squidhub and clarity-relay: independent ChatGPT browser sign-in,
completed GPT-6-Luna turns in each VM's repository, and follow-ups in the same
conversations. The clarity-relay conversation and saved environment name also
survived a Browser client reload. These pairings are in the test Browser profile;
other clients need their own pairing. Unnamed and Work remain uncommissioned.
Additional Personal-only trials in signalskyworks, Photonic, Arcwright-AI, and
FCM-Fallout-Chat-Mod verified private first-admin handoff, independent sign-in,
completed GPT-6-Luna repository turns, and saved history after Browser reload.
These trials do not establish physical-device pairing or Claude sign-in there.
Installing entries or finishing sign-in alone does not prove that the VM's
network and provider allow inference. Personal's managed sign-in worked through
the private HTTP/WebSocket route even though the earlier standalone Codex CLI
trial could not reach its ChatGPT endpoint through the managed proxy.

After commissioning, normal chats run without repeating installation.
[Automatic managed updates](./updating.md#cloud-vm-environments) retain their
activity and admission checks; a tunnel or Cloud process can hold installation.
Switch repositories by selecting the project
on the corresponding connected VM. A new task requires its own connection; cloud
account switching and VM relaunch are not automatic. Keep needed work in Git and
preserve task state before replacing it; the helper does not keep Cloud tasks or
tunnels alive. If the Cloud VM suspends or its route drops, inspect and reconnect
the same task without reinitializing its T3 home. A replacement task needs fresh
identity, sign-ins, route provisioning, and device pairing. Preserve work through
Git or an agreed private export before replacement; T3 updates do not keep a VM alive.

## Reconnection, renewal, and replacement

Treat a disconnected saved environment as a reachability problem first. Do not
silently send its work to a PC checkout, switch accounts, initialize another home,
or create a replacement task while diagnosing it.

1. Open the recorded Cloud task and check whether the same VM and checkout are
   available. Verify the recorded T3 data home and server ID. Publishing an updated
   template does not upgrade or replace that task's state.
2. Check its loopback descriptor and the recorded launcher processes. Inspect
   maintenance state through the normal helper with the recorded home:

   ```sh
   python3 /opt/t3-cloud-tools/cloud-environment.py status --home /tmp/t3-cloud-task-home
   ```

   If the launcher is stopped, use `start` with that same configured home and the
   original writable process home/coordinator namespace. Leave a working launcher
   running; do not rerun `setup` or `init`. Substitute the actual paths, and retain
   the resumed launcher's PID and private log location.

3. Check the gateway host and this VM's reverse connection. Restore only its
   recorded mapping, then compare loopback and gateway descriptors again. A route
   answering with another T3 ID must not receive this environment's credentials.
   Capture new owned PIDs after an authorized restart; never kill by name or pattern.
4. If a tunnel credential expired, renew it through the provisioned route's normal
   management flow and verify access before retiring the old credential. Renew a
   Tailscale VPN auth key in the environment's VPN configuration when required,
   following the current UI's save/publish behavior. Verify whether the existing
   task received the change; do not assume it did. Never publish a task's SSH key.
5. If T3 is connected but a provider needs sign-in, reconnect that provider on the
   recorded VM through **Settings → Providers**. If a device lost authorization,
   create a fresh device pairing link. A used or expired device link is not a
   reason to restart the server. Keep VPN, tunnel, T3 pairing, and provider
   credentials separate when diagnosing which authorization failed.
6. If the task is unavailable and a replacement is needed, first preserve accessible
   work through the agreed Git or private export workflow. Check uncommitted and
   untracked files, and preserve any needed conversation export privately. Keep
   secrets and authentication state out of Git and reusable images. Record what
   cannot be recovered; do not promise conversation migration that was not verified.
7. Commission the replacement as a fresh task: new T3 home/ID, route, sign-ins,
   project, and per-device pairing. Retain the old connection until its work has
   been reviewed and the new connection passes validation. Remove obsolete saved
   connections and task-specific routes only when their retirement is authorized.

Record credential expiry and the responsible renewal path at setup. An expiring
key is not the same as proof that an existing connection has already stopped;
verify the live route. Installation updates preserve their maintenance checks,
but neither updating T3 nor enabling automatic updates keeps a Cloud VM awake.

## Final handoff record

Return a non-secret commissioning record through the user's private conversation
or an agreed private file. Keep pairing URLs in a separate private handoff for
their intended device; do not include tokens, private keys, or secret values in
this record. Mark any unfinished step pending with the exact next action.

```text
T3 environment name: <repository (Owning account) — Codex Cloud>
Repository / branch / actual checkout: <verified values>
Published Cloud name / ID or settings URL: <verified values>
Owning ChatGPT account: <account>
Running Cloud task URL / runtime ID: <verified values>
T3 server ID / installed version / channel: <verified values>
T3 home / process home / coordinator namespace: <recorded paths>
Gateway host / private HTTPS origin / reverse mapping: <recorded route>
Owned launcher/tunnel PIDs / private log paths: <recorded values>
Configured Codex accounts / default chat account: <verified values>
Claude: <not requested, pending sign-in, or completed test>
Application configuration: <key names, destination, and validation; no values>
Provider tests: <account, model, completed turn, checkout, follow-up/reload>
Update policy / installation review / remaining admission blockers: <status>
Credential renewal: <credential type, expiry, owner, and normal renewal steps>
Work preservation / reconnection: <agreed Git/export and resume procedure>
Outstanding steps: <specific actions, or none>
```

Include every requested device in a table:

| Device  | Client/version compatible | Gateway reachable | T3 pairing saved | Name/project/history verified | Status or next action                 |
| ------- | ------------------------- | ----------------- | ---------------- | ----------------------------- | ------------------------------------- |
| Desktop | Pending                   | Pending           | Pending          | Pending                       | Verify on this client                 |
| Phone   | Pending                   | Pending           | Pending          | Pending                       | Connect Tailscale and pair in the app |

Replace the placeholders with actual results. For the phone, reconnect after
closing and reopening the app and confirm it returns to the same environment.
Where device access permits, verify through the network the user intends to use,
including cellular with Tailscale when needed. If the agent cannot operate a
device, provide its normal UI steps and leave it pending until verified.

"Ready" means the VM route and requested providers passed checks and the reported
devices were verified. If some devices remain pending, describe the VM as ready
and those device connections as pending. A setup report, VPN connection, installed
account entry, or Browser-only pairing does not establish end-to-end readiness.

## What is automated today

| Step                           | Current behavior                                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Reusable tools                 | Codex Install script can prepare them once before publishing.                                                         |
| T3 runtime, name, and launcher | One `setup --repository` command with the owner list; standard name, verified installation, and automatic updates on. |
| Subsequent updates             | Saved policy; five idle minutes and countdown, with active work blocking.                                             |
| Task startup                   | Start skill can run the helper; its runner must keep the process alive.                                               |
| Codex account entries          | `export-accounts` once, then `setup --accounts --owner-account` prepares only the owner by default.                   |
| Additional Codex accounts      | Explicitly add in Providers, or use `--include-account` during fresh setup.                                           |
| Codex account authentication   | Independent browser authorization for each account in each new VM; sessions stay task-local.                          |
| Private route and pairing      | Operator provisioning and one-time pairing per task/client.                                                           |
| Claude subscription            | Interactive browser authorization in the task.                                                                        |
| Project registration           | Add the actual cloud checkout in the connected T3 environment.                                                        |
| New tasks                      | Select the owning account/environment and commission each VM.                                                         |
| Chat account selection         | Choose any connected Codex provider in that VM; its checkout stays the same.                                          |

A complete T3 setup wizard still needs reusable tunnel provisioning, authenticated
project/connection registration, and task startup/reconnection management. The
scripted server setup alone does not provide those capabilities.
