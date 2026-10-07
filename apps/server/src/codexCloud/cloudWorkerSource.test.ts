// @effect-diagnostics nodeBuiltinImport:off -- Exercises the downloadable Python worker at a real process/HTTP boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { cloudWorkerSource } from "./cloudWorkerSource.ts";

type WorkerEvent = {
  runId: string;
  sequence: number;
  output: string;
  status: string;
  sessionId: string | null;
};
const job = (id: string, sessionId: string | null = null) => ({
  id,
  agent: "claude",
  prompt: `Harmless fixture ${id}`,
  sessionId,
});

async function runWorker(
  agent: string,
  handle: (path: string, body: Record<string, unknown>) => { status?: number; body: unknown },
  inspect: (dir: string) => Promise<void>,
  useProxy = false,
) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-cloud-worker-fixture-"));
  const server = NodeHttp.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.headers.authorization !== "Bearer fixture-credential") {
      res.writeHead(401);
      res.end();
      return;
    }
    try {
      const result = handle(req.url ?? "", JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(result.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(result.body));
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const workerPath = NodePath.join(dir, "worker.py");
  await NodeFSP.writeFile(workerPath, cloudWorkerSource);
  await NodeFSP.writeFile(NodePath.join(dir, "claude"), `#!/usr/bin/env python3\n${agent}`, {
    mode: 0o700,
  });
  const worker = NodeChildProcess.spawn("python3", [workerPath], {
    cwd: dir,
    detached: true,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      NO_PROXY: useProxy ? "" : "127.0.0.1",
      no_proxy: useProxy ? "" : "127.0.0.1",
      ...(useProxy ? { http_proxy: `http://127.0.0.1:${address.port}` } : {}),
      T3_CLOUD_CONTROLLER: useProxy
        ? "http://controller.fixture.invalid"
        : `http://127.0.0.1:${address.port}`,
      T3_CLOUD_TOKEN: "fixture-credential",
      T3_CLOUD_CWD: dir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  worker.stdout.on("data", (chunk) => {
    logs += chunk.toString();
  });
  worker.stderr.on("data", (chunk) => {
    logs += chunk.toString();
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      worker.once("exit", resolve);
      worker.once("error", reject);
    });
    expect(code, logs).toBe(0);
    expect(logs).not.toContain("fixture-credential");
    await inspect(dir);
  } finally {
    if (worker.exitCode === null && worker.pid) {
      try {
        process.kill(-worker.pid, "SIGKILL");
      } catch {
        /* Already stopped. */
      }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
}

it.skipIf(HostProcessPlatform.defaultValue() === "win32")(
  "streams Unicode output, retries the same event, and resumes Claude without passing controller credentials",
  async () => {
    const events: WorkerEvent[] = [];
    const accepted = new Map<string, WorkerEvent>();
    let nextJob = 0;
    let failOnce = true;
    await runWorker(
      String.raw`import json, os, sys
prompt = sys.stdin.read()
resumed = "--resume" in sys.argv
name = "resumed.json" if resumed else "first.json"
with open(name, "w") as f: json.dump({"prompt": prompt, "args": sys.argv[1:], "token": os.environ.get("T3_CLOUD_TOKEN"), "origin": os.environ.get("T3_CLOUD_CONTROLLER")}, f)
print(json.dumps({"session_id": "fixture_session"}), flush=True)
if not resumed: sys.stdout.write("🦑" * 40000 + "\n")
print(json.dumps({"type": "result"}), flush=True)
`,
      (path, body) => {
        if (path.endsWith("/poll")) {
          if (accepted.get("second-terminal")) return { status: 401, body: {} };
          if (body.activeRunId === null && nextJob === 0) {
            nextJob++;
            return { body: { job: job("first"), cancel: false } };
          }
          if (body.activeRunId === null && nextJob === 1 && accepted.get("first-terminal")) {
            nextJob++;
            return { body: { job: job("second", "fixture_session"), cancel: false } };
          }
          return { body: { job: null, cancel: false } };
        }
        const event = body as unknown as WorkerEvent;
        events.push(event);
        accepted.set(`${event.runId}-${event.sequence}`, event);
        if (event.status === "completed") accepted.set(`${event.runId}-terminal`, event);
        if (failOnce) {
          failOnce = false;
          return { status: 503, body: {} };
        }
        return { body: { accepted: true } };
      },
      async (dir) => {
        const first = JSON.parse(await NodeFSP.readFile(NodePath.join(dir, "first.json"), "utf8"));
        const resumed = JSON.parse(
          await NodeFSP.readFile(NodePath.join(dir, "resumed.json"), "utf8"),
        );
        expect(first.prompt).toBe("Harmless fixture first");
        expect(first.token).toBeNull();
        expect(first.origin).toBeNull();
        expect(resumed.args).toContain("--resume");
        expect(resumed.args).toContain("fixture_session");
        expect(resumed.prompt).toBe("Harmless fixture second");
        expect(events[0]).toEqual(events[1]);
        const output = [...accepted.entries()]
          .filter(([key]) => key.startsWith("first-") && !key.endsWith("terminal"))
          .map(([, event]) => event.output)
          .join("");
        expect(output.match(/🦑/gu)?.length).toBe(40000);
        expect(output).not.toContain("�");
        expect(accepted.get("first-terminal")?.sessionId).toBe("fixture_session");
      },
      true,
    );
  },
  30_000,
);

it.skipIf(HostProcessPlatform.defaultValue() === "win32")(
  "stops an unresponsive agent and its process group on cancellation",
  async () => {
    let dispatched = false;
    let running = false;
    let cancelled = false;
    await runWorker(
      String.raw`import json, os, signal, subprocess, sys
sys.stdin.read()
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = subprocess.Popen([sys.executable, "-c", "import signal; signal.signal(signal.SIGTERM, signal.SIG_IGN); signal.pause()"])
with open("pids.json", "w") as f: json.dump([os.getpid(), child.pid], f)
print(json.dumps({"session_id": "cancellable"}), flush=True)
signal.pause()
`,
      (path, body) => {
        if (path.endsWith("/poll")) {
          if (cancelled) return { status: 401, body: {} };
          if (!dispatched) {
            dispatched = true;
            return { body: { job: job("cancel"), cancel: false } };
          }
          return { body: { job: null, cancel: running } };
        }
        running = true;
        if (body.status === "cancelled") cancelled = true;
        return { body: { accepted: true } };
      },
      async (dir) => {
        expect(cancelled).toBe(true);
        const pids: number[] = JSON.parse(
          await NodeFSP.readFile(NodePath.join(dir, "pids.json"), "utf8"),
        );
        for (const pid of pids) {
          if (HostProcessPlatform.defaultValue() === "linux") {
            const status = await NodeFSP.readFile(`/proc/${pid}/status`, "utf8").catch(
              () => "State:\tZ",
            );
            expect(status).toMatch(/State:\s+Z/);
          } else expect(() => process.kill(pid, 0)).toThrow();
        }
      },
    );
  },
  30_000,
);
