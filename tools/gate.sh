#!/usr/bin/env bash
# Thirdlight green gate. Three modes:
#
#   tools/gate.sh fast [e2e files or dirs…]   per commit: build + lint + vitest + the smoke set + the
#                                             e2e files named (the ones for the area you changed)
#   tools/gate.sh full [--both-renderers]     per phase item / before STATUS says done: build +
#                                             lint + vitest + every e2e spec, the leak test included
#                                             (TL_MEMORY=1). On a GPU one pass in the
#                                             product's own renderer; --both-renderers (for shader /
#                                             rendering changes) adds the forced WebGL 2 variants and
#                                             the webgpu project
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
SMOKE=(tests/e2e/start.e2e.ts tests/e2e/play-export.e2e.ts tests/e2e/menus.e2e.ts tests/e2e/scenes.e2e.ts tests/e2e/rendering.e2e.ts tests/e2e/inspector.e2e.ts tests/e2e/scale-bench.e2e.ts tests/e2e/count-caps.e2e.ts)
export TL_E2E_WORKERS=${TL_E2E_WORKERS:-3}
L=${TL_GATE_LOGS:-$HOME/.cache/thirdlight-logs/gate-$mode-$(date +%Y%m%d-%H%M%S)}
mkdir -p "$L"
t0=$(date +%s)
say() { echo "$*" | tee -a "$L/summary.txt"; }
done_() { say "$1 ($(( ($(date +%s) - t0) / 60 )) min, logs $L)"; case "$1" in GREEN*) exit 0 ;; *) exit 1 ;; esac; }

build_and_unit() {
  npm run build > "$L/build.log" 2>&1
  grep -q '^build: done' "$L/build.log" || { grep -E 'FAIL|error' "$L/build.log" | head -20; done_ "RED build"; }
  npm run lint > "$L/lint.log" 2>&1 || { grep -E 'error|✖' "$L/lint.log" | head -20; done_ "RED lint"; }
  say "lint: clean"
  npx vitest run --exclude '.claude/**' --exclude 'archive/**' > "$L/vitest.log" 2>&1
  if ! grep -qE 'Test Files .*passed' "$L/vitest.log" || grep -qE 'Test Files .*failed' "$L/vitest.log"; then
    # Like the e2e step: rerun the failed files once alone (timeouts and CPU budgets on a loaded host).
    local failed
    # vitest colours its FAIL lines (D44): strip the escapes before matching.
    failed=$(sed 's/\x1b\[[0-9;]*m//g' "$L/vitest.log" | grep -oE '^ *FAIL +[^ ]+\.(test|spec)\.[cm]?[jt]s' | awk '{print $2}' | sort -u | tr '\n' ' ')
    if [ -n "$failed" ]; then
      say "vitest: rerunning failed files alone: $failed"
      # shellcheck disable=SC2086
      npx vitest run $failed > "$L/vitest-rerun.log" 2>&1
      if grep -qE 'Test Files .*passed' "$L/vitest-rerun.log" && ! grep -qE 'Test Files .*failed' "$L/vitest-rerun.log"; then
        say "vitest-rerun: $(grep -E 'Test Files' "$L/vitest-rerun.log" | tail -1 | sed 's/^ *//') (failed once, passed alone)"
      else
        grep -E 'FAIL|✗|×' "$L/vitest-rerun.log" | head -20; done_ "RED vitest"
      fi
    else
      grep -E 'FAIL|✗|×' "$L/vitest.log" | head -20; done_ "RED vitest"
    fi
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
    PROJECTS=(--project=default)
    if [ "${1:-}" = "--both-renderers" ]; then export TL_E2E_ALL_VARIANTS=1; PROJECTS=(); fi
    say "renderer: $(node -e "import('./tests/e2e/browser-env.mjs').then((m) => console.log(m.gpuAvailable() ? 'GPU' : 'SwiftShader (no usable GPU)'))") ${PROJECTS[*]:-both projects, all variants}"
    if e2e e2e.log "${PROJECTS[@]}"; then done_ GREEN; fi
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
  *) echo "usage: tools/gate.sh fast [e2e files…] | full [--both-renderers] | rerun"; exit 2 ;;
esac
