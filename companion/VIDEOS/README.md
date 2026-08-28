# Companion animation sources

These MP4 files are source media for default Companion animations. Runtime does
not decode them directly; release binaries embed JPEG sprite sheets from
`companion/animations/`.

Each sheet uses first three seconds at 24 FPS: 72 square `200x200` frames in a
`12x6` grid, producing a `2400x1200` JPEG.

| Source | Runtime animation |
| --- | --- |
| `idle.mp4` | `intro.jpg` |
| `question.mp4` | `question.jpg` (`input` state) |
| `unknown.mp4` | `unknown.jpg` (unknown/custom agents) |
| Other `<name>.mp4` files | Matching `<name>.jpg` agent animation |

Regenerate sheets from repository root with FFmpeg:

```bash
for video in companion/VIDEOS/*.mp4; do
  name=$(basename "$video" .mp4)
  output_name=$name
  if [ "$name" = "idle" ]; then
    output_name=intro
  fi
  ffmpeg -hide_banner -loglevel error -y \
    -i "$video" \
    -vf "trim=duration=3,setpts=PTS-STARTPTS,fps=24,scale=200:200,setsar=1,tile=12x6" \
    -frames:v 1 -q:v 2 \
    "companion/animations/$output_name.jpg"
done
```
