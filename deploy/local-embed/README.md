# Kizuki Local CPU Semantic Embedding Service (`deploy/local-embed`)

Zero-API-cost, loopback-only CPU semantic vector server for Kizuki's `@kizuki/embed-local-http` (`kizuki.embedding.local-http`) and `@kizuki/retrieval-pg` (`kizuki.retrieval.embedded-pg`) ports.

## Architecture & Model Selection

- **Model**: `BAAI/bge-small-en-v1.5` (384 dimensions, 6-layer BERT encoder, CLS pooling + L2 normalization).
- **Local Cache**: Uses the pre-cached HuggingFace snapshot at `~/.cache/huggingface/hub/models--BAAI--bge-small-en-v1.5` with `local_files_only=True` (`HF_HUB_OFFLINE=1`) and optional ONNX Runtime graph caching under `~/.cache/kizuki-embed/BAAI--bge-small-en-v1.5/model.onnx` (or `--onnx-cache-dir`).
- **Wire Contracts**:
  - `POST /v1/embeddings` — OpenAI-compatible embeddings endpoint (`api = "openai"`).
  - `POST /api/embed` — Ollama-compatible embeddings endpoint (`api = "ollama"`).
  - `GET /health` — Readiness, RSS memory (`rss_mib`), request count, and latency telemetry.
  - `GET /v1/models` — Pinned model metadata.
- **Security & Privacy**:
  - Refuses to bind any non-loopback address (`127.0.0.0/8` or `::1` only).
  - Never logs query or document text.
  - Responds with explicit `Content-Length` and `Connection: close` matching Kizuki's raw socket client (`packages/embed-local-http/src/http.ts`).

## Exact `.kizuki/serve.toml` Wiring

```toml
[ports]
retrieval = { id = "kizuki.retrieval.embedded-pg", max_text_bytes = 268435456 }

[ports.embedding]
id = "kizuki.embedding.local-http"
api = "openai"
endpoint = "http://127.0.0.1:8789"
model = "BAAI/bge-small-en-v1.5"
dims = 384
max_input_tokens = 512
chunk_tokens = 384
chunk_overlap = 56
batch_size = 32
timeout_ms = 30000
prompt_query = "Represent this sentence for searching relevant passages: {q}"
prompt_doc = "{title}\n\n{text}"
```
