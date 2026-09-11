#!/usr/bin/env node
// Local timeline editor for stitching Hook + Gameplay + Endcard exports.
// No external dependencies -- Node's stdlib only.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const EXPORT_DIR = path.join(ROOT, "Exports");
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = process.env.PORT || 5175;

const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg"]);

const CANVAS_W = 1080, CANVAS_H = 1920, FPS = 30;
const AUDIO_RATE = 48000, AUDIO_LAYOUT = "stereo";

fs.mkdirSync(EXPORT_DIR, { recursive: true });

function ffprobe(filePath) {
  const res = spawnSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=width,height,codec_type",
    "-of", "json", filePath,
  ]);
  if (res.status !== 0) throw new Error(`ffprobe failed for ${filePath}: ${res.stderr}`);
  const data = JSON.parse(res.stdout.toString());
  const duration = parseFloat(data.format?.duration || "0");
  const vstream = (data.streams || []).find((s) => s.codec_type === "video") || {};
  return { duration, width: vstream.width || null, height: vstream.height || null };
}

function discoverAssets() {
  const hooks = [], gameplays = [], endcards = [];
  const entries = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "Exports" && d.name !== "editor" && !d.name.startsWith("."));

  for (const dir of entries) {
    const lower = dir.name.toLowerCase();
    let bucket = null;
    if (lower.includes("hook")) bucket = hooks;
    else if (lower.includes("gp") || lower.includes("gameplay")) bucket = gameplays;
    else if (lower.includes("end")) bucket = endcards;
    else continue;

    const dirPath = path.join(ROOT, dir.name);
    for (const file of fs.readdirSync(dirPath).sort()) {
      const ext = path.extname(file).toLowerCase();
      if (!VIDEO_EXT.has(ext) && !IMAGE_EXT.has(ext)) continue;
      const full = path.join(dirPath, file);
      const rel = path.relative(ROOT, full);
      const isImage = IMAGE_EXT.has(ext);
      let meta = { duration: 0, width: null, height: null };
      try { meta = isImage ? { duration: 0, width: null, height: null } : ffprobe(full); }
      catch (e) { console.error(e.message); }
      bucket.push({
        name: file,
        rel,
        isImage,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
      });
    }
  }
  return { hooks, gameplays, endcards };
}

// Whitelist check: resolved path must live inside one of the asset folders.
function resolveAssetPath(rel) {
  const full = path.resolve(ROOT, rel);
  if (!full.startsWith(ROOT + path.sep)) return null;
  if (!fs.existsSync(full)) return null;
  return full;
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function serveStatic(req, res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    const ext = path.extname(filePath);
    const type = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css" }[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
}

function streamFile(req, res, filePath) {
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const type = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/mp4",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" }[ext] || "application/octet-stream";

  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Accept-Ranges": "bytes" });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  const match = /bytes=(\d*)-(\d*)/.exec(range);
  let start = match[1] ? parseInt(match[1], 10) : 0;
  let end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
  end = Math.min(end, stat.size - 1);
  res.writeHead(206, {
    "Content-Type": type,
    "Content-Range": `bytes ${start}-${end}/${stat.size}`,
    "Accept-Ranges": "bytes",
    "Content-Length": end - start + 1,
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

// Decompose an arbitrary speed factor into a chain of atempo filters,
// since a single atempo instance only accepts 0.5-2.0.
function atempoChain(speed) {
  let remaining = speed;
  const steps = [];
  while (remaining > 2.0) { steps.push(2.0); remaining /= 2.0; }
  while (remaining < 0.5) { steps.push(0.5); remaining /= 0.5; }
  steps.push(remaining);
  return steps.map((s) => `atempo=${s.toFixed(4)}`).join(",");
}

function runExport(payload, cb) {
  const { hook, gameplay, endcard, target } = payload;
  const order = Array.isArray(payload.order) && payload.order.length === 3
    ? payload.order : ["hook", "gp", "end"];

  const hookFull = resolveAssetPath(hook.rel);
  const gpFull = resolveAssetPath(gameplay.rel);
  const endFull = resolveAssetPath(endcard.rel);
  if (!hookFull || !gpFull || !endFull) return cb(new Error("invalid asset path"));

  const hookIn = Math.max(0, hook.in), hookOut = Math.max(hookIn + 0.05, hook.out);
  const gpIn = Math.max(0, gameplay.in), gpOut = Math.max(gpIn + 0.05, gameplay.out);
  const endDur = Math.max(0.2, endcard.duration);
  const isImage = IMAGE_EXT.has(path.extname(endFull).toLowerCase());

  const hookSpeed = Math.min(4, Math.max(0.1, hook.speed || 1));
  const gpSpeed = Math.min(4, Math.max(0.1, gameplay.speed || 1));
  const endSpeed = Math.min(4, Math.max(0.1, endcard.speed || 1));

  const gpMeta = ffprobe(gpFull);
  const gpNeedsLoop = gpOut > gpMeta.duration + 0.05;

  const slug = (p) => path.basename(p, path.extname(p)).replace(/[^A-Za-z0-9]+/g, "");
  const outName = `${slug(hookFull)}_${slug(gpFull)}_${target}s_${crypto.randomBytes(2).toString("hex")}.mp4`;
  const outPath = path.join(EXPORT_DIR, outName);

  const vf = `scale=${CANVAS_W}:${CANVAS_H}:force_original_aspect_ratio=increase,crop=${CANVAS_W}:${CANVAS_H},setsar=1,fps=${FPS},format=yuv420p`;
  const af = `aformat=sample_rates=${AUDIO_RATE}:channel_layouts=${AUDIO_LAYOUT}`;

  const args = ["-y", "-loglevel", "error"];
  const filters = [];
  const segLabels = {}; // key -> {v, a}
  let inputIdx = 0;

  // hook
  args.push("-ss", hookIn.toFixed(3), "-t", (hookOut - hookIn).toFixed(3), "-i", hookFull);
  filters.push(`[${inputIdx}:v]${vf},setpts=PTS*${(1 / hookSpeed).toFixed(6)}[v_hook]`);
  filters.push(`[${inputIdx}:a]${af},${atempoChain(hookSpeed)}[a_hook]`);
  segLabels.hook = { v: "v_hook", a: "a_hook" };
  inputIdx++;

  // gameplay (loop the source if the requested range runs past its end)
  if (gpNeedsLoop) args.push("-stream_loop", "-1");
  args.push("-ss", gpIn.toFixed(3), "-t", (gpOut - gpIn).toFixed(3), "-i", gpFull);
  filters.push(`[${inputIdx}:v]${vf},setpts=PTS*${(1 / gpSpeed).toFixed(6)}[v_gp]`);
  filters.push(`[${inputIdx}:a]${af},${atempoChain(gpSpeed)}[a_gp]`);
  segLabels.gp = { v: "v_gp", a: "a_gp" };
  inputIdx++;

  // endcard
  if (isImage) {
    args.push("-loop", "1", "-t", endDur.toFixed(3), "-i", endFull);
    filters.push(`[${inputIdx}:v]${vf}[v_end]`);
    inputIdx++;
    args.push("-f", "lavfi", "-t", endDur.toFixed(3), "-i", `anullsrc=r=${AUDIO_RATE}:cl=${AUDIO_LAYOUT}`);
    filters.push(`[${inputIdx}:a]anull[a_end]`);
    inputIdx++;
  } else {
    args.push("-ss", (endcard.in || 0).toFixed(3), "-t", (endDur * endSpeed).toFixed(3), "-i", endFull);
    filters.push(`[${inputIdx}:v]${vf},setpts=PTS*${(1 / endSpeed).toFixed(6)}[v_end]`);
    filters.push(`[${inputIdx}:a]${af},${atempoChain(endSpeed)}[a_end]`);
    inputIdx++;
  }
  segLabels.end = { v: "v_end", a: "a_end" };

  const concatInputs = order.map((key) => `[${segLabels[key].v}][${segLabels[key].a}]`).join("");
  filters.push(`${concatInputs}concat=n=3:v=1:a=1[outv][outa]`);

  args.push("-filter_complex", filters.join(";"));
  args.push("-map", "[outv]", "-map", "[outa]");
  args.push("-c:v", "libx264", "-preset", "medium", "-crf", "20");
  args.push("-c:a", "aac", "-b:a", "192k");
  args.push("-pix_fmt", "yuv420p");
  args.push(outPath);

  const proc = spawn("ffmpeg", args);
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  proc.on("close", (code) => {
    if (code === 0) cb(null, { file: outName, url: `/exports/${outName}` });
    else cb(new Error(stderr || `ffmpeg exited ${code}`));
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/" ) return serveStatic(req, res, path.join(PUBLIC_DIR, "index.html"));
  if (url.pathname === "/app.js") return serveStatic(req, res, path.join(PUBLIC_DIR, "app.js"));
  if (url.pathname === "/styles.css") return serveStatic(req, res, path.join(PUBLIC_DIR, "styles.css"));

  if (url.pathname === "/api/assets" && req.method === "GET") {
    try { return sendJSON(res, 200, discoverAssets()); }
    catch (e) { return sendJSON(res, 500, { error: e.message }); }
  }

  if (url.pathname === "/media" && req.method === "GET") {
    const rel = url.searchParams.get("path");
    const full = rel && resolveAssetPath(rel);
    if (!full) return sendJSON(res, 404, { error: "not found" });
    return streamFile(req, res, full);
  }

  if (url.pathname === "/api/export" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(body); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
      runExport(payload, (err, result) => {
        if (err) return sendJSON(res, 500, { error: err.message });
        sendJSON(res, 200, { ok: true, ...result });
      });
    });
    return;
  }

  if (url.pathname === "/api/exports" && req.method === "GET") {
    const files = fs.readdirSync(EXPORT_DIR)
      .filter((f) => f.toLowerCase().endsWith(".mp4"))
      .map((f) => {
        const stat = fs.statSync(path.join(EXPORT_DIR, f));
        return { name: f, url: `/exports/${f}`, size: stat.size, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return sendJSON(res, 200, { files });
  }

  if (url.pathname.startsWith("/exports/") && req.method === "GET") {
    const name = decodeURIComponent(url.pathname.slice("/exports/".length));
    const full = path.join(EXPORT_DIR, name);
    if (!full.startsWith(EXPORT_DIR + path.sep) || !fs.existsSync(full)) return sendJSON(res, 404, { error: "not found" });
    return streamFile(req, res, full);
  }

  if (url.pathname === "/api/exports" && req.method === "DELETE") {
    const files = fs.readdirSync(EXPORT_DIR).filter((f) => f.toLowerCase().endsWith(".mp4"));
    files.forEach((f) => fs.unlinkSync(path.join(EXPORT_DIR, f)));
    return sendJSON(res, 200, { deleted: files.length });
  }

  if (url.pathname.startsWith("/exports/") && req.method === "DELETE") {
    const name = decodeURIComponent(url.pathname.slice("/exports/".length));
    const full = path.join(EXPORT_DIR, name);
    if (!full.startsWith(EXPORT_DIR + path.sep) || !fs.existsSync(full)) return sendJSON(res, 404, { error: "not found" });
    fs.unlinkSync(full);
    return sendJSON(res, 200, { ok: true });
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`Creative editor running at http://localhost:${PORT}`);
});
