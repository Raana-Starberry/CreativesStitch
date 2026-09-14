# CreativesStitch

A tool for stitching ad creatives together from three parts — **Hook**, **Gameplay**, and **Endcard** — into 30s/60s exports.

## Folder convention

Source clips live in folders matched by name (add more any time):

- a folder with `hook` in its name → hook clips
- a folder with `gp` or `gameplay` in its name → gameplay clips
- a folder with `end` in its name → endcard image/clip
- a folder with `cta` in its name → CTA button images (see below)

Currently: [`Hook/`](Hook), [`Gameplays/`](Gameplays), [`endcard/`](endcard), [`CTA/`](CTA).

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
- "Add CTA button" overlays a picked CTA image onto just the endcard segment, with a live preview (see below)
- "Clear list" / "remove" on Past Exports only hide entries from the list -- the files stay in `Exports/`

### CTA button

Checking "Add CTA button" (on by default when a CTA image is found) overlays the selected image from a `cta`-named folder onto the endcard only — never the hook or gameplay — at its original pixel size, centered around 60% down the frame. It pops in with a soft eased scale-in over the first 0.35s, then pulses gently (+/-6% size, ~0.9s per cycle) for the rest of the endcard to draw the eye -- no scale-out, it keeps pulsing right up to the end. The Endcard preview shows a live overlay (static, no animation) scaled proportionally to match, so you can see roughly how it'll sit before exporting. Applies to both single and batch export.

### Captions (ElevenLabs)

Checking "Caption this" (single export) or "Caption these" (batch export) transcribes the finished video's audio with [ElevenLabs Speech-to-Text](https://elevenlabs.io/docs/api-reference/speech-to-text) and adds captions in one of two styles (dropdown next to the checkbox):

- **Burned-in** (default) — text rendered permanently into the video frame, visible in any player/platform with no toggling needed. Requires `ffmpeg-full` (see below).
- **Soft subtitle** — an embedded, toggleable `mov_text` track (`..._captioned.mp4`). Only renders in players that support toggling embedded subtitle tracks (QuickTime, VLC) — **not** in a plain browser `<video>` element or most ad platforms.

Either way the original uncaptioned file is kept alongside the captioned one. Requires speech in the audio; silent gameplay/endcard segments just won't have cues.

Setup: create `.env` in the project root (never committed — already in `.gitignore`) with:

```
ELEVENLABS_API_KEY=your_key_here
```

Optionally override the STT model with `ELEVENLABS_STT_MODEL` (defaults to `scribe_v1`).

Burned-in captions need the `subtitles` filter (libass), which the default Homebrew `ffmpeg` formula doesn't include. Install `ffmpeg-full` alongside it (keg-only, doesn't touch your regular `ffmpeg`):

```bash
brew install ffmpeg-full
```

The server auto-detects it at `/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg` (or `/usr/local/opt/...` on Intel Macs), or set `FFMPEG_FULL_BIN` to point at a specific binary. Without it, burned-in captioning will fail — soft subtitles still work with the regular `ffmpeg`.

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
