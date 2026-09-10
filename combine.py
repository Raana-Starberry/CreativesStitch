#!/usr/bin/env python3
"""
Creative stitcher: combines Hook + Gameplay + Endcard into 30s/60s ad exports.

Folder convention (add more folders any time, they're matched by name):
  - a folder with "hook" in its name        -> hook clips
  - a folder with "gp" or "gameplay" in it   -> gameplay clips
  - a folder with "end" in its name          -> endcard image/clip

Usage:
  python3 combine.py --list
  python3 combine.py --duration 30
  python3 combine.py --duration 30,60
  python3 combine.py --duration 30 --hook poppy --gp basic
  python3 combine.py --duration 30 --dry-run
"""

import argparse
import itertools
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EXPORT_DIR = ROOT / "Exports"

VIDEO_EXT = {".mp4", ".mov", ".m4v"}
IMAGE_EXT = {".png", ".jpg", ".jpeg"}

CANVAS_W, CANVAS_H, FPS = 1080, 1920, 30
AUDIO_RATE, AUDIO_LAYOUT = 48000, "stereo"


def ffprobe_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(json.loads(out.stdout)["format"]["duration"])


def discover():
    hooks, gameplays, endcards = [], [], []
    for folder in sorted(p for p in ROOT.iterdir() if p.is_dir() and p.name != "Exports"):
        name = folder.name.lower()
        bucket = None
        if "hook" in name:
            bucket = hooks
        elif "gp" in name or "gameplay" in name:
            bucket = gameplays
        elif "end" in name:
            bucket = endcards
        else:
            continue
        for f in sorted(folder.iterdir()):
            ext = f.suffix.lower()
            if ext in VIDEO_EXT or ext in IMAGE_EXT:
                bucket.append(f)
    return hooks, gameplays, endcards


def slug(path: Path) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "", path.stem)


def build_export(hook: Path, gp: Path, endcard: Path, target: int,
                  endcard_dur: float, out_dir: Path, dry_run: bool):
    hook_dur = ffprobe_duration(hook)
    is_image = endcard.suffix.lower() in IMAGE_EXT

    gp_dur = target - hook_dur - endcard_dur
    if gp_dur <= 0.2:
        print(f"  SKIP {hook.name} + {gp.name} @ {target}s: "
              f"hook ({hook_dur:.1f}s) + endcard ({endcard_dur:.1f}s) "
              f"leaves no room for gameplay")
        return

    gp_available = ffprobe_duration(gp)
    if gp_dur > gp_available:
        print(f"  WARN {gp.name} is only {gp_available:.1f}s, "
              f"needs {gp_dur:.1f}s to hit {target}s -- will loop it")

    out_name = f"{slug(hook)}_{slug(gp)}_{target}s.mp4"
    out_path = out_dir / out_name

    vf = (f"scale={CANVAS_W}:{CANVAS_H}:force_original_aspect_ratio=increase,"
          f"crop={CANVAS_W}:{CANVAS_H},setsar=1,fps={FPS},format=yuv420p")
    af = f"aformat=sample_rates={AUDIO_RATE}:channel_layouts={AUDIO_LAYOUT}"

    inputs = []
    filters = []

    # 0: hook (full length)
    inputs += ["-i", str(hook)]
    filters.append(f"[0:v]{vf}[v0]")
    filters.append(f"[0:a]{af}[a0]")

    # 1: gameplay, looped if needed, trimmed to exact gp_dur
    if gp_dur > gp_available:
        inputs += ["-stream_loop", "-1", "-t", f"{gp_dur:.3f}", "-i", str(gp)]
    else:
        inputs += ["-t", f"{gp_dur:.3f}", "-i", str(gp)]
    filters.append(f"[1:v]{vf}[v1]")
    filters.append(f"[1:a]{af}[a1]")

    # 2: endcard (image looped into a clip, or a real video clip)
    if is_image:
        inputs += ["-loop", "1", "-t", f"{endcard_dur:.3f}", "-i", str(endcard)]
    else:
        inputs += ["-t", f"{endcard_dur:.3f}", "-i", str(endcard)]
    filters.append(f"[2:v]{vf}[v2]")

    # 3: silent audio bed for the endcard (image has no audio track)
    inputs += ["-f", "lavfi", "-t", f"{endcard_dur:.3f}",
               "-i", f"anullsrc=r={AUDIO_RATE}:cl={AUDIO_LAYOUT}"]
    filters.append("[3:a]anull[a2]")

    filters.append("[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[outv][outa]")

    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        *inputs,
        "-filter_complex", ";".join(filters),
        "-map", "[outv]", "-map", "[outa]",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-c:a", "aac", "-b:a", "192k",
        "-pix_fmt", "yuv420p",
        str(out_path),
    ]

    print(f"  BUILD {out_name}  (hook {hook_dur:.1f}s + gp {gp_dur:.1f}s + end {endcard_dur:.1f}s)")
    if dry_run:
        print("   " + " ".join(cmd))
        return
    subprocess.run(cmd, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--list", action="store_true", help="list discovered assets and exit")
    parser.add_argument("--duration", default="30,60", help="comma-separated target lengths in seconds (default: 30,60)")
    parser.add_argument("--hook", help="substring filter on hook filenames")
    parser.add_argument("--gp", help="substring filter on gameplay filenames")
    parser.add_argument("--endcard", help="substring filter on endcard filenames")
    parser.add_argument("--endcard-duration", type=float, default=2.0, help="seconds the endcard holds (default: 2.0)")
    parser.add_argument("--out-dir", default=str(EXPORT_DIR), help="output folder (default: Exports/)")
    parser.add_argument("--dry-run", action="store_true", help="print the plan without running ffmpeg")
    args = parser.parse_args()

    hooks, gameplays, endcards = discover()

    if args.list:
        print("Hooks:", [h.name for h in hooks])
        print("Gameplays:", [g.name for g in gameplays])
        print("Endcards:", [e.name for e in endcards])
        return

    if not hooks or not gameplays or not endcards:
        print("Missing assets -- need at least one file in a *hook*, *gp/gameplay*, and *end* folder.")
        print("Hooks:", [h.name for h in hooks])
        print("Gameplays:", [g.name for g in gameplays])
        print("Endcards:", [e.name for e in endcards])
        sys.exit(1)

    if args.hook:
        hooks = [h for h in hooks if args.hook.lower() in h.name.lower()]
    if args.gp:
        gameplays = [g for g in gameplays if args.gp.lower() in g.name.lower()]
    if args.endcard:
        endcards = [e for e in endcards if args.endcard.lower() in e.name.lower()]

    targets = [int(x) for x in args.duration.split(",")]
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    combos = list(itertools.product(hooks, gameplays, endcards, targets))
    print(f"Planning {len(combos)} export(s) -> {out_dir}")
    for hook, gp, endcard, target in combos:
        build_export(hook, gp, endcard, target, args.endcard_duration, out_dir, args.dry_run)


if __name__ == "__main__":
    main()
