# Packet 22 evidence — Pure prefab capture and instantiation

2026-09-18. Owner pre-approval: **owner pre-approval (autonomous M2 build
instruction, 2026-09-18); final manual review pending.** No commit made.

Every artifact here is sanitized (no credentials, no host paths, no tokens).
Commands ran from the repository root with the recorded toolchain (Node 22,
TypeScript 5.9.3, vitest 5.0.1, esbuild 0.28.2).

## Claim → artifact

| Claim | Artifact |
|---|---|
| The six required checks are green | `full-tests.txt` (69 files / 938 passed), `typecheck.txt` (exit 0), `check-deps.txt` (exit 0), `check-boundaries.txt` (10 pkgs / 164 files / 587 specifiers, exit 0), `build.txt` (4 built, exit 0), `check-fixtures.txt` (33/33 groups, exit 0) |
| The commands package suite passes (M1 regression + packet-21/22 tests) | `commands-tests.txt` (12 files / 214 passed) |
| Capture/instantiate/undo/redo/remap/atomicity/limits/query behavior | `prefab-replay.txt` (22 tests, verbose) |
| Packet-16's accepted prefab contract fixtures replay byte-exactly | `prefab-replay.txt` — the whole `prefab-scenario.messages.json` M1–M10 scenario (`toEqual` on every step, final scene/content `equal` the after envelope; M10 is a duplicated retry, asserted modulo `duplicated`), and 22 reachable `prefab-failures.json` cases equal their committed payloads (F23 compared modulo the C21-4 message/hint text) |
| Two instances with distinct IDs, correctly remapped internal references and the exact mapping in the result | `prefab-replay.txt` — M4/M5 mapping `group-0002,box-0002,model-0003,model-0004` / `group-0003,box-0003,model-0005,model-0006`; `model-0003.target = group-0002`, `model-0005.target = group-0003` |
| One undo/redo preserves identity | `prefab-replay.txt` — undo produces `deleteEntity` for the whole subtree, redo re-inserts the recorded entries with the recorded IDs (no re-scan) |
| Changes in one copy never affect another | `prefab-replay.txt` — editing `model-0003`/`box-0002` leaves `model-0005`, `model-0007` and `box-0004` at the definition's recorded values; the definition is byte-unchanged |
| Invalid input has no partial expansion | `prefab-replay.txt` — every failure leaves the state object byte-identical (`JSON.stringify(state)` before/after) |
| Packet-22 fixtures are committed and indexed | `scope.txt` — sha256 of `fixtures/m2/prefabs/expected.json` and `independence.messages.json`; the replay test asserts every step byte-exactly and the final revision |
| M1 data fixtures and behavior are unchanged | `scope.txt` — `git status --porcelain fixtures/commands` and `git diff --stat fixtures/commands` empty; the packet-16 fixture digests match packet 21's recorded digests; no accepted contract was edited |

## What is and is not independent evidence

- **Independent of this implementation:** packet 16's committed
  `prefab-scenario.messages.json` (M3–M10) and `prefab-failures.json`
  (F01–F20, F22, F23). They were authored and accepted before packet 22 and are
  asserted byte-for-byte by `m2-prefab.test.ts`.
- **Regression pin, not independent evidence:**
  `fixtures/m2/prefabs/independence.messages.json` was emitted by the packet-22
  implementation and is asserted against it (a byte-exact regression pin for the
  two-copy independence, edit isolation and exact-ID redo path). No second
  implementation re-derived it.

## Test counts

- Commands package: 195 → 214 tests (11 → 12 test files); the 19 new tests are
  in `m2-prefab.test.ts` (plus 3 in the same file for the new fixture replay).
- Repository: 916 → 938 tests, 68 → 69 test files.

## Not claimed

- No browser/GPU evidence (none is in packet 22's scope; prefab authoring UI is
  packet 28).
- No workspace executor, durable write, HTTP/MCP surface or blob/stage read is
  implemented or exercised here.
- No independent reviewer approval.

## Recorded deviations

- `errors.ts` adds the prefab §5.4 constructors, `propertyTypeDetail` and
  `propertyOverrideUnknown` (the override `property_unknown` shape packet 16's
  F07 pins differs from the F10 `setBehaviorProperties` shape); no accepted
  contract was changed.
- `properties.ts` now shares one value-rule implementation between the field
  presentation (packet-21 behavior preserved) and the constraint-rich prefab
  override presentation; the M2 string length rule was unified to code points
  (project-model §20.5) — ASCII fixtures are byte-identical.
- Fixture defect FD-22-1 (F21 payload addresses the wrong instance-B entity) and
  C21-4 (F23 message/hint text) are recorded in `handoffs/22.md`; the committed
  contract fixtures were not modified.
