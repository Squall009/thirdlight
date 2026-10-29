# Phase 44 — Consolidation after the lighting phases

Status: **in progress** (planned in the owner session of 2026-10-28; started 2026-10-29 at fb338eab, the end of
phase 43). 44.0 committed this plan and the global audit.

Goal: pay down the debt found by the global audit (`docs/audit-2026-10-26-global.md`, findings G1–G22) and reset the
docs, without adding features. The result is a smaller, stricter codebase for the voxel phases (45–49,
`docs/plan-phase-45.md`) to build on. Read `AGENTS.md` and the audit first.

## 1. Owner decisions (2026-10-26 to 2026-10-28)

- **Consolidation comes after 43, before the voxel work** (owner, 2026-10-26).
- **Leave block-layer, terrain and generated-architecture internals alone** wherever phase 48 retires them: their
  meshing, storage, sculpt/paint/scatter paths, the architecture generator's mesh and collider code, and their e2e
  specs. Change them only if a game needs a fix now. Work on code that phase 48 deletes is wasted. (Owner, 2026-10-28,
  relayed earlier as the memory note "phase44-voxel-scope".)
- **Duplicate helpers get one home, and a build check stops copies coming back** (owner, 2026-10-26):
  - generic helpers go into one zero-dependency leaf package;
  - domain constants stay in project-model, and three-adapter gets a value edge to its constants and limits;
  - the build fails when an owned name is redefined elsewhere, with existing copies on a ratchet list that only
    shrinks;
  - AGENTS.md gains a line: "If you can't import something, change the boundary rule in its own commit; never copy."
- **Docs stay current on every commit without growing** (owner, 2026-10-26). A build check enforces size limits on
  STATUS rows and plan progress rows, the same way `check-size` does for code.
- **Unanswered "owner to confirm" defaults count as approved** (owner, 2026-10-26). About 100 in plans 39–42 are
  recorded as approved in one place. Changes come back as new requests when a game runs into one.
- **Not in this phase:** release packaging and a local install (shelved by the owner, 2026-10-27), cross-browser
  testing, the memory-leak re-sweep, and any change to game repos.

Owner to decide (default used if the phase starts without an answer):
- **Commit the global audit:** default yes, in 44.0, as the phase's reference (done; default chosen, owner to
  confirm). `docs/plan-phase-45.md` is already committed (e52e891d) and is read-only during 44.

## 2. Items

Work through the items in order. Run the fast gate per commit. Each helper family or finding is its own commit, so a
regression points at its cause.

| Item | What |
|---|---|
| 44.0 | **Start.** Check for a newer three.js release (checklist). Commit this plan and, per the default, the audit. Record the full gate's time and memory peak from the end of 43 as this phase's baseline. |
| 44.1 | **Safety fixes (audit high).** G2: `writeAssetFolder` applies `uploadNameProblem`. G3: `GET /projects` and `/projects/resolve` limited to admin, or to the token's own project. G1: exports bundle from the built, frozen engine, not the live working tree (also closes D332's cause). One test each, at the HTTP boundary. |
| 44.2 | **Templates in the current format (G4).** Store both starter templates as current storage and schema versions. Then retire whatever only they kept alive: the v3 project and scene validation used for new projects, the manifest v1/v2 writers (test-only), and the `LEGACY_SESSION_PAGE` branch. Keep only upgrade-on-open code that real projects still need. |
| 44.3 | **The shared leaf package and the redefinition check.** Create the package and change the boundary rules (three-adapter value edge to project-model constants and limits; runtime stops relaying them). Add the build check with its ratchet. Byte-identical tests come **before** any move for SHA-256 and canonical JSON (content digests must not change) and for the seeded random and noise functions (saved worlds must not shift). Copies that differ are kept as named variants, not "fixed". |
| 44.4 | **Helper families moved, one commit each:** SHA-256 and canonical JSON; GLB, KTX2 and PNG readers and CRC-32; quaternion and matrix math; random and noise; `isPlainObject`, `deepFreeze`, `utf8Length`, `DIGEST_RE`, `REQUEST_ID_RE`; a bounded LRU; strict JSON parsing; the error constructors shared by commands and workspace. Files in the retired areas keep their copies; the ratchet lists them and phase 48 deletes them. |
| 44.5 | **Constants and lists with one owner (G20):** shadow defaults, surface presets, animation roles, manifest identity, `ENGINE_VERSION`, save format, message limit, move quantum, the import extension map, toolchain pins, shell screens and engine actions, and module ids. |
| 44.6 | **Parallel paths (G10–G16, outside the retired areas).** G10: each op's forward, inverse and redo in one module. G11: the admin accept/discard routes send `workspace.resync`. G12: one shared "hold, inspect, publish" step. G13: the property and prefab rules move into project-model and the editor uses them (room editing is architecture, so it is left for 48). G15: retire the raw-JSON script publish panel. G16: one commit-on-Enter/blur field. G5: fold the input character channels into the action evaluator. G14: the built-in title screen stops calling `newGame`; the deprecated paths stay until the games drop them. |
| 44.7 | **Dead and test-only code (G18, G19), outside the retired areas:** the scene v1/v2 renderer branch; the test-only parts of `session/media.ts` and `property-controls.ts`; the 2D outline collider; the demo module as a default; the stale boundary rule; `tools/dev/*`; the committed `.pyc`; package tests that default to `/tmp`. |
| 44.8 | **Caps (G7, G8).** Lift or justify the per-project caps on modes, behaviour groups, input actions and input maps, and extend the cap test so it can catch them (the block `cellFields` cap is left for 48). Selection-sized caps: the editor splits large moves and pastes into several commands, or the caps are raised to the request size limit. |
| 44.9 | **Size splits (G6), outside the retired areas:** `commands/types.ts`, `game-host/host.ts`, `backend/content.ts`, `three-adapter/material-graph.ts`, `commands/validate-request.ts`, `workspace/content-store.ts`. Split before they grow; the ratchet only shrinks. |
| 44.10 | **Tooling (G9, G21, G22):** add the missing private three.js hooks to the upgrade checklist; fix the perf probe's counters (per-frame `info`, the engine's own instancing, indirect draws); make `gate.sh rerun` re-run lint and vitest when those failed. |
| 44.11 | **Docs reset.** STATUS: header, defect counts, two-line rows. Roadmap: "How every phase is worked" replaced by a pointer to AGENTS.md; Future list updated (water and the voxel phases). Charter: current status, built features out of the deferred list, §11 dropped. `environment.md` corrected or archived. Decisions 0002–0005 get superseded notes. The work rules from plans 9 and 14 move into AGENTS.md, then plans 9 and 14–38 move to `archive/` with `git mv`. The defect list is split into open and closed. The roughly 100 open defaults are recorded as approved. |
| 44.12 | **Docs-on-commit check** in `npm run build`: a STATUS row or plan progress row longer than its limit (e.g. two lines or about 400 characters) fails the build, with a ratchet for today's long rows. Add the AGENTS.md lines (boundary rule; game answers go in `docs/requests/<game>-<date>.md`; a branch reserves a block of D numbers). |
| 44.13 | **Close.** Full gate (detached), with its time and memory against 44.0's baseline. Fewer lines and files is the expected outcome; record the counts. Then the phase review, then review fixes. |

## 3. Progress

| Item | Status |
|---|---|
| 44.0 | done (ece9b2ab + this row): three.js 0.186.1 is still the newest (npm, 2026-10-29), no upgrade; plan and audit committed; baselines in **44.0 baseline**; D413 closed (WebGL 2 walkers' shadow cost +0.67 / +1.03 → +0.20 / +0.23 ms, low / medium). |
| 44.1a | done: G2 job-export zips refuse names an upload may not have (6be64ef2; writeAssetFolder's body moved to folder-import, contentOps 443 → 421 lines); G3 project list and resolve scoped (2d85017a; MCP adapter's message for a refused project token). Vitest over HTTP; no e2e touched; fast gates green (one D311 watch miss, passed alone). |

### 44.0 baseline

What the end of 44 is measured against (44.13).

- **Full gate at the end of 43** (15472037, 2026-10-29): 32 min, memory peak 7.7 GB, 381 e2e, both renderers; RED (two real
  failures, D407/D408, fixed in e8c5ec3a; D409–D411 watch). Logs ~/.cache/thirdlight-logs/gate-full-20261029-132952.
- **Perf** at fb338eab: 60 Hz cap, Iris Xe, 1080p, medium tier, 2 rounds interleaved (22:10–22:54, load 1.9–4.1).
  44's end must not exceed these. GPU ms at full clock; WebGL 2 has no GPU timer.

| Scene | Renderer | p95 ms | missed | main ms | GPU ms full |
|---|---|---|---|---|---|
| village | WebGPU | 16.7 / 16.8 | 0/600, 0/600 | 5.48 / 5.51 | 5.66 / 5.68 |
| village | WebGL 2 | 16.8 / 16.7 | 0/600, 0/600 | 3.96 / 3.97 | - |
| landscape | WebGPU | 16.7 / 16.7 | 0/600, 0/600 | 4.94 / 4.88 | 10.42 / 10.44 |
| landscape | WebGL 2 | 16.7 / 16.7 | 0/600, 0/601 | 3.37 / 3.43 | - |
| interior | WebGPU | 16.7 / 16.7 | 0/600, 0/600 | 3.14 / 2.99 | 6.87 / 6.92 |
| interior | WebGL 2 | 16.7 / 16.8 | 0/600, 0/600 | 1.86 / 1.86 | - |

- **Size** (`git ls-files <dir>`, all files, `wc -l`) at fb338eab: packages 2,111 files / 518,342 lines (of which
  `.ts`/`.tsx` 1,981 / 511,165); tools 125 / 29,598; tests 474 / 99,289.
- **D413 re-measure** (`run.mjs lights --counts 64 --walkers 8 --tiers low,medium --renderers webgl2`, against
  `--shadowed 0`, same rounds as above): WebGL 2 main ms, control → walkers, low 1.41 → 1.58 / 1.39 → 1.62
  (+0.17 / +0.23), medium 1.86 → 2.00 / 1.82 → 2.13 (+0.14 / +0.31); p95 16.7–16.8, 0 missed. 43.6c read +0.67 /
  +1.03, so 5bc436c4's atlas fix took this case too.

## 4. Decision log

- 2026-10-28 (owner, planning session): plan drafted from the global audit and the owner's decisions of 2026-10-26
  to 2026-10-28 (§1). The retired-area rule comes from the voxel world plan (`docs/plan-phase-45.md` §5b, §4).
- 2026-10-29 (44.0, default chosen, owner to confirm): the global audit is committed as the phase's reference (§1's
  default); its G-ids stay and are cited beside the D-rows, nothing renumbered.
- 2026-10-29 (44.1a, default chosen, owner to confirm): G3 scope. The owner (admin) token, or a trusted network, keeps
  the full project list and folder resolve. A project-scoped token lists only its own project (as the session list
  already filters) and gets a resolve answer only for a path inside that project; any other path is a 401 with no
  reason or folder, so it cannot probe the server. The editor's picker and the MCP adapter use the owner token (or a
  project token from its own folder) and are unchanged.
