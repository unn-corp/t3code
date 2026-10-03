import subprocess
import unittest
from unittest.mock import patch

import smoke


class CollaborationSmokeTest(unittest.TestCase):
    def test_disposable_run_is_offline_restricted_and_has_no_published_ports(self):
        args = smoke.isolated_run_args("unique", "disposable-volume", "/private/synthetic-secret")
        self.assertEqual(args[args.index("--network") + 1], "none")
        self.assertIn("--read-only", args)
        self.assertEqual(args[args.index("--cap-drop") + 1], "ALL")
        self.assertIn("no-new-privileges:true", args)
        self.assertIn("256", args)
        self.assertIn("type=volume,src=disposable-volume,dst=/data", args)
        self.assertIn("type=bind,src=/private/synthetic-secret,dst=/run/secrets/clerk_secret_key,readonly", args)
        self.assertNotIn("--publish", args)
        self.assertNotIn("-p", args)
        self.assertFalse(any("docker.sock" in value or "host.docker.internal" in value for value in args))

    def test_personal_startup_logs_are_rejected_without_disclosing_content(self):
        smoke.validate_service_logs(b"Teams collaboration service is ready.")
        for marker in (b"T3 Code server is ready.", b"pairingUrl: private-value", b"provider login"):
            with self.assertRaisesRegex(RuntimeError, "logs withheld") as result:
                smoke.validate_service_logs(marker)
            self.assertNotIn("private-value", str(result.exception))

    def test_failure_probe_requires_safe_specific_failure_and_cleans_captured_container(self):
        def probe(code, output):
            with patch.object(smoke, "docker", side_effect=["captured-id", str(code), output, ""]) as run:
                try:
                    smoke.expect_config_failure("synthetic-image", ["--network", "none"])
                finally:
                    self.assertEqual(run.call_args.args, ("rm", "--force", "captured-id"))
        probe(1, "Teams collaboration service requires T3_TEAM_CLERK_SECRET_KEY")
        for code, output in [(0, "T3_TEAM_CLERK_SECRET_KEY"), (1, "unrelated failure"),
                             (1, "T3_TEAM_CLERK_SECRET_KEY " + smoke.SYNTHETIC_SECRET),
                             (1, "T3_TEAM_CLERK_SECRET_KEY Teams collaboration service is ready.")]:
            with self.assertRaises(AssertionError):
                probe(code, output)

    def test_failure_probe_timeout_still_removes_only_its_captured_container(self):
        with patch.object(smoke, "docker", side_effect=["captured-id", subprocess.TimeoutExpired("docker wait", 60), ""]) as run:
            with self.assertRaises(subprocess.TimeoutExpired):
                smoke.expect_config_failure("synthetic-image", ["--network", "none"])
            self.assertEqual(run.call_args.args, ("rm", "--force", "captured-id"))


if __name__ == "__main__":
    unittest.main()
