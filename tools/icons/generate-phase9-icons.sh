#!/bin/bash
# Phase 9.12 editor icons (Qwen-Image, transparent, 256x256, seed 42).
set -e
cd ~/projects/qwenimage
gen() { name="$1"; thing="$2"; colors="$3"
  python3 client.py --output-dir "${OUT:-/tmp/icons9}"/raw generate --transparent --width 256 --height 256 --steps 40 --seed 42 \
    --prompt "A flat minimalist UI icon: ${thing}. Simple bold vector shapes, ${colors}, soft rounded edges, no text, no letters, no drop shadow, centered, the icon fills most of the frame, on a plain background." > "${OUT:-/tmp/icons9}"/$name.log 2>&1
  f=$(ls -t "${OUT:-/tmp/icons9}"/raw/*.png | head -1); cp "$f" "${OUT:-/tmp/icons9}"/$name.raw.png; echo "$name <- $f"
}
mkdir -p "${OUT:-/tmp/icons9}"/raw
gen point "a glowing light bulb with short rays" "warm yellow and white"
gen spot "a stage spotlight lamp casting a wide cone of light downwards" "dark grey lamp, pale yellow light cone"
gen hemisphere "a round dome split in two halves, the upper half sky with a small sun, the lower half grass" "sky blue top, grass green bottom"
gen sound "a loudspeaker with three curved sound waves" "teal and white"
gen pickup "a shiny gold coin with a star embossed on it" "gold yellow and orange"
gen enemy "a cute angry slime monster with small horns" "purple with white eyes"
gen mover "a floating platform slab with a double-headed arrow above it pointing left and right" "tan brown platform, orange arrow"
gen switch "a big round red push button on a grey base plate" "red and grey"
gen door "a closed arched wooden door with a round handle" "warm brown wood"
gen sensor "a dashed square frame with a lightning bolt in the middle" "cyan"
gen fog "a soft cloud of fog with three wavy horizontal lines under it" "pale blue-grey"
gen sky "a yellow sun partly hidden behind a single fluffy white cloud with a light blue outline, no sky background" "yellow, white, light blue" # seed 7 in the shipped icon
