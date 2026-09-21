#!/usr/bin/env python3
"""Provide a forge credential to Git without putting it in a URL or log."""

import os
from pathlib import Path
import stat
import sys

provider = os.environ.get("GIT_CREDENTIAL_PROVIDER")
files = {
    "github": Path("/run/secrets/github.token"),
    "gitlab": Path("/run/secrets/gitlab.token"),
}
usernames = {"github": "x-access-token", "gitlab": "git"}

if provider not in files:
    raise SystemExit(1)

prompt = " ".join(sys.argv[1:]).lower()
if "username" in prompt:
    print(usernames[provider])
    raise SystemExit(0)
if "password" not in prompt:
    raise SystemExit(1)

try:
    fd = os.open(files[provider], os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise SystemExit(1)
        token = handle.read(4097).strip()
except OSError:
    raise SystemExit(1)

if not 16 <= len(token) <= 4096 or b"\n" in token or b"\r" in token:
    raise SystemExit(1)
sys.stdout.buffer.write(token + b"\n")
