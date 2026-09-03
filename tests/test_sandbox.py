import hashlib
import os
import tempfile
import unittest
from pathlib import Path

from gauntlet.identity import (
    Artifact,
    IdentityManifest,
    IdentityReceipt,
    materialize_attempt_home,
    validated_authority_binding,
)
from gauntlet.protocol import LeaseGrant
from gauntlet.sandbox import (
    SandboxError,
    SandboxSpec,
    full_release_tree_hash,
    build_offline_launch,
)
from gauntlet.task_spec import command_policy_sha256, sign_task_spec


TASK_SPEC_KEY = b"sandbox-task-spec-signing-key-01"
TASK_SPEC_KEYS = {"task-spec-key-1": TASK_SPEC_KEY}


class SandboxConstructionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.release = self.root / "release"
        (self.release / "bin").mkdir(parents=True)
        # Test fixtures must not inherit the host umask: the production guard
        # correctly rejects a release tree writable by the group or world.
        self.release.chmod(0o755)
        (self.release / "bin").chmod(0o755)
        for name in ("relay", "launch-isolated", "codex", "claude", "cursor-agent", "grok"):
            path = self.release / "bin" / name
            path.write_text("#!/bin/false\n", encoding="utf-8")
            path.chmod(0o500)
        self.executable_sha256 = hashlib.sha256(b"#!/bin/false\n").hexdigest()
        self.attempt = self.root / "attempt-1"
        self.attempt.mkdir(mode=0o700)
        self.work = self.attempt / "work"
        self.work.mkdir(mode=0o700)
        (self.work / ".git").mkdir(mode=0o700)
        self.raw = self.attempt / "raw"
        self.raw.mkdir(mode=0o700)
        self.home = self.attempt / "job-home"  # deliberately fresh/nonexistent
        self.key = b"k" * 32
        self.fixture_number = 0

    def tearDown(self):
        self.tmp.cleanup()

    def identity_fixture(self, *, artifact_path=".codex/credential", secret=b"x"):
        self.fixture_number += 1
        vault = self.root / f"fixture-vault-{self.fixture_number}"
        generation = vault / "codex-builder" / "generation-1" / ".codex"
        generation.mkdir(parents=True, mode=0o700)
        auth = vault / "codex-builder" / "generation-1" / artifact_path
        auth.parent.mkdir(parents=True, exist_ok=True)
        auth.write_bytes(secret); auth.chmod(0o600)
        for path in (vault, vault / "codex-builder", vault / "codex-builder" / "generation-1"):
            path.chmod(0o700)
        current = vault / "codex-builder" / "generation-1"
        for part in Path(artifact_path).parts[:-1]:
            current = current / part
            current.chmod(0o700)
        manifest = IdentityManifest("codex-builder", "builder-domain", "codex", 1,
                                    "a" * 64, self.executable_sha256, "c" * 64,
                                    (Artifact(artifact_path, hashlib.sha256(secret).hexdigest(), 4096),))
        return vault, manifest

    def task_spec(self, **overrides):
        command = (
            "/opt/harness/bin/codex", "exec", "--json", "--ephemeral",
            "--ignore-user-config", "--ignore-rules", "-C", "/work",
            "-s", "workspace-write", "-a", "never", "-",
        )
        fields = {
            "schema": "kizuki-gauntlet-task-spec-v1",
            "issuer_key_id": "task-spec-key-1",
            "campaign_id": "camp-01",
            "task_id": "task-01",
            "attempt": 1,
            "controller_epoch": 7,
            "expected_task_version": 11,
            "lease_token": 11,
            "lease_run_id": "run-01",
            "repository": "Illuminfti/kizuki",
            "base_sha": "a" * 40,
            "expected_branch": "outer/task-01",
            "allowed_paths": ("gauntlet", "tests"),
            "forbidden_paths": (".github/workflows", "systemd"),
            "adapter": "codex",
            "principal_id": "codex-builder",
            "authority_domain": "builder-domain",
            "identity_generation": 1,
            "role": "BUILDER",
            "command_policy": "codex-exec-v1",
            "command_policy_sha256": command_policy_sha256("codex-exec-v1", command),
            "wall_seconds": 300,
            "cpu_seconds": 300,
            "cpu_quota_percent": 100,
            "memory_bytes": 1024 * 1024 * 1024,
            "process_max": 16,
            "output_bytes": 1024 * 1024,
            "network_profile": "offline",
            "network_profile_sha256": "c" * 64,
            "issued_at": 10,
            "expires_at": 500,
            "expected_receipt_schema": "kizuki-gauntlet-phase-result-v2",
            "nonce": "d" * 64,
        }
        fields.update(overrides)
        return sign_task_spec(signing_key=TASK_SPEC_KEY, **fields)

    def admission_fixture(self, *, destination=None, artifact_path=".codex/credential", secret=b"x"):
        task_spec = self.task_spec()
        vault, manifest = self.identity_fixture(artifact_path=artifact_path, secret=secret)
        materialized = materialize_attempt_home(
            manifest,
            vault,
            self.home if destination is None else destination,
            self.key,
            campaign_id=task_spec.campaign_id,
            task_id=task_spec.task_id,
            attempt=task_spec.attempt,
            controller_epoch=task_spec.controller_epoch,
            task_spec_sha256=task_spec.task_spec_sha256,
        )
        identity_receipt = IdentityReceipt(
            "codex-builder", "builder-domain", "codex", 1,
            "a" * 64, self.executable_sha256, "c" * 64,
            10, 500, "READY", "READY",
        )
        authority = validated_authority_binding(
            manifest, identity_receipt, 20, self.key, task_spec.task_spec_sha256,
        )
        lease = LeaseGrant(
            "task-01", 1, "BUILDER", "codex-builder", "run-01",
            "builder-domain", authority.account_binding_sha256,
            authority.receipt_sha256, 11, 7, 500,
            "task:task-01:1:builder",
        )
        spec = self.spec(
            task_spec_sha256=task_spec.task_spec_sha256,
            identity_manifest_sha256=materialized.manifest_sha256,
        )
        return {
            "spec": spec,
            "materialized_identity": materialized,
            "task_spec": task_spec,
            "identity_manifest": manifest,
            "identity_receipt": identity_receipt,
            "authority_binding": authority,
            "lease_grant": lease,
        }

    def build(self, context, *, consumed=None, **overrides):
        values = {
            **context,
            "controller_hmac_key": self.key,
            "task_spec_verification_keys": TASK_SPEC_KEYS,
            "consumed_binding_ids": set() if consumed is None else consumed,
            "current_task_version": 11,
            "current_controller_epoch": 7,
            "now": 20,
        }
        values.update(overrides)
        return build_offline_launch(**values)

    def spec(self, **overrides):
        data = dict(
            campaign_id="camp-01",
            task_id="task-01",
            attempt=1,
            controller_epoch=7,
            expected_task_version=11,
            lease_token=11,
            lease_run_id="run-01",
            controller_unit="kizuki-gauntlet.service",
            release_tree=str(self.release),
            release_sha256=full_release_tree_hash(self.release),
            attempt_root=str(self.attempt),
            worktree=str(self.work),
            job_home=str(self.home),
            raw_evidence=str(self.raw),
            identity_principal_id="codex-builder",
            identity_authority_domain="builder-domain",
            identity_generation=1,
            identity_manifest_sha256="d" * 64,
            adapter="codex",
            role="BUILDER",
            task_spec_sha256="e" * 64,
            wall_seconds=300,
            cpu_seconds=300,
            cpu_quota_percent=100,
            memory_bytes=1024 * 1024 * 1024,
            tasks_max=16,
            output_bytes=1024 * 1024,
            network_profile_sha256="c" * 64,
            expected_receipt_schema="kizuki-gauntlet-phase-result-v2",
        )
        data.update(overrides)
        return SandboxSpec(**data)

    def test_constructs_controller_bound_offline_topology(self):
        context = self.admission_fixture()
        launch = self.build(context)
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

    def test_release_tree_rejects_group_or_world_writable_root(self):
        self.release.chmod(0o775)
        with self.assertRaisesRegex(SandboxError, "group or world writable"):
            full_release_tree_hash(self.release)

    def test_rejects_network_and_unsafe_or_nonfresh_paths(self):
        with self.assertRaises(SandboxError):
            self.spec(network_profile="vendor")
        context = self.admission_fixture(destination=self.attempt / "attested-home")
        with self.assertRaisesRegex(SandboxError, "prepared"):
            self.build(context)
        context = self.admission_fixture()
        (self.home / "extra").write_text("x", encoding="utf-8")
        (self.home / "extra").chmod(0o600)
        with self.assertRaisesRegex(SandboxError, "exactly match"):
            self.build(context)
        (self.home / "extra").unlink()
        (self.home / "bad").symlink_to(self.release / "bin")
        with self.assertRaisesRegex(SandboxError, "unsafe"):
            self.build(context)
        (self.home / "bad").unlink()
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
        context = self.admission_fixture()
        launch = self.build(context)
        self.assertNotIn("system", launch.systemd_argv[:3])
        self.assertEqual(launch.systemd_argv[:2], ("/usr/bin/systemd-run", "--user"))
        self.assertTrue(all(isinstance(value, str) for value in launch.systemd_argv))
        with self.assertRaises(SandboxError):
            self.spec(controller_unit="kizuki-gauntlet.service;rm")
        with self.assertRaises(SandboxError):
            self.spec(campaign_id="../camp")

    def test_accepts_fresh_private_identity_materialization_without_relaxing_containment(self):
        secret = b'{"test":"credential"}'
        context = self.admission_fixture(artifact_path=".codex/auth.json", secret=secret)
        launch = self.build(context)
        self.assertIn("/job-home", launch.harness_bwrap_argv)
        self.assertEqual((self.home / ".codex" / "auth.json").stat().st_mode & 0o777, 0o600)

    def test_rehashes_exact_attested_home_and_rejects_drift_extra_and_wrong_identity(self):
        secret = b'{"test":"credential"}'
        context = self.admission_fixture(artifact_path=".codex/auth.json", secret=secret)
        self.build(context)
        (self.home / "extra").write_text("no", encoding="utf-8")
        (self.home / "extra").chmod(0o600)
        with self.assertRaisesRegex(SandboxError, "exactly match"):
            self.build(context)
        (self.home / "extra").unlink()
        auth_copy = self.home / ".codex" / "auth.json"
        auth_copy.write_text("changed", encoding="utf-8")
        with self.assertRaisesRegex(SandboxError, "digest changed"):
            self.build(context)
        auth_copy.write_bytes(secret); auth_copy.chmod(0o644)
        with self.assertRaisesRegex(SandboxError, "mode 0600"):
            self.build(context)
        auth_copy.chmod(0o600)
        with self.assertRaisesRegex(SandboxError, "does not match"):
            self.build(context, spec=self.spec(
                identity_principal_id="other",
                identity_manifest_sha256=context["materialized_identity"].manifest_sha256,
                task_spec_sha256=context["task_spec"].task_spec_sha256,
            ))


if __name__ == "__main__":
    unittest.main()
