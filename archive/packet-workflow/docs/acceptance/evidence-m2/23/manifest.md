# Packet 23 evidence — workspace content publication and migration-copy

Owner pre-approval: **owner pre-approval (autonomous M2 build instruction,
2026-09-18); final manual review pending.** No git commit was made.

Raw outputs in this directory's `raw/` are the literal command transcripts;
nothing below is reconstructed from memory.

## Scope

Durable `storageVersion` 2 envelope read/write, immutable blob publication
under `sources/sha256/<digest>`, the §7.6 staging area (BR-4), derived-cache
paths, verified blob reads with integrity reporting, the captured content view,
v2 command execution, and the explicit operator `migrateProjectCopy`. All tests
run against disposable roots on ext4 (`/home/dadmin/.tl23-*` and
`.tl07-tmp-*`); crash tests use real subprocess `SIGKILL`.

## Commands run and actual results

| Command | Result | Transcript |
|---|---|---|
| `npm test` | 72 files / **975 passed** (exit 0) | `raw/npm-test.txt` |
| `npm run typecheck` | exit 0, all 10 packages | `raw/npm-typecheck.txt` |
| `npm run check-deps` | `check-deps: OK`, all pins exact | `raw/npm-check-deps.txt` |
| `npm run check-boundaries` | `OK — 10 package(s), 168 source file(s), 629 specifier(s)`, no violations | `raw/npm-check-boundaries.txt` |
| `npm run build` | `1 built … build: done (4 built, 0 skipped)` exit 0 | `raw/npm-build.txt` |
| `node fixtures/m2/contracts/tools/check-fixtures.mjs` | `check OK: 33 check group(s) passed, 0 problem(s)` | `raw/check-fixtures.txt` |

Packet-23 test suites: `packages/workspace/tests/m2-storage.test.ts` (27
tests), `packages/workspace/tests/m2-migration.test.ts` (4),
`tests/m2-crash.test.ts` (6 real-SIGKILL tests). Verbose transcripts:
`raw/m2-storage-migration-verbose.txt` (31 passed),
`raw/m2-crash-verbose.txt` (6 passed).

## Real crash durability (acceptance A09) — executed

Six subprocess runs; each child dies by `SIGKILL` from inside a `WriteOps`
seam, the parent reopens (explicit stale-owner takeover) and asserts the disk
state:

| Crash point | Observed after restart |
|---|---|
| before blob rename | blob absent, leftover `.<digest>.tmp-*` present, cleaned on open, retry publishes once |
| after blob rename | blob present and hash-equal; republish is idempotent (`alreadyPresent`) |
| before envelope rename | envelope revision 3, retry records `[]`; retry re-executes fresh (`duplicated: false`) |
| after envelope rename | envelope revision 4 + durable record; replay `duplicated: true`, envelope bytes frozen/equal |
| after blob, before command | blob durable but unreferenced; fresh retry commits exactly once |
| after envelope rename (new reference) | acked reference has durable bytes; replay `duplicated: true`; `readBlob` verifies after restart |

## Migration copy (acceptance A01/A09) — executed against the accepted fixtures

`migrateProjectCopy('demo-m1', 'demo-m1-v2')` on
`fixtures/m2/contracts/migration/v1-source` produces `project.json` and
`scenes/main.json` **byte-identical** to
`fixtures/m2/contracts/migration/expected-v2-destination` (asserted
byte-for-byte); the source project re-hashes identically before and after both
the successful call and a refused re-run. The interrupted destination
(`migration/interrupted-copy`, marker `phase: manifest`) is reported by the
startup scan with `migration: resume_required` and is **not** auto-completed;
resuming equals the expected destination and removes the marker.

## Fixture hashes (recomputed from committed bytes)

`raw/fixture-hashes.txt` records SHA-256 for every `fixtures/m2/storage/**`
file, the unchanged M1 `fixtures/commands/envelope/**` files, and the new
workspace sources. The storage index's own test recomputes every listed hash
(`packet 23 — fixture index …`).

- `blobs/alpha.bin` = `e0189bd4…76a20` (28 B)
- `blobs/beta.bin` = `bc592e7f…51cae5` (27 B)
- `project/scenes/main.json` = `e5939c88…d1bddf` (4 739 B, storageVersion 2)

## Contract-case execution status

`fixtures/m2/storage/expected.json` classifies every accepted
`fixtures/m2/contracts/cases/*.json`: 16 **executed** at this layer (existing
case files replayed as real workspace assertions — blob publication, ENOSPC,
full-disk, stage expiry/replay, harness staging, traversal/symlink, tamper,
missing blob, reimport/undo, concurrent stale import, ownership loss,
migration resume) and 1 **declarative** (`derived-cache-deleted-regenerable`,
whose regeneration needs packet 24's importer; the path/retention invariants
are exercised by the derived-cache test).

## Limitations / unverified

- Power-loss durability beyond `fsync` ordering (the accepted G2 device caveat)
  is not proven here.
- `inspectStage` (the `ImportProposal` return) is packet 24's `asset-pipeline`
  work; not exposed at packet 23 (contract-change request C23-1).
- `captureManifest` (dependencies.md §3.5) is not provided by the accepted
  project-model surface (contract-change request C23-2).
- `frame_bytes` (1 MiB) is a transport bound; the in-process `stageContent`
  API enforces `stage_bytes`/`open_stages`/`staged_bytes_per_project`
  (interpretation recorded).
