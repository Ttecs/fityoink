const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs   = require("fs");
const os   = require("os");

let mainWindow;
let core;

async function loadCore() {
  const fileUrl = `file:///${__dirname.replace(/\\/g, "/")}/core/downloader.mjs`;
  core = await import(fileUrl);
}

// ── Settings ──────────────────────────────────────────────────────────────────

const SETTINGS_FILE = path.join(app.getPath("userData"), "settings.json");
const DEFAULTS = {
  downloadDir: path.join(os.homedir(), "Downloads", "fitgirl"),
  sbrWs: "",
  triggerPct: 80,
};

function getSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")) }; } catch {}
  return { ...DEFAULTS };
}
function saveSettings(s) { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2)); }

// ── Per-download state map ────────────────────────────────────────────────────

const dlState = {};
// dlState[id] = { abort, resumeResolve, cancelled, filepath, cdnUrl, bytesDownloaded }

// ── Window ────────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1050, height: 720, minWidth: 800, minHeight: 580,
    title: "FitYoink",
    backgroundColor: "#0f0f1a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(async () => { await loadCore(); createWindow(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

// ── IPC: settings ─────────────────────────────────────────────────────────────

ipcMain.handle("get-settings", () => getSettings());
ipcMain.handle("save-settings", (_, s) => {
  saveSettings(s);
  core.setConfig({ sbrWs: s.sbrWs, triggerPct: s.triggerPct });
});
ipcMain.handle("choose-folder", async () => {
  const r = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle("open-folder", (_, p) => shell.openPath(p));

// ── Paste link extraction (paste.fitgirl-repacks.site CryptPad) ──────────────

function fetchLinksFromPaste(pasteUrl) {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, javascript: true } });
    const cleanup = () => { try { win.close(); } catch {} };

    win.loadURL(pasteUrl);

    const DOWNLOAD_HOST_RE = /https?:\/\/(?:datanodes\.to|buzzheavier\.com|gofile\.io|pixeldrain\.com|1fichier\.com|mediafire\.com|fuckingfast\.co)[^\s"'<>\]]+/gi;

    const tryExtract = async () => {
      try {
        const text = await win.webContents.executeJavaScript(`document.body.innerText`);
        const matches = [...text.matchAll(DOWNLOAD_HOST_RE)].map(m => m[0]);
        const unique = [...new Set(matches)];
        if (unique.length) return unique;
      } catch {}
      return [];
    };

    win.webContents.once("did-finish-load", async () => {
      try {
        // CryptPad decrypts content via JS — poll until links appear, up to 20s
        let found = [];
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 1000));
          found = await tryExtract();
          if (found.length) break;
        }
        cleanup();
        if (!found.length) return reject(new Error("No download links found in paste — make sure the paste URL is correct"));
        resolve(found.map(url => {
          const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "unknown"; } })();
          const filename = url.split("/").pop().split("?")[0] || url;
          return { url, filename, host };
        }));
      } catch (e) { cleanup(); reject(e); }
    });

    win.webContents.once("did-fail-load", (_, code, desc) => {
      cleanup(); reject(new Error(`Failed to load paste: ${desc}`));
    });

    setTimeout(() => { cleanup(); reject(new Error("Timed out loading paste page")); }, 45_000);
  });
}

// ── Remote link extraction — CDP network intercept + real button click ────────

function fetchLinksRemote(gamePageUrl) {
  return new Promise((resolve, reject) => {
    const ORIGIN = "https://fitgirl-download-link-extractor.vercel.app";
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });

    const cleanup = () => {
      try { win.webContents.debugger.detach(); } catch {}
      try { win.close(); } catch {}
    };

    // Attach CDP to capture network response body directly
    let capturedRequestId = null;
    let raw = null;
    try {
      win.webContents.debugger.attach("1.3");
      win.webContents.debugger.sendCommand("Network.enable");
      win.webContents.debugger.on("message", async (_e, method, params) => {
        try {
          if (method === "Network.responseReceived") {
            if ((params.response?.url || "").includes("extract-remote"))
              capturedRequestId = params.requestId;
          }
          if (method === "Network.loadingFinished" && params.requestId === capturedRequestId) {
            const body = await win.webContents.debugger.sendCommand(
              "Network.getResponseBody", { requestId: capturedRequestId }
            );
            raw = body.base64Encoded ? Buffer.from(body.body, "base64").toString() : body.body;
          }
        } catch {}
      });
    } catch {}

    win.webContents.once("did-finish-load", async () => {
      try {
        // Wait for React hydration
        await new Promise(r => setTimeout(r, 2500));

        // Poll for an input/textarea to appear
        let filled = false;
        for (let i = 0; i < 10; i++) {
          filled = await win.webContents.executeJavaScript(`
            (() => {
              const el = document.querySelector('input, textarea');
              if (!el) return false;
              const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (setter) setter.call(el, ${JSON.stringify(gamePageUrl)});
              else el.value = ${JSON.stringify(gamePageUrl)};
              el.dispatchEvent(new Event('input',  { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            })()
          `).catch(() => false);
          if (filled) break;
          await new Promise(r => setTimeout(r, 1000));
        }
        if (!filled) {
          const html = await win.webContents.executeJavaScript(`document.body.innerHTML.slice(0,600)`).catch(() => "");
          throw new Error(`Could not find URL input on extractor page.\nHTML: ${html}`);
        }

        await new Promise(r => setTimeout(r, 400));

        // Click the submit button
        await win.webContents.executeJavaScript(`
          (() => {
            const btn = document.querySelector('button[type="submit"]')
                     || document.querySelector('form button')
                     || [...document.querySelectorAll('button')].find(b => /fetch|extract|get|submit/i.test(b.textContent))
                     || document.querySelector('button');
            if (btn) btn.click();
          })()
        `);

        // Wait for CDP to capture the API response (up to 45s)
        for (let i = 0; i < 45; i++) {
          await new Promise(r => setTimeout(r, 1000));
          if (raw) break;
        }

        cleanup();
        if (!raw) return reject(new Error("Timed out — extractor API did not respond. Try again."));

        // Parse SSE
        let links = null;
        for (const line of raw.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            const json = JSON.parse(payload);
            const arr = Array.isArray(json)       ? json
                      : Array.isArray(json.data)  ? json.data
                      : Array.isArray(json.links) ? json.links
                      : null;
            if (arr && arr.length) { links = arr; break; }
          } catch {}
        }

        if (!links || !links.length) {
          const preview = raw.slice(0, 400).replace(/\n/g, " ↵ ");
          return reject(new Error(`No links found.\nAPI response: ${preview || "(empty)"}`));
        }

        resolve(links.map(item => {
          const url = item.url;
          const host = (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "unknown"; } })();
          return { url, filename: item.filename || url.split("/").pop(), host };
        }));
      } catch (e) { cleanup(); reject(e); }
    });

    win.webContents.once("did-fail-load", (_, code, desc) => {
      cleanup(); reject(new Error(`Page load failed: ${desc}`));
    });

    setTimeout(() => { cleanup(); reject(new Error("Timed out loading extractor page")); }, 70_000);

    win.loadURL(ORIGIN);
  });
}

// ── Datanodes from game page: find paste URL → extract links from paste ───────

async function fetchDatanodesFromGamePage(gamePageUrl) {
  // Step 1: load game page, grab paste.fitgirl-repacks.site links (or direct datanodes links)
  const pasteUrls = await new Promise((resolve, reject) => {
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
    const cleanup = () => { try { win.close(); } catch {} };

    win.webContents.once("did-finish-load", async () => {
      try {
        await new Promise(r => setTimeout(r, 1500));
        const results = await win.webContents.executeJavaScript(`
          (() => {
            const paste = [...document.querySelectorAll('a[href*="paste.fitgirl-repacks.site"]')].map(a => a.href);
            const direct = [...document.querySelectorAll('a[href*="datanodes.to"]')].map(a => a.href);
            return JSON.stringify({ paste, direct });
          })()
        `);
        cleanup();
        resolve(JSON.parse(results));
      } catch (e) { cleanup(); reject(e); }
    });
    win.webContents.once("did-fail-load", (_, c, desc) => { cleanup(); reject(new Error("Failed to load game page: " + desc)); });
    setTimeout(() => { cleanup(); reject(new Error("Timed out loading game page")); }, 30_000);
    win.loadURL(gamePageUrl);
  });

  // Step 2: if direct datanodes links found, return them
  if (pasteUrls.direct.length) {
    return pasteUrls.direct.map(url => ({
      url,
      filename: url.split("/").pop().split("?")[0] || url,
      host: "datanodes.to",
    }));
  }

  if (!pasteUrls.paste.length) {
    throw new Error("No datanodes or paste links found on this game page");
  }

  // Step 3: load the paste and extract download links
  return fetchLinksFromPaste(pasteUrls.paste[0]);
}

// ── IPC: fetch links ──────────────────────────────────────────────────────────

ipcMain.handle("fetch-links", async (_, inputUrl, mode) => {
  const s = getSettings();
  core.setConfig({ sbrWs: s.sbrWs, triggerPct: s.triggerPct });

  let hostname;
  try { hostname = new URL(inputUrl).hostname; }
  catch { throw new Error("Invalid URL"); }

  // Paste URL — always extract from paste regardless of mode
  if (hostname === "paste.fitgirl-repacks.site") {
    return fetchLinksFromPaste(inputUrl);
  }

  if (hostname !== "fitgirl-repacks.site" && hostname !== "www.fitgirl-repacks.site") {
    throw new Error("Please enter a fitgirl-repacks.site game page URL");
  }

  if (mode === "datanodes") return fetchDatanodesFromGamePage(inputUrl);
  return fetchLinksRemote(inputUrl); // fuckingfast (default)
});

// ── Download runner ───────────────────────────────────────────────────────────

async function runDownload(id, i, url, downloadDir, send) {
  const state = { abort: null, resumeResolve: null, cancelled: false, filepath: null, cdnUrl: null, bytesDownloaded: 0 };
  dlState[id] = state;

  // ── Resolve ──────────────────────────────────────────────────────────────
  send({ id, i, status: "resolving" });
  try {
    state.cdnUrl = await core.resolveDirectUrl(url, `[${i + 1}]`);
  } catch {
    send({ id, i, status: "failed", error: "Could not resolve link" });
    return;
  }
  if (state.cancelled) return;

  // ── Download loop (handles pause → resume) ───────────────────────────────
  send({ id, i, status: "downloading", cdnUrl: state.cdnUrl });

  while (true) {
    const startByte = state.filepath && fs.existsSync(state.filepath)
      ? fs.statSync(state.filepath).size
      : 0;

    const { at80, done, abort } = core.downloadFile(
      state.cdnUrl, downloadDir,
      prog => {
        state.bytesDownloaded = prog.downloaded;
        state.filepath        = prog.filepath;
        send({ id, i, status: "downloading", ...prog });
      },
      startByte
    );
    state.abort = abort;

    const result = await done;

    if (result.paused) {
      if (state.cancelled) {
        if (state.filepath && fs.existsSync(state.filepath)) {
          try { fs.unlinkSync(state.filepath); } catch {}
        }
        send({ id, i, status: "cancelled" });
        break;
      }
      send({ id, i, status: "paused", bytesDownloaded: result.bytesDownloaded });
      await new Promise(r => { state.resumeResolve = r; });
      state.resumeResolve = null;
      if (state.cancelled) {
        if (state.filepath && fs.existsSync(state.filepath)) {
          try { fs.unlinkSync(state.filepath); } catch {}
        }
        send({ id, i, status: "cancelled" });
        break;
      }
      send({ id, i, status: "downloading", cdnUrl: state.cdnUrl });
      continue;
    }

    send({ id, i, status: "complete", filename: result.filename, filepath: result.filepath, downloadDir });
    break;
  }

  delete dlState[id];
}

// ── IPC: start downloads ──────────────────────────────────────────────────────

ipcMain.handle("start-downloads", async (event, { urls, downloadDir }) => {
  const s = getSettings();
  core.setConfig({ sbrWs: s.sbrWs, triggerPct: s.triggerPct });
  fs.mkdirSync(downloadDir, { recursive: true });

  const send = data => { try { event.sender.send("dl-progress", data); } catch {} };

  for (let i = 0; i < urls.length; i++) {
    await runDownload(`dl-${i}`, i, urls[i], downloadDir, send);
  }
  send({ status: "all-done" });
});

// ── IPC: pause / resume / cancel ─────────────────────────────────────────────

ipcMain.handle("pause-download", (_, id) => {
  const s = dlState[id];
  if (s?.abort) s.abort();
});

ipcMain.handle("resume-download", (_, id) => {
  const s = dlState[id];
  if (s?.resumeResolve) s.resumeResolve();
});

ipcMain.handle("cancel-download", (_, id) => {
  const s = dlState[id];
  if (!s) return;
  s.cancelled = true;
  if (s.abort)          s.abort();
  if (s.resumeResolve)  s.resumeResolve();
});
