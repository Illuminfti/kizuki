import contextlib
import fcntl
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from gauntlet import runtime_intent as runtime_intent_module
from gauntlet.runtime_intent import (
    PrefixProjectionProof,
    ProjectionEventProof,
    RuntimeIntentError,
    RuntimeIntentJournal,
)


GENESIS = "0" * 64


@contextlib.contextmanager
def locked_journal(root):
    for name in (".controller.lock", ".writer.lock"):
        path = root / name
        if not path.exists():
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.fchmod(fd, 0o600)
                os.fsync(fd)
            finally:
                os.close(fd)
    controller_fd = os.open(
        root / ".controller.lock",
        os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
    )
    writer_fd = os.open(
        root / ".writer.lock",
        os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0),
    )
    journal = None
    try:
        fcntl.flock(controller_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(writer_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        journal = RuntimeIntentJournal._from_locked_fds(
            root, writer_lock_fd=writer_fd,
            controller_lock_fd=controller_fd,
        )
        yield journal
    finally:
        if journal is not None:
            journal.close()
        fcntl.flock(writer_fd, fcntl.LOCK_UN)
        fcntl.flock(controller_fd, fcntl.LOCK_UN)
        os.close(writer_fd)
        os.close(controller_fd)


def crash_child(root, stage, operation):
    child = os.fork()
    if child == 0:
        try:
            with locked_journal(root) as journal:
                runtime_intent_module._CRASH_HOOK = (
                    lambda observed: os._exit(73) if observed == stage else None
                )
                operation(journal)
        except BaseException:
            os._exit(72)
        os._exit(71)
    waited, status = os.waitpid(child, 0)
    if waited != child or not os.WIFEXITED(status):
        raise AssertionError("crash child did not exit deterministically")
    if os.WEXITSTATUS(status) != 73:
        raise AssertionError(
            f"crash child missed {stage}: exit={os.WEXITSTATUS(status)}"
        )


def canonical(value):
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
        allow_nan=False,
    ).encode("ascii")


def event_line(previous=GENESIS, event_type="protocol.phase_result", epoch=7):
    payload = {"epoch": epoch, "task_id": "task-1", "verdict": "PASS"}
    created_at = 1_777_777_777
    digest = hashlib.sha256(canonical({
        "created_at": created_at,
        "payload": payload,
        "prev": previous,
        "type": event_type,
    })).hexdigest()
    return canonical({
        "created_at": created_at,
        "hash": digest,
        "payload": payload,
        "prev": previous,
        "type": event_type,
    }) + b"\n", digest


class RuntimeIntentJournalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "state"
        self.root.mkdir(mode=0o700)
        self.root.chmod(0o700)
        self.ledger = self.root / "events.jsonl"
        self.ledger.write_bytes(b"")
        self.ledger.chmod(0o600)

    def tearDown(self):
        self.temp.cleanup()

    def test_prepare_publishes_one_private_canonical_intent_and_inspect_is_stable(self):
        line, event_hash = event_line()
        with locked_journal(self.root) as journal:
            intent = journal.prepare(
                event_line=line,
                event_hash=event_hash,
                event_sequence=1,
                ledger_prefix_bytes=0,
                ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                ledger_prefix_tip_hash=GENESIS,
                ledger_prefix_event_count=0,
                projection_sha256="a" * 64,
                epoch=7,
            )
            observed = journal.inspect()

        self.assertEqual(observed, intent)
        self.assertEqual(intent.event_line, line)
        self.assertEqual(intent.event_hash, event_hash)
        self.assertEqual(intent.event_sequence, 1)
        self.assertEqual(intent.event_line_sha256, hashlib.sha256(line).hexdigest())
        self.assertEqual(len(intent.record_sha256), 64)
        path = self.root / ".runtime-intent"
        info = path.stat()
        self.assertEqual(info.st_mode & 0o777, 0o600)
        self.assertEqual(info.st_nlink, 1)
        raw = path.read_bytes()
        self.assertTrue(raw.endswith(b"\n"))
        self.assertEqual(
            raw[:-1],
            json.dumps(
                json.loads(raw), sort_keys=True, separators=(",", ":"),
                ensure_ascii=True, allow_nan=False,
            ).encode("ascii"),
        )
        self.assertFalse((self.root / ".runtime-intent.staging").exists())

    def test_recovery_appends_and_fsyncs_the_exact_event_once(self):
        line, event_hash = event_line()
        with locked_journal(self.root) as journal:
            intent = journal.prepare(
                event_line=line,
                event_hash=event_hash,
                event_sequence=1,
                ledger_prefix_bytes=0,
                ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                ledger_prefix_tip_hash=GENESIS,
                ledger_prefix_event_count=0,
                projection_sha256="a" * 64,
                epoch=7,
            )
            receipt = journal.recover_ledger()
            repeated = journal.recover_ledger()

        self.assertEqual(self.ledger.read_bytes(), line)
        self.assertEqual(receipt.intent_sha256, intent.record_sha256)
        self.assertEqual(receipt.event_hash, event_hash)
        self.assertEqual(receipt.event_sequence, 1)
        self.assertEqual(receipt.appended_bytes, len(line))
        self.assertFalse(receipt.already_complete)
        self.assertEqual(repeated.appended_bytes, 0)
        self.assertTrue(repeated.already_complete)
        self.assertEqual(repeated.ledger_sha256, hashlib.sha256(line).hexdigest())

    def test_recovery_finishes_only_an_exact_event_prefix_and_never_truncates(self):
        cases = {
            "empty": b"",
            "one-byte": None,
            "half": None,
            "all-but-one": None,
            "full": None,
            "divergent": b"x",
            "duplicate": None,
            "extra": None,
        }
        for name in tuple(cases):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as case:
                root = Path(case) / "state"
                root.mkdir(mode=0o700)
                root.chmod(0o700)
                ledger = root / "events.jsonl"
                ledger.write_bytes(b"")
                ledger.chmod(0o600)
                line, digest = event_line()
                with locked_journal(root) as journal:
                    journal.prepare(
                        event_line=line,
                        event_hash=digest,
                        event_sequence=1,
                        ledger_prefix_bytes=0,
                        ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                        ledger_prefix_tip_hash=GENESIS,
                        ledger_prefix_event_count=0,
                        projection_sha256="a" * 64,
                        epoch=7,
                    )
                    tails = {
                        "empty": b"",
                        "one-byte": line[:1],
                        "half": line[:len(line) // 2],
                        "all-but-one": line[:-1],
                        "full": line,
                        "divergent": b"x",
                        "duplicate": line + line,
                        "extra": line + b"x",
                    }
                    ledger.write_bytes(tails[name])
                    ledger.chmod(0o600)
                    before = ledger.read_bytes()
                    if name in {"divergent", "duplicate", "extra"}:
                        with self.assertRaisesRegex(
                            RuntimeIntentError, "divergent|after",
                        ):
                            journal.recover_ledger()
                        self.assertEqual(ledger.read_bytes(), before)
                    else:
                        receipt = journal.recover_ledger()
                        self.assertEqual(ledger.read_bytes(), line)
                        self.assertEqual(receipt.appended_bytes, len(line) - len(before))

    def test_clear_requires_exact_projection_proof_and_is_idempotent(self):
        line, event_hash = event_line()
        with locked_journal(self.root) as journal:
            intent = journal.prepare(
                event_line=line,
                event_hash=event_hash,
                event_sequence=1,
                ledger_prefix_bytes=0,
                ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                ledger_prefix_tip_hash=GENESIS,
                ledger_prefix_event_count=0,
                projection_sha256="a" * 64,
                epoch=7,
            )
            journal.recover_ledger()
        proof = ProjectionEventProof(
            event_line_sha256=intent.event_line_sha256,
            event_hash=event_hash,
            event_sequence=1,
            epoch=7,
            prior_projection_sha256="a" * 64,
            projection_sha256="b" * 64,
        )
        forged = ProjectionEventProof(
            event_line_sha256="c" * 64,
            event_hash=event_hash,
            event_sequence=1,
            epoch=7,
            prior_projection_sha256="a" * 64,
            projection_sha256="b" * 64,
        )
        unchanged = ProjectionEventProof(
            event_line_sha256=intent.event_line_sha256,
            event_hash=event_hash,
            event_sequence=1,
            epoch=7,
            prior_projection_sha256="a" * 64,
            projection_sha256="a" * 64,
        )
        with locked_journal(self.root) as journal:
            self.ledger.write_bytes(line[:-1])
            with self.assertRaisesRegex(RuntimeIntentError, "exact intended event"):
                journal.clear(intent, proof)
            self.assertEqual(self.ledger.read_bytes(), line[:-1])
            self.ledger.write_bytes(line)
            with self.assertRaisesRegex(RuntimeIntentError, "projection proof"):
                journal.clear(intent, forged)
            with self.assertRaisesRegex(RuntimeIntentError, "must change"):
                journal.clear(intent, unchanged)
            self.assertTrue((self.root / ".runtime-intent").exists())

        with locked_journal(self.root) as reopened:
            receipt = reopened.clear(intent, proof)
            repeated = reopened.clear(intent, proof)

        self.assertFalse((self.root / ".runtime-intent").exists())
        self.assertEqual(self.ledger.read_bytes(), line)
        self.assertEqual(receipt.intent_sha256, intent.record_sha256)
        self.assertFalse(receipt.already_absent)
        self.assertTrue(repeated.already_absent)
        self.assertEqual(receipt.projection_sha256, "b" * 64)

    def test_clear_retires_by_verified_identity_without_unlinking_names(self):
        line, digest = event_line()
        with locked_journal(self.root) as journal:
            intent = journal.prepare(
                event_line=line,
                event_hash=digest,
                event_sequence=1,
                ledger_prefix_bytes=0,
                ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                ledger_prefix_tip_hash=GENESIS,
                ledger_prefix_event_count=0,
                projection_sha256="a" * 64,
                epoch=7,
            )
            journal.recover_ledger()
            proof = ProjectionEventProof(
                event_line_sha256=intent.event_line_sha256,
                event_hash=digest,
                event_sequence=1,
                epoch=7,
                prior_projection_sha256="a" * 64,
                projection_sha256="b" * 64,
            )
            with mock.patch.object(
                runtime_intent_module.os, "unlink",
                side_effect=AssertionError("retirement must not unlink"),
            ):
                receipt = journal.clear(intent, proof)
        self.assertFalse(receipt.already_absent)
        self.assertFalse((self.root / ".runtime-intent").exists())
        retired = self.root / ".runtime-intent.retired"
        self.assertTrue(retired.exists())
        self.assertEqual(retired.stat().st_nlink, 1)
        self.assertEqual(retired.stat().st_mode & 0o777, 0o600)
        with RuntimeIntentJournal(self.root) as observer:
            self.assertIsNone(observer.inspect())

        with locked_journal(self.root) as journal:
            with mock.patch.object(
                runtime_intent_module.os, "fsync",
                side_effect=OSError("injected already-absent sync failure"),
            ):
                with self.assertRaisesRegex(OSError, "already-absent"):
                    journal.clear(intent, proof)

    def test_retirement_never_deletes_an_active_name_replacement(self):
        line, digest = event_line()
        with locked_journal(self.root) as journal:
            intent = journal.prepare(
                event_line=line,
                event_hash=digest,
                event_sequence=1,
                ledger_prefix_bytes=0,
                ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                ledger_prefix_tip_hash=GENESIS,
                ledger_prefix_event_count=0,
                projection_sha256="a" * 64,
                epoch=7,
            )
            journal.recover_ledger()
            proof = ProjectionEventProof(
                event_line_sha256=intent.event_line_sha256,
                event_hash=digest,
                event_sequence=1,
                epoch=7,
                prior_projection_sha256="a" * 64,
                projection_sha256="b" * 64,
            )
            real_rename = runtime_intent_module._rename_no_replace
            saved = self.root / ".runtime-intent.saved"

            def replace_before_retirement(directory_fd, source, destination):
                os.rename(
                    source, saved.name, src_dir_fd=directory_fd,
                    dst_dir_fd=directory_fd,
                )
                rival_fd = os.open(
                    source, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600,
                    dir_fd=directory_fd,
                )
                try:
                    os.fchmod(rival_fd, 0o600)
                    os.write(rival_fd, b"rival")
                    os.fsync(rival_fd)
                finally:
                    os.close(rival_fd)
                return real_rename(directory_fd, source, destination)

            with mock.patch.object(
                runtime_intent_module, "_rename_no_replace",
                side_effect=replace_before_retirement,
            ):
                with self.assertRaisesRegex(RuntimeIntentError, "changed|identity|valid"):
                    journal.clear(intent, proof)
        self.assertEqual(
            (self.root / ".runtime-intent.retired").read_bytes(), b"rival",
        )
        self.assertTrue(saved.exists())

    def test_staging_reset_never_truncates_a_name_replacement(self):
        staging = self.root / ".runtime-intent.staging"
        staging.write_bytes(b"partial")
        staging.chmod(0o600)
        proof = PrefixProjectionProof(
            ledger_prefix_bytes=0,
            ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
            ledger_prefix_tip_hash=GENESIS,
            ledger_prefix_event_count=0,
            projection_sha256="a" * 64,
            epoch=7,
        )
        saved = self.root / ".runtime-intent.staging.saved"
        real_ftruncate = runtime_intent_module.os.ftruncate
        injected = False

        def replace_before_truncate(fd, length):
            nonlocal injected
            if not injected:
                injected = True
                staging.rename(saved)
                staging.write_bytes(b"rival")
                staging.chmod(0o600)
            return real_ftruncate(fd, length)

        with locked_journal(self.root) as journal, mock.patch.object(
            runtime_intent_module.os, "ftruncate",
            side_effect=replace_before_truncate,
        ):
            with self.assertRaisesRegex(RuntimeIntentError, "changed|replaced"):
                journal.discard_staging(proof)
        self.assertEqual(staging.read_bytes(), b"rival")
        self.assertEqual(
            saved.read_bytes(), runtime_intent_module._VACANT_STAGING_RECORD,
        )

    def test_crash_callbacks_cannot_continue_after_lock_authority_changes(self):
        line, digest = event_line()
        with locked_journal(self.root) as journal:
            journal.prepare(
                event_line=line,
                event_hash=digest,
                event_sequence=1,
                ledger_prefix_bytes=0,
                ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                ledger_prefix_tip_hash=GENESIS,
                ledger_prefix_event_count=0,
                projection_sha256="a" * 64,
                epoch=7,
            )
            original = runtime_intent_module._CRASH_HOOK

            def replace_lock(stage):
                if stage != "during_ledger_append":
                    return
                (self.root / ".writer.lock").rename(
                    self.root / ".writer.lock.old",
                )
                replacement = self.root / ".writer.lock"
                replacement.write_bytes(b"")
                replacement.chmod(0o600)

            runtime_intent_module._CRASH_HOOK = replace_lock
            try:
                with self.assertRaisesRegex(RuntimeIntentError, "replaced"):
                    journal.recover_ledger()
            finally:
                runtime_intent_module._CRASH_HOOK = original
        self.assertEqual(self.ledger.read_bytes(), line[:len(line) // 2])

    def test_partial_staging_requires_exact_prefix_and_projection_discard_proof(self):
        class Crash(BaseException):
            pass

        line, event_hash = event_line()
        proof = PrefixProjectionProof(
            ledger_prefix_bytes=0,
            ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
            ledger_prefix_tip_hash=GENESIS,
            ledger_prefix_event_count=0,
            projection_sha256="a" * 64,
            epoch=7,
        )
        wrong = PrefixProjectionProof(
            ledger_prefix_bytes=0,
            ledger_prefix_sha256="c" * 64,
            ledger_prefix_tip_hash=GENESIS,
            ledger_prefix_event_count=0,
            projection_sha256="a" * 64,
            epoch=7,
        )
        with locked_journal(self.root) as journal:
            original = runtime_intent_module._CRASH_HOOK
            runtime_intent_module._CRASH_HOOK = (
                lambda stage: (_ for _ in ()).throw(Crash())
                if stage == "during_staging_write" else None
            )
            try:
                with self.assertRaises(Crash):
                    journal.prepare(
                        event_line=line,
                        event_hash=event_hash,
                        event_sequence=1,
                        ledger_prefix_bytes=0,
                        ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                        ledger_prefix_tip_hash=GENESIS,
                        ledger_prefix_event_count=0,
                        projection_sha256="a" * 64,
                        epoch=7,
                    )
            finally:
                runtime_intent_module._CRASH_HOOK = original

            staging = self.root / ".runtime-intent.staging"
            before = staging.read_bytes()
            self.assertGreater(len(before), 0)
            self.assertLess(len(before), 2 * 1024 * 1024)
            with self.assertRaisesRegex(RuntimeIntentError, "staging"):
                journal.inspect()
            with self.assertRaisesRegex(RuntimeIntentError, "proof"):
                journal.discard_staging(wrong)
            self.assertEqual(staging.read_bytes(), before)

            receipt = journal.discard_staging(proof)
            repeated = journal.discard_staging(proof)
        self.assertTrue(staging.exists())
        self.assertEqual(
            staging.read_bytes(), runtime_intent_module._VACANT_STAGING_RECORD,
        )
        self.assertEqual(receipt.staging_sha256, hashlib.sha256(before).hexdigest())
        self.assertEqual(receipt.staging_bytes, len(before))
        self.assertFalse(receipt.already_absent)
        self.assertTrue(repeated.already_absent)
        self.assertEqual(self.ledger.read_bytes(), b"")

    def test_exact_staging_duplicate_is_reset_but_stable_duplicate_is_corrupt(self):
        line, event_hash = event_line()
        with locked_journal(self.root) as journal:
            intent = journal.prepare(
                event_line=line,
                event_hash=event_hash,
                event_sequence=1,
                ledger_prefix_bytes=0,
                ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                ledger_prefix_tip_hash=GENESIS,
                ledger_prefix_event_count=0,
                projection_sha256="a" * 64,
                epoch=7,
            )
            journal.recover_ledger()
            active = self.root / ".runtime-intent"
            staging = self.root / ".runtime-intent.staging"
            staging.write_bytes(active.read_bytes())
            staging.chmod(0o600)
            active_proof = PrefixProjectionProof(
                ledger_prefix_bytes=len(line),
                ledger_prefix_sha256=hashlib.sha256(line).hexdigest(),
                ledger_prefix_tip_hash=event_hash,
                ledger_prefix_event_count=1,
                projection_sha256="a" * 64,
                epoch=7,
            )
            with self.assertRaisesRegex(RuntimeIntentError, "duplicate"):
                journal.inspect()
            active_receipt = journal.discard_staging(active_proof)
            self.assertFalse(active_receipt.already_absent)
            self.assertEqual(journal.inspect(), intent)
            journal.clear(intent, ProjectionEventProof(
                event_line_sha256=intent.event_line_sha256,
                event_hash=event_hash,
                event_sequence=1,
                epoch=7,
                prior_projection_sha256="a" * 64,
                projection_sha256="b" * 64,
            ))

        retired = self.root / ".runtime-intent.retired"
        staging.write_bytes(retired.read_bytes())
        staging.chmod(0o600)
        proof = PrefixProjectionProof(
            ledger_prefix_bytes=len(line),
            ledger_prefix_sha256=hashlib.sha256(line).hexdigest(),
            ledger_prefix_tip_hash=event_hash,
            ledger_prefix_event_count=1,
            projection_sha256="b" * 64,
            epoch=7,
        )
        with locked_journal(self.root) as journal:
            with self.assertRaisesRegex(RuntimeIntentError, "duplicate"):
                journal.inspect()
            receipt = journal.discard_staging(proof)
            self.assertFalse(receipt.already_absent)
            self.assertIsNone(journal.inspect())
        self.assertEqual(
            staging.read_bytes(), runtime_intent_module._VACANT_STAGING_RECORD,
        )

        different = json.loads(retired.read_bytes())
        different["projection_sha256"] = "c" * 64
        staging.write_bytes(canonical(different) + b"\n")
        staging.chmod(0o600)
        before_different = staging.read_bytes()
        with locked_journal(self.root) as journal:
            with self.assertRaisesRegex(RuntimeIntentError, "different stable"):
                journal.discard_staging(proof)
        self.assertEqual(staging.read_bytes(), before_different)

        staging.write_bytes(runtime_intent_module._VACANT_STAGING_RECORD)
        staging.chmod(0o600)
        active.write_bytes(retired.read_bytes())
        active.chmod(0o600)
        before = {
            name: (self.root / name).read_bytes()
            for name in (
                ".runtime-intent", ".runtime-intent.staging",
                ".runtime-intent.retired",
            )
        }
        with locked_journal(self.root) as journal:
            with self.assertRaisesRegex(RuntimeIntentError, "duplicate"):
                journal.discard_staging(proof)
        self.assertEqual(
            {
                name: (self.root / name).read_bytes()
                for name in before
            },
            before,
        )

    def test_every_declared_crash_boundary_resumes_without_duplicate_append(self):
        class Crash(BaseException):
            pass

        staging_stages = (
            "during_staging_write",
            "after_staging_fsync",
            "after_staging_readback",
        )
        active_stages = ("after_activation", "after_activation_dir_fsync")
        for stage in staging_stages + active_stages:
            with self.subTest(operation="prepare", stage=stage), tempfile.TemporaryDirectory() as case:
                root = Path(case) / "state"
                root.mkdir(mode=0o700)
                root.chmod(0o700)
                ledger = root / "events.jsonl"
                ledger.write_bytes(b"")
                ledger.chmod(0o600)
                line, digest = event_line()
                proof = PrefixProjectionProof(
                    ledger_prefix_bytes=0,
                    ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                    ledger_prefix_tip_hash=GENESIS,
                    ledger_prefix_event_count=0,
                    projection_sha256="a" * 64,
                    epoch=7,
                )
                with locked_journal(root) as journal:
                    original = runtime_intent_module._CRASH_HOOK
                    runtime_intent_module._CRASH_HOOK = (
                        lambda observed, expected=stage: (
                            (_ for _ in ()).throw(Crash())
                            if observed == expected else None
                        )
                    )
                    try:
                        with self.assertRaises(Crash):
                            journal.prepare(
                                event_line=line,
                                event_hash=digest,
                                event_sequence=1,
                                ledger_prefix_bytes=0,
                                ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                                ledger_prefix_tip_hash=GENESIS,
                                ledger_prefix_event_count=0,
                                projection_sha256="a" * 64,
                                epoch=7,
                            )
                    finally:
                        runtime_intent_module._CRASH_HOOK = original
                    if stage in staging_stages:
                        self.assertTrue((root / ".runtime-intent.staging").exists())
                        self.assertFalse((root / ".runtime-intent").exists())
                        journal.discard_staging(proof)
                    else:
                        self.assertFalse((root / ".runtime-intent.staging").exists())
                        self.assertIsNotNone(journal.inspect())
                        journal.recover_ledger()
                        self.assertEqual(ledger.read_bytes(), line)

        ledger_stages = (
            "before_ledger_append",
            "during_ledger_append",
            "after_ledger_fsync",
            "after_ledger_dir_fsync",
        )
        for stage in ledger_stages:
            with self.subTest(operation="ledger", stage=stage), tempfile.TemporaryDirectory() as case:
                root = Path(case) / "state"
                root.mkdir(mode=0o700)
                root.chmod(0o700)
                ledger = root / "events.jsonl"
                ledger.write_bytes(b"")
                ledger.chmod(0o600)
                line, digest = event_line()
                with locked_journal(root) as journal:
                    journal.prepare(
                        event_line=line,
                        event_hash=digest,
                        event_sequence=1,
                        ledger_prefix_bytes=0,
                        ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                        ledger_prefix_tip_hash=GENESIS,
                        ledger_prefix_event_count=0,
                        projection_sha256="a" * 64,
                        epoch=7,
                    )
                    original = runtime_intent_module._CRASH_HOOK
                    runtime_intent_module._CRASH_HOOK = (
                        lambda observed, expected=stage: (
                            (_ for _ in ()).throw(Crash())
                            if observed == expected else None
                        )
                    )
                    try:
                        with self.assertRaises(Crash):
                            journal.recover_ledger()
                    finally:
                        runtime_intent_module._CRASH_HOOK = original
                    before_retry = ledger.read_bytes()
                    self.assertTrue(line.startswith(before_retry))
                    receipt = journal.recover_ledger()
                    self.assertEqual(ledger.read_bytes(), line)
                    self.assertEqual(
                        receipt.appended_bytes, len(line) - len(before_retry),
                    )

        clear_stages = (
            "before_intent_retirement", "after_intent_retirement",
            "after_retirement_dir_fsync",
        )
        for stage in clear_stages:
            with self.subTest(operation="clear", stage=stage), tempfile.TemporaryDirectory() as case:
                root = Path(case) / "state"
                root.mkdir(mode=0o700)
                root.chmod(0o700)
                ledger = root / "events.jsonl"
                ledger.write_bytes(b"")
                ledger.chmod(0o600)
                line, digest = event_line()
                with locked_journal(root) as journal:
                    intent = journal.prepare(
                        event_line=line,
                        event_hash=digest,
                        event_sequence=1,
                        ledger_prefix_bytes=0,
                        ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                        ledger_prefix_tip_hash=GENESIS,
                        ledger_prefix_event_count=0,
                        projection_sha256="a" * 64,
                        epoch=7,
                    )
                    journal.recover_ledger()
                    projection = ProjectionEventProof(
                        event_line_sha256=intent.event_line_sha256,
                        event_hash=digest,
                        event_sequence=1,
                        epoch=7,
                        prior_projection_sha256="a" * 64,
                        projection_sha256="b" * 64,
                    )
                    original = runtime_intent_module._CRASH_HOOK
                    runtime_intent_module._CRASH_HOOK = (
                        lambda observed, expected=stage: (
                            (_ for _ in ()).throw(Crash())
                            if observed == expected else None
                        )
                    )
                    try:
                        with self.assertRaises(Crash):
                            journal.clear(intent, projection)
                    finally:
                        runtime_intent_module._CRASH_HOOK = original
                    receipt = journal.clear(intent, projection)
                    self.assertEqual(ledger.read_bytes(), line)
                    retired_before_crash = stage in {
                        "after_intent_retirement", "after_retirement_dir_fsync",
                    }
                    self.assertEqual(receipt.already_absent, retired_before_crash)

    def test_real_process_exit_at_every_crash_boundary_recovers_with_fresh_handle(self):
        prepare_stages = (
            "during_staging_write", "after_staging_fsync",
            "after_staging_readback", "after_activation",
            "after_activation_dir_fsync",
        )
        for stage in prepare_stages:
            with self.subTest(operation="prepare", stage=stage), tempfile.TemporaryDirectory() as case:
                root = Path(case) / "state"
                root.mkdir(mode=0o700)
                root.chmod(0o700)
                ledger = root / "events.jsonl"
                ledger.write_bytes(b"")
                ledger.chmod(0o600)
                line, digest = event_line()
                arguments = dict(
                    event_line=line,
                    event_hash=digest,
                    event_sequence=1,
                    ledger_prefix_bytes=0,
                    ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                    ledger_prefix_tip_hash=GENESIS,
                    ledger_prefix_event_count=0,
                    projection_sha256="a" * 64,
                    epoch=7,
                )
                crash_child(root, stage, lambda journal: journal.prepare(**arguments))
                with locked_journal(root) as journal:
                    if stage.startswith("after_activation"):
                        self.assertIsNotNone(journal.inspect())
                        journal.recover_ledger()
                        self.assertEqual(ledger.read_bytes(), line)
                    else:
                        with self.assertRaisesRegex(RuntimeIntentError, "staging"):
                            journal.inspect()
                        journal.discard_staging(PrefixProjectionProof(
                            ledger_prefix_bytes=0,
                            ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                            ledger_prefix_tip_hash=GENESIS,
                            ledger_prefix_event_count=0,
                            projection_sha256="a" * 64,
                            epoch=7,
                        ))

        for stage in (
            "before_ledger_append", "during_ledger_append",
            "after_ledger_fsync", "after_ledger_dir_fsync",
        ):
            with self.subTest(operation="ledger", stage=stage), tempfile.TemporaryDirectory() as case:
                root = Path(case) / "state"
                root.mkdir(mode=0o700)
                root.chmod(0o700)
                ledger = root / "events.jsonl"
                ledger.write_bytes(b"")
                ledger.chmod(0o600)
                line, digest = event_line()
                with locked_journal(root) as journal:
                    journal.prepare(
                        event_line=line,
                        event_hash=digest,
                        event_sequence=1,
                        ledger_prefix_bytes=0,
                        ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                        ledger_prefix_tip_hash=GENESIS,
                        ledger_prefix_event_count=0,
                        projection_sha256="a" * 64,
                        epoch=7,
                    )
                crash_child(root, stage, lambda journal: journal.recover_ledger())
                with locked_journal(root) as journal:
                    journal.recover_ledger()
                self.assertEqual(ledger.read_bytes(), line)

        for stage in (
            "before_intent_retirement", "after_intent_retirement",
            "after_retirement_dir_fsync",
        ):
            with self.subTest(operation="clear", stage=stage), tempfile.TemporaryDirectory() as case:
                root = Path(case) / "state"
                root.mkdir(mode=0o700)
                root.chmod(0o700)
                ledger = root / "events.jsonl"
                ledger.write_bytes(b"")
                ledger.chmod(0o600)
                line, digest = event_line()
                with locked_journal(root) as journal:
                    intent = journal.prepare(
                        event_line=line,
                        event_hash=digest,
                        event_sequence=1,
                        ledger_prefix_bytes=0,
                        ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                        ledger_prefix_tip_hash=GENESIS,
                        ledger_prefix_event_count=0,
                        projection_sha256="a" * 64,
                        epoch=7,
                    )
                    journal.recover_ledger()
                proof = ProjectionEventProof(
                    event_line_sha256=intent.event_line_sha256,
                    event_hash=digest,
                    event_sequence=1,
                    epoch=7,
                    prior_projection_sha256="a" * 64,
                    projection_sha256="b" * 64,
                )
                crash_child(root, stage, lambda journal: journal.clear(intent, proof))
                with locked_journal(root) as journal:
                    receipt = journal.clear(intent, proof)
                self.assertEqual(
                    receipt.already_absent,
                    stage != "before_intent_retirement",
                )

        for stage in (
            "before_staging_reset", "during_staging_reset",
            "after_staging_reset",
            "after_staging_reset_dir_fsync",
        ):
            with self.subTest(operation="discard", stage=stage), tempfile.TemporaryDirectory() as case:
                root = Path(case) / "state"
                root.mkdir(mode=0o700)
                root.chmod(0o700)
                ledger = root / "events.jsonl"
                ledger.write_bytes(b"")
                ledger.chmod(0o600)
                staging = root / ".runtime-intent.staging"
                staging.write_bytes(b"partial")
                staging.chmod(0o600)
                proof = PrefixProjectionProof(
                    ledger_prefix_bytes=0,
                    ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                    ledger_prefix_tip_hash=GENESIS,
                    ledger_prefix_event_count=0,
                    projection_sha256="a" * 64,
                    epoch=7,
                )
                crash_child(root, stage, lambda journal: journal.discard_staging(proof))
                with locked_journal(root) as journal:
                    receipt = journal.discard_staging(proof)
                self.assertEqual(
                    receipt.already_absent,
                    stage in {
                        "after_staging_reset",
                        "after_staging_reset_dir_fsync",
                    },
                )
                self.assertEqual(
                    staging.read_bytes(),
                    runtime_intent_module._VACANT_STAGING_RECORD,
                )

    def test_path_only_handle_is_inspection_only_and_does_not_heal(self):
        line, digest = event_line()
        before_names = tuple(sorted(path.name for path in self.root.iterdir()))
        before_ledger = self.ledger.read_bytes()
        before_stat = self.ledger.stat()
        with RuntimeIntentJournal(self.root) as journal:
            self.assertIsNone(journal.inspect())
            with self.assertRaisesRegex(RuntimeIntentError, "held controller and writer"):
                journal.prepare(
                    event_line=line,
                    event_hash=digest,
                    event_sequence=1,
                    ledger_prefix_bytes=0,
                    ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                    ledger_prefix_tip_hash=GENESIS,
                    ledger_prefix_event_count=0,
                    projection_sha256="a" * 64,
                    epoch=7,
                )
        after_stat = self.ledger.stat()
        self.assertEqual(tuple(sorted(path.name for path in self.root.iterdir())), before_names)
        self.assertEqual(self.ledger.read_bytes(), before_ledger)
        self.assertEqual(
            (after_stat.st_dev, after_stat.st_ino, after_stat.st_mode,
             after_stat.st_nlink, after_stat.st_size, after_stat.st_mtime_ns,
             after_stat.st_ctime_ns),
            (before_stat.st_dev, before_stat.st_ino, before_stat.st_mode,
             before_stat.st_nlink, before_stat.st_size, before_stat.st_mtime_ns,
             before_stat.st_ctime_ns),
        )

    def test_mutation_authority_rejects_unlocked_wrong_replaced_and_forked_fds(self):
        for name in (".controller.lock", ".writer.lock"):
            path = self.root / name
            path.write_bytes(b"")
            path.chmod(0o600)
        controller_fd = os.open(self.root / ".controller.lock", os.O_RDONLY)
        writer_fd = os.open(self.root / ".writer.lock", os.O_RDONLY)
        try:
            with self.assertRaisesRegex(RuntimeIntentError, "not exclusively held"):
                RuntimeIntentJournal._from_locked_fds(
                    self.root, writer_lock_fd=writer_fd,
                    controller_lock_fd=controller_fd,
                )
            fcntl.flock(controller_fd, fcntl.LOCK_EX)
            fcntl.flock(writer_fd, fcntl.LOCK_EX)
            with self.assertRaisesRegex(RuntimeIntentError, "fixed lock file"):
                RuntimeIntentJournal._from_locked_fds(
                    self.root, writer_lock_fd=writer_fd,
                    controller_lock_fd=writer_fd,
                )
            journal = RuntimeIntentJournal._from_locked_fds(
                self.root, writer_lock_fd=writer_fd,
                controller_lock_fd=controller_fd,
            )
            try:
                os.rename(
                    self.root / ".writer.lock", self.root / ".writer.lock.old",
                )
                replacement = self.root / ".writer.lock"
                replacement.write_bytes(b"")
                replacement.chmod(0o600)
                line, digest = event_line()
                with self.assertRaisesRegex(RuntimeIntentError, "replaced"):
                    journal.prepare(
                        event_line=line,
                        event_hash=digest,
                        event_sequence=1,
                        ledger_prefix_bytes=0,
                        ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                        ledger_prefix_tip_hash=GENESIS,
                        ledger_prefix_event_count=0,
                        projection_sha256="a" * 64,
                        epoch=7,
                    )
                self.assertFalse((self.root / ".runtime-intent.staging").exists())
            finally:
                journal.close()
        finally:
            os.close(writer_fd)
            os.close(controller_fd)

        with tempfile.TemporaryDirectory() as case:
            root = Path(case) / "state"
            root.mkdir(mode=0o700)
            root.chmod(0o700)
            ledger = root / "events.jsonl"
            ledger.write_bytes(b"")
            ledger.chmod(0o600)
            with locked_journal(root) as journal:
                read_fd, write_fd = os.pipe()
                child = os.fork()
                if child == 0:
                    os.close(read_fd)
                    try:
                        try:
                            journal.inspect()
                        except RuntimeIntentError:
                            os.write(write_fd, b"rejected")
                        else:
                            os.write(write_fd, b"accepted")
                    finally:
                        os.close(write_fd)
                        os._exit(0)
                os.close(write_fd)
                result = os.read(read_fd, 32)
                os.close(read_fd)
                waited, status = os.waitpid(child, 0)
                self.assertEqual(waited, child)
                self.assertTrue(os.WIFEXITED(status))
                self.assertEqual(result, b"rejected")

    def test_anchored_root_rejects_path_replacement(self):
        with tempfile.TemporaryDirectory() as case:
            parent = Path(case)
            root = parent / "state"
            root.mkdir(mode=0o700)
            root.chmod(0o700)
            ledger = root / "events.jsonl"
            ledger.write_bytes(b"")
            ledger.chmod(0o600)
            with locked_journal(root) as journal:
                old = parent / "state-old"
                root.rename(old)
                root.mkdir(mode=0o700)
                root.chmod(0o700)
                with self.assertRaisesRegex(RuntimeIntentError, "state directory"):
                    journal.inspect()

    def test_name_and_content_races_fail_closed_without_overwriting(self):
        line, digest = event_line()
        with locked_journal(self.root) as journal:
            real_activate = runtime_intent_module._rename_no_replace

            def inject_active(directory_fd, source, destination):
                rival_fd = os.open(
                    destination,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o600,
                    dir_fd=directory_fd,
                )
                try:
                    os.fchmod(rival_fd, 0o600)
                    os.write(rival_fd, b"rival")
                    os.fsync(rival_fd)
                finally:
                    os.close(rival_fd)
                return real_activate(directory_fd, source, destination)

            with mock.patch.object(
                runtime_intent_module, "_rename_no_replace",
                side_effect=inject_active,
            ):
                with self.assertRaisesRegex(RuntimeIntentError, "already exists"):
                    journal.prepare(
                        event_line=line,
                        event_hash=digest,
                        event_sequence=1,
                        ledger_prefix_bytes=0,
                        ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                        ledger_prefix_tip_hash=GENESIS,
                        ledger_prefix_event_count=0,
                        projection_sha256="a" * 64,
                        epoch=7,
                    )
            self.assertEqual((self.root / ".runtime-intent").read_bytes(), b"rival")
            self.assertTrue((self.root / ".runtime-intent.staging").exists())

        with tempfile.TemporaryDirectory() as case:
            root = Path(case) / "state"
            root.mkdir(mode=0o700)
            root.chmod(0o700)
            ledger = root / "events.jsonl"
            ledger.write_bytes(b"")
            ledger.chmod(0o600)
            with locked_journal(root) as journal:
                journal.prepare(
                    event_line=line,
                    event_hash=digest,
                    event_sequence=1,
                    ledger_prefix_bytes=0,
                    ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                    ledger_prefix_tip_hash=GENESIS,
                    ledger_prefix_event_count=0,
                    projection_sha256="a" * 64,
                    epoch=7,
                )
                original = runtime_intent_module._CRASH_HOOK

                def race_ledger(stage):
                    if stage == "before_ledger_append":
                        ledger.write_bytes(b"x")
                        ledger.chmod(0o600)

                runtime_intent_module._CRASH_HOOK = race_ledger
                try:
                    with self.assertRaisesRegex(RuntimeIntentError, "changed"):
                        journal.recover_ledger()
                finally:
                    runtime_intent_module._CRASH_HOOK = original
                self.assertEqual(ledger.read_bytes(), b"x")

        with tempfile.TemporaryDirectory() as case:
            root = Path(case) / "state"
            root.mkdir(mode=0o700)
            root.chmod(0o700)
            ledger = root / "events.jsonl"
            ledger.write_bytes(b"")
            ledger.chmod(0o600)
            with locked_journal(root) as journal:
                journal.prepare(
                    event_line=line,
                    event_hash=digest,
                    event_sequence=1,
                    ledger_prefix_bytes=0,
                    ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                    ledger_prefix_tip_hash=GENESIS,
                    ledger_prefix_event_count=0,
                    projection_sha256="a" * 64,
                    epoch=7,
                )
            intent_path = root / ".runtime-intent"
            raw = intent_path.read_bytes()
            stale = root / ".runtime-intent.old"
            journal = RuntimeIntentJournal(root)
            real_open = runtime_intent_module.os.open
            injected = False

            def swap_before_open(path, flags, mode=0o777, *, dir_fd=None):
                nonlocal injected
                if path == ".runtime-intent" and dir_fd is not None and not injected:
                    injected = True
                    intent_path.rename(stale)
                    intent_path.write_bytes(raw)
                    intent_path.chmod(0o600)
                return real_open(path, flags, mode, dir_fd=dir_fd)

            try:
                with mock.patch.object(
                    runtime_intent_module.os, "open", side_effect=swap_before_open,
                ):
                    with self.assertRaisesRegex(RuntimeIntentError, "changed"):
                        journal.inspect()
            finally:
                journal.close()

    def test_nonempty_prefix_is_verified_by_bytes_hash_count_tip_and_chain(self):
        first, first_hash = event_line(event_type="protocol.task_registered")
        second, second_hash = event_line(
            previous=first_hash, event_type="protocol.phase_result",
        )
        self.ledger.write_bytes(first)
        with locked_journal(self.root) as journal:
            intent = journal.prepare(
                event_line=second,
                event_hash=second_hash,
                event_sequence=2,
                ledger_prefix_bytes=len(first),
                ledger_prefix_sha256=hashlib.sha256(first).hexdigest(),
                ledger_prefix_tip_hash=first_hash,
                ledger_prefix_event_count=1,
                projection_sha256="a" * 64,
                epoch=7,
            )
            receipt = journal.recover_ledger()
        self.assertEqual(self.ledger.read_bytes(), first + second)
        self.assertEqual(intent.event_sequence, 2)
        self.assertEqual(receipt.ledger_event_count, 2)
        self.assertEqual(receipt.ledger_tip_hash, second_hash)

    def test_fixed_intent_slots_are_reused_for_many_events_without_unlink(self):
        ledger_bytes = b""
        previous = GENESIS
        projection = hashlib.sha256(b"projection-0").hexdigest()
        for sequence in range(1, 7):
            line, digest = event_line(previous=previous)
            with locked_journal(self.root) as journal, mock.patch.object(
                runtime_intent_module.os, "unlink",
                side_effect=AssertionError("fixed slots must never be unlinked"),
            ):
                intent = journal.prepare(
                    event_line=line,
                    event_hash=digest,
                    event_sequence=sequence,
                    ledger_prefix_bytes=len(ledger_bytes),
                    ledger_prefix_sha256=hashlib.sha256(ledger_bytes).hexdigest(),
                    ledger_prefix_tip_hash=previous,
                    ledger_prefix_event_count=sequence - 1,
                    projection_sha256=projection,
                    epoch=7,
                )
                journal.recover_ledger()
                next_projection = hashlib.sha256(
                    f"projection-{sequence}".encode("ascii")
                ).hexdigest()
                journal.clear(intent, ProjectionEventProof(
                    event_line_sha256=intent.event_line_sha256,
                    event_hash=digest,
                    event_sequence=sequence,
                    epoch=7,
                    prior_projection_sha256=projection,
                    projection_sha256=next_projection,
                ))
                self.assertIsNone(journal.inspect())
            ledger_bytes += line
            previous = digest
            projection = next_projection
            intent_names = {
                path.name for path in self.root.iterdir()
                if path.name.startswith(".runtime-intent")
            }
            self.assertLessEqual(len(intent_names), 3)
            for name in intent_names:
                info = (self.root / name).stat()
                self.assertEqual(info.st_nlink, 1)
                self.assertEqual(info.st_mode & 0o777, 0o600)
        self.assertEqual(self.ledger.read_bytes(), ledger_bytes)

    def test_root_and_intent_metadata_must_remain_private_and_single_linked(self):
        with tempfile.TemporaryDirectory() as case:
            root = Path(case) / "state"
            root.mkdir(mode=0o700)
            root.chmod(0o700)
            root.chmod(0o750)
            with self.assertRaisesRegex(RuntimeIntentError, "mode-0700"):
                RuntimeIntentJournal(root)

        with tempfile.TemporaryDirectory() as case:
            real = Path(case) / "real"
            real.mkdir(mode=0o700)
            real.chmod(0o700)
            alias = Path(case) / "alias"
            alias.symlink_to(real, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeIntentError, "canonical"):
                RuntimeIntentJournal(alias)

        for defect in ("mode", "hardlink", "symlink"):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as case:
                root = Path(case) / "state"
                root.mkdir(mode=0o700)
                root.chmod(0o700)
                ledger = root / "events.jsonl"
                ledger.write_bytes(b"")
                ledger.chmod(0o600)
                line, digest = event_line()
                with locked_journal(root) as journal:
                    journal.prepare(
                        event_line=line,
                        event_hash=digest,
                        event_sequence=1,
                        ledger_prefix_bytes=0,
                        ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                        ledger_prefix_tip_hash=GENESIS,
                        ledger_prefix_event_count=0,
                        projection_sha256="a" * 64,
                        epoch=7,
                    )
                active = root / ".runtime-intent"
                if defect == "mode":
                    active.chmod(0o640)
                    message = "mode-0600"
                elif defect == "hardlink":
                    os.link(active, root / "second-link")
                    message = "single-linked"
                else:
                    active.unlink()
                    active.symlink_to(ledger)
                    message = "regular file"
                with self.assertRaisesRegex(RuntimeIntentError, message):
                    RuntimeIntentJournal(root)

    def test_intent_json_and_input_bounds_reject_without_creating_staging(self):
        line, digest = event_line()
        invalid_lines = []
        decoded = json.loads(line)
        invalid_lines.append(
            json.dumps(decoded, sort_keys=True).encode("ascii") + b"\n"
        )
        invalid_lines.append(line[:-2] + b',"type":"protocol.phase_result"}\n')
        nested = {}
        cursor = nested
        for _ in range(40):
            cursor["x"] = {}
            cursor = cursor["x"]
        created_at = 1_777_777_777
        nested_hash = hashlib.sha256(canonical({
            "created_at": created_at,
            "payload": nested,
            "prev": GENESIS,
            "type": "protocol.phase_result",
        })).hexdigest()
        invalid_lines.append(canonical({
            "created_at": created_at,
            "hash": nested_hash,
            "payload": nested,
            "prev": GENESIS,
            "type": "protocol.phase_result",
        }) + b"\n")
        with locked_journal(self.root) as journal:
            for invalid in invalid_lines:
                with self.subTest(invalid=invalid[:20]):
                    with self.assertRaises(RuntimeIntentError):
                        journal.prepare(
                            event_line=invalid,
                            event_hash=digest,
                            event_sequence=1,
                            ledger_prefix_bytes=0,
                            ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                            ledger_prefix_tip_hash=GENESIS,
                            ledger_prefix_event_count=0,
                            projection_sha256="a" * 64,
                            epoch=7,
                        )
                    self.assertFalse((self.root / ".runtime-intent.staging").exists())
            with self.assertRaisesRegex(RuntimeIntentError, "event sequence"):
                journal.prepare(
                    event_line=line,
                    event_hash=digest,
                    event_sequence=True,
                    ledger_prefix_bytes=0,
                    ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                    ledger_prefix_tip_hash=GENESIS,
                    ledger_prefix_event_count=0,
                    projection_sha256="a" * 64,
                    epoch=7,
                )
            with self.assertRaisesRegex(RuntimeIntentError, "event count"):
                journal.prepare(
                    event_line=line,
                    event_hash=digest,
                    event_sequence=65_536,
                    ledger_prefix_bytes=0,
                    ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                    ledger_prefix_tip_hash=GENESIS,
                    ledger_prefix_event_count=65_536,
                    projection_sha256="a" * 64,
                    epoch=7,
                )

    def test_inspect_rejects_noncanonical_unknown_corrupt_and_oversized_records(self):
        for defect in ("whitespace", "duplicate", "unknown", "line-sha", "oversized"):
            with self.subTest(defect=defect), tempfile.TemporaryDirectory() as case:
                root = Path(case) / "state"
                root.mkdir(mode=0o700)
                root.chmod(0o700)
                ledger = root / "events.jsonl"
                ledger.write_bytes(b"")
                ledger.chmod(0o600)
                line, digest = event_line()
                with locked_journal(root) as journal:
                    journal.prepare(
                        event_line=line,
                        event_hash=digest,
                        event_sequence=1,
                        ledger_prefix_bytes=0,
                        ledger_prefix_sha256=hashlib.sha256(b"").hexdigest(),
                        ledger_prefix_tip_hash=GENESIS,
                        ledger_prefix_event_count=0,
                        projection_sha256="a" * 64,
                        epoch=7,
                    )
                active = root / ".runtime-intent"
                raw = active.read_bytes()
                value = json.loads(raw)
                if defect == "whitespace":
                    hostile = json.dumps(value, sort_keys=True).encode("ascii") + b"\n"
                    active.write_bytes(hostile)
                elif defect == "duplicate":
                    active.write_bytes(raw[:-2] + b',"version":1}\n')
                elif defect == "unknown":
                    value["unknown"] = 1
                    active.write_bytes(canonical(value) + b"\n")
                elif defect == "line-sha":
                    value["event"]["line_sha256"] = "f" * 64
                    active.write_bytes(canonical(value) + b"\n")
                else:
                    with active.open("r+b") as stream:
                        stream.truncate(2 * 1024 * 1024 + 1)
                active.chmod(0o600)
                before = active.stat().st_size
                with RuntimeIntentJournal(root) as journal:
                    with self.assertRaises(RuntimeIntentError):
                        journal.inspect()
                self.assertEqual(active.stat().st_size, before)


if __name__ == "__main__":
    unittest.main()
