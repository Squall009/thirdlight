#!/usr/bin/env bash
# A staging backend: this checkout's dist/ on its own ports and data root, for testing work that must not
# reach the production service (its data root, its ports, its code).
#
#   tools/staging.sh start    start it detached, as the systemd unit thirdlight-staging, under a memory cap
#   tools/staging.sh stop     stop that unit and check that nothing of it is left (unit, process, ports)
#   tools/staging.sh status   running or stopped, its pid, memory, ports and data root
#   tools/staging.sh smoke    against a running staging: the editor page answers, the empty test project
#                             exists (created through the admin API if not) and a command reads it back
#
# Settings (environment): TL_STAGING_PORT (4180) and TL_STAGING_PREVIEW_PORT (the port + 1),
# TL_STAGING_ROOT (~/thirdlight-staging-p45), TL_STAGING_HOST (127.0.0.1; a LAN address only when a
# browser elsewhere needs it), TL_STAGING_MEM (6G).
#
# The data root holds engine-owned test worlds only, never a game or a copy of one: its owner token is its
# own (tools/start.mjs makes it on first start). The production service's data root and ports are refused,
# read from its unit and the start script's defaults, so a mistyped setting cannot open production's
# projects in a second backend. Start refuses with less than the cap + 2 GB available: this host has been
# taken down by OOM kills, and the staging backend shares it with gates and perf runs.
set -u
cd "$(dirname "$0")/.."
ENGINE=$PWD
UNIT=thirdlight-staging
PORT=${TL_STAGING_PORT:-4180}
PREVIEW_PORT=${TL_STAGING_PREVIEW_PORT:-$((PORT + 1))}
ROOT=${TL_STAGING_ROOT:-$HOME/thirdlight-staging-p45}
HOST=${TL_STAGING_HOST:-127.0.0.1}
MEM=${TL_STAGING_MEM:-6G}
TEST_PROJECT=staging-empty

die() { echo "staging: $*" >&2; exit 1; }

# The production service's data root and ports: from its unit's command line, else start.mjs's defaults.
production() {
  local cmd
  cmd=$(systemctl show thirdlight -p ExecStart --value 2> /dev/null)
  PROD_ROOT=$(sed -n 's/.*--data-root \([^ ;]*\).*/\1/p' <<< "$cmd")
  PROD_PORT=$(sed -n 's/.*--port \([0-9]*\).*/\1/p' <<< "$cmd")
  PROD_PREVIEW=$(sed -n 's/.*--preview-port \([0-9]*\).*/\1/p' <<< "$cmd")
  PROD_ROOT=${PROD_ROOT:-$HOME/thirdlight}
  PROD_PORT=${PROD_PORT:-8501}
  PROD_PREVIEW=${PROD_PREVIEW:-8502}
}

port_taken() { [ -n "$(ss -Hltn "sport = :$1" 2> /dev/null)" ]; }

check_settings() {
  production
  [[ "$PORT" =~ ^[0-9]+$ && "$PREVIEW_PORT" =~ ^[0-9]+$ ]] || die "ports must be numbers ($PORT, $PREVIEW_PORT)"
  [ "$PORT" != "$PREVIEW_PORT" ] || die "the editor and preview ports must differ"
  for p in "$PORT" "$PREVIEW_PORT"; do
    { [ "$p" = "$PROD_PORT" ] || [ "$p" = "$PROD_PREVIEW" ]; } && die "port $p is the production service's; refused"
  done
  local root prod
  root=$(realpath -m "$ROOT")
  prod=$(realpath -m "$PROD_ROOT")
  case "$root/" in "$prod"/*) die "$ROOT is (inside) the production data root $PROD_ROOT; refused" ;; esac
  case "$prod/" in "$root"/*) die "$ROOT contains the production data root $PROD_ROOT; refused" ;; esac
  ROOT=$root
}

origin() { echo "http://$HOST:$PORT"; }

case "${1:-}" in
  start)
    check_settings
    for p in "$PORT" "$PREVIEW_PORT"; do port_taken "$p" && die "port $p is taken"; done
    systemctl is-active --quiet "$UNIT" && die "already running ($UNIT); tools/staging.sh status"
    need=${MEM%G}
    avail=$(awk '/MemAvailable/ {print int($2 / 1048576)}' /proc/meminfo)
    [ "$avail" -ge $((need + 2)) ] || die "only ${avail} GB available (need $((need + 2)): the ${MEM} cap + 2 GB); not started"
    [ -f dist/backend/backend.mjs ] && [ -f dist/editor/index.html ] || die "dist/ is missing: npm run build first"
    mkdir -p "$ROOT"
    tmp=$HOME/.cache/tmp/$UNIT
    mkdir -p "$tmp"
    sudo -n systemctl reset-failed "$UNIT" 2> /dev/null || true
    # A transient unit, not a scope: it outlives the shell that started it and stops by name. The inner sudo
    # keeps the user's supplementary groups (video, render: the GPU for headless play).
    sudo -n systemd-run --unit="$UNIT" --quiet -p MemoryMax="$MEM" -p MemorySwapMax=0 -p KillSignal=SIGTERM \
      -p TimeoutStopSec=20 -p StandardOutput=append:"$ROOT/staging.log" -p StandardError=append:"$ROOT/staging.log" \
      --working-directory="$ENGINE" -- sudo -n -u "$(id -un)" -- env HOME="$HOME" PATH="$PATH" TMPDIR="$tmp" \
      NODE_ENV=production ${THIRDLIGHT_BROWSER_LIBS:+THIRDLIGHT_BROWSER_LIBS="$THIRDLIGHT_BROWSER_LIBS"} \
      node tools/start.mjs --data-root "$ROOT" --host "$HOST" --port "$PORT" --preview-port "$PREVIEW_PORT" \
      || die "systemd-run failed"
    for _ in $(seq 1 60); do
      [ "$(curl -s -o /dev/null -w '%{http_code}' "$(origin)/")" = 200 ] && break
      systemctl is-active --quiet "$UNIT" || break
      sleep 1
    done
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "$(origin)/")" != 200 ]; then
      tail -n 20 "$ROOT/staging.log" >&2
      sudo -n systemctl stop "$UNIT" 2> /dev/null
      die "did not answer on $(origin)/ within 60 s; stopped"
    fi
    echo "staging running: $(origin)/  (unit $UNIT, pid $(systemctl show "$UNIT" -p MainPID --value), data root $ROOT, token $ROOT/owner-token, log $ROOT/staging.log)"
    ;;
  stop)
    check_settings
    if systemctl is-active --quiet "$UNIT"; then sudo -n systemctl stop "$UNIT" || die "could not stop $UNIT"; fi
    sudo -n systemctl reset-failed "$UNIT" 2> /dev/null || true
    left=$(systemctl show "$UNIT" -p ActiveState --value)
    [ "$left" = active ] || [ "$left" = deactivating ] && die "$UNIT is still $left"
    for p in "$PORT" "$PREVIEW_PORT"; do port_taken "$p" && die "port $p is still taken after the stop"; done
    echo "staging stopped: unit $UNIT ${left:-gone}, ports $PORT and $PREVIEW_PORT free"
    ;;
  status)
    check_settings
    if systemctl is-active --quiet "$UNIT"; then
      echo "running: $(origin)/  unit $UNIT, pid $(systemctl show "$UNIT" -p MainPID --value), memory $(( $(systemctl show "$UNIT" -p MemoryCurrent --value) / 1048576 )) MB of $MEM, data root $ROOT"
    else
      echo "stopped (unit $UNIT $(systemctl show "$UNIT" -p ActiveState --value); ports $PORT/$PREVIEW_PORT, data root $ROOT)"
    fi
    ;;
  smoke)
    check_settings
    systemctl is-active --quiet "$UNIT" || die "not running; tools/staging.sh start"
    code=$(curl -s -o /dev/null -w '%{http_code}' "$(origin)/")
    [ "$code" = 200 ] || die "the editor page answered $code"
    echo "editor page: 200"
    # The test project goes in through the same admin API and commands every client uses.
    TL_ORIGIN=$(origin) TL_TOKEN_FILE="$ROOT/owner-token" TL_PROJECT=$TEST_PROJECT node --input-type=module -e '
      import { readFileSync } from "node:fs";
      const origin = process.env.TL_ORIGIN, id = process.env.TL_PROJECT;
      const headers = { authorization: `Bearer ${readFileSync(process.env.TL_TOKEN_FILE, "utf8").trim()}`, origin, "content-type": "application/json" };
      const post = async (path, body) => { const r = await fetch(origin + path, { method: "POST", headers, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
      const created = await post("/api/v1/admin/projects", { projectId: id, name: "Staging empty test world" });
      if (created.json.ok !== true) { console.error(`create ${created.status} ${JSON.stringify(created.json).slice(0, 400)}`); process.exit(1); }
      console.log(`test project ${id}: ${created.json.created === true ? "created" : "already there"}`);
      const q = await post(`/api/v1/projects/${id}/commands`, { op: "queryProject", projectId: id, args: {} });
      if (q.json.ok !== true) { console.error(`queryProject ${q.status} ${JSON.stringify(q.json).slice(0, 400)}`); process.exit(1); }
      console.log(`queryProject: ok, revision ${q.json.revision}`);
    ' || die "smoke failed"
    ;;
  *)
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 2 ;;
esac
