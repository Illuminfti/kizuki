import hashlib
import os
import stat
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from gauntlet.identity import (
    Artifact,
    IdentityError,
    IdentityManifest,
    IdentityReceipt,
    authenticate_authority_binding,
    validated_authority_binding,
    materialize_attempt_home,
    receipt_is_current,
    verify_authority_binding,
    verify_materialized_identity,
)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class IdentityIsolationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.vault = self.root / "vault"
        self.generation = self.vault / "codex-builder" / "generation-1"
        (self.generation / ".codex").mkdir(parents=True, mode=0o700)
        self.secret = b'{"credential":"test-only"}\n'
        auth = self.generation / ".codex" / "auth.json"
        auth.write_bytes(self.secret)
        auth.chmod(0o600)
        for path in (self.vault, self.vault / "codex-builder", self.generation, self.generation / ".codex"):
            path.chmod(0o700)
        self.attempts = self.root / "attempts"
        self.attempts.mkdir(mode=0o700)
        self.key = b"k" * 32

    def tearDown(self):
        self.tmp.cleanup()

    def manifest(self, **overrides):
        values = dict(
            principal_id="codex-builder",
            authority_domain="codex-builder-domain",
            adapter="codex",
            generation=1,
            account_binding_sha256="a" * 64,
            executable_sha256="b" * 64,
            network_profile_sha256="c" * 64,
            artifacts=(Artifact(".codex/auth.json", digest(self.secret), 4096),),
        )
        values.update(overrides)
        return IdentityManifest(**values)

    @staticmethod
    def attempt_context(**overrides):
        values = dict(
            campaign_id="campaign-1",
            task_id="task-1",
            task_attempt=1,
            phase_attempt_id="d" * 64,
            controller_epoch=3,
            task_spec_sha256="e" * 64,
            expires_at=200,
        )
        values.update(overrides)
        return values

    def materialize(self, destination, **context_overrides):
        return materialize_attempt_home(
            self.manifest(), self.vault, destination, self.key,
            clock=lambda: 100,
            **self.attempt_context(**context_overrides),
        )

    def test_materializes_only_reviewed_files_into_fresh_private_home(self):
        destination = self.attempts / "job-home"
        result = self.materialize(destination)
        copied = destination / ".codex" / "auth.json"
        self.assertEqual(copied.read_bytes(), self.secret)
        self.assertEqual(result.files, (".codex/auth.json",))
        self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(copied.stat().st_mode), 0o600)
        self.assertFalse(any(path.name == "history.jsonl" for path in destination.rglob("*")))

    def test_materialization_attestation_is_attempt_bound_current_and_not_replayable(self):
        first = self.materialize(self.attempts / "job-home-one")
        verify_materialized_identity(
            first, self.key, now=150,
            **self.attempt_context(),
        )

        stale_contexts = (
            {"task_attempt": 2},
            {"phase_attempt_id": "f" * 64},
            {"controller_epoch": 4},
            {"task_spec_sha256": "0" * 64},
            {"expires_at": 201},
        )
        for changed in stale_contexts:
            with self.subTest(changed=changed), self.assertRaises(IdentityError):
                verify_materialized_identity(
                    first, self.key, now=150,
                    **self.attempt_context(**changed),
                )
        with self.assertRaisesRegex(IdentityError, "current|expired"):
            verify_materialized_identity(
                first, self.key, now=200,
                **self.attempt_context(),
            )

        second = self.materialize(
            self.attempts / "job-home-two",
            task_attempt=2,
            phase_attempt_id="f" * 64,
            task_spec_sha256="0" * 64,
        )
        self.assertNotEqual(first.attestation_sha256, second.attestation_sha256)
        self.assertNotEqual(first.destination_sha256, second.destination_sha256)

    def test_refuses_existing_destination_symlink_or_unreviewed_artifact(self):
        destination = self.attempts / "job-home"
        destination.mkdir(mode=0o700)
        with self.assertRaises(IdentityError):
            self.materialize(destination)
        destination.rmdir()
        destination.symlink_to(self.generation, target_is_directory=True)
        with self.assertRaises(IdentityError):
            self.materialize(destination)
        destination.unlink()
        with self.assertRaises(IdentityError):
            self.manifest(artifacts=(Artifact("../auth.json", "a" * 64, 10),))

    def test_refuses_source_symlink_mutable_mode_or_digest_drift(self):
        auth = self.generation / ".codex" / "auth.json"
        auth.unlink()
        auth.symlink_to(self.generation / "elsewhere")
        with self.assertRaises(IdentityError):
            self.materialize(self.attempts / "one")
        auth.unlink(); auth.write_bytes(self.secret); auth.chmod(0o666)
        with self.assertRaises(IdentityError):
            self.materialize(self.attempts / "two")
        auth.chmod(0o600); auth.write_bytes(b"changed")
        with self.assertRaises(IdentityError):
            self.materialize(self.attempts / "three")

    def test_receipt_binds_generation_account_binary_network_and_expiry(self):
        manifest = self.manifest()
        receipt = IdentityReceipt(
            principal_id=manifest.principal_id,
            authority_domain=manifest.authority_domain,
            adapter=manifest.adapter,
            generation=manifest.generation,
            account_binding_sha256=manifest.account_binding_sha256,
            executable_sha256=manifest.executable_sha256,
            network_profile_sha256=manifest.network_profile_sha256,
            checked_at=10,
            expires_at=20,
            auth_status="READY",
            route_status="READY",
        )
        self.assertTrue(receipt_is_current(manifest, receipt, now=15))
        key = b"k" * 32
        operation = "e" * 64
        binding = validated_authority_binding(manifest, receipt, now=15,
                                              controller_hmac_key=key,
                                              operation_sha256=operation)
        self.assertEqual((binding.principal_id, binding.authority_domain, binding.generation),
                         (manifest.principal_id, manifest.authority_domain, manifest.generation))
        self.assertFalse(receipt_is_current(manifest, receipt, now=20))
        changed = self.manifest(generation=2)
        self.assertFalse(receipt_is_current(changed, receipt, now=15))
        with self.assertRaises(IdentityError):
            validated_authority_binding(changed, receipt, now=15,
                                        controller_hmac_key=key,
                                        operation_sha256=operation)

    def test_authority_binding_is_authenticated_short_lived_and_one_use(self):
        manifest = self.manifest()
        receipt = IdentityReceipt(manifest.principal_id, manifest.authority_domain,
                                  manifest.adapter, manifest.generation,
                                  manifest.account_binding_sha256,
                                  manifest.executable_sha256,
                                  manifest.network_profile_sha256,
                                  10, 900, "READY", "READY")
        key, operation = b"k" * 32, "e" * 64
        binding = validated_authority_binding(manifest, receipt, 15, key, operation)
        self.assertLessEqual(binding.expires_at - binding.checked_at, 600)
        used = set()
        verify_authority_binding(binding, manifest, receipt, 16, key, operation, used)
        self.assertEqual(used, {binding.binding_id})
        with self.assertRaises(IdentityError):
            verify_authority_binding(binding, manifest, receipt, 16, key, operation, used)
        with self.assertRaises(IdentityError):
            verify_authority_binding(binding, manifest, receipt, 16, b"z" * 32, operation, set())
        with self.assertRaises(IdentityError):
            verify_authority_binding(binding, manifest, receipt, binding.expires_at, key, operation, set())
        with self.assertRaises(IdentityError):
            verify_authority_binding(binding, manifest, receipt, 16, key, "f" * 64, set())
        tampered = replace(binding, principal_id="other-principal")
        with self.assertRaises(IdentityError):
            verify_authority_binding(tampered, manifest, receipt, 16, key, operation, set())
        with self.assertRaises(IdentityError):
            validated_authority_binding(manifest, receipt, 15, b"too-short", operation)

    def test_authority_binding_authentication_is_pure_and_repeatable(self):
        manifest = self.manifest()
        receipt = IdentityReceipt(manifest.principal_id, manifest.authority_domain,
                                  manifest.adapter, manifest.generation,
                                  manifest.account_binding_sha256,
                                  manifest.executable_sha256,
                                  manifest.network_profile_sha256,
                                  10, 900, "READY", "READY")
        key, operation = b"k" * 32, "e" * 64
        binding = validated_authority_binding(manifest, receipt, 15, key, operation)

        self.assertIs(
            authenticate_authority_binding(binding, manifest, receipt, 16, key, operation),
            binding,
        )
        self.assertIs(
            authenticate_authority_binding(binding, manifest, receipt, 16, key, operation),
            binding,
        )

    def test_pure_authority_authentication_rejects_context_and_identity_drift(self):
        manifest = self.manifest()
        receipt = IdentityReceipt(manifest.principal_id, manifest.authority_domain,
                                  manifest.adapter, manifest.generation,
                                  manifest.account_binding_sha256,
                                  manifest.executable_sha256,
                                  manifest.network_profile_sha256,
                                  10, 900, "READY", "READY")
        key, operation = b"k" * 32, "e" * 64
        binding = validated_authority_binding(manifest, receipt, 15, key, operation)

        cases = (
            (replace(binding, signature_sha256="0" * 64), manifest, receipt, 16, operation),
            (binding, manifest, receipt, binding.expires_at, operation),
            (binding, manifest, receipt, 16, "f" * 64),
            (binding, replace(manifest, network_profile_sha256="d" * 64), receipt, 16, operation),
            (binding, manifest, replace(receipt, executable_sha256="d" * 64), 16, operation),
        )
        for candidate, candidate_manifest, candidate_receipt, now, candidate_operation in cases:
            with self.subTest(now=now, operation=candidate_operation), self.assertRaises(IdentityError):
                authenticate_authority_binding(
                    candidate, candidate_manifest, candidate_receipt, now, key,
                    candidate_operation,
                )

    def test_refuses_destination_nested_in_generation_or_containing_generation(self):
        with self.assertRaises(IdentityError):
            materialize_attempt_home(self.manifest(), self.vault,
                                     self.generation / "attempt" / "job-home", self.key,
                                     **self.attempt_context())
        # A generation constructed below an existing attempt parent is equally
        # unsafe: the destination contains the source generation.
        nested_vault = self.attempts / "vault"
        nested_generation = nested_vault / "codex-builder" / "generation-1" / ".codex"
        nested_generation.mkdir(parents=True, mode=0o700)
        auth = nested_generation / "auth.json"
        auth.write_bytes(self.secret); auth.chmod(0o600)
        for path in (nested_vault, nested_vault / "codex-builder",
                     nested_vault / "codex-builder" / "generation-1", nested_generation):
            path.chmod(0o700)
        with self.assertRaises(IdentityError):
            materialize_attempt_home(
                self.manifest(), nested_vault, self.attempts, self.key,
                **self.attempt_context(),
            )

    def test_manifest_rejects_duplicate_paths_and_unknown_adapter(self):
        artifact = Artifact(".x/auth", "d" * 64, 10)
        with self.assertRaises(IdentityError):
            self.manifest(artifacts=(artifact, artifact))
        with self.assertRaises(IdentityError):
            self.manifest(adapter="other")


if __name__ == "__main__":
    unittest.main()
