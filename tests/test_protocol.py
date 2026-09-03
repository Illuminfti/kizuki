import unittest

from gauntlet.identity import Artifact, IdentityManifest, IdentityReceipt, validated_authority_binding
from gauntlet.protocol import AuthorizationError, ConflictError, ProtocolError, ProtocolStore

B = "b" * 40
KEY = b"identity-controller-test-key-material-01"
BRIDGE = b"bridge-receipt-test-key-material-01"

def manifest(who, domain=None, account=None):
    return IdentityManifest(who, domain or "domain-" + who, "codex", 1, account or (who[0] * 64), "2" * 64, "3" * 64, (Artifact("auth.json", "4" * 64, 128),))
def receipt(m):
    return IdentityReceipt(m.principal_id, m.authority_domain, m.adapter, m.generation, m.account_binding_sha256, m.executable_sha256, m.network_profile_sha256, 0, 500, "READY", "READY")
def store(now=10):
    return ProtocolStore(clock=lambda: now, identity_hmac_key=KEY, bridge_receipt_keys={"bridge": BRIDGE})
def register(p, who, domain=None, account=None):
    m = manifest(who, domain, account); r = receipt(m); p.register_identity(m, r); return m, r
def claim(p, task, role, m, r):
    binding = validated_authority_binding(m, r, p.clock(), KEY, p.operation_sha256(task, role))
    return p.claim_phase(task, role, binding, p.task(task).version, 100)

class ProtocolTests(unittest.TestCase):
    def test_store_requires_pinned_keys_and_task_destination_is_immutable(self):
        with self.assertRaises(ProtocolError): ProtocolStore()
        p = store(); p.admit_task("t", B, "Illuminfti/kizuki", 4)
        self.assertEqual((p.task("t").repository, p.task("t").pr_number), ("Illuminfti/kizuki", 4))
        with self.assertRaises(ConflictError): p.admit_task("t", B, "Other/repo", 8)

    def test_claim_authenticates_current_task_bound_binding_and_consumes_once(self):
        p = store(); p.admit_task("t", B, "Illuminfti/kizuki", 4); m, r = register(p, "builder")
        binding = validated_authority_binding(m, r, 10, KEY, p.operation_sha256("t", "BUILDER"))
        lease = p.claim_phase("t", "BUILDER", binding, p.task("t").version, 100)
        self.assertEqual(lease.principal_id, "builder")
        with self.assertRaises((AuthorizationError, ProtocolError)): p.claim_phase("t", "BUILDER", binding, p.task("t").version, 100)

    def test_rejects_tampered_expired_and_cross_operation_bindings(self):
        p = store(); p.admit_task("t", B, "Illuminfti/kizuki", 4); m, r = register(p, "builder")
        binding = validated_authority_binding(m, r, 10, KEY, p.operation_sha256("t", "BUILDER"))
        bad = binding.__class__(**{**binding.__dict__, "signature_sha256": "0" * 64})
        with self.assertRaises(AuthorizationError): p.claim_phase("t", "BUILDER", bad, p.task("t").version, 100)
        other = validated_authority_binding(m, r, 10, KEY, "9" * 64)
        with self.assertRaises(AuthorizationError): p.claim_phase("t", "BUILDER", other, p.task("t").version, 100)
        late = store(600); late.admit_task("t", B, "Illuminfti/kizuki", 4); late.register_identity(m, r)
        with self.assertRaises(AuthorizationError): late.claim_phase("t", "BUILDER", binding, late.task("t").version, 100)

    def test_account_binding_is_not_reusable_across_authority_domains(self):
        p = store(); p.admit_task("t", B, "Illuminfti/kizuki", 4)
        a, ar = register(p, "builder", "domain-a", "a" * 64); b, br = register(p, "verifier", "domain-b", "a" * 64)
        lease = claim(p, "t", "BUILDER", a, ar); p.start_build(lease, p.task("t").version)
        from gauntlet.protocol import PhaseResult
        p.commit_phase(lease, p.task("t").version, PhaseResult("PASS", "a" * 40, B, "a" * 40, "e" * 64))
        with self.assertRaises(AuthorizationError): claim(p, "t", "VERIFIER", b, br)

    def test_recovery_never_reopens_post_merge_and_returns_verification_to_submitted(self):
        p = store(); p.admit_task("t", B, "Illuminfti/kizuki", 4); m, r = register(p, "builder")
        lease = claim(p, "t", "BUILDER", m, r); p.start_build(lease, p.task("t").version)
        p.tasks["t"].state = "VERIFYING"
        self.assertEqual(p.recover_task("t", p.task("t").version).state, "SUBMITTED")
        p.tasks["t"].state = "POST_MERGE_VERIFYING"
        with self.assertRaises(ProtocolError): p.recover_task("t", p.task("t").version)
