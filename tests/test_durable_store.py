import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

from gauntlet.core import GuardError, Store
from gauntlet.durable_store import DurableProtocolStore, DurableStoreError


OPT_IN_V1_FIXTURE = os.environ.get("KIZUKI_GAUNTLET_V1_FIXTURE")


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

    def test_preflight_reports_v1_inventory_without_changing_source_bytes(self):
        before = self.source_bytes()
        ledger = before["events.jsonl"]

        report = DurableProtocolStore(self.root).preflight_migration()

        self.assertEqual(report.schema_version, 1)
        self.assertEqual(report.state, "V1_READY")
        self.assertEqual(report.ledger_prefix_bytes, len(ledger))
        self.assertEqual(report.ledger_prefix_sha256, hashlib.sha256(ledger).hexdigest())
        self.assertEqual(before, self.source_bytes())

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

                    with self.assertRaisesRegex(InjectedCrash, stage):
                        DurableProtocolStore(root, crash_hook=crash).migrate_v1_to_v2()

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

    def test_partial_schema_event_append_resumes_with_persisted_exact_remainder(self):
        for repetition in range(2):
            with self.subTest(repetition=repetition), tempfile.TemporaryDirectory() as case:
                root = Path(case) / "state"
                self.seed_wal_v1(root)
                original = (root / "events.jsonl").read_bytes()

                def crash(observed):
                    if observed == "during_ledger_append":
                        raise InjectedCrash(observed)

                with self.assertRaisesRegex(InjectedCrash, "during_ledger_append"):
                    DurableProtocolStore(root, crash_hook=crash).migrate_v1_to_v2()

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

            with self.assertRaisesRegex(InjectedCrash, "during_ledger_append"):
                DurableProtocolStore(root, crash_hook=crash).migrate_v1_to_v2()

            path = root / "events.jsonl"
            divergent = bytearray(path.read_bytes())
            divergent[-1] = ord("X") if divergent[-1] != ord("X") else ord("Y")
            path.write_bytes(divergent)
            before = self.source_file_bytes(root)

            with self.assertRaisesRegex(DurableStoreError, "divergent partial"):
                DurableProtocolStore(root).migrate_v1_to_v2()

            self.assertEqual(before, self.source_file_bytes(root))

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

            with self.assertRaisesRegex(InjectedCrash, "before_ddl"):
                DurableProtocolStore(fixture, crash_hook=crash).migrate_v1_to_v2()

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

    @unittest.skipUnless(OPT_IN_V1_FIXTURE, "set KIZUKI_GAUNTLET_V1_FIXTURE to opt in")
    def test_opt_in_copied_v1_fixture_runs_repeated_full_crash_matrix(self):
        stages = (
            "before_ddl", "after_ddl", "during_ledger_append",
            "after_ledger_fsync", "before_projection_commit",
        )
        source = Path(OPT_IN_V1_FIXTURE)
        for stage in stages:
            for repetition in range(2):
                with self.subTest(stage=stage, repetition=repetition), tempfile.TemporaryDirectory() as case:
                    fixture = Path(case) / "state"
                    shutil.copytree(source, fixture)
                    before = self.source_file_bytes(fixture)
                    self.assertTrue(
                        {"state.sqlite3", "state.sqlite3-wal", "state.sqlite3-shm"}
                        <= set(before)
                    )
                    report = DurableProtocolStore(fixture).preflight_migration()
                    self.assertEqual(before, self.source_file_bytes(fixture))

                    def crash(observed):
                        if observed == stage:
                            raise InjectedCrash(observed)

                    with self.assertRaisesRegex(InjectedCrash, stage):
                        DurableProtocolStore(fixture, crash_hook=crash).migrate_v1_to_v2()

                    result = DurableProtocolStore(fixture).migrate_v1_to_v2()
                    ledger = (fixture / "events.jsonl").read_bytes()
                    self.assertEqual(
                        ledger[:report.ledger_prefix_bytes], before["events.jsonl"]
                    )
                    self.assertEqual(
                        len(ledger[report.ledger_prefix_bytes:].splitlines()), 1
                    )
                    self.assertEqual(
                        result.projection_sha256, result.replay_projection_sha256
                    )
                    self.assertTrue(DurableProtocolStore(fixture).verify_replay_equivalence())

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


if __name__ == "__main__":
    unittest.main()
