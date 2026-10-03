#!/usr/bin/env python3
"""Provision private deployment files for the Teams collaboration service."""

import argparse
import contextlib
import fcntl
import os
from pathlib import Path
import re
import stat
import tempfile


def check_file(path, *, private=False):
    value = path.lstat()
    if not stat.S_ISREG(value.st_mode) or value.st_uid != os.getuid():
        raise RuntimeError(f"Refusing a file not owned by this account: {path}")
    if value.st_mode & (0o077 if private else 0o022):
        raise RuntimeError(f"Unsafe file permissions: {path}")


def check_directory(path, *, private=False):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    value = path.lstat()
    if not stat.S_ISDIR(value.st_mode) or value.st_uid != os.getuid():
        raise RuntimeError(f"Refusing a directory not owned by this account: {path}")
    if value.st_mode & (0o077 if private else 0o022):
        raise RuntimeError(f"Unsafe directory permissions: {path}")


@contextlib.contextmanager
def locked_file(path):
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "r+", encoding="utf-8") as handle:
        value = os.fstat(handle.fileno())
        if not stat.S_ISREG(value.st_mode) or value.st_uid != os.getuid() or value.st_mode & 0o077:
            raise RuntimeError(f"Unsafe control file: {path}")
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield handle


def write_private(path, content):
    if path.exists() or path.is_symlink():
        check_file(path, private=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".team-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def configure_environment(path, secrets):
    lines = []
    if path.exists() or path.is_symlink():
        check_file(path, private=True)
        lines = path.read_text().splitlines()
    defaults = {
        "T3_TEAM_UID": str(os.getuid()),
        "T3_TEAM_GID": str(os.getgid()),
        "T3_TEAM_SECRETS_DIR": str(secrets),
        "T3_TEAM_CLERK_PUBLISHABLE_KEY": "",
        "T3_TEAM_ORIGINS": "http://localhost:3910",
        "T3_TEAM_CREATORS": "",
        "T3_TEAM_OAUTH_ISSUER": "",
        "T3_TEAM_OAUTH_CLIENT_ID": "",
    }
    for name, value in defaults.items():
        configured = [line.split("=", 1)[1] for line in lines if line.startswith(name + "=")]
        if name in ("T3_TEAM_UID", "T3_TEAM_GID") and configured:
            if len(configured) != 1 or not configured[0].isdigit() or int(configured[0]) == 0:
                raise RuntimeError(f"{name} must be a single nonzero numeric identity")
        if not configured:
            lines.append(name + "=" + value)
    write_private(path, "\n".join(lines) + "\n")


def provision(directory):
    if os.getuid() == 0 or os.getgid() == 0:
        raise RuntimeError("Run as the dedicated non-root deployment account")
    if not directory.is_absolute() or not re.fullmatch(r"/[A-Za-z0-9_./-]+", str(directory)):
        raise RuntimeError("Use an absolute deployment path without shell or Compose metacharacters")
    if ".." in directory.parts or any(parent.is_symlink() for parent in (directory, *directory.parents)):
        raise RuntimeError("Deployment paths must not contain symlinks or parent traversal")
    check_directory(directory, private=True)
    secrets = directory / "secrets"
    check_directory(secrets, private=True)
    with locked_file(secrets / ".bootstrap.lock"):
        clerk = secrets / "clerk_secret_key"
        if clerk.exists() or clerk.is_symlink():
            check_file(clerk, private=True)
        else:
            write_private(clerk, "")
        configure_environment(directory / ".env", secrets)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, help="Private service deployment directory")
    arguments = parser.parse_args()
    try:
        provision(arguments.directory)
    except RuntimeError as error:
        parser.exit(1, f"Service provisioning failed: {error}\n")
    except OSError as error:
        parser.exit(1, f"Service provisioning failed ({type(error).__name__}); check paths and ownership.\n")
    print("Private deployment configuration and Clerk secret placeholder provisioned; no secret values printed.")
