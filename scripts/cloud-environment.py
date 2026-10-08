#!/usr/bin/env python3
"""Bootstrap fresh Linux VMs onto T3's existing launcher and maintenance updater."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile


CONFIG_FILE = "cloud-environment.json"
SERVICE_PROTOCOL = 3
VERSION = re.compile(r"\d+\.\d+\.\d+(?:-(?:nightly|preview)\.\d+\.\d+)?")
ACCOUNT_ID = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,63}")
# Initial choices match the fork's model defaults. These are fresh-home
# preferences, so runtime updates and later user choices never rewrite them.
INITIAL_CODEX_MODEL = "gpt-6-astra"
INITIAL_TEXT_MODEL = "gpt-6-luna"


class SetupError(Exception):
    pass


def checked_name(value):
    if not isinstance(value, str):
        raise SetupError("Choose a repository environment name.")
    name = value.strip()
    if not name or len(name) > 120 or any(ord(char) < 32 or ord(char) == 127 for char in name):
        raise SetupError("Environment name must be 1–120 characters without control characters.")
    return name


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError) as error:
        raise SetupError(f"Cannot read {path.name}; inspect the environment before continuing.") from error


def checked_accounts(value):
    if not isinstance(value, dict) or set(value) != {"format", "codexAccounts"} or type(value["format"]) is not int or value["format"] != 1:
        raise SetupError("Use an account list from export-accounts; it contains names and IDs only.")
    accounts = value["codexAccounts"]
    if not isinstance(accounts, list) or not 1 <= len(accounts) <= 32:
        raise SetupError("The account list must contain 1–32 Codex accounts.")
    ids = set()
    result = []
    for account in accounts:
        if not isinstance(account, dict) or set(account) != {"id", "name", "enabled"}:
            raise SetupError("Account entries must contain only id, name, and enabled; never credentials or host paths.")
        account_id = account["id"]
        if not isinstance(account_id, str) or not ACCOUNT_ID.fullmatch(account_id) or account_id in ids:
            raise SetupError("Each account needs a unique valid T3 provider ID.")
        if type(account["enabled"]) is not bool:
            raise SetupError("Each account needs an explicit enabled preference.")
        ids.add(account_id)
        result.append({"id": account_id, "name": checked_name(account["name"]), "enabled": account["enabled"]})
    return result


def export_accounts(settings_path, output):
    settings = read_json(settings_path)
    instances = settings.get("providerInstances") if isinstance(settings, dict) else None
    if not isinstance(instances, dict):
        raise SetupError("Choose T3's settings.json containing your configured provider accounts.")
    accounts = []
    for instance_id, instance in instances.items():
        if not isinstance(instance, dict) or instance.get("driver") != "codex":
            continue
        config = instance.get("config", {})
        if not isinstance(config, dict):
            raise SetupError("A Codex account has invalid configuration; review Providers settings.")
        accounts.append({
            "id": instance_id,
            "name": instance.get("displayName") or instance_id,
            "enabled": instance.get("enabled") is not False and config.get("enabled") is not False,
        })
    manifest = {"format": 1, "codexAccounts": accounts}
    checked_accounts(manifest)
    write_json(output, manifest)
    print(f"Exported {len(accounts)} account entries to {output}; no credentials or host configuration included.", flush=True)


def selected_accounts(manifest, owner_account, include_accounts=None):
    if manifest is None:
        if owner_account is not None or include_accounts:
            raise SetupError("Choose --accounts before selecting its owner or additional accounts.")
        return None
    accounts = checked_accounts(manifest)
    by_id = {account["id"]: account for account in accounts}
    if not isinstance(owner_account, str) or owner_account not in by_id:
        raise SetupError("Choose --owner-account with the owning Codex provider ID from the account list.")
    selected = [by_id[owner_account]]
    seen = {owner_account}
    for account_id in include_accounts or ():
        if not isinstance(account_id, str) or account_id not in by_id:
            raise SetupError("Each --include-account must be a Codex provider ID from the account list.")
        if account_id in seen:
            raise SetupError("Select the owner and each additional account only once.")
        seen.add(account_id)
        selected.append(by_id[account_id])
    return selected


def repository_environment_name(repository, accounts):
    if not isinstance(repository, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)?", repository.strip()):
        raise SetupError("Use --repository with a repository name or owner/repository, not a path or URL.")
    parts = repository.strip().split("/")
    if any(part in (".", "..") for part in parts):
        raise SetupError("Use the repository's actual name.")
    if not accounts:
        raise SetupError("Repository naming needs --accounts and a confirmed --owner-account.")
    return checked_name(f"{parts[-1]} ({accounts[0]['name']}) — Codex Cloud")


def write_json(path, value):
    # Only fresh bootstrap state is written here. Updates belong to the native controller.
    with path.open("x") as stream:
        os.chmod(path, 0o600)
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def checked_runtime(home, version):
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise SetupError("The environment has an unsupported runtime version.")
    runtime = home / "runtime" / "versions" / version
    executable = runtime / "t3"
    sentinel = runtime / ".install-complete"
    if not executable.is_file() or executable.is_symlink() or not os.access(executable, os.X_OK):
        raise SetupError("The selected runtime is missing; use T3 recovery rather than reinstalling over its data.")
    if not sentinel.is_file() or sentinel.read_text().strip() != version:
        raise SetupError("The selected runtime is incomplete; inspect or recover it before starting.")
    return executable


def initialize(home, installer, version, port, auto=True, name=None, accounts=None, owner_account=None, include_accounts=None):
    if home.exists() or home.is_symlink():
        raise SetupError("Home already exists. Use start/status/update for a configured home; initialization never replaces one.")
    if not installer.is_file():
        raise SetupError("Keep cloud-environment.py beside the fork's install.sh, or supply --installer.")
    if version is not None and not VERSION.fullmatch(version):
        raise SetupError("Choose an exact fork version, not a tag, range, or filesystem path.")
    if not 1 <= port <= 65535:
        raise SetupError("Port must be between 1 and 65535.")
    name = checked_name(name) if name is not None else None
    accounts = selected_accounts(accounts, owner_account, include_accounts)
    home.parent.mkdir(parents=True, exist_ok=True)
    # Reserve the fresh destination exclusively. Failure leaves an unconfigured directory
    # for inspection; we never delete a destination that another process could have opened.
    home.mkdir(mode=0o700)
    with tempfile.TemporaryDirectory(prefix=".bootstrap-", dir=home) as staging:
        stage = Path(staging)
        install_home = stage / "home"
        env = dict(os.environ)
        env.update(T3CODE_HOME=str(install_home), T3CODE_INSTALL_BIN_DIR=str(stage / "bin"), T3CODE_CHANNEL="nightly")
        env.pop("T3CODE_VERSION", None)
        if version is not None:
            env["T3CODE_VERSION"] = version
        # Reuse the fork installer: fresh GitHub eligibility, manifest safety gates,
        # SHA256SUMS agreement, and archive digest verification. Never install globally.
        result = subprocess.run(["sh", str(installer)], env=env, check=False)
        if result.returncode:
            raise SetupError("The verified fork installer failed. No server or update was started.")
        versions = list((install_home / "runtime" / "versions").iterdir())
        if len(versions) != 1:
            raise SetupError("Expected one verified runtime in the fresh installation.")
        selected = versions[0].name
        checked_runtime(install_home, selected)
        if (home / "userdata").exists() or (home / "runtime").exists():
            raise SetupError("The fresh destination changed during setup; no launcher state was written.")
        shutil.move(str(install_home / "runtime"), str(home / "runtime"))
        if accounts is not None:
            # Fresh, unpublished home only. Authentication happens through the
            # running provider service; a reusable image never contains logins.
            userdata = home / "userdata"
            userdata.mkdir(mode=0o700)
            shared_codex_home = home / "providers" / "codex" / "shared"
            shared_codex_home.mkdir(mode=0o700, parents=True)
            write_json(userdata / "settings.json", {
                # A missing explicit `codex` slot is synthesized from legacy
                # defaults by T3. Disable that slot unless explicitly selected,
                # so a Work/Unnamed owner cannot pick up an ambient CLI login.
                "providers": {"codex": {
                    "enabled": any(account["id"] == "codex" and account["enabled"] for account in accounts),
                    "setupMode": "managed", "homePath": str(shared_codex_home),
                }},
                "providerInstances": {
                    account["id"]: {
                        "driver": "codex", "displayName": account["name"], "enabled": account["enabled"],
                        "config": {"setupMode": "managed", "homePath": str(shared_codex_home)},
                    } for account in accounts
                },
                "defaultModelSelection": {"instanceId": owner_account, "model": INITIAL_CODEX_MODEL},
                "textGenerationModelSelection": {"instanceId": owner_account, "model": INITIAL_TEXT_MODEL},
                **{policy: {"enabled": False} for policy in (
                    "repositoryReview", "continuousImprovement", "productOpportunityDiscovery",
                    "decisionFollowUp", "pullRequestRollup", "inactiveWorktreeCleanup",
                )},
            })
        write_json(home / "runtime" / "service-state.json", {"protocol": SERVICE_PROTOCOL, "activeVersion": selected})
        # Seed native PolicyState only in this exclusively reserved, unpublished
        # home. Bootstrap review and all admission gates still apply. Subsequent
        # changes belong to the running controller; start never rewrites policy.
        maintenance = home / "maintenance"
        maintenance.mkdir(mode=0o700)
        write_json(maintenance / "policy.json", {
            "channel": "nightly" if "-nightly." in selected else "stable",
            "automaticInstallation": auto,
            "pinnedBuild": None,
            "failedArtifactSha256": [],
            "automationReviewRequired": False,
            "cancelledTargetSha256": None,
        })
        config = {"format": 1, "port": port}
        if name is not None:
            config["name"] = name
        if accounts is not None:
            config["codexAccounts"] = accounts
            config["codexOwnerAccountId"] = owner_account
        write_json(home / CONFIG_FILE, config)
    print(f"Initialized {selected} in {home}; automatic updates {'on' if auto else 'off'}. After launch, pair the environment and review installations in Settings > Connections.", flush=True)
    if accounts is not None:
        print(f"Prepared {len(accounts)} Codex account entries. Connect each account in this environment's Providers settings; authentication has not been copied.", flush=True)


def configured_environment(home):
    if home.is_symlink() or not home.is_dir():
        raise SetupError("Choose the real directory of an initialized cloud environment.")
    config = read_json(home / CONFIG_FILE)
    if not isinstance(config, dict) or config.get("format") != 1:
        raise SetupError("Unsupported cloud environment configuration.")
    port = config.get("port")
    if type(port) is not int or not 1 <= port <= 65535:
        raise SetupError("Invalid saved environment port.")
    state = read_json(home / "runtime" / "service-state.json")
    if not isinstance(state, dict) or state.get("protocol") != SERVICE_PROTOCOL:
        raise SetupError("Unsupported launcher state; use the stopped-work bootstrap or recovery procedure.")
    executable = checked_runtime(home, state.get("activeVersion"))
    env = dict(os.environ)
    env.update(T3CODE_HOME=str(home), T3CODE_PORT=str(port), T3CODE_HOST="127.0.0.1", T3CODE_NO_BROWSER="true")
    if "name" in config:
        env["T3CODE_ENVIRONMENT_LABEL"] = checked_name(config["name"])
    # Honor the managed VM proxy rather than attempting direct outbound requests.
    if any(env.get(name) for name in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy")):
        env.setdefault("NODE_USE_ENV_PROXY", "1")
        # The native operator endpoint is inside this VM. Keep its loopback
        # requests local while retaining every existing external proxy exclusion.
        exclusions = env.get("no_proxy", env.get("NO_PROXY", ""))
        exclusions = ",".join(filter(None, (exclusions, "localhost,127.0.0.1,::1,[::1]")))
        env["NO_PROXY"] = exclusions
        env["no_proxy"] = exclusions
    # A task's one-use trial admission must only come from the real service launcher.
    env.pop("T3CODE_MAINTENANCE_TRIAL", None)
    env.pop("T3_SERVICE_LAUNCHER_CONTEXT", None)
    return executable, env


def start(home):
    executable, env = configured_environment(home)
    lock_path = home / "runtime" / ".cloud-launcher.lock"
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise SetupError("This cloud environment already has a launcher running.") from error
        # The wrapper only owns this child and its lock. The native launcher owns
        # version swaps, IPC, trial admission, snapshots, health receipts and recovery.
        child = subprocess.Popen([str(executable), "__service-launcher"], env=env, start_new_session=True)
        def forward(signum, _frame):
            if child.poll() is None:
                child.send_signal(signum)
        previous = {sig: signal.signal(sig, forward) for sig in (signal.SIGINT, signal.SIGTERM)}
        try:
            return child.wait()
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)


def operator(home, action, auto=None):
    executable, env = configured_environment(home)
    if action == "status":
        arguments = ["maintenance", "status"]
    elif action == "update":
        arguments = ["update"]
    elif action == "auto-update" and auto in ("on", "off"):
        arguments = ["maintenance", "policy", "--auto", auto]
    else:
        raise SetupError("Choose status, update, or auto-update with --auto on/off.")
    command = [str(executable), *arguments, "--base-dir", str(home)]
    # This is the existing authenticated operator endpoint, not another installer.
    # Policy changes persist there; start never overwrites a saved opt-out or pin.
    return subprocess.call(command, env=env)


def setup(home, installer, version, port, auto=True, name=None, accounts=None, owner_account=None, include_accounts=None):
    # A single fresh-VM entry point. Resume with start so a partial setup or
    # existing live home can never be silently reinstalled or reconfigured.
    initialize(home, installer, version, port, auto, name, accounts, owner_account, include_accounts)
    return start(home)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("setup", "init", "start", "status", "update", "auto-update", "export-accounts"))
    parser.add_argument("--home", type=Path, help="Explicit, private T3 data home")
    parser.add_argument("--accounts", type=Path, help="Non-secret account list for fresh setup/init")
    parser.add_argument("--owner-account", help="Owning Codex provider ID; required with --accounts")
    parser.add_argument("--include-account", action="append", default=[], help="Explicit additional Codex provider ID (repeatable; setup/init only)")
    parser.add_argument("--settings", type=Path, help="Read-only source settings for export-accounts")
    parser.add_argument("--output", type=Path, help="New account list file for export-accounts")
    parser.add_argument("--version", help="Exact initial fork release; default: eligible Nightly")
    parser.add_argument("--port", type=int, default=13882, help="Initial loopback port")
    parser.add_argument("--repository", help="Repository name or owner/repository; derives 'repository (Owner) — Codex Cloud' on setup/init")
    parser.add_argument("--name", help="Explicit initial name; standard: 'Squidhub (Personal) — Codex Cloud'")
    parser.add_argument("--installer", type=Path, default=Path(__file__).with_name("install.sh"))
    parser.add_argument("--auto", choices=("on", "off"), help="Initial preference (setup/init default to on), or saved preference (auto-update)")
    args = parser.parse_args(argv)
    if args.action == "export-accounts":
        if args.settings is None or args.output is None:
            parser.error("export-accounts needs --settings and --output.")
        if args.home is not None or args.accounts is not None or args.owner_account is not None or args.include_account or args.auto is not None or args.name is not None or args.repository is not None or args.version is not None or args.port != 13882:
            parser.error("export-accounts only uses --settings and --output.")
        try:
            export_accounts(args.settings.expanduser(), args.output.expanduser())
            return 0
        except (SetupError, OSError) as error:
            print(f"Cloud environment: {error}", file=sys.stderr)
            return 1
    if args.home is None:
        parser.error("Choose an explicit --home for this cloud environment.")
    if args.settings is not None or args.output is not None:
        parser.error("--settings and --output are only for export-accounts.")
    if (args.accounts is not None or args.owner_account is not None or args.include_account) and args.action not in ("setup", "init"):
        parser.error("Account selection is a setup/init option; configured homes keep their saved providers.")
    if args.accounts is not None and args.owner_account is None:
        parser.error("--accounts needs --owner-account with the owning Codex provider ID.")
    if args.accounts is None and (args.owner_account is not None or args.include_account):
        parser.error("--owner-account and --include-account need --accounts.")
    if args.action == "auto-update" and args.auto is None:
        parser.error("Use auto-update with --auto on/off.")
    if args.auto is not None and args.action not in ("setup", "init", "auto-update"):
        parser.error("--auto is only for setup, init, or auto-update; other actions preserve the saved preference.")
    if args.name is not None and args.action not in ("setup", "init"):
        parser.error("--name is a setup/init option; other actions use the saved name.")
    if args.repository is not None:
        if args.action not in ("setup", "init"):
            parser.error("--repository is a setup/init option; configured homes keep their saved name.")
        if args.name is not None:
            parser.error("Choose --repository for the standard name or --name for an explicit name.")
        if args.accounts is None:
            parser.error("--repository needs --accounts and --owner-account to name the confirmed owner.")
    if sys.platform != "linux":
        parser.error("This cloud launcher helper currently supports Linux only.")
    # Preserve the literal final component so symlink homes are refused, not resolved away.
    home = Path(os.path.abspath(args.home.expanduser()))
    try:
        accounts = read_json(args.accounts.expanduser()) if args.accounts else None
        name = args.name
        if args.repository is not None:
            name = repository_environment_name(args.repository, selected_accounts(accounts, args.owner_account, args.include_account))
        if args.action == "setup":
            return setup(home, args.installer.absolute(), args.version, args.port, args.auto != "off", name,
                         accounts, args.owner_account, args.include_account)
        if args.action == "init":
            initialize(home, args.installer.absolute(), args.version, args.port, args.auto != "off", name,
                       accounts, args.owner_account, args.include_account)
            return 0
        if args.version is not None or args.port != 13882:
            raise SetupError("Version and port are initial setup options. Existing updates use the saved T3 maintenance policy.")
        return start(home) if args.action == "start" else operator(home, args.action, args.auto)
    except (SetupError, OSError) as error:
        print(f"Cloud environment: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
