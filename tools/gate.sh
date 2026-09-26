#!/usr/bin/env bash
# Thirdlight green gate (2026-09-26). Three modes:
#
#   tools/gate.sh fast [e2e files or dirs…]   per commit: build + vitest + the smoke set + the
#                                             e2e files named (the ones for the area you changed)
#   tools/gate.sh full                        per phase item / before STATUS says done: build +
#                                             vitest + every e2e spec in both projects, the leak
#                                             test included (TL_MEMORY=1)
#   tools/gate.sh rerun                       the fix loop: only the tests that failed last time
#                                             (Playwright --last-failed), nothing else
#
# Every run writes its logs to its own folder (TL_GATE_LOGS, default
# ~/.cache/thirdlight-logs/gate-<mode>-<time>/) and prints the last line GREEN or RED.
# A failed full run reruns its failed tests once alone (load flakes on the
# CPU-rendered host) before it says RED. TL_E2E_WORKERS sets Playwright's
# worker count (default here: 3; the config's own default is 1).
set -u
mode=${1:-}
shift || true
cd "$(dirname "$0")/.."
SMOKE=(tests/e2e/start.e2e.ts tests/e2e/play-export.e2e.ts tests/e2e/menus.e2e.ts tests/e2e/scenes.e2e.ts tests/e2e/rendering.e2e.ts tests/e2e/inspector.e2e.ts)
export TL_E2E_WORKERS=${TL_E2E_WORKERS:-3}
L=${TL_GATE_LOGS:-$HOME/.cache/thirdlight-logs/gate-$mode-$(date +%Y%m%d-%H%M%S)}
mkdir -p "$L"
t0=$(date +%s)
say() { echo "$*" | tee -a "$L/summary.txt"; }
done_() { say "$1 ($(( ($(date +%s) - t0) / 60 )) min, logs $L)"; case "$1" in GREEN*) exit 0 ;; *) exit 1 ;; esac; }

build_and_unit() {
  npm run build > "$L/build.log" 2>&1
  grep -q '^build: done' "$L/build.log" || { grep -E 'FAIL|error' "$L/build.log" | head -20; done_ "RED build"; }
  npx vitest run --exclude '.claude/**' --exclude 'archive/**' > "$L/vitest.log" 2>&1
  if ! grep -qE 'Test Files .*passed' "$L/vitest.log" || grep -qE 'Test Files .*failed' "$L/vitest.log"; then
    grep -E 'FAIL|✗|×' "$L/vitest.log" | head -20; done_ "RED vitest"
  fi
  say "$(grep -E 'Test Files' "$L/vitest.log" | tail -1 | sed 's/^ *//')"
}

e2e() { # e2e <log> [playwright args…]
  local log=$1; shift
  npx playwright test "$@" > "$L/$log" 2>&1
  say "$log: $(grep -E '^\s+[0-9]+ (passed|failed|flaky)' "$L/$log" | tr -s ' ' | tr '\n' ' ')"
  grep -qE '^\s+[0-9]+ passed' "$L/$log" && ! grep -qE '^\s+[0-9]+ failed' "$L/$log"
}

case "$mode" in
  fast)
    build_and_unit
    e2e e2e.log --project=default "${SMOKE[@]}" "$@" || done_ "RED e2e (fix, then: tools/gate.sh rerun)"
    done_ GREEN ;;
  full)
    build_and_unit
    export TL_MEMORY=1
    if e2e e2e.log; then done_ GREEN; fi
    grep -qE '^\s+[0-9]+ failed' "$L/e2e.log" || done_ "RED e2e (no summary)"
    say "rerunning the failed tests alone"
    TL_E2E_WORKERS=1 e2e e2e-rerun.log --last-failed && done_ "GREEN (failed once, passed alone: see e2e.log)"
    done_ "RED e2e (fix, then: tools/gate.sh rerun)" ;;
  rerun)
    npm run build > "$L/build.log" 2>&1
    grep -q '^build: done' "$L/build.log" || done_ "RED build"
    export TL_MEMORY=1
    e2e e2e.log --last-failed && done_ GREEN
    done_ "RED e2e" ;;
  *) echo "usage: tools/gate.sh fast [e2e files…] | full | rerun"; exit 2 ;;
esac
