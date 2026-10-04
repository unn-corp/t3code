# Updating T3 Code

The app you use and the server running your agents can be on different machines.
When a server is behind your web or desktop app, an update notice appears in the
conversation and **Settings → Connections**. Update the machine named in that
notice.

## Before you update

Server updates restart the connection and can interrupt active agents and
terminal commands. Saved threads, settings, and project files remain.

**Settings → General → Continue threads after restarts** is off by default.
Enable it to resume supported active threads after an update, crash, or machine
restart. Changes are saved to connected environments that support this setting;
update older servers first. If a supported environment was offline or has a
different value, use **Apply to all** in Settings after it connects.
T3 Code must start again on that machine;
the setting does not enable automatic startup. Terminal commands may still be
interrupted, and threads without saved provider resume state need a new message.
If you previously enabled continuation for updates, enable this setting once
to allow recovery without a connected client.

Updates from the previous orchestration system preserve conversation transcripts but cannot carry
every kind of runtime history forward. Read [Threads from older T3 Code versions](./thread-migration.md)
before continuing an important older thread.

## When versions don't match

A client and server must speak the same orchestration protocol. If they do not, the connection is
refused rather than running half-upgraded:

- An app newer than the server is blocked before connecting, with a notice telling you to update
  T3 Code on the machine named in the notice.
- A server newer than your app refuses the connection with an update message.

Update the side the notice names, then reconnect.

## Update a connected server

The offered action depends on how the server runs:

| Action                     | What to do                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Update server**          | Keep the client open while it installs and reconnects. Supported background services update remotely. For a desktop-hosted server, this also closes and relaunches the desktop app on the host. |
| **Update the desktop app** | Update the desktop app on the machine running the server, then reopen it if needed.                                                                                                             |
| **Copy update command**    | Stop the command-line server on its host and relaunch with the copied command, keeping your usual startup options.                                                                              |

On the host, run:

```sh
t3 update <client-version>
```

Replace `<client-version>` with the version shown in the notice. The command
asks before restarting the background service; if you decline, run
`t3 service restart` when you are ready. For a server you started by hand,
stop it and start it again afterwards with your usual options such as `--host`
or `--tailscale-serve`.

If you run the server with `npx` rather than an installed `t3`, there is
nothing to update on the host: stop the server and relaunch it as
`npx t3@<client-version>` with the same subcommand and options.

## If an update fails

Keep the client open until it reconnects or reports a failure. A failed service
update can roll back to the previous version. If the update still fails:

1. Retry the offered action once.
2. Check that you updated the server's machine, not only the device you are using.
3. For a command-line server, stop it and relaunch the exact version shown in the notice.

## Update providers

**Settings → Providers** shows provider updates for the selected environment.
**Update all** updates every outdated provider on every connected environment
at once. Hover it to see which providers it will update. Providers that only
offer a manual update command are not included.

## Mobile updates

To update an environment from your phone, open **Settings → Environments** and
select it. **Check for updates** finds the latest release on that environment's
current release channel. Keep the app open while the environment updates and
reconnects. Hosts that cannot update remotely show instructions for updating on
the machine instead.

The same page lets you refresh provider status and update supported providers.
These controls require a connected environment and permission to operate it.
Provider update checks and restart continuation preferences are in
**Settings → Maintenance**. If provider update checks are disabled, enable them
there before refreshing to find newer versions.

Install App Store or Google Play releases as usual. The mobile app can also
download updates in the background and apply them when you next leave the app.
It saves drafts and queued messages before restarting. If you keep the app open
for a long time, it may ask to install immediately; choosing **Later** leaves the
update queued for the next suitable moment.

## Back up and restore

Stop the server, then create a backup on that machine with an explicit T3 home and a new output directory:

```sh
t3 backup create --home-dir "$HOME/.t3" --output /path/to/new-backup
```

The backup includes conversation state, settings, keybindings, themes, attachments, browser artifacts,
and credentials stored in T3 home. Keep it private. Provider CLI credentials stored elsewhere, logs,
caches, project working files, and Git worktrees are not included; back up those separately.
The command verifies the database and records file checksums.
It never opens the source database for writing.

Restore into a new directory:

```sh
t3 backup restore --input /path/to/new-backup --home-dir /path/to/restored-t3
t3 serve --base-dir /path/to/restored-t3
```

Restore verifies the manifest, checksums, and database before publishing the restored data. It refuses
an existing destination. Use the same or a newer fork build to open it; database migrations can prevent
older builds from reading it. Settings and scheduled work are retained, so review schedules before
starting a restored server on another machine. Project paths still refer to their original locations.

## Identify a fork build

Settings shows the client version and commit. Connections shows each server's commit; mobile shows it
in the environment's settings. A build made with local edits is marked accordingly. Builds without
commit metadata show it as unknown. A matching version number alone does not mean two forks have the
same changes.

## Limit continuous work

Open **Settings → General → Run limits** and choose environment defaults or a thread. On mobile,
use environment settings for defaults or **Thread actions → Run limits** for a thread. Limits start
unlimited. A thread can set its own values, remove its limits, or return to environment defaults.

A time limit covers a run and its automatic continuations. Output-token limits use reported main-agent
usage, including reasoning; they are checked when usage is available and can overshoot between reports.
Providers without normalized usage reports support the time limit. Reaching a limit requests Stop and
holds queued messages. Stop remains visible as **Stopping…** until termination is confirmed; it can be retried.
Agents can read or change thread limits with `t3_thread_limits`.
