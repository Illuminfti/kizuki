//! Top navigation bar, pinned toast overlay, Raycast-grade Cmd+K command palette,
//! and 2-column keyboard shortcuts sheet.

use std::f32::consts::PI;

use rune::tok::{TextStyle, motion};
use rune::{
    Color, El, LineCap, ScrollSpec, Shape, Transition, Tx, canvas, col, edit_access, el, row,
    spacer, text, text_input,
};

use crate::data::ConnectionState;
use crate::state::{ActiveView, AppState, DecisionVerdict};
use crate::theme::{Palette, Tone, kit, radius, space, typo};

const PALETTE_INPUT_STYLE: TextStyle = TextStyle::new(20.0, 400.0).tracking(-0.25).lh(26.0);

fn nav_short_label(tab: ActiveView) -> &'static str {
    match tab {
        ActiveView::FlowDeck => "Flow",
        ActiveView::Board => "Board",
        ActiveView::Today => "Today",
        ActiveView::Mind => "Mind",
        ActiveView::AiLive => "AI Live",
    }
}

fn verdict_phrase(verdict: DecisionVerdict) -> &'static str {
    match verdict {
        DecisionVerdict::Approved => "Approved",
        DecisionVerdict::Revised => "Revision queued",
        DecisionVerdict::Deferred => "Deferred",
    }
}

fn sanitize_ui_copy(raw: &str) -> String {
    let mut out = raw.replace("NEURAL", "Memory").replace('\u{2014}', "-");
    if out.contains("Local write -> POST ") {
        if let Some((_, tail)) = out.split_once(" · ") {
            out = format!("Saves locally · {tail}");
        } else {
            out = "Saves locally".to_string();
        }
    } else if out.contains("persisted locally via ") {
        out = out.replace("persisted locally via ", "saved locally ");
    } else if out.contains("synced via ") {
        out = out.replace("synced via ", "synced ");
    }

    let api_seg = concat!("/", "api/");
    if !out.contains(api_seg) {
        return out;
    }

    let mut words: Vec<String> = Vec::new();
    for tok in out.split_whitespace() {
        let trimmed = tok.trim_matches(|c| c == '(' || c == ')');
        if trimmed.contains(api_seg) {
            if tok.ends_with(')')
                && let Some(last) = words.last_mut()
            {
                last.push(')');
            }
            continue;
        }
        words.push(tok.to_string());
    }
    words.join(" ")
}

fn command_group(kind: &str) -> &'static str {
    match kind {
        "GATE" | "UNDO" => "Decisions",
        "THREAD" | "LIVE" => "Threads",
        "NEURAL" => "Memory",
        "CAPTURE" => "Capture",
        _ => "Actions",
    }
}

fn format_command_accessory(kind: &str, hint: &str) -> Option<String> {
    let trimmed = hint.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("enter") {
        return None;
    }
    if let Some(short) = trimmed.strip_prefix("Key ") {
        return Some(short.to_string());
    }
    if kind == "NEURAL" {
        if let Some((score, _)) = trimmed.split_once(" · ") {
            if score.ends_with('%') {
                return Some(format!("{score} match"));
            }
            return Some("Match".to_string());
        }
        return Some("Match".to_string());
    }
    if kind == "LIVE" {
        let mut chars = trimmed.chars();
        if let Some(first) = chars.next() {
            return Some(format!(
                "{}{}",
                first.to_ascii_uppercase(),
                chars.as_str().to_ascii_lowercase()
            ));
        }
    }
    Some(sanitize_ui_copy(trimmed))
}

fn theme_disc_icon(dark: bool, color: Color) -> El {
    let half = if dark {
        kit::arc_path(7.0, 7.0, 4.75, -PI * 0.5, PI * 0.5).close()
    } else {
        kit::arc_path(7.0, 7.0, 4.75, PI * 0.5, PI * 1.5).close()
    };
    let shape = Shape::new()
        .view_box(14.0, 14.0)
        .stroke_path(
            &kit::circle_path(7.0, 7.0, 4.75),
            1.25,
            LineCap::Round,
            color,
        )
        .fill_path(&half, color);
    canvas(shape).size(14.0, 14.0)
}

fn search_magnifier_icon(color: Color) -> El {
    let shape = Shape::new()
        .view_box(16.0, 16.0)
        .stroke_path(
            &kit::circle_path(6.75, 6.75, 4.5),
            1.4,
            LineCap::Round,
            color,
        )
        .line([10.2, 10.2], [13.75, 13.75], 1.4, LineCap::Round, color);
    canvas(shape).size(16.0, 16.0)
}

/// 44px precision top bar with unified titlebar inset clearance, quiet brand lockup,
/// segmented 5-view nav, and whisper-quiet right status cluster.
pub fn top_bar(s: &AppState, p: &Palette, titlebar_inset: f32) -> El {
    let leading_pad = titlebar_inset.max(space::S4);
    let active_agents = s.data.active_agent_count();
    let waiting = s.waiting_decision_count();

    let brand = row()
        .gap(space::S2)
        .items_center()
        .child(el().size(10.0, 10.0).radius(2.0).fill(p.ink))
        .child(text("Kizuki").font(typo::HEADING).color(p.ink));

    let nav_tabs = row()
        .key("nav-tabs")
        .gap(2.0)
        .padding(2.0)
        .radius(radius::ROW)
        .continuous_corners()
        .fill(p.recessed_well)
        .items_center()
        .children(ActiveView::ALL.into_iter().map(|tab| {
            let active = s.view == tab;
            let fg = if active { p.ink } else { p.ink_secondary };
            let mut seg = row()
                .key(tab.key())
                .role("tab")
                .label(tab.label())
                .focusable(true)
                .focus_ring(2.0, 1.5, p.focus_ring)
                .help(format!("{} ({})", tab.label(), tab.shortcut_digit()))
                .px(space::S3)
                .py(4.5)
                .radius(radius::CONTROL)
                .continuous_corners()
                .items_center()
                .press_fill(p.press)
                .press_scale(0.98)
                .motion(motion::SNAPPY)
                .on_press_tx(move |st: &mut AppState, tx: &mut Tx| {
                    st.view = tab;
                    tx.animated();
                })
                .child(text(nav_short_label(tab)).font(typo::BODY_STRONG).color(fg));

            if active {
                seg = seg
                    .fill(p.surface_elevated)
                    .border(1.0, p.hairline)
                    .shadow(1.0, 2.0, p.shadow)
                    .hover_fill(p.surface_elevated);
            } else {
                seg = seg.fill(Color::TRANSPARENT).hover_fill(p.hover);
            }
            seg
        }));

    let (ai_snap, _) = s.box_ai_live_effective();
    let (ai_total, ai_bld, ai_dsn, ai_prd, ai_orc) = ai_snap.effective_counts();

    let (conn_tone, conn_label, conn_help, conn_emph) = match &s.connection {
        ConnectionState::Live {
            hits,
            total,
            synced_secs_ago,
        } => {
            let ver_note = match s.live_versions {
                Some(v) => format!(" (board v{}, vault v{})", v.board, v.vault),
                None => String::new(),
            };
            let detail = if s.sse_live {
                format!("Live stream connected: {hits} of {total} sources{ver_note}")
            } else if *synced_secs_ago == 0 {
                format!("Live: {hits} of {total} sources synced now{ver_note}")
            } else {
                format!("Live: {hits} of {total} sources synced {synced_secs_ago}s ago{ver_note}")
            };
            (Tone::Live, "Live".to_string(), detail, false)
        }
        ConnectionState::Degraded {
            hits,
            total,
            synced_secs_ago,
        } => (
            Tone::Caution,
            format!("Degraded {hits} of {total}"),
            format!("Partial connection: {hits} of {total} sources ({synced_secs_ago}s ago)"),
            false,
        ),
        ConnectionState::Offline { snapshot_date } => (
            Tone::Caution,
            "Snapshot".to_string(),
            format!("Offline, showing snapshot from {snapshot_date} and retrying"),
            true,
        ),
    };

    let status_pill = row()
        .key("status-pill")
        .gap(6.0)
        .items_center()
        .help(conn_help)
        .child(kit::dot(conn_tone, p))
        .child(
            text(conn_label)
                .font(typo::CAPTION)
                .color(if conn_emph { p.ink } else { p.ink_secondary }),
        );

    let cmd_btn = row()
        .key("cmd-trigger")
        .role("button")
        .label("Open Command Palette")
        .focusable(true)
        .focus_ring(2.0, 1.5, p.focus_ring)
        .w(216.0)
        .h(28.0)
        .px(10.0)
        .gap(space::S2)
        .radius(radius::CONTROL)
        .continuous_corners()
        .fill(p.recessed_well)
        .border(1.0, p.hairline)
        .hover_fill(p.hover)
        .press_fill(p.press)
        .press_scale(0.98)
        .motion(motion::SNAPPY)
        .items_center()
        .justify_between()
        .on_press_tx(|st: &mut AppState, tx: &mut Tx| {
            st.cmd_open = !st.cmd_open;
            st.shortcuts_open = false;
            tx.animated();
            if st.cmd_open {
                tx.focus_when_shown("cmd-input", true);
            }
        })
        .child(
            text("Search or run a command")
                .font(typo::CAPTION)
                .color(p.ink_secondary)
                .truncate(),
        )
        .child(kit::kbd("⌘K", p));

    let help_btn = row()
        .key("shortcuts-trigger")
        .role("button")
        .label("Keyboard Shortcuts")
        .focusable(true)
        .focus_ring(2.0, 1.5, p.focus_ring)
        .help("Keyboard shortcuts (?)")
        .size(28.0, 28.0)
        .radius(radius::CONTROL)
        .center()
        .hover_fill(p.hover)
        .press_fill(p.press)
        .press_scale(0.96)
        .motion(motion::SNAPPY)
        .on_press_tx(|st: &mut AppState, tx: &mut Tx| {
            st.shortcuts_open = !st.shortcuts_open;
            st.cmd_open = false;
            tx.animated();
        })
        .child(text("?").font(typo::BODY_STRONG).color(p.ink_secondary));

    let theme_btn = row()
        .key("theme-toggle")
        .role("button")
        .label(if s.dark {
            "Switch to Light Mode"
        } else {
            "Switch to Dark Mode"
        })
        .focusable(true)
        .focus_ring(2.0, 1.5, p.focus_ring)
        .help("Toggle appearance (T)")
        .size(28.0, 28.0)
        .radius(radius::CONTROL)
        .center()
        .hover_fill(p.hover)
        .press_fill(p.press)
        .press_scale(0.96)
        .motion(motion::SNAPPY)
        .on_press_tx(|st: &mut AppState, tx: &mut Tx| {
            st.dark = !st.dark;
            tx.color_motion(motion::CALM);
        })
        .child(theme_disc_icon(s.dark, p.ink_secondary));

    let mut cluster = row().gap(space::S4).items_center();

    if waiting > 0 {
        let decisions_label = if waiting == 1 {
            "1 decision".to_string()
        } else {
            format!("{waiting} decisions")
        };
        cluster = cluster.child(
            row()
                .key("decisions-trigger")
                .role("button")
                .label("Open pending decisions")
                .focusable(true)
                .focus_ring(2.0, 1.5, p.focus_ring)
                .help("Jump to open owner decisions in Flow")
                .gap(6.0)
                .px(6.0)
                .py(4.0)
                .radius(radius::CONTROL)
                .items_center()
                .hover_fill(p.hover)
                .press_fill(p.press)
                .press_scale(0.98)
                .motion(motion::SNAPPY)
                .on_press_tx(|st: &mut AppState, tx: &mut Tx| {
                    st.view = ActiveView::FlowDeck;
                    tx.animated();
                })
                .child(kit::dot(Tone::Urgent, p))
                .child(text(decisions_label).font(typo::BODY_STRONG).color(p.ink)),
        );
    }

    if active_agents > 0 || ai_total > 0 {
        let agents_label = if active_agents == 1 {
            "1 agent".to_string()
        } else {
            format!("{active_agents} agents")
        };
        cluster = cluster.child(
            row()
                .key("live-ai-pill")
                .role("button")
                .label("Open AI Live")
                .focusable(true)
                .focus_ring(2.0, 1.5, p.focus_ring)
                .help(format!(
                    "{ai_total} live workers: {ai_bld} building, {ai_dsn} designing, {ai_prd} predicting, {ai_orc} orchestrating"
                ))
                .px(6.0)
                .py(4.0)
                .radius(radius::CONTROL)
                .items_center()
                .hover_fill(p.hover)
                .press_fill(p.press)
                .press_scale(0.98)
                .motion(motion::SNAPPY)
                .on_press_tx(|st: &mut AppState, tx: &mut Tx| {
                    st.view = ActiveView::AiLive;
                    tx.animated();
                })
                .child(text(agents_label).font(typo::CAPTION).color(p.ink_secondary)),
        );
    }

    cluster = cluster
        .child(status_pill)
        .child(cmd_btn)
        .child(row().gap(space::S1).items_center().child(help_btn).child(theme_btn));

    col()
        .key("top-bar")
        .w_full()
        .h(44.0)
        .fill(p.canvas)
        .window_drag()
        .child(
            row()
                .w_full()
                .grow(1.0)
                .pl(leading_pad)
                .pr(space::S4)
                .gap(space::S4)
                .items_center()
                .child(brand)
                .child(nav_tabs)
                .child(spacer())
                .child(cluster),
        )
        .child(kit::rule_h(p))
}

/// Out-of-flow bottom-right pinned toast overlay. Never pushes or shifts workspace layout.
pub fn toast_overlay(s: &AppState, p: &Palette) -> Option<El> {
    let inner = if let Some(err) = &s.error_banner {
        row()
            .key("error-banner")
            .max_w(520.0)
            .px(14.0)
            .py(10.0)
            .gap(space::S3)
            .radius(10.0)
            .continuous_corners()
            .fill(p.surface_elevated)
            .border(1.0, p.hairline_strong)
            .shadow(8.0, 24.0, p.shadow)
            .items_center()
            .transition(Transition::opacity())
            .child(kit::dot(Tone::Urgent, p))
            .child(
                text(sanitize_ui_copy(err))
                    .font(typo::BODY_STRONG)
                    .color(p.ink)
                    .truncate(),
            )
            .child(
                kit::button_quiet("Dismiss", Some("esc"), p)
                    .key("dismiss-error-btn")
                    .role("button")
                    .label("Dismiss error")
                    .focusable(true)
                    .focus_ring(2.0, 1.5, p.focus_ring)
                    .on_press(|st: &mut AppState| {
                        st.error_banner = None;
                        st.shake_card_id = None;
                    }),
            )
    } else if let Some(undo) = s.active_undo() {
        row()
            .key("undo-banner")
            .max_w(440.0)
            .px(14.0)
            .py(10.0)
            .gap(space::S3)
            .radius(10.0)
            .continuous_corners()
            .fill(p.surface_elevated)
            .border(1.0, p.hairline_strong)
            .shadow(8.0, 24.0, p.shadow)
            .items_center()
            .transition(Transition::opacity())
            .child(kit::dot(Tone::Live, p))
            .child(
                text(format!("{} #{}", verdict_phrase(undo.verdict), undo.thread_id))
                    .font(typo::BODY_STRONG)
                    .color(p.ink)
                    .truncate(),
            )
            .child(
                kit::button_quiet("Undo", Some("U"), p)
                    .key("undo-chip-btn")
                    .role("button")
                    .label("Undo last verdict")
                    .focusable(true)
                    .focus_ring(2.0, 1.5, p.focus_ring)
                    .on_press_tx(|st: &mut AppState, tx: &mut Tx| {
                        st.trigger_undo();
                        tx.animated();
                    }),
            )
    } else {
        let toast = s.active_toast()?;
        let tone = if toast.is_live {
            Tone::Live
        } else {
            Tone::Steel
        };
        row()
            .key("toast-banner")
            .max_w(480.0)
            .px(14.0)
            .py(10.0)
            .gap(space::S3)
            .radius(10.0)
            .continuous_corners()
            .fill(p.surface_elevated)
            .border(1.0, p.hairline_strong)
            .shadow(8.0, 24.0, p.shadow)
            .items_center()
            .transition(Transition::opacity())
            .child(kit::dot(tone, p))
            .child(
                text(sanitize_ui_copy(&toast.message))
                    .font(typo::BODY_STRONG)
                    .color(p.ink)
                    .truncate(),
            )
            .child(
                kit::button_quiet("Dismiss", Some("esc"), p)
                    .key("dismiss-toast-btn")
                    .role("button")
                    .label("Dismiss status")
                    .focusable(true)
                    .focus_ring(2.0, 1.5, p.focus_ring)
                    .on_press(|st: &mut AppState| {
                        st.status_toast = None;
                    }),
            )
    };

    Some(
        row()
            .key("toast-stack")
            .pin(None, None, Some(space::S4), Some(space::S4))
            .raise()
            .child(inner),
    )
}

/// Compatibility alias pointing to the out-of-flow pinned toast overlay.
#[allow(dead_code)]
pub fn status_banner(s: &AppState, p: &Palette) -> Option<El> {
    toast_overlay(s, p)
}

/// Raycast-grade Cmd+K command palette overlay with borderless input, grouped unboxed rows,
/// cobalt focus bar on selection, and quiet keyboard hint footer.
pub fn command_palette_overlay(s: &AppState, p: &Palette) -> El {
    let cmds = s.filtered_commands();
    let selected = s.cmd_selected.min(cmds.len().saturating_sub(1));

    let input_row = row()
        .w_full()
        .h(52.0)
        .px(space::S4)
        .gap(10.0)
        .items_center()
        .child(search_magnifier_icon(p.ink_muted))
        .child(
            text_input(&s.cmd_input, PALETTE_INPUT_STYLE)
                .key("cmd-input")
                .w_full()
                .grow(1.0)
                .color(p.ink)
                .single_line()
                .placeholder(
                    "Search gates, threads and memory, or type a command",
                    p.ink_faint,
                )
                .on_edit(edit_access(|st: &mut AppState| &mut st.cmd_input))
                .on_input_change(|st: &mut AppState, _tx: &mut Tx| {
                    st.cmd_selected = 0;
                    st.refresh_remote_commands();
                })
                .on_submit(|st: &mut AppState, tx: &mut Tx| {
                    let list = st.filtered_commands();
                    if let Some(cmd) = list.get(st.cmd_selected).cloned() {
                        st.execute_command(cmd.action);
                        tx.blur();
                        tx.animated();
                    }
                }),
        )
        .child(kit::kbd("esc", p));

    let mut list_items: Vec<El> = Vec::new();
    let mut prev_group: Option<&'static str> = None;

    if cmds.is_empty() {
        list_items.push(
            row()
                .w_full()
                .px(space::S3)
                .py(space::S4)
                .child(
                    text("No matching commands, threads, or memories.")
                        .font(typo::CAPTION)
                        .color(p.ink_muted),
                ),
        );
    } else {
        for (i, cmd) in cmds.into_iter().enumerate() {
            let group = command_group(cmd.kind);
            if prev_group != Some(group) {
                let top_pad = if prev_group.is_some() { 10.0 } else { 4.0 };
                list_items.push(
                    row()
                        .w_full()
                        .px(space::S3)
                        .pt(top_pad)
                        .pb(space::S1)
                        .child(text(group).font(typo::LABEL).color(p.ink_muted)),
                );
                prev_group = Some(group);
            }

            let is_sel = i == selected;
            let action = cmd.action.clone();
            let clean_label = sanitize_ui_copy(&cmd.label);
            let clean_detail = cmd
                .detail
                .as_deref()
                .map(sanitize_ui_copy)
                .filter(|d| !d.is_empty());
            let has_detail = clean_detail.is_some();

            let mut text_col = col()
                .grow(1.0)
                .min_w(0.0)
                .gap(2.0)
                .child(
                    text(clean_label.clone())
                        .font(if is_sel {
                            typo::BODY_STRONG
                        } else {
                            typo::BODY
                        })
                        .color(p.ink)
                        .truncate(),
                );
            if let Some(detail) = clean_detail {
                text_col = text_col.child(
                    text(detail)
                        .font(typo::CAPTION)
                        .color(p.ink_muted)
                        .truncate(),
                );
            }

            let marker = row().w(16.0).center();
            let marker = match cmd.kind {
                "GATE" => marker.child(kit::dot(Tone::Urgent, p)),
                "CAPTURE" | "UNDO" => marker.child(kit::dot(Tone::Live, p)),
                _ => marker,
            };

            let mut item = kit::list_row(is_sel, p)
                .key(format!("cmd-row-{i}"))
                .role("button")
                .label(clean_label)
                .focusable(true)
                .min_h(if has_detail { 52.0 } else { 40.0 })
                .py(if has_detail { 8.0 } else { 6.0 })
                .on_press_tx(move |st: &mut AppState, tx: &mut Tx| {
                    st.execute_command(action.clone());
                    tx.blur();
                    tx.animated();
                });

            if is_sel {
                item = item.child(kit::focus_bar(p));
            }

            item = item.child(marker).child(text_col);

            if is_sel {
                item = item.child(kit::kbd("↵", p));
            } else if let Some(acc) = format_command_accessory(cmd.kind, &cmd.hint) {
                item = item.child(text(acc).font(typo::CAPTION).color(p.ink_muted));
            }

            list_items.push(item);
        }
    }

    let results = col()
        .w_full()
        .max_h(420.0)
        .px(space::S2)
        .pt(space::S2)
        .pb(space::S3)
        .gap(2.0)
        .scroll(ScrollSpec::default())
        .scroll_edge_fade(16.0)
        .children(list_items);

    let footer_hint = |k: &str, label: &str| {
        row()
            .gap(6.0)
            .items_center()
            .child(kit::kbd(k, p))
            .child(text(label).font(typo::CAPTION).color(p.ink_muted))
    };

    let footer = row()
        .w_full()
        .h(36.0)
        .px(space::S4)
        .items_center()
        .justify_between()
        .child(
            text("Type capture note to save locally")
                .font(typo::CAPTION)
                .color(p.ink_muted),
        )
        .child(
            row()
                .gap(space::S3)
                .items_center()
                .child(footer_hint("↑↓", "Navigate"))
                .child(footer_hint("↵", "Open"))
                .child(footer_hint("esc", "Close")),
        );

    let modal = col()
        .key("cmd-palette")
        .w(600.0)
        .radius(radius::SHEET)
        .continuous_corners()
        .clip_rounded(radius::SHEET)
        .fill(p.surface_elevated)
        .border_gradient(1.0, p.edge_top, p.edge_bottom)
        .shadow(24.0, 64.0, p.shadow)
        .child(input_row)
        .child(kit::rule_h(p))
        .child(results)
        .child(kit::rule_h(p))
        .child(footer);

    col()
        .key("cmd-palette-overlay")
        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .raise()
        .fill(p.overlay_scrim)
        .items_center()
        .pt(112.0)
        .transition(Transition::opacity())
        .child(modal)
}

/// Clean 2-column `?` keyboard shortcuts sheet divided by a vertical hairline, with zero nested row boxes.
pub fn shortcuts_overlay(s: &AppState, p: &Palette) -> El {
    let _ = s;

    let nav_keys = [
        ("1 - 5", "Switch views"),
        ("J / K", "Move selection"),
        ("↵", "Inspect selected"),
        ("⌘K", "Command palette"),
    ];
    let app_keys = [("T", "Toggle dark and light"), ("? / esc", "Shortcuts or close")];
    let decide_keys = [
        ("A", "Approve selected"),
        ("R", "Request revision"),
        ("D", "Defer selected"),
        ("U", "Undo last verdict"),
    ];

    let shortcut_row = |k: &str, desc: &str| {
        row()
            .w_full()
            .h(32.0)
            .gap(space::S3)
            .items_center()
            .child(row().w(72.0).items_center().child(kit::kbd(k, p)))
            .child(
                text(desc)
                    .font(typo::BODY)
                    .color(p.ink_secondary)
                    .truncate(),
            )
    };

    let header = row()
        .w_full()
        .px(space::S5)
        .py(space::S4)
        .items_center()
        .justify_between()
        .child(text("Keyboard shortcuts").font(typo::TITLE).color(p.ink))
        .child(
            kit::button_quiet("Close", Some("esc"), p)
                .key("close-shortcuts-btn")
                .role("button")
                .label("Close shortcuts")
                .focusable(true)
                .focus_ring(2.0, 1.5, p.focus_ring)
                .on_press_tx(|st: &mut AppState, tx: &mut Tx| {
                    st.shortcuts_open = false;
                    tx.animated();
                }),
        );

    let left_col = col()
        .grow(1.0)
        .min_w(0.0)
        .gap(space::S1)
        .child(row().pb(space::S1).child(kit::overline("Navigate", p)))
        .children(nav_keys.into_iter().map(|(k, d)| shortcut_row(k, d)))
        .child(
            row()
                .pt(space::S3)
                .pb(space::S1)
                .child(kit::overline("App", p)),
        )
        .children(app_keys.into_iter().map(|(k, d)| shortcut_row(k, d)));

    let right_col = col()
        .grow(1.0)
        .min_w(0.0)
        .gap(space::S1)
        .child(row().pb(space::S1).child(kit::overline("Decide", p)))
        .children(decide_keys.into_iter().map(|(k, d)| shortcut_row(k, d)))
        .child(
            row().w_full().min_w(0.0).pt(space::S3).child(
                text("Verdicts write back and can be undone for 30 seconds.")
                    .font(typo::CAPTION)
                    .color(p.ink_muted)
                    .grow(1.0)
                    .min_w(0.0)
                    .wrap(),
            ),
        );

    let body = row()
        .w_full()
        .px(space::S5)
        .py(space::S4)
        .gap(space::S5)
        .child(left_col)
        .child(kit::rule_v(p))
        .child(right_col);

    let modal = col()
        .key("help-sheet")
        .w(560.0)
        .radius(radius::SHEET)
        .continuous_corners()
        .clip_rounded(radius::SHEET)
        .fill(p.surface_elevated)
        .border_gradient(1.0, p.edge_top, p.edge_bottom)
        .shadow(24.0, 64.0, p.shadow)
        .child(header)
        .child(kit::rule_h(p))
        .child(body);

    col()
        .key("shortcuts-overlay")
        .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
        .raise()
        .fill(p.overlay_scrim)
        .items_center()
        .pt(120.0)
        .transition(Transition::opacity())
        .child(modal)
}
