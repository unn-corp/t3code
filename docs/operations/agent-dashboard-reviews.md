# Agent Dashboard review operations

The T3-owned review scheduler and job service are the source of truth for repository reviews.
The scheduler wakes every 30 seconds, keeps the two-hour cadence, and enqueues work through the
shared review job service. The job service owns the single-worker limit, provider dispatch,
turn monitoring, structured finding ingestion, retries, and durable run history.

## What was watching the integration agents

Last night's integration work was watched by an external `agent-dashboard-hourly-monitor.mjs`
process. It was intended to supervise the orchestration program supervisor, not the T3 dashboard
review scheduler or the individual integration workers. It read persisted program state, a PID
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
store. A missing assistant message, malformed metadata, timeout, or failed finding write produces
a non-success terminal state. The job service also persists `updatedAt` during a long provider
turn, so a worker heartbeat reflects actual polling progress rather than only enqueue time.

On server startup, queued, running, and ingesting runs are recovered as failed with a restart
reason. The dashboard exposes run history, target repository, model, retry count, finding count,
errors, coverage freshness, and collector health.

## Recovery checks

1. Open Agent Dashboard, then Runs and coverage.
2. Confirm that no run is left in `queued`, `running`, or `ingesting` without a recent `updatedAt`.
3. Inspect the repository coverage row and the collector state before retrying.
4. Retry only a terminal failed or partial run. Retries are bounded and recorded as external
   actions with the originating run id.
5. If the server restarted, verify that the old run is marked failed before starting a new one.

The durable files live below the configured server state directory in `agent-dashboard/`:

- `automation-runs.json` stores lifecycle history;
- `findings.json` stores deduplicated cross-run findings and dispositions;
- `repository-policies.json` stores cadence, priority, exclusions, and enabled checks;
- `repository-coverage.json` stores freshness, backoff, and consecutive failures;
- `collector-states.json` stores available, partial, and unavailable integration health.

Automated repository review uses the explicit `automated-review` runtime. Only an adapter that
declares support may start it. The Codex implementation uses read-only sandboxing and disables
network access for the turn. A prompt or repository instruction cannot change those runtime
controls.
