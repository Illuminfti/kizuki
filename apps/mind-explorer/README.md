# Kizuki Mind Explorer

Local-first web workbench for exploring a Kizuki vault, decision ledger, people intelligence, taste calibration studio, mind codex, and live local AI telemetry. Runs directly on Bun with zero external runtime dependencies.

## Quick Start

```bash
cd apps/mind-explorer
KIZUKI_VAULT=/path/to/your/vault bun run start
```

Open `http://127.0.0.1:8797` in your browser.

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `KIZUKI_VAULT` (or `KIZUKI_VAULT_PATH`) | `~/Kizuki` | Root directory of your local Kizuki vault |
| `KIZUKI_PORT` (or `PORT`) | `8797` | Loopback HTTP port |
| `KIZUKI_HOST` | `127.0.0.1` | Bind interface (defaults strictly to loopback) |
| `KIZUKI_EXPLORER_PUBLIC` | `./public` | Static assets directory |
| `KIZUKI_LLM_ENDPOINT` | `http://127.0.0.1:8003/v1/chat/completions` | Optional local OpenAI-compatible inference endpoint |
| `KIZUKI_LLM_MODEL` | `local-model` | Model ID sent to `KIZUKI_LLM_ENDPOINT` |
| `KIZUKI_OWNER_NAME` | _(unset)_ | Optional owner display name used to classify outbound messages |
| `KIZUKI_OWNER_EMAILS` | _(unset)_ | Optional comma-separated owner emails used to classify outbound messages |

## Workspace Views

- **Today**: Daily chronometer, proactive briefing, schedule, inbox radar, open commitments, and pending decision gates.
- **Flow Deck**: Vault explorer, knowledge graph, markdown reader/editor, and life replay timeline/map.
- **Board**: Local Agent Board threads, orchestrator queue, decision verdicts, and live mesh canvas.
- **People**: Relationship radar, cross-channel cadence visuals, dossier cards, and local-only meeting prep drafts.
- **Taste**: Multi-domain calibration cards, rule synthesis, and autonomous domain gardener console.
- **Codex**: Living operating principles, interests, hobbies, projects, and action plane constellation.
- **AI Live**: Local host AI process radar and neural observatory (`Alt+I`).

## Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| `1` - `5` | Switch primary workspace views |
| `Cmd+K` / `Ctrl+K` | Open unified Command Plane and hybrid search |
| `Alt+I` | Toggle Box AI Live Observatory |
| `Alt+U` | Toggle UI/UX Studio Drawer |
| `?` | Show keyboard shortcut reference |

## Local-Only Privacy Boundary

- Binds to `127.0.0.1` by default and serves self-hosted Geist fonts with zero third-party font CDNs or telemetry.
- All reply drafts, meeting prep packs, and context briefs stay strictly local and never transmit outbound messages.
- Secret-pattern detection blocks and redacts API keys, tokens, and private key blocks before persistence or display.

## Testing

```bash
cd apps/mind-explorer
bun test
```
