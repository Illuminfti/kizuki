import hashlib
import os
import tempfile
import unittest
from pathlib import Path

from gauntlet.sandbox import (
    SandboxError,
    SandboxSpec,
    full_release_tree_hash,
    build_offline_launch,
)
from gauntlet.identity import Artifact, IdentityManifest, materialize_attempt_home


class SandboxConstructionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.release = self.root / "release"
        (self.release / "bin").mkdir(parents=True)
        for name in ("relay", "launch-isolated", "codex", "claude", "cursor-agent", "grok"):
            path = self.release / "bin" / name
            path.write_text("#!/bin/false\n", encoding="utf-8")
            path.chmod(0o500)
        self.attempt = self.root / "attempt-1"
        self.attempt.mkdir(mode=0o700)
        self.work = self.attempt / "work"
        self.work.mkdir(mode=0o700)
        (self.work / ".git").mkdir(mode=0o700)
        self.raw = self.attempt / "raw"
        self.raw.mkdir(mode=0o700)
        self.home = self.attempt / "job-home"  # deliberately fresh/nonexistent
        self.key = b"k" * 32

    def tearDown(self):
        self.tmp.cleanup()

    def materialize_fixture(self, destination):
        vault = self.root / "fixture-vault"
        generation = vault / "codex-builder" / "generation-1" / ".codex"
        generation.mkdir(parents=True, mode=0o700)
        secret = b"x"
        auth = generation / "credential"
        auth.write_bytes(secret); auth.chmod(0o600)
        for path in (vault, vault / "codex-builder", vault / "codex-builder" / "generation-1", generation):
            path.chmod(0o700)
        manifest = IdentityManifest("codex-builder", "builder-domain", "codex", 1,
                                    "a" * 64, "b" * 64, "c" * 64,
                                    (Artifact(".codex/credential", hashlib.sha256(secret).hexdigest(), 4096),))
        return materialize_attempt_home(manifest, vault, destination, self.key)

    def spec(self, **overrides):
        data = dict(
            campaign_id="camp-01",
            task_id="task-01",
            attempt=1,
            controller_epoch=7,
            lease_token=11,
            controller_unit="kizuki-gauntlet.service",
            release_tree=str(self.release),
            release_sha256=full_release_tree_hash(self.release),
            attempt_root=str(self.attempt),
            worktree=str(self.work),
            job_home=str(self.home),
            raw_evidence=str(self.raw),
            identity_principal_id="codex-builder",
            identity_generation=1,
            identity_manifest_sha256="d" * 64,
            adapter="codex",
            wall_seconds=300,
            cpu_quota_percent=100,
            memory_bytes=1024 * 1024 * 1024,
            tasks_max=16,
            output_bytes=1024 * 1024,
        )
        data.update(overrides)
        return SandboxSpec(**data)

    def test_constructs_controller_bound_offline_topology(self):
        receipt = self.materialize_fixture(self.home)
        spec = self.spec(identity_manifest_sha256=receipt.manifest_sha256)
        launch = build_offline_launch(spec, receipt, self.key)
        self.assertTrue(launch.unit_name.startswith("kizuki-gauntlet-attempt-"))
        self.assertIn("--property=BindsTo=kizuki-gauntlet.service", launch.systemd_argv)
        self.assertIn("--property=PrivateNetwork=yes", launch.systemd_argv)
        self.assertIn("--property=KillMode=control-group", launch.systemd_argv)
        self.assertIn("--property=MemoryMax=1073741824", launch.systemd_argv)
        self.assertIn("--property=TasksMax=16", launch.systemd_argv)
        self.assertIn("--property=TimeoutStartSec=30s", launch.systemd_argv)
        self.assertIn("--property=ReadWritePaths=" + str(self.attempt.resolve()), launch.systemd_argv)
        self.assertIn("--unshare-user", launch.harness_bwrap_argv)
        self.assertIn("--unshare-pid", launch.harness_bwrap_argv)
        self.assertNotIn("--unshare-net", launch.harness_bwrap_argv)
        self.assertIn("--ro-bind", launch.harness_bwrap_argv)
        self.assertIn("/work", launch.harness_bwrap_argv)
        self.assertIn("/job-home", launch.harness_bwrap_argv)
        self.assertNotIn("/relay-run", launch.harness_bwrap_argv)
        self.assertIsNone(launch.relay_bwrap_argv)
        self.assertEqual(launch.systemd_argv[:2], ("/usr/bin/systemd-run", "--user"))
        self.assertIn("--property=BindReadOnlyPaths=" + str(self.release.resolve()), launch.systemd_argv)
        self.assertIn("--wait", launch.systemd_argv)
        self.assertIn("--pipe", launch.systemd_argv)
        self.assertIn("--service-type=exec", launch.systemd_argv)
        self.assertNotIn("--property=CapabilityBoundingSet=", launch.systemd_argv)
        self.assertNotIn("--property=RestrictNamespaces=yes", launch.systemd_argv)
        self.assertNotIn("--property=MemoryDenyWriteExecute=yes", launch.systemd_argv)
        self.assertEqual(launch.harness_bwrap_argv[0], "/usr/bin/bwrap")
        separator = launch.systemd_argv.index("--")
        self.assertEqual(launch.systemd_argv[separator + 1:], launch.harness_bwrap_argv)
        self.assertNotIn("<controller-prompt>", "\0".join(launch.harness_bwrap_argv))
        self.assertNotIn(str(Path.home()), " ".join(launch.systemd_argv + launch.harness_bwrap_argv))

    def test_release_identity_covers_all_regular_files_and_modes(self):
        baseline = full_release_tree_hash(self.release)
        (self.release / "bin" / "codex").chmod(0o700)
        (self.release / "bin" / "codex").write_text("changed\n", encoding="utf-8")
        self.assertNotEqual(baseline, full_release_tree_hash(self.release))
        (self.release / "bin" / "codex").write_text("#!/bin/false\n", encoding="utf-8")
        (self.release / "bin" / "codex").chmod(0o400)
        self.assertNotEqual(baseline, full_release_tree_hash(self.release))

    def test_rejects_network_and_unsafe_or_nonfresh_paths(self):
        with self.assertRaises(SandboxError):
            self.spec(network_profile="vendor")
        receipt = self.materialize_fixture(self.attempt / "attested-home")
        spec = self.spec(identity_manifest_sha256=receipt.manifest_sha256)
        with self.assertRaisesRegex(SandboxError, "prepared"):
            build_offline_launch(spec, receipt, self.key)
        self.home.mkdir(mode=0o700)
        with self.assertRaisesRegex(SandboxError, "exactly match"):
            build_offline_launch(spec, receipt, self.key)
        (self.home / "bad").symlink_to(self.release / "bin")
        with self.assertRaisesRegex(SandboxError, "unsafe"):
            build_offline_launch(spec, receipt, self.key)
        (self.home / "bad").unlink()
        (self.home / "credential").write_text("x", encoding="utf-8")
        (self.home / "credential").chmod(0o600)
        with self.assertRaises(SandboxError):
            self.spec(release_sha256="0" * 64)
        with self.assertRaises(SandboxError):
            self.spec(worktree=str(self.root / "outside"))
        with self.assertRaises(SandboxError):
            self.spec(adapter="shell")

    def test_attempt_state_must_be_owned_and_private(self):
        self.attempt.chmod(0o755)
        with self.assertRaisesRegex(SandboxError, "mode 0700"):
            self.spec()
        self.attempt.chmod(0o700)
        self.work.chmod(0o755)
        with self.assertRaisesRegex(SandboxError, "mode 0700"):
            self.spec()

    def test_rejects_release_symlink_and_git_metadata(self):
        (self.release / "link").symlink_to(self.release / "bin" / "worker")
        with self.assertRaises(SandboxError):
            full_release_tree_hash(self.release)
        (self.release / "link").unlink()
        (self.release / ".git").mkdir()
        with self.assertRaises(SandboxError):
            self.spec()

    def test_commands_are_inert_and_fail_closed_on_bad_unit_values(self):
        receipt = self.materialize_fixture(self.home)
        spec = self.spec(identity_manifest_sha256=receipt.manifest_sha256)
        launch = build_offline_launch(spec, receipt, self.key)
        self.assertNotIn("system", launch.systemd_argv[:3])
        self.assertEqual(launch.systemd_argv[:2], ("/usr/bin/systemd-run", "--user"))
        self.assertTrue(all(isinstance(value, str) for value in launch.systemd_argv))
        with self.assertRaises(SandboxError):
            self.spec(controller_unit="kizuki-gauntlet.service;rm")
        with self.assertRaises(SandboxError):
            self.spec(campaign_id="../camp")

    def test_accepts_fresh_private_identity_materialization_without_relaxing_containment(self):
        vault = self.root / "vault"
        generation = vault / "codex-builder" / "generation-1" / ".codex"
        generation.mkdir(parents=True, mode=0o700)
        secret = b'{"test":"credential"}'
        auth = generation / "auth.json"; auth.write_bytes(secret); auth.chmod(0o600)
        for path in (vault, vault / "codex-builder", vault / "codex-builder" / "generation-1", generation):
            path.chmod(0o700)
        manifest = IdentityManifest("codex-builder", "builder-domain", "codex", 1,
                                    "a" * 64, "b" * 64, "c" * 64,
                                    (Artifact(".codex/auth.json", hashlib.sha256(secret).hexdigest(), 4096),))
        materialized = materialize_attempt_home(manifest, vault, self.home, self.key)
        spec = self.spec(identity_manifest_sha256=materialized.manifest_sha256)
        launch = build_offline_launch(spec, materialized, self.key)
        self.assertIn("/job-home", launch.harness_bwrap_argv)
        self.assertEqual((self.home / ".codex" / "auth.json").stat().st_mode & 0o777, 0o600)

    def test_rehashes_exact_attested_home_and_rejects_drift_extra_and_wrong_identity(self):
        vault = self.root / "vault"
        generation = vault / "codex-builder" / "generation-1" / ".codex"
        generation.mkdir(parents=True, mode=0o700)
        secret = b'{"test":"credential"}'
        auth = generation / "auth.json"; auth.write_bytes(secret); auth.chmod(0o600)
        for path in (vault, vault / "codex-builder", vault / "codex-builder" / "generation-1", generation):
            path.chmod(0o700)
        manifest = IdentityManifest("codex-builder", "builder-domain", "codex", 1,
                                    "a" * 64, "b" * 64, "c" * 64,
                                    (Artifact(".codex/auth.json", hashlib.sha256(secret).hexdigest(), 4096),))
        receipt = materialize_attempt_home(manifest, vault, self.home, self.key)
        spec = self.spec(identity_manifest_sha256=receipt.manifest_sha256)
        build_offline_launch(spec, receipt, self.key)
        (self.home / "extra").write_text("no", encoding="utf-8")
        (self.home / "extra").chmod(0o600)
        with self.assertRaisesRegex(SandboxError, "exactly match"):
            build_offline_launch(spec, receipt, self.key)
        (self.home / "extra").unlink()
        auth_copy = self.home / ".codex" / "auth.json"
        auth_copy.write_text("changed", encoding="utf-8")
        with self.assertRaisesRegex(SandboxError, "digest changed"):
            build_offline_launch(spec, receipt, self.key)
        auth_copy.write_bytes(secret); auth_copy.chmod(0o644)
        with self.assertRaisesRegex(SandboxError, "mode 0600"):
            build_offline_launch(spec, receipt, self.key)
        auth_copy.chmod(0o600)
        with self.assertRaisesRegex(SandboxError, "does not match sandbox"):
            build_offline_launch(self.spec(identity_principal_id="other",
                                           identity_manifest_sha256=receipt.manifest_sha256), receipt, self.key)


if __name__ == "__main__":
    unittest.main()
