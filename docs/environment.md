# Thirdlight — Host environment

The server the engine is built, tested and served on (checked 2026-10-30). The 2026-09-16 snapshot this replaces
(no GPU, 6 CPUs, the pi-web harness) is in git history.

## Machine

| Item | Value |
|---|---|
| Container | Proxmox VE LXC, Ubuntu 26.04.1 LTS, kernel 7.0.2-pve, x86_64. No containers inside it (owner, 2026-09-16) |
| CPU | Intel Core i5-12600H, 16 threads visible since 2026-11-11 (4 performance cores × 2 + 8 efficiency cores); the host shares them: a gate uses at most ~10–12 |
| Memory | 32 GiB (owner doubled it 2026-11-11), 512 MiB swap. OOM kills have taken the service and every agent down before |
| GPU | Intel Iris Xe (Alder Lake-P GT2), passed through at `/dev/dri`; `dadmin` is in `video` and `render`. The floor tier for performance (owner, 2026-10-28) |
| Disk | `/` 63 GB (LVM). `/tmp` is a RAM tmpfs capped at 4 GB |
| Toolchain | Node 22.22.1, npm 9.2.0 (pins: `package.json`, the lockfile) |

## Services

- `thirdlight.service`: the editor backend from this checkout's `dist/`, data root `/home/dadmin/thirdlight/`
  (registry, owner token; projects are game folders registered there). Drop-ins: `MemoryMax=8G`, and
  `TMPDIR=~/.cache/tmp/thirdlight-service`. Setup: `docs/deployment.md`.
- `cloudcli.service`: the Claude Code UI that holds every agent session. Its temp files go to `~/.cache/tmp`.
- `thirdlight-staging`: a staging backend for branch work, started only while testing: `tools/staging.sh start`,
  `smoke`, `status`, `stop`. It runs the checkout's `dist/` (build first) as a transient unit capped at 6 GB, on
  127.0.0.1:4180/4181 with its own data root `~/thirdlight-staging-p45` (its own owner token; engine-owned test
  worlds only, never a game copy). It refuses production's ports and data root, a taken port, and less than
  8 GB available. `smoke` creates the empty test project `staging-empty` through the admin API and reads it
  back with a command. Settings: `TL_STAGING_PORT`, `TL_STAGING_ROOT`, `TL_STAGING_HOST`, `TL_STAGING_MEM`.
  The voxel slice's test world is the project `voxel-slice` (made through the admin API), its world written by
  `node tools/voxel-bench/run.mjs slice-world --project-dir ~/thirdlight-staging-p45/projects/voxel-slice` (in a
  capped scope, before the backend opens it); the page is
  `http://127.0.0.1:4180/voxel-world.html?project=voxel-slice&world=slice&at=0,103,-32` (token from the editor).
- `thirdlight-gate`: the detached unit `tools/gate.sh start` runs a gate in, capped at 12 GB (`TL_GATE_MEM`) and
  1100 % CPU, 11 of the 16 threads (`TL_GATE_CPU`). Gates and e2e tests run Chromium on the Iris Xe.

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

## Gate on this host

Measured 2026-11-11 (16 threads, 32 GiB). Every gate's `load.log` has the 1-minute load every 30 s; its last line
gives the mean and peak. The load is lxcfs's, the container's own: it counts a thread the CPU cap throttles as
runnable, so the cap bounds the CPU a gate takes, not the load it shows; worker counts set the load.

| Run (vitest 6 workers, e2e 3 on the area files) | Time | 1-min load mean / peak | Memory peak |
|---|---|---|---|
| `fast --all`, no CPU cap | 604 s | 8.3 / 15.2 | 6.4 GB |
| `fast --all`, CPU cap 1100 % | 614 s | 7.9 / 14.6 | 7.0 GB |
| `area voxel rendering`, no cap / cap | 285 s / 293 s | 6.4 / 9.4, 5.2 / 7.0 | 6.1 GB |
| `fast --all` + the 20 area files, in turn (kept) | 839 s | 7.3 / 13.1 | 6.1 GB |
| the same, lint + vitest beside the e2e step | 694 s | 11.6 / **20.2** | 10.2 GB |
| the same, beside it with vitest on 4 workers | 777 s (×2) | 8.1–8.4 / 12.4–13.7 | 10.3 GB |

- The CPU cap is kept: it costs nothing measurable (the vitest step alone holds ~11 threads) and keeps 5 threads
  for production, staging and the agents whatever a gate starts.
- Running lint and vitest beside the e2e step was backed out. At 6 vitest workers the load reached 20; at 4 it
  saved 62 s of 839 (7 %) but slowed the e2e step 30 % (voxel 174 → 235–285 s: its streaming and meshing workers
  need the CPU too, it is not only waiting on the GPU) and a Play test timed out waiting for the world to draw
  (`voxel-world.e2e.ts:894`, 30 s), with the memory peak at 10.3 of the 12 GB cap. So the steps run in turn.
- A fourth e2e worker was not tried: it was to follow only a clean overlap.
- The heaviest step is vitest's whole suite (~430 s at 6 workers, load peak 13–15 alone); a fast gate's
  `vitest related` and the e2e step (load 7–9 at 3 workers) leave the host room.
