#!/usr/bin/env python3
"""Exercise a built application image using disposable, offline Docker resources."""

import argparse
import base64
import json
import os
from pathlib import Path
import selectors
import subprocess
import tempfile
import time
import uuid


def docker(*args, timeout=60):
    try:
        result = subprocess.run(
            ["docker", *args], capture_output=True, text=True, check=True, timeout=timeout
        )
        return (result.stdout + (result.stderr if args[0] == "logs" else "")).strip()
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f"Docker {args[0]} failed: {error.stderr[-2000:]}") from None


def ready(container):
    # Follow the explicit collaboration receipt; there are no personal pairing logs.
    child = subprocess.Popen(
        ["docker", "logs", "--follow", container],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            deadline = time.monotonic() + 60
            recent = b""
            while time.monotonic() < deadline:
                remaining = max(0, deadline - time.monotonic())
                if not selector.select(remaining):
                    break
                chunk = os.read(child.stdout.fileno(), 65536)
                if not chunk:
                    break
                recent = (recent + chunk)[-65536:]
                validate_service_logs(recent)
                if b"Teams collaboration service is ready." in recent:
                    return
        raise RuntimeError("Application did not emit its startup receipt; logs were not disclosed.")
    finally:
        child.terminate()
        child.wait(timeout=10)


SYNTHETIC_SECRET = "sk_test_container_smoke_synthetic"
SYNTHETIC_PUBLISHABLE = "pk_test_" + base64.b64encode(b"synthetic.clerk.accounts.dev$").decode()


def validate_service_logs(logs):
    for marker in (b"T3 Code server is ready.", b"pairingUrl:", b"pairing token", b"provider login"):
        if marker in logs:
            raise RuntimeError("Personal startup activity appeared in collaboration logs; logs withheld.")


def isolated_run_args(suffix, volume, secret):
    return [
        "--init", "--network", "none", "--read-only", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true",
        "--cpus", "2", "--memory", "2g", "--memory-swap", "2g", "--pids-limit", "256",
        "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=134217728,mode=1777",
        "--mount", f"type=volume,src={volume},dst=/data",
        "--mount", f"type=bind,src={secret},dst=/run/secrets/clerk_secret_key,readonly",
        "--label", f"ai.arcwright.team-service.smoke={suffix}",
    ]


def expect_config_failure(image, arguments):
    container = docker("run", "--detach", *arguments, image)
    try:
        code = int(docker("wait", container, timeout=60))
        output = docker("logs", container)
        assert code != 0, "Missing required config must fail startup"
        assert "T3_TEAM_CLERK" in output or "T3_TEAM_ORIGINS" in output, "Failure must name required configuration"
        assert SYNTHETIC_SECRET not in output, "Startup must not disclose the secret"
        assert "Teams collaboration service is ready." not in output, "Invalid service must not be ready"
        validate_service_logs(output.encode())
    finally:
        docker("rm", "--force", container)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="arcwright/team-service:local-v1")
    args = parser.parse_args()
    suffix = uuid.uuid4().hex
    volume = f"t3-team-service-smoke-{suffix}"
    container = None
    image = json.loads(docker("image", "inspect", args.image))[0]
    assert int(image["Config"]["User"].split(":")[0]) > 0, "Image must run as non-root"

    with tempfile.TemporaryDirectory(prefix="t3-team-service-smoke-") as directory:
        secret = Path(directory) / "clerk_secret_key"
        secret.write_text(SYNTHETIC_SECRET)
        secret.chmod(0o600)
        docker("volume", "create", "--label", f"ai.arcwright.team-service.smoke={suffix}", volume)
        try:
            run_args = isolated_run_args(suffix, volume, secret)
            config_args = ["--env", f"T3_TEAM_CLERK_PUBLISHABLE_KEY={SYNTHETIC_PUBLISHABLE}",
                           "--env", "T3_TEAM_ORIGINS=http://localhost:3910", "--env", "T3_TEAM_CREATORS="]
            expect_config_failure(args.image, run_args)
            secret.write_text("")
            expect_config_failure(args.image, [*run_args, *config_args])
            secret.write_text(SYNTHETIC_SECRET)
            container = docker("run", "--detach", *run_args, *config_args, args.image)
            ready(container)
            probe = r"""
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
(async () => {
  assert.notEqual(process.getuid(), 0);
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  assert.match(status, /^CapEff:\s+0+$/m);
  assert.match(status, /^NoNewPrivs:\s+1$/m);
  assert.match(status, /^Seccomp:\s+2$/m);
  assert.throws(() => fs.writeFileSync('/home/node/readonly-probe', 'x'), { code: 'EROFS' });
  assert.equal(fs.existsSync('/var/run/docker.sock'), false);
  for (const file of ['LICENSE', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md']) assert.ok(fs.statSync('/opt/t3/' + file).size > 0);
  for (const file of ['secrets', 'settings.json', 'environment-id', 'anonymous-id', 'server-runtime.json', 'logs/provider', 'logs/terminals', 'attachments']) assert.equal(fs.existsSync('/data/userdata/' + file), false);
  assert.equal(fs.existsSync('/data/worktrees'), false);
  assert.equal(fs.existsSync('/run/secrets/team_ssh_key'), false);
  const config = await fetch('http://127.0.0.1:3910/api/team/config');
  assert.equal(config.status, 200);
  const enabled = await config.json();
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.agentExecution, "local");
  const root = await fetch("http://127.0.0.1:3910/", { redirect: "manual" });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/spaces");
  const spaces = await fetch('http://127.0.0.1:3910/spaces');
  assert.equal(spaces.status, 200);
  assert.match(await spaces.text(), /<html/);
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
    for (const route of ['/api/config', '/api/auth/pair', '/api/team/local-account', '/api/teams/account', '/api/teams/team-directory', '/api/teams/team-command', '/api/terminal', '/api/dashboard', '/api/assets', '/api/workspace', '/ws', '/ws/nested', '/oauth', '/oauth/token', '/.well-known/openid-configuration', '/mcp', '/mcp/nested']) {
      const response = await fetch('http://127.0.0.1:3910' + route, { method });
      assert.equal(response.status, 404, method + ' ' + route);
      assert.doesNotMatch(response.headers.get('content-type') || '', /text\/html/);
    }
  }
  const denied = await fetch('http://127.0.0.1:3910/api/team/spaces');
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, 'sign_in_required');
  const html = await (await fetch('http://127.0.0.1:3910/spaces')).text();
  const asset = html.match(/(?:src|href)="([^" ]+\.(?:js|css))"/);
  assert.ok(asset, 'Management HTML references a bundle');
  assert.equal((await fetch(new URL(asset[1], 'http://127.0.0.1:3910'))).status, 200);
  for (const pid of fs.readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
    let command;
    try { command = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').replaceAll('\0', ' '); }
    catch { continue; }
    if (Number(pid) === process.pid) continue;
    assert.doesNotMatch(command, /(?:^|[ /])(?:codex|claude|cursor|grok|hermes|opencode|ssh|bash|sh)(?: |$)/);
  }
  const db = new DatabaseSync('/data/userdata/state.sqlite', { readOnly: true });
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='team_spaces'").get());
  assert.equal(db.prepare('SELECT name FROM effect_sql_migrations WHERE migration_id=63').get().name, 'TeamRoster');
  for (const table of ['team_roster', 'team_roster_invites', 'team_project_creation_requests', 'local_team_file_creation_requests']) {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name=?").get(table));
  }
  db.close();
  fs.writeFileSync('/data/container-smoke', 'persists');
  console.log('Collaboration HTTP, assets, NOTICE, permissions, migration, and process separation probes passed.');
})().catch(error => { console.error('Runtime probe failed:', error.message); process.exitCode = 1; });
"""
            print(docker("exec", container, "node", "-e", probe))
            docker("stop", "--time", "45", container)
            docker("rm", container)
            container = None
            container = docker(
                "run", "--detach", "--network", "none", "--read-only",
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                "--cpus", "2", "--memory", "2g", "--memory-swap", "2g", "--pids-limit", "256",
                "--label", f"ai.arcwright.team-service.smoke={suffix}",
                "--mount", f"type=volume,src={volume},dst=/data,readonly",
                "--entrypoint", "node", args.image, "-e",
                "require('node:assert/strict').equal(require('node:fs').readFileSync('/data/container-smoke', 'utf8'), 'persists'); console.log('Private data volume persists across containers.');",
            )
            assert docker("wait", container) == "0", "Persistence probe must succeed"
            print(docker("logs", container))
            docker("rm", container)
            container = None
            print("Teams collaboration container smoke passed; no external network or ports used.")
        finally:
            if container:
                subprocess.run(["docker", "rm", "--force", container], capture_output=True, check=True)
            docker("volume", "rm", volume)


if __name__ == "__main__":
    main()
