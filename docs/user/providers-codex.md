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

This integration is experimental. In **Project settings → Codex Cloud**, select the
Codex account that owns the repository, enter its published environment ID or settings URL, and save
the project default. **Cloud tasks** in the conversation's workspace controls opens
the same panel. Personal, Unnamed, Work, and other configured Codex accounts remain
separate; existing jobs keep the account and environment they started with.

Cloud submissions use that account's existing ChatGPT CLI login. Connecting through
ChatGPT sharing alone does not grant access to cloud tasks. The installed CLI must
also support the published environment: a successful account-access check does not
prove that a newly created environment appears in its cloud catalog. Find the ID by
opening the environment's settings in ChatGPT and inspecting its settings address.

Describe the work and run the task, then open its cloud link, check its status, or
view its changes here. Work runs in the cloud repository checkout; local uncommitted
files are not uploaded. Review and bring changes back through your normal Git flow.
If submission is uncertain, check that account's tasks in ChatGPT first. Retrying the
same request in the open panel does not create another job; **New task** deliberately
starts a separate request. Cloud task cancellation stays in ChatGPT.

### Claude and interactive worker experiments

Choose **Cloud worker (experimental)** to send successive Codex or Claude prompts to
a connected cloud checkout and resume its previous conversations. This is a separate
task panel, not a replacement for the regular local conversation provider.

In **Connect an experimental worker**, enter the HTTPS origin of the T3 server that
owns this project, prepare a worker, and download its script. The server must run a
version with cloud support. Connect the cloud environment to your tailnet in its
ChatGPT network settings, and verify that an HTTPS request from a cloud task can
reach the controller. The worker needs outbound HTTP/HTTPS access; inbound SSH is
not part of this setup. Enable the required installer and model API domains too.

Install the agent CLI in the cloud environment before publishing it. Claude needs
its own supported login or API credentials; your Codex subscription does not sign
Claude in. Follow [Claude's setup](https://code.claude.com/docs/en/setup) and
[programmatic usage](https://code.claude.com/docs/en/headless) guidance.

In the running cloud task, save the downloaded script as `t3-cloud-worker.py`. Set
`T3_CLOUD_CONTROLLER` to the controller origin, `T3_CLOUD_CWD` to the cloud checkout,
and `T3_CLOUD_TOKEN` to the credential copied separately from the panel. Start it:

```bash
python3 t3-cloud-worker.py
```

Supply task credentials after publishing the reusable environment, so its snapshot
does not contain them. The worker credential expires after 24 hours and binds to
its first process. It is not an account password or a Tailscale auth key. It is
removed from agent subprocess environments. Revoke it from this panel to disconnect
the worker, and prepare a new credential when starting another worker process.

Keep the cloud task and controller running while using the worker. Each worker runs
one job at a time. **Stop** records cancellation; a connected worker stops the
process on its next heartbeat. Closing a suspended VM or losing a worker does not
automatically replay edits. Start a new worker and inspect the checkout before
continuing. Claude tool execution is enabled for the submitted job, including shell
commands; interactive approval and browser automation are not provided by this
worker. The task list shows previews; **View output** retrieves the retained output
tail, up to 180,000 characters.

The controls are shared by web, desktop, and this fork's Android web client. The
upstream React Native client has no cloud-task panel yet. Installation, real cloud
connectivity, and provider authentication must be verified on each deployment;
fixture tests alone do not establish that a particular cloud account works.

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
