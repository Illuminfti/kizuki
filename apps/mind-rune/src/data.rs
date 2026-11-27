//! Live Kizuki Mind OS data models, SSE push & smart delta version polling plane,
//! ETag conditional fallback, C1 decision write-back client, C2 next-moves hydration,
//! Wave 3 proactive intel briefing, hybrid neural recall, local quick capture, and embedded snapshot.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::state::BoxAiLiveSnapshot;

const EMBEDDED_SNAPSHOT: &str = include_str!("../assets/live-snapshot.json");

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct SnapshotData {
    pub health: HealthData,
    pub mission: MissionData,
    pub agents: AgentsData,
    pub blockers: BlockersData,
    pub today: TodayData,
    pub taste: TasteData,
    pub gardeners: GardenersData,
    pub codex: CodexData,
    #[serde(skip)]
    pub next_moves: Vec<NextMoveItem>,
    #[serde(skip)]
    pub pending_decisions: Vec<PendingDecisionItem>,
    #[serde(skip)]
    pub intel_briefing: Option<IntelBriefing>,
    #[serde(skip)]
    pub box_ai_live: Option<BoxAiLiveSnapshot>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct HealthData {
    pub ok: bool,
    #[serde(rename = "boardOnline")]
    pub board_online: bool,
    #[serde(rename = "cockpitOnline")]
    pub cockpit_online: bool,
    #[serde(rename = "brainOnline")]
    pub brain_online: bool,
    #[serde(rename = "synthReady")]
    pub synth_ready: bool,
    pub totals: BoardTotals,
    pub seats: Vec<SeatInfo>,
    pub mesh: MeshSummary,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct BoardTotals {
    pub channels: u32,
    pub threads: u32,
    pub messages: u32,
    #[serde(rename = "openTasks")]
    pub open_tasks: u32,
    pub blocked: u32,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct MeshSummary {
    pub online: bool,
    pub nodes_total: u32,
    pub nodes_online: u32,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct SeatInfo {
    pub id: String,
    pub label: String,
    pub harness: String,
    pub family: String,
    pub model: String,
    pub eligible: bool,
    pub reason: String,
    pub headroom: f32,
    pub weekly_used_pct: Option<f32>,
    pub weekly_limit_pct: Option<f32>,
}

impl SeatInfo {
    pub fn headroom_pct(&self) -> u32 {
        if let Some(used) = self.weekly_used_pct {
            return (100.0 - used).clamp(0.0, 100.0).round() as u32;
        }
        (self.headroom * 100.0).clamp(0.0, 100.0).round() as u32
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct MissionData {
    pub items: Vec<MissionItem>,
    #[serde(rename = "telemetryCount")]
    pub telemetry_count: u32,
    #[serde(rename = "signalCount")]
    pub signal_count: u32,
    #[serde(rename = "activeRooms")]
    pub active_rooms: Vec<ActiveRoom>,
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct MissionItem {
    pub id: String,
    pub channel: String,
    pub title: String,
    pub text: String,
    pub by: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub role: String,
    pub brand: String,
    pub state: Option<String>,
    pub replies: Option<u32>,
    #[serde(rename = "replyCount")]
    pub reply_count: Option<u32>,
    #[serde(rename = "createdAt")]
    pub created_at: Option<String>,
    pub created_at_snake: Option<String>,
    pub recommendation: Option<String>,
}

impl MissionItem {
    pub fn author_label(&self) -> &str {
        if !self.display_name.is_empty() {
            &self.display_name
        } else if !self.by.is_empty() {
            &self.by
        } else {
            "Agent"
        }
    }

    pub fn brand_key(&self) -> &str {
        if !self.brand.is_empty() {
            &self.brand
        } else if !self.role.is_empty() {
            &self.role
        } else {
            &self.by
        }
    }

    #[allow(dead_code)]
    pub fn headline(&self) -> String {
        let src = if !self.title.is_empty() {
            &self.title
        } else {
            &self.text
        };
        clean_snippet(src, 110)
    }

    pub fn replies_total(&self) -> u32 {
        self.reply_count.or(self.replies).unwrap_or(0)
    }

    pub fn timestamp(&self) -> Option<&str> {
        self.created_at
            .as_deref()
            .or(self.created_at_snake.as_deref())
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct ActiveRoom {
    pub channel: String,
    pub name: String,
    #[serde(rename = "groupLabel")]
    pub group_label: String,
    #[serde(rename = "signalCount")]
    pub signal_count: u32,
    #[serde(rename = "blockedCount")]
    pub blocked_count: u32,
    #[serde(rename = "decisionCount")]
    pub decision_count: u32,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct AgentsData {
    pub agents: Vec<AgentPresence>,
    #[serde(rename = "meshNodes")]
    pub mesh_nodes: Vec<MeshNode>,
    pub seats: Vec<SeatInfo>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct AgentPresence {
    pub handle: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub role: String,
    pub brand: String,
    #[serde(rename = "messagesCount")]
    pub messages_count: u32,
    #[serde(rename = "threadsStarted")]
    pub threads_started: u32,
    #[serde(rename = "recentChannels")]
    pub recent_channels: Vec<String>,
    #[serde(rename = "activeRecent")]
    pub active_recent: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct MeshNode {
    pub node_id: String,
    pub role: String,
    pub host: String,
    pub status: String,
    pub load1: Option<f32>,
    pub mem_available_gib: Option<f32>,
    pub active_runs: u32,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct BlockersData {
    pub counts: BlockerCounts,
    #[serde(rename = "orchestratorQueue")]
    pub orchestrator_queue: Vec<DecisionBlocker>,
    pub paused: Vec<PausedBlocker>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct BlockerCounts {
    #[serde(rename = "orchestratorQueue")]
    pub orchestrator_queue: u32,
    pub escalations: u32,
    pub paused: u32,
    pub stalled: u32,
    pub intake: u32,
    #[serde(rename = "attentionTotal")]
    pub attention_total: u32,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct DecisionBlocker {
    pub id: String,
    pub channel: String,
    pub project: String,
    pub text: String,
    pub recommendation: Option<String>,
    pub state: String,
    pub by: String,
    pub created_at: String,
    pub replies: u32,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct PausedBlocker {
    pub id: String,
    pub channel: String,
    pub project: String,
    pub text: String,
    pub state: String,
    pub kind: Option<String>,
    pub question: Option<String>,
    pub rec: Option<String>,
    pub created_at: String,
    pub replies: u32,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct TodayData {
    pub generated_at: String,
    pub summary: TodaySummary,
    pub schedule: Vec<ScheduleEvent>,
    pub actions: Vec<TodayAction>,
    pub inbox_counts: InboxCounts,
    pub people_radar: Vec<PersonRadar>,
    pub whoop: WhoopSnapshot,
    pub workstreams: Vec<Workstream>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct TodaySummary {
    pub events_total: u64,
    pub docs_total: u64,
    pub people_total: u64,
    pub atlas_panels: u32,
    pub active_pipelines: u32,
    pub total_pipelines: u32,
    pub claims_live: u64,
    pub memt_verified: u32,
    pub open_actions: u32,
    pub priority_inbox_count: u32,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct ScheduleEvent {
    pub id: String,
    pub title: String,
    pub start: String,
    pub end: String,
    pub countdown: String,
    pub is_now: bool,
    pub is_today: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct TodayAction {
    pub id: String,
    pub title: String,
    pub detail: String,
    pub tag: String,
    pub done: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct InboxCounts {
    pub priority: u32,
    pub all: u32,
    pub whatsapp: u32,
    pub imessage: u32,
    pub gmail: u32,
    pub telegram: u32,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct PersonRadar {
    pub key: String,
    pub name: String,
    pub initials: String,
    pub channels: Vec<String>,
    pub last_seen_label: String,
    pub preview: String,
    pub message_count: u32,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct WhoopSnapshot {
    pub recovery_pct: u32,
    pub recovery_zone: String,
    pub hrv_ms: f32,
    pub rhr_bpm: u32,
    pub sleep_hours: f32,
    pub summary: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct Workstream {
    pub name: String,
    pub domain: String,
    pub state: String,
    pub next_move: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct TasteData {
    pub stats: TasteStats,
    pub domains: Vec<TasteDomain>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct TasteStats {
    pub total_questions: u32,
    pub answered_count: u32,
    pub remaining_count: u32,
    pub skipped_count: u32,
    pub vault_docs_count: u32,
    pub calibration_pct: u32,
    pub streak_count: u32,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct TasteDomain {
    pub id: String,
    pub label: String,
    pub answered: u32,
    pub total: u32,
    pub pct: u32,
    pub signature_traits: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct GardenersData {
    pub stats: GardenerStats,
    pub gardeners: Vec<GardenerInfo>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct GardenerStats {
    pub gardeners_total: u32,
    pub gardeners_running: u32,
    pub domains_cultivated: u32,
    pub domains_total: u32,
    pub total_frameworks: u32,
    pub total_principles: u32,
    pub total_policies: u32,
    pub runs_total: u32,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct GardenerInfo {
    pub id: String,
    pub name: String,
    pub domains: Vec<String>,
    pub status: String,
    pub runs_count: u32,
    pub items_cultivated: u32,
    pub last_engine: String,
    pub last_summary: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct CodexData {
    pub stats: CodexStats,
    pub sections: Vec<CodexSection>,
    pub open_decisions: Vec<CodexDecision>,
    pub items: Vec<CodexEntry>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct CodexStats {
    pub total: u32,
    pub philosophies: u32,
    pub interests: u32,
    pub hobbies: u32,
    pub ideas: u32,
    pub actions_open: u32,
    pub actions_done: u32,
    pub bookmarks: u32,
    pub decisions_open: u32,
    pub pinned: u32,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct CodexSection {
    pub id: String,
    pub label: String,
    pub count: u32,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct CodexDecision {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub domain: String,
    pub leverage_score: u32,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct CodexEntry {
    pub id: String,
    pub section: String,
    pub title: String,
    pub domain: String,
    pub conviction: String,
    pub leverage_score: u32,
}

/// Contract C2: GET /api/today/next-moves
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct NextMoveItem {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub why_now: String,
    pub score: f32,
    pub verbs: Vec<String>,
    pub thread_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
struct NextMovesEnvelope {
    pub moves: Vec<NextMoveItem>,
}

/// Contract C1: GET /api/decisions/pending
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct PendingDecisionItem {
    #[serde(alias = "threadId", alias = "id")]
    pub thread_id: String,
    pub channel: String,
    pub title: String,
    pub text: String,
    pub recommendation: Option<String>,
    pub by: String,
    pub created_at: String,
    pub replies: u32,
    pub stamped: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
struct PendingDecisionsEnvelope {
    pub pending: Vec<PendingDecisionItem>,
    pub decisions: Vec<PendingDecisionItem>,
    pub items: Vec<PendingDecisionItem>,
}

/// Contract C1: POST /api/decisions/stamp payload.
#[derive(Clone, Debug, Serialize)]
pub struct StampRequest {
    #[serde(rename = "threadId")]
    pub thread_id: String,
    pub verdict: String,
    #[serde(rename = "idempotencyKey")]
    pub idempotency_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retract: Option<bool>,
}

/// Area 6: POST /api/command/resolve response (graceful optional).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct RemoteCommandHit {
    pub verb: String,
    pub preview: String,
    pub label: String,
    pub target_id: Option<String>,
}

/// Wave 3: GET /api/intel/briefing proactive daily briefing payload (fail-soft).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct IntelBriefing {
    pub summary: String,
    #[serde(alias = "meetingPreps")]
    pub meeting_preps: Vec<MeetingPrep>,
    pub commitments: Vec<OpenCommitment>,
    #[serde(alias = "crossSignals")]
    pub cross_signals: Vec<CrossSignal>,
}

impl IntelBriefing {
    pub fn has_content(&self) -> bool {
        !self.summary.trim().is_empty()
            || !self.meeting_preps.is_empty()
            || !self.commitments.is_empty()
            || !self.cross_signals.is_empty()
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct MeetingPrep {
    pub id: String,
    pub title: String,
    #[serde(alias = "timeLabel")]
    pub time_label: String,
    pub attendees: Vec<String>,
    #[serde(alias = "lastTouch")]
    pub last_touch: String,
    #[serde(alias = "openLoopsCount")]
    pub open_loops_count: u32,
    #[serde(alias = "talkingPoints")]
    pub talking_points: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct OpenCommitment {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub person: String,
    pub channel: String,
    #[serde(alias = "ageHours")]
    pub age_hours: f32,
    pub urgency: String,
    pub status: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct CrossSignal {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub detail: String,
}

/// Wave 3: POST /api/intel/commitment payload.
#[derive(Clone, Debug, Serialize)]
pub struct CommitmentOpRequest {
    pub id: String,
    pub op: String,
}

/// Wave 3: GET /api/semantic/recall hit item.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct SemanticHit {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub subtitle: String,
    pub snippet: String,
    pub score: f32,
    #[serde(alias = "matchMode")]
    pub match_mode: String,
    #[serde(alias = "targetView")]
    pub target_view: String,
    #[serde(alias = "targetRef")]
    pub target_ref: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
struct SemanticRecallEnvelope {
    pub hits: Vec<SemanticHit>,
    pub items: Vec<SemanticHit>,
    pub results: Vec<SemanticHit>,
}

/// Wave 3: POST /api/capture/quick strictly-local capture payload.
#[derive(Clone, Debug, Serialize)]
pub struct QuickCaptureRequest {
    pub kind: String,
    pub title: String,
    pub body: String,
}

/// Wave 3: GET /api/live/status version fingerprint.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct LiveVersions {
    pub vault: u64,
    pub board: u64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
struct LiveStatusResponse {
    pub versions: Option<LiveVersions>,
    pub vault: Option<u64>,
    pub board: Option<u64>,
}

impl LiveStatusResponse {
    fn resolved_versions(&self) -> Option<LiveVersions> {
        if let Some(v) = self.versions {
            return Some(v);
        }
        if self.vault.is_some() || self.board.is_some() {
            return Some(LiveVersions {
                vault: self.vault.unwrap_or(0),
                board: self.board.unwrap_or(0),
            });
        }
        None
    }
}

/// Normalized gate card shown in Flow Deck "WHAT NEEDS YOU" and Today pulse.
#[derive(Clone, Debug)]
pub struct DecisionGateCard {
    pub id: String,
    pub channel: String,
    pub title: String,
    pub recommendation: String,
    pub author: String,
    pub age_label: String,
    pub age_ratio: f32,
    pub replies: u32,
}

/// Honest live/degraded/offline status pill state.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConnectionState {
    Live {
        hits: usize,
        total: usize,
        synced_secs_ago: u64,
    },
    Degraded {
        hits: usize,
        total: usize,
        synced_secs_ago: u64,
    },
    Offline {
        snapshot_date: String,
    },
}

impl ConnectionState {
    pub fn pill_label(&self) -> String {
        match self {
            ConnectionState::Live {
                hits,
                total,
                synced_secs_ago,
            } => {
                if *synced_secs_ago == 0 {
                    format!("LIVE {hits}/{total} · now")
                } else {
                    format!("LIVE {hits}/{total} · {synced_secs_ago}s ago")
                }
            }
            ConnectionState::Degraded {
                hits,
                total,
                synced_secs_ago,
            } => {
                if *synced_secs_ago == 0 {
                    format!("DEGRADED {hits}/{total}")
                } else {
                    format!("DEGRADED {hits}/{total} · {synced_secs_ago}s ago")
                }
            }
            ConnectionState::Offline { snapshot_date } => {
                format!("OFFLINE snapshot {snapshot_date}")
            }
        }
    }

    pub fn is_live(&self) -> bool {
        matches!(self, ConnectionState::Live { .. })
    }

    pub fn is_offline(&self) -> bool {
        matches!(self, ConnectionState::Offline { .. })
    }
}

/// Rolling telemetry history for live hardware rack sparklines (zero hardcoded fake waveforms).
#[derive(Clone, Debug)]
pub struct TelemetryHistory {
    pub host_load: VecDeque<f32>,
    pub board_msgs: VecDeque<f32>,
    pub cockpit_blocked: VecDeque<f32>,
    pub brain_events: VecDeque<f32>,
    pub synth_runs: VecDeque<f32>,
}

impl TelemetryHistory {
    pub fn from_snapshot(data: &SnapshotData) -> Self {
        let mut h = Self {
            host_load: VecDeque::with_capacity(24),
            board_msgs: VecDeque::with_capacity(24),
            cockpit_blocked: VecDeque::with_capacity(24),
            brain_events: VecDeque::with_capacity(24),
            synth_runs: VecDeque::with_capacity(24),
        };
        // Seed initial multi-point traces from real snapshot distributions (zero synthetic constants).
        for node in &data.agents.mesh_nodes {
            if let Some(l) = node.load1 {
                push_ring(&mut h.host_load, (l / 14.0).max(0.05));
            }
        }
        for room in data.mission.active_rooms.iter().take(10) {
            push_ring(&mut h.board_msgs, room.signal_count as f32);
            push_ring(&mut h.cockpit_blocked, room.blocked_count as f32);
        }
        for dom in data.taste.domains.iter().take(8) {
            push_ring(&mut h.brain_events, dom.pct as f32);
        }
        for g in data.gardeners.gardeners.iter().take(8) {
            push_ring(&mut h.synth_runs, g.runs_count as f32);
        }
        h.record(data);
        h
    }

    pub fn record(&mut self, data: &SnapshotData) {
        let load = data.host_load_ratio().unwrap_or(0.0);
        let msgs = data.health.totals.messages as f32;
        let blocked = data.health.totals.blocked as f32;
        let events = (data.today.summary.events_total as f32) / 1000.0;
        let runs = data.gardeners.stats.runs_total as f32;
        push_ring(&mut self.host_load, load);
        push_ring(&mut self.board_msgs, msgs);
        push_ring(&mut self.cockpit_blocked, blocked);
        push_ring(&mut self.brain_events, events);
        push_ring(&mut self.synth_runs, runs);
    }

    pub fn series_for(&self, idx: usize) -> Vec<f32> {
        let src = match idx {
            0 => &self.host_load,
            1 => &self.board_msgs,
            2 => &self.cockpit_blocked,
            3 => &self.brain_events,
            _ => &self.synth_runs,
        };
        src.iter().copied().collect()
    }
}

fn push_ring(q: &mut VecDeque<f32>, val: f32) {
    if q.len() >= 24 {
        q.pop_front();
    }
    q.push_back(val);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PollTier {
    All,
    BoardFast,
    TodayMedium,
    MindSlow,
}

#[derive(Clone, Debug, Default)]
pub struct PollSummary {
    pub live_hits: usize,
    pub not_modified_304: usize,
    pub changed: bool,
    pub delta_skipped: bool,
    pub live_versions: Option<LiveVersions>,
}

/// Conditional HTTP (Contract C5 ETag / If-None-Match) + Wave 3 `/api/live/status`
/// version-fingerprinted delta polling client.
pub struct PollClient {
    base: String,
    agent: ureq::Agent,
    fast_agent: ureq::Agent,
    etags: HashMap<String, String>,
    endpoint_ok: [bool; 8],
    last_success: Option<Instant>,
    consecutive_failures: u32,
    last_live_versions: Option<LiveVersions>,
    delta_skips: usize,
}

impl PollClient {
    pub fn new(base: impl Into<String>) -> Self {
        let base = base.into().trim_end_matches('/').to_string();
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_millis(900))
            .timeout_read(Duration::from_millis(4500))
            .build();
        let fast_agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_millis(500))
            .timeout_read(Duration::from_millis(1200))
            .build();
        Self {
            base,
            agent,
            fast_agent,
            etags: HashMap::new(),
            endpoint_ok: [false; 8],
            last_success: None,
            consecutive_failures: 0,
            last_live_versions: None,
            delta_skips: 0,
        }
    }

    pub fn delta_skips(&self) -> usize {
        self.delta_skips
    }

    /// Lightweight version fingerprint probe (`GET /api/live/status`).
    /// Returns `None` cleanly if the endpoint is 404 or unreachable.
    pub fn check_live_status(&self) -> Option<LiveVersions> {
        let url = format!("{}/api/live/status", self.base);
        let resp = self.fast_agent.get(&url).call().ok()?;
        if resp.status() != 200 {
            return None;
        }
        let parsed = resp.into_json::<LiveStatusResponse>().ok()?;
        parsed.resolved_versions()
    }

    /// Smart delta poll: checks `/api/live/status` version fingerprints first so unchanged views
    /// skip redundant HTTP fetches entirely. Falls back cleanly to ETag polling when absent.
    pub fn poll_smart_delta(
        &mut self,
        data: &mut SnapshotData,
        force_today: bool,
        force_mind: bool,
    ) -> PollSummary {
        if let Some(versions) = self.check_live_status() {
            let all_hydrated = self.endpoint_ok.iter().all(|ok| *ok);
            if self.last_live_versions == Some(versions)
                && all_hydrated
                && !force_today
                && !force_mind
            {
                self.delta_skips = self.delta_skips.saturating_add(1);
                self.consecutive_failures = 0;
                self.last_success = Some(Instant::now());
                return PollSummary {
                    live_hits: 8,
                    not_modified_304: 0,
                    changed: false,
                    delta_skipped: true,
                    live_versions: Some(versions),
                };
            }

            let prev = self.last_live_versions;
            let board_changed = prev.is_none_or(|p| p.board != versions.board)
                || !self.endpoint_ok[0..4].iter().all(|ok| *ok);
            let vault_changed = prev.is_none_or(|p| p.vault != versions.vault)
                || !self.endpoint_ok[4..8].iter().all(|ok| *ok);

            let mut out = PollSummary {
                live_hits: self.endpoint_ok.iter().filter(|ok| **ok).count(),
                not_modified_304: 0,
                changed: false,
                delta_skipped: false,
                live_versions: Some(versions),
            };

            if board_changed {
                let b = self.poll_tier(PollTier::BoardFast, data);
                out.not_modified_304 += b.not_modified_304;
                out.changed |= b.changed;
            }
            if vault_changed || force_today {
                let t = self.poll_tier(PollTier::TodayMedium, data);
                out.not_modified_304 += t.not_modified_304;
                out.changed |= t.changed;
            }
            if vault_changed || force_mind {
                let m = self.poll_tier(PollTier::MindSlow, data);
                out.not_modified_304 += m.not_modified_304;
                out.changed |= m.changed;
            }

            self.last_live_versions = Some(versions);
            out.live_hits = self.endpoint_ok.iter().filter(|ok| **ok).count();
            return out;
        }

        // Fail-soft fallback when /api/live/status is 404 or server is offline.
        let mut out = self.poll_tier(PollTier::BoardFast, data);
        if force_today {
            let t = self.poll_tier(PollTier::TodayMedium, data);
            out.not_modified_304 += t.not_modified_304;
            out.changed |= t.changed;
        }
        if force_mind {
            let m = self.poll_tier(PollTier::MindSlow, data);
            out.not_modified_304 += m.not_modified_304;
            out.changed |= m.changed;
        }
        out.live_hits = self.endpoint_ok.iter().filter(|ok| **ok).count();
        out
    }

    pub fn backoff_delay(&self, base_delay: Duration) -> Duration {
        if self.consecutive_failures == 0 {
            return base_delay;
        }
        let shift = self.consecutive_failures.min(2);
        let scaled = base_delay.saturating_mul(1u32 << shift);
        scaled.min(Duration::from_secs(8))
    }

    pub fn connection_state(&self, snapshot_date: &str) -> ConnectionState {
        let hits = self.endpoint_ok.iter().filter(|ok| **ok).count();
        let synced_secs_ago = self
            .last_success
            .map(|t| t.elapsed().as_secs())
            .unwrap_or(0);
        if hits == 0 {
            ConnectionState::Offline {
                snapshot_date: snapshot_date.to_string(),
            }
        } else if hits == 8 {
            ConnectionState::Live {
                hits,
                total: 8,
                synced_secs_ago,
            }
        } else {
            ConnectionState::Degraded {
                hits,
                total: 8,
                synced_secs_ago,
            }
        }
    }

    pub fn poll_tier(&mut self, tier: PollTier, data: &mut SnapshotData) -> PollSummary {
        let mut summary = PollSummary {
            live_hits: 0,
            not_modified_304: 0,
            changed: false,
            delta_skipped: false,
            live_versions: self.last_live_versions,
        };
        let mut attempted = 0usize;
        let mut succeeded = 0usize;

        let poll_board = matches!(tier, PollTier::All | PollTier::BoardFast);
        let poll_today = matches!(tier, PollTier::All | PollTier::TodayMedium);
        let poll_mind = matches!(tier, PollTier::All | PollTier::MindSlow);

        if poll_board {
            attempted += 4;
            match self.fetch_conditional::<HealthData>("/api/agent-board/health") {
                FetchOutcome::Fresh(v) => {
                    data.health = v;
                    self.endpoint_ok[0] = true;
                    succeeded += 1;
                    summary.changed = true;
                }
                FetchOutcome::NotModified => {
                    self.endpoint_ok[0] = true;
                    succeeded += 1;
                    summary.not_modified_304 += 1;
                }
                FetchOutcome::Failed => {
                    self.endpoint_ok[0] = false;
                }
            }
            match self.fetch_conditional::<MissionData>("/api/agent-board/mission?limit=15") {
                FetchOutcome::Fresh(v) => {
                    data.mission = v;
                    self.endpoint_ok[1] = true;
                    succeeded += 1;
                    summary.changed = true;
                }
                FetchOutcome::NotModified => {
                    self.endpoint_ok[1] = true;
                    succeeded += 1;
                    summary.not_modified_304 += 1;
                }
                FetchOutcome::Failed => {
                    self.endpoint_ok[1] = false;
                }
            }
            match self.fetch_conditional::<AgentsData>("/api/agent-board/agents") {
                FetchOutcome::Fresh(v) => {
                    data.agents = v;
                    self.endpoint_ok[2] = true;
                    succeeded += 1;
                    summary.changed = true;
                }
                FetchOutcome::NotModified => {
                    self.endpoint_ok[2] = true;
                    succeeded += 1;
                    summary.not_modified_304 += 1;
                }
                FetchOutcome::Failed => {
                    self.endpoint_ok[2] = false;
                }
            }
            match self.fetch_conditional::<BlockersData>("/api/agent-board/blockers") {
                FetchOutcome::Fresh(v) => {
                    data.blockers = v;
                    self.endpoint_ok[3] = true;
                    succeeded += 1;
                    summary.changed = true;
                }
                FetchOutcome::NotModified => {
                    self.endpoint_ok[3] = true;
                    succeeded += 1;
                    summary.not_modified_304 += 1;
                }
                FetchOutcome::Failed => {
                    self.endpoint_ok[3] = false;
                }
            }

            // Optional C1 /api/decisions/pending (graceful fallback when endpoint absent)
            if let FetchOutcome::Fresh(val) =
                self.fetch_conditional::<serde_json::Value>("/api/decisions/pending")
            {
                let parsed = parse_pending_decisions(&val);
                if !parsed.is_empty() {
                    data.pending_decisions = parsed;
                    summary.changed = true;
                }
            }

            // Optional Always-On Box AI Live telemetry (`GET /api/box/ai-live`, fail-soft)
            if let FetchOutcome::Fresh(ai_live) =
                self.fetch_conditional::<BoxAiLiveSnapshot>("/api/box/ai-live")
                && ai_live.has_live_data()
            {
                data.box_ai_live = Some(ai_live);
                summary.changed = true;
            }
        }

        if poll_today {
            attempted += 1;
            match self.fetch_conditional::<TodayData>("/api/today") {
                FetchOutcome::Fresh(v) => {
                    data.today = v;
                    self.endpoint_ok[4] = true;
                    succeeded += 1;
                    summary.changed = true;
                }
                FetchOutcome::NotModified => {
                    self.endpoint_ok[4] = true;
                    succeeded += 1;
                    summary.not_modified_304 += 1;
                }
                FetchOutcome::Failed => {
                    self.endpoint_ok[4] = false;
                }
            }

            // Optional C2 /api/today/next-moves (graceful fallback when absent)
            if let FetchOutcome::Fresh(val) =
                self.fetch_conditional::<serde_json::Value>("/api/today/next-moves")
            {
                let parsed = parse_next_moves(&val);
                if !parsed.is_empty() {
                    data.next_moves = parsed;
                    summary.changed = true;
                }
            }

            // Optional Wave 3 /api/intel/briefing (graceful fallback when absent)
            if let FetchOutcome::Fresh(briefing) =
                self.fetch_conditional::<IntelBriefing>("/api/intel/briefing")
                && briefing.has_content()
            {
                data.intel_briefing = Some(briefing);
                summary.changed = true;
            }
        }

        if poll_mind {
            attempted += 3;
            match self.fetch_conditional::<TasteData>("/api/taste") {
                FetchOutcome::Fresh(v) => {
                    data.taste = v;
                    self.endpoint_ok[5] = true;
                    succeeded += 1;
                    summary.changed = true;
                }
                FetchOutcome::NotModified => {
                    self.endpoint_ok[5] = true;
                    succeeded += 1;
                    summary.not_modified_304 += 1;
                }
                FetchOutcome::Failed => {
                    self.endpoint_ok[5] = false;
                }
            }
            match self.fetch_conditional::<GardenersData>("/api/taste/gardeners") {
                FetchOutcome::Fresh(v) => {
                    data.gardeners = v;
                    self.endpoint_ok[6] = true;
                    succeeded += 1;
                    summary.changed = true;
                }
                FetchOutcome::NotModified => {
                    self.endpoint_ok[6] = true;
                    succeeded += 1;
                    summary.not_modified_304 += 1;
                }
                FetchOutcome::Failed => {
                    self.endpoint_ok[6] = false;
                }
            }
            match self.fetch_conditional::<CodexData>("/api/codex") {
                FetchOutcome::Fresh(v) => {
                    data.codex = v;
                    self.endpoint_ok[7] = true;
                    succeeded += 1;
                    summary.changed = true;
                }
                FetchOutcome::NotModified => {
                    self.endpoint_ok[7] = true;
                    succeeded += 1;
                    summary.not_modified_304 += 1;
                }
                FetchOutcome::Failed => {
                    self.endpoint_ok[7] = false;
                }
            }
        }

        if attempted > 0 && succeeded == 0 {
            self.consecutive_failures = self.consecutive_failures.saturating_add(1);
            // If all fast-tier probes fail, server is unreachable: clear stale ok flags so
            // pill transitions honestly to OFFLINE within 10s.
            if poll_board {
                self.endpoint_ok = [false; 8];
            }
        } else if succeeded > 0 {
            self.consecutive_failures = 0;
            self.last_success = Some(Instant::now());
        }

        summary.live_hits = self.endpoint_ok.iter().filter(|ok| **ok).count();
        summary
    }

    fn fetch_conditional<T: serde::de::DeserializeOwned>(&mut self, path: &str) -> FetchOutcome<T> {
        let url = format!("{}{}", self.base, path);
        let mut req = self.agent.get(&url);
        if let Some(etag) = self.etags.get(path) {
            req = req.set("If-None-Match", etag);
        }
        match req.call() {
            Ok(resp) => {
                if resp.status() == 304 {
                    return FetchOutcome::NotModified;
                }
                if let Some(etag) = resp.header("etag").or_else(|| resp.header("ETag")) {
                    self.etags.insert(path.to_string(), etag.to_string());
                }
                match resp.into_json::<T>() {
                    Ok(v) => FetchOutcome::Fresh(v),
                    Err(_) => FetchOutcome::Failed,
                }
            }
            Err(_) => FetchOutcome::Failed,
        }
    }
}

enum FetchOutcome<T> {
    Fresh(T),
    NotModified,
    Failed,
}

fn parse_next_moves(val: &serde_json::Value) -> Vec<NextMoveItem> {
    if let Ok(env) = serde_json::from_value::<NextMovesEnvelope>(val.clone())
        && !env.moves.is_empty()
    {
        return env.moves;
    }
    serde_json::from_value::<Vec<NextMoveItem>>(val.clone()).unwrap_or_default()
}

fn parse_pending_decisions(val: &serde_json::Value) -> Vec<PendingDecisionItem> {
    if let Ok(env) = serde_json::from_value::<PendingDecisionsEnvelope>(val.clone()) {
        if !env.pending.is_empty() {
            return env.pending;
        }
        if !env.decisions.is_empty() {
            return env.decisions;
        }
        if !env.items.is_empty() {
            return env.items;
        }
    }
    serde_json::from_value::<Vec<PendingDecisionItem>>(val.clone()).unwrap_or_default()
}

/// Posts a Contract C1 stamp or undo request to the live server.
pub fn post_decision_stamp(base: &str, payload: &StampRequest) -> Result<u16, String> {
    let base = base.trim_end_matches('/');
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(1200))
        .timeout_read(Duration::from_millis(5000))
        .build();

    let url = format!("{base}/api/decisions/stamp");
    match agent
        .post(&url)
        .set("Content-Type", "application/json")
        .send_json(payload)
    {
        Ok(resp) => {
            let status = resp.status();
            if (200..300).contains(&status) {
                Ok(status)
            } else {
                Err(format!("HTTP {status}"))
            }
        }
        Err(ureq::Error::Status(404, _)) if payload.retract == Some(true) => {
            // Fallback to /api/decisions/undo if stamp endpoint does not handle retract.
            let undo_url = format!("{base}/api/decisions/undo");
            match agent
                .post(&undo_url)
                .set("Content-Type", "application/json")
                .send_json(payload)
            {
                Ok(resp) if (200..300).contains(&resp.status()) => Ok(resp.status()),
                Ok(resp) => Err(format!("HTTP {}", resp.status())),
                Err(ureq::Error::Status(code, _)) => Err(format!("HTTP {code}")),
                Err(e) => Err(e.to_string()),
            }
        }
        Err(ureq::Error::Status(code, _)) => Err(format!("HTTP {code}")),
        Err(e) => Err(e.to_string()),
    }
}

/// Optional Area 6 live command resolution (`POST /api/command/resolve`).
pub fn resolve_command_remote(base: &str, query: &str) -> Vec<RemoteCommandHit> {
    let q = query.trim();
    if q.is_empty() {
        return Vec::new();
    }
    let base = base.trim_end_matches('/');
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(500))
        .timeout_read(Duration::from_millis(1200))
        .build();
    let url = format!("{base}/api/command/resolve");
    let body = serde_json::json!({ "q": q });
    let Ok(resp) = agent
        .post(&url)
        .set("Content-Type", "application/json")
        .send_json(body)
    else {
        return Vec::new();
    };
    let Ok(val) = resp.into_json::<serde_json::Value>() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Some(verb) = val.get("verb").and_then(|v| v.as_str()) {
        let preview = val
            .get("preview")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let target_id = val
            .get("target")
            .and_then(|t| t.get("id"))
            .and_then(|v| v.as_str())
            .map(str::to_owned);
        out.push(RemoteCommandHit {
            verb: verb.to_string(),
            label: if preview.is_empty() {
                format!("{verb} {q}")
            } else {
                preview.clone()
            },
            preview,
            target_id,
        });
    }
    if let Some(arr) = val.get("items").and_then(|v| v.as_array()) {
        for item in arr.iter().take(5) {
            if let Ok(hit) = serde_json::from_value::<RemoteCommandHit>(item.clone())
                && !hit.label.is_empty()
            {
                out.push(hit);
            }
        }
    }
    out
}

/// Wave 3: POST /api/intel/commitment (resolve or snooze an open commitment locally).
pub fn post_commitment_op(base: &str, id: &str, op: &str) -> Result<u16, String> {
    let base = base.trim_end_matches('/');
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(900))
        .timeout_read(Duration::from_millis(3000))
        .build();
    let url = format!("{base}/api/intel/commitment");
    let payload = CommitmentOpRequest {
        id: id.to_string(),
        op: op.to_string(),
    };
    match agent
        .post(&url)
        .set("Content-Type", "application/json")
        .send_json(&payload)
    {
        Ok(resp) if (200..300).contains(&resp.status()) => Ok(resp.status()),
        Ok(resp) => Err(format!("HTTP {}", resp.status())),
        Err(ureq::Error::Status(404, _)) => Err("HTTP 404".into()),
        Err(ureq::Error::Status(code, _)) => Err(format!("HTTP {code}")),
        Err(e) => Err(e.to_string()),
    }
}

/// Wave 3: GET /api/semantic/recall?q=...&limit=... (hybrid neural semantic recall, fail-soft).
pub fn fetch_semantic_recall(base: &str, query: &str, limit: usize) -> Vec<SemanticHit> {
    let q = query.trim();
    if q.len() < 2 {
        return Vec::new();
    }
    let base = base.trim_end_matches('/');
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(450))
        .timeout_read(Duration::from_millis(1200))
        .build();
    let url = format!(
        "{base}/api/semantic/recall?q={}&limit={}",
        url_encode(q),
        limit.clamp(1, 12)
    );
    let Ok(resp) = agent.get(&url).call() else {
        return Vec::new();
    };
    if resp.status() != 200 {
        return Vec::new();
    }
    let Ok(val) = resp.into_json::<serde_json::Value>() else {
        return Vec::new();
    };
    if let Ok(env) = serde_json::from_value::<SemanticRecallEnvelope>(val.clone()) {
        if !env.hits.is_empty() {
            return env.hits;
        }
        if !env.items.is_empty() {
            return env.items;
        }
        if !env.results.is_empty() {
            return env.results;
        }
    }
    serde_json::from_value::<Vec<SemanticHit>>(val).unwrap_or_default()
}

/// Wave 3: POST /api/capture/quick (strictly local quick capture, zero outbound sends).
pub fn post_quick_capture(base: &str, payload: &QuickCaptureRequest) -> Result<u16, String> {
    let base = base.trim_end_matches('/');
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(900))
        .timeout_read(Duration::from_millis(3000))
        .build();
    let url = format!("{base}/api/capture/quick");
    match agent
        .post(&url)
        .set("Content-Type", "application/json")
        .send_json(payload)
    {
        Ok(resp) if (200..300).contains(&resp.status()) => Ok(resp.status()),
        Ok(resp) => Err(format!("HTTP {}", resp.status())),
        Err(ureq::Error::Status(404, _)) => Err("HTTP 404".into()),
        Err(ureq::Error::Status(code, _)) => Err(format!("HTTP {code}")),
        Err(e) => Err(e.to_string()),
    }
}

fn url_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 12);
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            b' ' => out.push_str("%20"),
            _ => {
                out.push_str(&format!("%{b:02X}"));
            }
        }
    }
    out
}

/// Spawns the non-blocking SSE push listener + smart delta polling loop that pushes updates via
/// `AppHandle::update` ONLY when real data versions or connection states change (keeping idle
/// GPU frames at strictly 0 and RAM tiny).
pub fn spawn_background_poller(
    api_base: String,
    initial_data: SnapshotData,
    handle: rune::AppHandle<crate::state::AppState>,
    visible: Arc<AtomicBool>,
) {
    let wake_signal = Arc::new((Mutex::new(0u64), Condvar::new()));
    let sse_connected = Arc::new(AtomicBool::new(false));

    // Lightweight SSE push subscriber (`GET /api/live/events`).
    // Fails soft with 45s backoff when endpoint is 404 or offline.
    let sse_base = api_base.trim_end_matches('/').to_string();
    let sse_wake = wake_signal.clone();
    let sse_flag = sse_connected.clone();
    let sse_vis = visible.clone();
    let sse_epoch = Arc::new(AtomicU64::new(0));
    std::thread::Builder::new()
        .name("kizuki-sse-listener".into())
        .spawn(move || {
            let agent = ureq::AgentBuilder::new()
                .timeout_connect(Duration::from_millis(900))
                .timeout_read(Duration::from_secs(30))
                .build();
            let url = format!("{sse_base}/api/live/events");
            loop {
                if !sse_vis.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_secs(2));
                    continue;
                }
                match agent
                    .get(&url)
                    .set("Accept", "text/event-stream")
                    .set("Cache-Control", "no-cache")
                    .call()
                {
                    Ok(resp) if resp.status() == 200 => {
                        let is_sse = resp
                            .header("content-type")
                            .is_some_and(|ct| ct.to_ascii_lowercase().contains("event-stream"));
                        if !is_sse {
                            sse_flag.store(false, Ordering::Relaxed);
                            std::thread::sleep(Duration::from_secs(45));
                            continue;
                        }
                        sse_flag.store(true, Ordering::Relaxed);
                        let mut reader = BufReader::new(resp.into_reader());
                        let mut line = String::new();
                        loop {
                            line.clear();
                            match reader.read_line(&mut line) {
                                Ok(0) => break,
                                Ok(_) => {
                                    let trimmed = line.trim();
                                    if trimmed.starts_with("data:")
                                        && !trimmed.contains("heartbeat")
                                        && !trimmed.contains("ping")
                                    {
                                        let next = sse_epoch.fetch_add(1, Ordering::Relaxed) + 1;
                                        if let Ok(mut guard) = sse_wake.0.lock() {
                                            *guard = next;
                                            sse_wake.1.notify_all();
                                        }
                                    }
                                }
                                Err(_) => break,
                            }
                        }
                        sse_flag.store(false, Ordering::Relaxed);
                        std::thread::sleep(Duration::from_secs(4));
                    }
                    Err(ureq::Error::Status(404, _)) => {
                        sse_flag.store(false, Ordering::Relaxed);
                        std::thread::sleep(Duration::from_secs(60));
                    }
                    _ => {
                        sse_flag.store(false, Ordering::Relaxed);
                        std::thread::sleep(Duration::from_secs(12));
                    }
                }
            }
        })
        .ok();

    std::thread::Builder::new()
        .name("kizuki-live-poller".into())
        .spawn(move || {
            let mut client = PollClient::new(api_base);
            let mut data = initial_data;
            let snapshot_date = data.snapshot_date();

            // Immediate non-blocking first hydration right after window opens.
            let first = client.poll_tier(PollTier::All, &mut data);
            let initial_versions = client.check_live_status();
            client.last_live_versions = initial_versions;
            let first_conn = client.connection_state(&snapshot_date);
            let mut last_conn_kind = conn_kind_tag(&first_conn);
            let mut last_sse = sse_connected.load(Ordering::Relaxed);
            let snapshot_clone = data.clone();
            handle.update(move |st, tx| {
                st.apply_live_poll(snapshot_clone, first_conn, first.changed);
                st.apply_live_meta(last_sse, initial_versions, 0);
                if first.changed {
                    tx.animated();
                }
            });

            let mut last_today = Instant::now();
            let mut last_mind = Instant::now();
            let mut seen_wake = 0u64;

            loop {
                let wait = client.backoff_delay(Duration::from_secs(5));
                if let Ok(guard) = wake_signal.0.lock()
                    && *guard == seen_wake
                {
                    let (new_guard, _) = wake_signal
                        .1
                        .wait_timeout(guard, wait)
                        .unwrap_or_else(|e| e.into_inner());
                    seen_wake = *new_guard;
                } else if let Ok(guard) = wake_signal.0.lock() {
                    seen_wake = *guard;
                }

                if !visible.load(Ordering::Relaxed) {
                    continue;
                }

                let force_today = last_today.elapsed() >= Duration::from_secs(30);
                let force_mind = last_mind.elapsed() >= Duration::from_secs(120);
                let summary = client.poll_smart_delta(&mut data, force_today, force_mind);
                if force_today {
                    last_today = Instant::now();
                }
                if force_mind {
                    last_mind = Instant::now();
                }

                let conn = client.connection_state(&snapshot_date);
                let conn_kind = conn_kind_tag(&conn);
                let sse_now = sse_connected.load(Ordering::Relaxed);
                let meta_changed = conn_kind != last_conn_kind || sse_now != last_sse;

                // Zero idle GPU frames: only wake UI when actual data changed or connection
                // polarity transitioned.
                if summary.changed || meta_changed {
                    last_conn_kind = conn_kind;
                    last_sse = sse_now;
                    let data_clone = data.clone();
                    let skips = client.delta_skips();
                    let vers = summary.live_versions;
                    let changed = summary.changed;
                    handle.update(move |st, tx| {
                        st.apply_live_poll(data_clone, conn, changed);
                        st.apply_live_meta(sse_now, vers, skips);
                        if changed {
                            tx.animated();
                        }
                    });
                }
            }
        })
        .ok();
}

fn conn_kind_tag(c: &ConnectionState) -> u8 {
    match c {
        ConnectionState::Live { .. } => 2,
        ConnectionState::Degraded { .. } => 1,
        ConnectionState::Offline { .. } => 0,
    }
}

impl SnapshotData {
    pub fn load_embedded() -> Self {
        serde_json::from_str(EMBEDDED_SNAPSHOT).unwrap_or_default()
    }

    pub fn snapshot_date(&self) -> String {
        let raw = if !self.today.generated_at.is_empty() {
            &self.today.generated_at
        } else if !self.mission.generated_at.is_empty() {
            &self.mission.generated_at
        } else {
            ""
        };
        if raw.len() >= 10 {
            raw[..10].to_string()
        } else {
            "local".to_string()
        }
    }

    #[allow(dead_code)]
    pub fn formatted_today_date(&self) -> String {
        let d = self.snapshot_date();
        if d.len() == 10 {
            let parts: Vec<&str> = d.split('-').collect();
            if parts.len() == 3 {
                let month = match parts[1] {
                    "01" => "JANUARY",
                    "02" => "FEBRUARY",
                    "03" => "MARCH",
                    "04" => "APRIL",
                    "05" => "MAY",
                    "06" => "JUNE",
                    "07" => "JULY",
                    "08" => "AUGUST",
                    "09" => "SEPTEMBER",
                    "10" => "OCTOBER",
                    "11" => "NOVEMBER",
                    "12" => "DECEMBER",
                    _ => parts[1],
                };
                let day = parts[2].trim_start_matches('0');
                return format!("{month} {day}, {}", parts[0]);
            }
        }
        "TODAY".to_string()
    }

    pub fn reference_epoch_secs(&self) -> Option<i64> {
        parse_iso8601_epoch(&self.mission.generated_at)
            .or_else(|| parse_iso8601_epoch(&self.today.generated_at))
    }

    pub fn decision_gates(&self) -> Vec<DecisionGateCard> {
        let ref_epoch = self.reference_epoch_secs();
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();

        // Prefer C1 /api/decisions/pending items if hydrated from live server
        for item in &self.pending_decisions {
            if item.stamped.is_some() || !seen.insert(item.thread_id.clone()) {
                continue;
            }
            let (age_label, age_ratio) = relative_age(&item.created_at, ref_epoch);
            let title_src = if !item.title.is_empty() {
                &item.title
            } else {
                &item.text
            };
            out.push(DecisionGateCard {
                id: item.thread_id.clone(),
                channel: if item.channel.is_empty() {
                    "board".into()
                } else {
                    item.channel.clone()
                },
                title: clean_snippet(title_src, 96),
                recommendation: item
                    .recommendation
                    .as_deref()
                    .map(|r| clean_snippet(r, 102))
                    .unwrap_or_else(|| "Review proposal and stamp disposition.".into()),
                author: if item.by.is_empty() {
                    "agent".into()
                } else {
                    item.by.clone()
                },
                age_label,
                age_ratio,
                replies: item.replies,
            });
        }

        for item in &self.blockers.orchestrator_queue {
            if !seen.insert(item.id.clone()) {
                continue;
            }
            let (age_label, age_ratio) = relative_age(&item.created_at, ref_epoch);
            out.push(DecisionGateCard {
                id: item.id.clone(),
                channel: item.channel.clone(),
                title: clean_snippet(&item.text, 96),
                recommendation: item
                    .recommendation
                    .as_deref()
                    .map(|r| clean_snippet(r, 102))
                    .unwrap_or_else(|| "Review config delta and approve rollout.".into()),
                author: if item.by.is_empty() {
                    "claude".into()
                } else {
                    item.by.clone()
                },
                age_label,
                age_ratio,
                replies: item.replies,
            });
        }

        if let Some(p) = self.blockers.paused.first()
            && seen.insert(p.id.clone())
        {
            let (age_label, age_ratio) = relative_age(&p.created_at, ref_epoch);
            out.push(DecisionGateCard {
                id: p.id.clone(),
                channel: p.channel.clone(),
                title: clean_snippet(&p.text, 96),
                recommendation: p
                    .rec
                    .as_deref()
                    .map(|r| clean_snippet(r, 102))
                    .unwrap_or_else(|| "Confirm disposition or close paused item.".into()),
                author: p.kind.clone().unwrap_or_else(|| "paused".into()),
                age_label,
                age_ratio,
                replies: p.replies,
            });
        }
        out
    }

    pub fn active_agent_count(&self) -> usize {
        self.agents
            .agents
            .iter()
            .filter(|a| a.messages_count > 0 || a.active_recent)
            .count()
    }

    pub fn owner_message_count(&self) -> Option<u32> {
        self.agents
            .agents
            .iter()
            .find(|a| a.role == "owner")
            .map(|a| a.messages_count)
    }

    pub fn host_load_ratio(&self) -> Option<f32> {
        self.agents
            .mesh_nodes
            .iter()
            .find(|n| n.role == "primary" || n.node_id == "local-node")
            .or_else(|| self.agents.mesh_nodes.first())
            .and_then(|n| n.load1)
            .map(|l| (l / 14.0).max(0.05))
    }

    pub fn host_mem_gib(&self) -> Option<f32> {
        self.agents
            .mesh_nodes
            .iter()
            .find(|n| n.role == "primary" || n.node_id == "local-node")
            .or_else(|| self.agents.mesh_nodes.first())
            .and_then(|n| n.mem_available_gib)
    }

    pub fn seats_effective(&self) -> &[SeatInfo] {
        if !self.health.seats.is_empty() {
            &self.health.seats
        } else {
            &self.agents.seats
        }
    }
}

/// Parses ISO-8601 UTC timestamp `YYYY-MM-DDTHH:MM:SS...` into Unix epoch seconds (pure Rust, zero deps).
pub fn parse_iso8601_epoch(s: &str) -> Option<i64> {
    if s.len() < 19 {
        return None;
    }
    let y: i64 = s.get(0..4)?.parse().ok()?;
    let m: i64 = s.get(5..7)?.parse().ok()?;
    let d: i64 = s.get(8..10)?.parse().ok()?;
    let hh: i64 = s.get(11..13)?.parse().ok()?;
    let mm: i64 = s.get(14..16)?.parse().ok()?;
    let ss: i64 = s.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    // Howard Hinnant civil-from-days inverse
    let y_adj = y - if m <= 2 { 1 } else { 0 };
    let era = if y_adj >= 0 { y_adj } else { y_adj - 399 } / 400;
    let yoe = y_adj - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(days * 86400 + hh * 3600 + mm * 60 + ss)
}

fn relative_age(created_at: &str, ref_epoch: Option<i64>) -> (String, f32) {
    let (Some(ts), Some(now)) = (parse_iso8601_epoch(created_at), ref_epoch) else {
        return ("n/a".into(), 0.25);
    };
    let diff = (now - ts).max(0);
    let hours = diff as f32 / 3600.0;
    let ratio = (hours / 72.0).clamp(0.12, 1.0);
    let label = if diff < 3600 {
        format!("{}m", (diff / 60).max(1))
    } else if diff < 48 * 3600 {
        format!("{}h", diff / 3600)
    } else {
        format!("{}d", diff / 86400)
    };
    (label, ratio)
}

pub fn clean_snippet(raw: &str, max_chars: usize) -> String {
    let single: String = raw
        .replace(['\n', '\r'], " ")
        .replace('\u{2014}', " - ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    // Clean only `@[local:user:ubuntu+name]` mentions without stripping normal `[TAG]` brackets.
    let mut cleaned = String::with_capacity(single.len());
    let mut rest = single.as_str();
    while let Some(pos) = rest.find("@[local:user:ubuntu+") {
        cleaned.push_str(&rest[..pos]);
        let after = &rest[pos + "@[local:user:ubuntu+".len()..];
        if let Some(end) = after.find(']') {
            cleaned.push('@');
            cleaned.push_str(&after[..end]);
            rest = &after[end + 1..];
        } else {
            cleaned.push('@');
            rest = after;
        }
    }
    cleaned.push_str(rest);

    if cleaned.chars().count() <= max_chars {
        cleaned
    } else {
        let budget = max_chars.saturating_sub(3);
        let raw_cut: String = cleaned.chars().take(budget).collect();
        let word_cut = match raw_cut.rfind(char::is_whitespace) {
            Some(idx) if idx > budget / 2 => &raw_cut[..idx],
            _ => raw_cut.as_str(),
        };
        let trimmed = word_cut.trim_end_matches(|c: char| {
            c.is_whitespace() || matches!(c, '.' | ',' | ';' | ':' | '-')
        });
        format!("{trimmed}...")
    }
}

pub fn format_k(n: u64) -> String {
    if n >= 1000 {
        format!("{:.1}K", n as f64 / 1000.0)
    } else {
        n.to_string()
    }
}
