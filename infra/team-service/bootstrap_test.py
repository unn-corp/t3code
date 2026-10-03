import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

import bootstrap


class ServiceBootstrapTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.directory = self.root / "service"

    def test_provision_is_idempotent_and_creates_only_private_service_files(self):
        bootstrap.provision(self.directory)
        env = (self.directory / ".env").read_bytes()
        bootstrap.provision(self.directory)
        self.assertEqual((self.directory / ".env").read_bytes(), env)
        self.assertEqual((self.directory / "secrets/clerk_secret_key").read_bytes(), b"")
        self.assertEqual(sorted(p.name for p in (self.directory / "secrets").iterdir()),
                         [".bootstrap.lock", "clerk_secret_key"])
        self.assertIn(b"T3_TEAM_OAUTH_CLIENT_ID=\n", env)
        for path in self.directory.rglob("*"):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700 if path.is_dir() else 0o600)

    def test_configured_values_secret_and_obsolete_files_are_preserved(self):
        bootstrap.provision(self.directory)
        secret = self.directory / "secrets/clerk_secret_key"
        secret.write_text("synthetic-existing-secret")
        obsolete = self.directory / "secrets/team_ssh_key"
        obsolete.write_text("synthetic-obsolete-key")
        obsolete.chmod(0o600)
        env = self.directory / ".env"
        configured = "T3_TEAM_UID=1007\nT3_TEAM_GID=1007\nT3_TEAM_ORIGINS=https://team.example.com\nT3_TEAM_CREATORS=\nT3_TEAM_OAUTH_ISSUER=https://issuer.example.com\nT3_TEAM_OAUTH_CLIENT_ID=configured-client\nT3_TEAM_SECRETS_DIR=/private/retained\n"
        env.write_text(configured)
        bootstrap.provision(self.directory)
        first = env.read_bytes()
        bootstrap.provision(self.directory)
        self.assertEqual(env.read_bytes(), first)
        self.assertTrue(first.startswith(configured.encode()))
        self.assertEqual(secret.read_text(), "synthetic-existing-secret")
        self.assertEqual(obsolete.read_text(), "synthetic-obsolete-key")

    def test_symlink_and_unsafe_secret_are_rejected_without_mutation(self):
        bootstrap.provision(self.directory)
        secret = self.directory / "secrets/clerk_secret_key"
        secret.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, "Unsafe file permissions"):
            bootstrap.provision(self.directory)
        secret.chmod(0o600)
        target = self.root / "target"
        target.write_text("preserve")
        secret.unlink()
        secret.symlink_to(target)
        with self.assertRaises(RuntimeError):
            bootstrap.provision(self.directory)
        self.assertEqual(target.read_text(), "preserve")

    def test_directory_symlink_unsafe_modes_and_foreign_ownership_are_rejected(self):
        target = self.root / "target"
        target.mkdir(mode=0o700)
        self.directory.symlink_to(target, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "symlinks"):
            bootstrap.provision(self.directory)
        self.directory.unlink()
        self.directory.mkdir(mode=0o755)
        with self.assertRaisesRegex(RuntimeError, "Unsafe directory"):
            bootstrap.provision(self.directory)
        self.directory.chmod(0o700)
        with patch.object(bootstrap.os, "getuid", return_value=os.getuid() + 1):
            with self.assertRaisesRegex(RuntimeError, "not owned"):
                bootstrap.provision(self.directory)

    def test_zero_runtime_identity_and_root_provisioning_are_rejected(self):
        bootstrap.provision(self.directory)
        env = self.directory / ".env"
        env.write_text("T3_TEAM_UID=0\n")
        before = env.read_bytes()
        with self.assertRaisesRegex(RuntimeError, "nonzero"):
            bootstrap.provision(self.directory)
        self.assertEqual(env.read_bytes(), before)
        with patch.object(bootstrap.os, "getuid", return_value=0):
            with self.assertRaisesRegex(RuntimeError, "non-root"):
                bootstrap.provision(self.directory)


if __name__ == "__main__":
    unittest.main()
