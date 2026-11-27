//! View 4: Mind (Taste Calibration Radar + Domain Ledger + Gardeners + Codex + People Cadence).
//! Unboxed hairline geometry under the 90/8/2 restraint law and 7-size/3-weight type scale.

use std::f32::consts::PI;

use rune::{El, LineCap, Path, Shape, canvas, col, el, row, text};

use crate::data::{PersonRadar, TasteDomain};
use crate::state::AppState;
use crate::theme::{Palette, Tone, kit, space, typo};

const RADAR_WRAP_W: f32 = 440.0;
const RADAR_WRAP_H: f32 = 360.0;
const RADAR_CANVAS_SIZE: f32 = 320.0;
const RADAR_CANVAS_X: f32 = 60.0;
const RADAR_CANVAS_Y: f32 = 20.0;
const RADAR_CENTER: f32 = 160.0;
const RADAR_RADIUS: f32 = 120.0;

const CADENCE_MAX_MINUTES: f32 = 524_160.0;
const CADENCE_TICKS: [(&str, f32); 7] = [
    ("now", 0.0),
    ("1h", 60.0),
    ("1d", 1_440.0),
    ("1w", 10_080.0),
    ("1mo", 43_200.0),
    ("1q", 129_600.0),
    ("1y", CADENCE_MAX_MINUTES),
];

pub fn view(s: &AppState, p: &Palette) -> El {
    let tstats = &s.data.taste.stats;
    let gstats = &s.data.gardeners.stats;
    let domains: Vec<&TasteDomain> = s.data.taste.domains.iter().take(8).collect();
    let lowest_idx = domains
        .iter()
        .enumerate()
        .min_by_key(|(_, d)| d.pct)
        .map(|(i, _)| i);

    let masthead = row()
        .key("taste-calibration-hero")
        .w_full()
        .h(72.0)
        .items_center()
        .justify_between()
        .gap(space::S6)
        .child(
            col()
                .grow(1.0)
                .min_w(0.0)
                .gap(space::S1)
                .child(
                    text(format!("Taste is {}% calibrated", tstats.calibration_pct))
                        .font(typo::TITLE)
                        .color(p.ink),
                )
                .child(
                    text(format!(
                        "{} of {} answered, {} day streak, {} vault docs, {} remaining.",
                        tstats.answered_count,
                        tstats.total_questions,
                        tstats.streak_count,
                        tstats.vault_docs_count,
                        tstats.remaining_count,
                    ))
                    .font(typo::CAPTION)
                    .color(p.ink_secondary)
                    .truncate(),
                ),
        )
        .child(
            row()
                .h(40.0)
                .items_center()
                .gap(space::S5)
                .child(kit::stat(
                    "Frameworks",
                    &gstats.total_frameworks.to_string(),
                    p,
                ))
                .child(kit::rule_v(p))
                .child(kit::stat(
                    "Principles",
                    &gstats.total_principles.to_string(),
                    p,
                ))
                .child(kit::rule_v(p))
                .child(kit::stat(
                    "Policies",
                    &gstats.total_policies.to_string(),
                    p,
                )),
        );

    let row_a = row()
        .w_full()
        .h(396.0)
        .py(space::S4)
        .gap(space::S4)
        .child(taste_radar_pane(
            &domains,
            lowest_idx,
            tstats.calibration_pct,
            p,
        ))
        .child(kit::rule_v(p))
        .child(domain_ledger_pane(&domains, lowest_idx, p))
        .child(kit::rule_v(p))
        .child(gardeners_pane(s, p));

    let row_b = row()
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .pt(space::S4)
        .gap(space::S4)
        .child(codex_pane(s, p))
        .child(kit::rule_v(p))
        .child(people_pane(s, p));

    col()
        .key("mind-view")
        .w_full()
        .h_full()
        .child(masthead)
        .child(kit::rule_h(p))
        .child(row_a)
        .child(kit::rule_h(p))
        .child(row_b)
}

fn taste_radar_pane(
    domains: &[&TasteDomain],
    lowest_idx: Option<usize>,
    calibration_pct: u32,
    p: &Palette,
) -> El {
    let axes = domains.len().max(3);
    let angle_for = |i: usize| -PI * 0.5 + (i as f32) * (2.0 * PI / axes as f32);

    let mut shape = Shape::new().view_box(RADAR_CANVAS_SIZE, RADAR_CANVAS_SIZE);

    for (ring_i, frac) in [0.25_f32, 0.50, 0.75, 1.00].into_iter().enumerate() {
        let r = RADAR_RADIUS * frac;
        let pts: Vec<[f32; 2]> = (0..axes)
            .map(|i| {
                let (s, c) = angle_for(i).sin_cos();
                [RADAR_CENTER + r * c, RADAR_CENTER + r * s]
            })
            .collect();
        let stroke = if ring_i == 3 {
            p.hairline_strong
        } else {
            p.hairline
        };
        shape = shape.stroke_with(pts, true, 1.0, LineCap::Butt, stroke);
    }

    for i in 0..axes {
        let (s, c) = angle_for(i).sin_cos();
        let outer = [
            RADAR_CENTER + RADAR_RADIUS * c,
            RADAR_CENTER + RADAR_RADIUS * s,
        ];
        shape = shape.line(
            [RADAR_CENTER, RADAR_CENTER],
            outer,
            1.0,
            LineCap::Butt,
            p.hairline,
        );
    }

    if domains.len() >= 3 {
        let data_pts: Vec<[f32; 2]> = domains
            .iter()
            .enumerate()
            .map(|(i, dom)| {
                let frac = (dom.pct as f32 / 100.0).clamp(0.0, 1.0);
                let r = RADAR_RADIUS * frac;
                let (s, c) = angle_for(i).sin_cos();
                [RADAR_CENTER + r * c, RADAR_CENTER + r * s]
            })
            .collect();

        let mut poly = Path::new().move_to(data_pts[0]);
        for &pt in &data_pts[1..] {
            poly = poly.line_to(pt);
        }
        poly = poly.close();

        shape = shape
            .fill_path(&poly, p.steel.alpha(0.16))
            .stroke_with(data_pts.clone(), true, 1.5, LineCap::Round, p.ink);

        for (i, &[vx, vy]) in data_pts.iter().enumerate() {
            shape = shape.fill_path(&kit::circle_path(vx, vy, 2.5), p.ink);
            if lowest_idx == Some(i) {
                shape = shape.stroke_path(
                    &kit::circle_path(vx, vy, 5.0),
                    1.5,
                    LineCap::Round,
                    p.amber,
                );
            }
        }
    }

    let mut wrapper = el()
        .key("taste-radar")
        .size(RADAR_WRAP_W, RADAR_WRAP_H)
        .child(
            canvas(shape)
                .size(RADAR_CANVAS_SIZE, RADAR_CANVAS_SIZE)
                .pin(Some(RADAR_CANVAS_X), Some(RADAR_CANVAS_Y), None, None),
        )
        .child(
            col()
                .w(120.0)
                .items_center()
                .gap(2.0)
                .pin(Some(160.0), Some(154.0), None, None)
                .child(
                    text(format!("{calibration_pct}%"))
                        .font(typo::NUM_XL)
                        .color(p.ink),
                )
                .child(text("calibrated").font(typo::LABEL).color(p.ink_secondary)),
        );

    let wrap_cx = RADAR_CANVAS_X + RADAR_CENTER;
    let wrap_cy = RADAR_CANVAS_Y + RADAR_CENTER;
    let label_r = RADAR_RADIUS * 1.18;

    for (i, dom) in domains.iter().enumerate() {
        let theta = angle_for(i);
        let (sin_t, cos_t) = theta.sin_cos();
        let ax = wrap_cx + label_r * cos_t;
        let ay = wrap_cy + label_r * sin_t;
        let short = short_domain_label(&dom.id, &dom.label);

        let (box_w, pin_x, pin_y, align_right, align_center) = if cos_t.abs() < 0.15 {
            let bw = 120.0;
            let py = if sin_t < 0.0 {
                (ay - 16.0).max(4.0)
            } else {
                (ay + 2.0).min(RADAR_WRAP_H - 18.0)
            };
            (bw, (ax - bw * 0.5).clamp(4.0, RADAR_WRAP_W - bw - 4.0), py, false, true)
        } else if cos_t > 0.0 {
            let px = (ax - 4.0).clamp(4.0, RADAR_WRAP_W - 88.0);
            let bw = (RADAR_WRAP_W - px - 2.0).max(76.0);
            (bw, px, (ay - 7.0).clamp(4.0, RADAR_WRAP_H - 18.0), false, false)
        } else {
            let right_edge = (ax + 4.0).clamp(80.0, RADAR_WRAP_W - 4.0);
            let bw = (right_edge - 4.0).min(114.0);
            let px = (right_edge - bw).max(2.0);
            (bw, px, (ay - 7.0).clamp(4.0, RADAR_WRAP_H - 18.0), true, false)
        };

        let mut lbl_row = row()
            .w(box_w)
            .pin(Some(pin_x), Some(pin_y), None, None)
            .items_center();
        if align_center {
            lbl_row = lbl_row.justify_center();
        } else if align_right {
            lbl_row = lbl_row.justify_end();
        }
        lbl_row = lbl_row.child(
            text(short)
                .font(typo::LABEL)
                .color(p.ink_secondary)
                .truncate()
                .help_when_truncated(dom.label.as_str()),
        );
        wrapper = wrapper.child(lbl_row);
    }

    kit::pane()
        .w(RADAR_WRAP_W)
        .h_full()
        .items_center()
        .justify_center()
        .child(wrapper)
}

fn domain_ledger_pane(domains: &[&TasteDomain], lowest_idx: Option<usize>, p: &Palette) -> El {
    let mut list = col().w_full().grow(1.0).min_h(0.0);
    for (i, dom) in domains.iter().enumerate() {
        if i > 0 {
            list = list.child(kit::rule_h(p));
        }
        let is_lowest = lowest_idx == Some(i);
        let trait_text = dom
            .signature_traits
            .first()
            .map(|t| t.replace('-', " "))
            .unwrap_or_else(|| "calibrated".to_string());

        let mut title_row = row().w_full().items_center().gap(6.0);
        if is_lowest {
            title_row = title_row.child(kit::dot(Tone::Caution, p));
        }
        title_row = title_row.child(
            text(&dom.label)
                .font(typo::BODY)
                .color(p.ink)
                .grow(1.0)
                .min_w(0.0)
                .truncate()
                .help_when_truncated(dom.label.as_str()),
        );

        let entry = row()
            .key(format!("tdom-{i}"))
            .w_full()
            .h(40.0)
            .items_center()
            .justify_between()
            .gap(space::S3)
            .child(
                col()
                    .grow(1.0)
                    .min_w(0.0)
                    .gap(1.0)
                    .child(title_row)
                    .child(
                        text(trait_text)
                            .font(typo::CAPTION)
                            .color(p.ink_muted)
                            .truncate(),
                    ),
            )
            .child(
                row()
                    .items_center()
                    .gap(space::S3)
                    .child(
                        text(format!("{}/{}", dom.answered, dom.total))
                            .font(typo::NUM)
                            .color(p.ink_secondary),
                    )
                    .child(el().w(96.0).child(kit::meter(
                        dom.pct as f32 / 100.0,
                        Tone::Steel,
                        p,
                    ))),
            );

        list = list.child(entry);
    }

    kit::pane()
        .key("taste-domains")
        .w(380.0)
        .h_full()
        .child(kit::pane_head(
            "Domains",
            &format!("{} domains", domains.len()),
            p,
        ))
        .child(kit::rule_h(p))
        .child(list)
}

fn gardeners_pane(s: &AppState, p: &Palette) -> El {
    let gstats = &s.data.gardeners.stats;
    let gardeners = &s.data.gardeners.gardeners;
    let engine = gardeners
        .iter()
        .find_map(|g| {
            let trimmed = g.last_engine.trim();
            (!trimmed.is_empty()).then_some(trimmed)
        })
        .unwrap_or("");
    let meta = if engine.is_empty() {
        format!("{} total, {} runs", gardeners.len(), gstats.runs_total)
    } else {
        format!("{} on {}, {} runs", gardeners.len(), engine, gstats.runs_total)
    };

    let mut list = col().w_full().grow(1.0).min_h(0.0);
    for (i, g) in gardeners.iter().take(5).enumerate() {
        if i > 0 {
            list = list.child(kit::rule_h(p));
        }
        let running = g.status == "running";
        let mut name_row = row().grow(1.0).min_w(0.0).items_center().gap(6.0);
        if running {
            name_row = name_row.child(kit::dot(Tone::Live, p));
        }
        name_row = name_row.child(
            text(&g.name)
                .font(typo::BODY_STRONG)
                .color(p.ink)
                .grow(1.0)
                .min_w(0.0)
                .truncate()
                .help_when_truncated(g.name.as_str()),
        );

        let item = col()
            .key(format!("gardener-{i}"))
            .w_full()
            .py(5.0)
            .gap(2.0)
            .child(
                row()
                    .w_full()
                    .items_center()
                    .justify_between()
                    .gap(space::S2)
                    .child(name_row)
                    .child(
                        text(format!("{} runs, {} items", g.runs_count, g.items_cultivated))
                            .font(typo::CAPTION)
                            .color(p.ink_muted),
                    ),
            )
            .child(
                text(&g.last_summary)
                    .font(typo::CAPTION)
                    .color(p.ink_secondary)
                    .wrap()
                    .max_lines(2)
                    .help_when_truncated(g.last_summary.as_str()),
            );
        list = list.child(item);
    }

    kit::pane()
        .key("taste-gardeners")
        .grow(1.0)
        .h_full()
        .child(kit::pane_head("Gardeners", &meta, p))
        .child(kit::rule_h(p))
        .child(list)
}

fn codex_pane(s: &AppState, p: &Palette) -> El {
    let cs = &s.data.codex.stats;
    let meta = format!("{} open decisions, {} pinned", cs.decisions_open, cs.pinned);

    let summary = row()
        .w_full()
        .py(space::S2)
        .items_end()
        .justify_between()
        .gap(space::S3)
        .child(
            row()
                .items_end()
                .gap(space::S2)
                .child(text(cs.total.to_string()).font(typo::NUM_L).color(p.ink))
                .child(
                    text("entries")
                        .font(typo::LABEL)
                        .color(p.ink_muted)
                        .pb(3.0),
                ),
        )
        .child(
            text(format!(
                "{} philosophy, {} ideas, {} interests, {} bookmarks",
                cs.philosophies, cs.ideas, cs.interests, cs.bookmarks
            ))
            .font(typo::CAPTION)
            .color(p.ink_secondary)
            .truncate(),
        );

    let mut list = col().w_full().grow(1.0).min_h(0.0);
    for (i, item) in s.data.codex.items.iter().take(5).enumerate() {
        if i > 0 {
            list = list.child(kit::rule_h(p));
        }
        let entry = row()
            .key(format!("codex-item-{i}"))
            .w_full()
            .py(9.0)
            .items_center()
            .justify_between()
            .gap(space::S3)
            .child(
                text(&item.title)
                    .font(typo::BODY_STRONG)
                    .color(p.ink)
                    .grow(1.0)
                    .min_w(0.0)
                    .truncate()
                    .help_when_truncated(item.title.as_str()),
            )
            .child(
                row()
                    .items_center()
                    .gap(space::S4)
                    .child(text(&item.domain).font(typo::CAPTION).color(p.ink_muted))
                    .child(
                        text(format!("L{}", item.leverage_score))
                            .font(typo::NUM)
                            .color(p.ink),
                    ),
            );
        list = list.child(entry);
    }

    kit::pane()
        .key("codex-overview")
        .w(640.0)
        .h_full()
        .child(kit::pane_head("Codex", &meta, p))
        .child(summary)
        .child(kit::rule_h(p))
        .child(list)
}

fn people_pane(s: &AppState, p: &Palette) -> El {
    let all_people = &s.data.today.people_radar;
    let visible: Vec<&PersonRadar> = all_people.iter().take(6).collect();
    let left_col: Vec<(usize, &PersonRadar)> = visible
        .iter()
        .take(3)
        .enumerate()
        .map(|(i, pr)| (i, *pr))
        .collect();
    let right_col: Vec<(usize, &PersonRadar)> = visible
        .iter()
        .skip(3)
        .take(3)
        .enumerate()
        .map(|(i, pr)| (i + 3, *pr))
        .collect();

    kit::pane()
        .key("people-radar")
        .grow(1.0)
        .h_full()
        .child(kit::pane_head(
            "People",
            &format!("{} in vault", s.data.today.summary.people_total),
            p,
        ))
        .child(cadence_ribbon(all_people, p))
        .child(kit::rule_h(p))
        .child(
            row()
                .w_full()
                .grow(1.0)
                .min_h(0.0)
                .gap(space::S4)
                .child(people_ledger_col(&left_col, p))
                .child(kit::rule_v(p))
                .child(people_ledger_col(&right_col, p)),
        )
}

fn cadence_ribbon(people: &[PersonRadar], p: &Palette) -> El {
    let vb_w = 720.0_f32;
    let vb_h = 64.0_f32;
    let pad_x = 14.0_f32;
    let draw_w = vb_w - pad_x * 2.0;
    let base_y = 44.0_f32;

    let max_count = people
        .iter()
        .map(|pr| pr.message_count)
        .max()
        .unwrap_or(1)
        .max(1) as f32;

    let mut shape = Shape::new().view_box(vb_w, vb_h).line(
        [pad_x, base_y],
        [pad_x + draw_w, base_y],
        1.0,
        LineCap::Butt,
        p.hairline_strong,
    );

    for &(_, mins) in &CADENCE_TICKS {
        let x = pad_x + log_time_frac(mins) * draw_w;
        shape = shape.line(
            [x, base_y],
            [x, base_y + 4.0],
            1.0,
            LineCap::Butt,
            p.hairline_strong,
        );
    }

    for person in people {
        let Some(mins) = parse_age_minutes(&person.last_seen_label) else {
            continue;
        };
        let x = pad_x + log_time_frac(mins) * draw_w;
        let ratio = (person.message_count as f32 / max_count).clamp(0.0, 1.0);
        let stem_h = 8.0 + 32.0 * ratio.sqrt();
        let top_y = (base_y - stem_h).max(4.0);
        shape = shape
            .line([x, base_y], [x, top_y], 1.5, LineCap::Round, p.steel)
            .fill_path(&kit::circle_path(x, top_y, 2.5), p.ink);
    }

    let mut wrapper = el()
        .key("people-cadence-ribbon")
        .w_full()
        .h(vb_h)
        .child(canvas(shape).w_full().h(vb_h));

    for (idx, &(lbl, mins)) in CADENCE_TICKS.iter().enumerate() {
        let t = log_time_frac(mins);
        let tick_layer = if idx == 0 {
            row()
                .pin(Some(pad_x), Some(48.0), Some(pad_x), None)
                .child(text(lbl).font(typo::NUM_S).color(p.ink_muted))
        } else if idx + 1 == CADENCE_TICKS.len() {
            row()
                .pin(Some(pad_x), Some(48.0), Some(pad_x), None)
                .justify_end()
                .child(text(lbl).font(typo::NUM_S).color(p.ink_muted))
        } else {
            row()
                .pin(Some(pad_x), Some(48.0), Some(pad_x), None)
                .child(el().w_frac(t).h(1.0))
                .child(
                    text(lbl)
                        .font(typo::NUM_S)
                        .color(p.ink_muted)
                        .offset(-8.0, 0.0),
                )
        };
        wrapper = wrapper.child(tick_layer);
    }

    wrapper
}

fn people_ledger_col(items: &[(usize, &PersonRadar)], p: &Palette) -> El {
    let mut list = col().grow(1.0).min_w(0.0).h_full();
    for (pos, &(idx, person)) in items.iter().enumerate() {
        if pos > 0 {
            list = list.child(kit::rule_h(p));
        }
        let preview_str = if person.preview.is_empty() {
            person.channels.join(", ")
        } else {
            person.preview.clone()
        };

        let mut tags = row().w_full().items_center().gap(space::S2);
        for ch in person.channels.iter().take(4) {
            tags = tags.child(kit::tag(ch, Tone::Neutral, p));
        }

        let entry = row()
            .key(format!("person-{idx}"))
            .w_full()
            .py(7.0)
            .gap(space::S3)
            .items_start()
            .child(kit::monogram(&person.initials, 24.0, p))
            .child(
                col()
                    .grow(1.0)
                    .min_w(0.0)
                    .gap(2.0)
                    .child(
                        row()
                            .w_full()
                            .items_center()
                            .justify_between()
                            .gap(space::S2)
                            .child(
                                text(&person.name)
                                    .font(typo::BODY_STRONG)
                                    .color(p.ink)
                                    .grow(1.0)
                                    .min_w(0.0)
                                    .truncate()
                                    .help_when_truncated(person.name.as_str()),
                            )
                            .child(
                                text(format!(
                                    "{}, {} msgs",
                                    person.last_seen_label, person.message_count
                                ))
                                .font(typo::CAPTION)
                                .color(p.ink_muted),
                            ),
                    )
                    .child(
                        text(&preview_str)
                            .font(typo::CAPTION)
                            .color(p.ink_secondary)
                            .truncate_fade()
                            .help_when_truncated(preview_str.as_str()),
                    )
                    .child(tags),
            );
        list = list.child(entry);
    }
    list
}

fn short_domain_label<'a>(id: &str, fallback: &'a str) -> &'a str {
    match id {
        "ui_product" => "UI & Product",
        "typography_copy" => "Typography",
        "visual_brand" => "Visual Brand",
        "motion_feel" => "Motion",
        "video_anime" => "Film & Anime",
        "merch_objects" => "Objects",
        "spaces_life" => "Spaces",
        "agent_ops" => "Agent Ops",
        _ => fallback,
    }
}

fn log_time_frac(minutes: f32) -> f32 {
    let clamped = minutes.clamp(0.0, CADENCE_MAX_MINUTES);
    (1.0 + clamped).ln() / (1.0 + CADENCE_MAX_MINUTES).ln()
}

/// Parses relative recency strings such as "55m ago", "3h ago", "1d ago", "2w ago", "1mo ago",
/// "1y ago", or "now". Returns `None` for unknown or malformed labels so no stem is fabricated.
pub fn parse_age_minutes(label: &str) -> Option<f32> {
    let s = label.trim().to_ascii_lowercase();
    if s.is_empty() {
        return None;
    }
    if s == "now" || s == "just now" {
        return Some(0.0);
    }
    let trimmed = s.strip_suffix("ago").unwrap_or(&s).trim();
    let digit_end = trimmed
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(trimmed.len());
    if digit_end == 0 {
        return None;
    }
    let val: f32 = trimmed[..digit_end].parse().ok()?;
    if !val.is_finite() || val < 0.0 {
        return None;
    }
    let unit = trimmed[digit_end..].trim();
    let mult = match unit {
        "s" | "sec" | "secs" | "second" | "seconds" => 1.0 / 60.0,
        "m" | "min" | "mins" | "minute" | "minutes" => 1.0,
        "h" | "hr" | "hrs" | "hour" | "hours" => 60.0,
        "d" | "day" | "days" => 1_440.0,
        "w" | "wk" | "wks" | "week" | "weeks" => 10_080.0,
        "mo" | "mos" | "month" | "months" => 43_200.0,
        "q" | "quarter" | "quarters" => 129_600.0,
        "y" | "yr" | "yrs" | "year" | "years" => 525_600.0,
        _ => return None,
    };
    Some(val * mult)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_relative_age_labels_honestly() {
        assert_eq!(parse_age_minutes("now"), Some(0.0));
        assert_eq!(parse_age_minutes("55m ago"), Some(55.0));
        assert_eq!(parse_age_minutes("3h ago"), Some(180.0));
        assert_eq!(parse_age_minutes("1d ago"), Some(1_440.0));
        assert_eq!(parse_age_minutes("2w ago"), Some(20_160.0));
        assert_eq!(parse_age_minutes("1mo ago"), Some(43_200.0));
        assert_eq!(parse_age_minutes("1y ago"), Some(525_600.0));
        assert_eq!(parse_age_minutes(""), None);
        assert_eq!(parse_age_minutes("unknown"), None);
    }
}
