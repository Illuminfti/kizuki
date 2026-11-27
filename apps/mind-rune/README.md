# Kizuki Mind OS (Native Rune Desktop Client)

Native Rust GPU desktop client for Kizuki Mind OS built on [Anomaly Rune](https://github.com/anomalyco/rune) (`#![forbid(unsafe_code)]`, pinned rev `d8285c3a5d5c014bdab0a8fb8a4c23f5e15fd887`). Renders natively on Apple Metal (macOS) and Vulkan/wgpu (Linux) with a unified macOS titlebar, a 90/8/2 anodized graphite dark and warm porcelain light palette, and a strict 7-size / 3-weight typographic scale (`>= 11.0px` floor with tabular numerals).

## Views

- **Flow Deck (`1`)**: Data-driven cubic Bezier Sankey ribbons connecting intake sources, active workers, rooms, the elevated owner decision plate, and knowledge sinks, paired with a 72px hardware/seat headroom rail.
- **Board (`2`)**: 3-pane workspace (agent presence rail, filterable signal stream, editorial thread reader) with optimistic durable verdict stamps (`A` / `R` / `D`), 30-second undo (`U`), and local note capture.
- **Today (`3`)**: Editorial date masthead, architectural 24-hour Day Dial with live time needle and event lanes, ranked next moves, meeting prep, open commitments, schedule, and pipeline status.
- **Mind (`4`)**: 8-axis Taste Calibration Radar, domain ledger, active gardeners, personal Codex overview, and a log-time People Cadence ribbon.
- **AI Live (`5`)**: 4-lane live worker observatory (`Building`, `Designing`, `Predicting`, `Orchestrating`) wired through a crossing-minimized cubic conduit manifold to shared resources.

## Quick Start

Run against a local `apps/mind-explorer` server (default `http://127.0.0.1:8797`, booting immediately on the bundled synthetic snapshot while hydrating live data in the background):

```bash
cd apps/mind-rune
cargo run --release -- --api http://127.0.0.1:8797
```

You can also set the API endpoint via environment variable:

```bash
KIZUKI_API_URL=http://127.0.0.1:8797 cargo run --release
```

Run fully offline using the bundled synthetic demo snapshot (`assets/live-snapshot.json`, zero network calls):

```bash
cargo run --release -- --offline
```

Run the automated headless GPU verification and visual restraint suite (spins up an ephemeral loopback mock server, asserts `< 300ms` boot-to-first-frame, ETag `304` polling, decision write-back + HTTP 500 rollback, zero idle frames over 10s, `>= 11.0px` typography floor, 90/8/2 restraint ratios, and writes `1440x900` PNGs + `element-tree.json` to `/tmp/rune-shots/`):

```bash
cargo run -- --headless
```

## Keyboard Shortcuts

- `1` - `5`: Switch between Flow Deck, Board, Today, Mind, and AI Live
- `J` / `K` or `Up` / `Down`: Move active selection
- `A` / `R` / `D`: Stamp Approve, Revise, or Defer on the selected decision gate
- `U`: Undo the last confirmed verdict within 30 seconds
- `Enter`: Inspect the selected gate or move in Board
- `T`: Toggle anodized graphite dark and warm porcelain light polarity
- `Cmd+K` / `Ctrl+K`: Open command palette, semantic memory recall, and local quick capture (`capture note ...`, `capture action ...`)
- `?`: Open keyboard shortcut sheet
- `Esc`: Close overlays, clear filters, or dismiss banners

## Architecture

- `src/main.rs`: `#![forbid(unsafe_code)]`, instant embedded boot, unified 44px macOS titlebar, frame latency logging, visibility-aware poll pausing, and `ambient_fps(30.0)`.
- `src/data.rs`: SSE live push + smart delta version polling (`/api/live/status`), conditional `If-None-Match` ETag fallback, decision write-back (`/api/decisions/stamp`), proactive intel briefing, semantic recall, local quick capture, and rolling sparkline telemetry.
- `src/state.rs`: Optimistic decision write-back worker with idempotency keys, 30s undo, clean rollback on failure, verdict audit ledger, hover isolation, and command palette filtering.
- `src/theme.rs`: Dual-polarity anodized graphite dark and warm porcelain light palette tokens, focus ring, tabular numeral typography scale, and unboxed hairline kit primitives.
- `src/views/`: `flow_deck.rs`, `board.rs`, `today.rs`, `mind.rs`, and `chrome.rs`.
- `src/headless.rs`: Ephemeral loopback mock HTTP server and deterministic offscreen GPU visual/restraint verification suite.
- `assets/live-snapshot.json`: 100% synthetic demo dataset so every view renders richly offline with zero personal data.
