# Codex

Use your ChatGPT plan or an existing Codex CLI login to code in Arcwright Code.

## Connect with ChatGPT

Connect during onboarding or in **Settings → Providers**. For a remote machine,
select that environment first. Arcwright Code handles Codex installation; sign in on
OpenAI and allow sharing of your ChatGPT plan.

Manage shared usage and credits in ChatGPT through **Manage usage** in Arcwright Code.
If a request uses a feature that ChatGPT sharing does not support, use another
provider for that request.

When reconnecting, choose the same account in Arcwright Code and on OpenAI's sign-in
page. Disconnecting stops running threads but keeps their history and lets you
reconnect later.

If remote sign-in cannot return automatically, paste the full URL from the final
localhost page into the sign-in panel, even if that page could not load.

## Use an existing Codex login

Arcwright Code can use your installed Codex and its existing login. Run `codex login`
on the environment's machine to sign in. [Provider setup](./install.md#providers)
covers installation and custom configuration.

## Use multiple accounts

Add another ChatGPT account in **Settings → Providers**, then select the account
from the thread's model picker. Compatible accounts can continue the same thread.
Connecting accounts through Arcwright Code leaves your CLI login unchanged.

### Multiple CLI logins

A shared Codex home with a shadow home lets work and personal accounts continue
the same threads. The accounts share Codex sessions and configuration while keeping
their own login and available models.

Keep your first account in `~/.codex`. On the environment's machine, sign the
second account into a fresh directory:

```bash
mkdir -p ~/.codex_personal
CODEX_HOME=~/.codex_personal codex login
```

Then add a second Codex instance in **Settings > Providers**:

| Instance       | CODEX_HOME path | Shadow home path    |
| -------------- | --------------- | ------------------- |
| Codex Work     | `~/.codex`      | Leave empty         |
| Codex Personal | `~/.codex`      | `~/.codex_personal` |

Both instances must use the same **CODEX_HOME path**. Arcwright Code prepares the shared
state in the shadow directory; do not populate it by copying your whole Codex
home. Shared Codex entries are linked into the shadow home, while the shadow
home keeps its own `auth.json` and local runtime directories (`log`, `memories`,
and `tmp`).

If an older Arcwright Code version or a manual copy left a real file or directory where
a shared link belongs, Arcwright Code moves that entry into a recoverable
`<shadow-home>.t3-shadow-backups` directory beside the shadow home before
creating the link. Nothing from the old shadow setup is deleted. Keep the
backup until you have confirmed that the account and existing threads open
normally. The ephemeral `mcp-oauth-locks` directory is the exception: it is
replaced with the shared lock directory because its contents are runtime locks.

The shadow account needs its own `auth.json` file. If Codex uses an OS credential
store, configure file storage for this setup. See
[OpenAI's credential storage guide](https://learn.chatgpt.com/docs/auth#credential-storage).

Use a completely separate **CODEX_HOME path**, with no shadow home, when you want
separate Codex sessions and configuration. That instance cannot continue threads
from the other home.

## Switch accounts in an existing thread

Choose the other account from the thread's model picker. Arcwright Code offers compatible
Codex instances that share the thread's **CODEX_HOME path**. Changing accounts does
not move the conversation into a separate Codex home.

If the account is missing from the picker, compare the home paths in provider
settings. If two instances show the same unexpected account or models, check their
reported accounts, refresh provider status, and confirm the second instance has
its own shadow path and login. If a shadow-home startup error remains after an
update, close Arcwright Code and inspect the matching `<shadow-home>.t3-shadow-backups`
directory; it contains the preserved entries that were replaced with shared
links. The private `auth.json` must remain a real file in the shadow home.

## Run work in Codex Cloud

Follow [the cloud environment setup guide](./cloud-environments.md) for the
copyable preparation prompt, Install script/Start skill instructions, single-command
server setup, automatic account entries, provider sign-in, and readiness checks.

For ordinary Claude conversations, run a compatible T3 server inside the task VM
and connect it through **Settings → Connections → Add environment**. Register the
VM checkout as a project, choose that project when starting a thread, and select
Claude. The VM environment owns the conversation, provider session, commands,
files, and checkpoints. Claude requires its own sign-in inside that VM. Any of your
Codex accounts can also be connected independently in the same VM, regardless of
which account owns the published Cloud environment. Reuse a non-secret account
list with `setup --accounts --owner-account` to prepare only the owner and select
it as the default. Add other accounts explicitly in Providers when needed, or
include them during fresh setup with `--include-account`. Each new VM still needs
browser authorization for each account you want to use there.

This remains a manual experiment: Codex Cloud does not expose an inbound T3
endpoint. An operator must establish a private outbound tunnel carrying both
HTTP and WebSocket traffic before supplying a pairing URL. Live trials
verified Claude in Squidhub and owner-only Personal Codex chats and follow-ups
in Squidhub and clarity-relay through this route.
Personal used fresh browser authorization in an owner-only managed VM setup;
Unnamed and Work remain uncommissioned. This does not
provide automatic VM launch, account switching, or recovery after VM termination.
For new Linux VMs, the [managed setup helper](./updating.md#cloud-vm-environments)
enables the existing per-environment update and recovery controls without systemd.
Saved connections belong to each client profile; pairing a test browser does not
also pair the desktop app. Keep the VM and tunnel running, and preserve its state
before replacing the task. Never publish a reusable snapshot containing provider
logins or client pairing credentials.

## Answer questions while Codex works

Codex can ask a question and keep working. Answer it in the thread's question
panel. The answer becomes a new message: it reaches the active turn, or starts
another turn if Codex has finished. Unanswered questions survive reconnects.
If you do not want to answer, dismiss the question from its panel. Dismissing
closes it without sending anything to Codex. This requires a Codex version that
supports async questions.

## Approve app access

Codex tools can request access to another app. Respond to the named app's request
in the thread on web, desktop, or mobile. Some tools offer access for one request,
the current session, or permanently. See [Permission modes](./permission-modes.md)
for command and file approvals.

## Codex says I hit a usage limit

When Codex stops on a usage limit, the thread names the window that ran out and
when it resets, when Codex reports them. Send the message again after the reset. On a workspace plan the
message also says whether your workspace owner needs to add credits or raise the
spend limit to continue sooner.

## Send feedback to OpenAI

In an existing Codex thread, send `/feedback` with an optional description, for
example `/feedback The agent stopped before finishing the tests`. This uploads
the conversation and Codex logs to OpenAI. The returned thread ID can be shared
with OpenAI support.
