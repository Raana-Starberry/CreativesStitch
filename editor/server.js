#!/usr/bin/env node
// Local timeline editor for stitching Hook + Gameplay + Endcard exports.
// No external dependencies -- Node's stdlib only.

const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const EXPORT_DIR = path.join(ROOT, "Exports");
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = process.env.PORT || 5175;

// Minimal .env loader (no npm dependency) -- doesn't override already-set env vars.
(function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_STT_MODEL = process.env.ELEVENLABS_STT_MODEL || "scribe_v1";

const MUSIC_PRESETS = {
  upbeat: "upbeat energetic pop, bright and positive mood, mobile game ad background music, instrumental",
  chill: "chill relaxed lo-fi, calm easygoing mood, mobile game ad background music, instrumental",
  playful: "playful whimsical, fun and bouncy, casual mobile game ad background music, instrumental",
  epic: "epic cinematic orchestral, big and triumphant, mobile game ad background music, instrumental",
  suspenseful: "tense suspenseful, steadily building energy, mobile game ad background music, instrumental",
};
const MUSIC_MIX_VOLUME = 0.18; // background music level, mixed under the existing (full-volume) audio

// Burned-in captions need libass (the `subtitles` filter), which the default
// Homebrew `ffmpeg` formula ships without. `ffmpeg-full` (also in
// homebrew-core) has it, is keg-only, and doesn't touch the default `ffmpeg`
// on PATH -- so only this one operation uses it, everything else keeps using
// plain `ffmpeg`.
function resolveSubtitlesFfmpeg() {
  if (process.env.FFMPEG_FULL_BIN) return process.env.FFMPEG_FULL_BIN;
  const candidates = [
    "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg",
    "/usr/local/opt/ffmpeg-full/bin/ffmpeg",
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return "ffmpeg"; // fallback -- burn-in will fail if this build lacks libass
}

const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg"]);

const FPS = 30;
const AUDIO_RATE = 48000, AUDIO_LAYOUT = "stereo";
const TRANSITION_DUR = 0.4; // seconds -- crossfade between consecutive segments (hook/gameplay/endcard), whatever order they're in

const ASPECT_RATIOS = {
  "9x16": { w: 1080, h: 1920 },
  "16x9": { w: 1920, h: 1080 },
  "4x5": { w: 1080, h: 1350 },
};
function resolveAspect(key) {
  return ASPECT_RATIOS[key] || ASPECT_RATIOS["9x16"];
}

const LANGUAGES = ["EN", "ES", "IT", "TR", "DE"];

fs.mkdirSync(EXPORT_DIR, { recursive: true });

// Files "removed" from the list are hidden here, not deleted from disk.
const HIDDEN_FILE = path.join(EXPORT_DIR, ".hidden.json");
function loadHidden() {
  try { return JSON.parse(fs.readFileSync(HIDDEN_FILE, "utf8")); }
  catch { return []; }
}
function saveHidden(list) {
  fs.writeFileSync(HIDDEN_FILE, JSON.stringify(list));
}

// Exports live in one subfolder per recipe (see runExport), so listing needs
// to walk one level of subdirectories, not just the top of EXPORT_DIR.
function listExportFiles() {
  const out = [];
  for (const entry of fs.readdirSync(EXPORT_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const f of fs.readdirSync(path.join(EXPORT_DIR, entry.name))) {
        if (f.toLowerCase().endsWith(".mp4")) out.push(path.join(entry.name, f));
      }
    } else if (entry.name.toLowerCase().endsWith(".mp4")) {
      out.push(entry.name); // legacy flat files from before recipe folders existed
    }
  }
  return out;
}

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
  const hasAudio = (data.streams || []).some((s) => s.codec_type === "audio");
  return { duration, width: vstream.width || null, height: vstream.height || null, hasAudio };
}

function discoverAssets() {
  const hooks = [], gameplays = [], endcards = [], ctas = [];
  const entries = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "Exports" && d.name !== "editor" && !d.name.startsWith("."));

  for (const dir of entries) {
    const lower = dir.name.toLowerCase();
    let bucket = null;
    if (lower.includes("cta")) bucket = ctas;
    else if (lower.includes("hook")) bucket = hooks;
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
  return { hooks, gameplays, endcards, ctas };
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

const CTA_VERTICAL_FRAC = 0.6; // where the button's vertical center sits, as a fraction of canvas height from the top
const CTA_BASE_HEIGHT = 1920; // 9x16's height -- the reference the CTA's "100% / original size" is defined against
const CTA_SCALE_ANIM_DUR = 0.35; // seconds for the soft scale-in
const CTA_PULSE_AMPLITUDE = 0.06; // +/- size wobble during the hold, as a fraction
const CTA_PULSE_PERIOD = 0.9; // seconds per pulse cycle

// A soft pop: eased 0->1 over the first CTA_SCALE_ANIM_DUR seconds, then a
// gentle continuous "tap me" pulse for the rest of the endcard -- no
// scale-out, it stays pulsing right up to the end. `t` here is local to the
// CTA image's own input stream, which starts at 0 in step with the endcard
// segment it's overlaid onto (both begin decoding at the same point,
// pre-concat), so this lines up correctly with that segment's real duration.
function ctaScaleExpr() {
  const a = CTA_SCALE_ANIM_DUR;
  const pulse = `1+${CTA_PULSE_AMPLITUDE}*sin(2*PI*(t-${a})/${CTA_PULSE_PERIOD})`;
  return `max(0.05,if(lt(t,${a}),sin(min(t/${a},1)*PI/2),${pulse}))`;
}

const LANDSCAPE_FG_HEIGHT_FRAC = 1.0; // foreground height as a fraction of the 16x9 canvas -- full height, empty space only on the sides
const LANDSCAPE_BLUR_SIGMA = 20;

// Builds the scale/crop/format filter chain for one video stream. Sources
// here are usually portrait (9x16-shot), so force-cropping them to fill a
// 16x9 landscape frame would throw away most of the shot -- instead, 16x9
// gets a blurred, full-bleed copy of the same video as background, with the
// uncropped source composited on top at LANDSCAPE_FG_HEIGHT_FRAC of the
// canvas height. 9x16/4x5 keep the plain crop-to-fill.
function buildVideoFilter(filters, srcPad, outPad, canvasW, canvasH, aspectKey, ptsFactor) {
  const ptsPart = ptsFactor ? `,setpts=PTS*${ptsFactor}` : "";
  if (aspectKey === "16x9") {
    const fgH = Math.round(canvasH * LANDSCAPE_FG_HEIGHT_FRAC);
    const tag = crypto.randomBytes(3).toString("hex");
    filters.push(`[${srcPad}]split=2[bg${tag}][fg${tag}]`);
    filters.push(`[bg${tag}]scale=${canvasW}:${canvasH}:force_original_aspect_ratio=increase,crop=${canvasW}:${canvasH},gblur=sigma=${LANDSCAPE_BLUR_SIGMA},setsar=1[bgd${tag}]`);
    filters.push(`[fg${tag}]scale=-2:${fgH}[fgd${tag}]`);
    filters.push(`[bgd${tag}][fgd${tag}]overlay=(W-w)/2:(H-h)/2,fps=${FPS},format=yuv420p${ptsPart}[${outPad}]`);
  } else {
    filters.push(`[${srcPad}]scale=${canvasW}:${canvasH}:force_original_aspect_ratio=increase,crop=${canvasW}:${canvasH},setsar=1,fps=${FPS},format=yuv420p${ptsPart}[${outPad}]`);
  }
}

// Some source clips (e.g. silent b-roll) have no audio stream at all.
// Referencing a nonexistent `N:a` pad makes ffmpeg's filtergraph binding
// fail outright ("matches no streams"), killing the whole export -- not
// just that segment. When the source has no audio, this pushes a silent
// anullsrc input instead, so the export still succeeds with silence for
// that segment (matching how the image-endcard case already behaves).
// `curIdx` is the index of the segment's video input, already pushed to
// args; returns the next free input index.
function addSegmentAudio(args, filters, af, hasAudio, curIdx, outDurSec, speed, outLabel) {
  if (hasAudio) {
    filters.push(`[${curIdx}:a]${af},${atempoChain(speed)}[${outLabel}]`);
    return curIdx + 1;
  }
  args.push("-f", "lavfi", "-t", outDurSec.toFixed(3), "-i", `anullsrc=r=${AUDIO_RATE}:cl=${AUDIO_LAYOUT}`);
  filters.push(`[${curIdx + 1}:a]anull[${outLabel}]`);
  return curIdx + 2;
}

function runExport(payload, cb) {
  const { hook, gameplay, endcard, target, cta } = payload;
  const order = Array.isArray(payload.order) && payload.order.length === 3
    ? payload.order : ["hook", "gp", "end"];

  const hookFull = resolveAssetPath(hook.rel);
  const gpFull = resolveAssetPath(gameplay.rel);
  const endFull = resolveAssetPath(endcard.rel);
  if (!hookFull || !gpFull || !endFull) return cb(new Error("invalid asset path"));

  const ctaFull = cta && cta.enabled && cta.rel ? resolveAssetPath(cta.rel) : null;

  const hookIn = Math.max(0, hook.in), hookOut = Math.max(hookIn + 0.05, hook.out);
  const gpIn = Math.max(0, gameplay.in), gpOut = Math.max(gpIn + 0.05, gameplay.out);
  const endDur = Math.max(0.2, endcard.duration);
  const isImage = IMAGE_EXT.has(path.extname(endFull).toLowerCase());

  const hookSpeed = Math.min(4, Math.max(0.1, hook.speed || 1));
  const gpSpeed = Math.min(4, Math.max(0.1, gameplay.speed || 1));
  const endSpeed = Math.min(4, Math.max(0.1, endcard.speed || 1));

  const gpMeta = ffprobe(gpFull);
  const gpNeedsLoop = gpOut > gpMeta.duration + 0.05;
  const hookMeta = ffprobe(hookFull);

  const aspectKey = Object.prototype.hasOwnProperty.call(ASPECT_RATIOS, payload.aspect) ? payload.aspect : "9x16";
  const { w: canvasW, h: canvasH } = resolveAspect(aspectKey);

  // Splits the filename into words on any non-alphanumeric run, then keeps
  // only the first 3 -- keeps the naming convention's Hook/GP name segments
  // short even when the source filename is long (e.g. a Higgsfield-generated
  // hook's prompt-derived name). Never includes anything from the endcard
  // or CTA -- the naming convention only ever reflects Hook and Gameplay.
  const slug = (p) => path.basename(p, path.extname(p))
    .split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 3).join("");
  const gameSlug = String(payload.gameName || "").replace(/[^A-Za-z0-9]+/g, "") || "Game";
  const language = LANGUAGES.includes(String(payload.language || "").toUpperCase())
    ? String(payload.language).toUpperCase() : "EN";
  const today = new Date();
  const dateStr = `${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, "0")}.${String(today.getDate()).padStart(2, "0")}`;
  // One folder per creative recipe (same naming, minus dimension) holds every
  // aspect-ratio variant of that recipe together:
  //   {Game}_{Date}_{Language}_{HookName}_{GPName}_{Duration}s/
  //     {Game}_{Dimension}_{Date}_{Language}_{HookName}_{GPName}_{Duration}s.mp4
  const recipeFolder = `${gameSlug}_${dateStr}_${language}_${slug(hookFull)}_${slug(gpFull)}_${target}s`;
  const fileName = `${gameSlug}_${aspectKey}_${dateStr}_${language}_${slug(hookFull)}_${slug(gpFull)}_${target}s.mp4`;
  const outName = path.join(recipeFolder, fileName); // relative to EXPORT_DIR -- used as the "file" identifier everywhere
  const outPath = path.join(EXPORT_DIR, outName);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const af = `aformat=sample_rates=${AUDIO_RATE}:channel_layouts=${AUDIO_LAYOUT}`;

  const args = ["-y", "-loglevel", "error"];
  const filters = [];
  const segLabels = {}; // key -> {v, a}
  let inputIdx = 0;

  // hook
  args.push("-ss", hookIn.toFixed(3), "-t", (hookOut - hookIn).toFixed(3), "-i", hookFull);
  buildVideoFilter(filters, `${inputIdx}:v`, "v_hook", canvasW, canvasH, aspectKey, (1 / hookSpeed).toFixed(6));
  inputIdx = addSegmentAudio(args, filters, af, hookMeta.hasAudio, inputIdx, (hookOut - hookIn) / hookSpeed, hookSpeed, "a_hook");
  segLabels.hook = { v: "v_hook", a: "a_hook" };

  // gameplay (loop the source if the requested range runs past its end)
  if (gpNeedsLoop) args.push("-stream_loop", "-1");
  args.push("-ss", gpIn.toFixed(3), "-t", (gpOut - gpIn).toFixed(3), "-i", gpFull);
  buildVideoFilter(filters, `${inputIdx}:v`, "v_gp", canvasW, canvasH, aspectKey, (1 / gpSpeed).toFixed(6));
  inputIdx = addSegmentAudio(args, filters, af, gpMeta.hasAudio, inputIdx, (gpOut - gpIn) / gpSpeed, gpSpeed, "a_gp");
  segLabels.gp = { v: "v_gp", a: "a_gp" };

  // endcard
  if (isImage) {
    args.push("-loop", "1", "-t", endDur.toFixed(3), "-i", endFull);
    buildVideoFilter(filters, `${inputIdx}:v`, "v_end", canvasW, canvasH, aspectKey, null);
    inputIdx++;
    args.push("-f", "lavfi", "-t", endDur.toFixed(3), "-i", `anullsrc=r=${AUDIO_RATE}:cl=${AUDIO_LAYOUT}`);
    filters.push(`[${inputIdx}:a]anull[a_end]`);
    inputIdx++;
  } else {
    const endMeta = ffprobe(endFull);
    args.push("-ss", (endcard.in || 0).toFixed(3), "-t", (endDur * endSpeed).toFixed(3), "-i", endFull);
    buildVideoFilter(filters, `${inputIdx}:v`, "v_end", canvasW, canvasH, aspectKey, (1 / endSpeed).toFixed(6));
    inputIdx = addSegmentAudio(args, filters, af, endMeta.hasAudio, inputIdx, endDur, endSpeed, "a_end");
  }
  segLabels.end = { v: "v_end", a: "a_end" };

  // CTA button: overlaid only onto the endcard segment's video, positioned
  // bottom-center with a soft scale-in/scale-out. -loop 1 makes the still
  // image supply frames for as long as the endcard segment needs (image is
  // naturally shorter than a looping still source with no fixed duration,
  // so it never runs out).
  if (ctaFull) {
    args.push("-loop", "1", "-i", ctaFull);
    const scaleExpr = ctaScaleExpr();
    // "Original size" is defined relative to the 9x16 canvas; other aspect
    // ratios scale the button by their height vs 9x16's, so it reads at a
    // consistent relative size instead of ballooning on shorter canvases
    // (e.g. 4x5 at 1350 tall -> 1350/1920 = 70% of the 9x16 button size).
    const ctaBaseScale = (canvasH / CTA_BASE_HEIGHT).toFixed(6);
    filters.push(`[${inputIdx}:v]scale=w='iw*${ctaBaseScale}*(${scaleExpr})':h='ih*${ctaBaseScale}*(${scaleExpr})':eval=frame[cta_img]`);
    filters.push(`[v_end][cta_img]overlay=(W-w)/2:H*${CTA_VERTICAL_FRAC}-h/2:shortest=1[v_end_cta]`);
    segLabels.end.v = "v_end_cta";
    inputIdx++;
  }

  // Crossfade consecutive segments (in whatever sequence order is chosen)
  // instead of a hard cut. xfade needs an explicit offset (in seconds, into
  // the running/combined stream so far) where the next clip starts overlapping;
  // acrossfade infers its own position from the tail of the first input, no
  // offset needed. Every segment's video was already normalized to the same
  // canvas/fps/format by buildVideoFilter, and every audio stream to the same
  // sample rate/layout by addSegmentAudio, so xfade/acrossfade can pair them
  // directly.
  const segOutDur = {
    hook: (hookOut - hookIn) / hookSpeed,
    gp: (gpOut - gpIn) / gpSpeed,
    end: endDur,
  };
  let curV = segLabels[order[0]].v;
  let curA = segLabels[order[0]].a;
  let curDur = segOutDur[order[0]];
  for (let i = 1; i < order.length; i++) {
    const key = order[i];
    const nextDur = segOutDur[key];
    const fadeDur = Math.max(0.05, Math.min(TRANSITION_DUR, curDur / 2, nextDur / 2));
    const offset = Math.max(0, curDur - fadeDur);
    const isLast = i === order.length - 1;
    const outV = isLast ? "outv" : `xv${i}`;
    const outA = isLast ? "outa" : `xa${i}`;
    filters.push(`[${curV}][${segLabels[key].v}]xfade=transition=fade:duration=${fadeDur.toFixed(3)}:offset=${offset.toFixed(3)}[${outV}]`);
    filters.push(`[${curA}][${segLabels[key].a}]acrossfade=d=${fadeDur.toFixed(3)}:c1=tri:c2=tri[${outA}]`);
    curV = outV;
    curA = outA;
    curDur = curDur + nextDur - fadeDur;
  }

  args.push("-filter_complex", filters.join(";"));
  args.push("-map", "[outv]", "-map", "[outa]");
  args.push("-c:v", "libx264", "-preset", "medium", "-crf", "20");
  args.push("-c:a", "aac", "-b:a", "192k");
  args.push("-pix_fmt", "yuv420p");
  // Hard cap: the export must never run past the target duration, not even
  // by one frame, regardless of how the segments/transitions add up --
  // trims the muxed output rather than relying on the segments already
  // summing to exactly `target` (they usually run a little under anyway,
  // since crossfading shortens the total by the transition overlap, but
  // this is the actual guarantee, not just the usual case).
  args.push("-t", target.toFixed(3));
  args.push(outPath);

  const proc = spawn("ffmpeg", args);
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  proc.on("close", (code) => {
    if (code === 0) cb(null, { file: outName, url: `/exports/${outName}` });
    else cb(new Error(stderr || `ffmpeg exited ${code}`));
  });
}

// --- ElevenLabs speech-to-text -> soft subtitle track ---

function postMultipart(hostname, urlPath, headers, fields, fileField) {
  return new Promise((resolve, reject) => {
    const boundary = "----creativeStitcher" + crypto.randomBytes(8).toString("hex");
    const parts = [];
    for (const [name, value] of Object.entries(fields)) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      ));
    }
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileField.name}"; filename="${fileField.filename}"\r\n` +
      `Content-Type: ${fileField.contentType}\r\n\r\n`
    ));
    parts.push(fileField.data);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    const req = https.request({
      hostname, path: urlPath, method: "POST",
      headers: { ...headers, "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": body.length },
    }, (res) => {
      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(text)); } catch (e) { reject(new Error("bad JSON from ElevenLabs: " + text.slice(0, 300))); }
        } else {
          reject(new Error(`ElevenLabs ${res.statusCode}: ${text.slice(0, 500)}`));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function transcribeWithElevenLabs(videoPath) {
  if (!ELEVENLABS_API_KEY) throw new Error("ELEVENLABS_API_KEY not set -- add it to .env in the project root");
  const data = fs.readFileSync(videoPath);
  const result = await postMultipart(
    "api.elevenlabs.io", "/v1/speech-to-text",
    { "xi-api-key": ELEVENLABS_API_KEY },
    { model_id: ELEVENLABS_STT_MODEL, timestamps_granularity: "word" },
    { name: "file", filename: path.basename(videoPath), contentType: "video/mp4", data }
  );
  return (result.words || []).filter((w) => w.type === "word" && w.text && w.text.trim());
}

// --- ElevenLabs music generation -> background music mixed under the export's audio ---

function generateMusicWithElevenLabs(prompt, durationMs) {
  return new Promise((resolve, reject) => {
    if (!ELEVENLABS_API_KEY) return reject(new Error("ELEVENLABS_API_KEY not set -- add it to .env in the project root"));
    const body = Buffer.from(JSON.stringify({
      prompt,
      music_length_ms: Math.max(3000, Math.min(600000, Math.round(durationMs))),
      force_instrumental: true,
    }));
    const req = https.request({
      hostname: "api.elevenlabs.io", path: "/v1/music", method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json", "Content-Length": body.length },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const data = Buffer.concat(chunks);
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`ElevenLabs music ${res.statusCode}: ${data.toString("utf8").slice(0, 500)}`));
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Mixes generated music (at MUSIC_MIX_VOLUME) under the video's existing audio.
// normalize=0 keeps the existing audio at full volume -- amix's default
// loudness normalization would otherwise quietly duck the original dialogue
// just because a second, much quieter track was added alongside it.
function mixMusicIntoVideo(videoPath, musicPath, outPath, cb) {
  const args = [
    "-y", "-loglevel", "error",
    "-i", videoPath, "-i", musicPath,
    "-filter_complex",
    `[1:a]volume=${MUSIC_MIX_VOLUME}[music];[0:a][music]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`,
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    outPath,
  ];
  const proc = spawn("ffmpeg", args);
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  proc.on("close", (code) => {
    if (code === 0) cb(null);
    else cb(new Error(stderr || `ffmpeg exited ${code}`));
  });
}

function srtTime(sec) {
  const ms = Math.round(sec * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const msRem = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(msRem).padStart(3, "0")}`;
}

function groupWordsIntoCues(words) {
  const MAX_WORDS = 5, MAX_CUE_SEC = 2.5;
  const cues = [];
  let cur = [];
  for (const w of words) {
    if (cur.length && (cur.length >= MAX_WORDS || w.end - cur[0].start > MAX_CUE_SEC)) {
      cues.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) cues.push(cur);
  return cues;
}

function wordsToSrt(words) {
  const cues = groupWordsIntoCues(words);
  return cues.map((cue, i) => {
    const text = cue.map((w) => w.text).join(" ").trim();
    return `${i + 1}\n${srtTime(cue[0].start)} --> ${srtTime(cue[cue.length - 1].end)}\n${text}\n`;
  }).join("\n");
}

function assTime(sec) {
  const cs = Math.round(sec * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const csRem = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(csRem).padStart(2, "0")}`;
}

// A plain SRT has no notion of the video's resolution, so libass assumes a
// small default canvas and scales font/margin sizes up wildly to match the
// real output. Writing a real .ass file with an explicit PlayResX/PlayResY
// (matching the actual source video, probed by the caller -- works for any
// aspect ratio) and the style baked in sidesteps that guess entirely -- this
// is what burned-in captions render from.
function wordsToAss(words, videoW, videoH) {
  const cues = groupWordsIntoCues(words);
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${videoW}
PlayResY: ${videoH}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,52,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,3,1,2,40,40,220,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = cues.map((cue) => {
    const text = cue.map((w) => w.text).join(" ").trim().replace(/[{}]/g, "");
    return `Dialogue: 0,${assTime(cue[0].start)},${assTime(cue[cue.length - 1].end)},Default,,0,0,0,,${text}`;
  }).join("\n");
  return header + events + "\n";
}

function muxSoftSubtitles(videoPath, srtPath, outPath, cb) {
  const args = [
    "-y", "-loglevel", "error",
    "-i", videoPath, "-i", srtPath,
    "-map", "0:v", "-map", "0:a", "-map", "1:s",
    "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text",
    "-metadata:s:s:0", "language=eng",
    outPath,
  ];
  const proc = spawn("ffmpeg", args);
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  proc.on("close", (code) => {
    if (code === 0) cb(null);
    else cb(new Error(stderr || `ffmpeg exited ${code}`));
  });
}

// Escape a filesystem path for use as the subtitles filter's file argument.
// Our own paths never contain ':' or '\\' (macOS, filenames we generate), so
// this only needs to guard against a stray single quote.
function escapeSubtitlesPath(p) {
  return p.replace(/'/g, "'\\''");
}

function burnInSubtitles(videoPath, assPath, outPath, cb) {
  // The .ass file (from wordsToAss) already carries an explicit PlayResY and
  // full style block, so no force_style guesswork is needed here.
  const vf = `subtitles='${escapeSubtitlesPath(assPath)}'`;

  const args = [
    "-y", "-loglevel", "error",
    "-i", videoPath,
    "-vf", vf,
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    outPath,
  ];
  const proc = spawn(resolveSubtitlesFfmpeg(), args);
  let stderr = "";
  proc.stderr.on("data", (d) => (stderr += d.toString()));
  proc.on("close", (code) => {
    if (code === 0) cb(null);
    else cb(new Error(stderr || `ffmpeg exited ${code}`));
  });
}

// A generated music track is meant to be reused across every aspect-ratio
// variant of one export (so picking a theme is a one-time cost, independent
// of how many dimensions are checked), not regenerated per file. Tracks live
// as temp files outside EXPORT_DIR, referenced by an opaque id the client
// holds only for the duration of one export/batch-item run, and released
// explicitly when done -- the TTL sweep is just a safety net for a client
// that never got to call release (closed tab, crashed mid-export).
const MUSIC_TRACKS = new Map(); // id -> { path, createdAt }
const MUSIC_TRACK_TTL_MS = 30 * 60 * 1000;

function cleanupStaleMusicTracks() {
  const now = Date.now();
  for (const [id, track] of MUSIC_TRACKS) {
    if (now - track.createdAt > MUSIC_TRACK_TTL_MS) {
      try { fs.unlinkSync(track.path); } catch (e) { /* already gone */ }
      MUSIC_TRACKS.delete(id);
    }
  }
}

// --- Higgsfield (Kling 3.0 Turbo, via the `higgsfield` CLI) -> new Hook clip ---
// A generated clip is written straight into the Hook folder and treated as a
// normal asset from then on (discoverAssets() picks it up next refresh), so
// "generate a hook" and "pick an existing hook" end up being the same thing.
//
// This shells out to the `higgsfield` CLI (authenticated via `higgsfield auth
// login`, workspace selected via `higgsfield workspace set`) rather than
// calling api.higgsfield.ai directly with an API key -- the CLI draws on the
// account's own subscription credits, while the plain REST API key draws
// from a separate developer wallet that needs its own top-up.

const HIGGSFIELD_MODEL = "kling3_0_turbo";

function resolveHiggsfieldBin() {
  if (process.env.HIGGSFIELD_BIN) return process.env.HIGGSFIELD_BIN;
  const which = spawnSync("which", ["higgsfield"]);
  if (which.status === 0) {
    const p = which.stdout.toString().trim();
    if (p) return p;
  }
  return "higgsfield"; // fallback -- relies on PATH
}

// imageDataUri, when given, is used as the start frame (image-to-video). The
// CLI's --start-image flag takes a local file path (it uploads it for us),
// so the data URI is decoded back to a temp file first.
async function generateHiggsfieldHookVideo(prompt, durationSec, imageDataUri) {
  const duration = Number(durationSec) === 10 ? 10 : 5;
  let tempImagePath = null;

  try {
    const args = [
      "generate", "create", HIGGSFIELD_MODEL,
      "--prompt", prompt,
      "--duration", String(duration),
      "--aspect-ratio", "9:16",
      "--wait", "--wait-timeout", "5m",
      "--json",
    ];

    if (imageDataUri) {
      const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/.exec(imageDataUri);
      if (!m) throw new Error("imageDataUri must be a base64 data URI");
      const ext = m[1].split("+")[0].replace("jpeg", "jpg");
      tempImagePath = path.join(os.tmpdir(), `cs-hookgen-${crypto.randomBytes(6).toString("hex")}.${ext}`);
      fs.writeFileSync(tempImagePath, Buffer.from(m[2], "base64"));
      args.push("--start-image", tempImagePath);
    }

    const result = await new Promise((resolve, reject) => {
      const proc = spawn(resolveHiggsfieldBin(), args);
      let stdout = "", stderr = "";
      proc.stdout.on("data", (d) => (stdout += d.toString()));
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(stderr.trim() || stdout.trim() || `higgsfield CLI exited ${code}`));
      });
    });

    let job;
    try { job = JSON.parse(result); } catch (e) { job = null; }
    const resultUrl = job ? (Array.isArray(job) ? job[0]?.result_url : job.result_url) : result;
    if (!resultUrl) throw new Error(`higgsfield CLI returned no result URL: ${result.slice(0, 300)}`);
    return resultUrl;
  } finally {
    if (tempImagePath) { try { fs.unlinkSync(tempImagePath); } catch (e) { /* already gone */ } }
  }
}

function downloadToFile(urlStr, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https.get(urlStr, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        return resolve(downloadToFile(res.headers.location, destPath, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`download failed: ${res.statusCode}`));
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
      file.on("error", reject);
    }).on("error", reject);
  });
}

// Same case-insensitive "hook" match discoverAssets() uses, so a generated
// clip lands exactly where the asset scanner will find it.
function resolveHookDir() {
  const entries = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "Exports" && d.name !== "editor" && !d.name.startsWith("."));
  const hookDir = entries.find((d) => d.name.toLowerCase().includes("hook"));
  return hookDir ? path.join(ROOT, hookDir.name) : path.join(ROOT, "Hook");
}

function slugifyPrompt(s) {
  const firstWord = String(s || "").trim().split(/\s+/)[0] || "";
  const slug = firstWord.replace(/[^A-Za-z0-9]+/g, "");
  return slug || "Generated";
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

  if (url.pathname === "/api/caption" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let payload;
      try { payload = JSON.parse(body); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
      const srcName = payload.file;
      const srcPath = srcName && path.join(EXPORT_DIR, srcName);
      if (!srcPath || !srcPath.startsWith(EXPORT_DIR + path.sep) || !fs.existsSync(srcPath)) {
        return sendJSON(res, 404, { error: "export not found" });
      }
      const style = payload.style === "burned" ? "burned" : "soft";
      try {
        const words = await transcribeWithElevenLabs(srcPath);
        if (!words.length) return sendJSON(res, 200, { ok: true, captioned: false, reason: "no speech detected" });

        const subsPath = srcPath.replace(/\.mp4$/i, style === "burned" ? ".ass" : ".srt");
        if (style === "burned") {
          const srcMeta = ffprobe(srcPath);
          fs.writeFileSync(subsPath, wordsToAss(words, srcMeta.width, srcMeta.height));
        } else {
          fs.writeFileSync(subsPath, wordsToSrt(words));
        }

        // Caption in place -- write to a temp file (ffmpeg can't read and
        // write the same path at once) then replace the uncaptioned original,
        // so exporting with captions checked leaves exactly one file behind,
        // not both versions.
        const tempName = srcName.replace(/\.mp4$/i, `_captioning_tmp_${crypto.randomBytes(4).toString("hex")}.mp4`);
        const tempPath = path.join(EXPORT_DIR, tempName);
        const mux = style === "burned" ? burnInSubtitles : muxSoftSubtitles;
        mux(srcPath, subsPath, tempPath, (err) => {
          fs.unlinkSync(subsPath);
          if (err) {
            try { fs.unlinkSync(tempPath); } catch (e2) { /* nothing written */ }
            return sendJSON(res, 500, { error: err.message });
          }
          fs.renameSync(tempPath, srcPath);
          sendJSON(res, 200, { ok: true, captioned: true, file: srcName, url: `/exports/${srcName}` });
        });
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
    });
    return;
  }

  // Generates one music track for a chosen mood/duration and hands back an
  // opaque id -- call this once per export (not once per aspect ratio), then
  // pass the id to /api/music/apply for each rendered dimension.
  if (url.pathname === "/api/music/generate" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let payload;
      try { payload = JSON.parse(body); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
      const mood = MUSIC_PRESETS[payload.mood] ? payload.mood : "upbeat";
      const durationSec = Number(payload.durationSec);
      if (!(durationSec > 0)) return sendJSON(res, 400, { error: "durationSec required" });

      cleanupStaleMusicTracks();
      try {
        const musicBuf = await generateMusicWithElevenLabs(MUSIC_PRESETS[mood], durationSec * 1000);
        const trackId = crypto.randomBytes(12).toString("hex");
        const tmpPath = path.join(os.tmpdir(), `cs-music-${trackId}.mp3`);
        fs.writeFileSync(tmpPath, musicBuf);
        MUSIC_TRACKS.set(trackId, { path: tmpPath, createdAt: Date.now() });
        sendJSON(res, 200, { ok: true, trackId });
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
    });
    return;
  }

  // Mixes a previously generated track (by id) under one exported file's audio.
  if (url.pathname === "/api/music/apply" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(body); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
      const srcName = payload.file;
      const srcPath = srcName && path.join(EXPORT_DIR, srcName);
      if (!srcPath || !srcPath.startsWith(EXPORT_DIR + path.sep) || !fs.existsSync(srcPath)) {
        return sendJSON(res, 404, { error: "export not found" });
      }
      const track = MUSIC_TRACKS.get(payload.trackId);
      if (!track || !fs.existsSync(track.path)) {
        return sendJSON(res, 404, { error: "music track not found or expired" });
      }

      const outName = srcName.replace(/\.mp4$/i, "_music.mp4");
      const outPath = path.join(EXPORT_DIR, outName);
      mixMusicIntoVideo(srcPath, track.path, outPath, (err) => {
        if (err) return sendJSON(res, 500, { error: err.message });
        sendJSON(res, 200, { ok: true, musicked: true, file: outName, url: `/exports/${outName}` });
      });
    });
    return;
  }

  // Best-effort cleanup once a client is done applying a track to every dimension.
  if (url.pathname === "/api/music/release" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(body); } catch (e) { payload = {}; }
      const track = MUSIC_TRACKS.get(payload.trackId);
      if (track) {
        try { fs.unlinkSync(track.path); } catch (e) { /* already gone */ }
        MUSIC_TRACKS.delete(payload.trackId);
      }
      sendJSON(res, 200, { ok: true });
    });
    return;
  }

  if (url.pathname === "/api/higgsfield/generate-hook" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let payload;
      try { payload = JSON.parse(body); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
      const prompt = (payload.prompt || "").trim();
      if (!prompt) return sendJSON(res, 400, { error: "prompt required" });
      const duration = Number(payload.duration) === 10 ? 10 : 5;
      const imageDataUri = typeof payload.imageDataUri === "string" ? payload.imageDataUri : null;
      if (imageDataUri && !/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(imageDataUri)) {
        return sendJSON(res, 400, { error: "imageDataUri must be a base64 data URI" });
      }

      try {
        const videoUrl = await generateHiggsfieldHookVideo(prompt, duration, imageDataUri);
        const hookDir = resolveHookDir();
        fs.mkdirSync(hookDir, { recursive: true });
        const fileName = `Generated_${slugifyPrompt(prompt)}_${crypto.randomBytes(3).toString("hex")}.mp4`;
        const destPath = path.join(hookDir, fileName);
        await downloadToFile(videoUrl, destPath);
        const rel = path.relative(ROOT, destPath);
        const meta = ffprobe(destPath);
        sendJSON(res, 200, { ok: true, rel, name: fileName, duration: meta.duration, width: meta.width, height: meta.height, isImage: false });
      } catch (e) {
        sendJSON(res, 500, { error: e.message });
      }
    });
    return;
  }

  if (url.pathname === "/api/exports" && req.method === "GET") {
    const hidden = new Set(loadHidden());
    const files = listExportFiles()
      .filter((f) => !hidden.has(f))
      .map((f) => {
        const stat = fs.statSync(path.join(EXPORT_DIR, f));
        return { name: f, url: `/exports/${f.split(path.sep).map(encodeURIComponent).join("/")}`, size: stat.size, mtime: stat.mtimeMs };
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

  // Reveals a file (or just the Exports folder) in the OS file manager --
  // this only makes sense because the editor and the browser viewing it are
  // running on the same machine. macOS-only (`open -R`); on another OS this
  // would need a different reveal command.
  if (url.pathname === "/api/reveal" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(body || "{}"); } catch (e) { return sendJSON(res, 400, { error: "bad json" }); }
      const name = payload.file;
      const full = name ? path.join(EXPORT_DIR, name) : EXPORT_DIR;
      const inBounds = full === EXPORT_DIR || full.startsWith(EXPORT_DIR + path.sep);
      if (!inBounds || !fs.existsSync(full)) return sendJSON(res, 404, { error: "not found" });
      const args = name ? ["-R", full] : [full];
      const proc = spawn("open", args);
      let stderr = "";
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      proc.on("close", (code) => {
        if (code === 0) sendJSON(res, 200, { ok: true });
        else sendJSON(res, 500, { error: stderr || `open exited ${code}` });
      });
    });
    return;
  }

  // "Delete" only hides an export from the list -- the file stays in Exports/ on disk.
  if (url.pathname === "/api/exports" && req.method === "DELETE") {
    const hidden = new Set(loadHidden());
    const visible = listExportFiles().filter((f) => !hidden.has(f));
    visible.forEach((f) => hidden.add(f));
    saveHidden([...hidden]);
    return sendJSON(res, 200, { hidden: visible.length });
  }

  if (url.pathname.startsWith("/exports/") && req.method === "DELETE") {
    const name = decodeURIComponent(url.pathname.slice("/exports/".length));
    const full = path.join(EXPORT_DIR, name);
    if (!full.startsWith(EXPORT_DIR + path.sep) || !fs.existsSync(full)) return sendJSON(res, 404, { error: "not found" });
    const hidden = new Set(loadHidden());
    hidden.add(name);
    saveHidden([...hidden]);
    return sendJSON(res, 200, { ok: true });
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`Creative editor running at http://localhost:${PORT}`);
});
