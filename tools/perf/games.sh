#!/bin/sh
# Measure game projects the way the village class is measured (tools/perf/village-run.ts): their export on
# both renderers, the plain three.js page built from the same frame, GPU passes and the main-thread split.
# Local only, not in the gate (it needs the games on this host).
#
#   tools/perf/games.sh [game-folder …]      default: ~/projects/skyforge-tactics ~/projects/sprout
#
# A game's own folder is never registered or written: the backend writes into what it registers, so each
# game is copied (without .git and node_modules) to ~/.cache/thirdlight-perf/games/<name>/ and the copy is
# measured, then deleted (TL_GAMES_KEEP=1 keeps it). Run it in a memory-capped scope on this host.
#
# The view to measure: TL_GAME_STEPS (JSON steps for every game: {"wait":ms}, {"key":"Enter"}, {"click":[x,y]})
# or the default below per folder name — the keys that take each game from its title into its first scene.
# Extra arguments for the run (e.g. --renderers webgpu --ablation) go in TL_GAME_ARGS.
# TL_GAME_STATIC=1 marks the copy's placed models static first (tools/perf/mark-static.mjs): static batching
# measured on a game whose scenes do not set the flag yet.
set -eu
cd "$(dirname "$0")/../.."
[ -f dist/backend/backend.mjs ] || { echo "games: run npm run build first"; exit 2; }
ROOT=${TL_PERF_ROOT:-$HOME/.cache/thirdlight-perf}/games
mkdir -p "$ROOT"
[ "$#" -gt 0 ] || set -- "$HOME/projects/skyforge-tactics" "$HOME/projects/sprout"
for src in "$@"; do
  name=$(basename "$src")
  case "$name" in
    skyforge*) steps='[{"wait":6000},{"key":"Enter"},{"wait":3000},{"key":"Enter"},{"wait":15000}]' ;;
    *) steps='[{"wait":6000}]' ;;
  esac
  steps=${TL_GAME_STEPS:-$steps}
  copy="$ROOT/$name"
  echo "games: copying $src to $copy"
  rm -rf "$copy"
  rsync -a --exclude .git --exclude node_modules "$src/" "$copy/"
  [ "${TL_GAME_STATIC:-0}" = 1 ] && node tools/perf/mark-static.mjs "$copy"
  # shellcheck disable=SC2086
  node tools/perf/run.mjs village --project "$copy" --steps "$steps" ${TL_GAME_ARGS:-} || echo "games: $name failed"
  [ "${TL_GAMES_KEEP:-0}" = 1 ] || rm -rf "$copy"
done
