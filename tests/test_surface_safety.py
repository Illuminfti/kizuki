import http.client
import json
import os
import tempfile
import threading
import hashlib
import time
import unittest
from pathlib import Path

from gauntlet.adapters import Adapter, statuses, validate_identities
from gauntlet.cli import main
from gauntlet.core import Guard, Limits, Store
from gauntlet.http import serve


class SurfaceSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(self.tmp.name)
        self.store.claim_controller()
        self.campaign = self.store.create_campaign()
        self.task = self.store.create_task(self.campaign, "src/surface")

    def tearDown(self):
        self.store.close(); self.tmp.cleanup()

    def request(self, server, method, path):
        thread = threading.Thread(target=server.handle_request)
        thread.start()
        conn = http.client.HTTPConnection("127.0.0.1", server.server_address[1])
        conn.request(method, path)
        response = conn.getresponse()
        body = response.read()
        result = response.status, body, dict(response.getheaders())
        conn.close(); thread.join(timeout=2)
        return result

    def test_adapter_missing_and_timeout_and_sanitization(self):
        self.assertFalse(Adapter("codex", "/not/found").probe()["found"])
        script = Path(self.tmp.name) / "slow"
        script.write_text("#!/bin/sh\nsleep 3\n", encoding="utf-8")
        script.chmod(0o700)
        result = Adapter("codex", str(script), timeout_seconds=.1).probe()
        self.assertEqual(result["error"], "version probe timed out")
        self.assertNotIn("path", result)
        self.assertEqual(result["auth_ready"], "unknown")
        self.assertFalse(result["route_ready"])
        self.assertFalse(result["ready"])
        pathy = Path(self.tmp.name) / "pathy"
        pathy.write_text("#!/bin/sh\nprintf '/home/private/tool 1.0\\n'\n", encoding="utf-8")
        pathy.chmod(0o700)
        self.assertNotIn("/home/private", Adapter("codex", str(pathy)).probe()["version"])

    def test_adapter_timeout_kills_process_group_and_bounds_output(self):
        pidfile=Path(self.tmp.name)/"child.pid"; script=Path(self.tmp.name)/"forking"
        script.write_text("#!/bin/sh\nyes X &\necho $! > '%s'\nsleep 30\n"%pidfile,encoding="utf-8"); script.chmod(0o700)
        result=Adapter("codex",str(script),timeout_seconds=.1).probe()
        self.assertEqual(result["error"],"version probe timed out")
        if pidfile.exists():
            child=int(pidfile.read_text().strip())
            for _ in range(20):
                try: os.kill(child,0)
                except ProcessLookupError: break
                time.sleep(.01)
            else: self.fail("probe descendant survived timeout")

    def test_adapter_observer_uses_only_operator_attested_receipts(self):
        script = Path(self.tmp.name) / "fake-adapter"
        marker = Path(self.tmp.name) / "executed"
        script.write_text("#!/bin/sh\ntouch %s\nprintf 'fake 1.0\\n'\n" % marker, encoding="utf-8")
        script.chmod(0o700)
        self.store.record_adapter_receipt(
            "codex", "fake 1.0", "READY", "READY", "f" * 64, hashlib.sha256(script.read_bytes()).hexdigest(),
            "ISOLATED_ROUTE_PROBE", 600,
        )
        adapter=Adapter("codex",str(script))
        server = serve(self.store, [adapter], port=0)
        try:
            status, body, _ = self.request(server, "GET", "/v1/adapters")
            self.assertEqual(status, 200)
            self.assertFalse(marker.exists(), "observer must not execute adapter probes")
            result = json.loads(body)[0]
        finally:
            server.server_close()
        self.assertFalse(result["ready"])
        identity=validate_identities([adapter],self.store.snapshot()["adapter_receipts"])
        result=statuses([],self.store.snapshot()["adapter_receipts"],identities=identity)[0]
        self.assertTrue(result["ready"])
        self.assertEqual(result["attestation"], "operator-attested")
        self.assertNotIn("note", result)
        stale = dict(self.store.snapshot()["adapter_receipts"][0], expires_at=0)
        result = statuses([], [stale], now=1, identities={"codex":{"current":True,"checked_at":1}})[0]
        self.assertFalse(result["ready"])
        self.assertFalse(result["auth_ready"])
        self.assertFalse(result["route_ready"])
        checked=identity["codex"]["checked_at"]
        aged=statuses([],self.store.snapshot()["adapter_receipts"],now=checked+3601,identities=identity)[0]
        self.assertFalse(aged["ready"]); self.assertFalse(aged["identity_current"])

    def test_adapter_identity_refresh_happens_outside_request(self):
        self.store.record_adapter_receipt("codex","v","READY","READY","a"*64,"b"*64,"ISOLATED_ROUTE_PROBE",600)
        refreshed={"calls":0}
        def refresh():
            refreshed["calls"]+=1
            return {"codex":{"current":False,"checked_at":time.time()}}
        server=serve(self.store,[],port=0,adapter_identities={"codex":{"current":True,"checked_at":time.time()}},adapter_identity_refresh=refresh,identity_refresh_seconds=60)
        try:
            server.next_identity_refresh=0; server.service_actions(); self.assertEqual(refreshed["calls"],1)
            status,body,_=self.request(server,"GET","/v1/adapters")
            self.assertEqual(status,200); self.assertFalse(json.loads(body)[0]["ready"]); self.assertEqual(refreshed["calls"],1)
        finally: server.server_close()

    def test_cli_exit_propagates(self):
        self.assertEqual(main(["--config", str(Path(self.tmp.name) / "missing.json"), "--state-dir", self.tmp.name, "doctor"]), 2)
        self.assertEqual(main(["--state-dir", "relative", "doctor"]), 2)

    def test_config_cannot_enable_execution(self):
        config = Path(self.tmp.name) / "config.json"
        config.write_text(json.dumps({"adapters":{"codex":{"execute_enabled":True}}}), encoding="utf-8")
        self.assertEqual(main(["--config", str(config), "--state-dir", self.tmp.name, "doctor"]), 2)

    def test_record_adapter_hashes_regular_evidence_and_expires(self):
        script = Path(self.tmp.name) / "fake-version"
        script.write_text("#!/bin/sh\nprintf 'fake 1.0\\n'\n", encoding="utf-8")
        script.chmod(0o700)
        state = Path(self.tmp.name) / "receipt-state"
        evidence = Path(self.tmp.name) / "route-receipt.txt"
        evidence.write_text("adapter=codex\nauth=READY\nroute=READY\n", encoding="utf-8")
        config = Path(self.tmp.name) / "receipt-config.json"
        config.write_text(json.dumps({"adapters":{"codex":{"path":str(script)}}}), encoding="utf-8")
        rc = main([
            "--config", str(config), "--state-dir", str(state), "record-adapter", "codex",
            "--version", "fake 1.0", "--auth-status", "READY", "--route-status", "READY",
            "--evidence-file", str(evidence), "--reason-code", "ISOLATED_ROUTE_PROBE",
            "--ttl-seconds", "600",
        ])
        self.assertEqual(rc, 0)
        with Store(str(state)) as recorded:
            row = recorded.snapshot()["adapter_receipts"][0]
            self.assertEqual(row["evidence_sha256"], hashlib.sha256(evidence.read_bytes()).hexdigest())
            self.assertGreater(row["expires_at"], row["checked_at"])
            self.assertEqual(row["method"], "operator-attested-isolated-probe-v1")

    def test_observer_routes_methods_cursor_and_task(self):
        server = serve(self.store, [], port=0)
        try:
            status, body, headers = self.request(server, "GET", "/v1/tasks/%s" % self.task)
            self.assertEqual(status, 200); self.assertEqual(json.loads(body)["id"], self.task)
            self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
            status, body, _ = self.request(server, "GET", "/v1/events?after=0")
            self.assertEqual(status, 200); self.assertTrue(json.loads(body))
            status, _, headers = self.request(server, "POST", "/v1/tasks")
            self.assertEqual(status, 405); self.assertEqual(headers["Allow"], "GET")
            status, _, _ = self.request(server, "GET", "/v1/events?after=no")
            self.assertEqual(status, 400)
        finally:
            server.server_close()

    def test_event_cursor_pages_forward_without_history_gap(self):
        for number in range(110): self.store.incident("test",str(number))
        server=serve(self.store,[],port=0)
        try:
            status,body,_=self.request(server,"GET","/v1/events?after=0")
            first=json.loads(body); self.assertEqual(status,200); self.assertEqual(len(first),100)
            self.assertEqual([row["seq"] for row in first],sorted(row["seq"] for row in first))
            status,body,_=self.request(server,"GET","/v1/events?after=%d"%first[-1]["seq"])
            second=json.loads(body); self.assertEqual(status,200); self.assertTrue(second)
            self.assertEqual(second[0]["seq"],first[-1]["seq"]+1)
        finally: server.server_close()

    def test_reconciliation_observer_is_path_free_summary(self):
        self.store.record_reconciliation(self.campaign,{"inventory_at":1.0,"safe_to_promote":False,"worktree_count":17,"dirty_worktree_count":3,"disposition_counts":{"EXTERNAL_UNRECONCILED":17},"local_main_ahead":0,"local_main_behind":3,"cached_origin_main":"a"*40,"remote_ref_freshness":"unknown; cached local ref; no fetch performed","repo":"/home/private/kizuki"})
        server=serve(self.store,[],port=0)
        try:
            status,body,_=self.request(server,"GET","/v1/reconciliation"); result=json.loads(body)
            self.assertEqual(status,200); self.assertEqual(result["worktree_count"],17); self.assertEqual(result["local_main_behind"],3)
            self.assertNotIn(b"/home/private",body); self.assertFalse(result["safe_to_promote"]); self.assertEqual(result["remote_ref_freshness"],"CACHED_UNVERIFIED")
        finally: server.server_close()

    def test_reconciliation_summary_rejects_strings_in_typed_fields(self):
        secret="SENSITIVE-RECONCILIATION-STRING"
        self.store.record_reconciliation(self.campaign,{"inventory_at":secret,"safe_to_promote":False,"worktree_count":secret,"dirty_worktree_count":secret,"disposition_counts":{secret:1,"EXTERNAL_UNRECONCILED":secret},"local_main_ahead":secret,"local_main_behind":secret,"cached_origin_main":secret,"remote_ref_freshness":secret})
        server=serve(self.store,[],port=0)
        try:
            status,body,_=self.request(server,"GET","/v1/reconciliation"); result=json.loads(body)
            self.assertEqual(status,200); self.assertNotIn(secret.encode(),body)
            self.assertIsNone(result["cached_origin_main"]); self.assertEqual(result["remote_ref_freshness"],"UNKNOWN"); self.assertEqual(result["disposition_counts"],{})
        finally: server.server_close()

    def test_observer_dtos_exclude_sensitive_stored_payloads(self):
        secret = "SENSITIVE-UNPUBLISHABLE-STRING"
        self.store.incident("crash", secret)
        self.store.record_adapter_receipt(
            "codex", "safe version", "READY", "READY", "a" * 64, "b" * 64,
            "ISOLATED_ROUTE_PROBE", 600,
        )
        # A source-like scope is legitimate ledger state but never observer data.
        private_task = self.store.create_task(self.campaign, "src/" + secret)
        server = serve(self.store, [], port=0)
        try:
            for path in ("/v1/incidents", "/v1/receipts", "/v1/events", "/v1/adapters", "/v1/tasks"):
                status, body, _ = self.request(server, "GET", path)
                self.assertEqual(status, 200)
                self.assertNotIn(secret.encode(), body, path)
            incidents = json.loads(self.request(server, "GET", "/v1/incidents")[1])
            self.assertNotIn("detail", incidents[0])
            tasks = json.loads(self.request(server, "GET", "/v1/tasks")[1])
            self.assertTrue(any(row["id"] == private_task for row in tasks))
            self.assertTrue(all("scope" not in row for row in tasks))
        finally:
            server.server_close()

    def test_non_loopback_refused_and_health_is_truthful(self):
        with self.assertRaises(ValueError): serve(self.store, [], host="0.0.0.0", port=0)
        server = serve(self.store, [], port=0, guard=Guard(Limits(min_free_bytes=10**30)))
        try:
            status, body, _ = self.request(server, "GET", "/v1/health")
            self.assertEqual(status, 503); self.assertFalse(json.loads(body)["ok"])
        finally:
            server.server_close()

    def test_all_observer_data_routes_fail_closed_on_projection_corruption(self):
        self.store.db.execute("UPDATE campaigns SET state='RELEASED' WHERE id=?", (self.campaign,))
        server = serve(self.store, [], port=0)
        try:
            status, body, _ = self.request(server, "GET", "/v1/campaign")
            self.assertEqual(status, 503)
            self.assertNotIn(b"RELEASED", body)
        finally:
            server.server_close()
