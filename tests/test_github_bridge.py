import copy
import hashlib
import unittest

from gauntlet.github_bridge import (
    BridgeError,
    MergeOperation,
    PREPARED,
    SENT,
    branch_policy_attestation,
    canonical_json,
    collect_branch_policy_proof,
    collect_evidence,
    evidence_digest,
    gate_admission,
    mark_publication_sent,
    mark_publication_uncertain,
    mint_merge_grant,
    prepare_publication,
    reconcile_publication,
    required_check_policy_digest,
)


HEAD = "a" * 40
BASE = "b" * 40
POLICY_KEY = b"policy-verification-key-material-01"
GRANT_KEY = b"merge-grant-signing-key-material-01"
POLICY_KEYS = {"key-1": POLICY_KEY}
GRANT_KEYS = {"grant-key-1": GRANT_KEY}
REQUIRED = ("test", "secrets", "workflows")


def digest(value):
    return hashlib.sha256(canonical_json(value).encode("ascii")).hexdigest()


def pr_fixture(*, observed_at=10):
    return {
        "repository": "Illuminfti/kizuki",
        "number": 385,
        "author": "builder",
        "head_sha": HEAD,
        "base_ref": "main",
        "base_sha": BASE,
        "state": "OPEN",
        "merged": False,
        "draft": False,
        "mergeable": "MERGEABLE",
        "observed_at": observed_at,
        "checks": [
            {"name": "test", "head_sha": HEAD, "conclusion": "SUCCESS", "url": "https://ci.invalid/test"},
            {"name": "secrets", "head_sha": HEAD, "conclusion": "SUCCESS", "url": "https://ci.invalid/secrets"},
            {"name": "workflows", "head_sha": HEAD, "conclusion": "SUCCESS", "url": "https://ci.invalid/workflows"},
        ],
        "reviews": [
            {"lens": "spec", "principal": "reviewer-spec", "head_sha": HEAD, "reference": "r1"},
            {"lens": "regression", "principal": "reviewer-regression", "head_sha": HEAD, "reference": "r2"},
            {"lens": "independent", "principal": "reviewer-independent", "head_sha": HEAD, "reference": "r3"},
        ],
    }


def policy_fixture(*, observed_at=9, expires_at=200, key=POLICY_KEY):
    unsigned = {
        "repository": "Illuminfti/kizuki",
        "main_sha": BASE,
        "required_checks_sha256": required_check_policy_digest(REQUIRED),
        "direct_writes_blocked": True,
        "required_checks_enforced": True,
        "publisher": "policy-publisher",
        "key_id": "key-1",
        "reference": "policy:1",
        "observed_at": observed_at,
        "expires_at": expires_at,
    }
    return collect_branch_policy_proof({
        **unsigned,
        "attestation_hmac_sha256": branch_policy_attestation(unsigned, key),
    })


def admit(evidence, proof, *, now=10, repository="Illuminfti/kizuki", pr_number=385):
    return gate_admission(
        evidence,
        repository,
        pr_number,
        HEAD,
        BASE,
        REQUIRED,
        proof,
        now,
        "policy-publisher",
        "key-1",
        "policy:1",
        POLICY_KEYS,
    )


def summary(*, status="PASS", receipt="d" * 64):
    return {
        "campaign_id": "campaign-1",
        "task_id": "task-1",
        "status": status,
        "ledger_tip_sha256": "c" * 64,
        "receipt_sha256": receipt,
        "receipt_ids": ["receipt-1", "receipt-2"],
        "reason_code": None if status == "PASS" else "WAITING_FOR_REVIEW",
    }


def comments(items, *, observed_at=10, repository="Illuminfti/kizuki", issue_number=4):
    return {
        "repository": repository,
        "issue_number": issue_number,
        "observed_at": observed_at,
        "complete": True,
        "comments": list(items),
    }


def grant(evidence, proof, *, epoch=2):
    return mint_merge_grant(
        signing_key=GRANT_KEY,
        repository="Illuminfti/kizuki",
        pr_number=385,
        head_sha=HEAD,
        base_sha=BASE,
        strategy="SQUASH",
        title_sha256=digest("title"),
        body_sha256=digest("body"),
        issuer="issuer",
        issuer_key_id="grant-key-1",
        github_evidence_sha256=evidence["sha256"],
        branch_policy_proof_sha256=proof["sha256"],
        authority_reference="decision-log:C5",
        delegate="delegate",
        expires_at=200,
        epoch=epoch,
        fence_token=9,
        operation_id="op-1",
        generation=1,
        max_requests=1,
    )


def request(op, signed_grant, evidence, proof, *, now=10, epoch=2):
    return op.request(
        signed_grant,
        now=now,
        current_epoch=epoch,
        grant_verification_keys=GRANT_KEYS,
        title="title",
        body="body",
        evidence=evidence,
        fresh_main_sha=BASE,
        delegate="delegate",
        authority_reference="decision-log:C5",
        issuer="issuer",
        fence_token=9,
        generation=1,
        branch_policy_proof=proof,
        required_checks=REQUIRED,
        expected_policy_publisher="policy-publisher",
        expected_policy_key_id="key-1",
        expected_policy_reference="policy:1",
        policy_verification_keys=POLICY_KEYS,
    )


class GitHubBridgeTests(unittest.TestCase):
    def test_collect_is_typed_canonical_and_digest_is_stable(self):
        evidence = collect_evidence(pr_fixture())
        self.assertEqual(evidence["head_sha"], HEAD)
        self.assertEqual(evidence["sha256"], evidence_digest(evidence))
        self.assertEqual(canonical_json(evidence), canonical_json(copy.deepcopy(evidence)))

    def test_rejects_raw_query_secrets_and_pathlike_references(self):
        raw = pr_fixture()
        raw["checks"][0]["log"] = "secret"
        with self.assertRaises(BridgeError):
            collect_evidence(raw)
        raw = pr_fixture()
        raw["checks"][0]["url"] = "https://ci.invalid/job?token=TOPSECRET"
        with self.assertRaises(BridgeError):
            collect_evidence(raw)
        raw = pr_fixture()
        raw["reviews"][0]["reference"] = "/home/ubuntu/review"
        with self.assertRaises(BridgeError):
            collect_evidence(raw)

    def test_gate_requires_exact_destination_head_base_checks_reviews_and_signed_policy(self):
        evidence = collect_evidence(pr_fixture())
        proof = policy_fixture()
        admit(evidence, proof)
        for repository, number in (("Other/repo", 385), ("Illuminfti/kizuki", 386)):
            with self.assertRaises(BridgeError):
                admit(evidence, proof, repository=repository, pr_number=number)
        stale = copy.deepcopy(evidence)
        stale["head_sha"] = "c" * 40
        with self.assertRaises(BridgeError):
            admit(stale, proof)

    def test_policy_mac_is_verified_not_merely_well_formed(self):
        evidence = collect_evidence(pr_fixture())
        forged = policy_fixture(key=b"attacker-controlled-key-material-01")
        with self.assertRaisesRegex(BridgeError, "authentication"):
            admit(evidence, forged)
        tampered = dict(policy_fixture())
        tampered["attestation_hmac_sha256"] = "e" * 64
        tampered["sha256"] = evidence_digest(tampered)
        with self.assertRaises(BridgeError):
            admit(evidence, tampered)

    def test_policy_must_attest_enforcement_and_direct_write_exclusion(self):
        base = {
            "repository": "Illuminfti/kizuki",
            "main_sha": BASE,
            "required_checks_sha256": required_check_policy_digest(REQUIRED),
            "direct_writes_blocked": False,
            "required_checks_enforced": True,
            "publisher": "policy-publisher",
            "key_id": "key-1",
            "reference": "policy:1",
            "observed_at": 9,
            "expires_at": 200,
        }
        with self.assertRaises(BridgeError):
            branch_policy_attestation(base, POLICY_KEY)

    def test_gate_rejects_old_or_future_pr_evidence(self):
        proof = policy_fixture(observed_at=900, expires_at=1200)
        with self.assertRaisesRegex(BridgeError, "stale"):
            admit(collect_evidence(pr_fixture(observed_at=800)), proof, now=1000)
        with self.assertRaisesRegex(BridgeError, "future"):
            admit(collect_evidence(pr_fixture(observed_at=1001)), proof, now=1000)

    def test_gate_rejects_ancient_or_overlong_signed_policy(self):
        evidence = collect_evidence(pr_fixture(observed_at=1000))
        ancient = policy_fixture(observed_at=750, expires_at=1001)
        with self.assertRaisesRegex(BridgeError, "stale"):
            admit(evidence, ancient, now=1000)
        with self.assertRaisesRegex(BridgeError, "lifetime"):
            policy_fixture(observed_at=1, expires_at=302)

    def test_gate_requires_open_unmerged_pr(self):
        proof = policy_fixture()
        for field, value in (("state", "CLOSED"), ("merged", True)):
            raw = pr_fixture()
            raw[field] = value
            with self.assertRaises(BridgeError):
                admit(collect_evidence(raw), proof)

    def test_gate_rejects_casefolded_author_or_reviewer_aliases(self):
        proof = policy_fixture()
        raw = pr_fixture()
        raw["author"] = "Builder"
        raw["reviews"][0]["principal"] = "builder"
        with self.assertRaises(BridgeError):
            admit(collect_evidence(raw), proof)
        raw = pr_fixture()
        raw["reviews"][0]["principal"] = "Reviewer"
        raw["reviews"][1]["principal"] = "reviewer"
        with self.assertRaises(BridgeError):
            admit(collect_evidence(raw), proof)

    def test_gate_rejects_check_sha_duplicate_reviewers_and_missing_success(self):
        proof = policy_fixture()
        raw = pr_fixture()
        raw["checks"][0]["head_sha"] = "c" * 40
        with self.assertRaises(BridgeError):
            admit(collect_evidence(raw), proof)
        raw = pr_fixture()
        raw["checks"][0]["conclusion"] = "IN_PROGRESS"
        with self.assertRaises(BridgeError):
            admit(collect_evidence(raw), proof)

    def test_optional_checks_are_exact_named_pairs(self):
        raw = pr_fixture()
        raw["checks"].append({
            "name": "bugbot", "head_sha": HEAD, "conclusion": "NEUTRAL",
            "url": "https://ci.invalid/bugbot",
        })
        evidence = collect_evidence(raw)
        proof = policy_fixture()
        gate_admission(
            evidence, "Illuminfti/kizuki", 385, HEAD, BASE, REQUIRED, proof, 10,
            "policy-publisher", "key-1", "policy:1", POLICY_KEYS,
            optional_checks={"bugbot": "NEUTRAL"},
        )
        with self.assertRaises(BridgeError):
            gate_admission(
                evidence, "Illuminfti/kizuki", 385, HEAD, BASE, REQUIRED, proof, 10,
                "policy-publisher", "key-1", "policy:1", POLICY_KEYS,
                optional_checks={"other": "NEUTRAL"},
            )

    def test_publication_is_typed_derived_destination_bound_and_idempotent(self):
        prepared = prepare_publication(
            {}, "immutable", summary(), "publisher", "Illuminfti/kizuki", 4,
            dry_run=False, comment_listing=comments([]), now=10,
        )
        self.assertTrue(prepared["marker"].startswith("kizuki-gauntlet-"))
        sent = mark_publication_sent(prepared)
        listing = comments([{"id": 7, "author": "publisher", "body": prepared["body"]}], observed_at=11)
        confirmed = reconcile_publication(sent, listing, now=11)
        same = prepare_publication(
            confirmed, "immutable", summary(), "publisher", "Illuminfti/kizuki", 4,
            dry_run=False, comment_listing=listing, now=11,
        )
        self.assertTrue(same["idempotent"])
        with self.assertRaises(BridgeError):
            prepare_publication(
                confirmed, "immutable", summary(), "publisher", "Other/repo", 4,
                dry_run=False, comment_listing=comments([], repository="Other/repo"), now=11,
            )

    def test_publication_rejects_arbitrary_text_and_requires_fresh_pagination(self):
        unsafe = summary()
        unsafe["message"] = "token=TOPSECRET"
        with self.assertRaises(BridgeError):
            prepare_publication({}, "immutable", unsafe, "publisher", "Illuminfti/kizuki", 4)
        with self.assertRaisesRegex(BridgeError, "pagination"):
            prepare_publication(
                {}, "immutable", summary(), "publisher", "Illuminfti/kizuki", 4,
                dry_run=False,
            )
        with self.assertRaisesRegex(BridgeError, "stale"):
            prepare_publication(
                {}, "immutable", summary(), "publisher", "Illuminfti/kizuki", 4,
                dry_run=False, comment_listing=comments([], observed_at=1), now=500,
            )

    def test_status_update_says_not_authorization_and_rechecks_id_author_body(self):
        first = prepare_publication(
            {}, "status", summary(status="BLOCKED"), "publisher", "Illuminfti/kizuki", 4,
            dry_run=False, comment_listing=comments([]), now=10,
        )
        self.assertIn("\nNOT AUTHORIZATION\n", first["body"])
        listing = comments([{"id": 41, "author": "publisher", "body": first["body"]}], observed_at=11)
        confirmed = reconcile_publication(mark_publication_sent(first), listing, now=11)
        update = prepare_publication(
            confirmed, "status", summary(status="DONE", receipt="e" * 64),
            "publisher", "Illuminfti/kizuki", 4, dry_run=False,
            comment_listing=listing, now=11,
        )
        self.assertEqual((update["operation"], update["comment_id"]), ("UPDATE", 41))
        changed = comments([{"id": 41, "author": "publisher", "body": first["body"] + " changed"}], observed_at=11)
        with self.assertRaises(BridgeError):
            prepare_publication(
                confirmed, "status", summary(status="DONE", receipt="e" * 64),
                "publisher", "Illuminfti/kizuki", 4, dry_run=False,
                comment_listing=changed, now=11,
            )

    def test_sent_or_uncertain_publication_never_reposts(self):
        prepared = prepare_publication(
            {}, "immutable", summary(), "publisher", "Illuminfti/kizuki", 4,
            dry_run=False, comment_listing=comments([]), now=10,
        )
        sent = mark_publication_sent(prepared)
        uncertain = mark_publication_uncertain(sent)
        for state in (sent, uncertain):
            with self.assertRaises(BridgeError):
                prepare_publication(
                    state, "immutable", summary(), "publisher", "Illuminfti/kizuki", 4,
                    dry_run=False, comment_listing=comments([]), now=10,
                )

    def test_publication_send_boundary_rejects_forged_body(self):
        prepared = prepare_publication(
            {}, "immutable", summary(), "publisher", "Illuminfti/kizuki", 4,
            dry_run=False, comment_listing=comments([]), now=10,
        )
        forged = dict(prepared)
        forged["body"] = "RAW SECRET authcode ABC"
        forged["body_sha256"] = "f" * 64
        with self.assertRaisesRegex(BridgeError, "canonical"):
            mark_publication_sent(forged)
        forged = dict(prepared)
        forged["dry_run"] = 0
        with self.assertRaises(BridgeError):
            mark_publication_sent(forged)

    def test_merge_grant_is_authenticated_one_shot_and_rechecks_all_gates(self):
        evidence = collect_evidence(pr_fixture())
        proof = policy_fixture()
        signed = grant(evidence, proof)
        op = MergeOperation(signed, GRANT_KEYS, current_epoch=2)
        op.prepare(signed, now=10, current_epoch=2, verification_keys=GRANT_KEYS)
        self.assertEqual(op.state, PREPARED)
        envelope = request(op, signed, evidence, proof)
        self.assertEqual((op.state, envelope["sha"]), (SENT, HEAD))
        with self.assertRaises(BridgeError):
            request(op, signed, evidence, proof)

    def test_forged_or_stale_epoch_grant_is_rejected(self):
        evidence = collect_evidence(pr_fixture())
        proof = policy_fixture()
        signed = grant(evidence, proof)
        with self.assertRaisesRegex(BridgeError, "authentication"):
            MergeOperation(signed, {"grant-key-1": b"attacker-controlled-key-material-01"}, 2)
        with self.assertRaisesRegex(BridgeError, "stale epoch"):
            MergeOperation(signed, GRANT_KEYS, 3)

    def test_merge_confirmation_is_fresh_and_repository_pr_head_bound(self):
        evidence = collect_evidence(pr_fixture())
        proof = policy_fixture()
        signed = grant(evidence, proof)
        op = MergeOperation(signed, GRANT_KEYS, 2)
        op.prepare(signed, now=10, current_epoch=2, verification_keys=GRANT_KEYS)
        request(op, signed, evidence, proof)
        confirmation = {
            "repository": "Illuminfti/kizuki",
            "pr_number": 385,
            "operation_id": "op-1",
            "request_sha256": op.request_sha256,
            "head_sha": HEAD,
            "included_head_sha": HEAD,
            "observed_at": 11,
            "merged_at": 11,
            "merge_commit": "d" * 40,
            "main_sha": "d" * 40,
        }
        for field, value in (("repository", "Other/repo"), ("pr_number", 999), ("included_head_sha", "c" * 40)):
            bad = dict(confirmation)
            bad[field] = value
            with self.assertRaises(BridgeError):
                op.confirm(bad, now=11, current_epoch=2)
        op.confirm(confirmation, now=11, current_epoch=2)
        self.assertEqual(op.state, "CONFIRMED")

    def test_merge_confirmation_rejects_future_merge_time(self):
        evidence = collect_evidence(pr_fixture())
        proof = policy_fixture()
        signed = grant(evidence, proof)
        op = MergeOperation(signed, GRANT_KEYS, 2)
        op.prepare(signed, now=10, current_epoch=2, verification_keys=GRANT_KEYS)
        request(op, signed, evidence, proof)
        confirmation = {
            "repository": "Illuminfti/kizuki", "pr_number": 385,
            "operation_id": "op-1", "request_sha256": op.request_sha256,
            "head_sha": HEAD, "included_head_sha": HEAD, "observed_at": 11,
            "merged_at": 10**12, "merge_commit": "d" * 40,
            "main_sha": "d" * 40,
        }
        with self.assertRaisesRegex(BridgeError, "later"):
            op.confirm(confirmation, now=11, current_epoch=2)


if __name__ == "__main__":
    unittest.main()
