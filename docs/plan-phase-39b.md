# Phase 39b — Consolidation

Status: planned 2026-10-21.

Goal: make the engine cheaper to change before the two big rebuilds
(phase 40, ground cover and placement; phase 41, one physics backend). The
phase breaks up the large units every feature lands in, brings the test gate
back inside its budget, gives the defect list a real status, and applies the
owner's decisions on the backlog of defaults. **No behaviour changes**, except
where the owner's decision session reverses a default.

Source: the maintainability assessment of 2026-10-21 (HEAD `5dc0c4ca`; the
findings are summarised in §2). The owner approved a consolidation phase
between 39 and 40.

## 1. Owner decisions (2026-10-21)

- A consolidation phase runs between 39 and 40.
- The owner goes through one batched decision list (the defaults logged as
  "owner to confirm" in the plans since phase 17) and does one owner look
  across the phases marked "owner look pending". The outcomes are applied in
  this phase (39b.6).

## 2. Where things stand (assessment, 2026-10-21)

- **Package layering is clean and machine-checked.** 17 packages, a DAG, no
  boundary violations. The value-subpath exceptions grew one at a time:
  backend → project-model went from 4 to 10.
- **Large units under the 2,000-line file rule.** The rule caps files, not
  units:
  - `RuntimeInstance` (`runtime/src/runtime.ts`): 3,633 lines, 330 members;
  - `createSceneAdapter` (`three-adapter`): 1,793 lines;
  - `createBackend`: 1,708 lines;
  - `EditorApp`: 1,297 lines;
  - `GraphEditor`: 1,231 lines;
  - `attachBrowserInput`: 1,099 lines;
  - `Viewport`: 188 members;
  - `SessionClientCore`: 159 members.
  
  Over the file rule: `runtime.ts` (3,988 lines) and `asset-pipeline/src/
  inspect.ts` (2,876). Eleven more files are between 1,800 and 1,999 lines.
- **The full gate runs 26–31 min** against its 15 min budget (D253). 22 D-rows
  are flaky-test "watch" rows.
- **The defect list has no status column.** About 106 rows look open (1 H,
  23 M, 82 L by a text heuristic).
- **About 209 defaults are open "owner to confirm"** (74 decision-log entries; split per decision, plus audit questions: `~/.cache/thirdlight-owner-review/decisions-2026-10-21.md`); 4 were ever confirmed. 24
  phases are marked "owner look pending".
- **Logic kept in two places:**
  - 19 parity-test files guard pairs (editor vs runtime, CPU vs GPU, graph vs
    compiled);
  - project formats v2–v6 still have types and upgrade code;
  - `package.json` descriptions in 14 packages carry phase history and are
    stale.
- **Copied tolerances:** `1e-6` appears 159 times in 81 files; `0.001` 73
  times.

## 3. Items

**Rule for every item:** behaviour-preserving. Each split keeps the public
surface its callers use, moves one subsystem at a time behind a small
interface, and is proven by the existing tests (unchanged) plus the perf
classes at the cap (no regression). Splits that change no behaviour need no
new e2e.

| Item | What |
|---|---|
| 39b.0 | **Release checks.** Record the starting numbers: the unit-size list, gate time per file (the slowest 30 e2e files), the open D-rows, and the perf classes at the 60 Hz cap on both renderers. |
| 39b.1 | **A unit-size rule, checked at build.** `tools/check-size.mjs` in `npm run build`: no function or closure over 400 lines and no class over 80 members, alongside the 2,000-line file rule. A ratchet list names today's offenders with their current size; an entry may only shrink and is removed when it fits. AGENTS.md states the rule. |
| 39b.2 | **Split `RuntimeInstance`** into subsystem modules behind interfaces (scene set, entities and access, physics bridge, behaviours and hooks, audio, camera, UI, saves, streaming, diagnostics; the boundaries are chosen from the code). `RuntimeInstance` becomes a composition root. `runtime.ts` falls under 2,000 lines. |
| 39b.3 | **Split `createSceneAdapter`** (three-adapter) and **`createBackend`** (backend) the same way: per-subsystem modules wired by a thin root. |
| 39b.4 | **Split the editor's large units:** `EditorApp`, `Viewport`, `SessionClientCore`, `GraphEditor` and `attachBrowserInput`, each into per-area modules or hooks. `asset-pipeline/src/inspect.ts` is split per asset kind. |
| 39b.5 | **The test gate inside 15 min.** Fix or delete each of the 22 watch tests: fixed if it guards something real, deleted with a note if it duplicates another test. Merge and prune e2e files (one backend per file; browser-free checks move to vitest) until `full --both-renderers` runs ≤ 15 min on this host with 2 workers (D253 closed). |
| 39b.6 | **Apply the owner's decisions.** Every default from the decision list is marked confirmed or reversed in its plan. Reversals are implemented as items here (or moved to the phase that owns the area, if larger). The phases the owner has looked at are marked done without "owner look pending". |
| 39b.7 | **The defect list gets a status column** (open / fixed `<commit>` / superseded / won't fix). Every row is classified; fixed and stale rows are closed with evidence; duplicates are merged. STATUS.md shows the open counts. |
| 39b.8 | **Old formats out.** Drop types and upgrade code for project formats older than the oldest version a supported project can still be on (default: older than schema 6 — every template and game repo is at 7). An older project is refused with a clear message naming the last engine version that upgrades it. Default chosen, owner to confirm. |
| 39b.9 | **Two-place logic shared where possible.** For each of the 19 parity pairs, either one implementation serves both sides (shared module) and the parity test goes, or the reason it can't (CPU reference for a GPU shader, for example) is written next to the pair. |
| 39b.10 | **Small hygiene:** `package.json` descriptions say what each package is today (no history); the boundary exceptions are reviewed (each one justified or removed); the repeated tolerances become named constants in their owners; the Inspector's hand-built panels that duplicate descriptor fields move to descriptors (the rest are declared exceptions). |
| 39b.11 | **Acceptance:** the size rule passes with the ratchet list shorter; `runtime.ts` and `inspect.ts` are under 2,000 lines; the full gate runs ≤ 15 min and is green; no perf class regresses at the cap; the open D-row count is known. Then the phase review. |
| 39b.12 | **Review fixes.** |

**Done when:**
- No unit grows past the size rule, and the ratchet list only shrinks.
- The runtime, adapter, backend and editor roots are composition roots.
- The full gate is green in ≤ 15 min.
- The defect list has a status for every row.
- Every logged default is confirmed or reversed.

## 4. Progress

| Item | Status |
|---|---|
| — | Not started. |

## 5. Decision log

- 2026-10-21: Planned from the maintainability assessment, on the owner's
  approval of a consolidation phase between 39 and 40, the placement pipeline
  folded into 40, and a batched owner decision session.
