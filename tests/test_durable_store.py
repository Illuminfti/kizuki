import hashlib
import inspect
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from gauntlet import durable_store as durable_store_module
from gauntlet.core import GuardError, Store
from gauntlet.durable_store import DurableProtocolStore, DurableStoreError


class InjectedCrash(RuntimeError):
    pass


class DurableStoreMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.seed_v1(self.root)

    @staticmethod
    def populate_v1(store):
        store.claim_controller()
        campaign = store.create_campaign("campaign-1")
        store.record_reconciliation(campaign, {"safe_to_promote": True})
        version = store.snapshot()["campaigns"][0]["version"]
        version = store.campaign_state(campaign, "READY", version)
        store.campaign_state(campaign, "ACTIVE", version)
        task = store.create_task(campaign, "scope/example", "task-1")
        version = store.snapshot()["tasks"][0]["version"]
        version = store.task_state(task, "READY", version)
        token = store.acquire(task, "scope/example", "legacy-worker")
        version = store.snapshot()["tasks"][0]["version"]
        version = store.task_state(
            task, "RUNNING", version, "scope/example", "legacy-worker", token
        )
        store.task_state(
            task, "SUBMITTED", version, "scope/example", "legacy-worker", token
        )
        store.receipt(
            task, "a" * 40, ["synthetic legacy evidence"],
            "scope/example", "legacy-worker", token,
        )

    @classmethod
    def seed_v1(cls, root):
        with Store(str(root)) as store:
            cls.populate_v1(store)

    @classmethod
    def seed_wal_v1(cls, root):
        with tempfile.TemporaryDirectory(dir=root.parent) as case:
            source = Path(case) / "source"
            store = Store(str(source))
            try:
                store.db.execute("PRAGMA wal_autocheckpoint=0")
                cls.populate_v1(store)
                required = {"state.sqlite3", "state.sqlite3-wal", "state.sqlite3-shm"}
                present = {path.name for path in source.iterdir() if path.is_file()}
                if not required <= present:
                    raise AssertionError("synthetic v1 fixture did not retain DB/WAL/SHM")
                shutil.copytree(source, root)
            finally:
                store.close()

    @staticmethod
    def seed_disposition_v1(root):
        states = (
            "DISCOVERED", "READY", "LEASED", "RUNNING", "SUBMITTED",
            "VERIFYING", "REVIEWING", "INTEGRATING", "MERGED",
            "POST_MERGE_VERIFYING", "CHANGES_REQUESTED", "RECOVERING",
            "FAILED", "SUPERSEDED", "DONE",
        )
        with Store(str(root)) as store:
            store.claim_controller()
            campaign = store.create_campaign("active-campaign")
            store.record_reconciliation(campaign, {"safe_to_promote": True})
            version = store.snapshot()["campaigns"][0]["version"]
            version = store.campaign_state(campaign, "READY", version)
            store.campaign_state(campaign, "ACTIVE", version)
            for state in states:
                task_id = "task-" + state.lower().replace("_", "-")
                store.create_task(campaign, "scope/" + task_id, task_id)
                if state == "DISCOVERED":
                    continue
                if state == "LEASED":
                    version = next(
                        item["version"] for item in store.snapshot()["tasks"]
                        if item["id"] == task_id
                    )
                    store.task_state(task_id, "READY", version)
                    store.acquire(task_id, "scope/" + task_id, "legacy-owner")
                    continue
                # These are historical fixtures for known v1 vocabulary that
                # bootstrap intentionally cannot reach through its locked API.
                store._write(lambda: None, "task.state", {"id": task_id, "state": state})
            terminal_states = ("ABORTED", "FAILED", "RELEASED")
            for state in terminal_states:
                campaign_id = "campaign-" + state.lower()
                store.create_campaign(campaign_id)
                store._write(
                    lambda: None, "campaign.state",
                    {"id": campaign_id, "state": state},
                )
            store.create_campaign("campaign-paused")
            store._write(
                lambda: None, "campaign.state",
                {"id": "campaign-paused", "state": "PAUSED"},
            )
            before = {
                item["id"]: item["version"] for item in store.snapshot()["tasks"]
            }
        return before

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def source_file_bytes(root):
        return {
            path.name: path.read_bytes()
            for path in sorted(root.iterdir())
            if path.is_file()
        }

    def source_bytes(self):
        return self.source_file_bytes(self.root)

    @staticmethod
    def event_line(previous, event_type, payload, created_at):
        raw = json.dumps(
            {
                "prev": previous,
                "type": event_type,
                "payload": payload,
                "created_at": created_at,
            },
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("ascii")
        event = {
            "prev": previous,
            "hash": hashlib.sha256(raw).hexdigest(),
            "type": event_type,
            "payload": payload,
            "created_at": created_at,
        }
        return (
            json.dumps(
                event, sort_keys=True, separators=(",", ":"), allow_nan=False,
            ).encode("ascii")
            + b"\n"
        ), event["hash"]

    def test_preflight_reports_v1_inventory_without_changing_source_bytes(self):
        before = self.source_bytes()
        ledger = before["events.jsonl"]
        before_stats = {
            path.name: (
                path.stat().st_dev, path.stat().st_ino, path.stat().st_mode,
                path.stat().st_nlink, path.stat().st_size, path.stat().st_atime_ns,
                path.stat().st_mtime_ns, path.stat().st_ctime_ns,
            )
            for path in sorted(self.root.iterdir()) if path.is_file()
        }

        report = DurableProtocolStore(self.root).preflight_migration()

        after_stats = {
            path.name: (
                path.stat().st_dev, path.stat().st_ino, path.stat().st_mode,
                path.stat().st_nlink, path.stat().st_size, path.stat().st_atime_ns,
                path.stat().st_mtime_ns, path.stat().st_ctime_ns,
            )
            for path in sorted(self.root.iterdir()) if path.is_file()
        }

        self.assertEqual(report.schema_version, 1)
        self.assertEqual(report.state, "V1_READY")
        self.assertEqual(report.ledger_prefix_bytes, len(ledger))
        self.assertEqual(report.ledger_prefix_sha256, hashlib.sha256(ledger).hexdigest())
        self.assertEqual(before_stats, after_stats)
        self.assertEqual(before, self.source_bytes())

    def test_preflight_rejects_duplicate_ledger_keys_without_changing_source(self):
        path = self.root / "events.jsonl"
        lines = path.read_bytes().splitlines()
        first = json.loads(lines[0])
        lines[0] = lines[0][:-1] + (
            b',"type":' + json.dumps(first["type"]).encode("ascii") + b"}"
        )
        ambiguous = b"\n".join(lines) + b"\n"
        path.write_bytes(ambiguous)

        with self.assertRaisesRegex(DurableStoreError, "duplicate"):
            DurableProtocolStore(self.root).preflight_migration()

        self.assertEqual(path.read_bytes(), ambiguous)

    def test_preflight_rejects_noncanonical_nonfinite_and_deep_ledger_json(self):
        defects = ("whitespace", "nan", "nested-duplicate", "depth")
        for defect in defects:
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as case:
                root = Path(case) / "state"
                self.seed_v1(root)
                path = root / "events.jsonl"
                lines = path.read_bytes().splitlines()
                first = json.loads(lines[0])
                if defect == "whitespace":
                    lines[0] = json.dumps(first, sort_keys=True).encode("ascii")
                    message = "canonical"
                elif defect == "nan":
                    marker = (
                        b'"created_at":'
                        + json.dumps(first["created_at"]).encode("ascii")
                    )
                    lines[0] = lines[0].replace(marker, b'"created_at":NaN', 1)
                    message = "non-finite"
                elif defect == "nested-duplicate":
                    key, value = next(iter(first["payload"].items()))
                    duplicate = (
                        json.dumps(key).encode("ascii") + b":"
                        + json.dumps(value, separators=(",", ":")).encode("ascii")
                        + b","
                    )
                    lines[0] = lines[0].replace(
                        b'"payload":{', b'"payload":{' + duplicate, 1,
                    )
                    message = "duplicate"
                else:
                    nested = 1
                    for _ in range(40):
                        nested = [nested]
                    lines[0], _ = self.event_line(
                        "0" * 64, first["type"], {"epoch": nested},
                        first["created_at"],
                    )
                    lines[0] = lines[0][:-1]
                    message = "depth"
                hostile = b"\n".join(lines) + b"\n"
                path.write_bytes(hostile)

                with self.assertRaisesRegex(DurableStoreError, message):
                    DurableProtocolStore(root).preflight_migration()

                self.assertEqual(path.read_bytes(), hostile)

    def test_preflight_enforces_ledger_total_and_line_byte_bounds(self):
        cases = (("total", "total byte"), ("line", "line byte"))
        for defect, message in cases:
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as case:
                root = Path(case) / "state"
                self.seed_v1(root)
                path = root / "events.jsonl"
                if defect == "total":
                    with path.open("r+b") as stream:
                        stream.truncate(64 * 1024 * 1024 + 1)
                else:
                    path.write_bytes(b"{" + b" " * (1024 * 1024) + b"}\n")

                with self.assertRaisesRegex(DurableStoreError, message):
                    DurableProtocolStore(root).preflight_migration()

    def test_ledger_read_rejects_swap_between_admission_and_open(self):
        with tempfile.TemporaryDirectory() as case:
            root = Path(case) / "state"
            self.seed_wal_v1(root)
            target = root / "events.jsonl"
            original = target.read_bytes()
            replacement = root / "events.replacement"
            replacement.write_bytes(original + b"x")
            replacement.chmod(0o600)
            real_stat = os.stat
            ledger_stats = 0

            def racing_stat(path, *args, **kwargs):
                nonlocal ledger_stats
                if path == "events.jsonl":
                    ledger_stats += 1
                    if ledger_stats == 2:
                        replacement.replace(target)
                return real_stat(path, *args, **kwargs)

            handle = DurableProtocolStore(root)
            try:
                with mock.patch.object(
                    durable_store_module, "_MAX_LEDGER_BYTES", len(original),
                ), mock.patch.object(durable_store_module.os, "stat", racing_stat):
                    with self.assertRaisesRegex(
                        DurableStoreError, "changed while being opened|total byte bound",
                    ):
                        handle._read_ledger()
            finally:
                handle.close()

    def test_ledger_read_rejects_same_size_change_during_pread(self):
        with tempfile.TemporaryDirectory() as case:
            root = Path(case) / "state"
            self.seed_wal_v1(root)
            target = root / "events.jsonl"
            original = target.read_bytes()
            real_pread = os.pread
            changed = False

            def racing_pread(fd, count, offset):
                nonlocal changed
                chunk = real_pread(fd, count, offset)
                if not changed:
                    changed = True
                    hostile = bytearray(original)
                    hostile[0] = ord("[") if hostile[0] != ord("[") else ord("{")
                    target.write_bytes(hostile)
                    target.chmod(0o600)
                return chunk

            handle = DurableProtocolStore(root)
            try:
                with mock.patch.object(
                    durable_store_module.os, "pread", racing_pread,
                ):
                    with self.assertRaisesRegex(
                        DurableStoreError, "changed while being read",
                    ):
                        handle._read_ledger()
            finally:
                handle.close()

    def test_preflight_enforces_ledger_event_count_bound(self):
        path = self.root / "events.jsonl"
        original_ledger = path.read_bytes()
        ledger = bytearray()
        previous = "0" * 64
        for sequence in range(4):
            line, previous = self.event_line(
                previous, "incident",
                {"id": f"i-{sequence}", "kind": "synthetic", "detail": "bounded"},
                sequence,
            )
            ledger.extend(line)
        path.write_bytes(ledger)
        self.assertEqual(durable_store_module._MAX_LEDGER_EVENTS, 65_536)

        with mock.patch.object(durable_store_module, "_MAX_LEDGER_EVENTS", 3):
            with self.assertRaisesRegex(DurableStoreError, "event count"):
                DurableProtocolStore(self.root).preflight_migration()

        path.write_bytes(original_ledger)
        exact_v1_count = len(original_ledger.splitlines())
        with mock.patch.object(
            durable_store_module, "_MAX_LEDGER_EVENTS", exact_v1_count,
        ):
            with self.assertRaisesRegex(DurableStoreError, "schema.v2.*event bound"):
                DurableProtocolStore(self.root).preflight_migration()

    def test_explicit_migration_appends_one_event_and_marks_legacy_receipt_nonauthoritative(self):
        original = (self.root / "events.jsonl").read_bytes()
        handle = DurableProtocolStore(self.root)

        result = handle.migrate_v1_to_v2()

        migrated = (self.root / "events.jsonl").read_bytes()
        appended = migrated[len(original):]
        self.assertEqual(migrated[:len(original)], original)
        self.assertEqual(len(appended.splitlines()), 1)
        self.assertEqual(json.loads(appended)["type"], "schema.v2")
        self.assertEqual((result.schema_version, result.state), (2, "COMMITTED"))
        receipts = handle.legacy_receipts()
        self.assertEqual(len(receipts), 1)
        self.assertEqual((receipts[0].schema_version, receipts[0].authoritative), (1, 0))

    def test_public_projection_reads_reject_committed_rows_not_in_ledger(self):
        handle = DurableProtocolStore(self.root)
        handle.migrate_v1_to_v2()
        handle.close()

        db = sqlite3.connect(self.root / "state.sqlite3")
        try:
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("UPDATE receipts SET authoritative=1")
            db.rollback()
            db.execute("PRAGMA ignore_check_constraints=ON")
            db.execute("UPDATE receipts SET authoritative=1")
            db.commit()
        finally:
            db.close()

        handle = DurableProtocolStore(self.root)
        try:
            for method_name in (
                "legacy_receipts", "migration_view", "projection_digest",
            ):
                with self.subTest(method=method_name):
                    with self.assertRaisesRegex(
                        DurableStoreError,
                        "committed projection|legacy receipt",
                    ):
                        getattr(handle, method_name)()
        finally:
            handle.close()

    def test_public_surface_is_migration_and_replay_only(self):
        self.assertEqual(
            set(durable_store_module.__all__),
            {
                "DurableProtocolStore", "DurableStoreError", "LegacyReceipt",
                "MigratedCampaign", "MigratedTask", "MigrationPreflight",
                "MigrationResult", "MigrationView", "ReplayProjection",
            },
        )
        self.assertEqual(
            tuple(inspect.signature(DurableProtocolStore).parameters),
            ("state_dir",),
        )
        self.assertEqual(
            tuple(inspect.signature(DurableProtocolStore.migrate_v1_to_v2).parameters),
            ("self",),
        )
        handle = DurableProtocolStore(self.root)
        try:
            for forbidden in (
                "claim_controller", "register_identity", "claim_phase",
                "heartbeat", "commit_phase", "reject_phase", "preflight",
                "migrate", "bind_task_destination", "recover_runtime_tail",
            ):
                self.assertFalse(hasattr(handle, forbidden), forbidden)
        finally:
            handle.close()

    def test_v2_projection_contains_only_adr_migration_tables_and_columns(self):
        DurableProtocolStore(self.root).migrate_v1_to_v2()
        db = sqlite3.connect(self.root / "state.sqlite3")
        try:
            tables = {
                row[0] for row in db.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' "
                    "AND name NOT LIKE 'sqlite_%'"
                )
            }
            self.assertEqual(
                tables,
                {
                    "controller", "campaigns", "tasks", "leases", "fences",
                    "receipts", "incidents", "reconciliation",
                    "adapter_receipts", "events", "schema_metadata",
                    "phase_leases", "phase_receipts", "merge_claims",
                    "merge_operations", "merge_recovery_tasks",
                },
            )

            def columns(table):
                return tuple(row[1] for row in db.execute(f"PRAGMA table_info({table})"))

            self.assertEqual(
                columns("tasks")[-4:],
                ("subject_sha", "merge_sha", "active_role", "recovery_from"),
            )
            self.assertEqual(
                columns("receipts")[-2:], ("schema_version", "authoritative"),
            )
            self.assertEqual(
                columns("phase_leases"),
                (
                    "resource", "task_id", "attempt", "role", "run_id",
                    "principal_id", "token", "expires_at", "heartbeat_at", "epoch",
                ),
            )
            self.assertEqual(
                columns("phase_receipts"),
                (
                    "id", "task_id", "attempt", "phase", "role", "principal_id",
                    "verdict", "subject_sha", "base_sha", "result_sha",
                    "evidence_sha256", "github_evidence_id", "lease_resource",
                    "lease_token", "merge_fence_token", "epoch", "authoritative",
                    "created_at",
                ),
            )
            self.assertEqual(
                columns("merge_claims"),
                (
                    "resource", "token", "task_id", "attempt", "subject_sha",
                    "base_sha", "pr_number", "merge_operation_id",
                    "grant_generation", "status", "epoch",
                    "linked_remediation_task_id", "updated_at",
                ),
            )
            self.assertEqual(
                columns("merge_operations"),
                (
                    "merge_operation_id", "task_id", "attempt",
                    "grant_generation", "parent_merge_operation_id",
                    "request_state", "grant_sha256", "request_sha256",
                    "response_sha256", "epoch", "updated_at",
                ),
            )
            unique_shapes = {
                tuple(item[2] for item in db.execute(f"PRAGMA index_info('{row[1]}')"))
                for row in db.execute("PRAGMA index_list('phase_receipts')")
                if row[2]
            }
            self.assertIn(
                ("task_id", "attempt", "phase", "role"), unique_shapes,
            )
        finally:
            db.close()

    def test_every_migration_crash_point_resumes_without_duplicate_schema_event(self):
        stages = (
            "before_ddl", "after_ddl", "after_ledger_fsync",
            "before_projection_commit",
        )
        for stage in stages:
            for repetition in range(2):
                with self.subTest(stage=stage, repetition=repetition), tempfile.TemporaryDirectory() as case:
                    root = Path(case) / "state"
                    self.seed_wal_v1(root)
                    original = (root / "events.jsonl").read_bytes()

                    def crash(observed):
                        if observed == stage:
                            raise InjectedCrash(stage)

                    with mock.patch.object(durable_store_module, "_CRASH_HOOK", crash):
                        with self.assertRaisesRegex(InjectedCrash, stage):
                            DurableProtocolStore(root).migrate_v1_to_v2()

                    prepared = DurableProtocolStore(root).preflight_migration()
                    expected_state = "V1_READY" if stage == "before_ddl" else "PREPARED"
                    self.assertEqual(prepared.state, expected_state)
                    first = DurableProtocolStore(root).migrate_v1_to_v2()
                    once = (root / "events.jsonl").read_bytes()
                    second = DurableProtocolStore(root).migrate_v1_to_v2()
                    twice = (root / "events.jsonl").read_bytes()

                    self.assertEqual(once[:len(original)], original)
                    self.assertEqual(len(once[len(original):].splitlines()), 1)
                    self.assertEqual(once, twice)
                    self.assertEqual(first.schema_event_hash, second.schema_event_hash)

    def test_abrupt_process_death_at_every_migration_hook_resumes_exactly_once(self):
        stages = (
            "before_ddl", "after_ddl", "during_ledger_append",
            "after_ledger_fsync", "before_projection_commit",
        )
        repository = Path(__file__).resolve().parents[1]
        program = """
import os
import sys
from gauntlet import durable_store
from gauntlet.durable_store import DurableProtocolStore

stage = sys.argv[2]
def crash(observed):
    if observed == stage:
        os._exit(73)

durable_store._CRASH_HOOK = crash
DurableProtocolStore(sys.argv[1]).migrate_v1_to_v2()
os._exit(0)
"""
        child_environment = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "PYTHONPATH": str(repository),
        }
        for stage in stages:
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as case:
                root = Path(case) / "state"
                self.seed_wal_v1(root)
                original = (root / "events.jsonl").read_bytes()
                report = DurableProtocolStore(root).preflight_migration()

                child = subprocess.run(
                    (sys.executable, "-c", program, str(root), stage),
                    cwd=repository,
                    env=child_environment,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    check=False,
                    timeout=30,
                )
                self.assertEqual(child.returncode, 73)
                self.assertEqual(child.stdout, b"")
                self.assertEqual(child.stderr, b"")

                expected_state = "V1_READY" if stage == "before_ddl" else "PREPARED"
                self.assertEqual(
                    DurableProtocolStore(root).preflight_migration().state,
                    expected_state,
                )
                first = DurableProtocolStore(root).migrate_v1_to_v2()
                first_ledger = (root / "events.jsonl").read_bytes()
                second = DurableProtocolStore(root).migrate_v1_to_v2()
                self.assertEqual((root / "events.jsonl").read_bytes(), first_ledger)
                self.assertEqual(first.schema_event_hash, second.schema_event_hash)
                self.assertEqual(first_ledger[:report.ledger_prefix_bytes], original)
                self.assertEqual(
                    len(first_ledger[report.ledger_prefix_bytes:].splitlines()), 1,
                )
                self.assertEqual(
                    first.projection_sha256, first.replay_projection_sha256,
                )
                self.assertTrue(
                    DurableProtocolStore(root).verify_replay_equivalence()
                )

    def test_partial_schema_event_append_resumes_with_persisted_exact_remainder(self):
        for repetition in range(2):
            with self.subTest(repetition=repetition), tempfile.TemporaryDirectory() as case:
                root = Path(case) / "state"
                self.seed_wal_v1(root)
                original = (root / "events.jsonl").read_bytes()

                def crash(observed):
                    if observed == "during_ledger_append":
                        raise InjectedCrash(observed)

                with mock.patch.object(durable_store_module, "_CRASH_HOOK", crash):
                    with self.assertRaisesRegex(InjectedCrash, "during_ledger_append"):
                        DurableProtocolStore(root).migrate_v1_to_v2()

                partial = (root / "events.jsonl").read_bytes()
                self.assertTrue(partial.startswith(original))
                self.assertGreater(len(partial), len(original))
                self.assertFalse(partial.endswith(b"\n"))
                self.assertEqual(
                    DurableProtocolStore(root).preflight_migration().state,
                    "PREPARED",
                )

                result = DurableProtocolStore(root).migrate_v1_to_v2()
                completed = (root / "events.jsonl").read_bytes()
                self.assertTrue(completed.startswith(partial))
                self.assertEqual(len(completed[len(original):].splitlines()), 1)
                self.assertEqual(
                    json.loads(completed[len(original):])["hash"],
                    result.schema_event_hash,
                )

    def test_divergent_partial_schema_tail_fails_closed_without_rewrite(self):
        with tempfile.TemporaryDirectory() as case:
            root = Path(case) / "state"
            self.seed_wal_v1(root)

            def crash(observed):
                if observed == "during_ledger_append":
                    raise InjectedCrash(observed)

            with mock.patch.object(durable_store_module, "_CRASH_HOOK", crash):
                with self.assertRaisesRegex(InjectedCrash, "during_ledger_append"):
                    DurableProtocolStore(root).migrate_v1_to_v2()

            path = root / "events.jsonl"
            divergent = bytearray(path.read_bytes())
            divergent[-1] = ord("X") if divergent[-1] != ord("X") else ord("Y")
            path.write_bytes(divergent)
            before = self.source_file_bytes(root)

            with self.assertRaisesRegex(DurableStoreError, "divergent partial"):
                DurableProtocolStore(root).migrate_v1_to_v2()

            self.assertEqual(before, self.source_file_bytes(root))

    def test_replay_rejects_any_event_after_schema_boundary(self):
        DurableProtocolStore(self.root).migrate_v1_to_v2()
        path = self.root / "events.jsonl"
        committed = path.read_bytes()
        previous = json.loads(committed.splitlines()[-1])["hash"]
        extra, _ = self.event_line(
            previous, "incident",
            {"id": "post-boundary", "kind": "synthetic", "detail": "forbidden"},
            123,
        )
        path.write_bytes(committed + extra)

        with self.assertRaisesRegex(DurableStoreError, "after schema.v2"):
            DurableProtocolStore(self.root).replay_projection()

    def test_forked_handle_and_replaced_root_are_rejected(self):
        handle = DurableProtocolStore(self.root)
        child = os.fork()
        if child == 0:
            try:
                handle.preflight_migration()
            except DurableStoreError as exc:
                os._exit(0 if "different process" in str(exc) else 2)
            except BaseException:
                os._exit(3)
            os._exit(1)
        _, status = os.waitpid(child, 0)
        self.assertTrue(os.WIFEXITED(status))
        self.assertEqual(os.WEXITSTATUS(status), 0)

        displaced = self.root.with_name(self.root.name + "-displaced")
        self.root.rename(displaced)
        self.root.mkdir(mode=0o700)
        try:
            with self.assertRaisesRegex(DurableStoreError, "replaced"):
                handle.preflight_migration()
        finally:
            handle.close()
            self.root.rmdir()
            displaced.rename(self.root)

    def test_ledger_inode_and_content_changes_are_rejected_at_commit_boundaries(self):
        cases = (
            ("during_ledger_append", "inode"),
            ("before_projection_commit", "content"),
        )
        for stage, defect in cases:
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as case:
                root = Path(case) / "state"
                self.seed_wal_v1(root)
                path = root / "events.jsonl"
                changed = False

                def mutate(observed):
                    nonlocal changed
                    if observed != stage or changed:
                        return
                    changed = True
                    if defect == "inode":
                        displaced = root / "events.displaced"
                        path.replace(displaced)
                        path.write_bytes(displaced.read_bytes())
                        path.chmod(0o600)
                    else:
                        data = bytearray(path.read_bytes())
                        data[-2] = ord("X") if data[-2] != ord("X") else ord("Y")
                        path.write_bytes(data)

                with mock.patch.object(durable_store_module, "_CRASH_HOOK", mutate):
                    with self.assertRaisesRegex(
                        DurableStoreError, "ledger.*(replaced|changed)|ledger inode",
                    ):
                        DurableProtocolStore(root).migrate_v1_to_v2()

    def test_writer_lock_and_projection_inode_changes_are_rejected(self):
        cases = (
            ("after_ledger_fsync", ".writer.lock", "writer lock"),
            ("after_ddl", "state.sqlite3", "projection database"),
        )
        for stage, name, message in cases:
            with self.subTest(stage=stage), tempfile.TemporaryDirectory() as case:
                root = Path(case) / "state"
                self.seed_wal_v1(root)
                path = root / name
                changed = False

                def replace_inode(observed):
                    nonlocal changed
                    if observed != stage or changed:
                        return
                    changed = True
                    displaced = root / (name + ".displaced")
                    path.replace(displaced)
                    if name == "state.sqlite3":
                        shutil.copy2(displaced, path)
                    else:
                        path.touch(mode=0o600)
                    path.chmod(0o600)

                with mock.patch.object(
                    durable_store_module, "_CRASH_HOOK", replace_inode,
                ):
                    with self.assertRaisesRegex(DurableStoreError, message):
                        DurableProtocolStore(root).migrate_v1_to_v2()

    def test_preflight_rejects_unknown_and_partial_v1_layouts_without_writes(self):
        mutations = (
            "ALTER TABLE tasks ADD COLUMN unknown_partial TEXT",
            "DROP TABLE reconciliation",
            "CREATE INDEX unknown_index ON tasks(state)",
        )
        for statement in mutations:
            with self.subTest(statement=statement), tempfile.TemporaryDirectory() as case:
                root = Path(case)
                self.seed_v1(root)
                db = sqlite3.connect(root / "state.sqlite3")
                try:
                    db.execute(statement)
                    db.commit()
                finally:
                    db.close()
                before = {
                    path.name: path.read_bytes() for path in root.iterdir() if path.is_file()
                }

                with self.assertRaises(DurableStoreError):
                    DurableProtocolStore(root).preflight_migration()

                after = {
                    path.name: path.read_bytes() for path in root.iterdir() if path.is_file()
                }
                self.assertEqual(before, after)

    def test_schema_classification_bounds_names_before_materialization(self):
        db = sqlite3.connect(":memory:")
        try:
            db.executescript("CREATE TABLE a(x); CREATE TABLE b(x); CREATE TABLE c(x);")
            with mock.patch.object(durable_store_module, "_MAX_SCHEMA_OBJECTS", 2):
                with self.assertRaisesRegex(DurableStoreError, "schema object bound"):
                    durable_store_module._bounded_table_names(db)
        finally:
            db.close()

    def test_preflight_rejects_unknown_ledger_event_without_changing_it(self):
        path = self.root / "events.jsonl"
        ledger = path.read_bytes()
        previous = json.loads(ledger.splitlines()[-1])["hash"]
        created_at = 123.5
        payload = {"bounded": True}
        raw = json.dumps(
            {"prev": previous, "type": "unknown.future", "payload": payload,
             "created_at": created_at},
            sort_keys=True, separators=(",", ":"),
        )
        event = {
            "prev": previous, "hash": hashlib.sha256(raw.encode()).hexdigest(),
            "type": "unknown.future", "payload": payload, "created_at": created_at,
        }
        forged = ledger + json.dumps(event, sort_keys=True, separators=(",", ":")).encode() + b"\n"
        path.write_bytes(forged)

        with self.assertRaisesRegex(DurableStoreError, "unknown ledger event"):
            DurableProtocolStore(self.root).preflight_migration()

        self.assertEqual(path.read_bytes(), forged)

    def test_preflight_rejects_noncanonical_and_oversized_prepared_metadata(self):
        defects = ("whitespace", "duplicate", "nan", "oversized")
        messages = {
            "whitespace": "canonical",
            "duplicate": "duplicate",
            "nan": "non-finite",
            "oversized": "field bounds",
        }
        for defect in defects:
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as case:
                root = Path(case) / "state"
                self.seed_wal_v1(root)

                def crash(stage):
                    if stage == "after_ddl":
                        raise InjectedCrash(stage)

                with mock.patch.object(durable_store_module, "_CRASH_HOOK", crash):
                    with self.assertRaisesRegex(InjectedCrash, "after_ddl"):
                        DurableProtocolStore(root).migrate_v1_to_v2()

                db = sqlite3.connect(root / "state.sqlite3")
                try:
                    original = db.execute(
                        "SELECT disposition_json FROM schema_metadata"
                    ).fetchone()[0]
                    if defect == "whitespace":
                        hostile = json.dumps(json.loads(original), sort_keys=True)
                    elif defect == "duplicate":
                        hostile = original[:-1] + ',"version":1}'
                    elif defect == "nan":
                        hostile = original.replace('"version":1', '"version":NaN', 1)
                    else:
                        db.execute("PRAGMA ignore_check_constraints=ON")
                        hostile = '{"padding":"' + "x" * (1024 * 1024) + '"}'
                    db.execute(
                        "UPDATE schema_metadata SET disposition_json=?",
                        (hostile,),
                    )
                    db.commit()
                finally:
                    db.close()

                with self.assertRaisesRegex(
                    DurableStoreError, messages[defect],
                ):
                    DurableProtocolStore(root).preflight_migration()

    def test_preflight_byte_bounds_dynamic_text_in_metadata_fields(self):
        with tempfile.TemporaryDirectory() as case:
            root = Path(case) / "state"
            self.seed_wal_v1(root)

            def crash(stage):
                if stage == "after_ddl":
                    raise InjectedCrash(stage)

            with mock.patch.object(durable_store_module, "_CRASH_HOOK", crash):
                with self.assertRaisesRegex(InjectedCrash, "after_ddl"):
                    DurableProtocolStore(root).migrate_v1_to_v2()

            db = sqlite3.connect(root / "state.sqlite3")
            try:
                with self.assertRaises(sqlite3.IntegrityError):
                    db.execute(
                        "UPDATE schema_metadata SET disposition_json=?",
                        ("\N{TEST TUBE}" * 262_145,),
                    )
                db.rollback()
                with self.assertRaises(sqlite3.IntegrityError):
                    db.execute(
                        "UPDATE schema_metadata SET schema_event_bytes=?",
                        ("\N{TEST TUBE}" * 262_145,),
                    )
                db.rollback()
                db.execute(
                    "UPDATE schema_metadata SET schema_event_bytes=?",
                    ("\N{TEST TUBE}" * 40,),
                )
                db.commit()
            finally:
                db.close()

            with mock.patch.object(
                durable_store_module, "_MAX_LEDGER_LINE_BYTES", 64,
            ):
                with self.assertRaisesRegex(DurableStoreError, "field bounds"):
                    DurableProtocolStore(root).preflight_migration()

    def test_prepared_projection_rejects_v2_data_before_schema_event(self):
        with tempfile.TemporaryDirectory() as case:
            root = Path(case) / "state"
            self.seed_wal_v1(root)
            original_ledger = (root / "events.jsonl").read_bytes()

            def crash(stage):
                if stage == "after_ddl":
                    raise InjectedCrash(stage)

            with mock.patch.object(durable_store_module, "_CRASH_HOOK", crash):
                with self.assertRaisesRegex(InjectedCrash, "after_ddl"):
                    DurableProtocolStore(root).migrate_v1_to_v2()

            db = sqlite3.connect(root / "state.sqlite3")
            try:
                db.execute("PRAGMA ignore_check_constraints=ON")
                db.execute("UPDATE receipts SET authoritative=1")
                db.commit()
            finally:
                db.close()

            for operation in ("preflight", "migrate"):
                with self.subTest(operation=operation):
                    handle = DurableProtocolStore(root)
                    try:
                        with self.assertRaisesRegex(
                            DurableStoreError, "PREPARED projection",
                        ):
                            if operation == "preflight":
                                handle.preflight_migration()
                            else:
                                handle.migrate_v1_to_v2()
                    finally:
                        handle.close()
            self.assertEqual((root / "events.jsonl").read_bytes(), original_ledger)
            db = sqlite3.connect(root / "state.sqlite3")
            try:
                self.assertEqual(
                    db.execute("SELECT state FROM schema_metadata").fetchone()[0],
                    "PREPARED",
                )
            finally:
                db.close()

    def test_preflight_rejects_non_wal_store_without_source_mutation(self):
        db = sqlite3.connect(self.root / "state.sqlite3")
        try:
            self.assertEqual(db.execute("PRAGMA journal_mode=DELETE").fetchone()[0], "delete")
        finally:
            db.close()
        before = self.source_bytes()

        with self.assertRaisesRegex(DurableStoreError, "WAL"):
            DurableProtocolStore(self.root).preflight_migration()
        with self.assertRaisesRegex(DurableStoreError, "WAL"):
            DurableProtocolStore(self.root).migrate_v1_to_v2()

        self.assertEqual(before, self.source_bytes())

    def test_preflight_rejects_rollback_journal_residue(self):
        journal = self.root / "state.sqlite3-journal"
        journal.write_bytes(b"synthetic rollback residue")
        journal.chmod(0o600)
        before = journal.read_bytes()

        with self.assertRaisesRegex(DurableStoreError, "rollback journal"):
            DurableProtocolStore(self.root).preflight_migration()

        self.assertEqual(journal.read_bytes(), before)

    def test_preflight_bounds_db_family_and_snapshot_free_space(self):
        with tempfile.TemporaryDirectory() as case:
            root = Path(case) / "state"
            self.seed_v1(root)
            with (root / "state.sqlite3").open("r+b") as stream:
                stream.truncate(1024 * 1024 * 1024 + 1)
            with self.assertRaisesRegex(DurableStoreError, "snapshot byte bound"):
                DurableProtocolStore(root).preflight_migration()

        no_space = SimpleNamespace(f_frsize=4096, f_bsize=4096, f_bavail=0)
        with mock.patch.object(durable_store_module.os, "statvfs", return_value=no_space):
            with self.assertRaisesRegex(DurableStoreError, "free space"):
                DurableProtocolStore(self.root).preflight_migration()

    def test_preflight_bounds_each_db_family_member_and_aggregate(self):
        for name, label in (
            ("state.sqlite3", "projection database"),
            ("state.sqlite3-wal", "projection WAL"),
            ("state.sqlite3-shm", "projection SHM"),
        ):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as case:
                root = Path(case) / "state"
                self.seed_wal_v1(root)
                with (root / name).open("r+b") as stream:
                    stream.truncate(1024 * 1024 * 1024 + 1)
                with self.assertRaisesRegex(
                    DurableStoreError, label + ".*snapshot byte bound",
                ):
                    DurableProtocolStore(root).preflight_migration()

        with tempfile.TemporaryDirectory() as case:
            root = Path(case) / "state"
            self.seed_wal_v1(root)
            total = sum(
                (root / name).stat().st_size
                for name in ("state.sqlite3", "state.sqlite3-wal", "state.sqlite3-shm")
            )
            with mock.patch.object(
                durable_store_module, "_MAX_DB_FAMILY_TOTAL_BYTES", total - 1,
            ):
                with self.assertRaisesRegex(DurableStoreError, "total snapshot bound"):
                    DurableProtocolStore(root).preflight_migration()

    def test_snapshot_admission_rejects_file_swap_between_identity_and_size(self):
        with tempfile.TemporaryDirectory() as case:
            root = Path(case) / "state"
            self.seed_wal_v1(root)
            target = root / "state.sqlite3"
            replacement = root / "replacement.sqlite3"
            shutil.copy2(target, replacement)
            replacement.chmod(0o600)
            family_sizes = tuple(
                (root / name).stat().st_size
                for name in ("state.sqlite3", "state.sqlite3-wal", "state.sqlite3-shm")
            )
            limit = max(family_sizes)
            with replacement.open("r+b") as stream:
                stream.truncate(limit + 1)

            real_stat = os.stat
            target_stats = 0

            def racing_stat(path, *args, **kwargs):
                nonlocal target_stats
                if path == "state.sqlite3":
                    target_stats += 1
                    if target_stats == 2:
                        replacement.replace(target)
                return real_stat(path, *args, **kwargs)

            handle = DurableProtocolStore(root)
            try:
                with mock.patch.object(
                    durable_store_module, "_MAX_DB_FAMILY_FILE_BYTES", limit,
                ), mock.patch.object(durable_store_module.os, "stat", racing_stat):
                    with self.assertRaisesRegex(
                        DurableStoreError, "changed during snapshot admission|byte bound",
                    ):
                        handle._snapshot_family()
            finally:
                handle.close()

    def test_preflight_bounds_projection_before_row_materialization(self):
        limits = (
            ("_MAX_PROJECTION_ROWS", 1, "row bound"),
            ("_MAX_PROJECTION_FIELD_BYTES", 8, "oversized field"),
            ("_MAX_PROJECTION_MATERIALIZED_BYTES", 32, "materialized byte"),
        )
        for attribute, value, message in limits:
            with self.subTest(attribute=attribute):
                with mock.patch.object(durable_store_module, attribute, value):
                    with self.assertRaisesRegex(DurableStoreError, message):
                        DurableProtocolStore(self.root).preflight_migration()

        db = sqlite3.connect(self.root / "state.sqlite3")
        try:
            db.execute(
                "UPDATE reconciliation SET evidence=?",
                ("\N{TEST TUBE}" * 40,),
            )
            db.commit()
            with mock.patch.object(
                durable_store_module, "_MAX_PROJECTION_FIELD_BYTES", 64,
            ):
                with self.assertRaisesRegex(DurableStoreError, "oversized field"):
                    durable_store_module._projection_table_size(
                        db, "reconciliation", ("evidence",),
                    )
        finally:
            db.close()

    def test_public_projection_reads_enforce_materialization_bounds(self):
        handle = DurableProtocolStore(self.root)
        handle.migrate_v1_to_v2()
        try:
            with mock.patch.object(durable_store_module, "_MAX_PROJECTION_ROWS", 0):
                with self.assertRaisesRegex(DurableStoreError, "row bound"):
                    handle.legacy_receipts()
                with self.assertRaisesRegex(DurableStoreError, "row bound"):
                    handle.migration_view()
        finally:
            handle.close()

    def test_migration_fails_closed_when_synchronous_full_cannot_be_verified(self):
        real_connect = sqlite3.connect
        before = self.source_bytes()

        class CursorResult:
            @staticmethod
            def fetchone():
                return (0,)

        class ConnectionProxy:
            def __init__(self, connection):
                object.__setattr__(self, "connection", connection)

            def __getattr__(self, name):
                return getattr(self.connection, name)

            def __setattr__(self, name, value):
                setattr(self.connection, name, value)

            def execute(self, statement, *args):
                result = self.connection.execute(statement, *args)
                if statement == "PRAGMA synchronous":
                    return CursorResult()
                return result

        def connect(database, *args, **kwargs):
            connection = real_connect(database, *args, **kwargs)
            if isinstance(database, str) and database.startswith("file:/proc/self/fd/"):
                return ConnectionProxy(connection)
            return connection

        with mock.patch.object(durable_store_module.sqlite3, "connect", connect):
            with self.assertRaisesRegex(DurableStoreError, "synchronous=FULL"):
                DurableProtocolStore(self.root).migrate_v1_to_v2()
        self.assertEqual(before, self.source_bytes())

    def test_migration_fails_closed_when_busy_timeout_cannot_be_verified(self):
        real_connect = sqlite3.connect
        before = self.source_bytes()

        class CursorResult:
            @staticmethod
            def fetchone():
                return (0,)

        class ConnectionProxy:
            def __init__(self, connection):
                object.__setattr__(self, "connection", connection)

            def __getattr__(self, name):
                return getattr(self.connection, name)

            def __setattr__(self, name, value):
                setattr(self.connection, name, value)

            def execute(self, statement, *args):
                result = self.connection.execute(statement, *args)
                if statement == "PRAGMA busy_timeout":
                    return CursorResult()
                return result

        def connect(database, *args, **kwargs):
            connection = real_connect(database, *args, **kwargs)
            if isinstance(database, str) and database.startswith("file:/proc/self/fd/"):
                return ConnectionProxy(connection)
            return connection

        with mock.patch.object(durable_store_module.sqlite3, "connect", connect):
            with self.assertRaisesRegex(DurableStoreError, "busy_timeout=30000"):
                DurableProtocolStore(self.root).migrate_v1_to_v2()
        self.assertEqual(before, self.source_bytes())

    def test_deleted_projection_replays_equivalently_from_ledger_alone(self):
        handle = DurableProtocolStore(self.root)
        migrated = handle.migrate_v1_to_v2()
        ledger = (self.root / "events.jsonl").read_bytes()
        for suffix in ("", "-wal", "-shm"):
            path = Path(str(self.root / "state.sqlite3") + suffix)
            if path.exists():
                path.unlink()

        replayed = handle.replay_projection()

        self.assertEqual((self.root / "events.jsonl").read_bytes(), ledger)
        self.assertEqual(replayed.state, "COMMITTED")
        self.assertEqual(replayed.projection_sha256, migrated.projection_sha256)
        self.assertEqual(len(replayed.legacy_receipts), 1)
        self.assertEqual(replayed.legacy_receipts[0].authoritative, 0)

    def test_before_ddl_crash_does_not_change_synthetic_wal_store_bytes(self):
        with tempfile.TemporaryDirectory() as case:
            fixture = Path(case) / "state"
            self.seed_wal_v1(fixture)
            before = {
                path.name: path.read_bytes() for path in fixture.iterdir() if path.is_file()
            }

            def crash(observed):
                if observed == "before_ddl":
                    raise InjectedCrash(observed)

            with mock.patch.object(durable_store_module, "_CRASH_HOOK", crash):
                with self.assertRaisesRegex(InjectedCrash, "before_ddl"):
                    DurableProtocolStore(fixture).migrate_v1_to_v2()

            after = {
                path.name: path.read_bytes() for path in fixture.iterdir() if path.is_file()
            }
            self.assertEqual(before, after)

    def test_active_controller_blocks_migration_without_changing_state_bytes(self):
        with tempfile.TemporaryDirectory() as case:
            root = Path(case) / "state"
            store = Store(str(root))
            try:
                self.populate_v1(store)
                before = {
                    path.name: path.read_bytes()
                    for path in root.iterdir() if path.is_file()
                }

                with self.assertRaisesRegex(DurableStoreError, "controller.*active"):
                    DurableProtocolStore(root).migrate_v1_to_v2()

                after = {
                    path.name: path.read_bytes()
                    for path in root.iterdir() if path.is_file()
                }
                self.assertEqual(before, after)
            finally:
                store.close()

    def test_writable_state_symlinks_fail_closed_without_touching_target(self):
        for name in ("state.sqlite3-wal", "state.sqlite3-shm", ".controller.lock"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as case:
                root = Path(case) / "state"
                self.seed_v1(root)
                candidate = root / name
                if candidate.exists():
                    candidate.unlink()
                target = Path(case) / "outside"
                target.write_bytes(b"unchanged")
                candidate.symlink_to(target)

                with self.assertRaisesRegex(DurableStoreError, "symlink|regular"):
                    DurableProtocolStore(root).migrate_v1_to_v2()

                self.assertEqual(target.read_bytes(), b"unchanged")

    def test_state_root_must_be_absolute_canonical_and_mode_0700(self):
        relative = Path(os.path.relpath(self.root, Path.cwd()))
        with self.assertRaisesRegex(DurableStoreError, "absolute canonical"):
            DurableProtocolStore(relative)

        self.root.chmod(0o750)
        with self.assertRaisesRegex(DurableStoreError, "mode-0700"):
            DurableProtocolStore(self.root)

    def test_every_state_file_must_be_private_and_single_linked(self):
        names = (
            "state.sqlite3", "state.sqlite3-wal", "state.sqlite3-shm",
            "events.jsonl", ".writer.lock", ".controller.lock",
        )
        for name in names:
            with self.subTest(name=name, defect="mode"), tempfile.TemporaryDirectory() as case:
                root = Path(case) / "state"
                self.seed_wal_v1(root)
                candidate = root / name
                self.assertTrue(candidate.exists())
                candidate.chmod(0o640)
                with self.assertRaisesRegex(DurableStoreError, "mode-0600"):
                    DurableProtocolStore(root)

            with self.subTest(name=name, defect="hardlink"), tempfile.TemporaryDirectory() as case:
                root = Path(case) / "state"
                self.seed_wal_v1(root)
                candidate = root / name
                alias = Path(case) / (name.replace("/", "-") + ".alias")
                os.link(candidate, alias)
                with self.assertRaisesRegex(DurableStoreError, "single-linked"):
                    DurableProtocolStore(root)

    def test_committed_v2_layout_locks_out_legacy_store(self):
        DurableProtocolStore(self.root).migrate_v1_to_v2()

        with self.assertRaisesRegex(GuardError, "incompatible receipt schema"):
            Store(str(self.root))

    def test_migration_applies_every_protocol_v1_disposition_category(self):
        with tempfile.TemporaryDirectory() as case:
            root = Path(case)
            old_versions = self.seed_disposition_v1(root)

            handle = DurableProtocolStore(root)
            handle.migrate_v1_to_v2()
            view = handle.migration_view()

            campaigns = {item.id: item for item in view.campaigns}
            self.assertTrue(campaigns["active-campaign"].recovery_required)
            self.assertTrue(campaigns["campaign-paused"].recovery_required)
            self.assertTrue(campaigns["campaign-failed"].recovery_required)
            for state in ("ABORTED", "RELEASED"):
                self.assertFalse(campaigns["campaign-" + state.lower()].recovery_required)
            tasks = {item.id.removeprefix("task-").replace("-", "_").upper(): item
                     for item in view.tasks}
            for state in ("LEASED", "RUNNING", "RECOVERING"):
                self.assertEqual(
                    (tasks[state].state, tasks[state].recovery_from,
                     tasks[state].version - old_versions[tasks[state].id]),
                    ("READY", state, 1),
                )
            for state in ("SUBMITTED", "VERIFYING", "REVIEWING"):
                self.assertEqual(
                    (tasks[state].state, tasks[state].recovery_from,
                     tasks[state].version - old_versions[tasks[state].id]),
                    ("READY", state, 2),
                )
            self.assertEqual(
                (tasks["CHANGES_REQUESTED"].state,
                 tasks["CHANGES_REQUESTED"].recovery_from),
                ("READY", "CHANGES_REQUESTED"),
            )
            for state in ("INTEGRATING", "MERGED", "POST_MERGE_VERIFYING"):
                self.assertEqual((tasks[state].state, tasks[state].recovery_from), (state, state))
            for state in ("DISCOVERED", "READY", "FAILED", "SUPERSEDED", "DONE"):
                self.assertEqual((tasks[state].state, tasks[state].recovery_from), (state, None))
            self.assertEqual(view.legacy_lease_count, 0)

    def test_legacy_merge_states_materialize_bounded_global_recovery_hold(self):
        with tempfile.TemporaryDirectory() as case:
            root = Path(case)
            self.seed_disposition_v1(root)

            handle = DurableProtocolStore(root)
            handle.migrate_v1_to_v2()
            view = handle.migration_view()

            self.assertTrue(view.merge_recovery_required)
            self.assertEqual(view.merge_recovery_task_count, 3)
            self.assertTrue(handle.verify_replay_equivalence())
            db = sqlite3.connect(root / "state.sqlite3")
            try:
                fence = db.execute(
                    "SELECT token FROM fences WHERE scope='merge/global'"
                ).fetchone()
                claim = db.execute(
                    "SELECT token,status FROM merge_claims "
                    "WHERE resource='merge/global'"
                ).fetchone()
                self.assertEqual(fence, (1,))
                self.assertEqual(claim, (1, "RECOVERY_REQUIRED"))
                self.assertEqual(
                    db.execute("SELECT count(*) FROM phase_leases").fetchone(),
                    (0,),
                )
                self.assertEqual(
                    db.execute("SELECT count(*) FROM phase_receipts").fetchone(),
                    (0,),
                )
                self.assertEqual(
                    db.execute("SELECT count(*) FROM merge_operations").fetchone(),
                    (0,),
                )
            finally:
                db.close()


if __name__ == "__main__":
    unittest.main()
