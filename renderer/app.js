// ── State ─────────────────────────────────────────────────────────────────────
let links    = [];   // [{url, filename, host}]
let selected = new Set();
let settings = {};
let downloading = false;

function checkBrdWarning() {
  const banner = $("brd-banner");
  if (!settings.sbrWs || !settings.sbrWs.trim()) {
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const pasteInput  = $("paste-url");
const btnFetch    = $("btn-fetch");
const fetchStatus = $("fetch-status");
const filesCard   = $("files-card");
const fileList    = $("file-list");
const fileCount   = $("file-count");
const btnSelAll   = $("btn-select-all");
const dlBar       = $("dl-bar");
const dlDirInput  = $("dl-dir");
const btnBrowse   = $("btn-browse");
const btnDownload = $("btn-download");
const queue       = $("queue");
const overlay     = $("modal-overlay");
const btnSettings = $("btn-settings");
const btnCloseM   = $("btn-close-modal");
const btnSave     = $("btn-save-settings");
const btnCancel   = $("btn-cancel-settings");
const sBrowse     = $("s-browse");

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  settings = await window.api.getSettings();
  dlDirInput.value = settings.downloadDir;
  window.api.onProgress(handleProgress);
  checkBrdWarning();
  $("brd-banner-btn").onclick = () => openSettings(true);
})();

// ── Download action delegation ────────────────────────────────────────────────
document.addEventListener("click", e => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const { action, id, path: p } = btn.dataset;
  if (action === "open-folder") window.api.openFolder(p);
  else if (action === "pause")  window.api.pauseDownload(id);
  else if (action === "resume") window.api.resumeDownload(id);
  else if (action === "cancel") window.api.cancelDownload(id);
});

// ── Settings modal ────────────────────────────────────────────────────────────
function openSettings(focusBrd = false) {
  $("s-dl-dir").value  = settings.downloadDir;
  $("s-sbr-ws").value  = settings.sbrWs || "";
  $("s-trigger").value = settings.triggerPct || 80;
  overlay.classList.remove("hidden");
  if (focusBrd) {
    const f = $("s-sbr-ws");
    f.classList.add("input-warn");
    setTimeout(() => { f.focus(); f.select(); }, 80);
  }
}
btnSettings.onclick = () => openSettings();
btnCloseM.onclick = btnCancel.onclick = () => overlay.classList.add("hidden");
overlay.onclick = e => { if (e.target === overlay) overlay.classList.add("hidden"); };

sBrowse.onclick = async () => {
  const p = await window.api.chooseFolder();
  if (p) $("s-dl-dir").value = p;
};

btnSave.onclick = async () => {
  settings = {
    downloadDir: $("s-dl-dir").value.trim() || settings.downloadDir,
    sbrWs:       $("s-sbr-ws").value.trim(),
    triggerPct:  parseInt($("s-trigger").value) || 80,
  };
  await window.api.saveSettings(settings);
  dlDirInput.value = settings.downloadDir;
  $("s-sbr-ws").classList.remove("input-warn");
  overlay.classList.add("hidden");
  checkBrdWarning();
};

// ── Browse download folder ────────────────────────────────────────────────────
btnBrowse.onclick = async () => {
  const p = await window.api.chooseFolder();
  if (p) { dlDirInput.value = p; settings.downloadDir = p; }
};

// ── Fetch links ───────────────────────────────────────────────────────────────
btnFetch.onclick = fetchLinks;
pasteInput.addEventListener("keydown", e => { if (e.key === "Enter") fetchLinks(); });

async function fetchLinks() {
  const url = pasteInput.value.trim();
  if (!url) return;
  btnFetch.disabled = true;
  setStatus("fetch-status", "⏳ Opening paste in browser...", "");
  try {
    links = await window.api.fetchLinks(url);
    if (!links.length) { setStatus("fetch-status", "No links found in this paste.", "error"); return; }
    renderFileList();
    filesCard.style.display = "";
    dlBar.style.display = "";
    setStatus("fetch-status", `Found ${links.length} link(s).`, "success");
  } catch (err) {
    setStatus("fetch-status", "❌ " + err.message, "error");
  } finally {
    btnFetch.disabled = false;
  }
}

// ── File list rendering ───────────────────────────────────────────────────────
function renderFileList() {
  fileList.innerHTML = "";
  selected.clear();
  links.forEach((link, i) => {
    selected.add(i);
    const item = document.createElement("div");
    item.className = "file-item selected";
    item.dataset.i = i;
    item.innerHTML = `
      <input type="checkbox" checked data-i="${i}" />
      <div class="file-info">
        <div class="file-name" title="${escHtml(link.url)}">${escHtml(link.filename)}</div>
        <div class="file-host">${escHtml(link.host)}</div>
      </div>`;
    item.onclick = e => { if (e.target.tagName !== "INPUT") toggleItem(i, item); };
    item.querySelector("input").onchange = e => toggleItem(i, item, e.target.checked);
    fileList.appendChild(item);
  });
  updateFileCount();
}

function toggleItem(i, el, force) {
  const on = force !== undefined ? force : !selected.has(i);
  if (on) selected.add(i); else selected.delete(i);
  el.classList.toggle("selected", on);
  el.querySelector("input").checked = on;
  updateFileCount();
}

function updateFileCount() {
  fileCount.textContent = `${selected.size}/${links.length}`;
  btnDownload.disabled = selected.size === 0 || downloading;
}

btnSelAll.onclick = () => {
  const allSelected = selected.size === links.length;
  document.querySelectorAll(".file-item").forEach((el, i) => toggleItem(i, el, !allSelected));
};

// ── Download ──────────────────────────────────────────────────────────────────
btnDownload.onclick = startDownload;

function startDownload() {
  if (downloading || !selected.size) return;
  downloading = true;
  btnDownload.disabled = true;

  const selectedUrls = [...selected].sort((a, b) => a - b).map(i => links[i].url);
  const downloadDir  = dlDirInput.value.trim() || settings.downloadDir;

  // Clear old queue and seed items
  queue.innerHTML = "";
  selectedUrls.forEach((url, i) => {
    const link = links[[...selected].sort((a,b)=>a-b)[i]];
    createQueueItem(`dl-${i}`, link.filename, link.host);
  });

  window.api.offProgress();
  window.api.onProgress(handleProgress);
  window.api.startDownloads(selectedUrls, downloadDir);
}

function createQueueItem(id, filename, host) {
  const el = document.createElement("div");
  el.className = "dl-item resolving";
  el.id = `qi-${id}`;
  el.innerHTML = `
    <div class="dl-top">
      <span class="dl-name" title="${escHtml(filename)}">${escHtml(filename)}</span>
      <span class="dl-badge badge-resolving" id="badge-${id}">Resolving</span>
    </div>
    <div class="dl-bar-wrap" id="barwrap-${id}" style="display:none">
      <div class="dl-bar-fill" id="bar-${id}" style="width:0%"></div>
    </div>
    <div class="dl-stats" id="stats-${id}">
      <span><span class="spinner"></span> Resolving link...</span>
      <span></span>
    </div>
    <div class="dl-action" id="action-${id}"></div>`;
  queue.appendChild(el);
}

function handleProgress(d) {
  if (d.status === "all-done") {
    downloading = false;
    btnDownload.disabled = false;
    return;
  }

  const id      = d.id;
  const el      = document.getElementById(`qi-${id}`);
  const badge   = document.getElementById(`badge-${id}`);
  const barwrap = document.getElementById(`barwrap-${id}`);
  const bar     = document.getElementById(`bar-${id}`);
  const stats   = document.getElementById(`stats-${id}`);
  const action  = document.getElementById(`action-${id}`);
  if (!el) return;

  if (d.status === "resolving") {
    el.className = "dl-item resolving";
    badge.className = "dl-badge badge-resolving";
    badge.textContent = "Resolving";
    stats.innerHTML = `<span><span class="spinner"></span> Connecting to host...</span><span></span>`;
  }

  else if (d.status === "downloading") {
    el.className = "dl-item";
    badge.className = "dl-badge badge-downloading";
    badge.textContent = "Downloading";
    barwrap.style.display = "";
    const pct = d.pct ? d.pct.toFixed(1) : "0.0";
    bar.style.width = pct + "%";
    const dl  = d.downloaded ? fmtBytes(d.downloaded) : "–";
    const tot = d.total      ? fmtBytes(d.total)      : "–";
    stats.innerHTML = `<span>${pct}%</span><span>${dl} / ${tot}</span>`;
    action.innerHTML = `
      <button class="btn btn-ghost btn-sm" data-action="pause" data-id="${escHtml(id)}">Pause</button>
      <button class="btn btn-danger btn-sm" data-action="cancel" data-id="${escHtml(id)}">Cancel</button>`;
  }

  else if (d.status === "paused") {
    el.className = "dl-item paused";
    badge.className = "dl-badge badge-paused";
    badge.textContent = "Paused";
    const dl = d.bytesDownloaded ? fmtBytes(d.bytesDownloaded) : "–";
    stats.innerHTML = `<span>Paused · ${dl} downloaded</span><span></span>`;
    action.innerHTML = `
      <button class="btn btn-accent btn-sm" data-action="resume" data-id="${escHtml(id)}">Resume</button>
      <button class="btn btn-danger btn-sm" data-action="cancel" data-id="${escHtml(id)}">Cancel</button>`;
  }

  else if (d.status === "cancelled") {
    el.className = "dl-item failed";
    badge.className = "dl-badge badge-failed";
    badge.textContent = "Cancelled";
    stats.innerHTML = `<span style="color:var(--error)">Cancelled</span><span></span>`;
    action.innerHTML = "";
  }

  else if (d.status === "complete") {
    el.className = "dl-item complete";
    badge.className = "dl-badge badge-complete";
    badge.textContent = "Done";
    barwrap.style.display = "";
    bar.style.width = "100%";
    stats.innerHTML = `<span>✓ ${escHtml(d.filename || "")}</span><span></span>`;
    const btn = document.createElement("button");
    btn.className = "btn btn-ghost btn-sm";
    btn.dataset.action = "open-folder";
    btn.dataset.path = d.downloadDir;
    btn.textContent = "Open Folder";
    action.innerHTML = "";
    action.appendChild(btn);
  }

  else if (d.status === "failed") {
    el.className = "dl-item failed";
    badge.className = "dl-badge badge-failed";
    badge.textContent = "Failed";
    stats.innerHTML = `<span style="color:var(--error)">${escHtml(d.error || "Unknown error")}</span><span></span>`;
    action.innerHTML = "";
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setStatus(id, msg, cls) {
  const el = $(id);
  el.textContent = msg;
  el.className = "status-text" + (cls ? " " + cls : "");
}

function fmtBytes(b) {
  if (!b) return "0 B";
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / 1024 ** i).toFixed(1) + " " + ["B","KB","MB","GB"][i];
}

function escHtml(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
