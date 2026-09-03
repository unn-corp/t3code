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
- **Start work** refreshes the repository's remote default branch when `origin` is available, creates a dedicated worktree from that commit, and starts an implementation agent. After validation, the agent commits and pushes its isolated branch and opens a draft pull request targeting the captured default branch. It leaves the pull request in draft until a user marks it ready for review, and it never pushes directly to or merges the default branch. If repository credentials or validation block delivery, the agent leaves the worktree intact and reports the blocker instead of marking the finding done.
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

To control one project independently, open its **Project settings**, then **Automations**. Repository reviews, continuous improvement, product opportunity discovery, decision follow-up, pull request rollups, and inactive worktree cleanup each have their own switch. Turning off a type prevents only that scheduled automation from selecting the project, applies to every checkout in the project group, and leaves manual actions available.

## Product opportunity discovery

Product opportunity discovery adds a dedicated product and UX lane to scheduled repository reviews. It traces real user and operator workflows, then applies a second product-value critique that rejects bugs, security issues, refactors, test-only work, dependency updates, generic performance claims, and code cleanup. A review can return zero opportunities when the evidence does not support one.

Before enabling it for a project, open **Project settings**, then **Product context**. Choose a repository-relative Markdown document, such as `PRODUCT.md`, and select **Start conversation**. The agent first inspects the repository, separates evidence from assumptions, and interviews you about users, workflows, direction, UX principles, constraints, non-goals, terminology, and success signals. It shows the complete document and asks for approval before writing it. Mark the document **Confirmed for automation** when it represents the product accurately.

Confirmed context is required for scheduled opportunity discovery. Each opportunity records the affected user, current experience, proposed experience, expected value, repository evidence, and relevant product context. Product opportunities remain **Needs research** until a user chooses a direction; they never enter unattended Continuous Improvement directly.

## Decision Follow-up

Turn on **Decision follow-up** under **Settings**, then **Automation** to have T3 start read-only conversations about important findings that automation cannot safely resolve. You can configure the scan interval, reminder window, number of conversations per scan, minimum severity, eligible reasons, and the conversation model. Product opportunities remain eligible regardless of their severity.

Decision Follow-up handles findings that need product context or human judgment and ready findings above the Continuous Improvement risk limit. Each conversation explains what T3 found, why automation stopped, what remains uncertain, and concrete options with tradeoffs before asking one focused question. Project settings can disable these conversations independently.

Approving a product direction does not lower technical risk. Work above the unattended risk limit must continue in a separately authorized, supervised implementation thread. Reminder windows prevent duplicate conversations about the same unresolved finding.

## Continuous Improvement Mode

Open **Settings**, then **Automation**, and turn on **Continuous Improvement Mode** to let T3 work through pending **Ready for automation** findings while T3 is open. The mode is off by default. The same section lets you choose the implementation agent's provider account, model, and effort independently from discovery and qualification. Set the highest allowed risk tier and minimum evidence confidence to define which qualified findings may launch unattended.

Continuous improvement uses the same guarded implementation brief as **Start work**. It refreshes `origin` when available, creates an isolated `t3/*` worktree from the repository's detected default branch, and runs the project setup script. By default, the implementation agent validates, commits, pushes its branch, and opens one draft pull request against the default branch. It leaves the pull request in draft for user review and never pushes to the default branch or merges the pull request. Draft status does not by itself suppress GitHub Actions; repositories that defer CI until review must configure their workflows to skip draft pull requests.

Turn on **Consolidate pull requests** to have each automated implementation inspect open pull requests before editing. When an open pull request has a coherently related goal and overlapping code, the agent builds on its head commit and updates that pull request instead of opening a duplicate. Unrelated work remains isolated in a new draft pull request.

T3 also watches the linked work session for progress. If the agent remains inactive, T3 sends up to three progress checks with increasing wait times. If a turn finishes without the expected pull request, T3 asks the same agent to finish the delivery handoff. When the agent verifies that the finding is stale or invalid, T3 dismisses the finding with the reported reason instead of requesting a pull request. Runs that still do not progress are moved to **Needs attention**. Approval and user-input requests are surfaced immediately instead of receiving an automated response. After T3 verifies the pull request or closes a stale finding and confirms that background work is complete, it settles the thread and stops its provider session while keeping the thread available for review.

**Remove completed worktrees** is on by default. After a draft pull request is delivered or a stale finding is closed, T3 safely removes the automation worktree. It never forces removal, so a worktree with unexpected uncommitted changes is retained and the failed cleanup is recorded for inspection. Turn the setting off when you want completed automation worktrees to remain available on disk.

## Pull request rollups

Open **Settings**, then **Automation**, and turn on **Pull request rollup** to periodically review outstanding GitHub pull requests across connected repositories. The first scan starts after the setting is enabled, then repeats on the configured N-day interval. Each eligible repository gets an isolated agent worktree and one pre-release rollup pull request. T3 never merges or closes the source pull requests, pushes directly to the target branch, or merges the generated rollup pull request.

The automation can include draft pull requests, ready pull requests, or both. You can also require a period of inactivity, cap the number handled per repository, choose the target branch, branch prefix, pull request title, draft state, model, and completed-worktree cleanup. Repair controls determine whether the agent may fix failing checks on source branches or resolve conflicts on the isolated rollup branch, with a configurable attempt limit. Additional instructions can add validation or release-note requirements to every run.

Rollup runs appear in **Agent Dashboard**, then **Runs**, alongside the generated work session. A run succeeds only after T3 verifies a pull request from the isolated rollup branch in the configured draft state. Runs that need approval, user input, or manual follow-up remain visible as partial or failed work instead of being reported as complete.

## Inactive worktree cleanup

Open **Settings**, then **Automation**, and turn on **Inactive worktree cleanup** to remove old T3 worktrees on a configurable schedule. Set both the number of days between scans and the minimum inactive age. You can exclude an individual project from this automation in its **Project settings**.

Cleanup is intentionally conservative. Every thread using the worktree must be settled and inactive, with no running turn, provider session, background work, approval, or user-input request. T3 requires a clean Git status, a normal branch with a configured upstream, and a successful remote fetch. It then confirms that the exact remote branch still exists and contains the worktree's current commit before using Git's clean-only worktree removal. Dirty worktrees, detached heads, unpushed commits, missing or deleted upstream branches, and unavailable remotes are retained. Cleanup removes only the worktree; local and remote branches remain available.

T3 starts at most one finding-linked implementation agent at a time across the portfolio. It skips dismissed, blocked, snoozed, completed, unqualified, already-linked, repository-disabled, and policy-held findings. Higher severity and confidence are selected first; repository rotation then prevents one project from monopolizing the queue before older findings break remaining ties. If launch setup fails, T3 releases the finding for a later retry and applies a cooldown so it does not create a retry storm.

## Other dashboard views

- **Overview** shows repository, worktree, branch, portfolio health, and a focused **Needs you now** queue. Never-reviewed repositories are labeled **Unassessed**, not healthy.
- **Agent Feed** shows recent agent activity. Durable feed cards and their copied images are deleted after two days.
- **Runs** shows automation history, stage, duration, repository name, coverage, next due time, filters, and retry feedback.
- On mobile, open **Settings**, then **Agent Dashboard** for a compact portfolio-health, priority-finding, and active-run view.
