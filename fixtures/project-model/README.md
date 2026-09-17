# Fixtures — project-model (packet 01)

Companion to `docs/contracts/project-model.md`. These fixtures are part of the
contract: changing a fixture or its expected codes requires the same review as
the contract text (contract §17).

## Layout

```text
fixtures/project-model/
  expected.json                     ← machine-readable index (packet 05 input)
  README.md
  valid/
    demo-project/                   ← full valid project (manifest + scene)
      project.json
      scenes/main.json
    minimal-scene.json              ← valid scene == §15 default scene
    defaults-omitted.json           ← valid; all defaulted fields omitted
    quaternion-round-trip.json      ← preserved q/-q and near-unit rotations
  invalid/
    duplicate-ids.json
    hierarchy-cycle.json
    missing-reference.json
    invalid-numbers.json
    unknown-component.json
    two-cameras.json
    missing-transform.json
    unsupported-version.json        ← future schemaVersion (2)
    unsupported-version-past.json   ← past schemaVersion (0)
    non-strict-json.json            ← INTENTIONALLY invalid JSON syntax
    duplicate-key.json              ← escaped duplicate; JSON.parse misses it
    numeric-overflow.json           ← valid numeric tokens overflow to ±Infinity
    mixed-schema-versions/          ← v1 manifest + v2 scene; precedence
      project.json
      scenes/main.json
    manifest-scene-mismatch/        ← project-level failure (2 files)
      project.json
      scenes/main.json
  expected/
    quaternion-round-trip.json      ← exact canonical output (golden bytes)
  runtime/
    non-finite-cases.md             ← in-memory cases and overflow distinction
    byte-input-cases.md             ← encoding/parse/project precedence cases
  verification.md                  ← repeatable fixture checks; not a validator
```

## How packet 05 must use this

1. `expected.json` (indexVersion 2) is the single source of truth for file
   fixture expectations. Run file bytes through `parseManifest` / `parseScene`;
   project entries use the **interchange** composition in contract §13, not
   active-workspace envelope loading. `expectedCodes` is the exact set of
   returned codes. Also assert `expectedErrorCount` and the ordered
   `expectedErrors` code/path/document projections when provided. Unexpected
   codes are defects, never silently absorbed.
2. For every `valid` entry: validation passes; the normalizer produces a
   canonical document that (a) re-validates and (b) is byte-identical on a
   second normalization pass, including serialized/reparsed round-trip
   (idempotence, contract §12.2 rule 7). Where `expectedNormalized` exists,
   compare canonical output bytes with that golden file. Rotation components
   must be preserved, not divided by their norms; negative zero becomes zero.
3. `valid/minimal-scene.json` must be content-identical to the default
   creation scene in contract §15.
4. Exercise the directly constructed runtime cases in
   `runtime/non-finite-cases.md` as in-memory values, and the encoding and
   precedence cases in `runtime/byte-input-cases.md` through the byte APIs.
5. Existing fixtures remain **standalone logical documents**. Packet 07 must
   construct a workspace envelope around a scene for persistence integration
   tests; copying these scene files directly into active storage is not a
   supported workspace initialization procedure.

The repeatable checks in `verification.md` verify fixture construction and
review counterexamples only. They are not a substitute for packet 05's real
parser/validator/normalizer integration tests.

## Notes

- `invalid/non-strict-json.json` is **deliberately unparseable** by a strict
  JSON parser (it contains `NaN`/`Infinity` tokens). It exercises the
  `json_parse_error` path and the retain-original-bytes rule. Do not "fix"
  it; `JSON.parse` must reject its syntax. Conversely, `JSON.parse` accepts
  duplicate keys by discarding earlier values, so it alone is **not** a
  conforming Thirdlight byte parser. It also accepts numeric overflow; that
  is caught by subsequent per-value finite-number validation.
- `invalid/hierarchy-cycle.json` expects **two** codes: a cyclic hierarchy
  necessarily violates the parent-before-child array invariant as well
  (contract §11.1–§11.2), so `hierarchy_cycle` and
  `order_parent_before_child` both fire.
- `valid/demo-project/` is a *project-level* fixture: the directory name is
  not required to equal the manifest `id` ("demo-0001") — the
  directory-name-equals-project-id rule is enforced by the workspace layer
  (packet 07), not by the data validator (contract §5.3, §13).
- All fixture timestamps are fixed constants (no generated data), keeping
  the fixtures diff-stable.