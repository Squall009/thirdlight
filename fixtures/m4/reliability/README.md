# fixtures/m4/reliability — packet-67 M4 reliability fixtures

Self-generated, deterministic fixture set for the **PROPOSED** M4
reliability contract (`docs/planning/m4-contracts/reliability.md`, Gate Q).
It specifies the consistent-backup manifest (re-derived from the committed
v3 fixture), executes every backup/restore refusal case through a reference
implementation of the §1–§2 procedures, pins the same-ID vs new-ID
transforms, the F1–F8 fault matrix, the diagnostic report envelope, and the
67-B budget protocol with its digest-frozen scenes and the (entirely
BLOCKED) threshold table.

**Provenance.** All digests are re-derived from committed bytes (the v3
fixture, the Beacon Reach captured project) or from a deterministic engine
replay (S3 — the packet-65 recipe through the real `@thirdlight/commands`
engine). No third-party bytes. The 67-B numerical thresholds are **blocked,
unmeasured** — never invented (reference-device.md §2/§3: no representative
hardware in this container; the owner device decision is pending).

## Run

```sh
npx tsx fixtures/m4/reliability/tools/generate-fixtures.mts          # (re)write
npx tsx fixtures/m4/reliability/tools/generate-fixtures.mts --check  # verify bytes
npx tsx fixtures/m4/reliability/tools/check-reliability.mts          # independent re-derivation + case execution
```

The checker is **independent of the generator**: it re-derives the backup
example and the transform cases from the live committed bytes; it **runs
every §2 refusal case (R1–R8) through its own reference implementation** of
the §1–§2 procedures (backup/verify/restore/create) against temp trees and
asserts both the exact refusal code and that **the originals are
byte-identical after every refusal** (the acceptance obligation); it
verifies the fault matrix, the health envelope's bounds/redaction/cases, and
the budget tables (S1/S2 from committed bytes; **S3 by a second independent
engine replay** — generator and checker must agree; every threshold row
marked blocked); it re-hashes `index.json`. Deliberate-corruption negative
control (verified 2026-09-22): a tampered scene digest makes the checker
exit 1 (two independent detections: the S1 re-derivation + the index row).

## Layout

| File | Purpose |
|---|---|
| `cases/backup-example.json` | the §1.3 backup-manifest shape on the committed v3 fixture (real bytes + digests; the consistent set of workspace.md §15; `retention: "manual"`) |
| `cases/refusal-cases.json` | the 8 refusal cases (truncated file, bad hash, missing catalog blob, missing **superseded** blob, ownership-included, nonempty destination, symlink/path escape, live-project) with the exact codes + the original-preservation assertions |
| `cases/transform-cases.json` | same-ID restore (no transform) vs new-ID creation (the exact 3-field identity rewrite, byte-exact old/new values) — the "distinct operations" rule |
| `cases/fault-matrix.json` | the F1–F8 normative matrix (the accepted machinery + the 65/66/67 fault points) + the no-ready-partial (C09) invariant |
| `cases/health-envelope.json` | the §3 diagnostic report: the shape, the bounds (32 KiB / 100 / 32), the redaction rules, the overflow/redaction/stale-identity cases |
| `cases/budget-tables.json` | 67-B: the named device (BLOCKED placeholder), the 3 frozen scene digests (S1/S2/S3), the measurement protocol (warmup, N ≥ 30, median+p95, the environment record, the 7 closed metrics), and the threshold table with **every row `BLOCKED — unmeasured`** |
| `index.json` | byte length + sha256 of every data file |

## Identity note

The checker's reference implementation is a **spec-level reference** (the
production tool ships with the packet-75/79 tooling — CCR-67-1): it exists
to prove the fixture cases, not to be the product. The S3 scene identity is
the sha256 of the canonical envelope serialization
(`{storageVersion,type,projectId,scene,content,retry}`, 2-space JSON,
trailing newline) of the deterministic recipe replay — both the generator
and the checker replay the recipe independently and must agree. The
superseded-blob rule: a catalog version is `superseded: true` iff a higher
version exists in the same catalog (the §15 "every file, including
superseded versions" rule); a single-version missing blob is
`superseded: false`.