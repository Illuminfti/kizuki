import unittest
from dataclasses import replace

from gauntlet.launch_intent import (
    LAUNCH_INTENT_SCHEMA,
    LaunchIntentError,
    launch_operation_id,
    sign_launch_intent,
    verify_launch_intent,
)


KEY = b"controller-launch-intent-key-material"


def intent_fields(**overrides):
    values = {
        "schema": LAUNCH_INTENT_SCHEMA,
        "task_spec_sha256": "a" * 64,
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
        "subject_sha": "b" * 40,
        "identity_manifest_sha256": "c" * 64,
        "identity_receipt_sha256": "d" * 64,
        "authority_binding_id": "e" * 64,
        "issued_at": 20,
        "expires_at": 320,
    }
    values.update(overrides)
    values["launch_operation_id"] = launch_operation_id(
        task_spec_sha256=values["task_spec_sha256"],
        lease_resource=values["lease_resource"],
        lease_run_id=values["lease_run_id"],
        lease_token=values["lease_token"],
        controller_epoch=values["controller_epoch"],
    )
    return values


class LaunchIntentTests(unittest.TestCase):
    def test_authenticated_intent_binds_full_launch_and_fence_context(self):
        intent = sign_launch_intent(signing_key=KEY, **intent_fields())
        self.assertIs(verify_launch_intent(intent, KEY, now=21), intent)
        fields = (
            ("task_spec_sha256", "f" * 64),
            ("task_id", "task-02"),
            ("attempt", 3),
            ("role", "VERIFIER"),
            ("principal_id", "other"),
            ("lease_run_id", "other-run"),
            ("lease_token", 20),
            ("lease_expires_at", 499),
            ("controller_epoch", 8),
            ("expected_task_version", 12),
            ("subject_sha", "f" * 40),
            ("identity_manifest_sha256", "f" * 64),
            ("authority_binding_id", "f" * 64),
        )
        for name, value in fields:
            with self.subTest(name=name):
                with self.assertRaises(LaunchIntentError):
                    verify_launch_intent(replace(intent, **{name: value}), KEY, now=21)

    def test_operation_id_is_stable_and_changes_for_every_live_lease_fence(self):
        baseline = intent_fields()["launch_operation_id"]
        self.assertEqual(intent_fields()["launch_operation_id"], baseline)
        changes = (
            {"task_spec_sha256": "f" * 64},
            {"lease_resource": "task:task-01:2:verifier"},
            {"lease_run_id": "run-02"},
            {"lease_token": 20},
            {"controller_epoch": 8},
        )
        for change in changes:
            with self.subTest(change=change):
                self.assertNotEqual(intent_fields(**change)["launch_operation_id"], baseline)

    def test_operation_id_cannot_be_caller_selected(self):
        with self.assertRaises(LaunchIntentError):
            sign_launch_intent(
                signing_key=KEY,
                **{**intent_fields(), "launch_operation_id": "f" * 64},
            )

    def test_intent_is_short_lived_and_expires(self):
        intent = sign_launch_intent(signing_key=KEY, **intent_fields())
        with self.assertRaises(LaunchIntentError):
            verify_launch_intent(intent, KEY, now=320)
        with self.assertRaises(LaunchIntentError):
            sign_launch_intent(
                signing_key=KEY,
                **intent_fields(expires_at=621),
            )

    def test_signer_requires_exact_fields(self):
        fields = intent_fields()
        fields["unexpected"] = "x"
        with self.assertRaises(LaunchIntentError):
            sign_launch_intent(signing_key=KEY, **fields)


if __name__ == "__main__":
    unittest.main()
