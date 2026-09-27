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

Live Operations and the Director report saved evidence and work state. Organization worker activation is currently unavailable; a published draft does not authorize autonomous execution. The runtime retains uncertain scoped launches and resource permits for recovery instead of assuming that an interrupted process stopped.
