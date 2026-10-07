/** Python's standard HTTP client honors HTTP(S)_PROXY, including HTTPS CONNECT in Codex Cloud. */
export const cloudWorkerSource = String.raw`#!/usr/bin/env python3
import codecs, json, os, queue, shutil, signal, subprocess, sys, threading, time, urllib.request, urllib.error, uuid

def main():
    origin = os.environ.get("T3_CLOUD_CONTROLLER", "").rstrip("/")
    token = os.environ.get("T3_CLOUD_TOKEN", "")
    cwd = os.path.realpath(os.environ.get("T3_CLOUD_CWD", os.getcwd()))
    if not origin or not token or not os.path.isdir(cwd):
        sys.exit("Set T3_CLOUD_CONTROLLER, T3_CLOUD_TOKEN, and T3_CLOUD_CWD before starting.")
    instance = str(uuid.uuid4())
    agents = [a for a in ("codex", "claude") if shutil.which(a)]
    if not agents: sys.exit("Install Codex CLI or Claude Code first.")
    active = None
    events = queue.Queue(maxsize=128)
    sequence = 0
    pending = None
    buffered = ""
    session = None
    last_contact = time.monotonic()
    last_ack = last_contact
    json_buffer = ""
    agent_error = False
    stopped = False

    def stop(signum=None, frame=None):
        nonlocal stopped
        stopped = True
        if active: kill_group(active["process"], signal.SIGTERM)

    def kill_group(process, sig):
        try: os.killpg(process.pid, sig)
        except ProcessLookupError: pass
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    def request(path, body):
        req = urllib.request.Request(origin + "/api/codex-cloud/worker/" + path,
            data=json.dumps(body).encode(), headers={"Authorization": "Bearer " + token,
            "Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=15) as response:
            return json.loads(response.read(2000000))

    def pump(stream):
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        while True:
            chunk = stream.read(4096)
            if not chunk: break
            events.put(decoder.decode(chunk))
        tail = decoder.decode(b"", final=True)
        if tail: events.put(tail)
        stream.close()

    def feed(stream, prompt):
        try: stream.write(prompt.encode())
        except (BrokenPipeError, OSError): pass
        finally: stream.close()

    print("Cloud worker ready; waiting for T3 jobs.", flush=True)
    try:
        while not stopped:
            if time.monotonic() - last_contact > 60 or (pending and time.monotonic() - last_ack > 60):
                print("Controller unavailable for 60 seconds; stopping worker.", file=sys.stderr)
                stop()
                break
            if active and active.get("cancel_at") and time.monotonic() - active["cancel_at"] > 5:
                kill_group(active["process"], signal.SIGKILL)
            try:
                response = request("poll", {"instanceId": instance, "agents": agents,
                    "activeRunId": active["job"]["id"] if active else None})
                last_contact = time.monotonic()
                if active and response.get("cancel"):
                    if not active["cancelled"]:
                        active["cancelled"] = True
                        active["cancel_at"] = time.monotonic()
                        kill_group(active["process"], signal.SIGTERM)
                job = response.get("job")
                if job and active is None:
                    if job["agent"] == "claude":
                        args = ["claude", "-p", "--output-format", "stream-json", "--verbose",
                            "--permission-mode", "acceptEdits", "--allowedTools", "Read,Edit,Write,Bash,Glob,Grep"]
                        if job.get("sessionId"): args += ["--resume", job["sessionId"]]
                    else:
                        args = ["codex", "exec", "--json", "-c", 'approval_policy="never"']
                        if job.get("sessionId"): args += ["resume", job["sessionId"], "-"]
                        else: args += ["--sandbox", "workspace-write", "-"]
                    env = dict(os.environ)
                    for key in ("T3_CLOUD_TOKEN", "T3_CLOUD_CONTROLLER"): env.pop(key, None)
                    process = subprocess.Popen(args, cwd=cwd, env=env, stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True, bufsize=0)
                    active = {"job": job, "process": process, "cancelled": False, "thread": None}
                    sequence, buffered, session, json_buffer = 0, "", job.get("sessionId"), ""
                    agent_error = False
                    last_ack = time.monotonic()
                    thread = threading.Thread(target=pump, args=(process.stdout,), daemon=True)
                    thread.start()
                    active["thread"] = thread
                    threading.Thread(target=feed, args=(process.stdin, job["prompt"]), daemon=True).start()
                while len(buffered) < 30000:
                    try:
                        chunk = events.get_nowait()
                        buffered += chunk
                        json_buffer += chunk
                        while "\n" in json_buffer:
                            line, json_buffer = json_buffer.split("\n", 1)
                            try:
                                event = json.loads(line)
                                if event.get("is_error") is True or event.get("type") == "turn.failed": agent_error = True
                                candidate = event.get("session_id") or event.get("thread_id")
                                if isinstance(candidate, str) and len(candidate) <= 160 and all(c.isascii() and (c.isalnum() or c in "_-") for c in candidate): session = candidate
                            except (ValueError, AttributeError): pass
                        if len(json_buffer) > 262144: json_buffer = ""
                    except queue.Empty: break
                if active:
                    process = active["process"]
                    finished = process.poll() is not None and not active["thread"].is_alive() and events.empty()
                    if pending is None and (buffered or finished):
                        sequence += 1
                        status = "running"
                        if finished: status = "cancelled" if active["cancelled"] else ("completed" if process.returncode == 0 and not agent_error else "failed")
                        pending = {"runId": active["job"]["id"], "instanceId": instance,
                            "sequence": sequence, "output": buffered[:30000], "status": status,
                            "sessionId": session}
                        buffered = buffered[30000:]
                        # Drain large final output in running batches before the terminal event.
                        if buffered: pending["status"] = "running"
                    if pending:
                        request("event", pending)
                        last_ack = time.monotonic()
                        if pending["status"] != "running":
                            if active["cancelled"]: kill_group(active["process"], signal.SIGKILL)
                            active = None
                        pending = None
                time.sleep(2)
            except urllib.error.HTTPError as error:
                if error.code in (401, 403, 409, 410):
                    print("Worker authorization or instance binding rejected; stopping.", file=sys.stderr)
                    stop()
                else: time.sleep(3)
            except (OSError, ValueError) as error:
                if active and active["process"].poll() is not None and pending is None:
                    sequence += 1
                    pending = {"runId": active["job"]["id"], "instanceId": instance,
                        "sequence": sequence, "output": "Worker process failed.\n", "status": "failed", "sessionId": session}
                time.sleep(3)
    finally:
        stop()
        if active:
            try: active["process"].wait(timeout=5)
            except subprocess.TimeoutExpired:
                kill_group(active["process"], signal.SIGKILL)
                active["process"].wait()
            finally: kill_group(active["process"], signal.SIGKILL)

if __name__ == "__main__": main()
`;
