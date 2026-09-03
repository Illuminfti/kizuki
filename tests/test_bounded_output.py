import errno
import hashlib
from dataclasses import FrozenInstanceError, replace
import os
import stat
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from gauntlet.bounded_output import (
    BoundedOutputSpec,
    OutputCaptureError,
    OutputCaptureGrant,
    capture_bounded_output,
    mint_output_capture_grant,
)


class ScriptedClock:
    def __init__(self, *values):
        self.values = list(values)
        self.last = values[-1]

    def __call__(self):
        if self.values:
            self.last = self.values.pop(0)
        return self.last


class MutableClock:
    def __init__(self, value=0.0):
        self.value = value

    def __call__(self):
        return self.value


_DEFAULT_GRANT = object()


class BoundedOutputTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.attempt_root = self.root / "attempt"
        self.attempt_root.mkdir(mode=0o700)
        self.worktree = self.attempt_root / "work"
        self.worktree.mkdir(mode=0o700)
        self.raw = self.attempt_root / "raw"
        self.raw.mkdir(mode=0o700)
        self.signing_key = b"output-capture-test-key-material"[:32]
        self.issuer_key_id = "output-capture-key-01"
        self.verification_keys = {self.issuer_key_id: self.signing_key}

    def tearDown(self):
        self.tmp.cleanup()

    def spec(self, **overrides):
        values = {
            "campaign_id": "campaign-01",
            "task_id": "task-01",
            "attempt": 2,
            "controller_epoch": 7,
            "task_spec_sha256": "a" * 64,
            "attempt_root": str(self.attempt_root),
            "worktree": str(self.worktree),
            "raw_directory": str(self.raw),
            "stdout_max_bytes": 4096,
            "stderr_max_bytes": 4096,
            "combined_max_bytes": 8192,
            "wall_timeout_ms": 1000,
            "idle_timeout_ms": 200,
        }
        values.update(overrides)
        return BoundedOutputSpec(**values)

    def grant(self, spec):
        return mint_output_capture_grant(
            spec,
            issuer_key_id=self.issuer_key_id,
            grant_id="capture-grant-01",
            signing_key=self.signing_key,
        )

    def capture_streams(
        self,
        spec,
        stdout,
        stderr,
        *,
        grant=_DEFAULT_GRANT,
        **kwargs,
    ):
        if grant is _DEFAULT_GRANT:
            grant = self.grant(spec)
        return capture_bounded_output(
            spec,
            stdout,
            stderr,
            grant=grant,
            verification_keys=self.verification_keys,
            **kwargs,
        )

    def capture_bytes(self, stdout: bytes, stderr: bytes, *, spec=None, **kwargs):
        stdout_read, stdout_write = os.pipe()
        stderr_read, stderr_write = os.pipe()
        try:
            os.write(stdout_write, stdout)
            os.write(stderr_write, stderr)
            os.close(stdout_write)
            stdout_write = -1
            os.close(stderr_write)
            stderr_write = -1
            selected_spec = self.spec() if spec is None else spec
            return self.capture_streams(
                selected_spec,
                stdout_read,
                stderr_read,
                **kwargs,
            )
        finally:
            os.close(stdout_read)
            os.close(stderr_read)
            if stdout_write >= 0:
                os.close(stdout_write)
            if stderr_write >= 0:
                os.close(stderr_write)

    def test_spec_rejects_noncanonical_or_unbounded_values(self):
        cases = (
            ({"raw_directory": str(self.raw / ".." / "raw")}, "INVALID_OUTPUT_PATH"),
            ({"stdout_max_bytes": 64 * 1024 * 1024 + 1}, "INVALID_OUTPUT_BYTE_BUDGET"),
            ({"wall_timeout_ms": float("nan")}, "INVALID_OUTPUT_TIME_BUDGET"),
            ({"wall_timeout_ms": 10**10000}, "INVALID_OUTPUT_TIME_BUDGET"),
            ({"attempt": True}, "INVALID_CAPTURE_FENCE"),
        )

        for overrides, reason_code in cases:
            with self.subTest(overrides=overrides):
                with self.assertRaises(OutputCaptureError) as caught:
                    self.spec(**overrides)
                self.assertEqual(caught.exception.reason_code, reason_code)

    def test_layout_rejects_raw_under_worktree_and_prefix_confusion(self):
        cases = (
            str(self.worktree / "raw"),
            str(self.attempt_root) + "-lookalike/raw",
            str(self.raw / "nested"),
        )

        for raw_directory in cases:
            with self.subTest(raw_directory=raw_directory):
                with self.assertRaises(OutputCaptureError) as caught:
                    self.spec(raw_directory=raw_directory)
                self.assertEqual(caught.exception.reason_code, "INVALID_OUTPUT_LAYOUT")

    def test_grant_is_immutable_and_binds_every_non_path_capture_field(self):
        spec = self.spec()
        grant = self.grant(spec)
        terminations = []

        with self.assertRaises(FrozenInstanceError):
            setattr(grant, "grant_id", "replacement-grant")
        self.assertFalse(hasattr(spec, "__dict__"))
        self.assertFalse(hasattr(grant, "__dict__"))
        self.assertFalse(hasattr(grant.raw_directory_identity, "__dict__"))

        replacements = (
            {"campaign_id": "campaign-02"},
            {"task_id": "task-02"},
            {"attempt": 3},
            {"controller_epoch": 8},
            {"task_spec_sha256": "b" * 64},
            {"stdout_max_bytes": 4097},
            {"stderr_max_bytes": 4097},
            {"combined_max_bytes": 8193},
            {"wall_timeout_ms": 1001},
            {"idle_timeout_ms": 201},
        )
        for changes in replacements:
            with self.subTest(changes=changes):
                with self.assertRaises(OutputCaptureError) as caught:
                    self.capture_bytes(
                        b"mismatched-grant-private-marker",
                        b"",
                        spec=replace(spec, **changes),
                        grant=grant,
                        request_termination=terminations.append,
                    )
                self.assertEqual(caught.exception.reason_code, "OUTPUT_GRANT_MISMATCH")
                self.assertIsNone(caught.exception.receipt)

        self.assertEqual(terminations, ["OUTPUT_GRANT_MISMATCH"] * len(replacements))
        self.assertFalse((self.raw / "stdout.bin").exists())

    def test_unsigned_forged_and_valid_but_mismatched_grants_fail_closed(self):
        spec = self.spec()
        signed = self.grant(spec)
        forged_spec = replace(spec, stdout_max_bytes=spec.stdout_max_bytes + 1)
        forged = replace(signed, spec=forged_spec)
        next_unused_inode = 1 + max(
            signed.attempt_root_identity.inode,
            signed.worktree_identity.inode,
            signed.raw_directory_identity.inode,
        )
        wrong_identity = replace(
            signed.raw_directory_identity,
            inode=next_unused_inode,
        )
        forged_identity = replace(signed, raw_directory_identity=wrong_identity)
        valid_other = self.grant(replace(spec, task_id="task-02"))
        cases = (
            (None, spec, "OUTPUT_GRANT_REQUIRED"),
            (forged, forged_spec, "OUTPUT_GRANT_AUTHENTICATION_FAILED"),
            (forged_identity, spec, "OUTPUT_GRANT_AUTHENTICATION_FAILED"),
            (valid_other, spec, "OUTPUT_GRANT_MISMATCH"),
        )

        for candidate, expected_spec, reason_code in cases:
            terminations = []
            with self.subTest(reason_code=reason_code):
                with self.assertRaises(OutputCaptureError) as caught:
                    self.capture_bytes(
                        b"unauthorized-output-private-marker",
                        b"",
                        spec=expected_spec,
                        grant=candidate,
                        request_termination=terminations.append,
                    )
                self.assertEqual(caught.exception.reason_code, reason_code)
                self.assertIsNone(caught.exception.receipt)
                self.assertEqual(terminations, [reason_code])
                public = repr(caught.exception) + str(caught.exception)
                self.assertNotIn("unauthorized-output-private-marker", public)

        self.assertFalse((self.raw / "stdout.bin").exists())

    def test_grant_snapshot_rejects_replaced_worktree_identity(self):
        spec = self.spec()
        grant = self.grant(spec)
        moved_worktree = self.attempt_root / "moved-work"
        self.worktree.rename(moved_worktree)
        self.worktree.mkdir(mode=0o700)
        terminations = []

        with self.assertRaises(OutputCaptureError) as caught:
            self.capture_bytes(
                b"replaced-worktree-private-marker",
                b"",
                spec=spec,
                grant=grant,
                request_termination=terminations.append,
            )

        self.assertEqual(caught.exception.reason_code, "OUTPUT_LAYOUT_MISMATCH")
        self.assertIsNone(caught.exception.receipt)
        self.assertEqual(terminations, ["OUTPUT_LAYOUT_MISMATCH"])
        self.assertFalse((self.raw / "stdout.bin").exists())

    def test_grant_mint_rejects_non_private_layout_directories(self):
        for directory in (self.attempt_root, self.worktree, self.raw):
            with self.subTest(directory=directory.name):
                directory.chmod(0o755)
                try:
                    with self.assertRaises(OutputCaptureError) as caught:
                        self.grant(self.spec())
                    self.assertEqual(caught.exception.reason_code, "OUTPUT_PATH_UNSAFE")
                finally:
                    directory.chmod(0o700)

    def test_captures_invalid_bytes_in_private_files_with_sanitized_receipt(self):
        stdout = b"\xff\xfeprivate-stdout-marker"
        stderr = b"\x80private-stderr-marker"
        spec = self.spec()
        grant = self.grant(spec)

        receipt = self.capture_bytes(stdout, stderr, spec=spec, grant=grant)

        self.assertEqual((self.raw / "stdout.bin").read_bytes(), stdout)
        self.assertEqual((self.raw / "stderr.bin").read_bytes(), stderr)
        self.assertEqual(stat.S_IMODE((self.raw / "stdout.bin").stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.raw / "stderr.bin").stat().st_mode), 0o600)
        self.assertEqual((self.raw / "stdout.bin").stat().st_uid, os.geteuid())
        self.assertEqual((self.raw / "stderr.bin").stat().st_uid, os.geteuid())
        self.assertEqual(receipt.stdout_sha256, hashlib.sha256(stdout).hexdigest())
        self.assertEqual(receipt.stderr_sha256, hashlib.sha256(stderr).hexdigest())
        self.assertEqual(receipt.combined_bytes, len(stdout) + len(stderr))
        self.assertEqual(receipt.grant_id, grant.grant_id)
        self.assertEqual(receipt.grant_sha256, grant.sha256)
        self.assertEqual(receipt.layout_sha256, grant.layout_sha256)
        self.assertEqual(
            (
                receipt.campaign_id,
                receipt.task_id,
                receipt.attempt,
                receipt.controller_epoch,
                receipt.task_spec_sha256,
            ),
            ("campaign-01", "task-01", 2, 7, "a" * 64),
        )
        public = repr(receipt) + str(receipt)
        self.assertNotIn("private-stdout-marker", public)
        self.assertNotIn("private-stderr-marker", public)
        self.assertNotIn(str(self.attempt_root), public)
        self.assertNotIn(str(self.worktree), public)
        self.assertNotIn(str(self.raw), public)
        self.assertFalse(hasattr(receipt, "raw_directory"))

    def test_oversize_stream_fails_with_sanitized_receipt_and_termination(self):
        marker = b"secret-oversize-marker"
        terminations = []

        with self.assertRaises(OutputCaptureError) as caught:
            self.capture_bytes(
                marker,
                b"",
                spec=self.spec(stdout_max_bytes=8),
                request_termination=terminations.append,
            )

        self.assertEqual(terminations, ["STDOUT_LIMIT_EXCEEDED"])
        self.assertEqual(caught.exception.reason_code, "STDOUT_LIMIT_EXCEEDED")
        self.assertEqual(caught.exception.receipt.outcome, "FAILED")
        self.assertEqual(caught.exception.receipt.stdout_bytes, 8)
        self.assertEqual((self.raw / "stdout.bin").stat().st_size, 8)
        public = repr(caught.exception) + str(caught.exception) + repr(caught.exception.receipt)
        self.assertNotIn("secret-oversize-marker", public)

    def test_infinite_producer_is_bounded_and_termination_is_requested_once(self):
        stdout_read, stdout_write = os.pipe()
        stderr_read, stderr_write = os.pipe()
        os.close(stderr_write)
        stopped = threading.Event()
        terminations = []

        def terminate(reason_code):
            terminations.append(reason_code)
            stopped.set()

        def produce_forever():
            try:
                while not stopped.is_set():
                    os.write(stdout_write, b"infinite-private-marker" * 64)
            except (BrokenPipeError, OSError):
                pass
            finally:
                os.close(stdout_write)

        producer = threading.Thread(target=produce_forever, daemon=True)
        producer.start()
        spec = self.spec(stdout_max_bytes=1024, combined_max_bytes=2048)
        try:
            with self.assertRaises(OutputCaptureError) as caught:
                self.capture_streams(
                    spec,
                    stdout_read,
                    stderr_read,
                    request_termination=terminate,
                )
        finally:
            os.close(stdout_read)
            os.close(stderr_read)
            stopped.set()
            producer.join(timeout=1)

        self.assertFalse(producer.is_alive())
        self.assertEqual(caught.exception.reason_code, "STDOUT_LIMIT_EXCEEDED")
        self.assertEqual(terminations, ["STDOUT_LIMIT_EXCEEDED"])
        self.assertEqual((self.raw / "stdout.bin").stat().st_size, 1024)

    def test_combined_budget_is_enforced_across_both_streams(self):
        terminations = []

        with self.assertRaises(OutputCaptureError) as caught:
            self.capture_bytes(
                b"stdout-secret",
                b"stderr-secret",
                spec=self.spec(
                    stdout_max_bytes=64,
                    stderr_max_bytes=64,
                    combined_max_bytes=8,
                ),
                request_termination=terminations.append,
            )

        self.assertEqual(caught.exception.reason_code, "COMBINED_LIMIT_EXCEEDED")
        self.assertEqual(caught.exception.receipt.combined_bytes, 8)
        self.assertEqual(terminations, ["COMBINED_LIMIT_EXCEEDED"])

    def test_stderr_has_an_independent_byte_budget(self):
        terminations = []

        with self.assertRaises(OutputCaptureError) as caught:
            self.capture_bytes(
                b"ok",
                b"private-stderr-overflow",
                spec=self.spec(stderr_max_bytes=5),
                request_termination=terminations.append,
            )

        self.assertEqual(caught.exception.reason_code, "STDERR_LIMIT_EXCEEDED")
        self.assertEqual(caught.exception.receipt.stderr_bytes, 5)
        self.assertEqual(terminations, ["STDERR_LIMIT_EXCEEDED"])

    def test_cancellation_is_typed_and_requests_termination_once(self):
        terminations = []

        with self.assertRaises(OutputCaptureError) as caught:
            self.capture_bytes(
                b"ignored",
                b"",
                request_termination=terminations.append,
                cancelled=lambda: True,
            )

        self.assertEqual(caught.exception.reason_code, "CANCELLED")
        self.assertEqual(terminations, ["CANCELLED"])
        self.assertEqual(caught.exception.receipt.outcome, "FAILED")

    def test_termination_callback_diagnostics_cannot_escape(self):
        calls = 0

        def broken_termination(_reason_code):
            nonlocal calls
            calls += 1
            raise RuntimeError("termination-private-marker")

        with self.assertRaises(OutputCaptureError) as caught:
            self.capture_bytes(
                b"overflow-private-marker",
                b"",
                spec=self.spec(stdout_max_bytes=1),
                request_termination=broken_termination,
            )

        self.assertEqual(calls, 1)
        self.assertEqual(caught.exception.reason_code, "STDOUT_LIMIT_EXCEEDED")
        public = repr(caught.exception) + str(caught.exception) + repr(caught.exception.receipt)
        self.assertNotIn("termination-private-marker", public)
        self.assertNotIn("overflow-private-marker", public)

    def test_regular_file_streams_are_rejected_before_output_files_are_created(self):
        terminations = []

        with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
            with self.assertRaises(OutputCaptureError) as caught:
                self.capture_streams(
                    self.spec(),
                    stdout,
                    stderr,
                    request_termination=terminations.append,
                )

        self.assertEqual(caught.exception.reason_code, "OUTPUT_STREAM_INVALID")
        self.assertEqual(caught.exception.receipt.combined_bytes, 0)
        self.assertEqual(terminations, ["OUTPUT_STREAM_INVALID"])
        self.assertFalse((self.raw / "stdout.bin").exists())

    def test_capture_restores_caller_stream_blocking_flags(self):
        stdout_read, stdout_write = os.pipe()
        stderr_read, stderr_write = os.pipe()
        os.set_blocking(stderr_read, False)
        os.write(stdout_write, b"output")
        os.close(stdout_write)
        os.close(stderr_write)

        try:
            self.capture_streams(self.spec(), stdout_read, stderr_read)
            self.assertTrue(os.get_blocking(stdout_read))
            self.assertFalse(os.get_blocking(stderr_read))
        finally:
            os.close(stdout_read)
            os.close(stderr_read)

    def test_stream_restore_failure_is_sanitized_without_leaking_duplicate_fds(self):
        original_dup = os.dup
        original_set_blocking = os.set_blocking
        duplicated = []
        terminations = []

        def tracked_dup(descriptor):
            duplicate = original_dup(descriptor)
            duplicated.append(duplicate)
            return duplicate

        def fail_restoration(descriptor, blocking):
            if descriptor in duplicated and blocking is True:
                raise OSError(errno.EIO, "restore-private-marker")
            return original_set_blocking(descriptor, blocking)

        try:
            with mock.patch("gauntlet.bounded_output.os.dup", tracked_dup):
                with mock.patch(
                    "gauntlet.bounded_output.os.set_blocking",
                    fail_restoration,
                ):
                    with self.assertRaises(OutputCaptureError) as caught:
                        self.capture_bytes(
                            b"stream-private-marker",
                            b"",
                            request_termination=terminations.append,
                        )

            self.assertEqual(caught.exception.reason_code, "OUTPUT_STREAM_ERROR")
            self.assertEqual(terminations, ["OUTPUT_STREAM_ERROR"])
            for descriptor in duplicated:
                with self.assertRaises(OSError) as closed:
                    os.fstat(descriptor)
                self.assertEqual(closed.exception.errno, errno.EBADF)
            public = (
                repr(caught.exception)
                + str(caught.exception)
                + repr(caught.exception.receipt)
            )
            self.assertNotIn("restore-private-marker", public)
            self.assertNotIn("stream-private-marker", public)
        finally:
            for descriptor in duplicated:
                try:
                    os.close(descriptor)
                except OSError:
                    pass

    def test_aliasing_stdout_and_stderr_is_rejected_without_flag_drift(self):
        stdout_read, writer = os.pipe()
        stderr_read = os.dup(stdout_read)
        os.close(writer)
        terminations = []

        try:
            with self.assertRaises(OutputCaptureError) as caught:
                self.capture_streams(
                    self.spec(),
                    stdout_read,
                    stderr_read,
                    request_termination=terminations.append,
                )
            self.assertTrue(os.get_blocking(stdout_read))
            self.assertTrue(os.get_blocking(stderr_read))
        finally:
            os.close(stdout_read)
            os.close(stderr_read)

        self.assertEqual(caught.exception.reason_code, "OUTPUT_STREAM_INVALID")
        self.assertEqual(terminations, ["OUTPUT_STREAM_INVALID"])

    def test_wall_deadline_uses_injected_monotonic_clock(self):
        terminations = []
        clock = ScriptedClock(10.0, 10.5)

        with self.assertRaises(OutputCaptureError) as caught:
            self.capture_bytes(
                b"waiting-output",
                b"",
                spec=self.spec(wall_timeout_ms=500),
                clock=clock,
                request_termination=terminations.append,
            )

        self.assertEqual(caught.exception.reason_code, "WALL_TIMEOUT")
        self.assertEqual(terminations, ["WALL_TIMEOUT"])

    def test_regressing_injected_clock_fails_closed(self):
        terminations = []

        with self.assertRaises(OutputCaptureError) as caught:
            self.capture_bytes(
                b"clock-private-marker",
                b"",
                clock=ScriptedClock(10.0, 9.0),
                request_termination=terminations.append,
            )

        self.assertEqual(caught.exception.reason_code, "CLOCK_ERROR")
        self.assertEqual(terminations, ["CLOCK_ERROR"])
        public = repr(caught.exception) + str(caught.exception) + repr(caught.exception.receipt)
        self.assertNotIn("clock-private-marker", public)

    def test_unrepresentable_clock_value_is_a_sanitized_clock_failure(self):
        terminations = []

        with self.assertRaises(OutputCaptureError) as caught:
            self.capture_bytes(
                b"clock-overflow-private-marker",
                b"",
                clock=lambda: 10**10000,
                request_termination=terminations.append,
            )

        self.assertEqual(caught.exception.reason_code, "CLOCK_ERROR")
        self.assertEqual(terminations, ["CLOCK_ERROR"])
        public = repr(caught.exception) + str(caught.exception) + repr(caught.exception.receipt)
        self.assertNotIn("clock-overflow-private-marker", public)

    def test_deadline_is_rechecked_after_wait_before_accepting_output(self):
        terminations = []

        with self.assertRaises(OutputCaptureError) as caught:
            self.capture_bytes(
                b"late-private-output",
                b"",
                spec=self.spec(wall_timeout_ms=1000, idle_timeout_ms=2000),
                clock=ScriptedClock(0.0, 0.0, 2.0),
                request_termination=terminations.append,
            )

        self.assertEqual(caught.exception.reason_code, "WALL_TIMEOUT")
        self.assertEqual(caught.exception.receipt.stdout_bytes, 0)
        self.assertEqual((self.raw / "stdout.bin").read_bytes(), b"")
        self.assertEqual(terminations, ["WALL_TIMEOUT"])

    def test_idle_deadline_stops_producer_that_never_closes_streams(self):
        stdout_read, stdout_write = os.pipe()
        stderr_read, stderr_write = os.pipe()
        terminations = []

        try:
            with self.assertRaises(OutputCaptureError) as caught:
                self.capture_streams(
                    self.spec(wall_timeout_ms=500, idle_timeout_ms=30),
                    stdout_read,
                    stderr_read,
                    request_termination=terminations.append,
                )
        finally:
            for descriptor in (stdout_read, stdout_write, stderr_read, stderr_write):
                os.close(descriptor)

        self.assertEqual(caught.exception.reason_code, "IDLE_TIMEOUT")
        self.assertEqual(terminations, ["IDLE_TIMEOUT"])

    def test_slowloris_activity_cannot_extend_absolute_wall_deadline(self):
        stdout_read, stdout_write = os.pipe()
        stderr_read, stderr_write = os.pipe()
        os.close(stderr_write)
        stopped = threading.Event()
        terminations = []

        def terminate(reason_code):
            terminations.append(reason_code)
            stopped.set()

        def trickle():
            try:
                while not stopped.is_set():
                    os.write(stdout_write, b"x")
                    time.sleep(0.005)
            except (BrokenPipeError, OSError):
                pass
            finally:
                os.close(stdout_write)

        producer = threading.Thread(target=trickle, daemon=True)
        producer.start()
        try:
            with self.assertRaises(OutputCaptureError) as caught:
                self.capture_streams(
                    self.spec(wall_timeout_ms=50, idle_timeout_ms=200),
                    stdout_read,
                    stderr_read,
                    request_termination=terminate,
                )
        finally:
            os.close(stdout_read)
            os.close(stderr_read)
            stopped.set()
            producer.join(timeout=1)

        self.assertFalse(producer.is_alive())
        self.assertEqual(caught.exception.reason_code, "WALL_TIMEOUT")
        self.assertEqual(terminations, ["WALL_TIMEOUT"])

    def test_short_writes_are_retried_until_all_bytes_are_private(self):
        payload = b"short-write-payload"

        def short_write(descriptor, data):
            return os.write(descriptor, data[:2])

        receipt = self.capture_bytes(payload, b"", write_fn=short_write)

        self.assertEqual((self.raw / "stdout.bin").read_bytes(), payload)
        self.assertEqual(receipt.stdout_bytes, len(payload))

    def test_wall_deadline_is_enforced_between_short_writes(self):
        terminations = []
        clock = MutableClock()

        def one_byte_write(descriptor, data):
            written = os.write(descriptor, data[:1])
            clock.value = 2.0
            return written

        with self.assertRaises(OutputCaptureError) as caught:
            self.capture_bytes(
                b"multiple-writes",
                b"",
                spec=self.spec(wall_timeout_ms=1000, idle_timeout_ms=2000),
                clock=clock,
                write_fn=one_byte_write,
                request_termination=terminations.append,
            )

        self.assertEqual(caught.exception.reason_code, "WALL_TIMEOUT")
        self.assertEqual(caught.exception.receipt.stdout_bytes, 1)
        self.assertEqual((self.raw / "stdout.bin").read_bytes(), b"m")
        self.assertEqual(terminations, ["WALL_TIMEOUT"])

    def test_enospc_is_sanitized_and_requests_termination(self):
        marker = "private-enospc-marker"
        terminations = []
        calls = 0

        def no_space(descriptor, data):
            nonlocal calls
            calls += 1
            if calls == 1:
                return os.write(descriptor, data[:2])
            raise OSError(errno.ENOSPC, marker)

        with self.assertRaises(OutputCaptureError) as caught:
            self.capture_bytes(
                b"payload",
                b"",
                write_fn=no_space,
                request_termination=terminations.append,
            )

        self.assertEqual(caught.exception.reason_code, "OUTPUT_STORAGE_ERROR")
        self.assertEqual(terminations, ["OUTPUT_STORAGE_ERROR"])
        self.assertEqual(caught.exception.receipt.outcome, "FAILED")
        self.assertEqual(caught.exception.receipt.stdout_bytes, 2)
        self.assertEqual(
            caught.exception.receipt.stdout_sha256,
            hashlib.sha256(b"pa").hexdigest(),
        )
        self.assertEqual((self.raw / "stdout.bin").read_bytes(), b"pa")
        public = repr(caught.exception) + str(caught.exception) + repr(caught.exception.receipt)
        self.assertNotIn(marker, public)

    def test_fsync_failure_is_fail_closed_and_sanitized(self):
        marker = "fsync-private-marker"
        terminations = []

        with mock.patch(
            "gauntlet.bounded_output.os.fsync",
            side_effect=OSError(errno.ENOSPC, marker),
        ) as fsync:
            with self.assertRaises(OutputCaptureError) as caught:
                self.capture_bytes(
                    b"stored-private-marker",
                    b"",
                    request_termination=terminations.append,
                )

        self.assertEqual(caught.exception.reason_code, "OUTPUT_STORAGE_ERROR")
        self.assertEqual(terminations, ["OUTPUT_STORAGE_ERROR"])
        self.assertEqual(fsync.call_count, 3)
        public = repr(caught.exception) + str(caught.exception) + repr(caught.exception.receipt)
        self.assertNotIn(marker, public)
        self.assertNotIn("stored-private-marker", public)

    def test_unexpected_fsync_diagnostics_are_sanitized(self):
        terminations = []

        with mock.patch(
            "gauntlet.bounded_output.os.fsync",
            side_effect=RuntimeError("unexpected-fsync-private-marker"),
        ):
            with self.assertRaises(OutputCaptureError) as caught:
                self.capture_bytes(
                    b"unexpected-fsync-output-marker",
                    b"",
                    request_termination=terminations.append,
                )

        self.assertEqual(caught.exception.reason_code, "OUTPUT_STORAGE_ERROR")
        self.assertEqual(terminations, ["OUTPUT_STORAGE_ERROR"])
        public = repr(caught.exception) + str(caught.exception) + repr(caught.exception.receipt)
        self.assertNotIn("unexpected-fsync-private-marker", public)
        self.assertNotIn("unexpected-fsync-output-marker", public)

    def test_deadline_crossed_during_final_fsync_never_returns_captured(self):
        original_fsync = os.fsync
        clock = MutableClock()
        fsync_calls = 0
        terminations = []

        def advance_after_directory_fsync(descriptor):
            nonlocal fsync_calls
            original_fsync(descriptor)
            fsync_calls += 1
            if fsync_calls == 3:
                clock.value = 2.0

        with mock.patch(
            "gauntlet.bounded_output.os.fsync",
            advance_after_directory_fsync,
        ):
            with self.assertRaises(OutputCaptureError) as caught:
                self.capture_bytes(
                    b"post-fsync-private-marker",
                    b"",
                    spec=self.spec(wall_timeout_ms=1000, idle_timeout_ms=2000),
                    clock=clock,
                    request_termination=terminations.append,
                )

        self.assertEqual(fsync_calls, 3)
        self.assertEqual(caught.exception.reason_code, "WALL_TIMEOUT")
        self.assertEqual(caught.exception.receipt.outcome, "FAILED")
        self.assertEqual(terminations, ["WALL_TIMEOUT"])
        public = repr(caught.exception) + str(caught.exception) + repr(caught.exception.receipt)
        self.assertNotIn("post-fsync-private-marker", public)

    def test_output_file_swap_during_fsync_is_detected(self):
        original_fsync = os.fsync
        pinned = self.raw / "pinned-during-fsync"
        foreign = self.root / "foreign-during-fsync"
        foreign.write_bytes(b"foreign-original")
        swapped = False
        terminations = []

        def swap_after_first_fsync(descriptor):
            nonlocal swapped
            original_fsync(descriptor)
            if not swapped:
                swapped = True
                (self.raw / "stdout.bin").rename(pinned)
                (self.raw / "stdout.bin").symlink_to(foreign)

        with mock.patch("gauntlet.bounded_output.os.fsync", swap_after_first_fsync):
            with self.assertRaises(OutputCaptureError) as caught:
                self.capture_bytes(
                    b"fsync-swap-private-marker",
                    b"",
                    request_termination=terminations.append,
                )

        self.assertEqual(caught.exception.reason_code, "OUTPUT_PATH_CHANGED")
        self.assertEqual(terminations, ["OUTPUT_PATH_CHANGED"])
        self.assertEqual(pinned.read_bytes(), b"fsync-swap-private-marker")
        self.assertEqual(foreign.read_bytes(), b"foreign-original")

    def test_raw_directory_swap_fails_without_writing_through_symlink(self):
        spec = self.spec(wall_timeout_ms=2000, idle_timeout_ms=1500)
        moved = self.root / "pinned-raw"
        foreign = self.root / "foreign"
        foreign.mkdir(mode=0o700)
        stdout_read, stdout_write = os.pipe()
        stderr_read, stderr_write = os.pipe()
        terminations = []

        def swap_and_finish():
            deadline = time.monotonic() + 1
            while not (self.raw / "stdout.bin").exists():
                if time.monotonic() >= deadline:
                    return
                time.sleep(0.001)
            self.raw.rename(moved)
            self.raw.symlink_to(foreign, target_is_directory=True)
            os.write(stdout_write, b"path-swap-marker")
            os.close(stdout_write)
            os.close(stderr_write)

        mutator = threading.Thread(target=swap_and_finish, daemon=True)
        mutator.start()
        try:
            with self.assertRaises(OutputCaptureError) as caught:
                self.capture_streams(
                    spec,
                    stdout_read,
                    stderr_read,
                    request_termination=terminations.append,
                )
        finally:
            mutator.join(timeout=1)
            os.close(stdout_read)
            os.close(stderr_read)

        self.assertEqual(caught.exception.reason_code, "OUTPUT_PATH_CHANGED")
        self.assertEqual(terminations, ["OUTPUT_PATH_CHANGED"])
        self.assertFalse((foreign / "stdout.bin").exists())
        self.assertEqual((moved / "stdout.bin").read_bytes(), b"path-swap-marker")

    def test_output_file_swap_is_detected_without_writing_through_symlink(self):
        pinned = self.raw / "pinned-stdout"
        foreign = self.root / "foreign-output"
        foreign.write_bytes(b"foreign-original")
        stdout_read, stdout_write = os.pipe()
        stderr_read, stderr_write = os.pipe()
        terminations = []

        def swap_and_finish():
            deadline = time.monotonic() + 1
            while not (self.raw / "stdout.bin").exists():
                if time.monotonic() >= deadline:
                    return
                time.sleep(0.001)
            (self.raw / "stdout.bin").rename(pinned)
            (self.raw / "stdout.bin").symlink_to(foreign)
            os.write(stdout_write, b"file-swap-marker")
            os.close(stdout_write)
            os.close(stderr_write)

        mutator = threading.Thread(target=swap_and_finish, daemon=True)
        mutator.start()
        try:
            with self.assertRaises(OutputCaptureError) as caught:
                self.capture_streams(
                    self.spec(wall_timeout_ms=2000, idle_timeout_ms=1500),
                    stdout_read,
                    stderr_read,
                    request_termination=terminations.append,
                )
        finally:
            mutator.join(timeout=1)
            os.close(stdout_read)
            os.close(stderr_read)

        self.assertEqual(caught.exception.reason_code, "OUTPUT_PATH_CHANGED")
        self.assertEqual(terminations, ["OUTPUT_PATH_CHANGED"])
        self.assertEqual(foreign.read_bytes(), b"foreign-original")
        self.assertEqual(pinned.read_bytes(), b"file-swap-marker")

    def test_preexisting_output_symlink_is_rejected_without_following_it(self):
        foreign = self.root / "foreign-secret"
        foreign.write_bytes(b"foreign-original")
        (self.raw / "stdout.bin").symlink_to(foreign)
        terminations = []

        with self.assertRaises(OutputCaptureError) as caught:
            self.capture_bytes(
                b"must-not-follow-output-symlink",
                b"",
                request_termination=terminations.append,
            )

        self.assertEqual(caught.exception.reason_code, "OUTPUT_PATH_UNSAFE")
        self.assertEqual(caught.exception.receipt.stdout_bytes, 0)
        self.assertEqual(terminations, ["OUTPUT_PATH_UNSAFE"])
        self.assertEqual(foreign.read_bytes(), b"foreign-original")
        public = repr(caught.exception) + str(caught.exception) + repr(caught.exception.receipt)
        self.assertNotIn("must-not-follow-output-symlink", public)

    def test_symlink_in_output_directory_ancestry_is_never_followed(self):
        layout_parent = self.root / "layout-parent"
        layout_parent.mkdir(mode=0o700)
        attempt_root = layout_parent / "attempt"
        attempt_root.mkdir(mode=0o700)
        worktree = attempt_root / "work"
        worktree.mkdir(mode=0o700)
        raw = attempt_root / "raw"
        raw.mkdir(mode=0o700)
        spec = self.spec(
            attempt_root=str(attempt_root),
            worktree=str(worktree),
            raw_directory=str(raw),
        )
        grant = self.grant(spec)
        moved_parent = self.root / "moved-layout-parent"
        layout_parent.rename(moved_parent)
        layout_parent.symlink_to(moved_parent, target_is_directory=True)
        terminations = []

        with self.assertRaises(OutputCaptureError) as caught:
            self.capture_bytes(
                b"ancestor-symlink-secret",
                b"",
                spec=spec,
                grant=grant,
                request_termination=terminations.append,
            )

        self.assertEqual(caught.exception.reason_code, "OUTPUT_PATH_UNSAFE")
        self.assertEqual(terminations, ["OUTPUT_PATH_UNSAFE"])
        self.assertFalse((moved_parent / "attempt" / "raw" / "stdout.bin").exists())

    def test_stdout_and_stderr_are_drained_without_one_stream_starvation(self):
        stdout_payload = b"o" * (128 * 1024)
        stderr_payload = b"e" * (128 * 1024)
        stdout_read, stdout_write = os.pipe()
        stderr_read, stderr_write = os.pipe()
        stderr_finished = threading.Event()

        def write_all(descriptor, payload):
            offset = 0
            while offset < len(payload):
                offset += os.write(descriptor, payload[offset:])

        def produce_stdout():
            write_all(stdout_write, stdout_payload)
            stderr_finished.wait(timeout=1)
            os.close(stdout_write)

        def produce_stderr():
            write_all(stderr_write, stderr_payload)
            stderr_finished.set()
            os.close(stderr_write)

        producers = [
            threading.Thread(target=produce_stdout, daemon=True),
            threading.Thread(target=produce_stderr, daemon=True),
        ]
        for producer in producers:
            producer.start()
        try:
            receipt = self.capture_streams(
                self.spec(
                    stdout_max_bytes=256 * 1024,
                    stderr_max_bytes=256 * 1024,
                    combined_max_bytes=512 * 1024,
                    idle_timeout_ms=500,
                ),
                stdout_read,
                stderr_read,
            )
        finally:
            os.close(stdout_read)
            os.close(stderr_read)
            for producer in producers:
                producer.join(timeout=1)

        self.assertFalse(any(producer.is_alive() for producer in producers))
        self.assertEqual(receipt.stdout_bytes, len(stdout_payload))
        self.assertEqual(receipt.stderr_bytes, len(stderr_payload))
        self.assertEqual((self.raw / "stdout.bin").read_bytes(), stdout_payload)
        self.assertEqual((self.raw / "stderr.bin").read_bytes(), stderr_payload)


if __name__ == "__main__":
    unittest.main()
