import hashlib
import errno
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
    capture_bounded_output,
)


class ScriptedClock:
    def __init__(self, *values):
        self.values = list(values)
        self.last = values[-1]

    def __call__(self):
        if self.values:
            self.last = self.values.pop(0)
        return self.last


class BoundedOutputTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.raw = self.root / "raw"
        self.raw.mkdir(mode=0o700)

    def tearDown(self):
        self.tmp.cleanup()

    def spec(self, **overrides):
        values = {
            "campaign_id": "campaign-01",
            "task_id": "task-01",
            "attempt": 2,
            "controller_epoch": 7,
            "task_spec_sha256": "a" * 64,
            "raw_directory": str(self.raw),
            "stdout_max_bytes": 4096,
            "stderr_max_bytes": 4096,
            "combined_max_bytes": 8192,
            "wall_seconds": 1.0,
            "idle_seconds": 0.2,
        }
        values.update(overrides)
        return BoundedOutputSpec(**values)

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
            return capture_bounded_output(
                self.spec() if spec is None else spec,
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
            ({"wall_seconds": float("nan")}, "INVALID_OUTPUT_TIME_BUDGET"),
            ({"wall_seconds": 10**10000}, "INVALID_OUTPUT_TIME_BUDGET"),
            ({"attempt": True}, "INVALID_CAPTURE_FENCE"),
        )

        for overrides, reason_code in cases:
            with self.subTest(overrides=overrides):
                with self.assertRaises(OutputCaptureError) as caught:
                    self.spec(**overrides)
                self.assertEqual(caught.exception.reason_code, reason_code)

    def test_captures_invalid_bytes_in_private_files_with_sanitized_receipt(self):
        stdout = b"\xff\xfeprivate-stdout-marker"
        stderr = b"\x80private-stderr-marker"

        receipt = self.capture_bytes(stdout, stderr)

        self.assertEqual((self.raw / "stdout.bin").read_bytes(), stdout)
        self.assertEqual((self.raw / "stderr.bin").read_bytes(), stderr)
        self.assertEqual(stat.S_IMODE((self.raw / "stdout.bin").stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.raw / "stderr.bin").stat().st_mode), 0o600)
        self.assertEqual((self.raw / "stdout.bin").stat().st_uid, os.geteuid())
        self.assertEqual((self.raw / "stderr.bin").stat().st_uid, os.geteuid())
        self.assertEqual(receipt.stdout_sha256, hashlib.sha256(stdout).hexdigest())
        self.assertEqual(receipt.stderr_sha256, hashlib.sha256(stderr).hexdigest())
        self.assertEqual(receipt.combined_bytes, len(stdout) + len(stderr))
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
                terminate=terminations.append,
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
        try:
            with self.assertRaises(OutputCaptureError) as caught:
                capture_bounded_output(
                    self.spec(stdout_max_bytes=1024, combined_max_bytes=2048),
                    stdout_read,
                    stderr_read,
                    terminate=terminate,
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
                terminate=terminations.append,
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
                terminate=terminations.append,
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
                terminate=terminations.append,
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
                terminate=broken_termination,
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
                capture_bounded_output(
                    self.spec(),
                    stdout,
                    stderr,
                    terminate=terminations.append,
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
            capture_bounded_output(self.spec(), stdout_read, stderr_read)
            self.assertTrue(os.get_blocking(stdout_read))
            self.assertFalse(os.get_blocking(stderr_read))
        finally:
            os.close(stdout_read)
            os.close(stderr_read)

    def test_aliasing_stdout_and_stderr_is_rejected_without_flag_drift(self):
        stdout_read, writer = os.pipe()
        stderr_read = os.dup(stdout_read)
        os.close(writer)
        terminations = []

        try:
            with self.assertRaises(OutputCaptureError) as caught:
                capture_bounded_output(
                    self.spec(),
                    stdout_read,
                    stderr_read,
                    terminate=terminations.append,
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
                spec=self.spec(wall_seconds=0.5),
                clock=clock,
                terminate=terminations.append,
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
                terminate=terminations.append,
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
                terminate=terminations.append,
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
                spec=self.spec(wall_seconds=1.0, idle_seconds=2.0),
                clock=ScriptedClock(0.0, 0.0, 2.0),
                terminate=terminations.append,
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
                capture_bounded_output(
                    self.spec(wall_seconds=0.5, idle_seconds=0.03),
                    stdout_read,
                    stderr_read,
                    terminate=terminations.append,
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
                capture_bounded_output(
                    self.spec(wall_seconds=0.05, idle_seconds=0.2),
                    stdout_read,
                    stderr_read,
                    terminate=terminate,
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

        def one_byte_write(descriptor, data):
            return os.write(descriptor, data[:1])

        with self.assertRaises(OutputCaptureError) as caught:
            self.capture_bytes(
                b"multiple-writes",
                b"",
                spec=self.spec(wall_seconds=1.0, idle_seconds=2.0),
                clock=ScriptedClock(0.0, 0.0, 0.0, 2.0),
                write_fn=one_byte_write,
                terminate=terminations.append,
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
                terminate=terminations.append,
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
        ):
            with self.assertRaises(OutputCaptureError) as caught:
                self.capture_bytes(
                    b"stored-private-marker",
                    b"",
                    terminate=terminations.append,
                )

        self.assertEqual(caught.exception.reason_code, "OUTPUT_STORAGE_ERROR")
        self.assertEqual(terminations, ["OUTPUT_STORAGE_ERROR"])
        public = repr(caught.exception) + str(caught.exception) + repr(caught.exception.receipt)
        self.assertNotIn(marker, public)
        self.assertNotIn("stored-private-marker", public)

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
                    terminate=terminations.append,
                )

        self.assertEqual(caught.exception.reason_code, "OUTPUT_PATH_CHANGED")
        self.assertEqual(terminations, ["OUTPUT_PATH_CHANGED"])
        self.assertEqual(pinned.read_bytes(), b"fsync-swap-private-marker")
        self.assertEqual(foreign.read_bytes(), b"foreign-original")

    def test_raw_directory_swap_fails_without_writing_through_symlink(self):
        spec = self.spec(wall_seconds=2.0, idle_seconds=1.5)
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
                capture_bounded_output(
                    spec,
                    stdout_read,
                    stderr_read,
                    terminate=terminations.append,
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
                capture_bounded_output(
                    self.spec(wall_seconds=2.0, idle_seconds=1.5),
                    stdout_read,
                    stderr_read,
                    terminate=terminations.append,
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
                terminate=terminations.append,
            )

        self.assertEqual(caught.exception.reason_code, "OUTPUT_PATH_UNSAFE")
        self.assertEqual(caught.exception.receipt.stdout_bytes, 0)
        self.assertEqual(terminations, ["OUTPUT_PATH_UNSAFE"])
        self.assertEqual(foreign.read_bytes(), b"foreign-original")
        public = repr(caught.exception) + str(caught.exception) + repr(caught.exception.receipt)
        self.assertNotIn("must-not-follow-output-symlink", public)

    def test_symlink_in_output_directory_ancestry_is_never_followed(self):
        actual_parent = self.root / "actual-parent"
        actual_parent.mkdir(mode=0o700)
        actual_raw = actual_parent / "raw"
        actual_raw.mkdir(mode=0o700)
        linked_parent = self.root / "linked-parent"
        linked_parent.symlink_to(actual_parent, target_is_directory=True)
        terminations = []

        with self.assertRaises(OutputCaptureError) as caught:
            self.capture_bytes(
                b"ancestor-symlink-secret",
                b"",
                spec=self.spec(raw_directory=str(linked_parent / "raw")),
                terminate=terminations.append,
            )

        self.assertEqual(caught.exception.reason_code, "OUTPUT_PATH_UNSAFE")
        self.assertEqual(terminations, ["OUTPUT_PATH_UNSAFE"])
        self.assertFalse((actual_raw / "stdout.bin").exists())

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
            receipt = capture_bounded_output(
                self.spec(
                    stdout_max_bytes=256 * 1024,
                    stderr_max_bytes=256 * 1024,
                    combined_max_bytes=512 * 1024,
                    idle_seconds=0.5,
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
