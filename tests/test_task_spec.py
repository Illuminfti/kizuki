import dataclasses
import hashlib
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from gauntlet.task_spec import (
    ResourceBudgets,
    TaskSpec,
    TaskSpecError,
    canonical_envelope_bytes,
    materialize_task_spec,
    read_task_spec,
    sign_task_spec,
    verify_task_spec,
)


KEY = b"task-spec-test-controller-key-32b"
INSTRUCTION = b"Apply the bounded task and return only the required receipt."
INSTRUCTION_SHA256 = hashlib.sha256(INSTRUCTION).hexdigest()


class TaskSpecTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        self.now = int(time.time())
        self.attempts_root = self.root / "attempts"
        self.attempts_root.mkdir(mode=0o700)
        self.attempt_dir = self.attempts_root / ("9" * 64)
        self.attempt_dir.mkdir(mode=0o700)
        self.task_spec_path = self.attempt_dir / "task-spec.json"

    def tearDown(self):
        self.temp.cleanup()

    def spec(self, **overrides):
        values = dict(
            campaign_id="campaign-1",
            task_id="task-1",
            task_attempt=2,
            phase_attempt_id="9" * 64,
            controller_epoch=7,
            repository="owner/repository",
            base_sha="a" * 40,
            subject_sha="b" * 40,
            expected_branch="main",
            issue_url="https://github.com/owner/repository/issues/4",
            instruction_sha256=INSTRUCTION_SHA256,
            instruction_bytes=len(INSTRUCTION),
            allowed_prefixes=("gauntlet", "tests"),
            forbidden_prefixes=(".github/workflows", "secrets"),
            adapter="codex",
            principal_id="codex-builder",
            role="builder",
            verification_policy="python-unittest-v2",
            budgets=ResourceBudgets(
                wall_seconds=600,
                cpu_seconds=300,
                memory_bytes=1024 * 1024 * 1024,
                process_limit=32,
                output_bytes=2 * 1024 * 1024,
            ),
            network_profile="offline",
            issued_at=self.now,
            expires_at=self.now + 300,
            receipt_schema="gauntlet-phase-receipt-v2",
        )
        values.update(overrides)
        return TaskSpec(**values)

    def materialize(self, envelope, attempts_root=None, **overrides):
        expected = dict(
            expected_task_spec_sha256=envelope.task_spec_sha256,
            expected_phase_attempt_id=envelope.spec.phase_attempt_id,
            expected_subject_sha=envelope.spec.subject_sha,
            expected_instruction_sha256=envelope.spec.instruction_sha256,
            expected_instruction_bytes=envelope.spec.instruction_bytes,
            clock=lambda: self.now,
        )
        expected.update(overrides)
        return materialize_task_spec(
            envelope, attempts_root or self.attempts_root, KEY, **expected,
        )

    def test_binds_exact_private_instruction_digest_length_and_context(self):
        envelope = sign_task_spec(self.spec(), "controller-key-1", KEY)
        encoded = canonical_envelope_bytes(envelope)
        body = json.loads(encoded)["spec"]

        self.assertEqual(body["instruction_sha256"], INSTRUCTION_SHA256)
        self.assertEqual(body["instruction_bytes"], len(INSTRUCTION))
        self.assertFalse(hasattr(envelope.spec, "instruction"))
        self.assertFalse(hasattr(envelope.spec, "instruction_path"))
        self.assertNotIn(INSTRUCTION, encoded)
        self.assertNotIn(b"instruction_path", encoded)
        self.assertEqual(
            verify_task_spec(
                envelope, KEY, now=self.now,
                expected_instruction_sha256=INSTRUCTION_SHA256,
                expected_instruction_bytes=len(INSTRUCTION),
            ),
            envelope,
        )

        with self.assertRaisesRegex(TaskSpecError, "instruction"):
            verify_task_spec(
                envelope, KEY, now=self.now,
                expected_instruction_sha256="0" * 64,
                expected_instruction_bytes=len(INSTRUCTION),
            )
        with self.assertRaisesRegex(TaskSpecError, "instruction"):
            verify_task_spec(
                envelope, KEY, now=self.now,
                expected_instruction_sha256=INSTRUCTION_SHA256,
                expected_instruction_bytes=len(INSTRUCTION) + 1,
            )
        with self.assertRaisesRegex(TaskSpecError, "instruction"):
            verify_task_spec(
                envelope, KEY, now=self.now,
                expected_instruction_sha256=INSTRUCTION_SHA256,
            )

        for changed in (
            dataclasses.replace(envelope.spec, instruction_sha256="0" * 64),
            dataclasses.replace(envelope.spec, instruction_bytes=len(INSTRUCTION) + 1),
        ):
            with self.subTest(changed=changed), self.assertRaises(TaskSpecError):
                verify_task_spec(dataclasses.replace(envelope, spec=changed), KEY, now=self.now)

        for invalid in (False, 0, 1024 * 1024 + 1):
            with self.subTest(instruction_bytes=invalid), self.assertRaises(TaskSpecError):
                self.spec(instruction_bytes=invalid)
        with self.assertRaises(TaskSpecError):
            self.spec(instruction_sha256="not-a-digest")

    def test_signs_canonical_immutable_bounded_envelope(self):
        envelope = sign_task_spec(self.spec(), "controller-key-1", KEY)

        self.assertEqual(verify_task_spec(envelope, KEY, now=self.now), envelope)
        self.assertEqual(
            verify_task_spec(
                envelope, KEY, now=self.now,
                expected_phase_attempt_id="9" * 64,
                expected_subject_sha="b" * 40,
            ),
            envelope,
        )
        self.assertEqual(len(envelope.task_spec_sha256), 64)
        self.assertEqual(len(envelope.signature_sha256), 64)
        self.assertEqual(
            canonical_envelope_bytes(envelope),
            canonical_envelope_bytes(sign_task_spec(self.spec(), "controller-key-1", KEY)),
        )
        with self.assertRaises(dataclasses.FrozenInstanceError):
            envelope.spec.task_id = "changed"

        serialized = json.loads(canonical_envelope_bytes(envelope))
        flattened = json.dumps(serialized, sort_keys=True)
        for forbidden in ("secret", "lease_token", "argv", "pid", "patch", "worktree"):
            self.assertNotIn(f'"{forbidden}"', flattened.lower())

    def test_oversized_ensure_ascii_envelope_is_rejected_before_materialization(self):
        # Each path is within the UTF-8 field bound, but JSON's ensure_ascii
        # expansion makes the complete authenticated envelope exceed 64 KiB.
        suffix = "\N{GRINNING FACE}" * 58
        oversized = self.spec(
            allowed_prefixes=tuple(f"a{index:02d}-{suffix}" for index in range(64)),
            forbidden_prefixes=tuple(f"b{index:02d}-{suffix}" for index in range(64)),
        )
        prototype = sign_task_spec(self.spec(), "controller-key-1", KEY)
        forged = dataclasses.replace(prototype, spec=oversized)
        destination = self.task_spec_path

        with self.assertRaisesRegex(TaskSpecError, "size|bound|64"):
            sign_task_spec(oversized, "controller-key-1", KEY)
        with self.assertRaisesRegex(TaskSpecError, "size|bound|64"):
            canonical_envelope_bytes(forged)
        with self.assertRaisesRegex(TaskSpecError, "size|bound|64"):
            verify_task_spec(forged, KEY, now=self.now)
        with self.assertRaisesRegex(TaskSpecError, "size|bound|64"):
            self.materialize(forged)
        self.assertFalse(destination.exists())

    def test_rejects_tamper_wrong_key_expiry_and_identity_or_context_drift(self):
        envelope = sign_task_spec(self.spec(), "controller-key-1", KEY)
        cases = (
            dataclasses.replace(envelope, signature_sha256="0" * 64),
            dataclasses.replace(envelope, spec=dataclasses.replace(envelope.spec, role="verifier")),
            dataclasses.replace(envelope, spec=dataclasses.replace(envelope.spec, base_sha="b" * 40)),
            dataclasses.replace(envelope, spec=dataclasses.replace(envelope.spec, principal_id="other")),
        )
        for changed in cases:
            with self.subTest(changed=changed):
                with self.assertRaises(TaskSpecError):
                    verify_task_spec(changed, KEY, now=self.now)
        with self.assertRaises(TaskSpecError):
            verify_task_spec(envelope, b"x" * 32, now=self.now)
        with self.assertRaisesRegex(TaskSpecError, "expired"):
            verify_task_spec(envelope, KEY, now=envelope.spec.expires_at)

    def test_rejects_cross_attempt_subject_replay_and_far_future_lifetime(self):
        envelope = sign_task_spec(self.spec(), "controller-key-1", KEY)
        with self.assertRaisesRegex(TaskSpecError, "digest"):
            verify_task_spec(
                envelope, KEY, now=self.now,
                expected_task_spec_sha256="0" * 64,
            )
        with self.assertRaisesRegex(TaskSpecError, "attempt"):
            verify_task_spec(
                envelope, KEY, now=self.now,
                expected_phase_attempt_id="8" * 64,
                expected_subject_sha=envelope.spec.subject_sha,
            )
        with self.assertRaisesRegex(TaskSpecError, "subject"):
            verify_task_spec(
                envelope, KEY, now=self.now,
                expected_phase_attempt_id=envelope.spec.phase_attempt_id,
                expected_subject_sha="c" * 40,
            )
        with self.assertRaises(TaskSpecError):
            self.spec(expires_at=self.now + 10_000)
        future = sign_task_spec(
            self.spec(issued_at=self.now + 120, expires_at=self.now + 300),
            "controller-key-1", KEY,
        )
        with self.assertRaisesRegex(TaskSpecError, "future"):
            verify_task_spec(future, KEY, now=self.now)

    def test_fields_reject_unbounded_or_command_path_ref_and_secret_channels(self):
        bad = (
            dict(expected_branch="--upload-pack=evil"),
            dict(issue_url="https://token@example.invalid/private?secret=x"),
            dict(repository="../escape"),
            dict(allowed_prefixes=("../escape",)),
            dict(verification_policy="pytest; curl attacker"),
            dict(network_profile="arbitrary-host"),
            dict(adapter="shell"),
            dict(role="root"),
            dict(expires_at=True),
        )
        for override in bad:
            with self.subTest(override=override):
                with self.assertRaises(TaskSpecError):
                    self.spec(**override)
        with self.assertRaises(TaskSpecError):
            ResourceBudgets(3601, 1, 1024 * 1024 * 1024, 1, 1)
        with self.assertRaises(TaskSpecError):
            ResourceBudgets(10, 11, 1024 * 1024 * 1024, 1, 1)

    def test_materialization_is_exclusive_private_durable_and_verified_on_read(self):
        envelope = sign_task_spec(self.spec(), "controller-key-1", KEY)
        destination = self.task_spec_path

        digest = self.materialize(envelope)

        self.assertEqual(digest, envelope.task_spec_sha256)
        self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.attempts_root / "task-spec.json").exists())
        self.assertEqual(
            {path.name for path in self.attempt_dir.iterdir()},
            {"task-spec.json"},
        )
        self.assertEqual(
            read_task_spec(
                self.attempts_root, KEY, now=self.now,
                expected_task_spec_sha256=envelope.task_spec_sha256,
                expected_phase_attempt_id=envelope.spec.phase_attempt_id,
                expected_subject_sha=envelope.spec.subject_sha,
                expected_instruction_sha256=envelope.spec.instruction_sha256,
                expected_instruction_bytes=envelope.spec.instruction_bytes,
            ),
            envelope,
        )
        with self.assertRaisesRegex(TaskSpecError, "exists"):
            self.materialize(envelope)

    def test_materialization_requires_full_durable_context_before_creation(self):
        envelope = sign_task_spec(self.spec(), "controller-key-1", KEY)
        required = dict(
            expected_task_spec_sha256=envelope.task_spec_sha256,
            expected_phase_attempt_id=envelope.spec.phase_attempt_id,
            expected_subject_sha=envelope.spec.subject_sha,
            expected_instruction_sha256=envelope.spec.instruction_sha256,
            expected_instruction_bytes=envelope.spec.instruction_bytes,
        )
        mismatches = (
            dict(expected_task_spec_sha256="0" * 64),
            dict(expected_subject_sha="c" * 40),
            dict(expected_instruction_sha256="0" * 64),
            dict(expected_instruction_bytes=envelope.spec.instruction_bytes + 1),
        )

        for mismatch in mismatches:
            expected = dict(required)
            expected.update(mismatch)
            with self.subTest(mismatch=mismatch), self.assertRaises(TaskSpecError):
                materialize_task_spec(
                    envelope, self.attempts_root, KEY,
                    clock=lambda: self.now,
                    **expected,
                )
            self.assertFalse(self.task_spec_path.exists())

    def test_materialization_samples_final_clock_after_durable_write(self):
        import gauntlet.task_spec as module

        envelope = sign_task_spec(self.spec(), "controller-key-1", KEY)
        original_fsync = os.fsync
        clock_calls = 0
        fsync_calls = 0

        def recording_fsync(fd):
            nonlocal fsync_calls
            result = original_fsync(fd)
            fsync_calls += 1
            return result

        def expiring_clock():
            nonlocal clock_calls
            clock_calls += 1
            if clock_calls == 1:
                return self.now
            self.assertGreaterEqual(fsync_calls, 2)
            self.assertTrue(self.task_spec_path.is_file())
            return envelope.spec.expires_at

        with mock.patch.object(module.os, "fsync", side_effect=recording_fsync):
            with self.assertRaisesRegex(TaskSpecError, "expired"):
                materialize_task_spec(
                    envelope, self.attempts_root, KEY,
                    expected_task_spec_sha256=envelope.task_spec_sha256,
                    expected_phase_attempt_id=envelope.spec.phase_attempt_id,
                    expected_subject_sha=envelope.spec.subject_sha,
                    expected_instruction_sha256=envelope.spec.instruction_sha256,
                    expected_instruction_bytes=envelope.spec.instruction_bytes,
                    clock=expiring_clock,
                )

        self.assertGreaterEqual(clock_calls, 2)
        self.assertTrue(self.task_spec_path.is_file())
        self.assertEqual(self.task_spec_path.stat().st_mode & 0o777, 0o600)
        with self.assertRaisesRegex(TaskSpecError, "exists"):
            materialize_task_spec(
                envelope, self.attempts_root, KEY,
                expected_task_spec_sha256=envelope.task_spec_sha256,
                expected_phase_attempt_id=envelope.spec.phase_attempt_id,
                expected_subject_sha=envelope.spec.subject_sha,
                expected_instruction_sha256=envelope.spec.instruction_sha256,
                expected_instruction_bytes=envelope.spec.instruction_bytes,
                clock=lambda: self.now,
            )

    def test_storage_derives_the_signed_attempt_and_never_uses_a_sibling(self):
        envelope = sign_task_spec(self.spec(), "controller-key-1", KEY)
        other_root = self.root / "other-attempts"
        other_root.mkdir(mode=0o700)
        sibling = other_root / ("8" * 64)
        sibling.mkdir(mode=0o700)

        with self.assertRaisesRegex(TaskSpecError, "attempt directory|unavailable"):
            self.materialize(envelope, other_root)

        self.assertEqual(list(sibling.iterdir()), [])
        self.assertFalse((other_root / "task-spec.json").exists())

    def test_read_rejects_tamper_noncanonical_unknown_keys_modes_and_symlinks(self):
        envelope = sign_task_spec(self.spec(), "controller-key-1", KEY)
        destination = self.task_spec_path
        self.materialize(envelope)

        parsed = json.loads(destination.read_bytes())
        parsed["unexpected"] = True
        destination.write_text(json.dumps(parsed), encoding="utf-8")
        destination.chmod(0o600)
        with self.assertRaises(TaskSpecError):
            read_task_spec(
                self.attempts_root, KEY, now=self.now,
                expected_task_spec_sha256=envelope.task_spec_sha256,
                expected_phase_attempt_id=envelope.spec.phase_attempt_id,
                expected_subject_sha=envelope.spec.subject_sha,
                expected_instruction_sha256=envelope.spec.instruction_sha256,
                expected_instruction_bytes=envelope.spec.instruction_bytes,
            )

        destination.write_bytes(canonical_envelope_bytes(envelope) + b"\n")
        destination.chmod(0o644)
        with self.assertRaisesRegex(TaskSpecError, "0600"):
            read_task_spec(
                self.attempts_root, KEY, now=self.now,
                expected_task_spec_sha256=envelope.task_spec_sha256,
                expected_phase_attempt_id=envelope.spec.phase_attempt_id,
                expected_subject_sha=envelope.spec.subject_sha,
                expected_instruction_sha256=envelope.spec.instruction_sha256,
                expected_instruction_bytes=envelope.spec.instruction_bytes,
            )

        destination.unlink()
        target = self.root / "target"
        target.write_bytes(canonical_envelope_bytes(envelope) + b"\n")
        target.chmod(0o600)
        destination.symlink_to(target)
        with self.assertRaises(TaskSpecError):
            read_task_spec(
                self.attempts_root, KEY, now=self.now,
                expected_task_spec_sha256=envelope.task_spec_sha256,
                expected_phase_attempt_id=envelope.spec.phase_attempt_id,
                expected_subject_sha=envelope.spec.subject_sha,
                expected_instruction_sha256=envelope.spec.instruction_sha256,
                expected_instruction_bytes=envelope.spec.instruction_bytes,
            )

    def test_read_requires_exact_digest_attempt_subject_and_single_link(self):
        envelope = sign_task_spec(self.spec(), "controller-key-1", KEY)
        destination = self.task_spec_path
        self.materialize(envelope)
        instruction_context = dict(
            expected_instruction_sha256=envelope.spec.instruction_sha256,
            expected_instruction_bytes=envelope.spec.instruction_bytes,
        )
        cases = (
            dict(expected_task_spec_sha256="0" * 64,
                 expected_phase_attempt_id=envelope.spec.phase_attempt_id,
                 expected_subject_sha=envelope.spec.subject_sha,
                 **instruction_context),
            dict(expected_task_spec_sha256=envelope.task_spec_sha256,
                 expected_phase_attempt_id="8" * 64,
                 expected_subject_sha=envelope.spec.subject_sha,
                 **instruction_context),
            dict(expected_task_spec_sha256=envelope.task_spec_sha256,
                 expected_phase_attempt_id=envelope.spec.phase_attempt_id,
                 expected_subject_sha="c" * 40,
                 **instruction_context),
            dict(expected_task_spec_sha256=envelope.task_spec_sha256,
                 expected_phase_attempt_id=envelope.spec.phase_attempt_id,
                 expected_subject_sha=envelope.spec.subject_sha,
                 expected_instruction_sha256="0" * 64,
                 expected_instruction_bytes=envelope.spec.instruction_bytes),
            dict(expected_task_spec_sha256=envelope.task_spec_sha256,
                 expected_phase_attempt_id=envelope.spec.phase_attempt_id,
                 expected_subject_sha=envelope.spec.subject_sha,
                 expected_instruction_sha256=envelope.spec.instruction_sha256,
                 expected_instruction_bytes=envelope.spec.instruction_bytes + 1),
        )
        for expected in cases:
            with self.subTest(expected=expected), self.assertRaises(TaskSpecError):
                read_task_spec(
                    self.attempts_root, KEY, now=self.now,
                    **expected,
                )
        os.link(destination, self.root / "task-spec-hardlink.json")
        with self.assertRaisesRegex(TaskSpecError, "link|regular"):
            read_task_spec(
                self.attempts_root, KEY, now=self.now,
                expected_task_spec_sha256=envelope.task_spec_sha256,
                expected_phase_attempt_id=envelope.spec.phase_attempt_id,
                expected_subject_sha=envelope.spec.subject_sha,
                expected_instruction_sha256=envelope.spec.instruction_sha256,
                expected_instruction_bytes=envelope.spec.instruction_bytes,
            )

    def test_read_rejects_final_name_inode_swap(self):
        import gauntlet.task_spec as module

        envelope = sign_task_spec(self.spec(), "controller-key-1", KEY)
        destination = self.task_spec_path
        self.materialize(envelope)
        encoded = canonical_envelope_bytes(envelope) + b"\n"
        moved = self.root / "moved.json"
        original_read = os.read
        swapped = False

        def swapping_read(fd, count):
            nonlocal swapped
            result = original_read(fd, count)
            if result and not swapped:
                swapped = True
                destination.rename(moved)
                destination.write_bytes(encoded)
                destination.chmod(0o600)
            return result

        with mock.patch.object(module.os, "read", side_effect=swapping_read):
            with self.assertRaisesRegex(TaskSpecError, "changed|inode"):
                read_task_spec(
                    self.attempts_root, KEY, now=self.now,
                    expected_task_spec_sha256=envelope.task_spec_sha256,
                    expected_phase_attempt_id=envelope.spec.phase_attempt_id,
                    expected_subject_sha=envelope.spec.subject_sha,
                    expected_instruction_sha256=envelope.spec.instruction_sha256,
                    expected_instruction_bytes=envelope.spec.instruction_bytes,
                )

    def test_materialization_rejects_attempt_directory_mapping_swap(self):
        import gauntlet.task_spec as module

        envelope = sign_task_spec(self.spec(), "controller-key-1", KEY)
        moved = self.root / "owned-attempt-residue"
        original_fsync = os.fsync
        swapped = False

        def swap_after_file_sync(fd):
            nonlocal swapped
            result = original_fsync(fd)
            if not swapped and os.fstat(fd).st_mode & 0o170000 == 0o100000:
                swapped = True
                self.attempt_dir.rename(moved)
                self.attempt_dir.mkdir(mode=0o700)
                victim = self.attempt_dir / "task-spec.json"
                victim.write_text("victim", encoding="utf-8")
                victim.chmod(0o600)
            return result

        with mock.patch.object(module.os, "fsync", side_effect=swap_after_file_sync):
            with self.assertRaisesRegex(TaskSpecError, "attempt directory|mapping"):
                materialize_task_spec(
                    envelope, self.attempts_root, KEY,
                    expected_task_spec_sha256=envelope.task_spec_sha256,
                    expected_phase_attempt_id=envelope.spec.phase_attempt_id,
                    expected_subject_sha=envelope.spec.subject_sha,
                    expected_instruction_sha256=envelope.spec.instruction_sha256,
                    expected_instruction_bytes=envelope.spec.instruction_bytes,
                    clock=lambda: self.now,
                )

        self.assertTrue(swapped)
        self.assertEqual(self.task_spec_path.read_text(encoding="utf-8"), "victim")
        self.assertTrue((moved / "task-spec.json").is_file())

    def test_read_rejects_attempt_directory_mapping_swap(self):
        import gauntlet.task_spec as module

        envelope = sign_task_spec(self.spec(), "controller-key-1", KEY)
        self.materialize(envelope)
        moved = self.root / "read-attempt-residue"
        original_read = os.read
        swapped = False

        def swap_after_first_read(fd, count):
            nonlocal swapped
            result = original_read(fd, count)
            if result and not swapped:
                swapped = True
                self.attempt_dir.rename(moved)
                self.attempt_dir.mkdir(mode=0o700)
                victim = self.attempt_dir / "task-spec.json"
                victim.write_text("victim", encoding="utf-8")
                victim.chmod(0o600)
            return result

        with mock.patch.object(module.os, "read", side_effect=swap_after_first_read):
            with self.assertRaisesRegex(TaskSpecError, "attempt directory|mapping"):
                read_task_spec(
                    self.attempts_root, KEY, now=self.now,
                    expected_task_spec_sha256=envelope.task_spec_sha256,
                    expected_phase_attempt_id=envelope.spec.phase_attempt_id,
                    expected_subject_sha=envelope.spec.subject_sha,
                    expected_instruction_sha256=envelope.spec.instruction_sha256,
                    expected_instruction_bytes=envelope.spec.instruction_bytes,
                )

        self.assertTrue(swapped)
        self.assertEqual(self.task_spec_path.read_text(encoding="utf-8"), "victim")
        self.assertTrue((moved / "task-spec.json").is_file())

    def test_materialization_rejects_nonprivate_parent_and_symlink_destination(self):
        envelope = sign_task_spec(self.spec(), "controller-key-1", KEY)
        self.attempts_root.chmod(0o755)
        with self.assertRaisesRegex(TaskSpecError, "0700"):
            self.materialize(envelope)
        self.attempts_root.chmod(0o700)
        target = self.root / "elsewhere"
        target.write_text("leave me", encoding="utf-8")
        self.task_spec_path.symlink_to(target)
        with self.assertRaises(TaskSpecError):
            self.materialize(envelope)
        self.assertEqual(target.read_text(encoding="utf-8"), "leave me")

    def test_materialization_failure_retains_owned_residue_and_consumes_path(self):
        import gauntlet.task_spec as module

        envelope = sign_task_spec(self.spec(), "controller-key-1", KEY)
        destination = self.task_spec_path

        with mock.patch.object(module.os, "fsync", side_effect=OSError("injected sync failure")):
            with self.assertRaises(OSError):
                self.materialize(envelope)

        self.assertTrue(destination.is_file())
        self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
        with self.assertRaisesRegex(TaskSpecError, "exists"):
            self.materialize(envelope)

    def test_materialization_failure_never_deletes_swapped_task_spec_victim(self):
        import gauntlet.task_spec as module

        envelope = sign_task_spec(self.spec(), "controller-key-1", KEY)
        destination = self.task_spec_path
        residue = self.attempt_dir / "task-spec-owned-residue.json"
        swapped = False

        def swap_name_then_fail(_fd):
            nonlocal swapped
            if not swapped:
                swapped = True
                destination.rename(residue)
                destination.write_text("victim", encoding="utf-8")
                destination.chmod(0o600)
            raise OSError("injected sync failure after name swap")

        with mock.patch.object(module.os, "fsync", side_effect=swap_name_then_fail):
            with self.assertRaises(OSError):
                self.materialize(envelope)

        self.assertEqual(destination.read_text(encoding="utf-8"), "victim")
        self.assertTrue(residue.is_file())
        self.assertGreater(residue.stat().st_size, len("victim"))


if __name__ == "__main__":
    unittest.main()
