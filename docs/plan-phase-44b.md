# Phase 44b — Camera: occlusion modes and adaptive exposure

Status: **in progress** (started 2026-11-01 at 7f98343e). Planned in the owner session of 2026-10-28. It runs after
phase 44 and before the voxel phases (45–49). It doesn't depend on voxels.

Goal: each virtual camera decides how it handles what stands between it and its subject, and how it exposes the
picture. Games switch both by switching cameras, through priorities and camera regions as today.

## 1. Owner decisions (2026-10-28)

**Occlusion modes, chosen per camera.**
- Each virtual camera chooses `pullIn` (the default), `seeThrough` or `none`. Temporal, for example, could use
  see-through on interior cameras and pull-in on its freer outdoor cameras.
- **Pull-in.** Today the follow rig casts a ray and snaps the camera in front of a hit, and snaps back
  (`runtime/src/camera-brain.ts`, the follow rig's collision). Instead it should:
  - move in fast (it must never sit inside geometry), using a sphere test of the camera's radius so walls don't clip
    the near plane;
  - hold briefly once clear;
  - ease back out to the target distance;
  - expose per-camera times for in, hold and out.
- **See-through.** It keeps its occluder search and dither (39b), but only on cameras that choose it. Today it is a
  project-wide setting (off by default) with a script override. That setting becomes the default for new cameras, and
  the script override stays.
- **Props:** pull-in keeps casting against physics colliders, so props with colliders still count. (With voxels, the
  world part becomes a grid walk; that is phase 45's §9.)

**Adaptive exposure, chosen per camera.**
- Each virtual camera can enable auto-exposure (eye adaptation), with:
  - minimum and maximum exposure, so night stays dark and noon never blows out;
  - separate adaptation speeds for brightening and darkening;
  - metering: centre-weighted or the frame average;
  - exposure compensation;
  - off, for today's fixed exposure.
- The settings blend with camera blends, like the rest of a camera's look.
- **Cost:** one small luminance pass (a downsampled average), read back to the exposure at the next frame. It works
  the same on WebGPU and WebGL 2.
- Today exposure is a fixed number in the environment look's post settings (`renderer.toneMappingExposure`). That
  stays as the value when auto-exposure is off.

**Bloom must follow exposure.**
- Bloom runs on the scene colour *before* tone mapping and exposure (`three-adapter/src/environment-nodes.ts`). So
  its threshold ignores exposure, and auto-exposure couldn't calm a blooming sky. This is the leading suspect for
  D339, the washed-out outdoor scenes.
- Bloom's threshold is compared after exposure, with a soft knee, and the default strength is reviewed (today
  0.6 × 3).
- If D339 is still open when this phase starts, this fix is its first item.

## 2. Items

| Item | What |
|---|---|
| 44b.0 | **Start.** three.js release check; commit this plan. Check whether D339 is still open. Shots of the sunset and corridor look scenes, at medium on WebGPU and on WebGL 2, as the "before". |
| 44b.1 | **Bloom after exposure (D339).** Threshold on exposed colour with a soft knee; default strength reviewed. Before and after shots of the sunset (morning, noon, evening) and the corridor. The owner judges the look. |
| 44b.2 | **Occlusion modes per camera.** `pullIn`, `seeThrough`, `none` on the virtual camera, in the model, Inspector, MCP and manual. Pull-in with a sphere cast, fast in, hold, eased out, and per-camera timings. The see-through project setting becomes the default for new cameras; the script override keeps working. |
| 44b.3 | **Adaptive exposure per camera.** Luminance pass on both renderers, adaptation with min/max, speeds, metering and compensation, blended with camera blends. Model, Inspector, MCP and manual. |
| 44b.3a | **three r187.** The minor release (0.187.0, 2026-10-30) through `docs/three-upgrade-checklist.md`: its PMREM now draws cube targets instead of the CubeUV atlas (`environment-cube.ts` hook), r177 deprecations removed, a reversed-depth fix. Before and after shots of the look scenes, perf at the cap. |
| 44b.3b | **Exposure everywhere, cameras e2e back.** D421: exposure applies to the sky too without post, one path on both renderers; the cameras e2e back to about its 44b.1 time. |
| 44b.4 | **Look and close.** In a real browser on both renderers at the 60 Hz cap: walking from the door room out into the sunset (exposure adapting, no veil); a follow camera along a wall and through a doorway (pull-in in and out, no clipping); an interior camera in see-through mode. Shots and captures for the owner. Fast gate per item, the full gate at the end, the phase review. |

## 3. Progress

| Item | Status |
|---|---|
| 44b.0 | done: three 0.186.1 pinned, 0.187.0 (minor) out 2026-10-30 → item 44b.3a. Plan committed. D339 open → 44b.1. Before shots (look scenes, medium, both renderers, cap): sunset veiled on both at medium, corridor fine; bloom 0.88 / 0.84 ms GPU (sunset / corridor, ≈ 0.41 at full clock). See **44b.0 baseline**. No code, no e2e. |
| 44b.1 | done: bloom off removes the veil (both renderers). Bloom now thresholds the exposed colour, soft knee, only the excess glows; default strength 0.2; `bloom-exposure` load step. Sunset still veiled at exposure 1 (≈ 2 stops over), clean at 0.3: D339 open for 44b.3. Bloom GPU ≈ 0.42 ms full (0.41); level GPU +0.5–0.9: host (A/B, log). env-parity 23.0 → 25.9 s. Shots: acceptance/44b.1. |
| 44b.2 | done (4c5eb5cf): occlusion per camera; sphere pull-in (in/hold/out, cut past walls), see-through per camera, mode snaps mid-blend; defaults: log. Cap: interior WebGPU main 3.06, GPU 7.09 full, WebGL 2 1.84; village 6.16 / 4.36 CPU; p95 16.7, 0 missed: no cost. e2e cameras 18.7 → 31.5 s (+12.8: doorway + see-through, both renderers). Shots looked at (test-results). |
| 44b.3 | done: per-camera auto-exposure (meter 128×64→16×8, async read-back, both renderers), blended with camera blends. Sunset settles at 0.09, no veil, renderers alike: D339 fixed. Meter GPU ≈ 0.09 ms full clock; on: main +0.1–0.2 (A/B); off: interior/landscape/village within 44's range, p95 16.7–16.8, 0 missed. cameras e2e 31.5 → 32.4 s. D421. |
| 44b.3a | done (83037b97): three 0.187.0; every checklist row checked: 6 hooks removed (three does it), 9 changed, 1 added (precompile targets). Cap, WebGPU main/GPU full, WebGL 2 main: village 5.32/5.09, 3.95; landscape 4.75/10.49, 3.31; interior 3.06/7.08, 1.79; lights 64/256 2.17/2.59; p95 16.7–16.8, 0 missed: no cost. level-acceptance 1.9–2.1 min both; D422 (fails at base). |
| 44b.3b | done (8e3b2071): exposure applies to the whole picture, colour/image sky too without post, fixed or auto (sky exposed, not tone mapped: exposure 1 unchanged); meter sees the sky. D421 fixed. env-parity: tone-aces/neutral refs redrawn (sky only), exposure-0.5 check both renderers. cameras e2e 32.4 → 20.0 s. Village at cap: main 6.07 / 4.05 ms, p95 16.7–16.8, 0 missed. Gate: D422 only. |
| 44b.3c | done (e4c0e040): D422 and D409 fixed. Cause: the test passed only before WebGPU's live probes were lit (traced: Play's frame 0 passed, then it settled at the export's failing pixels). The sky now lights nothing and the yellows are darker; bounds unchanged. Alone 5/5, 31–35 s (passing before 35.6 s, failing 2.0 min). Fast gate green. |
| 44b.4a | partial (548afdaf): D424 fixed (r187 precompile re-bound the macro baker's 64² target: stale WebGPU Play; D426 bake throw); D423 watch. H1/M2 measured, not fixed: D427 (probes 1.3–2.4 stops over env light; noon auto 0.077). Cap: landscape 4.51/10.21, 3.21; interior 3.03/7.22, 1.80; village 5.86/4.10 ms; p95 16.7–16.8. |
| 44b.4b | done (8afa536f…4170f72a): M1 tone mapping none takes the exposure (linear curve, both renderers); M3 load step writes bloom strength 0.6, scales or notes levels' thresholds; D426 fixed (r187 freed never-made bind groups); L2/L6/L7/L8 fixed, L1/L3 left (log); L4 counts flat; D428 watch. env-parity exposure test 1.1 → 2.3 s. Village at cap 5.79 / 4.09 ms, p95 16.7, 0 missed. |
| 44b.4c | done: acceptance at the cap, both renderers (acceptance/44b.4c, README, all looked at): door room → sunset adapts 2 → 0.13, no veil settled; pull-in ≥ 0.200 m clear in 1,885 samples; see-through vs none; bloom follows exposure. D429 (WebGL 2 sunset morning/noon veiled). Perf vs 44b.0: main lower, p95 16.7–16.8, 0 missed; GPU +0.1–0.4 = host (same-hour A/B). See **44b results**. |

### 44b.0 baseline

- **D339** is still open at the start (audit list); 44b.1 is its fix, as §1 says.
- **Before shots** (2026-11-01, 7f98343e, Iris Xe, 1920×1080, 60 Hz cap; `~/.cache/thirdlight-phase44b/acceptance/before/`,
  all looked at, README there): `run.mjs look --scenes sunset,corridor --variants medium:quality=medium` (baked).
  The sunset at medium is washed out on **both** renderers: a pale peach veil over the frame, sky and ground one
  pastel, the house a ghost, no shadow seen (D339 had WebGL 2 clean, but at low). The corridor reads fine (panels
  with a wide halo). The look scene itself has no time of day; morning and noon come from `run.mjs look-accept
  --scenes sunset`, which has no quality flag: WebGPU (medium) is veiled at morning, noon and evening alike, WebGL 2
  at its default tier (no bloom drawn) is clean. All runs p95 16.7, 0 missed.
- **Bloom GPU** (WebGPU timestamps, at the cap): sunset 0.88 ms a frame at 555–649 MHz (≈ 0.41 ms at full clock;
  high-pass 0.15, five blurs 0.63, composite 0.09), corridor 0.84 ms (≈ 0.41). Frame GPU 7.68 / 7.81 ms (3.56 / 3.80
  at full clock). The bound for 44b.1.
- **Perf baseline of the phase:** phase 44's end (`docs/plan-phase-44.md`, **44.13 results**, dist of baf8f5bb; copied,
  not re-run). 60 Hz cap, Iris Xe, 1080p, medium, 3 rounds; GPU ms at full clock.

| Scene | Renderer | p95 ms | missed | main ms | GPU ms full |
|---|---|---|---|---|---|
| village | WebGPU | 16.7–16.8 | 0/600 ×3 | 5.74 / 6.25 / 6.56 | 4.74 / 4.76 / 4.95 |
| village | WebGL 2 | 16.7–16.8 | 0/600 ×3 | 4.11 / 4.43 / 4.37 | - |
| landscape | WebGPU | 16.7–16.8 | 0/600–601 ×3 | 5.09 / 5.28 / 5.75 | 10.03 / 9.98 / 9.96 |
| landscape | WebGL 2 | 16.7–16.8 | 0/600 ×3 | 3.52 / 3.64 / 3.69 | - |
| interior | WebGPU | 16.7–16.8 | 0/600–601 ×3 | 3.38 / 3.35 / 3.73 | 6.12 / 6.05 / 6.21 |
| interior | WebGL 2 | 16.7–16.8 | 0/600–601 ×3 | 2.01 / 1.93 / 2.23 | - |

  Main ms there read high against 44.0 by host state (its same-hour A/B against fb338eab); compare 44b's end in a
  same-hour A/B against 7f98343e.

### 44b results

- **Acceptance** (44b.4c, 2026-11-01 17:39–17:58, main at 5ae64dac, Iris Xe, headless Chrome 1920×1080, 60 Hz cap,
  quality medium on both renderers; `~/.cache/thirdlight-phase44b/acceptance/44b.4c/README.md`, every kept shot looked
  at). A scratch scene (the look door room under the sunset's sun, sky and post, baked) with the starter character:
  - Door room → sunset, follow camera with auto-exposure: 2 (max) inside, 1.0 in the doorway, 0.18 within 1 s
    outside, settled 0.13 (WebGPU) / 0.20 (WebGL 2); no veil once settled. The same walk at fixed exposure 1 is
    veiled outside (the over-bright reference).
  - Follow camera through the doorway and along the wall into a corner and out: pulled in and eased out as designed;
    clearance from the nearest block never below the 0.200 m radius in 1,885 camera samples of six walks. In the
    corner the character's body fills the view (nothing fades a subject; not a 44b item).
  - Interior: see-through opens a dithered circle onto the character; none keeps the wall solid; both renderers.
  - Bloom at fixed exposure 0.5 vs 2 on the night sign: a tight glow vs a wide one; bloom follows exposure.
  - Sunset through the day, live sun, auto-exposure: WebGPU 0.086 / 0.077 / 0.22 (morning / noon / evening), WebGL 2
    0.44 / 0.193 / 1.17 (as 44b.4a, D427); noon stays above the 1/16 floor but reads dark (sky-weighted meter).
    WebGL 2 morning and noon are veiled: **D429**. Corridor 0.55 / 0.58, clean on both. Baked sunset 0.105, both alike.
  - Frames on every walk and window: p95 16.7–16.8 ms, 0 missed.
- **Perf, end of 44b** (dist of 5ae64dac): 60 Hz cap, Iris Xe, 1080p, 3 rounds 2026-11-01 16:40–17:39,
  load 0.8–1.8, the default tier as 44.13. `run.mjs village --vsync --no-bare`, `run.mjs level --classes landscape,interior --vsync`. GPU ms at
  full clock; in brackets the 44b.0 baseline (44.13).

| Scene | Renderer | p95 ms | missed | main ms (44.13) | GPU ms full (44.13) |
|---|---|---|---|---|---|
| village | WebGPU | 16.7 | 0/600–601 ×3 | 5.43 / 5.37 / 5.37 (5.74–6.56) | 5.25 / 5.09 / 5.01 (4.74–4.95) |
| village | WebGL 2 | 16.7–16.8 | 0/600 ×3 | 3.88 / 3.95 / 3.89 (4.11–4.43) | - |
| landscape | WebGPU | 16.7–16.8 | 0/600–601 ×3 | 4.58 / 4.47 / 4.69 (5.09–5.75) | 10.03 / 10.18 / 10.19 (9.96–10.03) |
| landscape | WebGL 2 | 16.7–16.8 | 0/600–601 ×3 | 3.13 / 3.09 / 3.16 (3.52–3.69) | - |
| interior | WebGPU | 16.7–16.8 | 0/600–601 ×3 | 2.94 / 2.92 / 3.05 (3.35–3.73) | 6.53 / 6.50 / 6.29 (6.05–6.21) |
| interior | WebGL 2 | 16.7–16.8 | 0/600 ×3 | 1.84 / 1.80 / 1.83 (1.93–2.23) | - |

- Main-thread ms is lower than the baseline on every class and renderer; p95 and missed frames equal. GPU reads
  0.1–0.4 ms higher on village and interior in all three rounds, so a **same-hour A/B against 7f98343e** (WebGPU,
  base-head-head-base, 17:56–18:18, load 0.8–2.5; base worktree built with `node tools/build.mjs`), GPU ms full: village
  5.48 / 5.33 → 5.12 / 5.09, interior 6.78 / 6.89 → 6.98 / 6.79; main 5.42 / 5.62 → 5.60 / 5.59 and 3.12 / 3.03 →
  2.86 / 3.02; p95 16.7–16.8, 0 missed. The base reads as high the same hour: host state (D199, D290), not 44b. 44b is
  not slower.
- **Bloom and meter GPU, auto-exposure on** (`run.mjs look --scenes sunset --variants medium:quality=medium
  --auto-exposure --rounds 2`, WebGPU timestamps): bloom (high-pass, five blurs, composite) 0.85 / 1.03 ms raw at
  598 / 500 MHz = 0.36 / 0.36 ms at full clock (44b.0: 0.41); the meter 0.245 / 0.299 ms raw (128×64 pass 0.20 / 0.25,
  16×8 reduce 0.04 / 0.05) = 0.10 / 0.11 ms full, drawn in 180 of 181 timed frames. Main 2.13 / 1.96 ms; p95 16.7–16.8,
  0 missed, both renderers.

## 4. Decision log

- 2026-10-28 (owner, planning session): the camera features (occlusion modes, adaptive exposure) form their own small
  phase after 44 because they don't depend on voxels. The bloom finding is from reading the code while reviewing the
  42.15 shots with the owner (D339 update in the audit list), not yet tested.
- 2026-11-01 (44b.0, default chosen, owner to confirm): three r187 (0.187.0, a minor) is taken as its own item
  44b.3a, after the camera items and before the look-and-close, so 44b.1's before/after compares on one three and
  44b.4's shots and the full gate run on r187. Its PMREM change (cube targets for the CubeUV atlas) touches the
  lighting cube hook and may shift the environment light, so it gets its own look-scene before/after.
- 2026-11-01 (44b.1): D339's veil is bloom (gone with bloom off, both renderers), on a sunset look that is ≈ 2 stops
  overexposed at its exposure 1. Bloom's bright-pass now compares the exposed luminance (`toneMappingExposure`, so
  44b.3's adaptation calms it too) with a quadratic soft knee (half the threshold, Unity's default) and passes only the
  part above the threshold; three's own high-pass passed the whole colour. One TSL function on both renderers
  (`environment-nodes.ts`). At exposure 1 the sunset stays veiled (its surfaces sit several times over the threshold);
  at 0.3 it is clean with a local glow. D339 stays open for 44b.3. Leaving the sky's sun disc out of the environment
  bake was tried (no visible change) and dropped.
- 2026-11-01 (44b.1, default chosen, owner to confirm): new bloom starts at strength **0.2** (was 0.6): the composite
  adds ≈ 9 × strength of the excess (5 mips summing to 3, times the kept ×3), so 0.6 added 5.4 ×; 0.2 adds 1.8 ×.
  Threshold 0.85 and radius 0.4 stay; the threshold's range grows to 0–8 (exposed values). Defaults are defined once
  (`BLOOM_DEFAULTS`, `BLOOM_LIMITS` in project-model) instead of three copies.
- 2026-11-01 (44b.1): existing bloom keeps its start point: a recorded schema-8 step `bloom-exposure` scales a look's
  threshold (the default where absent) by that look's exposure when it is not 1 (each scene look and preset on its
  own; Problems says so). Strength and radius keep their meaning (a multiplier, a spread); the glow is weaker for the
  same strength because only the excess glows: the fix, not a silent change (manual, rendering page). The env-parity
  `bloom.png` reference is redrawn from WebGL 2 for the same reason (strict match on both backends; it still differs
  from the plain picture by mean 24.8).
- 2026-11-01 (44b.2, default chosen, owner to confirm): what existing projects get. A camera without an `occlusion`
  resolves at load: the project's `see_through` on → `seeThrough`, else an older `collision: false` → `none`, else
  `pullIn`. No upgrade step and no file rewritten: a project that had see-through keeps it on every camera (it loses
  the ray pull-in that ran beside it), every other follow camera pulls in with the new sphere, hold and ease. The
  setting is thereby "the default for new cameras" (a new camera has no field) and stays the look's home (radius,
  fade …). `collision` stays readable (shown under Occlusion, Pull in only) rather than retired by a format step.
- 2026-11-01 (44b.2, default chosen, owner to confirm): pull-in defaults radius 0.2 m (as before), in 0.1 s (time to
  cross the whole distance), hold 0.3 s, out 0.6 s (eased in-out). The in time only applies while the sphere grazes
  an edge and the target is still in sight; a collider that hides the target (a ray from the target), or a move
  that would start in or pass into one, puts the camera at the clear distance at once and the step is a cut (prev =
  curr), so no drawn frame is behind, inside or sliding through a wall. The floor at Min distance is gone (it put
  the camera inside a wall closer than that). Pull-in acts on the follow rig only, as the ray did.
- 2026-11-01 (44b.2): mode in blends: pull-in is part of each camera's pose, which blends as before; the mode itself
  (what the renderer reads: see-through on or off) snaps to the incoming camera's at the blend's midpoint and
  see-through's own fade eases it. A script's `setSeeThrough({enabled})` holds over every camera until `enabled:
  null` gives it back. The mask is built when a see-through camera loads (the view's `seeThroughLoaded`), during its
  scene's load, not when it goes live, so a camera switch never rebuilds programs.
- 2026-11-01 (44b.2, first task): 44b.1's landscape/interior GPU +0.5–0.9 ms against the 44.13 numbers is host state,
  not bb70d593: a same-hour interleaved A/B (WebGPU, 60 Hz cap, base-head-head-base, 06:50–07:29, load 1.0–2.6),
  7f98343e → bb70d593, GPU ms at full clock: landscape 10.69 / 10.30 → 10.59 / 10.31 (scene pass 7.34 / 7.07 →
  7.28 / 7.04), interior 6.92 / 6.69 → 7.14 / 6.98 (its scene pass swings 1.3–2.6 ms raw on either side); main ms
  5.06 / 4.94 → 4.91 / 5.04 and 2.99 / 3.04 → 3.12 / 3.02; p95 16.7–16.8, 0 missed everywhere. No D-row.
- 2026-11-01 (44b.2): the cameras e2e grew 18.7 → 31.5 s (one test, its backend shared): a doorway round trip (8 s of
  walking, the camera read every 30 ms) and the see-through pair, run on both renderers at once in the export. Nothing
  else was cut to pay for it; the phase review should weigh it. Visual: the pulled-in shot (walker in view, no wall)
  and the interior pair (wall solid with none, the figure through the dither with see-through) looked at on WebGL 2
  and the default renderer's pulled-in shot; not kept.
- 2026-11-01 (44b.3): auto-exposure is per camera (`autoExposure`, `exposureMin/Max`, `exposureBrightenSpeed`,
  `exposureDarkenSpeed`, `exposureMetering`, `exposureCompensation`; additive on schema 8). The brain turns a camera
  into a look and blends it with the camera blend; a camera without it is a look of weight 0 whose range is the
  environment's fixed exposure, so a blend narrows or widens the range in stops and a cut to it shows the fixed
  exposure at once. The renderer meters the scene colour (linear, before bloom and tone mapping) in two TSL passes —
  128×64 of mean log2 luminance from 4×4 filtered taps, then 8×8 texel loads down to 16×8 — and reads the 16×8 grid
  back asynchronously (three's `readRenderTargetPixelsAsync`); the passes are drawn only when a read-back starts (one
  in flight), so they run every few frames. Weighting (centre Gaussian σ 0.5 or flat) is on the CPU, so a metering
  blend changes no program. Adaptation in stops, `1 − e^(−speed·dt)`, frame-rate independent, target middle grey
  0.18 × 2^comp. Exposure stays `toneMappingExposure`, so bloom (44b.1) follows it. While any loaded camera has it the
  stack keeps the scene in a texture (built at load, so a camera switch builds nothing; a no-post frame then draws
  through the stack with its MSAA).
- 2026-11-01 (44b.3, default chosen, owner to confirm): min 0.0625 (first 0.125: the sunset clamped at 0.13), max 2,
  brighten 1/s, darken 3/s (Unity's and Unreal's pair: into the light ~1 s, into the dark ~3 s), centre-weighted,
  compensation 0. With 0 the sunset reads a little dark and flat (the bright sky in mid-frame pulls the meter);
  +1 EV looks more natural (`acceptance/44b.3/auto-comp1-*`): a project's choice, the engine keeps middle grey.
- 2026-11-01 (44b.3): D339 fixed: its cause was bloom before exposure (44b.1) on a sunset look ≈ 3.5 stops over at
  fixed exposure 1; with auto-exposure it settles at 0.09 on both renderers, no veil. Default chosen, owner to
  confirm: the look scene keeps fixed exposure 1 (the over-bright reference adaptation must handle).
- 2026-11-01 (44b.3): the 44b.1 note is real and by design: without post a colour or sRGB image sky is shown
  unexposed (parity with the archived WebGL renderer and its env-parity references), with post it is exposed. A loaded
  auto-exposure camera exposes it too (an adapted view would leave the sky as it was). Changing it for every project
  is the owner's call: D421.
- 2026-11-01 (44b.3): cost. Meter 0.15–0.23 ms per drawn meter at 515–944 MHz = 0.09–0.14 ms at full clock (sunset,
  corridor). Sunset, interleaved A/B, 2 rounds: main WebGPU 2.34/2.38 vs 2.23/2.15 ms, WebGL 2 1.36/1.49 vs 1.28/1.33.
  Classes without it (one round, at the cap, 08:42–09:01): landscape WebGPU main 5.26 GPU 10.49 full, WebGL 2 3.52;
  interior 3.34 / 7.11, 1.91; village 6.04 / 5.34, 3.97 — within phase 44's range (44b.0 table); p95 16.7–16.8, 0
  missed. The fast gate's village check passed (6.2 / 4.25 ms CPU). e2e: the cameras test 31.5 → 32.4 s (the dark
  room and the cut, both renderers in parallel in the export).
- 2026-11-01 (44b.3a): three r187 taken through the checklist (§5 there has the notes). Three now does what six hooks
  did: the lighting cube (its PMREM is a mip-mapped cube read with one lookup), the WebGL 2 VAO sweep, program and
  texture-listener release, the lose-context override and the editor's OrbitControls listener release; they are
  gone. Real breakages found by the gate, not by the guards: a layered sun lit nothing (r187 zeroes the direct sums
  again after a branch: the sums are named before it, vitest holds it), shadow maps were drawn in every precompile
  (`_isPreCompiling` gone), a sharing geometry was never freed (`disposeSharingGeometry` read r186's records), an
  instanced kit mesh could read another's matrices (`objectSpecific`), and `compileAsync` now builds its draws after
  it returns: a resized scene target gave pipelines without a depth format, and a depth copy from the canvas in a
  precompile broke every later WebGPU frame (`installPrecompileTargets`). The first present now also waits for start
  content arriving during the start compile (a clipped decal). Digests re-recorded after a hook-free build gave the
  same WGSL. Pixels: the sunset's ground greener, house a little firmer (the new PMREM); corridor unchanged
  (`acceptance/44b.3a`, looked at).
- 2026-11-01 (44b.3a, default chosen, owner to confirm): the glTF import recipe keeps its loader line `three 0.186.0`
  (`M2_GLTF_TOOLCHAIN`): r187's GLTFLoader changes only touch extensions the import refuses, and the line is part of
  every imported model's recipe digest (moving it would make every model re-import). It moves with a loader change
  that reaches accepted models.
- 2026-11-01 (44b.3a): `level-acceptance.e2e.ts:673` fails alone at the base 0f914de9 too (the WebGPU export's rule
  and door colours, identical pixels on r186 and r187; once WebGL 2 cover): D422, to fix before the full gate. With
  the judge made soft, base and r187 fail the same stages and pass all others.
- 2026-11-01 (44b.3b, default chosen, owner to confirm): exposure applies to the whole picture, sky included, with or
  without a post stack, fixed or adapted (as Unity and Godot do). Without post a colour or sRGB image sky stays
  untone-mapped (the colour picked, as the archived WebGL renderer drew it) but is multiplied by the exposure in the
  same background pass, so exposure 1 looks as before and most projects see no change; with post it is tone mapped
  as before. A loaded auto-exposure camera no longer switches that sky to the post path: the meter reads the scene
  pass with the background laid under its alpha (`MeterSource`), so a fixed and an adapting camera at the same
  exposure show the same sky. D421 fixed. env-parity `tone-aces.png` (exposure 1.3) and `tone-neutral.png` (0.8)
  were the only references with exposure ≠ 1 and no post; redrawn from WebGL 2: 32.5k of 76.8k pixels changed, all
  the sky (≈ 55 silhouette-edge pixels) and every sky pixel at the expected sRGB of 1.3 / 0.8 × its linear value;
  WebGPU matches strictly; looked at. New check (env-parity, both renderers): exposure 0.5, no post, sky
  126,200,255 → 91,146,188 (half its linear value), ground 110.7 → 79.3.
- 2026-11-01 (44b.3b): cameras e2e (the Play/export test) 32.4 → 20.0 s (18.7 before 44b.2), nothing dropped: the
  walker 2 → 6 m/s (a 2.7 s round trip) and the door camera's hold/out 0.1 / 0.3 s (the defaults' timing is the
  runtime's vitest, the doorway included), read until pulled in and back out instead of a fixed 9 s; the see-through
  shot polled instead of 2 × 600 ms waits; the dark-room hold 300 ms; the post-cut trace 1.5 s (settles within 1.3);
  the rail 4 → 8 m/s; the orbit activation at step 240 instead of 300 (the follow camera is shot by step ~110).
- 2026-11-01 (44b.3c): D422 and D409 came from the test, not the product. Traced in Play WebGPU, the first frame
  passed (ramp 165,89,168, door 155,142,57). 1–2 s later the live probes, holding the scene's saturated #3050d0 colour
  sky at the field's full sky light (1) plus the bounce, settled at 169,108,199 and 167,149,67: the WebGPU export's
  failing pixels exactly. The export failed whenever its first screenshot came after the probes. With the sky's light
  at 0.1 the settled ramp still failed by 1. At 0 the bounce alone takes the bright #f0e000 yellows over the blue bound
  under AgX (b 58 → 66). The test's sky now lights nothing, and the yellows are #c0b000. Settled: ramp 168,91,169, door
  145,119,41. WebGL 2 is unchanged at the old first-frame values. No bound was changed.
  Measured at each step: doorway 4.8 → 2.2 s, rail 2.9 → 2.3, export start to orbit 3.6 → 3.2.
- 2026-11-01 (44b.3b): fast gate (env-parity, cameras, level-acceptance, scene-view-parity, environment-blend-cost,
  scene-environment) and its rerun: everything passed but `level-acceptance.e2e.ts:673`, the WebGPU export's rule and
  door colours with D422's pixels (it fails at the base too; next item). Village at the cap run by hand (the gate
  stops before it on a red e2e), 12:02, load 1.5: main WebGPU 6.07, WebGL 2 4.05 ms, p95 16.7–16.8, 0 missed of 360.
- 2026-11-01 (44b.4a): D424 bisected to 83037b97 (r187), not probes or exposure. three r187's `compileAsync` builds
  its collected draws later and ends each by binding the target current when it was called; the terrain macro baker
  compiles into its 64² target and puts the renderer's back at once, so the builds re-bound the bake target between
  frames and every later frame's post quad drew into it (traced: render targets and binds logged in Play).
  `installPrecompileTargets` now ends each build with the target last bound by anyone else since it began; the
  baker's draws restore their target in `finally` (a draw threw a missing-GPU-buffer error in the streamed Play,
  D426). D423 not reproduced (four runs); likely the same freeze in the editor's terrain mode: watch.
- 2026-11-01 (44b.4a, review H1/M2, measured, not fixed): see D427. The sunset at exposure 1 is ≈3.5 stops over
  because of the GI light (live probes and the bake), not the sky's or sun's units: without probes it settles at
  1.17 (evening). Noon with auto-exposure settles at 0.077 (WebGPU) / 0.193 (WebGL 2), above the 1/16 floor.
  Leaving the sun disc out of the IBL bake moves it 0.35 stop only. The level-acceptance change of 44b.3c stays:
  a colour sky lights probe-lit surfaces and nothing else (`scene.environment` is null for it), a real divergence
  that D427 holds; giving colour skies an environment would change 81 e2e scenes, an owner decision. The look
  scene's settings are not changed until D427's cause is known (changing its exposure would hide it).

- 2026-11-01 (44b.4b, review M1): tone mapping `none` is drawn with three's linear tone mapping (colour × exposure,
  clamped to the display) instead of NoToneMapping, which skips the exposure: fixed and auto exposure now apply under
  `none` too, as bloom's threshold already assumed, one path on both renderers. At exposure 1 the picture is as before
  (the clamp is the display's). The no-post background pass is not needed under `none` (the renderer's own output
  exposes the sky the same way). env-parity: `tone-none` at exposure 0.5 is half its linear value, sky and ground.
- 2026-11-01 (44b.4b, review M3): the recorded `bloom-exposure` step also writes strength 0.6 (the old default) into
  every look and preset with bloom on and no strength, with a Problems note; extended rather than a new step, as 44b
  is not deployed (no project has recorded the step with the 0.2 default yet). Quality levels: a level's absent
  strength is the look's (now written); a level's threshold override is scaled where every look with bloom shares one
  exposure, else left with a note naming the levels and the exposures (one override serves looks of several).
- 2026-11-01 (44b.4b, D426): cause found. three r187's `Bindings.deleteForRender` releases a render object's bind
  groups whether or not they were ever made, and `compileAsync` yields between making a render object and its
  bindings; the macro baker's bake materials disposed in that gap took a use from the render context's shared group
  (camera uniforms) that it never had, the count hit 0 under the drawing bake, and its buffers were destroyed (probe
  in streamed Play: "uninitialised render object deleted: shared group render usedTimes 1", then "updateBinding
  without a GPU buffer: render"). `installBindingRelease` (dispose.ts) only forgets such a render object; vitest drives
  three's own `Bindings` with and without it. A render object disposed in the gap and then built by the compile keeps
  one use of its shared group (read in code: a camera uniform block kept per render context, not a growing leak).
- 2026-11-01 (44b.4b, review L5): the redrawn `tone-aces.png` (44b.3b) also holds r187's ACES change, so that
  reference is partly the engine's own picture now, not the archived renderer's.
- 2026-11-01 (44b.4b, review lows): L2 one ray stand-in for the sphere cast (`rayStoppedShort`, clamped at 0) in
  both places; L6 the pull-in's casts, rays and overlaps leave the follow target's own colliders out (a physics query
  filter), so a target that is not the character no longer turns every pull-in into a cut; L7 `setSeeThrough({enabled:
  null})` gives back the project's `enabled` in the settings too; L8 the MCP text says the meter reads every few
  frames, STATUS row 44b updated. L4: the full gate's memory runs (033fb18c) hold flat after the three removed WebGL 2
  hooks: backend swap ×10 prog 13 → 13, VAOs 22 → 22; Play start/stop ×10 and the additive scene ×50 equal or one
  less. Left: L1 (the meter's two small programs still compile when the first adapting camera goes live; compiling
  them ahead needs the scene texture bound, more than a fix-up) and L3 (the Inspector would need the project's
  see-through setting and the `collision` field to show the resolved mode; the field's help says what absent means).
