import json
import socket
import threading
import unittest
from dataclasses import replace

from gauntlet.egress import (
    EgressAttemptBinding,
    network_profile_sha256,
    sign_egress_policy,
)
from gauntlet.egress_proxy import AttemptEgressBudget, handle_connect_session


POLICY_KEY = b"egress-proxy-test-key-material-001"
POLICY_KEYS = {"egress-key-1": POLICY_KEY}


class PeerSocket:
    def __init__(self, stream, peer):
        self.stream = stream
        self.peer = peer

    def getpeername(self):
        return self.peer

    def close(self):
        return self.stream.close()

    def __getattr__(self, name):
        return getattr(self.stream, name)


def client_hello(
    host="api.openai.com", *, include_sni=True, include_ech=False,
    compression=b"\x00", encrypted_extension=None,
):
    extensions = bytearray()
    if include_sni:
        hostname = host.encode("ascii")
        server_name = b"\x00" + len(hostname).to_bytes(2, "big") + hostname
        names = len(server_name).to_bytes(2, "big") + server_name
        extensions.extend(b"\x00\x00" + len(names).to_bytes(2, "big") + names)
    if include_ech or encrypted_extension is not None:
        extension_type = 0xFE0D if encrypted_extension is None else encrypted_extension
        extensions.extend(extension_type.to_bytes(2, "big") + b"\x00\x00")
    body = (
        b"\x03\x03"
        + b"\x00" * 32
        + b"\x00"
        + b"\x00\x02\x13\x01"
        + len(compression).to_bytes(1, "big")
        + compression
        + len(extensions).to_bytes(2, "big")
        + bytes(extensions)
    )
    handshake = b"\x01" + len(body).to_bytes(3, "big") + body
    return b"\x16\x03\x01" + len(handshake).to_bytes(2, "big") + handshake


def signed_policy(**overrides):
    network = {
        "profile_id": "codex-v1",
        "hosts": ("api.openai.com",),
        "max_connections": 2,
        "max_client_bytes": 4096,
        "max_upstream_bytes": 4096,
        "max_total_bytes": 6144,
        "resolver_timeout_seconds": 2,
        "idle_seconds": 2,
        "wall_seconds": 5,
        "max_connect_bytes": 1024,
        "max_client_hello_bytes": 4096,
    }
    for name in tuple(network):
        if name in overrides:
            network[name] = overrides.pop(name)
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
    return sign_egress_policy(signing_key=POLICY_KEY, **values)


def binding(policy):
    return EgressAttemptBinding(
        campaign_id=policy.campaign_id,
        task_id=policy.task_id,
        attempt=policy.attempt,
        controller_epoch=policy.controller_epoch,
        adapter=policy.adapter,
        principal_id=policy.principal_id,
        authority_domain=policy.authority_domain,
        identity_generation=policy.identity_generation,
        network_profile_sha256=policy.network_profile_sha256,
    )


class ConnectSessionTests(unittest.TestCase):
    def assert_stream_closed(self, stream):
        try:
            data = stream.recv(1024)
        except ConnectionResetError:
            return
        self.assertEqual(data, b"")

    def start_connected_session(
        self, *, policy=None, budget=None, cancel_event=None, event_sink=None,
        connect_headers=b"",
    ):
        policy = policy or signed_policy()
        budget = budget or AttemptEgressBudget(policy)
        cancel_event = cancel_event or threading.Event()
        user, proxy = socket.socketpair()
        upstream, server = socket.socketpair()
        user.settimeout(2)
        server.settimeout(2)
        result = {}
        chosen = (
            socket.AF_INET,
            socket.SOCK_STREAM,
            socket.IPPROTO_TCP,
            "",
            ("93.184.216.34", 443),
        )
        kwargs = {}
        if event_sink is not None:
            kwargs["event_sink"] = event_sink
        thread = threading.Thread(target=lambda: result.setdefault(
            "value",
            handle_connect_session(
                proxy,
                policy,
                POLICY_KEYS,
                binding(policy),
                budget,
                policy_now=20,
                resolver=lambda *_args: (chosen,),
                dialer=lambda address, _timeout, _cancel: PeerSocket(
                    upstream, address[4],
                ),
                cancel_event=cancel_event,
                **kwargs,
            ),
        ))
        thread.start()
        user.sendall(
            b"CONNECT api.openai.com:443 HTTP/1.1\r\n"
            b"Host: api.openai.com:443\r\n"
            + connect_headers
            + b"\r\n"
        )
        self.assertIn(b"200 Connection Established", user.recv(1024))
        return policy, user, server, thread, result

    def test_invalid_expired_or_wrong_attempt_policy_is_denied_before_read(self):
        policy = signed_policy()
        cases = (
            (replace(policy, signature_sha256="b" * 64), binding(policy), 20),
            (policy, binding(policy), policy.expires_at),
            (policy, replace(binding(policy), controller_epoch=8), 20),
        )
        for candidate, candidate_binding, now in cases:
            with self.subTest(now=now, epoch=candidate_binding.controller_epoch):
                user, proxy = socket.socketpair()
                user.settimeout(1)
                budget = AttemptEgressBudget(policy)
                result = {}

                def forbidden(*_args):
                    self.fail("invalid policy reached an external boundary")

                thread = threading.Thread(target=lambda: result.setdefault(
                    "value",
                    handle_connect_session(
                        proxy,
                        candidate,
                        POLICY_KEYS,
                        candidate_binding,
                        budget,
                        policy_now=now,
                        resolver=forbidden,
                        dialer=forbidden,
                        cancel_event=threading.Event(),
                    ),
                ))
                thread.start()
                self.assertIn(b"403 Forbidden", user.recv(1024))
                thread.join(timeout=1)
                user.close()
                self.assertFalse(thread.is_alive())
                self.assertEqual(result["value"].outcome, "DENIED_POLICY")
                self.assertEqual(budget.connections, 0)

    def test_matching_tls_sni_relays_both_directions_and_half_closes(self):
        policy = signed_policy()
        user, proxy = socket.socketpair()
        upstream, server = socket.socketpair()
        user.settimeout(1)
        server.settimeout(1)
        result = {}
        chosen = (
            socket.AF_INET,
            socket.SOCK_STREAM,
            socket.IPPROTO_TCP,
            "",
            ("93.184.216.34", 443),
        )

        thread = threading.Thread(target=lambda: result.setdefault(
            "value",
            handle_connect_session(
                proxy,
                policy,
                POLICY_KEYS,
                binding(policy),
                AttemptEgressBudget(policy),
                policy_now=20,
                resolver=lambda *_args: (chosen,),
                dialer=lambda address, _timeout, _cancel: PeerSocket(
                    upstream, address[4],
                ),
                cancel_event=threading.Event(),
            ),
        ))
        thread.start()
        user.sendall(
            b"CONNECT api.openai.com:443 HTTP/1.1\r\n"
            b"Host: api.openai.com:443\r\n\r\n"
        )
        self.assertIn(b"200 Connection Established", user.recv(1024))

        hello = client_hello()
        client_payload = hello + b"encrypted-client-record"
        user.sendall(client_payload)
        user.shutdown(socket.SHUT_WR)
        received = bytearray()
        while True:
            chunk = server.recv(4096)
            if not chunk:
                break
            received.extend(chunk)
        self.assertEqual(bytes(received), client_payload)

        server_payload = b"encrypted-server-record"
        server.sendall(server_payload)
        server.shutdown(socket.SHUT_WR)
        response = bytearray()
        while True:
            chunk = user.recv(4096)
            if not chunk:
                break
            response.extend(chunk)
        thread.join(timeout=1)
        user.close()
        server.close()
        self.assertFalse(thread.is_alive())
        self.assertEqual(bytes(response), server_payload)
        self.assertEqual(result["value"].outcome, "COMPLETED")
        self.assertTrue(result["value"].allowed)
        self.assertEqual(result["value"].client_to_upstream_bytes, len(client_payload))
        self.assertEqual(result["value"].upstream_to_client_bytes, len(server_payload))
        self.assertEqual(result["value"].total_bytes, len(client_payload) + len(server_payload))

    def test_tls_preface_rejects_wrong_or_missing_sni_ech_non_tls_and_malformed(self):
        malformed = bytearray(client_hello())
        malformed[6:9] = b"\xff\xff\xff"
        cases = {
            "wrong-sni": client_hello("other.example"),
            "missing-sni": client_hello(include_sni=False),
            "ech": client_hello(include_ech=True),
            "legacy-esni": client_hello(encrypted_extension=0xFFCE),
            "compression": client_hello(compression=b"\x01"),
            "non-tls": b"GET / HTTP/1.1\r\n\r\n",
            "malformed": bytes(malformed),
        }
        for label, preface in cases.items():
            with self.subTest(label=label):
                _policy, user, server, thread, result = self.start_connected_session()
                user.sendall(preface)
                user.shutdown(socket.SHUT_WR)
                self.assert_stream_closed(user)
                self.assert_stream_closed(server)
                thread.join(timeout=1)
                user.close()
                server.close()
                self.assertFalse(thread.is_alive())
                self.assertEqual(result["value"].outcome, "DENIED_TLS")
                self.assertEqual(result["value"].total_bytes, 0)

    def test_tls_preface_rejects_oversize_before_forwarding(self):
        policy = signed_policy(max_client_hello_bytes=32)
        _policy, user, server, thread, result = self.start_connected_session(policy=policy)
        user.sendall(b"\x16\x03\x01\x00\x21" + b"x" * 33)
        self.assert_stream_closed(user)
        self.assert_stream_closed(server)
        thread.join(timeout=1)
        user.close()
        server.close()
        self.assertFalse(thread.is_alive())
        self.assertEqual(result["value"].outcome, "DENIED_TLS")

    def test_stalled_tls_preface_hits_idle_cap(self):
        policy = signed_policy(idle_seconds=1, wall_seconds=2)
        _policy, user, server, thread, result = self.start_connected_session(policy=policy)
        thread.join(timeout=1.5)
        user.close()
        server.close()
        self.assertFalse(thread.is_alive())
        self.assertEqual(result["value"].outcome, "DENIED_TLS")

    def test_attempt_connection_limit_counts_denied_sessions(self):
        policy = signed_policy(max_connections=1)
        budget = AttemptEgressBudget(policy)

        def forbidden(*_args):
            self.fail("connection-limited session reached an external boundary")

        outcomes = []
        for index in range(2):
            user, proxy = socket.socketpair()
            user.settimeout(1)
            result = {}
            thread = threading.Thread(target=lambda: result.setdefault(
                "value",
                handle_connect_session(
                    proxy,
                    policy,
                    POLICY_KEYS,
                    binding(policy),
                    budget,
                    policy_now=20,
                    resolver=forbidden,
                    dialer=forbidden,
                    cancel_event=threading.Event(),
                ),
            ))
            thread.start()
            if index == 0:
                user.sendall(
                    b"CONNECT evil.example:443 HTTP/1.1\r\n"
                    b"Host: evil.example:443\r\n\r\n"
                )
            self.assertIn(b"403 Forbidden", user.recv(1024))
            thread.join(timeout=1)
            user.close()
            self.assertFalse(thread.is_alive())
            outcomes.append(result["value"].outcome)
        self.assertEqual(outcomes, ["DENIED_HOST", "DENIED_POLICY"])
        self.assertEqual(budget.connections, 1)

    def test_client_direction_byte_cap_never_forwards_excess(self):
        hello = client_hello()
        policy = signed_policy(max_client_bytes=len(hello))
        _policy, user, server, thread, result = self.start_connected_session(policy=policy)
        user.sendall(hello + b"x")
        self.assertEqual(server.recv(4096), hello)
        self.assert_stream_closed(server)
        self.assert_stream_closed(user)
        thread.join(timeout=1)
        user.close()
        server.close()
        self.assertFalse(thread.is_alive())
        self.assertEqual(result["value"].outcome, "BYTE_LIMIT")
        self.assertEqual(result["value"].client_to_upstream_bytes, len(hello))

    def test_upstream_direction_and_total_byte_caps_never_forward_excess(self):
        hello = client_hello()
        cases = (
            (signed_policy(max_upstream_bytes=3), "upstream"),
            (signed_policy(max_total_bytes=len(hello) + 3), "total"),
        )
        for policy, label in cases:
            with self.subTest(cap=label):
                _policy, user, server, thread, result = self.start_connected_session(policy=policy)
                user.sendall(hello)
                user.shutdown(socket.SHUT_WR)
                received = bytearray()
                while True:
                    chunk = server.recv(4096)
                    if not chunk:
                        break
                    received.extend(chunk)
                self.assertEqual(bytes(received), hello)
                server.sendall(b"four")
                self.assert_stream_closed(user)
                thread.join(timeout=1)
                user.close()
                server.close()
                self.assertFalse(thread.is_alive())
                self.assertEqual(result["value"].outcome, "BYTE_LIMIT")
                self.assertEqual(result["value"].upstream_to_client_bytes, 0)

    def test_relay_enforces_idle_and_wall_caps(self):
        for policy, expected, timeout in (
            (signed_policy(idle_seconds=1, wall_seconds=2), "IDLE_TIMEOUT", 1.5),
            (
                signed_policy(
                    resolver_timeout_seconds=1, idle_seconds=1, wall_seconds=1,
                ),
                "WALL_TIMEOUT",
                1.5,
            ),
        ):
            with self.subTest(expected=expected):
                _policy, user, server, thread, result = self.start_connected_session(policy=policy)
                user.sendall(client_hello())
                self.assertTrue(server.recv(4096))
                thread.join(timeout=timeout)
                user.close()
                server.close()
                self.assertFalse(thread.is_alive())
                self.assertEqual(result["value"].outcome, expected)

    def test_cancellation_interrupts_stalled_preface_and_cleans_up_streams(self):
        cancel = threading.Event()
        _policy, user, server, thread, result = self.start_connected_session(cancel_event=cancel)
        cancel.set()
        thread.join(timeout=0.5)
        self.assertFalse(thread.is_alive())
        self.assert_stream_closed(user)
        self.assert_stream_closed(server)
        user.close()
        server.close()
        self.assertEqual(result["value"].outcome, "CANCELLED")

    def test_cancellation_after_resolution_prevents_any_dial(self):
        policy = signed_policy()
        cancel = threading.Event()
        user, proxy = socket.socketpair()
        user.settimeout(1)
        dialed = []
        result = {}
        chosen = (
            socket.AF_INET,
            socket.SOCK_STREAM,
            socket.IPPROTO_TCP,
            "",
            ("93.184.216.34", 443),
        )

        def resolver(*_args):
            cancel.set()
            return (chosen,)

        def dialer(*args):
            dialed.append(args)
            raise AssertionError("cancelled session reached dialer")

        thread = threading.Thread(target=lambda: result.setdefault(
            "value",
            handle_connect_session(
                proxy,
                policy,
                POLICY_KEYS,
                binding(policy),
                AttemptEgressBudget(policy),
                policy_now=20,
                resolver=resolver,
                dialer=dialer,
                cancel_event=cancel,
            ),
        ))
        thread.start()
        user.sendall(
            b"CONNECT api.openai.com:443 HTTP/1.1\r\n"
            b"Host: api.openai.com:443\r\n\r\n"
        )
        self.assert_stream_closed(user)
        thread.join(timeout=1)
        user.close()
        self.assertFalse(thread.is_alive())
        self.assertEqual(dialed, [])
        self.assertEqual(result["value"].outcome, "CANCELLED")

    def test_structured_event_is_bounded_and_contains_hostname_hash_only(self):
        events = []
        _policy, user, server, thread, result = self.start_connected_session(
            event_sink=events.append,
            connect_headers=b"X-Opaque: credential-marker\r\n",
        )
        model_output = b"raw-model-output-marker"
        upstream_payload = b"upstream-payload-marker"
        user.sendall(client_hello() + model_output)
        user.shutdown(socket.SHUT_WR)
        while server.recv(4096):
            pass
        server.sendall(upstream_payload)
        server.shutdown(socket.SHUT_WR)
        while user.recv(4096):
            pass
        thread.join(timeout=1)
        user.close()
        server.close()
        self.assertFalse(thread.is_alive())
        self.assertEqual(result["value"].outcome, "COMPLETED")
        self.assertEqual(len(events), 1)
        event = events[0]
        self.assertEqual(set(event), {
            "schema",
            "outcome",
            "allowed",
            "hostname_sha256",
            "client_to_upstream_bytes",
            "upstream_to_client_bytes",
            "total_bytes",
        })
        self.assertRegex(event["hostname_sha256"], r"^[0-9a-f]{64}$")
        encoded = json.dumps(event, sort_keys=True, separators=(",", ":"))
        self.assertLessEqual(len(encoded.encode("ascii")), 512)
        for forbidden in (
            "api.openai.com",
            "93.184.216.34",
            "credential-marker",
            "raw-model-output-marker",
            "upstream-payload-marker",
        ):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, encoded)

    def test_non_enumerated_connect_is_denied_before_resolution_or_dial(self):
        policy = signed_policy()
        user, proxy = socket.socketpair()
        user.settimeout(1)
        result = {}

        def forbidden(*_args, **_kwargs):
            self.fail("denied CONNECT reached an external boundary")

        def run():
            result["value"] = handle_connect_session(
                proxy,
                policy,
                POLICY_KEYS,
                binding(policy),
                AttemptEgressBudget(policy),
                policy_now=20,
                resolver=forbidden,
                dialer=forbidden,
                cancel_event=threading.Event(),
            )

        thread = threading.Thread(target=run)
        thread.start()
        user.sendall(
            b"CONNECT evil.example:443 HTTP/1.1\r\n"
            b"Host: evil.example:443\r\n\r\n"
        )
        response = user.recv(1024)
        thread.join(timeout=1)
        user.close()
        self.assertFalse(thread.is_alive())
        self.assertIn(b"403 Forbidden", response)
        self.assertEqual(result["value"].outcome, "DENIED_HOST")
        self.assertFalse(result["value"].allowed)

    def test_resolution_timeout_is_bounded_and_never_reaches_dialer(self):
        policy = signed_policy()
        user, proxy = socket.socketpair()
        user.settimeout(1)
        observed = []
        result = {}
        cancel = threading.Event()

        def resolver(host, port, timeout, resolver_cancel):
            observed.append((host, port, timeout, resolver_cancel is cancel))
            raise TimeoutError("synthetic timeout")

        def dialer(*_args):
            self.fail("timed-out resolution reached dialer")

        thread = threading.Thread(target=lambda: result.setdefault(
            "value",
            handle_connect_session(
                proxy,
                policy,
                POLICY_KEYS,
                binding(policy),
                AttemptEgressBudget(policy),
                policy_now=20,
                resolver=resolver,
                dialer=dialer,
                cancel_event=cancel,
            ),
        ))
        thread.start()
        user.sendall(
            b"CONNECT api.openai.com:443 HTTP/1.1\r\n"
            b"Host: api.openai.com:443\r\n\r\n"
        )
        response = user.recv(1024)
        thread.join(timeout=1)
        user.close()
        self.assertFalse(thread.is_alive())
        self.assertEqual(observed, [("api.openai.com", 443, 2, True)])
        self.assertIn(b"502 Bad Gateway", response)
        self.assertEqual(result["value"].outcome, "DENIED_RESOLUTION")

    def test_empty_private_and_mixed_dns_sets_never_reach_dialer(self):
        public = (
            socket.AF_INET,
            socket.SOCK_STREAM,
            socket.IPPROTO_TCP,
            "",
            ("93.184.216.34", 443),
        )
        private = (
            socket.AF_INET,
            socket.SOCK_STREAM,
            socket.IPPROTO_TCP,
            "",
            ("10.0.0.8", 443),
        )
        for label, answers in (
            ("empty", ()),
            ("private", (private,)),
            ("mixed", (public, private)),
        ):
            with self.subTest(label=label):
                policy = signed_policy()
                user, proxy = socket.socketpair()
                user.settimeout(1)
                result = {}

                def forbidden(*_args):
                    self.fail("rejected DNS set reached dialer")

                thread = threading.Thread(target=lambda: result.setdefault(
                    "value",
                    handle_connect_session(
                        proxy,
                        policy,
                        POLICY_KEYS,
                        binding(policy),
                        AttemptEgressBudget(policy),
                        policy_now=20,
                        resolver=lambda *_args, a=answers: a,
                        dialer=forbidden,
                        cancel_event=threading.Event(),
                    ),
                ))
                thread.start()
                user.sendall(
                    b"CONNECT api.openai.com:443 HTTP/1.1\r\n"
                    b"Host: api.openai.com:443\r\n\r\n"
                )
                self.assertIn(b"502 Bad Gateway", user.recv(1024))
                thread.join(timeout=1)
                user.close()
                self.assertFalse(thread.is_alive())
                self.assertEqual(result["value"].outcome, "DENIED_RESOLUTION")

    def test_chosen_public_address_is_pinned_and_post_dial_peer_is_rechecked(self):
        policy = signed_policy()
        user, proxy = socket.socketpair()
        upstream, server = socket.socketpair()
        user.settimeout(1)
        observed = []
        result = {}
        chosen = (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("93.184.216.34", 443))
        other = (socket.AF_INET6, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("2606:2800:220:1:248:1893:25c8:1946", 443, 0, 0))

        def resolver(host, port, timeout, resolver_cancel):
            self.assertEqual((host, port), ("api.openai.com", 443))
            self.assertGreater(timeout, 0)
            self.assertFalse(resolver_cancel.is_set())
            return (chosen, other)

        def dialer(address, timeout, dial_cancel):
            self.assertFalse(dial_cancel.is_set())
            observed.append((address, timeout))
            return PeerSocket(upstream, ("1.1.1.1", 443))

        thread = threading.Thread(target=lambda: result.setdefault(
            "value",
            handle_connect_session(
                proxy,
                policy,
                POLICY_KEYS,
                binding(policy),
                AttemptEgressBudget(policy),
                policy_now=20,
                resolver=resolver,
                dialer=dialer,
                cancel_event=threading.Event(),
            ),
        ))
        thread.start()
        user.sendall(
            b"CONNECT api.openai.com:443 HTTP/1.1\r\n"
            b"Host: api.openai.com:443\r\n\r\n"
        )
        response = user.recv(1024)
        thread.join(timeout=1)
        user.close()
        server.close()
        self.assertFalse(thread.is_alive())
        self.assertEqual(observed[0][0], chosen)
        self.assertIn(b"502 Bad Gateway", response)
        self.assertEqual(result["value"].outcome, "DENIED_PEER")

    def test_dial_result_arriving_after_wall_deadline_is_rejected_before_200(self):
        policy = signed_policy()
        user, proxy = socket.socketpair()
        upstream, server = socket.socketpair()
        user.settimeout(1)
        now = [0.0]
        result = {}
        chosen = (
            socket.AF_INET,
            socket.SOCK_STREAM,
            socket.IPPROTO_TCP,
            "",
            ("93.184.216.34", 443),
        )

        def dialer(address, timeout, dial_cancel):
            self.assertEqual(address, chosen)
            self.assertEqual(timeout, 5)
            self.assertFalse(dial_cancel.is_set())
            now[0] = 5.0
            return PeerSocket(upstream, address[4])

        thread = threading.Thread(target=lambda: result.setdefault(
            "value",
            handle_connect_session(
                proxy,
                policy,
                POLICY_KEYS,
                binding(policy),
                AttemptEgressBudget(policy),
                policy_now=20,
                resolver=lambda *_args: (chosen,),
                dialer=dialer,
                cancel_event=threading.Event(),
                monotonic=lambda: now[0],
            ),
        ))
        thread.start()
        user.sendall(
            b"CONNECT api.openai.com:443 HTTP/1.1\r\n"
            b"Host: api.openai.com:443\r\n\r\n"
        )
        self.assertIn(b"502 Bad Gateway", user.recv(1024))
        thread.join(timeout=1)
        user.close()
        server.close()
        self.assertFalse(thread.is_alive())
        self.assertEqual(result["value"].outcome, "DENIED_PEER")


if __name__ == "__main__":
    unittest.main()
