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
- Export renders via ffmpeg to `Exports/`, normalized crop/scale/fps
- "Export formats" lets you check any combination of **9:16** (1080x1920), **16:9** (1920x1080), and **4:5** (1080x1350), or "Select all" for all three at once -- one file is rendered per checked format, from the same Hook/Gameplay/Endcard/CTA/caption settings. Applies to both single and batch export.
  - 9:16 and 4:5 crop-to-fill (source is usually portrait already, so this just trims the top/bottom or sides)
  - 16:9 uses a blurred-background treatment instead of a hard crop, since force-cropping a portrait source to fill a landscape frame would throw away most of the shot: the full uncropped video fills the canvas height edge-to-edge, centered horizontally, with a blurred full-bleed copy of the same video filling the empty space on the left and right. Applies uniformly to Hook, Gameplay, and Endcard
- "File naming" bar sets the export filename structure: `{Game}_{Dimension}_{Date}_{Language}_{HookName}_{GPName}_{Duration}s.mp4` (e.g. `GardenGetaway_9x16_2026.09.14_EN_HookUGCYoungLady_GPFullBoard_30s.mp4`). "Game" is a free-text field (remembered across reloads), "Language" is EN/ES/IT/TR/DE, and the rest fill in automatically from your current selections -- a live preview shows the exact filename before you export. Re-exporting the same recipe on the same day overwrites the existing file rather than piling up random suffixes
- Optional "Caption this" / "Caption these" checkboxes add auto-generated captions as a soft subtitle track (see below)
- "Add CTA button" overlays a picked CTA image onto just the endcard segment, with a live preview (see below)
- "Clear list" / "remove" on Past Exports only hide entries from the list -- the files stay in `Exports/`
- "open" next to any result reveals that file in Finder (macOS `open -R`) rather than opening it in the browser -- works because the editor and the browser viewing it run on the same machine

### CTA button

Checking "Add CTA button" (on by default when a CTA image is found) overlays the selected image from a `cta`-named folder onto the endcard only — never the hook or gameplay — centered around 60% down the frame. Its "original size" is defined against the 9:16 canvas (100%); the 16:9 and 4:5 exports scale it down by their height ratio to 9:16's (1920px) so it reads as a consistent relative size instead of ballooning on a shorter canvas -- 4:5 (1350px tall) comes out around 70%, 16:9 (1080px tall) around 56%. It pops in with a soft eased scale-in over the first 0.35s, then pulses gently (+/-6% size, ~0.9s per cycle) for the rest of the endcard to draw the eye -- no scale-out, it keeps pulsing right up to the end. The Endcard preview shows a live overlay (static, no animation) scaled proportionally to match, so you can see roughly how it'll sit before exporting. Applies to both single and batch export.

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
