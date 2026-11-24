# MemT-1.0 SGLang Deployment Kit for Kizuki

One-command launchers for running **MemTensor/MemT-1.0** (`memt_sglang` speaking `memt-http-v1`) on a RunPod/GPU host and securely tunneling it to `127.0.0.1:30000` on the Kizuki VPS.

## 1. GPU Sizing & Launch Scripts

| Model | Script | GPUs (`--tp`) | Default Port |
| --- | --- | --- | --- |
| `MemTensor/MemT-1.0-Nano` | `./launch-nano-2gpu.sh` | 2x GPU | `127.0.0.1:30000` |
| `MemTensor/MemT-1.0-Flash` | `./launch-flash-8gpu.sh` | 8x GPU | `127.0.0.1:30000` |
| `MemTensor/MemT-1.0-Pro` | `./launch-pro-8gpu.sh` | 8x GPU | `127.0.0.1:30000` |

Run on the GPU pod (after installing `memt_sglang` and setting `HF_TOKEN` if required):

```bash
./launch-nano-2gpu.sh
```

Environment overrides:
- `MEMT_MODEL_PATH`: local checkpoint path or HuggingFace model ID
- `MEMT_HOST` / `MEMT_PORT`: bind address (keep `127.0.0.1:30000` for SSH tunnel)
- `MEMT_SNAPSHOT_DIR`: directory for `memt-memory-v1` `.safetensors` exports
- `MEMT_API_KEY`: optional Bearer token (never commit secrets)
- `MEMT_FOREGROUND=1`: run in foreground instead of `nohup`

## 2. VPS SSH Tunnel (`systemd --user`)

Create a `0600` environment file on the VPS:

```bash
mkdir -p ~/.config/kizuki && chmod 700 ~/.config/kizuki
cat > ~/.config/kizuki/memt-tunnel.env <<'EOF'
MEMT_SSH_TARGET=root@<runpod-ip>
MEMT_SSH_PORT=<runpod-ssh-port>
MEMT_SSH_KEY=/home/ubuntu/.ssh/id_ed25519
MEMT_LOCAL_PORT=30000
MEMT_REMOTE_PORT=30000
EOF
chmod 600 ~/.config/kizuki/memt-tunnel.env
```

Install and enable the user unit:

```bash
mkdir -p ~/.config/systemd/user
cp kizuki-memt-tunnel.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now kizuki-memt-tunnel.service
```

Verify the tunnel from the VPS:

```bash
curl -fsS http://127.0.0.1:30000/memt/identity
curl -fsS http://127.0.0.1:30000/memt/capabilities
```

## 3. Configure Kizuki (`serve.toml` or Environment)

Add an optional `[memt]` section to `<vault>/.kizuki/serve.toml`:

```toml
[memt]
enabled = true
url = "http://127.0.0.1:30000"
probe_timeout_ms = 1200
offline_backoff_ms = 15000
lease_ttl_seconds = 300
```

Or override via environment variables:
- `KIZUKI_MEMT_URL=http://127.0.0.1:30000`
- `KIZUKI_MEMT_API_KEY=...` (optional)

## 4. Offline & Restart Safety

- When the GPU pod is paused or unreachable, `@kizuki/memt` degrades automatically to `local-hybrid` (`gpu_backend: "offline"`) using the local SQLite Experience Bank + Kizuki System-2 RRF fusion with probe backoff so reads never stall.
- On GPU restart, `epoch` changes; `MemTSession.recover()` detects the restart and refuses to blindly replay uncertain writes.
- Every `.safetensors` snapshot is validated against `memt-memory-v1` (F32 4D `[1, heads, K, V]`, rejecting legacy `memory.layers.*`) and custody-tracked in `.kizuki/memt/registry.sqlite` (0600 permissions) so purged sources immediately invalidate affected snapshots.
