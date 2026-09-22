# Thirdlight — M3 v3 contract fixtures (packet 39)

**PROPOSED — not accepted.** These fixtures accompany the packet-39 proposals:

- [`docs/planning/m3-contracts/model.md`](../../../docs/planning/m3-contracts/model.md)
  — scene/storage v3 data model and version combinations (39-A), project-model §23
- [`docs/planning/m3-contracts/storage.md`](../../../docs/planning/m3-contracts/storage.md)
  — v3 envelope and the v2→v3 copy migration (39-A), workspace §16
- [`docs/planning/m3-contracts/authoring.md`](../../../docs/planning/m3-contracts/authoring.md)
  — the command/authoring surface and the authorability table (39-B)
- [`docs/planning/m3-contracts/diffs/`](../../../docs/planning/m3-contracts/diffs/)
  — the section-level diffs

Nothing in `docs/contracts/` is changed and nothing here is implemented. Gate K
records accept/reject per diff; a separate docs-only promotion applies accepted
rows before packet 44.

Machine-readable index: [`index.json`](index.json). Repeatable checks:
[`verification.md`](verification.md),
[`tools/check-fixtures.mjs`](tools/check-fixtures.mjs).

## Layout

```text
fixtures/m3/contracts/
  index.json                          fixture index: expected result/path/reason, sha256, byte length, code registry
  verification.md                     repeatable commands + negative control
  tools/check-fixtures.mjs            self-contained plain-Node checker (no dependency)
  source-preimages/                   real bytes whose SHA-256 the fixtures claim
    cue-start.wav                     real 48 kHz mono 16-bit PCM WAV, 96 samples (236 B)
    courier.glb                       opaque placeholder bytes (NOT a GLB)
  envelope/valid/                     byte-exact, fully valid v3 envelopes
    demo-0003-beacon-min-v3.json      every 39-owned v3 value (zones, spawns, camera, lights, game)
    demo-0003-fresh-v3.json           a fresh v3 project with content.game === null
    demo-0003-media-v3.json           audio/model assets, cue refs, modelAnimation (packet-41 placeholders)
  envelope/invalid/                   one rule isolated per file (19 files)
  catalog/audio-asset-record-v3.json  the audio AssetRecord kind (authoring row 18 / B12)
  migration/
    v2-source/                        a loadable v2 envelope + its manifest
    expected-v3-destination/          the exact v2→v3 copy outcome (identity + reset policy)
    interrupted-copy/                 marker present, NO envelope; resume/suppression case
  commands/
    scenario.{before,messages,after}.json   create/add/edit/remove + undo/redo, byte-exact
    no-change.json                    three no_change cases
    failures.json                     twelve reachable failures with code/path
```

## Conventions

- JSON fixtures are canonical: UTF-8, LF, 2-space indent, one trailing newline,
  no BOM, no trailing whitespace, and the declared key order of
  `model.md` §23.7 / `storage.md` §S3 (envelope
  `storageVersion, type, projectId, scene, content, retry`; content
  `assets, prefabs, behaviors, settings, behaviorTrust, game`; components in the
  §23.3 registry order). The checker verifies both bytes and key order.
- **Every digest is real.** `sourceDigest`/`sourceByteLength` values are the
  SHA-256/length of the committed files under `source-preimages/`, and the
  checker recomputes them. `courier.glb` is opaque placeholder content: no
  import-profile claim is made about it (packet 41/47 own the real media).
- **Packet-41 placeholders are marked.** The audio record's
  `importRecipe`/`metrics` (`profile: "pcm-wav"`, `recipeVersion: 0`, empty
  `toolchain`) and the `modelAnimation` role bindings
  (`{"binding": "packet-41-placeholder"}`) stand in for packet 41's WAV profile
  and `AnimationRoleBinding` fields. 39 owns only the discriminator, the cue
  assignment, the three role keys, requiredness and the byte bound; the checker
  therefore validates those and not the placeholder internals.
- Each invalid envelope fixture isolates **one** rule and declares exactly one
  expected `{ result, path, reason }`; the rules are re-derived independently by
  the checker (not compared against a second copy of the document).
- The command scenario is replayed from the recorded change data: revision
  arithmetic, derived-ID allocation, canonical created-entity values,
  inverse/redo equality and the final document. This is a contract-consistency
  replay, not the production `applyMutation`.

## Files excluded from the fixture index

`README.md`, `verification.md`, `index.json`, `tools/check-fixtures.mjs`.
