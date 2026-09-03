import errno
import fcntl
import hashlib
import inspect
import json
import os
import selectors
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from dataclasses import FrozenInstanceError, asdict
from pathlib import Path
from unittest import mock

import gauntlet.evidence_pump as evidence_pump_module
from gauntlet.evidence_pump import EvidencePumpError, EvidenceReceipt, pump_evidence


ATTEMPT_ID = "a" * 64


def _close(fd):
    try:
        os.close(fd)
    except OSError:
        pass


def _decode_frames(raw):
    if not raw.startswith(evidence_pump_module._MAGIC):
        raise ValueError("not an evidence object")
    frames = []
    offset = len(evidence_pump_module._MAGIC)
    while offset < len(raw):
        header_offset = offset
        if len(raw) - offset < evidence_pump_module._FRAME_HEADER.size:
            raise ValueError("truncated frame header")
        kind, length = evidence_pump_module._FRAME_HEADER.unpack_from(raw, offset)
        offset += evidence_pump_module._FRAME_HEADER.size
        end = offset + length
        if end > len(raw):
            raise ValueError("truncated frame payload")
        frames.append((kind, raw[offset:end], header_offset, offset))
        offset = end
    return frames


def _rebuild_frames(frames):
    return evidence_pump_module._MAGIC + b"".join(
        evidence_pump_module._encode_frame(kind, payload)
        for kind, payload in frames
    )


class EvidencePumpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.raw_directory = Path(self.temp.name) / "raw"
        self.raw_directory.mkdir(mode=0o700)

    def tearDown(self):
        self.temp.cleanup()

    def attempt(self, number):
        return f"{number:064x}"

    def pipes(self, stdout=b"", stderr=b"", *, close_writers=True):
        stdout_read, stdout_write = os.pipe()
        stderr_read, stderr_write = os.pipe()
        self.addCleanup(_close, stdout_read)
        self.addCleanup(_close, stderr_read)
        self.addCleanup(_close, stdout_write)
        self.addCleanup(_close, stderr_write)
        if stdout:
            os.write(stdout_write, stdout)
        if stderr:
            os.write(stderr_write, stderr)
        if close_writers:
            _close(stdout_write)
            _close(stderr_write)
        return stdout_read, stderr_read, stdout_write, stderr_write

    def eof_pipes(self):
        stdout, stderr, _, _ = self.pipes()
        return stdout, stderr

    def pump_kwargs(self, attempt_id=ATTEMPT_ID):
        return {
            "raw_directory": self.raw_directory,
            "attempt_id": attempt_id,
            "retained_byte_cap": 1024,
            "observed_byte_cap": 4096,
            "timeout_seconds": 1,
            "drain_timeout_seconds": 0.1,
            "stop_callback_timeout_seconds": 0.1,
            "stop_callback": lambda: None,
        }

    def evidence_path(self, attempt_id=ATTEMPT_ID):
        matches = list(self.raw_directory.glob(f"{attempt_id}.*.evidence"))
        self.assertEqual(len(matches), 1)
        return matches[0]

    def test_module_exports_only_the_narrow_public_seam(self):
        self.assertEqual(
            evidence_pump_module.__all__,
            ("EvidencePumpError", "EvidenceReceipt", "pump_evidence"),
        )
        self.assertFalse(hasattr(evidence_pump_module, "CancellationSignal"))
        for name in evidence_pump_module.__all__:
            self.assertTrue(hasattr(evidence_pump_module, name))

    def parsed_evidence(self, attempt_id=ATTEMPT_ID):
        path = self.evidence_path(attempt_id)
        generation = path.name.split(".")[1]
        parsed = evidence_pump_module._parse_evidence_object(
            path.read_bytes(),
            expected_attempt_id=attempt_id,
            expected_generation=generation,
        )
        return path, parsed

    def test_concurrently_drains_large_streams_into_one_exact_framed_object(self):
        stdout_chunk = b"stdout-evidence-" * 512
        stderr_chunk = b"stderr-evidence-" * 512
        repetitions = 24
        child = subprocess.Popen(
            [
                sys.executable,
                "-c",
                (
                    "import os\n"
                    f"out={stdout_chunk!r}\n"
                    f"err={stderr_chunk!r}\n"
                    f"repetitions={repetitions}\n"
                    "for _ in range(repetitions):\n"
                    " os.write(1, out)\n"
                    " os.write(2, err)\n"
                ),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertIsNotNone(child.stdout)
        self.assertIsNotNone(child.stderr)
        receipt = pump_evidence(
            child.stdout.fileno(),
            child.stderr.fileno(),
            **(
                self.pump_kwargs()
                | {
                    "retained_byte_cap": 2_000_000,
                    "observed_byte_cap": 4_000_000,
                    "timeout_seconds": 5,
                    "drain_timeout_seconds": 1,
                }
            ),
        )
        self.assertEqual(child.wait(timeout=2), 0)
        child.stdout.close()
        child.stderr.close()

        expected_stdout = stdout_chunk * repetitions
        expected_stderr = stderr_chunk * repetitions
        self.assertEqual(receipt.stdout_observed_bytes, len(expected_stdout))
        self.assertEqual(receipt.stderr_observed_bytes, len(expected_stderr))
        self.assertEqual(
            receipt.stdout_observed_sha256,
            hashlib.sha256(expected_stdout).hexdigest(),
        )
        self.assertEqual(
            receipt.stderr_observed_sha256,
            hashlib.sha256(expected_stderr).hexdigest(),
        )
        self.assertTrue(receipt.stdout_eof and receipt.stderr_eof)
        self.assertTrue(receipt.raw_evidence_committed)
        self.assertFalse(receipt.recovery_required)

        path, parsed = self.parsed_evidence()
        frames = _decode_frames(path.read_bytes())
        framed_stdout = b"".join(payload for kind, payload, _, _ in frames if kind == b"O")
        framed_stderr = b"".join(payload for kind, payload, _, _ in frames if kind == b"E")
        self.assertEqual(framed_stdout, expected_stdout)
        self.assertEqual(framed_stderr, expected_stderr)
        self.assertEqual(parsed.object_sha256, hashlib.sha256(path.read_bytes()).hexdigest())
        self.assertEqual(parsed.state, "COMMITTED")
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

        attempt_entries = sorted(self.raw_directory.glob(f"{ATTEMPT_ID}.*"))
        self.assertEqual(len(attempt_entries), 2)
        self.assertEqual(
            {entry.name.rsplit(".", 1)[-1] for entry in attempt_entries},
            {"lock", "evidence"},
        )
        serialized = repr(receipt) + repr(asdict(receipt))
        self.assertNotIn(str(self.raw_directory), serialized)
        self.assertNotIn("stdout-evidence", serialized)
        self.assertNotIn("stderr-evidence", serialized)

    def test_receipt_binds_authenticated_object_and_distinguishes_equal_streams(self):
        payload = b"same-stream-evidence"
        first_out, first_err, _, _ = self.pipes(payload, payload)
        first = pump_evidence(first_out, first_err, **self.pump_kwargs())

        second_attempt = self.attempt(2)
        second_raw = Path(self.temp.name) / "second-raw"
        second_raw.mkdir(mode=0o700)
        second_out, second_err, _, _ = self.pipes(payload, payload)
        second = pump_evidence(
            second_out,
            second_err,
            **(
                self.pump_kwargs(second_attempt)
                | {"raw_directory": second_raw}
            ),
        )

        for raw_directory, attempt_id, receipt in (
            (self.raw_directory, ATTEMPT_ID, first),
            (second_raw, second_attempt, second),
        ):
            objects = list(raw_directory.glob(f"{attempt_id}.*.evidence"))
            self.assertEqual(len(objects), 1)
            raw = objects[0].read_bytes()
            generation = objects[0].name.split(".")[1]
            self.assertEqual(receipt.attempt_id, attempt_id)
            self.assertEqual(receipt.generation, generation)
            self.assertEqual(receipt.evidence_bytes, len(raw))
            self.assertEqual(
                receipt.evidence_sha256,
                hashlib.sha256(raw).hexdigest(),
            )
            parsed = evidence_pump_module._parse_evidence_object(
                raw,
                expected_attempt_id=attempt_id,
                expected_generation=generation,
            )
            self.assertEqual(receipt.attempt_id, parsed.attempt_id)
            self.assertEqual(receipt.generation, parsed.generation)
            self.assertEqual(receipt.evidence_sha256, parsed.object_sha256)
            self.assertEqual(receipt.evidence_bytes, parsed.object_bytes)

        self.assertEqual(
            first.stdout_observed_sha256,
            second.stdout_observed_sha256,
        )
        self.assertEqual(
            first.stderr_observed_sha256,
            second.stderr_observed_sha256,
        )
        self.assertNotEqual(first.evidence_sha256, second.evidence_sha256)

    def test_combined_retention_overflow_stops_once_and_boundedly_drains_to_eof(self):
        stdout_chunk = b"O" * 4096
        stderr_chunk = b"E" * 6144
        repetitions = 20
        child = subprocess.Popen(
            [
                sys.executable,
                "-c",
                (
                    "import os\n"
                    f"out={stdout_chunk!r}\n"
                    f"err={stderr_chunk!r}\n"
                    f"repetitions={repetitions}\n"
                    "for _ in range(repetitions):\n"
                    " os.write(1, out)\n"
                    " os.write(2, err)\n"
                ),
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertIsNotNone(child.stdout)
        self.assertIsNotNone(child.stderr)
        calls = []
        receipt = pump_evidence(
            child.stdout.fileno(),
            child.stderr.fileno(),
            **(
                self.pump_kwargs()
                | {
                    "retained_byte_cap": 5000,
                    "observed_byte_cap": 1_000_000,
                    "timeout_seconds": 5,
                    "drain_timeout_seconds": 2,
                    "stop_callback": lambda: calls.append(True),
                }
            ),
        )
        self.assertEqual(child.wait(timeout=2), 0)
        child.stdout.close()
        child.stderr.close()
        self.assertEqual(calls, [True])
        self.assertTrue(receipt.overflowed)
        self.assertEqual(
            receipt.stdout_retained_bytes + receipt.stderr_retained_bytes,
            5000,
        )
        self.assertTrue(receipt.stdout_eof and receipt.stderr_eof)
        self.assertFalse(receipt.drain_limit_reached)
        self.assertTrue(receipt.raw_evidence_committed)
        self.assertTrue(receipt.recovery_required)
        _, parsed = self.parsed_evidence()
        self.assertEqual(parsed.state, "COMMITTED")
        self.assertEqual(parsed.stdout_retained.size, receipt.stdout_retained_bytes)
        self.assertEqual(parsed.stderr_retained.size, receipt.stderr_retained_bytes)

    def test_observed_cap_is_explicit_incomplete_quarantined_evidence(self):
        stdout_fd, stderr_fd, _, _ = self.pipes(b"O" * 1024, b"")
        calls = []
        receipt = pump_evidence(
            stdout_fd,
            stderr_fd,
            **(
                self.pump_kwargs()
                | {
                    "retained_byte_cap": 256,
                    "observed_byte_cap": 512,
                    "stop_callback": lambda: calls.append(True),
                }
            ),
        )
        self.assertEqual(calls, [True])
        self.assertEqual(
            receipt.stdout_observed_bytes + receipt.stderr_observed_bytes,
            512,
        )
        self.assertEqual(receipt.stdout_observed_bytes, 512)
        self.assertEqual(receipt.stdout_retained_bytes, 256)
        self.assertEqual(
            receipt.stdout_observed_sha256,
            hashlib.sha256(b"O" * 512).hexdigest(),
        )
        self.assertEqual(
            receipt.stdout_retained_sha256,
            hashlib.sha256(b"O" * 256).hexdigest(),
        )
        self.assertTrue(receipt.drain_limit_reached)
        self.assertTrue(receipt.raw_evidence_quarantined)
        self.assertFalse(receipt.raw_evidence_committed)
        self.assertTrue(receipt.recovery_required)
        _, parsed = self.parsed_evidence()
        self.assertEqual(parsed.state, "QUARANTINED")

    def test_timeout_requests_one_stop_and_authenticates_quarantine(self):
        stdout_fd, stderr_fd, stdout_write, stderr_write = self.pipes(close_writers=False)
        calls = []

        def stop():
            calls.append(True)
            _close(stdout_write)
            _close(stderr_write)

        receipt = pump_evidence(
            stdout_fd,
            stderr_fd,
            **(
                self.pump_kwargs()
                | {
                    "timeout_seconds": 0.02,
                    "drain_timeout_seconds": 0.2,
                    "stop_callback": stop,
                }
            ),
        )
        self.assertEqual(calls, [True])
        self.assertTrue(receipt.timed_out)
        self.assertTrue(receipt.stop_callback_completed)
        self.assertTrue(receipt.raw_evidence_quarantined)
        self.assertTrue(receipt.recovery_required)
        _, parsed = self.parsed_evidence()
        self.assertEqual(parsed.state, "QUARANTINED")

    def test_cancellation_with_open_writers_is_bounded_and_truthful(self):
        stdout_fd, stderr_fd, _, _ = self.pipes(close_writers=False)
        cancelled = threading.Event()
        cancelled.set()
        started = time.monotonic()
        receipt = pump_evidence(
            stdout_fd,
            stderr_fd,
            **(
                self.pump_kwargs()
                | {
                    "cancel_event": cancelled,
                    "drain_timeout_seconds": 0.05,
                }
            ),
        )
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertTrue(receipt.cancelled)
        self.assertTrue(receipt.drain_limit_reached)
        self.assertFalse(receipt.stdout_eof or receipt.stderr_eof)
        self.assertTrue(receipt.raw_evidence_quarantined)
        self.assertTrue(receipt.recovery_required)

    def test_exact_unset_threading_event_allows_normal_capture(self):
        stdout_fd, stderr_fd, _, _ = self.pipes(b"stdout", b"stderr")
        receipt = pump_evidence(
            stdout_fd,
            stderr_fd,
            **(self.pump_kwargs() | {"cancel_event": threading.Event()}),
        )
        self.assertTrue(receipt.raw_evidence_committed)
        self.assertFalse(receipt.cancelled)

    def test_custom_blocking_cancellation_signal_is_rejected_without_execution(self):
        stdout_fd, stderr_fd = self.eof_pipes()
        calls = []
        signal_calls = []

        class BlockingCancellation:
            def is_set(self):
                signal_calls.append(True)
                time.sleep(1)
                return False

        started = time.monotonic()
        with self.assertRaises(EvidencePumpError) as caught:
            pump_evidence(
                stdout_fd,
                stderr_fd,
                **(
                    self.pump_kwargs()
                    | {
                        "cancel_event": BlockingCancellation(),
                        "stop_callback": lambda: calls.append(True),
                    }
                ),
            )
        self.assertLess(time.monotonic() - started, 0.5)
        self.assertEqual(calls, [True])
        self.assertEqual(signal_calls, [])
        receipt = caught.exception.receipt
        self.assertFalse(receipt.capture_started)
        self.assertTrue(receipt.stop_callback_completed)
        self.assertTrue(receipt.recovery_required)
        self.assertIsNone(receipt.attempt_id)
        self.assertIsNone(receipt.generation)
        self.assertIsNone(receipt.evidence_sha256)
        self.assertEqual(receipt.evidence_bytes, 0)
        self.assertEqual(list(self.raw_directory.iterdir()), [])

    def test_threading_event_subclass_override_is_rejected_without_execution(self):
        stdout_fd, stderr_fd = self.eof_pipes()
        calls = []
        signal_calls = []

        class EventSubclass(threading.Event):
            def is_set(self):
                signal_calls.append(True)
                raise RuntimeError("must not execute")

        with self.assertRaises(EvidencePumpError) as caught:
            pump_evidence(
                stdout_fd,
                stderr_fd,
                **(
                    self.pump_kwargs()
                    | {
                        "cancel_event": EventSubclass(),
                        "stop_callback": lambda: calls.append(True),
                    }
                ),
            )
        self.assertEqual(calls, [True])
        self.assertEqual(signal_calls, [])
        receipt = caught.exception.receipt
        self.assertFalse(receipt.capture_started)
        self.assertTrue(receipt.stop_callback_completed)
        self.assertTrue(receipt.recovery_required)
        self.assertEqual(list(self.raw_directory.iterdir()), [])

    def test_post_timeout_selector_waits_are_positive_and_do_not_spin(self):
        stdout_fd, stderr_fd, _, _ = self.pipes(close_writers=False)
        original_selector = selectors.DefaultSelector
        waits = []

        class RecordingSelector:
            def __init__(self):
                self.delegate = original_selector()

            def register(self, *args):
                return self.delegate.register(*args)

            def unregister(self, *args):
                return self.delegate.unregister(*args)

            def select(self, timeout=None):
                waits.append(timeout)
                return self.delegate.select(timeout)

            def close(self):
                return self.delegate.close()

        started_cpu = time.process_time()
        with mock.patch(
            "gauntlet.evidence_pump.selectors.DefaultSelector",
            side_effect=RecordingSelector,
        ):
            receipt = pump_evidence(
                stdout_fd,
                stderr_fd,
                **(
                    self.pump_kwargs()
                    | {
                        "timeout_seconds": 0.02,
                        "drain_timeout_seconds": 0.08,
                    }
                ),
            )
        cpu_elapsed = time.process_time() - started_cpu
        self.assertTrue(receipt.timed_out and receipt.drain_limit_reached)
        self.assertLess(len(waits), 10)
        self.assertTrue(all(wait is not None and wait > 0 for wait in waits))
        self.assertLess(cpu_elapsed, 0.05)

    def test_blocking_stop_callback_is_bounded_and_never_claims_process_cleanup(self):
        stdout_fd, stderr_fd, _, _ = self.pipes(b"overflow", b"err")
        release = threading.Event()
        entered = threading.Event()

        def blocked_stop():
            entered.set()
            release.wait(2)

        started = time.monotonic()
        try:
            with self.assertRaises(EvidencePumpError) as caught:
                pump_evidence(
                    stdout_fd,
                    stderr_fd,
                    **(
                        self.pump_kwargs()
                        | {
                            "retained_byte_cap": 1,
                            "stop_callback_timeout_seconds": 0.03,
                            "stop_callback": blocked_stop,
                        }
                    ),
                )
        finally:
            release.set()
        self.assertTrue(entered.is_set())
        self.assertLess(time.monotonic() - started, 0.5)
        receipt = caught.exception.receipt
        self.assertTrue(receipt.stop_callback_timed_out)
        self.assertFalse(receipt.stop_callback_completed)
        self.assertTrue(receipt.raw_evidence_quarantined)
        self.assertTrue(receipt.recovery_required)
        self.assertFalse(any("process" in key or "cgroup" in key for key in asdict(receipt)))

    def test_stop_callback_failure_raises_with_authenticated_quarantine(self):
        stdout_fd, stderr_fd, _, _ = self.pipes(b"overflow", b"err")
        calls = []

        def fail_stop():
            calls.append(True)
            raise RuntimeError("stop failed")

        with self.assertRaises(EvidencePumpError) as caught:
            pump_evidence(
                stdout_fd,
                stderr_fd,
                **(
                    self.pump_kwargs()
                    | {"retained_byte_cap": 1, "stop_callback": fail_stop}
                ),
            )
        self.assertEqual(calls, [True])
        self.assertTrue(caught.exception.receipt.stop_callback_failed)
        self.assertTrue(caught.exception.receipt.raw_evidence_quarantined)
        path, parsed = self.parsed_evidence()
        receipt = caught.exception.receipt
        self.assertEqual(parsed.state, "QUARANTINED")
        self.assertEqual(receipt.attempt_id, parsed.attempt_id)
        self.assertEqual(receipt.generation, parsed.generation)
        self.assertEqual(receipt.evidence_sha256, parsed.object_sha256)
        self.assertEqual(receipt.evidence_bytes, len(path.read_bytes()))

    def test_invalid_callback_timeout_still_requests_one_bounded_stop(self):
        stdout_fd, stderr_fd = self.eof_pipes()
        calls = []
        with self.assertRaises(EvidencePumpError) as caught:
            pump_evidence(
                stdout_fd,
                stderr_fd,
                **(
                    self.pump_kwargs()
                    | {
                        "stop_callback_timeout_seconds": 0,
                        "stop_callback": lambda: calls.append(True),
                    }
                ),
            )
        self.assertEqual(calls, [True])
        receipt = caught.exception.receipt
        self.assertFalse(receipt.capture_started)
        self.assertTrue(receipt.stop_callback_completed)
        self.assertTrue(receipt.recovery_required)
        self.assertEqual(list(self.raw_directory.iterdir()), [])

    def test_invalid_preflight_values_request_stop_without_reserving_artifacts(self):
        stdout_fd, stderr_fd = self.eof_pipes()
        invalid = (
            {"attempt_id": "bad"},
            {"retained_byte_cap": True},
            {"retained_byte_cap": -1},
            {"retained_byte_cap": evidence_pump_module._MAX_RETAINED_BYTES + 1},
            {"observed_byte_cap": 0},
            {"observed_byte_cap": evidence_pump_module._MAX_OBSERVED_BYTES + 1},
            {"retained_byte_cap": 1024, "observed_byte_cap": 512},
            {"timeout_seconds": 0},
            {"timeout_seconds": float("inf")},
            {"drain_timeout_seconds": float("nan")},
            {"cancel_event": object()},
        )
        for index, changed in enumerate(invalid, 10):
            attempt_id = self.attempt(index)
            calls = []
            with self.subTest(changed=changed):
                with self.assertRaises(EvidencePumpError) as caught:
                    pump_evidence(
                        stdout_fd,
                        stderr_fd,
                        **(
                            self.pump_kwargs(attempt_id)
                            | changed
                            | {"stop_callback": lambda: calls.append(True)}
                        ),
                    )
                self.assertEqual(calls, [True])
                receipt = caught.exception.receipt
                self.assertFalse(receipt.capture_started)
                self.assertIsNone(receipt.attempt_id)
                self.assertIsNone(receipt.generation)
                self.assertIsNone(receipt.evidence_sha256)
                self.assertEqual(receipt.evidence_bytes, 0)
                self.assertEqual(list(self.raw_directory.glob(f"{attempt_id}.*")), [])

    def test_stdout_and_stderr_must_be_distinct_kernel_streams(self):
        stdout_fd, _, _, _ = self.pipes(b"ambiguous-stream", b"")
        calls = []
        with self.assertRaises(EvidencePumpError) as caught:
            pump_evidence(
                stdout_fd,
                stdout_fd,
                **(self.pump_kwargs() | {"stop_callback": lambda: calls.append(True)}),
            )
        self.assertEqual(calls, [True])
        receipt = caught.exception.receipt
        self.assertFalse(receipt.capture_started)
        self.assertIsNone(receipt.attempt_id)
        self.assertIsNone(receipt.generation)
        self.assertIsNone(receipt.evidence_sha256)
        self.assertEqual(receipt.evidence_bytes, 0)
        self.assertEqual(list(self.raw_directory.iterdir()), [])

    def test_input_descriptor_is_pinned_before_artifact_path_resolution(self):
        stdout_fd, stderr_fd, _, _ = self.pipes(b"trusted-stdout", b"")
        attacker_fd, _, _, _ = self.pipes(b"attacker-stdout", b"")
        rebound = False

        class RebindingDirectory:
            def __fspath__(inner_self):
                nonlocal rebound
                if not rebound:
                    _close(stdout_fd)
                    os.dup2(attacker_fd, stdout_fd)
                    rebound = True
                return str(self.raw_directory)

        receipt = pump_evidence(
            stdout_fd,
            stderr_fd,
            **(
                self.pump_kwargs()
                | {"raw_directory": RebindingDirectory()}
            ),
        )
        self.assertTrue(rebound)
        self.assertEqual(receipt.stdout_observed_bytes, len(b"trusted-stdout"))
        self.assertEqual(
            receipt.stdout_observed_sha256,
            hashlib.sha256(b"trusted-stdout").hexdigest(),
        )
        self.assertNotEqual(
            receipt.stdout_observed_sha256,
            hashlib.sha256(b"attacker-stdout").hexdigest(),
        )

    def test_regular_input_descriptor_requests_stop_before_artifact_reservation(self):
        regular = Path(self.temp.name) / "not-a-pipe"
        regular.write_bytes(b"not output")
        regular_fd = os.open(regular, os.O_RDONLY)
        self.addCleanup(_close, regular_fd)
        _, stderr_fd = self.eof_pipes()
        calls = []
        with self.assertRaises(EvidencePumpError) as caught:
            pump_evidence(
                regular_fd,
                stderr_fd,
                **(self.pump_kwargs() | {"stop_callback": lambda: calls.append(True)}),
            )
        self.assertEqual(calls, [True])
        self.assertFalse(caught.exception.receipt.capture_started)
        self.assertEqual(list(self.raw_directory.iterdir()), [])

    def test_noncallable_callback_is_rejected_before_entry_contract(self):
        stdout_fd, stderr_fd = self.eof_pipes()
        with self.assertRaises(EvidencePumpError) as caught:
            pump_evidence(
                stdout_fd,
                stderr_fd,
                **(self.pump_kwargs() | {"stop_callback": None}),
            )
        self.assertIsNone(caught.exception.receipt)
        self.assertEqual(list(self.raw_directory.iterdir()), [])

    def test_directory_symlink_mode_and_simulated_owner_fail_closed(self):
        stdout_fd, stderr_fd = self.eof_pipes()
        symlink = Path(self.temp.name) / "raw-link"
        symlink.symlink_to(self.raw_directory, target_is_directory=True)
        calls = []
        with self.assertRaises(EvidencePumpError):
            pump_evidence(
                stdout_fd,
                stderr_fd,
                **(
                    self.pump_kwargs(self.attempt(1))
                    | {
                        "raw_directory": symlink,
                        "stop_callback": lambda: calls.append("symlink"),
                    }
                ),
            )
        self.raw_directory.chmod(0o770)
        try:
            with self.assertRaises(EvidencePumpError):
                pump_evidence(
                    stdout_fd,
                    stderr_fd,
                    **(
                        self.pump_kwargs(self.attempt(2))
                        | {"stop_callback": lambda: calls.append("mode")}
                    ),
                )
        finally:
            self.raw_directory.chmod(0o700)
        with mock.patch(
            "gauntlet.evidence_pump.os.geteuid", return_value=os.geteuid() + 1
        ):
            with self.assertRaises(EvidencePumpError):
                pump_evidence(
                    stdout_fd,
                    stderr_fd,
                    **(
                        self.pump_kwargs(self.attempt(3))
                        | {"stop_callback": lambda: calls.append("owner")}
                    ),
                )
        self.assertEqual(calls, ["symlink", "mode", "owner"])

    def test_unknown_preexisting_entry_is_preserved_and_consumes_attempt(self):
        stdout_fd, stderr_fd = self.eof_pipes()
        target = self.raw_directory / f"{ATTEMPT_ID}.unknown"
        target.write_bytes(b"preserve-me")
        target.chmod(0o400)
        calls = []
        with self.assertRaises(EvidencePumpError) as caught:
            pump_evidence(
                stdout_fd,
                stderr_fd,
                **(self.pump_kwargs() | {"stop_callback": lambda: calls.append(True)}),
            )
        self.assertEqual(calls, [True])
        self.assertEqual(target.read_bytes(), b"preserve-me")
        receipt = caught.exception.receipt
        self.assertTrue(receipt.recovered_residue)
        self.assertFalse(receipt.capture_started)
        self.assertIsNone(receipt.attempt_id)
        self.assertIsNone(receipt.generation)
        self.assertIsNone(receipt.evidence_sha256)
        self.assertEqual(receipt.evidence_bytes, 0)
        tombstones = list(self.raw_directory.glob(f"{ATTEMPT_ID}.*.TOMBSTONE"))
        self.assertEqual(len(tombstones), 1)
        self.assertEqual(stat.S_IMODE(tombstones[0].stat().st_mode), 0o400)
        self.assertEqual(
            json.loads(tombstones[0].read_text("ascii"))["attempt_id"],
            ATTEMPT_ID,
        )

    def test_total_directory_entry_bound_rejects_unrelated_flood_before_reservation(self):
        unrelated = []
        for index in range(30):
            path = self.raw_directory / f"unrelated-{index:02d}"
            path.write_bytes(b"preserve")
            unrelated.append(path)
        stdout_fd, stderr_fd = self.eof_pipes()
        calls = []
        with self.assertRaises(EvidencePumpError) as caught:
            pump_evidence(
                stdout_fd,
                stderr_fd,
                **(self.pump_kwargs() | {"stop_callback": lambda: calls.append(True)}),
            )
        self.assertEqual(calls, [True])
        receipt = caught.exception.receipt
        self.assertFalse(receipt.capture_started)
        self.assertIsNone(receipt.attempt_id)
        self.assertIsNone(receipt.generation)
        self.assertIsNone(receipt.evidence_sha256)
        self.assertEqual(receipt.evidence_bytes, 0)
        self.assertEqual(list(self.raw_directory.glob(f"{ATTEMPT_ID}.*")), [])
        self.assertTrue(all(path.read_bytes() == b"preserve" for path in unrelated))

    def test_twenty_nine_unrelated_entries_allow_bounded_failure_tombstone(self):
        for index in range(29):
            (self.raw_directory / f"unrelated-{index:02d}").write_bytes(b"preserve")
        stdout_fd, stderr_fd = self.eof_pipes()
        calls = []
        with mock.patch(
            "gauntlet.evidence_pump._authenticate_evidence",
            side_effect=EvidencePumpError("injected authentication failure"),
        ):
            with self.assertRaises(EvidencePumpError) as caught:
                pump_evidence(
                    stdout_fd,
                    stderr_fd,
                    **(
                        self.pump_kwargs()
                        | {"stop_callback": lambda: calls.append(True)}
                    ),
                )
        self.assertEqual(calls, [True])
        self.assertTrue(caught.exception.receipt.capture_started)
        self.assertTrue(caught.exception.receipt.recovery_required)
        self.assertEqual(len(list(self.raw_directory.iterdir())), 32)
        self.assertEqual(len(list(self.raw_directory.glob(f"{ATTEMPT_ID}.*"))), 3)
        self.assertEqual(
            len(list(self.raw_directory.glob(f"{ATTEMPT_ID}.*.TOMBSTONE"))),
            1,
        )

    def test_tombstone_reservation_never_crosses_total_directory_bound(self):
        for index in range(30):
            (self.raw_directory / f"unrelated-{index:02d}").write_bytes(b"preserve")
        directory = evidence_pump_module._open_owned_directory(self.raw_directory)
        lock = evidence_pump_module._open_attempt_lock(directory, ATTEMPT_ID)
        evidence = self.raw_directory / f"{ATTEMPT_ID}.{'f' * 32}.evidence"
        evidence.write_bytes(b"")
        evidence.chmod(0o600)
        try:
            self.assertEqual(len(list(self.raw_directory.iterdir())), 32)
            self.assertFalse(
                evidence_pump_module._append_tombstone(
                    directory,
                    ATTEMPT_ID,
                    lock,
                    "PUBLICATION_FAILED",
                )
            )
            self.assertEqual(len(list(self.raw_directory.iterdir())), 32)
            self.assertEqual(
                list(self.raw_directory.glob(f"{ATTEMPT_ID}.*.TOMBSTONE")),
                [],
            )
        finally:
            os.close(lock.fd)
            os.close(directory.fd)

    def test_exact_name_symlink_fifo_and_hardlink_residue_are_never_followed(self):
        victim = Path(self.temp.name) / "victim"
        victim.write_bytes(b"victim")
        victim.chmod(0o400)
        for number, kind in enumerate(("symlink", "fifo", "hardlink"), 30):
            attempt_id = self.attempt(number)
            generation = f"{number:032x}"
            path = self.raw_directory / f"{attempt_id}.{generation}.evidence"
            if kind == "symlink":
                path.symlink_to(victim)
            elif kind == "fifo":
                os.mkfifo(path, 0o400)
            else:
                os.link(victim, path)
            stdout_fd, stderr_fd = self.eof_pipes()
            calls = []
            with self.subTest(kind=kind):
                with self.assertRaises(EvidencePumpError):
                    pump_evidence(
                        stdout_fd,
                        stderr_fd,
                        **(
                            self.pump_kwargs(attempt_id)
                            | {"stop_callback": lambda: calls.append(True)}
                        ),
                    )
                self.assertEqual(calls, [True])
                self.assertTrue(path.exists() or path.is_symlink())
                self.assertEqual(victim.read_bytes(), b"victim")

    def test_committed_attempt_is_single_use_and_never_overwritten(self):
        stdout_fd, stderr_fd, _, _ = self.pipes(b"first-stdout", b"first-stderr")
        first = pump_evidence(stdout_fd, stderr_fd, **self.pump_kwargs())
        self.assertTrue(first.raw_evidence_committed)
        path = self.evidence_path()
        before = path.read_bytes()
        identity = (path.stat().st_dev, path.stat().st_ino)
        retry_stdout, retry_stderr = self.eof_pipes()
        calls = []
        with self.assertRaises(EvidencePumpError) as caught:
            pump_evidence(
                retry_stdout,
                retry_stderr,
                **(self.pump_kwargs() | {"stop_callback": lambda: calls.append(True)}),
            )
        self.assertEqual(calls, [True])
        self.assertFalse(caught.exception.receipt.capture_started)
        self.assertTrue(caught.exception.receipt.recovered_residue)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual((path.stat().st_dev, path.stat().st_ino), identity)
        self.assertEqual(len(list(self.raw_directory.glob(f"{ATTEMPT_ID}.*.evidence"))), 1)

    def test_concurrent_calls_cannot_share_attempt_ownership(self):
        first_out, first_err, first_out_write, first_err_write = self.pipes(
            close_writers=False
        )
        outcome = {}

        def first_call():
            try:
                outcome["receipt"] = pump_evidence(
                    first_out,
                    first_err,
                    **(self.pump_kwargs() | {"timeout_seconds": 2}),
                )
            except BaseException as exc:
                outcome["error"] = exc

        thread = threading.Thread(target=first_call)
        thread.start()
        deadline = time.monotonic() + 1
        while not list(self.raw_directory.glob(f"{ATTEMPT_ID}.*.evidence")):
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.005)
        second_out, second_err = self.eof_pipes()
        calls = []
        with self.assertRaises(EvidencePumpError) as caught:
            pump_evidence(
                second_out,
                second_err,
                **(self.pump_kwargs() | {"stop_callback": lambda: calls.append(True)}),
            )
        self.assertEqual(calls, [True])
        self.assertFalse(caught.exception.receipt.capture_started)
        _close(first_out_write)
        _close(first_err_write)
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertNotIn("error", outcome)
        self.assertTrue(outcome["receipt"].raw_evidence_committed)

    def test_raw_directory_is_exclusive_across_different_active_attempts(self):
        first_attempt = self.attempt(37)
        second_attempt = self.attempt(38)
        first_out, first_err, first_out_write, first_err_write = self.pipes(
            close_writers=False
        )
        outcome = {}

        def first_call():
            try:
                outcome["receipt"] = pump_evidence(
                    first_out,
                    first_err,
                    **(
                        self.pump_kwargs(first_attempt)
                        | {"timeout_seconds": 2}
                    ),
                )
            except BaseException as exc:
                outcome["error"] = exc

        thread = threading.Thread(target=first_call)
        thread.start()
        deadline = time.monotonic() + 1
        while not list(self.raw_directory.glob(f"{first_attempt}.*.evidence")):
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.005)

        second_out, second_err = self.eof_pipes()
        calls = []
        with self.assertRaises(EvidencePumpError) as caught:
            pump_evidence(
                second_out,
                second_err,
                **(
                    self.pump_kwargs(second_attempt)
                    | {"stop_callback": lambda: calls.append(True)}
                ),
            )
        self.assertEqual(calls, [True])
        self.assertFalse(caught.exception.receipt.capture_started)
        self.assertEqual(list(self.raw_directory.glob(f"{second_attempt}.*")), [])

        _close(first_out_write)
        _close(first_err_write)
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertNotIn("error", outcome)
        self.assertTrue(outcome["receipt"].raw_evidence_committed)

    def test_lock_symlink_and_active_holder_each_fail_without_blocking(self):
        victim = Path(self.temp.name) / "lock-victim"
        victim.write_bytes(b"")
        victim.chmod(0o400)
        symlink_attempt = self.attempt(40)
        (self.raw_directory / f"{symlink_attempt}.controller.lock").symlink_to(victim)
        stdout_fd, stderr_fd = self.eof_pipes()
        calls = []
        with self.assertRaises(EvidencePumpError):
            pump_evidence(
                stdout_fd,
                stderr_fd,
                **(
                    self.pump_kwargs(symlink_attempt)
                    | {"stop_callback": lambda: calls.append("symlink")}
                ),
            )

        held_attempt = self.attempt(41)
        held_path = self.raw_directory / f"{held_attempt}.controller.lock"
        held_path.write_bytes(b"")
        held_path.chmod(0o400)
        held_fd = os.open(held_path, os.O_RDONLY)
        self.addCleanup(_close, held_fd)
        fcntl.flock(held_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stdout_fd, stderr_fd = self.eof_pipes()
        with self.assertRaises(EvidencePumpError):
            pump_evidence(
                stdout_fd,
                stderr_fd,
                **(
                    self.pump_kwargs(held_attempt)
                    | {"stop_callback": lambda: calls.append("held")}
                ),
            )
        self.assertEqual(calls, ["symlink", "held"])

    def test_competing_first_object_reservation_is_preserved_and_consumes_attempt(self):
        stdout_fd, stderr_fd = self.eof_pipes()
        calls = []
        real_open = os.open
        competitor = b"concurrently-reserved"
        competing_names = []

        def race_object(path, flags, mode=0o777, *, dir_fd=None):
            if (
                isinstance(path, str)
                and path.endswith(".evidence")
                and flags & os.O_EXCL
                and not competing_names
            ):
                competing_names.append(path)
                fd = real_open(
                    path,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o600,
                    dir_fd=dir_fd,
                )
                try:
                    os.write(fd, competitor)
                    os.fchmod(fd, 0o600)
                finally:
                    os.close(fd)
            return real_open(path, flags, mode, dir_fd=dir_fd)

        with mock.patch("gauntlet.evidence_pump.os.open", side_effect=race_object):
            with self.assertRaises(EvidencePumpError) as caught:
                pump_evidence(
                    stdout_fd,
                    stderr_fd,
                    **(
                        self.pump_kwargs()
                        | {"stop_callback": lambda: calls.append(True)}
                    ),
                )
        self.assertEqual(calls, [True])
        self.assertFalse(caught.exception.receipt.capture_started)
        self.assertEqual(caught.exception.receipt.attempt_id, ATTEMPT_ID)
        self.assertRegex(caught.exception.receipt.generation, r"[0-9a-f]{32}\Z")
        self.assertIsNone(caught.exception.receipt.evidence_sha256)
        self.assertEqual(caught.exception.receipt.evidence_bytes, 0)
        competitor_path = self.raw_directory / competing_names[0]
        self.assertEqual(competitor_path.read_bytes(), competitor)
        retry_out, retry_err = self.eof_pipes()
        with self.assertRaises(EvidencePumpError):
            pump_evidence(retry_out, retry_err, **self.pump_kwargs())
        self.assertEqual(competitor_path.read_bytes(), competitor)

    def test_first_object_open_failure_stops_once_and_durably_consumes_attempt(self):
        stdout_fd, stderr_fd = self.eof_pipes()
        calls = []
        real_open = os.open

        def fail_evidence(path, flags, mode=0o777, *, dir_fd=None):
            if (
                isinstance(path, str)
                and path.endswith(".evidence")
                and flags & os.O_EXCL
            ):
                raise OSError(errno.ENOSPC, "injected reservation failure")
            return real_open(path, flags, mode, dir_fd=dir_fd)

        with mock.patch("gauntlet.evidence_pump.os.open", side_effect=fail_evidence):
            with self.assertRaises(EvidencePumpError) as caught:
                pump_evidence(
                    stdout_fd,
                    stderr_fd,
                    **(
                        self.pump_kwargs()
                        | {"stop_callback": lambda: calls.append(True)}
                    ),
                )
        self.assertEqual(calls, [True])
        self.assertFalse(caught.exception.receipt.capture_started)
        self.assertEqual(caught.exception.receipt.attempt_id, ATTEMPT_ID)
        self.assertRegex(caught.exception.receipt.generation, r"[0-9a-f]{32}\Z")
        self.assertIsNone(caught.exception.receipt.evidence_sha256)
        self.assertEqual(caught.exception.receipt.evidence_bytes, 0)
        self.assertTrue(caught.exception.receipt.recovery_required)
        self.assertEqual(list(self.raw_directory.glob(f"{ATTEMPT_ID}.*.evidence")), [])
        tombstones = list(self.raw_directory.glob(f"{ATTEMPT_ID}.*.TOMBSTONE"))
        self.assertEqual(len(tombstones), 1)
        self.assertEqual(stat.S_IMODE(tombstones[0].stat().st_mode), 0o400)

    def test_generation_failure_after_lock_requests_stop_and_returns_unbound_receipt(self):
        cases = (
            RuntimeError("entropy failure"),
            "not-a-generation",
        )
        for index, first_result in enumerate(cases, 48):
            attempt_id = self.attempt(index)
            stdout_fd, stderr_fd = self.eof_pipes()
            calls = []
            with self.subTest(first_result=repr(first_result)), mock.patch(
                "gauntlet.evidence_pump.secrets.token_hex",
                side_effect=(first_result, f"{index:032x}"),
            ):
                with self.assertRaises(EvidencePumpError) as caught:
                    pump_evidence(
                        stdout_fd,
                        stderr_fd,
                        **(
                            self.pump_kwargs(attempt_id)
                            | {"stop_callback": lambda: calls.append(True)}
                        ),
                    )
            self.assertEqual(calls, [True])
            receipt = caught.exception.receipt
            self.assertIsNotNone(receipt)
            self.assertFalse(receipt.capture_started)
            self.assertIsNone(receipt.attempt_id)
            self.assertIsNone(receipt.generation)
            self.assertIsNone(receipt.evidence_sha256)
            self.assertEqual(receipt.evidence_bytes, 0)
            self.assertTrue(receipt.stop_callback_completed)
            self.assertTrue(receipt.recovery_required)
            self.assertEqual(
                len(list(self.raw_directory.glob(f"{attempt_id}.controller.lock"))),
                1,
            )
            self.assertEqual(
                len(list(self.raw_directory.glob(f"{attempt_id}.*.TOMBSTONE"))),
                1,
            )
            self.assertEqual(
                list(self.raw_directory.glob(f"{attempt_id}.*.evidence")),
                [],
            )

    def test_generation_and_tombstone_entropy_failures_still_return_one_stop_receipt(self):
        stdout_fd, stderr_fd = self.eof_pipes()
        calls = []
        with mock.patch(
            "gauntlet.evidence_pump.secrets.token_hex",
            side_effect=(RuntimeError("generation entropy"), RuntimeError("marker entropy")),
        ):
            with self.assertRaises(EvidencePumpError) as caught:
                pump_evidence(
                    stdout_fd,
                    stderr_fd,
                    **(
                        self.pump_kwargs()
                        | {"stop_callback": lambda: calls.append(True)}
                    ),
                )
        self.assertEqual(calls, [True])
        receipt = caught.exception.receipt
        self.assertIsNotNone(receipt)
        self.assertFalse(receipt.capture_started)
        self.assertIsNone(receipt.attempt_id)
        self.assertIsNone(receipt.generation)
        self.assertTrue(receipt.stop_callback_completed)
        self.assertTrue(receipt.recovery_required)
        self.assertEqual(
            list(self.raw_directory.glob(f"{ATTEMPT_ID}.*.TOMBSTONE")),
            [],
        )

    def test_forced_crash_leaves_partial_object_and_requires_a_fresh_attempt(self):
        crashed_attempt = self.attempt(50)
        source = inspect.cleandoc(
            f"""
            import os
            import gauntlet.evidence_pump as module
            raw_directory = {str(self.raw_directory)!r}
            attempt_id = {crashed_attempt!r}
            stdout_read, stdout_write = os.pipe()
            stderr_read, stderr_write = os.pipe()
            os.write(stdout_write, b'partial-frame')
            os.close(stdout_write)
            os.close(stderr_write)
            original = module._EvidenceWriter._write_frame
            def crashing_write(self, kind, payload):
                original(self, kind, payload)
                if kind == b'O':
                    os._exit(91)
            module._EvidenceWriter._write_frame = crashing_write
            module.pump_evidence(
                stdout_read,
                stderr_read,
                raw_directory=raw_directory,
                attempt_id=attempt_id,
                retained_byte_cap=1024,
                observed_byte_cap=4096,
                timeout_seconds=1,
                drain_timeout_seconds=0.1,
                stop_callback_timeout_seconds=0.1,
                stop_callback=lambda: None,
            )
            """
        )
        child = subprocess.run(
            [sys.executable, "-c", source],
            cwd=Path(__file__).resolve().parents[1],
            env={**os.environ, "PYTHONPATH": "."},
            timeout=3,
            check=False,
        )
        self.assertEqual(child.returncode, 91)
        partial = self.evidence_path(crashed_attempt)
        before = partial.read_bytes()
        with self.assertRaises(EvidencePumpError):
            evidence_pump_module._parse_evidence_object(before)
        stdout_fd, stderr_fd = self.eof_pipes()
        calls = []
        with self.assertRaises(EvidencePumpError) as caught:
            pump_evidence(
                stdout_fd,
                stderr_fd,
                **(
                    self.pump_kwargs(crashed_attempt)
                    | {"stop_callback": lambda: calls.append(True)}
                ),
            )
        self.assertEqual(calls, [True])
        self.assertFalse(caught.exception.receipt.capture_started)
        self.assertTrue(caught.exception.receipt.recovered_residue)
        self.assertEqual(partial.read_bytes(), before)

        fresh_attempt = self.attempt(51)
        fresh_out, fresh_err = self.eof_pipes()
        receipt = pump_evidence(fresh_out, fresh_err, **self.pump_kwargs(fresh_attempt))
        self.assertTrue(receipt.raw_evidence_committed)

    def test_sparse_oversize_residue_is_bounded_preserved_and_consumes_attempt(self):
        generation = "1" * 32
        path = self.raw_directory / f"{ATTEMPT_ID}.{generation}.evidence"
        with path.open("wb") as handle:
            handle.truncate(evidence_pump_module._MAX_OBJECT_BYTES + 1)
        path.chmod(0o400)
        size = path.stat().st_size
        stdout_fd, stderr_fd = self.eof_pipes()
        calls = []
        with self.assertRaises(EvidencePumpError) as caught:
            pump_evidence(
                stdout_fd,
                stderr_fd,
                **(self.pump_kwargs() | {"stop_callback": lambda: calls.append(True)}),
            )
        self.assertEqual(calls, [True])
        self.assertTrue(caught.exception.receipt.recovered_residue)
        self.assertEqual(path.stat().st_size, size)

    def test_no_writable_evidence_handle_survives_into_authentication(self):
        stdout_fd, stderr_fd, _, _ = self.pipes(b"out", b"err")
        original = evidence_pump_module._authenticate_evidence
        snapshots = []

        def inspect_handles(*args, **kwargs):
            writable = []
            for entry in Path("/proc/self/fd").iterdir():
                try:
                    target = os.readlink(entry)
                    fd = int(entry.name)
                    if target.endswith(".evidence"):
                        access = fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE
                        if access != os.O_RDONLY:
                            writable.append((fd, target, access))
                except (FileNotFoundError, OSError, ValueError):
                    pass
            snapshots.append(writable)
            return original(*args, **kwargs)

        with mock.patch(
            "gauntlet.evidence_pump._authenticate_evidence",
            side_effect=inspect_handles,
        ):
            receipt = pump_evidence(stdout_fd, stderr_fd, **self.pump_kwargs())
        self.assertTrue(receipt.raw_evidence_committed)
        self.assertEqual(snapshots, [[]])
        self.assertEqual(stat.S_IMODE(self.evidence_path().stat().st_mode), 0o600)

    def test_same_inode_same_size_mutation_between_complete_object_reads_is_rejected(self):
        stdout_fd, stderr_fd, _, _ = self.pipes(b"coherent-stdout", b"coherent-stderr")
        real_pread = os.pread
        mutated = False
        calls = []

        def mutate_after_first_read(fd, count, offset):
            nonlocal mutated
            chunk = real_pread(fd, count, offset)
            target = os.readlink(f"/proc/self/fd/{fd}")
            if chunk and not mutated and target.endswith(".evidence") and offset == 0:
                mutated = True
                writer = os.open(target, os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0))
                try:
                    os.pwrite(writer, b"X", len(evidence_pump_module._MAGIC))
                    os.fsync(writer)
                finally:
                    os.close(writer)
            return chunk

        with mock.patch("gauntlet.evidence_pump.os.pread", side_effect=mutate_after_first_read):
            with self.assertRaises(EvidencePumpError) as caught:
                pump_evidence(
                    stdout_fd,
                    stderr_fd,
                    **(
                        self.pump_kwargs()
                        | {"stop_callback": lambda: calls.append(True)}
                    ),
                )
        self.assertTrue(mutated)
        self.assertEqual(calls, [True])
        self.assertFalse(caught.exception.receipt.raw_evidence_committed)
        self.assertFalse(caught.exception.receipt.raw_evidence_quarantined)
        self.assertTrue(caught.exception.receipt.recovery_required)

    def test_same_object_mutation_after_named_snapshot_is_rejected_by_final_fstat(self):
        stdout_fd, stderr_fd, _, _ = self.pipes(b"late-stdout", b"late-stderr")
        real_stat = os.stat
        sealed_stats = 0
        mutated = False
        calls = []

        def mutate_after_named_stat(path, *args, **kwargs):
            nonlocal sealed_stats, mutated
            result = real_stat(path, *args, **kwargs)
            if isinstance(path, str) and path.endswith(".evidence"):
                if stat.S_IMODE(result.st_mode) == 0o600:
                    sealed_stats += 1
                    if sealed_stats == 2 and not mutated:
                        mutated = True
                        target = self.raw_directory / path
                        writer = os.open(target, os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0))
                        try:
                            os.pwrite(writer, b"Y", len(evidence_pump_module._MAGIC))
                            os.fsync(writer)
                        finally:
                            os.close(writer)
            return result

        with mock.patch("gauntlet.evidence_pump.os.stat", side_effect=mutate_after_named_stat):
            with self.assertRaises(EvidencePumpError) as caught:
                pump_evidence(
                    stdout_fd,
                    stderr_fd,
                    **(
                        self.pump_kwargs()
                        | {"stop_callback": lambda: calls.append(True)}
                    ),
                )
        self.assertTrue(mutated)
        self.assertEqual(calls, [True])
        self.assertFalse(caught.exception.receipt.raw_evidence_committed)

    def test_callback_cannot_rebind_the_authenticated_header_budgets(self):
        stdout_fd, stderr_fd, _, _ = self.pipes(b"overflow", b"err")
        calls = []
        mutations = []

        def mutate_header():
            calls.append(True)
            path = self.evidence_path()
            raw = path.read_bytes()
            needle = b'"retained_byte_cap":1'
            self.assertIn(needle, raw)
            offset = raw.index(needle) + len(needle) - 1
            writer = os.open(path, os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0))
            try:
                os.pwrite(writer, b"2", offset)
                os.fsync(writer)
                mutations.append(True)
            finally:
                os.close(writer)

        with self.assertRaises(EvidencePumpError) as caught:
            pump_evidence(
                stdout_fd,
                stderr_fd,
                **(
                    self.pump_kwargs()
                    | {"retained_byte_cap": 1, "stop_callback": mutate_header}
                ),
            )
        self.assertEqual(calls, [True])
        self.assertEqual(mutations, [True])
        self.assertTrue(caught.exception.receipt.stop_callback_completed)
        self.assertFalse(caught.exception.receipt.stop_callback_failed)
        self.assertFalse(caught.exception.receipt.raw_evidence_committed)
        self.assertTrue(caught.exception.receipt.recovery_required)

    def test_name_swap_during_object_authentication_is_rejected_and_never_deleted(self):
        stdout_fd, stderr_fd, _, _ = self.pipes(b"swap-out", b"swap-err")
        real_pread = os.pread
        swapped = False
        calls = []
        saved = self.raw_directory / "saved-original"
        replacement_bytes = b"replacement-victim"

        def swap_name(fd, count, offset):
            nonlocal swapped
            chunk = real_pread(fd, count, offset)
            target = Path(os.readlink(f"/proc/self/fd/{fd}"))
            if chunk and not swapped and target.name.endswith(".evidence"):
                swapped = True
                os.replace(target, saved)
                target.write_bytes(replacement_bytes)
                target.chmod(0o600)
            return chunk

        with mock.patch("gauntlet.evidence_pump.os.pread", side_effect=swap_name):
            with self.assertRaises(EvidencePumpError) as caught:
                pump_evidence(
                    stdout_fd,
                    stderr_fd,
                    **(
                        self.pump_kwargs()
                        | {"stop_callback": lambda: calls.append(True)}
                    ),
                )
        self.assertTrue(swapped)
        self.assertEqual(calls, [True])
        self.assertFalse(caught.exception.receipt.raw_evidence_committed)
        self.assertTrue(saved.exists())
        self.assertEqual(self.evidence_path().read_bytes(), replacement_bytes)

    def test_unknown_entry_injected_by_stop_callback_blocks_publication(self):
        stdout_fd, stderr_fd, _, _ = self.pipes(b"overflow-output", b"err")
        injected = self.raw_directory / f"{ATTEMPT_ID}.late-unknown"
        calls = []

        def inject_unknown():
            calls.append(True)
            injected.write_bytes(b"late")
            injected.chmod(0o400)

        with self.assertRaises(EvidencePumpError) as caught:
            pump_evidence(
                stdout_fd,
                stderr_fd,
                **(
                    self.pump_kwargs()
                    | {"retained_byte_cap": 2, "stop_callback": inject_unknown}
                ),
            )
        self.assertEqual(calls, [True])
        self.assertTrue(injected.exists())
        self.assertFalse(caught.exception.receipt.raw_evidence_committed)
        self.assertFalse(caught.exception.receipt.raw_evidence_quarantined)
        self.assertTrue(caught.exception.receipt.recovery_required)

    def test_unknown_entry_injected_during_stable_object_read_blocks_commit(self):
        stdout_fd, stderr_fd, _, _ = self.pipes(b"stdout", b"stderr")
        injected = self.raw_directory / f"{ATTEMPT_ID}.late-read-window"
        real_pread = os.pread
        injected_once = False
        calls = []

        def inject_during_read(fd, count, offset):
            nonlocal injected_once
            chunk = real_pread(fd, count, offset)
            target = os.readlink(f"/proc/self/fd/{fd}")
            if chunk and not injected_once and target.endswith(".evidence"):
                injected_once = True
                injected.write_bytes(b"late")
                injected.chmod(0o400)
            return chunk

        with mock.patch("gauntlet.evidence_pump.os.pread", side_effect=inject_during_read):
            with self.assertRaises(EvidencePumpError) as caught:
                pump_evidence(
                    stdout_fd,
                    stderr_fd,
                    **(
                        self.pump_kwargs()
                        | {"stop_callback": lambda: calls.append(True)}
                    ),
                )
        self.assertTrue(injected_once)
        self.assertEqual(calls, [True])
        self.assertFalse(caught.exception.receipt.raw_evidence_committed)
        self.assertTrue(caught.exception.receipt.recovery_required)

    def test_raw_directory_replaced_during_named_object_stat_cannot_commit(self):
        stdout_fd, stderr_fd, _, _ = self.pipes(b"stdout", b"stderr")
        moved = Path(self.temp.name) / "late-moved-raw"
        real_stat = os.stat
        replaced = False
        calls = []

        def replace_during_named_stat(path, *args, **kwargs):
            nonlocal replaced
            result = real_stat(path, *args, **kwargs)
            if (
                isinstance(path, str)
                and path.endswith(".evidence")
                and stat.S_IMODE(result.st_mode) == 0o600
                and not replaced
            ):
                replaced = True
                self.raw_directory.rename(moved)
                self.raw_directory.mkdir(mode=0o700)
            return result

        with mock.patch(
            "gauntlet.evidence_pump.os.stat", side_effect=replace_during_named_stat
        ):
            with self.assertRaises(EvidencePumpError) as caught:
                pump_evidence(
                    stdout_fd,
                    stderr_fd,
                    **(
                        self.pump_kwargs()
                        | {"stop_callback": lambda: calls.append(True)}
                    ),
                )
        self.assertTrue(replaced)
        self.assertEqual(calls, [True])
        self.assertFalse(caught.exception.receipt.raw_evidence_committed)
        self.assertTrue(caught.exception.receipt.recovery_required)
        self.assertEqual(list(self.raw_directory.iterdir()), [])
        self.assertEqual(len(list(moved.glob(f"{ATTEMPT_ID}.*.evidence"))), 1)

    def test_namespace_mutation_at_final_evidence_fingerprint_is_rejected(self):
        stdout_fd, stderr_fd, _, _ = self.pipes(b"stdout", b"stderr")
        injected = self.raw_directory / f"{ATTEMPT_ID}.fingerprint-window"
        real_stat = os.stat
        sealed_stats = 0
        injected_once = False
        calls = []

        def inject_after_final_evidence_stat(path, *args, **kwargs):
            nonlocal sealed_stats, injected_once
            result = real_stat(path, *args, **kwargs)
            if (
                isinstance(path, str)
                and path.endswith(".evidence")
                and stat.S_IMODE(result.st_mode) == 0o600
            ):
                sealed_stats += 1
                if sealed_stats == 3 and not injected_once:
                    injected_once = True
                    injected.write_bytes(b"late")
                    injected.chmod(0o400)
            return result

        with mock.patch(
            "gauntlet.evidence_pump.os.stat",
            side_effect=inject_after_final_evidence_stat,
        ):
            with self.assertRaises(EvidencePumpError) as caught:
                pump_evidence(
                    stdout_fd,
                    stderr_fd,
                    **(
                        self.pump_kwargs()
                        | {"stop_callback": lambda: calls.append(True)}
                    ),
                )
        self.assertTrue(injected_once)
        self.assertEqual(calls, [True])
        self.assertFalse(caught.exception.receipt.raw_evidence_committed)

    def test_lock_metadata_mutation_before_final_evidence_fingerprint_is_rejected(self):
        stdout_fd, stderr_fd, _, _ = self.pipes(b"stdout", b"stderr")
        lock_path = self.raw_directory / f"{ATTEMPT_ID}.controller.lock"
        real_stat = os.stat
        evidence_stats = 0
        mutated = False
        calls = []

        def mutate_lock_before_final_evidence_stat(path, *args, **kwargs):
            nonlocal evidence_stats, mutated
            if isinstance(path, str) and path.endswith(".evidence"):
                evidence_stats += 1
                if evidence_stats == 4 and not mutated:
                    lock_path.chmod(0o600)
                    lock_path.chmod(0o400)
                    mutated = True
            return real_stat(path, *args, **kwargs)

        with mock.patch(
            "gauntlet.evidence_pump.os.stat",
            side_effect=mutate_lock_before_final_evidence_stat,
        ):
            with self.assertRaises(EvidencePumpError) as caught:
                pump_evidence(
                    stdout_fd,
                    stderr_fd,
                    **(
                        self.pump_kwargs()
                        | {"stop_callback": lambda: calls.append(True)}
                    ),
                )
        self.assertTrue(mutated)
        self.assertEqual(calls, [True])
        self.assertFalse(caught.exception.receipt.raw_evidence_committed)
        self.assertTrue(caught.exception.receipt.recovery_required)

    def test_directory_and_lock_replacement_fail_closed_without_deleting_replacements(self):
        for number, replace_kind in ((60, "directory"), (61, "lock")):
            with self.subTest(replace_kind=replace_kind):
                attempt_id = self.attempt(number)
                stdout_fd, stderr_fd, _, _ = self.pipes(b"overflow", b"err")
                calls = []
                moved = Path(self.temp.name) / f"moved-{number}"

                def replace():
                    calls.append(True)
                    if replace_kind == "directory":
                        self.raw_directory.rename(moved)
                        self.raw_directory.mkdir(mode=0o700)
                    else:
                        lock = self.raw_directory / f"{attempt_id}.controller.lock"
                        saved = self.raw_directory / f"saved-lock-{number}"
                        lock.rename(saved)
                        lock.write_bytes(b"")
                        lock.chmod(0o400)

                with self.assertRaises(EvidencePumpError) as caught:
                    pump_evidence(
                        stdout_fd,
                        stderr_fd,
                        **(
                            self.pump_kwargs(attempt_id)
                            | {
                                "retained_byte_cap": 1,
                                "stop_callback": replace,
                            }
                        ),
                    )
                self.assertEqual(calls, [True])
                self.assertFalse(caught.exception.receipt.raw_evidence_committed)
                if replace_kind == "directory":
                    self.assertTrue(moved.exists())
                else:
                    self.assertTrue(
                        (self.raw_directory / f"saved-lock-{number}").exists()
                    )

    def test_post_open_capture_failures_publish_only_authenticated_quarantine(self):
        failure_factories = {
            "selector": lambda: mock.patch(
                "gauntlet.evidence_pump.selectors.DefaultSelector",
                side_effect=OSError(errno.EMFILE, "selector failure"),
            ),
            "register": lambda: mock.patch(
                "gauntlet.evidence_pump.selectors.DefaultSelector",
                return_value=mock.Mock(
                    spec=selectors.BaseSelector,
                    register=mock.Mock(side_effect=OSError(errno.EIO, "register failure")),
                    close=mock.Mock(),
                ),
            ),
            "read": lambda: mock.patch(
                "gauntlet.evidence_pump.os.read",
                side_effect=OSError(errno.EIO, "read failure"),
            ),
        }
        for index, (label, make_patch) in enumerate(failure_factories.items(), 70):
            stdout_fd, stderr_fd = self.eof_pipes()
            attempt_id = self.attempt(index)
            calls = []
            with self.subTest(label=label), make_patch():
                with self.assertRaises(EvidencePumpError) as caught:
                    pump_evidence(
                        stdout_fd,
                        stderr_fd,
                        **(
                            self.pump_kwargs(attempt_id)
                            | {"stop_callback": lambda: calls.append(True)}
                        ),
                    )
            self.assertEqual(calls, [True])
            receipt = caught.exception.receipt
            self.assertTrue(receipt.capture_started)
            self.assertTrue(receipt.raw_evidence_quarantined)
            self.assertTrue(receipt.recovery_required)
            self.assertEqual(self.parsed_evidence(attempt_id)[1].state, "QUARANTINED")

    def test_write_fsync_and_readback_failures_never_return_false_publication(self):
        for index, label in enumerate(("write", "fsync", "pread"), 80):
            stdout_fd, stderr_fd, _, _ = self.pipes(b"stdout", b"stderr")
            attempt_id = self.attempt(index)
            calls = []
            failed = False
            if label == "write":
                real = os.write

                def injected(fd, raw):
                    nonlocal failed
                    target = os.readlink(f"/proc/self/fd/{fd}")
                    if target.endswith(".evidence") and raw.startswith(b"O") and not failed:
                        failed = True
                        raise OSError(errno.ENOSPC, "write failure")
                    return real(fd, raw)

                patcher = mock.patch("gauntlet.evidence_pump.os.write", side_effect=injected)
            elif label == "fsync":
                real = os.fsync
                evidence_calls = 0

                def injected(fd):
                    nonlocal failed, evidence_calls
                    target = os.readlink(f"/proc/self/fd/{fd}")
                    if target.endswith(".evidence"):
                        evidence_calls += 1
                        if evidence_calls == 2 and not failed:
                            failed = True
                            raise OSError(errno.EIO, "fsync failure")
                    return real(fd)

                patcher = mock.patch("gauntlet.evidence_pump.os.fsync", side_effect=injected)
            else:
                real = os.pread

                def injected(fd, count, offset):
                    nonlocal failed
                    target = os.readlink(f"/proc/self/fd/{fd}")
                    if target.endswith(".evidence") and not failed:
                        failed = True
                        raise OSError(errno.EIO, "pread failure")
                    return real(fd, count, offset)

                patcher = mock.patch("gauntlet.evidence_pump.os.pread", side_effect=injected)
            with self.subTest(label=label), patcher:
                with self.assertRaises(EvidencePumpError) as caught:
                    pump_evidence(
                        stdout_fd,
                        stderr_fd,
                        **(
                            self.pump_kwargs(attempt_id)
                            | {"stop_callback": lambda: calls.append(True)}
                        ),
                    )
            self.assertTrue(failed)
            self.assertEqual(calls, [True])
            self.assertFalse(caught.exception.receipt.raw_evidence_committed)
            self.assertFalse(caught.exception.receipt.raw_evidence_quarantined)
            self.assertTrue(caught.exception.receipt.recovery_required)

    def test_post_capture_synthesis_failures_always_request_stop_and_return_receipt(self):
        failure_points = (
            "_trailer_payload",
            "_receipt_from_parsed",
        )
        for index, failure_point in enumerate(failure_points, 90):
            stdout_fd, stderr_fd, _, _ = self.pipes(b"stdout", b"stderr")
            attempt_id = self.attempt(index)
            calls = []
            with self.subTest(failure_point=failure_point), mock.patch(
                f"gauntlet.evidence_pump.{failure_point}",
                side_effect=RuntimeError("injected synthesis failure"),
            ):
                with self.assertRaises(EvidencePumpError) as caught:
                    pump_evidence(
                        stdout_fd,
                        stderr_fd,
                        **(
                            self.pump_kwargs(attempt_id)
                            | {"stop_callback": lambda: calls.append(True)}
                        ),
                    )
            self.assertEqual(calls, [True])
            self.assertIsNotNone(caught.exception.receipt)
            self.assertTrue(caught.exception.receipt.capture_started)
            self.assertFalse(caught.exception.receipt.raw_evidence_committed)
            self.assertFalse(caught.exception.receipt.raw_evidence_quarantined)
            self.assertTrue(caught.exception.receipt.recovery_required)
            self.assertEqual(
                len(list(self.raw_directory.glob(f"{attempt_id}.*.TOMBSTONE"))),
                1,
            )

    def test_partial_input_dup_failure_closes_the_first_duplicate(self):
        stdout_fd, stderr_fd = self.eof_pipes()
        real_dup = os.dup
        duplicated = []

        def second_dup_fails(fd):
            if not duplicated:
                result = real_dup(fd)
                duplicated.append(result)
                return result
            raise OSError(errno.EMFILE, "second dup failed")

        calls = []
        with mock.patch("gauntlet.evidence_pump.os.dup", side_effect=second_dup_fails):
            with self.assertRaises(EvidencePumpError) as caught:
                pump_evidence(
                    stdout_fd,
                    stderr_fd,
                    **(
                        self.pump_kwargs()
                        | {"stop_callback": lambda: calls.append(True)}
                    ),
                )
        self.assertEqual(calls, [True])
        self.assertFalse(caught.exception.receipt.capture_started)
        self.assertIsNone(caught.exception.receipt.attempt_id)
        self.assertIsNone(caught.exception.receipt.generation)
        self.assertEqual(list(self.raw_directory.iterdir()), [])
        self.assertEqual(len(duplicated), 1)
        with self.assertRaises(OSError):
            os.fstat(duplicated[0])

    def test_parser_rejects_frame_grammar_corruption(self):
        stdout_fd, stderr_fd, _, _ = self.pipes(b"stdout", b"stderr")
        pump_evidence(stdout_fd, stderr_fd, **self.pump_kwargs())
        raw = self.evidence_path().read_bytes()
        decoded = _decode_frames(raw)
        frames = [(kind, payload) for kind, payload, _, _ in decoded]
        header, trailer = frames[0], frames[-1]
        data_corruption = bytearray(raw)
        _, _, _, first_data_offset = next(
            frame for frame in decoded if frame[0] in {b"O", b"E"}
        )
        data_corruption[first_data_offset] ^= 1
        corruptions = {
            "bad-magic": b"X" + raw[1:],
            "truncated-header": evidence_pump_module._MAGIC + b"H\x00",
            "unknown-kind": (
                evidence_pump_module._MAGIC
                + evidence_pump_module._FRAME_HEADER.pack(b"X", 1)
                + b"x"
            ),
            "zero-length": (
                evidence_pump_module._MAGIC
                + evidence_pump_module._FRAME_HEADER.pack(b"H", 0)
            ),
            "oversize-data-frame": (
                evidence_pump_module._MAGIC
                + evidence_pump_module._FRAME_HEADER.pack(
                    b"O", evidence_pump_module._FRAME_DATA_MAX + 1
                )
            ),
            "data-before-header": _rebuild_frames([(b"O", b"x"), header, trailer]),
            "duplicate-header": _rebuild_frames([header, header, trailer]),
            "missing-trailer": _rebuild_frames(frames[:-1]),
            "trailer-not-final": _rebuild_frames(frames + [(b"O", b"x")]),
            "truncated-payload": raw[:-1],
            "retained-data-hash-mismatch": bytes(data_corruption),
        }
        for label, malformed in corruptions.items():
            with self.subTest(label=label), self.assertRaises(EvidencePumpError):
                evidence_pump_module._parse_evidence_object(malformed)

    def test_parser_recomputes_retained_frames_and_rejects_schema_or_metric_drift(self):
        stdout_fd, stderr_fd, _, _ = self.pipes(b"stdout", b"stderr")
        pump_evidence(stdout_fd, stderr_fd, **self.pump_kwargs())
        raw = self.evidence_path().read_bytes()
        frames = [(kind, payload) for kind, payload, _, _ in _decode_frames(raw)]
        trailer = json.loads(frames[-1][1].decode("ascii"))
        changes = (
            {"stdout_retained_sha256": "0" * 64},
            {"stdout_retained_bytes": trailer["stdout_retained_bytes"] + 1},
            {"stdout_observed_sha256": "0" * 64},
            {"stdout_observed_bytes": -1},
            {"stdout_eof": 1},
            {"generation": "f" * 32},
            {"state": "UNKNOWN"},
            {"state": []},
            {"state": {}},
            {"version": 3.0},
        )
        for changed in changes:
            candidate = trailer | changed
            rebuilt = _rebuild_frames(
                frames[:-1]
                + [(b"T", evidence_pump_module._canonical_json(candidate))]
            )
            with self.subTest(changed=changed), self.assertRaises(EvidencePumpError):
                evidence_pump_module._parse_evidence_object(rebuilt)

        missing = dict(trailer)
        missing.pop("stderr_eof")
        extra = dict(trailer, unexpected=True)
        for label, candidate in (("missing", missing), ("extra", extra)):
            rebuilt = _rebuild_frames(
                frames[:-1]
                + [(b"T", evidence_pump_module._canonical_json(candidate))]
            )
            with self.subTest(label=label), self.assertRaises(EvidencePumpError):
                evidence_pump_module._parse_evidence_object(rebuilt)

    def test_parser_rejects_noncanonical_data_frame_fragmentation(self):
        stdout_fd, stderr_fd, _, _ = self.pipes(b"stdout", b"stderr")
        pump_evidence(stdout_fd, stderr_fd, **self.pump_kwargs())
        frames = [
            (kind, payload)
            for kind, payload, _, _ in _decode_frames(self.evidence_path().read_bytes())
        ]
        split = []
        replaced = False
        for kind, payload in frames:
            if kind == b"O" and not replaced:
                split.extend(((b"O", payload[:1]), (b"O", payload[1:])))
                replaced = True
            else:
                split.append((kind, payload))
        self.assertTrue(replaced)
        with self.assertRaises(EvidencePumpError):
            evidence_pump_module._parse_evidence_object(_rebuild_frames(split))

    def test_parser_rejects_impossible_stop_and_terminal_combinations(self):
        stdout_fd, stderr_fd, _, _ = self.pipes(b"stdout", b"stderr")
        pump_evidence(stdout_fd, stderr_fd, **self.pump_kwargs())
        frames = [
            (kind, payload)
            for kind, payload, _, _ in _decode_frames(self.evidence_path().read_bytes())
        ]
        trailer = json.loads(frames[-1][1].decode("ascii"))
        impossible = (
            trailer
            | {
                "state": "QUARANTINED",
                "recovery_required": True,
                "stop_callback_requested": False,
            },
            trailer
            | {
                "recovery_required": True,
                "stop_callback_requested": True,
                "stop_callback_completed": True,
            },
        )
        for candidate in impossible:
            rebuilt = _rebuild_frames(
                frames[:-1]
                + [(b"T", evidence_pump_module._canonical_json(candidate))]
            )
            with self.assertRaises(EvidencePumpError):
                evidence_pump_module._parse_evidence_object(rebuilt)

        overflow_attempt = self.attempt(401)
        overflow_out, overflow_err, _, _ = self.pipes(b"overflow", b"err")
        pump_evidence(
            overflow_out,
            overflow_err,
            **(self.pump_kwargs(overflow_attempt) | {"retained_byte_cap": 1}),
        )
        overflow_frames = [
            (kind, payload)
            for kind, payload, _, _ in _decode_frames(
                self.evidence_path(overflow_attempt).read_bytes()
            )
        ]
        overflow_trailer = json.loads(overflow_frames[-1][1].decode("ascii"))
        overflow_trailer.update(
            {
                "recovery_required": False,
                "stop_callback_requested": False,
                "stop_callback_completed": False,
            }
        )
        rebuilt = _rebuild_frames(
            overflow_frames[:-1]
            + [(b"T", evidence_pump_module._canonical_json(overflow_trailer))]
        )
        with self.assertRaises(EvidencePumpError):
            evidence_pump_module._parse_evidence_object(rebuilt)

        overflow_header = json.loads(overflow_frames[0][1].decode("ascii"))
        overflow_header["retained_byte_cap"] += 1
        rebuilt = _rebuild_frames(
            [(b"H", evidence_pump_module._canonical_json(overflow_header))]
            + overflow_frames[1:]
        )
        with self.assertRaises(EvidencePumpError):
            evidence_pump_module._parse_evidence_object(rebuilt)

        wrong_type_header = json.loads(overflow_frames[0][1].decode("ascii"))
        wrong_type_header["version"] = 3.0
        rebuilt = _rebuild_frames(
            [(b"H", evidence_pump_module._canonical_json(wrong_type_header))]
            + overflow_frames[1:]
        )
        with self.assertRaises(EvidencePumpError):
            evidence_pump_module._parse_evidence_object(rebuilt)

    def test_recovery_rejects_float_version_tombstone_as_non_exact_grammar(self):
        lock = self.raw_directory / f"{ATTEMPT_ID}.controller.lock"
        lock.write_bytes(b"")
        lock.chmod(0o400)
        token = "b" * 32
        tombstone = self.raw_directory / f"{ATTEMPT_ID}.{token}.TOMBSTONE"
        tombstone.write_bytes(
            evidence_pump_module._canonical_json(
                {
                    "attempt_id": ATTEMPT_ID,
                    "reason": "RESIDUE_DETECTED",
                    "state": "TOMBSTONE",
                    "tombstone_id": token,
                    "version": 3.0,
                }
            )
        )
        tombstone.chmod(0o400)
        stdout_fd, stderr_fd = self.eof_pipes()
        calls = []
        with self.assertRaises(EvidencePumpError) as caught:
            pump_evidence(
                stdout_fd,
                stderr_fd,
                **(self.pump_kwargs() | {"stop_callback": lambda: calls.append(True)}),
            )
        self.assertEqual(calls, [True])
        self.assertTrue(caught.exception.receipt.recovered_residue)
        self.assertEqual(
            len(list(self.raw_directory.glob(f"{ATTEMPT_ID}.*.TOMBSTONE"))),
            2,
        )

        for malformed_reason in ([], {}):
            with self.subTest(malformed_reason=malformed_reason), self.assertRaises(
                EvidencePumpError
            ):
                evidence_pump_module._validate_tombstone(
                    {
                        "attempt_id": ATTEMPT_ID,
                        "reason": malformed_reason,
                        "state": "TOMBSTONE",
                        "tombstone_id": token,
                        "version": evidence_pump_module._VERSION,
                    },
                    ATTEMPT_ID,
                    token,
                )

    def test_parser_rejects_noncanonical_duplicate_and_nonfinite_json(self):
        attempt = ATTEMPT_ID.encode("ascii")
        malformed_headers = (
            b'{"schema": "not-canonical"}\n',
            b'{"attempt_id":"' + attempt + b'","attempt_id":"' + attempt + b'"}\n',
            b'{"value":NaN}\n',
        )
        for payload in malformed_headers:
            raw = evidence_pump_module._MAGIC + evidence_pump_module._encode_frame(
                b"H", payload
            )
            with self.assertRaises(EvidencePumpError):
                evidence_pump_module._parse_evidence_object(raw)

    def test_parser_enforces_object_size_frame_count_and_expected_binding(self):
        stdout_fd, stderr_fd, _, _ = self.pipes(b"stdout", b"stderr")
        pump_evidence(stdout_fd, stderr_fd, **self.pump_kwargs())
        raw = self.evidence_path().read_bytes()
        with mock.patch.object(evidence_pump_module, "_MAX_OBJECT_BYTES", len(raw) - 1):
            with self.assertRaises(EvidencePumpError):
                evidence_pump_module._parse_evidence_object(raw)
        with mock.patch.object(evidence_pump_module, "_MAX_DATA_FRAMES", 0):
            with self.assertRaises(EvidencePumpError):
                evidence_pump_module._parse_evidence_object(raw)
        with self.assertRaises(EvidencePumpError):
            evidence_pump_module._parse_evidence_object(
                raw, expected_attempt_id=self.attempt(999)
            )
        with self.assertRaises(EvidencePumpError):
            evidence_pump_module._parse_evidence_object(
                raw, expected_generation="f" * 32
            )

    def test_corrupted_committed_object_is_not_accepted_during_later_recovery(self):
        stdout_fd, stderr_fd, _, _ = self.pipes(b"stdout", b"stderr")
        pump_evidence(stdout_fd, stderr_fd, **self.pump_kwargs())
        path = self.evidence_path()
        path.chmod(0o600)
        writer = os.open(path, os.O_WRONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            os.pwrite(writer, b"X", 0)
            os.fsync(writer)
        finally:
            os.close(writer)
            path.chmod(0o600)
        corrupted = path.read_bytes()
        retry_out, retry_err = self.eof_pipes()
        calls = []
        with self.assertRaises(EvidencePumpError) as caught:
            pump_evidence(
                retry_out,
                retry_err,
                **(self.pump_kwargs() | {"stop_callback": lambda: calls.append(True)}),
            )
        self.assertEqual(calls, [True])
        self.assertTrue(caught.exception.receipt.recovered_residue)
        self.assertEqual(path.read_bytes(), corrupted)
        self.assertEqual(len(list(self.raw_directory.glob(f"{ATTEMPT_ID}.*.TOMBSTONE"))), 1)

    def test_attempt_entry_bound_aborts_without_unbounded_tombstones(self):
        for index in range(evidence_pump_module._MAX_ATTEMPT_ENTRIES + 1):
            path = self.raw_directory / f"{ATTEMPT_ID}.unknown-{index}"
            path.write_bytes(b"x")
            path.chmod(0o400)
        stdout_fd, stderr_fd = self.eof_pipes()
        calls = []
        with self.assertRaises(EvidencePumpError) as caught:
            pump_evidence(
                stdout_fd,
                stderr_fd,
                **(self.pump_kwargs() | {"stop_callback": lambda: calls.append(True)}),
            )
        self.assertEqual(calls, [True])
        self.assertFalse(caught.exception.receipt.capture_started)
        self.assertLessEqual(
            len(list(self.raw_directory.glob(f"{ATTEMPT_ID}.*.TOMBSTONE"))),
            1,
        )

    def test_receipt_is_frozen_content_free_and_uses_observed_field_names(self):
        stdout_fd, stderr_fd, _, _ = self.pipes(b"private-stdout", b"private-stderr")
        receipt = pump_evidence(stdout_fd, stderr_fd, **self.pump_kwargs())
        names = set(EvidenceReceipt.__dataclass_fields__)
        self.assertIn("stdout_observed_bytes", names)
        self.assertIn("stderr_observed_bytes", names)
        self.assertNotIn("stdout_bytes", names)
        self.assertNotIn("stderr_bytes", names)
        self.assertFalse(any("path" in name or "content" in name for name in names))
        serialized = repr(receipt) + repr(asdict(receipt))
        self.assertNotIn("private-stdout", serialized)
        self.assertNotIn("private-stderr", serialized)
        self.assertNotIn(str(self.raw_directory), serialized)
        with self.assertRaises(FrozenInstanceError):
            receipt.stdout_observed_bytes = 0

    def test_receipt_rejects_impossible_stop_and_publication_combinations(self):
        stdout_fd, stderr_fd = self.eof_pipes()
        receipt = pump_evidence(stdout_fd, stderr_fd, **self.pump_kwargs())
        values = asdict(receipt)
        quarantined_without_stop = values | {
            "raw_evidence_committed": False,
            "raw_evidence_quarantined": True,
            "recovery_required": True,
        }
        committed_with_unneeded_stop = values | {
            "stop_callback_requested": True,
            "stop_callback_completed": True,
            "recovery_required": True,
        }
        fully_retained_digest_drift = values | {
            "stdout_observed_sha256": "0" * 64,
        }
        committed_with_spurious_recovery = values | {
            "recovery_required": True,
        }
        payload_digest = hashlib.sha256(b"x").hexdigest()
        unpublished_with_retained_metrics = values | {
            "stdout_observed_sha256": payload_digest,
            "stdout_retained_sha256": payload_digest,
            "stdout_observed_bytes": 1,
            "stdout_retained_bytes": 1,
            "raw_evidence_committed": False,
            "stop_callback_requested": True,
            "stop_callback_completed": True,
            "recovery_required": True,
        }
        with self.assertRaises(EvidencePumpError):
            EvidenceReceipt(**quarantined_without_stop)
        with self.assertRaises(EvidencePumpError):
            EvidenceReceipt(**committed_with_unneeded_stop)
        with self.assertRaises(EvidencePumpError):
            EvidenceReceipt(**fully_retained_digest_drift)
        with self.assertRaises(EvidencePumpError):
            EvidenceReceipt(**committed_with_spurious_recovery)
        with self.assertRaises(EvidencePumpError):
            EvidenceReceipt(**unpublished_with_retained_metrics)

        zero_capture = values | {
            "attempt_id": None,
            "generation": None,
            "evidence_sha256": None,
            "evidence_bytes": 0,
            "stdout_observed_sha256": hashlib.sha256().hexdigest(),
            "stderr_observed_sha256": hashlib.sha256().hexdigest(),
            "stdout_retained_sha256": hashlib.sha256().hexdigest(),
            "stderr_retained_sha256": hashlib.sha256().hexdigest(),
            "stdout_observed_bytes": 0,
            "stderr_observed_bytes": 0,
            "stdout_retained_bytes": 0,
            "stderr_retained_bytes": 0,
            "stdout_eof": False,
            "stderr_eof": False,
            "capture_started": False,
            "raw_evidence_committed": False,
            "raw_evidence_quarantined": False,
            "stop_callback_requested": True,
            "stop_callback_completed": True,
            "recovery_required": True,
        }
        EvidenceReceipt(**zero_capture)

        reserved_without_object = zero_capture | {
            "attempt_id": ATTEMPT_ID,
            "generation": "f" * 32,
        }
        EvidenceReceipt(**reserved_without_object)

        for changed in (
            {"attempt_id": None},
            {"generation": None},
            {"attempt_id": "bad"},
            {"generation": "bad"},
            {"evidence_sha256": None},
            {"evidence_bytes": 0},
            {"evidence_sha256": "bad"},
            {"evidence_bytes": True},
            {"evidence_bytes": evidence_pump_module._MAX_OBJECT_BYTES + 1},
        ):
            with self.subTest(binding_change=changed), self.assertRaises(
                EvidencePumpError
            ):
                EvidenceReceipt(**(values | changed))

        for changed in (
            {"attempt_id": ATTEMPT_ID},
            {"generation": "f" * 32},
            {"evidence_sha256": "f" * 64},
            {"evidence_bytes": 1},
        ):
            with self.subTest(zero_binding_change=changed), self.assertRaises(
                EvidencePumpError
            ):
                EvidenceReceipt(**(zero_capture | changed))

        for flag in ("timed_out", "cancelled", "drain_limit_reached"):
            with self.subTest(zero_capture_flag=flag), self.assertRaises(
                EvidencePumpError
            ):
                EvidenceReceipt(**(zero_capture | {flag: True}))

        recovered_residue = zero_capture | {"recovered_residue": True}
        EvidenceReceipt(**recovered_residue)
        with self.assertRaises(EvidencePumpError):
            EvidenceReceipt(**(reserved_without_object | {"recovered_residue": True}))

    def test_append_only_seam_contains_no_delete_or_rename_operation(self):
        source = inspect.getsource(evidence_pump_module)
        for forbidden in (
            "os.unlink(",
            "os.remove(",
            "os.rename(",
            "os.replace(",
            ".unlink(",
            ".rename(",
        ):
            self.assertNotIn(forbidden, source)


if __name__ == "__main__":
    unittest.main()
