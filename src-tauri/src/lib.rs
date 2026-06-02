use std::path::{Path, PathBuf};
use std::sync::Mutex;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{Emitter, State};

/// Holds the file we are currently viewing plus the live filesystem watcher.
#[derive(Default)]
struct AppState {
    current: Mutex<Option<PathBuf>>,
    watcher: Mutex<Option<RecommendedWatcher>>,
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
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_initial_path,
            start_in_edit,
            read_md,
            write_md,
            watch_file
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // macOS delivers file-association opens as a runtime event.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                for url in urls {
                    if let Ok(p) = url.to_file_path() {
                        let _ = app.emit("open-file", p.to_string_lossy().into_owned());
                    }
                }
            }
            let _ = (app, &event);
        });
}
