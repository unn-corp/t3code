import importlib.util
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("cloud-environment.py")
spec = importlib.util.spec_from_file_location("cloud_environment", SCRIPT)
cloud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cloud)


class CloudEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="t3-cloud-launcher-test-")
        self.root = Path(self.temp.name)
        self.home = self.root / "home"
        self.installer = self.root / "install.sh"
        # This is the network/installer boundary. The fork installer retains its
        # own release verification; exercise real filesystem and child processes here.
        self.installer.write_text("""#!/bin/sh
set -eu
version=${T3CODE_VERSION:-1.2.3}
runtime="$T3CODE_HOME/runtime/versions/$version"
mkdir -p "$runtime" "$T3CODE_INSTALL_BIN_DIR"
printf '#!/bin/sh\\necho "t3 v%s"\\n' "$version" > "$runtime/t3"
chmod 755 "$runtime/t3"
printf '%s\\n' "$version" > "$runtime/.install-complete"
ln -s "$runtime/t3" "$T3CODE_INSTALL_BIN_DIR/t3"
""")

    def tearDown(self):
        self.temp.cleanup()

    def initialize(self):
        cloud.initialize(self.home, self.installer, "1.2.3", 14567)

    def runtime_script(self, version, content):
        runtime = self.home / "runtime" / "versions" / version
        runtime.mkdir(parents=True, exist_ok=True)
        entry = runtime / "t3"
        entry.write_text("#!" + sys.executable + "\n" + content)
        entry.chmod(0o755)
        (runtime / ".install-complete").write_text(version + "\n")

    def account_manifest(self):
        return {"format": 1, "codexAccounts": [
            {"id": "codex", "name": "Personal", "enabled": True},
            {"id": "codex_meckle", "name": "Unnamed", "enabled": True},
            {"id": "codex_work", "name": "Work", "enabled": False},
        ]}

    def test_account_export_strips_credentials_and_machine_configuration_without_mutating_source(self):
        source = self.root / "settings.json"
        source.write_text(json.dumps({"providerInstances": {
            "codex": {"driver": "codex", "displayName": "Personal", "environment": {"ACCESS_TOKEN": "secret"},
                      "config": {"homePath": "/personal/host", "launchArgs": "--secret", "accessToken": "secret"}},
            "codex_meckle": {"driver": "codex", "displayName": "Unnamed"},
            "codex_work": {"driver": "codex", "displayName": "Work", "config": {"enabled": False}},
            "claudeAgent": {"driver": "claudeAgent", "environment": {"TOKEN": "secret"}},
        }, "githubAccounts": {"other": "secret"}}))
        before = source.read_bytes()
        output = self.root / "accounts.json"
        result = subprocess.run([sys.executable, str(SCRIPT), "export-accounts", "--settings", str(source), "--output", str(output)], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(cloud.read_json(output), self.account_manifest())
        self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        self.assertEqual(source.read_bytes(), before)
        self.assertNotIn("secret", output.read_text() + result.stdout + result.stderr)
        with self.assertRaises(FileExistsError):
            cloud.export_accounts(source, output)
        self.assertEqual(cloud.read_json(output), self.account_manifest())

    def test_account_export_preserves_disabled_envelopes_and_uses_id_for_unnamed_accounts(self):
        source = self.root / "settings.json"
        source.write_text(json.dumps({"providerInstances": {
            "codex": {"driver": "codex", "enabled": False, "config": {"enabled": True}},
        }}))
        output = self.root / "accounts.json"
        cloud.export_accounts(source, output)
        self.assertEqual(cloud.read_json(output)["codexAccounts"], [{"id": "codex", "name": "codex", "enabled": False}])

    def test_fresh_accounts_have_independent_managed_login_entries_and_vm_local_shared_workspace(self):
        accounts_path = self.root / "accounts.json"
        accounts_path.write_text(json.dumps(self.account_manifest()))
        command = [sys.executable, str(SCRIPT), "setup", "--home", str(self.home), "--installer", str(self.installer), "--version", "1.2.3", "--accounts", str(accounts_path), "--owner-account", "codex", "--include-account", "codex_meckle", "--include-account", "codex_work"]
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("authentication has not been copied", result.stdout)
        settings_path = self.home / "userdata" / "settings.json"
        settings = cloud.read_json(settings_path)
        self.assertEqual(settings_path.stat().st_mode & 0o777, 0o600)
        for account in self.account_manifest()["codexAccounts"]:
            instance = settings["providerInstances"][account["id"]]
            self.assertEqual(instance["displayName"], account["name"])
            self.assertEqual(instance["enabled"], account["enabled"])
            self.assertEqual(instance["config"], {"setupMode": "managed", "homePath": str(self.home / "providers" / "codex" / "shared")})
        for policy in ("repositoryReview", "continuousImprovement", "productOpportunityDiscovery", "decisionFollowUp", "pullRequestRollup", "inactiveWorktreeCleanup"):
            self.assertFalse(settings[policy]["enabled"])
        self.assertFalse(list(self.home.rglob("auth.json")))
        self.assertFalse((self.home / "userdata" / "secrets").exists())
        # A normal restart must retain subsequent provider edits and login state.
        settings["providerInstances"]["codex"]["displayName"] = "Renamed in VM"
        settings_path.write_text(json.dumps(settings))
        before = settings_path.read_bytes()
        restarted = subprocess.run([sys.executable, str(SCRIPT), "start", "--home", str(self.home)], capture_output=True, text=True, timeout=10)
        self.assertEqual(restarted.returncode, 0, restarted.stderr)
        self.assertEqual(settings_path.read_bytes(), before)
        duplicate = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertEqual(settings_path.read_bytes(), before)

    def test_owner_only_setup_selects_each_owner_without_preparing_other_accounts(self):
        for owner in self.account_manifest()["codexAccounts"]:
            with self.subTest(owner=owner["id"]):
                home = self.root / owner["id"]
                cloud.initialize(home, self.installer, "1.2.3", 14567, accounts=self.account_manifest(), owner_account=owner["id"])
                settings = cloud.read_json(home / "userdata" / "settings.json")
                self.assertEqual(list(settings["providerInstances"]), [owner["id"]])
                self.assertEqual(settings["providerInstances"][owner["id"]]["enabled"], owner["enabled"])
                self.assertEqual(settings["defaultModelSelection"]["instanceId"], owner["id"])
                self.assertEqual(settings["textGenerationModelSelection"]["instanceId"], owner["id"])
                self.assertEqual(settings["providers"]["codex"]["enabled"], owner["id"] == "codex" and owner["enabled"])
                config = cloud.read_json(home / cloud.CONFIG_FILE)
                self.assertEqual(config["codexOwnerAccountId"], owner["id"])
                self.assertEqual(config["codexAccounts"], [owner])

    def test_extra_personal_account_never_changes_a_work_owners_defaults(self):
        manifest = self.account_manifest()
        manifest["codexAccounts"][2]["enabled"] = True
        cloud.initialize(self.home, self.installer, "1.2.3", 14567, accounts=manifest, owner_account="codex_work", include_accounts=["codex"])
        settings = cloud.read_json(self.home / "userdata" / "settings.json")
        self.assertEqual(list(settings["providerInstances"]), ["codex_work", "codex"])
        self.assertNotIn("codex_meckle", settings["providerInstances"])
        self.assertEqual(settings["defaultModelSelection"]["instanceId"], "codex_work")
        self.assertEqual(settings["textGenerationModelSelection"]["instanceId"], "codex_work")
        self.assertTrue(settings["providers"]["codex"]["enabled"])

    def test_repository_setup_names_the_owner_and_keeps_additional_accounts_separate(self):
        manifest = self.root / "accounts.json"
        manifest.write_text(json.dumps(self.account_manifest()))
        for owner in self.account_manifest()["codexAccounts"]:
            with self.subTest(owner=owner["id"]):
                home = self.root / ("named-" + owner["id"])
                command = [sys.executable, str(SCRIPT), "setup", "--home", str(home),
                           "--installer", str(self.installer), "--version", "1.2.3",
                           "--repository", "unn-corp/clarity-relay", "--accounts", str(manifest),
                           "--owner-account", owner["id"]]
                if owner["id"] != "codex":
                    command += ["--include-account", "codex"]
                result = subprocess.run(command, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                name = f"clarity-relay ({owner['name']}) — Codex Cloud"
                self.assertEqual(cloud.read_json(home / cloud.CONFIG_FILE)["name"], name)
                _, env = cloud.configured_environment(home)
                self.assertEqual(env["T3CODE_ENVIRONMENT_LABEL"], name)
                settings = cloud.read_json(home / "userdata" / "settings.json")
                self.assertEqual(settings["defaultModelSelection"]["instanceId"], owner["id"])
                before = (home / cloud.CONFIG_FILE).read_bytes()
                restarted = subprocess.run([sys.executable, str(SCRIPT), "start", "--home", str(home)], capture_output=True, text=True, timeout=10)
                self.assertEqual(restarted.returncode, 0, restarted.stderr)
                self.assertEqual((home / cloud.CONFIG_FILE).read_bytes(), before)

    def test_repository_naming_rejects_ambiguous_or_invalid_setup_before_creating_a_home(self):
        manifest = self.root / "accounts.json"
        manifest.write_text(json.dumps(self.account_manifest()))
        base = [sys.executable, str(SCRIPT), "init", "--home", str(self.home),
                "--installer", str(self.installer), "--accounts", str(manifest), "--owner-account", "codex"]
        for repository in ("", "../repo", "owner/..", "/workspace/repo", "https://github.com/owner/repo", "repo\nother"):
            with self.subTest(repository=repository):
                result = subprocess.run([*base, "--repository", repository], capture_output=True, text=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(self.home.exists())
        for action, flags in (("init", ["--name", "Custom"]), ("start", []), ("export-accounts", [])):
            result = subprocess.run([sys.executable, str(SCRIPT), action, "--home", str(self.home), "--repository", "repo", *flags], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertFalse(self.home.exists())

    def test_missing_unknown_or_duplicate_account_selection_never_installs(self):
        for owner, extra in ((None, []), ("Personal", []), ("missing", []), ("codex", ["missing"]), ("codex", ["codex"]), ("codex", ["codex_work", "codex_work"])):
            with self.subTest(owner=owner, extra=extra), self.assertRaises(cloud.SetupError):
                cloud.initialize(self.home, self.installer, "1.2.3", 14567, accounts=self.account_manifest(), owner_account=owner, include_accounts=extra)
            self.assertFalse(self.home.exists())
        with self.assertRaisesRegex(cloud.SetupError, "Choose --accounts"):
            cloud.initialize(self.home, self.installer, "1.2.3", 14567, owner_account="codex")
        self.assertFalse(self.home.exists())

    def test_account_manifest_rejects_credentials_duplicates_and_invalid_values_before_install(self):
        invalid = [
            {"format": 1, "codexAccounts": []},
            {"format": True, "codexAccounts": self.account_manifest()["codexAccounts"]},
            {**self.account_manifest(), "refreshToken": "secret"},
            {"format": 1, "codexAccounts": [{"id": "codex", "name": "Personal", "enabled": True, "config": {}}]},
            {"format": 1, "codexAccounts": [self.account_manifest()["codexAccounts"][0]] * 2},
            {"format": 1, "codexAccounts": [{"id": "../escape", "name": "Personal", "enabled": True}]},
            {"format": 1, "codexAccounts": [{"id": "codex", "name": "Bad\nName", "enabled": True}]},
            {"format": 1, "codexAccounts": [{"id": "codex", "name": "Personal", "enabled": "true"}]},
        ]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(cloud.SetupError):
                cloud.initialize(self.home, self.installer, "1.2.3", 14567, accounts=value)
            self.assertFalse(self.home.exists())

    def test_accounts_flag_never_changes_an_existing_environment(self):
        self.initialize()
        manifest = self.root / "accounts.json"
        manifest.write_text(json.dumps(self.account_manifest()))
        for action in ("start", "status", "update", "auto-update"):
            args = [sys.executable, str(SCRIPT), action, "--home", str(self.home), "--accounts", str(manifest)]
            if action == "auto-update":
                args += ["--auto", "on"]
            result = subprocess.run(args, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertFalse((self.home / "userdata").exists())
        for flags in (("--owner-account", "codex"), ("--include-account", "codex_work")):
            result = subprocess.run([sys.executable, str(SCRIPT), "start", "--home", str(self.home), *flags], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertFalse((self.home / "userdata").exists())

    def test_cli_requires_owner_and_manifest_before_installing(self):
        manifest = self.root / "accounts.json"
        manifest.write_text(json.dumps(self.account_manifest()))
        for flags in (("--accounts", str(manifest)), ("--owner-account", "codex"), ("--include-account", "codex_work")):
            result = subprocess.run([sys.executable, str(SCRIPT), "setup", "--home", str(self.home), "--installer", str(self.installer), *flags], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertFalse(self.home.exists())

    def test_fresh_bootstrap_is_private_and_does_not_replace_global_install(self):
        global_bin = self.root / "global"
        global_bin.mkdir()
        existing = global_bin / "t3"
        existing.write_text("existing install")
        with patch.dict(os.environ, {"T3CODE_INSTALL_BIN_DIR": str(global_bin), "T3CODE_VERSION": "9.9.9"}):
            self.initialize()
        state = cloud.read_json(self.home / "runtime" / "service-state.json")
        self.assertEqual(state, {"protocol": 3, "activeVersion": "1.2.3"})
        self.assertEqual(existing.read_text(), "existing install")
        self.assertEqual(cloud.read_json(self.home / cloud.CONFIG_FILE)["port"], 14567)
        self.assertEqual(self.home.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.home / cloud.CONFIG_FILE).stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.home / "userdata").exists())
        self.assertFalse(list(self.home.glob(".bootstrap-*")))
        policy_path = self.home / "maintenance" / "policy.json"
        self.assertTrue(cloud.read_json(policy_path)["automaticInstallation"])
        self.assertEqual(cloud.read_json(policy_path)["channel"], "stable")
        self.assertEqual(policy_path.stat().st_mode & 0o777, 0o600)

    def test_initial_auto_update_choice_and_channel_are_saved_before_first_start(self):
        for auto in (None, "off"):
            home = self.root / (auto or "default")
            arguments = [sys.executable, str(SCRIPT), "init", "--home", str(home), "--installer", str(self.installer), "--version", "1.2.3-nightly.20261007.1"]
            if auto is not None:
                arguments += ["--auto", auto]
            result = subprocess.run(arguments, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            policy = cloud.read_json(home / "maintenance" / "policy.json")
            self.assertEqual(policy["automaticInstallation"], auto != "off")
            self.assertEqual(policy["channel"], "nightly")
            self.assertIsNone(policy["pinnedBuild"])
            self.assertFalse((home / "userdata").exists())

    def test_setup_installs_and_starts_once_then_refuses_to_replace_saved_state(self):
        command = [sys.executable, str(SCRIPT), "setup", "--home", str(self.home), "--installer", str(self.installer), "--version", "1.2.3", "--port", "14567", "--auto", "off", "--name", "  Squidhub (Personal)  "]
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("t3 v1.2.3", result.stdout)
        self.assertEqual(cloud.read_json(self.home / cloud.CONFIG_FILE)["port"], 14567)
        self.assertEqual(cloud.read_json(self.home / cloud.CONFIG_FILE)["name"], "Squidhub (Personal)")
        policy_path = self.home / "maintenance" / "policy.json"
        self.assertFalse(cloud.read_json(policy_path)["automaticInstallation"])
        before = policy_path.read_bytes()
        marker = self.home / "conversation"
        marker.write_text("preserved")
        duplicate = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("Home already exists", duplicate.stderr)
        self.assertNotIn("t3 v", duplicate.stdout)
        self.assertEqual(policy_path.read_bytes(), before)
        self.assertEqual(marker.read_text(), "preserved")

    def test_setup_failure_never_attempts_to_launch_an_unverified_runtime(self):
        self.installer.write_text("#!/bin/sh\nexit 7\n")
        result = subprocess.run([sys.executable, str(SCRIPT), "setup", "--home", str(self.home), "--installer", str(self.installer)], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertIn("installer failed", result.stderr)
        self.assertFalse((self.home / cloud.CONFIG_FILE).exists())
        self.assertFalse((self.home / "runtime" / ".cloud-launcher.lock").exists())

    def test_initialization_refuses_existing_data_and_symlink_homes(self):
        self.home.mkdir()
        marker = self.home / "conversation"
        marker.write_text("keep this")
        with self.assertRaisesRegex(cloud.SetupError, "Home already exists"):
            self.initialize()
        alias = self.root / "alias"
        alias.symlink_to(self.home, target_is_directory=True)
        with self.assertRaisesRegex(cloud.SetupError, "Home already exists"):
            cloud.initialize(alias, self.installer, "1.2.3", 14567)
        self.assertEqual(marker.read_text(), "keep this")

    def test_failed_installer_never_starts_or_publishes_an_environment(self):
        self.installer.write_text("#!/bin/sh\nexit 7\n")
        with self.assertRaisesRegex(cloud.SetupError, "installer failed"):
            self.initialize()
        self.assertFalse((self.home / cloud.CONFIG_FILE).exists())
        self.assertFalse((self.home / "runtime" / "service-state.json").exists())
        self.assertFalse((self.home / "maintenance" / "policy.json").exists())
        with self.assertRaisesRegex(cloud.SetupError, "Home already exists"):
            self.initialize()

    def test_status_and_update_follow_the_recorded_runtime_after_an_update(self):
        cloud.initialize(self.home, self.installer, "1.2.3", 14567, name="Squidhub (Personal)")
        output = self.root / "operator.json"
        self.runtime_script("1.2.4", """import json, os, sys
from pathlib import Path
Path(os.environ['OPERATOR_RESULT']).write_text(json.dumps({'args':sys.argv[1:], 'home':os.environ['T3CODE_HOME'], 'port':os.environ['T3CODE_PORT'], 'label':os.environ.get('T3CODE_ENVIRONMENT_LABEL'), 'proxy':os.environ.get('NODE_USE_ENV_PROXY'), 'no_proxy':os.environ.get('no_proxy'), 'trial':os.environ.get('T3CODE_MAINTENANCE_TRIAL'), 'context':os.environ.get('T3_SERVICE_LAUNCHER_CONTEXT')}))
""")
        (self.home / "runtime" / "service-state.json").write_text(json.dumps({"protocol": 3, "activeVersion": "1.2.4"}))
        with patch.dict(os.environ, {"OPERATOR_RESULT": str(output), "HTTPS_PROXY": "http://proxy.invalid:8080", "no_proxy": "private.test", "T3CODE_MAINTENANCE_TRIAL": "do-not-inherit", "T3_SERVICE_LAUNCHER_CONTEXT": "do-not-inherit", "T3CODE_ENVIRONMENT_LABEL": "Other repository"}):
            for action, auto, arguments in (
                ("status", None, ["maintenance", "status"]),
                ("update", None, ["update"]),
                ("auto-update", "on", ["maintenance", "policy", "--auto", "on"]),
                ("auto-update", "off", ["maintenance", "policy", "--auto", "off"]),
            ):
                self.assertEqual(cloud.operator(self.home, action, auto), 0)
                value = cloud.read_json(output)
                self.assertEqual(value["args"], arguments + ["--base-dir", str(self.home)])
                self.assertEqual(value["home"], str(self.home))
                self.assertEqual(value["port"], "14567")
                self.assertEqual(value["label"], "Squidhub (Personal)")
                self.assertEqual(value["proxy"], "1")
                self.assertEqual(value["no_proxy"], "private.test,localhost,127.0.0.1,::1,[::1]")
                self.assertIsNone(value["trial"])
                self.assertIsNone(value["context"])

    def test_invalid_names_are_refused_before_install_and_bad_saved_names_never_launch(self):
        for name in ("  ", "x" * 121, "Repo\nOther", "Repo\x00", 42):
            with self.assertRaisesRegex(cloud.SetupError, "name"):
                cloud.initialize(self.home, self.installer, "1.2.3", 14567, name=name)
            self.assertFalse(self.home.exists())
        self.initialize()
        config_path = self.home / cloud.CONFIG_FILE
        # Older homes without a name remain usable.
        with patch.dict(os.environ, {}, clear=True):
            self.assertNotIn("T3CODE_ENVIRONMENT_LABEL", cloud.configured_environment(self.home)[1])
        config = cloud.read_json(config_path)
        config["name"] = "bad\nname"
        config_path.write_text(json.dumps(config))
        with self.assertRaisesRegex(cloud.SetupError, "name"):
            cloud.configured_environment(self.home)

    def test_auto_update_refusal_is_reported_without_writing_policy_or_reinstalling(self):
        self.initialize()
        self.runtime_script("1.2.3", "import sys\nsys.exit(7)\n")
        policy_path = self.home / "maintenance" / "policy.json"
        before = policy_path.read_bytes()
        # Only the native running controller may save a policy. A stopped or
        # unsupported host must fail, never fall back to an offline file write.
        result = subprocess.run([sys.executable, str(SCRIPT), "auto-update", "--auto", "on", "--home", str(self.home)], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 7)
        self.assertEqual(policy_path.read_bytes(), before)
        with self.assertRaisesRegex(cloud.SetupError, "--auto on/off"):
            cloud.operator(self.home, "auto-update")
        for arguments in (("auto-update",), ("start", "--auto", "on"), ("status", "--auto", "off")):
            invalid = subprocess.run([sys.executable, str(SCRIPT), *arguments, "--home", str(self.home)], capture_output=True, text=True, timeout=10)
            self.assertEqual(invalid.returncode, 2)
        self.assertEqual(policy_path.read_bytes(), before)

    def test_invalid_or_incomplete_runtime_never_launches(self):
        self.initialize()
        state_path = self.home / "runtime" / "service-state.json"
        state_path.write_text(json.dumps({"protocol": 3, "activeVersion": "../../outside"}))
        with self.assertRaisesRegex(cloud.SetupError, "runtime version"):
            cloud.configured_environment(self.home)
        state_path.write_text(json.dumps({"protocol": 3, "activeVersion": "1.2.3"}))
        (self.home / "runtime" / "versions" / "1.2.3" / ".install-complete").unlink()
        with self.assertRaisesRegex(cloud.SetupError, "incomplete"):
            cloud.configured_environment(self.home)

    def test_duplicate_start_is_refused_and_termination_reaches_only_owned_launcher(self):
        cloud.initialize(self.home, self.installer, "1.2.3", 14567, name="Squidhub (Personal)")
        policy_path = self.home / "maintenance" / "policy.json"
        # Simulate a saved opt-out and recovery hold. Launch must retain them,
        # rather than reapplying the new-home default on every VM restart.
        policy = cloud.read_json(policy_path)
        policy.update(automaticInstallation=False, pinnedBuild="a" * 64, automationReviewRequired=True)
        policy_path.write_text(json.dumps(policy))
        before = policy_path.read_bytes()
        self.runtime_script("1.2.3", """import os, signal, sys, threading
assert sys.argv[1:] == ['__service-launcher']
assert os.environ['T3CODE_ENVIRONMENT_LABEL'] == 'Squidhub (Personal)'
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
print(os.getpid(), flush=True)
threading.Event().wait()
""")
        parent = subprocess.Popen([sys.executable, str(SCRIPT), "start", "--home", str(self.home)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        child_pid = None
        try:
            ready, _, _ = select.select([parent.stdout], [], [], 10)
            self.assertTrue(ready, "Launcher did not report ready")
            child_pid = int(parent.stdout.readline())
            duplicate = subprocess.run([sys.executable, str(SCRIPT), "start", "--home", str(self.home)], capture_output=True, text=True, timeout=10)
            self.assertNotEqual(duplicate.returncode, 0)
            self.assertIn("already has a launcher", duplicate.stderr)
            os.kill(child_pid, 0)
            parent.terminate()
            self.assertEqual(parent.wait(timeout=10), 0)
            self.assertEqual(policy_path.read_bytes(), before)
            with self.assertRaises(ProcessLookupError):
                os.kill(child_pid, 0)
        finally:
            if parent.poll() is None:
                parent.terminate()
                parent.wait(timeout=10)
            parent.stdout.close()
            parent.stderr.close()


if __name__ == "__main__":
    unittest.main()
