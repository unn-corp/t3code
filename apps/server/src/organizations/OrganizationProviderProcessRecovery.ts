// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off globalDate:off preferSchemaOverJson:off tryCatchInEffectGen:off - Linux pidfd recovery is host local and returns bounded JSON evidence.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeUtil from "node:util";
import { OrganizationWorkError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const MARKER_RECORD = /^([a-f0-9]{64})\|(\d+(?:\.\d+)?)\|([a-f0-9-]{36})$/;

/** pidfd pins each matched process before the second marker/UID check and signal.
 * A denied /proc read, failed signal, or remaining marker yields held.
 */
const PIDFD_STOP = String.raw`
import json, os, select, signal, sys
marker = sys.argv[1]
known_pid = int(sys.argv[2])
prepared_uptime = float(sys.argv[3])
needle = ("T3_ORG_PROVIDER_LAUNCH_ID=" + marker).encode()
uid = os.getuid()
stopped = 0
ticks_per_second = os.sysconf('SC_CLK_TCK')

def started_before_marker(pid):
    try:
        with open('/proc/%d/stat' % pid, 'rb') as f:
            stat = f.read()
        fields = stat[stat.rfind(b')') + 2:].split()
        started = int(fields[19]) / ticks_per_second
        return started + 2 < prepared_uptime
    except (FileNotFoundError, ProcessLookupError):
        return True
    except Exception:
        return False

def scan():
    matches = []
    uncertain = False
    for name in os.listdir('/proc'):
        if not name.isdigit():
            continue
        pid = int(name)
        try:
            with open('/proc/%d/status' % pid, 'rb') as f:
                status = f.read()
            uid_line = next((line for line in status.splitlines() if line.startswith(b'Uid:')), None)
            if uid_line is None:
                uncertain = True
                continue
            uids = [int(part) for part in uid_line.split()[1:]]
            if uid not in uids:
                continue
            fd = os.pidfd_open(pid, 0)
            try:
                with open('/proc/%d/environ' % pid, 'rb') as f:
                    environ = f.read()
                if needle in environ.split(b'\0'):
                    matches.append((pid, fd))
                    fd = None
            finally:
                if fd is not None:
                    os.close(fd)
        except (FileNotFoundError, ProcessLookupError):
            continue
        except PermissionError:
            if not started_before_marker(pid):
                uncertain = True
        except OSError:
            uncertain = True
    return matches, uncertain

def wait_exit(fd, milliseconds):
    poll = select.poll()
    poll.register(fd, select.POLLIN)
    return bool(poll.poll(milliseconds))

def stop(pid, fd):
    global stopped
    try:
        with open('/proc/%d/status' % pid, 'rb') as f:
            status = f.read()
        uid_line = next(line for line in status.splitlines() if line.startswith(b'Uid:'))
        if uid not in [int(part) for part in uid_line.split()[1:]]:
            return False
        with open('/proc/%d/environ' % pid, 'rb') as f:
            if needle not in f.read().split(b'\0'):
                return False
        signal.pidfd_send_signal(fd, signal.SIGTERM)
        if not wait_exit(fd, 2000):
            signal.pidfd_send_signal(fd, signal.SIGKILL)
            if not wait_exit(fd, 2000):
                return False
        stopped += 1
        return True
    except (FileNotFoundError, ProcessLookupError):
        return wait_exit(fd, 0)
    except (PermissionError, OSError):
        return False

held = False
for _ in range(4):
    matches, uncertain = scan()
    held = held or uncertain
    if not matches:
        break
    for pid, fd in matches:
        try:
            if not stop(pid, fd):
                held = True
        finally:
            os.close(fd)
else:
    held = True
remaining, uncertain = scan()
held = held or uncertain or bool(remaining)
for _, fd in remaining:
    os.close(fd)
if known_pid > 0:
    try:
        with open('/proc/%d/stat' % known_pid, 'rb') as f:
            stat = f.read()
        state = stat[stat.rfind(b')') + 2:][:1]
        if state != b'Z':
            held = True
    except FileNotFoundError:
        pass
    except OSError:
        held = True
print(json.dumps({'clear': not held, 'stopped': stopped}))
`;

type ProviderRow = {
  work_id: string;
  organization_id: string;
  state: "launching" | "running";
  process_id: number | null;
  launch_marker: string | null;
};

/** This only runs before the live loop is granted. It never guesses a PID or
 * signals a process without a pinned pidfd and a repeated marker/UID check.
 */
export const recoverOrganizationProviderProcessesAtStartup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  let currentBootId: string | null = null;
  if (process.platform === "linux") {
    try {
      currentBootId = NodeFS.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {
      /* A missing boot identity keeps provider recovery closed. */
    }
  }
  const rows =
    yield* sql<ProviderRow>`SELECT work_id, organization_id, state, process_id, launch_marker
    FROM organization_provider_processes WHERE state <> 'exited'
    ORDER BY prepared_at LIMIT 129`;
  const held: { workId: string; reason: string }[] = [];
  if (rows.length > 128)
    held.push({ workId: rows[128]!.work_id, reason: "provider_recovery_batch_limit" });
  for (const row of rows.slice(0, 128)) {
    const marker = row.launch_marker && MARKER_RECORD.exec(row.launch_marker);
    if (
      process.platform !== "linux" ||
      !marker ||
      !currentBootId ||
      !Number.isFinite(Number(marker[2]))
    ) {
      held.push({ workId: row.work_id, reason: "provider_identity_unavailable" });
      continue;
    }
    if (marker[3] !== currentBootId) {
      const exitedAt = new Date().toISOString();
      yield* sql`UPDATE organization_provider_processes SET state = 'exited', exited_at = ${exitedAt}
        WHERE work_id = ${row.work_id} AND organization_id = ${row.organization_id}
          AND state <> 'exited' AND launch_marker = ${row.launch_marker}`;
      continue;
    }
    const result = yield* Effect.result(
      Effect.tryPromise({
        try: () =>
          execFile(
            "/usr/bin/python3",
            ["-c", PIDFD_STOP, marker[1]!, String(row.process_id ?? 0), marker[2]!],
            {
              env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
              timeout: 15_000,
              maxBuffer: 1024,
            },
          ),
        catch: () =>
          new OrganizationWorkError({
            code: "unavailable",
            message: "Provider pidfd recovery could not run.",
          }),
      }),
    );
    if (result._tag === "Failure") {
      held.push({ workId: row.work_id, reason: "provider_recovery_unavailable" });
      continue;
    }
    let clear = false;
    try {
      const parsed: unknown = JSON.parse(result.success.stdout);
      clear =
        typeof parsed === "object" &&
        parsed !== null &&
        "clear" in parsed &&
        parsed.clear === true &&
        "stopped" in parsed &&
        typeof parsed.stopped === "number" &&
        (row.state !== "launching" || parsed.stopped > 0);
    } catch {
      /* Invalid helper evidence is held. */
    }
    if (!clear) {
      held.push({ workId: row.work_id, reason: "provider_exit_unverified" });
      continue;
    }
    const exitedAt = new Date().toISOString();
    yield* sql`UPDATE organization_provider_processes SET state = 'exited', exited_at = ${exitedAt}
      WHERE work_id = ${row.work_id} AND organization_id = ${row.organization_id}
        AND state <> 'exited' AND launch_marker = ${row.launch_marker}`;
  }
  return { held };
});
