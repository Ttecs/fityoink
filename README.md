# FitYoink v2

Paste a FitGirl repack link once. FitYoink finds every download link in it, lets you pick files, and downloads them all — no clicking each one manually.

Supports: **datanodes.to**, **fuckingfast.co**, **pixeldrain**, **gofile**, **1fichier**, **buzzheavier**, **mediafire**

---

## Requirements

- [Node.js](https://nodejs.org/) (v18 or later)
- [Electron](https://www.electronjs.org/) — installed globally
- A **Bright Data** account (free trial available) — needed for datanodes.to and fuckingfast.co which use Cloudflare Turnstile

---

## Setup: Bright Data Scraping Browser

Datanodes.to and fuckingfast.co use Cloudflare Turnstile — a bot check that blocks normal automation. Bright Data's Browser API solves it automatically in the cloud.

### Step 1 — Create a Bright Data account

Go to [brightdata.com](https://brightdata.com), sign up, and log in. Once you're on the Home dashboard, click **Web Access** (the API icon) in the left sidebar.

![Step 1 — Click Web Access in the sidebar](assets/ss1.png)

---

### Step 2 — Open the Dashboard and create a new API

You'll land on the Web Access API page. Click the **Dashboard** tab, then click **Create API** in the top-right corner.

![Step 2 — Click Create API](assets/ss2.png)

---

### Step 3 — Select Browser API

On the "Choose API type" screen, select **Browser API** (top option). Then click **Continue**.

![Step 3 — Select Browser API and click Continue](assets/ss3.png)

---

### Step 4 — Name your API and add it

Give your API a name (e.g. `scraping_browser1`). Make sure **CAPTCHA Solver** is toggled on — this is what bypasses Cloudflare Turnstile. Then click **Add API**.

![Step 4 — Name the API and click Add API](assets/ss4.png)

---

### Step 5 — Copy your WSS URL

On the final screen you'll see your connection URL under **Puppeteer / Playwright**. Copy the `wss://...` line — this is what goes into FitYoink's Settings.

![Step 5 — Copy the WSS URL](assets/ss5.png)

---

### Step 6 — Paste it into FitYoink

1. Open FitYoink
2. Click the **⚙️** icon in the top-right corner
3. Paste your WSS URL into the **Bright Data Scraping Browser WSS URL** field
4. Click **Save**

That's it. FitYoink will now bypass Turnstile on datanodes.to and fuckingfast.co automatically.

---

## Install & Run

```bash
# 1. Install dependencies (only needed once)
cd v2
npm install

# 2. Install Electron globally if you haven't already
npm install -g electron

# 3. Launch the app
electron .
```

---

## How to use

1. Find a FitGirl repack page and copy its **PrivateBin paste URL**
   - It usually looks like: `https://paste.fitgirl-repacks.site/?xxxxxxxx#yyyyyyy`
2. Paste it into the **Paste URL** field and click **Fetch**
3. The app opens the paste in a browser, extracts all download links, and shows them as a list
4. Check the files you want (all selected by default)
5. Choose a download folder (defaults to `~/Downloads/fitgirl`)
6. Click **⬇ Download Selected**
7. FitYoink resolves each link, bypasses any Turnstile checks, and downloads files one by one with progress bars

### Controls per download

| Button | What it does |
|--------|-------------|
| **Pause** | Stops the current download cleanly |
| **Resume** | Picks up from where it left off (uses HTTP range resume) |
| **Cancel** | Stops and deletes the partial file |
| **Open Folder** | Opens the download folder in Explorer when done |

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Download Folder | `~/Downloads/fitgirl` | Where files are saved |
| Bright Data WSS URL | *(your credentials)* | CDP endpoint for Turnstile bypass |
| Pre-resolve trigger % | 80 | Start resolving the next link when the current download hits this percentage |

Settings are saved automatically between sessions.

---

## Troubleshooting

**"Could not resolve link"**
- Check that your Bright Data WSS URL is correct in Settings
- Make sure your Bright Data zone is active (check the dashboard)

**Download stuck at 0%**
- The CDN link may have expired. Cancel and re-fetch from the paste URL

**App won't open**
- Make sure you ran `npm install` inside the `v2/` folder
- Make sure Electron is installed: `npm install -g electron`
