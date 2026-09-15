const SEG_LABELS = { hook: "Hook", gp: "Gameplay", end: "Endcard" };

const state = {
  target: 30,
  order: ["hook", "gp", "end"],
  assets: { hooks: [], gameplays: [], endcards: [], ctas: [] },
  hook: null,   // {rel, duration, in, out, speed}
  gp: null,     // {rel, duration, in, out, speed}
  end: null,    // {rel, isImage, duration, in, out, speed, holdDuration}
  cta: null,    // {rel, enabled}
};

const el = (id) => document.getElementById(id);
const mediaUrl = (rel) => `/media?path=${encodeURIComponent(rel)}`;
const fmt = (n) => (Math.round(n * 10) / 10).toFixed(1) + "s";

function makeTrimSlider(containerId, { onChange }) {
  const container = el(containerId);
  const rangeIn = container.querySelector(".range-in");
  const rangeOut = container.querySelector(".range-out");
  const fill = container.querySelector(".trim-fill");

  function setBounds(max) {
    rangeIn.min = 0; rangeIn.max = max;
    rangeOut.min = 0; rangeOut.max = max;
  }
  function setValues(inVal, outVal) {
    rangeIn.value = inVal;
    rangeOut.value = outVal;
    redraw();
  }
  function redraw() {
    const max = parseFloat(rangeIn.max) || 1;
    const inV = parseFloat(rangeIn.value);
    const outV = parseFloat(rangeOut.value);
    fill.style.left = (inV / max * 100) + "%";
    fill.style.width = Math.max(0, (outV - inV) / max * 100) + "%";
  }
  rangeIn.addEventListener("input", () => {
    if (parseFloat(rangeIn.value) > parseFloat(rangeOut.value) - 0.1) {
      rangeIn.value = Math.max(0, parseFloat(rangeOut.value) - 0.1);
    }
    redraw();
    onChange(parseFloat(rangeIn.value), parseFloat(rangeOut.value));
  });
  rangeOut.addEventListener("input", () => {
    if (parseFloat(rangeOut.value) < parseFloat(rangeIn.value) + 0.1) {
      rangeOut.value = parseFloat(rangeIn.value) + 0.1;
    }
    redraw();
    onChange(parseFloat(rangeIn.value), parseFloat(rangeOut.value));
  });
  return { setBounds, setValues, redraw };
}

function makeSpeedControl({ rangeId, labelId, presetsId, videoEl, onChange }) {
  const range = el(rangeId);
  const label = el(labelId);
  const presets = el(presetsId);

  function apply(speed, fromPreset) {
    range.value = speed;
    label.textContent = speed.toFixed(2) + "x";
    if (videoEl) videoEl.playbackRate = speed;
    [...presets.children].forEach((b) => b.classList.toggle("active", Math.abs(parseFloat(b.dataset.speed) - speed) < 0.001));
    onChange(speed);
  }
  range.addEventListener("input", () => apply(parseFloat(range.value)));
  presets.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-speed]");
    if (!btn) return;
    apply(parseFloat(btn.dataset.speed));
  });
  return { apply };
}

const hookSlider = makeTrimSlider("hookTrim", {
  onChange: (i, o) => { state.hook.in = i; state.hook.out = o; syncHookLabels(); refreshTimeline(); }
});
const gpSlider = makeTrimSlider("gpTrim", {
  onChange: (i, o) => { state.gp.in = i; state.gp.out = o; syncGpLabels(); refreshTimeline(); }
});
const endSlider = makeTrimSlider("endTrim", {
  onChange: (i, o) => { state.end.in = i; state.end.out = o; syncEndLabels(); refreshTimeline(); }
});

const hookSpeed = makeSpeedControl({
  rangeId: "hookSpeedRange", labelId: "hookSpeedLabel", presetsId: "hookSpeedPresets", videoEl: el("hookVideo"),
  onChange: (s) => { state.hook.speed = s; syncHookLabels(); refreshTimeline(); }
});
const gpSpeed = makeSpeedControl({
  rangeId: "gpSpeedRange", labelId: "gpSpeedLabel", presetsId: "gpSpeedPresets", videoEl: el("gpVideo"),
  onChange: (s) => { state.gp.speed = s; syncGpLabels(); refreshTimeline(); }
});
const endSpeed = makeSpeedControl({
  rangeId: "endSpeedRange", labelId: "endSpeedLabel", presetsId: "endSpeedPresets", videoEl: el("endVideo"),
  onChange: (s) => { if (state.end) state.end.speed = s; syncEndLabels(); refreshTimeline(); }
});

function hookOutputLen() { return (state.hook.out - state.hook.in) / state.hook.speed; }
function gpOutputLen() { return (state.gp.out - state.gp.in) / state.gp.speed; }

function syncHookLabels() {
  el("hookInLabel").textContent = fmt(state.hook.in);
  el("hookOutLabel").textContent = fmt(state.hook.out);
  el("hookLenLabel").textContent = fmt(hookOutputLen());
  el("hookVideo").currentTime = state.hook.in;
}
function syncGpLabels() {
  el("gpInLabel").textContent = fmt(state.gp.in);
  el("gpOutLabel").textContent = fmt(state.gp.out);
  el("gpLenLabel").textContent = fmt(gpOutputLen());
  el("gpVideo").currentTime = state.gp.in;
}
function syncEndLabels() {
  if (!state.end) return;
  if (state.end.isImage) {
    el("endLenLabel").textContent = fmt(state.end.holdDuration);
    return;
  }
  el("endInLabel").textContent = fmt(state.end.in);
  el("endOutLabel").textContent = fmt(state.end.out);
  el("endLenLabel").textContent = fmt((state.end.out - state.end.in) / state.end.speed);
}

function populateSelect(selectEl, list) {
  selectEl.innerHTML = "";
  list.forEach((item, idx) => {
    const opt = document.createElement("option");
    opt.value = idx;
    opt.textContent = item.name;
    selectEl.appendChild(opt);
  });
}

function loadHook(item) {
  state.hook = { rel: item.rel, duration: item.duration, in: 0, out: item.duration, speed: 1 };
  const v = el("hookVideo");
  v.src = mediaUrl(item.rel);
  hookSlider.setBounds(item.duration);
  hookSlider.setValues(0, item.duration);
  hookSpeed.apply(1);
  syncHookLabels();
  refreshTimeline();
  updateNamingPreview();
}

function loadGp(item) {
  const defaultOut = Math.min(item.duration, Math.max(1, computeGpTargetLen()));
  state.gp = { rel: item.rel, duration: item.duration, in: 0, out: defaultOut, speed: 1 };
  const v = el("gpVideo");
  v.src = mediaUrl(item.rel);
  gpSlider.setBounds(item.duration);
  gpSlider.setValues(0, defaultOut);
  gpSpeed.apply(1);
  syncGpLabels();
  refreshTimeline();
  const idx = state.assets.gameplays.indexOf(item);
  if (el("gpSelect")) el("gpSelect").value = idx;
  if (el("batchGpSelect")) el("batchGpSelect").value = idx;
  updateNamingPreview();
}

function loadEnd(item) {
  const holdInput = el("endDuration");
  if (item.isImage) {
    state.end = { rel: item.rel, isImage: true, holdDuration: parseFloat(holdInput.value) || 2 };
    el("endImg").style.display = "block";
    el("endImg").src = mediaUrl(item.rel);
    el("endVideo").style.display = "none";
    el("endTrimWrap").style.display = "none";
    el("endDurationWrap").style.display = "flex";
  } else {
    state.end = { rel: item.rel, isImage: false, duration: item.duration, in: 0, out: item.duration, speed: 1 };
    el("endVideo").style.display = "block";
    el("endVideo").src = mediaUrl(item.rel);
    el("endImg").style.display = "none";
    el("endTrimWrap").style.display = "block";
    el("endDurationWrap").style.display = "none";
    endSlider.setBounds(item.duration);
    endSlider.setValues(0, item.duration);
    endSpeed.apply(1);
  }
  syncEndLabels();
  refreshTimeline();
}

function endLen() {
  if (!state.end) return 0;
  return state.end.isImage ? state.end.holdDuration : (state.end.out - state.end.in) / state.end.speed;
}

function computeGpTargetLen() {
  const hookLen = state.hook ? hookOutputLen() : 0;
  const e = endLen();
  return state.target - hookLen - e;
}

const SEG_VIDEO = { hook: () => el("hookVideo"), gp: () => el("gpVideo"), end: () => (state.end && state.end.isImage ? el("endImg") : el("endVideo")) };

function segLen(key) {
  if (key === "hook") return hookOutputLen();
  if (key === "gp") return gpOutputLen();
  if (key === "end") return endLen();
  return 0;
}

function refreshTimeline() {
  if (!state.hook || !state.gp || !state.end) return;
  const lens = { hook: hookOutputLen(), gp: gpOutputLen(), end: endLen() };
  const total = lens.hook + lens.gp + lens.end;
  const total_px = total || 1;

  const bar = el("timelineBar");
  bar.innerHTML = "";
  state.order.forEach((key) => {
    const div = document.createElement("div");
    div.className = `seg ${key}`;
    div.style.width = (lens[key] / total_px * 100) + "%";
    div.textContent = `${SEG_LABELS[key]} ${fmt(lens[key])}`;
    bar.appendChild(div);
  });

  const readout = el("totalReadout");
  const diff = total - state.target;
  readout.innerHTML = `Total: <b>${fmt(total)}</b> / target ${state.target}s`;
  if (Math.abs(diff) < 0.15) {
    readout.className = "total-readout match";
  } else {
    readout.className = "total-readout mismatch";
    readout.innerHTML += ` (${diff > 0 ? "+" : ""}${fmt(diff)})`;
  }
}

function autoFitGameplay() {
  if (!state.hook || !state.gp || !state.end) return;
  const neededOutputLen = computeGpTargetLen();
  const rawLen = Math.max(0.2, neededOutputLen * state.gp.speed);
  const newOut = state.gp.in + rawLen;
  state.gp.out = newOut;
  gpSlider.setBounds(Math.max(state.gp.duration, newOut));
  gpSlider.setValues(state.gp.in, newOut);
  syncGpLabels();
  refreshTimeline();
}

// --- individual trim preview (loop within in/out, respects speed) ---
function wireTrimPreview(videoId, playBtnId, getSeg) {
  const v = el(videoId);
  const btn = el(playBtnId);
  let raf;
  function tick() {
    const seg = getSeg();
    if (v.currentTime >= seg.out) v.currentTime = seg.in;
    raf = requestAnimationFrame(tick);
  }
  btn.addEventListener("click", () => {
    const seg = getSeg();
    if (v.paused) {
      v.currentTime = seg.in;
      v.playbackRate = seg.speed;
      v.play();
      btn.textContent = "⏸ Playing...";
      raf = requestAnimationFrame(tick);
    } else {
      v.pause();
      cancelAnimationFrame(raf);
      btn.textContent = "▶ Preview trim";
    }
  });
  v.addEventListener("pause", () => { btn.textContent = "▶ Preview trim"; cancelAnimationFrame(raf); });
}
wireTrimPreview("hookVideo", "hookPlayBtn", () => state.hook);
wireTrimPreview("gpVideo", "gpPlayBtn", () => state.gp);

// --- full sequence preview (follows current order + speed) ---
let sequenceRunning = false;
el("previewAllBtn").addEventListener("click", () => {
  if (sequenceRunning) return;
  runSequence();
});

function hideAllPreviews() {
  el("hookVideo").pause();
  el("gpVideo").pause();
  el("endVideo").pause();
}

function runSequence() {
  sequenceRunning = true;
  hideAllPreviews();

  function playVideoSegment(videoEl, seg, next) {
    videoEl.currentTime = seg.in;
    videoEl.playbackRate = seg.speed;
    const onTime = () => {
      if (videoEl.currentTime >= seg.out) {
        videoEl.pause();
        videoEl.removeEventListener("timeupdate", onTime);
        next();
      }
    };
    videoEl.addEventListener("timeupdate", onTime);
    videoEl.play().catch(() => {});
  }

  function playKey(key, next) {
    if (key === "hook") return playVideoSegment(el("hookVideo"), state.hook, next);
    if (key === "gp") return playVideoSegment(el("gpVideo"), state.gp, next);
    if (key === "end") {
      if (state.end.isImage) { setTimeout(next, state.end.holdDuration * 1000); }
      else playVideoSegment(el("endVideo"), state.end, next);
    }
  }

  const queue = [...state.order];
  function step() {
    const key = queue.shift();
    if (!key) { sequenceRunning = false; return; }
    playKey(key, step);
  }
  step();
}

// --- captioning (ElevenLabs speech-to-text -> burned-in or soft subtitle track) ---
async function captionExport(filename, style) {
  const res = await fetch("/api/caption", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file: filename, style }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || "captioning failed");
  return data; // { ok, captioned, file?, url?, reason? }
}

// --- background music (ElevenLabs music generation -> mixed under the export's audio) ---
// One track is generated per export/batch-item run (see generateMusicTrack)
// and reused across every aspect-ratio variant via its trackId, so picking a
// dimension has no bearing on the music -- it's the same track underneath.
async function generateMusicTrack(mood, durationSec) {
  const res = await fetch("/api/music/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mood, durationSec }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || "music generation failed");
  return data.trackId;
}

async function musicApply(filename, trackId) {
  const res = await fetch("/api/music/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file: filename, trackId }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || "music mix failed");
  return data; // { ok, musicked, file?, url? }
}

function releaseMusicTrack(trackId) {
  if (!trackId) return;
  fetch("/api/music/release", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trackId }),
  }).catch(() => {}); // best-effort cleanup -- the server's TTL sweep is the fallback
}

// Runs caption then music sequentially, each stage building on the previous
// stage's output file, and reports one combined status label. `musicTrackId`
// is generated once by the caller and shared across every aspect ratio;
// `musicError` surfaces a generation failure on every row without retrying it.
async function applyPostProcessing(file, url, opts, onStatus) {
  let cur = { file, url };
  const labelParts = [];

  if (opts.captionToggle.checked) {
    if (onStatus) onStatus("Captioning...");
    try {
      const capData = await captionExport(cur.file, opts.captionStyle.value);
      if (capData.captioned) { cur = { file: capData.file, url: capData.url }; labelParts.push("captioned"); }
      else labelParts.push(capData.reason || "no captions");
    } catch (e) {
      labelParts.push(`captioning failed: ${e.message}`);
    }
  }

  if (opts.musicTrackId) {
    if (onStatus) onStatus("Adding music...");
    try {
      const musicData = await musicApply(cur.file, opts.musicTrackId);
      if (musicData.musicked) { cur = { file: musicData.file, url: musicData.url }; labelParts.push("music"); }
    } catch (e) {
      labelParts.push(`music failed: ${e.message}`);
    }
  } else if (opts.musicError) {
    labelParts.push(`music failed: ${opts.musicError}`);
  }

  return { ...cur, label: labelParts.length ? `Done (${labelParts.join(", ")})` : "Done" };
}

async function revealFile(name) {
  try {
    await fetch("/api/reveal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file: name }),
    });
  } catch (e) { /* best-effort -- nothing sensible to show the user if this fails */ }
}

// --- aspect ratio selection ---
function getSelectedAspects() {
  return [...document.querySelectorAll(".aspect-check:checked")].map((cb) => cb.dataset.aspect);
}
function syncAspectAll() {
  const boxes = [...document.querySelectorAll(".aspect-check")];
  el("aspectAll").checked = boxes.length > 0 && boxes.every((cb) => cb.checked);
}
document.querySelectorAll(".aspect-check").forEach((cb) => cb.addEventListener("change", syncAspectAll));
el("aspectAll").addEventListener("change", (e) => {
  document.querySelectorAll(".aspect-check").forEach((cb) => (cb.checked = e.target.checked));
});

// --- file naming: {Game}_{Dimension}_{Date}_{Language}_{HookName}_{GPName}_{Duration} ---
try {
  const savedGameName = localStorage.getItem("cs_gameName");
  if (savedGameName) el("gameNameInput").value = savedGameName;
} catch (e) { /* localStorage unavailable -- fine, just won't persist */ }

function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
}
function slugify(s) {
  return String(s || "").replace(/[^A-Za-z0-9]+/g, "");
}
function updateNamingPreview() {
  const game = slugify(el("gameNameInput").value) || "Game";
  const lang = el("languageSelect").value;
  const aspects = getSelectedAspects();
  const aspect = aspects[0] || "9x16";
  const hookName = state.hook ? slugify(state.hook.rel.split("/").pop().replace(/\.[^.]+$/, "")) : "Hook";
  const gpName = state.gp ? slugify(state.gp.rel.split("/").pop().replace(/\.[^.]+$/, "")) : "GP";
  el("namingPreview").textContent =
    `Preview: ${game}_${aspect}_${todayDateStr()}_${lang}_${hookName}_${gpName}_${state.target}s.mp4`;
}
el("gameNameInput").addEventListener("input", () => {
  try { localStorage.setItem("cs_gameName", el("gameNameInput").value); } catch (e) {}
  updateNamingPreview();
});
el("languageSelect").addEventListener("change", updateNamingPreview);
document.querySelectorAll(".aspect-check").forEach((cb) => cb.addEventListener("change", updateNamingPreview));

// --- export ---
el("exportBtn").addEventListener("click", async () => {
  const btn = el("exportBtn");
  const status = el("statusLine");
  const resultList = el("resultList");
  resultList.innerHTML = "";

  const aspects = getSelectedAspects();
  if (!aspects.length) {
    status.className = "status-line error";
    status.textContent = "Pick at least one export format above.";
    return;
  }

  btn.disabled = true;
  status.className = "status-line";
  status.textContent = "Rendering... this can take a bit for longer gameplay segments.";

  const rows = {};
  aspects.forEach((a) => {
    const row = document.createElement("div");
    row.className = "row state-queued";
    row.innerHTML = `<span class="tag">${a}</span><span class="state">Queued</span>`;
    resultList.appendChild(row);
    rows[a] = row;
  });

  const hookPayload = { rel: state.hook.rel, in: state.hook.in, out: state.hook.out, speed: state.hook.speed };
  const gpPayload = { rel: state.gp.rel, in: state.gp.in, out: state.gp.out, speed: state.gp.speed };

  // Generate the music track once, up front -- it's shared across every
  // aspect ratio below rather than regenerated per dimension.
  let musicTrackId = null, musicError = null;
  if (el("musicToggle").checked) {
    status.textContent = "Generating music...";
    const totalSec = hookOutputLen() + gpOutputLen() + endLen();
    try {
      musicTrackId = await generateMusicTrack(el("musicMood").value, totalSec);
    } catch (e) {
      musicError = e.message;
    }
    status.textContent = "Rendering... this can take a bit for longer gameplay segments.";
  }

  for (const a of aspects) {
    const row = rows[a];
    row.innerHTML = `<span class="tag">${a}</span><span class="state">Rendering...</span>`;
    try {
      const data = await exportOne(hookPayload, gpPayload, a);
      const result = await applyPostProcessing(data.file, data.url, {
        captionToggle: el("captionToggle"), captionStyle: el("captionStyle"),
        musicTrackId, musicError,
      }, (s) => {
        row.innerHTML = `<span class="tag">${a}</span><span class="state">${s}</span>`;
      });
      row.className = "row state-done";
      row.innerHTML = `<span class="tag">${a}</span><span class="state">${result.label}</span><button class="row-open">open</button>`;
      row.querySelector(".row-open").addEventListener("click", () => revealFile(result.file));
    } catch (e) {
      row.className = "row state-error";
      row.innerHTML = `<span class="tag">${a}</span><span class="state">Error: ${e.message}</span>`;
    }
  }
  releaseMusicTrack(musicTrackId);

  status.className = "status-line ok";
  status.textContent = `Done: ${aspects.length} format${aspects.length > 1 ? "s" : ""} exported`;
  btn.disabled = false;
  loadExportsList();
});

async function loadExportsList() {
  const res = await fetch("/api/exports");
  const data = await res.json();
  const list = el("exportsList");
  list.innerHTML = "";
  data.files.forEach((f) => {
    const row = document.createElement("div");
    row.className = "row";
    const sizeMb = (f.size / 1e6).toFixed(1);
    row.innerHTML = `<span>${f.name} <span style="color:var(--muted)">(${sizeMb} MB)</span></span>
      <span class="links"><button class="row-open" data-name="${f.name}" title="Reveals the file in Finder">open</button><button class="row-delete" data-name="${f.name}" title="Removes from this list only -- the file stays in Exports/">remove</button></span>`;
    list.appendChild(row);
  });
  list.querySelectorAll(".row-open").forEach((link) => {
    link.addEventListener("click", () => revealFile(link.dataset.name));
  });
  list.querySelectorAll(".row-delete").forEach((link) => {
    link.addEventListener("click", async () => {
      await fetch(`/exports/${encodeURIComponent(link.dataset.name)}`, { method: "DELETE" });
      loadExportsList();
    });
  });
}

// Two-click arm/confirm instead of window.confirm() -- native dialogs are
// silently suppressed inside sandboxed preview panes, which made this button
// look broken (it was waiting on a confirm() that could never resolve true).
let clearArmed = false;
let clearArmTimer = null;
const clearBtn = el("clearExportsBtn");
const clearBtnDefaultText = clearBtn.textContent;
clearBtn.addEventListener("click", async () => {
  if (!clearArmed) {
    clearArmed = true;
    clearBtn.textContent = "Click again to confirm";
    clearArmTimer = setTimeout(() => {
      clearArmed = false;
      clearBtn.textContent = clearBtnDefaultText;
    }, 4000);
    return;
  }
  clearTimeout(clearArmTimer);
  clearArmed = false;
  clearBtn.textContent = clearBtnDefaultText;
  await fetch("/api/exports", { method: "DELETE" });
  loadExportsList();
});

// --- target toggle ---
el("targetToggle").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-target]");
  if (!btn) return;
  [...el("targetToggle").children].forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  state.target = parseInt(btn.dataset.target, 10);
  el("batchTargetName").textContent = state.target;
  if (state.hook && state.gp && state.end) autoFitGameplay();
  else refreshTimeline();
  updateNamingPreview();
});

el("autoFitBtn").addEventListener("click", autoFitGameplay);
el("endDuration").addEventListener("input", () => {
  if (!state.end || !state.end.isImage) return;
  state.end.holdDuration = parseFloat(el("endDuration").value) || 0.5;
  syncEndLabels();
  refreshTimeline();
});

// --- sequence order (drag to reorder, or use arrow buttons) ---
let dragKey = null;

function renderOrderChips() {
  const wrap = el("orderChips");
  wrap.innerHTML = "";
  state.order.forEach((key, idx) => {
    const chip = document.createElement("div");
    chip.className = "order-chip";
    chip.draggable = true;
    chip.dataset.key = key;
    chip.innerHTML = `
      <span class="pos">${idx + 1}</span>
      <span class="swatch ${key}"></span>
      <span>${SEG_LABELS[key]}</span>
      <span class="arrows">
        <button data-dir="-1" ${idx === 0 ? "disabled" : ""} title="Move earlier">◀</button>
        <button data-dir="1" ${idx === state.order.length - 1 ? "disabled" : ""} title="Move later">▶</button>
      </span>`;

    chip.addEventListener("dragstart", (e) => {
      dragKey = key;
      e.dataTransfer.effectAllowed = "move";
    });
    chip.addEventListener("dragover", (e) => { e.preventDefault(); chip.classList.add("drag-over"); });
    chip.addEventListener("dragleave", () => chip.classList.remove("drag-over"));
    chip.addEventListener("drop", (e) => {
      e.preventDefault();
      chip.classList.remove("drag-over");
      if (!dragKey || dragKey === key) return;
      moveKeyTo(dragKey, state.order.indexOf(key));
    });

    chip.querySelector('button[data-dir="-1"]').addEventListener("click", () => moveKeyTo(key, idx - 1));
    chip.querySelector('button[data-dir="1"]').addEventListener("click", () => moveKeyTo(key, idx + 1));

    wrap.appendChild(chip);
  });
}

function moveKeyTo(key, newIndex) {
  const cur = state.order.indexOf(key);
  if (cur === -1 || newIndex < 0 || newIndex >= state.order.length) return;
  state.order.splice(cur, 1);
  state.order.splice(newIndex, 0, key);
  renderOrderChips();
  refreshTimeline();
}

// --- batch export: same Gameplay/Endcard/order/speed recipe, run across many hooks ---
function buildEndcardPayload() {
  return state.end.isImage
    ? { rel: state.end.rel, duration: state.end.holdDuration }
    : { rel: state.end.rel, duration: (state.end.out - state.end.in) / state.end.speed, in: state.end.in, out: state.end.out, speed: state.end.speed };
}

function buildCtaPayload() {
  if (!state.cta || !state.cta.enabled || !state.cta.rel) return { enabled: false };
  return { enabled: true, rel: state.cta.rel };
}

async function exportOne(hookPayload, gpPayload, aspect) {
  const payload = {
    target: state.target,
    order: state.order,
    hook: hookPayload,
    gameplay: gpPayload,
    endcard: buildEndcardPayload(),
    cta: buildCtaPayload(),
    aspect,
    gameName: el("gameNameInput").value,
    language: el("languageSelect").value,
  };
  const res = await fetch("/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || "export failed");
  return data;
}

function renderBatchHookList() {
  const wrap = el("batchHookList");
  wrap.innerHTML = "";
  state.assets.hooks.forEach((h, idx) => {
    const row = document.createElement("label");
    row.className = "batch-hook-row";
    row.innerHTML = `<input type="checkbox" data-idx="${idx}" /><span>${h.name}</span><span class="hook-duration">${fmt(h.duration)}</span>`;
    wrap.appendChild(row);
  });
}

el("batchSelectAllBtn").addEventListener("click", () => {
  el("batchHookList").querySelectorAll('input[type="checkbox"]').forEach((cb) => (cb.checked = true));
});
el("batchSelectNoneBtn").addEventListener("click", () => {
  el("batchHookList").querySelectorAll('input[type="checkbox"]').forEach((cb) => (cb.checked = false));
});

el("batchExportBtn").addEventListener("click", async () => {
  const selectedIdx = [...el("batchHookList").querySelectorAll('input[type="checkbox"]:checked')]
    .map((cb) => parseInt(cb.dataset.idx, 10));
  const aspects = getSelectedAspects();

  const resultsWrap = el("batchResults");
  resultsWrap.innerHTML = "";

  if (!selectedIdx.length) {
    resultsWrap.innerHTML = `<div class="batch-row state-error"><span class="name">Pick at least one hook above.</span></div>`;
    return;
  }
  if (!aspects.length) {
    resultsWrap.innerHTML = `<div class="batch-row state-error"><span class="name">Pick at least one export format above.</span></div>`;
    return;
  }
  if (!state.gp || !state.end) {
    resultsWrap.innerHTML = `<div class="batch-row state-error"><span class="name">Load a Gameplay and Endcard first.</span></div>`;
    return;
  }

  const rowKey = (idx, a) => `${idx}|${a}`;
  const rows = {};
  selectedIdx.forEach((idx) => {
    const h = state.assets.hooks[idx];
    aspects.forEach((a) => {
      const row = document.createElement("div");
      row.className = "batch-row state-queued";
      row.innerHTML = `<span class="name">${h.name}<span class="tag">${a}</span></span><span class="state">Queued</span>`;
      resultsWrap.appendChild(row);
      rows[rowKey(idx, a)] = row;
    });
  });

  el("batchExportBtn").disabled = true;
  for (const idx of selectedIdx) {
    const h = state.assets.hooks[idx];
    let hookPayload, gpPayload;
    try {
      const hookLen = h.duration / state.hook.speed;
      const eLen = endLen();
      const neededOutputLen = state.target - hookLen - eLen;
      const rawLen = neededOutputLen * state.gp.speed;
      if (rawLen <= 0.2) {
        throw new Error(`hook (${fmt(hookLen)}) + endcard (${fmt(eLen)}) leave no room for gameplay at ${state.target}s`);
      }
      const gpOut = state.gp.in + rawLen;
      hookPayload = { rel: h.rel, in: 0, out: h.duration, speed: state.hook.speed };
      gpPayload = { rel: state.gp.rel, in: state.gp.in, out: gpOut, speed: state.gp.speed };
    } catch (e) {
      aspects.forEach((a) => {
        const row = rows[rowKey(idx, a)];
        row.className = "batch-row state-error";
        row.innerHTML = `<span class="name">${h.name}<span class="tag">${a}</span></span><span class="state">Error: ${e.message}</span>`;
      });
      continue;
    }

    // One music track per hook, shared across that hook's aspect ratios below
    // (gameplay is auto-fit to hit state.target exactly, so every dimension
    // for this hook has the same duration and can reuse the same track).
    let musicTrackId = null, musicError = null;
    if (el("batchMusicToggle").checked) {
      try {
        musicTrackId = await generateMusicTrack(el("batchMusicMood").value, state.target);
      } catch (e) {
        musicError = e.message;
      }
    }

    for (const a of aspects) {
      const row = rows[rowKey(idx, a)];
      row.className = "batch-row state-rendering";
      row.innerHTML = `<span class="name">${h.name}<span class="tag">${a}</span></span><span class="state">Rendering...</span>`;
      try {
        const data = await exportOne(hookPayload, gpPayload, a);
        const result = await applyPostProcessing(data.file, data.url, {
          captionToggle: el("batchCaptionToggle"), captionStyle: el("batchCaptionStyle"),
          musicTrackId, musicError,
        }, (s) => {
          row.innerHTML = `<span class="name">${h.name}<span class="tag">${a}</span></span><span class="state">${s}</span>`;
        });
        row.className = "batch-row state-done";
        row.innerHTML = `<span class="name">${h.name}<span class="tag">${a}</span></span><span class="state">${result.label}</span><button class="row-open">open</button>`;
        row.querySelector(".row-open").addEventListener("click", () => revealFile(result.file));
      } catch (e) {
        row.className = "batch-row state-error";
        row.innerHTML = `<span class="name">${h.name}<span class="tag">${a}</span></span><span class="state">Error: ${e.message}</span>`;
      }
    }
    releaseMusicTrack(musicTrackId);
  }
  el("batchExportBtn").disabled = false;
  loadExportsList();
});

// --- CTA button overlay (endcard only) ---
const CTA_CANVAS_W = 1080; // matches CANVAS_W on the server

function updateCtaPreview() {
  const img = el("ctaPreviewOverlay");
  if (state.cta && state.cta.enabled && state.cta.rel) {
    // Rendered at "original size" in the export, so the preview scales the
    // overlay by the image's natural pixel width relative to the real
    // 1080px-wide canvas, not a fixed percentage.
    const applyWidth = () => {
      if (img.naturalWidth) img.style.width = (img.naturalWidth / CTA_CANVAS_W * 100) + "%";
    };
    img.onload = applyWidth;
    img.src = mediaUrl(state.cta.rel);
    img.style.display = "block";
    if (img.complete) applyWidth();
  } else {
    img.style.display = "none";
  }
}

el("ctaToggle").addEventListener("change", (e) => {
  if (!state.cta) state.cta = { rel: null, enabled: false };
  state.cta.enabled = e.target.checked;
  updateCtaPreview();
});
el("ctaSelect").addEventListener("change", (e) => {
  const item = state.assets.ctas[e.target.value];
  if (!item) return;
  if (!state.cta) state.cta = { rel: null, enabled: false };
  state.cta.rel = item.rel;
  updateCtaPreview();
});

// --- page section order (grab the handle on each card and drag it directly) ---
const SECTION_IDS = [
  "sectionFormats",
  "sectionNaming",
  "sectionSegments",
  "sectionTimeline",
  "sectionBatch",
  "sectionExports",
];
const SECTION_ORDER_KEY = "cs_sectionOrder";

function loadSectionOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem(SECTION_ORDER_KEY) || "null");
    if (Array.isArray(saved) && saved.length === SECTION_IDS.length && SECTION_IDS.every((id) => saved.includes(id))) {
      return saved;
    }
  } catch (e) { /* localStorage unavailable or corrupt -- fall back to default order */ }
  return SECTION_IDS.slice();
}

function applySectionOrder(order) {
  const main = document.querySelector("main");
  order.forEach((id) => {
    const node = el(id);
    if (node) main.appendChild(node); // appendChild on an existing node moves it
  });
}

function saveCurrentSectionOrder() {
  const main = document.querySelector("main");
  const order = [...main.children].map((c) => c.id).filter((id) => SECTION_IDS.includes(id));
  try { localStorage.setItem(SECTION_ORDER_KEY, JSON.stringify(order)); } catch (e) {}
}

let draggedSection = null;

function initSectionDragHandles() {
  const main = document.querySelector("main");
  SECTION_IDS.forEach((id) => {
    const section = el(id);
    if (!section) return;
    section.classList.add("draggable-section");

    const handle = document.createElement("div");
    handle.className = "drag-handle";
    handle.title = "Drag to reorder this section";
    handle.draggable = true;
    handle.textContent = "⠿";
    section.insertBefore(handle, section.firstChild);

    handle.addEventListener("dragstart", (e) => {
      draggedSection = section;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", id);
      requestAnimationFrame(() => section.classList.add("dragging"));
    });
    handle.addEventListener("dragend", () => {
      section.classList.remove("dragging");
      draggedSection = null;
      saveCurrentSectionOrder();
    });

    section.addEventListener("dragover", (e) => {
      if (!draggedSection || draggedSection === section) return;
      e.preventDefault();
      const rect = section.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      main.insertBefore(draggedSection, before ? section : section.nextSibling);
    });
    section.addEventListener("drop", (e) => e.preventDefault());
  });
}

// --- Hook source: existing asset vs. generate a new one with Higgsfield ---
document.querySelectorAll("#hookSourceToggle button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#hookSourceToggle button").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const generating = btn.dataset.source === "generate";
    el("hookGenerate").style.display = generating ? "flex" : "none";
    el("hookExistingPanel").style.display = generating ? "none" : "block";
  });
});

// Optional reference image -- read as a data URI client-side. Higgsfield's
// image_url field accepts an inline "data:image/...;base64,..." string
// directly, so nothing needs to be uploaded/hosted anywhere first.
let hookGenImageDataUri = null;

function clearHookGenImage() {
  hookGenImageDataUri = null;
  el("hookGenImage").value = "";
  el("hookGenImagePreview").style.display = "none";
  el("hookGenImagePreview").src = "";
  el("hookGenImageClear").style.display = "none";
}

el("hookGenImage").addEventListener("change", () => {
  const file = el("hookGenImage").files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    hookGenImageDataUri = reader.result;
    el("hookGenImagePreview").src = hookGenImageDataUri;
    el("hookGenImagePreview").style.display = "block";
    el("hookGenImageClear").style.display = "inline-block";
  };
  reader.onerror = () => {
    el("hookGenStatus").className = "status-line error";
    el("hookGenStatus").textContent = "Could not read that image file.";
    clearHookGenImage();
  };
  reader.readAsDataURL(file);
});
el("hookGenImageClear").addEventListener("click", clearHookGenImage);

el("hookGenBtn").addEventListener("click", async () => {
  const btn = el("hookGenBtn");
  const status = el("hookGenStatus");
  const prompt = el("hookGenPrompt").value.trim();
  if (!prompt) {
    status.className = "status-line error";
    status.textContent = "Describe the video first.";
    return;
  }
  const duration = parseInt(el("hookGenDuration").value, 10);

  btn.disabled = true;
  status.className = "status-line";
  status.textContent = "Generating with Higgsfield... this can take a minute or two.";

  try {
    const res = await fetch("/api/higgsfield/generate-hook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, duration, imageDataUri: hookGenImageDataUri }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "generation failed");

    // The new clip becomes a normal hook asset -- same array, same loadHook()
    // path as picking one from the dropdown.
    const item = { name: data.name, rel: data.rel, isImage: false, duration: data.duration, width: data.width, height: data.height };
    state.assets.hooks.unshift(item);
    populateSelect(el("hookSelect"), state.assets.hooks);
    el("hookSelect").value = 0;
    loadHook(item);
    renderBatchHookList();

    status.className = "status-line ok";
    status.textContent = `Done: added "${data.name}" as a new hook.`;
    el("hookGenPrompt").value = "";
    clearHookGenImage();

    document.querySelectorAll("#hookSourceToggle button").forEach((b) => b.classList.remove("active"));
    document.querySelector('#hookSourceToggle button[data-source="existing"]').classList.add("active");
    el("hookGenerate").style.display = "none";
    el("hookExistingPanel").style.display = "block";
  } catch (e) {
    status.className = "status-line error";
    status.textContent = `Generation failed: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
});

// --- boot ---
async function init() {
  const res = await fetch("/api/assets");
  state.assets = await res.json();

  populateSelect(el("hookSelect"), state.assets.hooks);
  populateSelect(el("gpSelect"), state.assets.gameplays);
  populateSelect(el("batchGpSelect"), state.assets.gameplays);
  populateSelect(el("endSelect"), state.assets.endcards);
  populateSelect(el("ctaSelect"), state.assets.ctas);

  if (state.assets.hooks.length) loadHook(state.assets.hooks[0]);
  if (state.assets.gameplays.length) loadGp(state.assets.gameplays[0]);
  if (state.assets.endcards.length) loadEnd(state.assets.endcards[0]);

  if (state.assets.ctas.length) {
    state.cta = { rel: state.assets.ctas[0].rel, enabled: true };
    el("ctaToggle").checked = true;
  } else {
    state.cta = { rel: null, enabled: false };
    el("ctaToggle").disabled = true;
  }
  updateCtaPreview();

  el("hookSelect").addEventListener("change", (e) => loadHook(state.assets.hooks[e.target.value]));
  el("gpSelect").addEventListener("change", (e) => loadGp(state.assets.gameplays[e.target.value]));
  el("batchGpSelect").addEventListener("change", (e) => loadGp(state.assets.gameplays[e.target.value]));
  el("endSelect").addEventListener("change", (e) => loadEnd(state.assets.endcards[e.target.value]));

  renderOrderChips();
  renderBatchHookList();
  loadExportsList();
  updateNamingPreview();
  applySectionOrder(loadSectionOrder());
  initSectionDragHandles();
}
init();
