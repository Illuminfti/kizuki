//! View 3: Today (Editorial Date Masthead, 24h Day Dial, and De-Boxified Hairline Columns).

use rune::color::Color;
use rune::tok::motion;
use rune::{El, LineCap, Path, ScrollSpec, Shape, Tx, canvas, col, el, row, text};

use crate::data::{ConnectionState, ScheduleEvent, format_k};
use crate::state::{AppState, CommitmentOp, DecisionVerdict};
use crate::theme::{Palette, Tone, kit, radius, space, typo};

pub fn view(s: &AppState, p: &Palette) -> El {
    let today_events: Vec<&ScheduleEvent> = s
        .data
        .today
        .schedule
        .iter()
        .filter(|e| e.is_today)
        .collect();
    let next_ev = find_next_event(s, &today_events);

    let masthead = editorial_masthead(s, &today_events, next_ev, p);
    let dial = day_dial_strip(s, &today_events, next_ev, p);

    let body = row()
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .gap(0.0)
        .child(decide_and_projects_column(s, p))
        .child(gutter_v(p))
        .child(meetings_and_commitments_column(s, p))
        .child(gutter_v(p))
        .child(schedule_and_loops_column(s, next_ev, p));

    let footer = pipeline_footer(s, p);

    col()
        .key("today-view")
        .w_full()
        .h_full()
        .gap(space::S4)
        .child(masthead)
        .child(dial)
        .child(body)
        .child(footer)
}

fn gutter_v(p: &Palette) -> El {
    row()
        .w(space::PANE_GAP)
        .h_full()
        .justify_center()
        .child(kit::rule_v(p))
}

fn find_next_event<'a>(
    s: &'a AppState,
    today_events: &[&'a ScheduleEvent],
) -> Option<&'a ScheduleEvent> {
    s.data
        .today
        .schedule
        .iter()
        .find(|e| e.is_now)
        .or_else(|| today_events.first().copied())
        .or_else(|| s.data.today.schedule.first())
}

fn format_editorial_date(snapshot_date: &str) -> String {
    let parts: Vec<&str> = snapshot_date.split('-').collect();
    if parts.len() == 3
        && let (Ok(y), Ok(m), Ok(d)) = (
            parts[0].parse::<i64>(),
            parts[1].parse::<i64>(),
            parts[2].parse::<i64>(),
        )
        && (1..=12).contains(&m)
        && (1..=31).contains(&d)
    {
        let y_adj = y - if m <= 2 { 1 } else { 0 };
        let era = if y_adj >= 0 { y_adj } else { y_adj - 399 } / 400;
        let yoe = y_adj - era * 400;
        let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        let days = era * 146097 + doe - 719468;
        let weekday = match (days + 4).rem_euclid(7) {
            0 => "Sunday",
            1 => "Monday",
            2 => "Tuesday",
            3 => "Wednesday",
            4 => "Thursday",
            5 => "Friday",
            _ => "Saturday",
        };
        let month = match m {
            1 => "January",
            2 => "February",
            3 => "March",
            4 => "April",
            5 => "May",
            6 => "June",
            7 => "July",
            8 => "August",
            9 => "September",
            10 => "October",
            11 => "November",
            _ => "December",
        };
        return format!("{weekday} {d} {month}");
    }
    "Today".to_string()
}

fn event_start_hhmm(ev: &ScheduleEvent) -> String {
    ev.start
        .split('T')
        .nth(1)
        .map(|t| t.chars().take(5).collect::<String>())
        .unwrap_or_else(|| "--:--".into())
}

fn event_end_hhmm(ev: &ScheduleEvent) -> String {
    ev.end
        .split('T')
        .nth(1)
        .map(|t| t.chars().take(5).collect::<String>())
        .unwrap_or_else(|| "--:--".into())
}

fn sanitize_copy(raw: &str) -> String {
    raw.replace('\u{2014}', " - ")
}

fn editorial_masthead(
    s: &AppState,
    today_events: &[&ScheduleEvent],
    next_ev: Option<&ScheduleEvent>,
    p: &Palette,
) -> El {
    let date_headline = format_editorial_date(&s.data.snapshot_date());
    let waiting = s.waiting_decision_count();
    let decisions_clause = match waiting {
        0 => "No decisions waiting".to_string(),
        1 => "1 decision waiting".to_string(),
        n => format!("{n} decisions waiting"),
    };
    let events_clause = match today_events.len() {
        0 => "no events today".to_string(),
        1 => "1 event".to_string(),
        n => format!("{n} events"),
    };
    let next_clause = match next_ev {
        Some(ev) if ev.is_now => format!(" Now: {}.", sanitize_copy(&ev.title)),
        Some(ev) => {
            let start = event_start_hhmm(ev);
            if ev.countdown.is_empty() {
                format!(" Next: {} at {}.", sanitize_copy(&ev.title), start)
            } else {
                format!(
                    " Next: {} at {}, {}.",
                    sanitize_copy(&ev.title),
                    start,
                    sanitize_copy(&ev.countdown)
                )
            }
        }
        None => String::new(),
    };
    let summary_line = format!("{decisions_clause}, {events_clause}.{next_clause}");

    let whoop = &s.data.today.whoop;
    let rec_val = if whoop.recovery_pct > 0 {
        format!("{}%", whoop.recovery_pct)
    } else {
        "--".into()
    };
    let rec_tone = if whoop.recovery_pct > 0 {
        match whoop.recovery_zone.to_ascii_lowercase().as_str() {
            "green" => Some(Tone::Live),
            "yellow" | "red" => Some(Tone::Caution),
            _ => Some(Tone::Neutral),
        }
    } else {
        None
    };
    let hrv_val = if whoop.hrv_ms > 0.0 {
        format!("{:.1} ms", whoop.hrv_ms)
    } else {
        "--".into()
    };
    let rhr_val = if whoop.rhr_bpm > 0 {
        format!("{}", whoop.rhr_bpm)
    } else {
        "--".into()
    };
    let sleep_val = if whoop.sleep_hours > 0.0 {
        format!("{:.1}h", whoop.sleep_hours)
    } else {
        "--".into()
    };

    let mut rec_label_row = row().gap(5.0).items_center();
    if let Some(tone) = rec_tone {
        rec_label_row = rec_label_row.child(kit::dot(tone, p));
    }
    rec_label_row = rec_label_row.child(text("Recovery").font(typo::LABEL).color(p.ink_muted));

    let recovery_cell = col()
        .gap(2.0)
        .child(rec_label_row)
        .child(text(rec_val).font(typo::NUM_L).color(p.ink));

    let stat_div = || el().h(32.0).child(kit::rule_v(p));

    row()
        .key("today-hero")
        .w_full()
        .items_end()
        .justify_between()
        .gap(space::S6)
        .child(
            col()
                .grow(1.0)
                .min_w(0.0)
                .gap(space::S1)
                .child(text(date_headline).font(typo::DISPLAY).color(p.ink))
                .child(
                    text(&summary_line)
                        .font(typo::BODY)
                        .color(p.ink_secondary)
                        .truncate()
                        .help_when_truncated(summary_line.clone()),
                ),
        )
        .child(
            row()
                .items_center()
                .gap(space::S5)
                .child(recovery_cell)
                .child(stat_div())
                .child(kit::stat("HRV", &hrv_val, p))
                .child(stat_div())
                .child(kit::stat("Resting HR", &rhr_val, p))
                .child(stat_div())
                .child(kit::stat("Sleep", &sleep_val, p)),
        )
}

/// Parses an ISO-8601 timestamp (`YYYY-MM-DDTHH:MM:...`) into fractional hours `[0.0, 24.0)`.
fn parse_iso_hour(ts: &str) -> Option<f32> {
    let time_part = ts.split('T').nth(1)?;
    let hh: f32 = time_part.get(0..2)?.parse().ok()?;
    let mm: f32 = time_part.get(3..5)?.parse().ok()?;
    Some((hh + mm / 60.0).clamp(0.0, 24.0))
}

fn format_hhmm(hour: f32) -> String {
    let total_mins = (hour * 60.0).round() as u32 % (24 * 60);
    format!("{:02}:{:02}", total_mins / 60, total_mins % 60)
}

struct PlacedDialEvent<'a> {
    idx: usize,
    ev: &'a ScheduleEvent,
    start_h: f32,
    end_h: f32,
    lane: usize,
}

/// Architectural 24h Day Dial: recessed night halves, Vernier hour ticks, crisp now-needle,
/// and real positioned event bars carrying native `.help(...)` tooltips.
fn day_dial_strip(
    s: &AppState,
    today_events: &[&ScheduleEvent],
    next_ev: Option<&ScheduleEvent>,
    p: &Palette,
) -> El {
    let now_hour = parse_iso_hour(&s.data.today.generated_at).unwrap_or(9.0);
    let now_hhmm = format_hhmm(now_hour);
    let next_id = next_ev.map(|e| e.id.as_str());

    let vb_w = 1400.0_f32;
    let vb_h = 56.0_f32;
    let baseline_y = 44.0_f32;
    let track_top = 8.0_f32;
    let x_for_hour = |h: f32| -> f32 { (h.clamp(0.0, 24.0) / 24.0) * vb_w };

    let mut shape = Shape::new().view_box(vb_w, vb_h);

    // 1. Night half convention (00..06 and 18..24) in recessed_well
    for (h0, h1) in [(0.0_f32, 6.0_f32), (18.0_f32, 24.0_f32)] {
        let x0 = x_for_hour(h0);
        let x1 = x_for_hour(h1);
        let rect = Path::new()
            .move_to([x0, track_top])
            .line_to([x1, track_top])
            .line_to([x1, baseline_y])
            .line_to([x0, baseline_y])
            .close();
        shape = shape.fill_path(&rect, p.recessed_well);
    }

    // 2. Baseline at y = 44
    shape = shape.line(
        [0.0, baseline_y],
        [vb_w, baseline_y],
        1.0,
        LineCap::Butt,
        p.hairline_strong,
    );

    // 3. Hour graduations: 4px every hour in hairline, 8px every 6 hours in hairline_strong
    for h in 0..=24 {
        let x = x_for_hour(h as f32);
        let is_major = h % 6 == 0;
        let tick_len = if is_major { 8.0 } else { 4.0 };
        let tick_col = if is_major {
            p.hairline_strong
        } else {
            p.hairline
        };
        shape = shape.line(
            [x, baseline_y],
            [x, baseline_y + tick_len],
            1.0,
            LineCap::Butt,
            tick_col,
        );
        if is_major && h > 0 && h < 24 {
            shape = shape.line(
                [x, track_top],
                [x, baseline_y],
                1.0,
                LineCap::Butt,
                p.hairline,
            );
        }
    }

    // 4. Crisp current-time needle (1.5px vertical line y=4..48 + radius-3 head in ink)
    let now_x = x_for_hour(now_hour).clamp(4.0, vb_w - 4.0);
    shape = shape
        .line(
            [now_x, 4.0],
            [now_x, 48.0],
            1.5,
            LineCap::Round,
            p.ink,
        )
        .fill_path(&kit::circle_path(now_x, 4.0, 3.0), p.ink);

    // 5. Assign real today events to lanes (lane 1 only on overlap)
    let mut lane0_end = -1.0_f32;
    let mut placed: Vec<PlacedDialEvent<'_>> = Vec::with_capacity(today_events.len());
    for (idx, ev) in today_events.iter().enumerate() {
        let Some(start_h) = parse_iso_hour(&ev.start) else {
            continue;
        };
        let end_h = parse_iso_hour(&ev.end)
            .filter(|&e| e > start_h)
            .unwrap_or((start_h + 0.75).min(24.0));
        let lane = if start_h < lane0_end - 0.05 {
            1
        } else {
            lane0_end = end_h;
            0
        };
        placed.push(PlacedDialEvent {
            idx,
            ev,
            start_h,
            end_h,
            lane,
        });
    }

    // Build pinned event bar elements over the canvas so each carries a native tooltip
    // and clear inline labels when horizontal space allows without collisions.
    let mut dial_stack = col()
        .w_full()
        .h(vb_h)
        .child(canvas(shape).key("solar-day-arc-canvas").w_full().h(vb_h));

    for (pos, item) in placed.iter().enumerate() {
        let start_frac = (item.start_h / 24.0).clamp(0.0, 0.985);
        let dur_frac = ((item.end_h - item.start_h) / 24.0)
            .max(0.012)
            .min(1.0 - start_frac);
        let y = if item.lane == 0 { 12.0 } else { 28.0 };
        let is_next = next_id == Some(item.ev.id.as_str());
        let bar_color = if item.ev.is_now {
            p.emerald
        } else if is_next {
            p.ink
        } else {
            p.steel
        };

        let start_lbl = event_start_hhmm(item.ev);
        let end_lbl = event_end_hhmm(item.ev);
        let clean_title = sanitize_copy(&item.ev.title);
        let tooltip = format!("{start_lbl} - {end_lbl}  {clean_title}");

        // Check horizontal clearance after this bar on the same lane before the next event.
        let next_same_lane_start = placed
            .iter()
            .skip(pos + 1)
            .find(|other| other.lane == item.lane)
            .map(|other| other.start_h)
            .unwrap_or(24.0);
        let clearance_h = (next_same_lane_start - item.end_h).max(0.0);
        let needle_blocks_label = now_hour >= item.end_h - 0.15 && now_hour <= item.end_h + 1.6;
        let show_inline_label =
            item.lane == 0 && clearance_h >= 1.45 && !needle_blocks_label && !clean_title.is_empty();

        let mut overlay = row()
            .key(format!("dial-ev-{}", item.idx))
            .pin(Some(0.0), Some(y), Some(0.0), None)
            .h(14.0)
            .items_center()
            .child(el().w_frac(start_frac).h_full())
            .child(
                el().w_frac(dur_frac)
                    .h(10.0)
                    .radius(3.0)
                    .fill(bar_color)
                    .hover_fill(p.ink)
                    .motion(motion::SNAPPY)
                    .help(tooltip),
            );

        if show_inline_label {
            let max_lbl_w = (clearance_h * 52.0 - 10.0).clamp(64.0, 176.0);
            let est_w = clean_title.chars().count() as f32 * 7.2 + 8.0;
            if est_w <= max_lbl_w {
                overlay = overlay.child(
                    text(&clean_title)
                        .font(typo::LABEL)
                        .color(if item.ev.is_now || is_next {
                            p.ink
                        } else {
                            p.ink_secondary
                        })
                        .pl(6.0),
                );
            }
        }

        dial_stack = dial_stack.child(overlay);
    }

    let next_right = match next_ev {
        Some(ev) if ev.is_now => row()
            .gap(6.0)
            .items_center()
            .child(kit::dot(Tone::Live, p))
            .child(
                text(format!("Now: {}", sanitize_copy(&ev.title)))
                    .font(typo::CAPTION)
                    .color(p.ink)
                    .truncate(),
            ),
        Some(ev) => {
            let start = event_start_hhmm(ev);
            let label = if ev.countdown.is_empty() {
                format!("Next: {} at {}", sanitize_copy(&ev.title), start)
            } else {
                format!(
                    "Next: {} at {} ({})",
                    sanitize_copy(&ev.title),
                    start,
                    sanitize_copy(&ev.countdown)
                )
            };
            row().child(
                text(&label)
                    .font(typo::CAPTION)
                    .color(p.ink_secondary)
                    .truncate()
                    .help_when_truncated(label.clone()),
            )
        }
        None => row().child(
            text("Schedule clear")
                .font(typo::CAPTION)
                .color(p.ink_muted),
        ),
    };

    let events_count_str = match today_events.len() {
        0 => "No scheduled events".to_string(),
        1 => "1 event today".to_string(),
        n => format!("{n} events today"),
    };

    let hour_labels = ["00", "06", "12", "18", "24"];

    col()
        .key("solar-chronometer")
        .w_full()
        .gap(space::S1)
        .child(
            row()
                .w_full()
                .items_center()
                .justify_between()
                .gap(space::S4)
                .child(
                    row()
                        .gap(space::S3)
                        .items_center()
                        .child(kit::overline("Day", p))
                        .child(
                            text(format!("Now {now_hhmm} UTC"))
                                .font(typo::NUM_S)
                                .color(p.ink_secondary),
                        )
                        .child(
                            text(events_count_str)
                                .font(typo::CAPTION)
                                .color(p.ink_muted),
                        ),
                )
                .child(next_right),
        )
        .child(dial_stack)
        .child(
            row()
                .w_full()
                .justify_between()
                .children(hour_labels.into_iter().map(|lbl| {
                    text(lbl).font(typo::NUM_S).color(p.ink_muted)
                })),
        )
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

fn decide_and_projects_column(s: &AppState, p: &Palette) -> El {
    let moves = s.next_moves_effective();
    let gate_cards = s.data.decision_gates();
    let workstreams: Vec<_> = s.data.today.workstreams.iter().take(3).collect();
    let waiting = s.waiting_decision_count();
    let head_meta = if waiting == 0 {
        "All clear".to_string()
    } else if waiting == 1 {
        "1 waiting".to_string()
    } else {
        format!("{waiting} waiting")
    };

    let selected_idx = if moves.is_empty() {
        0
    } else {
        s.selected_move_idx.min(moves.len().saturating_sub(1))
    };

    let mut moves_list = col().w_full().gap(0.0);
    let shown_moves: Vec<_> = moves.into_iter().take(4).collect();
    if shown_moves.is_empty() {
        moves_list = moves_list.child(
            row()
                .py(space::S3)
                .gap(space::S2)
                .items_center()
                .child(kit::ring(1.0, 14.0, Tone::Live, p))
                .child(
                    text("No open decisions waiting.")
                        .font(typo::BODY)
                        .color(p.ink_secondary),
                ),
        );
    } else {
        for (i, mv) in shown_moves.into_iter().enumerate() {
            if i > 0 {
                moves_list = moves_list.child(kit::rule_h(p));
            }
            let is_sel = i == selected_idx;
            let is_decision = mv.kind == "decision";
            let stamped = mv
                .thread_id
                .as_deref()
                .and_then(|tid| s.verdicts.get(tid).copied());
            let gate_age_ratio = mv
                .thread_id
                .as_deref()
                .and_then(|tid| gate_cards.iter().find(|g| g.id == tid))
                .map(|g| g.age_ratio)
                .unwrap_or_else(|| (mv.score / 100.0).clamp(0.15, 1.0));

            let clean_title = sanitize_copy(&mv.title);
            let clean_why = sanitize_copy(&mv.why_now);

            let mut row_box = col()
                .key(format!("next-move-{i}"))
                .w_full()
                .px(space::ROW_X)
                .py(space::ROW_Y)
                .gap(space::S2)
                .radius(radius::ROW)
                .fill(if is_sel {
                    p.selection
                } else {
                    Color::TRANSPARENT
                })
                .hover_fill(p.hover)
                .motion(motion::SNAPPY);

            if is_sel {
                row_box = row_box.child(kit::focus_bar(p));
            }

            let mut header_line = row()
                .w_full()
                .gap(space::S2)
                .items_start()
                .on_press_tx(move |st: &mut AppState, tx: &mut Tx| {
                    st.selected_move_idx = i;
                    tx.animated();
                });

            if is_decision {
                let ring_tone = match stamped {
                    Some(v) => verdict_tone(v),
                    None => Tone::Urgent,
                };
                let ring_frac = if stamped.is_some() {
                    1.0
                } else {
                    gate_age_ratio
                };
                header_line = header_line.child(
                    el().pt(3.0)
                        .child(kit::ring(ring_frac, 14.0, ring_tone, p)),
                );
            }

            let title_style = if is_decision {
                typo::HEADING
            } else {
                typo::BODY_STRONG
            };
            header_line = header_line.child(
                col()
                    .grow(1.0)
                    .min_w(0.0)
                    .gap(2.0)
                    .child(
                        text(&clean_title)
                            .font(title_style)
                            .color(if stamped.is_some() {
                                p.ink_secondary
                            } else {
                                p.ink
                            })
                            .wrap()
                            .max_lines(2)
                            .help_when_truncated(clean_title.clone()),
                    )
                    .child(
                        text(&clean_why)
                            .font(typo::CAPTION)
                            .color(p.ink_secondary)
                            .wrap()
                            .max_lines(2)
                            .help_when_truncated(clean_why.clone()),
                    ),
            );

            row_box = row_box.child(header_line);

            if let Some(tid) = mv.thread_id.clone() {
                if let Some(v) = stamped {
                    let inspect_id = tid.clone();
                    row_box = row_box.child(
                        row()
                            .pl(if is_decision { 22.0 } else { 0.0 })
                            .gap(space::S2)
                            .items_center()
                            .child(
                                row()
                                    .key(format!("today-approve-{i}"))
                                    .child(kit::stamp(verdict_label(v), verdict_tone(v), p)),
                            )
                            .child(
                                kit::button_quiet("Inspect", None, p)
                                    .key(format!("today-inspect-{i}"))
                                    .role("button")
                                    .label(format!("Inspect #{inspect_id}"))
                                    .focusable(true)
                                    .on_press_tx(move |st: &mut AppState, tx: &mut Tx| {
                                        st.focus_thread_in_board(&inspect_id);
                                        tx.animated();
                                    }),
                            ),
                    );
                } else if is_sel {
                    let tid_approve = tid.clone();
                    let tid_revise = tid.clone();
                    let tid_defer = tid.clone();
                    let tid_inspect = tid;
                    row_box = row_box.child(
                        row()
                            .pl(if is_decision { 22.0 } else { 0.0 })
                            .gap(space::S2)
                            .items_center()
                            .child(
                                kit::button_primary("Approve", Some("A"), p)
                                    .key(format!("today-approve-{i}"))
                                    .role("button")
                                    .label(format!("Approve #{tid_approve}"))
                                    .focusable(true)
                                    .focus_ring(2.0, 1.5, p.focus_ring)
                                    .on_press_tx(move |st: &mut AppState, tx: &mut Tx| {
                                        st.submit_verdict(&tid_approve, DecisionVerdict::Approved);
                                        tx.animated();
                                    }),
                            )
                            .child(
                                kit::button_quiet("Revise", Some("R"), p)
                                    .key(format!("today-revise-{i}"))
                                    .role("button")
                                    .label(format!("Revise #{tid_revise}"))
                                    .focusable(true)
                                    .on_press_tx(move |st: &mut AppState, tx: &mut Tx| {
                                        st.submit_verdict(&tid_revise, DecisionVerdict::Revised);
                                        tx.animated();
                                    }),
                            )
                            .child(
                                kit::button_quiet("Defer", Some("D"), p)
                                    .key(format!("today-defer-{i}"))
                                    .role("button")
                                    .label(format!("Defer #{tid_defer}"))
                                    .focusable(true)
                                    .on_press_tx(move |st: &mut AppState, tx: &mut Tx| {
                                        st.submit_verdict(&tid_defer, DecisionVerdict::Deferred);
                                        tx.animated();
                                    }),
                            )
                            .child(
                                kit::button_quiet("Inspect", Some("\u{21B5}"), p)
                                    .key(format!("today-inspect-{i}"))
                                    .role("button")
                                    .label(format!("Inspect #{tid_inspect}"))
                                    .focusable(true)
                                    .on_press_tx(move |st: &mut AppState, tx: &mut Tx| {
                                        st.focus_thread_in_board(&tid_inspect);
                                        tx.animated();
                                    }),
                            ),
                    );
                }
            }

            moves_list = moves_list.child(row_box);
        }
    }

    let mut projects_list = col().w_full().gap(0.0);
    for (i, ws) in workstreams.iter().enumerate() {
        if i > 0 {
            projects_list = projects_list.child(kit::rule_h(p));
        }
        let clean_next = sanitize_copy(&ws.next_move);
        let clean_state = sanitize_copy(&ws.state);
        projects_list = projects_list.child(
            col()
                .key(format!("ws-{i}"))
                .w_full()
                .py(space::S2)
                .gap(2.0)
                .child(
                    row()
                        .w_full()
                        .items_center()
                        .justify_between()
                        .gap(space::S3)
                        .child(text(&ws.name).font(typo::BODY_STRONG).color(p.ink))
                        .child(
                            kit::tag(&clean_state, Tone::Neutral, p)
                                .shrink()
                                .truncate()
                                .help_when_truncated(clean_state.clone()),
                        ),
                )
                .child(
                    text(&clean_next)
                        .font(typo::CAPTION)
                        .color(p.ink_muted)
                        .truncate()
                        .help_when_truncated(clean_next.clone()),
                ),
        );
    }

    let mut content = col().w_full().gap(0.0).child(moves_list);
    if !workstreams.is_empty() {
        content = content
            .child(
                row()
                    .w_full()
                    .pt(space::S4)
                    .pb(space::S2)
                    .items_center()
                    .justify_between()
                    .child(text("Projects").font(typo::LABEL).color(p.ink_muted))
                    .child(
                        text(format!("{} active", workstreams.len()))
                            .font(typo::CAPTION)
                            .color(p.ink_muted),
                    ),
            )
            .child(kit::rule_h(p))
            .child(projects_list);
    }

    kit::pane()
        .key("today-next-moves")
        .grow(47.0)
        .h_full()
        .gap(0.0)
        .child(kit::pane_head("Decide", &head_meta, p))
        .child(kit::rule_h(p))
        .child(
            col()
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .scroll(ScrollSpec::default())
                .scroll_edge_fade(16.0)
                .child(content),
        )
}

fn meetings_and_commitments_column(s: &AppState, p: &Palette) -> El {
    let (briefing, _) = s.intel_briefing_effective();
    let preps: Vec<_> = briefing.meeting_preps.iter().take(2).collect();
    let commitments: Vec<_> = briefing.commitments.iter().take(4).collect();
    let open_count = briefing
        .commitments
        .iter()
        .filter(|c| {
            !matches!(
                s.commitment_ops.get(&c.id),
                Some(CommitmentOp::Resolved | CommitmentOp::Snoozed)
            ) && !c.status.eq_ignore_ascii_case("resolved")
                && !c.status.eq_ignore_ascii_case("snoozed")
        })
        .count();

    let head_meta = if open_count == 0 {
        "All clear".to_string()
    } else if open_count == 1 {
        "1 open".to_string()
    } else {
        format!("{open_count} open")
    };

    let mut prep_list = col().w_full().gap(0.0);
    if preps.is_empty() {
        prep_list = prep_list.child(
            text("No meetings needing prep.")
                .font(typo::CAPTION)
                .color(p.ink_muted)
                .py(space::S3),
        );
    } else {
        for (i, mp) in preps.into_iter().enumerate() {
            if i > 0 {
                prep_list = prep_list.child(kit::rule_h(p));
            }
            let time_lbl = if mp.time_label.is_empty() {
                "Today".to_string()
            } else {
                sanitize_copy(&mp.time_label)
            };
            let attendees_line = if mp.attendees.is_empty() {
                sanitize_copy(&mp.last_touch)
            } else if mp.last_touch.is_empty() {
                mp.attendees.join(", ")
            } else {
                format!("{} \u{00B7} {}", mp.attendees.join(", "), sanitize_copy(&mp.last_touch))
            };
            let talking = mp
                .talking_points
                .first()
                .map(|t| sanitize_copy(t))
                .unwrap_or_else(|| "Review agenda and open loops.".to_string());
            let clean_title = sanitize_copy(&mp.title);

            let mut title_row = row()
                .w_full()
                .items_center()
                .justify_between()
                .gap(space::S2)
                .child(
                    text(&clean_title)
                        .font(typo::BODY_STRONG)
                        .color(p.ink)
                        .truncate()
                        .help_when_truncated(clean_title.clone()),
                );
            if mp.open_loops_count > 0 {
                let loops_txt = if mp.open_loops_count == 1 {
                    "1 loop".to_string()
                } else {
                    format!("{} loops", mp.open_loops_count)
                };
                title_row = title_row.child(kit::tag(&loops_txt, Tone::Caution, p));
            }

            let mut details_col = col()
                .grow(1.0)
                .min_w(0.0)
                .gap(2.0)
                .child(title_row);
            if !attendees_line.is_empty() {
                details_col = details_col.child(
                    text(&attendees_line)
                        .font(typo::CAPTION)
                        .color(p.ink_muted)
                        .truncate()
                        .help_when_truncated(attendees_line.clone()),
                );
            }
            details_col = details_col.child(
                text(&talking)
                    .font(typo::BODY)
                    .color(p.ink_secondary)
                    .wrap()
                    .max_lines(2)
                    .help_when_truncated(talking.clone()),
            );

            prep_list = prep_list.child(
                row()
                    .key(format!("meeting-prep-{i}"))
                    .w_full()
                    .py(space::ROW_Y)
                    .gap(space::S3)
                    .items_start()
                    .child(text(time_lbl).font(typo::NUM).color(p.ink).w(48.0))
                    .child(details_col),
            );
        }
    }

    let mut commit_list = col().w_full().gap(0.0);
    for (i, cm) in commitments.into_iter().enumerate() {
        if i > 0 {
            commit_list = commit_list.child(kit::rule_h(p));
        }
        let local_op = s.commitment_ops.get(&cm.id).copied().or_else(|| {
            if cm.status.eq_ignore_ascii_case("resolved") {
                Some(CommitmentOp::Resolved)
            } else if cm.status.eq_ignore_ascii_case("snoozed") {
                Some(CommitmentOp::Snoozed)
            } else {
                None
            }
        });
        let is_resolved = matches!(local_op, Some(CommitmentOp::Resolved));
        let is_snoozed = matches!(local_op, Some(CommitmentOp::Snoozed));
        let is_overdue = local_op.is_none()
            && (cm.age_hours >= 24.0
                || matches!(
                    cm.urgency.to_ascii_lowercase().as_str(),
                    "high" | "critical" | "urgent"
                ));

        let age_str = if cm.age_hours >= 48.0 {
            format!("{:.0}d", cm.age_hours / 24.0)
        } else if cm.age_hours >= 1.0 {
            format!("{:.0}h", cm.age_hours)
        } else {
            "now".into()
        };
        let meta = format!(
            "{} \u{00B7} {} \u{00B7} {}",
            if cm.person.is_empty() {
                "Owner"
            } else {
                cm.person.as_str()
            },
            if cm.channel.is_empty() {
                "local"
            } else {
                cm.channel.as_str()
            },
            age_str
        );
        let clean_title = sanitize_copy(&cm.title);
        let id_resolve = cm.id.clone();
        let id_snooze = cm.id.clone();

        let (ring_frac, ring_tone) = if is_resolved {
            (1.0, Tone::Live)
        } else if is_snoozed {
            (0.5, Tone::Caution)
        } else {
            (0.0, Tone::Neutral)
        };

        let mut meta_row = row().gap(5.0).items_center();
        if is_overdue {
            meta_row = meta_row.child(kit::dot(Tone::Caution, p));
        }
        meta_row = meta_row.child(
            text(&meta)
                .font(typo::CAPTION)
                .color(p.ink_muted)
                .truncate()
                .help_when_truncated(meta.clone()),
        );

        let right_ctrl = if let Some(op) = local_op {
            let (lbl, tone) = match op {
                CommitmentOp::Resolved => ("Resolved", Tone::Live),
                CommitmentOp::Snoozed => ("Snoozed", Tone::Caution),
            };
            row().child(kit::stamp(lbl, tone, p))
        } else {
            row()
                .gap(space::S1)
                .items_center()
                .child(
                    kit::button_quiet("Resolve", None, p)
                        .key(format!("commit-resolve-{i}"))
                        .role("button")
                        .label(format!("Resolve {}", clean_title))
                        .focusable(true)
                        .on_press_tx(move |st: &mut AppState, tx: &mut Tx| {
                            st.submit_commitment_op(&id_resolve, CommitmentOp::Resolved);
                            tx.animated();
                        }),
                )
                .child(
                    kit::button_quiet("Snooze", None, p)
                        .key(format!("commit-snooze-{i}"))
                        .role("button")
                        .label(format!("Snooze {}", clean_title))
                        .focusable(true)
                        .on_press_tx(move |st: &mut AppState, tx: &mut Tx| {
                            st.submit_commitment_op(&id_snooze, CommitmentOp::Snoozed);
                            tx.animated();
                        }),
                )
        };

        commit_list = commit_list.child(
            row()
                .key(format!("commitment-{i}"))
                .w_full()
                .py(space::ROW_Y)
                .gap(space::S3)
                .items_center()
                .justify_between()
                .child(
                    row()
                        .grow(1.0)
                        .min_w(0.0)
                        .gap(space::S3)
                        .items_start()
                        .child(el().pt(2.0).child(kit::ring(ring_frac, 16.0, ring_tone, p)))
                        .child(
                            col()
                                .grow(1.0)
                                .min_w(0.0)
                                .gap(2.0)
                                .child(
                                    text(&clean_title)
                                        .font(typo::BODY)
                                        .color(if is_resolved || is_snoozed {
                                            p.ink_muted
                                        } else {
                                            p.ink
                                        })
                                        .wrap()
                                        .max_lines(2)
                                        .help_when_truncated(clean_title.clone()),
                                )
                                .child(meta_row),
                        ),
                )
                .child(right_ctrl),
        );
    }

    let mut content = col()
        .w_full()
        .gap(0.0)
        .child(prep_list)
        .child(
            row()
                .w_full()
                .pt(space::S4)
                .pb(space::S2)
                .items_center()
                .justify_between()
                .child(text("Commitments").font(typo::LABEL).color(p.ink_muted))
                .child(text(head_meta.as_str()).font(typo::CAPTION).color(p.ink_muted)),
        )
        .child(kit::rule_h(p))
        .child(commit_list);

    if let Some(sig) = briefing.cross_signals.first() {
        let insight = format!(
            "{}. {}",
            sanitize_copy(&sig.title),
            sanitize_copy(&sig.detail)
        );
        content = content.child(kit::rule_h(p)).child(
            row()
                .key("today-cross-signal")
                .w_full()
                .min_w(0.0)
                .pt(space::S3)
                .gap(space::S2)
                .items_start()
                .child(el().pt(6.0).child(kit::dot(Tone::Steel, p)))
                .child(
                    text(&insight)
                        .font(typo::BODY)
                        .color(p.ink_secondary)
                        .grow(1.0)
                        .min_w(0.0)
                        .wrap()
                        .max_lines(2)
                        .help_when_truncated(insight.clone()),
                ),
        );
    }

    kit::pane()
        .key("today-proactive-intel")
        .grow(47.0)
        .h_full()
        .gap(0.0)
        .child(kit::pane_head("Meetings and commitments", &head_meta, p))
        .child(kit::rule_h(p))
        .child(
            col()
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .scroll(ScrollSpec::default())
                .scroll_edge_fade(16.0)
                .child(content),
        )
}

fn schedule_and_loops_column(
    s: &AppState,
    next_ev: Option<&ScheduleEvent>,
    p: &Palette,
) -> El {
    let sched: Vec<_> = s.data.today.schedule.iter().take(5).collect();
    let next_id = next_ev.map(|e| e.id.as_str());

    // Surface open loops ahead of already-done items while preserving original order within each group.
    let mut actions: Vec<_> = s.data.today.actions.iter().filter(|a| !a.done).collect();
    if actions.len() < 4 {
        let remaining = 4 - actions.len();
        actions.extend(s.data.today.actions.iter().filter(|a| a.done).take(remaining));
    } else {
        actions.truncate(4);
    }
    let open_loops = s.data.today.actions.iter().filter(|a| !a.done).count();

    let sched_meta = match s.data.today.schedule.len() {
        0 => "Clear".to_string(),
        1 => "1 event".to_string(),
        n => format!("{n} events"),
    };

    let mut sched_list = col().w_full().gap(0.0);
    if sched.is_empty() {
        sched_list = sched_list.child(
            text("No events on the calendar.")
                .font(typo::CAPTION)
                .color(p.ink_muted)
                .py(space::S3),
        );
    } else {
        for (i, ev) in sched.into_iter().enumerate() {
            if i > 0 {
                sched_list = sched_list.child(kit::rule_h(p));
            }
            let time_hhmm = event_start_hhmm(ev);
            let is_next = next_id == Some(ev.id.as_str());
            let clean_title = sanitize_copy(&ev.title);
            let time_col = if ev.is_now {
                p.emerald
            } else if is_next {
                p.ink
            } else {
                p.ink_secondary
            };

            let right_meta = if ev.is_now {
                row()
                    .gap(5.0)
                    .items_center()
                    .child(kit::dot(Tone::Live, p))
                    .child(text("Now").font(typo::CAPTION).color(p.emerald))
            } else {
                let cd = if ev.countdown.is_empty() {
                    "Today".to_string()
                } else {
                    sanitize_copy(&ev.countdown)
                };
                row().child(text(cd).font(typo::CAPTION).color(p.ink_muted))
            };

            sched_list = sched_list.child(
                row()
                    .key(format!("sched-{i}"))
                    .w_full()
                    .h(42.0)
                    .gap(space::S3)
                    .items_center()
                    .justify_between()
                    .child(text(time_hhmm).font(typo::NUM).color(time_col).w(52.0))
                    .child(
                        text(&clean_title)
                            .font(typo::BODY)
                            .color(if ev.is_now || is_next {
                                p.ink
                            } else {
                                p.ink_secondary
                            })
                            .grow(1.0)
                            .min_w(0.0)
                            .truncate()
                            .help_when_truncated(clean_title.clone()),
                    )
                    .child(right_meta),
            );
        }
    }

    let loops_meta = if open_loops == 0 {
        "All closed".to_string()
    } else if open_loops == 1 {
        "1 open".to_string()
    } else {
        format!("{open_loops} open")
    };

    let mut loops_list = col().w_full().gap(0.0);
    for (i, act) in actions.into_iter().enumerate() {
        if i > 0 {
            loops_list = loops_list.child(kit::rule_h(p));
        }
        let clean_title = sanitize_copy(&act.title);
        let (ring_frac, ring_tone) = if act.done {
            (1.0, Tone::Live)
        } else {
            (0.0, Tone::Neutral)
        };
        let mut txt_col = col()
            .grow(1.0)
            .min_w(0.0)
            .gap(1.0)
            .child(
                text(&clean_title)
                    .font(typo::BODY)
                    .color(if act.done { p.ink_muted } else { p.ink })
                    .truncate()
                    .help_when_truncated(clean_title.clone()),
            );
        if !act.tag.is_empty() {
            txt_col = txt_col.child(text(&act.tag).font(typo::CAPTION).color(p.ink_muted));
        }

        loops_list = loops_list.child(
            row()
                .key(format!("act-{i}"))
                .w_full()
                .py(space::S2)
                .gap(space::S3)
                .items_center()
                .child(kit::ring(ring_frac, 16.0, ring_tone, p))
                .child(txt_col),
        );
    }

    let content = col()
        .w_full()
        .gap(0.0)
        .child(sched_list)
        .child(
            row()
                .w_full()
                .pt(space::S4)
                .pb(space::S2)
                .items_center()
                .justify_between()
                .child(text("Loops").font(typo::LABEL).color(p.ink_muted))
                .child(text(loops_meta).font(typo::CAPTION).color(p.ink_muted)),
        )
        .child(kit::rule_h(p))
        .child(loops_list);

    kit::pane()
        .key("today-schedule")
        .grow(38.0)
        .h_full()
        .gap(0.0)
        .child(kit::pane_head("Schedule", &sched_meta, p))
        .child(kit::rule_h(p))
        .child(
            col()
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .scroll(ScrollSpec::default())
                .scroll_edge_fade(16.0)
                .child(content),
        )
}

fn pipeline_footer(s: &AppState, p: &Palette) -> El {
    let summary = &s.data.today.summary;
    let total_p = summary.total_pipelines.max(1);
    let active_p = summary.active_pipelines.min(total_p);
    let all_live = active_p >= total_p;

    let pipe_sentence = if all_live {
        format!("{total_p} pipelines live")
    } else {
        format!("{active_p} of {total_p} pipelines live")
    };

    let sync_label = match &s.connection {
        ConnectionState::Live {
            synced_secs_ago: 0, ..
        } => "Synced now".to_string(),
        ConnectionState::Live {
            synced_secs_ago, ..
        } => format!("Synced {synced_secs_ago}s ago"),
        ConnectionState::Degraded { hits, total, .. } => format!("Degraded {hits} of {total}"),
        ConnectionState::Offline { snapshot_date } => format!("Snapshot {snapshot_date}"),
    };

    let right_summary = format!(
        "Vault: {} pages \u{00B7} Priority inbox: {} \u{00B7} {}",
        format_k(summary.docs_total),
        s.data.today.inbox_counts.priority,
        sync_label
    );

    col()
        .key("pipeline-matrix")
        .w_full()
        .gap(space::S2)
        .child(kit::rule_h(p))
        .child(
            row()
                .w_full()
                .h(24.0)
                .items_center()
                .justify_between()
                .gap(space::S4)
                .child(
                    row()
                        .gap(space::S2)
                        .items_center()
                        .child(kit::dot(
                            if all_live { Tone::Live } else { Tone::Caution },
                            p,
                        ))
                        .child(text(pipe_sentence).font(typo::CAPTION).color(p.ink_secondary)),
                )
                .child(
                    text(right_summary)
                        .font(typo::CAPTION)
                        .color(p.ink_muted)
                        .truncate(),
                ),
        )
}
