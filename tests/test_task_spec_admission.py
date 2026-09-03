import hashlib
import tempfile
import unittest
from dataclasses import replace
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
    build_offline_launch,
    full_release_tree_hash,
)

from gauntlet.task_spec import (
    TaskSpecError,
    command_policy_sha256,
    sign_task_spec,
    verify_task_spec,
)


SPEC_KEY = b"task-spec-signing-key-material-01"
SPEC_KEYS = {"task-spec-key-1": SPEC_KEY}


def spec_fields(**overrides):
    command = (
        "/opt/harness/bin/codex", "exec", "--json", "--ephemeral",
        "--ignore-user-config", "--ignore-rules", "-C", "/work",
        "-s", "workspace-write", "-a", "never", "-",
    )
    values = {
        "schema": "kizuki-gauntlet-task-spec-v1",
        "issuer_key_id": "task-spec-key-1",
        "campaign_id": "campaign-01",
        "task_id": "task-01",
        "attempt": 2,
        "controller_epoch": 7,
        "expected_task_version": 11,
        "lease_token": 19,
        "lease_run_id": "run-01",
        "repository": "Illuminfti/kizuki",
        "base_sha": "a" * 40,
        "expected_branch": "outer/task-01",
        "allowed_paths": ("gauntlet", "tests"),
        "forbidden_paths": (".github/workflows", "systemd"),
        "adapter": "codex",
        "principal_id": "codex-builder",
        "authority_domain": "codex-builder-domain",
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
    values.update(overrides)
    return values


class TaskSpecSigningTests(unittest.TestCase):
    def test_signed_spec_verifies_and_field_tampering_fails(self):
        signed = sign_task_spec(signing_key=SPEC_KEY, **spec_fields())
        self.assertIs(verify_task_spec(signed, SPEC_KEYS, now=20), signed)
        with self.assertRaises(TaskSpecError):
            verify_task_spec(replace(signed, task_id="task-02"), SPEC_KEYS, now=20)

    def test_path_policy_is_canonical_and_unambiguous(self):
        with self.assertRaises(TaskSpecError):
            sign_task_spec(
                signing_key=SPEC_KEY,
                **spec_fields(allowed_paths=("gauntlet//core", "tests")),
            )
        with self.assertRaises(TaskSpecError):
            sign_task_spec(
                signing_key=SPEC_KEY,
                **spec_fields(
                    allowed_paths=("gauntlet", "tests"),
                    forbidden_paths=("gauntlet", "systemd"),
                ),
            )


class LaunchAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.release = self.root / "release"
        (self.release / "bin").mkdir(parents=True)
        self.release.chmod(0o755)
        (self.release / "bin").chmod(0o755)
        for name in ("relay", "launch-isolated", "codex", "claude", "cursor-agent", "grok"):
            executable = self.release / "bin" / name
            executable.write_text("#!/bin/false\n", encoding="utf-8")
            executable.chmod(0o500)
        self.release_executable_sha256 = hashlib.sha256(b"#!/bin/false\n").hexdigest()
        self.attempt_root = self.root / "attempt-2"
        self.attempt_root.mkdir(mode=0o700)
        self.work = self.attempt_root / "work"
        self.work.mkdir(mode=0o700)
        (self.work / ".git").mkdir(mode=0o700)
        self.raw = self.attempt_root / "raw"
        self.raw.mkdir(mode=0o700)
        self.home = self.attempt_root / "job-home"
        self.controller_key = b"controller-identity-key-material-01"

        self.vault = self.root / "vault"
        generation = self.vault / "codex-builder" / "generation-1" / ".codex"
        generation.mkdir(parents=True, mode=0o700)
        credential = b"fixture-credential"
        credential_path = generation / "credential"
        credential_path.write_bytes(credential)
        credential_path.chmod(0o600)
        for path in (
            self.vault,
            self.vault / "codex-builder",
            self.vault / "codex-builder" / "generation-1",
            generation,
        ):
            path.chmod(0o700)
        self.manifest = IdentityManifest(
            "codex-builder", "codex-builder-domain", "codex", 1,
            "a" * 64, self.release_executable_sha256, "c" * 64,
            (Artifact(".codex/credential", hashlib.sha256(credential).hexdigest(), 4096),),
        )
        self.identity_receipt = IdentityReceipt(
            "codex-builder", "codex-builder-domain", "codex", 1,
            "a" * 64, self.release_executable_sha256, "c" * 64,
            10, 500, "READY", "READY",
        )
        self.task_spec = sign_task_spec(signing_key=SPEC_KEY, **spec_fields())
        self.materialized = materialize_attempt_home(
            self.manifest,
            self.vault,
            self.home,
            self.controller_key,
            campaign_id=self.task_spec.campaign_id,
            task_id=self.task_spec.task_id,
            attempt=self.task_spec.attempt,
            controller_epoch=self.task_spec.controller_epoch,
            task_spec_sha256=self.task_spec.task_spec_sha256,
        )
        self.authority = validated_authority_binding(
            self.manifest,
            self.identity_receipt,
            20,
            self.controller_key,
            self.task_spec.task_spec_sha256,
        )
        self.lease = LeaseGrant(
            task_id="task-01",
            attempt=2,
            role="BUILDER",
            principal_id="codex-builder",
            run_id="run-01",
            authority_domain="codex-builder-domain",
            account_binding_sha256=self.authority.account_binding_sha256,
            identity_receipt_sha256=self.authority.receipt_sha256,
            token=19,
            epoch=7,
            expires_at=500,
            resource="task:task-01:2:builder",
        )
        self.sandbox_spec = SandboxSpec(
            campaign_id="campaign-01",
            task_id="task-01",
            attempt=2,
            controller_epoch=7,
            expected_task_version=11,
            lease_token=19,
            lease_run_id="run-01",
            controller_unit="kizuki-gauntlet.service",
            release_tree=str(self.release),
            release_sha256=full_release_tree_hash(self.release),
            attempt_root=str(self.attempt_root),
            worktree=str(self.work),
            job_home=str(self.home),
            raw_evidence=str(self.raw),
            identity_principal_id="codex-builder",
            identity_authority_domain="codex-builder-domain",
            identity_generation=1,
            identity_manifest_sha256=self.materialized.manifest_sha256,
            adapter="codex",
            role="BUILDER",
            task_spec_sha256=self.task_spec.task_spec_sha256,
            wall_seconds=300,
            cpu_seconds=300,
            cpu_quota_percent=100,
            memory_bytes=1024 * 1024 * 1024,
            tasks_max=16,
            output_bytes=1024 * 1024,
            network_profile="offline",
            network_profile_sha256="c" * 64,
            expected_receipt_schema="kizuki-gauntlet-phase-result-v2",
        )

    def tearDown(self):
        self.tmp.cleanup()

    def admit(self, *, consumed=None, **overrides):
        values = {
            "spec": self.sandbox_spec,
            "materialized_identity": self.materialized,
            "controller_hmac_key": self.controller_key,
            "task_spec": self.task_spec,
            "task_spec_verification_keys": SPEC_KEYS,
            "lease_grant": self.lease,
            "identity_manifest": self.manifest,
            "identity_receipt": self.identity_receipt,
            "authority_binding": self.authority,
            "consumed_binding_ids": set() if consumed is None else consumed,
            "current_task_version": 11,
            "current_controller_epoch": 7,
            "now": 20,
        }
        values.update(overrides)
        return build_offline_launch(**values)

    def test_launch_requires_exact_authenticated_current_admission(self):
        launch = self.admit()
        self.assertEqual(launch.task_spec_sha256, self.task_spec.task_spec_sha256)
        self.assertEqual(launch.authority_binding_id, self.authority.binding_id)
        self.assertEqual(launch.lease_run_id, self.lease.run_id)

        denials = (
            {"task_spec": replace(self.task_spec, task_id="task-02")},
            {"lease_grant": replace(self.lease, task_id="task-02")},
            {"lease_grant": replace(self.lease, attempt=3)},
            {"lease_grant": replace(self.lease, token=19.0)},
            {"lease_grant": replace(self.lease, principal_id="other-builder")},
            {"lease_grant": replace(self.lease, role="VERIFIER")},
            {"lease_grant": replace(self.lease, token=20)},
            {"materialized_identity": replace(self.materialized, task_id="task-02")},
            {"materialized_identity": replace(self.materialized, attempt=3)},
            {"current_task_version": 12},
            {"current_controller_epoch": 8},
            {"now": 500},
        )
        for override in denials:
            with self.subTest(override=override):
                with self.assertRaises(SandboxError):
                    self.admit(**override)

    def test_materialized_home_is_not_replayable_across_destination(self):
        other_home = self.attempt_root / "other-job-home"
        other = materialize_attempt_home(
            self.manifest,
            self.vault,
            other_home,
            self.controller_key,
            campaign_id=self.task_spec.campaign_id,
            task_id=self.task_spec.task_id,
            attempt=self.task_spec.attempt,
            controller_epoch=self.task_spec.controller_epoch,
            task_spec_sha256=self.task_spec.task_spec_sha256,
        )
        with self.assertRaisesRegex(SandboxError, "destination"):
            self.admit(materialized_identity=other)

    def test_authenticated_materialization_is_bound_to_task_attempt_and_spec(self):
        other_spec = sign_task_spec(
            signing_key=SPEC_KEY,
            **spec_fields(nonce="e" * 64),
        )
        contexts = (
            ("cross-task-home", "task-02", 2, self.task_spec.task_spec_sha256),
            ("cross-attempt-home", "task-01", 3, self.task_spec.task_spec_sha256),
            ("cross-spec-home", "task-01", 2, other_spec.task_spec_sha256),
        )
        for destination, task_id, attempt, task_spec_sha256 in contexts:
            with self.subTest(destination=destination):
                materialized = materialize_attempt_home(
                    self.manifest,
                    self.vault,
                    self.attempt_root / destination,
                    self.controller_key,
                    campaign_id=self.task_spec.campaign_id,
                    task_id=task_id,
                    attempt=attempt,
                    controller_epoch=self.task_spec.controller_epoch,
                    task_spec_sha256=task_spec_sha256,
                )
                with self.assertRaisesRegex(SandboxError, "task attempt"):
                    self.admit(materialized_identity=materialized)

    def test_expired_identity_authority_is_denied_independently(self):
        expired_receipt = replace(self.identity_receipt, expires_at=25)
        expired_authority = validated_authority_binding(
            self.manifest,
            expired_receipt,
            20,
            self.controller_key,
            self.task_spec.task_spec_sha256,
        )
        matching_lease = replace(
            self.lease,
            identity_receipt_sha256=expired_authority.receipt_sha256,
        )
        with self.assertRaisesRegex(SandboxError, "authority"):
            self.admit(
                identity_receipt=expired_receipt,
                authority_binding=expired_authority,
                lease_grant=matching_lease,
                now=26,
            )

    def test_authority_binding_is_consumed_once(self):
        consumed = set()
        self.admit(consumed=consumed)
        self.assertEqual(consumed, {self.authority.binding_id})
        with self.assertRaisesRegex(SandboxError, "authority"):
            self.admit(consumed=consumed)

    def test_failed_preflight_does_not_consume_authority(self):
        consumed = set()
        with self.assertRaisesRegex(SandboxError, "lease"):
            self.admit(
                consumed=consumed,
                lease_grant=replace(self.lease, run_id="stale-run"),
            )
        self.assertEqual(consumed, set())

    def test_attested_executable_must_be_the_release_executable(self):
        mismatched_manifest = replace(self.manifest, executable_sha256="f" * 64)
        mismatched_receipt = replace(self.identity_receipt, executable_sha256="f" * 64)
        other_root = self.root / "mismatched-attempt"
        other_root.mkdir(mode=0o700)
        other_work = other_root / "work"
        other_work.mkdir(mode=0o700)
        (other_work / ".git").mkdir(mode=0o700)
        other_raw = other_root / "raw"
        other_raw.mkdir(mode=0o700)
        other_home = other_root / "job-home"
        mismatched_materialized = materialize_attempt_home(
            mismatched_manifest,
            self.vault,
            other_home,
            self.controller_key,
            campaign_id=self.task_spec.campaign_id,
            task_id=self.task_spec.task_id,
            attempt=self.task_spec.attempt,
            controller_epoch=self.task_spec.controller_epoch,
            task_spec_sha256=self.task_spec.task_spec_sha256,
        )
        mismatched_sandbox = replace(
            self.sandbox_spec,
            attempt_root=str(other_root),
            worktree=str(other_work),
            raw_evidence=str(other_raw),
            job_home=str(other_home),
            identity_manifest_sha256=mismatched_materialized.manifest_sha256,
        )
        mismatched_authority = validated_authority_binding(
            mismatched_manifest,
            mismatched_receipt,
            20,
            self.controller_key,
            self.task_spec.task_spec_sha256,
        )
        matching_lease = replace(
            self.lease,
            account_binding_sha256=mismatched_authority.account_binding_sha256,
            identity_receipt_sha256=mismatched_authority.receipt_sha256,
        )
        with self.assertRaisesRegex(SandboxError, "executable"):
            self.admit(
                spec=mismatched_sandbox,
                materialized_identity=mismatched_materialized,
                identity_manifest=mismatched_manifest,
                identity_receipt=mismatched_receipt,
                authority_binding=mismatched_authority,
                lease_grant=matching_lease,
            )


if __name__ == "__main__":
    unittest.main()
