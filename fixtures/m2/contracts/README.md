# Thirdlight — M2 content-storage, asset & delivery fixtures (packets 15–19)

**PROPOSED — pending Gate E.** These fixtures accompany two proposal documents:

- [`docs/planning/m2-contracts/content-storage.md`](../../../docs/planning/m2-contracts/content-storage.md)
- [`docs/planning/m2-contracts/assets.md`](../../../docs/planning/m2-contracts/assets.md)

with the section-level diffs in
`docs/planning/m2-contracts/diffs/{project-model,workspace}.md`. Nothing in this
directory is implemented and nothing in `docs/contracts/` is changed: Gate E
records accept/reject per diff, and a separate docs-only promotion step applies
the accepted diffs before packet 20 (`docs/planning/m2-packets.md`, "Contract
drafting and promotion").

Machine-readable index: [`expected.json`](expected.json). Repeatable checks:
[`verification.md`](verification.md), [`tools/check-fixtures.mjs`](tools/check-fixtures.mjs).

## Layout

```text
fixtures/m2/contracts/
  expected.json                    machine-readable index + error-code registry
  verification.md                  repeatable verification commands
  tools/check-fixtures.mjs         consistency checker (no contract logic)
  source-preimages/                opaque placeholder bytes + digest index
  envelope/valid/                  byte-exact v2 envelopes (the only supported combination)
  envelope/invalid/                v2 envelope load-validation failures
  catalog/                         content-block and captured-content-view examples
  migration/                       v1 source, expected v2 destination, interrupted copy
  cases/NN-*.json                  declarative publish/staging/integrity/migration cases
  cases/constructed-cases.md       cases needing hundreds of records or large byte counts
  input/action-sequences.json      (packet 17) ActionFrame mapping, latch, suppression, replay
  physics/numerics.json            (packet 17) constants, tolerances, slope/settings/validation cases
  platformer/traces.json           (packet 17) step-indexed traces + numerical expectation tables
  platformer/failures.json         (packet 17) required failure paths and expected outcomes
  runtime/catchup.json             (packet 17) scheduler/drop/ownership/combination cases
  delivery/protocol-surface.json   (packet 19) routes, bridge messages and error→status mappings
  delivery/locator-cases.json      (packet 19) play-content locator expiry/authorization/negative cases
  delivery/upload-bounds.json      (packet 19) upload/stage bounds and malformed-frame cases
  delivery/scan-expectations.json  (packet 19) format-aware validation expectations
  delivery/manifest-example.json   (packet 19) one digest-bound runtime-content manifest + closure
  delivery/input-relay.json        (packet 19) bounded input-exercise relay cases
```

## Conventions

- Envelope and document bytes are canonical in the same sense as
  `fixtures/commands/` (workspace.md §4.4): UTF-8, LF, 2-space indentation, one
  trailing newline, no BOM, fixed key order. The v2 envelope key order is
  `storageVersion, type, projectId, scene, content, retry`; the content block is
  `assets, prefabs, behaviors, settings`.
- Envelope fixtures are standalone *documents*. The
  `projectId == directory name` check (workspace.md §4.3 step 5) is a load-time
  check and is not asserted by a single-file fixture.
- **Every digest is real.** `sourceDigest`/`sourceByteLength` values are the
  SHA-256 and length of the committed files under `source-preimages/`, and
  `tools/check-fixtures.mjs` recomputes them. The preimages are *opaque
  placeholder bytes*, not GLB files; no import-profile claim is made about them.
  The real GLB fixtures of the M2 profile belong to packet 24.
- `retry.records` is intentionally empty in the v2 envelopes: a content-publish
  record shape does not exist before packets 21/23, and retry-record semantics
  are already pinned byte-exactly by `fixtures/commands/envelope/*`. An empty
  block at a non-zero revision is the released state of workspace.md §9.
- `catalog/captured-content-view.json` carries a recomputable `contentDigest`
  (SHA-256 of the canonical JSON of the view with the `contentDigest` member
  removed). The checker recomputes it instead of trusting it.
- `migration/` records both the v1 source files and their SHA-256 values in
  `expected.json` (`sourceHashes`), which is how these fixtures express the
  original-preserving requirement: the migration must leave those bytes intact.
- Case fixtures (`cases/*.json`) are declarative — input state, ordered steps,
  expected outcome and the proposal sections they pin. Packet 23/24 turn them
  into executable tests; they are not executable tests themselves.
- Error codes used by any fixture must be declared in `expected.json.registry`,
  which is the accepted M1 code sets plus the codes these proposals add
  (`modelErrorCodes`, `workspaceErrorCodes`, `commandErrorCodes`,
  `runtimeErrorCodes`, `behaviorErrorCodes`, `sessionErrorCodes`,
  `exportErrorCodes`, `deliveryErrorCodes`, and the accepted
  `importDiagnosticCodes`).
- **Packet-19 fixtures are shape fixtures, not behaviour fixtures.**
  `delivery/*.json` pin routes/messages/error mappings, locator arithmetic,
  upload bounds, format-aware scan classification, the manifest's recomputable
  `buildId`/`buildOptionsDigest` and the input relay's step range. The checker's
  `p19-*` groups re-derive every expectation from the fixture's own inputs (TTL
  arithmetic, bound ordering, fault→code table) — they do not execute a server,
  a build or a browser. The accepted-contract sections they pin live in
  `docs/contracts/sessions.md`/`export.md` and the proposals in
  `docs/planning/m2-contracts/{delivery.md,diffs/*.md}`.
- **Packet-17 expectation tables are replayed twice.** The tables in
  `platformer/traces.json` and `physics/numerics.json` were produced by an
  independent `python3` reference implementation of the proposed controller,
  scripted port and scheduler
  (`docs/acceptance/evidence-m2/17/independent-recompute.py`), and
  `tools/check-fixtures.mjs` re-derives every row, constant and derived value
  with its own JavaScript implementation (check groups `p17-*`). A disagreement
  is a bug in the checker or the fixture, never a licence to change the proposal
  silently. The `platformer/traces.json` model is a *scripted analytic port*
  (flat ground plus axis-aligned statics) and is explicitly not the Rapier
  adapter: the real adapter is packet 31's and packet 32's evidence.`

## Backup and tamper notes these fixtures pin

- The authoritative set for a backup is the manifest, the envelope and **all**
  authoritative blobs under `sources/sha256/` — including superseded versions,
  because history, snapshots and retained retry records can still pin them
  (content-storage.md §11). Derived caches, staging, ownership/claim files and
  recovery snapshots are excluded.
- An external-source tamper is any change to a file under `sources/sha256/`.
  Because the path is the content address, a tamper is detected by hashing on
  every read (`blob_corrupt`), the bytes are retained byte-for-byte, and nothing
  is auto-repaired or auto-deleted (`blob-tamper-detected.json`).

## Tooling

```bash
# from the repository root
node fixtures/m2/contracts/tools/check-fixtures.mjs            # verify
node fixtures/m2/contracts/tools/check-fixtures.mjs --write    # canonicalize JSON fixtures
```

The checker contains a strict JSON parser with duplicate-key rejection, a
canonical-JSON digest helper and the fixture cross-references — it contains no
storage, import or publish logic. Where the checker and the proposal documents
disagree, the proposals win and the checker is a bug to fix.
