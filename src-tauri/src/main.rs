// Prevents an extra console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMABUF/GL renderer triggers `libGLESv2.so.2: undefined symbol`
    // and blank windows on many Linux GPU/driver/VM combos. Fall back to the
    // compatible renderer unless the user explicitly overrides it.
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    md_viewer_lib::run()
}
