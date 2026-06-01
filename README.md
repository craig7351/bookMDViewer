# Markdown Viewer

A lightweight, fully-local Markdown viewer built with **Tauri v2**. Uses the
operating system's built-in WebView (WebView2 on Windows, WKWebView on macOS,
WebKitGTK on Linux) instead of bundling Chromium — so the binary is a few MB and
idle memory stays low.

## Features

- **GFM** rendering (tables, task lists, strikethrough) via `markdown-it`
- **Syntax highlighting** via `highlight.js`
- **Mermaid diagrams** — loaded lazily, only when a document actually contains a
  ` ```mermaid ` block, so plain documents pay nothing for it
- **Live reload** — the file is watched on disk and re-rendered on save
- **File association** — double-click any `.md` file to open it
- **Drag & drop** a `.md` file onto the window
- Light / dark theme follows the OS setting
- External links open in your default browser

## Develop

```bash
npm install
npm run tauri dev
```

## Build a local binary

```bash
npm run tauri build
```

Output (Windows): `src-tauri/target/release/Markdown Viewer.exe` plus an NSIS
installer under `src-tauri/target/release/bundle/` that registers the `.md`
file association.

## Cross-platform releases

Push a tag and GitHub Actions builds Windows / macOS (Intel + Apple Silicon) /
Linux installers and attaches them to a draft release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

See [.github/workflows/release.yml](.github/workflows/release.yml).
