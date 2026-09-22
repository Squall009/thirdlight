# Packet 21 evidence — Pure content and property commands

2026-09-18. Owner pre-approval: **owner pre-approval (autonomous M2 build
instruction, 2026-09-18); final manual review pending.** No commit made.

Every artifact here is sanitized (no credentials, no host paths, no tokens).
Commands ran from the repository root with the recorded toolchain (Node 22,
TypeScript 5.9.3, vitest 5.0.1, esbuild 0.28.2).

## Claim → artifact

| Claim | Artifact |
|---|---|
| The six required checks are green | `full-tests.txt` (68 files / 916 passed), `typecheck.txt` (exit 0), `check-deps.txt` (exit 0), `check-boundaries.txt` (10 pkgs / 161 files / 571 specifiers, exit 0), `build.txt` (4 built, exit 0), `check-fixtures.txt` (33/33 groups, exit 0) |
| The commands package suite passes (M1 regression + packet-21 tests) | `commands-tests.txt` (11 files / 195 passed) |
| Packet-21 op/query/history behavior, ordering and redo invalidation | `m2-replay.txt` (32 tests) — the whole `m2-content.test.ts` run, verbose |
| The accepted packet-16 command fixtures replay byte-exactly through the new pure layer | `m2-replay.txt` — `M1 publishBehavior` and `M2 setBehaviorProperties` results `toEqual` the committed `prefab-scenario.messages.json` payloads; 11 of the `prefab-failures.json` cases reachable without a prefab op (F10–F20, states `base`/`r3-after-M1`/`r4-after-M2`) equal their committed error payloads |
| M1 data fixtures and behavior are unchanged | `scope.txt` — `git status --porcelain fixtures/commands` empty and `git diff --stat fixtures/commands` empty; the packet-16 fixture digests are recorded (unmodified). The one M1 test edit is the `ERROR_CODES` list assertion in `api-surface.test.ts` (see Recorded deviations) |
| The packet-21 fixture set is committed and indexed | `scope.txt` — sha256 of `fixtures/m2/commands/content-ops.messages.json` and `expected.json`; the replay test asserts every step byte-exactly and the final revision |

## What is and is not independent evidence

- **Independent of this implementation:** the replay of packet 16's committed
  `prefab-scenario.messages.json` (M1/M2 request/result pairs) and
  `prefab-failures.json` (F10–F20). These were authored and accepted before
  packet 21 and are asserted byte-for-byte by `m2-content.test.ts`.
- **Regression pin, not independent evidence:**
  `fixtures/m2/commands/content-ops.messages.json` was emitted by the packet-21
  implementation and is asserted against it (a byte-exact regression pin for the
  new ops). No second implementation re-derived it.

## Test counts

- Commands package: 163 → 195 tests (10 → 11 test files); the 32 new tests are
  `m2-content.test.ts`.
- Repository: 884 → 916 tests, 67 → 68 test files.

## Not claimed

- No browser/GPU evidence (none is in packet 21's scope).
- No prefab operation, workspace executor, blob/stage read, HTTP/MCP surface or
  durable write is implemented or exercised here (`publishAsset` carries
  digest-addressed facts only).
- No independent reviewer approval.

## Recorded deviations

- `ERROR_CODES` is extended with the commands.md §5.4 M2 rows (contract-mandated
  by the promotion); the single `api-surface.test.ts` list assertion was updated
  to the extended set. No other M1 test or fixture changed.
- Contract-change requests C21-1…C21-5 are recorded in `handoffs/21.md`.
