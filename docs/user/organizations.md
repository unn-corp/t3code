# Organizations

Organizations keep a mission, team structure, workflows, decisions, and evidence together. They can exist without a Project. Link a Project from **Governance** when you want the Organization to refer to it.

## Design with AI

Open an Organization and choose **Designer**. The canvas and Architect conversation show the same draft. Choose a configured provider and model, then use **Guide me through the design** or describe the team you want. The Architect asks focused questions about the mission, responsibilities, review relationships, workflows, resources, and authority. It may suggest roles and connections as the conversation progresses.

Review each suggested change beside the canvas. **Apply all to draft** commits the suggestions from one reply together, so related roles, connections, and workflow definitions arrive in one revision. You can also apply a single suggestion or edit the canvas and forms yourself. An older suggestion cannot overwrite a newer draft. **Publish** in Governance captures a validated configuration version; it does not start workers.

## Share through GitHub

Choose **Repository** within an Organization to inspect the share preview, create or link a dedicated GitHub repository, and save and sync. New repositories default to private. The repository holds portable configuration history, conversations, memory, sanitized observations, findings, work records, and audit history. The shared archive shows incoming records and conflicts by category. Choose a conflict result explicitly; a remote record remains attributed reference material until you review it locally. You can save an Organization-scoped shared memory record as a local memory reference after reviewing it.

On another installation, choose **Load a shared Organization** from the Organizations page and enter `OWNER/REPO`. T3 opens it as a local draft with the shared archive available. Reconnect local Projects, accounts, budgets, and permissions before publishing. Source secrets, tokens, local paths, live processes, resource permits, and machine-specific access are kept local.

The Repository view shows pending local records, incoming records, conflicts, and the last accepted commit. **Sync automatically** is selected by default when linking or loading. T3 checks linked repositories in the background about every two minutes, and retries temporary failures with a delay. You can choose manual sync and use **Save and sync** whenever you want to send or receive changes. If a push races with another user, the pending records remain local so you can sync again and resolve any same-record conflict.

## Operating state

Live Operations and the Director report saved evidence and work state. On a Linux host with the scoped worker available, publish a workflow with work, independent QA, approval, and integration steps. Link a Project with write access, then open a current work intent and choose **Prepare one file for Project work**. Select a flat `.mjs` file in the Project root, a Git branch at the current HEAD that is not checked out in any worktree, a configured Codex or Claude model, and one to eight JSON examples for QA. **Start reviewed work** queues the change; review the proposed patch before approving Git integration. The worker checks runtime recovery before accepting work and retains uncertain launches for inspection.

This first Project execution path changes one explicitly selected file per work intent. For an enabled, Project-scoped HTTP source, choose **Automatically start matching Project work** while preparing an intent to authorize a bounded number of future matching intents. The grant fixes the Project, source, file, branch, workflow, model, task, and QA examples, expires within 30 days, and can be revoked in Governance. Each Git integration still asks for your approval. Pause is available after active worker phases settle and stops new scheduling. **Drain and pause** finishes admitted work phases without starting another, then pauses the Organization. Resume rechecks runtime readiness. Cancel acts on one selected work item and may require a worker scope to be verified stopped first. **Request emergency stop** blocks new work and interrupts admitted work; Governance shows outstanding process verification instead of claiming an immediate completed stop. If a crash leaves a provider launch unverified, new Project work stays blocked. Restarting the host clears an unresolved launch from a previous boot; work does not resume automatically while its process identity remains uncertain. Set the host, Organization, and Project provider ceilings before starting; zero blocks provider dispatch.

### Host provider ceiling

An administrator of the machine running T3 Code can inspect and set the shared Organization provider ceiling from that machine's CLI. Use the same absolute data directory passed to the server as `--base-dir`. The database must already exist; these commands do not create an installation.

```sh
t3 organization-budget show --base-dir /absolute/path/to/t3-data
t3 organization-budget set --base-dir /absolute/path/to/t3-data \
  --expected-revision 1970-01-01T00:00:00.000Z \
  --max-concurrent 2 --max-daily-calls 5 --max-daily-estimated-tokens 700000
```

Copy `revision` from the `show` output into `set`. A stale revision fails so another administrator's change is not overwritten. The example permits at most five single-file proposals at the current conservative reservation of 140,000 estimated tokens each; actual provider usage may differ. The limits are shared across Organizations; Organization and Project ceilings must also be configured before provider calls can run. A limit of zero blocks that dimension. Only someone with local access to the server's data directory should run this command.
