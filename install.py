#!/usr/bin/env python3
"""Install a pinned, reviewable runtime without replacing project configuration.

This replaces manual copying as the update path. No network access or global changes.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

SOURCE = Path(__file__).resolve().parent
VENDOR = Path(".agents/agentslots")
MANIFEST = Path(".agents/agentslots-install.json")
COMMANDS = ("agent-up", "agent-dev", "agent-mobile", "agent-status", "agent-stop",
            "agent-down", "agent-reap", "sim-lock")
BLOCK = (b"<!-- agentslots:start -->\n"
         b"## AgentSlots runtime resources\n\n"
         b"These runtime instructions complement task permissions; they do not grant them.\n"
         b"Read `.agents/agentslots/README.md` for the installed runtime contract.\n"
         b"Run `scripts/agent-status.sh` before provisioning or cleanup. Start code-only with\n"
         b"`scripts/agent-up.sh <branch>`; add `--stack` only for a running local app.\n"
         b"Stop and release only this task's resources. AgentKeel owns its isolated clones.\n"
         b"<!-- agentslots:end -->\n")


class Refused(Exception):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_path(root, relative):
    relative = Path(relative)
    if relative.is_absolute() or ".." in relative.parts:
        raise Refused(f"invalid managed path: {relative}")
    p = root
    for part in relative.parts:
        p = p / part
        if p.is_symlink():
            raise Refused(f"refusing symlink: {p}")
    if p.exists() and not p.is_file():
        raise Refused(f"not a regular file: {p}")
    return p


def read(root, relative):
    p = safe_path(root, relative)
    return p.read_bytes() if p.exists() else None


def saved(data):
    return None if data is None else base64.b64encode(data).decode("ascii")


def restored(data):
    return None if data is None else base64.b64decode(data, validate=True)


def atomic_write(root, relative, data, mode=0o644):
    p = safe_path(root, relative)
    if data is None:
        p.unlink(missing_ok=True)
        return
    p.parent.mkdir(parents=True, exist_ok=True)
    safe_path(root, relative)
    fd, temp = tempfile.mkstemp(prefix=".agentslots-", dir=p.parent)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(data)
        os.chmod(temp, mode)
        os.replace(temp, p)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def payload():
    files = {}
    for directory in ("scripts", "integrations"):
        for p in sorted((SOURCE / directory).rglob("*")):
            if p.is_file() and p.suffix in (".sh", ".py", ".mjs", ".ts", ".md", ".conf"):
                if p.is_symlink():
                    raise Refused(f"source symlink: {p}")
                rel = p.relative_to(SOURCE)
                files[str(VENDOR / rel)] = (p.read_bytes(), p.stat().st_mode & 0o777)
    for name in ("README.md", "LICENSE", ".agent-slots.conf.example", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", "PRE-RELEASE.md"):
        files[str(VENDOR / name)] = ((SOURCE / name).read_bytes(), 0o644)
    for p in sorted((SOURCE / "docs").rglob("*")):
        if p.is_file() and p.suffix in (".md", ".svg", ".gif"):
            files[str(VENDOR / p.relative_to(SOURCE))] = (p.read_bytes(), 0o644)
    files[str(VENDOR / "QUICKSTART.md")] = ((SOURCE / "QUICKSTART.md").read_bytes(), 0o644)
    for name in COMMANDS:
        text = ("#!/usr/bin/env bash\n# AgentSlots managed wrapper.\n"
                'ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)\n'
                f'exec /bin/bash "$ROOT/{VENDOR}/scripts/{name}.sh" "$@"\n')
        files[f"scripts/{name}.sh"] = (text.encode(), 0o755)
    text = ('# AgentSlots managed source wrapper; for project-specific helpers.\n'
            '_agentslots_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)\n'
            f'. "$_agentslots_root/{VENDOR}/scripts/lib/agent-slot.sh"\n'
            'unset _agentslots_root\n')
    files["scripts/lib/agent-slot.sh"] = (text.encode(), 0o644)
    return files


def load_manifest(root):
    data = read(root, MANIFEST)
    if data is None:
        return None
    try:
        manifest = json.loads(data)
        if manifest["format"] != 1 or not isinstance(manifest["files"], dict):
            raise ValueError("unsupported format")
        for name, entry in manifest["files"].items():
            allowed = name.startswith(str(VENDOR) + "/") or name in {
                "AGENTS.md", ".agent-slots.conf", ".gitignore", "scripts/lib/agent-slot.sh",
                *(f"scripts/{command}.sh" for command in COMMANDS)}
            if not allowed:
                raise ValueError(f"unexpected managed path {name}")
            safe_path(root, name)
            restored(entry["original"])
            if not isinstance(entry["sha256"], str):
                raise ValueError("missing checksum")
        return manifest
    except (ValueError, KeyError, TypeError) as error:
        raise Refused(f"invalid install manifest: {error}") from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--uninstall", action="store_true")
    parser.add_argument("--adopt-existing", action="store_true",
                        help="replace existing script entry points, preserving their original bytes")
    args = parser.parse_args()
    root = args.repo.expanduser().resolve()
    try:
        top = subprocess.run(["git", "-C", str(root), "rev-parse", "--show-toplevel"],
                             check=True, capture_output=True, text=True).stdout.strip()
        if Path(top).resolve() != root:
            raise Refused("--repo must name the repository root")
        old = load_manifest(root)
        if args.uninstall and old is None:
            print("AgentSlots: nothing installed by this installer.")
            return 0
        entries = old["files"] if old else {}
        changes, records = {}, {}
        retained = []
        for name, entry in entries.items():
            current = read(root, name)
            same = current is not None and digest(current) == entry["sha256"]
            editable = name in ("AGENTS.md", ".agent-slots.conf", ".gitignore")
            if not same and not editable:
                raise Refused(f"managed file changed: {name}; preserve or reconcile it before updating/removing")
            if args.uninstall:
                if same:
                    changes[name] = (restored(entry["original"]), entry.get("original_mode", 0o644))
                elif name == "AGENTS.md" and current is not None:
                    block = restored(entry.get("block"))
                    if block and current.count(block) == 1:
                        changes[name] = (current.replace(block, b"", 1), 0o644)
                    else:
                        retained.append(name)
                else:
                    retained.append(name)
        version = json.loads((SOURCE / "package.json").read_text())["version"]
        if not args.uninstall:
            files = payload()
            for name, (data, mode) in files.items():
                current = read(root, name)
                if name not in entries and current is not None:
                    if not (args.adopt_existing and name.startswith("scripts/")):
                        raise Refused(f"existing file: {name}; only script entry points can be adopted with --adopt-existing")
                original = entries.get(name, {}).get("original", saved(current))
                original_mode = entries.get(name, {}).get("original_mode", safe_path(root, name).stat().st_mode & 0o777 if current is not None else 0o644)
                records[name] = {"original": original, "original_mode": original_mode, "sha256": digest(data)}
                if current != data:
                    changes[name] = (data, mode)
            # Remove retired, unchanged vendor files on an update, restoring any adopted originals.
            for name, entry in entries.items():
                if name not in files and name not in ("AGENTS.md", ".agent-slots.conf", ".gitignore"):
                    changes[name] = (restored(entry["original"]), entry.get("original_mode", 0o644))
            for name in ("AGENTS.md", ".agent-slots.conf", ".gitignore"):
                current = read(root, name)
                entry = entries.get(name)
                data, block = current, None
                if name == "AGENTS.md":
                    if entry:
                        previous = restored(entry.get("block"))
                        if previous and current is not None and current.count(previous) == 1:
                            block = BLOCK
                            data = current.replace(previous, block, 1)
                        else:
                            raise Refused("the AgentSlots block in AGENTS.md changed; reconcile it before updating")
                    else:
                        if current and b"<!-- agentslots:" in current:
                            raise Refused("AGENTS.md already contains unmanaged AgentSlots markers")
                        block = BLOCK
                        data = (current or b"") + (b"\n\n" if current else b"") + block
                elif name == ".agent-slots.conf" and current is None:
                    data = (SOURCE / ".agent-slots.conf.example").read_bytes()
                elif name == ".gitignore":
                    if b".agent" not in (current or b"").splitlines():
                        data = (current or b"") + (b"\n" if current and not current.endswith(b"\n") else b"") + b".agent\n"
                if data != current:
                    changes[name] = (data, 0o644)
                if entry or data != current:
                    records[name] = {"original": entry["original"] if entry else saved(current),
                                     "sha256": digest(data), "original_mode": entry.get("original_mode", 0o644) if entry else 0o644}
                    if block:
                        records[name]["block"] = saved(block)
                    if entry and name == "AGENTS.md" and current is not None and digest(current) != entry["sha256"]:
                        records[name]["original"] = saved(current.replace(restored(entry["block"]), b"", 1))
                    # User-owned config/ignore edits must survive uninstall.
                    if entry and name != "AGENTS.md" and current is not None and digest(current) != entry["sha256"]:
                        records[name]["original"] = saved(current)
            git = lambda *a: subprocess.run(["git", "-C", str(SOURCE), *a], capture_output=True, text=True, check=True).stdout.strip()
            manifest = {"format": 1, "version": version, "revision": git("rev-parse", "HEAD"),
                        "source_dirty": bool(git("status", "--porcelain", "--untracked-files=normal")),
                        "files": records}
            data = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
            if read(root, MANIFEST) != data:
                changes[str(MANIFEST)] = (data, 0o644)
        else:
            changes[str(MANIFEST)] = (None, 0o644)
        print(f"AgentSlots {'uninstall' if args.uninstall else version + ' install/update'}: {root}")
        for name, (data, _) in sorted(changes.items()):
            print(f"  {'remove' if data is None else 'write '} {name}")
        for name in retained:
            print(f"  keep edited {name}")
        if not args.apply:
            print("Preview only. Add --apply to make these changes.")
            return 0
        # All files have been checked before the first write. Undo partial application on failure.
        before = {name: (read(root, name), safe_path(root, name).stat().st_mode & 0o777 if safe_path(root, name).exists() else 0o644) for name in changes}
        done = []
        try:
            for name, (data, mode) in changes.items():
                atomic_write(root, name, data, mode)
                done.append(name)
        except OSError:
            for name in reversed(done):
                atomic_write(root, name, *before[name])
            raise
        if args.uninstall:
            vendor = root / VENDOR
            if vendor.is_dir():
                for p in sorted(vendor.rglob("*"), reverse=True):
                    if p.is_dir():
                        try: p.rmdir()
                        except OSError: pass
                try: vendor.rmdir()
                except OSError: pass
        print("Applied. No commit, host configuration or global installation was changed.")
        return 0
    except (Refused, OSError, subprocess.CalledProcessError) as error:
        print(f"AgentSlots: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
