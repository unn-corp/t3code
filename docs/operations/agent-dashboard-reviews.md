# Agent Dashboard findings operations

The T3-owned findings portfolio scheduler is the source of truth for automatic collection. It
wakes every 30 seconds and runs immediately after first startup, then maintains a two-hour cadence.
Each cycle scans every stable project with the research, engineering, operations, and security
collectors before enqueueing one rotating deep repository review. That review evaluates bugs,
security, research opportunities, improvements, operational risks, and general review findings.

The shared review job service owns the single-worker limit, provider dispatch, turn monitoring,
structured finding ingestion, retries, and durable run history. The former standalone security
schedule is not started, which prevents duplicate scans and conflicting health state.

## What was watching the integration agents

Last night's integration work was watched by an external `agent-dashboard-hourly-monitor.mjs`
process. It was intended to supervise the orchestration program supervisor, not the T3 dashboard
findings scheduler or the individual integration workers. It read persisted program state, a PID
file, and `ps` output, then started a recovery supervisor when the program appeared to be running
without its supervisor.

That monitor had two gaps:

- the persisted `running` flag could remain true after a worker stalled;
- the PID and command checks did not prove that the expected worker was making progress.

The result was a false heartbeat. The monitor repeatedly reported that ADW-04 was running even
though no provider process was present, and later recovery messages did not establish that the
workstream had completed.

## Truthful lifecycle

Each review now moves through this sequence:

`queued` -> `running` -> `ingesting` -> `succeeded`, `partial`, or `failed`

The review is not successful until structured findings have been written to the canonical finding
store. A missing assistant message, malformed metadata after bounded correction attempts, an
exhausted idle-progress lease, or a failed finding write produces a non-success terminal state.
There is no total run-duration limit. The job service advances `updatedAt` only when provider
messages, activities, or turn state demonstrate progress, so polling alone cannot create a false
heartbeat.

Finding dispositions use a separate reversible lifecycle. Starting linked work moves a finding to
`in-progress`; completing verified work moves it to `done`; and Reopen returns it to `open`. Done
findings stay visible for auditability but no longer contribute to repository attention counts.

On server startup, queued work is relaunched and running or ingesting repository reviews reconnect
to their durable T3 thread. Only a run whose project or thread can no longer be resolved becomes a
restart failure. Continuous implementation runs use the same reconnect-first policy. The dashboard
exposes run history, target repository, model, retry count, finding count, errors, coverage
freshness, collector health, and the finding types attempted and successfully completed by the
latest cycle. Repositories without a successful cycle remain explicitly unassessed.

## Recovery checks

1. Open Agent Dashboard, then Runs and coverage.
2. Confirm that no run is left in `queued`, `running`, or `ingesting` without a recent `updatedAt`.
3. Inspect the repository coverage row and the collector state before retrying.
4. Retry only a terminal failed or partial run. Retries are bounded and recorded as external
   actions with the originating run id.
5. If the server restarted, verify that the old run reconnected to its existing thread. Retry only
   when T3 reports that durable recovery was impossible.

The durable files live below the configured server state directory in `agent-dashboard/`:

- `automation-runs.json` stores lifecycle history;
- `findings.json` stores deduplicated cross-run findings and dispositions;
- `repository-policies.json` stores cadence, priority, exclusions, and enabled checks;
- `repository-coverage.json` stores freshness, backoff, and consecutive failures;
- `collector-states.json` stores available, partial, and unavailable integration health.
- `research-watchlist.json` stores user-managed repository research topics and sources.
- `feed.jsonl` stores recent durable activity. Cards older than two days and their owned image assets
  are pruned during store activity and startup.
- `review-schedule.json` stores the consolidated portfolio cadence and latest type coverage. The
  filename is retained so existing installations migrate without losing scheduler history.

Pull request discovery and merging are live project-scoped operations rather than collected
findings. The server resolves the registered project and its GitHub remote, runs `gh` from that
project's workspace, and never accepts an arbitrary repository path from the client. A merge
requires an explicit strategy and the head commit observed during review; GitHub's
`--match-head-commit` guard rejects stale confirmations. Successful merge submissions are recorded
in the dashboard external-action audit trail; a protected branch may still place the PR in its
GitHub merge queue.

Automated repository review uses the explicit `automated-review` runtime. Only an adapter that
declares support may start it. The Codex implementation uses read-only sandboxing and disables
network access for the turn. A prompt or repository instruction cannot change those runtime
controls.
