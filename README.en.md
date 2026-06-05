# Markdown Viewer

[繁體中文](README.md) | **English**

A **lightweight, fully-local Markdown viewer & editor** for Windows, macOS and
Linux. Built with **Tauri v2**, it uses the operating system's built-in WebView
(WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux) instead of bundling
Chromium — so the Windows binary is only **~4 MB** and idle memory stays around
**30–60 MB**.

Double-click a `.md` file and it opens instantly, beautifully rendered — with a
navigable outline, syntax highlighting, Mermaid diagrams, a built-in editor with
live preview, and one-click export to a self-contained HTML file. No installer
bloat, no cloud, no telemetry. Everything runs offline.

## Screenshots

### Reading mode — outline + rendered Markdown

The left **outline (TOC)** is generated from the document's headings; click any
entry to jump, and it highlights the section you're currently reading.

![Reading mode with outline sidebar](docs/screenshots/viewer.png)

### Editing mode — live edit & preview

Press **Edit** (or `Ctrl+E`) to open the split editor. The preview updates as you
type, the two panes **scroll together**, and `Ctrl+S` saves back to disk.

![Edit mode with live preview](docs/screenshots/editor.png)

## Features

- **GFM** rendering — tables, task lists, strikethrough (`markdown-it`)
- **Syntax highlighting** for code blocks (`highlight.js`)
- **Mermaid diagrams** — loaded lazily, only when a document actually contains a
  ` ```mermaid ` block, so plain documents pay nothing for it
- **Outline / TOC sidebar** — auto-built from headings, scroll-spy highlighting,
  collapsible with `Ctrl+\`
- **Live edit & preview** — split editor with synced scrolling (`Ctrl+E`),
  save with `Ctrl+S`, and an unsaved-changes prompt on close
- **Export to HTML** — produces a single self-contained `.html` next to your file,
  including the outline sidebar, highlighted code and inline Mermaid SVGs
- **Live reload** — the open file is watched on disk and re-rendered on save
- **File association** — double-click any `.md` / `.markdown` file to open it
- **Drag & drop** a Markdown file onto the window
- **Find in document** (`Ctrl+F`), **open-file dialog** (`Ctrl+O`) and a **recent-files** list
- **YAML front matter** — the leading `---...---` block renders as a clean metadata card (title, description, date, tags, draft badge) instead of broken rules
- **Local relative-path images** — `![](images/x.png)` resolves and displays
- **Safe** — rendered HTML is sanitized with DOMPurify under a strict CSP, so opening an untrusted document won't run malicious scripts
- Light / dark theme follows the OS setting
- External links open in your default browser

## Download

Grab the latest build from the [**Releases**](https://github.com/craig7351/bookMDViewer/releases/latest) page:

| Platform | File |
| --- | --- |
| Windows (portable, no install) | `Markdown.Viewer_*_x64_portable.exe` |
| Windows (installer) | `Markdown.Viewer_*_x64-setup.exe` or `*_x64_en-US.msi` |
| macOS (Apple Silicon / Intel) | `*_aarch64.dmg` / `*_x64.dmg` |
| Linux | `*_amd64.AppImage`, `*_amd64.deb`, `*.x86_64.rpm` |

> The installer registers the `.md` file association (double-click to open). The
> portable build runs without installing but won't change file associations.
> All builds require the system WebView (WebView2 is preinstalled on Windows 11).

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+O` | Open a file |
| `Ctrl+F` | Find in document |
| `Ctrl+E` | Toggle edit / preview |
| `Ctrl+S` | Save |
| `Ctrl+\` | Toggle outline sidebar |
| `Ctrl++` / `Ctrl+-` | Increase / decrease font size (or the `A+` / `A−` buttons) |

## Launch flags

```bash
md-viewer.exe file.md            # open and render
md-viewer.exe file.md --edit     # open straight into edit mode
md-viewer.exe file.md --zoom=1.5 # scale the whole UI (high-DPI / accessibility)
```

## Develop

```bash
npm install
npm run tauri dev
```

## Build a local binary

```bash
npm run tauri build
```

Output (Windows): `src-tauri/target/release/md-viewer.exe` plus NSIS/MSI
installers under `src-tauri/target/release/bundle/`.

## Cross-platform releases

Push a version tag and GitHub Actions builds Windows / macOS (Intel + Apple
Silicon) / Linux installers — plus a portable Windows exe — and publishes them to
a release:

```bash
git tag v1.0.0
git push origin v1.0.0
```

See [.github/workflows/release.yml](.github/workflows/release.yml).
