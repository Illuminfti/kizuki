import inspect
import socket
import unittest
from dataclasses import replace

from gauntlet.egress import (
    EgressAttemptBinding,
    EgressError,
    EgressPolicy,
    network_profile_sha256,
    parse_connect_request,
    resolve_public_addresses,
    sign_egress_policy,
    verify_egress_policy,
)


POLICY_KEY = b"egress-policy-test-key-material-01"
POLICY_KEYS = {"egress-key-1": POLICY_KEY}


def policy_fields(**overrides):
    network = {
        "profile_id": "codex-v1",
        "hosts": ("api.openai.com", "chatgpt.com"),
        "max_connections": 4,
        "max_client_bytes": 1_000_000,
        "max_upstream_bytes": 1_000_000,
        "max_total_bytes": 1_500_000,
        "resolver_timeout_seconds": 5,
        "idle_seconds": 30,
        "wall_seconds": 300,
        "max_connect_bytes": 8192,
        "max_client_hello_bytes": 65536,
    }
    values = {
        "schema": "kizuki-gauntlet-egress-policy-v1",
        "issuer_key_id": "egress-key-1",
        "campaign_id": "campaign-01",
        "task_id": "task-01",
        "attempt": 2,
        "controller_epoch": 7,
        "adapter": "codex",
        "principal_id": "codex-builder",
        "authority_domain": "codex-builder-domain",
        "identity_generation": 3,
        **network,
        "network_profile_sha256": network_profile_sha256(**network),
        "issued_at": 10,
        "expires_at": 500,
        "nonce": "a" * 64,
    }
    values.update(overrides)
    return values


def attempt_binding(**overrides):
    values = {
        "campaign_id": "campaign-01",
        "task_id": "task-01",
        "attempt": 2,
        "controller_epoch": 7,
        "adapter": "codex",
        "principal_id": "codex-builder",
        "authority_domain": "codex-builder-domain",
        "identity_generation": 3,
        "network_profile_sha256": policy_fields()["network_profile_sha256"],
    }
    values.update(overrides)
    return EgressAttemptBinding(**values)


class AuthenticatedEgressPolicyTests(unittest.TestCase):
    def test_policy_is_authenticated_and_bound_to_the_exact_attempt_identity(self):
        policy = sign_egress_policy(signing_key=POLICY_KEY, **policy_fields())
        self.assertIs(
            verify_egress_policy(policy, POLICY_KEYS, attempt_binding(), now=20),
            policy,
        )
        for field, value in (
            ("campaign_id", "campaign-02"),
            ("task_id", "task-02"),
            ("attempt", 3),
            ("controller_epoch", 8),
            ("adapter", "claude"),
            ("principal_id", "other-builder"),
            ("authority_domain", "other-domain"),
            ("identity_generation", 4),
            ("network_profile_sha256", "b" * 64),
        ):
            with self.subTest(field=field), self.assertRaises(EgressError):
                verify_egress_policy(
                    policy,
                    POLICY_KEYS,
                    replace(attempt_binding(), **{field: value}),
                    now=20,
                )

        with self.assertRaises(EgressError):
            verify_egress_policy(replace(policy, task_id="task-02"), POLICY_KEYS, attempt_binding(), now=20)
        with self.assertRaises(EgressError):
            verify_egress_policy(policy, POLICY_KEYS, attempt_binding(), now=500)

    def test_signature_covers_identity_authority_expiry_nonce_and_network_profile(self):
        policy = sign_egress_policy(signing_key=POLICY_KEY, **policy_fields())
        tampering = (
            ("campaign_id", "campaign-02"),
            ("task_id", "task-02"),
            ("attempt", 3),
            ("controller_epoch", 8),
            ("adapter", "claude"),
            ("principal_id", "other-builder"),
            ("authority_domain", "other-domain"),
            ("identity_generation", 4),
            ("profile_id", "codex-v2"),
            ("issued_at", 11),
            ("expires_at", 501),
            ("nonce", "b" * 64),
            ("policy_sha256", "b" * 64),
            ("signature_sha256", "b" * 64),
        )
        for field, value in tampering:
            with self.subTest(field=field), self.assertRaises(EgressError):
                candidate = replace(policy, **{field: value})
                verify_egress_policy(candidate, POLICY_KEYS, attempt_binding(), now=20)
        for keys in ({}, {**POLICY_KEYS, "unexpected-key": b"x" * 32}):
            with self.subTest(keys=tuple(keys)), self.assertRaises(EgressError):
                verify_egress_policy(policy, keys, attempt_binding(), now=20)


class EgressPolicyTests(unittest.TestCase):
    def test_resolution_has_no_network_capable_default(self):
        resolver = inspect.signature(resolve_public_addresses).parameters["resolver"]
        self.assertIs(resolver.default, inspect.Parameter.empty)

    def test_policy_requires_exact_enumerated_hosts_and_bounded_limits(self):
        policy = sign_egress_policy(signing_key=POLICY_KEY, **policy_fields())
        self.assertTrue(policy.permits("api.openai.com"))
        self.assertTrue(policy.permits("api.openai.com", 443))
        self.assertFalse(policy.permits("api.openai.com", 80))
        self.assertFalse(policy.permits("evil.api.openai.com"))
        self.assertFalse(policy.permits("openai.com"))
        for hosts in (("*.openai.com",), ("com",), ("127.0.0.1",), ("localhost",)):
            with self.subTest(hosts=hosts), self.assertRaises(EgressError):
                sign_egress_policy(signing_key=POLICY_KEY, **policy_fields(hosts=hosts))
        for field, value in (
            ("max_connections", 65),
            ("max_client_bytes", 1_000_000_001),
            ("max_upstream_bytes", 1_000_000_001),
            ("max_total_bytes", 2_000_000_001),
            ("resolver_timeout_seconds", 31),
            ("idle_seconds", 301),
            ("wall_seconds", 3601),
            ("max_connect_bytes", 65_537),
            ("max_client_hello_bytes", 262_145),
        ):
            with self.subTest(field=field), self.assertRaises(EgressError):
                sign_egress_policy(signing_key=POLICY_KEY, **policy_fields(**{field: value}))

    def test_connect_parser_accepts_only_https_connect_to_exact_host(self):
        request = (
            b"CONNECT api.openai.com:443 HTTP/1.1\r\n"
            b"Host: api.openai.com:443\r\n"
            b"Proxy-Connection: Keep-Alive\r\n\r\n"
        )
        parsed = parse_connect_request(request)
        self.assertEqual((parsed.host, parsed.port), ("api.openai.com", 443))
        for bad in (
            b"GET https://api.openai.com/ HTTP/1.1\r\n\r\n",
            b"CONNECT api.openai.com:80 HTTP/1.1\r\n\r\n",
            b"CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n",
            b"CONNECT api.openai.com:443 HTTP/1.0\r\n\r\n",
            b"CONNECT api.openai.com:443 HTTP/1.1\r\n\r\n",
            b"CONNECT api.openai.com:443 HTTP/1.1\r\nProxy-Authorization: secret\r\n\r\n",
            b"CONNECT api.openai.com:443 HTTP/1.1\r\nHost: other.example:443\r\n\r\n",
        ):
            with self.subTest(bad=bad[:40]), self.assertRaises(EgressError):
                parse_connect_request(bad)

    def test_connect_parser_bounds_and_normalizes(self):
        parsed = parse_connect_request(
            b"CONNECT API.OPENAI.COM:443 HTTP/1.1\r\nHost: API.OPENAI.COM:443\r\n\r\n"
        )
        self.assertEqual(parsed.host, "api.openai.com")
        with self.assertRaises(EgressError):
            parse_connect_request(b"CONNECT a.example:443 HTTP/1.1\r\nX: " + b"x" * 9000 + b"\r\n\r\n")
        with self.assertRaises(EgressError):
            parse_connect_request(b"CONNECT example.com.:443 HTTP/1.1\r\n\r\n")

    def test_resolution_rejects_every_non_global_address_and_deduplicates(self):
        def fake_public(*_):
            return [
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443)),
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443)),
                (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2606:2800:220:1:248:1893:25c8:1946", 443, 0, 0)),
            ]

        addresses = resolve_public_addresses("example.com", resolver=fake_public)
        self.assertEqual(len(addresses), 2)

        bad_addresses = (
            "127.0.0.1", "10.0.0.1", "169.254.169.254", "192.0.2.1",
            "224.0.0.1", "0.0.0.0", "::1", "fc00::1", "fe80::1",
        )
        for address in bad_addresses:
            family = socket.AF_INET6 if ":" in address else socket.AF_INET
            sockaddr = (address, 443, 0, 0) if family == socket.AF_INET6 else (address, 443)
            with self.subTest(address=address), self.assertRaises(EgressError):
                resolve_public_addresses(
                    "example.com",
                    resolver=lambda *_args, f=family, s=sockaddr: [(f, socket.SOCK_STREAM, 6, "", s)],
                )

    def test_resolution_rejects_empty_or_mixed_public_private_answers(self):
        with self.assertRaises(EgressError):
            resolve_public_addresses("example.com", resolver=lambda *_: [])
        mixed = lambda *_: [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.2", 443)),
        ]
        with self.assertRaises(EgressError):
            resolve_public_addresses("example.com", resolver=mixed)

    def test_resolution_rejects_family_protocol_and_ipv6_metadata_confusion(self):
        malformed = (
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("2606:2800:220:1:248:1893:25c8:1946", 443)),
            (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443, 0, 0)),
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_UDP, "", ("93.184.216.34", 443)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443, 0, 0)),
            (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2606:2800:220:1:248:1893:25c8:1946", 443, 1, 0)),
            (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2606:2800:220:1:248:1893:25c8:1946", 443, 0, 2)),
        )
        for entry in malformed:
            with self.subTest(entry=entry), self.assertRaises(EgressError):
                resolve_public_addresses("example.com", resolver=lambda *_args, e=entry: (e,))

    def test_resolution_consumes_at_most_one_over_the_answer_limit(self):
        yielded = []

        def excessive(*_args):
            entry = (
                socket.AF_INET,
                socket.SOCK_STREAM,
                socket.IPPROTO_TCP,
                "",
                ("93.184.216.34", 443),
            )
            for index in range(1000):
                yielded.append(index)
                yield entry

        with self.assertRaises(EgressError):
            resolve_public_addresses("example.com", resolver=excessive)
        self.assertLessEqual(len(yielded), 33)


if __name__ == "__main__":
    unittest.main()
