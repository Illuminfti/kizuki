//! Kizuki Mind OS (Native Rune Edition)
//! Live, writable, keyboard-first, kinetic native Rust GPU desktop client built with Anomaly Rune.

#![forbid(unsafe_code)]

mod data;
mod headless;
mod state;
mod theme;
mod views;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

use rune::{App, AppSpec, FrameOutcome, Tx};

use crate::data::{ConnectionState, SnapshotData, spawn_background_poller};
use crate::state::{ActiveView, AppState};
use crate::views::root_view;

static POLL_VISIBLE: AtomicBool = AtomicBool::new(true);
static API_BASE_FOR_INIT: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();

fn init_state() -> AppState {
    // Instant non-blocking boot on embedded snapshot (<300ms to first frame).
    let data = SnapshotData::load_embedded();
    let snapshot_date = data.snapshot_date();
    let api_base = API_BASE_FOR_INIT.get().cloned().flatten();
    AppState::new(
        data,
        ConnectionState::Offline { snapshot_date },
        api_base,
    )
}

fn on_window_visibility(_s: &mut AppState, visible: bool, _tx: &mut Tx) {
    POLL_VISIBLE.store(visible, Ordering::Relaxed);
}

#[cfg(target_os = "linux")]
fn ensure_linux_vulkan_icd() {
    use std::path::Path;
    if std::env::var_os("VK_ICD_FILENAMES").is_some()
        || std::env::var_os("VK_DRIVER_FILES").is_some()
        || std::env::var_os("KIZUKI_RUNE_ICD_BOOTSTRAPPED").is_some()
    {
        return;
    }
    let has_system_icd = std::fs::read_dir("/usr/share/vulkan/icd.d")
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .any(|e| e.path().extension().is_some_and(|x| x == "json"));
    if has_system_icd {
        return;
    }
    let swiftshader = Path::new("/opt/google/chrome/vk_swiftshader_icd.json");
    if !swiftshader.exists() {
        return;
    }
    if let Ok(exe) = std::env::current_exe() {
        let status = std::process::Command::new(exe)
            .args(std::env::args_os().skip(1))
            .env("VK_ICD_FILENAMES", swiftshader)
            .env("VK_DRIVER_FILES", swiftshader)
            .env("KIZUKI_RUNE_ICD_BOOTSTRAPPED", "1")
            .status();
        match status {
            Ok(s) => std::process::exit(s.code().unwrap_or(0)),
            Err(e) => {
                eprintln!("kizuki-mind-rune: SwiftShader ICD re-exec failed: {e}");
            }
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn ensure_linux_vulkan_icd() {}

fn main() {
    let boot_start = Instant::now();
    ensure_linux_vulkan_icd();

    let args: Vec<String> = std::env::args().collect();
    let is_headless_suite = args.iter().any(|a| a == "--headless");
    let offline = args.iter().any(|a| a == "--offline");

    let api_flag = args
        .iter()
        .position(|a| a == "--api")
        .and_then(|i| args.get(i + 1))
        .cloned()
        .or_else(|| std::env::var("KIZUKI_API_URL").ok());

    let out_dir = args
        .iter()
        .position(|a| a == "--out")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp/rune-shots"));

    if is_headless_suite {
        if let Err(err) = headless::run_headless_suite(&out_dir, boot_start) {
            eprintln!("kizuki-mind-rune headless error: {err}");
            std::process::exit(1);
        }
        return;
    }

    let api_target = if offline {
        None
    } else if let Some(url) = api_flag {
        Some(url)
    } else {
        Some("http://127.0.0.1:8797".to_string())
    };

    let _ = API_BASE_FOR_INIT.set(api_target.clone());

    let spec = AppSpec::<AppState> {
        min_size: Some((1180.0, 720.0)),
        on_key: Some(views::handle_root_key),
        scenes: &[
            ("flow-dark", |s| {
                s.view = ActiveView::FlowDeck;
                s.dark = true;
            }),
            ("flow-light", |s| {
                s.view = ActiveView::FlowDeck;
                s.dark = false;
            }),
            ("board", |s| {
                s.view = ActiveView::Board;
                s.dark = true;
            }),
            ("today", |s| {
                s.view = ActiveView::Today;
                s.dark = true;
            }),
            ("mind", |s| {
                s.view = ActiveView::Mind;
                s.dark = true;
            }),
        ],
        ..AppSpec::new("Kizuki Mind OS", (1440.0, 900.0), init_state, root_view)
    };

    let first_encoded_logged = Arc::new(AtomicBool::new(false));
    let first_presented_logged = Arc::new(AtomicBool::new(false));
    let frames_encoded_total = Arc::new(AtomicU64::new(0));

    let enc_flag = first_encoded_logged.clone();
    let enc_count = frames_encoded_total.clone();
    let pres_flag = first_presented_logged.clone();

    let app = App::new(spec)
        .titlebar(rune::Titlebar::new(44.0))
        .ambient_fps(30.0)
        .on_visibility(on_window_visibility)
        .on_frame_encoded(move |frame| {
            if frame.outcome() == FrameOutcome::Drawn {
                enc_count.fetch_add(1, Ordering::Relaxed);
                if !enc_flag.swap(true, Ordering::SeqCst) {
                    let ms = boot_start.elapsed().as_secs_f64() * 1000.0;
                    eprintln!(
                        "kizuki-mind-rune: first_frame_encoded_ms={ms:.1} seq={}",
                        frame.seq()
                    );
                }
            }
        })
        .on_frame_presented(move |pres| {
            if !pres_flag.swap(true, Ordering::SeqCst) {
                let ms = boot_start.elapsed().as_secs_f64() * 1000.0;
                eprintln!(
                    "kizuki-mind-rune: first_frame_presented_ms={ms:.1} seq={}",
                    pres.seq()
                );
            }
        });

    let handle = app.handle();

    // Start non-blocking live data plane & C1 writer AFTER creating AppHandle (zero boot block).
    if let Some(url) = api_target {
        let initial_snapshot = SnapshotData::load_embedded();
        let writer_handle = handle.clone();
        let writer_url = url.clone();
        handle.update(move |st, _tx| {
            st.attach_desktop_writer(writer_url, writer_handle);
        });

        let visible_arc = Arc::new(AtomicBool::new(true));
        let vis_mirror = visible_arc.clone();
        std::thread::Builder::new()
            .name("kizuki-vis-sync".into())
            .spawn(move || loop {
                vis_mirror.store(POLL_VISIBLE.load(Ordering::Relaxed), Ordering::Relaxed);
                std::thread::sleep(std::time::Duration::from_millis(250));
            })
            .ok();

        spawn_background_poller(url, initial_snapshot, handle, visible_arc);
    }

    app.run();
}
