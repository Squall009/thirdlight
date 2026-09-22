# Thirdlight — M3 storage fixtures (packet 46)

Committed on-disk states for the durable v3 workspace and the v2→v3 copy
operator. Contract: [`docs/contracts/workspace.md`](../../../docs/contracts/workspace.md)
§16 (storage v3 and the v2→v3 copy migration); §5 (durability) and §4
(envelope) are exercised unchanged.

Nothing here is an implementation: the fixtures are plain JSON documents plus
one real `sources/sha256/<digest>` blob reference. Packet 46's implementation
lives in `packages/workspace/**` and executes these bytes through the real
service (see `tests/crash/m3-storage-crash.test.ts`,
`packages/workspace/tests/m3-{storage,migration}.test.ts`).

Machine-readable index: [`index.json`](index.json). Repeatable checks:
[`verification.md`](verification.md),
[`tools/check-fixtures.mjs`](tools/check-fixtures.mjs).

## Layout

```text
fixtures/m3/storage/
  index.json                              byte length + SHA-256 of every fixture
  README.md / verification.md
  tools/check-fixtures.mjs                self-contained plain-Node checker
  project-v2-demo-0002/                   a real-pipeline-loadable v2 source
    project.json                          schemaVersion 1, id demo-0002
    scenes/main.json                      storageVersion 2, scene schemaVersion 2,
                                          5-key content, empty retry, one model asset
                                          (publishedRevision 2), settings.run_speed 5
  project-v3-demo-0003/                   a real loadable v3 project
    project.json                          schemaVersion 1, id demo-0003
    scenes/main.json                      storageVersion 3, scene schemaVersion 3,
                                          6-key content, non-null game block
  cases/migration.json                    §16.5 operator/marker/report/refusal facts
  cases/durability.json                   §5.3 ack timing, crash points, single-file rule
  cases/media.json                        typed prepared-media facts, copy-safe byte reads
```

## Provenance

- `project-v3-demo-0003/scenes/main.json` is byte-identical to the committed
  packet-39 `fixtures/m3/contracts/envelope/valid/demo-0003-beacon-min-v3.json`
  (`a932b05a…be9414`); its manifest is a minimal v1 manifest with the same id.
- `project-v2-demo-0002/project.json` is byte-identical to the committed
  packet-39 `fixtures/m3/contracts/migration/v2-source/project.json`. Its
  envelope carries the same scene and content but **empty** `retry.records`:
  the packet-39 source's single record carries the stub `result: { "ok": true }`,
  which is not a valid `commands.md` §5.1 success payload and is therefore not
  loadable by the real v2 pipeline (`workspace.md` §4.3 step 7). The storage
  fixture is the corrected, real-pipeline-loadable copy; the defect in the
  contracts fixture is recorded as a packet-46 contract-change request (see
  `docs/handoffs/46.md`). The destination derivation is unchanged: the operator
  clears `retry.records` in the destination (the contracts destination fixture
  is byte-identical to what this source produces).
- The one blob referenced by the v2 source
  (`ec535bb2…4ecc`, 47 B) is the committed
  `fixtures/m3/contracts/source-preimages/courier.glb`. It is not copied into
  this fixture tree (the tree holds authoring state, not blob bytes); the
  implementation tests seed it from the contracts preimage and the checker
  cross-checks the contracts destination fixture.
- Every byte under `fixtures/m3/storage/**` is original, self-authored content
  generated from literal data for this packet. No third-party asset, no
  credential, no user project.
