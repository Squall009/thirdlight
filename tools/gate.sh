#!/usr/bin/env bash
# Thirdlight green gate. It runs what a change affects:
#
#   tools/gate.sh fast [--all] [e2e files…]   per commit: build + lint + the unit tests related to what
#                                             changed since this branch's last green gate (--all: every
#                                             one) + the core smoke + the e2e areas the changed files reach
#                                             (tools/gate-areas.json) + the changed and named e2e files +, when
#                                             rendering or frame code changed, on a GPU host the village perf
#                                             class at the 60 Hz cap against its baseline
#   tools/gate.sh area <name>…                at the end of an item that changed an area broadly: build +
#                                             every e2e file of those areas, the leak test on (TL_MEMORY=1)
#   tools/gate.sh phase <start-commit>        once at the end of a phase: build + lint + every unit test +
#                                             the core smoke and every area the changes since that commit
#                                             reach, the leak test on + the perf check
#   tools/gate.sh full                        only for the merge to main or on the owner's word: build +
#                                             lint + vitest + every e2e spec, the leak test included
#                                             (TL_MEMORY=1), once on the product's renderer (WebGPU on a
#                                             GPU; WebGL 2's coverage is webgl2-smoke.e2e.ts)
#   tools/gate.sh rerun                       the fix loop: the build, then the step the last RED gate
#                                             stopped at (lint, the vitest files that failed, the e2e
#                                             tests that failed, the perf check) and the steps after it
#   tools/gate.sh start <mode> [args…]        the same, detached as the systemd unit thirdlight-gate
#                                             under a memory cap (TL_GATE_MEM, default 12G) and a CPU
#                                             cap (TL_GATE_CPU, default 1100%: 11 of the 16 threads): a
#                                             caller that ends (an agent session) no longer kills the
#                                             gate halfway. Prints its log folder.
#   tools/gate.sh wait                        blocks until the detached gate ends; prints its summary.
#                                             A unit the cap's OOM killer (or a signal) ended is RED,
#                                             whatever its summary got to say
#
# One gate at a time (a lock in the log folder): two gates on this host starve each other into
# timeouts. The summary ends with the run's memory peak.
#
# Every run writes its logs to its own folder (TL_GATE_LOGS, default
# ~/.cache/thirdlight-logs/gate-<mode>-<time>/) and prints the last line GREEN or RED.
# A failed full, phase or area run reruns its failed tests once alone (load flakes) before it says RED. Every
# e2e run's summary gives its test time by area. TL_E2E_WORKERS sets Playwright's worker count (the config's own
# default is 1). Here: 2 for fast and rerun, FULL_WORKERS for full, phase and area on a GPU.
# TL_VITEST_WORKERS caps vitest's workers (default: vitest's own, a CPU each): the unit run alone peaks
# above a 5G cap with them all, so a gate started under 5G sets about 4.
# On the GPU host the 29 heaviest e2e files took 600 s on 2 workers and 471–478 s on 3, at
# 4.7 and 5.6 GB of anonymous memory (6.5 GB with the page cache the cap reclaims), each test
# about 5 % slower than on 2: the cap held 3, not 4 (+0.9 GB a worker). With the voxel world's files a wide run
# on 3 workers was OOM-killed at the old 7G cap 3 min into its e2e step (the leak test on); with the host's
# memory raised to 32 GiB the cap is 12G: 3 again.
set -u
mode=${1:-}
shift || true
cd "$(dirname "$0")/.."
# The full gate has no fixed time budget (AGENTS.md): its summary gives its time beside the previous green full
# gate's (the previous phase's end), so a phase's growth is seen and questioned in its review.
FULL_WORKERS=3
# A worker count the caller set wins in every mode.
workers_set=${TL_E2E_WORKERS:+1}
export TL_E2E_WORKERS=${TL_E2E_WORKERS:-2}
LOGS=$HOME/.cache/thirdlight-logs
UNIT=thirdlight-gate
mkdir -p "$LOGS"

case "$mode" in
  start)
    sub=${1:-}; [ -n "$sub" ] || { echo "usage: tools/gate.sh start fast|area|phase|full|rerun [args…]"; exit 2; }
    shift
    if systemctl is-active --quiet "$UNIT"; then echo "a gate is already running ($UNIT); tools/gate.sh wait"; exit 1; fi
    # A gate started short of memory gets its browsers killed by the cap halfway; wait for room.
    need=${TL_GATE_MEM:-12G}; need_gb=${need%G}
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
    # No --collect: a unit that failed stays loaded, so `wait` can read how it ended (reset above on the next start).
    # The host's 16 threads also run production, staging, the agent UI and the Proxmox host: the CPU cap leaves them
    # five, so a gate slows down rather than hanging the host. The container's load average (lxcfs) still counts a
    # throttled thread as runnable: the cap bounds the CPU a gate takes, not the load it shows; worker counts do that.
    cpu=${TL_GATE_CPU:-1100%}
    sudo -n systemd-run --unit="$UNIT" --quiet -p MemoryMax="$need" -p MemorySwapMax=0 -p CPUQuota="$cpu" \
      --working-directory="$PWD" -- sudo -n -u "$(id -un)" -- env HOME="$HOME" PATH="$PATH" \
      NODE_OPTIONS=--max-old-space-size=4096 TL_GATE_LOGS="$L" ${workers_set:+TL_E2E_WORKERS="$TL_E2E_WORKERS"} ${TL_VITEST_WORKERS:+TL_VITEST_WORKERS="$TL_VITEST_WORKERS"} \
      tools/gate.sh "$sub" "$@" || exit 1
    echo "started $UNIT ($sub; caps: memory $need, CPU $cpu), logs $L"
    exit 0 ;;
  wait)
    L=$(cat "$LOGS/last-detached" 2> /dev/null)
    while systemctl is-active --quiet "$UNIT"; do sleep 30; done
    # How the unit ended: oom-kill (the cap), signal, core-dump or timeout means the run was cut off, even when the
    # summary has a line (an OOM kill can take a browser and leave the script to write GREEN after its rerun).
    res=$(systemctl show -p Result --value "$UNIT" 2> /dev/null)
    case "$res" in
      oom-kill | signal | core-dump | timeout | watchdog) cut="RED killed (unit result: $res; see journalctl -u $UNIT)" ;;
      *) cut='' ;;
    esac
    if [ -z "$cut" ] && ! tail -1 "$L/summary.txt" 2> /dev/null | grep -qE '^(GREEN|RED)'; then cut="RED ended without a summary (unit result: ${res:-unknown})"; fi
    [ -n "$cut" ] && [ -n "$L" ] && echo "$cut" >> "$L/summary.txt"
    [ -n "$L" ] && cat "$L/summary.txt"
    tail -1 "$L/summary.txt" 2> /dev/null | grep -q '^GREEN' ;
    exit $? ;;
esac

# A gate run straight from a shell has no memory cap: one such rerun peaked at 12.7 GB on this 16 GiB host,
# which has OOM-killed every session on it before. Only run inside a capped cgroup (the detached unit, or a
# capped systemd-run scope).
cg=$(sed -n 's/^0:://p' /proc/self/cgroup 2> /dev/null)
cap=$(cat "/sys/fs/cgroup$cg/memory.max" 2> /dev/null || echo max)
if [ "$cap" = max ]; then
  echo "refused: no memory cap on this shell; use tools/gate.sh start $mode … then tools/gate.sh wait"
  exit 2
fi

exec 9> "$LOGS/gate.lock"
flock -n 9 || { echo "another gate is running (lock $LOGS/gate.lock)"; exit 1; }
# /tmp is RAM on this host (tmpfs) and doesn't show as used memory, so a gate's test projects, exports and caches
# there pushed the host into the OOM killer. Every temp file of the run goes to disk instead and is removed at the end.
GATE_TMP=$HOME/.cache/thirdlight-tmp/gate-$$
# The EXIT trap does not run when the unit is OOM-killed or sent SIGKILL: an earlier run's folder can be left. Under the
# lock no other gate runs, so one untouched for an hour is left over.
find "$HOME/.cache/thirdlight-tmp" -mindepth 1 -maxdepth 1 -type d -name 'gate-*' ! -name "gate-$$" -mmin +60 -exec rm -rf {} + 2> /dev/null
rm -rf "$GATE_TMP" && mkdir -p "$GATE_TMP" && chmod 700 "$GATE_TMP"
export TMPDIR=$GATE_TMP TMP=$GATE_TMP TEMP=$GATE_TMP
L=${TL_GATE_LOGS:-$HOME/.cache/thirdlight-logs/gate-$mode-$(date +%Y%m%d-%H%M%S)}
mkdir -p "$L"
t0=$(date +%s)
# The host's 1-minute load every 30 s (load.log, its mean and peak in the last line): the gate shares the host's
# threads with production, staging and the agents, so how hard it pushed them is part of its result.
# Without the lock (fd 9): its sleep outlives the gate by up to 30 s and would hold the lock that long.
( exec 9>&-; while :; do echo "$(date +%T) $(cut -d' ' -f1 /proc/loadavg)" >> "$L/load.log"; sleep 30; done ) &
SAMPLER=$!
trap 'kill "$SAMPLER" 2> /dev/null; rm -rf "$GATE_TMP"' EXIT
say() { echo "$*" | tee -a "$L/summary.txt"; }
load() { # the 1-minute load's mean and peak over the samples so far
  awk '{ v = $2 + 0; s += v; n++; if (v > m) m = v } END { if (n) printf ", load mean %.1f peak %.1f", s / n, m }' "$L/load.log" 2> /dev/null
}
secs() { echo "$(( $(date +%s) - $1 )) s"; } # secs <start>: the time since then
peak() { # the memory peak of this run's cgroup (the detached unit's, or the caller's scope)
  local f=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)/memory.peak
  [ -r "$f" ] && awk '{printf "memory peak %.1f GB", $1 / 1073741824}' "$f"
}
prev_full() { # the last green full gate before this one, from its summary: "<n> min on <its folder's time>"
  local d m
  for d in $(ls -d "$LOGS"/gate-full-* 2> /dev/null | sort -r); do
    [ "$d" = "$L" ] && continue
    m=$(grep -E '^GREEN' "$d/summary.txt" 2> /dev/null | tail -1 | grep -oE '\([0-9]+ min' | head -1 | tr -dc '0-9')
    [ -n "$m" ] && { echo "$m min on ${d##*/gate-full-}"; return; }
  done
}
# The last green tree of this branch: the base the next gate's changed set is taken from. Only a clean tree is
# recorded: a gate that ran on uncommitted work proves a tree no commit names.
LAST_GREEN=$LOGS/last-green-$(git rev-parse --abbrev-ref HEAD | tr '/' '-')
mark_green() {
  if [ -n "$(git status --porcelain)" ]; then say "last green: not recorded (uncommitted changes in the tree)"; return; fi
  git rev-parse HEAD > "$LAST_GREEN"
}
done_() {
  local min=$(( ($(date +%s) - t0) / 60 )) prev=''
  [ "$mode" = full ] && prev=$(prev_full) && prev=", previous green full gate ${prev:-not recorded}"
  case "$1" in GREEN*) mark_green ;; esac
  say "$1 (${min} min${prev}, $(peak)$(load), logs $L)"; case "$1" in GREEN*) rm -rf "$STATE"; exit 0 ;; *) exit 1 ;; esac
}

# What changed: from a base commit to the working tree (uncommitted work counts), untracked files included.
# CHANGED is the list, BASE the commit (empty: no base, so everything counts as changed).
CHANGED=(); BASE=''
changed_since() { # changed_since <commit or empty>
  BASE=${1:-}; CHANGED=()
  [ -n "$BASE" ] || return 0
  mapfile -t CHANGED < <({ git diff --name-only "$BASE" --; git ls-files -o --exclude-standard; } | sort -u)
}
last_green_base() { # this branch's last green commit when it is an ancestor of HEAD, else nothing
  local c; c=$(cat "$LAST_GREEN" 2> /dev/null)
  [ -n "$c" ] && git merge-base --is-ancestor "$c" HEAD 2> /dev/null && echo "$c"
}
# Tests that read files from disk rather than importing them: the manual, the skill, the specs, the docs check.
DOC_TESTS=(packages/backend/src/docs.test.ts packages/mcp-adapter/src/onboarding.test.ts tools/manual-links.test.mjs tools/skill.test.mjs tools/check-docs.test.mjs tools/ratchet-base.test.mjs tools/voxel-bench/role-spec-doc.test.ts)
# UNIT_SCOPE: empty = the whole suite (UNIT_WHY says why), else the files `vitest related` starts from.
UNIT_SCOPE=(); UNIT_WHY=''
unit_scope() { # unit_scope [--all]
  UNIT_SCOPE=(); UNIT_WHY=''
  [ "${1:-}" = --all ] && { UNIT_WHY='--all'; return; }
  [ -n "$BASE" ] || { UNIT_WHY='no green gate on this branch to compare with'; return; }
  local f docs=''
  for f in "${CHANGED[@]}"; do
    case "$f" in
      # The suite's own setup, dependencies and compiler settings change what every test runs on.
      package.json | */package.json | package-lock.json | tsconfig*.json | */tsconfig*.json | vitest.config.mts | eslint.config.mjs | \
        tools/gate.sh | tools/check-*.mjs | tests/test-hygiene.ts | fixtures/* | templates/* | packs/*)
        UNIT_WHY="$f changed"; return ;;
      docs/* | skills/*) docs=1 ;;
      *.ts | *.tsx | *.mts | *.cts | *.js | *.mjs | *.cjs | *.json)
        # A deleted module: its importers are found only by the whole suite (the build fails them first).
        [ -e "$f" ] || { UNIT_WHY="$f deleted"; return; }
        UNIT_SCOPE+=("$f") ;;
      # Shaders, styles, pages and data next to the code are read by tests the import graph does not name.
      packages/* | tools/*) case "$f" in *.md) ;; *) UNIT_WHY="$f changed (not a module)"; return ;; esac ;;
    esac
  done
  [ -n "$docs" ] && for f in "${DOC_TESTS[@]}"; do [ -e "$f" ] && UNIT_SCOPE+=("$f"); done
  return 0
}

# What `rerun` picks up (STATE): the gate that went RED (`mode`, its arguments in `args`), the step it stopped at
# (`step`: lint, vitest, e2e or perf; a failed build reruns from lint) and the vitest files that failed (`vitest`;
# empty: the whole suite). A GREEN gate clears it. The steps after the failed one never ran, so a rerun runs them too.
STATE=$LOGS/rerun-state
fail_at() { # fail_at <step> [vitest files]
  mkdir -p "$STATE" && echo "$1" > "$STATE/step" && echo "${2:-}" > "$STATE/vitest"
}
begin_state() { # begin_state <mode> [args…]: a new fast or full gate replaces the last one's state
  rm -rf "$STATE" && mkdir -p "$STATE" && echo "$1" > "$STATE/mode" && shift
  # No arguments must leave the file empty: printf with none still writes one empty string, which a rerun would
  # hand Playwright as a filter that matches every e2e file.
  : > "$STATE/args"
  if [ $# -gt 0 ]; then printf '%s\0' "$@" > "$STATE/args"; fi
}

build() {
  local t=$(date +%s)
  npm run build > "$L/build.log" 2>&1
  grep -q '^build: done' "$L/build.log" || { grep -E 'FAIL|error' "$L/build.log" | head -20; [ -s "$STATE/step" ] || fail_at lint; done_ "RED build"; }
  say "build: done ($(secs "$t"))"
}

lint() {
  local t=$(date +%s)
  npm run lint > "$L/lint.log" 2>&1 || { grep -E 'error|✖' "$L/lint.log" | head -20; fail_at lint; done_ "RED lint (fix, then: tools/gate.sh rerun)"; }
  say "lint: clean ($(secs "$t"))"
}

unit() { # unit [--related] [files…]: the whole suite, or (a rerun) only the test files named, or (--related) the
  # test files that import the files named
  local cmd=(run) t=$(date +%s)
  [ "${1:-}" = --related ] && { cmd=(related --run --passWithNoTests); shift; }
  npx vitest "${cmd[@]}" --exclude '.claude/**' --exclude 'archive/**' ${TL_VITEST_WORKERS:+--maxWorkers="$TL_VITEST_WORKERS"} "$@" > "$L/vitest.log" 2>&1
  # Nothing related (a docs-only change): vitest found no test file, which passes.
  if [ "${cmd[0]}" = related ] && sed 's/\x1b\[[0-9;]*m//g' "$L/vitest.log" | grep -qE 'No test files found'; then say "vitest: no test file related"; return 0; fi
  if ! grep -qE 'Test Files .*passed' "$L/vitest.log" || grep -qE 'Test Files .*failed' "$L/vitest.log"; then
    # Like the e2e step: rerun the failed files once alone (timeouts and CPU budgets on a loaded host).
    local failed
    # vitest colours its FAIL lines: strip the escapes before matching.
    failed=$(sed 's/\x1b\[[0-9;]*m//g' "$L/vitest.log" | grep -oE '^ *FAIL +[^ ]+\.(test|spec)\.[cm]?[jt]s' | awk '{print $2}' | sort -u | tr '\n' ' ')
    if [ -n "$failed" ]; then
      say "vitest: rerunning failed files alone: $failed"
      # shellcheck disable=SC2086
      npx vitest run $failed > "$L/vitest-rerun.log" 2>&1
      if grep -qE 'Test Files .*passed' "$L/vitest-rerun.log" && ! grep -qE 'Test Files .*failed' "$L/vitest-rerun.log"; then
        say "vitest-rerun: $(sed 's/\x1b\[[0-9;]*m//g' "$L/vitest-rerun.log" | grep -E 'Test Files' | tail -1 | sed 's/^ *//') (failed once, passed alone)"
      else
        grep -E 'FAIL|✗|×' "$L/vitest-rerun.log" | head -20; fail_at vitest "$failed"; done_ "RED vitest (fix, then: tools/gate.sh rerun)"
      fi
    else
      grep -E 'FAIL|✗|×' "$L/vitest.log" | head -20; fail_at vitest; done_ "RED vitest (fix, then: tools/gate.sh rerun)"
    fi
  fi
  say "$(sed 's/\x1b\[[0-9;]*m//g' "$L/vitest.log" | grep -E 'Test Files' | tail -1 | sed 's/^ *//') ($(secs "$t"))"
}
unit_changed() { # unit_changed [--all]: the unit tests the changed files reach, or the whole suite
  unit_scope "$@"
  if [ -n "$UNIT_WHY" ]; then say "vitest: whole suite ($UNIT_WHY)"; unit; return; fi
  say "vitest: related to ${#UNIT_SCOPE[@]} changed files since ${BASE:0:8} (${#CHANGED[@]} changed in all)"
  if [ ${#UNIT_SCOPE[@]} -eq 0 ]; then say "vitest: no test file related"; return; fi
  unit --related "${UNIT_SCOPE[@]}"
}

e2e() { # e2e <log> [playwright args…]
  local log=$1; shift
  npx playwright test "$@" > "$L/$log" 2>&1
  say "$log: $(grep -E '^\s+[0-9]+ (passed|failed|flaky)' "$L/$log" | tr -s ' ' | tr '\n' ' ')"
  grep -qE '^\s+[0-9]+ passed' "$L/$log" && ! grep -qE '^\s+[0-9]+ failed' "$L/$log"
}

# The village perf class's export at the display's 60 Hz cap against its recorded baseline
# (tests/perf/village-baseline.json): refreshes missed and the main thread's CPU time per frame on WebGPU (the
# product's renderer), alone after the e2e step. Never uncapped: uncapped frame times read the host's load. Only on
# a GPU host: SwiftShader frame times say nothing about the product. Only when a package that draws or runs the
# frame changed (or there is no base to compare with). Re-record: docs/manual/features/performance.md.
PERF_PATHS='^(packages/(three-adapter|runtime|game-host|voxel|effects)|tools/perf|tests/perf)/'
perf_needed() {
  [ -z "$BASE" ] && return 0
  printf '%s\n' "${CHANGED[@]}" | grep -qE "$PERF_PATHS"
}
perf_check() {
  if ! perf_needed; then say "perf: not run (nothing that draws or runs the frame changed since ${BASE:0:8})"; return 0; fi
  if ! node -e "import('./tests/e2e/browser-env.mjs').then((m) => process.exit(m.gpuAvailable() ? 0 : 1))"; then
    # Not a pass: the gate's last line says the village class went unmeasured.
    PERF_SKIPPED=" — perf SKIPPED: no usable GPU, the village class was NOT measured"
    say "perf: SKIPPED (no usable GPU): the village class was NOT measured"; return 0
  fi
  local t=$(date +%s) rc
  node tools/perf/run.mjs village --gate --renderers webgpu --check tests/perf/village-baseline.json > "$L/perf.log" 2>&1
  rc=$?
  say "perf: $(grep -E '^village: (REGRESSION|webgpu|webgl2|the baseline)' "$L/perf.log" | sed 's/^village: //' | tr '\n' ';') ($(( $(date +%s) - t )) s)"
  return $rc
}

# The e2e areas (tools/gate-areas.json, checked by tools/check-gate-areas.mjs in the build): which e2e files a
# changed file reaches. `core` (the smoke) runs in every fast gate.
areas_changed() { # the areas the changed files reach, one a line
  [ ${#CHANGED[@]} -gt 0 ] && node tools/check-gate-areas.mjs --for "${CHANGED[@]}"
  return 0
}
changed_e2e() { # the changed e2e files themselves
  local f
  for f in "${CHANGED[@]}"; do case "$f" in tests/e2e/*.e2e.ts) [ -e "$f" ] && echo "$f" ;; esac; done
  return 0
}
area_times() { # area_times <log>: test time by area (a file in two areas counts in both), so growth is seen per area
  say "e2e time by area: $(node tools/check-gate-areas.mjs --times "$L/$1")"
}
fast_e2e() { # fast_e2e [e2e files…]: the core smoke, the areas the changes reach, the changed e2e files, the files named
  local areas=() files=()
  if [ -n "$BASE" ]; then mapfile -t areas < <(areas_changed); else say "e2e areas: none from the changes (no green gate on this branch to compare with)"; fi
  mapfile -t files < <({ node tools/check-gate-areas.mjs --e2e core "${areas[@]}"; changed_e2e; printf '%s\n' "$@"; } | sed '/^$/d' | sort -u)
  say "e2e: core${areas[*]:+ + ${areas[*]}}${1:+ + named: $*} (${#files[@]} files)"
  e2e e2e.log --project=default "${files[@]}" || { area_times e2e.log; fail_at e2e; done_ "RED e2e (fix, then: tools/gate.sh rerun)"; }
  area_times e2e.log
}
fast_perf() {
  perf_check || { fail_at perf; done_ "RED perf (the village class at the cap; fix, then: tools/gate.sh rerun)"; }
}
# The wide e2e runs (full, phase, area): more workers on a GPU, the leak test on, and the failed tests rerun once
# alone before it says RED. WIDE_NOTE says when a rerun turned it green.
WIDE_NOTE=''
wide_e2e() { # wide_e2e [e2e files…] (none: every spec)
  # Measured on the GPU: a CPU-rendered host keeps 2 (SwiftShader slows every test past ~cores/3).
  if [ -z "$workers_set" ] && node -e "import('./tests/e2e/browser-env.mjs').then((m) => process.exit(m.gpuAvailable() ? 0 : 1))"; then
    export TL_E2E_WORKERS=$FULL_WORKERS
  fi
  export TL_MEMORY=1
  say "renderer: $(node -e "import('./tests/e2e/browser-env.mjs').then((m) => console.log(m.gpuAvailable() ? 'GPU' : 'SwiftShader (no usable GPU)'))") --project=default, ${TL_E2E_WORKERS} workers"
  e2e e2e.log --project=default "$@" && return 0
  fail_at e2e
  area_times e2e.log
  grep -qE '^\s+[0-9]+ failed' "$L/e2e.log" || done_ "RED e2e (no summary)"
  say "rerunning the failed tests alone"
  TL_E2E_WORKERS=1 e2e e2e-rerun.log --last-failed --trace=retain-on-failure || done_ "RED e2e (fix, then: tools/gate.sh rerun)"
  WIDE_NOTE=" (failed once, passed alone: see e2e.log)"
}
full_e2e() {
  wide_e2e
  area_times e2e.log
  done_ "GREEN$WIDE_NOTE"
}
area_e2e() { # area_e2e <areas…>: every e2e file of those areas
  local files=()
  mapfile -t files < <(node tools/check-gate-areas.mjs --e2e "$@") || done_ "RED (unknown area: $*)"
  [ ${#files[@]} -gt 0 ] || done_ "RED (unknown area: $*)"
  say "e2e: areas $* (${#files[@]} files)"
  wide_e2e "${files[@]}"
  area_times e2e.log
}
phase_e2e() { # the core smoke and every area the phase's changes reach (CHANGED: since its start)
  local areas=() files=()
  mapfile -t areas < <(areas_changed)
  mapfile -t files < <({ node tools/check-gate-areas.mjs --e2e core "${areas[@]}"; changed_e2e; } | sed '/^$/d' | sort -u)
  say "e2e: core${areas[*]:+ + ${areas[*]}} (${#files[@]} files; ${#CHANGED[@]} files changed since ${BASE:0:8})"
  wide_e2e "${files[@]}"
  area_times e2e.log
}
phase_start() { # phase_start <commit>: the phase's first commit, an ancestor of HEAD
  git rev-parse --verify -q "${1:-}^{commit}" > /dev/null && git merge-base --is-ancestor "$1" HEAD || { echo "usage: tools/gate.sh phase <start-commit> (an ancestor of HEAD)"; exit 2; }
  git rev-parse "$1"
}

case "$mode" in
  fast)
    all=''; [ "${1:-}" = --all ] && { all=--all; shift; }
    begin_state fast "$@"
    changed_since "$(last_green_base)"
    build; lint; unit_changed $all
    fast_e2e "$@"
    fast_perf
    done_ "GREEN${PERF_SKIPPED:-}" ;;
  full)
    begin_state full
    build; lint; unit
    full_e2e ;;
  area)
    [ $# -gt 0 ] || { echo "usage: tools/gate.sh area <name>… (tools/gate-areas.json)"; exit 2; }
    begin_state area "$@"
    build
    area_e2e "$@"
    done_ "GREEN$WIDE_NOTE" ;;
  phase)
    start=$(phase_start "${1:-}") || { echo "$start"; exit 2; }
    begin_state phase "$start"
    changed_since "$start"
    build; lint; unit
    phase_e2e
    fast_perf
    done_ "GREEN$WIDE_NOTE${PERF_SKIPPED:-}" ;;
  rerun)
    # The failed step of the last RED gate, then the steps after it; without a recorded step (an older gate's run),
    # the e2e tests that failed last time.
    step=$(cat "$STATE/step" 2> /dev/null); was=$(cat "$STATE/mode" 2> /dev/null)
    args=(); [ -r "$STATE/args" ] && mapfile -d '' -t args < "$STATE/args"
    say "rerun of the ${was:-last} gate from ${step:-its failed e2e tests}${args[*]:+ (${args[*]})}"
    if [ "$was" = phase ]; then changed_since "${args[0]:-}"; else changed_since "$(last_green_base)"; fi
    build
    case "$step" in
      lint) if [ "$was" = fast ]; then lint; unit_changed; elif [ "$was" != area ]; then lint; unit; fi ;;
      vitest)
        # A failed file the fix deleted has nothing left to run (vitest refuses a missing file).
        files=(); for f in $(cat "$STATE/vitest"); do [ -e "$f" ] && files+=("$f"); done
        if [ -n "$(tr -d ' \n' < "$STATE/vitest")" ] && [ ${#files[@]} -eq 0 ]; then say "vitest: the files that failed are gone"; else unit "${files[@]}"; fi ;;
    esac
    case "$step" in
      lint | vitest)
        case "$was" in
          full) full_e2e ;;
          area) area_e2e "${args[@]}" ;;
          phase) phase_e2e ;;
          *) fast_e2e "${args[@]}" ;;
        esac ;;
      e2e | '')
        export TL_MEMORY=1
        e2e e2e.log --last-failed --trace=retain-on-failure || { [ -n "$step" ] && fail_at e2e; done_ "RED e2e"; } ;;
    esac
    case "$was" in fast | phase) fast_perf ;; esac
    done_ "GREEN$WIDE_NOTE${PERF_SKIPPED:-}" ;;
  *) echo "usage: tools/gate.sh fast [--all] [e2e files…] | area <name>… | phase <start-commit> | full | rerun | start <mode> [args…] | wait"; exit 2 ;;
esac
