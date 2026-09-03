import concurrent.futures
import hashlib
import json
import multiprocessing
import os
import shutil
import sqlite3
import tempfile
import threading
import time
import unittest
from dataclasses import replace
from pathlib import Path
from types import MappingProxyType
from unittest import mock

from gauntlet.core import Store
from gauntlet import durable_store
from gauntlet.durable_store import (
    CleanupEvidence,
    DurableProtocolStore,
    DurableStoreError,
    PhaseResult,
    phase_claim_transition,
    phase_identity_reuse_allowed,
    phase_result_transition,
)
from gauntlet.identity import (
    Artifact,
    IdentityManifest,
    IdentityReceipt,
    validated_authority_binding,
)


HMAC_KEY = b"durable-v2-test-controller-key!!"


class DurableProtocolStoreV2Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.seed_store(self.root)

    @staticmethod
    def seed_store(root):
        with Store(str(root)) as legacy:
            legacy.claim_controller()
            campaign = legacy.create_campaign("campaign-v2")
            legacy.record_reconciliation(campaign, {"safe_to_promote": True})
            version = legacy.snapshot()["campaigns"][0]["version"]
            version = legacy.campaign_state(campaign, "READY", version)
            legacy.campaign_state(campaign, "ACTIVE", version)
            task = legacy.create_task(campaign, "scope/v2", "task-v2")
            version = legacy.snapshot()["tasks"][0]["version"]
            legacy.task_state(task, "READY", version)
            other = legacy.create_task(campaign, "scope/v2-other", "task-v2-other")
            other_version = next(
                item["version"] for item in legacy.snapshot()["tasks"]
                if item["id"] == other
            )
            legacy.task_state(other, "READY", other_version)
        DurableProtocolStore(root).migrate_v1_to_v2()

    def fresh_root(self):
        case = tempfile.TemporaryDirectory()
        self.addCleanup(case.cleanup)
        root = Path(case.name)
        self.seed_store(root)
        return root

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def identity(
        now, *, principal_id="builder-one", authority_domain="builder-domain",
        adapter="codex", generation=1,
    ):
        def digest(label):
            return hashlib.sha256(label.encode("ascii")).hexdigest()

        manifest = IdentityManifest(
            principal_id, authority_domain, adapter, generation,
            digest(principal_id + ":account"),
            digest(f"{principal_id}:executable:{generation}"),
            digest(f"{principal_id}:network:{generation}"),
            (Artifact("auth.json", digest(f"{principal_id}:artifact:{generation}"), 128),),
        )
        receipt = IdentityReceipt(
            manifest.principal_id, manifest.authority_domain, manifest.adapter,
            manifest.generation, manifest.account_binding_sha256,
            manifest.executable_sha256, manifest.network_profile_sha256,
            now - 10, now + 300, "READY", "READY",
        )
        return manifest, receipt

    def claimable_store(self, root=None):
        root = self.root if root is None else root
        handle = DurableProtocolStore(root)
        self.assertEqual(handle.claim_controller(), 2)
        handle.clear_campaign_recovery(
            "campaign-v2", expected_version=4, evidence_sha256="5" * 64
        )
        task = handle.bind_task_destination(
            "task-v2", repository="owner/repository", base_sha="a" * 40,
            pr_number=17, subject_sha="b" * 40, expected_version=2,
        )
        now = time.time()
        manifest, receipt = self.identity(now)
        identity = handle.register_identity(manifest, receipt)
        request = handle.phase_authority_request("task-v2", "builder")
        binding = validated_authority_binding(
            manifest, receipt, now, HMAC_KEY, request.operation_sha256
        )
        self.assertEqual(task.version, request.task_version)
        return handle, manifest, receipt, identity, binding, request

    def claim_builder(self, root=None):
        handle, manifest, receipt, identity, binding, request = self.claimable_store(root)
        grant = handle.claim_phase(
            "task-v2", "builder", binding, manifest, receipt,
            expected_task_version=request.task_version, ttl_seconds=60,
            controller_hmac_key=HMAC_KEY,
        )
        return handle, identity, binding, grant

    def test_controller_claim_is_one_durable_replayable_event(self):
        ledger = self.root / "events.jsonl"
        before = ledger.read_bytes()
        handle = DurableProtocolStore(self.root)

        epoch = handle.claim_controller()

        after = ledger.read_bytes()
        self.assertEqual(epoch, 2)
        self.assertEqual(len(after.splitlines()), len(before.splitlines()) + 1)
        campaign = handle.campaign("campaign-v2")
        self.assertTrue(campaign.recovery_required)
        self.assertEqual(campaign.version, 4)
        self.assertTrue(handle.verify_replay_equivalence())
        handle.release_controller()

    def test_controller_epoch_fences_every_nonterminal_campaign_including_failed(self):
        case = tempfile.TemporaryDirectory()
        self.addCleanup(case.cleanup)
        root = Path(case.name)
        with Store(str(root)) as legacy:
            legacy.claim_controller()
            for campaign_id, state in (
                ("campaign-active", "ACTIVE"),
                ("campaign-failed", "FAILED"),
                ("campaign-paused", "PAUSED"),
                ("campaign-aborted", "ABORTED"),
            ):
                legacy.create_campaign(campaign_id)
                legacy._write(
                    lambda: None, "campaign.state",
                    {"id": campaign_id, "state": state},
                )
        handle = DurableProtocolStore(root)
        handle.migrate_v1_to_v2()
        before = {
            campaign_id: handle.campaign(campaign_id)
            for campaign_id in (
                "campaign-active", "campaign-failed", "campaign-paused",
                "campaign-aborted",
            )
        }

        self.assertEqual(handle.claim_controller(), 2)

        for campaign_id in (
            "campaign-active", "campaign-failed", "campaign-paused",
        ):
            current = handle.campaign(campaign_id)
            self.assertTrue(current.recovery_required)
            self.assertEqual(current.epoch, 2)
            self.assertEqual(current.version, before[campaign_id].version + 1)
        aborted = handle.campaign("campaign-aborted")
        self.assertFalse(aborted.recovery_required)
        self.assertEqual(aborted.version, before["campaign-aborted"].version)
        handle.release_controller()

    def test_consumed_binding_and_claim_replay_after_reopen(self):
        handle, _identity, binding, grant = self.claim_builder()
        self.assertEqual(grant.resource, "task:task-v2:1:builder")
        handle.release_controller()

        reopened = DurableProtocolStore(self.root)

        self.assertTrue(reopened.binding_consumed(binding.binding_id))
        self.assertEqual(grant.execution_generation, 1)
        self.assertEqual(reopened.phase_attempt(grant.attempt_id).state, "CLAIMED")
        self.assertTrue(reopened.verify_replay_equivalence())

    def test_retry_schema_uses_execution_generation_not_one_role_row(self):
        with sqlite3.connect(self.root / "state.sqlite3") as db:
            attempt_indexes = []
            for row in db.execute("PRAGMA index_list('phase_attempts')"):
                if row[2]:
                    attempt_indexes.append(tuple(
                        item[2] for item in db.execute(
                            f"PRAGMA index_info('{row[1]}')"
                        )
                    ))
            spec_indexes = []
            for row in db.execute("PRAGMA index_list('task_specs')"):
                if row[2]:
                    spec_indexes.append(tuple(
                        item[2] for item in db.execute(
                            f"PRAGMA index_info('{row[1]}')"
                        )
                    ))

        self.assertNotIn(("task_id", "task_attempt", "role"), attempt_indexes)
        self.assertNotIn(("lease_resource",), attempt_indexes)
        self.assertNotIn(("task_id", "task_attempt", "role"), spec_indexes)
        self.assertTrue(any(
            "execution_generation" in columns for columns in attempt_indexes
        ))

    def test_two_concurrent_claims_of_one_binding_have_exactly_one_winner(self):
        handle, manifest, receipt, _identity, binding, request = self.claimable_store()
        before = len((self.root / "events.jsonl").read_bytes().splitlines())
        start = threading.Event()

        def claim():
            start.wait()
            try:
                grant = handle.claim_phase(
                    "task-v2", "builder", binding, manifest, receipt,
                    expected_task_version=request.task_version, ttl_seconds=60,
                    controller_hmac_key=HMAC_KEY,
                )
                return "ok", grant.attempt_id
            except BaseException as exc:
                return type(exc).__name__, str(exc)

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(claim) for _ in range(2)]
            start.set()
            results = [future.result(timeout=10) for future in futures]

        self.assertEqual(sum(item[0] == "ok" for item in results), 1)
        self.assertEqual(sum(item[0] == "DurableStoreError" for item in results), 1)
        self.assertEqual(
            len((self.root / "events.jsonl").read_bytes().splitlines()), before + 1
        )
        handle.release_controller()

    def test_forked_handle_cannot_mutate_or_unlock_parent_controller(self):
        handle = DurableProtocolStore(self.root)
        self.assertEqual(handle.claim_controller(), 2)
        campaign = handle.campaign("campaign-v2")
        context = multiprocessing.get_context("fork")
        outcome = context.Queue()

        def inherited_controller_use():
            try:
                handle.clear_campaign_recovery(
                    "campaign-v2", expected_version=campaign.version,
                    evidence_sha256="5" * 64,
                )
                outcome.put(("accepted", None))
            except BaseException as exc:
                outcome.put((type(exc).__name__, str(exc)))
            finally:
                handle.release_controller()

        process = context.Process(target=inherited_controller_use)
        process.start()
        process.join(10)
        self.assertEqual(process.exitcode, 0)
        self.assertEqual(outcome.get(timeout=2)[0], "DurableStoreError")

        competitor = DurableProtocolStore(self.root)
        with self.assertRaisesRegex(DurableStoreError, "already claimed"):
            competitor.claim_controller()
        self.assertEqual(
            handle.clear_campaign_recovery(
                "campaign-v2", expected_version=campaign.version,
                evidence_sha256="5" * 64,
            ),
            campaign.version + 1,
        )
        handle.release_controller()

    def test_claim_append_intent_recovers_every_crash_boundary_exactly_once(self):
        stages = (
            "before_runtime_append", "during_runtime_ledger_append",
            "after_runtime_ledger_fsync", "before_runtime_projection_commit",
        )
        for stage in stages:
            with self.subTest(stage=stage):
                root = self.fresh_root()
                handle, manifest, receipt, _identity, binding, request = (
                    self.claimable_store(root)
                )
                ledger = root / "events.jsonl"
                before = ledger.read_bytes()

                def crash(observed):
                    if observed == stage:
                        raise RuntimeError(observed)

                with self.assertRaisesRegex(RuntimeError, stage):
                    handle.claim_phase(
                        "task-v2", "builder", binding, manifest, receipt,
                        expected_task_version=request.task_version, ttl_seconds=60,
                        controller_hmac_key=HMAC_KEY, crash_hook=crash,
                    )
                crashed = ledger.read_bytes()
                self.assertTrue(crashed.startswith(before))
                with sqlite3.connect(root / "state.sqlite3") as db:
                    intent = db.execute(
                        "SELECT state,event_seq,event_hash,event_bytes,"
                        "event_bytes_sha256,ledger_prefix_bytes,"
                        "ledger_prefix_sha256,ledger_prefix_tip_hash,"
                        "ledger_prefix_seq FROM runtime_append_intent"
                    ).fetchone()
                self.assertIsNotNone(intent)
                self.assertEqual(intent[0], "PREPARED")
                self.assertEqual(intent[1], len(before.splitlines()) + 1)
                self.assertEqual(hashlib.sha256(intent[3]).hexdigest(), intent[4])
                self.assertEqual(intent[5], len(before))
                self.assertEqual(hashlib.sha256(before).hexdigest(), intent[6])
                self.assertEqual(intent[8], len(before.splitlines()))
                self.assertEqual(len(intent[2]), 64)
                self.assertEqual(len(intent[7]), 64)
                if stage == "before_runtime_append":
                    self.assertEqual(crashed, before)
                elif stage == "during_runtime_ledger_append":
                    self.assertGreater(len(crashed), len(before))
                    self.assertFalse(crashed.endswith(b"\n"))
                else:
                    self.assertEqual(len(crashed.splitlines()), len(before.splitlines()) + 1)

                attempt = handle.recover_runtime_tail().attempts[0]
                self.assertEqual(attempt.state, "CLAIMED")
                handle.recover_runtime_tail()
                self.assertTrue(handle.binding_consumed(binding.binding_id))
                with sqlite3.connect(root / "state.sqlite3") as db:
                    self.assertEqual(
                        db.execute("SELECT count(*) FROM runtime_append_intent").fetchone()[0],
                        0,
                    )
                self.assertEqual(
                    len(ledger.read_bytes().splitlines()), len(before.splitlines()) + 1
                )
                self.assertTrue(handle.verify_replay_equivalence())
                handle.release_controller()

    def test_heartbeat_append_intent_recovers_every_crash_boundary_exactly_once(self):
        stages = (
            "before_runtime_append", "during_runtime_ledger_append",
            "after_runtime_ledger_fsync", "before_runtime_projection_commit",
        )
        for stage in stages:
            with self.subTest(stage=stage):
                root = self.fresh_root()
                handle, _identity, _binding, grant = self.claim_builder(root)
                ledger = root / "events.jsonl"
                before = ledger.read_bytes()

                def crash(observed):
                    if observed == stage:
                        raise RuntimeError(observed)

                with self.assertRaisesRegex(RuntimeError, stage):
                    handle.heartbeat(
                        grant, expected_lease_version=grant.lease_version,
                        ttl_seconds=60, crash_hook=crash,
                    )
                handle.recover_runtime_tail()
                recovered = handle.active_grant(grant.attempt_id)
                self.assertEqual(recovered.lease_version, 2)
                renewed = handle.heartbeat(
                    recovered, expected_lease_version=2, ttl_seconds=60,
                )
                self.assertEqual(renewed.lease_version, 3)
                self.assertEqual(
                    len(ledger.read_bytes().splitlines()), len(before.splitlines()) + 2
                )
                self.assertTrue(handle.verify_replay_equivalence())
                handle.release_controller()

    def test_restart_recovers_appended_unprojected_event_before_epoch_advance(self):
        handle, manifest, receipt, _identity, binding, request = self.claimable_store()
        ledger = self.root / "events.jsonl"
        before_count = len(ledger.read_bytes().splitlines())

        def crash(stage):
            if stage == "before_runtime_projection_commit":
                raise RuntimeError(stage)

        with self.assertRaisesRegex(RuntimeError, "before_runtime_projection_commit"):
            handle.claim_phase(
                "task-v2", "builder", binding, manifest, receipt,
                expected_task_version=request.task_version, ttl_seconds=60,
                controller_hmac_key=HMAC_KEY, crash_hook=crash,
            )
        self.assertEqual(len(ledger.read_bytes().splitlines()), before_count + 1)
        handle.release_controller()

        restarted = DurableProtocolStore(self.root)
        self.assertEqual(restarted.claim_controller(), 3)
        attempts = restarted.recover_runtime_tail().attempts
        self.assertEqual(len(attempts), 1)
        self.assertEqual(attempts[0].state, "RECOVERY_REQUIRED")
        self.assertTrue(restarted.binding_consumed(binding.binding_id))
        self.assertEqual(len(ledger.read_bytes().splitlines()), before_count + 2)
        self.assertTrue(restarted.verify_replay_equivalence())
        restarted.release_controller()

    def test_runtime_intent_rejects_divergent_partial_tail_without_rewrite(self):
        handle, manifest, receipt, _identity, binding, request = self.claimable_store()
        ledger = self.root / "events.jsonl"

        def crash(stage):
            if stage == "before_runtime_append":
                raise RuntimeError(stage)

        with self.assertRaisesRegex(RuntimeError, "before_runtime_append"):
            handle.claim_phase(
                "task-v2", "builder", binding, manifest, receipt,
                expected_task_version=request.task_version, ttl_seconds=60,
                controller_hmac_key=HMAC_KEY, crash_hook=crash,
            )
        with ledger.open("ab") as stream:
            stream.write(b"divergent")
            stream.flush()
        divergent = ledger.read_bytes()

        with self.assertRaisesRegex(DurableStoreError, "divergent"):
            handle.recover_runtime_tail()

        self.assertEqual(ledger.read_bytes(), divergent)
        handle.release_controller()

    def test_applier_failure_is_dry_run_before_intent_or_ledger_write(self):
        handle = DurableProtocolStore(self.root)
        handle.claim_controller()
        handle.clear_campaign_recovery(
            "campaign-v2", expected_version=4, evidence_sha256="5" * 64
        )
        now = time.time()
        manifest, receipt = self.identity(now)
        ledger = self.root / "events.jsonl"
        before = ledger.read_bytes()
        registry = dict(durable_store.V2_EVENT_APPLIERS)

        def reject_projection(_db, _event):
            raise DurableStoreError("injected applier constraint failure")

        registry["identity.registered.v2"] = reject_projection
        with mock.patch.object(
            durable_store, "V2_EVENT_APPLIERS", MappingProxyType(registry)
        ):
            with self.assertRaisesRegex(DurableStoreError, "injected applier"):
                handle.register_identity(manifest, receipt)

        self.assertEqual(ledger.read_bytes(), before)
        registered = handle.register_identity(manifest, receipt)
        self.assertEqual(registered.principal_id, manifest.principal_id)
        handle.release_controller()

    def test_projection_row_divergence_blocks_new_runtime_event(self):
        handle = DurableProtocolStore(self.root)
        handle.claim_controller()
        ledger = self.root / "events.jsonl"
        before = ledger.read_bytes()
        with sqlite3.connect(self.root / "state.sqlite3") as db:
            db.execute("UPDATE tasks SET version=version+1 WHERE id='task-v2'")

        with self.assertRaisesRegex(DurableStoreError, "differs from deterministic replay"):
            handle.clear_campaign_recovery(
                "campaign-v2", expected_version=4, evidence_sha256="5" * 64
            )

        self.assertEqual(ledger.read_bytes(), before)
        handle.release_controller()

    def test_projection_row_divergence_blocks_controller_epoch_event(self):
        first = DurableProtocolStore(self.root)
        first.claim_controller()
        first.release_controller()
        ledger = self.root / "events.jsonl"
        before = ledger.read_bytes()
        with sqlite3.connect(self.root / "state.sqlite3") as db:
            db.execute("UPDATE tasks SET version=version+1 WHERE id='task-v2'")

        with self.assertRaisesRegex(DurableStoreError, "differs from deterministic replay"):
            DurableProtocolStore(self.root).claim_controller()

        self.assertEqual(ledger.read_bytes(), before)

    def test_replaced_controller_lock_inode_blocks_mutation(self):
        handle = DurableProtocolStore(self.root)
        handle.claim_controller()
        ledger = self.root / "events.jsonl"
        before = ledger.read_bytes()
        lock = self.root / ".controller.lock"
        lock.rename(self.root / ".controller.lock.replaced")
        lock.write_bytes(b"")
        lock.chmod(0o600)

        with self.assertRaisesRegex(DurableStoreError, "controller lock.*replaced"):
            handle.clear_campaign_recovery(
                "campaign-v2", expected_version=4, evidence_sha256="5" * 64
            )

        self.assertEqual(ledger.read_bytes(), before)
        handle.release_controller()

    def test_controller_lock_inode_is_rechecked_at_runtime_append_boundary(self):
        handle, manifest, receipt, _identity, binding, request = self.claimable_store()
        ledger = self.root / "events.jsonl"
        before = ledger.read_bytes()
        lock = self.root / ".controller.lock"
        displaced = self.root / ".controller.lock.displaced"

        def replace_controller_lock(stage):
            if stage != "before_runtime_append" or displaced.exists():
                return
            lock.rename(displaced)
            shutil.copy2(displaced, lock)

        with self.assertRaisesRegex(DurableStoreError, "controller lock.*replaced"):
            handle.claim_phase(
                "task-v2", "builder", binding, manifest, receipt,
                expected_task_version=request.task_version, ttl_seconds=60,
                controller_hmac_key=HMAC_KEY, crash_hook=replace_controller_lock,
            )
        self.assertEqual(ledger.read_bytes(), before)
        handle.release_controller()

    def test_replaced_state_root_is_rejected_before_runtime_append(self):
        handle, manifest, receipt, _identity, binding, request = self.claimable_store()
        displaced = self.root.with_name(self.root.name + "-displaced")
        self.addCleanup(
            lambda: shutil.rmtree(displaced) if displaced.exists() else None
        )

        def replace_root(stage):
            if stage != "before_runtime_append" or displaced.exists():
                return
            self.root.rename(displaced)
            self.root.mkdir(mode=0o700)
            for source in displaced.iterdir():
                if source.is_file():
                    shutil.copy2(source, self.root / source.name)

        with self.assertRaisesRegex(DurableStoreError, "state directory path was replaced"):
            handle.claim_phase(
                "task-v2", "builder", binding, manifest, receipt,
                expected_task_version=request.task_version, ttl_seconds=60,
                controller_hmac_key=HMAC_KEY, crash_hook=replace_root,
            )
        handle.release_controller()

    def test_replaced_projection_database_is_rejected_before_runtime_append(self):
        handle, manifest, receipt, _identity, binding, request = self.claimable_store()
        database = self.root / "state.sqlite3"
        displaced = self.root / "state.sqlite3.displaced"
        ledger = self.root / "events.jsonl"
        before = ledger.read_bytes()

        def replace_database(stage):
            if stage != "before_runtime_append" or displaced.exists():
                return
            database.rename(displaced)
            shutil.copy2(displaced, database)

        with self.assertRaisesRegex(DurableStoreError, "projection database.*replaced"):
            handle.claim_phase(
                "task-v2", "builder", binding, manifest, receipt,
                expected_task_version=request.task_version, ttl_seconds=60,
                controller_hmac_key=HMAC_KEY, crash_hook=replace_database,
            )
        self.assertEqual(ledger.read_bytes(), before)
        handle.release_controller()

    def test_replaced_ledger_inode_is_rejected_before_runtime_append(self):
        handle, manifest, receipt, _identity, binding, request = self.claimable_store()
        ledger = self.root / "events.jsonl"
        displaced = self.root / "events.displaced"

        def replace_ledger(stage):
            if stage != "before_runtime_append" or displaced.exists():
                return
            ledger.rename(displaced)
            shutil.copy2(displaced, ledger)

        with self.assertRaisesRegex(DurableStoreError, "ledger.*replaced"):
            handle.claim_phase(
                "task-v2", "builder", binding, manifest, receipt,
                expected_task_version=request.task_version, ttl_seconds=60,
                controller_hmac_key=HMAC_KEY, crash_hook=replace_ledger,
            )
        handle.release_controller()

    def test_replaced_writer_lock_inode_is_rejected_before_runtime_append(self):
        handle, manifest, receipt, _identity, binding, request = self.claimable_store()
        lock = self.root / ".writer.lock"
        displaced = self.root / ".writer.lock.displaced"

        def replace_writer_lock(stage):
            if stage != "before_runtime_append" or displaced.exists():
                return
            lock.rename(displaced)
            shutil.copy2(displaced, lock)

        with self.assertRaisesRegex(DurableStoreError, "writer lock.*replaced"):
            handle.claim_phase(
                "task-v2", "builder", binding, manifest, receipt,
                expected_task_version=request.task_version, ttl_seconds=60,
                controller_hmac_key=HMAC_KEY, crash_hook=replace_writer_lock,
            )
        handle.release_controller()

    def test_ledger_content_mode_and_link_count_are_rechecked_at_append(self):
        mutations = ("content", "mode", "hardlink")
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                root = self.fresh_root()
                handle, manifest, receipt, _identity, binding, request = (
                    self.claimable_store(root)
                )
                ledger = root / "events.jsonl"
                before = ledger.read_bytes()
                alias = root / "events.alias"

                def mutate(stage):
                    if stage != "before_runtime_append":
                        return
                    if mutation == "content":
                        changed = bytearray(before)
                        changed[0] = ord("[") if changed[0] != ord("[") else ord("{")
                        ledger.write_bytes(changed)
                    elif mutation == "mode":
                        ledger.chmod(0o640)
                    else:
                        os.link(ledger, alias)

                with self.assertRaisesRegex(
                    DurableStoreError, "ledger.*(content|mode-0600|single-linked|changed)"
                ):
                    handle.claim_phase(
                        "task-v2", "builder", binding, manifest, receipt,
                        expected_task_version=request.task_version, ttl_seconds=60,
                        controller_hmac_key=HMAC_KEY, crash_hook=mutate,
                    )
                self.assertEqual(ledger.stat().st_size, len(before))
                handle.release_controller()

    def test_ledger_hash_is_rechecked_after_fsync_and_before_projection_commit(self):
        for target_stage in (
            "after_runtime_ledger_fsync", "before_runtime_projection_commit",
        ):
            with self.subTest(stage=target_stage):
                root = self.fresh_root()
                handle, manifest, receipt, _identity, binding, request = (
                    self.claimable_store(root)
                )
                ledger = root / "events.jsonl"

                def mutate(stage):
                    if stage != target_stage:
                        return
                    content = bytearray(ledger.read_bytes())
                    content[0] = ord("[") if content[0] != ord("[") else ord("{")
                    ledger.write_bytes(content)

                with self.assertRaisesRegex(DurableStoreError, "ledger.*(content|hash)"):
                    handle.claim_phase(
                        "task-v2", "builder", binding, manifest, receipt,
                        expected_task_version=request.task_version, ttl_seconds=60,
                        controller_hmac_key=HMAC_KEY, crash_hook=mutate,
                    )
                self.assertFalse(handle.binding_consumed(binding.binding_id))
                handle.release_controller()

    def test_release_controller_cannot_race_an_inflight_mutation(self):
        handle, manifest, receipt, _identity, binding, request = self.claimable_store()
        append_reached = threading.Event()
        continue_append = threading.Event()
        released = threading.Event()

        def pause(stage):
            if stage == "before_runtime_append":
                append_reached.set()
                if not continue_append.wait(2):
                    raise RuntimeError("test coordination timed out")

        def claim():
            return handle.claim_phase(
                "task-v2", "builder", binding, manifest, receipt,
                expected_task_version=request.task_version, ttl_seconds=60,
                controller_hmac_key=HMAC_KEY, crash_hook=pause,
            )

        def release():
            handle.release_controller()
            released.set()

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            claim_future = executor.submit(claim)
            self.assertTrue(append_reached.wait(2))
            release_future = executor.submit(release)
            self.assertFalse(released.wait(0.1))
            continue_append.set()
            grant = claim_future.result(timeout=3)
            release_future.result(timeout=3)

        self.assertTrue(released.is_set())
        self.assertTrue(handle.binding_consumed(binding.binding_id))
        self.assertEqual(handle.phase_attempt(grant.attempt_id).state, "CLAIMED")

    def test_heartbeat_is_one_event_and_uses_lease_cas(self):
        handle, _identity, _binding, grant = self.claim_builder()
        before = len((self.root / "events.jsonl").read_bytes().splitlines())

        renewed = handle.heartbeat(
            grant, expected_lease_version=grant.lease_version, ttl_seconds=60
        )

        self.assertEqual((renewed.token, renewed.lease_version), (grant.token, 2))
        self.assertEqual(
            len((self.root / "events.jsonl").read_bytes().splitlines()), before + 1
        )
        with self.assertRaises(DurableStoreError):
            handle.heartbeat(
                grant, expected_lease_version=grant.lease_version, ttl_seconds=60
            )
        handle.release_controller()

    def test_new_epoch_blocks_claim_until_cgroup_empty_recovery_and_preserves_tokens(self):
        handle, _identity, _binding, stale_grant = self.claim_builder()
        handle.bind_task_destination(
            "task-v2-other", repository="owner/repository", base_sha="a" * 40,
            pr_number=18, subject_sha="d" * 40, expected_version=2,
        )
        handle.release_controller()

        restarted = DurableProtocolStore(self.root)
        self.assertEqual(restarted.claim_controller(), 3)
        campaign = restarted.campaign("campaign-v2")
        self.assertTrue(campaign.recovery_required)
        stale_attempt = restarted.phase_attempt(stale_grant.attempt_id)
        self.assertEqual((stale_attempt.state, stale_attempt.version),
                         ("RECOVERY_REQUIRED", 2))
        with self.assertRaisesRegex(DurableStoreError, "clearance rejected"):
            restarted.clear_campaign_recovery(
                "campaign-v2", expected_version=campaign.version,
                evidence_sha256="f" * 64,
            )
        with self.assertRaisesRegex(DurableStoreError, "recovery blocks"):
            restarted.phase_authority_request("task-v2-other", "builder")

        recovered = restarted.recover_phase(
            stale_grant.attempt_id,
            expected_attempt_version=stale_attempt.version,
            expected_task_version=stale_grant.task_version,
            cleanup=CleanupEvidence("e" * 64, cgroup_empty=True),
        )
        self.assertEqual(recovered.state, "READY")
        restarted.clear_campaign_recovery(
            "campaign-v2", expected_version=campaign.version,
            evidence_sha256="f" * 64,
        )
        request = restarted.phase_authority_request("task-v2-other", "builder")
        now = time.time()
        manifest, receipt = self.identity(now, generation=2)
        restarted.register_identity(manifest, receipt)
        blocked_binding = validated_authority_binding(
            manifest, receipt, now, HMAC_KEY, request.operation_sha256
        )
        new_grant = restarted.claim_phase(
            "task-v2-other", "builder", blocked_binding, manifest, receipt,
            expected_task_version=request.task_version, ttl_seconds=60,
            controller_hmac_key=HMAC_KEY,
        )
        self.assertGreater(new_grant.token, stale_grant.token)
        restarted.release_controller()

    def test_campaign_clearance_fails_closed_while_merge_recovery_is_unresolved(self):
        case = tempfile.TemporaryDirectory()
        self.addCleanup(case.cleanup)
        root = Path(case.name)
        with Store(str(root)) as legacy:
            legacy.claim_controller()
            campaign = legacy.create_campaign("campaign-merge-recovery")
            legacy._write(
                lambda: None, "campaign.state",
                {"id": campaign, "state": "ACTIVE"},
            )
            task = legacy.create_task(campaign, "scope/merge", "task-merge")
            legacy._write(
                lambda: None, "task.state",
                {"id": task, "state": "INTEGRATING"},
            )
        handle = DurableProtocolStore(root)
        handle.migrate_v1_to_v2()
        self.assertTrue(handle.migration_view().merge_recovery_required)
        handle.claim_controller()
        campaign_view = handle.campaign(campaign)

        with self.assertRaisesRegex(DurableStoreError, "unresolved"):
            handle.clear_campaign_recovery(
                campaign, expected_version=campaign_view.version,
                evidence_sha256="f" * 64,
            )

        self.assertTrue(handle.campaign(campaign).recovery_required)
        handle.release_controller()

    def test_pass_result_fails_closed_before_signed_spec_and_trusted_unit(self):
        handle, _identity, _binding, grant = self.claim_builder()
        before = (self.root / "events.jsonl").read_bytes()
        result = PhaseResult(
            subject_sha="b" * 40, base_sha="a" * 40, result_sha="c" * 40,
            evidence_sha256="6" * 64,
            cleanup=CleanupEvidence("7" * 64, cgroup_empty=True),
            task_spec_sha256="8" * 64, unit_identity_sha256="9" * 64,
            instruction_sha256="a" * 64, instruction_bytes=1,
            instruction_materialization_sha256="a" * 64,
            instruction_materialization_bytes=1,
            instruction_transport_sha256="a" * 64,
            instruction_transport_bytes=1, cpu_usage_ns=1,
            memory_peak_bytes=1, tasks_peak=1, oom_count=0,
            oom_killed=False, systemd_service_result="success",
            systemd_exec_code=1, systemd_exec_status=0,
            resource_outcome_sha256="b" * 64,
        )

        with self.assertRaisesRegex(DurableStoreError, "EXITED"):
            handle.commit_phase(
                grant, expected_task_version=grant.task_version, result=result,
            )

        self.assertEqual((self.root / "events.jsonl").read_bytes(), before)
        self.assertEqual(handle.phase_receipts("task-v2"), ())
        self.assertTrue(handle.verify_replay_equivalence())
        handle.release_controller()

    def test_fail_result_fails_closed_before_signed_spec_and_trusted_unit(self):
        handle, _identity, _binding, grant = self.claim_builder()
        before = (self.root / "events.jsonl").read_bytes()
        result = PhaseResult(
            subject_sha="b" * 40, base_sha="a" * 40, result_sha="b" * 40,
            evidence_sha256="8" * 64,
            cleanup=CleanupEvidence("9" * 64, cgroup_empty=True),
            task_spec_sha256="6" * 64, unit_identity_sha256="7" * 64,
            instruction_sha256="a" * 64, instruction_bytes=1,
            instruction_materialization_sha256="a" * 64,
            instruction_materialization_bytes=1,
            instruction_transport_sha256="a" * 64,
            instruction_transport_bytes=1, cpu_usage_ns=1,
            memory_peak_bytes=1, tasks_peak=1, oom_count=0,
            oom_killed=False, systemd_service_result="success",
            systemd_exec_code=1, systemd_exec_status=0,
            resource_outcome_sha256="b" * 64,
        )

        with self.assertRaisesRegex(DurableStoreError, "builder.*FAIL|failure"):
            handle.reject_phase(
                grant, expected_task_version=grant.task_version, result=result,
            )

        self.assertEqual((self.root / "events.jsonl").read_bytes(), before)
        self.assertEqual(handle.phase_receipts("task-v2"), ())
        self.assertTrue(handle.verify_replay_equivalence())
        handle.release_controller()

    def test_phase_result_resource_evidence_is_complete_bounded_and_hash_only(self):
        values = {
            "subject_sha": "b" * 40,
            "base_sha": "a" * 40,
            "result_sha": "c" * 40,
            "evidence_sha256": "4" * 64,
            "cleanup": CleanupEvidence("5" * 64, cgroup_empty=True),
            "task_spec_sha256": "6" * 64,
            "unit_identity_sha256": "7" * 64,
            "instruction_sha256": "8" * 64,
            "instruction_bytes": 41,
            "instruction_materialization_sha256": "8" * 64,
            "instruction_materialization_bytes": 41,
            "instruction_transport_sha256": "8" * 64,
            "instruction_transport_bytes": 41,
            "cpu_usage_ns": 12_000,
            "memory_peak_bytes": 4096,
            "tasks_peak": 3,
            "oom_count": 0,
            "oom_killed": False,
            "systemd_service_result": "success",
            "systemd_exec_code": 1,
            "systemd_exec_status": 0,
            "resource_outcome_sha256": "9" * 64,
        }

        result = PhaseResult(**values)

        self.assertEqual(result.instruction_transport_bytes, 41)
        self.assertFalse(any(
            word in field for field in result.__dataclass_fields__
            for word in ("raw", "path", "output", "pid")
        ))
        invalid = (
            {"instruction_transport_sha256": None},
            {"instruction_materialization_bytes": 40},
            {"cpu_usage_ns": -1},
            {"oom_count": 0, "oom_killed": True},
            {"systemd_service_result": "forged"},
            {"systemd_exec_code": 4},
            {"systemd_exec_status": 256},
            {"resource_outcome_sha256": "not-a-digest"},
        )
        for changed in invalid:
            with self.subTest(changed=changed):
                with self.assertRaises(DurableStoreError):
                    PhaseResult(**(values | changed))

    def test_phase_policy_matches_every_worker_result_edge(self):
        claims = {
            "builder": ("READY", "LEASED"),
            "verifier": ("SUBMITTED", "VERIFYING"),
            "spec-reviewer": ("VERIFIED", "REVIEWING"),
            "regression-reviewer": ("VERIFIED", "REVIEWING"),
            "independent-reviewer": ("VERIFIED", "REVIEWING"),
            "integrator": ("REVIEWED", "INTEGRATING"),
            "post-merge-verifier": ("MERGED", "POST_MERGE_VERIFYING"),
        }
        for role, (before, after) in claims.items():
            with self.subTest(role=role):
                self.assertEqual(phase_claim_transition(role, before), after)
                with self.assertRaises(DurableStoreError):
                    phase_claim_transition(role, after)

        self.assertEqual(phase_result_transition("builder", "PASS"), "SUBMITTED")
        self.assertEqual(phase_result_transition("verifier", "PASS"), "VERIFIED")
        self.assertEqual(phase_result_transition("verifier", "FAIL"),
                         "CHANGES_REQUESTED")
        reviewers = ("spec-reviewer", "regression-reviewer", "independent-reviewer")
        self.assertEqual(
            phase_result_transition(reviewers[0], "PASS", ()), "VERIFIED"
        )
        self.assertEqual(
            phase_result_transition(reviewers[2], "PASS", reviewers[:2]), "REVIEWED"
        )
        self.assertEqual(
            phase_result_transition(reviewers[1], "FAIL", (reviewers[0],)),
            "CHANGES_REQUESTED",
        )
        with self.assertRaisesRegex(DurableStoreError, "merge-specific"):
            phase_result_transition("integrator", "PASS")
        with self.assertRaisesRegex(DurableStoreError, "merge-specific"):
            phase_result_transition("integrator", "FAIL")
        with self.assertRaisesRegex(DurableStoreError, "builder.*FAIL|failure"):
            phase_result_transition("builder", "FAIL")
        self.assertEqual(phase_result_transition("post-merge-verifier", "PASS"),
                         "POST_MERGE_VERIFIED")
        self.assertEqual(phase_result_transition("post-merge-verifier", "FAIL"),
                         "POST_MERGE_FAILED")
        self.assertNotIn(
            phase_result_transition("post-merge-verifier", "PASS"),
            {"MERGED", "DONE"},
        )

    def test_only_verifier_and_postmerge_verifier_may_reuse_identity(self):
        self.assertTrue(phase_identity_reuse_allowed(
            "verifier", "post-merge-verifier"
        ))
        self.assertTrue(phase_identity_reuse_allowed(
            "post-merge-verifier", "verifier"
        ))
        for existing in (
            "builder", "verifier", "spec-reviewer", "regression-reviewer",
            "independent-reviewer", "integrator", "post-merge-verifier",
        ):
            for proposed in (
                "builder", "verifier", "spec-reviewer", "regression-reviewer",
                "independent-reviewer", "integrator", "post-merge-verifier",
            ):
                if existing == proposed or {
                    existing, proposed
                } == {"verifier", "post-merge-verifier"}:
                    continue
                with self.subTest(existing=existing, proposed=proposed):
                    self.assertFalse(phase_identity_reuse_allowed(existing, proposed))

    def test_only_latest_registered_identity_generation_can_claim(self):
        handle = DurableProtocolStore(self.root)
        handle.claim_controller()
        handle.clear_campaign_recovery(
            "campaign-v2", expected_version=4, evidence_sha256="5" * 64
        )
        task = handle.bind_task_destination(
            "task-v2", repository="owner/repository", base_sha="a" * 40,
            pr_number=17, subject_sha="b" * 40, expected_version=2,
        )
        now = time.time()
        old_manifest, old_receipt = self.identity(now, generation=1)
        new_manifest, new_receipt = self.identity(now, generation=2)
        handle.register_identity(old_manifest, old_receipt)
        handle.register_identity(new_manifest, new_receipt)
        request = handle.phase_authority_request("task-v2", "builder")
        old_binding = validated_authority_binding(
            old_manifest, old_receipt, now, HMAC_KEY, request.operation_sha256,
        )
        before = (self.root / "events.jsonl").read_bytes()

        with self.assertRaisesRegex(DurableStoreError, "latest registered"):
            handle.claim_phase(
                "task-v2", "builder", old_binding, old_manifest, old_receipt,
                expected_task_version=task.version, ttl_seconds=60,
                controller_hmac_key=HMAC_KEY,
            )

        self.assertEqual((self.root / "events.jsonl").read_bytes(), before)
        new_binding = validated_authority_binding(
            new_manifest, new_receipt, now, HMAC_KEY, request.operation_sha256,
        )
        grant = handle.claim_phase(
            "task-v2", "builder", new_binding, new_manifest, new_receipt,
            expected_task_version=task.version, ttl_seconds=60,
            controller_hmac_key=HMAC_KEY,
        )
        self.assertEqual(grant.identity_receipt_sha256, new_binding.receipt_sha256)
        handle.release_controller()

    def test_identity_registration_rejects_generation_rollback_without_event(self):
        handle = DurableProtocolStore(self.root)
        handle.claim_controller()
        now = time.time()
        newer = self.identity(now, generation=2)
        older = self.identity(now, generation=1)
        handle.register_identity(*newer)
        before = (self.root / "events.jsonl").read_bytes()

        with self.assertRaisesRegex(DurableStoreError, "not monotonic"):
            handle.register_identity(*older)

        self.assertEqual((self.root / "events.jsonl").read_bytes(), before)
        handle.release_controller()

    def test_identity_lineage_is_one_event_and_replays_deterministically(self):
        handle = DurableProtocolStore(self.root)
        handle.claim_controller()
        now = time.time()
        first = self.identity(now, generation=1)
        second = self.identity(now, generation=2)
        before = (self.root / "events.jsonl").read_bytes()

        handle.register_identity(*first)

        after_first = (self.root / "events.jsonl").read_bytes()
        self.assertEqual(len(after_first.splitlines()), len(before.splitlines()) + 1)
        self.assertTrue(handle.verify_replay_equivalence())
        handle.register_identity(*second)
        after_second = (self.root / "events.jsonl").read_bytes()
        self.assertEqual(
            len(after_second.splitlines()), len(after_first.splitlines()) + 1,
        )
        with sqlite3.connect(self.root / "state.sqlite3") as db:
            self.assertEqual(
                db.execute("SELECT count(*) FROM identity_lineages").fetchone()[0], 1,
            )
            self.assertEqual(
                db.execute("SELECT count(*) FROM identity_registry").fetchone()[0], 2,
            )
        self.assertTrue(handle.verify_replay_equivalence())
        handle.release_controller()

    def test_process_race_cannot_split_an_identity_lineage_alias(self):
        now = time.time()
        first_manifest, first_receipt = self.identity(now, principal_id="race-one")
        alias_manifest, alias_receipt = self.identity(
            now, principal_id="race-two",
            authority_domain=first_manifest.authority_domain,
            adapter="claude",
        )
        alias_manifest = replace(
            alias_manifest,
            account_binding_sha256=first_manifest.account_binding_sha256,
        )
        alias_receipt = replace(
            alias_receipt,
            account_binding_sha256=first_receipt.account_binding_sha256,
        )
        context = multiprocessing.get_context("fork")
        start = context.Event()
        outcome = context.Queue()

        def register_in_process(manifest, receipt):
            store = DurableProtocolStore(self.root)
            claimed = False
            start.wait()
            try:
                store.claim_controller()
                claimed = True
                registration = store.register_identity(manifest, receipt)
                outcome.put(("registered", registration.principal_id))
            except BaseException as exc:
                outcome.put((type(exc).__name__, str(exc)))
            finally:
                if claimed:
                    store.release_controller()

        processes = (
            context.Process(
                target=register_in_process,
                args=(first_manifest, first_receipt),
            ),
            context.Process(
                target=register_in_process,
                args=(alias_manifest, alias_receipt),
            ),
        )
        for process in processes:
            process.start()
        start.set()
        for process in processes:
            process.join(15)
            self.assertEqual(process.exitcode, 0)
        outcomes = [outcome.get(timeout=2) for _ in processes]

        self.assertEqual(sum(item[0] == "registered" for item in outcomes), 1)
        with sqlite3.connect(self.root / "state.sqlite3") as db:
            self.assertEqual(
                db.execute("SELECT count(*) FROM identity_lineages").fetchone()[0], 1,
            )
            self.assertEqual(
                db.execute("SELECT count(*) FROM identity_registry").fetchone()[0], 1,
            )
        identity_events = [
            json.loads(line)["type"]
            for line in (self.root / "events.jsonl").read_bytes().splitlines()
        ].count("identity.registered.v2")
        self.assertEqual(identity_events, 1)
        self.assertTrue(DurableProtocolStore(self.root).verify_replay_equivalence())

    def test_identity_lineage_rejects_every_partial_tuple_alias_without_event(self):
        handle, manifest, receipt, _identity, _binding, _request = self.claimable_store()
        now = time.time()
        before = (self.root / "events.jsonl").read_bytes()
        same_principal, same_principal_receipt = self.identity(
            now, principal_id=manifest.principal_id,
            authority_domain="different-domain", adapter="claude",
        )
        same_domain, same_domain_receipt = self.identity(
            now, principal_id="different-principal",
            authority_domain=manifest.authority_domain, adapter="claude",
        )
        same_account, same_account_receipt = self.identity(
            now, principal_id="third-principal",
            authority_domain="third-domain", adapter="cursor",
        )
        same_account = replace(
            same_account, account_binding_sha256=manifest.account_binding_sha256,
        )
        same_account_receipt = replace(
            same_account_receipt,
            account_binding_sha256=receipt.account_binding_sha256,
        )

        for alias_manifest, alias_receipt in (
            (same_principal, same_principal_receipt),
            (same_domain, same_domain_receipt),
            (same_account, same_account_receipt),
        ):
            with self.subTest(
                principal=alias_manifest.principal_id,
                domain=alias_manifest.authority_domain,
            ):
                with self.assertRaisesRegex(DurableStoreError, "lineage|alias"):
                    handle.register_identity(alias_manifest, alias_receipt)
                self.assertEqual((self.root / "events.jsonl").read_bytes(), before)
        handle.release_controller()

    def test_new_identity_generation_quarantines_active_attempt_and_old_grant(self):
        handle, _identity, _binding, grant = self.claim_builder()
        now = time.time()
        newer = self.identity(now, generation=2)

        handle.register_identity(*newer)

        attempt = handle.phase_attempt(grant.attempt_id)
        self.assertEqual(attempt.state, "RECOVERY_REQUIRED")
        self.assertEqual(attempt.version, grant.attempt_version + 1)
        before = (self.root / "events.jsonl").read_bytes()
        with self.assertRaisesRegex(DurableStoreError, "latest|recovery|stale"):
            handle.heartbeat(
                grant, expected_lease_version=grant.lease_version, ttl_seconds=60,
            )
        self.assertEqual((self.root / "events.jsonl").read_bytes(), before)
        self.assertTrue(handle.verify_replay_equivalence())
        handle.release_controller()

    def test_destination_requires_current_epoch_and_cleared_campaign_recovery(self):
        handle = DurableProtocolStore(self.root)
        handle.claim_controller()
        before = (self.root / "events.jsonl").read_bytes()

        with self.assertRaisesRegex(DurableStoreError, "recovery|campaign"):
            handle.bind_task_destination(
                "task-v2", repository="owner/repository", base_sha="a" * 40,
                pr_number=17, subject_sha="b" * 40, expected_version=2,
            )

        self.assertEqual((self.root / "events.jsonl").read_bytes(), before)
        handle.release_controller()

    def test_destination_replay_rejects_rehashed_stale_epoch(self):
        handle = DurableProtocolStore(self.root)
        handle.claim_controller()
        handle.clear_campaign_recovery(
            "campaign-v2", expected_version=4, evidence_sha256="5" * 64,
        )
        handle.bind_task_destination(
            "task-v2", repository="owner/repository", base_sha="a" * 40,
            pr_number=17, subject_sha="b" * 40, expected_version=2,
        )
        handle.release_controller()
        ledger_path = self.root / "events.jsonl"
        lines = ledger_path.read_bytes().splitlines()
        event = json.loads(lines[-1].decode("ascii"))
        event["payload"]["epoch"] += 1
        event["hash"] = hashlib.sha256(durable_store._raw_event(
            event["prev"], event["type"], event["payload"], event["created_at"],
        ).encode()).hexdigest()
        lines[-1] = durable_store._canonical(event)
        ledger_path.write_bytes(b"\n".join(lines) + b"\n")

        with self.assertRaisesRegex(DurableStoreError, "epoch|destination"):
            DurableProtocolStore(self.root).replay_projection()

    def test_reserved_runner_receipt_tables_have_strict_bounded_evidence_columns(self):
        with sqlite3.connect(self.root / "state.sqlite3") as db:
            db.execute("PRAGMA foreign_keys=ON")
            unit_columns = {
                row[1] for row in db.execute("PRAGMA table_info('attempt_units')")
            }
            workspace_columns = {
                row[1] for row in db.execute("PRAGMA table_info('attempt_workspaces')")
            }
            home_columns = {
                row[1] for row in db.execute("PRAGMA table_info('attempt_homes')")
            }
            input_columns = {
                row[1] for row in db.execute("PRAGMA table_info('attempt_inputs')")
            }
            spec_columns = {
                row[1] for row in db.execute("PRAGMA table_info('task_specs')")
            }
            receipt_columns = {
                row[1] for row in db.execute("PRAGMA table_info('phase_receipts')")
            }
            for stream in ("stdout", "stderr"):
                self.assertTrue({
                    f"{stream}_observed_sha256", f"{stream}_observed_bytes",
                    f"{stream}_retained_sha256", f"{stream}_retained_bytes",
                    f"{stream}_eof",
                }.issubset(unit_columns))
            self.assertTrue({
                "output_overflow", "timed_out", "cancelled", "drain_limit_hit",
                "raw_evidence_status", "stop_callback_status", "recovery_required",
            }.issubset(unit_columns))
            self.assertNotIn("cgroup", unit_columns)
            self.assertTrue({
                "attempt_id", "task_id", "task_spec_sha256", "subject_sha",
                "tree_sha256", "inventory_sha256", "file_count", "total_bytes",
                "prepared_event_seq",
            }.issubset(workspace_columns))
            self.assertTrue({
                "attempt_id", "binding_id", "principal_id", "authority_domain",
                "account_binding_sha256", "identity_receipt_sha256", "manifest_sha256",
                "task_spec_sha256",
                "materialization_attestation_sha256", "artifact_count",
                "total_bytes", "prepared_event_seq",
            }.issubset(home_columns))
            self.assertTrue({
                "attempt_id", "task_id", "task_attempt", "execution_generation",
                "role", "binding_id", "principal_id", "authority_domain",
                "account_binding_sha256", "identity_receipt_sha256", "manifest_sha256",
                "task_spec_sha256", "instruction_sha256", "instruction_bytes",
                "materialization_attestation_sha256", "prepared_event_seq",
            }.issubset(input_columns))
            self.assertTrue({
                "task_id", "task_attempt", "execution_generation", "role",
                "binding_id", "principal_id", "authority_domain",
                "account_binding_sha256", "identity_receipt_sha256", "manifest_sha256",
                "task_spec_sha256", "instruction_sha256", "instruction_bytes",
                "workspace_subject_sha", "workspace_tree_sha256",
                "workspace_inventory_sha256",
                "home_materialization_attestation_sha256",
                "input_materialization_attestation_sha256",
                "instruction_materialization_sha256",
                "instruction_materialization_bytes",
                "instruction_transport_sha256", "instruction_transport_bytes",
                "cpu_usage_ns", "memory_peak_bytes", "tasks_peak", "oom_count",
                "oom_killed", "systemd_service_result", "systemd_exec_code",
                "systemd_exec_status", "resource_outcome_sha256",
            }.issubset(unit_columns))
            self.assertTrue({
                "instruction_sha256", "instruction_bytes",
            }.issubset(spec_columns))
            self.assertTrue({
                "instruction_materialization_sha256",
                "instruction_materialization_bytes",
                "instruction_transport_sha256", "instruction_transport_bytes",
                "cpu_usage_ns", "memory_peak_bytes", "tasks_peak", "oom_count",
                "oom_killed", "systemd_service_result", "systemd_exec_code",
                "systemd_exec_status", "resource_outcome_sha256",
            }.issubset(receipt_columns))
            self.assertFalse(any(
                forbidden in column for column in receipt_columns
                for forbidden in ("raw", "path", "pid")
            ))
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute(
                    "INSERT INTO attempt_workspaces(attempt_id,task_id,task_attempt,"
                    "execution_generation,role,task_spec_sha256,subject_sha,tree_sha256,"
                    "inventory_sha256,file_count,total_bytes,prepared_event_seq) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                    ("f" * 64, "missing-task", 1, 1, "builder", "1" * 64,
                     "2" * 40, "3" * 64, "4" * 64, -1, 0, 1),
                )
            db.rollback()
            db.execute("PRAGMA foreign_keys=OFF")
            digest = "a" * 64
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute(
                    "INSERT INTO attempt_units("
                    "attempt_id,unit_name,state,launch_intent_sha256,argv_sha256,"
                    "bwrap_sha256,executable_sha256,requested_properties_sha256,"
                    "version,created_event_seq,updated_event_seq) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    ("b" * 64, "attempt-unit.service", "STOPPED", digest, digest,
                     digest, digest, digest, 1, 1, 1),
                )
            db.execute(
                "INSERT INTO task_specs(attempt_id,task_id,task_attempt,"
                "execution_generation,role,controller_epoch) VALUES(?,?,?,?,?,?)",
                ("c" * 64, "missing-task", 1, 1, "builder", 1),
            )
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute(
                    "UPDATE task_specs SET schema_version=2,task_spec_sha256=?,"
                    "canonical_json=?,instruction_sha256=?,instruction_bytes=1,"
                    "signing_key_id='controller',signature_sha256=?,expires_at=1,"
                    "attached_event_seq=1 WHERE attempt_id=?",
                    (digest, '"' + ("x" * 65536) + '"', digest, digest, "c" * 64),
                )

    def test_preparation_chain_rejects_mismatched_receipt_dimensions(self):
        handle, _identity, _binding, grant = self.claim_builder()
        spec_sha = "1" * 64
        instruction_sha = "2" * 64
        workspace_tree = "3" * 64
        workspace_inventory = "4" * 64
        home_attestation = "5" * 64
        input_attestation = "6" * 64
        with sqlite3.connect(self.root / "state.sqlite3") as db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys=ON")
            attempt = db.execute(
                "SELECT a.*,b.account_binding_sha256,b.identity_receipt_sha256,"
                "b.manifest_sha256 FROM phase_attempts a "
                "JOIN consumed_authority_bindings b ON b.binding_id=a.binding_id "
                "WHERE a.attempt_id=?", (grant.attempt_id,),
            ).fetchone()

            def reserve_event(label):
                sequence = db.execute(
                    "SELECT coalesce(max(seq),0)+1 FROM events"
                ).fetchone()[0]
                db.execute(
                    "INSERT INTO events VALUES(?,?,?,?,?)",
                    (sequence, hashlib.sha256(label.encode()).hexdigest(),
                     "test.preparation.receipt", "{}", time.time()),
                )
                return sequence

            spec_event = reserve_event("spec")
            db.execute(
                "UPDATE task_specs SET schema_version=2,task_spec_sha256=?,"
                "canonical_json='{}',instruction_sha256=?,instruction_bytes=41,"
                "signing_key_id='controller',signature_sha256=?,expires_at=?,"
                "attached_event_seq=? WHERE attempt_id=?",
                (spec_sha, "2" * 64, "7" * 64, time.time() + 300,
                 spec_event, grant.attempt_id),
            )
            workspace_event = reserve_event("workspace")
            db.execute(
                "INSERT INTO attempt_workspaces VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (grant.attempt_id, grant.task_id, grant.task_attempt,
                 grant.execution_generation, grant.role, spec_sha,
                 grant.subject_sha, workspace_tree, workspace_inventory,
                 4, 1024, workspace_event),
            )
            home_event = reserve_event("home")
            home = {
                "attempt_id": grant.attempt_id, "task_id": grant.task_id,
                "task_attempt": grant.task_attempt,
                "execution_generation": grant.execution_generation,
                "role": grant.role, "binding_id": grant.binding_id,
                "principal_id": grant.principal_id,
                "authority_domain": grant.authority_domain,
                "account_binding_sha256": grant.account_binding_sha256,
                "identity_receipt_sha256": grant.identity_receipt_sha256,
                "manifest_sha256": attempt["manifest_sha256"],
                "task_spec_sha256": spec_sha,
                "materialization_attestation_sha256": home_attestation,
                "artifact_count": 1, "total_bytes": 128,
                "prepared_event_seq": home_event,
            }
            home_columns = tuple(home)
            home_sql = (
                "INSERT INTO attempt_homes(" + ",".join(home_columns) + ") VALUES(" +
                ",".join(":" + column for column in home_columns) + ")"
            )
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute(home_sql, home | {"principal_id": "forged-principal"})
            db.execute(home_sql, home)

            input_event = reserve_event("input")
            input_receipt = {
                key: home[key] for key in (
                    "attempt_id", "task_id", "task_attempt",
                    "execution_generation", "role", "binding_id", "principal_id",
                    "authority_domain", "account_binding_sha256",
                    "identity_receipt_sha256", "manifest_sha256",
                    "task_spec_sha256",
                )
            } | {
                "instruction_sha256": instruction_sha, "instruction_bytes": 41,
                "materialization_attestation_sha256": input_attestation,
                "prepared_event_seq": input_event,
            }
            input_columns = tuple(input_receipt)
            input_sql = (
                "INSERT INTO attempt_inputs(" + ",".join(input_columns) + ") VALUES(" +
                ",".join(":" + column for column in input_columns) + ")"
            )
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute(
                    input_sql,
                    input_receipt | {"instruction_sha256": "8" * 64},
                )
            db.execute(input_sql, input_receipt)

            unit_event = reserve_event("unit")
            unit = {
                key: input_receipt[key] for key in (
                    "attempt_id", "task_id", "task_attempt",
                    "execution_generation", "role", "binding_id", "principal_id",
                    "authority_domain", "account_binding_sha256",
                    "identity_receipt_sha256", "manifest_sha256",
                    "task_spec_sha256", "instruction_sha256", "instruction_bytes",
                )
            } | {
                "workspace_subject_sha": grant.subject_sha,
                "workspace_tree_sha256": workspace_tree,
                "workspace_inventory_sha256": workspace_inventory,
                "home_materialization_attestation_sha256": home_attestation,
                "input_materialization_attestation_sha256": input_attestation,
                "instruction_materialization_sha256": instruction_sha,
                "instruction_materialization_bytes": 41,
                "instruction_transport_sha256": instruction_sha,
                "instruction_transport_bytes": 41,
                "unit_name": "gauntlet-attempt.service", "state": "PREPARED",
                "launch_intent_sha256": "9" * 64, "argv_sha256": "a" * 64,
                "bwrap_sha256": "b" * 64, "executable_sha256": "c" * 64,
                "requested_properties_sha256": "d" * 64, "version": 1,
                "created_event_seq": unit_event, "updated_event_seq": unit_event,
            }
            unit_columns = tuple(unit)
            unit_sql = (
                "INSERT INTO attempt_units(" + ",".join(unit_columns) + ") VALUES(" +
                ",".join(":" + column for column in unit_columns) + ")"
            )
            for changed in (
                {"workspace_tree_sha256": "e" * 64},
                {"home_materialization_attestation_sha256": "e" * 64},
                {"input_materialization_attestation_sha256": "e" * 64},
                {"task_spec_sha256": "e" * 64},
            ):
                with self.subTest(changed=changed):
                    with self.assertRaises(sqlite3.IntegrityError):
                        db.execute(unit_sql, unit | changed)
            db.execute(unit_sql, unit)
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute(
                    "UPDATE attempt_units SET state='STOPPED' WHERE attempt_id=?",
                    (grant.attempt_id,),
                )
            stopped = {
                "observed_unit_sha256": "1" * 64,
                "effective_properties_sha256": "2" * 64,
                "main_pid": 123,
                "cgroup_identity_sha256": "3" * 64,
                "exit_outcome": "EXITED", "exit_code": 0,
                "stdout_observed_sha256": "4" * 64,
                "stdout_observed_bytes": 10,
                "stdout_retained_sha256": "4" * 64,
                "stdout_retained_bytes": 10, "stdout_eof": 1,
                "stderr_observed_sha256": "5" * 64,
                "stderr_observed_bytes": 0,
                "stderr_retained_sha256": "5" * 64,
                "stderr_retained_bytes": 0, "stderr_eof": 1,
                "raw_evidence_status": "COMMITTED", "cgroup_empty": 1,
                "cpu_usage_ns": 12_000, "memory_peak_bytes": 4096,
                "tasks_peak": 3, "oom_count": 0, "oom_killed": 0,
                "systemd_service_result": "success", "systemd_exec_code": 1,
                "systemd_exec_status": 0, "resource_outcome_sha256": "6" * 64,
            }
            stopped_sql = "UPDATE attempt_units SET state='STOPPED'," + ",".join(
                column + "=:" + column for column in stopped
            ) + " WHERE attempt_id=:attempt_id"
            premature_sql = "UPDATE attempt_units SET " + ",".join(
                column + "=:" + column for column in stopped
            ) + " WHERE attempt_id=:attempt_id"
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute(
                    premature_sql,
                    stopped | {"attempt_id": grant.attempt_id},
                )
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute(
                    stopped_sql,
                    stopped | {"attempt_id": grant.attempt_id, "oom_killed": 1},
                )
            db.execute(stopped_sql, stopped | {"attempt_id": grant.attempt_id})
            receipt_event = reserve_event("phase-receipt")
            phase_receipt = {
                "id": "7" * 64, "attempt_id": grant.attempt_id,
                "task_id": grant.task_id, "task_attempt": grant.task_attempt,
                "execution_generation": grant.execution_generation,
                "phase": grant.role, "role": grant.role,
                "principal_id": grant.principal_id,
                "authority_domain": grant.authority_domain, "verdict": "PASS",
                "subject_sha": grant.subject_sha, "base_sha": grant.base_sha,
                "result_sha": "8" * 40, "evidence_sha256": "8" * 64,
                "cleanup_evidence_sha256": "9" * 64, "cgroup_empty": 1,
                "identity_receipt_sha256": grant.identity_receipt_sha256,
                "account_binding_sha256": grant.account_binding_sha256,
                "task_spec_sha256": spec_sha,
                "instruction_sha256": instruction_sha, "instruction_bytes": 41,
                "instruction_materialization_sha256": instruction_sha,
                "instruction_materialization_bytes": 41,
                "instruction_transport_sha256": instruction_sha,
                "instruction_transport_bytes": 41,
                "unit_identity_sha256": stopped["observed_unit_sha256"],
                "cpu_usage_ns": stopped["cpu_usage_ns"],
                "memory_peak_bytes": stopped["memory_peak_bytes"],
                "tasks_peak": stopped["tasks_peak"],
                "oom_count": stopped["oom_count"],
                "oom_killed": stopped["oom_killed"],
                "systemd_service_result": stopped["systemd_service_result"],
                "systemd_exec_code": stopped["systemd_exec_code"],
                "systemd_exec_status": stopped["systemd_exec_status"],
                "resource_outcome_sha256": stopped["resource_outcome_sha256"],
                "lease_resource": grant.resource, "lease_token": grant.token,
                "run_id": grant.run_id, "binding_id": grant.binding_id,
                "epoch": grant.epoch, "task_version_before": grant.task_version,
                "task_version_after": grant.task_version + 1,
                "event_seq": receipt_event, "authoritative": 1,
                "created_at": time.time(),
            }
            receipt_columns = tuple(phase_receipt)
            receipt_sql = (
                "INSERT INTO phase_receipts(" + ",".join(receipt_columns) +
                ") VALUES(" + ",".join(":" + column for column in receipt_columns) +
                ")"
            )
            for changed in (
                {"execution_generation": grant.execution_generation + 1},
                {"task_spec_sha256": "e" * 64},
                {"instruction_sha256": "e" * 64,
                 "instruction_materialization_sha256": "e" * 64,
                 "instruction_transport_sha256": "e" * 64},
                {"unit_identity_sha256": "e" * 64},
                {"resource_outcome_sha256": "e" * 64},
            ):
                with self.subTest(receipt_changed=changed):
                    with self.assertRaises(sqlite3.IntegrityError):
                        db.execute(receipt_sql, phase_receipt | changed)
            db.execute(receipt_sql, phase_receipt)
            self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])
            db.rollback()
        handle.release_controller()

    def test_merge_reservations_reject_orphans_malformed_digests_and_counters(self):
        with sqlite3.connect(self.root / "state.sqlite3") as db:
            db.execute("PRAGMA foreign_keys=ON")
            invalid_operations = (
                ("not-a-digest", "missing", 1, 1, None, "PREPARED", "a" * 64,
                 None, None, 1, time.time()),
                ("a" * 64, "missing", 0, 1, None, "PREPARED", "b" * 64,
                 None, None, 1, time.time()),
                ("b" * 64, "missing", 1, 1, None, "UNKNOWN", "c" * 64,
                 None, None, 1, time.time()),
                ("d" * 64, "missing", 1, 1, None, "PREPARED", "e" * 64,
                 None, None, 1, time.time()),
            )
            for row in invalid_operations:
                with self.subTest(row=row):
                    with self.assertRaises(sqlite3.IntegrityError):
                        db.execute(
                            "INSERT INTO merge_operations VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                            row,
                        )
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute(
                    "INSERT INTO merge_claims VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    ("merge/global", 1, "task-v2", 1, "a" * 40, "b" * 40,
                     17, "f" * 64, 1, "HELD", 1, None, time.time()),
                )

    def test_result_rejects_every_stale_grant_and_cas_dimension_without_event(self):
        handle, _identity, _binding, grant = self.claim_builder()
        valid = PhaseResult(
            subject_sha="b" * 40, base_sha="a" * 40, result_sha="c" * 40,
            evidence_sha256="6" * 64,
            cleanup=CleanupEvidence("7" * 64, cgroup_empty=True),
            task_spec_sha256="8" * 64, unit_identity_sha256="9" * 64,
            instruction_sha256="a" * 64, instruction_bytes=1,
            instruction_materialization_sha256="a" * 64,
            instruction_materialization_bytes=1,
            instruction_transport_sha256="a" * 64,
            instruction_transport_bytes=1, cpu_usage_ns=1,
            memory_peak_bytes=1, tasks_peak=1, oom_count=0,
            oom_killed=False, systemd_service_result="success",
            systemd_exec_code=1, systemd_exec_status=0,
            resource_outcome_sha256="b" * 64,
        )
        cases = (
            replace(grant, attempt_id="f" * 64),
            replace(grant, resource="task:forged:resource"),
            replace(grant, run_id="f" * 64),
            replace(grant, binding_id="f" * 64),
            replace(grant, account_binding_sha256="f" * 64),
            replace(grant, identity_receipt_sha256="f" * 64),
            replace(grant, base_sha="d" * 40),
            replace(grant, subject_sha="d" * 40),
            replace(grant, task_version=grant.task_version + 1),
            replace(grant, execution_generation=grant.execution_generation + 1),
            replace(grant, attempt_version=grant.attempt_version + 1),
            replace(grant, lease_version=grant.lease_version + 1),
            replace(grant, expires_at=grant.expires_at + 1),
            replace(grant, epoch=grant.epoch + 1),
            replace(grant, token=grant.token + 1),
            replace(grant, principal_id="other-builder"),
            replace(grant, authority_domain="other-domain"),
            replace(grant, role="verifier"),
            replace(grant, task_attempt=grant.task_attempt + 1),
            replace(grant, task_id="task-v2-other"),
        )
        before = (self.root / "events.jsonl").read_bytes()
        for stale_grant in cases:
            with self.subTest(stale_grant=stale_grant):
                with self.assertRaisesRegex(
                    DurableStoreError, "stale|no longer live"
                ):
                    handle.commit_phase(
                        stale_grant, expected_task_version=stale_grant.task_version,
                        result=valid,
                    )
                self.assertEqual((self.root / "events.jsonl").read_bytes(), before)
        handle.release_controller()


if __name__ == "__main__":
    unittest.main()
