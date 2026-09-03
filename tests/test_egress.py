import socket
import unittest

from gauntlet.egress import (
    EgressError,
    EgressPolicy,
    parse_connect_request,
    resolve_public_addresses,
)


class EgressPolicyTests(unittest.TestCase):
    def test_policy_requires_exact_enumerated_hosts_and_bounded_limits(self):
        policy = EgressPolicy(
            profile_id="codex-v1",
            hosts=("api.openai.com", "chatgpt.com"),
            max_connections=4,
            max_bytes=1_000_000,
            idle_seconds=30,
            wall_seconds=300,
        )
        self.assertTrue(policy.permits("api.openai.com"))
        self.assertFalse(policy.permits("evil.api.openai.com"))
        self.assertFalse(policy.permits("openai.com"))
        for hosts in (("*.openai.com",), ("com",), ("127.0.0.1",), ("localhost",)):
            with self.subTest(hosts=hosts), self.assertRaises(EgressError):
                EgressPolicy("bad", hosts, 1, 1, 1, 1)

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


if __name__ == "__main__":
    unittest.main()
