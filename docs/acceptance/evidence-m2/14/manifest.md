# M2 evidence — packet 14: browser baseline and bounded physics selection

Date 2026-09-18 (UTC) · runId `tl14-2026-09-18-a` · packet 14 of M2
(`docs/planning/m2-packets.md` §14). All artifacts are sanitized: numbers,
versions/integrity strings, and build outputs only — no credentials, no
project data.

## Environment (actual)

Container host (Proxmox LXC, same host as the M1 acceptance run):
12th Gen Intel Core i5-12600H (6 cores visible) · 16 GiB RAM ·
Node v22.22.1 · repo-pinned esbuild 0.28.2 and TypeScript 5.9.3 ·
no browser, no GPU, no physical gamepad.
**Every CPU/init number in this directory is DIRECTIONAL** (container, Node,
not the reference desktop) per plan-review BR-2
(`docs/handoffs/m2-plan-review.md`). CPU acceptance requires a labeled
desktop measurement. Candidates were installed only in disposable prefixes
(`/tmp/tl-m2-eval-14/<cand>` via `npm --prefix`), never in the repo
lockfile or `node_modules` (BR-1). Machine facts: `01-machine-facts.json`.

## Reproduction

All probes live in `tests/evaluations/m2-physics/` (standalone `.mjs`/`.ts`;
deliberately NOT picked up by vitest or the repo typecheck/boundary scans —
BR-1) and import candidates via `EVAL_PREFIX` (default
`/tmp/tl-m2-eval-14`):

```bash
# disposable candidate installs (exact identities in 02-candidate-registry.json)
for c in rapier2d-compat rapier2d planck cannon-es; do
  npm --prefix /tmp/tl-m2-eval-14/$c install @dimforge/rapier2d-compat@0.20.0 @dimforge/rapier2d@0.20.0 planck@1.5.0 cannon-es@0.20.0 || true
done   # (per-candidate installs were actually used; see registry)

cd tests/evaluations/m2-physics
node probe-rapier2d.mjs phases    # -> 05-phases-*.json (run twice: determinism)
node probe-rapier2d.mjs cpu       # -> 06-cpu.json (3 runs, 5 s warmup + 30 s measure)
node coldinit-sample.mjs          # -> 07-coldinit.json (3 fresh processes)
node probe-planck.mjs             # -> 08-planck.json (bounded functional comparison)
node probe-cannon-es.mjs          # -> 09-cannon-es.json (bounded functional comparison)
node build-iife.mjs /tmp/tl-m2-eval-14/out   # -> 10-iife-build.json + 10-probe-iife.js
# strict-TS runs: tsc 5.9.3 --noEmit on ts-probe.ts (3 configs, see 11-tsc-strict.json)
# M1 baseline + subpath serving: see 12-m1-build-subpath-serving.json
```

Course spec (frozen before the run; tolerances declared in the spec, one
recorded T7 tolerance correction): `course-spec.json` (copy of
`tests/evaluations/m2-physics/course-spec.json`).

## Claims → artifacts

| # | Claim | Artifact | Status |
|---|-------|----------|--------|
| 1 | `@dimforge/rapier2d-compat@0.20.0` passes all 10 frozen course phases (idle, flat run, seam, 43° climb, 47° refuse, wall stop, head bump, ledge, 12 m/s no-tunneling, jump height) under the canonical M2 game-logic model, 120 Hz fixed step, capsule r=0.3/hh=0.6 | `05-phases-run1.json`, `05-phases-run2.json` | **verified (Node/container)** |
| 2 | The result is deterministic (two full runs byte-identical) | `05-determinism.json` | **verified** |
| 3 | Fixed-step cost with 1 kinematic capsule + 64 static colliders: controller p50 ≈ 0.004 ms, total fixed-step p99 ≤ 0.031 ms vs the 8.333 ms tick budget | `06-cpu.json` | **directional (BR-2)** |
| 4 | Cold init (ESM import → `init()` → first step): 73–77 ms total in fresh Node processes | `07-coldinit.json` | **directional (BR-2)** |
| 5 | The candidate bundles under the exact pinned option set of export.md §5.3 (bundle/platform-browser/iife/treeShaking-off/sourcemap-off/minify-off) with repo-pinned esbuild 0.28.2, satisfies the no-top-level-await IIFE rule, and the 2,169,354-byte unminified bundle runs standalone | `10-iife-build.json`, `10-probe-iife.js` | **verified (build + Node run; browser run unverified)** |
| 6 | The candidate's `.d.ts` fails the repo base strict config (33 × TS2550 `Symbol.dispose`); one additive per-package `lib: esnext.disposable` entry fixes it and strictness stays intact (negative control) | `11-tsc-strict.json` | **verified** |
| 7 | Distribution facts: integrity, license Apache-2.0, zero dependencies, **≈7.6 MB unpacked (registry `unpackedSize`, approximate — GE-4)**, WASM base64-embedded in the ESM entry (no runtime WASM fetch), one inert `fetch(` pattern for the packet-19 scan table | `02-candidate-registry.json` | **verified (registry metadata)** |
| 8 | planck@1.5.0 out-of-the-box gaps: kinematic bodies pass through static walls (7.8 m penetration measured), no ramp climbing (Box2D edge case), grounding requires custom raycasts, no capsule shape | `08-planck.json` | **verified (functional, Node)** |
| 9 | cannon-es@0.20.0 out-of-the-box gaps: same wall/ramp gaps (3D constrained to XY), plus a self-hit raycast trap (grounding raycast hits the character's own shape — measured constant 0.89 m — fixed only with explicit collision-filter groups), no Capsule shape in 0.20.0 | `09-cannon-es.json` | **verified (functional, Node)** |
| 10 | rapier3d (3D candidate) eliminated by desk research — labeled, no fabricated benchmark row | `02-candidate-registry.json` | **desk research** |
| 11 | M1 `npm run build` baseline green (4 built, 0 skipped) and dist + eval assets serve standalone from independent origins over plain-HTTP-style URLs (all 200) | `12-m1-build-subpath-serving.json` | **verified (serving via curl)** |
| 12 | Degenerate-input robustness of the CC sweep (large commanded downward delta while grounded — impossible under correct game logic): no floor miss, no penetration, no grounded-flag miss in 60 steps | `05-phases-run1.json` (T12) | **verified** |
| 13 | CC jitter: 1-step horizontal stalls at existing floor contact (average speed unaffected) — recorded for contract 17 | `05-phases-run1.json` (T2 `horizontalStallSteps`) | **recorded** |

## Failure cases (packet 14)

- **WASM/CSP/init failure**: the `-compat` distribution embeds the WASM as
  base64 in the JS bundle; the browser path performs no separate WASM fetch,
  so there is no CORS surface for the WASM itself. The single inert `fetch(`
  pattern is recorded for the packet-19 static scan. CSP interaction in a
  real browser: **unverified** (desktop procedure below).
- **Unavailable gamepad/secure context**: `navigator.getGamepads()` is only
  available in secure contexts per MDN (HTTPS or localhost); Chrome's
  Permissions-Policy `gamepad` default allowlist is `*`. A plain-HTTP LAN
  origin is therefore expected to fail — the owner must pick
  localhost/TLS-on-LAN topology before packet 30 if the desktop test fails.
  **Unverified** (no gamepad/browser in the container).
- **Package license/version incompatibility**: all four candidates are
  MIT or Apache-2.0 with zero runtime dependencies — no incompatibility
  found. planck's `engines: node>=24` is a Node-publish concern, not a
  browser one (recorded).
- **Missing browser**: present (no browser in the container). Selection
  therefore remains **provisional** and blocks dependent approval (Gate E),
  as the packet requires.

## Manual desktop evidence procedure (owner)

Run on the owner's reference desktop + reference browser (the same
browser/host the M1 §1B real-browser observations used), after the owner
accepts this evidence set:

1. `npm run build` in the repo; serve the repo with a plain static server
   (e.g. `python3 -m http.server` on the LAN) and record the plain-HTTP URL.
2. Open the M1 editor page (`/dist/editor/`) in the reference browser;
   record whether it renders (baseline). Screenshot or console log.
3. Serve the physics probe bundle (rebuild: `node tests/evaluations/m2-physics/build-iife.mjs <out>`)
   from a second static server/subpath (separate origin per the M2
   separate-origin topology) and open its page; record the
   `{"tl14_probe":"ok",...}` console marker (WASM init + 10 steps in the
   browser). Note any CSP/`init()` failure verbatim.
4. Connect a physical gamepad; on the probe page (or any page on that
   origin) log `navigator.getGamepads()` length and the first `gamepad`
   event (id/product) after pressing a button. Record the exact URL scheme
   (http vs https/localhost).
5. Save results into this directory as `13-desktop-evidence.json` (browser +
   version, OS, machine label, timestamp, scheme, console outputs). If step 4
   fails on a plain-HTTP LAN URL, the owner records the topology choice
   (localhost vs TLS-on-LAN) here before packet 30.

Browser-side CPU re-measurement is NOT required for the selection decision;
if desired, it goes in the same file (labeled "desktop", per BR-2).

## Sanitization note

Artifacts contain only numeric results, package identities (name/version/
integrity/license), and the exact unminified IIFE build output
(`10-probe-iife.js`, 2.1 MB). No credentials, session tokens, or project
data. `/tmp/tl-m2-eval-14` is disposable and may be deleted; every artifact
in this directory is regeneratable with the commands above.