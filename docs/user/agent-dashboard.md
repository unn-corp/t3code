# Agent Dashboard

The Agent Dashboard brings repository health, agent activity, automation runs, and actionable findings together across your connected projects.

## Findings

Open **Agent Dashboard**, then **Findings** to review one canonical list of:

- Bugs
- Security risks
- Research findings
- Improvement ideas
- Review findings
- Operational findings

Findings are grouped into closed project sections so the portfolio stays compact. Expand a project to review its findings and pull requests. Use search, project, status, severity, type, and priority sorting together to narrow the list. Type counts update with the active filters.

The default **Active pipeline** view follows unresolved work from first signal to delivery. The pipeline summary separates **Needs qualification**, **Ready for automation**, **Needs approval**, **In delivery**, and **Resolved** findings. Each held finding explains what is missing. Qualified work moves to **Needs approval** when its risk exceeds the automation limit or its evidence confidence is below the configured minimum. Dismissed and blocked findings remain available under **Resolved** and **Archived** for traceability and can be reopened.

Select individual findings or all visible results for bulk completion, three-day snoozing, or dismissal. **Details and triage** shows the full evidence and proposal, and lets you record an assignee, decision note, or a one-day to 30-day snooze.

## Acting on a finding

Available actions depend on the finding and repository:

- **Investigate** starts a repository-grounded qualification pass for any signal that does not yet have a concrete implementation plan.
- Expand **Ask about this finding** at the bottom of a finding to type or dictate a question with the microphone control. The composer is closed by default to keep the findings list compact. Choose any enabled provider and model, adjust its effort or other supported traits, and set the session access level before sending. Press Enter or select the send arrow to start a new repository session with the finding context, evidence, and your question preloaded. Use Shift+Enter for a new line. This does not replace the finding's linked implementation thread.
- **Start work** refreshes the repository's remote default branch when `origin` is available, creates a dedicated worktree from that commit, and starts an implementation agent. After validation, the agent commits and pushes its isolated branch and opens a pull request targeting the captured default branch. It never pushes directly to or merges the default branch. If repository credentials or validation block delivery, the agent leaves the worktree intact and reports the blocker instead of marking the finding done.
- **Open work** returns to the linked agent thread.
- **Create issue** records the finding in a connected GitHub repository.
- **Done**, **Snooze**, **Dismiss**, and **Reopen** update the finding's reversible workflow state.

Each project section also includes a closed-by-default **Pending pull requests** workspace. Expand it to review open GitHub PRs, check and approval status, source and target branches, and merge readiness. Select **Merge**, confirm the exact PR and reviewed commit, then choose squash, merge commit, or rebase. T3 refuses the operation if the PR head changed after it was reviewed. Drafts, conflicts, requested changes, failing checks, and GitHub-reported blockers keep the direct merge action disabled. GitHub may place an accepted merge into a protected branch's merge queue.

To consolidate related work, select two or more PRs in the same project that target the same branch, then choose **Combine PRs**. The review sheet lets you set their integration order, name the replacement PR, and choose the agent model, effort, and access level. T3 launches the work in a fresh worktree. The agent verifies every reviewed head commit, integrates and validates the changes, then opens one new PR. It does not merge, close, retarget, or modify the source PRs. A GitHub remote and an authenticated `gh` CLI are required; the workspace provides the remediation path when either is missing.

Use **Collect findings** to start the local research, engineering, and security collectors and request a repository review. Collector availability remains visible so an unavailable integration is not mistaken for a clean result. If the research watchlist is missing, select **Set up research**, choose a repository, and add a topic or source; T3 saves and collects it immediately.

The same complete cycle runs automatically while T3 is open. Open **Settings**, then **Automation** to enable or pause scheduled discovery and qualification, choose a cadence from 15 minutes to one day, and choose its provider account, model, and effort. The default cadence is every two hours.
The schedule strip reports when collection last finished, when it will run again, and how many
finding types were attempted versus completed. Missing optional research watchlists are shown separately from collectors
that need attention. Repository sections remain closed until you choose one to inspect.
Only evidence-backed findings are created, so a successful cycle may produce zero items for a type
when the project does not contain a defensible issue.

## Continuous Improvement Mode

Open **Settings**, then **Automation**, and turn on **Continuous Improvement Mode** to let T3 work through pending **Ready for automation** findings while T3 is open. The mode is off by default. The same section lets you choose the implementation agent's provider account, model, and effort independently from discovery and qualification. Set the highest allowed risk tier and minimum evidence confidence to define which qualified findings may launch unattended.

Continuous improvement uses the same guarded implementation brief as **Start work**. It refreshes `origin` when available, creates an isolated `t3/*` worktree from the repository's detected default branch, runs the project setup script, and asks the implementation agent to validate, commit, push its branch, and open one pull request against that default branch. It never pushes to the default branch or merges the pull request.

T3 starts at most one finding-linked implementation agent at a time across the portfolio. It skips dismissed, blocked, snoozed, completed, unqualified, already-linked, repository-disabled, and policy-held findings. Higher severity and confidence are selected first, with older findings breaking ties. If launch setup fails, T3 releases the finding for a later retry and applies a cooldown so it does not create a retry storm.

## Other dashboard views

- **Overview** shows repository, worktree, branch, portfolio health, and a focused **Needs you now** queue. Never-reviewed repositories are labeled **Unassessed**, not healthy.
- **Agent Feed** shows recent agent activity. Durable feed cards and their copied images are deleted after two days.
- **Runs** shows automation history, stage, duration, repository name, coverage, next due time, filters, and retry feedback.
- On mobile, open **Settings**, then **Agent Dashboard** for a compact portfolio-health, priority-finding, and active-run view.
