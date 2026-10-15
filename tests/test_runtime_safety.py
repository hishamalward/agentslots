"""Focused safety checks for the shared Python runtime helper."""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "scripts" / "lib" / "agent-runtime.py"
SPEC = importlib.util.spec_from_file_location("agent_runtime", RUNTIME)
runtime = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(runtime)


class GitTrees:
    def __init__(self, root: Path):
        self.repo = root / "repo"
        self.one = root / "one"
        self.two = root / "two"
        self.repo.mkdir()
        self.git(self.repo, "init", "-b", "main")
        self.git(self.repo, "config", "user.email", "test@example.invalid")
        self.git(self.repo, "config", "user.name", "Runtime Tests")
        (self.repo / "tracked.txt").write_text("fixture\n")
        self.git(self.repo, "add", "tracked.txt")
        self.git(self.repo, "commit", "-m", "fixture")
        self.git(self.repo, "worktree", "add", "-b", "slot-one", str(self.one))
        self.git(self.repo, "worktree", "add", "-b", "slot-two", str(self.two))

    @staticmethod
    def git(path: Path, *args: str) -> str:
        result = subprocess.run(["git", "-C", str(path), *args], text=True,
                                capture_output=True, check=True)
        return result.stdout.strip()

    def claim(self, path: Path, *, env_file: Path | None = None) -> dict:
        p = runtime.paths(str(path))
        info = os.stat(path)
        value = {
            **p,
            "version": 1,
            "task": "fixture-task",
            "session": "fixture-session",
            "keel_identity": "b" * 64,
            "identity": "a" * 64,
            "dir_dev": info.st_dev,
            "dir_ino": info.st_ino,
            "state": "provisioning",
            "resources": {"env_path": str(env_file.resolve())} if env_file else {},
            "processes": [],
        }
        runtime.write(p, value)
        workspace = {
            "version": 1,
            "task": "fixture-task",
            "session": "fixture-session",
            "identity": "b" * 64,
            "path": p["path"],
            "gitdir": p["gitdir"],
            "common_dir": p["common_dir"],
            "primary": p["primary"],
            "branch": p["branch"],
            "dir_dev": info.st_dev,
            "dir_ino": info.st_ino,
            "state": "active",
        }
        Path(p["workspace_marker"]).write_text(json.dumps(workspace))
        return p


class RuntimeSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.trees = GitTrees(Path(self.temp.name))

    def test_identity_rejects_replaced_worktree_and_wrong_host_session(self):
        p = self.trees.claim(self.trees.one)
        os.environ["AGENTKEEL_SESSION_ID"] = "other-session"
        self.addCleanup(os.environ.pop, "AGENTKEEL_SESSION_ID", None)
        with self.assertRaisesRegex(runtime.Refused, "session does not match"):
            runtime.identity(p)

        os.environ["AGENTKEEL_SESSION_ID"] = "fixture-session"
        marker = Path(p["workspace_marker"])
        workspace = json.loads(marker.read_text())
        workspace["dir_ino"] += 1
        marker.write_text(json.dumps(workspace))
        with self.assertRaisesRegex(runtime.Refused, "directory was replaced"):
            runtime.identity(p)

    def test_marker_and_workspace_manifest_symlinks_are_refused(self):
        p = runtime.paths(str(self.trees.one))
        outside = Path(self.temp.name) / "outside.json"
        outside.write_text("{}")
        os.symlink(outside, p["marker"])
        with self.assertRaisesRegex(runtime.Refused, "marker is a symlink"):
            runtime.read(p)
        os.unlink(p["marker"])

        os.symlink(outside, p["workspace_marker"])
        with self.assertRaisesRegex(runtime.Refused, "workspace manifest is a symlink"):
            runtime.identity(p)

    def test_environment_restore_restores_only_managed_keys_and_original_mode(self):
        env_file = self.trees.one / ".env"
        env_file.write_text("# keep me\nTOKEN=old\nKEEP=yes\n")
        env_file.chmod(0o640)
        p = self.trees.claim(self.trees.one, env_file=env_file)
        with mock.patch.object(runtime, "locked", return_value=True):
            runtime.env_apply(p, {"TOKEN": "new", "ADDED": "value with space"})
        installed = env_file.read_text()
        self.assertIn("# keep me\n", installed)
        self.assertIn("KEEP=yes\n", installed)
        self.assertIn("TOKEN=new\n", installed)
        self.assertIn('ADDED="value with space"\n', installed)
        self.assertEqual(env_file.stat().st_mode & 0o777, 0o640)

        with mock.patch.object(runtime, "locked", return_value=True):
            runtime.env_restore(p)
        self.assertEqual(env_file.read_text(), "# keep me\nKEEP=yes\nTOKEN=old\n")
        self.assertEqual(env_file.stat().st_mode & 0o777, 0o640)
        self.assertFalse(list(Path(p["gitdir"]).glob("agent-runtime-env-*.json")))

    def test_environment_restore_refuses_symlinked_parent(self):
        folder = self.trees.one / "config"
        folder.mkdir()
        env_file = folder / ".env"
        env_file.write_text("TOKEN=old\n")
        p = self.trees.claim(self.trees.one, env_file=env_file)
        with mock.patch.object(runtime, "locked", return_value=True):
            runtime.env_apply(p, {"TOKEN": "new"})

        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        outside_env = outside / ".env"
        outside_env.write_text("TOKEN=new\n")
        folder.rename(self.trees.one / "config.saved")
        folder.symlink_to(outside, target_is_directory=True)
        before = outside_env.read_text()

        with self.assertRaises(runtime.Refused):
            with mock.patch.object(runtime, "locked", return_value=True):
                runtime.env_restore(p)
        self.assertEqual(outside_env.read_text(), before)

    def test_process_with_unknown_identity_is_preserved(self):
        process = {"pid": 23456, "started": "old", "cwd": str(self.trees.one), "pgid": 23456}
        with mock.patch.object(runtime.os, "kill") as kill, \
                mock.patch.object(runtime, "proc_identity", return_value=None):
            with self.assertRaisesRegex(runtime.Refused, "alive but unidentifiable"):
                runtime.stop_process(process, str(self.trees.one))
        kill.assert_called_once_with(23456, 0)

    def test_shutdown_checks_group_when_leader_exits_at_grace_deadline(self):
        process = {"pid": 23456, "started": "old", "cwd": str(self.trees.one), "pgid": 23456}
        alive_checks = iter((True, True, False))

        def kill(pid, signal):
            if signal == 0:
                if next(alive_checks):
                    return
                raise ProcessLookupError

        with mock.patch.object(runtime.os, "kill", side_effect=kill), \
                mock.patch.object(runtime.os, "killpg") as killpg, \
                mock.patch.object(runtime, "proc_identity", return_value=process), \
                mock.patch.object(runtime.time, "monotonic", side_effect=(0, 0, 6)), \
                mock.patch.object(runtime.time, "sleep"):
            with self.assertRaisesRegex(runtime.Refused, "child processes remain"):
                runtime.stop_process(process, str(self.trees.one))
        self.assertEqual(killpg.call_args_list, [mock.call(23456, 15), mock.call(23456, 0)])

    def test_locking_two_linked_trees_does_not_self_deadlock(self):
        # Run in a child so dup2(fd, 8/9) does not affect unittest's own process.
        code = (
            "import importlib.util,sys; "
            f"s=importlib.util.spec_from_file_location('rt',{str(RUNTIME)!r}); "
            "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
            f"m.lock({str(self.trees.one)!r}); m.lock({str(self.trees.two)!r})"
        )
        result = subprocess.run([sys.executable, "-c", code], capture_output=True,
                                text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
