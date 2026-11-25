#!/usr/bin/env python3
"""
Kizuki Local CPU Semantic Embedding Server (`kizuki.embedding.local-http`).

Binds strictly to a loopback address literal (`127.0.0.1` or `::1`) and serves:
  - POST /v1/embeddings  (OpenAI-compatible wire format)
  - POST /api/embed      (Ollama-compatible wire format)
  - GET  /health         (Readiness, RSS memory, latency & throughput telemetry)
  - GET  /v1/models      (Pinned model metadata)

Uses `BAAI/bge-small-en-v1.5` (384 dimensions, CLS pooling + L2 normalization)
from the local HuggingFace cache (`local_files_only=True` by default) with
optional ONNX Runtime acceleration and length-sorted micro-batching.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import resource
import sys
import threading
import time
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import numpy as np

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8789
DEFAULT_MODEL_ID = "BAAI/bge-small-en-v1.5"
DEFAULT_DIMS = 384
DEFAULT_MAX_SEQ_LENGTH = 512
DEFAULT_BATCH_SIZE = 32
DEFAULT_THREADS = min(6, os.cpu_count() or 4)
DEFAULT_CACHE_SIZE = 2048
MAX_REQUEST_BYTES = 4 * 1024 * 1024
MAX_BATCH_INPUTS = 128


def assert_loopback_host(host: str) -> str:
    cleaned = host.strip()
    if cleaned.startswith("[") and cleaned.endswith("]"):
        cleaned = cleaned[1:-1]
    try:
        addr = ipaddress.ip_address(cleaned)
    except ValueError as exc:
        raise ValueError(
            f"bind host must be a loopback IP literal (127.0.0.0/8 or ::1), got {host!r}"
        ) from exc
    if not addr.is_loopback:
        raise ValueError(
            f"refusing non-loopback bind host {host!r}; local-embed is loopback-only"
        )
    return str(addr)


def current_rss_bytes() -> int:
    try:
        with open("/proc/self/statm", "r", encoding="utf-8") as fh:
            parts = fh.read().split()
            if len(parts) >= 2:
                return int(parts[1]) * os.sysconf("SC_PAGE_SIZE")
    except OSError:
        pass
    usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(usage * 1024)


def resolve_cached_snapshot(model_id: str) -> Path | None:
    candidate = Path(model_id)
    if candidate.is_dir():
        return candidate
    hub_dir = Path(
        os.environ.get(
            "HF_HUB_CACHE",
            str(Path.home() / ".cache" / "huggingface" / "hub"),
        )
    )
    safe_name = "models--" + model_id.replace("/", "--")
    model_root = hub_dir / safe_name
    snapshots_dir = model_root / "snapshots"
    if not snapshots_dir.is_dir():
        return None
    ref_main = model_root / "refs" / "main"
    if ref_main.is_file():
        commit = ref_main.read_text(encoding="utf-8").strip()
        snap = snapshots_dir / commit
        if snap.is_dir():
            return snap
    snaps = sorted(
        (p for p in snapshots_dir.iterdir() if p.is_dir()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return snaps[0] if snaps else None


class LocalSemanticEmbedder:
    """Thread-safe local CPU semantic embedder with length-sorted micro-batching."""

    def __init__(
        self,
        model_id: str = DEFAULT_MODEL_ID,
        max_seq_length: int = DEFAULT_MAX_SEQ_LENGTH,
        batch_size: int = DEFAULT_BATCH_SIZE,
        threads: int = DEFAULT_THREADS,
        backend: str = "auto",
        onnx_cache_dir: str | None = None,
        allow_download: bool = False,
        cache_size: int = DEFAULT_CACHE_SIZE,
    ) -> None:
        self.model_id = model_id
        self.max_seq_length = max_seq_length
        self.batch_size = max(1, min(batch_size, MAX_BATCH_INPUTS))
        self.threads = max(1, threads)
        self.cache_capacity = max(0, int(cache_size))
        self._lock = threading.Lock()
        self._cache: OrderedDict[str, list[float]] = OrderedDict()
        self.cache_hits = 0
        self.cache_misses = 0
        self.requests_total = 0
        self.texts_total = 0
        self.total_latency_ms = 0.0
        self.started_at = time.time()

        snapshot = resolve_cached_snapshot(model_id)
        load_path = str(snapshot) if snapshot is not None else model_id
        local_only = not allow_download and snapshot is not None

        self.fast_tokenizer: Any = None
        self.tokenizer: Any = None
        self.backend = "torch"
        self.ort_session: Any = None
        self.ort_input_names: set[str] = set()
        self.torch_model: Any = None
        self.dims = DEFAULT_DIMS

        onnx_path = self._prepare_onnx(load_path, local_only, backend, onnx_cache_dir)
        if onnx_path is not None:
            import onnxruntime as ort

            self.fast_tokenizer = self._load_fast_tokenizer(load_path)
            if self.fast_tokenizer is None:
                from transformers import AutoTokenizer

                self.tokenizer = AutoTokenizer.from_pretrained(
                    load_path,
                    local_files_only=local_only,
                    use_fast=True,
                )

            sess_options = ort.SessionOptions()
            sess_options.intra_op_num_threads = self.threads
            sess_options.inter_op_num_threads = 1
            sess_options.graph_optimization_level = (
                ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            )
            self.ort_session = ort.InferenceSession(
                str(onnx_path),
                sess_options=sess_options,
                providers=["CPUExecutionProvider"],
            )
            self.ort_input_names = {
                inp.name for inp in self.ort_session.get_inputs()
            }
            out_shape = self.ort_session.get_outputs()[0].shape
            if isinstance(out_shape, (list, tuple)) and len(out_shape) >= 2 and isinstance(out_shape[-1], int):
                self.dims = int(out_shape[-1])
            self.backend = "onnx"
        else:
            import torch
            from transformers import AutoModel, AutoTokenizer

            self.tokenizer = AutoTokenizer.from_pretrained(
                load_path,
                local_files_only=local_only,
                use_fast=True,
            )
            torch.set_num_threads(self.threads)
            self.torch_model = AutoModel.from_pretrained(
                load_path,
                local_files_only=local_only,
            )
            self.torch_model.eval()
            self.dims = int(self.torch_model.config.hidden_size)
            self.backend = "torch"

        self.embed(["warmup query"])
        self._cache.clear()
        self.cache_hits = 0
        self.cache_misses = 0
        self.requests_total = 0
        self.texts_total = 0
        self.total_latency_ms = 0.0

    def _load_fast_tokenizer(self, load_path: str) -> Any:
        snap = Path(load_path)
        tok_file = snap / "tokenizer.json"
        if not tok_file.is_file():
            return None
        try:
            import tokenizers

            tok = tokenizers.Tokenizer.from_file(str(tok_file))
            pad_token = "[PAD]"
            cfg_file = snap / "tokenizer_config.json"
            if cfg_file.is_file():
                cfg = json.loads(cfg_file.read_text(encoding="utf-8"))
                raw_pad = cfg.get("pad_token")
                if isinstance(raw_pad, str) and raw_pad:
                    pad_token = raw_pad
            pad_id = tok.token_to_id(pad_token)
            if pad_id is None:
                pad_id = 0
            tok.enable_truncation(max_length=self.max_seq_length)
            tok.enable_padding(pad_id=pad_id, pad_token=pad_token)
            return tok
        except Exception:
            return None

    def _prepare_onnx(
        self,
        load_path: str,
        local_only: bool,
        backend: str,
        onnx_cache_dir: str | None,
    ) -> Path | None:
        if backend == "torch":
            return None
        snap = Path(load_path)
        if snap.is_dir():
            for rel in ("onnx/model_quantized.onnx", "onnx/model.onnx", "model.onnx"):
                candidate = snap / rel
                if candidate.is_file():
                    return candidate

        cache_root = (
            Path(onnx_cache_dir)
            if onnx_cache_dir
            else (
                Path("/data/models/kizuki-embed")
                if Path("/data/models").is_dir() and os.access("/data/models", os.W_OK)
                else Path.home() / ".cache" / "kizuki-embed"
            )
        )
        safe_id = self.model_id.replace("/", "--")
        onnx_file = cache_root / safe_id / "model.onnx"
        if onnx_file.is_file():
            return onnx_file

        if backend != "onnx":
            return None

        try:
            import torch
            from transformers import AutoModel, AutoTokenizer

            onnx_file.parent.mkdir(parents=True, exist_ok=True)
            export_tokenizer = AutoTokenizer.from_pretrained(
                load_path,
                local_files_only=local_only,
                use_fast=True,
            )
            model = AutoModel.from_pretrained(load_path, local_files_only=local_only)
            model.eval()
            dummy = export_tokenizer(
                ["export dummy text"],
                padding=True,
                truncation=True,
                max_length=32,
                return_tensors="pt",
            )
            input_names = ["input_ids", "attention_mask"]
            args: tuple[Any, ...] = (dummy["input_ids"], dummy["attention_mask"])
            dynamic_axes = {
                "input_ids": {0: "batch", 1: "seq"},
                "attention_mask": {0: "batch", 1: "seq"},
                "last_hidden_state": {0: "batch", 1: "seq"},
            }
            if "token_type_ids" in dummy:
                input_names.append("token_type_ids")
                args = (
                    dummy["input_ids"],
                    dummy["attention_mask"],
                    dummy["token_type_ids"],
                )
                dynamic_axes["token_type_ids"] = {0: "batch", 1: "seq"}

            tmp_file = onnx_file.with_suffix(".onnx.tmp")
            with torch.inference_mode():
                torch.onnx.export(
                    model,
                    args,
                    str(tmp_file),
                    input_names=input_names,
                    output_names=["last_hidden_state"],
                    dynamic_axes=dynamic_axes,
                    opset_version=14,
                    dynamo=False,
                )
            tmp_file.replace(onnx_file)
            return onnx_file
        except Exception:
            return None

    def _embed_subbatch(self, texts: list[str]) -> np.ndarray:
        if self.backend == "onnx":
            if self.fast_tokenizer is not None:
                encodings = self.fast_tokenizer.encode_batch(texts)
                input_ids = np.array([e.ids for e in encodings], dtype=np.int64)
                attention_mask = np.array([e.attention_mask for e in encodings], dtype=np.int64)
                encoded: dict[str, np.ndarray] = {
                    "input_ids": input_ids,
                    "attention_mask": attention_mask,
                }
                if "token_type_ids" in self.ort_input_names:
                    encoded["token_type_ids"] = np.array(
                        [e.type_ids for e in encodings], dtype=np.int64
                    )
            else:
                encoded = self.tokenizer(
                    texts,
                    padding=True,
                    truncation=True,
                    max_length=self.max_seq_length,
                    return_tensors="np",
                )
            feed: dict[str, Any] = {}
            for name in self.ort_input_names:
                if name in encoded:
                    feed[name] = encoded[name].astype(np.int64, copy=False)
                elif name == "token_type_ids":
                    feed[name] = np.zeros_like(encoded["input_ids"], dtype=np.int64)
            outputs = self.ort_session.run(None, feed)
            hidden = outputs[0]
            cls_vecs = hidden[:, 0, :].astype(np.float32, copy=False)
        else:
            import torch

            encoded = self.tokenizer(
                texts,
                padding=True,
                truncation=True,
                max_length=self.max_seq_length,
                return_tensors="pt",
            )
            with torch.inference_mode():
                outputs = self.torch_model(**encoded)
                cls_tensor = outputs.last_hidden_state[:, 0]
                cls_tensor = torch.nn.functional.normalize(cls_tensor, p=2, dim=1)
                return cls_tensor.cpu().numpy().astype(np.float32, copy=False)

        norms = np.linalg.norm(cls_vecs, axis=1, keepdims=True)
        norms = np.where(norms > 1e-12, norms, 1.0)
        return (cls_vecs / norms).astype(np.float32, copy=False)

    def embed(self, texts: list[str]) -> tuple[list[list[float]], int]:
        if not texts:
            return [], 0
        started = time.perf_counter()
        ordered_result: list[list[float] | None] = [None] * len(texts)
        approx_tokens = sum(max(1, (len(t) + 3) // 4) for t in texts)

        with self._lock:
            missing_by_text: dict[str, list[int]] = {}
            for orig_idx, raw_text in enumerate(texts):
                if self.cache_capacity > 0:
                    cached = self._cache.get(raw_text)
                    if cached is not None:
                        self._cache.move_to_end(raw_text)
                        ordered_result[orig_idx] = cached
                        self.cache_hits += 1
                        continue
                self.cache_misses += 1
                indices = missing_by_text.get(raw_text)
                if indices is None:
                    missing_by_text[raw_text] = [orig_idx]
                else:
                    indices.append(orig_idx)

            if missing_by_text:
                unique_missing = sorted(missing_by_text.keys(), key=len)
                for start in range(0, len(unique_missing), self.batch_size):
                    chunk_texts = unique_missing[start : start + self.batch_size]
                    sub_texts = [t if len(t) > 0 else " " for t in chunk_texts]
                    matrix = self._embed_subbatch(sub_texts)
                    for row_idx, raw_text in enumerate(chunk_texts):
                        vec = matrix[row_idx]
                        if vec.shape[0] != self.dims or not np.all(np.isfinite(vec)):
                            raise RuntimeError("embedding model produced non-finite or mismatched vector")
                        if not np.any(vec != 0):
                            raise RuntimeError("embedding model produced zero vector")
                        vec_list = vec.tolist()
                        if self.cache_capacity > 0:
                            self._cache[raw_text] = vec_list
                            self._cache.move_to_end(raw_text)
                            while len(self._cache) > self.cache_capacity:
                                self._cache.popitem(last=False)
                        for orig_idx in missing_by_text[raw_text]:
                            ordered_result[orig_idx] = vec_list

            elapsed_ms = (time.perf_counter() - started) * 1000.0
            self.requests_total += 1
            self.texts_total += len(texts)
            self.total_latency_ms += elapsed_ms

        return [row for row in ordered_result if row is not None], approx_tokens

    def stats(self) -> dict[str, Any]:
        rss = current_rss_bytes()
        return {
            "status": "ok",
            "model": self.model_id,
            "backend": self.backend,
            "dims": self.dims,
            "max_seq_length": self.max_seq_length,
            "batch_size": self.batch_size,
            "threads": self.threads,
            "rss_bytes": rss,
            "rss_mib": round(rss / (1024 * 1024), 2),
            "uptime_s": round(time.time() - self.started_at, 2),
            "requests_total": self.requests_total,
            "texts_total": self.texts_total,
            "cache_hits": self.cache_hits,
            "cache_misses": self.cache_misses,
            "cache_size": len(self._cache),
            "cache_capacity": self.cache_capacity,
            "avg_request_latency_ms": (
                round(self.total_latency_ms / self.requests_total, 2)
                if self.requests_total > 0
                else 0.0
            ),
        }


class EmbedHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class EmbedRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = 30.0
    disable_nagle_algorithm = True
    wbufsize = 65536
    embedder: LocalSemanticEmbedder

    def log_message(self, format: str, *args: Any) -> None:
        return

    def handle_one_request(self) -> None:
        try:
            super().handle_one_request()
        except (TimeoutError, ConnectionResetError, BrokenPipeError):
            self.close_connection = True

    def _send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        conn_header = self.headers.get("Connection", "").lower() if self.headers else ""
        keep_alive = (
            status < 400
            and self.request_version == "HTTP/1.1"
            and "close" not in conn_header
        )
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if keep_alive:
            self.send_header("Connection", "keep-alive")
            self.send_header("Keep-Alive", "timeout=30")
            self.close_connection = False
        else:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self._send_json(200, self.embedder.stats())
            return
        if path == "/v1/models":
            self._send_json(
                200,
                {
                    "object": "list",
                    "data": [
                        {
                            "id": self.embedder.model_id,
                            "object": "model",
                            "owned_by": "local-embed",
                            "dims": self.embedder.dims,
                            "max_input_tokens": self.embedder.max_seq_length,
                        }
                    ],
                },
            )
            return
        self._send_json(404, {"error": {"message": "not found", "type": "invalid_request_error"}})

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        if path not in ("/v1/embeddings", "/api/embed"):
            self._send_json(404, {"error": {"message": "not found", "type": "invalid_request_error"}})
            return

        content_length_raw = self.headers.get("Content-Length")
        if content_length_raw is None or not content_length_raw.isdigit():
            self._send_json(400, {"error": {"message": "Content-Length required"}})
            return
        content_length = int(content_length_raw)
        if content_length <= 0 or content_length > MAX_REQUEST_BYTES:
            self._send_json(413, {"error": {"message": "request payload out of bounds"}})
            return

        try:
            raw_body = self.rfile.read(content_length)
            payload = json.loads(raw_body.decode("utf-8"))
        except Exception:
            self._send_json(400, {"error": {"message": "malformed JSON request"}})
            return

        if not isinstance(payload, dict):
            self._send_json(400, {"error": {"message": "request body must be a JSON object"}})
            return

        requested_model = payload.get("model")
        if not isinstance(requested_model, str) or not requested_model.strip():
            self._send_json(400, {"error": {"message": "model is required"}})
            return

        allowed_names = {
            self.embedder.model_id,
            self.embedder.model_id.lower(),
            self.embedder.model_id.split("/")[-1],
            self.embedder.model_id.split("/")[-1].lower(),
        }
        if requested_model not in allowed_names and requested_model.lower() not in allowed_names:
            self._send_json(
                400,
                {"error": {"message": "requested model does not match pinned local model"}},
            )
            return

        raw_input = payload.get("input")
        if isinstance(raw_input, str):
            inputs = [raw_input]
        elif (
            isinstance(raw_input, list)
            and 0 < len(raw_input) <= MAX_BATCH_INPUTS
            and all(isinstance(item, str) for item in raw_input)
        ):
            inputs = raw_input
        else:
            self._send_json(
                400,
                {"error": {"message": f"input must be a string or list of 1..{MAX_BATCH_INPUTS} strings"}},
            )
            return

        try:
            vectors, prompt_tokens = self.embedder.embed(inputs)
        except Exception:
            self._send_json(500, {"error": {"message": "embedding computation failed"}})
            return

        if path == "/api/embed":
            self._send_json(
                200,
                {
                    "model": requested_model,
                    "embeddings": vectors,
                },
            )
            return

        self._send_json(
            200,
            {
                "object": "list",
                "model": requested_model,
                "data": [
                    {
                        "object": "embedding",
                        "index": idx,
                        "embedding": vec,
                    }
                    for idx, vec in enumerate(vectors)
                ],
                "usage": {
                    "prompt_tokens": prompt_tokens,
                    "total_tokens": prompt_tokens,
                },
            },
        )


def cosine_sim(a: list[float], b: list[float]) -> float:
    va = np.asarray(a, dtype=np.float32)
    vb = np.asarray(b, dtype=np.float32)
    denom = float(np.linalg.norm(va) * np.linalg.norm(vb))
    return float(np.dot(va, vb) / denom) if denom > 0 else 0.0


def run_benchmark(embedder: LocalSemanticEmbedder) -> dict[str, Any]:
    queries = [
        "Represent this sentence for searching relevant passages: automobile purchase and car keys",
        "Represent this sentence for searching relevant passages: quarterly financial audit and cash schedule",
        "Represent this sentence for searching relevant passages: physician appointment and medical clinic",
        "Represent this sentence for searching relevant passages: coastal storm and weather emergency",
        "Represent this sentence for searching relevant passages: apartment residence lease renewal",
    ]
    latencies_ms: list[float] = []
    for i in range(50):
        q = queries[i % len(queries)]
        t0 = time.perf_counter()
        vecs, _ = embedder.embed([q])
        latencies_ms.append((time.perf_counter() - t0) * 1000.0)
        assert len(vecs) == 1 and len(vecs[0]) == embedder.dims

    latencies_sorted = sorted(latencies_ms)
    p50_ms = latencies_sorted[len(latencies_sorted) // 2]
    p95_ms = latencies_sorted[int(len(latencies_sorted) * 0.95)]
    mean_ms = sum(latencies_ms) / len(latencies_ms)

    sample_docs = [
        f"Note {i}: We signed for the sedan on Friday and the dealership keys arrive next week for the garage."
        for i in range(256)
    ]
    t0 = time.perf_counter()
    for start in range(0, len(sample_docs), 32):
        batch = sample_docs[start : start + 32]
        vecs, _ = embedder.embed(batch)
        assert len(vecs) == len(batch)
    batch_elapsed_s = time.perf_counter() - t0
    throughput_docs_per_s = len(sample_docs) / batch_elapsed_s

    notes = [
        ("vehicle", "We signed for the sedan on Friday and the keys arrive next week."),
        ("money", "The payment schedule for the agency needs revised numbers before the audit."),
        ("illness", "Grace is unwell and staying offline until the fever clears."),
        ("housing", "The apartment lease ends in June so the boxes are packed early."),
        ("pet", "The puppy chewed through two sofa cushions again."),
        ("weather", "A hurricane warning covers the coast through Sunday night."),
        ("clinic", "The physician moved the checkup to Tuesday morning."),
    ]
    paraphrases = [
        ("vehicle", "Represent this sentence for searching relevant passages: buying an automobile"),
        ("money", "Represent this sentence for searching relevant passages: financial cash budget"),
        ("illness", "Represent this sentence for searching relevant passages: sick with a high temperature"),
        ("housing", "Represent this sentence for searching relevant passages: moving out of the residence"),
        ("pet", "Represent this sentence for searching relevant passages: a dog destroying furniture"),
        ("weather", "Represent this sentence for searching relevant passages: severe tropical storm"),
        ("clinic", "Represent this sentence for searching relevant passages: seeing a medical doctor"),
    ]
    note_vecs, _ = embedder.embed([text for _, text in notes])
    query_vecs, _ = embedder.embed([q for _, q in paraphrases])

    hits = 0
    pair_scores: list[dict[str, Any]] = []
    for q_idx, (expected_id, _q_text) in enumerate(paraphrases):
        sims = [
            (notes[n_idx][0], cosine_sim(query_vecs[q_idx], note_vecs[n_idx]))
            for n_idx in range(len(notes))
        ]
        sims.sort(key=lambda item: item[1], reverse=True)
        top_id, top_score = sims[0]
        runner_up_id, runner_up_score = sims[1]
        if top_id == expected_id:
            hits += 1
        pair_scores.append(
            {
                "expected": expected_id,
                "top_match": top_id,
                "top_score": round(top_score, 4),
                "runner_up": runner_up_id,
                "runner_up_score": round(runner_up_score, 4),
            }
        )

    rss_bytes = current_rss_bytes()
    return {
        "model": embedder.model_id,
        "backend": embedder.backend,
        "dims": embedder.dims,
        "threads": embedder.threads,
        "query_latency_ms": {
            "mean": round(mean_ms, 3),
            "p50": round(p50_ms, 3),
            "p95": round(p95_ms, 3),
        },
        "batch_32_throughput_docs_per_s": round(throughput_docs_per_s, 1),
        "cache_hits": embedder.cache_hits,
        "cache_misses": embedder.cache_misses,
        "cache_size": len(embedder._cache),
        "rss_mib": round(rss_bytes / (1024 * 1024), 2),
        "rss_bytes": rss_bytes,
        "semantic_top1_accuracy": f"{hits}/{len(paraphrases)}",
        "semantic_pairs": pair_scores,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Kizuki local loopback CPU semantic embedding server"
    )
    parser.add_argument("--host", default=os.environ.get("KIZUKI_EMBED_HOST", DEFAULT_HOST))
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("KIZUKI_EMBED_PORT", str(DEFAULT_PORT))),
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("KIZUKI_EMBED_MODEL", DEFAULT_MODEL_ID),
    )
    parser.add_argument(
        "--max-seq-length",
        type=int,
        default=int(os.environ.get("KIZUKI_EMBED_MAX_SEQ_LENGTH", str(DEFAULT_MAX_SEQ_LENGTH))),
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=int(os.environ.get("KIZUKI_EMBED_BATCH_SIZE", str(DEFAULT_BATCH_SIZE))),
    )
    parser.add_argument(
        "--threads",
        type=int,
        default=int(os.environ.get("KIZUKI_EMBED_THREADS", str(DEFAULT_THREADS))),
    )
    parser.add_argument(
        "--cache-size",
        type=int,
        default=int(os.environ.get("KIZUKI_EMBED_CACHE_SIZE", str(DEFAULT_CACHE_SIZE))),
    )
    parser.add_argument(
        "--backend",
        choices=("auto", "onnx", "torch"),
        default=os.environ.get("KIZUKI_EMBED_BACKEND", "auto"),
    )
    parser.add_argument(
        "--onnx-cache-dir",
        default=os.environ.get("KIZUKI_EMBED_ONNX_CACHE", ""),
    )
    parser.add_argument(
        "--allow-download",
        action="store_true",
        help="Allow downloading weights if not already cached locally",
    )
    parser.add_argument(
        "--benchmark",
        action="store_true",
        help="Run CPU latency, batch throughput, semantic recall, and RSS benchmark and exit",
    )
    args = parser.parse_args(argv)

    host = assert_loopback_host(args.host)
    if not (0 <= args.port <= 65535):
        raise ValueError(f"port must be in 0..65535, got {args.port}")

    embedder = LocalSemanticEmbedder(
        model_id=args.model,
        max_seq_length=args.max_seq_length,
        batch_size=args.batch_size,
        threads=args.threads,
        backend=args.backend,
        onnx_cache_dir=args.onnx_cache_dir or None,
        allow_download=args.allow_download,
        cache_size=args.cache_size,
    )

    if args.benchmark:
        report = run_benchmark(embedder)
        print(json.dumps(report, indent=2))
        return 0

    class BoundHandler(EmbedRequestHandler):
        pass

    BoundHandler.embedder = embedder
    server = EmbedHTTPServer((host, args.port), BoundHandler)
    actual_host, actual_port = server.server_address[:2]
    print(
        json.dumps(
            {
                "event": "listening",
                "host": actual_host,
                "port": actual_port,
                "endpoint": f"http://{actual_host}:{actual_port}",
                **embedder.stats(),
            }
        ),
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
