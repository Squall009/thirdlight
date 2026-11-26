#!/usr/bin/env bash
# Thirdlight's green gate: two commands.
#
#   tools/gate.sh check            every commit an agent calls green: the build (incremental), lint (cached), the
#                                  fast unit set (every unit file but tests/slow-unit-files.json's) and the boot
#                                  check (tests/e2e/boot.e2e.ts, the only browser test). Under 5 min.
#   tools/gate.sh check --failed   the fix loop after a real fix: the build and lint again (seconds when warm),
#                                  then only what failed in the last check (its failed unit files, its failed boot
#                                  tests; everything after a failed build). Under 1 min. Not a "see if it passes
#                                  this time" rerun: a red is fixed, or the test goes.
#                                  A red step does not stop the run (only a red build does): one run shows every
#                                  failure.
#   tools/gate.sh phase            once, at a phase's close: the full build, full lint (no cache), every unit test
#                                  (the slow list too), the boot check, the performance report (frame rate, frame
#                                  time, GPU time, memory beside the previous phase run's; recorded, never gating),
#                                  then the picture set.
#   tools/gate.sh pictures         the picture set alone (docs/pictures.md): the fixed list's world pictures and
#                                  editor screens, settled, as a pack for an agent's read in
#                                  ~/.cache/thirdlight-pictures/<run>/ (TL_PICTURES_DIR in place of the first part).
#                                  RED when a picture could not be taken or did not settle; what a picture shows
#                                  never turns it red. About 15 minutes: start it detached.
#   tools/gate.sh start check|phase|pictures [--failed]
#                                  the same, detached as the systemd unit thirdlight-gate (a caller that ends no
#                                  longer kills it halfway); prints its log folder. For `phase` and `pictures`,
#                                  which pass 10 minutes.
#   tools/gate.sh wait             blocks until the detached run ends; prints its summary. A unit the cap's OOM
#                                  killer (or a signal) ended is RED, whatever its summary got to say.
#
# Every run is memory- and CPU-capped (TL_GATE_MEM, default 12G; TL_GATE_CPU, default 1100%: 11 of the host's 16
# threads, which it shares with production, staging and the agents): run straight from a shell, it starts itself in
# a capped scope and blocks. Unit tests run on TL_VITEST_WORKERS workers (default and most 6), the boot check on one.
# One run at a time (a lock in the log folder, shared with every checkout on this host). Each run writes its logs to
# its own folder ~/.cache/thirdlight-logs/gate-<mode>-<time>/; the last line is GREEN or RED with the run's time,
# memory peak and host load.
set -u
cd "$(dirname "$0")/.."
mode=${1:-}
shift || true
LOGS=$HOME/.cache/thirdlight-logs
UNIT=thirdlight-gate
MEM=${TL_GATE_MEM:-12G}
CPU=${TL_GATE_CPU:-1100%}
WORKERS=${TL_VITEST_WORKERS:-6}
[ "$WORKERS" -le 6 ] 2> /dev/null || WORKERS=6
# What `check --failed` reads: the step the last check stopped at and what failed in it. A green check clears it.
STATE=$LOGS/check-state
mkdir -p "$LOGS"

usage() { sed -n '2,/^set -u/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 2; }
enough_memory() {
  local need=${MEM%G} avail
  avail=$(awk '/MemAvailable/ {print int($2 / 1048576)}' /proc/meminfo)
  [ "$avail" -ge "$need" ] || { echo "not started: only ${avail} GB available (the cap is $MEM)"; exit 1; }
}
# The environment a capped run gets (the inner sudo -u keeps the GPU groups).
capped_env() { echo env HOME="$HOME" PATH="$PATH" NODE_OPTIONS=--max-old-space-size=4096 TL_GATE_CAPPED=1 TL_VITEST_WORKERS="$WORKERS" ${TL_PICTURES_DIR:+TL_PICTURES_DIR="$TL_PICTURES_DIR"} "$@"; }

case "$mode" in
  check | phase | pictures) ;;
  start)
    sub=${1:-}; case "$sub" in check | phase | pictures) ;; *) usage ;; esac
    shift
    if systemctl is-active --quiet "$UNIT"; then echo "a gate is already running ($UNIT); tools/gate.sh wait"; exit 1; fi
    enough_memory
    L=$LOGS/gate-$sub-$(date +%Y%m%d-%H%M%S)
    mkdir -p "$L"
    echo "$L" > "$LOGS/last-detached"
    sudo -n systemctl reset-failed "$UNIT" 2> /dev/null || true
    # No --collect: a unit that failed stays loaded, so `wait` can read how it ended (reset on the next start).
    # shellcheck disable=SC2046
    sudo -n systemd-run --unit="$UNIT" --quiet -p MemoryMax="$MEM" -p MemorySwapMax=0 -p CPUQuota="$CPU" \
      --working-directory="$PWD" -- sudo -n -u "$(id -un)" -- $(capped_env TL_GATE_LOGS="$L") tools/gate.sh "$sub" "$@" || exit 1
    echo "started $UNIT ($sub; caps: memory $MEM, CPU $CPU), logs $L"
    exit 0 ;;
  wait)
    L=$(cat "$LOGS/last-detached" 2> /dev/null)
    while systemctl is-active --quiet "$UNIT"; do sleep 15; done
    res=$(systemctl show -p Result --value "$UNIT" 2> /dev/null)
    case "$res" in
      oom-kill | signal | core-dump | timeout | watchdog) cut="RED killed (unit result: $res; see journalctl -u $UNIT)" ;;
      *) cut='' ;;
    esac
    if [ -z "$cut" ] && ! tail -1 "$L/summary.txt" 2> /dev/null | grep -qE '^(GREEN|RED)'; then cut="RED ended without a summary (unit result: ${res:-unknown})"; fi
    [ -n "$cut" ] && [ -n "$L" ] && echo "$cut" >> "$L/summary.txt"
    [ -n "$L" ] && cat "$L/summary.txt"
    tail -1 "$L/summary.txt" 2> /dev/null | grep -q '^GREEN'
    exit $? ;;
  *) usage ;;
esac

failed_only=''
[ "${1:-}" = --failed ] && { [ "$mode" = check ] || usage; failed_only=1; shift; }
[ $# -eq 0 ] || usage

# Straight from a shell: start again inside a capped scope, blocking (a run with no cap once peaked at 12.7 GB and
# took every session on the host with it).
if [ -z "${TL_GATE_CAPPED:-}" ]; then
  enough_memory
  # shellcheck disable=SC2046
  exec sudo -n systemd-run --scope --quiet -p MemoryMax="$MEM" -p MemorySwapMax=0 -p CPUQuota="$CPU" -- \
    sudo -n -u "$(id -un)" -- $(capped_env) tools/gate.sh "$mode" ${failed_only:+--failed}
fi

exec 9> "$LOGS/gate.lock"
flock -n 9 || { echo "another gate is running (lock $LOGS/gate.lock)"; exit 1; }
# /tmp is RAM on this host: every temp file of the run goes to disk instead, removed at the end. The EXIT trap does
# not run when the run is OOM-killed: under the lock, a folder untouched for an hour is an earlier run's.
GATE_TMP=$HOME/.cache/thirdlight-tmp/gate-$$
find "$HOME/.cache/thirdlight-tmp" -mindepth 1 -maxdepth 1 -type d -name 'gate-*' -mmin +60 -exec rm -rf {} + 2> /dev/null
mkdir -p "$GATE_TMP" && chmod 700 "$GATE_TMP"
export TMPDIR=$GATE_TMP TMP=$GATE_TMP TEMP=$GATE_TMP
L=${TL_GATE_LOGS:-$LOGS/gate-$mode-$(date +%Y%m%d-%H%M%S)}
mkdir -p "$L"
t0=$(date +%s)
# The host's 1-minute load every 15 s: the run shares the host, so how hard it pushed it is part of its result.
# Its stdio is not the run's: a sleep still holding the caller's pipe would keep the caller waiting after the end.
( exec 9>&-; while :; do cut -d' ' -f1 /proc/loadavg >> "$L/load.log"; sleep 15; done ) < /dev/null > /dev/null 2>&1 &
SAMPLER=$!
trap 'pkill -P "$SAMPLER" 2> /dev/null; kill "$SAMPLER" 2> /dev/null; rm -rf "$GATE_TMP"' EXIT

say() { echo "$*" | tee -a "$L/summary.txt"; }
secs() { echo "$(( $(date +%s) - $1 )) s"; }
finish() { # finish GREEN|RED… : the summary's last line, and the exit code
  local f peak='' load
  f=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup)/memory.peak
  [ -r "$f" ] && peak=$(awk '{printf ", memory peak %.1f GB", $1 / 1073741824}' "$f")
  load=$(awk '{ v = $1 + 0; s += v; n++; if (v > m) m = v } END { if (n) printf ", load mean %.1f peak %.1f", s / n, m }' "$L/load.log" 2> /dev/null)
  say "$1 ($(secs "$t0")$peak$load, logs $L)"
  case "$1" in GREEN*) exit 0 ;; *) exit 1 ;; esac
}
# A red step is recorded and the run goes on (all but the build: nothing after it can run on a broken build), so
# one run shows every failure and `check --failed` has only failures to run again. FAILED: what failed, in order.
FAILED=()
fail() { # fail <step> <message> [items]: the step's failure, and for `check --failed` what to run again (empty: all of it)
  FAILED+=("$1: $2")
  say "$1: RED: $2"
  if [ "$mode" = check ]; then mkdir -p "$STATE" && printf '%s\n' "${3:-}" > "$STATE/$1"; fi
}
strip() { sed 's/\x1b\[[0-9;]*m//g' "$1"; }

# check --failed: what the last check recorded as failed. Build and lint always run (warm, they take seconds and
# catch a fix that broke the build); the unit and boot steps run only where they failed, and only their failures.
WANT_UNIT=1 WANT_BOOT=1 UNIT_FILES=() BOOT_ARGS=()
if [ -n "$failed_only" ]; then
  [ -d "$STATE" ] && [ -n "$(ls "$STATE")" ] || { echo "nothing failed in the last check (or it went green): run tools/gate.sh check"; exit 2; }
  say "check --failed: the last check's failures: $(ls "$STATE" | tr '\n' ' ')"
  if [ -e "$STATE/build" ]; then :; # nothing after the build ran: everything runs again
  else
    if [ -e "$STATE/unit" ]; then
      # A failed file the fix deleted (or archived) has nothing left to run.
      for f in $(cat "$STATE/unit"); do [ -e "$f" ] && UNIT_FILES+=("$f"); done
      [ -n "$(tr -d ' \n' < "$STATE/unit")" ] && [ ${#UNIT_FILES[@]} -eq 0 ] && { say "unit: the files that failed are gone"; WANT_UNIT=''; }
    else WANT_UNIT=''; fi
    if [ -e "$STATE/boot" ]; then BOOT_ARGS=(--last-failed); else WANT_BOOT=''; fi
  fi
  rm -rf "$STATE"
fi

build() {
  local t=$(date +%s)
  npm run build > "$L/build.log" 2>&1
  if ! grep -q '^build: done' "$L/build.log"; then
    grep -E 'FAILED|error' "$L/build.log" | head -20
    fail build "the build failed (build.log)"
    [ "$mode" = check ] && : > "$STATE/unit" && : > "$STATE/boot"
    finish "RED (build)"
  fi
  say "build: done ($(secs "$t"))"
}

# The check lints from a cache (node_modules/.cache/eslint, keyed by each file's content and the config): a changed
# file is always linted again. What a cache cannot see: a type-aware rule's answer in an unchanged file whose import
# changed (a function that became async); the phase run lints everything without it.
lint() {
  local t=$(date +%s) args=()
  [ "$mode" = check ] && args=(-- --cache --cache-strategy content --cache-location node_modules/.cache/eslint/)
  if npm run lint "${args[@]}" > "$L/lint.log" 2>&1; then say "lint: clean${args[*]:+ (cached)} ($(secs "$t"))"
  else grep -E 'error|✖' "$L/lint.log" | head -20; fail lint "lint errors (lint.log; $(secs "$t"))"; fi
}

unit() { # unit <set> [files…]: a set of tests/slow-unit-files.json's split (fast, all), or only the files named
  local t=$(date +%s) set=$1 failed
  shift
  TL_UNIT_SET=$set npx vitest run --maxWorkers="$WORKERS" --reporter=default --reporter=json --outputFile.json="$L/vitest.json" "$@" > "$L/vitest.log" 2>&1
  local line="unit ($set${1:+, $# files}): $(strip "$L/vitest.log" | grep -E 'Test Files' | tail -1 | sed 's/^ *//') ($(secs "$t"))"
  if ! strip "$L/vitest.log" | grep -qE 'Test Files .*passed' || strip "$L/vitest.log" | grep -qE 'Test Files .*failed'; then
    # No JSON (vitest itself failed): nothing names a file, so `--failed` runs the whole set again.
    failed=$(node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(r.testResults.filter(f=>f.status==='failed').map(f=>require('path').relative(process.cwd(),f.name)).join(' '))" "$L/vitest.json" 2> /dev/null)
    strip "$L/vitest.log" | grep -E '^ *(FAIL|×)' | head -20
    fail unit "$line; failed: ${failed:-see vitest.log}" "$failed"
  else say "$line"; fi
}

BOOT=tests/e2e/boot.e2e.ts
# The boot check's own results folder: `--failed` reruns its failed tests from the run's .last-run.json there.
BOOT_OUT=$LOGS/boot-results
boot() { # boot [--last-failed]
  local t=$(date +%s)
  TL_E2E_WORKERS=1 npx playwright test "$BOOT" --project=default --output="$BOOT_OUT" "$@" > "$L/boot.log" 2>&1
  local rc=$? line
  line="boot${1:+ (its failed tests)}: $(grep -E '^\s+[0-9]+ (passed|failed|flaky|skipped)' "$L/boot.log" | tr -s ' ' | tr '\n' ' ')($(secs "$t"))"
  if [ $rc -eq 0 ]; then say "$line"; else grep -E '✘' "$L/boot.log" | head -10; fail boot "$line (boot.log)" last-failed; fi
}

# The picture set (tools/voxel-bench/pictures-cli.ts): its pack, named after the run's log folder, holds the
# pictures, their settle states and the newest performance report beside the one before. A picture that could not
# be taken or did not settle is RED: the run did not do its job. What a picture shows is the agent's read, never
# the gate's.
pictures() {
  local t=$(date +%s) out=${TL_PICTURES_DIR:-$HOME/.cache/thirdlight-pictures}/${L##*/}
  if node tools/voxel-bench/run.mjs pictures --out "$out" > "$L/pictures.log" 2>&1; then
    say "$(grep '^pictures: ' "$L/pictures.log" | tail -1) ($(secs "$t"))"
  else
    grep '^pictures: ' "$L/pictures.log" | tail -12
    fail pictures "$(tail -1 "$L/pictures.log") (pictures.log; $(secs "$t"))"
  fi
}

# Frame rate, frame time, GPU time and memory from the headroom bench on staging's 8 km world (low tier, at its cap),
# after the tests so it runs alone (the pictures come after it, so their pack carries this run's report); written
# beside the previous phase run's. Never gating: whatever happens here, the run's result is the other steps'.
perf() {
  local t=$(date +%s) started='' reports=$LOGS/perf-reports
  if ! node -e "import('./tests/e2e/browser-env.mjs').then((m) => process.exit(m.gpuAvailable() ? 0 : 1))"; then
    say "perf: not recorded (no usable GPU on this host)"; return 0
  fi
  if ! systemctl is-active --quiet thirdlight-staging; then
    TL_STAGING_MEM=6G tools/staging.sh start > "$L/staging.log" 2>&1 || { say "perf: not recorded (staging did not start: staging.log)"; return 0; }
    started=1
  fi
  node tools/voxel-bench/run.mjs headroom --quality low --rounds 1 --copies none --scales none --tag phase --out "$L/perf-headroom.json" > "$L/perf.log" 2>&1
  [ -n "$started" ] && tools/staging.sh stop >> "$L/staging.log" 2>&1
  if [ -s "$L/perf-headroom.json" ] && node tools/perf-report.mjs "$L/perf-headroom.json" "$reports" "$(git rev-parse --short HEAD)" > "$L/perf-report.md" 2>> "$L/perf.log"; then
    say "perf: $(grep -E '^\| (frame rate|GPU frame|page heap)' "$L/perf-report.md" | awk -F' *\\| *' '{printf "%s %s; ", $2, $3}')report $L/perf-report.md ($(secs "$t"); recorded, never gating)"
  else
    say "perf: not recorded (the bench wrote no result: perf.log) ($(secs "$t"))"
  fi
}

verdict() { if [ ${#FAILED[@]} -eq 0 ]; then finish GREEN; else finish "RED (${FAILED[*]%%:*})"; fi; }

case "$mode" in
  check)
    say "check at $(git rev-parse --short HEAD)$( [ -n "$(git status --porcelain)" ] && echo ' with uncommitted changes')"
    [ -z "$failed_only" ] && rm -rf "$STATE"
    build
    lint
    if [ -n "$WANT_UNIT" ]; then if [ ${#UNIT_FILES[@]} -gt 0 ]; then unit all "${UNIT_FILES[@]}"; else unit fast; fi; fi
    [ -n "$WANT_BOOT" ] && boot "${BOOT_ARGS[@]}"
    verdict ;;
  phase)
    say "phase run at $(git rev-parse --short HEAD)"
    build; lint; unit all; boot; perf; pictures
    verdict ;;
  pictures)
    say "pictures at $(git rev-parse --short HEAD)"
    pictures
    verdict ;;
esac
