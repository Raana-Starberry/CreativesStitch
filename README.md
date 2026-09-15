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
- Export renders via ffmpeg to `Exports/`, normalized crop/scale/fps. A source clip with no audio track (silent b-roll) gets silence substituted for that segment rather than crashing the export
- "Export formats" lets you check any combination of **9:16** (1080x1920), **16:9** (1920x1080), and **4:5** (1080x1350), or "Select all" for all three at once -- one file is rendered per checked format, from the same Hook/Gameplay/Endcard/CTA/caption settings. Applies to both single and batch export.
  - 9:16 and 4:5 crop-to-fill (source is usually portrait already, so this just trims the top/bottom or sides)
  - 16:9 uses a blurred-background treatment instead of a hard crop, since force-cropping a portrait source to fill a landscape frame would throw away most of the shot: the full uncropped video fills the canvas height edge-to-edge, centered horizontally, with a blurred full-bleed copy of the same video filling the empty space on the left and right. Applies uniformly to Hook, Gameplay, and Endcard
- "File naming" bar sets the export filename structure: `{Game}_{Dimension}_{Date}_{Language}_{HookName}_{GPName}_{Duration}s.mp4` (e.g. `GardenGetaway_9x16_2026.09.14_EN_HookUGCYoungLady_GPFullBoard_30s.mp4`). "Game" is a free-text field (remembered across reloads), "Language" is EN/ES/IT/TR/DE, and the rest fill in automatically from your current selections -- a live preview shows the exact filename before you export. Re-exporting the same recipe on the same day overwrites the existing file rather than piling up random suffixes
- Every export lands in a folder named after the same convention minus the dimension (`{Game}_{Date}_{Language}_{HookName}_{GPName}_{Duration}s/`), so all the aspect-ratio variants of one recipe -- 9:16, 16:9, 4:5 -- sit together in one place instead of scattered flat in `Exports/`
- Optional "Caption this" / "Caption these" checkboxes add auto-generated captions as a soft subtitle track (see below)
- "Add CTA button" overlays a picked CTA image onto just the endcard segment, with a live preview (see below)
- "Clear list" / "remove" on Past Exports only hide entries from the list -- the files stay in `Exports/`
- "open" next to any result reveals that file in Finder (macOS `open -R`) rather than opening it in the browser -- works because the editor and the browser viewing it run on the same machine
- Each major section (Export formats, File naming, Hook/Gameplay/Endcard, Timeline & Export, Batch export, Past exports) has a small grip handle (⠿) in the left margin -- grab it and drag the section itself to reorder the page layout. The order is remembered across reloads

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

### Background music (ElevenLabs)

Checking "Add music" (single export) or "Add music" in Batch export generates an instrumental track with [ElevenLabs Music](https://elevenlabs.io/docs/api-reference/music) in the mood picked from the dropdown (Upbeat, Chill, Playful, Epic, Suspenseful), sized to the export's length, and mixes it in quietly underneath the existing hook/gameplay/endcard audio -- it never replaces the original dialogue or sound effects. It's opt-in: leave it unchecked and exports are unaffected. One track is generated per export (per hook, in batch export) and reused across every checked aspect ratio -- picking 9:16 + 16:9 + 4:5 still only generates the music once, since dimension has no bearing on the music itself. Uses the same `ELEVENLABS_API_KEY` as captions (see above); no extra setup needed. If both "Caption this" and "Add music" are checked, captions are applied first and music is mixed into that result, so the final file (`..._captioned_music.mp4` or similar) has both. The uncaptioned/unmusicked original is always kept alongside.

### Generating a Hook with Higgsfield

The Hook segment has a toggle at the top: **Existing** (pick from the `Hook/` folder as usual) or **Generate with Higgsfield**. In generate mode, describe the clip in the text box, optionally attach a **reference image** (uploaded locally, used as the video's start frame instead of pure text-to-video), pick a duration (5s or 10s), and hit "Generate hook" -- it runs the [Higgsfield CLI](https://higgsfield.ai/cli) (Kling 3.0 Turbo, 9:16) in the background, waits for the result (typically under a couple of minutes), downloads it straight into the `Hook/` folder, and selects it as the current hook. From that point on it's just a normal hook clip -- reusable from the "Existing" dropdown on future runs, trimmable, speed-adjustable, same as anything else.

Setup: install and authenticate the Higgsfield CLI once (it draws on your Higgsfield account's own subscription credits, not a separate API wallet):

```bash
npm i -g @higgsfield/cli
higgsfield auth login
higgsfield workspace set <workspace_id>   # `higgsfield workspace list` shows the id
```

The editor server shells out to this CLI, so it must stay authenticated on the machine running `node editor/server.js`. Running low on credits (`higgsfield account status`) shows up as a generation error in the status line rather than a video.

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
