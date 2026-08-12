import { chromium } from "playwright-core";
import https from "https";
import http from "http";
import fs from "fs";
import path from "path";
import { URL } from "url";

// Runtime config — updated by setConfig() from main process
let config = {
  sbrWs:      "",
  resolveMs:  180_000,
  minFileMb:  0.5,
  triggerPct: 80,
};
export function setConfig(c) { Object.assign(config, c); }

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const FILE_EXT_RE = /\.(rar|zip|7z|iso|part\d*|exe|msi|bin|tar|gz)(\?.*)?$/i;

// ── Utilities ─────────────────────────────────────────────────────────────────

export function fmtBytes(b) {
  if (!b) return "0 B";
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / 1024 ** i).toFixed(1) + " " + ["B","KB","MB","GB"][i];
}

function filenameFrom(url, cd) {
  if (cd) {
    const m = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
    if (m) return decodeURIComponent(m[1].trim());
  }
  try {
    const u = new URL(url);
    const frag = u.hash.replace(/^#/, "");
    if (frag && FILE_EXT_RE.test(frag)) return decodeURIComponent(frag);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length) return decodeURIComponent(parts.at(-1));
  } catch {}
  return `file_${Date.now()}`;
}

function looksLikeFileUrl(url) {
  try { return FILE_EXT_RE.test(new URL(url).pathname); } catch { return false; }
}

function nodeReq(method, rawUrl, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const go = (url, hops) => {
      if (hops > 12) return reject(new Error("Too many redirects"));
      let u;
      try { u = new URL(url); } catch { return reject(new Error("Bad URL: " + url)); }
      const lib = u.protocol === "https:" ? https : http;
      const req = lib.request({
        method, hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        headers: { "User-Agent": UA, ...extraHeaders },
      }, res => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
          res.resume(); go(new URL(res.headers.location, url).href, hops + 1);
        } else { resolve({ res, finalUrl: url }); }
      });
      req.on("error", reject); req.end();
    };
    go(rawUrl, 0);
  });
}

// ── Step 1: Extract links via remote API ──────────────────────────────────────


// ── Host resolvers ────────────────────────────────────────────────────────────

async function browserResolve(pageUrl, interactFn, label) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ acceptDownloads: true, userAgent: UA });
    const page    = await context.newPage();
    let capturedUrl = null;

    page.on("response", async res => {
      if (capturedUrl) return;
      try {
        const cd  = res.headers()["content-disposition"] || "";
        const len = parseInt(res.headers()["content-length"] || "0", 10);
        if (cd.includes("attachment") && (len === 0 || len >= config.minFileMb * 1024 * 1024)) {
          capturedUrl = res.url(); return;
        }
        const ct = res.headers()["content-type"] || "";
        if (ct.includes("application/json")) {
          const body = await res.text().catch(() => "");
          const m = body.match(/["'](https?:\/\/[^"']+)/g);
          if (m) {
            const fileLink = m.map(s => s.replace(/^["']/, "")).find(looksLikeFileUrl);
            if (fileLink) capturedUrl = fileLink;
          }
        }
      } catch {}
    });

    const dlPromise = page.waitForEvent("download", { timeout: config.resolveMs }).catch(() => null);
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

    const domLinks = await page.$$eval("a[href]", (els, re) => {
      const rx = new RegExp(re, "i");
      return els.map(e => e.href).filter(h => h.startsWith("http") && rx.test(new URL(h).pathname));
    }, FILE_EXT_RE.source).catch(() => []);
    if (domLinks.length) { await browser.close(); return domLinks[0]; }

    await interactFn(page, context, label);

    const dl = await Promise.race([dlPromise, new Promise(r => setTimeout(r, config.resolveMs, null))]);
    if (dl) { const u = dl.url(); await dl.cancel().catch(() => {}); await browser.close(); return u; }
    if (capturedUrl) { await browser.close(); return capturedUrl; }
    throw new Error("Could not find download URL for " + pageUrl);
  } catch (err) { await browser.close().catch(() => {}); throw err; }
}

async function resolveFuckingFast(pageUrl, label) {
  const fileId = new URL(pageUrl).pathname.replace(/^\/+/, "").split("/")[0];
  const browser = await chromium.connectOverCDP(config.sbrWs);
  try {
    const context = await browser.newContext();
    const page    = await context.newPage();
    let resolvedUrl = null;

    page.on("response", async res => {
      if (resolvedUrl) return;
      try {
        if (!res.url().includes(`/f/${fileId}/go`)) return;
        const headers = res.headers();
        for (const h of ["hx-redirect", "hx-location", "location"]) {
          const val = headers[h];
          if (val) { resolvedUrl = val.startsWith("http") ? val : `https://fuckingfast.co${val}`; return; }
        }
        const body = await res.text().catch(() => "");
        try {
          const j = JSON.parse(body);
          const u = j.url || j.download_url || j.link || j.redirect;
          if (u?.startsWith("http")) { resolvedUrl = u; return; }
        } catch {}
        const m = body.match(/https?:\/\/(?!challenges\.cloudflare\.com)[^\s"'<>,]+/);
        if (m && looksLikeFileUrl(m[0])) resolvedUrl = m[0];
      } catch {}
    });
    context.on("page", async popup => { try { await popup.close().catch(() => {}); } catch {} });

    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    let token = null;
    for (let i = 0; i < 30; i++) {
      token = await page.evaluate(() => window.turnstileToken || null).catch(() => null);
      if (token) break;
      await page.waitForTimeout(1000);
    }
    const dlEl = page.locator(":text-is('DOWNLOAD')").first();
    await dlEl.waitFor({ state: "visible", timeout: 15_000 });
    await dlEl.click().catch(() => {});
    await page.waitForTimeout(2000);
    if (resolvedUrl) { await browser.close(); return resolvedUrl; }
    await dlEl.click().catch(() => {});
    for (let i = 0; i < 10 && !resolvedUrl; i++) await page.waitForTimeout(1000);
    await browser.close();
    if (resolvedUrl) return resolvedUrl;
    throw new Error("fuckingfast: could not capture CDN URL");
  } catch (err) { await browser.close().catch(() => {}); throw err; }
}

function resolvePixelDrain(url) {
  const id = new URL(url).pathname.replace(/^\/(u|l)\//, "").split("/")[0];
  return Promise.resolve(`https://pixeldrain.com/api/file/${id}?download`);
}

async function resolveGoFile(url) {
  const id = new URL(url).pathname.split("/").pop();
  const tr = await fetch("https://api.gofile.io/accounts", {
    method: "POST", headers: { "Content-Type": "application/json" },
  }).then(r => r.json()).catch(() => ({}));
  const token = tr?.data?.token;
  const r = await fetch(`https://api.gofile.io/contents/${id}?wt=4fd6sg89d7s6&cache=true`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} }).then(r => r.json());
  if (r.status !== "ok") throw new Error("GoFile: " + r.status);
  const file = Object.values(r.data?.children ?? {}).find(c => c.type === "file");
  if (!file) throw new Error("GoFile: no files in folder");
  return file.link;
}

function resolve1Fichier(url, label) {
  return browserResolve(url, async (page) => {
    const btn = page.locator('input[type=submit], form button[type=submit]').first();
    if (await btn.count() > 0) await btn.click().catch(() => {});
  }, label);
}

function resolveBuzzheavier(url, label) {
  return browserResolve(url, async (page) => {
    const btn = page.locator('a:has-text("Download"), button:has-text("Download")').first();
    if (await btn.count() > 0) await btn.click().catch(() => {});
  }, label);
}

async function resolveDatanodes(url, label) {
  const browser = await chromium.connectOverCDP(config.sbrWs);
  try {
    const context = await browser.newContext();
    const page    = await context.newPage();
    let resolvedUrl = null;

    page.on("response", async res => {
      try {
        const ct  = res.headers()["content-type"] || "";
        const cd  = res.headers()["content-disposition"] || "";
        const len = res.headers()["content-length"] || "0";
        const st  = res.status();
        if (resolvedUrl) return;
        if (cd.includes("attachment") ||
            (ct.match(/^application\/(octet-stream|zip|x-rar|x-7z)/) && parseInt(len) > 100_000)) {
          resolvedUrl = res.url(); return;
        }
        if (ct.includes("json")) {
          const body = await res.text().catch(() => "");
          try {
            const j = JSON.parse(body);
            let u = j.url || j.download_url || j.link || j.direct || j.file;
            if (u) { try { u = decodeURIComponent(u); } catch {} if (u.startsWith("http")) { resolvedUrl = u; return; } }
          } catch {}
          const m = body.match(/https?:\/\/[^\s"'<>]+/g);
          if (m) { const hit = m.find(looksLikeFileUrl); if (hit) resolvedUrl = hit; }
        }
        if (st >= 300 && st < 400) {
          const loc = res.headers()["location"] || "";
          if (loc.startsWith("http") && looksLikeFileUrl(loc)) resolvedUrl = loc;
        }
      } catch {}
    });

    let adClickDone = false;
    context.on("page", async popup => {
      try {
        if (!adClickDone) { await popup.close().catch(() => {}); }
        else {
          const popupUrl = popup.url();
          if (popupUrl?.startsWith("http") && looksLikeFileUrl(popupUrl)) resolvedUrl = popupUrl;
          else {
            await popup.waitForNavigation({ timeout: 10_000 }).catch(() => {});
            const navUrl = popup.url();
            if (navUrl?.startsWith("http") && looksLikeFileUrl(navUrl)) resolvedUrl = navUrl;
          }
          await popup.close().catch(() => {});
        }
      } catch {}
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const freeBtn = page.locator('a:has-text("Free Download"), button:has-text("Free Download")').first();
    await freeBtn.waitFor({ state: "visible", timeout: 60_000 });
    await freeBtn.click().catch(() => {});
    await page.waitForTimeout(2000);
    adClickDone = true;
    await page.waitForTimeout(20_000);
    const startBtn = page.locator('button:has-text("Start Download")').first();
    await startBtn.click().catch(() => {});
    for (let i = 0; i < 15 && !resolvedUrl; i++) await page.waitForTimeout(1000);
    await browser.close();
    if (resolvedUrl) return resolvedUrl;
    throw new Error("datanodes: could not capture CDN URL");
  } catch (err) { await browser.close().catch(() => {}); throw err; }
}

function resolveMediaFire(url, label) {
  return browserResolve(url, async (page) => {
    await page.waitForSelector("#downloadButton, .dl-btn-label", { timeout: 10_000 }).catch(() => {});
    const btn = page.locator("#downloadButton, .dl-btn-label").first();
    if (await btn.count() > 0) await btn.click().catch(() => {});
  }, label);
}

async function resolveGeneric(url) {
  try {
    const { res } = await nodeReq("HEAD", url);
    const cd = res.headers["content-disposition"] || ""; res.resume();
    if (cd.includes("attachment")) return url;
  } catch {}
  return browserResolve(url, async (page) => {
    await page.waitForTimeout(2000);
    const btn = page.locator('a[download], a:has-text("Download"), button:has-text("Download"), input[type=submit]').first();
    if (await btn.count() > 0) await btn.click().catch(() => {});
    else await page.waitForTimeout(5000);
  }, "");
}

export function resolveDirectUrl(url, label) {
  const host = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } })();
  if (host === "dl.fuckingfast.co")     return Promise.resolve(url); // already a CDN URL
  if (host.includes("fuckingfast.co"))  return resolveFuckingFast(url, label);
  if (host.includes("pixeldrain.com"))  return resolvePixelDrain(url);
  if (host.includes("gofile.io"))       return resolveGoFile(url);
  if (host.includes("1fichier.com"))    return resolve1Fichier(url, label);
  if (host.includes("buzzheavier.com")) return resolveBuzzheavier(url, label);
  if (host.includes("datanodes.to"))    return resolveDatanodes(url, label);
  if (host.includes("mediafire.com"))   return resolveMediaFire(url, label);
  return resolveGeneric(url);
}

// ── Download with progress callback ──────────────────────────────────────────

// startByte > 0 → sends Range header and appends to existing partial file
export function downloadFile(directUrl, destDir, onProgress, startByte = 0) {
  let resolve80;
  const at80 = new Promise(r => { resolve80 = r; });
  const abortRef = { fn: null };

  const done = new Promise((resolve, reject) => {
    const headers = startByte > 0 ? { Range: `bytes=${startByte}-` } : {};
    nodeReq("GET", directUrl, headers).then(({ res, finalUrl }) => {
      if (res.statusCode < 200 || res.statusCode >= 400) {
        res.resume(); resolve80();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const filename   = filenameFrom(finalUrl, res.headers["content-disposition"]);
      const filepath   = path.join(destDir, filename);
      const contentLen = parseInt(res.headers["content-length"] || "0", 10);
      const totalBytes = startByte + contentLen;
      let downloaded   = startByte;
      let triggered    = false;

      const file = fs.createWriteStream(filepath, { flags: startByte > 0 ? "a" : "w" });

      abortRef.fn = () => {
        res.destroy();
        file.end();
        resolve({ filename, filepath, paused: true, bytesDownloaded: downloaded });
        resolve80();
      };

      res.on("data", chunk => {
        downloaded += chunk.length;
        const pct = totalBytes > 0 ? (downloaded / totalBytes) * 100 : 0;
        onProgress({ pct, downloaded, total: totalBytes, filename, filepath });
        if (pct >= config.triggerPct && !triggered) { triggered = true; resolve80(); }
      });
      res.on("end",   () => { file.end(); resolve80(); resolve({ filename, filepath, paused: false, bytesDownloaded: downloaded }); });
      res.on("error", e  => { file.destroy(); resolve80(); reject(e); });
      file.on("error",e  => { resolve80(); reject(e); });
      res.pipe(file, { end: false });
    }).catch(e => { resolve80(); reject(e); });
  });

  return { at80, done, abort: () => { if (abortRef.fn) abortRef.fn(); } };
}
