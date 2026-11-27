//! Application state, durable C1 decision write-back with 30s undo,
//! Wave 3 proactive intel commitments, hybrid neural semantic recall,
//! local quick capture, keyboard command palette, selection state, and hover isolation.

use std::collections::HashMap;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use rune::TextEdit;
use serde::{Deserialize, Deserializer};

use crate::data::{
    ConnectionState, DecisionGateCard, IntelBriefing, LiveVersions, MeetingPrep, NextMoveItem,
    OpenCommitment, QuickCaptureRequest, RemoteCommandHit, SemanticHit, SnapshotData, StampRequest,
    TelemetryHistory, TodayAction, clean_snippet, fetch_semantic_recall, post_commitment_op,
    post_decision_stamp, post_quick_capture, resolve_command_remote,
};

fn de_string_or_null<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(Option::<String>::deserialize(d)?.unwrap_or_default())
}

fn de_f32_or_null<'de, D: Deserializer<'de>>(d: D) -> Result<f32, D::Error> {
    Ok(Option::<f32>::deserialize(d)?.unwrap_or(0.0))
}

fn de_u32_or_null<'de, D: Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    Ok(Option::<u32>::deserialize(d)?.unwrap_or(0))
}

fn de_bool_or_null<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    Ok(Option::<bool>::deserialize(d)?.unwrap_or(false))
}

/// Defensive live telemetry contract for `GET /api/box/ai-live`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct BoxAiLiveSnapshot {
    pub summary: BoxAiSummary,
    pub agents: Vec<BoxAiAgent>,
    pub resources: Vec<BoxAiResource>,
    pub edges: Vec<BoxAiEdge>,
}

impl BoxAiLiveSnapshot {
    pub fn has_live_data(&self) -> bool {
        !self.agents.is_empty() || self.summary.total_live > 0
    }

    pub fn effective_counts(&self) -> (u32, u32, u32, u32, u32) {
        let mut bld = 0u32;
        let mut dsn = 0u32;
        let mut prd = 0u32;
        let mut orc = 0u32;
        for a in &self.agents {
            match normalize_ai_category(&a.category) {
                "building" => bld += 1,
                "designing" => dsn += 1,
                "predicting" => prd += 1,
                _ => orc += 1,
            }
        }
        let sum_agents = bld + dsn + prd + orc;
        if self.summary.total_live > 0 {
            (
                self.summary.total_live,
                self.summary.building.max(bld),
                self.summary.designing.max(dsn),
                self.summary.predicting.max(prd),
                self.summary.orchestrating.max(orc),
            )
        } else {
            (sum_agents, bld, dsn, prd, orc)
        }
    }
}

pub fn normalize_ai_category(raw: &str) -> &'static str {
    let c = raw.trim().to_ascii_lowercase();
    if c.contains("build") || c.contains("code") || c.contains("dev") || c.contains("eng") {
        "building"
    } else if c.contains("design") || c.contains("art") || c.contains("ui") || c.contains("visual")
    {
        "designing"
    } else if c.contains("predict")
        || c.contains("trad")
        || c.contains("forecast")
        || c.contains("market")
        || c.contains("quant")
    {
        "predicting"
    } else {
        "orchestrating"
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct BoxAiSummary {
    #[serde(alias = "totalLive", deserialize_with = "de_u32_or_null")]
    pub total_live: u32,
    #[serde(deserialize_with = "de_u32_or_null")]
    pub building: u32,
    #[serde(deserialize_with = "de_u32_or_null")]
    pub designing: u32,
    #[serde(deserialize_with = "de_u32_or_null")]
    pub predicting: u32,
    #[serde(deserialize_with = "de_u32_or_null")]
    pub orchestrating: u32,
    #[serde(alias = "totalCpuPct", deserialize_with = "de_f32_or_null")]
    pub total_cpu_pct: f32,
    #[serde(alias = "totalRamMb", deserialize_with = "de_f32_or_null")]
    pub total_ram_mb: f32,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct BoxAiAgent {
    #[serde(deserialize_with = "de_string_or_null")]
    pub id: String,
    #[serde(deserialize_with = "de_string_or_null")]
    pub name: String,
    #[serde(deserialize_with = "de_string_or_null")]
    pub runtime: String,
    #[serde(deserialize_with = "de_string_or_null")]
    pub category: String,
    #[serde(deserialize_with = "de_string_or_null")]
    pub state: String,
    pub pid: Option<u32>,
    #[serde(alias = "cpuPct", deserialize_with = "de_f32_or_null")]
    pub cpu_pct: f32,
    #[serde(alias = "ramMb", deserialize_with = "de_f32_or_null")]
    pub ram_mb: f32,
    #[serde(deserialize_with = "de_string_or_null")]
    pub repo: String,
    #[serde(alias = "currentAction", deserialize_with = "de_string_or_null")]
    pub current_action: String,
    #[serde(alias = "activeTool", deserialize_with = "de_string_or_null")]
    pub active_tool: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct BoxAiResource {
    #[serde(deserialize_with = "de_string_or_null")]
    pub id: String,
    #[serde(deserialize_with = "de_string_or_null")]
    pub label: String,
    #[serde(deserialize_with = "de_string_or_null")]
    pub kind: String,
    #[serde(deserialize_with = "de_string_or_null")]
    pub metric: String,
    #[serde(alias = "activeCount", deserialize_with = "de_u32_or_null")]
    pub active_count: u32,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct BoxAiEdge {
    #[serde(deserialize_with = "de_string_or_null")]
    pub id: String,
    #[serde(deserialize_with = "de_string_or_null")]
    pub from: String,
    #[serde(deserialize_with = "de_string_or_null")]
    pub to: String,
    #[serde(deserialize_with = "de_string_or_null")]
    pub category: String,
    #[serde(deserialize_with = "de_string_or_null")]
    pub label: String,
    #[serde(deserialize_with = "de_f32_or_null")]
    pub weight: f32,
    #[serde(alias = "cpuPct", deserialize_with = "de_f32_or_null")]
    pub cpu_pct: f32,
    #[serde(deserialize_with = "de_bool_or_null")]
    pub active: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActiveView {
    FlowDeck,
    Board,
    Today,
    Mind,
    AiLive,
}

impl ActiveView {
    pub const ALL: [ActiveView; 5] = [
        ActiveView::FlowDeck,
        ActiveView::Board,
        ActiveView::Today,
        ActiveView::Mind,
        ActiveView::AiLive,
    ];

    pub fn label(self) -> &'static str {
        match self {
            ActiveView::FlowDeck => "Flow Deck",
            ActiveView::Board => "Board",
            ActiveView::Today => "Today",
            ActiveView::Mind => "Mind",
            ActiveView::AiLive => "AI Live",
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            ActiveView::FlowDeck => "nav-flow",
            ActiveView::Board => "nav-board",
            ActiveView::Today => "nav-today",
            ActiveView::Mind => "nav-mind",
            ActiveView::AiLive => "nav-ai-live",
        }
    }

    pub fn shortcut_digit(self) -> &'static str {
        match self {
            ActiveView::FlowDeck => "1",
            ActiveView::Board => "2",
            ActiveView::Today => "3",
            ActiveView::Mind => "4",
            ActiveView::AiLive => "5",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecisionVerdict {
    Approved,
    Revised,
    Deferred,
}

impl DecisionVerdict {
    pub fn label(self) -> &'static str {
        match self {
            DecisionVerdict::Approved => "APPROVED",
            DecisionVerdict::Revised => "REVISE QUEUED",
            DecisionVerdict::Deferred => "DEFERRED",
        }
    }

    pub fn wire_value(self) -> &'static str {
        match self {
            DecisionVerdict::Approved => "approve",
            DecisionVerdict::Revised => "revise",
            DecisionVerdict::Deferred => "defer",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WriteStatus {
    Pending,
    Confirmed(u16),
    Reverted(String),
    Undone,
}

#[derive(Clone, Debug)]
pub struct VerdictRecord {
    pub thread_id: String,
    pub verdict: DecisionVerdict,
    pub idempotency_key: String,
    pub status: WriteStatus,
    pub is_undo: bool,
}

#[derive(Clone, Debug)]
pub struct UndoEntry {
    pub thread_id: String,
    pub verdict: DecisionVerdict,
    pub previous: Option<DecisionVerdict>,
    pub idempotency_key: String,
    pub expires_at: Instant,
}

#[derive(Clone, Debug)]
pub struct WriteRequest {
    pub thread_id: String,
    pub verdict: DecisionVerdict,
    pub previous: Option<DecisionVerdict>,
    pub idempotency_key: String,
    pub is_undo: bool,
}

#[derive(Clone, Debug)]
pub struct WriteOutcome {
    pub thread_id: String,
    pub verdict: DecisionVerdict,
    pub previous: Option<DecisionVerdict>,
    pub idempotency_key: String,
    pub is_undo: bool,
    pub result: Result<u16, String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommitmentOp {
    Resolved,
    Snoozed,
}

impl CommitmentOp {
    pub fn wire_value(self) -> &'static str {
        match self {
            CommitmentOp::Resolved => "resolve",
            CommitmentOp::Snoozed => "snooze",
        }
    }

    pub fn badge_label(self) -> &'static str {
        match self {
            CommitmentOp::Resolved => "RESOLVED",
            CommitmentOp::Snoozed => "SNOOZED",
        }
    }
}

#[derive(Clone, Debug)]
pub struct StatusToast {
    #[allow(dead_code)]
    pub badge: &'static str,
    pub message: String,
    pub is_live: bool,
    pub expires_at: Instant,
}

#[derive(Clone, Debug)]
enum BgRequest {
    Stamp(WriteRequest),
    Commitment {
        id: String,
        op: CommitmentOp,
    },
    QuickCapture {
        kind: String,
        title: String,
        body: String,
    },
}

#[derive(Clone, Debug)]
enum BgOutcome {
    Stamp(WriteOutcome),
    Commitment {
        id: String,
        op: CommitmentOp,
        result: Result<u16, String>,
    },
    QuickCapture {
        kind: String,
        title: String,
        result: Result<u16, String>,
    },
}

#[derive(Clone, Debug)]
struct SearchRequest {
    seq: u64,
    query: String,
}

#[derive(Clone, Debug)]
pub struct CommandEntry {
    pub kind: &'static str,
    pub label: String,
    pub detail: Option<String>,
    pub hint: String,
    pub action: CommandAction,
}

#[derive(Clone, Debug)]
pub enum CommandAction {
    SwitchView(ActiveView),
    ToggleTheme,
    InspectThread(String),
    StampGate(String, DecisionVerdict),
    FilterAgent(Option<String>),
    UndoLast,
    ToggleShortcuts,
    OpenSemanticHit {
        target_view: String,
        target_ref: String,
        title: String,
    },
    QuickCapture {
        kind: String,
        title: String,
        body: String,
    },
}

pub struct AppState {
    pub view: ActiveView,
    pub dark: bool,
    pub data: SnapshotData,
    pub connection: ConnectionState,
    pub telemetry: TelemetryHistory,
    pub api_base: Option<String>,

    // Durable decision write-back & Wave 3 local action state
    pub verdicts: HashMap<String, DecisionVerdict>,
    pub pending_writes: HashMap<String, String>,
    pub verdict_history: Vec<VerdictRecord>,
    pub undo_entry: Option<UndoEntry>,
    pub commitment_ops: HashMap<String, CommitmentOp>,
    pub status_toast: Option<StatusToast>,
    pub error_banner: Option<String>,
    pub shake_card_id: Option<String>,
    pub shake_seq: u32,
    write_seq: u64,
    write_tx: Option<mpsc::Sender<BgRequest>>,
    write_rx: Option<mpsc::Receiver<BgOutcome>>,
    search_tx: Option<mpsc::Sender<SearchRequest>>,

    // Live SSE & smart delta metadata
    pub sse_live: bool,
    pub live_versions: Option<LiveVersions>,
    pub delta_skips: usize,

    // Selection & hover isolation
    pub selected_gate_idx: usize,
    pub selected_thread_idx: usize,
    pub selected_move_idx: usize,
    pub selected_ai_agent_idx: usize,
    pub agent_filter: Option<String>,
    pub hovered_flow: Option<(usize, usize)>,
    pub hovered_ai_node: Option<(usize, usize)>,

    // Keyboard overlays & hybrid neural recall
    pub cmd_open: bool,
    pub cmd_input: TextEdit,
    pub cmd_selected: usize,
    pub cmd_remote_hits: Vec<RemoteCommandHit>,
    pub cmd_semantic_hits: Vec<SemanticHit>,
    pub cmd_search_seq: u64,
    pub shortcuts_open: bool,
}

impl AppState {
    pub fn new(data: SnapshotData, connection: ConnectionState, api_base: Option<String>) -> Self {
        let telemetry = TelemetryHistory::from_snapshot(&data);
        Self {
            view: ActiveView::FlowDeck,
            dark: true,
            data,
            connection,
            telemetry,
            api_base,
            verdicts: HashMap::new(),
            pending_writes: HashMap::new(),
            verdict_history: Vec::new(),
            undo_entry: None,
            commitment_ops: HashMap::new(),
            status_toast: None,
            error_banner: None,
            shake_card_id: None,
            shake_seq: 0,
            write_seq: 0,
            write_tx: None,
            write_rx: None,
            search_tx: None,
            sse_live: false,
            live_versions: None,
            delta_skips: 0,
            selected_gate_idx: 0,
            selected_thread_idx: 0,
            selected_move_idx: 0,
            selected_ai_agent_idx: 0,
            agent_filter: None,
            hovered_flow: None,
            hovered_ai_node: None,
            cmd_open: false,
            cmd_input: TextEdit::new(""),
            cmd_selected: 0,
            cmd_remote_hits: Vec::new(),
            cmd_semantic_hits: Vec::new(),
            cmd_search_seq: 0,
            shortcuts_open: false,
        }
    }

    /// Attaches background write-back & non-blocking neural search workers wired to a live desktop `AppHandle`.
    pub fn attach_desktop_writer(
        &mut self,
        api_base: String,
        handle: rune::AppHandle<AppState>,
    ) {
        let (tx, rx) = mpsc::channel::<BgRequest>();
        self.api_base = Some(api_base.clone());
        self.write_tx = Some(tx);

        let writer_base = api_base.clone();
        let writer_handle = handle.clone();
        std::thread::Builder::new()
            .name("kizuki-decision-writer".into())
            .spawn(move || {
                while let Ok(req) = rx.recv() {
                    let outcome = dispatch_bg_request(&writer_base, req);
                    writer_handle.update(move |st, ui_tx| {
                        st.apply_bg_outcome(outcome);
                        ui_tx.animated();
                    });
                }
            })
            .ok();

        let (stx, srx) = mpsc::channel::<SearchRequest>();
        self.search_tx = Some(stx);
        std::thread::Builder::new()
            .name("kizuki-semantic-search".into())
            .spawn(move || {
                while let Ok(mut req) = srx.recv() {
                    // Coalesce rapid keystrokes: keep only the latest queued search query.
                    while let Ok(newer) = srx.try_recv() {
                        req = newer;
                    }
                    let remote = resolve_command_remote(&api_base, &req.query);
                    let semantic = fetch_semantic_recall(&api_base, &req.query, 6);
                    let seq = req.seq;
                    handle.update(move |st, ui_tx| {
                        if st.cmd_search_seq == seq {
                            st.cmd_remote_hits = remote;
                            st.cmd_semantic_hits = semantic;
                            ui_tx.animated();
                        }
                    });
                }
            })
            .ok();
    }

    /// Attaches a background write-back worker thread whose outcomes are drained by headless tests.
    pub fn attach_headless_writer(&mut self, api_base: String) {
        let (req_tx, req_rx) = mpsc::channel::<BgRequest>();
        let (res_tx, res_rx) = mpsc::channel::<BgOutcome>();
        self.api_base = Some(api_base.clone());
        self.write_tx = Some(req_tx);
        self.write_rx = Some(res_rx);
        std::thread::Builder::new()
            .name("kizuki-headless-writer".into())
            .spawn(move || {
                while let Ok(req) = req_rx.recv() {
                    let outcome = dispatch_bg_request(&api_base, req);
                    let _ = res_tx.send(outcome);
                }
            })
            .ok();
    }

    /// Drains any completed background write outcomes into state (used by headless suite).
    pub fn drain_write_outcomes(&mut self) -> usize {
        let mut drained = Vec::new();
        if let Some(rx) = &self.write_rx {
            while let Ok(o) = rx.try_recv() {
                drained.push(o);
            }
        }
        let count = drained.len();
        for o in drained {
            self.apply_bg_outcome(o);
        }
        count
    }

    pub fn apply_live_meta(
        &mut self,
        sse_live: bool,
        live_versions: Option<LiveVersions>,
        delta_skips: usize,
    ) {
        self.sse_live = sse_live;
        self.live_versions = live_versions;
        self.delta_skips = delta_skips;
    }

    pub fn active_toast(&self) -> Option<&StatusToast> {
        self.status_toast
            .as_ref()
            .filter(|t| Instant::now() < t.expires_at)
    }

    fn apply_bg_outcome(&mut self, outcome: BgOutcome) {
        match outcome {
            BgOutcome::Stamp(o) => self.apply_write_outcome(o),
            BgOutcome::Commitment { id, op, result } => {
                let (is_live, suffix) = match result {
                    Ok(_) => (true, "synced via /api/intel/commitment"),
                    Err(_) => (false, "applied locally (endpoint offline)"),
                };
                self.status_toast = Some(StatusToast {
                    badge: op.badge_label(),
                    message: format!("Commitment #{id} {} ({suffix})", op.wire_value()),
                    is_live,
                    expires_at: Instant::now() + Duration::from_secs(12),
                });
            }
            BgOutcome::QuickCapture {
                kind,
                title,
                result,
            } => {
                let (is_live, suffix) = match result {
                    Ok(_) => (true, "persisted locally via /api/capture/quick"),
                    Err(_) => (false, "captured in session (endpoint offline)"),
                };
                self.status_toast = Some(StatusToast {
                    badge: "CAPTURED",
                    message: format!(
                        "{}: {} ({suffix})",
                        kind.to_uppercase(),
                        clean_snippet(&title, 72)
                    ),
                    is_live,
                    expires_at: Instant::now() + Duration::from_secs(14),
                });
            }
        }
    }

    pub fn apply_live_poll(
        &mut self,
        new_data: SnapshotData,
        conn: ConnectionState,
        changed: bool,
    ) {
        self.connection = conn;
        if changed {
            self.data = new_data;
            self.telemetry.record(&self.data);
            let pending_len = self.pending_decision_gates().len();
            if pending_len > 0 {
                self.selected_gate_idx = self.selected_gate_idx.min(pending_len - 1);
            } else {
                self.selected_gate_idx = 0;
            }
        }
    }

    pub fn pending_decision_gates(&self) -> Vec<DecisionGateCard> {
        self.data
            .decision_gates()
            .into_iter()
            .filter(|g| !self.verdicts.contains_key(&g.id))
            .collect()
    }

    pub fn resolved_decision_gates(&self) -> Vec<(DecisionGateCard, DecisionVerdict)> {
        self.data
            .decision_gates()
            .into_iter()
            .filter_map(|g| {
                let v = self.verdicts.get(&g.id).copied()?;
                Some((g, v))
            })
            .collect()
    }

    pub fn waiting_decision_count(&self) -> usize {
        self.pending_decision_gates().len()
    }

    pub fn active_undo(&self) -> Option<&UndoEntry> {
        self.undo_entry
            .as_ref()
            .filter(|u| Instant::now() < u.expires_at)
    }

    /// Optimistic durable write-back (Contract C1): updates UI immediately and dispatches POST.
    pub fn submit_verdict(&mut self, id: &str, verdict: DecisionVerdict) {
        let previous = self.verdicts.get(id).copied();
        if previous == Some(verdict) {
            return;
        }
        self.write_seq = self.write_seq.saturating_add(1);
        let idempotency_key = format!(
            "rune-{}-{}-{}",
            id,
            verdict.wire_value(),
            self.write_seq
        );

        self.error_banner = None;
        self.shake_card_id = None;
        self.verdicts.insert(id.to_string(), verdict);
        self.pending_writes
            .insert(id.to_string(), idempotency_key.clone());

        self.verdict_history.insert(
            0,
            VerdictRecord {
                thread_id: id.to_string(),
                verdict,
                idempotency_key: idempotency_key.clone(),
                status: WriteStatus::Pending,
                is_undo: false,
            },
        );
        self.verdict_history.truncate(24);

        let pending_len = self.pending_decision_gates().len();
        if pending_len > 0 {
            self.selected_gate_idx = self.selected_gate_idx.min(pending_len - 1);
        } else {
            self.selected_gate_idx = 0;
        }

        if let Some(tx) = &self.write_tx {
            let _ = tx.send(BgRequest::Stamp(WriteRequest {
                thread_id: id.to_string(),
                verdict,
                previous,
                idempotency_key,
                is_undo: false,
            }));
        } else {
            // Offline mode: local confirm with 30s undo available.
            self.apply_write_outcome(WriteOutcome {
                thread_id: id.to_string(),
                verdict,
                previous,
                idempotency_key,
                is_undo: false,
                result: Ok(200),
            });
        }
    }

    pub fn trigger_undo(&mut self) -> bool {
        let Some(entry) = self.active_undo().cloned() else {
            self.undo_entry = None;
            return false;
        };
        self.undo_entry = None;
        self.error_banner = None;

        // Optimistically restore previous state.
        match entry.previous {
            Some(prev) => {
                self.verdicts.insert(entry.thread_id.clone(), prev);
            }
            None => {
                self.verdicts.remove(&entry.thread_id);
            }
        }

        let undo_key = format!("{}-undo", entry.idempotency_key);
        self.verdict_history.insert(
            0,
            VerdictRecord {
                thread_id: entry.thread_id.clone(),
                verdict: entry.verdict,
                idempotency_key: undo_key.clone(),
                status: WriteStatus::Pending,
                is_undo: true,
            },
        );

        if let Some(tx) = &self.write_tx {
            let _ = tx.send(BgRequest::Stamp(WriteRequest {
                thread_id: entry.thread_id,
                verdict: entry.verdict,
                previous: Some(entry.verdict),
                idempotency_key: undo_key,
                is_undo: true,
            }));
        } else {
            self.apply_write_outcome(WriteOutcome {
                thread_id: entry.thread_id,
                verdict: entry.verdict,
                previous: Some(entry.verdict),
                idempotency_key: undo_key,
                is_undo: true,
                result: Ok(200),
            });
        }
        true
    }

    pub fn apply_write_outcome(&mut self, outcome: WriteOutcome) {
        self.pending_writes.remove(&outcome.thread_id);
        match outcome.result {
            Ok(code) => {
                if let Some(rec) = self
                    .verdict_history
                    .iter_mut()
                    .find(|r| r.idempotency_key == outcome.idempotency_key)
                {
                    rec.status = if outcome.is_undo {
                        WriteStatus::Undone
                    } else {
                        WriteStatus::Confirmed(code)
                    };
                }
                if !outcome.is_undo {
                    self.undo_entry = Some(UndoEntry {
                        thread_id: outcome.thread_id,
                        verdict: outcome.verdict,
                        previous: outcome.previous,
                        idempotency_key: outcome.idempotency_key,
                        expires_at: Instant::now() + Duration::from_secs(30),
                    });
                }
            }
            Err(err) => {
                // Clean revert on non-200 / network error.
                if outcome.is_undo {
                    self.verdicts
                        .insert(outcome.thread_id.clone(), outcome.verdict);
                } else {
                    match outcome.previous {
                        Some(prev) => {
                            self.verdicts.insert(outcome.thread_id.clone(), prev);
                        }
                        None => {
                            self.verdicts.remove(&outcome.thread_id);
                        }
                    }
                }
                if let Some(rec) = self
                    .verdict_history
                    .iter_mut()
                    .find(|r| r.idempotency_key == outcome.idempotency_key)
                {
                    rec.status = WriteStatus::Reverted(err.clone());
                }
                self.error_banner = Some(format!(
                    "Decision write failed for #{} ({}) - verdict reverted cleanly",
                    outcome.thread_id, err
                ));
                self.shake_card_id = Some(outcome.thread_id);
                self.shake_seq = self.shake_seq.wrapping_add(1);
            }
        }
    }

    pub fn select_next(&mut self) {
        match self.view {
            ActiveView::FlowDeck => {
                let n = self.pending_decision_gates().len();
                if n > 0 {
                    self.selected_gate_idx = (self.selected_gate_idx + 1) % n;
                }
            }
            ActiveView::Board => {
                let n = self.board_stream_ids().len();
                if n > 0 {
                    self.selected_thread_idx = (self.selected_thread_idx + 1) % n;
                }
            }
            ActiveView::Today => {
                let n = self.next_moves_effective().len();
                if n > 0 {
                    self.selected_move_idx = (self.selected_move_idx + 1) % n;
                }
            }
            ActiveView::Mind => {}
            ActiveView::AiLive => {
                let (snap, _) = self.box_ai_live_effective();
                let n = snap.agents.len();
                if n > 0 {
                    self.selected_ai_agent_idx = (self.selected_ai_agent_idx + 1) % n;
                }
            }
        }
    }

    pub fn select_prev(&mut self) {
        match self.view {
            ActiveView::FlowDeck => {
                let n = self.pending_decision_gates().len();
                if n > 0 {
                    self.selected_gate_idx = (self.selected_gate_idx + n - 1) % n;
                }
            }
            ActiveView::Board => {
                let n = self.board_stream_ids().len();
                if n > 0 {
                    self.selected_thread_idx = (self.selected_thread_idx + n - 1) % n;
                }
            }
            ActiveView::Today => {
                let n = self.next_moves_effective().len();
                if n > 0 {
                    self.selected_move_idx = (self.selected_move_idx + n - 1) % n;
                }
            }
            ActiveView::Mind => {}
            ActiveView::AiLive => {
                let (snap, _) = self.box_ai_live_effective();
                let n = snap.agents.len();
                if n > 0 {
                    self.selected_ai_agent_idx = (self.selected_ai_agent_idx + n - 1) % n;
                }
            }
        }
    }

    pub fn stamp_selected(&mut self, verdict: DecisionVerdict) -> bool {
        match self.view {
            ActiveView::FlowDeck => {
                let gates = self.pending_decision_gates();
                if let Some(gate) = gates.get(self.selected_gate_idx) {
                    let id = gate.id.clone();
                    self.submit_verdict(&id, verdict);
                    return true;
                }
                false
            }
            ActiveView::Board => {
                let ids = self.board_stream_ids();
                if let Some(id) = ids.get(self.selected_thread_idx).cloned() {
                    self.submit_verdict(&id, verdict);
                    return true;
                }
                false
            }
            ActiveView::Today => {
                let moves = self.next_moves_effective();
                if let Some(mv) = moves.get(self.selected_move_idx)
                    && let Some(tid) = mv.thread_id.clone()
                {
                    self.submit_verdict(&tid, verdict);
                    return true;
                }
                let gates = self.pending_decision_gates();
                if let Some(gate) = gates.first() {
                    let id = gate.id.clone();
                    self.submit_verdict(&id, verdict);
                    return true;
                }
                false
            }
            ActiveView::Mind | ActiveView::AiLive => false,
        }
    }

    pub fn inspect_selected(&mut self) -> bool {
        match self.view {
            ActiveView::FlowDeck => {
                let gates = self.pending_decision_gates();
                if let Some(gate) = gates.get(self.selected_gate_idx) {
                    let id = gate.id.clone();
                    self.focus_thread_in_board(&id);
                    return true;
                }
                false
            }
            ActiveView::Today => {
                let moves = self.next_moves_effective();
                if let Some(mv) = moves.get(self.selected_move_idx)
                    && let Some(tid) = mv.thread_id.clone()
                {
                    self.focus_thread_in_board(&tid);
                    return true;
                }
                false
            }
            _ => false,
        }
    }

    pub fn focus_thread_in_board(&mut self, thread_id: &str) {
        self.agent_filter = None;
        self.view = ActiveView::Board;
        let ids = self.board_stream_ids();
        if let Some(pos) = ids.iter().position(|id| id == thread_id) {
            self.selected_thread_idx = pos;
        } else {
            self.selected_thread_idx = 0;
        }
    }

    pub fn board_stream_ids(&self) -> Vec<String> {
        let mut ids = Vec::new();
        for b in self.data.blockers.orchestrator_queue.iter().take(4) {
            if !ids.contains(&b.id) {
                ids.push(b.id.clone());
            }
        }
        for m in self.data.mission.items.iter().take(12) {
            if !ids.contains(&m.id) {
                ids.push(m.id.clone());
            }
        }
        ids
    }

    /// Returns C2 `/api/today/next-moves` if hydrated, or synthesizes honest ranked moves
    /// directly from live blockers/workstreams/schedule (zero hardcoded strings).
    pub fn next_moves_effective(&self) -> Vec<NextMoveItem> {
        if !self.data.next_moves.is_empty() {
            return self.data.next_moves.clone();
        }
        let mut out = Vec::new();
        for gate in self.pending_decision_gates().into_iter().take(3) {
            out.push(NextMoveItem {
                id: format!("gate-{}", gate.id),
                kind: "decision".into(),
                title: gate.title.clone(),
                why_now: format!(
                    "Owner gate #{} in {} waiting {} ({} replies)",
                    gate.id, gate.channel, gate.age_label, gate.replies
                ),
                score: (gate.age_ratio * 100.0).round(),
                verbs: vec!["approve".into(), "revise".into(), "defer".into()],
                thread_id: Some(gate.id),
            });
        }
        for ws in self.data.today.workstreams.iter().take(3) {
            if out.len() >= 5 {
                break;
            }
            out.push(NextMoveItem {
                id: format!("ws-{}", ws.name),
                kind: "workstream".into(),
                title: format!("{}: {}", ws.name, ws.next_move),
                why_now: format!("Active {} stream ({})", ws.domain, ws.state),
                score: 68.0,
                verbs: vec!["open".into()],
                thread_id: None,
            });
        }
        for ev in self.data.today.schedule.iter().take(2) {
            if out.len() >= 5 {
                break;
            }
            out.push(NextMoveItem {
                id: format!("ev-{}", ev.id),
                kind: "schedule".into(),
                title: ev.title.clone(),
                why_now: if ev.countdown.is_empty() {
                    "Scheduled today".into()
                } else {
                    format!("Starts {}", ev.countdown)
                },
                score: if ev.is_now { 92.0 } else { 54.0 },
                verbs: vec!["prep".into()],
                thread_id: None,
            });
        }
        out
    }

    /// Returns Wave 3 `/api/intel/briefing` if hydrated, or synthesizes honest meeting preps
    /// and open commitments directly from live schedule, people radar, and actions (fail-soft).
    pub fn intel_briefing_effective(&self) -> (IntelBriefing, bool) {
        if let Some(b) = &self.data.intel_briefing
            && b.has_content()
        {
            return (b.clone(), true);
        }

        let mut meeting_preps = Vec::new();
        for (i, ev) in self.data.today.schedule.iter().take(2).enumerate() {
            let time_label = ev
                .start
                .split('T')
                .nth(1)
                .map(|t| t.chars().take(5).collect::<String>())
                .unwrap_or_else(|| "Today".into());
            let attendees: Vec<String> = self
                .data
                .today
                .people_radar
                .iter()
                .skip(i)
                .take(2)
                .map(|p| p.name.clone())
                .collect();
            let last_touch = self
                .data
                .today
                .people_radar
                .get(i)
                .map(|p| format!("Last touch {}", p.last_seen_label))
                .unwrap_or_else(|| "Calendar sync".into());
            let mut talking_points = Vec::new();
            if let Some(ws) = self.data.today.workstreams.get(i) {
                talking_points.push(format!("{}: {}", ws.name, ws.next_move));
            }
            if !ev.countdown.is_empty() {
                talking_points.push(format!("Starts {}", ev.countdown));
            }
            meeting_preps.push(MeetingPrep {
                id: format!("prep-{}", ev.id),
                title: ev.title.clone(),
                time_label,
                attendees,
                last_touch,
                open_loops_count: self.data.today.actions.iter().filter(|a| !a.done).count() as u32,
                talking_points,
            });
        }

        let mut commitments = Vec::new();
        for act in self.data.today.actions.iter().filter(|a| !a.done).take(3) {
            commitments.push(OpenCommitment {
                id: act.id.clone(),
                kind: "action".into(),
                title: act.title.clone(),
                person: "Owner".into(),
                channel: if act.tag.is_empty() {
                    "today".into()
                } else {
                    act.tag.clone()
                },
                age_hours: 4.0,
                urgency: "medium".into(),
                status: "open".into(),
            });
        }
        for person in self.data.today.people_radar.iter().take(2) {
            if commitments.len() >= 4 {
                break;
            }
            commitments.push(OpenCommitment {
                id: format!("radar-{}", person.key),
                kind: "followup".into(),
                title: clean_snippet(&person.preview, 72),
                person: person.name.clone(),
                channel: person
                    .channels
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "inbox".into()),
                age_hours: 12.0,
                urgency: "normal".into(),
                status: "open".into(),
            });
        }

        let summary = format!(
            "{} meetings prepped · {} open commitments · {} priority threads",
            meeting_preps.len(),
            commitments.len(),
            self.data.today.inbox_counts.priority
        );

        (
            IntelBriefing {
                summary,
                meeting_preps,
                commitments,
                cross_signals: Vec::new(),
            },
            false,
        )
    }

    /// Returns live `GET /api/box/ai-live` telemetry if hydrated, or synthesizes an honest
    /// offline fallback directly from active agents, gardeners, rooms, and workstreams so the
    /// Live AI Pill and Observatory never look empty when offline.
    pub fn box_ai_live_effective(&self) -> (BoxAiLiveSnapshot, bool) {
        if let Some(live) = &self.data.box_ai_live
            && live.has_live_data()
        {
            return (live.clone(), true);
        }

        let mut agents = Vec::new();
        let workers: Vec<_> = self
            .data
            .agents
            .agents
            .iter()
            .filter(|a| a.role != "owner")
            .take(8)
            .collect();

        for (i, w) in workers.iter().enumerate() {
            let b = w.brand.to_ascii_lowercase();
            let r = w.role.to_ascii_lowercase();
            let category = if b.contains("codex") || b.contains("claude") || r.contains("build") {
                if i % 3 == 1 { "designing" } else { "building" }
            } else if b.contains("dreamer") || r.contains("gardener") || r.contains("predict") {
                "predicting"
            } else {
                "orchestrating"
            };
            let runtime = if !w.brand.is_empty() {
                w.brand.clone()
            } else if !w.role.is_empty() {
                w.role.clone()
            } else {
                "agent".into()
            };
            let repo = w
                .recent_channels
                .first()
                .cloned()
                .unwrap_or_else(|| "kizuki/board".into());
            let action = if w.active_recent {
                format!(
                    "Active on {} ({} msgs · {} threads)",
                    repo, w.messages_count, w.threads_started
                )
            } else {
                format!("Standby on {} ({} msgs)", repo, w.messages_count)
            };
            agents.push(BoxAiAgent {
                id: format!("fallback-agent-{}", w.handle),
                name: if w.display_name.is_empty() {
                    w.handle.clone()
                } else {
                    w.display_name.clone()
                },
                runtime,
                category: category.into(),
                state: if w.active_recent {
                    "running".into()
                } else {
                    "idle".into()
                },
                pid: None,
                cpu_pct: if w.active_recent {
                    12.0 + (w.messages_count.min(60) as f32) * 0.4
                } else {
                    1.5
                },
                ram_mb: 340.0 + (w.threads_started.min(20) as f32) * 18.0,
                repo,
                current_action: action,
                active_tool: if w.active_recent {
                    "board-sync".into()
                } else {
                    "idle".into()
                },
            });
        }

        // Ensure predicting lane reflects active gardeners if no worker mapped there
        if !agents.iter().any(|a| a.category == "predicting") {
            for g in self.data.gardeners.gardeners.iter().take(2) {
                agents.push(BoxAiAgent {
                    id: format!("fallback-gardener-{}", g.id),
                    name: g.name.clone(),
                    runtime: if g.last_engine.is_empty() {
                        "gardener".into()
                    } else {
                        g.last_engine.clone()
                    },
                    category: "predicting".into(),
                    state: if g.status.is_empty() {
                        "active".into()
                    } else {
                        g.status.clone()
                    },
                    pid: None,
                    cpu_pct: 9.5,
                    ram_mb: 420.0,
                    repo: g
                        .domains
                        .first()
                        .cloned()
                        .unwrap_or_else(|| "vault/taste".into()),
                    current_action: if g.last_summary.is_empty() {
                        format!("{} runs · {} cultivated", g.runs_count, g.items_cultivated)
                    } else {
                        clean_snippet(&g.last_summary, 76)
                    },
                    active_tool: "cultivate".into(),
                });
            }
        }

        let mut bld = 0u32;
        let mut dsn = 0u32;
        let mut prd = 0u32;
        let mut orc = 0u32;
        let mut total_cpu = 0.0f32;
        let mut total_ram = 0.0f32;
        for a in &agents {
            match normalize_ai_category(&a.category) {
                "building" => bld += 1,
                "designing" => dsn += 1,
                "predicting" => prd += 1,
                _ => orc += 1,
            }
            total_cpu += a.cpu_pct;
            total_ram += a.ram_mb;
        }

        let resources = vec![
            BoxAiResource {
                id: "res-kizuki-vault".into(),
                label: "Kizuki Vault".into(),
                kind: "BRAIN".into(),
                metric: format!("{} docs", crate::data::format_k(self.data.today.summary.docs_total)),
                active_count: bld.max(1),
            },
            BoxAiResource {
                id: "res-agent-board".into(),
                label: "Agent Board :4100".into(),
                kind: "BUS".into(),
                metric: format!("{} msgs", self.data.health.totals.messages),
                active_count: orc.max(1),
            },
            BoxAiResource {
                id: "res-kizuki-rune".into(),
                label: "kizuki-mind-rune".into(),
                kind: "REPO".into(),
                metric: "Rust GPU".into(),
                active_count: dsn.max(1),
            },
            BoxAiResource {
                id: "res-local-gpu".into(),
                label: "Local GPU Synth".into(),
                kind: "GPU".into(),
                metric: if self.data.health.synth_ready {
                    "READY".into()
                } else {
                    "STANDBY".into()
                },
                active_count: prd.max(1),
            },
            BoxAiResource {
                id: "res-brain-daemon".into(),
                label: "Brain :4113".into(),
                kind: "BRAIN".into(),
                metric: format!("{} MemT", self.data.today.summary.memt_verified),
                active_count: (bld + prd).max(1),
            },
        ];

        let mut edges = Vec::new();
        for (i, a) in agents.iter().enumerate() {
            let res_idx = match normalize_ai_category(&a.category) {
                "building" => if i % 2 == 0 { 2 } else { 0 },
                "designing" => 2,
                "predicting" => if i % 2 == 0 { 3 } else { 4 },
                _ => 1,
            };
            let target = &resources[res_idx % resources.len()];
            edges.push(BoxAiEdge {
                id: format!("fb-edge-{i}"),
                from: a.id.clone(),
                to: target.id.clone(),
                category: a.category.clone(),
                label: a.active_tool.clone(),
                weight: (a.cpu_pct / 20.0).clamp(0.4, 2.0),
                cpu_pct: a.cpu_pct,
                active: a.state != "idle",
            });
        }

        (
            BoxAiLiveSnapshot {
                summary: BoxAiSummary {
                    total_live: agents.len() as u32,
                    building: bld,
                    designing: dsn,
                    predicting: prd,
                    orchestrating: orc,
                    total_cpu_pct: total_cpu,
                    total_ram_mb: total_ram,
                },
                agents,
                resources,
                edges,
            },
            false,
        )
    }

    /// Optimistically resolves or snoozes a commitment locally and posts to `/api/intel/commitment`.
    pub fn submit_commitment_op(&mut self, id: &str, op: CommitmentOp) {
        self.commitment_ops.insert(id.to_string(), op);
        if let Some(tx) = &self.write_tx {
            let _ = tx.send(BgRequest::Commitment {
                id: id.to_string(),
                op,
            });
        } else {
            self.apply_bg_outcome(BgOutcome::Commitment {
                id: id.to_string(),
                op,
                result: Err("offline".into()),
            });
        }
    }

    /// Strictly local quick capture (`POST /api/capture/quick`, zero outbound sends).
    pub fn submit_quick_capture(&mut self, kind: &str, title: &str, body: &str) {
        let norm_kind = match kind.to_ascii_lowercase().as_str() {
            "action" | "note" | "codex" | "memt" => kind.to_ascii_lowercase(),
            _ => "note".to_string(),
        };
        let clean_title = title.trim().to_string();
        if clean_title.is_empty() {
            return;
        }
        let clean_body = if body.trim().is_empty() {
            clean_title.clone()
        } else {
            body.trim().to_string()
        };

        self.write_seq = self.write_seq.saturating_add(1);
        if norm_kind == "action" {
            self.data.today.actions.insert(
                0,
                TodayAction {
                    id: format!("cap-{}", self.write_seq),
                    title: clean_title.clone(),
                    detail: clean_body.clone(),
                    tag: "captured".into(),
                    done: false,
                },
            );
        }

        if let Some(tx) = &self.write_tx {
            let _ = tx.send(BgRequest::QuickCapture {
                kind: norm_kind,
                title: clean_title,
                body: clean_body,
            });
        } else {
            self.apply_bg_outcome(BgOutcome::QuickCapture {
                kind: norm_kind,
                title: clean_title,
                result: Err("offline".into()),
            });
        }
    }

    /// Parses `capture action|note|codex|memt <title> [:: <body>]` from Cmd+K input.
    pub fn parse_quick_capture_query(raw: &str) -> Option<(String, String, String)> {
        let trimmed = raw.trim();
        let lower = trimmed.to_ascii_lowercase();
        let rest = if lower.starts_with("capture ") {
            trimmed[8..].trim()
        } else if lower.starts_with("cap ") {
            trimmed[4..].trim()
        } else {
            return None;
        };
        if rest.is_empty() {
            return None;
        }

        let mut parts = rest.splitn(2, char::is_whitespace);
        let first = parts.next().unwrap_or("").to_ascii_lowercase();
        let tail = parts.next().unwrap_or("").trim();

        let (kind, content) = match first.as_str() {
            "action" | "note" | "codex" | "memt" => {
                if tail.is_empty() {
                    return None;
                }
                (first, tail)
            }
            _ => ("note".to_string(), rest),
        };

        let (title, body) = if let Some((t, b)) = content.split_once("::") {
            (t.trim().to_string(), b.trim().to_string())
        } else if let Some((t, b)) = content.split_once(" | ") {
            (t.trim().to_string(), b.trim().to_string())
        } else {
            (content.to_string(), content.to_string())
        };

        if title.is_empty() {
            None
        } else {
            Some((kind, title, body))
        }
    }

    pub fn refresh_remote_commands(&mut self) {
        self.cmd_search_seq = self.cmd_search_seq.wrapping_add(1);
        let q = self.cmd_input.text.trim().to_string();
        let q_low = q.to_ascii_lowercase();
        if q.len() < 2 || q_low.starts_with("capture") || q_low.starts_with("cap ") {
            self.cmd_remote_hits.clear();
            self.cmd_semantic_hits.clear();
            return;
        }
        if let Some(stx) = &self.search_tx {
            if !self.connection.is_offline() {
                let _ = stx.send(SearchRequest {
                    seq: self.cmd_search_seq,
                    query: q,
                });
            }
            return;
        }
        if let Some(base) = self.api_base.clone()
            && !self.connection.is_offline()
        {
            self.cmd_remote_hits = resolve_command_remote(&base, &q);
            self.cmd_semantic_hits = fetch_semantic_recall(&base, &q, 6);
        }
    }

    pub fn filtered_commands(&self) -> Vec<CommandEntry> {
        let raw = self.cmd_input.text.trim();
        let q = raw.to_lowercase();

        // Instant Quick Capture verb (`capture action|note|codex|memt ...`)
        if let Some((kind, title, body)) = Self::parse_quick_capture_query(raw) {
            return vec![CommandEntry {
                kind: "CAPTURE",
                label: format!("Capture {}: {}", kind.to_uppercase(), title),
                detail: Some(format!(
                    "Local write -> POST /api/capture/quick (zero outbound sends){}",
                    if body != title {
                        format!(" · {}", clean_snippet(&body, 56))
                    } else {
                        String::new()
                    }
                )),
                hint: "Enter".into(),
                action: CommandAction::QuickCapture { kind, title, body },
            }];
        }

        let mut all = vec![
            CommandEntry {
                kind: "VIEW",
                label: "Switch to Flow Deck".into(),
                detail: None,
                hint: "Key 1".into(),
                action: CommandAction::SwitchView(ActiveView::FlowDeck),
            },
            CommandEntry {
                kind: "VIEW",
                label: "Switch to Board Studio".into(),
                detail: None,
                hint: "Key 2".into(),
                action: CommandAction::SwitchView(ActiveView::Board),
            },
            CommandEntry {
                kind: "VIEW",
                label: "Switch to Today Brief".into(),
                detail: None,
                hint: "Key 3".into(),
                action: CommandAction::SwitchView(ActiveView::Today),
            },
            CommandEntry {
                kind: "VIEW",
                label: "Switch to Mind & Codex".into(),
                detail: None,
                hint: "Key 4".into(),
                action: CommandAction::SwitchView(ActiveView::Mind),
            },
            CommandEntry {
                kind: "VIEW",
                label: "Switch to Box AI Live Observatory".into(),
                detail: Some("Building, Designing, Predicting, Orchestrating telemetry".into()),
                hint: "Key 5".into(),
                action: CommandAction::SwitchView(ActiveView::AiLive),
            },
            CommandEntry {
                kind: "MODE",
                label: if self.dark {
                    "Switch to Light Polarity".into()
                } else {
                    "Switch to Dark Polarity".into()
                },
                detail: None,
                hint: "Key T".into(),
                action: CommandAction::ToggleTheme,
            },
            CommandEntry {
                kind: "HELP",
                label: "Open Keyboard Shortcut Sheet".into(),
                detail: None,
                hint: "Key ?".into(),
                action: CommandAction::ToggleShortcuts,
            },
            CommandEntry {
                kind: "FILTER",
                label: "Clear Board Agent Filter".into(),
                detail: None,
                hint: "All".into(),
                action: CommandAction::FilterAgent(None),
            },
        ];

        for agent in self.data.agents.agents.iter().take(4) {
            let key = if !agent.brand.is_empty() {
                agent.brand.clone()
            } else {
                agent.role.clone()
            };
            all.push(CommandEntry {
                kind: "FILTER",
                label: format!("Filter Board by {}", agent.display_name),
                detail: None,
                hint: format!("{} msgs", agent.messages_count),
                action: CommandAction::FilterAgent(Some(key)),
            });
        }

        if let Some(u) = self.active_undo() {
            all.insert(
                0,
                CommandEntry {
                    kind: "UNDO",
                    label: format!("Undo {} on #{}", u.verdict.label(), u.thread_id),
                    detail: None,
                    hint: "Key U".into(),
                    action: CommandAction::UndoLast,
                },
            );
        }

        for gate in self.pending_decision_gates().into_iter().take(4) {
            all.push(CommandEntry {
                kind: "GATE",
                label: format!("Approve #{} {}", gate.id, gate.title),
                detail: None,
                hint: gate.channel.clone(),
                action: CommandAction::StampGate(gate.id.clone(), DecisionVerdict::Approved),
            });
            all.push(CommandEntry {
                kind: "THREAD",
                label: format!("Inspect #{} {}", gate.id, gate.title),
                detail: None,
                hint: "Enter".into(),
                action: CommandAction::InspectThread(gate.id),
            });
        }

        for hit in &self.cmd_remote_hits {
            let action = if hit.verb == "approve"
                && let Some(tid) = hit.target_id.clone()
            {
                CommandAction::StampGate(tid, DecisionVerdict::Approved)
            } else if let Some(tid) = hit.target_id.clone() {
                CommandAction::InspectThread(tid)
            } else {
                CommandAction::SwitchView(ActiveView::Board)
            };
            all.insert(
                0,
                CommandEntry {
                    kind: "LIVE",
                    label: hit.label.clone(),
                    detail: if !hit.preview.is_empty() && hit.preview != hit.label {
                        Some(clean_snippet(&hit.preview, 72))
                    } else {
                        None
                    },
                    hint: hit.verb.to_uppercase(),
                    action,
                },
            );
        }

        let neural_entries: Vec<CommandEntry> = self
            .cmd_semantic_hits
            .iter()
            .take(6)
            .map(|hit| {
                let score_str = if hit.score <= 1.0 && hit.score > 0.0 {
                    format!("{:.0}%", hit.score * 100.0)
                } else if hit.score > 1.0 {
                    format!("{:.0}", hit.score)
                } else {
                    "MATCH".into()
                };
                let kind_tag = if hit.kind.is_empty() {
                    "MEM".into()
                } else {
                    hit.kind.to_uppercase()
                };
                let detail_src = if !hit.snippet.is_empty() {
                    &hit.snippet
                } else {
                    &hit.subtitle
                };
                let detail = if detail_src.is_empty() {
                    None
                } else {
                    Some(clean_snippet(detail_src, 78))
                };
                CommandEntry {
                    kind: "NEURAL",
                    label: if hit.title.is_empty() {
                        hit.id.clone()
                    } else {
                        hit.title.clone()
                    },
                    detail,
                    hint: format!("{score_str} · {kind_tag}"),
                    action: CommandAction::OpenSemanticHit {
                        target_view: hit.target_view.clone(),
                        target_ref: hit.target_ref.clone(),
                        title: hit.title.clone(),
                    },
                }
            })
            .collect();

        if q.is_empty() {
            all.truncate(9);
            return all;
        }

        let mut scored: Vec<(i32, CommandEntry)> = all
            .into_iter()
            .filter_map(|cmd| {
                let hay = format!("{} {} {}", cmd.kind, cmd.label, cmd.hint).to_lowercase();
                fuzzy_score(&hay, &q).map(|sc| (sc, cmd))
            })
            .collect();
        scored.sort_by_key(|a| std::cmp::Reverse(a.0));

        // Merge lexical matches alongside NEURAL semantic recall hits so semantic matches
        // never get dropped by strict lexical substring filtering.
        let mut merged: Vec<CommandEntry> = Vec::with_capacity(9);
        let lexical_budget = if neural_entries.is_empty() { 9 } else { 5 };
        for (_, c) in scored.into_iter().take(lexical_budget) {
            merged.push(c);
        }
        for n in neural_entries {
            if merged.len() >= 9 {
                break;
            }
            if !merged
                .iter()
                .any(|m| m.label.eq_ignore_ascii_case(&n.label))
            {
                merged.push(n);
            }
        }
        merged
    }

    pub fn execute_command(&mut self, action: CommandAction) {
        self.cmd_open = false;
        self.cmd_input = TextEdit::new("");
        self.cmd_selected = 0;
        self.cmd_remote_hits.clear();
        self.cmd_semantic_hits.clear();
        match action {
            CommandAction::SwitchView(v) => self.view = v,
            CommandAction::ToggleTheme => self.dark = !self.dark,
            CommandAction::InspectThread(id) => self.focus_thread_in_board(&id),
            CommandAction::StampGate(id, verdict) => self.submit_verdict(&id, verdict),
            CommandAction::FilterAgent(agent) => {
                self.agent_filter = agent;
                self.view = ActiveView::Board;
                self.selected_thread_idx = 0;
            }
            CommandAction::UndoLast => {
                self.trigger_undo();
            }
            CommandAction::ToggleShortcuts => {
                self.shortcuts_open = !self.shortcuts_open;
            }
            CommandAction::OpenSemanticHit {
                target_view,
                target_ref,
                title,
            } => {
                let tv = target_view.to_ascii_lowercase();
                if tv.contains("board") && !target_ref.is_empty() {
                    self.focus_thread_in_board(&target_ref);
                } else if tv.contains("today") {
                    self.view = ActiveView::Today;
                } else if tv.contains("mind") || tv.contains("codex") || tv.contains("vault") {
                    self.view = ActiveView::Mind;
                } else if tv.contains("ai") || tv.contains("live") {
                    self.view = ActiveView::AiLive;
                } else if tv.contains("flow") {
                    self.view = ActiveView::FlowDeck;
                } else if !target_ref.is_empty() {
                    self.focus_thread_in_board(&target_ref);
                } else {
                    self.view = ActiveView::Mind;
                }
                self.status_toast = Some(StatusToast {
                    badge: "NEURAL",
                    message: format!("Recalled: {}", clean_snippet(&title, 76)),
                    is_live: true,
                    expires_at: Instant::now() + Duration::from_secs(10),
                });
            }
            CommandAction::QuickCapture { kind, title, body } => {
                self.submit_quick_capture(&kind, &title, &body);
            }
        }
    }
}

fn dispatch_bg_request(api_base: &str, req: BgRequest) -> BgOutcome {
    match req {
        BgRequest::Stamp(r) => {
            let payload = StampRequest {
                thread_id: r.thread_id.clone(),
                verdict: r.verdict.wire_value().to_string(),
                idempotency_key: r.idempotency_key.clone(),
                note: None,
                retract: if r.is_undo { Some(true) } else { None },
            };
            let result = post_decision_stamp(api_base, &payload);
            BgOutcome::Stamp(WriteOutcome {
                thread_id: r.thread_id,
                verdict: r.verdict,
                previous: r.previous,
                idempotency_key: r.idempotency_key,
                is_undo: r.is_undo,
                result,
            })
        }
        BgRequest::Commitment { id, op } => {
            let result = post_commitment_op(api_base, &id, op.wire_value());
            BgOutcome::Commitment { id, op, result }
        }
        BgRequest::QuickCapture { kind, title, body } => {
            let payload = QuickCaptureRequest {
                kind: kind.clone(),
                title: title.clone(),
                body,
            };
            let result = post_quick_capture(api_base, &payload);
            BgOutcome::QuickCapture {
                kind,
                title,
                result,
            }
        }
    }
}

fn fuzzy_score(haystack: &str, needle: &str) -> Option<i32> {
    if haystack.contains(needle) {
        return Some(100 - (haystack.len() as i32 - needle.len() as i32).min(60));
    }
    let mut h_chars = haystack.chars();
    let mut score = 0i32;
    for nc in needle.chars() {
        let mut found = false;
        for hc in h_chars.by_ref() {
            if hc == nc {
                score += 8;
                found = true;
                break;
            }
        }
        if !found {
            return None;
        }
    }
    Some(score)
}
