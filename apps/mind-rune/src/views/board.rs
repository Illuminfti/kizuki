//! View 2: Board (3-Pane Linear Workspace).
//! Left 232px agent rail, center growing signal stream, right 480px editorial reader,
//! separated solely by two full-height hairline vertical rules with zero outer pane boxes.

use rune::tok::motion;
use rune::{El, ScrollSpec, TextEdit, Tx, col, el, row, spacer, text};

use crate::state::{AppState, DecisionVerdict, WriteStatus};
use crate::theme::{Palette, Tone, kit, radius, space, typo};

#[derive(Clone)]
struct StreamEntry {
    id: String,
    channel: String,
    project: String,
    author: String,
    brand: String,
    title: String,
    body: String,
    recommendation: Option<String>,
    replies: u32,
    created_at: String,
    is_blocked: bool,
}

const KNOWN_LEAD_INS: &[&str] = &[
    "investigate and fix recurring friction:",
    "refine worker/reviewer prompt or skill guardrail to prevent:",
    "investigate and fix:",
];

const KNOWN_COLON_PREFIXES: &[&str] = &[
    "rsi",
    "ops",
    "gate",
    "plan",
    "decision",
    "alert",
    "triage",
    "incident",
    "audit",
    "dream",
    "sync",
    "ci",
    "cron",
    "infra",
    "sec",
    "bot",
];

/// Strips a leading machine prefix (`[gate]`, `[plan]`, `[RSI MEDIUM / code_fix]`, `rsi:`, `ops:`)
/// plus known RSI boilerplate lead-ins, returning `(tag, clean_headline)`.
/// Leaves plain human titles unchanged.
pub fn split_machine_prefix(title: &str) -> (Option<&str>, &str) {
    let trimmed = title.trim();
    if let Some(rest) = trimmed.strip_prefix('[')
        && let Some(close) = rest.find(']')
    {
        let tag = rest[..close].trim();
        let after = rest[close + 1..].trim_start();
        if !tag.is_empty() && !after.is_empty() {
            let cleaned = strip_known_lead_in(after);
            let headline = if cleaned.is_empty() { after } else { cleaned };
            return (Some(tag), headline);
        }
    }

    if let Some(colon) = trimmed.find(':') {
        let prefix = &trimmed[..colon];
        let after = trimmed[colon + 1..].trim_start();
        if !prefix.is_empty()
            && prefix.len() <= 12
            && !after.is_empty()
            && prefix
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            && KNOWN_COLON_PREFIXES
                .iter()
                .any(|k| prefix.eq_ignore_ascii_case(k))
        {
            return (Some(prefix), after);
        }
    }

    (None, trimmed)
}

fn strip_known_lead_in(s: &str) -> &str {
    let lower = s.to_ascii_lowercase();
    for lead in KNOWN_LEAD_INS {
        if lower.starts_with(lead) {
            return s[lead.len()..].trim_start();
        }
    }
    s
}

/// Formats an extracted machine prefix into calm sentence-case text so it never
/// emits shouting all-caps runs while staying honest to the source tag.
fn format_prefix_tag(raw: &str) -> String {
    let parts: Vec<&str> = raw
        .split('/')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    if parts.len() >= 2 {
        let head = parts[0];
        let tail = parts[1].replace('_', " ");
        if head.to_ascii_uppercase().starts_with("RSI") {
            return format!("RSI · {}", tail.to_ascii_lowercase());
        }
        return format!("{} · {}", title_word(head), tail.to_ascii_lowercase());
    }
    if raw.eq_ignore_ascii_case("rsi") {
        return "RSI".to_string();
    }
    if raw.eq_ignore_ascii_case("ci") {
        return "CI".to_string();
    }
    title_word(&raw.replace('_', " "))
}

fn title_word(raw: &str) -> String {
    let trimmed = raw.trim();
    let mut chars = trimmed.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    let mut out = String::with_capacity(trimmed.len());
    out.extend(first.to_uppercase());
    out.push_str(&chars.as_str().to_ascii_lowercase());
    out
}

/// Cleans `@[local:user:ubuntu+handle]` mentions and strips em-dashes without
/// touching normal bracketed tags (`[RSI ...]`) or truncating any content.
fn sanitize_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    const MENTION_PREFIX: &str = "@[local:user:ubuntu+";
    while let Some(idx) = rest.find(MENTION_PREFIX) {
        out.push_str(&rest[..idx]);
        let after = &rest[idx + MENTION_PREFIX.len()..];
        if let Some(close) = after.find(']') {
            out.push('@');
            out.push_str(&after[..close]);
            rest = &after[close + 1..];
        } else {
            out.push('@');
            rest = after;
        }
    }
    out.push_str(rest);

    let normalized = out.replace('\u{2014}', " - ").replace("\r\n", "\n");
    let mut lines = Vec::new();
    for line in normalized.lines() {
        let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
        lines.push(collapsed);
    }
    lines.join("\n").trim().to_string()
}

/// Strips a trailing `Recommendation: ...` section from blocker body text when
/// `recommendation` is already displayed in its dedicated callout block.
fn strip_trailing_recommendation(body: &str, has_rec: bool) -> String {
    if !has_rec {
        return body.to_string();
    }
    if let Some(idx) = body.find("\n\nRecommendation:") {
        return body[..idx].trim().to_string();
    }
    if let Some(idx) = body.find("\nRecommendation:") {
        return body[..idx].trim().to_string();
    }
    body.to_string()
}

/// Extracts an untruncated full title and non-duplicating body for a stream entry.
fn extract_title_and_body(raw_title: Option<&str>, raw_body: &str, has_rec: bool) -> (String, String) {
    let clean_body_full = strip_trailing_recommendation(&sanitize_text(raw_body), has_rec);

    // Prefer an untruncated explicit title when provided; otherwise derive from the first
    // line or sentence of the full text so nothing is ever cut mid-word with "...".
    if let Some(t) = raw_title {
        let clean_t = sanitize_text(t);
        if !clean_t.is_empty() && !clean_t.ends_with("...") {
            let body = strip_duplicate_lead(&clean_t, &clean_body_full);
            return (clean_t, body);
        }
    }

    let first_line = clean_body_full.lines().next().unwrap_or("").trim();
    if first_line.is_empty() {
        let fallback = raw_title.map(sanitize_text).unwrap_or_default();
        return (fallback, String::new());
    }

    // If the first line is a multi-sentence paragraph, split cleanly at the first
    // sentence boundary (`. `, `? `, `! `) so the reader title is a complete sentence
    // and the remainder flows naturally into the body with zero truncation.
    if first_line.chars().count() > 140
        && let Some(split_at) = find_sentence_split(first_line)
    {
        let title = first_line[..split_at].trim().to_string();
        let rest_of_first = first_line[split_at..].trim();
        let rest_lines: Vec<&str> = clean_body_full.lines().skip(1).collect();
        let mut body_parts = Vec::new();
        if !rest_of_first.is_empty() {
            body_parts.push(rest_of_first.to_string());
        }
        if !rest_lines.is_empty() {
            let tail = rest_lines.join("\n").trim().to_string();
            if !tail.is_empty() {
                body_parts.push(tail);
            }
        }
        return (title, body_parts.join("\n\n"));
    }

    let title = first_line.to_string();
    let body = strip_duplicate_lead(&title, &clean_body_full);
    (title, body)
}

fn find_sentence_split(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    for i in 24..bytes.len().saturating_sub(2) {
        let b = bytes[i];
        if (b == b'.' || b == b'?' || b == b'!') && bytes[i + 1] == b' ' {
            return Some(i + 1);
        }
    }
    None
}

fn strip_duplicate_lead(title: &str, body: &str) -> String {
    let b = body.trim();
    if b.is_empty() || b == title.trim() {
        return String::new();
    }
    if let Some(rest) = b.strip_prefix(title.trim()) {
        return rest.trim().to_string();
    }
    b.to_string()
}

fn build_stream(s: &AppState) -> Vec<StreamEntry> {
    let mut entries = Vec::new();
    for b in s.data.blockers.orchestrator_queue.iter().take(4) {
        let rec = b
            .recommendation
            .as_deref()
            .map(sanitize_text)
            .filter(|r| !r.is_empty());
        let (title, body) = extract_title_and_body(None, &b.text, rec.is_some());
        entries.push(StreamEntry {
            id: b.id.clone(),
            channel: b.channel.clone(),
            project: b.project.clone(),
            author: if b.by.is_empty() {
                "Claude".into()
            } else {
                b.by.clone()
            },
            brand: if b.by.contains("claude") {
                "claude".into()
            } else {
                "keeper".into()
            },
            title,
            body,
            recommendation: rec,
            replies: b.replies,
            created_at: b.created_at.clone(),
            is_blocked: true,
        });
    }
    for m in s.data.mission.items.iter().take(12) {
        if entries.iter().any(|e| e.id == m.id) {
            continue;
        }
        let rec = m
            .recommendation
            .as_deref()
            .map(sanitize_text)
            .filter(|r| !r.is_empty());
        let raw_title = if m.title.is_empty() {
            None
        } else {
            Some(m.title.as_str())
        };
        let (title, body) = extract_title_and_body(raw_title, &m.text, rec.is_some());
        entries.push(StreamEntry {
            id: m.id.clone(),
            channel: m.channel.clone(),
            project: m.channel.split('/').next().unwrap_or("box").to_string(),
            author: m.author_label().to_string(),
            brand: m.brand_key().to_string(),
            title,
            body,
            recommendation: rec,
            replies: m.replies_total(),
            created_at: m.timestamp().unwrap_or("").to_string(),
            is_blocked: m.state.as_deref() == Some("blocked"),
        });
    }
    entries
}

fn monogram_code(name: &str) -> String {
    let words: Vec<&str> = name
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    if words.len() >= 2 {
        let second_is_word = words[1].chars().any(|c| c.is_ascii_alphabetic())
            && !words[1].chars().all(|c| c.is_ascii_hexdigit() && words[1].len() >= 5);
        if second_is_word {
            let a = words[0].chars().next().unwrap_or('A');
            let b = words[1].chars().next().unwrap_or('G');
            return format!("{}{}", a.to_ascii_uppercase(), b.to_ascii_uppercase());
        }
    }
    let flat: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(2)
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if flat.is_empty() { "AG".into() } else { flat }
}

fn format_commas(n: u32) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, ch) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

fn verdict_label(v: DecisionVerdict) -> &'static str {
    match v {
        DecisionVerdict::Approved => "Approved",
        DecisionVerdict::Revised => "Revise queued",
        DecisionVerdict::Deferred => "Deferred",
    }
}

fn verdict_tone(v: DecisionVerdict) -> Tone {
    match v {
        DecisionVerdict::Approved => Tone::Live,
        DecisionVerdict::Revised => Tone::Caution,
        DecisionVerdict::Deferred => Tone::Neutral,
    }
}

fn format_replies(n: u32) -> String {
    match n {
        1 => "1 reply".into(),
        _ => format!("{n} replies"),
    }
}

/// Parses an ISO-8601 UTC prefix (`YYYY-MM-DDTHH:MM:SS`) into unix-like seconds for
/// deterministic snapshot-relative age calculation without reading wall-clock time.
fn parse_iso_seconds(ts: &str) -> Option<i64> {
    let b = ts.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') {
        return None;
    }
    let year: i64 = ts[0..4].parse().ok()?;
    let month: i64 = ts[5..7].parse().ok()?;
    let day: i64 = ts[8..10].parse().ok()?;
    let hour: i64 = ts[11..13].parse().ok()?;
    let min: i64 = ts[14..16].parse().ok()?;
    let sec: i64 = ts[17..19].parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let y = year - i64::from(month <= 2);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hour * 3600 + min * 60 + sec)
}

fn format_relative_age(created_at: &str, reference_ts: &str) -> Option<String> {
    let created = parse_iso_seconds(created_at)?;
    let now = parse_iso_seconds(reference_ts)?;
    let diff = (now - created).max(0);
    if diff < 60 {
        Some("just now".into())
    } else if diff < 3600 {
        Some(format!("{}m ago", diff / 60))
    } else if diff < 86_400 * 2 {
        Some(format!("{}h ago", diff / 3600))
    } else {
        Some(format!("{}d ago", diff / 86_400))
    }
}

fn format_opened_timestamp(ts: &str) -> String {
    if ts.len() >= 16 && ts.as_bytes()[10] == b'T' {
        format!("{} {} UTC", &ts[0..10], &ts[11..16])
    } else if ts.is_empty() {
        "Unknown".into()
    } else {
        ts.to_string()
    }
}

pub fn view(s: &AppState, p: &Palette) -> El {
    let all_entries = build_stream(s);
    let decisions_count = all_entries.iter().filter(|e| e.is_blocked).count();
    let filtered: Vec<StreamEntry> = match s.agent_filter.as_deref() {
        Some("decisions") => all_entries
            .iter()
            .filter(|e| e.is_blocked)
            .cloned()
            .collect(),
        Some(f) => {
            let fl = f.to_lowercase();
            let v: Vec<_> = all_entries
                .iter()
                .filter(|e| {
                    e.brand.to_lowercase().contains(&fl) || e.author.to_lowercase().contains(&fl)
                })
                .cloned()
                .collect();
            if v.is_empty() { all_entries } else { v }
        }
        None => all_entries,
    };

    let selected_idx = s.selected_thread_idx.min(filtered.len().saturating_sub(1));
    let selected = filtered.get(selected_idx).cloned();
    let ref_ts = if !s.data.mission.generated_at.is_empty() {
        s.data.mission.generated_at.as_str()
    } else {
        s.data.today.generated_at.as_str()
    };

    row()
        .key("board-view")
        .w_full()
        .h_full()
        .fill(p.canvas)
        .child(presence_rail(s, p))
        .child(kit::rule_v(p))
        .child(signal_stream(
            s,
            &filtered,
            selected_idx,
            decisions_count,
            ref_ts,
            p,
        ))
        .child(kit::rule_v(p))
        .child(editorial_reader(s, selected.as_ref(), ref_ts, p))
}

fn presence_rail(s: &AppState, p: &Palette) -> El {
    let all_active = s.agent_filter.is_none();
    let agents: Vec<(String, String, String, String, u32, bool)> = s
        .data
        .agents
        .agents
        .iter()
        .take(12)
        .map(|a| {
            let name = if a.display_name.is_empty() {
                a.handle.clone()
            } else {
                a.display_name.clone()
            };
            let code = monogram_code(&name);
            let filter_key = if !a.brand.is_empty() {
                a.brand.clone()
            } else {
                a.role.clone()
            };
            let rooms = a
                .recent_channels
                .iter()
                .take(2)
                .cloned()
                .collect::<Vec<_>>()
                .join(" · ");
            (code, name, filter_key, rooms, a.messages_count, a.active_recent)
        })
        .collect();

    let mut all_row = kit::list_row(all_active, p)
        .key("filter-all")
        .role("button")
        .label("All signals")
        .focusable(true)
        .focus_ring(2.0, 1.5, p.focus_ring)
        .py(6.0)
        .min_h(32.0)
        .gap(space::S2)
        .on_press(|st: &mut AppState| {
            st.agent_filter = None;
            st.selected_thread_idx = 0;
        })
        .child(
            text("All signals")
                .font(if all_active {
                    typo::BODY_STRONG
                } else {
                    typo::BODY
                })
                .color(if all_active { p.ink } else { p.ink_secondary }),
        )
        .child(spacer())
        .child(
            text(format_commas(s.data.mission.signal_count))
                .font(typo::NUM_S)
                .color(p.ink_muted),
        );
    if all_active {
        all_row = all_row.child(kit::focus_bar(p));
    }

    let blocked_count = s.data.health.totals.blocked;
    let footer = col()
        .w_full()
        .pt(space::S2)
        .gap(space::S1)
        .child(
            row()
                .w_full()
                .justify_between()
                .items_center()
                .child(text("Threads").font(typo::CAPTION).color(p.ink_muted))
                .child(
                    text(format_commas(s.data.health.totals.threads))
                        .font(typo::NUM_S)
                        .color(p.ink_secondary),
                ),
        )
        .child(
            row()
                .w_full()
                .justify_between()
                .items_center()
                .child(text("Open tasks").font(typo::CAPTION).color(p.ink_muted))
                .child(
                    text(format_commas(s.data.health.totals.open_tasks))
                        .font(typo::NUM_S)
                        .color(p.ink_secondary),
                ),
        )
        .child(
            row()
                .w_full()
                .justify_between()
                .items_center()
                .child(text("Blocked").font(typo::CAPTION).color(p.ink_muted))
                .child(
                    text(format_commas(blocked_count))
                        .font(typo::NUM_S)
                        .color(if blocked_count > 0 {
                            p.tone(Tone::Caution)
                        } else {
                            p.ink_secondary
                        }),
                ),
        );

    col()
        .key("presence-dock")
        .w(232.0)
        .h_full()
        .min_h(0.0)
        .fill(p.deck)
        .padding(space::S3)
        .gap(space::S2)
        .child(all_row)
        .child(kit::rule_h(p))
        .child(kit::pane_head(
            "Agents",
            &format!("{} active", s.data.active_agent_count()),
            p,
        ))
        .child(
            col()
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .gap(2.0)
                .scroll(ScrollSpec::default())
                .scroll_edge_fade(16.0)
                .children(agents.into_iter().enumerate().map(
                    |(idx, (code, name, filter_key, rooms, msgs, online))| {
                        let active = s.agent_filter.as_deref() == Some(filter_key.as_str());
                        let key_owned = filter_key.clone();
                        let help_text = if rooms.is_empty() {
                            format!("{name} ({msgs} messages)")
                        } else {
                            format!("{name} in {rooms}")
                        };

                        let mut line1 = row()
                            .w_full()
                            .items_center()
                            .gap(space::S2)
                            .child(kit::monogram(&code, 20.0, p))
                            .child(
                                text(name.as_str())
                                    .font(if active {
                                        typo::BODY_STRONG
                                    } else {
                                        typo::BODY
                                    })
                                    .color(if active { p.ink } else { p.ink_secondary })
                                    .truncate_middle()
                                    .grow(1.0)
                                    .shrink(),
                            )
                            .child(text(format!("{msgs}")).font(typo::NUM_S).color(p.ink_muted));
                        if online {
                            line1 = line1.child(el().size(5.0, 5.0).radius(2.5).fill(p.emerald));
                        }

                        let mut inner = col().w_full().min_w(0.0).gap(2.0).child(line1);
                        if active && !rooms.is_empty() {
                            inner = inner.child(
                                text(rooms.as_str())
                                    .font(typo::CAPTION)
                                    .color(p.ink_muted)
                                    .pl(28.0)
                                    .truncate(),
                            );
                        }

                        let mut item_row = kit::list_row(active, p)
                            .key(format!("agent-dock-{idx}"))
                            .role("button")
                            .label(format!("Filter by {name}"))
                            .help(help_text)
                            .focusable(true)
                            .focus_ring(2.0, 1.5, p.focus_ring)
                            .py(6.0)
                            .min_h(32.0)
                            .on_press(move |st: &mut AppState| {
                                if st.agent_filter.as_deref() == Some(key_owned.as_str()) {
                                    st.agent_filter = None;
                                } else {
                                    st.agent_filter = Some(key_owned.clone());
                                }
                                st.selected_thread_idx = 0;
                            })
                            .child(inner);
                        if active {
                            item_row = item_row.child(kit::focus_bar(p));
                        }
                        item_row
                    },
                )),
        )
        .child(kit::rule_h(p))
        .child(footer)
}

fn stream_filter_tab(
    key: &'static str,
    label: String,
    active: bool,
    p: &Palette,
    target: Option<&'static str>,
) -> El {
    let target_owned = target.map(str::to_string);
    let mut tab = col()
        .key(key)
        .role("button")
        .label(label.clone())
        .focusable(true)
        .focus_ring(2.0, 1.5, p.focus_ring)
        .h_full()
        .justify_center()
        .px(space::S1)
        .hover_fill(p.hover)
        .motion(motion::SNAPPY)
        .on_press(move |st: &mut AppState| {
            st.agent_filter = target_owned.clone();
            st.selected_thread_idx = 0;
        })
        .child(
            text(label)
                .font(if active {
                    typo::BODY_STRONG
                } else {
                    typo::BODY
                })
                .color(if active { p.ink } else { p.ink_muted }),
        );
    if active {
        tab = tab.child(
            el().pin(Some(4.0), None, Some(4.0), Some(0.0))
                .h(2.0)
                .radius(1.0)
                .fill(p.cobalt),
        );
    }
    tab
}

fn signal_stream(
    s: &AppState,
    items: &[StreamEntry],
    selected_idx: usize,
    decisions_count: usize,
    ref_ts: &str,
    p: &Palette,
) -> El {
    let is_all = s.agent_filter.is_none();
    let is_decisions = s.agent_filter.as_deref() == Some("decisions");

    let new_note_btn = kit::button_quiet("New note", None, p)
        .key("board-new-note")
        .role("button")
        .label("New note")
        .help("Capture a local note")
        .focusable(true)
        .focus_ring(2.0, 1.5, p.focus_ring)
        .on_press_tx(|st: &mut AppState, tx: &mut Tx| {
            st.cmd_input = TextEdit::new("capture note ");
            st.cmd_open = true;
            st.cmd_selected = 0;
            tx.animated();
            tx.focus_when_shown("cmd-input", true);
        });

    let header = row()
        .w_full()
        .h(44.0)
        .px(space::S4)
        .items_center()
        .justify_between()
        .gap(space::S3)
        .child(
            row()
                .h_full()
                .items_center()
                .gap(space::S3)
                .child(kit::overline("Signals", p))
                .child(
                    text(format!(
                        "{} signals in {} rooms",
                        s.data.mission.signal_count,
                        s.data.mission.active_rooms.len()
                    ))
                    .font(typo::CAPTION)
                    .color(p.ink_muted)
                    .truncate(),
                )
                .child(
                    row()
                        .h_full()
                        .items_center()
                        .gap(space::S2)
                        .pl(space::S2)
                        .child(stream_filter_tab("stream-tab-all", "All".into(), is_all, p, None))
                        .child(stream_filter_tab(
                            "stream-tab-decisions",
                            if decisions_count > 0 {
                                format!("Decisions {decisions_count}")
                            } else {
                                "Decisions".into()
                            },
                            is_decisions,
                            p,
                            Some("decisions"),
                        )),
                ),
        )
        .child(
            row()
                .items_center()
                .gap(space::S2)
                .child(
                    text(format!("{} shown", items.len()))
                        .font(typo::CAPTION)
                        .color(p.ink_muted),
                )
                .child(kit::kbd("J", p))
                .child(kit::kbd("K", p))
                .child(new_note_btn),
        );

    let list_body = if items.is_empty() {
        col()
            .key("stream-scroll")
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .center()
            .padding(space::S6)
            .child(
                text("No signals match the active filter.")
                    .font(typo::BODY)
                    .color(p.ink_muted),
            )
    } else {
        col()
            .key("stream-scroll")
            .w_full()
            .grow(1.0)
            .min_h(0.0)
            .px(space::S2)
            .scroll(ScrollSpec::default())
            .scroll_edge_fade(24.0)
            .children(items.iter().enumerate().map(|(i, item)| {
                let is_sel = i == selected_idx;
                let verdict = s.verdicts.get(&item.id).copied();
                let (prefix_raw, clean_headline) = split_machine_prefix(&item.title);
                let age_str = format_relative_age(&item.created_at, ref_ts);

                let marker = if let Some(v) = verdict {
                    kit::dot(verdict_tone(v), p)
                } else if item.is_blocked {
                    kit::dot(Tone::Urgent, p)
                } else {
                    el().size(6.0, 6.0)
                };

                let mut line1 = row()
                    .w_full()
                    .min_w(0.0)
                    .items_center()
                    .gap(space::S2)
                    .child(marker);
                if let Some(raw_tag) = prefix_raw {
                    line1 = line1.child(kit::tag(&format_prefix_tag(raw_tag), Tone::Steel, p));
                }
                line1 = line1.child(
                    text(clean_headline)
                        .font(typo::BODY_STRONG)
                        .color(if is_sel || item.is_blocked {
                            p.ink
                        } else {
                            p.ink_secondary
                        })
                        .truncate()
                        .help_when_truncated(item.title.as_str())
                        .grow(1.0)
                        .shrink(),
                );
                if let Some(v) = verdict {
                    line1 = line1.child(kit::tag(verdict_label(v), verdict_tone(v), p));
                } else if item.is_blocked {
                    line1 = line1.child(kit::tag("Decision", Tone::Urgent, p));
                }

                let mut meta_parts = vec![item.author.clone(), item.channel.clone()];
                if let Some(age) = age_str {
                    meta_parts.push(age);
                }
                if item.replies > 0 {
                    meta_parts.push(format_replies(item.replies));
                }
                let meta_line = meta_parts.join(" · ");

                let meta_col = if is_sel { p.ink_secondary } else { p.ink_muted };
                let line2 = row()
                    .w_full()
                    .min_w(0.0)
                    .pl(14.0)
                    .items_center()
                    .justify_between()
                    .gap(space::S2)
                    .child(
                        text(meta_line)
                            .font(typo::LABEL)
                            .color(meta_col)
                            .truncate()
                            .grow(1.0)
                            .shrink(),
                    )
                    .child(
                        text(format!("#{}", item.id))
                            .font(typo::MONO_S)
                            .color(meta_col),
                    );

                let mut row_el = kit::list_row(is_sel, p)
                    .key(format!("stream-item-{i}"))
                    .role("button")
                    .label(format!("Inspect thread #{}", item.id))
                    .focusable(true)
                    .focus_ring(2.0, 1.5, p.focus_ring)
                    .min_h(60.0)
                    .on_press(move |st: &mut AppState| {
                        st.selected_thread_idx = i;
                    })
                    .child(
                        col()
                            .w_full()
                            .min_w(0.0)
                            .grow(1.0)
                            .gap(space::S1)
                            .child(line1)
                            .child(line2),
                    );
                if is_sel {
                    row_el = row_el.child(kit::focus_bar(p));
                }

                let mut wrapper = col().w_full().child(row_el);
                if i + 1 < items.len() {
                    wrapper = wrapper.child(kit::rule_h(p));
                }
                wrapper
            }))
    };

    kit::pane()
        .key("signal-stream")
        .grow(1.0)
        .h_full()
        .fill(p.canvas)
        .child(header)
        .child(kit::rule_h(p))
        .child(list_body)
}

fn editorial_reader(s: &AppState, entry: Option<&StreamEntry>, ref_ts: &str, p: &Palette) -> El {
    let Some(item) = entry else {
        return col()
            .key("thread-inspector")
            .w(480.0)
            .h_full()
            .fill(p.canvas)
            .center()
            .padding(space::S6)
            .child(
                text("Select a signal to read.")
                    .font(typo::BODY)
                    .color(p.ink_muted),
            );
    };

    let verdict = s.verdicts.get(&item.id).copied();
    let is_pending = s.pending_writes.contains_key(&item.id);
    let (prefix_raw, clean_title) = split_machine_prefix(&item.title);
    let author_code = monogram_code(&item.author);
    let age_suffix = format_relative_age(&item.created_at, ref_ts)
        .map(|a| format!(" ({a})"))
        .unwrap_or_default();

    let status_el = if let Some(v) = verdict {
        kit::stamp(verdict_label(v), verdict_tone(v), p)
    } else if item.is_blocked {
        row()
            .items_center()
            .gap(6.0)
            .child(kit::dot(Tone::Urgent, p))
            .child(kit::tag("Awaiting verdict", Tone::Urgent, p))
    } else {
        kit::tag("Active signal", Tone::Steel, p)
    };

    let meta_strip = row()
        .w_full()
        .items_center()
        .justify_between()
        .gap(space::S2)
        .child(
            row()
                .items_center()
                .gap(space::S2)
                .min_w(0.0)
                .grow(1.0)
                .child(kit::monogram(&author_code, 22.0, p))
                .child(
                    text(item.author.as_str())
                        .font(typo::BODY_STRONG)
                        .color(p.ink)
                        .truncate(),
                )
                .child(
                    text(item.channel.as_str())
                        .font(typo::CAPTION)
                        .color(p.ink_muted)
                        .truncate()
                        .shrink(),
                )
                .child(
                    text(format!("#{}", item.id))
                        .font(typo::MONO_S)
                        .color(p.ink_muted),
                ),
        )
        .child(status_el);

    let mut content = col()
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .px(space::S6)
        .pt(space::S5)
        .pb(space::S4)
        .gap(space::S4)
        .scroll(ScrollSpec::default())
        .scroll_edge_fade(20.0)
        .child(meta_strip)
        .child(kit::rule_h(p));

    let mut title_block = col().w_full().gap(space::S1);
    if let Some(raw_tag) = prefix_raw {
        title_block = title_block.child(kit::tag(&format_prefix_tag(raw_tag), Tone::Steel, p));
    }
    title_block = title_block.child(
        text(clean_title)
            .font(typo::TITLE)
            .color(p.ink)
            .max_w(432.0)
            .wrap(),
    );
    content = content.child(title_block);

    let body_trimmed = item.body.trim();
    if !body_trimmed.is_empty() && body_trimmed != clean_title.trim() && body_trimmed != item.title.trim()
    {
        content = content.child(
            text(body_trimmed)
                .font(typo::READ)
                .color(p.ink_secondary)
                .max_w(432.0)
                .wrap(),
        );
    }

    if let Some(rec) = &item.recommendation {
        content = content.child(
            row()
                .w_full()
                .items_stretch()
                .gap(space::S3)
                .child(el().w(2.0).radius(1.0).fill(p.steel))
                .child(
                    col()
                        .grow(1.0)
                        .min_w(0.0)
                        .gap(space::S1)
                        .child(
                            text("Agent recommendation")
                                .font(typo::LABEL)
                                .color(p.ink_muted),
                        )
                        .child(text(rec.as_str()).font(typo::READ).color(p.ink).wrap()),
                ),
        );
    }

    let room_value = if item.channel.starts_with(&item.project) || item.project.is_empty() {
        item.channel.clone()
    } else {
        format!("{} · {}", item.project, item.channel)
    };

    let context_rows = col()
        .key("inspector-replies")
        .w_full()
        .gap(space::S2)
        .child(
            row()
                .w_full()
                .justify_between()
                .items_center()
                .gap(space::S3)
                .child(text("Room").font(typo::CAPTION).color(p.ink_muted))
                .child(
                    text(room_value)
                        .font(typo::CAPTION)
                        .color(p.ink_secondary)
                        .truncate(),
                ),
        )
        .child(
            row()
                .w_full()
                .justify_between()
                .items_center()
                .gap(space::S3)
                .child(text("Opened").font(typo::CAPTION).color(p.ink_muted))
                .child(
                    text(format!(
                        "{}{}",
                        format_opened_timestamp(&item.created_at),
                        age_suffix
                    ))
                    .font(typo::CAPTION)
                    .color(p.ink_secondary),
                ),
        )
        .child(
            row()
                .w_full()
                .justify_between()
                .items_center()
                .gap(space::S3)
                .child(text("Replies").font(typo::CAPTION).color(p.ink_muted))
                .child(
                    text(format_replies(item.replies))
                        .font(typo::NUM_S)
                        .color(p.ink_secondary),
                ),
        );

    content = content.child(kit::rule_h(p)).child(context_rows);

    if !s.verdict_history.is_empty() {
        let mut history = col()
            .key("inspector-verdict-history")
            .w_full()
            .gap(space::S2)
            .child(kit::pane_head(
                "Session verdicts",
                &format!("{}", s.verdict_history.len()),
                p,
            ));

        for (i, rec) in s.verdict_history.iter().take(4).enumerate() {
            let (stamp_lbl, stamp_tone) = if matches!(rec.status, WriteStatus::Reverted(_)) {
                ("Reverted", Tone::Caution)
            } else if rec.is_undo {
                ("Undone", Tone::Neutral)
            } else {
                (verdict_label(rec.verdict), verdict_tone(rec.verdict))
            };
            let (result_text, result_color) = match &rec.status {
                WriteStatus::Pending => ("Saving".to_string(), p.amber),
                WriteStatus::Confirmed(_) => ("Saved".to_string(), p.emerald),
                WriteStatus::Reverted(err) => (format!("Reverted, {err}"), p.tone(Tone::Caution)),
                WriteStatus::Undone => ("Undone".to_string(), p.ink_muted),
            };
            history = history.child(
                row()
                    .key(format!("vhist-{i}"))
                    .w_full()
                    .py(space::S1)
                    .items_center()
                    .gap(space::S2)
                    .child(kit::stamp(stamp_lbl, stamp_tone, p))
                    .child(
                        text(format!("#{}", rec.thread_id))
                            .font(typo::MONO_S)
                            .color(p.ink_secondary),
                    )
                    .child(spacer())
                    .child(
                        text(result_text)
                            .font(typo::CAPTION)
                            .color(result_color)
                            .truncate(),
                    ),
            );
            if i + 1 < s.verdict_history.len().min(4) {
                history = history.child(kit::rule_h(p));
            }
        }
        content = content.child(kit::rule_h(p)).child(history);
    }

    let note_id = item.id.clone();
    let note_field = row()
        .key("reader-note-trigger")
        .role("button")
        .label(format!("Add a note on #{}", item.id))
        .focusable(true)
        .focus_ring(2.0, 1.5, p.focus_ring)
        .w_full()
        .h(36.0)
        .px(space::S3)
        .radius(radius::CONTROL)
        .fill(p.recessed_well)
        .border(1.0, p.hairline)
        .items_center()
        .hover_fill(p.hover)
        .motion(motion::SNAPPY)
        .on_press_tx(move |st: &mut AppState, tx: &mut Tx| {
            st.cmd_input = TextEdit::new(format!("capture note #{note_id} :: "));
            st.cmd_open = true;
            st.cmd_selected = 0;
            tx.animated();
            tx.focus_when_shown("cmd-input", true);
        })
        .child(
            text(format!("Add a note on #{} (saves locally)", item.id))
                .font(typo::CAPTION)
                .color(p.ink_secondary)
                .truncate(),
        );

    let approve_id = item.id.clone();
    let approve_label = if is_pending {
        "Saving"
    } else if verdict == Some(DecisionVerdict::Approved) {
        "Approved"
    } else {
        "Approve"
    };
    let mut approve_btn = kit::button_primary(
        approve_label,
        if is_pending { None } else { Some("A") },
        p,
    )
    .key("verdict-approve")
    .role("button")
    .label("Approve")
    .help("Records your approval with a 30 second undo window")
    .focusable(true)
    .focus_ring(2.0, 1.5, p.focus_ring)
    .on_press_tx(move |st: &mut AppState, tx: &mut Tx| {
        st.submit_verdict(&approve_id, DecisionVerdict::Approved);
        tx.animated();
    });
    if is_pending {
        approve_btn = approve_btn.opacity(0.65);
    }

    let revise_id = item.id.clone();
    let revise_btn = kit::button_quiet("Revise", Some("R"), p)
        .key("verdict-revise")
        .role("button")
        .label("Revise")
        .focusable(true)
        .focus_ring(2.0, 1.5, p.focus_ring)
        .on_press_tx(move |st: &mut AppState, tx: &mut Tx| {
            st.submit_verdict(&revise_id, DecisionVerdict::Revised);
            tx.animated();
        });

    let defer_id = item.id.clone();
    let defer_btn = kit::button_quiet("Defer", Some("D"), p)
        .key("verdict-defer")
        .role("button")
        .label("Defer")
        .focusable(true)
        .focus_ring(2.0, 1.5, p.focus_ring)
        .on_press_tx(move |st: &mut AppState, tx: &mut Tx| {
            st.submit_verdict(&defer_id, DecisionVerdict::Deferred);
            tx.animated();
        });

    let mut actions_row = row()
        .w_full()
        .items_center()
        .gap(space::S2)
        .child(approve_btn)
        .child(revise_btn)
        .child(defer_btn)
        .child(spacer());

    if s.active_undo().is_some() {
        actions_row = actions_row.child(
            kit::button_quiet("Undo", Some("U"), p)
                .key("verdict-undo")
                .role("button")
                .label("Undo")
                .focusable(true)
                .focus_ring(2.0, 1.5, p.focus_ring)
                .on_press_tx(|st: &mut AppState, tx: &mut Tx| {
                    st.trigger_undo();
                    tx.animated();
                }),
        );
    }

    let action_bar = col()
        .w_full()
        .px(space::S6)
        .py(space::S4)
        .gap(space::S3)
        .child(note_field)
        .child(actions_row);

    col()
        .key("thread-inspector")
        .w(480.0)
        .h_full()
        .min_h(0.0)
        .fill(p.canvas)
        .child(content)
        .child(kit::rule_h(p))
        .child(action_bar)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_machine_prefix_handles_brackets_leadins_and_colon_tags() {
        assert_eq!(
            split_machine_prefix(
                "[RSI MEDIUM / code_fix] Investigate and fix recurring friction: A grade asked for on v6 conflicts with the no-grade rule"
            ),
            (
                Some("RSI MEDIUM / code_fix"),
                "A grade asked for on v6 conflicts with the no-grade rule"
            )
        );
        assert_eq!(
            split_machine_prefix(
                "[RSI LOW / prompt_rule] Refine worker/reviewer prompt or skill guardrail to prevent: Dispatcher run failure: run 1669-1"
            ),
            (
                Some("RSI LOW / prompt_rule"),
                "Dispatcher run failure: run 1669-1"
            )
        );
        assert_eq!(
            split_machine_prefix("[gate] Approve serve.toml timeout"),
            (Some("gate"), "Approve serve.toml timeout")
        );
        assert_eq!(
            split_machine_prefix("[plan] Board 3-pane redesign"),
            (Some("plan"), "Board 3-pane redesign")
        );
        assert_eq!(
            split_machine_prefix("rsi: fix stale taste brief"),
            (Some("rsi"), "fix stale taste brief")
        );
        assert_eq!(
            split_machine_prefix("ops: restart kizuki daemon"),
            (Some("ops"), "restart kizuki daemon")
        );
        assert_eq!(
            split_machine_prefix("M2 gauntlet: live world_consolidation is 0"),
            (None, "M2 gauntlet: live world_consolidation is 0")
        );
    }

    #[test]
    fn sanitize_text_preserves_brackets_and_cleans_mentions() {
        assert_eq!(
            sanitize_text("@[local:user:ubuntu+board-keeper] [RSI MEDIUM / code_fix] test"),
            "@board-keeper [RSI MEDIUM / code_fix] test"
        );
        assert_eq!(
            sanitize_text("left \u{2014} right"),
            "left - right"
        );
    }

    #[test]
    fn extract_title_and_body_never_truncates_or_duplicates() {
        let raw = "M2 gauntlet: live world_consolidation is 0 because input_token_overhead=24000 while max_input_tokens=8192 so every handle is skipped before any model call. The fix is live config: add max_input_tokens = 32768.\n\nRecommendation: Yes.";
        let (title, body) = extract_title_and_body(None, raw, true);
        assert!(!title.ends_with("..."));
        assert_eq!(
            title,
            "M2 gauntlet: live world_consolidation is 0 because input_token_overhead=24000 while max_input_tokens=8192 so every handle is skipped before any model call."
        );
        assert_eq!(body, "The fix is live config: add max_input_tokens = 32768.");
    }

    #[test]
    fn relative_age_is_deterministic() {
        assert_eq!(
            format_relative_age("2026-11-25T14:44:24.189Z", "2026-11-27T00:21:00Z"),
            Some("33h ago".into())
        );
    }
}
