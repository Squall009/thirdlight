#!/usr/bin/env bash
# Thirdlight green gate. Three modes:
#
#   tools/gate.sh fast [e2e files or dirs…]   per commit: build + lint + vitest + the smoke set + the
#                                             e2e files named (the ones for the area you changed) + on a
#                                             GPU host the village perf class against its frame baseline
#   tools/gate.sh full [--both-renderers]     per phase item / before STATUS says done: build +
#                                             lint + vitest + every e2e spec, the leak test included
#                                             (TL_MEMORY=1). On a GPU one pass in the
#                                             product's own renderer; --both-renderers (for shader /
#                                             rendering changes) adds the forced WebGL 2 variants and
#                                             the webgpu project
#   tools/gate.sh rerun                       the fix loop: only the tests that failed last time
#                                             (Playwright --last-failed), nothing else
#   tools/gate.sh start <mode> [args…]        the same, detached as the systemd unit thirdlight-gate
#                                             under a memory cap (TL_GATE_MEM, default 7G): a caller
#                                             that ends (an agent session) no longer kills the gate
#                                             halfway. Prints its log folder.
#   tools/gate.sh wait                        blocks until the detached gate ends; prints its summary
#
# One gate at a time (a lock in the log folder): two gates on this host starve each other into
# timeouts. The summary ends with the run's memory peak.
#
# Every run writes its logs to its own folder (TL_GATE_LOGS, default
# ~/.cache/thirdlight-logs/gate-<mode>-<time>/) and prints the last line GREEN or RED.
# A failed full run reruns its failed tests once alone (load flakes on the
# CPU-rendered host) before it says RED. TL_E2E_WORKERS sets Playwright's
# worker count (default here: 2 — three workers peaked at 8.2 GB beside the
# service and turned load into timeouts; the config's own default is 1).
set -u
mode=${1:-}
shift || true
cd "$(dirname "$0")/.."
# The fast gate's smoke set: open and start, the authoring loop, Play and the export, scenes, the Inspector and
# menus, rendering, MCP, a script in Play, and one project at scale (count-caps). Kept to ~2 min on 2 workers.
SMOKE=(tests/e2e/start.e2e.ts tests/e2e/authoring-loop.e2e.ts tests/e2e/play-export.e2e.ts tests/e2e/scenes.e2e.ts tests/e2e/inspector.e2e.ts tests/e2e/menus.e2e.ts tests/e2e/rendering.e2e.ts tests/e2e/mcp.e2e.ts tests/e2e/script-api.e2e.ts tests/e2e/count-caps.e2e.ts)
# The phase-end full gate's budget (both renderers, on the GPU host, 2 workers): a run over it says so in its
# summary; a phase that adds e2e time extends or replaces tests to stay inside it (AGENTS.md).
FULL_BUDGET_MIN=15
export TL_E2E_WORKERS=${TL_E2E_WORKERS:-2}
LOGS=$HOME/.cache/thirdlight-logs
UNIT=thirdlight-gate
mkdir -p "$LOGS"

case "$mode" in
  start)
    sub=${1:-}; [ -n "$sub" ] || { echo "usage: tools/gate.sh start fast|full|rerun [args…]"; exit 2; }
    shift
    if systemctl is-active --quiet "$UNIT"; then echo "a gate is already running ($UNIT); tools/gate.sh wait"; exit 1; fi
    # A gate started short of memory gets its browsers killed by the cap halfway; wait for room.
    need=${TL_GATE_MEM:-7G}; need_gb=${need%G}
    for _ in $(seq 1 15); do
      avail=$(awk '/MemAvailable/ {print int($2 / 1048576)}' /proc/meminfo)
      [ "$avail" -ge "$need_gb" ] && break
      echo "only ${avail} GB available (need ${need_gb}); waiting"; sleep 60
    done
    [ "$avail" -ge "$need_gb" ] || { echo "not started: only ${avail} GB available"; exit 1; }
    L=$LOGS/gate-$sub-$(date +%Y%m%d-%H%M%S)
    mkdir -p "$L"
    echo "$L" > "$LOGS/last-detached"
    sudo -n systemctl reset-failed "$UNIT" 2> /dev/null || true
    sudo -n systemd-run --unit="$UNIT" --quiet --collect -p MemoryMax="$need" -p MemorySwapMax=0 \
      --working-directory="$PWD" -- sudo -n -u "$(id -un)" -- env HOME="$HOME" PATH="$PATH" \
      NODE_OPTIONS=--max-old-space-size=4096 TL_GATE_LOGS="$L" TL_E2E_WORKERS="$TL_E2E_WORKERS" \
      tools/gate.sh "$sub" "$@" || exit 1
    echo "started $UNIT ($sub), logs $L"
    exit 0 ;;
  wait)
    L=$(cat "$LOGS/last-detached" 2> /dev/null)
    while systemctl is-active --quiet "$UNIT"; do sleep 30; done
    [ -n "$L" ] && cat "$L/summary.txt"
    tail -1 "$L/summary.txt" 2> /dev/null | grep -q '^GREEN' ;
    exit $? ;;
esac

exec 9> "$LOGS/gate.lock"
flock -n 9 || { echo "another gate is running (lock $LOGS/gate.lock)"; exit 1; }
L=${TL_GATE_LOGS:-$HOME/.cache/thirdlight-logs/gate-$mode-$(date +%Y%m%d-%H%M%S)}
mkdir -p "$L"
t0=$(date +%s)
say() { echo "$*" | tee -a "$L/summary.txt"; }
peak() { # the memory peak of this run's cgroup (the detached unit's, or the caller's scope)
  local f=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)/memory.peak
  [ -r "$f" ] && awk '{printf "memory peak %.1f GB", $1 / 1073741824}' "$f"
}
done_() {
  local min=$(( ($(date +%s) - t0) / 60 )) over=''
  [ "$mode" = full ] && [ "$min" -gt "$FULL_BUDGET_MIN" ] && over=", OVER BUDGET (${FULL_BUDGET_MIN} min)"
  say "$1 (${min} min${over}, $(peak), logs $L)"; case "$1" in GREEN*) exit 0 ;; *) exit 1 ;; esac
}

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

# The village perf class's export frame time against its recorded baseline (tests/perf/village-baseline.json),
# both renderers, alone after the e2e step (a loaded host measures nothing). Only on a GPU host: SwiftShader
# frame times say nothing about the product. Re-record: docs/deployment.md "Performance".
perf_check() {
  if ! node -e "import('./tests/e2e/browser-env.mjs').then((m) => process.exit(m.gpuAvailable() ? 0 : 1))"; then
    say "perf: skipped (no usable GPU)"; return 0
  fi
  local t=$(date +%s) rc
  node tools/perf/run.mjs village --gate --check tests/perf/village-baseline.json > "$L/perf.log" 2>&1
  rc=$?
  say "perf: $(grep -E '^village: (REGRESSION|webgpu|webgl2|the baseline)' "$L/perf.log" | sed 's/^village: //' | tr '\n' ';') ($(( $(date +%s) - t )) s)"
  return $rc
}

case "$mode" in
  fast)
    build_and_unit
    e2e e2e.log --project=default "${SMOKE[@]}" "$@" || done_ "RED e2e (fix, then: tools/gate.sh rerun)"
    rm -f "$LOGS/perf-failed"
    perf_check || { touch "$LOGS/perf-failed"; done_ "RED perf (the village class's frame time; fix, then: tools/gate.sh rerun)"; }
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
    TL_E2E_WORKERS=1 e2e e2e-rerun.log --last-failed --trace=retain-on-failure && done_ "GREEN (failed once, passed alone: see e2e.log)"
    done_ "RED e2e (fix, then: tools/gate.sh rerun)" ;;
  rerun)
    npm run build > "$L/build.log" 2>&1
    grep -q '^build: done' "$L/build.log" || done_ "RED build"
    # A fast gate that failed on its perf check reruns that check alone.
    if [ -e "$LOGS/perf-failed" ]; then
      perf_check || done_ "RED perf"
      rm -f "$LOGS/perf-failed"; done_ GREEN
    fi
    export TL_MEMORY=1
    e2e e2e.log --last-failed --trace=retain-on-failure && done_ GREEN
    done_ "RED e2e" ;;
  *) echo "usage: tools/gate.sh fast [e2e files…] | full [--both-renderers] | rerun | start <mode> [args…] | wait"; exit 2 ;;
esac
