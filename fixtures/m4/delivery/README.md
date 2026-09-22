# fixtures/m4/delivery — packet-64 M4 delivery fixtures

Self-generated, deterministic fixture set for the **PROPOSED** M4 delivery
contract (`docs/planning/m4-contracts/delivery.md`, Gate Q). It specifies
the observable rendered and numeric expectations, the load-order/failure
outcomes, the query shapes/errors and the per-bundle graph/scan rows that
packets 69/70/71 implement and evidence.

**Provenance.** Every byte is original generated content: no downloaded
asset, no third-party byte, no license asserted over external material.
The GLBs are minimal valid glTF 2.0 GLB containers built by the committed
generator (no dependency, no network, no eval). Re-running the generator
reproduces every byte exactly:

```sh
node fixtures/m4/delivery/tools/generate-fixtures.mjs          # (re)write
node fixtures/m4/delivery/tools/generate-fixtures.mjs --check  # verify bytes
node fixtures/m4/delivery/tools/check-fixtures.mjs             # independent re-derivation
```

The checker independently re-derives every fixture fact (GLB container
facts, index digests, the manifest fragment's digest identity and ready
tuple, the selector/crossfade math, the query maps, the committed-fixture
summary, closed-code membership) and **exits non-zero on any mismatch**.
Deliberate-corruption negative control (verified 2026-09-22): copying this
tree to a temp dir and flipping one byte of `glb/runner-m4.glb` makes the
checker exit 1 with three independent detections (container parse failure,
index digest mismatch, manifest identity mismatch).

## Layout

| File | Purpose |
|---|---|
| `glb/runner-m4.glb` | positive rigid 3-clip profile (`Idle`/`Run`/`Airborne`, 2 meshes, no skin, no root translation, rotation channels on the non-root node) |
| `glb/bad-root-motion-m4.glb` | A6 negative — a translation channel on the scene root node (`animation_root_motion`) |
| `glb/bad-skin-m4.glb` | A2 negative — a `skins` array + `node.skin` (`animation_skin_unsupported`) |
| `glb/undeclared-m4.glb` | a VALID GLB the case manifest does **not** declare (the undeclared-fetch negative) |
| `glb/corrupt-m4.glb` | the runner GLB truncated to 60% (declared total ≠ file length — the L2/L3 hard failure) |
| `cases/model-attach-cases.json` | realization/animation expectations (holder parenting, per-instance independence, role-selection boundaries, non-player neutral pinning, crossfade weights, static-on-unresolved, ownership-counter baseline) |
| `cases/load-order-cases.json` | the both-host loading order + the L1–L9 failure-injection table + the pinned-reimport no-op + the self-consistent manifest fragment (every digest re-derivable) |
| `cases/query-cases.json` | the `querySettings` shapes/errors (explicit vs resolved, registry order, v1), the accepted `queryProject` content summary (incl. the committed v3 fixture's expected counts, re-derived by the checker) and the MCP/client parity rules |
| `cases/scan-graph-cases.json` | the per-bundle graph + scan rows (the M3 bundles gain the `three-adapter` `./gltf-loader` subpath; the M1/M2 bundles stay loader-free) + the negative controls |
| `index.json` | byte length + SHA-256 of every data file (the checker verifies) |

## Identity note

The `load-order` manifest fragment's digests (scene/content/game/
settings/media/build) follow the accepted block-digest rule (sessions.md
§17.1.1: `sha256(JSON.stringify(value, null, 2) + "\n")` over the declared
canonical key order; `null` hashes the four bytes `null`). They are
fixture-internal self-consistency values — the real play-build path (the
actual scene-document canonicalization of project-model §12.2) is
exercised by the packet-70 browser evidence, not by this fixture.