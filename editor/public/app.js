const SEG_LABELS = { hook: "Hook", gp: "Gameplay", end: "Endcard" };

const state = {
  target: 30,
  order: ["hook", "gp", "end"],
  assets: { hooks: [], gameplays: [], endcards: [] },
  hook: null,   // {rel, duration, in, out, speed}
  gp: null,     // {rel, duration, in, out, speed}
  end: null,    // {rel, isImage, duration, in, out, speed, holdDuration}
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

// --- captioning (ElevenLabs speech-to-text -> soft subtitle track) ---
async function captionExport(filename) {
  const res = await fetch("/api/caption", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file: filename }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || "captioning failed");
  return data; // { ok, captioned, file?, url?, reason? }
}

// --- export ---
el("exportBtn").addEventListener("click", async () => {
  const btn = el("exportBtn");
  const status = el("statusLine");
  el("resultRow").classList.remove("show");
  btn.disabled = true;
  status.className = "status-line";
  status.textContent = "Rendering... this can take a bit for longer gameplay segments.";

  const payload = {
    target: state.target,
    order: state.order,
    hook: { rel: state.hook.rel, in: state.hook.in, out: state.hook.out, speed: state.hook.speed },
    gameplay: { rel: state.gp.rel, in: state.gp.in, out: state.gp.out, speed: state.gp.speed },
    endcard: buildEndcardPayload(),
  };

  try {
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "export failed");
    status.className = "status-line ok";
    status.textContent = `Done: ${data.file}`;
    el("resultVideo").src = data.url;
    el("resultLink").href = data.url;
    el("resultRow").classList.add("show");
    loadExportsList();

    if (el("captionToggle").checked) {
      status.textContent = `Done: ${data.file} -- captioning...`;
      try {
        const capData = await captionExport(data.file);
        if (capData.captioned) {
          status.textContent = `Done: ${capData.file} (captioned)`;
          el("resultVideo").src = capData.url;
          el("resultLink").href = capData.url;
        } else {
          status.textContent = `Done: ${data.file} -- ${capData.reason || "no captions added"}`;
        }
        loadExportsList();
      } catch (e) {
        status.textContent = `Done: ${data.file} -- captioning failed: ${e.message}`;
      }
    }
  } catch (e) {
    status.className = "status-line error";
    status.textContent = "Error: " + e.message;
  } finally {
    btn.disabled = false;
  }
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
      <span class="links"><a href="${f.url}" target="_blank">open</a><a class="row-delete" data-name="${f.name}" title="Removes from this list only -- the file stays in Exports/">remove</a></span>`;
    list.appendChild(row);
  });
  list.querySelectorAll(".row-delete").forEach((link) => {
    link.addEventListener("click", async () => {
      await fetch(`/exports/${encodeURIComponent(link.dataset.name)}`, { method: "DELETE" });
      loadExportsList();
    });
  });
}

el("clearExportsBtn").addEventListener("click", async () => {
  if (!confirm("Clear this list? The video files stay in the Exports folder.")) return;
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

async function exportOne(hookPayload, gpPayload) {
  const payload = {
    target: state.target,
    order: state.order,
    hook: hookPayload,
    gameplay: gpPayload,
    endcard: buildEndcardPayload(),
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

  const resultsWrap = el("batchResults");
  resultsWrap.innerHTML = "";

  if (!selectedIdx.length) {
    resultsWrap.innerHTML = `<div class="batch-row state-error"><span class="name">Pick at least one hook above.</span></div>`;
    return;
  }
  if (!state.gp || !state.end) {
    resultsWrap.innerHTML = `<div class="batch-row state-error"><span class="name">Load a Gameplay and Endcard first.</span></div>`;
    return;
  }

  const rows = {};
  selectedIdx.forEach((idx) => {
    const h = state.assets.hooks[idx];
    const row = document.createElement("div");
    row.className = "batch-row state-queued";
    row.innerHTML = `<span class="name">${h.name}</span><span class="state">Queued</span>`;
    resultsWrap.appendChild(row);
    rows[idx] = row;
  });

  el("batchExportBtn").disabled = true;
  for (const idx of selectedIdx) {
    const h = state.assets.hooks[idx];
    const row = rows[idx];
    row.className = "batch-row state-rendering";
    row.innerHTML = `<span class="name">${h.name}</span><span class="state">Rendering...</span>`;
    try {
      const hookLen = h.duration / state.hook.speed;
      const eLen = endLen();
      const neededOutputLen = state.target - hookLen - eLen;
      const rawLen = neededOutputLen * state.gp.speed;
      if (rawLen <= 0.2) {
        throw new Error(`hook (${fmt(hookLen)}) + endcard (${fmt(eLen)}) leave no room for gameplay at ${state.target}s`);
      }
      const gpOut = state.gp.in + rawLen;
      const hookPayload = { rel: h.rel, in: 0, out: h.duration, speed: state.hook.speed };
      const gpPayload = { rel: state.gp.rel, in: state.gp.in, out: gpOut, speed: state.gp.speed };
      const data = await exportOne(hookPayload, gpPayload);
      let finalUrl = data.url, finalState = "Done";
      if (el("batchCaptionToggle").checked) {
        row.innerHTML = `<span class="name">${h.name}</span><span class="state">Captioning...</span>`;
        try {
          const capData = await captionExport(data.file);
          if (capData.captioned) { finalUrl = capData.url; finalState = "Done (captioned)"; }
          else finalState = `Done (${capData.reason || "no captions"})`;
        } catch (e) {
          finalState = `Done, captioning failed: ${e.message}`;
        }
      }
      row.className = "batch-row state-done";
      row.innerHTML = `<span class="name">${h.name}</span><span class="state">${finalState}</span><a href="${finalUrl}" target="_blank">open</a>`;
    } catch (e) {
      row.className = "batch-row state-error";
      row.innerHTML = `<span class="name">${h.name}</span><span class="state">Error: ${e.message}</span>`;
    }
  }
  el("batchExportBtn").disabled = false;
  loadExportsList();
});

// --- boot ---
async function init() {
  const res = await fetch("/api/assets");
  state.assets = await res.json();

  populateSelect(el("hookSelect"), state.assets.hooks);
  populateSelect(el("gpSelect"), state.assets.gameplays);
  populateSelect(el("batchGpSelect"), state.assets.gameplays);
  populateSelect(el("endSelect"), state.assets.endcards);

  if (state.assets.hooks.length) loadHook(state.assets.hooks[0]);
  if (state.assets.gameplays.length) loadGp(state.assets.gameplays[0]);
  if (state.assets.endcards.length) loadEnd(state.assets.endcards[0]);

  el("hookSelect").addEventListener("change", (e) => loadHook(state.assets.hooks[e.target.value]));
  el("gpSelect").addEventListener("change", (e) => loadGp(state.assets.gameplays[e.target.value]));
  el("batchGpSelect").addEventListener("change", (e) => loadGp(state.assets.gameplays[e.target.value]));
  el("endSelect").addEventListener("change", (e) => loadEnd(state.assets.endcards[e.target.value]));

  renderOrderChips();
  renderBatchHookList();
  loadExportsList();
}
init();
