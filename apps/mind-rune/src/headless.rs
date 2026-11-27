//! Deterministic headless GPU PNG renderer, ephemeral loopback mock-server integration suite,
//! keyboard/write-back assertions, idle-frame check, font-floor audit, and column-occupancy proof.

use std::collections::BTreeSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rune::color::srgb_decode;
use rune::render::{Gpu, OFFSCREEN_FORMAT, Offscreen, Renderer, write_png};
use rune::{Color, Env, Key, KeyEvent, Mods, Runtime, TextEdit};
use serde_json::{Value, json};

use crate::data::{ConnectionState, PollClient, PollTier, SnapshotData};
use crate::state::{ActiveView, AppState, CommitmentOp, DecisionVerdict};
use crate::views::root_view;

const W: f32 = 1440.0;
const H: f32 = 900.0;
const SCALE: f32 = 1.0;

struct MockServerState {
    base_snapshot: Value,
    stop: AtomicBool,
    version: AtomicU64,
    vault_version: AtomicU64,
    fail_next_stamp: AtomicBool,
    extra_blocker: AtomicBool,
    stamp_posts: Mutex<Vec<String>>,
    commitment_posts: Mutex<Vec<String>>,
    capture_posts: Mutex<Vec<String>>,
    not_modified_hits: AtomicUsize,
}

struct MockServerHandle {
    base_url: String,
    state: Arc<MockServerState>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl MockServerHandle {
    fn start() -> Result<Self, String> {
        let embedded_raw = include_str!("../assets/live-snapshot.json");
        let base_snapshot: Value =
            serde_json::from_str(embedded_raw).map_err(|e| format!("parse embedded: {e}"))?;
        let listener =
            TcpListener::bind("127.0.0.1:0").map_err(|e| format!("bind mock server: {e}"))?;
        let addr = listener.local_addr().map_err(|e| e.to_string())?;
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("set_nonblocking: {e}"))?;

        let state = Arc::new(MockServerState {
            base_snapshot,
            stop: AtomicBool::new(false),
            version: AtomicU64::new(1),
            vault_version: AtomicU64::new(1),
            fail_next_stamp: AtomicBool::new(false),
            extra_blocker: AtomicBool::new(false),
            stamp_posts: Mutex::new(Vec::new()),
            commitment_posts: Mutex::new(Vec::new()),
            capture_posts: Mutex::new(Vec::new()),
            not_modified_hits: AtomicUsize::new(0),
        });

        let st = state.clone();
        let join = std::thread::Builder::new()
            .name("kizuki-mock-server".into())
            .spawn(move || {
                while !st.stop.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let _ = handle_http_conn(stream, &st);
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(_) => break,
                    }
                }
            })
            .map_err(|e| format!("spawn mock server: {e}"))?;

        Ok(Self {
            base_url: format!("http://127.0.0.1:{}", addr.port()),
            state,
            join: Some(join),
        })
    }

    fn shutdown(&mut self) {
        self.state.stop.store(true, Ordering::SeqCst);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

impl Drop for MockServerHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn handle_http_conn(mut stream: TcpStream, st: &MockServerState) -> Result<(), String> {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);

    let mut request_line = String::new();
    if reader.read_line(&mut request_line).map_err(|e| e.to_string())? == 0 {
        return Ok(());
    }
    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 {
        return Ok(());
    }
    let method = parts[0];
    let path = parts[1];

    let mut content_length = 0usize;
    let mut if_none_match: Option<String> = None;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).map_err(|e| e.to_string())?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            let kl = k.trim().to_ascii_lowercase();
            let val = v.trim();
            if kl == "content-length" {
                content_length = val.parse().unwrap_or(0);
            } else if kl == "if-none-match" {
                if_none_match = Some(val.to_string());
            }
        }
    }

    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        reader.read_exact(&mut body).map_err(|e| e.to_string())?;
    }
    let body_str = String::from_utf8_lossy(&body).to_string();

    if method == "POST" && (path == "/api/decisions/stamp" || path == "/api/decisions/undo") {
        if let Ok(mut posts) = st.stamp_posts.lock() {
            posts.push(body_str);
        }
        if st.fail_next_stamp.swap(false, Ordering::SeqCst) {
            let resp = "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: 27\r\n\r\n{\"error\":\"mock_write_fail\"}";
            let _ = stream.write_all(resp.as_bytes());
            return Ok(());
        }
        let resp = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: 11\r\n\r\n{\"ok\":true}";
        let _ = stream.write_all(resp.as_bytes());
        return Ok(());
    }

    if method == "POST" && path == "/api/intel/commitment" {
        if let Ok(mut posts) = st.commitment_posts.lock() {
            posts.push(body_str);
        }
        let resp = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: 11\r\n\r\n{\"ok\":true}";
        let _ = stream.write_all(resp.as_bytes());
        return Ok(());
    }

    if method == "POST" && path == "/api/capture/quick" {
        if let Ok(mut posts) = st.capture_posts.lock() {
            posts.push(body_str);
        }
        let resp = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: 11\r\n\r\n{\"ok\":true}";
        let _ = stream.write_all(resp.as_bytes());
        return Ok(());
    }

    if method == "GET" && path == "/api/live/status" {
        let board_v = st.version.load(Ordering::SeqCst);
        let vault_v = st.vault_version.load(Ordering::SeqCst);
        let payload = json!({
            "versions": { "vault": vault_v, "board": board_v },
            "sse": true
        })
        .to_string();
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
            payload.len(),
            payload
        );
        let _ = stream.write_all(resp.as_bytes());
        return Ok(());
    }

    if method == "GET" && path.starts_with("/api/semantic/recall") {
        let payload = json!({
            "hits": [
                {
                    "id": "sem-vault-1",
                    "kind": "vault",
                    "title": "Kizuki Vault Claim Synthesis Architecture",
                    "subtitle": "Mind & Codex · MemT verified",
                    "snippet": "Hybrid BM25 + dense vector recall across 13K canon pages with zero cloud dependency.",
                    "score": 0.94,
                    "match_mode": "neural",
                    "target_view": "mind",
                    "target_ref": "vault-claim-cap"
                },
                {
                    "id": "sem-board-2487",
                    "kind": "thread",
                    "title": "Owner Gate #2487: Vault Synthesis Throughput Cap",
                    "subtitle": "kizuki/decisions · 34h waiting",
                    "snippet": "Approve nightly gardener synthesis budget before expanding local GPU queue.",
                    "score": 0.89,
                    "match_mode": "neural",
                    "target_view": "board",
                    "target_ref": "2487"
                }
            ]
        })
        .to_string();
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
            payload.len(),
            payload
        );
        let _ = stream.write_all(resp.as_bytes());
        return Ok(());
    }

    if method == "POST" && path == "/api/command/resolve" {
        let payload = json!({
            "verb": "inspect",
            "preview": "Inspect #2487 Kizuki vault rollout",
            "target": { "kind": "thread", "id": "2487" }
        })
        .to_string();
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
            payload.len(),
            payload
        );
        let _ = stream.write_all(resp.as_bytes());
        return Ok(());
    }

    let ver = st.version.load(Ordering::SeqCst);
    let etag = format!("\"kizuki-v{ver}\"");
    if if_none_match.as_deref() == Some(etag.as_str()) {
        st.not_modified_hits.fetch_add(1, Ordering::SeqCst);
        let resp = format!(
            "HTTP/1.1 304 Not Modified\r\nETag: {etag}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
        );
        let _ = stream.write_all(resp.as_bytes());
        return Ok(());
    }

    let payload_val: Option<Value> = match path {
        "/api/agent-board/health" => Some(st.base_snapshot["health"].clone()),
        "/api/agent-board/mission?limit=15" => Some(st.base_snapshot["mission"].clone()),
        "/api/agent-board/agents" => Some(st.base_snapshot["agents"].clone()),
        "/api/agent-board/blockers" => {
            let mut b = st.base_snapshot["blockers"].clone();
            if st.extra_blocker.load(Ordering::SeqCst)
                && let Some(arr) = b.get_mut("orchestratorQueue").and_then(|v| v.as_array_mut())
            {
                arr.insert(
                    0,
                    json!({
                        "id": "9991",
                        "channel": "kizuki/decisions",
                        "project": "kizuki",
                        "text": "Live-polled owner decision gate injected without restart",
                        "recommendation": "Approve live worker promotion after E2E check.",
                        "state": "blocked",
                        "by": "codex-live",
                        "created_at": "2026-11-27T00:10:00.000Z",
                        "replies": 2
                    }),
                );
            }
            Some(b)
        }
        "/api/today" => Some(st.base_snapshot["today"].clone()),
        "/api/taste" => Some(st.base_snapshot["taste"].clone()),
        "/api/taste/gardeners" => Some(st.base_snapshot["gardeners"].clone()),
        "/api/codex" => Some(st.base_snapshot["codex"].clone()),
        "/api/today/next-moves" => Some(json!({
            "moves": [
                {
                    "id": "nm-2487",
                    "kind": "decision",
                    "title": "Approve Kizuki vault claim synthesis cap",
                    "why_now": "Owner gate #2487 blocked 34h in kizuki/decisions",
                    "score": 96.0,
                    "verbs": ["approve", "revise", "defer"],
                    "thread_id": "2487"
                },
                {
                    "id": "nm-2494",
                    "kind": "decision",
                    "title": "Confirm local GPU nightly gardener schedule",
                    "why_now": "Owner gate #2494 waiting 29h with agent recommendation",
                    "score": 88.0,
                    "verbs": ["approve", "inspect"],
                    "thread_id": "2494"
                },
                {
                    "id": "nm-ws-1",
                    "kind": "workstream",
                    "title": "Ship Kizuki Mind OS Rune live GPU client",
                    "why_now": "All 10 hill-climb lanes integrating on loopback",
                    "score": 82.0,
                    "verbs": ["open"],
                    "thread_id": null
                }
            ]
        })),
        "/api/intel/briefing" => Some(json!({
            "summary": "2 meetings prepped · 3 open commitments · Local GPU synth ready",
            "meeting_preps": [
                {
                    "id": "mp-1",
                    "title": "Kizuki Mind OS Wave 3 Ship Review",
                    "time_label": "10:30",
                    "attendees": ["Owner", "Keeper", "Planner"],
                    "last_touch": "18m ago on #kizuki",
                    "open_loops_count": 2,
                    "talking_points": [
                        "Verify zero-idle-frame SSE delta polling and semantic recall latency",
                        "Lock local quick-capture routing to Today and Codex"
                    ]
                },
                {
                    "id": "mp-2",
                    "title": "Local GPU Gardener Budget Sync",
                    "time_label": "14:00",
                    "attendees": ["Owner", "Atlas"],
                    "last_touch": "4h ago in vault",
                    "open_loops_count": 1,
                    "talking_points": [
                        "Confirm nightly vault claim synthesis cap before promotion"
                    ]
                }
            ],
            "commitments": [
                {
                    "id": "cm-101",
                    "kind": "deliverable",
                    "title": "Confirm Rune GPU Wave 3 headless & release build proof",
                    "person": "Owner",
                    "channel": "kizuki/decisions",
                    "age_hours": 3.0,
                    "urgency": "high",
                    "status": "open"
                },
                {
                    "id": "cm-102",
                    "kind": "followup",
                    "title": "Send local GPU nightly gardener telemetry cap",
                    "person": "Atlas",
                    "channel": "board/ops",
                    "age_hours": 14.0,
                    "urgency": "medium",
                    "status": "open"
                },
                {
                    "id": "cm-103",
                    "kind": "review",
                    "title": "Audit MemT taste experiences synced from workstation overlay",
                    "person": "Keeper",
                    "channel": "vault/taste",
                    "age_hours": 26.0,
                    "urgency": "normal",
                    "status": "open"
                }
            ],
            "cross_signals": [
                {
                    "id": "xs-1",
                    "kind": "CROSS",
                    "title": "Vault & Board converge on Gate #2487",
                    "detail": "2 threads + 1 calendar block reference synthesis cap"
                }
            ]
        })),
        "/api/decisions/pending" => {
            let mut items = Vec::new();
            if st.extra_blocker.load(Ordering::SeqCst) {
                items.push(json!({
                    "threadId": "9991",
                    "channel": "kizuki/decisions",
                    "title": "Live-polled owner decision gate injected without restart",
                    "text": "Live-polled owner decision gate injected without restart",
                    "recommendation": "Approve live worker promotion after E2E check.",
                    "by": "codex-live",
                    "created_at": "2026-11-27T00:10:00.000Z",
                    "replies": 2
                }));
            }
            Some(json!({ "pending": items }))
        }
        "/api/box/ai-live" => Some(json!({
            "summary": {
                "total_live": 8,
                "building": 3,
                "designing": 2,
                "predicting": 1,
                "orchestrating": 2,
                "total_cpu_pct": 164.8,
                "total_ram_mb": 5240.0
            },
            "agents": [
                {
                    "id": "ai-codex-rune",
                    "name": "Codex Rune W5",
                    "runtime": "codex",
                    "category": "building",
                    "state": "running",
                    "pid": 41822,
                    "cpu_pct": 44.2,
                    "ram_mb": 980.0,
                    "repo": "kizuki-mind-rune",
                    "current_action": "Compiling GPU canvas ribbons and scene layout",
                    "active_tool": "cargo-build"
                },
                {
                    "id": "ai-claude-api",
                    "name": "Claude API W1",
                    "runtime": "claude",
                    "category": "building",
                    "state": "running",
                    "pid": 41905,
                    "cpu_pct": 28.4,
                    "ram_mb": 720.0,
                    "repo": "kizuki-mind-web",
                    "current_action": "Streaming live process telemetry and edge topology",
                    "active_tool": "node-server"
                },
                {
                    "id": "ai-codex-vault",
                    "name": "Vault Indexer",
                    "runtime": "codex",
                    "category": "building",
                    "state": "running",
                    "pid": 41940,
                    "cpu_pct": 16.5,
                    "ram_mb": 640.0,
                    "repo": "Kizuki",
                    "current_action": "Refreshing MemT vector shards and BM25 claim index",
                    "active_tool": "kizuki-cli"
                },
                {
                    "id": "ai-neon-ui",
                    "name": "Neon Visual W3",
                    "runtime": "neon",
                    "category": "designing",
                    "state": "running",
                    "pid": 42018,
                    "cpu_pct": 22.1,
                    "ram_mb": 810.0,
                    "repo": "kizuki-mind-rune",
                    "current_action": "Auditing dual-polarity OKLCH contrast and optical waveguide glow",
                    "active_tool": "wgpu-render"
                },
                {
                    "id": "ai-critic-pass",
                    "name": "Pixel Critic",
                    "runtime": "gemini",
                    "category": "designing",
                    "state": "running",
                    "pid": 42064,
                    "cpu_pct": 11.8,
                    "ram_mb": 490.0,
                    "repo": "kizuki-mind-web",
                    "current_action": "Comparing 1440x900 headless captures for typography floor >= 11px",
                    "active_tool": "png-audit"
                },
                {
                    "id": "ai-local-pred",
                    "name": "Local Forecaster",
                    "runtime": "gpu-synth",
                    "category": "predicting",
                    "state": "running",
                    "pid": 42110,
                    "cpu_pct": 19.6,
                    "ram_mb": 910.0,
                    "repo": "vault/taste",
                    "current_action": "Scoring overnight claim drift and MemT skill promotion curves",
                    "active_tool": "gpu-infer"
                },
                {
                    "id": "ai-keeper-orch",
                    "name": "Keeper",
                    "runtime": "keeper",
                    "category": "orchestrating",
                    "state": "running",
                    "pid": 41102,
                    "cpu_pct": 12.4,
                    "ram_mb": 390.0,
                    "repo": "agent-board",
                    "current_action": "Routing owner decision gates #2487 and #2494 across active lanes",
                    "active_tool": "board-dispatch"
                },
                {
                    "id": "ai-atlas-loop",
                    "name": "Atlas Ambient",
                    "runtime": "ambient",
                    "category": "orchestrating",
                    "state": "running",
                    "pid": 41088,
                    "cpu_pct": 9.8,
                    "ram_mb": 300.0,
                    "repo": "kizuki/ops",
                    "current_action": "Coordinating inbox radar, calendar preps, and live SSE pulses",
                    "active_tool": "sse-relay"
                }
            ],
            "resources": [
                {
                    "id": "res-kizuki-vault",
                    "label": "Kizuki Vault",
                    "kind": "BRAIN",
                    "metric": "13.2K canon, 100K+ events",
                    "active_count": 3
                },
                {
                    "id": "res-agent-board",
                    "label": "Agent Board :4100",
                    "kind": "BUS",
                    "metric": "SQLite WAL, SSE live",
                    "active_count": 2
                },
                {
                    "id": "res-kizuki-rune",
                    "label": "kizuki-mind-rune",
                    "kind": "REPO",
                    "metric": "Rust GPU native client",
                    "active_count": 3
                },
                {
                    "id": "res-kizuki-web",
                    "label": "kizuki-mind-web",
                    "kind": "REPO",
                    "metric": "API :8797 · live telemetry",
                    "active_count": 2
                },
                {
                    "id": "res-local-gpu",
                    "label": "Local GPU Synth",
                    "kind": "GPU",
                    "metric": "Local synth ready",
                    "active_count": 2
                }
            ],
            "edges": [
                {
                    "id": "edge-1",
                    "from": "ai-codex-rune",
                    "to": "res-kizuki-rune",
                    "category": "building",
                    "label": "wgpu compile",
                    "weight": 1.8,
                    "cpu_pct": 44.2,
                    "active": true
                },
                {
                    "id": "edge-2",
                    "from": "ai-claude-api",
                    "to": "res-kizuki-web",
                    "category": "building",
                    "label": "telemetry stream",
                    "weight": 1.3,
                    "cpu_pct": 28.4,
                    "active": true
                },
                {
                    "id": "edge-3",
                    "from": "ai-codex-vault",
                    "to": "res-kizuki-vault",
                    "category": "building",
                    "label": "MemT index",
                    "weight": 1.0,
                    "cpu_pct": 16.5,
                    "active": true
                },
                {
                    "id": "edge-4",
                    "from": "ai-neon-ui",
                    "to": "res-kizuki-rune",
                    "category": "designing",
                    "label": "OKLCH shader",
                    "weight": 1.4,
                    "cpu_pct": 22.1,
                    "active": true
                },
                {
                    "id": "edge-5",
                    "from": "ai-critic-pass",
                    "to": "res-kizuki-web",
                    "category": "designing",
                    "label": "pixel audit",
                    "weight": 0.9,
                    "cpu_pct": 11.8,
                    "active": true
                },
                {
                    "id": "edge-6",
                    "from": "ai-local-pred",
                    "to": "res-local-gpu",
                    "category": "predicting",
                    "label": "GPU inference",
                    "weight": 1.5,
                    "cpu_pct": 19.6,
                    "active": true
                },
                {
                    "id": "edge-7",
                    "from": "ai-local-pred",
                    "to": "res-kizuki-vault",
                    "category": "predicting",
                    "label": "claim forecast",
                    "weight": 1.1,
                    "cpu_pct": 14.0,
                    "active": true
                },
                {
                    "id": "edge-8",
                    "from": "ai-keeper-orch",
                    "to": "res-agent-board",
                    "category": "orchestrating",
                    "label": "gate dispatch",
                    "weight": 1.2,
                    "cpu_pct": 12.4,
                    "active": true
                },
                {
                    "id": "edge-9",
                    "from": "ai-atlas-loop",
                    "to": "res-kizuki-vault",
                    "category": "orchestrating",
                    "label": "ambient sync",
                    "weight": 0.95,
                    "cpu_pct": 9.8,
                    "active": true
                }
            ]
        })),
        _ => None,
    };

    match payload_val {
        Some(v) => {
            let json_str = v.to_string();
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nETag: {etag}\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                json_str.len(),
                json_str
            );
            let _ = stream.write_all(resp.as_bytes());
        }
        None => {
            let resp = "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
            let _ = stream.write_all(resp.as_bytes());
        }
    }
    Ok(())
}

fn press_text_key(rt: &mut Runtime<AppState>, ch: &str) {
    rt.key(KeyEvent {
        key: Key::Text(ch.to_string()),
        mods: Mods::default(),
    });
}

fn wait_for_write_outcome(rt: &mut Runtime<AppState>, timeout_ms: u64) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    while Instant::now() < deadline {
        let mut drained = 0usize;
        rt.update(|st, tx| {
            drained = st.drain_write_outcomes();
            if drained > 0 {
                tx.animated();
            }
        });
        if drained > 0 {
            for _ in 0..35 {
                rt.frame(1.0 / 60.0);
            }
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(8));
    }
    Err("timed out waiting for background write-back outcome".into())
}

fn audit_font_floor(rt: &Runtime<AppState>, scene: &str) -> Result<f32, String> {
    let mut min_px = f32::INFINITY;
    let mut offenders = Vec::new();
    for el in rt.elements() {
        if let Some(style) = el.text_style {
            if style.size < min_px {
                min_px = style.size;
            }
            if style.size < 11.0 {
                offenders.push(format!(
                    "{} ({:?}): {:.1}px",
                    el.path,
                    el.text.as_deref().unwrap_or(""),
                    style.size
                ));
            }
        }
    }
    if !offenders.is_empty() {
        return Err(format!(
            "scene `{scene}` has text under 11.0px: {}",
            offenders.join(", ")
        ));
    }
    Ok(if min_px.is_finite() { min_px } else { 11.0 })
}

fn audit_flow_column_occupancy(rt: &Runtime<AppState>) -> Result<Value, String> {
    let els = rt.elements();
    let checks = [
        ("col-asks", "ask-4"),
        ("col-works", "worker-4"),
        ("col-lands", "room-4"),
        ("col-becomes", "sink-4"),
    ];
    let mut ratios = serde_json::Map::new();
    for (col_key, last_card_key) in checks {
        let col_el = els
            .iter()
            .find(|e| e.key.as_deref() == Some(col_key))
            .ok_or_else(|| format!("missing flow column `{col_key}`"))?;
        let card_el = els
            .iter()
            .find(|e| e.key.as_deref() == Some(last_card_key))
            .ok_or_else(|| format!("missing last card `{last_card_key}` in `{col_key}`"))?;

        let col_top = col_el.rect[1];
        let col_h = col_el.rect[3].max(1.0);
        let card_bottom = card_el.rect[1] + card_el.rect[3];
        let occupancy = ((card_bottom - col_top) / col_h).clamp(0.0, 1.0);
        ratios.insert(col_key.into(), json!((occupancy * 1000.0).round() / 1000.0));
        if occupancy < 0.90 {
            return Err(format!(
                "column `{col_key}` last card `{last_card_key}` bottom reaches only {:.1}% (< 90%)",
                occupancy * 100.0
            ));
        }
    }
    Ok(Value::Object(ratios))
}

fn color_oklab_chroma_and_bin(c: Color) -> (f32, i32) {
    let [_, a, b, _] = c.to_oklab();
    let chroma = a.hypot(b);
    let mut deg = b.atan2(a).to_degrees();
    if deg < 0.0 {
        deg += 360.0;
    }
    let bin = ((deg / 30.0).floor() as i32).rem_euclid(12);
    (chroma, bin)
}

fn audit_restraint(
    rt: &Runtime<AppState>,
    scene: &str,
    pixels: &[u8],
) -> Result<Value, String> {
    const ALLOWED_SIZES: [f32; 7] = [11.0, 12.0, 13.0, 14.0, 15.0, 20.0, 28.0];
    const ALLOWED_WEIGHTS: [f32; 3] = [400.0, 510.0, 600.0];
    const CHROMA_MIN: f32 = 0.07;
    const ALPHA_MIN: f32 = 0.5;

    let viewport_area = (W * H).max(1.0);
    let mut bordered_boxes = 0usize;
    let mut bordered_examples: Vec<String> = Vec::new();
    let mut chroma_area = 0.0_f32;
    let mut hue_bins: BTreeSet<i32> = BTreeSet::new();
    let mut distinct_sizes: BTreeSet<i32> = BTreeSet::new();
    let mut distinct_weights: BTreeSet<i32> = BTreeSet::new();
    let mut sizes_outside_scale = 0usize;
    let mut bad_size_examples: Vec<String> = Vec::new();
    let mut bad_weights: BTreeSet<i32> = BTreeSet::new();
    let mut total_text_runs = 0usize;
    let mut resolved_family_runs = 0usize;
    let mut mono_runs = 0usize;
    let mut caps_runs = 0usize;
    let mut caps_examples: Vec<String> = Vec::new();
    let mut api_strings = 0usize;
    let mut api_examples: Vec<String> = Vec::new();
    let mut em_dashes = 0usize;

    for el in rt.elements() {
        if el.exiting || el.opacity <= 0.01 {
            continue;
        }
        let vis_w = el.visible[2].max(0.0);
        let vis_h = el.visible[3].max(0.0);
        if vis_w <= 0.0 || vis_h <= 0.0 {
            continue;
        }

        // 1. Bordered boxes >= 24x24
        if let Some(bc) = el.border_color
            && bc.a > 0.02
            && el.rect[2] >= 24.0
            && el.rect[3] >= 24.0
        {
            bordered_boxes += 1;
            if bordered_examples.len() < 8 {
                let id = el.key.as_deref().unwrap_or(&el.path);
                bordered_examples.push(format!("{id}({:.0}x{:.0})", el.rect[2], el.rect[3]));
            }
        }

        // 2. Chromatic fill area ratio (element fills)
        if el.fill.a >= ALPHA_MIN {
            let (chroma, _) = color_oklab_chroma_and_bin(el.fill);
            if chroma >= CHROMA_MIN {
                chroma_area += vis_w * vis_h;
            }
        }

        // 3. Distinct 30-degree hue bins over fills, borders, and text colors
        for c in [Some(el.fill), el.border_color, el.text_color]
            .into_iter()
            .flatten()
        {
            if c.a >= ALPHA_MIN {
                let (chroma, bin) = color_oklab_chroma_and_bin(c);
                if chroma >= CHROMA_MIN {
                    hue_bins.insert(bin);
                }
            }
        }

        // 4 & 5. Typography scale, weights, and mono ratio
        if let Some(style) = &el.text_style {
            total_text_runs += 1;
            let size_tenths = (style.size * 10.0).round() as i32;
            distinct_sizes.insert(size_tenths);
            if !ALLOWED_SIZES.iter().any(|&s| (style.size - s).abs() <= 0.5) {
                sizes_outside_scale += 1;
                if bad_size_examples.len() < 6 {
                    bad_size_examples.push(format!("{:.1}px", style.size));
                }
            }

            let weight_i = style.weight.round() as i32;
            distinct_weights.insert(weight_i);
            if !ALLOWED_WEIGHTS
                .iter()
                .any(|&w| (style.weight - w).abs() <= 1.0)
            {
                bad_weights.insert(weight_i);
            }

            if let Some(fam) = &style.family {
                resolved_family_runs += 1;
                let fl = fam.to_ascii_lowercase();
                if fl.contains("mono")
                    || fl.contains("menlo")
                    || fl.contains("consolas")
                    || fl.contains("courier")
                {
                    mono_runs += 1;
                }
            }
        }

        // 6, 7 & 8. Caps runs (honoring OVERLINE uppercase transform), API strings, and em-dashes
        if let Some(txt) = el.text.as_deref() {
            let letters = txt.chars().filter(|c| c.is_alphabetic()).count();
            let has_lower = txt.chars().any(|c| c.is_lowercase());
            let is_overline_upper = el.text_style.as_ref().is_some_and(|ts| {
                ts.size <= 11.5 && ts.weight >= 590.0 && ts.tracking >= 0.5
            });
            if letters >= 4 && (!has_lower || is_overline_upper) {
                caps_runs += 1;
                if caps_examples.len() < 8 {
                    caps_examples.push(txt.chars().take(28).collect());
                }
            }
            if txt.contains("/api/") || txt.contains("127.0.0.1") {
                api_strings += 1;
                if api_examples.len() < 6 {
                    api_examples.push(txt.chars().take(48).collect());
                }
            }
            if txt.contains('\u{2014}') {
                em_dashes += 1;
            }
        }
    }

    // Pixel-level chromatic fill ratio across rendered RGBA8 frame (stride 2 for speed)
    let mut sampled_pixels = 0usize;
    let mut chromatic_pixels = 0usize;
    for px in pixels.as_chunks::<4>().0.iter().step_by(2) {
        sampled_pixels += 1;
        let c = Color {
            r: srgb_decode(px[0] as f32 / 255.0),
            g: srgb_decode(px[1] as f32 / 255.0),
            b: srgb_decode(px[2] as f32 / 255.0),
            a: px[3] as f32 / 255.0,
        };
        let (chroma, _) = color_oklab_chroma_and_bin(c);
        if chroma >= CHROMA_MIN {
            chromatic_pixels += 1;
        }
    }
    let pixel_chroma_ratio = if sampled_pixels > 0 {
        chromatic_pixels as f64 / sampled_pixels as f64
    } else {
        0.0
    };

    let chroma_area_ratio = (chroma_area / viewport_area) as f64;
    let mono_ratio_opt = if resolved_family_runs == 0 {
        eprintln!(
            "rune-headless: [restraint] scene `{scene}` resolved 0 font families; recording mono_ratio=null"
        );
        None
    } else {
        Some(mono_runs as f64 / total_text_runs.max(1) as f64)
    };

    let mut violations: Vec<String> = Vec::new();
    if bordered_boxes > 14 {
        violations.push(format!(
            "bordered_boxes={bordered_boxes} (> 14): [{}]",
            bordered_examples.join(", ")
        ));
    }
    if chroma_area_ratio > 0.02 {
        violations.push(format!(
            "chroma_area_ratio={chroma_area_ratio:.4} (> 0.02)"
        ));
    }
    if pixel_chroma_ratio > 0.05 {
        violations.push(format!(
            "pixel_chroma_ratio={pixel_chroma_ratio:.4} (> 0.05)"
        ));
    }
    if hue_bins.len() > 4 {
        violations.push(format!("hue_bins={} (> 4): {:?}", hue_bins.len(), hue_bins));
    }
    if distinct_sizes.len() > 8 {
        violations.push(format!("font_sizes={} (> 8)", distinct_sizes.len()));
    }
    if sizes_outside_scale > 0 {
        violations.push(format!(
            "font_sizes_outside_scale={sizes_outside_scale}: [{}]",
            bad_size_examples.join(", ")
        ));
    }
    if !bad_weights.is_empty() {
        violations.push(format!("invalid font_weights={bad_weights:?}"));
    }
    if let Some(mr) = mono_ratio_opt
        && mr > 0.25
    {
        violations.push(format!("mono_ratio={mr:.3} (> 0.25)"));
    }
    if caps_runs > 12 {
        violations.push(format!(
            "caps_runs={caps_runs} (> 12): [{}]",
            caps_examples.join(", ")
        ));
    }
    if api_strings > 0 {
        violations.push(format!(
            "api_strings={api_strings}: [{}]",
            api_examples.join(", ")
        ));
    }
    if em_dashes > 0 {
        violations.push(format!("em_dashes={em_dashes} (> 0)"));
    }

    let mono_json = match mono_ratio_opt {
        Some(r) => json!((r * 10000.0).round() / 10000.0),
        None => Value::Null,
    };
    let weights_vec: Vec<i32> = distinct_weights.into_iter().collect();

    let report = json!({
        "bordered_boxes": bordered_boxes,
        "chroma_area_ratio": (chroma_area_ratio * 100000.0).round() / 100000.0,
        "pixel_chroma_ratio": (pixel_chroma_ratio * 100000.0).round() / 100000.0,
        "hue_bins": hue_bins.len(),
        "font_sizes": distinct_sizes.len(),
        "font_sizes_outside_scale": sizes_outside_scale,
        "font_weights": weights_vec,
        "mono_ratio": mono_json,
        "caps_runs": caps_runs,
        "api_strings": api_strings,
        "em_dashes": em_dashes,
    });

    if !violations.is_empty() {
        return Err(format!(
            "restraint audit failed on `{scene}`: {}",
            violations.join("; ")
        ));
    }
    Ok(report)
}

pub fn run_headless_suite(out_dir: &Path, process_start: Instant) -> Result<(), String> {
    std::fs::create_dir_all(out_dir).map_err(|e| format!("create_dir_all: {e}"))?;

    // Spin up ephemeral loopback mock server.
    let mut mock = MockServerHandle::start()?;
    eprintln!("rune-headless: mock server listening on {}", mock.base_url);

    // Measure instant non-blocking boot-to-first-frame (<300ms target).
    let ui_boot_start = Instant::now();
    let embedded = SnapshotData::load_embedded();
    let snap_date = embedded.snapshot_date();
    let mut state = AppState::new(
        embedded.clone(),
        ConnectionState::Offline {
            snapshot_date: snap_date.clone(),
        },
        Some(mock.base_url.clone()),
    );
    state.attach_headless_writer(mock.base_url.clone());

    let mut rt = Runtime::new(state, root_view, (W, H), Env::new(true, SCALE));
    rt.on_key = Some(crate::views::handle_root_key);
    rt.frame(0.0);
    let boot_to_first_frame_ms = ui_boot_start.elapsed().as_secs_f64() * 1000.0;
    let process_to_first_frame_ms = process_start.elapsed().as_secs_f64() * 1000.0;
    eprintln!(
        "rune-headless: first_frame_ms={boot_to_first_frame_ms:.2} process_to_first_frame_ms={process_to_first_frame_ms:.2}"
    );
    if boot_to_first_frame_ms >= 300.0 {
        return Err(format!(
            "boot-to-first-frame exceeded 300ms: {boot_to_first_frame_ms:.2}ms"
        ));
    }
    // Focus root so on_key_preview is active immediately (matching desktop boot).
    rt.update(|_, tx| tx.focus("kizuki-root", false));
    rt.frame(0.0);

    // Initialize offscreen GPU renderer.
    let gpu = Gpu::headless();
    eprintln!("rune-headless: adapter={}", gpu.adapter.get_info().name);
    let pw = (W * SCALE).round() as u32;
    let ph = (H * SCALE).round() as u32;
    let mut renderer = Renderer::new(&gpu.device, OFFSCREEN_FORMAT);
    let target = Offscreen::new(&gpu.device, pw, ph);

    let mut snap = |rt: &mut Runtime<AppState>, filename: &str| -> Result<Vec<u8>, String> {
        renderer.render_runtime_to_offscreen(&gpu.device, &gpu.queue, &target, rt);
        let pixels = target.read(&gpu.device);
        let path = out_dir.join(filename);
        write_png(&path, pw, ph, &pixels).map_err(|e| format!("write_png {filename}: {e}"))?;
        eprintln!("rune-headless: wrote {} ({pw}x{ph})", path.display());
        Ok(pixels)
    };

    // Hydrate from ephemeral mock server (1st poll -> 200 OK x8, 2nd poll -> 304 Not Modified x8).
    let mut poller = PollClient::new(&mock.base_url);
    let mut live_data = embedded;
    let first_poll = poller.poll_tier(PollTier::All, &mut live_data);
    let conn = poller.connection_state(&snap_date);
    if !conn.is_live() || first_poll.live_hits != 8 {
        return Err(format!(
            "expected LIVE 8/8 from mock server, got {:?} ({}/8)",
            conn, first_poll.live_hits
        ));
    }
    let second_poll = poller.poll_tier(PollTier::All, &mut live_data);
    if second_poll.not_modified_304 < 8 {
        return Err(format!(
            "expected >= 8 HTTP 304 Not Modified hits via If-None-Match, got {}",
            second_poll.not_modified_304
        ));
    }
    let live_clone = live_data.clone();
    let box_ai_live_agents = live_data
        .box_ai_live
        .as_ref()
        .map(|b| b.agents.len())
        .unwrap_or(0);
    let box_ai_live_edges = live_data
        .box_ai_live
        .as_ref()
        .map(|b| b.edges.len())
        .unwrap_or(0);
    if box_ai_live_agents == 0 {
        return Err("expected /api/box/ai-live to hydrate box_ai_live_agents > 0".into());
    }
    rt.update(move |st, tx| {
        st.apply_live_poll(live_clone, conn, true);
        tx.animated();
    });
    for _ in 0..30 {
        rt.frame(1.0 / 60.0);
    }

    let mut min_font_overall = f32::INFINITY;
    let mut check_font = |rt: &Runtime<AppState>, name: &str| -> Result<(), String> {
        let m = audit_font_floor(rt, name)?;
        if m < min_font_overall {
            min_font_overall = m;
        }
        Ok(())
    };

    let mut restraint_results = serde_json::Map::new();

    // 1. Flow Deck Dark (LIVE 8/8 + Bezier Sankey ribbons + full-height columns)
    let flow_dark_px = snap(&mut rt, "rune-01-flow-deck-dark.png")?;
    check_font(&rt, "flow-deck-dark")?;
    restraint_results.insert(
        "flow-deck-dark".into(),
        audit_restraint(&rt, "flow-deck-dark", &flow_dark_px)?,
    );
    let col_occupancy = audit_flow_column_occupancy(&rt)?;
    let flow_dark_tree = summarize_tree(&mut rt, "flow-deck-dark");
    let before_waiting = rt.state.waiting_decision_count();

    // 2. Assert Key `2` switches view to Board!
    press_text_key(&mut rt, "2");
    for _ in 0..35 {
        rt.frame(1.0 / 60.0);
    }
    if rt.state.view != ActiveView::Board {
        return Err("key `2` did not switch active view to Board".into());
    }
    let board_dark_px = snap(&mut rt, "rune-03-board-dark.png")?;
    check_font(&rt, "board-dark")?;
    restraint_results.insert(
        "board-dark".into(),
        audit_restraint(&rt, "board-dark", &board_dark_px)?,
    );
    let board_tree = summarize_tree(&mut rt, "board-dark");

    // Switch back to Flow Deck via Key `1`
    press_text_key(&mut rt, "1");
    for _ in 0..35 {
        rt.frame(1.0 / 60.0);
    }
    if rt.state.view != ActiveView::FlowDeck {
        return Err("key `1` did not switch active view back to FlowDeck".into());
    }

    // 3. Assert Key `A` on selected gate sends EXACTLY 1 POST /api/decisions/stamp & removes gate!
    press_text_key(&mut rt, "a");
    for _ in 0..10 {
        rt.frame(1.0 / 60.0);
    }
    wait_for_write_outcome(&mut rt, 2500)?;
    let posts_after_approve = mock.state.stamp_posts.lock().map_err(|e| e.to_string())?.len();
    if posts_after_approve != 1 {
        return Err(format!(
            "expected exactly 1 POST to /api/decisions/stamp, observed {posts_after_approve}"
        ));
    }
    let after_waiting = rt.state.waiting_decision_count();
    if after_waiting != before_waiting.saturating_sub(1) {
        return Err(format!(
            "key `A` did not remove stamped gate from pending list ({before_waiting} -> {after_waiting})"
        ));
    }
    if rt.state.active_undo().is_none() {
        return Err("expected 30s Undo chip active after HTTP 200 stamp".into());
    }
    snap(&mut rt, "rune-01b-flow-deck-stamped.png")?;
    check_font(&rt, "flow-deck-stamped")?;
    let stamped_tree = summarize_tree(&mut rt, "flow-deck-stamped");

    // 4. Assert Mock HTTP 500 cleanly reverts optimistic verdict & shows error banner!
    mock.state.fail_next_stamp.store(true, Ordering::SeqCst);
    press_text_key(&mut rt, "a");
    for _ in 0..6 {
        rt.frame(1.0 / 60.0);
    }
    wait_for_write_outcome(&mut rt, 2500)?;
    let waiting_after_500 = rt.state.waiting_decision_count();
    if waiting_after_500 != after_waiting {
        return Err(format!(
            "mock HTTP 500 did not revert optimistic verdict ({after_waiting} vs {waiting_after_500})"
        ));
    }
    if rt.state.error_banner.is_none() {
        return Err("mock HTTP 500 did not display inline error banner".into());
    }
    snap(&mut rt, "rune-01c-flow-deck-error-revert.png")?;
    check_font(&rt, "flow-deck-error-revert")?;

    // Dismiss error banner via Escape
    rt.key(KeyEvent {
        key: Key::Escape,
        mods: Mods::default(),
    });
    for _ in 0..20 {
        rt.frame(1.0 / 60.0);
    }

    // 5. Assert Wave 3 smart delta polling skips redundant fetches when versions are unchanged,
    //    and updates live UI count with ZERO restart when board version increments!
    let seed_delta = poller.poll_smart_delta(&mut live_data, false, false);
    if seed_delta.live_versions.is_none() {
        return Err("expected /api/live/status version fingerprint to hydrate".into());
    }
    let unchanged_delta = poller.poll_smart_delta(&mut live_data, false, false);
    if !unchanged_delta.delta_skipped || unchanged_delta.changed {
        return Err(format!(
            "expected smart delta poll to skip unchanged versions, got {:?}",
            unchanged_delta
        ));
    }

    mock.state.extra_blocker.store(true, Ordering::SeqCst);
    mock.state.version.fetch_add(1, Ordering::SeqCst);
    let mut_poll = poller.poll_smart_delta(&mut live_data, false, false);
    let mut_conn = poller.connection_state(&snap_date);
    let mut_clone = live_data.clone();
    let mut_vers = mut_poll.live_versions;
    let delta_skips = poller.delta_skips();
    rt.update(move |st, tx| {
        st.apply_live_poll(mut_clone, mut_conn, mut_poll.changed);
        st.apply_live_meta(true, mut_vers, delta_skips);
        tx.animated();
    });
    for _ in 0..25 {
        rt.frame(1.0 / 60.0);
    }
    let waiting_after_poll = rt.state.waiting_decision_count();
    if waiting_after_poll != after_waiting + 1 {
        return Err(format!(
            "mutated mock payload did not update live waiting count ({after_waiting} -> {waiting_after_poll})"
        ));
    }

    // 6. Toggle Dark -> Light via Key `T` and render Light suite across all 4 views!
    press_text_key(&mut rt, "t");
    for _ in 0..45 {
        rt.frame(1.0 / 60.0);
    }
    if rt.state.dark {
        return Err("key `T` did not toggle Dark -> Light polarity".into());
    }
    let flow_light_px = snap(&mut rt, "rune-02-flow-deck-light.png")?;
    check_font(&rt, "flow-deck-light")?;
    restraint_results.insert(
        "flow-deck-light".into(),
        audit_restraint(&rt, "flow-deck-light", &flow_light_px)?,
    );

    press_text_key(&mut rt, "2");
    for _ in 0..35 {
        rt.frame(1.0 / 60.0);
    }
    let board_light_px = snap(&mut rt, "rune-04-board-light.png")?;
    check_font(&rt, "board-light")?;
    restraint_results.insert(
        "board-light".into(),
        audit_restraint(&rt, "board-light", &board_light_px)?,
    );

    press_text_key(&mut rt, "3");
    for _ in 0..35 {
        rt.frame(1.0 / 60.0);
    }
    if rt.state.view != ActiveView::Today {
        return Err("key `3` did not switch to Today".into());
    }
    let today_light_px = snap(&mut rt, "rune-06-today-light.png")?;
    check_font(&rt, "today-light")?;
    restraint_results.insert(
        "today-light".into(),
        audit_restraint(&rt, "today-light", &today_light_px)?,
    );

    press_text_key(&mut rt, "4");
    for _ in 0..35 {
        rt.frame(1.0 / 60.0);
    }
    if rt.state.view != ActiveView::Mind {
        return Err("key `4` did not switch to Mind".into());
    }
    let mind_light_px = snap(&mut rt, "rune-08-mind-light.png")?;
    check_font(&rt, "mind-light")?;
    restraint_results.insert(
        "mind-light".into(),
        audit_restraint(&rt, "mind-light", &mind_light_px)?,
    );

    // Toggle back to Dark via Key `T` and capture Today Dark, Mind Dark, Cmd+K, and `?` overlays.
    press_text_key(&mut rt, "t");
    for _ in 0..45 {
        rt.frame(1.0 / 60.0);
    }
    let mind_dark_px = snap(&mut rt, "rune-07-mind-dark.png")?;
    check_font(&rt, "mind-dark")?;
    restraint_results.insert(
        "mind-dark".into(),
        audit_restraint(&rt, "mind-dark", &mind_dark_px)?,
    );
    let mind_tree = summarize_tree(&mut rt, "mind-dark");

    press_text_key(&mut rt, "3");
    for _ in 0..35 {
        rt.frame(1.0 / 60.0);
    }
    if rt.state.data.intel_briefing.is_none() {
        return Err("expected Wave 3 /api/intel/briefing to hydrate into Today view".into());
    }
    // Exercise local commitment resolve via POST /api/intel/commitment
    rt.update(|st, tx| {
        st.submit_commitment_op("cm-102", CommitmentOp::Resolved);
        tx.animated();
    });
    wait_for_write_outcome(&mut rt, 2500)?;
    let commitment_posts = mock
        .state
        .commitment_posts
        .lock()
        .map_err(|e| e.to_string())?
        .len();
    if commitment_posts != 1 {
        return Err(format!(
            "expected 1 POST to /api/intel/commitment, observed {commitment_posts}"
        ));
    }
    // Dismiss status toast before snapping clean Today Dark view
    rt.key(KeyEvent {
        key: Key::Escape,
        mods: Mods::default(),
    });
    for _ in 0..20 {
        rt.frame(1.0 / 60.0);
    }
    let today_dark_px = snap(&mut rt, "rune-05-today-dark.png")?;
    check_font(&rt, "today-dark")?;
    restraint_results.insert(
        "today-dark".into(),
        audit_restraint(&rt, "today-dark", &today_dark_px)?,
    );
    let today_tree = summarize_tree(&mut rt, "today-dark");

    // Return to Flow Deck and capture Cmd+K Command Palette (with NEURAL recall hits!) & `?` Cheat Sheet!
    press_text_key(&mut rt, "1");
    for _ in 0..35 {
        rt.frame(1.0 / 60.0);
    }
    rt.key(KeyEvent {
        key: Key::Command('k'),
        mods: Mods {
            cmd: true,
            ..Mods::default()
        },
    });
    for _ in 0..30 {
        rt.frame(1.0 / 60.0);
    }
    if !rt.state.cmd_open {
        return Err("Cmd+K did not open command palette overlay".into());
    }
    // Exercise Wave 3 hybrid NEURAL semantic recall alongside lexical hits
    rt.update(|st, tx| {
        st.cmd_input = TextEdit::new("vault");
        st.refresh_remote_commands();
        tx.animated();
    });
    for _ in 0..20 {
        rt.frame(1.0 / 60.0);
    }
    let neural_hits_count = rt
        .state
        .filtered_commands()
        .iter()
        .filter(|c| c.kind == "NEURAL")
        .count();
    if neural_hits_count == 0 {
        return Err("expected NEURAL semantic recall hits merged in Cmd+K palette".into());
    }
    snap(&mut rt, "rune-09-cmd-palette-dark.png")?;
    check_font(&rt, "cmd-palette-dark")?;

    // Exercise Wave 3 local Quick Capture verb (`capture action ...`) -> POST /api/capture/quick
    rt.update(|st, tx| {
        st.cmd_input = TextEdit::new("capture action Ship Rune GPU Wave 3 parity :: local only");
        let cmds = st.filtered_commands();
        if let Some(first) = cmds.first().cloned()
            && first.kind == "CAPTURE"
        {
            st.execute_command(first.action);
            tx.blur();
            tx.animated();
        }
    });
    wait_for_write_outcome(&mut rt, 2500)?;
    let capture_posts = mock
        .state
        .capture_posts
        .lock()
        .map_err(|e| e.to_string())?
        .len();
    if capture_posts != 1 {
        return Err(format!(
            "expected 1 POST to /api/capture/quick, observed {capture_posts}"
        ));
    }
    // Dismiss capture toast cleanly before shortcuts overlay
    rt.key(KeyEvent {
        key: Key::Escape,
        mods: Mods::default(),
    });
    for _ in 0..20 {
        rt.frame(1.0 / 60.0);
    }

    press_text_key(&mut rt, "?");
    for _ in 0..30 {
        rt.frame(1.0 / 60.0);
    }
    if !rt.state.shortcuts_open {
        return Err("key `?` did not open shortcuts cheat-sheet overlay".into());
    }
    snap(&mut rt, "rune-10-shortcuts-sheet-dark.png")?;
    check_font(&rt, "shortcuts-sheet-dark")?;

    rt.key(KeyEvent {
        key: Key::Escape,
        mods: Mods::default(),
    });
    for _ in 0..25 {
        rt.frame(1.0 / 60.0);
    }

    // 6b. Switch to View 5 (Native GPU Box AI Live Observatory) via Key `5` & capture still!
    press_text_key(&mut rt, "5");
    for _ in 0..35 {
        rt.frame(1.0 / 60.0);
    }
    if rt.state.view != ActiveView::AiLive {
        return Err("key `5` did not switch active view to AiLive".into());
    }
    let ai_live_px = snap(&mut rt, "rune-13-ai-live-dark.png")?;
    check_font(&rt, "ai-live-dark")?;
    restraint_results.insert(
        "ai-live-dark".into(),
        audit_restraint(&rt, "ai-live-dark", &ai_live_px)?,
    );
    let ai_live_tree = summarize_tree(&mut rt, "ai-live-dark");

    // Return to Flow Deck before offline check
    press_text_key(&mut rt, "1");
    for _ in 0..35 {
        rt.frame(1.0 / 60.0);
    }

    // 7. Shut down mock server and assert status pill reads OFFLINE!
    mock.shutdown();
    let _ = poller.poll_tier(PollTier::BoardFast, &mut live_data);
    let offline_conn = poller.connection_state(&snap_date);
    let offline_clone = offline_conn.clone();
    rt.update(move |st, _tx| {
        st.apply_live_poll(live_data, offline_clone, false);
    });
    rt.frame(1.0 / 60.0);
    if !offline_conn.is_offline() || !offline_conn.pill_label().starts_with("OFFLINE") {
        return Err(format!(
            "expected OFFLINE status pill after server shutdown, got {}",
            offline_conn.pill_label()
        ));
    }

    // 8. Idle frame encoding check: settle springs, then step 600 frames (10s @ 60Hz) with 0 input.
    for _ in 0..180 {
        rt.frame(1.0 / 60.0);
    }
    let mut idle_frames_needed = 0usize;
    for _ in 0..600 {
        if rt.frame(1.0 / 60.0) {
            idle_frames_needed += 1;
        }
    }
    if idle_frames_needed > 0 {
        return Err(format!(
            "expected 0 frames encoded during 10s idle, observed {idle_frames_needed}"
        ));
    }

    let stamped_verified = rt
        .state
        .verdicts
        .values()
        .any(|v| *v == DecisionVerdict::Approved);

    let report = json!({
        "adapter": gpu.adapter.get_info().name,
        "viewport": [pw, ph],
        "scale": SCALE,
        "boot_to_first_frame_ms": (boot_to_first_frame_ms * 100.0).round() / 100.0,
        "process_to_first_frame_ms": (process_to_first_frame_ms * 100.0).round() / 100.0,
        "min_font_size_px": min_font_overall,
        "restraint": Value::Object(restraint_results),
        "flow_column_occupancy": col_occupancy,
        "idle_frames_encoded_10s": idle_frames_needed,
        "mock_server_proof": {
            "initial_live_hits": first_poll.live_hits,
            "etag_304_hits": second_poll.not_modified_304,
            "key_2_switched_to_board": true,
            "key_a_stamp_post_count": posts_after_approve,
            "waiting_before": before_waiting,
            "waiting_after_approve": after_waiting,
            "mock_500_reverted_cleanly": true,
            "live_poll_mutation_waiting_after": waiting_after_poll,
            "offline_pill_after_shutdown": offline_conn.pill_label(),
            "approved_verdict_recorded": stamped_verified,
            "cmd_k_overlay_verified": true,
            "neural_semantic_recall_hits": neural_hits_count,
            "quick_capture_post_count": capture_posts,
            "intel_commitment_post_count": commitment_posts,
            "smart_delta_skips": delta_skips,
            "shortcuts_overlay_verified": true,
            "box_ai_live_agents": box_ai_live_agents,
            "box_ai_live_edges": box_ai_live_edges,
            "key_5_switched_to_ai_live": true,
            "screenshots_rendered": 13
        },
        "trees": [
            flow_dark_tree,
            stamped_tree,
            board_tree,
            today_tree,
            mind_tree,
            ai_live_tree,
        ]
    });

    let tree_path = out_dir.join("element-tree.json");
    let pretty = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
    std::fs::write(&tree_path, pretty).map_err(|e| format!("write tree json: {e}"))?;
    eprintln!(
        "rune-headless: ALL ASSERTIONS PASSED (13 PNGs, box_ai_live_agents={box_ai_live_agents}, min_font={min_font_overall:.1}px, idle_frames=0, boot={boot_to_first_frame_ms:.2}ms)"
    );
    Ok(())
}

fn summarize_tree(rt: &mut Runtime<AppState>, scene: &str) -> Value {
    let a11y = rt.accessibility_tree();
    let total_nodes = a11y.nodes.len();
    let keyed_controls: Vec<Value> = a11y
        .nodes
        .iter()
        .filter_map(|(_, node)| {
            let key = node.author_id()?;
            let label = node.label().unwrap_or("");
            Some(json!({
                "key": key,
                "label": label,
                "role": format!("{:?}", node.role()),
            }))
        })
        .collect();
    let labels_sample: Vec<String> = a11y
        .nodes
        .iter()
        .filter_map(|(_, n)| n.label().map(str::to_owned))
        .filter(|s| !s.is_empty())
        .take(24)
        .collect();

    json!({
        "scene": scene,
        "a11y_node_count": total_nodes,
        "keyed_controls_count": keyed_controls.len(),
        "keyed_controls": keyed_controls,
        "labels_sample": labels_sample,
    })
}
