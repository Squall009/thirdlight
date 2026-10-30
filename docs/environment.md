# Thirdlight — Host environment

The server the engine is built, tested and served on (checked 2026-10-30). The 2026-09-16 snapshot this replaces
(no GPU, 6 CPUs, the pi-web harness) is in git history.

## Machine

| Item | Value |
|---|---|
| Container | Proxmox VE LXC, Ubuntu 26.04.1 LTS, kernel 7.0.2-pve, x86_64. No containers inside it (owner, 2026-09-16) |
| CPU | Intel Core i5-12600H, 10 CPUs visible |
| Memory | 16 GiB, 512 MiB swap. OOM kills have taken the service and every agent down before |
| GPU | Intel Iris Xe (Alder Lake-P GT2), passed through at `/dev/dri`; `dadmin` is in `video` and `render`. The floor tier for performance (owner, 2026-10-28) |
| Disk | `/` 48 GB (LVM). `/tmp` is a RAM tmpfs capped at 4 GB |
| Toolchain | Node 22.22.1, npm 9.2.0 (pins: `package.json`, the lockfile) |

## Services

- `thirdlight.service`: the editor backend from this checkout's `dist/`, data root `/home/dadmin/thirdlight/`
  (registry, owner token; projects are game folders registered there). Drop-ins: `MemoryMax=8G`, and
  `TMPDIR=~/.cache/tmp/thirdlight-service`. Setup: `docs/deployment.md`.
- `cloudcli.service`: the Claude Code UI that holds every agent session. Its temp files go to `~/.cache/tmp`.
- `thirdlight-gate`: the detached, memory-capped unit `tools/gate.sh start` runs a gate in (7 GB cap by default).
  Gates and e2e tests run Chromium on the Iris Xe.

## Rules for runs on this host

- **Never write to `/tmp`.** It is RAM, does not show as memory in Proxmox, and filled it caused the OOM kills of
  2026-10-17 and 2026-10-23. Set `TMPDIR=$HOME/.cache/tmp/<task>` for builds, tests, browsers and scripts; an hourly
  cron job deletes files older than 6 h there.
- **Cap every heavy run.** Gates via `tools/gate.sh start …` and `tools/gate.sh wait`. Ad-hoc backends, browsers and
  perf runs inside `sudo -n systemd-run --scope -p MemoryMax=7G -p MemorySwapMax=0 -- sudo -n -u dadmin -- env
  HOME=$HOME PATH=$PATH …` (the inner `sudo -u` keeps the GPU groups). Start one only with the cap + 2 GB available
  (`free -g`); one backend and one browser at a time.
- **Performance is measured at the display's 60 Hz cap**, never uncapped (uncapped runs throttle).
- The shell exports `NODE_ENV=production`; installs need `NODE_ENV=development`.
