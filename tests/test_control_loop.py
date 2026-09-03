import hashlib
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path

from gauntlet.adapters import Adapter
from gauntlet.control_loop import ControlLoop, LoopAlreadyRunning
from gauntlet.core import Limits, Store


class ControlLoopTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        with Store(self.tmp.name) as store:
            store.claim_controller()
            self.campaign = store.create_campaign()

    def tearDown(self):
        self.tmp.cleanup()

    def status(self):
        return json.loads((Path(self.tmp.name) / "loop-status.json").read_text(encoding="utf-8"))

    def test_tick_is_private_atomic_and_execution_disabled(self):
        loop = ControlLoop(self.tmp.name, Limits(min_free_bytes=1), session_id="session-a")
        result = loop.tick()
        path = Path(self.tmp.name) / "loop-status.json"
        self.assertEqual(result["state"], "DEGRADED")
        self.assertEqual(result["schema"], "kizuki-gauntlet-loop-status-v1")
        self.assertFalse(result["execution_enabled"])
        self.assertFalse(result["merge_enabled"])
        self.assertEqual(result["summary"]["campaigns"]["count"], 1)
        self.assertEqual(len(result["adapters"]), 4)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(self.status(), result)
        self.assertFalse(any(Path(self.tmp.name).glob(".loop-status-*.tmp")))

    def test_duplicate_loop_is_excluded(self):
        first = ControlLoop(self.tmp.name, Limits(min_free_bytes=1))
        second = ControlLoop(self.tmp.name, Limits(min_free_bytes=1))
        first._open_lock()
        try:
            with self.assertRaises(LoopAlreadyRunning):
                second._open_lock()
        finally:
            first._close_lock()

    def test_degraded_receipt_state_never_enables_work(self):
        with Store(self.tmp.name) as store:
            store.claim_controller()
            store.record_adapter_receipt("claude", "v", "READY", "QUOTA_BLOCKED", "a" * 64, "b" * 64, "PROVIDER_QUOTA_BLOCKED", 60)
        result = ControlLoop(self.tmp.name, Limits(min_free_bytes=1)).tick()
        claude = next(item for item in result["adapters"] if item["name"] == "claude")
        self.assertEqual(claude["route_status"], "QUOTA_BLOCKED")
        self.assertFalse(claude["ready"])
        self.assertEqual(result["state"], "DEGRADED")
        self.assertFalse(result["execution_enabled"])

    def test_four_fresh_receipts_with_current_identities_are_running(self):
        executable = Path(self.tmp.name) / "harness"
        executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        executable.chmod(0o700)
        executable_sha = hashlib.sha256(executable.read_bytes()).hexdigest()
        adapters = tuple(Adapter(name, str(executable)) for name in ("codex", "claude", "cursor", "grok"))
        with Store(self.tmp.name) as store:
            store.claim_controller()
            for adapter in adapters:
                store.record_adapter_receipt(adapter.name, "v", "READY", "READY", "a" * 64, executable_sha, "ISOLATED_ROUTE_PROBE", 60)
        result = ControlLoop(self.tmp.name, Limits(min_free_bytes=1), adapters=adapters).tick()
        self.assertEqual(result["state"], "RUNNING")
        self.assertTrue(all(item["ready"] for item in result["adapters"]))
        self.assertFalse(result["execution_enabled"])

    def test_store_failure_replaces_stale_running_status_with_degraded(self):
        class BrokenStore:
            def __init__(self, _):
                raise RuntimeError("database unavailable")

        path = Path(self.tmp.name) / "loop-status.json"
        path.write_text('{"state":"RUNNING"}\n', encoding="utf-8")
        result = ControlLoop(self.tmp.name, Limits(min_free_bytes=1), store_factory=BrokenStore).tick()
        self.assertEqual(result["state"], "DEGRADED")
        self.assertIn("integrity_or_guard_failed:RuntimeError", result["reasons"])
        self.assertEqual(self.status(), result)

    def test_clean_stop_then_restart_reuses_lock_and_replaces_status(self):
        first = ControlLoop(self.tmp.name, Limits(min_free_bytes=1), session_id="first")
        stopped = first.run(max_iterations=1)
        self.assertEqual(stopped["state"], "STOPPED")
        self.assertEqual(self.status()["session_id"], "first")
        second = ControlLoop(self.tmp.name, Limits(min_free_bytes=1), session_id="second")
        second.run(max_iterations=1)
        status = self.status()
        self.assertEqual(status["state"], "STOPPED")
        self.assertEqual(status["session_id"], "second")
        self.assertEqual(stat.S_IMODE((Path(self.tmp.name) / "loop-status.json").stat().st_mode), 0o600)

    def test_source_has_no_execution_or_network_paths(self):
        source = (Path(__file__).parents[1] / "gauntlet" / "control_loop.py").read_text(encoding="utf-8")
        for forbidden in ("import subprocess", "import socket", "import urllib", ".execute(", "import requests"):
            self.assertNotIn(forbidden, source)
        unit = (Path(__file__).parents[1] / "systemd" / "kizuki-gauntlet-loop.service").read_text(encoding="utf-8")
        self.assertIn("RestrictAddressFamilies=AF_UNIX", unit)
        self.assertIn("loop", unit)

    def test_sigterm_style_stop_writes_stopped_receipt(self):
        loop = ControlLoop(self.tmp.name, Limits(min_free_bytes=1), session_id="signal")
        loop.request_stop()
        result = loop.run(max_iterations=1)
        self.assertEqual(result["state"], "STOPPED")
        self.assertEqual(result["reasons"], ["clean_stop_requested"])
