import http.client
import tempfile
import threading
import time
import unittest
from pathlib import Path

from gauntlet.adapters import Adapter
from gauntlet.core import (
    ConflictError,
    FencedError,
    Guard,
    GuardError,
    Limits,
    Store,
    validate_change_plan,
)
from gauntlet.http import serve


SHA = "a" * 40


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(self.temp.name)
        self.store.claim_controller()
        self.campaign = self.store.create_campaign()
        self.store.record_reconciliation(
            self.campaign, {"safe_to_promote": True, "worktrees": []}
        )
        version = self.store.snapshot()["campaigns"][0]["version"]
        version = self.store.campaign_state(self.campaign, "READY", version)
        self.store.campaign_state(self.campaign, "ACTIVE", version)
        self.task = self.store.create_task(self.campaign, "src/retrieval")
        version = self.store.snapshot()["tasks"][0]["version"]
        self.store.task_state(self.task, "READY", version)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def test_cas_and_race_lease(self):
        token = self.store.acquire(self.task, "global/merge", "worker-a")
        with self.assertRaises((ConflictError, FencedError)):
            self.store.acquire(self.task, "global/merge", "worker-b")
        version = self.store.db.execute(
            "SELECT version FROM tasks WHERE id=?", (self.task,)
        ).fetchone()[0]
        self.store.task_state(
            self.task,
            "RUNNING",
            version,
            scope="global/merge",
            holder="worker-a",
            token=token,
        )
        with self.assertRaises(ConflictError):
            self.store.task_state(self.task, "SUBMITTED", version)
        self.assertEqual(token, 1)

    def test_expired_fencing(self):
        token = self.store.acquire(self.task, "task/fence", "worker-a", ttl=0.01)
        time.sleep(0.02)
        with self.assertRaises(FencedError):
            self.store.heartbeat("task/fence", "worker-a", token, task_id=self.task)

        version = self.store.snapshot()["tasks"][0]["version"]
        version = self.store.task_state(self.task, "RECOVERING", version)
        self.store.task_state(self.task, "READY", version)
        next_token = self.store.acquire(self.task, "task/fence", "worker-b")
        with self.assertRaises(FencedError):
            self.store.release("task/fence", "worker-a", token, task_id=self.task)
        self.assertGreater(next_token, token)

    def test_crash_replay(self):
        self.store.close()
        for suffix in ("", "-wal", "-shm"):
            path = Path(self.temp.name) / ("state.sqlite3" + suffix)
            if path.exists():
                path.unlink()
        recovered = Store(self.temp.name)
        recovered.claim_controller()
        try:
            self.assertEqual(len(recovered.snapshot()["campaigns"]), 1)
            self.assertEqual(len(recovered.snapshot()["tasks"]), 1)
            self.assertTrue(recovered.verify_integrity())
        finally:
            recovered.close()
        # The original handle is closed; replace it so tearDown stays idempotent.
        self.store = Store(self.temp.name)

    def test_forbidden_paths_and_weaken_tests(self):
        with self.assertRaises(GuardError):
            self.store.create_task(self.campaign, "../.git/config")
        with self.assertRaises(GuardError):
            validate_change_plan(["src/a"], ["rm tests/test_core.py"])
        with self.assertRaises(GuardError):
            validate_change_plan(["/etc/passwd"])

    def test_receipt(self):
        token = self.store.acquire(self.task, "task/receipt", "worker")
        self.store.receipt(
            self.task,
            SHA,
            ["python -m unittest"],
            "task/receipt",
            "worker",
            token,
        )
        receipt = self.store.snapshot()["receipts"][0]
        self.assertEqual(receipt["sha"], SHA)
        self.assertEqual(receipt["token"], token)

    def test_adapter_probe_is_nonsecret(self):
        result = Adapter("x", "/not/found").probe()
        self.assertTrue(result["probe_only"])
        self.assertFalse(result["ready"])

    def test_disk_guard(self):
        with self.assertRaises(GuardError):
            Guard(Limits(min_free_bytes=10**30)).check(self.store)

    def test_readonly_http(self):
        server = serve(self.store, [], port=0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        port = server.server_address[1]
        try:
            connection = http.client.HTTPConnection("127.0.0.1", port)
            connection.request("GET", "/v1/health")
            response = connection.getresponse()
            response.read()
            self.assertEqual(response.status, 200)
            connection.close()

            connection = http.client.HTTPConnection("127.0.0.1", port)
            connection.request("POST", "/v1/tasks")
            response = connection.getresponse()
            response.read()
            self.assertEqual(response.status, 405)
            connection.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
