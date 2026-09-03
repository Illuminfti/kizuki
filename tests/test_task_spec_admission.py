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
from gauntlet.launch_intent import LAUNCH_INTENT_SCHEMA, sign_launch_intent
from gauntlet.protocol import LeaseGrant
from gauntlet.sandbox import (
    SandboxError,
    SandboxSpec,
    build_offline_launch,
    full_release_tree_hash,
)

from gauntlet.task_spec import (
    TASK_SPEC_SCHEMA,
    TaskSpecError,
    command_policy_sha256,
    sign_task_spec,
    verification_policy_sha256,
    verify_task_spec,
)


SPEC_KEY = b"task-spec-signing-key-material-01"
SPEC_KEYS = {"task-spec-key-1": SPEC_KEY}
VERIFICATION_COMMANDS = {
    "compile": ("python3", "-m", "compileall", "-q", "gauntlet", "tests"),
    "unit": ("python3", "-m", "unittest", "discover", "-s", "tests", "-v"),
}


def spec_fields(**overrides):
    command = (
        "/opt/harness/bin/codex", "exec", "--json", "--ephemeral",
        "--ignore-user-config", "--ignore-rules", "-C", "/work",
        "-s", "workspace-write", "-a", "never", "-",
    )
    values = {
        "schema": TASK_SPEC_SCHEMA,
        "issuer_key_id": "task-spec-key-1",
        "campaign_id": "campaign-01",
        "task_id": "task-01",
        "attempt": 2,
        "controller_epoch": 7,
        "expected_task_version": 11,
        "repository": "Illuminfti/kizuki",
        "base_sha": "a" * 40,
        "expected_branch": "outer/task-01",
        "issue_spec_url": "https://github.com/Illuminfti/kizuki/issues/4",
        "allowed_paths": ("gauntlet", "tests"),
        "forbidden_paths": (".github/workflows", "systemd"),
        "adapter": "codex",
        "principal_id": "codex-builder",
        "authority_domain": "codex-builder-domain",
        "identity_generation": 1,
        "role": "BUILDER",
        "command_policy": "codex-exec-v1",
        "command_policy_sha256": command_policy_sha256("codex-exec-v1", command),
        "verification_policy": "python-project-v1",
        "verification_policy_sha256": verification_policy_sha256(
            "python-project-v1", VERIFICATION_COMMANDS,
        ),
        "required_verification_commands": ("compile", "unit"),
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
        self.launch_intent = self.issue_launch_intent()
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

    def admit(self, **overrides):
        values = {
            "spec": self.sandbox_spec,
            "materialized_identity": self.materialized,
            "controller_hmac_key": self.controller_key,
            "task_spec": self.task_spec,
            "task_spec_verification_keys": SPEC_KEYS,
            "identity_manifest": self.manifest,
            "identity_receipt": self.identity_receipt,
            "authority_binding": self.authority,
            "launch_intent": self.launch_intent,
            "verification_commands": VERIFICATION_COMMANDS,
            "now": 20,
        }
        values.update(overrides)
        return build_offline_launch(**values)

    def issue_launch_intent(self, *, authority=None, **overrides):
        authority = self.authority if authority is None else authority
        explicit = set(overrides)
        values = {
            "schema": LAUNCH_INTENT_SCHEMA,
            "task_spec_sha256": self.task_spec.task_spec_sha256,
            "campaign_id": "campaign-01",
            "task_id": "task-01",
            "attempt": 2,
            "role": "BUILDER",
            "principal_id": "codex-builder",
            "authority_domain": "codex-builder-domain",
            "expected_task_version": 11,
            "controller_epoch": 7,
            "lease_resource": "task:task-01:2:builder",
            "lease_run_id": "run-01",
            "lease_token": 19,
            "lease_expires_at": 500,
            "subject_sha": "a" * 40,
            "identity_manifest_sha256": authority.manifest_sha256,
            "identity_receipt_sha256": authority.receipt_sha256,
            "authority_binding_id": authority.binding_id,
            "issued_at": 20,
            "expires_at": 320,
        }
        values.update(overrides)
        if "lease_resource" not in explicit:
            values["lease_resource"] = (
                f"task:{values['task_id']}:{values['attempt']}:"
                f"{values['role'].lower().replace('_', '-')}"
            )
        from gauntlet.launch_intent import launch_operation_id
        values["launch_operation_id"] = launch_operation_id(
            task_spec_sha256=values["task_spec_sha256"],
            lease_resource=values["lease_resource"],
            lease_run_id=values["lease_run_id"],
            lease_token=values["lease_token"],
            controller_epoch=values["controller_epoch"],
        )
        return sign_launch_intent(signing_key=self.controller_key, **values)

    def test_launch_requires_exact_authenticated_current_admission(self):
        launch = self.admit()
        self.assertEqual(launch.task_spec_sha256, self.task_spec.task_spec_sha256)
        self.assertEqual(launch.authority_binding_id, self.authority.binding_id)
        self.assertEqual(launch.lease_run_id, self.lease.run_id)

        denials = (
            {"task_spec": replace(self.task_spec, task_id="task-02")},
            {"launch_intent": self.issue_launch_intent(task_id="task-02")},
            {"launch_intent": self.issue_launch_intent(attempt=3)},
            {"launch_intent": self.issue_launch_intent(principal_id="other-builder")},
            {"launch_intent": self.issue_launch_intent(role="VERIFIER")},
            {"launch_intent": self.issue_launch_intent(lease_token=20)},
            {"materialized_identity": replace(self.materialized, task_id="task-02")},
            {"materialized_identity": replace(self.materialized, attempt=3)},
            {"launch_intent": self.issue_launch_intent(expected_task_version=12)},
            {"launch_intent": self.issue_launch_intent(controller_epoch=8)},
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

    def test_post_preflight_worktree_symlink_swap_is_denied(self):
        original = self.attempt_root / "original-work"
        outside = self.root / "outside-work"
        outside.mkdir(mode=0o700)
        (outside / ".git").mkdir(mode=0o700)
        self.work.rename(original)
        self.work.symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(SandboxError, "worktree"):
            self.admit()

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
        expired_intent = self.issue_launch_intent(authority=expired_authority)
        with self.assertRaisesRegex(SandboxError, "authority"):
            self.admit(
                identity_receipt=expired_receipt,
                authority_binding=expired_authority,
                launch_intent=expired_intent,
                now=26,
            )

    def test_retry_of_one_durable_intent_is_the_same_inert_operation(self):
        first = self.admit()
        second = self.admit()
        self.assertEqual(first.launch_operation_id, second.launch_operation_id)
        self.assertEqual(first.unit_name, second.unit_name)

    def test_fresh_binding_cannot_select_a_new_operation_for_the_same_lease(self):
        fresh_authority = validated_authority_binding(
            self.manifest,
            self.identity_receipt,
            21,
            self.controller_key,
            self.task_spec.task_spec_sha256,
        )
        fresh_intent = self.issue_launch_intent(authority=fresh_authority, issued_at=21)
        original = self.admit()
        replacement = self.admit(
            authority_binding=fresh_authority,
            launch_intent=fresh_intent,
            now=21,
        )
        self.assertEqual(original.launch_operation_id, replacement.launch_operation_id)
        self.assertEqual(original.unit_name, replacement.unit_name)

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
        mismatched_intent = self.issue_launch_intent(authority=mismatched_authority)
        with self.assertRaisesRegex(SandboxError, "executable"):
            self.admit(
                spec=mismatched_sandbox,
                materialized_identity=mismatched_materialized,
                identity_manifest=mismatched_manifest,
                identity_receipt=mismatched_receipt,
                authority_binding=mismatched_authority,
                launch_intent=mismatched_intent,
            )


if __name__ == "__main__":
    unittest.main()
