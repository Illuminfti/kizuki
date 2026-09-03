import hashlib
import os
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from gauntlet.attempt_workspace import (
    AttemptWorkspaceError,
    AttemptWorkspaceReceipt,
    create_attempt_workspace,
)
from gauntlet.task_spec import ResourceBudgets, TaskSpec, sign_task_spec


KEY = b"workspace-test-controller-key-32bytes"
INSTRUCTION = b"Implement only the signed bounded workspace task."
INSTRUCTION_SHA256 = hashlib.sha256(INSTRUCTION).hexdigest()


class AttemptWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        self.source = self.root / "source"
        self._git("init", "--initial-branch=main", str(self.source), cwd=self.root)
        self.source.chmod(0o700)
        (self.source / "gauntlet").mkdir()
        (self.source / "gauntlet" / "worker.py").write_text("print('ok')\n", encoding="utf-8")
        executable = self.source / "verify.sh"
        executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        executable.chmod(0o755)
        self._commit("initial")
        self.base_sha = self._git("rev-parse", "HEAD", cwd=self.source).stdout.strip()
        self._privatize_source_metadata()
        self.attempts_root = self.root / "attempts"
        self.attempts_root.mkdir(mode=0o700)
        self.attempt = self.attempts_root / ("9" * 64)
        self.now = int(time.time())

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def _git(*args, cwd, check=True):
        return subprocess.run(
            ("/usr/bin/git", *args), cwd=cwd, check=check, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env={"PATH": "/usr/bin:/bin", "HOME": "/dev/null", "LC_ALL": "C",
                 "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"},
        )

    def _commit(self, message):
        self._git("add", "--all", cwd=self.source)
        self._git(
            "-c", "user.name=Gauntlet Test", "-c", "user.email=test@example.invalid",
            "commit", "-m", message, cwd=self.source,
        )

    def _privatize_source_metadata(self):
        git_dir = self.source / ".git"
        for current, directories, files in os.walk(git_dir, followlinks=False):
            Path(current).chmod(0o700)
            for name in directories:
                path = Path(current) / name
                if not path.is_symlink():
                    path.chmod(0o700)
            for name in files:
                path = Path(current) / name
                if not path.is_symlink():
                    path.chmod(0o600)

    def envelope(self, **overrides):
        values = dict(
            campaign_id="campaign-1", task_id="task-1", task_attempt=1,
            phase_attempt_id="9" * 64,
            controller_epoch=3, repository="owner/repository",
            base_sha=self.base_sha, subject_sha=self.base_sha, expected_branch="main",
            issue_url="https://github.com/owner/repository/issues/4",
            instruction_sha256=INSTRUCTION_SHA256,
            instruction_bytes=len(INSTRUCTION),
            allowed_prefixes=("gauntlet",), forbidden_prefixes=("secrets",),
            adapter="codex", principal_id="codex-builder", role="builder",
            verification_policy="python-unittest-v2",
            budgets=ResourceBudgets(300, 120, 512 * 1024 * 1024, 16, 1024 * 1024),
            network_profile="offline", issued_at=self.now, expires_at=self.now + 300,
            receipt_schema="gauntlet-phase-receipt-v2",
        )
        values.update(overrides)
        if "base_sha" in overrides and "subject_sha" not in overrides:
            values["subject_sha"] = overrides["base_sha"]
        return sign_task_spec(TaskSpec(**values), "controller-key-1", KEY)

    def create(self, envelope=None):
        current = envelope or self.envelope()
        self._privatize_source_metadata()
        return create_attempt_workspace(
            current, KEY, {"owner/repository": self.source}, self.attempts_root,
            expected_phase_attempt_id=current.spec.phase_attempt_id,
            expected_subject_sha=current.spec.subject_sha, clock=lambda: self.now,
        )

    def use_fresh_attempt(self, label):
        self.attempts_root = self.root / f"attempts-{label}"
        self.attempts_root.mkdir(mode=0o700)
        self.attempt = self.attempts_root / ("9" * 64)

    def test_creates_private_detached_no_local_clone_with_bounded_receipt(self):
        import gauntlet.attempt_workspace as module

        commands = []
        environments = []
        original = module._run_quiet

        def recording(argv, *args, **kwargs):
            commands.append(tuple(argv))
            environments.append(dict(kwargs["environment"]))
            return original(argv, *args, **kwargs)

        with mock.patch.object(module, "_run_quiet", side_effect=recording):
            receipt = self.create()

        clone = next(command for command in commands if len(command) > 1 and command[1] == "clone")
        self.assertIn("--no-local", clone)
        self.assertIn("--no-hardlinks", clone)
        self.assertIn("--no-checkout", clone)
        self.assertIn("--no-recurse-submodules", clone)
        self.assertIn("--single-branch", clone)
        self.assertIn("--no-tags", clone)
        self.assertIn("--branch=main", clone)
        self.assertEqual(clone[0], "/usr/bin/git")
        self.assertIn("/proc/self/fd/", clone[-2])
        self.assertIn("/proc/self/fd/", clone[-1])
        self.assertNotIn(str(self.source), "\0".join(clone))
        self.assertNotIn(str(self.attempt), "\0".join(clone))
        self.assertTrue(environments)
        self.assertTrue(all(item["GIT_NO_REPLACE_OBJECTS"] == "1"
                            for item in environments))
        expected_protected = {
            "core.hooksPath": "/dev/null",
            "core.fsmonitor": "false",
            "core.alternateRefsCommand": "/bin/false",
            "uploadpack.packObjectsHook": "exec",
            "credential.helper": "",
            "core.askPass": "/bin/false",
            "core.sshCommand": "/bin/false",
            "core.gitProxy": "/bin/false",
            "diff.external": "/bin/false",
        }
        for environment in environments:
            count = int(environment["GIT_CONFIG_COUNT"])
            protected = {
                environment[f"GIT_CONFIG_KEY_{index}"]:
                environment[f"GIT_CONFIG_VALUE_{index}"]
                for index in range(count)
            }
            self.assertEqual(protected, expected_protected)
        self.assertEqual(receipt.repository, "owner/repository")
        self.assertEqual(receipt.base_sha, self.base_sha)
        self.assertEqual(receipt.subject_sha, self.base_sha)
        self.assertEqual(receipt.phase_attempt_id, "9" * 64)
        self.assertFalse(hasattr(receipt, "instruction"))
        self.assertFalse(hasattr(receipt, "instruction_path"))
        self.assertFalse((self.attempts_root / "work").exists())
        self.assertEqual(
            {path.name for path in self.attempts_root.iterdir()},
            {receipt.phase_attempt_id},
        )
        self.assertEqual(receipt.file_count, 2)
        self.assertGreater(receipt.total_bytes, 0)
        self.assertEqual(len(receipt.inventory_sha256), 64)
        self.assertEqual(len(receipt.git_tree_sha), 40)

        work = self.attempt / "work"
        self.assertEqual(work.stat().st_mode & 0o777, 0o700)
        self.assertTrue((work / ".git").is_dir())
        self.assertEqual(self._git("rev-parse", "HEAD", cwd=work).stdout.strip(), self.base_sha)
        detached = self._git("symbolic-ref", "-q", "HEAD", cwd=work, check=False)
        self.assertEqual(detached.returncode, 1)
        self.assertEqual(self._git("remote", cwd=work).stdout, "")
        self.assertFalse(any((work / ".git" / "hooks").glob("*")))
        self.assertFalse((work / ".git" / "logs").exists())
        alternates = work / ".git" / "objects" / "info" / "alternates"
        self.assertFalse(alternates.exists())
        object_files = [path for path in (work / ".git" / "objects").rglob("*") if path.is_file()]
        self.assertTrue(object_files)
        self.assertTrue(all(path.stat().st_nlink == 1 for path in object_files))
        self.assertTrue(os.access(work / "verify.sh", os.X_OK))
        retained_controller_state = list(self.attempt.glob(".gauntlet-git-*"))
        self.assertEqual(len(retained_controller_state), 1)
        self.assertEqual(retained_controller_state[0].stat().st_mode & 0o777, 0o700)
        self.assertEqual(
            {path.name for path in retained_controller_state[0].iterdir()},
            {"home"},
        )
        self.assertTrue((retained_controller_state[0] / "home").is_dir())
        self.assertEqual(list((retained_controller_state[0] / "home").iterdir()), [])
        self.assertFalse((retained_controller_state[0] / "template").exists())
        self.assertFalse(
            retained_controller_state[0].is_relative_to(work),
            "controller-only retained state must remain outside the worker tree",
        )
        source_bytes = str(self.source).encode()
        for path in (work / ".git").rglob("*"):
            if path.is_file() and "objects" not in path.relative_to(work / ".git").parts:
                self.assertNotIn(source_bytes, path.read_bytes())

    def test_non_builder_detaches_subject_while_preserving_comparison_base(self):
        (self.source / "gauntlet" / "worker.py").write_text(
            "print('submitted')\n", encoding="utf-8"
        )
        self._commit("submitted head")
        subject = self._git("rev-parse", "HEAD", cwd=self.source).stdout.strip()
        envelope = self.envelope(
            role="verifier", base_sha=self.base_sha, subject_sha=subject,
        )

        receipt = self.create(envelope)

        self.assertEqual(receipt.base_sha, self.base_sha)
        self.assertEqual(receipt.subject_sha, subject)
        self.assertEqual(
            self._git("rev-parse", "HEAD", cwd=self.attempt / "work").stdout.strip(),
            subject,
        )

    def test_rejects_clone_whose_captured_branch_differs_from_signed_subject(self):
        import gauntlet.attempt_workspace as module

        (self.source / "gauntlet" / "worker.py").write_text(
            "print('submitted')\n", encoding="utf-8"
        )
        self._commit("submitted head")
        subject = self._git("rev-parse", "HEAD", cwd=self.source).stdout.strip()
        envelope = self.envelope(
            role="verifier", base_sha=self.base_sha, subject_sha=subject,
        )
        original = module._run_quiet
        changed = False

        def alter_cloned_branch(argv, *args, **kwargs):
            nonlocal changed
            result = original(argv, *args, **kwargs)
            if len(argv) > 1 and argv[1] == "clone" and not changed:
                changed = True
                branch = self.attempt / "work" / ".git" / "refs" / "heads" / "main"
                branch.write_text(self.base_sha + "\n", encoding="ascii")
                branch.chmod(0o600)
            return result

        with mock.patch.object(module, "_run_quiet", side_effect=alter_cloned_branch):
            with self.assertRaisesRegex(AttemptWorkspaceError, "cloned snapshot branch"):
                self.create(envelope)

    def test_scrubs_ambient_git_config_and_templates(self):
        hostile = self.root / "hostile-home"
        template = hostile / "template" / "hooks"
        template.mkdir(parents=True)
        (template / "post-checkout").write_text("#!/bin/sh\nexit 99\n", encoding="utf-8")
        (template / "post-checkout").chmod(0o755)
        (hostile / ".gitconfig").write_text(
            f"[init]\n\ttemplateDir = {template.parent}\n[core]\n\thooksPath = {template}\n",
            encoding="utf-8",
        )
        with mock.patch.dict(os.environ, {
            "HOME": str(hostile), "GIT_CONFIG_GLOBAL": str(hostile / ".gitconfig"),
            "GIT_TEMPLATE_DIR": str(template.parent), "GIT_ALTERNATE_OBJECT_DIRECTORIES": "/tmp/no",
        }):
            self.create()
        self.assertFalse(any((self.attempt / "work" / ".git" / "hooks").glob("*")))

    def test_late_template_hook_insertion_has_no_clone_execution_surface(self):
        import gauntlet.attempt_workspace as module

        marker = self.root / "late-template-hook-ran"
        original = module._run_quiet
        clone_command = None
        injected = False

        def insert_hook_immediately_before_clone(argv, *args, **kwargs):
            nonlocal clone_command, injected
            if len(argv) > 1 and argv[1] == "clone" and not injected:
                injected = True
                clone_command = tuple(argv)
                state = next(self.attempt.glob(".gauntlet-git-*"))
                hooks = state / "template" / "hooks"
                hooks.mkdir(parents=True, mode=0o700)
                hook = hooks / "reference-transaction"
                hook.write_text(
                    f"#!/bin/sh\nprintf ran > '{marker}'\n",
                    encoding="utf-8",
                )
                hook.chmod(0o700)
            return original(argv, *args, **kwargs)

        with mock.patch.object(module, "_run_quiet", side_effect=insert_hook_immediately_before_clone):
            receipt = self.create()

        self.assertTrue(injected)
        self.assertIsNotNone(clone_command)
        self.assertIn("--template=", clone_command)
        self.assertFalse(marker.exists())
        self.assertEqual(receipt.subject_sha, self.base_sha)

    def test_late_source_config_cannot_execute_external_clone_helper(self):
        import gauntlet.attempt_workspace as module

        alternate = self.root / "alternate"
        self._git("init", "--initial-branch=main", str(alternate), cwd=self.root)
        self._git(
            "-c", "user.name=Gauntlet Test", "-c", "user.email=test@example.invalid",
            "commit", "--allow-empty", "-m", "alternate", cwd=alternate,
        )
        marker = self.root / "late-config-helper-ran"
        helper = self.root / "alternate-refs-helper"
        helper.write_text(
            f"#!/bin/sh\nprintf ran > '{marker}'\nexit 0\n",
            encoding="utf-8",
        )
        helper.chmod(0o700)
        original_popen = module.subprocess.Popen
        injected = False

        def inject_at_clone_process_boundary(argv, *args, **kwargs):
            nonlocal injected
            if "clone" in argv and not injected:
                injected = True
                alternates = self.source / ".git" / "objects" / "info" / "alternates"
                alternates.write_text(
                    str(alternate / ".git" / "objects") + "\n",
                    encoding="utf-8",
                )
                config = self.source / ".git" / "config"
                config.write_text(
                    config.read_text(encoding="utf-8")
                    + f"\n[core]\n\talternateRefsCommand = {helper}\n",
                    encoding="utf-8",
                )
            return original_popen(argv, *args, **kwargs)

        with mock.patch.object(
            module.subprocess, "Popen", side_effect=inject_at_clone_process_boundary,
        ):
            with self.assertRaisesRegex(
                AttemptWorkspaceError, "Git|config|metadata|source|clone",
            ):
                self.create()

        self.assertTrue(injected)
        self.assertFalse(marker.exists(), "late source config executed an external helper")

    def test_source_config_snapshot_cannot_change_during_clone(self):
        import gauntlet.attempt_workspace as module

        original_popen = module.subprocess.Popen
        injected = False

        def change_allowed_config_at_clone(argv, *args, **kwargs):
            nonlocal injected
            if "clone" in argv and not injected:
                injected = True
                config = self.source / ".git" / "config"
                config.write_text(
                    config.read_text(encoding="utf-8")
                    + "\n[remote \"origin\"]\n"
                    + "\turl = https://example.invalid/changed\n"
                    + "\tfetch = +refs/heads/*:refs/remotes/origin/*\n",
                    encoding="utf-8",
                )
            return original_popen(argv, *args, **kwargs)

        with mock.patch.object(
            module.subprocess, "Popen", side_effect=change_allowed_config_at_clone,
        ):
            with self.assertRaisesRegex(
                AttemptWorkspaceError, "config|source|changed|snapshot",
            ):
                self.create()

        self.assertTrue(injected)

    def test_rejects_attribute_control_paths_and_same_size_blob_drift(self):
        attributes = self.source / ".gitattributes"
        attributes.write_text("* text\n", encoding="utf-8")
        self._commit("attributes")
        current = self._git("rev-parse", "HEAD", cwd=self.source).stdout.strip()
        with self.assertRaisesRegex(AttemptWorkspaceError, "attribute"):
            self.create(self.envelope(base_sha=current))

        self.use_fresh_attempt("info-attributes")
        self._git("reset", "--hard", self.base_sha, cwd=self.source)
        info_attributes = self.source / ".git" / "info" / "attributes"
        info_attributes.write_text("* -text\n", encoding="utf-8")
        info_attributes.chmod(0o600)
        with self.assertRaisesRegex(AttemptWorkspaceError, "attribute"):
            self.create()
        info_attributes.unlink()
        self.use_fresh_attempt("blob-drift")

        import gauntlet.attempt_workspace as module
        original = module._run_capture
        changed = False

        def drift_after_status(argv, *args, **kwargs):
            nonlocal changed
            result = original(argv, *args, **kwargs)
            if "status" in argv and not changed:
                changed = True
                target = self.attempt / "work" / "gauntlet" / "worker.py"
                data = target.read_bytes()
                target.write_bytes(b"x" * len(data))
                target.chmod(0o600)
            return result

        with mock.patch.object(module, "_run_capture", side_effect=drift_after_status):
            with self.assertRaisesRegex(AttemptWorkspaceError, "blob|identity|changed"):
                self.create()

    def test_rejects_preexisting_or_symlink_destination_without_touching_target(self):
        self.attempt.mkdir(mode=0o700)
        work = self.attempt / "work"
        work.mkdir()
        marker = work / "marker"
        marker.write_text("keep", encoding="utf-8")
        with self.assertRaisesRegex(AttemptWorkspaceError, "consumed|recovery"):
            self.create()
        self.assertEqual(marker.read_text(encoding="utf-8"), "keep")
        self.use_fresh_attempt("symlink-destination")
        self.attempt.mkdir(mode=0o700)
        work = self.attempt / "work"
        outside = self.root / "outside"
        outside.mkdir()
        work.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(AttemptWorkspaceError, "consumed|recovery"):
            self.create()
        self.assertTrue(outside.is_dir())

    def test_atomic_work_ownership_rejects_injected_empty_preopened_directory(self):
        import gauntlet.attempt_workspace as module

        original_mkdir = module.os.mkdir
        injected_fd = None
        injected_identity = None

        def inject_before_controller_mkdir(path, mode=0o777, *, dir_fd=None):
            nonlocal injected_fd, injected_identity
            if path == "work" and dir_fd is not None and injected_fd is None:
                original_mkdir(path, mode=0o700, dir_fd=dir_fd)
                injected_fd = os.open(
                    path,
                    os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0),
                    dir_fd=dir_fd,
                )
                info = os.fstat(injected_fd)
                injected_identity = (info.st_dev, info.st_ino)
                raise FileExistsError("injected work directory won mkdirat race")
            return original_mkdir(path, mode=mode, dir_fd=dir_fd)

        try:
            with mock.patch.object(module.os, "mkdir", side_effect=inject_before_controller_mkdir):
                with self.assertRaisesRegex(AttemptWorkspaceError, "fresh|owned|exists"):
                    self.create()
            self.assertIsNotNone(injected_fd)
            self.assertEqual(
                injected_identity,
                ((self.attempt / "work").stat().st_dev,
                 (self.attempt / "work").stat().st_ino),
            )
            self.assertEqual(list((self.attempt / "work").iterdir()), [])
        finally:
            if injected_fd is not None:
                os.close(injected_fd)

    def test_rejects_active_hooks_alternates_and_unsafe_source_config(self):
        hook = self.source / ".git" / "hooks" / "post-checkout"
        hook.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        hook.chmod(0o755)
        with self.assertRaisesRegex(AttemptWorkspaceError, "hook"):
            self.create()
        hook.unlink()

        self.use_fresh_attempt("alternates")
        alternates = self.source / ".git" / "objects" / "info" / "alternates"
        alternates.write_text("/tmp/objects\n", encoding="utf-8")
        with self.assertRaisesRegex(AttemptWorkspaceError, "alternate"):
            self.create()
        alternates.unlink()

        self.use_fresh_attempt("unsafe-config")
        self._git("config", "core.hooksPath", "/tmp/hooks", cwd=self.source)
        with self.assertRaisesRegex(AttemptWorkspaceError, "config"):
            self.create()

    def test_rejects_group_writable_or_symlinked_git_metadata(self):
        envelope = self.envelope()
        git_dir = self.source / ".git"
        git_dir.chmod(0o770)
        with self.assertRaisesRegex(AttemptWorkspaceError, "writable|metadata"):
            create_attempt_workspace(
                envelope, KEY, {"owner/repository": self.source}, self.attempts_root,
                expected_phase_attempt_id=envelope.spec.phase_attempt_id,
                expected_subject_sha=envelope.spec.subject_sha, clock=lambda: self.now,
            )
        git_dir.chmod(0o700)

        self.use_fresh_attempt("group-writable-config")
        config = git_dir / "config"
        config.chmod(0o660)
        with self.assertRaisesRegex(AttemptWorkspaceError, "metadata|path"):
            create_attempt_workspace(
                envelope, KEY, {"owner/repository": self.source}, self.attempts_root,
                expected_phase_attempt_id=envelope.spec.phase_attempt_id,
                expected_subject_sha=envelope.spec.subject_sha, clock=lambda: self.now,
            )
        config.chmod(0o600)

        self.use_fresh_attempt("symlinked-hooks")
        hooks = git_dir / "hooks"
        outside_hooks = self.root / "outside-hooks"
        hooks.rename(outside_hooks)
        hooks.symlink_to(outside_hooks, target_is_directory=True)
        with self.assertRaisesRegex(AttemptWorkspaceError, "metadata|path"):
            create_attempt_workspace(
                envelope, KEY, {"owner/repository": self.source}, self.attempts_root,
                expected_phase_attempt_id=envelope.spec.phase_attempt_id,
                expected_subject_sha=envelope.spec.subject_sha, clock=lambda: self.now,
            )
        hooks.unlink()
        outside_hooks.rename(hooks)
        self._privatize_source_metadata()

        info = git_dir / "objects" / "info"
        outside_info = self.root / "outside-info"
        info.rename(outside_info)
        info.symlink_to(outside_info, target_is_directory=True)
        with self.assertRaisesRegex(AttemptWorkspaceError, "metadata|path"):
            create_attempt_workspace(
                envelope, KEY, {"owner/repository": self.source}, self.attempts_root,
                expected_phase_attempt_id=envelope.spec.phase_attempt_id,
                expected_subject_sha=envelope.spec.subject_sha, clock=lambda: self.now,
            )

    def test_rejects_git_indirection_metadata_and_metadata_hardlinks(self):
        envelope = self.envelope()
        git_dir = self.source / ".git"
        cases = (
            (git_dir / "commondir", "../other\n"),
            (git_dir / "gitdir", "/tmp/untrusted-worktree/.git\n"),
            (git_dir / "config.worktree", "[core]\n\tbare = false\n"),
            (git_dir / "worktrees", None),
            (git_dir / "modules", None),
        )
        for index, (path, content) in enumerate(cases):
            with self.subTest(path=path):
                self.use_fresh_attempt(f"indirection-{index}")
                if content is None:
                    path.mkdir(mode=0o700)
                else:
                    path.write_text(content, encoding="utf-8")
                    path.chmod(0o600)
                with self.assertRaisesRegex(AttemptWorkspaceError, "indirection|metadata"):
                    self.create(envelope)
                if path.is_dir():
                    path.rmdir()
                else:
                    path.unlink()

        self.use_fresh_attempt("metadata-hardlink")
        alias = self.root / "config-hardlink"
        os.link(git_dir / "config", alias)
        with self.assertRaisesRegex(AttemptWorkspaceError, "link|metadata"):
            create_attempt_workspace(
                envelope, KEY, {"owner/repository": self.source}, self.attempts_root,
                expected_phase_attempt_id=envelope.spec.phase_attempt_id,
                expected_subject_sha=envelope.spec.subject_sha, clock=lambda: self.now,
            )

    def test_attempt_root_swap_is_detected_and_owned_residue_is_retained(self):
        import gauntlet.attempt_workspace as module

        moved = self.root / "attempt-moved"
        original = module._run_quiet
        swapped = False

        def swap_after_clone(argv, *args, **kwargs):
            nonlocal swapped
            result = original(argv, *args, **kwargs)
            if len(argv) > 1 and argv[1] == "clone" and not swapped:
                swapped = True
                self.attempt.rename(moved)
                self.attempt.mkdir(mode=0o700)
            return result

        with mock.patch.object(module, "_run_quiet", side_effect=swap_after_clone):
            with self.assertRaisesRegex(AttemptWorkspaceError, "root|mapping|changed"):
                self.create()
        self.assertTrue((moved / "work" / ".git").is_dir())
        self.assertFalse((self.attempt / "work").exists())

    def test_failure_preserves_swapped_victim_and_owned_orphan_for_recovery(self):
        import gauntlet.attempt_workspace as module

        original = module._run_quiet
        orphan = self.attempt / "owned-orphan"
        victim = self.attempt / "work"
        swapped = False

        def swap_after_clone_then_fail(argv, *args, **kwargs):
            nonlocal swapped
            result = original(argv, *args, **kwargs)
            if len(argv) > 1 and argv[1] == "clone" and not swapped:
                swapped = True
                victim.rename(orphan)
                victim.mkdir(mode=0o700)
                marker = victim / "do-not-delete"
                marker.write_text("victim", encoding="utf-8")
                marker.chmod(0o600)
                raise AttemptWorkspaceError("injected post-clone failure")
            return result

        with mock.patch.object(module, "_run_quiet", side_effect=swap_after_clone_then_fail):
            with self.assertRaisesRegex(AttemptWorkspaceError, "injected"):
                self.create()

        self.assertEqual((victim / "do-not-delete").read_text(), "victim")
        self.assertTrue(orphan.is_dir())
        self.assertTrue((orphan / ".git").is_dir())
        with self.assertRaisesRegex(AttemptWorkspaceError, "consumed|recovery"):
            self.create()

    def test_failure_never_deletes_nested_file_victim_or_owned_residue(self):
        import gauntlet.attempt_workspace as module

        original = module._run_quiet
        swapped = False

        def swap_nested_file_then_fail(argv, *args, **kwargs):
            nonlocal swapped
            result = original(argv, *args, **kwargs)
            if len(argv) > 1 and argv[1] == "clone" and not swapped:
                swapped = True
                git_dir = self.attempt / "work" / ".git"
                config = git_dir / "config"
                residue = git_dir / "config.owned-residue"
                config.rename(residue)
                config.write_text("victim", encoding="utf-8")
                config.chmod(0o600)
                raise AttemptWorkspaceError("injected nested-file swap")
            return result

        with mock.patch.object(module, "_run_quiet", side_effect=swap_nested_file_then_fail):
            with self.assertRaisesRegex(AttemptWorkspaceError, "nested-file"):
                self.create()

        git_dir = self.attempt / "work" / ".git"
        self.assertEqual((git_dir / "config").read_text(), "victim")
        self.assertTrue((git_dir / "config.owned-residue").is_file())
        with self.assertRaisesRegex(AttemptWorkspaceError, "consumed|recovery"):
            self.create()

    def test_preclone_failure_permanently_consumes_single_use_attempt_path(self):
        hook = self.source / ".git" / "hooks" / "post-checkout"
        hook.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        hook.chmod(0o700)

        with self.assertRaisesRegex(AttemptWorkspaceError, "hook"):
            self.create()
        retained = list(self.attempt.glob(".gauntlet-git-*"))
        self.assertEqual(len(retained), 1)
        hook.unlink()

        with self.assertRaisesRegex(AttemptWorkspaceError, "consumed|recovery"):
            self.create()
        self.assertEqual(list(self.attempt.glob(".gauntlet-git-*")), retained)

    def test_source_advance_after_inventory_does_not_change_validated_snapshot(self):
        import gauntlet.attempt_workspace as module

        original = module._worktree_inventory
        advanced = False

        def advance_after_inventory(*args, **kwargs):
            nonlocal advanced
            result = original(*args, **kwargs)
            if not advanced:
                advanced = True
                (self.source / "late").write_text("late\n", encoding="utf-8")
                self._commit("late source advance")
                self._privatize_source_metadata()
            return result

        with mock.patch.object(module, "_worktree_inventory", side_effect=advance_after_inventory):
            receipt = self.create()

        advanced_sha = self._git("rev-parse", "HEAD", cwd=self.source).stdout.strip()
        self.assertNotEqual(advanced_sha, self.base_sha)
        self.assertEqual(receipt.subject_sha, self.base_sha)
        self.assertEqual(
            self._git("rev-parse", "HEAD", cwd=self.attempt / "work").stdout.strip(),
            self.base_sha,
        )

    def test_source_inode_swap_after_inventory_does_not_change_validated_snapshot(self):
        import gauntlet.attempt_workspace as module

        original = module._worktree_inventory
        moved = self.root / "source-moved"
        swapped = False

        def swap_after_inventory(*args, **kwargs):
            nonlocal swapped
            result = original(*args, **kwargs)
            if not swapped:
                swapped = True
                self.source.rename(moved)
                self.source.mkdir(mode=0o700)
            return result

        with mock.patch.object(module, "_worktree_inventory", side_effect=swap_after_inventory):
            receipt = self.create()
        self.assertEqual(receipt.subject_sha, self.base_sha)
        self.assertTrue((moved / ".git").is_dir())
        self.assertEqual(
            self._git("rev-parse", "HEAD", cwd=self.attempt / "work").stdout.strip(),
            self.base_sha,
        )

    def test_rejects_source_path_residue_in_clone_metadata(self):
        import gauntlet.attempt_workspace as module

        original = module._worktree_inventory
        injected = False

        def inject_after_inventory(*args, **kwargs):
            nonlocal injected
            result = original(*args, **kwargs)
            if not injected:
                injected = True
                description = self.attempt / "work" / ".git" / "description"
                description.write_text(str(self.source), encoding="utf-8")
                description.chmod(0o600)
            return result

        with mock.patch.object(module, "_worktree_inventory", side_effect=inject_after_inventory):
            with self.assertRaisesRegex(AttemptWorkspaceError, "source-path residue"):
                self.create()

    def test_final_admission_rechecks_detached_head_after_late_checks(self):
        import gauntlet.attempt_workspace as module

        original = module._assert_no_path_residue
        changed = False

        def change_head_after_late_check(*args, **kwargs):
            nonlocal changed
            result = original(*args, **kwargs)
            if not changed:
                changed = True
                head = self.attempt / "work" / ".git" / "HEAD"
                head.write_text("ref: refs/heads/main\n", encoding="ascii")
                head.chmod(0o600)
            return result

        with mock.patch.object(
            module, "_assert_no_path_residue", side_effect=change_head_after_late_check,
        ):
            with self.assertRaisesRegex(AttemptWorkspaceError, "HEAD|detached|subject"):
                self.create()

    def test_final_admission_rechecks_porcelain_after_late_checks(self):
        import gauntlet.attempt_workspace as module

        original = module._assert_no_path_residue
        changed = False

        def change_file_after_late_check(*args, **kwargs):
            nonlocal changed
            result = original(*args, **kwargs)
            if not changed:
                changed = True
                target = self.attempt / "work" / "gauntlet" / "worker.py"
                target.write_bytes(b"x" * len(target.read_bytes()))
                target.chmod(0o600)
            return result

        with mock.patch.object(
            module, "_assert_no_path_residue", side_effect=change_file_after_late_check,
        ):
            with self.assertRaisesRegex(AttemptWorkspaceError, "clean|status|changed"):
                self.create()

    def test_final_admission_repeats_and_compares_exact_inventory_metrics(self):
        import gauntlet.attempt_workspace as module

        original = module._worktree_inventory
        calls = 0

        def differing_second_inventory(*args, **kwargs):
            nonlocal calls
            result = original(*args, **kwargs)
            calls += 1
            if calls == 2:
                return ("0" * 64, result[1], result[2])
            return result

        with mock.patch.object(
            module, "_worktree_inventory", side_effect=differing_second_inventory,
        ):
            with self.assertRaisesRegex(AttemptWorkspaceError, "inventory|metrics|changed"):
                self.create()
        self.assertEqual(calls, 2)

    def test_expiry_during_inventory_rejects_on_fresh_final_clock_sample(self):
        import gauntlet.attempt_workspace as module

        envelope = self.envelope()
        clock_calls = 0
        inventory_calls = 0
        current_time = self.now
        original_inventory = module._worktree_inventory

        def clock():
            nonlocal clock_calls
            clock_calls += 1
            return current_time

        def observe_inventory(*args, **kwargs):
            nonlocal current_time, inventory_calls
            inventory_calls += 1
            result = original_inventory(*args, **kwargs)
            if inventory_calls == 2:
                current_time = envelope.spec.expires_at
            return result

        with mock.patch.object(module, "_worktree_inventory", side_effect=observe_inventory):
            with self.assertRaisesRegex(AttemptWorkspaceError, "specification|admission|expired"):
                create_attempt_workspace(
                    envelope, KEY, {"owner/repository": self.source}, self.attempts_root,
                    expected_phase_attempt_id=envelope.spec.phase_attempt_id,
                    expected_subject_sha=envelope.spec.subject_sha,
                    clock=clock,
                )
        self.assertEqual(inventory_calls, 2)
        self.assertGreaterEqual(clock_calls, 2)

    def test_final_clock_attempt_swap_rejects_and_preserves_both_namespaces(self):
        envelope = self.envelope()
        orphan = self.root / "orphaned-admission-attempt"
        victim_marker = self.attempt / "replacement-victim"
        clock_calls = 0

        def swapping_clock():
            nonlocal clock_calls
            clock_calls += 1
            if clock_calls == 2:
                self.attempt.rename(orphan)
                self.attempt.mkdir(mode=0o700)
                victim_marker.write_text("preserve me", encoding="utf-8")
            return self.now

        with self.assertRaisesRegex(
            AttemptWorkspaceError, "attempt|mapping|destination|metadata",
        ):
            create_attempt_workspace(
                envelope, KEY, {"owner/repository": self.source}, self.attempts_root,
                expected_phase_attempt_id=envelope.spec.phase_attempt_id,
                expected_subject_sha=envelope.spec.subject_sha,
                clock=swapping_clock,
            )

        self.assertEqual(clock_calls, 2)
        self.assertEqual(victim_marker.read_text(encoding="utf-8"), "preserve me")
        self.assertTrue((orphan / "work" / ".git").is_dir())
        self.assertTrue((orphan / f".gauntlet-git-{envelope.spec.phase_attempt_id}").is_dir())

    def test_receipt_validates_every_string_field_independently(self):
        values = dict(
            task_spec_sha256="a" * 64,
            phase_attempt_id="b" * 64,
            repository="owner/repository",
            base_sha="c" * 40,
            subject_sha="d" * 40,
            expected_branch="topic/safe",
            git_tree_sha="e" * 40,
            inventory_sha256="f" * 64,
            file_count=1,
            total_bytes=1,
        )
        AttemptWorkspaceReceipt(**values)
        invalid = {
            "task_spec_sha256": "A" * 64,
            "phase_attempt_id": "short",
            "repository": "owner/repository/extra",
            "base_sha": "g" * 40,
            "subject_sha": None,
            "expected_branch": "../escape",
            "git_tree_sha": "0" * 39,
            "inventory_sha256": b"f" * 64,
        }
        for field, value in invalid.items():
            with self.subTest(field=field):
                changed = dict(values)
                changed[field] = value
                with self.assertRaises(AttemptWorkspaceError):
                    AttemptWorkspaceReceipt(**changed)

    def test_git_capture_kills_child_when_leader_exits_holding_pipe(self):
        import gauntlet.attempt_workspace as module

        script = self.root / "orphan.sh"
        pidfile = self.root / "orphan.pid"
        script.write_text(
            "#!/bin/sh\n"
            "sleep 30 &\n"
            f"echo $! > {pidfile}\n"
            "exit 0\n",
            encoding="utf-8",
        )
        script.chmod(0o700)
        private_home = self.root / "git-home"
        private_home.mkdir(mode=0o700)
        environment = module._git_environment(private_home)
        command = ("/usr/bin/git", "-c", f"alias.orphan=!{script}", "orphan")
        child_pid = None
        try:
            with self.assertRaisesRegex(AttemptWorkspaceError, "time|process group|descendant"):
                module._run_capture(
                    command, environment=environment, max_bytes=1024,
                    timeout_seconds=1,
                )
            child_pid = int(pidfile.read_text(encoding="ascii").strip())
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                try:
                    os.kill(child_pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.01)
            else:
                self.fail("Git descendant survived bounded process-group cleanup")
        finally:
            if child_pid is not None:
                try:
                    os.kill(child_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def test_git_quiet_keyboard_interrupt_still_empties_process_group(self):
        import gauntlet.attempt_workspace as module

        private_home = self.root / "interrupt-home"
        private_home.mkdir(mode=0o700)
        environment = module._git_environment(private_home)
        command = ("/usr/bin/git", "-c", "alias.wait=!sleep 30", "wait")
        original_popen = module.subprocess.Popen
        original_waitid = module.os.waitid
        pgid = None
        interrupted = False

        def start(*args, **kwargs):
            nonlocal pgid
            process = original_popen(*args, **kwargs)
            pgid = process.pid
            return process

        def interrupt_observation(*args, **kwargs):
            nonlocal interrupted
            if not interrupted:
                interrupted = True
                raise KeyboardInterrupt
            return original_waitid(*args, **kwargs)

        try:
            with mock.patch.object(module.subprocess, "Popen", side_effect=start), \
                    mock.patch.object(module.os, "waitid", side_effect=interrupt_observation):
                with self.assertRaises(KeyboardInterrupt):
                    module._run_quiet(command, environment=environment)
            self.assertIsNotNone(pgid)
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                try:
                    os.killpg(pgid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.01)
            else:
                self.fail("Git process group survived interrupted quiet wait")
        finally:
            if pgid is not None:
                try:
                    os.killpg(pgid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def test_git_capture_setup_exceptions_still_empty_process_group(self):
        import gauntlet.attempt_workspace as module

        private_home = self.root / "capture-setup-home"
        private_home.mkdir(mode=0o700)
        environment = module._git_environment(private_home)
        command = ("/usr/bin/git", "-c", "alias.wait=!sleep 30", "wait")
        original_popen = module.subprocess.Popen

        def set_blocking_fault():
            return mock.patch.object(module.os, "set_blocking", side_effect=KeyboardInterrupt)

        def selector_fault():
            return mock.patch.object(
                module.selectors, "DefaultSelector", side_effect=KeyboardInterrupt,
            )

        def register_fault():
            selector = mock.Mock()
            selector.register.side_effect = KeyboardInterrupt
            return mock.patch.object(
                module.selectors, "DefaultSelector", return_value=selector,
            )

        for label, fault in (
            ("set-blocking", set_blocking_fault),
            ("selector", selector_fault),
            ("register", register_fault),
        ):
            with self.subTest(label=label):
                pgid = None

                def start(*args, **kwargs):
                    nonlocal pgid
                    process = original_popen(*args, **kwargs)
                    pgid = process.pid
                    return process

                try:
                    with mock.patch.object(module.subprocess, "Popen", side_effect=start), fault():
                        with self.assertRaises(KeyboardInterrupt):
                            module._run_capture(
                                command, environment=environment, max_bytes=1024,
                            )
                    self.assertIsNotNone(pgid)
                    deadline = time.monotonic() + 2
                    while time.monotonic() < deadline:
                        try:
                            os.killpg(pgid, 0)
                        except ProcessLookupError:
                            break
                        time.sleep(0.01)
                    else:
                        self.fail(f"Git process group survived {label} failure")
                finally:
                    if pgid is not None:
                        try:
                            os.killpg(pgid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass

    def test_successful_git_commands_never_force_kill_reaped_numeric_pgid(self):
        import gauntlet.attempt_workspace as module

        private_home = self.root / "normal-git-home"
        private_home.mkdir(mode=0o700)
        environment = module._git_environment(private_home)
        original_killpg = module.os.killpg
        signals = []

        def record_signal(pgid, sent_signal):
            signals.append(sent_signal)
            return original_killpg(pgid, sent_signal)

        with mock.patch.object(module.os, "killpg", side_effect=record_signal):
            module._run_quiet(("/usr/bin/git", "--version"), environment=environment)
            output = module._run_capture(
                ("/usr/bin/git", "--version"), environment=environment,
                max_bytes=1024,
            )
        self.assertTrue(output.startswith(b"git version "))
        self.assertNotIn(signal.SIGKILL, signals)

    def test_git_group_is_never_probed_or_signaled_after_leader_reap(self):
        import gauntlet.attempt_workspace as module

        private_home = self.root / "reused-pgid-home"
        private_home.mkdir(mode=0o700)
        environment = module._git_environment(private_home)
        original_popen = module.subprocess.Popen
        original_killpg = module.os.killpg
        original_waitid = module.os.waitid
        trackers = []

        class ReuseOnReap:
            def __init__(self, process):
                self._process = process
                self.reaped = False

            def __getattr__(self, name):
                return getattr(self._process, name)

            @property
            def returncode(self):
                return self._process.returncode

            @returncode.setter
            def returncode(self, value):
                self._process.returncode = value

            def poll(self):
                raise AssertionError("poll would reap the process-group leader")

            def wait(self, *args, **kwargs):
                raise AssertionError("Popen.wait would reap outside the pinned waitid seam")

        def start(*args, **kwargs):
            tracker = ReuseOnReap(original_popen(*args, **kwargs))
            trackers.append(tracker)
            return tracker

        def reject_reused_numeric_group(pgid, sent_signal):
            tracker = next(item for item in trackers if item.pid == pgid)
            if tracker.reaped:
                raise AssertionError("numeric process-group ID was reused after reap")
            return original_killpg(pgid, sent_signal)

        def observe_or_reap(id_type, pid, options):
            result = original_waitid(id_type, pid, options)
            if result is not None and not options & os.WNOWAIT:
                tracker = next(item for item in trackers if item.pid == pid)
                tracker.reaped = True
            return result

        with mock.patch.object(module.subprocess, "Popen", side_effect=start), \
                mock.patch.object(module.os, "killpg", side_effect=reject_reused_numeric_group), \
                mock.patch.object(module.os, "waitid", side_effect=observe_or_reap):
            module._run_quiet(("/usr/bin/git", "--version"), environment=environment)
            output = module._run_capture(
                ("/usr/bin/git", "--version"), environment=environment,
                max_bytes=1024,
            )

        self.assertTrue(output.startswith(b"git version "))
        self.assertEqual(len(trackers), 2)
        self.assertTrue(all(item.reaped for item in trackers))

    def test_interrupted_consuming_wait_never_touches_reused_group_id(self):
        import gauntlet.attempt_workspace as module

        private_home = self.root / "interrupted-reap-home"
        private_home.mkdir(mode=0o700)
        environment = module._git_environment(private_home)
        original_popen = module.subprocess.Popen
        original_waitid = module.os.waitid
        original_getpgid = module.os.getpgid
        original_killpg = module.os.killpg
        process = None
        reaped = False

        def start(*args, **kwargs):
            nonlocal process
            process = original_popen(*args, **kwargs)
            return process

        def interrupt_after_consuming_wait(id_type, pid, options):
            nonlocal reaped
            result = original_waitid(id_type, pid, options)
            if result is not None and not options & os.WNOWAIT:
                reaped = True
                raise KeyboardInterrupt
            return result

        def reject_reused_getpgid(pid):
            if reaped:
                raise AssertionError("reused process-group leader ID was probed")
            return original_getpgid(pid)

        def reject_reused_killpg(pgid, sent_signal):
            if reaped:
                raise AssertionError("reused process-group ID was signaled")
            return original_killpg(pgid, sent_signal)

        with mock.patch.object(module.subprocess, "Popen", side_effect=start), \
                mock.patch.object(
                    module.os, "waitid", side_effect=interrupt_after_consuming_wait,
                ), mock.patch.object(
                    module.os, "getpgid", side_effect=reject_reused_getpgid,
                ), mock.patch.object(
                    module.os, "killpg", side_effect=reject_reused_killpg,
                ):
            with self.assertRaises(KeyboardInterrupt):
                module._run_quiet(
                    ("/usr/bin/git", "--version"), environment=environment,
                )
        self.assertTrue(reaped)
        self.assertIsNotNone(process)
        self.assertIsNotNone(process.returncode)

    def test_rejects_gitmodules_gitlinks_symlinks_and_stale_branch_base(self):
        (self.source / ".gitmodules").write_text("[submodule \"x\"]\npath=x\nurl=./x\n", encoding="utf-8")
        self._commit("gitmodules")
        current = self._git("rev-parse", "HEAD", cwd=self.source).stdout.strip()
        with self.assertRaisesRegex(AttemptWorkspaceError, "submodule"):
            self.create(self.envelope(base_sha=current))

        self.use_fresh_attempt("symlink-tree")
        self._git("reset", "--hard", self.base_sha, cwd=self.source)
        link = self.source / "linked"
        link.symlink_to("gauntlet/worker.py")
        self._commit("symlink")
        current = self._git("rev-parse", "HEAD", cwd=self.source).stdout.strip()
        with self.assertRaisesRegex(AttemptWorkspaceError, "symlink|mode"):
            self.create(self.envelope(base_sha=current))

        self.use_fresh_attempt("stale-branch")
        with self.assertRaisesRegex(AttemptWorkspaceError, "branch"):
            self.create(self.envelope(base_sha=self.base_sha))

    def test_rejects_gitlink_even_without_gitmodules(self):
        self._git(
            "update-index", "--add", "--cacheinfo",
            f"160000,{self.base_sha},vendor", cwd=self.source,
        )
        self._git(
            "-c", "user.name=Gauntlet Test", "-c", "user.email=test@example.invalid",
            "commit", "-m", "gitlink", cwd=self.source,
        )
        current = self._git("rev-parse", "HEAD", cwd=self.source).stdout.strip()
        with self.assertRaisesRegex(AttemptWorkspaceError, "submodule"):
            self.create(self.envelope(base_sha=current))

    def test_rejects_wrong_repository_mapping_tampered_or_expired_spec_and_nonprivate_root(self):
        envelope = self.envelope()
        with self.assertRaises(AttemptWorkspaceError):
            create_attempt_workspace(
                envelope, KEY, {"other/repository": self.source}, self.attempts_root,
                clock=lambda: self.now,
                expected_phase_attempt_id=envelope.spec.phase_attempt_id,
                expected_subject_sha=envelope.spec.subject_sha,
            )
        with self.assertRaises(AttemptWorkspaceError):
            create_attempt_workspace(
                envelope, b"z" * 32, {"owner/repository": self.source}, self.attempts_root,
                expected_phase_attempt_id=envelope.spec.phase_attempt_id,
                expected_subject_sha=envelope.spec.subject_sha, clock=lambda: self.now,
            )
        with self.assertRaises(AttemptWorkspaceError):
            create_attempt_workspace(
                envelope, KEY, {"owner/repository": self.source}, self.attempts_root,
                expected_phase_attempt_id=envelope.spec.phase_attempt_id,
                expected_subject_sha=envelope.spec.subject_sha,
                clock=lambda: envelope.spec.expires_at,
            )
        with self.assertRaisesRegex(AttemptWorkspaceError, "authentication"):
            create_attempt_workspace(
                envelope, KEY, {"owner/repository": self.source}, self.attempts_root,
                expected_phase_attempt_id="8" * 64,
                expected_subject_sha=envelope.spec.subject_sha, clock=lambda: self.now,
            )
        self.attempts_root.chmod(0o755)
        with self.assertRaisesRegex(AttemptWorkspaceError, "0700"):
            self.create()


if __name__ == "__main__":
    unittest.main()
