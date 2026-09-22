"""Minimal ``.env`` loader.

The repo keeps a gitignored ``.env`` at its root. Loading it here means the CLI
works from a plain shell without a wrapper, and without adding a dependency.

Rules, deliberately strict and boring:

* an existing process environment variable always wins — the file never
  overwrites what the operator exported;
* values are never logged or printed;
* a malformed line is reported by line number, not silently dropped.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from .errors import ConfigError

log = logging.getLogger(__name__)

ENV_FILENAME = ".env"

# `~/.harness/machine.env`: what this machine is — vault root, realms, name.
# Read after the repo `.env`, so it fills gaps and never overrides a secret
# the repo file or the shell already set. `HARNESS_MACHINE_ENV` relocates it.
MACHINE_ENV_VAR = "HARNESS_MACHINE_ENV"
MACHINE_ENV_SEGMENTS = (".harness", "machine.env")


def machine_env_file() -> Path:
    override = os.environ.get(MACHINE_ENV_VAR, "").strip()
    return Path(override) if override else Path.home().joinpath(*MACHINE_ENV_SEGMENTS)


def find_env_file(start: Path | None = None) -> Path | None:
    """Walk up from ``start`` looking for a ``.env``. Returns None if absent."""
    current = (start or Path(__file__).resolve().parent).resolve()
    for candidate in (current, *current.parents):
        env_path = candidate / ENV_FILENAME
        if env_path.is_file():
            return env_path
    return None


def parse_env_file(text: str, origin: str = "<env>") -> dict[str, str]:
    """Parse ``KEY=value`` lines. Supports ``export`` prefixes and quoting."""
    values: dict[str, str] = {}
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            raise ConfigError(f"{origin}:{number}: expected KEY=value")
        key, _, value = line.partition("=")
        key = key.strip()
        if not key:
            raise ConfigError(f"{origin}:{number}: empty key")
        values[key] = _unquote(value.strip())
    return values


def load_env_file(path: Path | None = None, *, override: bool = False) -> list[str]:
    """Load the repo ``.env``, then the machine file, into ``os.environ``.

    Returns the names that were applied. The repo file is the one named (or
    found by walking up); the machine file is optional and only fills gaps.
    """
    env_path = path or find_env_file()
    applied: list[str] = []
    if env_path is None:
        log.debug("No .env found; relying on the process environment")
    else:
        if not env_path.is_file():
            raise ConfigError(f"env file does not exist: {env_path}")
        applied += _apply(env_path, override=override)

    machine = machine_env_file()
    if machine.is_file():
        applied += _apply(machine, override=False)
    return applied


def _apply(env_path: Path, *, override: bool) -> list[str]:
    try:
        text = env_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise ConfigError(f"could not read {env_path}: {exc}") from exc

    applied: list[str] = []
    for key, value in parse_env_file(text, origin=env_path.as_posix()).items():
        if not override and key in os.environ:
            continue
        os.environ[key] = value
        applied.append(key)

    if applied:
        # Names only. Values are secrets.
        log.debug("Loaded %d variable(s) from %s: %s", len(applied), env_path, applied)
    return applied


def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value
