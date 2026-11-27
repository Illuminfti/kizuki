pub mod board;
pub mod chrome;
pub mod flow_deck;
pub mod mind;
pub mod today;

use rune::tok::motion;
use rune::{Cx, El, Key, KeyEvent, Transition, Tx, col};

use crate::state::{ActiveView, AppState, DecisionVerdict};
use crate::theme::{Palette, space};

pub fn root_view(s: &AppState, cx: &mut Cx<AppState>) -> El {
    let p = Palette::for_mode(s.dark);
    cx.press_cursor(rune::Cursor::Pointer);
    cx.focus_ring(2.0, 2.0, p.focus_ring);
    let titlebar_inset = cx.titlebar_inset();

    let view_key = match s.view {
        ActiveView::FlowDeck => "stage-flow",
        ActiveView::Board => "stage-board",
        ActiveView::Today => "stage-today",
        ActiveView::Mind => "stage-mind",
        ActiveView::AiLive => "stage-ai-live",
    };

    let body = match s.view {
        ActiveView::FlowDeck => flow_deck::view(s, &p),
        ActiveView::Board => board::view(s, &p),
        ActiveView::Today => today::view(s, &p),
        ActiveView::Mind => mind::view(s, &p),
        ActiveView::AiLive => flow_deck::ai_live_view(s, &p),
    };

    let mut stage = col()
        .key(view_key)
        .w_full()
        .grow(1.0)
        .min_h(0.0)
        .opacity_motion(motion::SNAPPY)
        .transition(Transition::opacity());

    if s.view != ActiveView::Board {
        stage = stage.px(space::S5).pt(space::S4).pb(space::S5);
    }

    let mut root = col()
        .key("kizuki-root")
        .focusable(true)
        .w_full()
        .h_full()
        .fill(p.canvas)
        .on_key_preview(handle_root_key)
        .child(chrome::top_bar(s, &p, titlebar_inset))
        .child(stage.child(body));

    // Pinned overlays sit out of flex flow so toasts and modals never shift workspace geometry.
    if let Some(toast) = chrome::toast_overlay(s, &p) {
        root = root.child(toast);
    }

    if s.cmd_open {
        root = root.child(chrome::command_palette_overlay(s, &p));
    } else if s.shortcuts_open {
        root = root.child(chrome::shortcuts_overlay(s, &p));
    }

    root
}

pub fn handle_root_key(s: &mut AppState, ev: &KeyEvent, tx: &mut Tx) -> bool {
    // Global Cmd+K / Ctrl+K toggles quick command and filter overlay.
    if ev.is_command('k') {
        s.cmd_open = !s.cmd_open;
        s.shortcuts_open = false;
        s.cmd_selected = 0;
        tx.animated();
        if s.cmd_open {
            tx.focus_when_shown("cmd-input", true);
        } else {
            tx.blur();
        }
        return true;
    }

    if ev.key == Key::Escape {
        if s.cmd_open {
            s.cmd_open = false;
            s.cmd_selected = 0;
            tx.blur();
            tx.animated();
            return true;
        }
        if s.shortcuts_open {
            s.shortcuts_open = false;
            tx.animated();
            return true;
        }
        if s.error_banner.is_some() {
            s.error_banner = None;
            s.shake_card_id = None;
            return true;
        }
        if s.status_toast.is_some() {
            s.status_toast = None;
            return true;
        }
        if s.agent_filter.is_some() {
            s.agent_filter = None;
            s.selected_thread_idx = 0;
            return true;
        }
        return false;
    }

    // Command palette key handling (let text_input handle character typing).
    if s.cmd_open {
        let count = s.filtered_commands().len();
        match &ev.key {
            Key::Down => {
                if count > 0 {
                    s.cmd_selected = (s.cmd_selected + 1) % count;
                }
                return true;
            }
            Key::Up => {
                if count > 0 {
                    s.cmd_selected = (s.cmd_selected + count - 1) % count;
                }
                return true;
            }
            Key::Enter => {
                let cmds = s.filtered_commands();
                if let Some(cmd) = cmds.get(s.cmd_selected).cloned() {
                    s.execute_command(cmd.action);
                    tx.blur();
                    tx.animated();
                }
                return true;
            }
            _ => return false,
        }
    }

    // Do not intercept command chords other than Cmd+K.
    if ev.mods.cmd || ev.mods.ctrl || ev.mods.alt {
        return false;
    }

    match &ev.key {
        Key::Text(t) => match t.as_str() {
            "1" => {
                s.view = ActiveView::FlowDeck;
                tx.animated();
                true
            }
            "2" => {
                s.view = ActiveView::Board;
                tx.animated();
                true
            }
            "3" => {
                s.view = ActiveView::Today;
                tx.animated();
                true
            }
            "4" => {
                s.view = ActiveView::Mind;
                tx.animated();
                true
            }
            "5" => {
                s.view = ActiveView::AiLive;
                tx.animated();
                true
            }
            "j" | "J" => {
                s.select_next();
                true
            }
            "k" | "K" => {
                s.select_prev();
                true
            }
            "a" | "A" => {
                if s.stamp_selected(DecisionVerdict::Approved) {
                    tx.animated();
                    true
                } else {
                    false
                }
            }
            "r" | "R" => {
                if s.stamp_selected(DecisionVerdict::Revised) {
                    tx.animated();
                    true
                } else {
                    false
                }
            }
            "d" | "D" => {
                if s.stamp_selected(DecisionVerdict::Deferred) {
                    tx.animated();
                    true
                } else {
                    false
                }
            }
            "u" | "U" => {
                if s.trigger_undo() {
                    tx.animated();
                    true
                } else {
                    false
                }
            }
            "t" | "T" => {
                s.dark = !s.dark;
                tx.color_motion(motion::CALM);
                true
            }
            "?" => {
                s.shortcuts_open = !s.shortcuts_open;
                tx.animated();
                true
            }
            _ => false,
        },
        Key::Down => {
            s.select_next();
            true
        }
        Key::Up => {
            s.select_prev();
            true
        }
        Key::Enter if s.inspect_selected() => {
            tx.animated();
            true
        }
        _ => false,
    }
}
