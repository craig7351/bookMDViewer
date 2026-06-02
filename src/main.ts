import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";

// hljs theme CSS as strings, so HTML export can be fully self-contained.
import hljsLightCss from "highlight.js/styles/github.css?inline";
import hljsDarkCss from "highlight.js/styles/github-dark.css?inline";

const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

// Apply the matching highlight.js theme to the live app.
{
  const style = document.createElement("style");
  style.textContent = prefersDark ? hljsDarkCss : hljsLightCss;
  document.head.appendChild(style);
}

const md: MarkdownIt = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight: (str, lang) => {
    // Leave mermaid blocks untouched so we can render them lazily later.
    if (lang === "mermaid") {
      return `<pre class="mermaid">${md.utils.escapeHtml(str)}</pre>`;
    }
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${
          hljs.highlight(str, { language: lang }).value
        }</code></pre>`;
      } catch {
        /* fall through to plain escaping */
      }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(str)}</code></pre>`;
  },
}).use(taskLists, { enabled: true, label: true });

const content = document.getElementById("content") as HTMLElement;
const toc = document.getElementById("toc") as HTMLElement;
const layout = document.getElementById("layout") as HTMLElement;
const tocToggle = document.getElementById("toc-toggle") as HTMLButtonElement;
const editor = document.getElementById("editor") as HTMLTextAreaElement;
const editToggle = document.getElementById("edit-toggle") as HTMLButtonElement;
const saveBtn = document.getElementById("save-btn") as HTMLButtonElement;
const exportBtn = document.getElementById("export-btn") as HTMLButtonElement;
const closeModal = document.getElementById("close-modal") as HTMLElement;
const toastEl = document.getElementById("toast") as HTMLElement;
const appWindow = getCurrentWindow();
let currentPath: string | null = null;
let currentText = "";
let editMode = false;
let dirty = false;
let suppressReloadUntil = 0;
let mermaidLoaded = false;
let spy: IntersectionObserver | null = null;

// Build the left-hand outline from the rendered headings.
function buildToc(): void {
  spy?.disconnect();
  toc.innerHTML = "";
  const headings = Array.from(
    content.querySelectorAll<HTMLElement>("h1, h2, h3"),
  );

  if (headings.length < 2) {
    layout.classList.remove("has-toc");
    return;
  }
  layout.classList.add("has-toc");

  const links = new Map<string, HTMLAnchorElement>();
  headings.forEach((h, i) => {
    h.id = `h-${i}`;
    const a = document.createElement("a");
    a.href = `#h-${i}`;
    a.textContent = h.textContent ?? "";
    a.className = `toc-link toc-${h.tagName.toLowerCase()}`;
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      h.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    toc.appendChild(a);
    links.set(h.id, a);
  });

  // Scroll-spy: highlight the heading currently near the top.
  spy = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          toc.querySelector(".active")?.classList.remove("active");
          const link = links.get(e.target.id);
          link?.classList.add("active");
          link?.scrollIntoView({ block: "nearest" });
        }
      }
    },
    { root: content, rootMargin: "0px 0px -80% 0px", threshold: 0 },
  );
  headings.forEach((h) => spy!.observe(h));
}

async function renderMarkdown(
  text: string,
  preserveScroll = false,
): Promise<void> {
  const scrollTop = content.scrollTop;
  content.innerHTML = md.render(text);
  buildToc();

  // Lazily pull in mermaid only when a diagram is actually present.
  const diagrams = content.querySelectorAll<HTMLElement>("pre.mermaid");
  if (diagrams.length > 0) {
    const mermaid = (await import("mermaid")).default;
    if (!mermaidLoaded) {
      mermaid.initialize({
        startOnLoad: false,
        theme: prefersDark ? "dark" : "default",
        securityLevel: "strict",
      });
      mermaidLoaded = true;
    }
    try {
      await mermaid.run({ nodes: Array.from(diagrams) });
    } catch (e) {
      console.error("mermaid render failed", e);
    }
  }

  // New documents start at the top; only hot-reload / live-edit keep position.
  content.scrollTop = preserveScroll ? scrollTop : 0;
}

function setTitle(): void {
  const name = currentPath?.split(/[\\/]/).pop() ?? "Markdown Viewer";
  document.title = `${dirty ? "● " : ""}${name} — Markdown Viewer`;
  saveBtn.hidden = !editMode;
  saveBtn.disabled = !dirty;
  saveBtn.textContent = dirty ? "💾 Save*" : "💾 Saved";
}

async function openFile(
  path: string,
  watch = true,
  preserveScroll = false,
): Promise<void> {
  try {
    const text = await invoke<string>("read_md", { path });
    currentPath = path;
    currentText = text;
    dirty = false;
    if (editMode) editor.value = text;
    setTitle();
    await renderMarkdown(text, preserveScroll);
    if (watch) {
      await invoke("watch_file", { path });
    }
  } catch (e) {
    content.innerHTML = `<div class="empty-state"><p>${String(e)}</p></div>`;
    buildToc();
  }
}

// ---------- Edit mode + live preview ----------

let previewTimer: number | undefined;
function schedulePreview(): void {
  dirty = editor.value !== currentText;
  setTitle();
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(
    () => void renderMarkdown(editor.value, true),
    180,
  );
}

function setEditMode(on: boolean): void {
  editMode = on;
  layout.classList.toggle("mode-edit", on);
  editToggle.textContent = on ? "👁 Preview" : "✎ Edit";
  if (on) {
    editor.value = currentText;
    editor.focus();
  } else {
    // Leaving edit mode: render the latest source, keep position.
    void renderMarkdown(editor.value, true);
  }
  setTitle();
}

function toggleEdit(): void {
  setEditMode(!editMode);
}

async function save(): Promise<void> {
  if (!currentPath || !dirty) return;
  try {
    // Ignore the watcher event our own write is about to trigger.
    suppressReloadUntil = Date.now() + 1000;
    await invoke("write_md", { path: currentPath, content: editor.value });
    currentText = editor.value;
    dirty = false;
    setTitle();
  } catch (e) {
    console.error("save failed", e);
  }
}

editToggle.addEventListener("click", toggleEdit);
editor.addEventListener("input", schedulePreview);
saveBtn.addEventListener("click", () => void save());

// ---------- Toast ----------
let toastTimer: number | undefined;
function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true;
  }, 2800);
}

// ---------- Export to standalone HTML (with TOC sidebar) ----------
const EXPORT_CSS = `
:root{--bg:#fff;--fg:#1f2328;--muted:#59636e;--border:#d1d9e0;--code-bg:#f6f8fa;--accent:#0969da;--stripe:#f6f8fa}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--border:#30363d;--code-bg:#161b22;--accent:#4493f8;--stripe:#161b22}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;display:flex;align-items:flex-start}
.toc{flex:0 0 264px;width:264px;position:sticky;top:0;max-height:100vh;overflow:auto;padding:24px 12px 40px;border-right:1px solid var(--border);font-size:13.5px;line-height:1.5}
.toc a{display:block;padding:3px 10px;margin:1px 0;color:var(--muted);text-decoration:none;border-left:2px solid transparent;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.toc a:hover{color:var(--fg);background:var(--code-bg)}
.toc .l1{font-weight:600}.toc .l2{padding-left:22px}.toc .l3{padding-left:34px;font-size:13px}
.markdown-body{flex:1;min-width:0;max-width:860px;margin:0 auto;padding:32px 40px 80px;word-wrap:break-word}
.markdown-body h1,.markdown-body h2{border-bottom:1px solid var(--border);padding-bottom:.3em}
.markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4{margin-top:1.4em;margin-bottom:.6em;font-weight:600;line-height:1.25}
.markdown-body a{color:var(--accent);text-decoration:none}.markdown-body a:hover{text-decoration:underline}
.markdown-body code{background:var(--code-bg);padding:.2em .4em;border-radius:6px;font-size:85%;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.markdown-body pre{background:var(--code-bg);padding:16px;border-radius:8px;overflow:auto;line-height:1.45}
.markdown-body pre code{background:transparent;padding:0;font-size:90%}
.markdown-body blockquote{margin:0;padding:0 1em;color:var(--muted);border-left:4px solid var(--border)}
.markdown-body table{border-collapse:collapse;display:block;width:max-content;max-width:100%;overflow:auto;margin:1em 0}
.markdown-body th,.markdown-body td{border:1px solid var(--border);padding:6px 13px}
.markdown-body tr:nth-child(2n){background:var(--stripe)}
.markdown-body img{max-width:100%}
.markdown-body hr{border:none;border-top:1px solid var(--border);margin:1.6em 0}
.markdown-body .task-list-item{list-style:none}
.markdown-body .task-list-item input{margin:0 .4em .25em -1.4em}
.markdown-body pre.mermaid{background:transparent;text-align:center;padding:8px 0}
`;

function buildExportHtml(): string {
  // Clone so we don't mutate the live DOM.
  const article = content.cloneNode(true) as HTMLElement;
  const headings = Array.from(
    article.querySelectorAll<HTMLElement>("h1, h2, h3"),
  );

  let tocHtml = "";
  if (headings.length >= 2) {
    const items = headings
      .map((h, i) => {
        if (!h.id) h.id = `h-${i}`;
        const level = h.tagName.toLowerCase().replace("h", "l");
        const label = (h.textContent ?? "").replace(/[<>&]/g, "");
        return `<a class="${level}" href="#${h.id}">${label}</a>`;
      })
      .join("\n");
    tocHtml = `<nav class="toc">\n${items}\n</nav>\n`;
  }

  const title = currentPath?.split(/[\\/]/).pop()?.replace(/\.(md|markdown)$/i, "") ?? "Document";
  const themeCss = prefersDark ? hljsDarkCss : hljsLightCss;

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>${EXPORT_CSS}</style>
<style>${themeCss}</style>
</head>
<body>
${tocHtml}<article class="markdown-body">
${article.innerHTML}
</article>
</body>
</html>`;
}

async function exportHtml(): Promise<void> {
  if (!currentPath) {
    toast("沒有開啟的檔案");
    return;
  }
  // Make sure the preview reflects the latest source (e.g. while editing).
  if (editMode) await renderMarkdown(editor.value, true);

  const base = currentPath.replace(/\.(md|markdown)$/i, "");
  const out = `${base}.html`;
  try {
    await invoke("write_md", { path: out, content: buildExportHtml() });
    toast(`已匯出 ${out.split(/[\\/]/).pop()}`);
  } catch (e) {
    toast(`匯出失敗: ${String(e)}`);
  }
}

exportBtn.addEventListener("click", () => void exportHtml());

// ---------- Synced scrolling (editor <-> preview) ----------
let syncing = false;
function syncScroll(from: HTMLElement, to: HTMLElement): void {
  if (syncing || !editMode) return;
  syncing = true;
  const max = from.scrollHeight - from.clientHeight;
  const ratio = max > 0 ? from.scrollTop / max : 0;
  to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);
  requestAnimationFrame(() => {
    syncing = false;
  });
}
editor.addEventListener("scroll", () => syncScroll(editor, content));
content.addEventListener("scroll", () => syncScroll(content, editor));

// ---------- Close confirmation when there are unsaved changes ----------
function showCloseModal(): void {
  closeModal.hidden = false;
}
function hideCloseModal(): void {
  closeModal.hidden = true;
}
(document.getElementById("modal-cancel") as HTMLButtonElement).addEventListener(
  "click",
  hideCloseModal,
);
(document.getElementById("modal-discard") as HTMLButtonElement).addEventListener(
  "click",
  () => {
    dirty = false;
    hideCloseModal();
    void appWindow.destroy();
  },
);
(document.getElementById("modal-save") as HTMLButtonElement).addEventListener(
  "click",
  async () => {
    await save();
    hideCloseModal();
    void appWindow.destroy();
  },
);

// Collapse / expand the outline.
function toggleToc(): void {
  layout.classList.toggle("toc-collapsed");
}
tocToggle.addEventListener("click", toggleToc);
window.addEventListener("keydown", (ev) => {
  if (ev.ctrlKey && ev.key === "\\") {
    ev.preventDefault();
    toggleToc();
  } else if (ev.ctrlKey && (ev.key === "e" || ev.key === "E")) {
    ev.preventDefault();
    toggleEdit();
  } else if (ev.ctrlKey && (ev.key === "s" || ev.key === "S")) {
    ev.preventDefault();
    void save();
  }
});

// Open external links in the user's default browser instead of navigating
// the webview away from the document.
content.addEventListener("click", (ev) => {
  const anchor = (ev.target as HTMLElement).closest("a");
  if (anchor) {
    const href = anchor.getAttribute("href") ?? "";
    if (/^https?:\/\//i.test(href)) {
      ev.preventDefault();
      void openUrl(href);
    }
  }
});

async function init(): Promise<void> {
  // Hot reload when the watched file changes on disk. Skip while editing or
  // when the change came from our own save.
  await listen<string>("md-changed", () => {
    if (currentPath && !editMode && Date.now() > suppressReloadUntil) {
      void openFile(currentPath, false, true);
    }
  });

  // macOS delivers file-association opens at runtime.
  await listen<string>("open-file", (ev) => {
    void openFile(ev.payload);
  });

  // Drag-and-drop a .md file onto the window.
  await getCurrentWebview().onDragDropEvent((ev) => {
    if (ev.payload.type === "drop") {
      const file = ev.payload.paths.find((p) => /\.(md|markdown)$/i.test(p));
      if (file) {
        void openFile(file);
      }
    }
  });

  // Intercept window close when there are unsaved edits.
  await appWindow.onCloseRequested((event) => {
    if (dirty) {
      event.preventDefault();
      showCloseModal();
    }
  });

  // File the app was launched with (Windows / Linux association).
  const initial = await invoke<string | null>("get_initial_path");
  if (initial) {
    await openFile(initial);
    // Optional `--edit` flag opens straight into edit mode.
    if (await invoke<boolean>("start_in_edit")) {
      setEditMode(true);
    }
  }
}

void init();
