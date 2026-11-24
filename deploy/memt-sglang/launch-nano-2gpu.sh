#!/usr/bin/env bash
set -euo pipefail

# One-command RunPod / SGLang launcher for MemTensor/MemT-1.0-Nano (2x GPU).
# Binds to loopback 127.0.0.1:30000 by default for secure SSH tunneling to the Kizuki VPS.

MODEL_PATH="${MEMT_MODEL_PATH:-MemTensor/MemT-1.0-Nano}"
HOST="${MEMT_HOST:-127.0.0.1}"
PORT="${MEMT_PORT:-30000}"
TP_SIZE="${MEMT_TP_SIZE:-2}"
MEM_FRACTION="${MEMT_MEM_FRACTION:-0.85}"
SNAPSHOT_DIR="${MEMT_SNAPSHOT_DIR:-/workspace/memt-snapshots/nano}"
LOG_FILE="${MEMT_LOG_FILE:-/workspace/memt-nano.log}"
PYTHON_BIN="${MEMT_PYTHON_BIN:-python3}"

mkdir -p "$SNAPSHOT_DIR"
chmod 700 "$SNAPSHOT_DIR"

echo "[memt-nano] Launching ${MODEL_PATH} on ${HOST}:${PORT} (tp=${TP_SIZE})"
echo "[memt-nano] Snapshot directory: ${SNAPSHOT_DIR}"

CMD=(
  "$PYTHON_BIN" -m sglang.launch_server
  --model-path "$MODEL_PATH"
  --host "$HOST"
  --port "$PORT"
  --tp "$TP_SIZE"
  --mem-fraction-static "$MEM_FRACTION"
  --enable-memt
  --memt-snapshot-dir "$SNAPSHOT_DIR"
  --trust-remote-code
)

if [[ -n "${MEMT_API_KEY:-}" ]]; then
  CMD+=(--api-key "$MEMT_API_KEY")
fi

if [[ "${MEMT_FOREGROUND:-0}" == "1" ]]; then
  exec "${CMD[@]}"
fi

nohup "${CMD[@]}" >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "[memt-nano] Started SGLang PID=${SERVER_PID}, waiting for /memt/capabilities..."

AUTH_HEADER=()
if [[ -n "${MEMT_API_KEY:-}" ]]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${MEMT_API_KEY}")
fi

for _ in $(seq 1 180); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[memt-nano] Server exited prematurely; check ${LOG_FILE}" >&2
    exit 1
  fi
  if curl -fsS --max-time 2 "${AUTH_HEADER[@]}" "http://${HOST}:${PORT}/memt/capabilities" >/dev/null 2>&1; then
    echo "[memt-nano] Ready! Identity & capabilities:"
    curl -fsS --max-time 5 "${AUTH_HEADER[@]}" "http://${HOST}:${PORT}/memt/identity" && echo ""
    curl -fsS --max-time 5 "${AUTH_HEADER[@]}" "http://${HOST}:${PORT}/memt/capabilities" && echo ""
    exit 0
  fi
  sleep 2
done

echo "[memt-nano] Timed out waiting for http://${HOST}:${PORT}/memt/capabilities" >&2
exit 1
