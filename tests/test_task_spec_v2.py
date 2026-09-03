import os
import tempfile
import unittest
from dataclasses import asdict, replace
from pathlib import Path

from gauntlet.task_spec import (
    SUPPORTED_RECEIPT_SCHEMAS,
    TASK_SPEC_SCHEMA,
    TaskSpecError,
    canonical_task_spec_bytes,
    command_policy_sha256,
    path_policy_allows,
    read_task_spec,
    sign_task_spec,
    verification_policy_sha256,
    verify_task_spec,
    write_task_spec,
)


SPEC_KEY = b"task-spec-v2-signing-key-material"
SPEC_KEYS = {"task-spec-key-1": SPEC_KEY}


def spec_fields(**overrides):
    adapter_argv = (
        "/opt/harness/bin/codex", "exec", "--json", "--ephemeral",
        "--ignore-user-config", "--ignore-rules", "-C", "/work",
        "-s", "workspace-write", "-a", "never", "-",
    )
    verification_commands = {
        "compile": ("python3", "-m", "compileall", "-q", "gauntlet", "tests"),
        "unit": ("python3", "-m", "unittest", "discover", "-s", "tests", "-v"),
    }
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
        "issue_spec_url": (
            "https://github.com/Illuminfti/kizuki/issues/4"
            "#issuecomment-5518330965"
        ),
        "allowed_paths": ("gauntlet", "tests"),
        "forbidden_paths": (".github/workflows", "gauntlet/private", "systemd"),
        "adapter": "codex",
        "principal_id": "codex-builder",
        "authority_domain": "codex-builder-domain",
        "identity_generation": 1,
        "role": "BUILDER",
        "command_policy": "codex-exec-v1",
        "command_policy_sha256": command_policy_sha256("codex-exec-v1", adapter_argv),
        "verification_policy": "python-project-v1",
        "verification_policy_sha256": verification_policy_sha256(
            "python-project-v1", verification_commands,
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


class TaskSpecV2ContractTests(unittest.TestCase):
    def test_v2_spec_has_no_lease_secret_and_authenticates_protocol_fields(self):
        signed = sign_task_spec(signing_key=SPEC_KEY, **spec_fields())
        self.assertIs(verify_task_spec(signed, SPEC_KEYS, now=20), signed)
        self.assertNotIn("lease_token", asdict(signed))
        self.assertNotIn("lease_run_id", asdict(signed))
        for name, value in (
            ("issue_spec_url", "https://github.com/Illuminfti/kizuki/issues/5"),
            ("verification_policy", "other-v1"),
            ("required_verification_commands", ("unit",)),
            ("expected_receipt_schema", "kizuki-gauntlet-phase-result-v3"),
        ):
            with self.subTest(name=name):
                with self.assertRaises(TaskSpecError):
                    verify_task_spec(replace(signed, **{name: value}), SPEC_KEYS, now=20)

    def test_issue_url_branch_and_receipt_schema_are_strict(self):
        invalid = (
            {"expected_branch": "outer/.hidden"},
            {"expected_branch": "outer/name.lock/topic"},
            {"expected_branch": "HEAD"},
            {"issue_spec_url": "http://github.com/Illuminfti/kizuki/issues/4"},
            {"issue_spec_url": "https://github.com/other/kizuki/issues/4"},
            {"issue_spec_url": "https://github.com/Illuminfti/kizuki/issues/4?token=x"},
            {"issue_spec_url": "https://user@github.com/Illuminfti/kizuki/issues/4"},
            {"expected_receipt_schema": "made-up-v1"},
        )
        for override in invalid:
            with self.subTest(override=override):
                with self.assertRaises(TaskSpecError):
                    sign_task_spec(signing_key=SPEC_KEY, **spec_fields(**override))
        self.assertEqual(
            SUPPORTED_RECEIPT_SCHEMAS,
            frozenset({"kizuki-gauntlet-phase-result-v2"}),
        )

    def test_path_policy_uses_component_boundaries_and_forbidden_wins(self):
        signed = sign_task_spec(signing_key=SPEC_KEY, **spec_fields())
        self.assertTrue(path_policy_allows("gauntlet/sandbox.py", signed))
        self.assertTrue(path_policy_allows("tests/test_sandbox.py", signed))
        self.assertFalse(path_policy_allows("gauntlet/private/key", signed))
        self.assertFalse(path_policy_allows("gauntlet2/lookalike.py", signed))
        self.assertFalse(path_policy_allows("systemd/unit.service", signed))
        for unsafe in (".", "../gauntlet/x", "/gauntlet/x", "gauntlet//x", "gauntlet\\x"):
            with self.subTest(unsafe=unsafe):
                with self.assertRaises(TaskSpecError):
                    path_policy_allows(unsafe, signed)

    def test_verification_policy_digest_is_canonical_and_bounded(self):
        commands_a = {
            "unit": ("python3", "-m", "unittest"),
            "compile": ("python3", "-m", "compileall", "gauntlet"),
        }
        commands_b = {
            "compile": ["python3", "-m", "compileall", "gauntlet"],
            "unit": ["python3", "-m", "unittest"],
        }
        self.assertEqual(
            verification_policy_sha256("python-project-v1", commands_a),
            verification_policy_sha256("python-project-v1", commands_b),
        )
        with self.assertRaises(TaskSpecError):
            verification_policy_sha256("python-project-v1", {"unit": ("sh", "-c", "x\x00y")})


class TaskSpecFileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.root.chmod(0o700)
        self.path = self.root / "task-spec.json"
        self.spec = sign_task_spec(signing_key=SPEC_KEY, **spec_fields())

    def tearDown(self):
        self.tmp.cleanup()

    def test_write_once_mode_0600_and_exact_byte_authenticated_reload(self):
        write_task_spec(self.path, self.spec, SPEC_KEYS, now=20)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.path.read_bytes(), canonical_task_spec_bytes(self.spec))
        self.assertEqual(
            read_task_spec(
                self.path,
                SPEC_KEYS,
                now=20,
                expected_task_spec_sha256=self.spec.task_spec_sha256,
            ),
            self.spec,
        )
        with self.assertRaises(TaskSpecError):
            write_task_spec(self.path, self.spec, SPEC_KEYS, now=20)

    def test_parser_rejects_noncanonical_duplicate_or_mutable_files(self):
        write_task_spec(self.path, self.spec, SPEC_KEYS, now=20)
        canonical = self.path.read_bytes()
        self.path.write_bytes(canonical + b"\n")
        self.path.chmod(0o600)
        with self.assertRaises(TaskSpecError):
            read_task_spec(self.path, SPEC_KEYS, now=20)

        self.path.unlink()
        self.path.write_bytes(b'{"schema":"one","schema":"two"}\n')
        self.path.chmod(0o600)
        with self.assertRaisesRegex(TaskSpecError, "duplicate"):
            read_task_spec(self.path, SPEC_KEYS, now=20)

        self.path.unlink()
        self.path.write_bytes(canonical)
        self.path.chmod(0o640)
        with self.assertRaisesRegex(TaskSpecError, "0600"):
            read_task_spec(self.path, SPEC_KEYS, now=20)

    def test_reader_and_writer_reject_symlink_destinations(self):
        target = self.root / "target"
        target.write_bytes(b"do-not-touch")
        target.chmod(0o600)
        self.path.symlink_to(target)
        with self.assertRaises(TaskSpecError):
            write_task_spec(self.path, self.spec, SPEC_KEYS, now=20)
        with self.assertRaises(TaskSpecError):
            read_task_spec(self.path, SPEC_KEYS, now=20)
        self.assertEqual(target.read_bytes(), b"do-not-touch")

    def test_reader_rejects_a_hardlinked_spec_file(self):
        write_task_spec(self.path, self.spec, SPEC_KEYS, now=20)
        alias = self.root / "task-spec-alias.json"
        os.link(self.path, alias)
        with self.assertRaisesRegex(TaskSpecError, "hardlink"):
            read_task_spec(self.path, SPEC_KEYS, now=20)

    def test_reload_requires_the_expected_signed_digest(self):
        write_task_spec(self.path, self.spec, SPEC_KEYS, now=20)
        with self.assertRaisesRegex(TaskSpecError, "expected digest"):
            read_task_spec(
                self.path,
                SPEC_KEYS,
                now=20,
                expected_task_spec_sha256="e" * 64,
            )

    def test_writer_refuses_to_occupy_path_with_unauthenticated_bytes(self):
        tampered = replace(self.spec, task_id="task-02")
        with self.assertRaises(TaskSpecError):
            write_task_spec(self.path, tampered, SPEC_KEYS, now=20)
        self.assertFalse(self.path.exists())


if __name__ == "__main__":
    unittest.main()
