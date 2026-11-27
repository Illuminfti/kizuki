//! View 1: Flow Deck and View 5: AI Live Observatory.
//! Unboxed hairline geometry under the 90/8/2 restraint law: one elevated plate for owner gates,
//! data-driven cubic Bezier Sankey volume ribbons, a 72px telemetry rail, and a 4-lane AI Live
//! ledger with crossing-minimized steel conduits.

use rune::tok::motion;
use rune::{
    Color, El, LineCap, Path, ScrollSpec, Shape, Transition, Tx, canvas, col, row, spacer, text,
};

use crate::data::{DecisionGateCard, SeatInfo, clean_snippet, format_k};
use crate::state::{
    AppState, BoxAiAgent, BoxAiLiveSnapshot, BoxAiResource, DecisionVerdict, normalize_ai_category,
};
use crate::theme::{Palette, Tone, kit, radius, space, typo};

struct RibbonSpec {
    from_idx: usize,
    to_idx: usize,
    volume: f32,
    urgent: bool,
}

pub fn view(s: &AppState, p: &Palette) -> El {
    let pending_gates = s.pending_decision_gates();
    let workers_count = s
        .data
        .agents
        .agents
        .iter()
        .filter(|a| a.role != "owner")
        .take(5)
        .count()
        .max(1);
    let rooms_count = s.data.mission.active_rooms.iter().take(5).count().max(1);
    let gates_count = pending_gates.len().max(1);

    let r01 = build_ribbons_asks_to_works(s, workers_count);
    let r12 = build_ribbons_works_to_lands(s, workers_count, rooms_count);
    let r23 = build_ribbons_lands_to_gates(s, rooms_count, &pending_gates);
    let r34 = build_ribbons_gates_to_sinks(&pending_gates, 5);

    let summary = flow_summary_line(s, pending_gates.len(), p);

    let pipeline = row()
        .key("flow-pipeline")
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .gap(0.0)
        .child(col_who_asks(s, p))
        .child(kit::rule_v(p))
        .child(sankey_rail(
            "rail-0-1",
            0,
            1,
            5,
            workers_count,
            &r01,
            s.hovered_flow,
            p,
        ))
        .child(col_who_works(s, p))
        .child(kit::rule_v(p))
        .child(sankey_rail(
            "rail-1-2",
            1,
            2,
            workers_count,
            rooms_count,
            &r12,
            s.hovered_flow,
            p,
        ))
        .child(col_where_it_lands(s, p))
        .child(kit::rule_v(p))
        .child(sankey_rail(
            "rail-2-3",
            2,
            3,
            rooms_count,
            gates_count,
            &r23,
            s.hovered_flow,
            p,
        ))
        .child(col_what_needs_you(s, &pending_gates, p))
        .child(sankey_rail(
            "rail-3-4",
            3,
            4,
            gates_count,
            5,
            &r34,
            s.hovered_flow,
            p,
        ))
        .child(kit::rule_v(p))
        .child(col_what_it_becomes(s, p));

    col()
        .key("flow-deck-view")
        .w_full()
        .h_full()
        .gap(space::S3)
        .child(summary)
        .child(pipeline)
        .child(telemetry_rail(s, p))
}

fn flow_summary_line(s: &AppState, waiting: usize, p: &Palette) -> El {
    let lead = match waiting {
        0 => "Nothing needs you.".to_string(),
        1 => "1 decision needs you.".to_string(),
        n => format!("{n} decisions need you."),
    };
    let agents = s.data.active_agent_count();
    let rooms = if !s.data.mission.active_rooms.is_empty() {
        s.data.mission.active_rooms.len()
    } else {
        s.data.health.totals.channels as usize
    };
    let agent_word = if agents == 1 { "agent" } else { "agents" };
    let room_word = if rooms == 1 { "room" } else { "rooms" };
    let tail = format!(" {agents} {agent_word} across {rooms} {room_word}.");

    row()
        .w_full()
        .h(28.0)
        .items_center()
        .child(text(lead).font(typo::TITLE).color(p.ink))
        .child(text(tail).font(typo::TITLE).color(p.ink_secondary))
}

fn gate_is_over_24h(card: &DecisionGateCard) -> bool {
    card.age_ratio >= (24.0 / 72.0 - 0.001) || card.age_label.ends_with('d')
}

fn build_ribbons_asks_to_works(s: &AppState, works_n: usize) -> Vec<RibbonSpec> {
    let volumes = [
        s.data.owner_message_count().unwrap_or(0) as f32,
        s.data.blockers.counts.orchestrator_queue as f32,
        s.data.blockers.counts.paused as f32,
        s.data.today.summary.active_pipelines as f32,
        s.data.today.inbox_counts.priority as f32,
    ];
    let n = works_n.max(1);
    volumes
        .into_iter()
        .enumerate()
        .map(|(i, v)| RibbonSpec {
            from_idx: i,
            to_idx: i % n,
            volume: v,
            urgent: false,
        })
        .collect()
}

fn build_ribbons_works_to_lands(s: &AppState, works_n: usize, rooms_n: usize) -> Vec<RibbonSpec> {
    let workers: Vec<_> = s
        .data
        .agents
        .agents
        .iter()
        .filter(|a| a.role != "owner")
        .take(5)
        .collect();
    let rn = rooms_n.max(1);
    (0..works_n)
        .map(|i| {
            let volume = workers
                .get(i)
                .map(|w| w.messages_count as f32)
                .unwrap_or(0.0);
            RibbonSpec {
                from_idx: i,
                to_idx: i % rn,
                volume,
                urgent: false,
            }
        })
        .collect()
}

fn build_ribbons_lands_to_gates(
    s: &AppState,
    rooms_n: usize,
    pending: &[DecisionGateCard],
) -> Vec<RibbonSpec> {
    let rooms: Vec<_> = s.data.mission.active_rooms.iter().take(5).collect();
    let gn = pending.len().max(1);
    (0..rooms_n)
        .map(|i| {
            let to = i % gn;
            let volume = rooms.get(i).map(|r| r.signal_count as f32).unwrap_or(0.0);
            let urgent = pending.get(to).is_some_and(gate_is_over_24h);
            RibbonSpec {
                from_idx: i,
                to_idx: to,
                volume,
                urgent,
            }
        })
        .collect()
}

fn build_ribbons_gates_to_sinks(pending: &[DecisionGateCard], sinks_n: usize) -> Vec<RibbonSpec> {
    let gn = pending.len().max(1);
    (0..sinks_n)
        .map(|j| {
            let from = j % gn;
            let volume = pending
                .get(from)
                .map(|g| (g.replies.max(1)) as f32)
                .unwrap_or(1.0);
            RibbonSpec {
                from_idx: from,
                to_idx: j,
                volume,
                urgent: false,
            }
        })
        .collect()
}

/// Pure cubic Bezier Sankey volume ribbons between adjacent columns.
/// Band thickness scales monotonically with sqrt(v / v_max); quiet ribbons draw first,
/// hovered or urgent ribbons draw last. Zero sockets, flanges, diamonds, or chevrons.
#[allow(clippy::too_many_arguments)]
fn sankey_rail(
    key: &'static str,
    left_col: usize,
    right_col: usize,
    left_n: usize,
    right_n: usize,
    ribbons: &[RibbonSpec],
    hovered: Option<(usize, usize)>,
    p: &Palette,
) -> El {
    let vb_w = 44.0_f32;
    let vb_h = 560.0_f32;
    let top_pad = 29.0_f32;
    let bot_pad = 25.0_f32;
    let usable_h = vb_h - top_pad - bot_pad;

    let slot_y = |idx: usize, count: usize| -> f32 {
        let c = count.max(1) as f32;
        top_pad + ((idx as f32 + 0.5) / c) * usable_h
    };

    let v_max = ribbons
        .iter()
        .map(|r| r.volume)
        .fold(0.0_f32, f32::max)
        .max(1.0);

    let any_hover = hovered.is_some();
    let x0 = 0.0_f32;
    let x1 = vb_w;
    let xm = (x0 + x1) * 0.5;

    let is_lit = |r: &RibbonSpec| -> bool {
        match hovered {
            Some((c, idx)) => {
                (c == left_col && idx == r.from_idx) || (c == right_col && idx == r.to_idx)
            }
            None => false,
        }
    };

    let mut quiet_pass = Vec::new();
    let mut focus_pass = Vec::new();
    for r in ribbons {
        if is_lit(r) || r.urgent {
            focus_pass.push(r);
        } else {
            quiet_pass.push(r);
        }
    }

    let mut shape = Shape::new().view_box(vb_w, vb_h);
    for r in quiet_pass.into_iter().chain(focus_pass) {
        let y0 = slot_y(r.from_idx, left_n);
        let y1 = slot_y(r.to_idx, right_n);
        let norm = (r.volume / v_max).clamp(0.0, 1.0);
        let thickness = 1.5 + 8.5 * norm.sqrt();
        let half = thickness * 0.5;

        let lit = is_lit(r);
        let fill_color = if lit {
            if r.urgent {
                p.vermilion.alpha(0.75)
            } else {
                p.ink.alpha(0.62)
            }
        } else if any_hover {
            if r.urgent {
                p.vermilion.alpha(0.22)
            } else {
                p.steel.alpha(0.07)
            }
        } else if r.urgent {
            p.vermilion.alpha(0.55)
        } else {
            p.steel.alpha(0.20)
        };

        let band = Path::new()
            .move_to([x0, y0 - half])
            .cubic_to([xm, y0 - half], [xm, y1 - half], [x1, y1 - half])
            .line_to([x1, y1 + half])
            .cubic_to([xm, y1 + half], [xm, y0 + half], [x0, y0 + half])
            .close();
        shape = shape.fill_path(&band, fill_color);
    }

    canvas(shape).key(key).w(vb_w).h_full()
}

fn quiet_column_footer(left: &str, right: String, p: &Palette) -> El {
    col()
        .w_full()
        .child(kit::rule_h(p))
        .child(
            row()
                .w_full()
                .h(24.0)
                .px(space::S1)
                .items_center()
                .justify_between()
                .gap(space::S2)
                .child(
                    text(left)
                        .font(typo::CAPTION)
                        .color(p.ink_muted)
                        .truncate()
                        .shrink(),
                )
                .child(text(right).font(typo::NUM_S).color(p.ink_secondary)),
        )
}

fn col_who_asks(s: &AppState, p: &Palette) -> El {
    let owner_metric = match s.data.owner_message_count() {
        Some(n) => format!("{n} msgs"),
        None => "None".into(),
    };
    let paused_metric = if s.data.blockers.counts.paused > 0 {
        format!("{} paused", s.data.blockers.counts.paused)
    } else if s.data.blockers.counts.stalled > 0 {
        format!("{} stalled", s.data.blockers.counts.stalled)
    } else {
        "Idle".into()
    };
    let active_pipes = s.data.today.summary.active_pipelines;
    let total_pipes = s.data.today.summary.total_pipelines;
    let (pipe_metric, pipe_ratio) = if total_pipes > 0 {
        (
            format!("{active_pipes}/{total_pipes}"),
            Some(active_pipes as f32 / total_pipes as f32),
        )
    } else {
        ("Idle".into(), None)
    };

    let sources: [(&str, String, &str, Option<f32>); 5] = [
        (
            "Owner",
            owner_metric,
            "Direct asks, voice, threads",
            None,
        ),
        (
            "Keeper Queue",
            format!("{} queued", s.data.blockers.counts.orchestrator_queue),
            "Escalations and owner gates",
            None,
        ),
        (
            "Dreamer RSI",
            paused_metric,
            "Nightly friction and sweeps",
            None,
        ),
        (
            "Cron Watchers",
            pipe_metric,
            "Mail, calendar, X, vault sync",
            pipe_ratio,
        ),
        (
            "Priority Inbox",
            format!("{}", s.data.today.inbox_counts.priority),
            "WhatsApp, Telegram, Gmail",
            None,
        ),
    ];

    let mut body = col().w_full().grow(1.0).min_h(0.0);
    for (i, (name, metric, desc, ratio)) in sources.into_iter().enumerate() {
        if i > 0 {
            body = body.child(kit::rule_h(p));
        }
        let lit = s.hovered_flow == Some((0, i));
        let mut band = col()
            .key(format!("ask-{i}"))
            .w_full()
            .grow(1.0)
            .justify_center()
            .gap(space::S1)
            .px(space::S1)
            .radius(radius::ROW)
            .fill(if lit { p.hover } else { Color::TRANSPARENT })
            .hover_fill(p.hover)
            .motion(motion::SNAPPY)
            .on_hover_change(move |st: &mut AppState, over, _tx| {
                if over {
                    st.hovered_flow = Some((0, i));
                } else if st.hovered_flow == Some((0, i)) {
                    st.hovered_flow = None;
                }
            })
            .child(
                row()
                    .w_full()
                    .min_w(0.0)
                    .items_center()
                    .justify_between()
                    .gap(space::S2)
                    .child(
                        text(name)
                            .font(typo::BODY_STRONG)
                            .color(p.ink)
                            .truncate()
                            .help_when_truncated(name),
                    )
                    .child(
                        text(&metric)
                            .font(typo::NUM)
                            .color(p.ink_secondary)
                            .truncate()
                            .shrink(),
                    ),
            )
            .child(
                text(desc)
                    .font(typo::CAPTION)
                    .color(p.ink_muted)
                    .truncate()
                    .help_when_truncated(desc),
            );
        if let Some(frac) = ratio {
            band = band.child(kit::meter(frac, Tone::Steel, p));
        }
        body = body.child(band);
    }

    kit::pane()
        .key("col-asks")
        .w(188.0)
        .h_full()
        .pr(space::S2)
        .child(kit::pane_head("Who asks", "5", p))
        .child(kit::rule_h(p))
        .child(body)
        .child(quiet_column_footer(
            "Intake queue",
            format!("{} pending", s.data.blockers.counts.intake),
            p,
        ))
}

fn col_who_works(s: &AppState, p: &Palette) -> El {
    let workers: Vec<_> = s
        .data
        .agents
        .agents
        .iter()
        .filter(|a| a.role != "owner")
        .take(5)
        .collect();
    let count_str = format!("{}", s.data.active_agent_count());

    let mut body = col().w_full().grow(1.0).min_h(0.0);
    if workers.is_empty() {
        body = body.child(
            col()
                .w_full()
                .grow(1.0)
                .center()
                .child(text("No active workers").font(typo::CAPTION).color(p.ink_muted)),
        );
    } else {
        for (i, w) in workers.into_iter().enumerate() {
            if i > 0 {
                body = body.child(kit::rule_h(p));
            }
            let ch = w
                .recent_channels
                .first()
                .map(|c| c.as_str())
                .unwrap_or("board");
            let lit = s.hovered_flow == Some((1, i));
            let activity = format!(
                "{} {}, {} {}",
                w.messages_count,
                if w.messages_count == 1 { "event" } else { "events" },
                w.threads_started,
                if w.threads_started == 1 { "thread" } else { "threads" },
            );

            let mut head_row = row()
                .w_full()
                .min_w(0.0)
                .items_center()
                .justify_between()
                .gap(space::S2)
                .child(
                    text(&w.display_name)
                        .font(typo::BODY_STRONG)
                        .color(p.ink)
                        .truncate()
                        .help_when_truncated(&w.display_name),
                );
            if w.active_recent {
                head_row = head_row.child(
                    row()
                        .gap(space::S1)
                        .items_center()
                        .shrink()
                        .child(kit::dot(Tone::Live, p))
                        .child(
                            text(format!("{}", w.messages_count))
                                .font(typo::NUM)
                                .color(p.ink_secondary)
                                .truncate()
                                .shrink(),
                        ),
                );
            } else {
                head_row = head_row.child(
                    text(format!("{}", w.messages_count))
                        .font(typo::NUM)
                        .color(p.ink_secondary)
                        .truncate()
                        .shrink(),
                );
            }

            let band = col()
                .key(format!("worker-{i}"))
                .w_full()
                .grow(1.0)
                .justify_center()
                .gap(space::S1)
                .px(space::S1)
                .radius(radius::ROW)
                .fill(if lit { p.hover } else { Color::TRANSPARENT })
                .hover_fill(p.hover)
                .motion(motion::SNAPPY)
                .on_hover_change(move |st: &mut AppState, over, _tx| {
                    if over {
                        st.hovered_flow = Some((1, i));
                    } else if st.hovered_flow == Some((1, i)) {
                        st.hovered_flow = None;
                    }
                })
                .child(head_row)
                .child(
                    text(ch)
                        .font(typo::MONO_S)
                        .color(p.ink_muted)
                        .truncate_middle()
                        .help_when_truncated(ch),
                )
                .child(
                    text(&activity)
                        .font(typo::CAPTION)
                        .color(p.ink_muted)
                        .truncate()
                        .help_when_truncated(&activity),
                );
            body = body.child(band);
        }
    }

    kit::pane()
        .key("col-works")
        .w(200.0)
        .h_full()
        .px(space::S2)
        .child(kit::pane_head("Who works", &count_str, p))
        .child(kit::rule_h(p))
        .child(body)
        .child(quiet_column_footer(
            "Dispatcher",
            if s.data.health.cockpit_online {
                "Event-driven".into()
            } else {
                "Standby".into()
            },
            p,
        ))
}

fn col_where_it_lands(s: &AppState, p: &Palette) -> El {
    let rooms: Vec<_> = s.data.mission.active_rooms.iter().take(5).collect();
    let count_str = format!("{} rooms", s.data.health.totals.channels);

    let mut body = col().w_full().grow(1.0).min_h(0.0);
    if rooms.is_empty() {
        body = body.child(
            col()
                .w_full()
                .grow(1.0)
                .center()
                .child(text("No active rooms").font(typo::CAPTION).color(p.ink_muted)),
        );
    } else {
        for (i, room) in rooms.into_iter().enumerate() {
            if i > 0 {
                body = body.child(kit::rule_h(p));
            }
            let lit = s.hovered_flow == Some((2, i));
            let mut sub_row = row()
                .w_full()
                .min_w(0.0)
                .items_center()
                .gap(space::S2)
                .child(
                    text(&room.group_label)
                        .font(typo::CAPTION)
                        .color(p.ink_muted)
                        .truncate()
                        .help_when_truncated(&room.group_label),
                )
                .child(spacer());
            if room.blocked_count > 0 {
                sub_row = sub_row.child(kit::tag(
                    &format!("{} blocked", room.blocked_count),
                    Tone::Caution,
                    p,
                ));
            }

            let band = col()
                .key(format!("room-{i}"))
                .w_full()
                .grow(1.0)
                .justify_center()
                .gap(space::S1)
                .px(space::S1)
                .radius(radius::ROW)
                .fill(if lit { p.hover } else { Color::TRANSPARENT })
                .hover_fill(p.hover)
                .motion(motion::SNAPPY)
                .on_hover_change(move |st: &mut AppState, over, _tx| {
                    if over {
                        st.hovered_flow = Some((2, i));
                    } else if st.hovered_flow == Some((2, i)) {
                        st.hovered_flow = None;
                    }
                })
                .child(
                    row()
                        .w_full()
                        .min_w(0.0)
                        .items_center()
                        .justify_between()
                        .gap(space::S2)
                        .child(
                            text(&room.channel)
                                .font(typo::BODY_STRONG)
                                .color(p.ink)
                                .grow(1.0)
                                .min_w(0.0)
                                .truncate_middle()
                                .help_when_truncated(&room.channel),
                        )
                        .child(
                            text(format!("{}", room.signal_count))
                                .font(typo::NUM)
                                .color(p.ink_secondary),
                        ),
                )
                .child(sub_row);
            body = body.child(band);
        }
    }

    kit::pane()
        .key("col-lands")
        .w(200.0)
        .h_full()
        .px(space::S2)
        .child(kit::pane_head("Where it lands", &count_str, p))
        .child(kit::rule_h(p))
        .child(body)
        .child(quiet_column_footer(
            "Threads",
            format!(
                "{} / {}",
                s.data.health.totals.threads, s.data.health.totals.messages
            ),
            p,
        ))
}

fn verdict_sentence_label(v: DecisionVerdict) -> &'static str {
    match v {
        DecisionVerdict::Approved => "Approved",
        DecisionVerdict::Revised => "Revise queued",
        DecisionVerdict::Deferred => "Deferred",
    }
}

fn col_what_needs_you(s: &AppState, pending: &[DecisionGateCard], p: &Palette) -> El {
    let resolved = s.resolved_decision_gates();
    let waiting = pending.len();

    let head = row()
        .w_full()
        .h(38.0)
        .px(space::S4)
        .items_center()
        .justify_between()
        .child(kit::overline("Needs you", p))
        .child(if waiting > 0 {
            row()
                .gap(6.0)
                .items_center()
                .child(kit::dot(Tone::Urgent, p))
                .child(text(format!("{waiting} open")).font(typo::CAPTION).color(p.ink))
        } else {
            row()
                .gap(6.0)
                .items_center()
                .child(kit::dot(Tone::Live, p))
                .child(text("Clear").font(typo::CAPTION).color(p.ink_muted))
        });

    let mut gate_stack = col()
        .key("pending-gate-stack")
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .animate_layout();

    if pending.len() > 4 {
        gate_stack = gate_stack
            .scroll(ScrollSpec::default())
            .scroll_edge_fade(20.0);
    }

    if pending.is_empty() {
        gate_stack = gate_stack.child(
            col()
                .key("gates-clear-state")
                .w_full()
                .grow(1.0)
                .center()
                .padding(space::S6)
                .gap(space::S2)
                .child(kit::ring(1.0, 20.0, Tone::Live, p))
                .child(text("No decisions waiting").font(typo::HEADING).color(p.ink))
                .child(
                    text("Press U within 30 seconds to undo, or 2 to inspect Board.")
                        .font(typo::CAPTION)
                        .color(p.ink_muted),
                ),
        );
    } else {
        for (idx, card) in pending.iter().enumerate() {
            if idx > 0 {
                gate_stack = gate_stack.child(kit::rule_h(p));
            }
            let is_selected = idx == s.selected_gate_idx;
            let is_pending_write = s.pending_writes.contains_key(&card.id);
            let shake_dx = 0.0;
            gate_stack = gate_stack.child(decision_gate_row(
                idx,
                card,
                is_selected,
                is_pending_write,
                shake_dx,
                s.hovered_flow == Some((3, idx)),
                p,
            ));
        }
    }

    let mut plate = kit::plate(p)
        .key("col-needs-you")
        .grow(1.0)
        .min_w(320.0)
        .h_full()
        .min_h(0.0)
        .child(head)
        .child(kit::rule_h(p))
        .child(gate_stack);

    if let Some((latest, verdict)) = resolved.first() {
        let mut foot = row()
            .key("resolved-gates-tray")
            .w_full()
            .h(36.0)
            .px(space::S4)
            .items_center()
            .justify_between()
            .gap(space::S2)
            .transition(Transition::opacity())
            .child(
                row()
                    .grow(1.0)
                    .min_w(0.0)
                    .gap(6.0)
                    .items_center()
                    .child(kit::dot(Tone::Live, p))
                    .child(
                        text(format!("{} #{}", verdict_sentence_label(*verdict), latest.id))
                            .font(typo::CAPTION)
                            .color(p.ink_secondary)
                            .truncate(),
                    ),
            );
        if s.active_undo().is_some() {
            foot = foot.child(
                kit::button_quiet("Undo", Some("U"), p)
                    .role("button")
                    .label("Undo last verdict")
                    .focusable(true)
                    .on_press_tx(|st: &mut AppState, tx: &mut Tx| {
                        if st.trigger_undo() {
                            tx.animated();
                        }
                    }),
            );
        }
        plate = plate.child(kit::rule_h(p)).child(foot);
    } else {
        plate = plate.child(kit::rule_h(p)).child(
            row()
                .w_full()
                .h(28.0)
                .px(space::S4)
                .items_center()
                .justify_between()
                .child(text("Owner queue").font(typo::CAPTION).color(p.ink_muted))
                .child(
                    text(format!(
                        "{} paused, {} queued",
                        s.data.blockers.counts.paused, s.data.blockers.counts.orchestrator_queue
                    ))
                    .font(typo::NUM_S)
                    .color(p.ink_secondary),
                ),
        );
    }

    plate
}

#[allow(clippy::too_many_arguments)]
fn decision_gate_row(
    idx: usize,
    card: &DecisionGateCard,
    is_selected: bool,
    is_pending_write: bool,
    shake_dx: f32,
    lit: bool,
    p: &Palette,
) -> El {
    let over_24h = gate_is_over_24h(card);
    let ring_tone = if over_24h { Tone::Urgent } else { Tone::Steel };
    let card_id = card.id.clone();
    let card_id_rev = card.id.clone();
    let card_id_def = card.id.clone();

    let approve_label = if is_pending_write {
        "Saving"
    } else {
        "Approve"
    };
    let mut stamp_btn = if is_selected {
        let mut b = kit::button_primary(approve_label, Some("A"), p);
        if is_pending_write {
            b = b.fill(p.ink.alpha(0.6));
        }
        b
    } else {
        kit::button_quiet(approve_label, None, p).h(24.0).px(space::S2)
    };
    stamp_btn = stamp_btn
        .key(format!("stamp-{idx}"))
        .role("button")
        .label(format!("Approve #{}", card.id))
        .help("Approve and write back owner verdict")
        .focusable(true)
        .focus_ring(2.0, 1.5, p.focus_ring)
        .on_press_tx(move |st: &mut AppState, tx: &mut Tx| {
            st.submit_verdict(&card_id, DecisionVerdict::Approved);
            tx.animated();
        });

    let revise_btn = if is_selected {
        kit::button_quiet("Revise", Some("R"), p)
    } else {
        kit::button_quiet("Revise", None, p).h(24.0).px(space::S2)
    }
    .key(format!("revise-{idx}"))
    .role("button")
    .label(format!("Revise #{}", card.id))
    .focusable(true)
    .on_press_tx(move |st: &mut AppState, tx: &mut Tx| {
        st.submit_verdict(&card_id_rev, DecisionVerdict::Revised);
        tx.animated();
    });

    let defer_btn = if is_selected {
        kit::button_quiet("Defer", Some("D"), p)
    } else {
        kit::button_quiet("Defer", None, p).h(24.0).px(space::S2)
    }
    .key(format!("defer-{idx}"))
    .role("button")
    .label(format!("Defer #{}", card.id))
    .focusable(true)
    .on_press_tx(move |st: &mut AppState, tx: &mut Tx| {
        st.submit_verdict(&card_id_def, DecisionVerdict::Deferred);
        tx.animated();
    });

    let meta_line = row()
        .w_full()
        .min_w(0.0)
        .gap(space::S2)
        .items_center()
        .child(kit::ring(card.age_ratio, 14.0, ring_tone, p))
        .child(
            text(&card.age_label)
                .font(typo::NUM)
                .color(if over_24h { p.vermilion } else { p.ink_secondary }),
        )
        .child(
            text(format!("#{}", card.id))
                .font(typo::MONO_S)
                .color(p.ink_muted),
        )
        .child(
            text(&card.channel)
                .font(typo::CAPTION)
                .color(p.ink_muted)
                .truncate()
                .shrink()
                .help_when_truncated(&card.channel),
        )
        .child(spacer())
        .child(
            text(&card.author)
                .font(typo::CAPTION)
                .color(p.ink_muted)
                .truncate_middle()
                .shrink()
                .help_when_truncated(&card.author),
        );

    let rec_text = format!("Recommends: {}", card.recommendation);

    let actions = row()
        .w_full()
        .pt(space::S1)
        .gap(space::S2)
        .items_center()
        .child(stamp_btn)
        .child(revise_btn)
        .child(defer_btn);

    let mut gate = col()
        .key(format!("gate-card-{}", card.id))
        .w_full()
        .px(space::S4)
        .py(space::S2)
        .gap(space::S1)
        .fill(if is_selected {
            p.selection
        } else if lit {
            p.hover
        } else {
            Color::TRANSPARENT
        })
        .hover_fill(p.hover)
        .offset(shake_dx, 0.0)
        .motion(motion::SNAPPY)
        .transition(Transition::offset(0.0, -8.0).combined(Transition::opacity()))
        .on_press_tx(move |st: &mut AppState, tx: &mut Tx| {
            let max_idx = st.pending_decision_gates().len().saturating_sub(1);
            st.selected_gate_idx = idx.min(max_idx);
            tx.animated();
        })
        .on_hover_change(move |st: &mut AppState, over, _tx| {
            if over {
                st.hovered_flow = Some((3, idx));
            } else if st.hovered_flow == Some((3, idx)) {
                st.hovered_flow = None;
            }
        });

    if is_selected {
        gate = gate.child(kit::focus_bar(p));
    }

    gate.child(meta_line)
        .child(
            text(&card.title)
                .font(typo::HEADING)
                .color(p.ink)
                .wrap()
                .max_lines(2)
                .help_when_truncated(&card.title),
        )
        .child(
            text(&rec_text)
                .font(typo::BODY)
                .color(p.ink_secondary)
                .wrap()
                .max_lines(2)
                .help_when_truncated(&rec_text),
        )
        .child(actions)
}

fn col_what_it_becomes(s: &AppState, p: &Palette) -> El {
    let docs = format_k(s.data.today.summary.docs_total);
    let claims = format_k(s.data.today.summary.claims_live);
    let codex_total = s.data.codex.stats.total;
    let taste_ans = s.data.taste.stats.answered_count;
    let taste_tot = s.data.taste.stats.total_questions;
    let memt = s.data.today.summary.memt_verified;
    let brain_online = s.data.health.brain_online;

    let (taste_val, taste_ratio) = if taste_tot > 0 {
        (
            format!("{taste_ans}/{taste_tot}"),
            Some(taste_ans as f32 / taste_tot as f32),
        )
    } else {
        ("None".into(), None)
    };

    type SinkRow<'a> = (&'a str, String, String, Option<f32>, Option<Tone>);
    let sinks: [SinkRow<'_>; 5] = [
        (
            "Kizuki Vault",
            docs,
            format!(
                "{claims} claims, {} people",
                s.data.today.summary.people_total
            ),
            None,
            None,
        ),
        (
            "Personal Codex",
            format!("{codex_total}"),
            format!(
                "{} ideas, {} bookmarks",
                s.data.codex.stats.ideas, s.data.codex.stats.bookmarks
            ),
            None,
            None,
        ),
        (
            "Taste Ledger",
            taste_val,
            format!(
                "{}% calibrated, {} gardeners",
                s.data.taste.stats.calibration_pct, s.data.gardeners.stats.gardeners_total
            ),
            taste_ratio,
            None,
        ),
        (
            "MemT Skills",
            format!("{memt}"),
            "Verified trajectory skills".into(),
            None,
            None,
        ),
        (
            "Brain :4113",
            if brain_online { "Online" } else { "Offline" }.into(),
            format!("{} events indexed", format_k(s.data.today.summary.events_total)),
            None,
            Some(if brain_online {
                Tone::Live
            } else {
                Tone::Caution
            }),
        ),
    ];

    let mut body = col().w_full().grow(1.0).min_h(0.0);
    for (i, (name, value, sub, ratio, status_dot)) in sinks.into_iter().enumerate() {
        if i > 0 {
            body = body.child(kit::rule_h(p));
        }
        let lit = s.hovered_flow == Some((4, i));
        let metric_el = if let Some(dot_tone) = status_dot {
            row()
                .gap(5.0)
                .items_center()
                .shrink()
                .child(kit::dot(dot_tone, p))
                .child(
                    text(&value)
                        .font(typo::NUM)
                        .color(p.ink_secondary)
                        .truncate()
                        .shrink(),
                )
        } else {
            text(&value)
                .font(typo::NUM)
                .color(p.ink_secondary)
                .truncate()
                .shrink()
        };

        let mut band = col()
            .key(format!("sink-{i}"))
            .w_full()
            .grow(1.0)
            .justify_center()
            .gap(space::S1)
            .px(space::S1)
            .radius(radius::ROW)
            .fill(if lit { p.hover } else { Color::TRANSPARENT })
            .hover_fill(p.hover)
            .motion(motion::SNAPPY)
            .on_hover_change(move |st: &mut AppState, over, _tx| {
                if over {
                    st.hovered_flow = Some((4, i));
                } else if st.hovered_flow == Some((4, i)) {
                    st.hovered_flow = None;
                }
            })
            .child(
                row()
                    .w_full()
                    .min_w(0.0)
                    .items_center()
                    .justify_between()
                    .gap(space::S2)
                    .child(
                        text(name)
                            .font(typo::BODY_STRONG)
                            .color(p.ink)
                            .truncate()
                            .help_when_truncated(name),
                    )
                    .child(metric_el),
            )
            .child(
                text(&sub)
                    .font(typo::CAPTION)
                    .color(p.ink_muted)
                    .truncate()
                    .help_when_truncated(&sub),
            );
        if let Some(frac) = ratio {
            band = band.child(kit::meter(frac, Tone::Steel, p));
        }
        body = body.child(band);
    }

    kit::pane()
        .key("col-becomes")
        .w(200.0)
        .h_full()
        .pl(space::S2)
        .child(kit::pane_head("What it becomes", "5", p))
        .child(kit::rule_h(p))
        .child(body)
        .child(quiet_column_footer(
            "Pipelines",
            format!(
                "{}/{} live",
                s.data.today.summary.active_pipelines, s.data.today.summary.total_pipelines
            ),
            p,
        ))
}

/// 72px hairline-separated telemetry footer rail: 5 live stat+spark cells and 20-segment seat
/// headroom gauges in steel (amber below 15% headroom). Zero boxes, zero hardware costume copy.
fn telemetry_rail(s: &AppState, p: &Palette) -> El {
    let load_val = match s.data.host_load_ratio() {
        Some(v) => format!("{v:.2}x"),
        None => "None".into(),
    };
    let host_help = match s.data.host_mem_gib() {
        Some(v) => format!("Host load {load_val}, {v:.1} GiB free"),
        None => format!("Host load {load_val}"),
    };
    let totals = &s.data.health.totals;

    let cells: [(&str, String, bool, String); 5] = [
        (
            "Host",
            load_val,
            s.data.host_load_ratio().is_some(),
            host_help,
        ),
        (
            "Board",
            format!("{}", totals.messages),
            s.data.health.board_online,
            format!("{} channels, {} open tasks", totals.channels, totals.open_tasks),
        ),
        (
            "Dispatcher",
            format!("{}", totals.blocked),
            s.data.health.cockpit_online,
            format!(
                "{} blocked, dispatcher {}",
                totals.blocked,
                if s.data.health.cockpit_online {
                    "online"
                } else {
                    "offline"
                }
            ),
        ),
        (
            "Brain",
            format_k(s.data.today.summary.events_total),
            s.data.health.brain_online,
            format!(
                "{} docs, {} MemT skills",
                format_k(s.data.today.summary.docs_total),
                s.data.today.summary.memt_verified
            ),
        ),
        (
            "GPU",
            if s.data.health.synth_ready {
                format!("{}", s.data.gardeners.stats.runs_total)
            } else {
                "Idle".into()
            },
            s.data.health.synth_ready,
            format!(
                "Local GPU, {} gardeners, {} runs",
                s.data.gardeners.stats.gardeners_total, s.data.gardeners.stats.runs_total
            ),
        ),
    ];

    let mut left_cells = row()
        .key("rack-nodes")
        .grow(1.0)
        .min_w(0.0)
        .h_full()
        .items_center()
        .gap(space::S3);

    for (i, (label, val, live, help_text)) in cells.into_iter().enumerate() {
        if i > 0 {
            left_cells = left_cells.child(kit::rule_v(p));
        }
        let series = s.telemetry.series_for(i);
        left_cells = left_cells.child(
            row()
                .key(format!("hw-mod-{i}"))
                .grow(1.0)
                .min_w(0.0)
                .h_full()
                .items_center()
                .justify_between()
                .gap(space::S2)
                .help(help_text)
                .child(kit::stat(label, &val, p))
                .child(kit::spark(&series, live, 72.0, 20.0, p)),
        );
    }

    let seats = s.data.seats_effective();
    let mesh_on = s.data.health.mesh.nodes_online;
    let mesh_tot = s.data.health.mesh.nodes_total;
    let mesh_degraded = mesh_tot > 0 && mesh_on * 2 < mesh_tot;

    let mut right_seats = col()
        .key("seat-gauges")
        .w(360.0)
        .h_full()
        .justify_center()
        .gap(3.0)
        .child(
            row()
                .w_full()
                .items_center()
                .justify_between()
                .child(text("Seat headroom").font(typo::LABEL).color(p.ink_muted))
                .child(
                    row()
                        .gap(5.0)
                        .items_center()
                        .child(kit::dot(
                            if mesh_degraded {
                                Tone::Caution
                            } else {
                                Tone::Live
                            },
                            p,
                        ))
                        .child(
                            text(format!("{mesh_on} of {mesh_tot} mesh nodes online"))
                                .font(typo::LABEL)
                                .color(if mesh_degraded {
                                    p.amber
                                } else {
                                    p.ink_muted
                                }),
                        ),
                ),
        );

    if seats.is_empty() {
        right_seats = right_seats.child(
            text("No seat telemetry")
                .font(typo::CAPTION)
                .color(p.ink_muted),
        );
    } else {
        for (i, seat) in seats.iter().take(3).enumerate() {
            right_seats = right_seats.child(seat_gauge_row(i, seat, p));
        }
    }

    col()
        .key("hardware-rack")
        .w_full()
        .h(72.0)
        .gap(space::S2)
        .child(kit::rule_h(p))
        .child(
            row()
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .items_center()
                .gap(space::S4)
                .child(left_cells)
                .child(kit::rule_v(p))
                .child(right_seats),
        )
}

fn seat_gauge_row(idx: usize, seat: &SeatInfo, p: &Palette) -> El {
    let pct = seat.headroom_pct();
    let frac = pct as f32 / 100.0;
    let low = pct < 15;
    let tone = if low { Tone::Caution } else { Tone::Steel };
    let model = if !seat.model.is_empty() {
        seat.model.as_str()
    } else if !seat.id.is_empty() {
        seat.id.as_str()
    } else {
        seat.harness.as_str()
    };

    row()
        .key(format!("seat-row-{idx}"))
        .w_full()
        .h(15.0)
        .items_center()
        .justify_between()
        .gap(space::S2)
        .child(
            text(model)
                .font(typo::MONO_S)
                .color(p.ink_secondary)
                .w(148.0)
                .truncate()
                .help_when_truncated(model),
        )
        .child(
            row()
                .w(120.0)
                .items_center()
                .child(kit::seg_gauge(frac, 20, tone, p)),
        )
        .child(
            text(format!("{pct}%"))
                .font(typo::NUM_S)
                .color(if low { p.amber } else { p.ink })
                .w(36.0),
        )
}

/// Sanitizes live telemetry descriptions so raw route paths or build claims never render.
fn sanitize_live_copy(raw: &str, max_chars: usize) -> String {
    let raw_tokens: Vec<&str> = raw.split_whitespace().collect();
    let mut cleaned: Vec<&str> = Vec::with_capacity(raw_tokens.len());
    let mut skip_next = false;
    for (idx, tok) in raw_tokens.iter().enumerate() {
        if skip_next {
            skip_next = false;
            continue;
        }
        let segs: Vec<&str> = tok.split('/').collect();
        if segs.len() >= 3 && segs[0].is_empty() && segs[1].eq_ignore_ascii_case("api") {
            cleaned.push("live");
            cleaned.push("feed");
            continue;
        }
        if *tok == "0"
            && raw_tokens
                .get(idx + 1)
                .is_some_and(|next| next.eq_ignore_ascii_case("unsafe"))
        {
            if cleaned.last().copied() == Some("·") {
                cleaned.pop();
            }
            skip_next = true;
            continue;
        }
        cleaned.push(*tok);
    }
    let joined = cleaned.join(" ").replace('\u{2014}', " - ");
    clean_snippet(&joined, max_chars)
}

/// Strips verbose filesystem prefixes into a clean repo basename.
fn clean_repo_label(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return "kizuki-box".into();
    }
    if trimmed.starts_with('/') {
        let segs: Vec<&str> = trimmed.split('/').filter(|s| !s.is_empty()).collect();
        if let Some(last) = segs.last() {
            return (*last).to_string();
        }
    }
    trimmed.to_string()
}

fn harness_monogram(runtime: &str, name: &str) -> String {
    let rt = runtime.trim().to_ascii_lowercase();
    if rt.contains("codex") {
        return "CX".into();
    }
    if rt.contains("claude") {
        return "CL".into();
    }
    if rt.contains("neon") {
        return "NE".into();
    }
    if rt.contains("gemini") {
        return "GM".into();
    }
    if rt.contains("keeper") || rt.contains("ambient") {
        return "KP".into();
    }
    if rt.contains("g4") || rt.contains("synth") || rt.contains("gpu") {
        return "GP".into();
    }
    let src = if !runtime.trim().is_empty() {
        runtime.trim()
    } else {
        name.trim()
    };
    let chars: String = src
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(2)
        .collect::<String>()
        .to_ascii_uppercase();
    if chars.is_empty() { "AG".into() } else { chars }
}

fn format_kind_label(kind: &str) -> String {
    let k = kind.trim();
    if k.is_empty() {
        return "Target".into();
    }
    let lower = k.to_ascii_lowercase();
    if lower == "gpu" {
        return "GPU".into();
    }
    let mut chars = lower.chars();
    match chars.next() {
        Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
        None => "Target".into(),
    }
}

fn category_col_idx(raw: &str) -> usize {
    match normalize_ai_category(raw) {
        "building" => 0,
        "designing" => 1,
        "predicting" => 2,
        _ => 3,
    }
}

/// Orders shared resources by the mean lane index of their incoming edges to minimize crossings.
fn ordered_resources(snap: &BoxAiLiveSnapshot) -> Vec<(usize, &BoxAiResource)> {
    let base: Vec<(usize, &BoxAiResource)> = snap.resources.iter().take(5).enumerate().collect();
    if base.len() <= 1 {
        return base;
    }
    let mut keyed: Vec<(f32, usize, &BoxAiResource)> = base
        .into_iter()
        .map(|(orig_idx, res)| {
            let mut sum = 0.0_f32;
            let mut cnt = 0.0_f32;
            for e in &snap.edges {
                if e.to == res.id || e.to == res.label {
                    let from_col = snap
                        .agents
                        .iter()
                        .find(|a| a.id == e.from || a.name == e.from)
                        .map(|a| category_col_idx(&a.category))
                        .unwrap_or_else(|| category_col_idx(&e.category));
                    sum += from_col as f32;
                    cnt += 1.0;
                }
            }
            let mean_col = if cnt > 0.0 {
                sum / cnt
            } else {
                orig_idx as f32
            };
            (mean_col, orig_idx, res)
        })
        .collect();
    keyed.sort_by(|a, b| {
        a.0.partial_cmp(&b.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.1.cmp(&b.1))
    });
    keyed.into_iter().map(|(_, idx, res)| (idx, res)).collect()
}

/// View 5: De-boxified AI Live Observatory (`5 AI Live`).
/// Editorial header, 4 hairline-divided live lanes, 72px steel cubic conduit manifold,
/// crossing-minimized target cells, and a compact selected-worker inspector strip.
pub fn ai_live_view(s: &AppState, p: &Palette) -> El {
    let (snap, is_live) = s.box_ai_live_effective();
    let (total_live, _, _, _, _) = snap.effective_counts();
    let total_cpu: f32 = if snap.summary.total_cpu_pct > 0.0 {
        snap.summary.total_cpu_pct
    } else {
        snap.agents.iter().map(|a| a.cpu_pct).sum()
    };
    let total_ram_mb: f32 = if snap.summary.total_ram_mb > 0.0 {
        snap.summary.total_ram_mb
    } else {
        snap.agents.iter().map(|a| a.ram_mb).sum()
    };
    let ram_label = if total_ram_mb >= 1024.0 {
        format!("{:.2} GiB", total_ram_mb / 1024.0)
    } else {
        format!("{:.0} MiB", total_ram_mb)
    };
    let worker_word = if total_live == 1 { "worker" } else { "workers" };
    let summary_text = format!(
        "{total_live} {worker_word} in 4 lanes. {total_cpu:.1}% CPU, {ram_label}."
    );

    let header = row()
        .key("ai-live-header")
        .w_full()
        .h(42.0)
        .items_center()
        .justify_between()
        .gap(space::S4)
        .child(
            row()
                .gap(space::S3)
                .items_center()
                .child(text("AI Live").font(typo::TITLE).color(p.ink))
                .child(text(summary_text).font(typo::CAPTION).color(p.ink_secondary)),
        )
        .child(
            row()
                .gap(space::S4)
                .items_center()
                .child(
                    row()
                        .gap(6.0)
                        .items_center()
                        .child(kit::dot(
                            if is_live { Tone::Live } else { Tone::Caution },
                            p,
                        ))
                        .child(
                            text(if is_live { "Live" } else { "Local snapshot" })
                                .font(typo::BODY_STRONG)
                                .color(if is_live { p.ink } else { p.amber }),
                        ),
                ),
        );

    let lane_defs: [(usize, &str, &str); 4] = [
        (0, "Building", "building"),
        (1, "Designing", "designing"),
        (2, "Predicting", "predicting"),
        (3, "Orchestrating", "orchestrating"),
    ];

    let mut columns = row()
        .key("ai-live-columns")
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .gap(space::S4);

    for (i, (col_idx, title, cat_key)) in lane_defs.into_iter().enumerate() {
        if i > 0 {
            columns = columns.child(kit::rule_v(p));
        }
        columns = columns.child(ai_lane_column(s, &snap, col_idx, title, cat_key, p));
    }

    let ordered_res = ordered_resources(&snap);
    let selected_lane = snap
        .agents
        .get(s.selected_ai_agent_idx)
        .map(|a| category_col_idx(&a.category));

    let manifold = ai_conduit_manifold(&snap, &ordered_res, s.hovered_ai_node, selected_lane, p);
    let targets = ai_targets_row(s, &ordered_res, p);

    let mut root = col()
        .key("ai-live-view")
        .w_full()
        .h_full()
        .gap(space::S2)
        .child(header)
        .child(kit::rule_h(p))
        .child(
            col()
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .gap(0.0)
                .child(columns)
                .child(manifold)
                .child(targets),
        );

    if let Some(selected) = snap.agents.get(s.selected_ai_agent_idx) {
        root = root
            .child(kit::rule_h(p))
            .child(ai_selected_inspector_strip(selected, p));
    }

    root
}

fn ai_lane_column(
    s: &AppState,
    snap: &BoxAiLiveSnapshot,
    col_idx: usize,
    title: &str,
    cat_key: &str,
    p: &Palette,
) -> El {
    let lane_agents: Vec<(usize, &BoxAiAgent)> = snap
        .agents
        .iter()
        .enumerate()
        .filter(|(_, a)| normalize_ai_category(&a.category) == cat_key)
        .take(4)
        .collect();
    let lane_cpu: f32 = lane_agents.iter().map(|(_, a)| a.cpu_pct).sum();
    let meta = format!("{} live, {lane_cpu:.1}% CPU", lane_agents.len());

    let mut body = col().w_full().grow(1.0).min_h(0.0);
    if lane_agents.is_empty() {
        body = body.child(
            row()
                .w_full()
                .pt(space::S3)
                .child(
                    text("No active workers")
                        .font(typo::CAPTION)
                        .color(p.ink_muted),
                ),
        );
    } else {
        for (row_idx, (global_idx, agent)) in lane_agents.into_iter().enumerate() {
            if row_idx > 0 {
                body = body.child(kit::rule_h(p));
            }
            let is_selected = global_idx == s.selected_ai_agent_idx;
            let cpu_frac = (agent.cpu_pct / 100.0).clamp(0.0, 1.0);
            let name = if agent.name.is_empty() {
                agent.id.as_str()
            } else {
                agent.name.as_str()
            };
            let code = harness_monogram(&agent.runtime, name);
            let action = if agent.current_action.is_empty() {
                "Monitoring live event bus".into()
            } else {
                sanitize_live_copy(&agent.current_action, 96)
            };
            let repo = clean_repo_label(&agent.repo);
            let tool = if agent.active_tool.is_empty() {
                "idle".into()
            } else {
                clean_snippet(&agent.active_tool, 22)
            };

            let mut item = col()
                .key(format!("ai-agent-{}", agent.id))
                .w_full()
                .px(space::S3)
                .py(space::S2)
                .gap(6.0)
                .radius(radius::ROW)
                .fill(if is_selected {
                    p.selection
                } else {
                    Color::TRANSPARENT
                })
                .hover_fill(p.hover)
                .motion(motion::SNAPPY)
                .on_press_tx(move |st: &mut AppState, tx: &mut Tx| {
                    st.selected_ai_agent_idx = global_idx;
                    tx.animated();
                })
                .on_hover_change(move |st: &mut AppState, over, _tx| {
                    if over {
                        st.hovered_ai_node = Some((0, col_idx));
                    } else if st.hovered_ai_node == Some((0, col_idx)) {
                        st.hovered_ai_node = None;
                    }
                });

            if is_selected {
                item = item.child(kit::focus_bar(p));
            }

            item = item
                .child(
                    row()
                        .w_full()
                        .min_w(0.0)
                        .items_center()
                        .justify_between()
                        .gap(space::S2)
                        .child(
                            row()
                                .grow(1.0)
                                .min_w(0.0)
                                .gap(space::S2)
                                .items_center()
                                .child(kit::monogram(&code, 22.0, p))
                                .child(
                                    text(name)
                                        .font(typo::BODY_STRONG)
                                        .color(p.ink)
                                        .truncate()
                                        .help_when_truncated(name),
                                ),
                        )
                        .child(
                            text(format!("{:.1}%", agent.cpu_pct))
                                .font(typo::NUM)
                                .color(p.ink_secondary)
                                .shrink(),
                        ),
                )
                .child(
                    text(&action)
                        .font(typo::BODY)
                        .color(p.ink_secondary)
                        .wrap()
                        .max_lines(2)
                        .help_when_truncated(&action),
                )
                .child(
                    row()
                        .w_full()
                        .min_w(0.0)
                        .items_center()
                        .justify_between()
                        .gap(space::S2)
                        .child(
                            text(&repo)
                                .font(typo::MONO_S)
                                .color(p.ink_muted)
                                .truncate_middle()
                                .shrink()
                                .help_when_truncated(&agent.repo),
                        )
                        .child(kit::tag(&tool, Tone::Steel, p)),
                )
                .child(kit::meter(cpu_frac, Tone::Steel, p));

            body = body.child(item);
        }
    }

    let col_key = match col_idx {
        0 => "ai-col-building",
        1 => "ai-col-designing",
        2 => "ai-col-predicting",
        _ => "ai-col-orchestrating",
    };

    kit::pane()
        .key(col_key)
        .grow(1.0)
        .min_w(0.0)
        .h_full()
        .child(kit::pane_head(title, &meta, p))
        .child(kit::rule_h(p))
        .child(body)
}

/// 72px steel cubic conduit manifold wiring the 4 lanes to the crossing-minimized target row.
/// One 1.25px stroke per edge with vertical tangents and 3px port ticks. Zero glow or ornament.
fn ai_conduit_manifold(
    snap: &BoxAiLiveSnapshot,
    ordered_res: &[(usize, &BoxAiResource)],
    hovered: Option<(usize, usize)>,
    selected_lane: Option<usize>,
    p: &Palette,
) -> El {
    let vb_w = 1400.0_f32;
    let vb_h = 72.0_f32;
    let sy0 = 3.0_f32;
    let sy1 = vb_h - 3.0_f32;
    let mid_y = vb_h * 0.5;
    let res_n = ordered_res.len().max(1);

    struct Wire {
        from_col: usize,
        to_pos: usize,
    }

    let mut wires: Vec<Wire> = Vec::new();
    for e in &snap.edges {
        let from_col = snap
            .agents
            .iter()
            .find(|a| a.id == e.from || a.name == e.from)
            .map(|a| category_col_idx(&a.category))
            .unwrap_or_else(|| category_col_idx(&e.category));
        let to_pos = ordered_res
            .iter()
            .position(|(_, r)| r.id == e.to || r.label == e.to)
            .unwrap_or(from_col % res_n);
        wires.push(Wire { from_col, to_pos });
    }

    if wires.is_empty() {
        for c in 0..4 {
            wires.push(Wire {
                from_col: c,
                to_pos: c % res_n,
            });
        }
    }

    let gutter = 33.0_f32;
    let col_w = (vb_w - gutter * 3.0) / 4.0;
    let col_center_x = |col_idx: usize, off: f32| -> f32 {
        col_idx as f32 * (col_w + gutter) + col_w * 0.5 + off
    };

    let res_gap = 25.0_f32;
    let res_w = (vb_w - res_gap * (res_n.saturating_sub(1) as f32)) / res_n as f32;
    let res_center_x = |pos: usize, off: f32| -> f32 {
        pos as f32 * (res_w + res_gap) + res_w * 0.5 + off
    };

    let mut from_counts = [0usize; 4];
    let mut to_counts = [0usize; 5];
    for w in &wires {
        from_counts[w.from_col.min(3)] += 1;
        to_counts[w.to_pos.min(4)] += 1;
    }

    let mut from_seen = [0usize; 4];
    let mut to_seen = [0usize; 5];
    let mut coords: Vec<(usize, usize, f32, f32)> = Vec::with_capacity(wires.len());
    for w in &wires {
        let fc = w.from_col.min(3);
        let tp = w.to_pos.min(4);
        let f_pos = from_seen[fc];
        from_seen[fc] += 1;
        let t_pos = to_seen[tp];
        to_seen[tp] += 1;

        let f_off = (f_pos as f32 - (from_counts[fc].saturating_sub(1) as f32) * 0.5) * 18.0;
        let t_off = (t_pos as f32 - (to_counts[tp].saturating_sub(1) as f32) * 0.5) * 16.0;
        coords.push((fc, tp, col_center_x(fc, f_off), res_center_x(tp, t_off)));
    }

    let active_focus = hovered.is_some() || selected_lane.is_some();
    let is_lit = |fc: usize, tp: usize| -> bool {
        match hovered {
            Some((0, c)) => c == fc,
            Some((1, r)) => r == tp,
            _ => selected_lane == Some(fc),
        }
    };

    let mut quiet_wires = Vec::new();
    let mut lit_wires = Vec::new();
    for item in coords {
        if is_lit(item.0, item.1) {
            lit_wires.push(item);
        } else {
            quiet_wires.push(item);
        }
    }

    let mut shape = Shape::new().view_box(vb_w, vb_h);
    for (fc, tp, x0, x1) in quiet_wires.into_iter().chain(lit_wires) {
        let lit = is_lit(fc, tp);
        let stroke_col = if lit {
            p.ink.alpha(0.80)
        } else if active_focus {
            p.steel.alpha(0.12)
        } else {
            p.steel.alpha(0.35)
        };
        let curve = Path::new()
            .move_to([x0, sy0])
            .cubic_to([x0, mid_y], [x1, mid_y], [x1, sy1]);
        shape = shape
            .line([x0, 0.0], [x0, sy0], 1.25, LineCap::Butt, stroke_col)
            .line([x1, sy1], [x1, vb_h], 1.25, LineCap::Butt, stroke_col)
            .stroke_path(&curve, 1.25, LineCap::Round, stroke_col);
    }

    canvas(shape)
        .key("ai-optical-bus-manifold")
        .w_full()
        .h(vb_h)
}

fn ai_targets_row(
    s: &AppState,
    ordered_res: &[(usize, &BoxAiResource)],
    p: &Palette,
) -> El {
    let mut cells = row()
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .items_center()
        .gap(space::S3);

    for (sorted_pos, (orig_idx, res)) in ordered_res.iter().enumerate() {
        if sorted_pos > 0 {
            cells = cells.child(kit::rule_v(p));
        }
        let lit = s.hovered_ai_node == Some((1, sorted_pos));
        let kind_label = format_kind_label(&res.kind);
        let metric = if res.metric.is_empty() {
            "Online".into()
        } else {
            sanitize_live_copy(&res.metric, 36)
        };

        cells = cells.child(
            col()
                .key(format!("ai-res-{orig_idx}"))
                .grow(1.0)
                .min_w(0.0)
                .px(space::S2)
                .py(space::S1)
                .gap(3.0)
                .radius(radius::ROW)
                .fill(if lit { p.hover } else { Color::TRANSPARENT })
                .hover_fill(p.hover)
                .motion(motion::SNAPPY)
                .on_hover_change(move |st: &mut AppState, over, _tx| {
                    if over {
                        st.hovered_ai_node = Some((1, sorted_pos));
                    } else if st.hovered_ai_node == Some((1, sorted_pos)) {
                        st.hovered_ai_node = None;
                    }
                })
                .child(
                    row()
                        .w_full()
                        .items_center()
                        .justify_between()
                        .gap(space::S2)
                        .child(text(kind_label).font(typo::LABEL).color(p.ink_muted))
                        .child(
                            text(format!("{} linked", res.active_count))
                                .font(typo::NUM)
                                .color(p.ink_secondary),
                        ),
                )
                .child(
                    text(&res.label)
                        .font(typo::BODY_STRONG)
                        .color(p.ink)
                        .truncate()
                        .help_when_truncated(&res.label),
                )
                .child(
                    text(&metric)
                        .font(typo::CAPTION)
                        .color(p.ink_muted)
                        .truncate()
                        .help_when_truncated(&metric),
                ),
        );
    }

    col()
        .key("ai-shared-resources-dock")
        .w_full()
        .h(78.0)
        .gap(space::S2)
        .child(kit::rule_h(p))
        .child(cells)
}

fn ai_selected_inspector_strip(agent: &BoxAiAgent, p: &Palette) -> El {
    let name = if agent.name.is_empty() {
        agent.id.as_str()
    } else {
        agent.name.as_str()
    };
    let pid_str = agent
        .pid
        .map(|pid| format!("PID {pid}"))
        .unwrap_or_else(|| "Local".into());
    let ram_str = if agent.ram_mb >= 1024.0 {
        format!("{:.2} GiB", agent.ram_mb / 1024.0)
    } else {
        format!("{:.0} MiB", agent.ram_mb)
    };
    let action = if agent.current_action.is_empty() {
        "Monitoring live event bus".into()
    } else {
        sanitize_live_copy(&agent.current_action, 110)
    };
    let repo = clean_repo_label(&agent.repo);

    row()
        .key("ai-selected-inspector")
        .w_full()
        .h(32.0)
        .items_center()
        .justify_between()
        .gap(space::S4)
        .child(
            row()
                .grow(1.0)
                .min_w(0.0)
                .items_center()
                .gap(space::S3)
                .child(text("Selected").font(typo::LABEL).color(p.ink_muted))
                .child(text(name).font(typo::BODY_STRONG).color(p.ink))
                .child(text(pid_str).font(typo::MONO_S).color(p.ink_muted))
                .child(text(&repo).font(typo::MONO_S).color(p.ink_secondary))
                .child(
                    text(&action)
                        .font(typo::CAPTION)
                        .color(p.ink_secondary)
                        .truncate()
                        .shrink()
                        .help_when_truncated(&action),
                ),
        )
        .child(
            row()
                .gap(space::S3)
                .items_center()
                .child(
                    text(format!("{:.1}% CPU", agent.cpu_pct))
                        .font(typo::NUM_S)
                        .color(p.ink),
                )
                .child(text(ram_str).font(typo::NUM_S).color(p.ink_secondary)),
        )
}
