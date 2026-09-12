import express from "express";
import { createReadStream, readFileSync, statSync, readdirSync, mkdtempSync, rmSync, existsSync } from "fs";
import { join, extname, dirname } from "path";
import { fileURLToPath } from "url";
import { networkInterfaces } from "os";
import { spawn } from "child_process";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MEDIA_DIR = process.argv[2] || join(__dirname, "media");
const PORT = parseInt(process.env.PORT || "8080", 10);
const NATIVE_EXTENSIONS = new Set([".mp4", ".m4v", ".mov"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".mkv", ".avi", ".wmv", ".flv", ".webm", ".mpg", ".mpeg", ".ts", ".m2ts", ".vob", ".ogv", ".3gp"]);

const hlsSessions = new Map();

const app = express();

function resolveBase(req) {
  const vol = req.query.vol;
  if (vol && !vol.includes("..")) {
    const volPath = join("/Volumes", vol);
    try { if (statSync(volPath).isDirectory()) return volPath; } catch {}
  }
  return MEDIA_DIR;
}

app.get("/api/config", (_req, res) => {
  res.json({ mediaDir: MEDIA_DIR });
});

app.get("/api/volumes", (_req, res) => {
  try {
    const entries = readdirSync("/Volumes", { withFileTypes: true });
    const volumes = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join("/Volumes", entry.name);
      try { if (statSync(full).isDirectory()) volumes.push(entry.name); } catch {}
    }
    res.json(volumes);
  } catch {
    res.json([]);
  }
});

app.get("/api/browse", (req, res) => {
  const base = resolveBase(req);
  const relDir = (req.query.dir || "").replace(/\.\./g, "");
  const absDir = join(base, relDir);

  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return res.status(404).json({ error: "Directory not found" });
  }

  const folders = [];
  const videos = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(absDir, entry.name);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    const childPath = relDir ? relDir + "/" + entry.name : entry.name;
    if (stat.isDirectory()) {
      folders.push({ name: entry.name, path: childPath, mtime: stat.mtimeMs });
    } else if (stat.isFile() && VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      const needsTranscode = !NATIVE_EXTENSIONS.has(extname(entry.name).toLowerCase());
      videos.push({ name: entry.name, path: childPath, size: stat.size, mtime: stat.mtimeMs, transcode: needsTranscode });
    }
  }

  res.json({ dir: relDir || null, folders, videos });
});

app.get("/api/search", (req, res) => {
  const base = resolveBase(req);
  const q = (req.query.q || "").toLowerCase();
  const relDir = (req.query.dir || "").replace(/\.\./g, "");
  if (!q) return res.json({ folders: [], videos: [] });

  const absDir = join(base, relDir);
  const folders = [];
  const videos = [];

  function scan(dir, depth = 0) {
    if (depth > 5) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      const rel = relDir
        ? relDir + "/" + full.slice(absDir.length + 1)
        : full.slice(base.length + 1);
      if (stat.isDirectory()) {
        if (entry.name.toLowerCase().includes(q)) folders.push({ name: entry.name, path: rel });
        scan(full, depth + 1);
      } else if (stat.isFile() && VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        if (entry.name.toLowerCase().includes(q)) videos.push({ name: entry.name, path: rel });
      }
    }
  }

  scan(absDir);
  folders.sort((a, b) => a.name.localeCompare(b.name));
  videos.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ folders: folders.slice(0, 20), videos: videos.slice(0, 20) });
});

app.get("/api/stream/*", (req, res) => {
  const base = resolveBase(req);
  const relPath = req.params[0];
  if (relPath.includes("..")) return res.status(400).end();

  const filePath = join(base, relPath);
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return res.status(404).end();
  }

  const ext = extname(filePath).toLowerCase();
  const mimeTypes = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime" };
  const contentType = mimeTypes[ext] || "application/octet-stream";
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": contentType,
    });
    createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
    });
    createReadStream(filePath).pipe(res);
  }
});

// HLS transcoding
function createHlsSession(relPath, base) {
  const filePath = join(base, relPath);
  if (!existsSync(filePath)) return null;

  const sessionId = Math.random().toString(36).slice(2, 10);
  const tmpDir = mkdtempSync(join(tmpdir(), "hls-"));
  const playlistPath = join(tmpDir, "playlist.m3u8");
  const segPattern = join(tmpDir, "seg%04d.ts");

  const ffmpeg = spawn("ffmpeg", [
    "-i", filePath,
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
    "-c:a", "aac", "-b:a", "192k", "-ac", "2",
    "-f", "hls",
    "-hls_time", "4",
    "-hls_list_size", "0",
    "-hls_segment_filename", segPattern,
    "-hls_flags", "temp_file",
    playlistPath,
  ], { stdio: ["ignore", "ignore", "pipe"] });

  const session = { id: sessionId, tmpDir, playlistPath, ffmpeg, filePath };

  ffmpeg.on("close", () => { session.done = true; });

  hlsSessions.set(sessionId, session);
  return session;
}

function destroyHlsSession(sessionId) {
  const session = hlsSessions.get(sessionId);
  if (!session) return;
  hlsSessions.delete(sessionId);
  if (session.ffmpeg && !session.done) {
    session.ffmpeg.kill("SIGTERM");
  }
  try { rmSync(session.tmpDir, { recursive: true, force: true }); } catch {}
}

app.post("/api/hls/start", (req, res) => {
  const base = resolveBase(req);
  const relPath = req.query.path;
  if (!relPath || relPath.includes("..")) return res.status(400).json({ error: "Invalid path" });

  const session = createHlsSession(relPath, base);
  if (!session) return res.status(404).json({ error: "File not found" });

  res.json({ sessionId: session.id, playlistUrl: "/api/hls/" + session.id + "/playlist.m3u8" });
});

app.get("/api/hls/:sessionId/playlist.m3u8", (req, res) => {
  const session = hlsSessions.get(req.params.sessionId);
  if (!session) return res.status(404).end();

  const check = () => {
    if (existsSync(session.playlistPath)) {
      try {
        const content = readFileSync(session.playlistPath, "utf8");
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.setHeader("Cache-Control", "no-cache, no-store");
        res.send(content);
      } catch {
        if (!session.done) setTimeout(check, 200);
        else res.status(500).end();
      }
    } else if (session.done) {
      res.status(500).end();
    } else {
      setTimeout(check, 200);
    }
  };
  check();
});

app.get("/api/hls/:sessionId/:segment", (req, res) => {
  const session = hlsSessions.get(req.params.sessionId);
  if (!session) return res.status(404).end();
  session.lastAccess = Date.now();

  const segPath = join(session.tmpDir, req.params.segment);
  if (!existsSync(segPath)) return res.status(404).end();

  res.setHeader("Content-Type", "video/mp2t");
  res.setHeader("Cache-Control", "no-cache");
  createReadStream(segPath).pipe(res);
});

app.post("/api/hls/stop", (req, res) => {
  const sessionId = req.query.session;
  if (sessionId) destroyHlsSession(sessionId);
  res.json({ ok: true });
});

app.get("/", (_req, res) => {
  res.send(PAGE_HTML);
});

function getLocalIPs() {
  const nets = networkInterfaces();
  const results = [];
  for (const entries of Object.values(nets)) {
    for (const net of entries) {
      if (net.family === "IPv4" && !net.internal) results.push(net.address);
    }
  }
  return results;
}

// Clean up all HLS sessions on server shutdown
function cleanupAll() {
  for (const id of hlsSessions.keys()) destroyHlsSession(id);
}
process.on("SIGINT", () => { cleanupAll(); process.exit(); });
process.on("SIGTERM", () => { cleanupAll(); process.exit(); });

// Reap stale sessions (ffmpeg done + no playlist request in 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of hlsSessions) {
    if (session.done && (!session.lastAccess || now - session.lastAccess > 300000)) {
      destroyHlsSession(id);
    }
  }
}, 60000);

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>couch-serve</title>
<style>
  :root { --bg: #0a0a0a; --surface: #161616; --border: #2a2a2a; --text: #e0e0e0; --text-dim: #888; --accent: #4a9eff; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro", system-ui, sans-serif; background: var(--bg); color: var(--text); min-height: 100dvh; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }

  #navbar { position: sticky; top: 0; padding: 14px 16px; padding-top: calc(14px + env(safe-area-inset-top, 0px)); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; background: var(--bg); z-index: 10; }
  #navbar.player-mode { background: rgba(0,0,0,0.9); border-bottom-color: #222; }
  #back-btn { background: none; border: none; color: var(--accent); font-size: 0.95rem; cursor: pointer; padding: 4px 8px 4px 0; flex-shrink: 0; white-space: nowrap; }
  #nav-title { flex: 1; min-width: 0; font-size: 0.9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #nav-pill { display: flex; align-items: center; flex-shrink: 0; width: 30%; max-width: 30%; background: var(--surface); border: 1px solid var(--border); border-radius: 20px; overflow: hidden; }
  #navbar.player-mode #nav-pill { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.15); }
  .pill-btn { flex: 1; min-width: 0; background: none; border: none; color: var(--text-dim); font-size: 0.75rem; padding: 6px 8px; cursor: pointer; display: flex; align-items: center; gap: 3px; }
  .pill-btn:active { color: #fff; }
  .pill-btn.disabled { opacity: 0.3; pointer-events: none; }
  .pill-prev { justify-content: flex-start; }
  .pill-next { justify-content: flex-end; }
  .pill-divider { width: 1px; height: 16px; background: var(--border); flex-shrink: 0; }
  #navbar.player-mode .pill-divider { background: rgba(255,255,255,0.15); }
  .pill-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pill-arrow { flex-shrink: 0; }

  #search-wrap { display: flex; align-items: center; flex-shrink: 0; }
  #search-btn { background: none; border: none; color: var(--text-dim); font-size: 1rem; cursor: pointer; padding: 4px 6px; flex-shrink: 0; }
  #search-input { display: none; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: 0.85rem; padding: 5px 10px; outline: none; width: 0; transition: width 0.2s; -webkit-user-select: text; user-select: text; }
  #search-input:focus { border-color: var(--accent); }
  #navbar.search-active #nav-title { display: none; }
  #navbar.search-active #search-wrap { flex: 1; }
  #navbar.search-active #search-input { display: block; width: 100%; }
  #search-results { display: none; position: fixed; z-index: 9999; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 6px 0; max-width: 320px; min-width: 220px; max-height: 50vh; overflow-y: auto; box-shadow: 0 8px 24px rgba(0,0,0,0.6); -webkit-overflow-scrolling: touch; }
  #search-results.open { display: block; }
  .sr-section { font-size: 0.7rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; padding: 6px 14px 4px; }
  .sr-item { display: flex; align-items: center; gap: 8px; padding: 8px 14px; cursor: pointer; font-size: 0.85rem; color: var(--text); }
  .sr-item:active { background: var(--border); }
  .sr-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sr-path { font-size: 0.7rem; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sr-info { min-width: 0; flex: 1; }
  .sr-empty { padding: 10px 14px; font-size: 0.8rem; color: var(--text-dim); font-style: italic; }

  #reload-btn { background: none; border: none; color: var(--text-dim); cursor: pointer; padding: 4px 6px; flex-shrink: 0; }
  #sort-btn { background: var(--surface); border: 1px solid var(--border); color: var(--text); font-size: 0.8rem; padding: 6px 12px; border-radius: 6px; cursor: pointer; white-space: nowrap; flex-shrink: 0; margin-right: 4px; }
  #sort-btn:hover { border-color: var(--accent); }

  #library { padding: 16px; }
  .item-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
  .item { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; cursor: pointer; transition: border-color 0.15s; display: flex; align-items: center; gap: 12px; }
  .item:hover, .item:active { border-color: var(--accent); }

  .icon { flex-shrink: 0; width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
  .icon svg { width: 14px; height: 14px; fill: #fff; }
  .icon-play { background: var(--accent); }
  .icon-play svg { margin-left: 2px; }
  .icon-transcode { background: #e05555; }
  .icon-folder { background: #e8a838; }
  .icon-volume { background: #8b5cf6; }
  .icon { position: relative; }
  .star-badge { position: absolute; top: -3px; right: -3px; width: 12px; height: 12px; }

  .item-info { flex: 1; min-width: 0; }
  .item-name { font-size: 0.95rem; word-break: break-word; }
  .item-size { font-size: 0.75rem; color: var(--text-dim); margin-top: 2px; }

  #player-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: #000; z-index: 5; display: none; flex-direction: column; }
  #player-overlay.active { display: flex; }
  body.player-open { overflow: hidden; }
  #video-wrap { position: relative; flex: 1; min-height: 0; display: flex; }
  #video-wrap video { flex: 1; width: 100%; min-height: 0; background: #000; padding-bottom: env(safe-area-inset-bottom, 0px); }

  .tap-zone { position: absolute; top: 50px; bottom: 50px; width: 30%; z-index: 2; display: flex; align-items: center; justify-content: center; -webkit-tap-highlight-color: transparent; }
  .tap-zone-left { left: 0; }
  .tap-zone-right { right: 0; }
  .skip-indicator { opacity: 0; color: #fff; font-size: 1.4rem; font-weight: 600; pointer-events: none; transition: opacity 0.15s; text-shadow: 0 1px 4px rgba(0,0,0,0.8); }
  .skip-indicator.show { opacity: 1; }

  #fs-btn { position: absolute; top: 70px; left: 16px; z-index: 10; background: rgba(0,0,0,0.7); border: 1px solid rgba(255,255,255,0.3); color: #fff; font-size: 0.85rem; padding: 8px 14px; border-radius: 8px; cursor: pointer; opacity: 0; transition: opacity 0.3s; pointer-events: none; -webkit-tap-highlight-color: transparent; }
  #fs-btn.visible { opacity: 1; pointer-events: auto; }
  #loop-btn { position: absolute; top: 70px; right: 16px; z-index: 3; background: rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.25); color: #fff; font-size: 0.8rem; padding: 6px 12px; border-radius: 6px; cursor: pointer; opacity: 0; transition: opacity 0.3s; pointer-events: none; -webkit-tap-highlight-color: transparent; }
  #loop-btn.visible { opacity: 1; pointer-events: auto; }
  #loop-btn.active { background: var(--accent); border-color: var(--accent); }


  .empty { text-align: center; color: var(--text-dim); padding: 80px 24px; font-size: 1rem; line-height: 1.6; }

  .popover { display: none; position: fixed; z-index: 9999; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 6px 0; min-width: 200px; max-width: 280px; box-shadow: 0 8px 24px rgba(0,0,0,0.6); }
  .popover.open { display: block; }
  .popover-title { font-size: 0.7rem; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; padding: 6px 14px 4px; }
  .popover-item { display: flex; align-items: center; gap: 8px; padding: 8px 14px; cursor: pointer; font-size: 0.85rem; color: var(--text); }
  .popover-item:active { background: var(--border); }
  .popover-item.current { color: var(--accent); font-weight: 600; }
  .popover-icon { flex-shrink: 0; width: 14px; height: 14px; display: inline-flex; }
  .popover-icon svg { width: 14px; height: 14px; }
  .sr-icon { flex-shrink: 0; width: 14px; height: 14px; display: inline-flex; }
  .sr-icon svg { width: 14px; height: 14px; }
  .popover-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .popover-divider { height: 1px; background: var(--border); margin: 4px 0; }
  .popover-empty { padding: 10px 14px; font-size: 0.8rem; color: var(--text-dim); font-style: italic; }

  #sort-menu { display: none; position: fixed; z-index: 9999; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 6px 0; min-width: 180px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
  #sort-menu.open { display: block; }
  #sort-menu button { display: block; width: 100%; text-align: left; background: none; border: none; color: var(--text); font-size: 0.9rem; padding: 10px 16px; cursor: pointer; }
  #sort-menu button:hover { background: var(--border); }
  #sort-menu button.active { color: var(--accent); }
</style>
</head>
<body>

<div id="navbar">
  <button id="back-btn">&larr; Back</button>
  <span id="nav-title"></span>
  <div id="search-wrap">
    <button id="search-btn"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="4.5"/><line x1="10" y1="10" x2="14" y2="14"/></svg></button>
    <input id="search-input" type="text" placeholder="Search..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
  </div>
  <button id="reload-btn" style="display:none"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 8a6 6 0 0 1 10.3-4.2M14 8a6 6 0 0 1-10.3 4.2"/><polyline points="2,2 2,5 5,5"/><polyline points="14,14 14,11 11,11"/></svg></button>
  <button id="sort-btn">Sort</button>
  <div id="nav-pill">
    <button class="pill-btn pill-prev disabled" id="pill-prev"><span class="pill-arrow">&larr;</span> <span class="pill-name" id="pill-prev-name"></span></button>
    <div class="pill-divider"></div>
    <button class="pill-btn pill-next disabled" id="pill-next"><span class="pill-name" id="pill-next-name"></span> <span class="pill-arrow">&rarr;</span></button>
  </div>
</div>

<div class="popover" id="peek-popover"></div>
<div id="search-results"></div>

<div id="sort-menu">
  <button data-sort="name-asc">Name A-Z</button>
  <button data-sort="name-desc">Name Z-A</button>
  <button data-sort="size-asc">Size (smallest)</button>
  <button data-sort="size-desc">Size (largest)</button>
  <button data-sort="date-asc">Date (oldest)</button>
  <button data-sort="date-desc">Date (newest)</button>
</div>

<div id="library"></div>

<div id="player-overlay">
  <div id="video-wrap">
    <div class="tap-zone tap-zone-left" id="tap-left"><span class="skip-indicator" id="skip-left"></span></div>
    <div class="tap-zone tap-zone-right" id="tap-right"><span class="skip-indicator" id="skip-right"></span></div>
    <button id="fs-btn">Fullscreen</button>
    <button id="loop-btn">Loop: Off</button>
    <video id="player" controls playsinline></video>
  </div>
</div>

<script>
  const ICN = {
    home: '<svg viewBox="0 0 16 16" fill="white"><path d="M8 1L1 7h2v7h4v-4h2v4h4V7h2L8 1z"/></svg>',
    folder: '<svg viewBox="0 0 16 16" fill="white"><path d="M1 3h5l2 2h7v9H1V3z"/></svg>',
    play: '<svg viewBox="0 0 16 16" fill="white"><polygon points="4,2 14,8 4,14"/></svg>',
    volume: '<svg viewBox="0 0 16 16" fill="none" stroke="white" stroke-width="1.2"><rect x="2" y="3" width="12" height="10" rx="1.5"/><line x1="2" y1="9" x2="14" y2="9"/><circle cx="11.5" cy="11" r="0.9" fill="white" stroke="none"/></svg>',
  };

  const library = document.getElementById('library');
  const overlay = document.getElementById('player-overlay');
  const videoEl = document.getElementById('player');
  const navbar = document.getElementById('navbar');
  const navTitle = document.getElementById('nav-title');
  const backBtn = document.getElementById('back-btn');
  const sortBtn = document.getElementById('sort-btn');
  const reloadBtn = document.getElementById('reload-btn');
  reloadBtn.addEventListener('click', () => { location.reload(); });
  const sortMenu = document.getElementById('sort-menu');
  const pillPrev = document.getElementById('pill-prev');
  const pillNext = document.getElementById('pill-next');
  const pillPrevName = document.getElementById('pill-prev-name');
  const pillNextName = document.getElementById('pill-next-name');
  const fsBtn = document.getElementById('fs-btn');
  const loopBtn = document.getElementById('loop-btn');
  const tapLeft = document.getElementById('tap-left');
  const tapRight = document.getElementById('tap-right');
  const skipLeftEl = document.getElementById('skip-left');
  const skipRightEl = document.getElementById('skip-right');

  let currentDir = null;
  let currentData = null;
  let currentVol = null;
  let sortMode = 'name-asc';
  let cachedVolumes = [];

  const STAR_BADGE = '<svg class="star-badge" viewBox="0 0 12 12"><polygon points="6,0.5 7.5,4 11.5,4.5 8.5,7 9.5,11 6,9 2.5,11 3.5,7 0.5,4.5 4.5,4" fill="#f5c518"/></svg>';
  const STAR_ICON = '<svg viewBox="0 0 12 12" width="14" height="14"><polygon points="6,0.5 7.5,4 11.5,4.5 8.5,7 9.5,11 6,9 2.5,11 3.5,7 0.5,4.5 4.5,4" fill="#f5c518"/></svg>';

  let serverMediaDir = '';
  function favKey() { return 'fav:' + serverMediaDir + ':' + (currentVol || 'local'); }
  function getFavorites() {
    try { return JSON.parse(localStorage.getItem(favKey()) || '[]'); } catch { return []; }
  }
  function saveFavorites(favs) { localStorage.setItem(favKey(), JSON.stringify(favs)); }
  function isFavorite(path) { return getFavorites().some(f => f.path === path); }
  function addFavorite(video) {
    const favs = getFavorites();
    if (!favs.some(f => f.path === video.path)) {
      favs.push({ name: video.name, path: video.path, size: video.size, transcode: video.transcode });
      saveFavorites(favs);
    }
  }
  function removeFavorite(path) {
    saveFavorites(getFavorites().filter(f => f.path !== path));
  }
  function getAllFavorites() {
    const all = [];
    const prefix = 'fav:' + serverMediaDir + ':';
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith(prefix)) {
        const source = key.slice(prefix.length);
        try {
          const items = JSON.parse(localStorage.getItem(key) || '[]');
          for (const item of items) all.push({ ...item, _source: source });
        } catch {}
      }
    }
    return all;
  }

  function volParam() { return currentVol ? '&vol=' + encodeURIComponent(currentVol) : ''; }
  let playlist = [];
  let playlistIndex = -1;
  let isPlayerMode = false;
  let siblingFolders = [];
  let siblingIndex = -1;
  let activeHlsSession = null;

  function enterPlayerMode() {
    isPlayerMode = true;
    navbar.classList.add('player-mode');
    overlay.classList.add('active');
    document.body.classList.add('player-open');
    sortBtn.style.display = 'none';
  }

  function stopHls() {
    if (activeHlsSession) {
      fetch('/api/hls/stop?session=' + activeHlsSession, { method: 'POST' });
      activeHlsSession = null;
    }
  }

  function exitPlayerMode() {
    isPlayerMode = false;
    navbar.classList.remove('player-mode');
    overlay.classList.remove('active');
    document.body.classList.remove('player-open');
    sortBtn.style.display = '';
    videoEl.pause();
    videoEl.removeAttribute('src');
    videoEl.load();
    videoEl.loop = false;
    loopBtn.classList.remove('active');
    loopBtn.textContent = 'Loop: Off';
    stopHls();
    playlistIndex = -1;
    updatePill();
    updateNavTitle();
    updateHash();
  }

  backBtn.addEventListener('click', () => {
    if (isPlayerMode) {
      exitPlayerMode();
    } else if (currentDir) {
      const parts = currentDir.split('/');
      parts.pop();
      navigate(parts.length ? parts.join('/') : null);
    } else if (currentVol) {
      currentVol = null;
      showVolumes();
    }
  });

  function volumesPeekHtml() {
    if (cachedVolumes.length === 0) return '';
    let html = '<div class="popover-divider"></div>';
    html += '<div class="popover-title">Volumes</div>';
    for (const vol of cachedVolumes) {
      const isCurrent = vol === currentVol;
      html += '<div class="popover-item' + (isCurrent ? ' current' : '') + '" onclick="selectVolume(\\'' + esc(vol).replace(/'/g,"\\\\'") + '\\')"><span class="popover-icon">' + ICN.volume + '</span><span class="popover-name">' + esc(vol) + '</span></div>';
    }
    return html;
  }

  addLongPress(backBtn, (el) => {
    let html = '<div class="popover-item" onclick="goHome()"><span class="popover-icon">' + ICN.home + '</span><span class="popover-name">Home</span></div>';
    const path = currentDir;
    if (path) {
      const parts = path.split('/');
      let acc = '';
      for (let i = 0; i < parts.length; i++) {
        acc = acc ? acc + '/' + parts[i] : parts[i];
        const isCurrent = (acc === path && !isPlayerMode);
        const p = acc;
        html += '<div class="popover-item' + (isCurrent ? ' current' : '') + '" onclick="popNavFolder(\\'' + esc(p).replace(/'/g,"\\\\'") + '\\')"><span class="popover-icon">' + ICN.folder + '</span><span class="popover-name">' + esc(parts[i]) + '</span></div>';
      }
    }
    if (isPlayerMode && playlistIndex >= 0) {
      html += '<div class="popover-divider"></div>';
      html += '<div class="popover-item current"><span class="popover-icon">' + ICN.play + '</span><span class="popover-name">' + esc(playlist[playlistIndex].name) + '</span></div>';
    }
    html += volumesPeekHtml();
    showPeek(el, html);
  });

  window.goHome = function() { closePeek(); currentVol = null; showVolumes(); };

  addLongPress(navTitle, (el) => {
    if (cachedVolumes.length === 0) return;
    let html = '<div class="popover-item" onclick="goHome()"><span class="popover-icon">' + ICN.home + '</span><span class="popover-name">Home</span></div>';
    html += volumesPeekHtml();
    showPeek(el, html);
  });

  // Double-tap to skip
  const SKIP_SEC = 10;
  let lastTapLeft = 0, lastTapRight = 0, skipAccumLeft = 0, skipAccumRight = 0;
  let skipTimerLeft = null, skipTimerRight = null;

  function flashSkip(el, seconds, forward) {
    el.textContent = (forward ? '+' : '-') + seconds + 's';
    el.classList.add('show');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('show'), 600);
  }

  function showControls() {
    loopBtn.classList.add('visible');
    fsBtn.classList.add('visible');
    clearTimeout(loopBtn._hideTimer);
    loopBtn._hideTimer = setTimeout(() => {
      loopBtn.classList.remove('visible');
      fsBtn.classList.remove('visible');
    }, 3000);
  }

  function setupDoubleTap(zone, indicator, forward) {
    let lastTap = 0, accum = 0, accumTimer = null, pendingTimer = null;

    zone.addEventListener('click', (e) => {
      e.preventDefault();
      const now = Date.now();

      if (now - lastTap < 400) {
        clearTimeout(pendingTimer);
        accum += SKIP_SEC;
        if (forward) {
          videoEl.currentTime = Math.min(videoEl.duration || Infinity, videoEl.currentTime + SKIP_SEC);
        } else {
          videoEl.currentTime = Math.max(0, videoEl.currentTime - SKIP_SEC);
        }
        flashSkip(indicator, accum, forward);
        showControls();
        clearTimeout(accumTimer);
        accumTimer = setTimeout(() => { accum = 0; }, 800);
      } else {
        pendingTimer = setTimeout(() => {
          showControls();
        }, 300);
      }
      lastTap = now;
    });
  }

  setupDoubleTap(tapLeft, skipLeftEl, false);
  setupDoubleTap(tapRight, skipRightEl, true);

  // Tap middle area (between tap zones) also toggles controls
  videoEl.addEventListener('click', () => {
    showControls();
  });

  // Video fullscreen (not web fullscreen)
  fsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (videoEl.webkitEnterFullscreen) {
      videoEl.webkitEnterFullscreen();
    } else if (videoEl.requestFullscreen) {
      videoEl.requestFullscreen();
    }
    showControls();
  });

  // Loop toggle
  loopBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    videoEl.loop = !videoEl.loop;
    loopBtn.classList.toggle('active', videoEl.loop);
    loopBtn.textContent = videoEl.loop ? 'Loop: On' : 'Loop: Off';
    showControls();
  });

  sortBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = sortBtn.getBoundingClientRect();
    sortMenu.style.top = (rect.bottom + 4) + 'px';
    sortMenu.style.right = (window.innerWidth - rect.right) + 'px';
    sortMenu.classList.toggle('open');
    sortMenu.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.sort === sortMode));
  });

  document.addEventListener('click', (e) => { sortMenu.classList.remove('open'); if (!e.target.closest('#search-wrap') && !e.target.closest('#search-results')) closeSearch(); });

  sortMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    const btn = e.target.closest('button[data-sort]');
    if (!btn) return;
    sortMode = btn.dataset.sort;
    sortMenu.classList.remove('open');
    if (currentData) {
      render(currentData);
    } else if (!currentVol && !currentDir) {
      showVolumes();
    }
  });
  sortMenu.addEventListener('touchend', (e) => { e.stopPropagation(); });

  // Search
  const searchBtn = document.getElementById('search-btn');
  const searchInput = document.getElementById('search-input');
  const searchResults = document.getElementById('search-results');
  let searchDebounce = null;

  function openSearch() {
    navbar.classList.add('search-active');
    searchInput.value = '';
    searchInput.focus();
  }

  function closeSearch() {
    navbar.classList.remove('search-active');
    searchResults.classList.remove('open');
    searchInput.blur();
  }

  searchBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (navbar.classList.contains('search-active')) {
      closeSearch();
    } else {
      openSearch();
    }
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSearch();
  });

  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    const q = searchInput.value.trim();
    if (!q) { searchResults.classList.remove('open'); return; }
    searchDebounce = setTimeout(async () => {
      const dir = currentDir || '';
      const url = '/api/search?q=' + encodeURIComponent(q) + (dir ? '&dir=' + encodeURIComponent(dir) : '') + volParam();
      try {
        const res = await fetch(url);
        const data = await res.json();
        renderSearchResults(data);
      } catch {}
    }, 250);
  });

  function renderSearchResults(data) {
    if (data.folders.length === 0 && data.videos.length === 0) {
      searchResults.innerHTML = '<div class="sr-empty">No results</div>';
      searchResults.classList.add('open');
      positionSearchResults();
      return;
    }
    let html = '';
    if (data.folders.length) {
      html += '<div class="sr-section">Folders</div>';
      for (const f of data.folders) {
        html += '<div class="sr-item" onclick="searchNav(\\'folder\\',\\'' + esc(f.path).replace(/'/g,"\\\\'") + '\\')">'
          + '<span class="sr-icon">' + ICN.folder + '</span><div class="sr-info"><div class="sr-name">' + esc(f.name) + '</div>'
          + '<div class="sr-path">' + esc(f.path) + '</div></div></div>';
      }
    }
    if (data.videos.length) {
      html += '<div class="sr-section">Videos</div>';
      for (const v of data.videos) {
        html += '<div class="sr-item" onclick="searchNav(\\'video\\',\\'' + esc(v.path).replace(/'/g,"\\\\'") + '\\',\\'' + esc(v.name).replace(/'/g,"\\\\'") + '\\')">'
          + '<span class="sr-icon">' + ICN.play + '</span><div class="sr-info"><div class="sr-name">' + esc(v.name) + '</div>'
          + '<div class="sr-path">' + esc(v.path) + '</div></div></div>';
      }
    }
    searchResults.innerHTML = html;
    searchResults.classList.add('open');
    positionSearchResults();
  }

  function positionSearchResults() {
    const rect = searchInput.getBoundingClientRect();
    searchResults.style.top = (rect.bottom + 6) + 'px';
    searchResults.style.left = Math.max(8, rect.left) + 'px';
    searchResults.style.right = '16px';
  }

  window.searchNav = function(type, path, name) {
    closeSearch();
    if (type === 'folder') {
      navigate(path);
    } else {
      const parts = path.split('/');
      parts.pop();
      const dir = parts.length ? parts.join('/') : null;
      navigate(dir, path);
    }
  };

  function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }

  function updateNavTitle() {
    const prefix = currentVol ? currentVol + '/' : '';
    if (isPlayerMode && playlistIndex >= 0) {
      const v = playlist[playlistIndex];
      navTitle.textContent = prefix + (currentDir ? currentDir + '/' : '') + v.name;
      backBtn.style.display = '';
      reloadBtn.style.display = 'none';
    } else if (currentDir) {
      navTitle.textContent = prefix + currentDir;
      backBtn.style.display = '';
      reloadBtn.style.display = 'none';
    } else if (currentVol) {
      navTitle.textContent = currentVol;
      backBtn.style.display = '';
      reloadBtn.style.display = 'none';
    } else {
      navTitle.textContent = 'couch-serve';
      backBtn.style.display = 'none';
      reloadBtn.style.display = '';
    }
  }

  function wrapIndex(idx, delta, len) {
    return (idx + delta + len) % len;
  }

  function updatePill() {
    const items = isPlayerMode ? playlist : siblingFolders;
    const idx = isPlayerMode ? playlistIndex : siblingIndex;
    if (items.length < 2) {
      pillPrev.classList.add('disabled');
      pillPrevName.textContent = '';
      pillNext.classList.add('disabled');
      pillNextName.textContent = '';
    } else {
      pillPrev.classList.remove('disabled');
      pillPrevName.textContent = items[wrapIndex(idx, -1, items.length)].name;
      pillNext.classList.remove('disabled');
      pillNextName.textContent = items[wrapIndex(idx, 1, items.length)].name;
    }
  }

  function buildHash() {
    const parts = [];
    if (currentVol) parts.push('vol=' + encodeURIComponent(currentVol));
    if (currentDir) parts.push('dir=' + encodeURIComponent(currentDir));
    if (playlistIndex >= 0 && playlist[playlistIndex]) parts.push('play=' + encodeURIComponent(playlist[playlistIndex].path));
    return parts.length ? '#' + parts.join('&') : '#';
  }

  let initialLoad = true;
  function updateHash() {
    if (restoringState) return;
    const hash = buildHash();
    if (location.hash === hash) return;
    if (initialLoad) {
      history.replaceState(null, '', hash);
      initialLoad = false;
    } else {
      history.pushState(null, '', hash);
    }
  }

  function parseHash() {
    const h = location.hash.replace(/^#/, '');
    const params = {};
    for (const part of h.split('&')) {
      const [k, v] = part.split('=');
      if (k && v) params[k] = decodeURIComponent(v);
    }
    return params;
  }

  let restoringState = false;
  window.addEventListener('popstate', async () => {
    restoringState = true;
    const p = parseHash();
    currentVol = p.vol || null;
    if (p.play) {
      const dir = p.dir || null;
      if (dir !== currentDir) {
        await navigate(dir, p.play);
      } else {
        const v = playlist.find(v => v.path === p.play);
        if (v) {
          const idx = playlist.indexOf(v);
          playlistIndex = idx;
          enterPlayerMode();
          videoEl.src = '/api/stream/' + encodeURIComponent(v.path).replace(/%2F/g, '/') + '?' + volParam().slice(1);
          videoEl.play();
          updatePill();
          updateNavTitle();
        }
      }
    } else {
      if (isPlayerMode) {
        isPlayerMode = false;
        navbar.classList.remove('player-mode');
        overlay.classList.remove('active');
        document.body.classList.remove('player-open');
        sortBtn.style.display = '';
        videoEl.pause();
        videoEl.removeAttribute('src');
        videoEl.load();
        videoEl.loop = false;
        loopBtn.classList.remove('active');
        loopBtn.textContent = 'Loop: Off';
        playlistIndex = -1;
      }
      const dir = p.dir || null;
      if (dir !== currentDir) {
        await navigate(dir);
      } else {
        updatePill();
        updateNavTitle();
      }
    }
    restoringState = false;
  });

  async function playVideo(path, name) {
    stopHls();
    const idx = playlist.findIndex(v => v.path === path);
    if (idx !== -1) playlistIndex = idx;
    enterPlayerMode();
    updatePill();
    updateNavTitle();
    updateHash();

    const video = playlist[idx];
    if (video && video.transcode) {
      const startRes = await fetch('/api/hls/start?path=' + encodeURIComponent(path) + volParam(), { method: 'POST' });
      const data = await startRes.json();
      if (data.error) return;
      activeHlsSession = data.sessionId;
      videoEl.src = data.playlistUrl;
    } else {
      videoEl.src = '/api/stream/' + encodeURIComponent(path).replace(/%2F/g, '/') + '?' + volParam().slice(1);
    }
    videoEl.play();
  }

  pillPrev.addEventListener('click', () => {
    const items = isPlayerMode ? playlist : siblingFolders;
    const idx = isPlayerMode ? playlistIndex : siblingIndex;
    if (items.length < 2) return;
    const ni = wrapIndex(idx, -1, items.length);
    if (isPlayerMode) { playVideo(items[ni].path, items[ni].name); }
    else { navigate(items[ni].path); }
  });

  pillNext.addEventListener('click', () => {
    const items = isPlayerMode ? playlist : siblingFolders;
    const idx = isPlayerMode ? playlistIndex : siblingIndex;
    if (items.length < 2) return;
    const ni = wrapIndex(idx, 1, items.length);
    if (isPlayerMode) { playVideo(items[ni].path, items[ni].name); }
    else { navigate(items[ni].path); }
  });

  // Long-press popover
  const peekPop = document.getElementById('peek-popover');
  let lpTimer = null;

  function clearLongPress() {
    clearTimeout(lpTimer);
    lpTimer = null;
  }

  function closePeek() { peekPop.classList.remove('open'); }
  document.addEventListener('click', closePeek);

  function showPeek(anchor, html) {
    peekPop.innerHTML = html;
    peekPop.classList.add('open');
    const rect = anchor.getBoundingClientRect();
    peekPop.style.top = (rect.bottom + 6) + 'px';
    const right = window.innerWidth - rect.right;
    const left = rect.left;
    if (right < 220) {
      peekPop.style.right = Math.max(8, right) + 'px';
      peekPop.style.left = '';
    } else {
      peekPop.style.left = Math.max(8, left) + 'px';
      peekPop.style.right = '';
    }
  }

  function peekItemHtml(name, icon, isCurrent) {
    return '<div class="popover-item' + (isCurrent ? ' current' : '') + '"><span class="popover-icon">' + icon + '</span><span class="popover-name">' + esc(name) + '</span></div>';
  }

  function buildPillPeekHtml() {
    let items, idx, icon;
    if (isPlayerMode) {
      items = playlist;
      idx = playlistIndex;
      icon = ICN.play;
    } else {
      items = siblingFolders;
      idx = siblingIndex;
      icon = ICN.folder;
    }
    if (items.length === 0) return '<div class="popover-empty">No items</div>';

    const count = Math.min(5, items.length - 1);
    let html = '';
    for (let d = -count; d <= count; d++) {
      const i = (idx + d + items.length) % items.length;
      if (d !== 0 && i === idx) continue;
      const item = items[i];
      const clickAttr = isPlayerMode
        ? ' onclick="popNav(\\'video\\','+i+')"'
        : ' onclick="popNav(\\'folder\\','+i+')"';
      html += '<div class="popover-item' + (i === idx ? ' current' : '') + '"' + clickAttr + '><span class="popover-icon">' + icon + '</span><span class="popover-name">' + esc(item.name) + '</span></div>';
    }
    return html;
  }

  window.popNav = function(type, idx) {
    closePeek();
    if (type === 'video') {
      const v = playlist[idx];
      if (v) playVideo(v.path, v.name);
    } else {
      const f = siblingFolders[idx];
      if (f) navigate(f.path);
    }
  };

  window.popNavFolder = function(path) {
    closePeek();
    navigate(path);
  };

  window.popPlayFromFolder = function(path, name) {
    closePeek();
    const parts = path.split('/');
    parts.pop();
    const dir = parts.length ? parts.join('/') : null;
    navigate(dir, path);
  };

  function addLongPress(el, handler) {
    el.addEventListener('touchstart', (e) => {
      clearLongPress();
      lpTimer = setTimeout(() => {
        e.preventDefault();
        handler(el);
      }, 500);
    }, { passive: false });
    el.addEventListener('touchend', clearLongPress);
    el.addEventListener('touchmove', clearLongPress);
    el.addEventListener('touchcancel', clearLongPress);
  }

  addLongPress(pillPrev, (el) => showPeek(el, buildPillPeekHtml()));
  addLongPress(pillNext, (el) => showPeek(el, buildPillPeekHtml()));

  async function showFolderPeek(el, folderPath) {
    const url = '/api/browse?dir=' + encodeURIComponent(folderPath) + volParam();
    try {
      const res = await fetch(url);
      const data = await res.json();
      const items = [...data.folders.slice(0, 5), ...data.videos.slice(0, 5)].slice(0, 5);
      if (items.length === 0) {
        showPeek(el, '<div class="popover-empty">Empty folder</div>');
        return;
      }
      let html = '<div class="popover-title">' + esc(folderPath.split('/').pop()) + '</div>';
      for (const item of items) {
        const isFolder = !('size' in item);
        const icon = isFolder ? ICN.folder : ICN.play;
        const click = isFolder
          ? ' onclick="popNavFolder(\\'' + esc(item.path).replace(/'/g,"\\\\'") + '\\')"'
          : ' onclick="popPlayFromFolder(\\'' + esc(item.path).replace(/'/g,"\\\\'") + '\\',\\'' + esc(item.name).replace(/'/g,"\\\\'") + '\\')"';
        html += '<div class="popover-item"' + click + '><span class="popover-icon">' + icon + '</span><span class="popover-name">' + esc(item.name) + '</span></div>';
      }
      const total = data.folders.length + data.videos.length;
      if (total > 5) html += '<div class="popover-item" style="color:var(--text-dim);font-size:0.75rem;pointer-events:none">... ' + (total - 5) + ' more</div>';
      showPeek(el, html);
    } catch {}
  }

  // Delegated long-press for folder and video items
  library.addEventListener('touchstart', (e) => {
    const folder = e.target.closest('[data-folder-path]');
    const video = e.target.closest('[data-video-path]');
    if (!folder && !video) return;
    clearLongPress();
    lpTimer = setTimeout(() => {
      e.preventDefault();
      if (folder) {
        showFolderPeek(folder, folder.dataset.folderPath);
      } else if (video) {
        const path = video.dataset.videoPath;
        const name = video.dataset.videoName;
        const vol = video.dataset.videoVol || '';
        const isFav = isFavorite(path);
        const favLabel = isFav ? 'Remove from Favorites' : 'Add to Favorites';
        const action = isFav ? 'removeFav' : 'addFav';
        const parts = path.split('/');
        parts.pop();
        const parentDir = parts.length ? parts.join('/') : null;
        let peekHtml = '<div class="popover-item" onclick="toggleFav(\\'' + action + '\\',\\'' + esc(path).replace(/'/g,"\\\\'") + '\\',\\'' + esc(name).replace(/'/g,"\\\\'") + '\\')"><span class="popover-icon">' + STAR_ICON + '</span><span class="popover-name">' + favLabel + '</span></div>';
        if (parentDir && !currentDir) {
          peekHtml += '<div class="popover-item" onclick="goToFavFolder(\\'' + esc(vol).replace(/'/g,"\\\\'") + '\\',\\'' + esc(parentDir).replace(/'/g,"\\\\'") + '\\')"><span class="popover-icon">' + ICN.folder + '</span><span class="popover-name">Go to folder</span></div>';
        }
        showPeek(video, peekHtml);
      }
    }, 500);
  }, { passive: false });
  library.addEventListener('touchend', clearLongPress);
  library.addEventListener('touchmove', clearLongPress);
  library.addEventListener('touchcancel', clearLongPress);

  window.goToFavFolder = function(vol, dir) {
    closePeek();
    currentVol = vol || null;
    navigate(dir);
  };

  window.toggleFav = function(action, path, name) {
    closePeek();
    if (action === 'addFav') {
      const v = playlist.find(v => v.path === path);
      if (v) addFavorite(v);
    } else {
      removeFavorite(path);
      if (!currentDir && !currentVol) showVolumes();
    }
  };

  function sortItems(list) {
    const sorted = [...list];
    switch (sortMode) {
      case 'name-asc':  return sorted.sort((a,b) => a.name.localeCompare(b.name));
      case 'name-desc': return sorted.sort((a,b) => b.name.localeCompare(a.name));
      case 'size-asc':  return sorted.sort((a,b) => (a.size || 0) - (b.size || 0));
      case 'size-desc': return sorted.sort((a,b) => (b.size || 0) - (a.size || 0));
      case 'date-asc':  return sorted.sort((a,b) => (a.mtime || 0) - (b.mtime || 0));
      case 'date-desc': return sorted.sort((a,b) => (b.mtime || 0) - (a.mtime || 0));
    }
    return sorted;
  }

  function render(data) {
    currentData = data;
    const dir = data.dir;

    const sortedFolders = sortItems(data.folders);
    const sorted = sortItems(data.videos);
    playlist = sorted;
    playlistIndex = -1;
    updateNavTitle();
    updatePill();
    const totalItems = sortedFolders.length + sorted.length;

    if (totalItems === 0) {
      if (!dir && !currentVol) {
        library.innerHTML = '<div class="empty">No videos found.<br>Pass your media directory as an argument:<br><code>node server.js /path/to/videos</code></div>';
      } else {
        library.innerHTML = '<div class="empty">Empty folder</div>';
      }
      return;
    }

    let html = '<div class="item-list">';

    for (const folder of sortedFolders) {
      html += '<div class="item" data-folder-path="' + esc(folder.path) + '" onclick="navigate(\\'' + esc(folder.path).replace(/'/g,"\\\\'") + '\\')">'
        + '<div class="icon icon-folder"><svg viewBox="0 0 16 16"><path d="M1 3h5l2 2h7v9H1V3z"/></svg></div>'
        + '<div class="item-info"><div class="item-name">' + esc(folder.name) + '</div></div></div>';
    }

    for (const v of sorted) {
      const iconClass = v.transcode ? 'icon-transcode' : 'icon-play';
      const star = isFavorite(v.path) ? STAR_BADGE : '';
      html += '<div class="item" data-video-path="' + esc(v.path) + '" data-video-name="' + esc(v.name) + '" onclick="playVideo(\\'' + esc(v.path).replace(/'/g,"\\\\'") + '\\',\\'' + esc(v.name).replace(/'/g,"\\\\'") + '\\')">'
        + '<div class="icon ' + iconClass + '"><svg viewBox="0 0 16 16"><polygon points="4,2 14,8 4,14"/></svg>' + star + '</div>'
        + '<div class="item-info"><div class="item-name">' + esc(v.name) + '</div>'
        + '<div class="item-size">' + fmtSize(v.size) + '</div></div></div>';
    }

    html += '</div>';
    library.innerHTML = html;
  }

  async function fetchSiblings(dir) {
    if (!dir) {
      siblingFolders = [];
      siblingIndex = -1;
      return;
    }
    const parts = dir.split('/');
    const current = parts.pop();
    const parentDir = parts.length ? parts.join('/') : null;
    const parentUrl = (parentDir ? '/api/browse?dir=' + encodeURIComponent(parentDir) : '/api/browse?_=1') + volParam();
    try {
      const res = await fetch(parentUrl);
      const parentData = await res.json();
      siblingFolders = parentData.folders;
      siblingIndex = siblingFolders.findIndex(f => f.name === current);
    } catch {
      siblingFolders = [];
      siblingIndex = -1;
    }
  }

  async function navigate(dir, autoPlay) {
    if (!dir && !currentVol && !autoPlay) {
      showVolumes();
      return;
    }
    currentDir = dir;
    const url = (dir ? '/api/browse?dir=' + encodeURIComponent(dir) : '/api/browse?_=1') + volParam();
    const [res] = await Promise.all([fetch(url), fetchSiblings(dir)]);
    const data = await res.json();
    render(data);
    if (!autoPlay) updateHash();
    window.scrollTo(0, 0);
    if (autoPlay) {
      const v = playlist.find(v => v.path === autoPlay);
      if (v) playVideo(v.path, v.name);
    }
  }

  async function showVolumes() {
    currentDir = null;
    currentVol = null;
    playlist = [];
    playlistIndex = -1;
    siblingFolders = [];
    siblingIndex = -1;
    updateNavTitle();
    updatePill();
    updateHash();

    const res = await fetch('/api/volumes');
    const volumes = await res.json();
    cachedVolumes = volumes;

    // Also show the default media dir content
    const browseRes = await fetch('/api/browse?_=1');
    const browseData = await browseRes.json();
    const sortedFolders = sortItems(browseData.folders);
    const sorted = sortItems(browseData.videos);
    playlist = sorted;

    let html = '';
    if (volumes.length > 0) {
      html += '<div style="padding:8px 16px 4px;font-size:0.8rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.04em">Volumes</div>';
      html += '<div class="item-list" style="padding:0 16px 16px">';
      for (const vol of volumes) {
        html += '<div class="item" onclick="selectVolume(\\'' + esc(vol).replace(/'/g,"\\\\'") + '\\')">'
          + '<div class="icon icon-volume"><svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="white" stroke-width="1.2"/><line x1="2" y1="9" x2="14" y2="9" stroke="white" stroke-width="1"/><circle cx="11.5" cy="11" r="0.9" fill="white"/></svg></div>'
          + '<div class="item-info"><div class="item-name">' + esc(vol) + '</div></div></div>';
      }
      html += '</div>';
    }

    const allFavs = getAllFavorites();
    if (allFavs.length > 0) {
      html += '<div style="padding:8px 16px 4px;font-size:0.8rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.04em">Favorites</div>';
      html += '<div class="item-list" style="padding:0 16px 16px">';
      for (const v of allFavs) {
        const iconClass = v.transcode ? 'icon-transcode' : 'icon-play';
        const vol = v._source === 'local' ? '' : v._source;
        html += '<div class="item" data-video-path="' + esc(v.path) + '" data-video-name="' + esc(v.name) + '" data-video-vol="' + esc(vol) + '" onclick="playFavVol(\\'' + esc(vol).replace(/'/g,"\\\\'") + '\\',\\'' + esc(v.path).replace(/'/g,"\\\\'") + '\\',\\'' + esc(v.name).replace(/'/g,"\\\\'") + '\\')">'
          + '<div class="icon ' + iconClass + '"><svg viewBox="0 0 16 16"><polygon points="4,2 14,8 4,14"/></svg>' + STAR_BADGE + '</div>'
          + '<div class="item-info"><div class="item-name">' + esc(v.name) + '</div>'
          + (vol ? '<div class="item-size">' + esc(vol) + '</div>' : (v.size ? '<div class="item-size">' + fmtSize(v.size) + '</div>' : '')) + '</div></div>';
      }
      html += '</div>';
    }

    if (sortedFolders.length || sorted.length) {
      if (volumes.length > 0) {
        html += '<div style="padding:8px 16px 4px;font-size:0.8rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.04em">Local</div>';
      }
      html += '<div class="item-list" style="padding:0 16px 16px">';
      for (const folder of sortedFolders) {
        html += '<div class="item" data-folder-path="' + esc(folder.path) + '" onclick="navigate(\\'' + esc(folder.path).replace(/'/g,"\\\\'") + '\\')">'
          + '<div class="icon icon-folder"><svg viewBox="0 0 16 16"><path d="M1 3h5l2 2h7v9H1V3z"/></svg></div>'
          + '<div class="item-info"><div class="item-name">' + esc(folder.name) + '</div></div></div>';
      }
      for (const v of sorted) {
        const iconClass = v.transcode ? 'icon-transcode' : 'icon-play';
        const star = isFavorite(v.path) ? STAR_BADGE : '';
        html += '<div class="item" data-video-path="' + esc(v.path) + '" data-video-name="' + esc(v.name) + '" onclick="playVideo(\\'' + esc(v.path).replace(/'/g,"\\\\'") + '\\',\\'' + esc(v.name).replace(/'/g,"\\\\'") + '\\')">'
          + '<div class="icon ' + iconClass + '"><svg viewBox="0 0 16 16"><polygon points="4,2 14,8 4,14"/></svg>' + star + '</div>'
          + '<div class="item-info"><div class="item-name">' + esc(v.name) + '</div>'
          + '<div class="item-size">' + fmtSize(v.size) + '</div></div></div>';
      }
      html += '</div>';
    }

    if (!html) {
      html = '<div class="empty">No videos found.<br>Pass your media directory as an argument:<br><code>node server.js /path/to/videos</code></div>';
    }

    library.innerHTML = html;
    window.scrollTo(0, 0);
  }

  window.playFav = function(path, name) {
    const parts = path.split('/');
    parts.pop();
    const dir = parts.length ? parts.join('/') : null;
    navigate(dir, path);
  };

  window.playFavVol = function(vol, path, name) {
    currentVol = vol || null;
    const parts = path.split('/');
    parts.pop();
    const dir = parts.length ? parts.join('/') : null;
    navigate(dir, path);
  };

  function selectVolume(vol) {
    currentVol = vol;
    navigate(null);
  }

  // expose to inline onclick handlers
  window.navigate = navigate;
  window.playVideo = playVideo;
  window.selectVolume = selectVolume;
  window.addEventListener('beforeunload', stopHls);

  // init: fetch config + volumes, then restore state
  Promise.all([
    fetch('/api/config').then(r => r.json()),
    fetch('/api/volumes').then(r => r.json()),
  ]).then(([config, volumes]) => {
    serverMediaDir = config.mediaDir;
    cachedVolumes = volumes;
    const initial = parseHash();
    if (initial.vol) {
      currentVol = initial.vol;
      navigate(initial.dir || null, initial.play || null);
    } else if (initial.dir || initial.play) {
      navigate(initial.dir || null, initial.play || null);
    } else {
      showVolumes();
    }
  });
</script>
</body>
</html>`;

app.listen(PORT, "0.0.0.0", () => {
  const ips = getLocalIPs();
  console.log("Video Streamer running on port " + PORT);
  console.log("  Media directory: " + MEDIA_DIR);
  console.log("  Local:  http://localhost:" + PORT);
  for (const ip of ips) console.log("  Network: http://" + ip + ":" + PORT);
});
