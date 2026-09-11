# CreativesStitch

A tool for stitching ad creatives together from three parts — **Hook**, **Gameplay**, and **Endcard** — into 30s/60s exports.

## Folder convention

Source clips live in folders matched by name (add more any time):

- a folder with `hook` in its name → hook clips
- a folder with `gp` or `gameplay` in its name → gameplay clips
- a folder with `end` in its name → endcard image/clip

Currently: [`Hook/`](Hook), [`Gameplays/`](Gameplays), [`endcard/`](endcard).

## Timeline editor (recommended)

A local web UI for trimming cut points, setting per-clip playback speed, and reordering the sequence before exporting.

```bash
node editor/server.js
```

Open `http://localhost:5175`. Features:

- Pick a Hook / Gameplay / Endcard combination and preview each clip
- Drag-trim in/out points per clip
- Per-clip speed control (0.25x–3x), live in preview and in the export
- Drag to reorder the Hook / Gameplay / Endcard sequence
- "Auto-fit to target" computes the gameplay length needed to hit 30s or 60s exactly
- "Preview full sequence" plays the cut back-to-back before you render
- Export renders via ffmpeg to `Exports/` (1080x1920, normalized crop/scale/fps)
- Optional "Caption this" / "Caption these" checkboxes add auto-generated captions as a soft subtitle track (see below)
- "Clear list" / "remove" on Past Exports only hide entries from the list -- the files stay in `Exports/`

### Captions (ElevenLabs)

Checking "Caption this" (single export) or "Caption these" (batch export) transcribes the finished video's audio with [ElevenLabs Speech-to-Text](https://elevenlabs.io/docs/api-reference/speech-to-text) and muxes the result in as a soft/toggleable subtitle track (`..._captioned.mp4`) — the original uncaptioned file is kept too. Requires speech in the audio; silent gameplay/endcard segments just won't have cues.

Setup: create `.env` in the project root (never committed — already in `.gitignore`) with:

```
ELEVENLABS_API_KEY=your_key_here
```

Optionally override the STT model with `ELEVENLABS_STT_MODEL` (defaults to `scribe_v1`).

## Batch script

For generating every Hook x Gameplay combination without hand-tuning cuts:

```bash
python3 combine.py --list                 # see discovered assets
python3 combine.py --dry-run              # preview the export plan
python3 combine.py --duration 30,60       # all combos, both lengths (default)
python3 combine.py --duration 30 --hook poppy --gp basic
```

## Requirements

- `ffmpeg` / `ffprobe` on PATH
- Node.js (for the editor; no npm dependencies needed)
- Python 3 (for the batch script)
