//! Kizuki Mind OS (Rune) design system: anodized graphite dark and warm-neutral porcelain light.
//! Enforces the 90 / 8 / 2 restraint law, 7-size / 3-weight typographic scale (floor 11.0px),
//! and unboxed hairline geometry with a single elevated plate budget per view.

use std::f32::consts::{PI, TAU};

use rune::color::{Color, hex};
use rune::tok::{Family, TextStyle, motion};
use rune::{El, LineCap, Path, Shape, TextCase, canvas, col, el, row, text};

fn hx(s: &str) -> Color {
    hex(s).unwrap_or(Color::TRANSPARENT)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)]
pub enum Tone {
    Neutral,
    Steel,
    Focus,
    Live,
    Urgent,
    Caution,
}

#[derive(Clone, Copy, Debug)]
#[allow(dead_code)]
pub struct Palette {
    pub dark: bool,
    pub canvas: Color,
    pub deck: Color,
    pub surface: Color,
    pub surface_elevated: Color,
    pub recessed_well: Color,
    pub hairline: Color,
    pub hairline_strong: Color,
    pub ink: Color,
    pub ink_secondary: Color,
    pub ink_muted: Color,
    pub ink_faint: Color,
    pub steel: Color,
    pub steel_soft: Color,
    pub steel_edge: Color,
    pub selection: Color,
    pub edge_top: Color,
    pub edge_bottom: Color,
    pub on_signal: Color,
    pub hover: Color,
    pub press: Color,
    pub shadow: Color,
    pub focus_ring: Color,
    pub overlay_scrim: Color,
    pub vermilion: Color,
    pub vermilion_soft: Color,
    pub vermilion_border: Color,
    pub emerald: Color,
    pub emerald_soft: Color,
    pub emerald_border: Color,
    pub amber: Color,
    pub amber_soft: Color,
    pub amber_border: Color,
    pub cobalt: Color,
    pub cobalt_soft: Color,
    pub seg_empty: Color,
}

impl Palette {
    pub fn for_mode(dark: bool) -> Self {
        if dark {
            let steel = hx("#8E99AB");
            let steel_soft = hx("#8E99AB24");
            let edge_top = hx("#FFFFFF24");
            Self {
                dark: true,
                canvas: hx("#101114"),
                deck: hx("#14161A"),
                surface: hx("#191B20"),
                surface_elevated: hx("#20232A"),
                recessed_well: hx("#0B0C0E"),
                hairline: hx("#FFFFFF12"),
                hairline_strong: hx("#FFFFFF21"),
                ink: hx("#ECEBE8"),
                ink_secondary: hx("#A9ABB0"),
                ink_muted: hx("#8A8E96"),
                ink_faint: hx("#555962"),
                steel,
                steel_soft,
                steel_edge: hx("#8E99AB52"),
                selection: hx("#FFFFFF0F"),
                edge_top,
                edge_bottom: hx("#FFFFFF0A"),
                on_signal: hx("#14100E"),
                hover: hx("#FFFFFF0A"),
                press: hx("#FFFFFF14"),
                shadow: hx("#00000073"),
                focus_ring: hx("#6A9BF4"),
                overlay_scrim: hx("#08090B61"),
                vermilion: hx("#F25A3C"),
                vermilion_soft: hx("#F25A3C1F"),
                vermilion_border: hx("#F25A3C66"),
                emerald: hx("#3CCB8A"),
                emerald_soft: hx("#3CCB8A1F"),
                emerald_border: hx("#3CCB8A66"),
                amber: hx("#D9A441"),
                amber_soft: hx("#D9A4411F"),
                amber_border: hx("#D9A44166"),
                cobalt: hx("#6A9BF4"),
                cobalt_soft: hx("#6A9BF424"),
                seg_empty: hx("#FFFFFF14"),
            }
        } else {
            let steel = hx("#5C6575");
            let steel_soft = hx("#5C65751F");
            let edge_top = hx("#1B1A181A");
            Self {
                dark: false,
                canvas: hx("#F1F0ED"),
                deck: hx("#F6F5F2"),
                surface: hx("#FCFBF9"),
                surface_elevated: hx("#FEFDFB"),
                recessed_well: hx("#E8E6E1"),
                hairline: hx("#1B1A1814"),
                hairline_strong: hx("#1B1A1829"),
                ink: hx("#1B1A18"),
                ink_secondary: hx("#55534E"),
                ink_muted: hx("#6B6862"),
                ink_faint: hx("#A19E97"),
                steel,
                steel_soft,
                steel_edge: hx("#5C657552"),
                selection: hx("#1B1A180D"),
                edge_top,
                edge_bottom: hx("#1B1A182E"),
                on_signal: hx("#FFFFFF"),
                hover: hx("#1B1A180A"),
                press: hx("#1B1A1814"),
                shadow: hx("#1B1A1814"),
                focus_ring: hx("#2452CC"),
                overlay_scrim: hx("#1B1A182E"),
                vermilion: hx("#C8321A"),
                vermilion_soft: hx("#C8321A14"),
                vermilion_border: hx("#C8321A52"),
                emerald: hx("#0F7548"),
                emerald_soft: hx("#0F754814"),
                emerald_border: hx("#0F754852"),
                amber: hx("#8A5E0C"),
                amber_soft: hx("#8A5E0C14"),
                amber_border: hx("#8A5E0C52"),
                cobalt: hx("#2452CC"),
                cobalt_soft: hx("#2452CC14"),
                seg_empty: hx("#1B1A1814"),
            }
        }
    }

    pub fn tone(&self, t: Tone) -> Color {
        match t {
            Tone::Neutral => self.ink_secondary,
            Tone::Steel => self.steel,
            Tone::Focus => self.cobalt,
            Tone::Live => self.emerald,
            Tone::Urgent => self.vermilion,
            Tone::Caution => self.amber,
        }
    }

    pub fn tone_soft(&self, t: Tone) -> Color {
        match t {
            Tone::Neutral => self.hover,
            Tone::Steel => self.steel_soft,
            Tone::Focus => self.cobalt_soft,
            Tone::Live => self.emerald_soft,
            Tone::Urgent => self.vermilion_soft,
            Tone::Caution => self.amber_soft,
        }
    }

    pub fn tone_edge(&self, t: Tone) -> Color {
        match t {
            Tone::Neutral => self.hairline_strong,
            Tone::Steel => self.steel_edge,
            Tone::Focus => self.cobalt.alpha(0.4),
            Tone::Live => self.emerald_border,
            Tone::Urgent => self.vermilion_border,
            Tone::Caution => self.amber_border,
        }
    }
}

#[allow(dead_code)]
pub mod space {
    pub const S1: f32 = 4.0;
    pub const S2: f32 = 8.0;
    pub const S3: f32 = 12.0;
    pub const S4: f32 = 16.0;
    pub const S5: f32 = 20.0;
    pub const S6: f32 = 24.0;
    pub const S8: f32 = 32.0;
    pub const S10: f32 = 40.0;
    pub const GUTTER: f32 = 20.0;
    pub const PANE_GAP: f32 = 40.0;
    pub const ROW_X: f32 = 12.0;
    pub const ROW_Y: f32 = 10.0;
}

#[allow(dead_code)]
pub mod radius {
    pub const TAG: f32 = 4.0;
    pub const CONTROL: f32 = 6.0;
    pub const ROW: f32 = 8.0;
    pub const PLATE: f32 = 12.0;
    pub const SHEET: f32 = 14.0;
}

#[allow(dead_code)]
pub mod typo {
    use super::*;

    pub const DISPLAY: TextStyle = TextStyle::new(28.0, 600.0).tracking(-0.45).lh(34.0);
    pub const TITLE: TextStyle = TextStyle::new(20.0, 600.0).tracking(-0.25).lh(26.0);
    pub const HEADING: TextStyle = TextStyle::new(15.0, 600.0).tracking(-0.1).lh(20.0);
    pub const READ: TextStyle = TextStyle::new(14.0, 400.0).lh(22.0);
    pub const BODY: TextStyle = TextStyle::new(13.0, 400.0).lh(19.0);
    pub const BODY_STRONG: TextStyle = TextStyle::new(13.0, 510.0).lh(19.0);
    pub const CAPTION: TextStyle = TextStyle::new(12.0, 400.0).lh(16.0);
    pub const LABEL: TextStyle = TextStyle::new(11.0, 510.0).tracking(0.1).lh(14.0);
    pub const OVERLINE: TextStyle = TextStyle::new(11.0, 600.0).tracking(0.66).lh(14.0);

    pub const NUM_XL: TextStyle = TextStyle::new(28.0, 510.0)
        .features("'tnum' 1")
        .tracking(-0.4)
        .lh(32.0);
    pub const NUM_L: TextStyle = TextStyle::new(20.0, 510.0)
        .features("'tnum' 1")
        .tracking(-0.2)
        .lh(24.0);
    pub const NUM: TextStyle = TextStyle::new(13.0, 510.0).features("'tnum' 1").lh(19.0);
    pub const NUM_S: TextStyle = TextStyle::new(12.0, 400.0).features("'tnum' 1").lh(16.0);

    pub const MONO: TextStyle = TextStyle::new(12.0, 400.0)
        .family(Family::SystemMono)
        .features("'tnum' 1")
        .lh(16.0);
    pub const MONO_S: TextStyle = TextStyle::new(11.0, 400.0)
        .family(Family::SystemMono)
        .features("'tnum' 1")
        .lh(14.0);
}

#[allow(dead_code)]
pub mod kit {
    use super::*;

    pub fn rule_h(p: &Palette) -> El {
        el().w_full().h(1.0).fill(p.hairline)
    }

    pub fn rule_v(p: &Palette) -> El {
        el().w(1.0).h_full().fill(p.hairline)
    }

    pub fn pane() -> El {
        col().min_w(0.0).min_h(0.0)
    }

    pub fn plate(p: &Palette) -> El {
        let (blur_y, spread) = if p.dark { (10.0, 28.0) } else { (6.0, 20.0) };
        col()
            .fill(p.surface)
            .radius(radius::PLATE)
            .continuous_corners()
            .border_gradient(1.0, p.edge_top, p.edge_bottom)
            .shadow(blur_y, spread, p.shadow)
    }

    pub fn overline(label: &str, p: &Palette) -> El {
        text(label)
            .font(typo::OVERLINE)
            .color(p.ink_muted)
            .text_case(TextCase::Uppercase)
    }

    pub fn pane_head(title: &str, meta: &str, p: &Palette) -> El {
        row()
            .w_full()
            .h(28.0)
            .items_center()
            .justify_between()
            .gap(space::S2)
            .child(overline(title, p))
            .child(
                text(meta)
                    .font(typo::CAPTION)
                    .color(p.ink_muted)
                    .truncate(),
            )
    }

    pub fn list_row(selected: bool, p: &Palette) -> El {
        row()
            .w_full()
            .px(space::ROW_X)
            .py(space::ROW_Y)
            .gap(space::S3)
            .radius(radius::ROW)
            .items_center()
            .fill(if selected {
                p.selection
            } else {
                Color::TRANSPARENT
            })
            .hover_fill(p.hover)
            .motion(motion::SNAPPY)
    }

    pub fn focus_bar(p: &Palette) -> El {
        el().pin(Some(0.0), Some(8.0), None, Some(8.0))
            .w(2.0)
            .radius(1.0)
            .fill(p.cobalt)
    }

    pub fn kbd(label: &str, p: &Palette) -> El {
        row()
            .h(18.0)
            .min_w(18.0)
            .px(5.0)
            .radius(radius::TAG)
            .fill(p.surface_elevated)
            .border(1.0, p.hairline_strong)
            .center()
            .child(text(label).font(typo::LABEL).color(p.ink_secondary))
    }

    pub fn tag(label: &str, tone: Tone, p: &Palette) -> El {
        text(label).font(typo::LABEL).color(p.tone(tone))
    }

    pub fn badge(label: &str, tone: Tone, p: &Palette) -> El {
        row()
            .h(18.0)
            .px(6.0)
            .radius(radius::TAG)
            .fill(p.tone_soft(tone))
            .center()
            .child(text(label).font(typo::LABEL).color(p.tone(tone)))
    }

    pub fn dot(tone: Tone, p: &Palette) -> El {
        el().size(6.0, 6.0).radius(3.0).fill(p.tone(tone))
    }

    pub fn meter(frac: f32, tone: Tone, p: &Palette) -> El {
        let clamped = frac.clamp(0.0, 1.0);
        row()
            .w_full()
            .h(2.0)
            .radius(1.0)
            .fill(p.seg_empty)
            .clip_rounded(1.0)
            .child(el().h_full().w_frac(clamped).fill(p.tone(tone)))
    }

    pub fn stamp(label: &str, tone: Tone, p: &Palette) -> El {
        row()
            .h(20.0)
            .px(7.0)
            .gap(5.0)
            .radius(radius::TAG)
            .border(1.0, p.tone_edge(tone))
            .items_center()
            .child(dot(tone, p))
            .child(text(label).font(typo::LABEL).color(p.tone(tone)))
    }

    pub fn button_primary(label: &str, hint: Option<&str>, p: &Palette) -> El {
        let mut r = row()
            .h(28.0)
            .px(12.0)
            .gap(8.0)
            .radius(radius::CONTROL)
            .continuous_corners()
            .fill(p.ink)
            .items_center()
            .hover_fill(p.ink.alpha(0.88))
            .press_scale(0.97)
            .motion(motion::SNAPPY)
            .child(text(label).font(typo::BODY_STRONG).color(p.canvas));
        if let Some(h) = hint {
            r = r.child(text(h).font(typo::LABEL).color(p.canvas.alpha(0.6)));
        }
        r
    }

    pub fn button_quiet(label: &str, hint: Option<&str>, p: &Palette) -> El {
        let mut r = row()
            .h(28.0)
            .px(10.0)
            .gap(6.0)
            .radius(radius::CONTROL)
            .items_center()
            .hover_fill(p.hover)
            .press_fill(p.press)
            .press_scale(0.97)
            .motion(motion::SNAPPY)
            .child(text(label).font(typo::BODY_STRONG).color(p.ink_secondary));
        if let Some(h) = hint {
            r = r.child(kbd(h, p));
        }
        r
    }

    pub fn monogram(initials: &str, size: f32, p: &Palette) -> El {
        row()
            .size(size, size)
            .radius(size * 0.3)
            .fill(p.steel_soft)
            .center()
            .child(text(initials).font(typo::LABEL).color(p.ink_secondary))
    }

    pub fn stat(label: &str, value: &str, p: &Palette) -> El {
        col()
            .gap(2.0)
            .child(text(label).font(typo::LABEL).color(p.ink_muted))
            .child(text(value).font(typo::NUM_L).color(p.ink))
    }

    pub fn spark(values: &[f32], live: bool, width: f32, height: f32, p: &Palette) -> El {
        if values.len() < 2 {
            return el().w(width).h(height);
        }
        let mut min_v = f32::INFINITY;
        let mut max_v = f32::NEG_INFINITY;
        for &v in values {
            if v < min_v {
                min_v = v;
            }
            if v > max_v {
                max_v = v;
            }
        }
        let span = (max_v - min_v).max(1e-4);
        let pad_x = 2.0_f32;
        let pad_y = 3.0_f32;
        let inner_w = (width - pad_x * 2.0).max(1.0);
        let inner_h = (height - pad_y * 2.0).max(1.0);
        let n = values.len();
        let mut pts = Vec::with_capacity(n);
        for (i, &v) in values.iter().enumerate() {
            let x = pad_x + (i as f32 / (n - 1) as f32) * inner_w;
            let norm = (v - min_v) / span;
            let y = pad_y + (1.0 - norm) * inner_h;
            pts.push([x, y]);
        }
        let last = pts[n - 1];
        let end_color = if live { p.emerald } else { p.ink_secondary };
        let baseline_y = height - 1.5;
        let shape = Shape::new()
            .view_box(width, height)
            .line(
                [pad_x, baseline_y],
                [width - pad_x, baseline_y],
                1.0,
                LineCap::Butt,
                p.hairline,
            )
            .stroke_with(pts, false, 1.25, LineCap::Round, p.ink_secondary)
            .fill_path(&circle_path(last[0], last[1], 2.0), end_color);
        canvas(shape).size(width, height)
    }

    pub fn seg_gauge(frac: f32, segments: usize, tone: Tone, p: &Palette) -> El {
        let count = segments.max(1);
        let lit = ((frac.clamp(0.0, 1.0) * count as f32).round() as usize).min(count);
        let lit_color = p.tone(tone);
        let mut bar = row().w_full().h(6.0).gap(2.0).equal_columns(count);
        for i in 0..count {
            let fill = if i < lit { lit_color } else { p.seg_empty };
            bar = bar.child(el().h_full().radius(1.0).fill(fill));
        }
        bar
    }

    pub fn ring(frac: f32, size: f32, tone: Tone, p: &Palette) -> El {
        let c = size * 0.5;
        let r = (size * 0.5 - 1.5).max(1.5);
        let clamped = frac.clamp(0.0, 1.0);
        let mut shape = Shape::new().view_box(size, size).stroke_path(
            &circle_path(c, c, r),
            1.5,
            LineCap::Butt,
            p.seg_empty,
        );
        if clamped > 0.005 {
            let sweep = if clamped >= 0.999 {
                TAU - 0.001
            } else {
                TAU * clamped
            };
            shape = shape.stroke_path(
                &arc_path(c, c, r, -PI * 0.5, -PI * 0.5 + sweep),
                1.5,
                LineCap::Round,
                p.tone(tone),
            );
        }
        canvas(shape).size(size, size)
    }

    pub fn circle_path(cx: f32, cy: f32, r: f32) -> Path {
        const K: f32 = 0.552_284_8;
        let kr = K * r;
        Path::new()
            .move_to([cx, cy - r])
            .cubic_to([cx + kr, cy - r], [cx + r, cy - kr], [cx + r, cy])
            .cubic_to([cx + r, cy + kr], [cx + kr, cy + r], [cx, cy + r])
            .cubic_to([cx - kr, cy + r], [cx - r, cy + kr], [cx - r, cy])
            .cubic_to([cx - r, cy - kr], [cx - kr, cy - r], [cx, cy - r])
            .close()
    }

    pub fn arc_path(cx: f32, cy: f32, r: f32, a0: f32, a1: f32) -> Path {
        let total = a1 - a0;
        if total.abs() < 1e-4 {
            return Path::new();
        }
        let segs = (total.abs() / (PI * 0.5)).ceil().max(1.0) as usize;
        let step = total / segs as f32;
        let k = (4.0 / 3.0) * (step * 0.25).tan();
        let mut p = Path::new().move_to([cx + r * a0.cos(), cy + r * a0.sin()]);
        for i in 0..segs {
            let t0 = a0 + i as f32 * step;
            let t1 = t0 + step;
            let (s0, c0) = t0.sin_cos();
            let (s1, c1) = t1.sin_cos();
            let p0 = [cx + r * c0, cy + r * s0];
            let p3 = [cx + r * c1, cy + r * s1];
            let p1 = [p0[0] - k * r * s0, p0[1] + k * r * c0];
            let p2 = [p3[0] + k * r * s1, p3[1] - k * r * c1];
            p = p.cubic_to(p1, p2, p3);
        }
        p
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_palette_hex_literals_parse_cleanly() {
        let dark_hexes = [
            "#101114", "#14161A", "#191B20", "#20232A", "#0B0C0E", "#FFFFFF12", "#FFFFFF21",
            "#FFFFFF24", "#FFFFFF0A", "#FFFFFF0F", "#FFFFFF14", "#ECEBE8", "#A9ABB0", "#8A8E96",
            "#555962", "#8E99AB", "#8E99AB24", "#8E99AB52", "#F25A3C", "#F25A3C1F", "#F25A3C66",
            "#3CCB8A", "#3CCB8A1F", "#3CCB8A66", "#6A9BF4", "#6A9BF424", "#D9A441", "#D9A4411F",
            "#D9A44166", "#14100E", "#00000073", "#08090B61",
        ];
        let light_hexes = [
            "#F1F0ED", "#F6F5F2", "#FCFBF9", "#FEFDFB", "#E8E6E1", "#1B1A1814", "#1B1A1829",
            "#1B1A181A", "#1B1A182E", "#1B1A180D", "#1B1A180A", "#1B1A18", "#55534E", "#6B6862",
            "#A19E97", "#5C6575", "#5C65751F", "#5C657552", "#C8321A", "#C8321A14", "#C8321A52",
            "#0F7548", "#0F754814", "#0F754852", "#2452CC", "#2452CC14", "#8A5E0C", "#8A5E0C14",
            "#8A5E0C52", "#FFFFFF",
        ];
        for h in dark_hexes.into_iter().chain(light_hexes) {
            assert!(hex(h).is_some(), "failed to parse hex literal {h}");
        }
        let d = Palette::for_mode(true);
        let l = Palette::for_mode(false);
        assert!(d.dark && !l.dark);
        assert_eq!(d.tone(Tone::Steel), d.steel);
        assert_eq!(l.tone(Tone::Steel), l.steel);
    }
}
