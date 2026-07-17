use std::path::{Path, PathBuf};
use std::sync::Mutex;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{Emitter, State};

#[derive(Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[derive(Serialize)]
struct DirListing {
    dir: String,
    parent: Option<String>,
    entries: Vec<DirEntry>,
}

/// List sub-folders and Markdown files in a directory (for the file explorer).
/// If `path` is a file, its parent directory is listed.
#[tauri::command]
fn list_dir(path: String) -> Result<DirListing, String> {
    let p = std::path::PathBuf::from(&path);
    let dir = if p.is_dir() {
        p
    } else {
        p.parent().map(Path::to_path_buf).unwrap_or(p)
    };

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue; // skip hidden
        }
        let ep = entry.path();
        let is_dir = ep.is_dir();
        let is_md = ep
            .extension()
            .map(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
            .unwrap_or(false);
        if is_dir || is_md {
            entries.push(DirEntry {
                name,
                path: ep.to_string_lossy().into_owned(),
                is_dir,
            });
        }
    }
    // Folders first, then files; alphabetical, case-insensitive.
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(DirListing {
        dir: dir.to_string_lossy().into_owned(),
        parent: dir.parent().map(|p| p.to_string_lossy().into_owned()),
        entries,
    })
}

/// Holds the file we are currently viewing plus the live filesystem watcher.
#[derive(Default)]
struct AppState {
    current: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
    /// True once the webview has registered its event listeners.
    ready: Mutex<bool>,
    /// macOS file-open requests received before the frontend was ready.
    pending: Mutex<Vec<String>>,
    /// True once the initial window has been given a document. On macOS (which
    /// is single-instance) every *subsequent* file-open opens its own window
    /// instead of replacing the current document — matching Windows/Linux.
    claimed: Mutex<bool>,
}

/// Route a file-open request: the first file loads into the existing (empty)
/// window; any later file spawns a new instance so it gets its own window.
fn route_open(app: &tauri::AppHandle, state: &AppState, path: String) {
    let mut claimed = state.claimed.lock().unwrap();
    if !*claimed {
        *claimed = true;
        let _ = app.emit("open-file", path);
    } else if let Ok(exe) = std::env::current_exe() {
        let _ = std::process::Command::new(exe).arg(path).spawn();
    }
}

/// Pull a markdown file path out of the process arguments (set when the OS
/// launches us via a `.md` file association on Windows / Linux).
fn path_from_args() -> Option<PathBuf> {
    std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .find(|p| p.extension().map(|e| e.eq_ignore_ascii_case("md")).unwrap_or(false) && p.exists())
}

/// Whether the app was launched with `--edit` (open straight into edit mode).
#[tauri::command]
fn start_in_edit() -> bool {
    std::env::args().any(|a| a == "--edit")
}

/// Optional `--zoom=<factor>` launch flag (0.0 means "not set").
#[tauri::command]
fn start_zoom() -> f64 {
    std::env::args()
        .find_map(|a| a.strip_prefix("--zoom=").and_then(|v| v.parse::<f64>().ok()))
        .unwrap_or(0.0)
}

/// Called by the webview once its event listeners are registered. Flushes any
/// file-open requests that arrived during cold start (macOS drops events that
/// are emitted before the frontend is listening).
#[tauri::command]
fn frontend_ready(app: tauri::AppHandle, state: State<AppState>) {
    *state.ready.lock().unwrap() = true;
    let pending: Vec<String> = state.pending.lock().unwrap().drain(..).collect();
    for path in pending {
        route_open(&app, state.inner(), path);
    }
}

/// Returns the file path the app was opened with, if any.
#[tauri::command]
fn get_initial_path(state: State<AppState>) -> Option<String> {
    state
        .current
        .lock()
        .unwrap()
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned())
}

/// Read a markdown file's raw text.
#[tauri::command]
fn read_md(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {path}: {e}"))
}

/// Open a file in a brand-new application window (spawns another instance).
#[tauri::command]
fn open_new_window(path: String) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    std::process::Command::new(exe)
        .arg(path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Write text back to a markdown file.
#[tauri::command]
fn write_md(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("Failed to write {path}: {e}"))
}

/// Begin watching `path`; emits `md-changed` whenever the file is modified.
/// We watch the *parent directory* (non-recursive) because many editors save
/// by replacing the file, which breaks a watch placed directly on the file.
#[tauri::command]
fn watch_file(path: String, app: tauri::AppHandle, state: State<AppState>) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let parent = target
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "File has no parent directory".to_string())?;

    *state.current.lock().unwrap() = Some(target.clone());

    let watched = target.clone();
    let handle = app.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            if matches!(
                event.kind,
                EventKind::Modify(_) | EventKind::Create(_) | EventKind::Any
            ) && event.paths.iter().any(|p| p == &watched)
            {
                let _ = handle.emit("md-changed", watched.to_string_lossy().into_owned());
            }
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&parent, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    // Keep the watcher alive by stashing it in state (replacing any previous one).
    *state.watcher.lock().unwrap() = Some(watcher);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = AppState::default();
    if let Some(p) = path_from_args() {
        *state.current.lock().unwrap() = Some(p);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_initial_path,
            frontend_ready,
            start_in_edit,
            start_zoom,
            read_md,
            write_md,
            list_dir,
            open_new_window,
            watch_file
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS delivers file-association opens as a runtime event. During
            // cold start this can fire before the webview is listening, so we
            // buffer until `frontend_ready` flushes the queue.
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager as _;
                if let tauri::RunEvent::Opened { urls } = &event {
                    let state = app.state::<AppState>();
                    let ready = *state.ready.lock().unwrap();
                    for url in urls {
                        if let Ok(p) = url.to_file_path() {
                            let s = p.to_string_lossy().into_owned();
                            if ready {
                                route_open(app, state.inner(), s);
                            } else {
                                state.pending.lock().unwrap().push(s);
                            }
                        }
                    }
                }
            }
            let _ = (app, &event);
        });
}
