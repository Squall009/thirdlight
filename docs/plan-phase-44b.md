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
| 44b.4 | **Look and close.** In a real browser on both renderers at the 60 Hz cap: walking from the door room out into the sunset (exposure adapting, no veil); a follow camera along a wall and through a doorway (pull-in in and out, no clipping); an interior camera in see-through mode. Shots and captures for the owner. Fast gate per item, the full gate at the end, the phase review. |

## 3. Progress

| Item | Status |
|---|---|
| 44b.0 | done: three 0.186.1 pinned, 0.187.0 (minor) out 2026-10-30 → item 44b.3a. Plan committed. D339 open → 44b.1. Before shots (look scenes, medium, both renderers, cap): sunset veiled on both at medium, corridor fine; bloom 0.88 / 0.84 ms GPU (sunset / corridor, ≈ 0.41 at full clock). See **44b.0 baseline**. No code, no e2e. |
| 44b.1 | done: bloom off removes the veil (both renderers). Bloom now thresholds the exposed colour, soft knee, only the excess glows; default strength 0.2; `bloom-exposure` load step. Sunset still veiled at exposure 1 (≈ 2 stops over), clean at 0.3: D339 open for 44b.3. Bloom GPU ≈ 0.42 ms full (0.41); landscape/interior main ms below 44.13. env-parity 23.0 → 25.9 s. Shots: acceptance/44b.1. |

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
