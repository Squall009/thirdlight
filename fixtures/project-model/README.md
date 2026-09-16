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
    non-strict-json.json            ← INTENTIONALLY invalid strict JSON
    manifest-scene-mismatch/        ← project-level failure (2 files)
      project.json
      scenes/main.json
  runtime/
    non-finite-cases.md             ← NaN/±Infinity cases (in-memory only)
```

## How packet 05 must use this

1. `expected.json` is the single source of truth for fixture expectations.
   For every `invalid` entry: run the relevant entry point
   (`validateManifest` / `validateScene` / `validateProject`) and assert that
   **all** listed `expectedCodes` are present. Any **unexpected** additional
   code is a defect to report (fixture or implementation), never silently
   absorbed.
2. For every `valid` entry: validation passes; the normalizer produces a
   canonical document that (a) re-validates and (b) is byte-identical on a
   second normalization pass (idempotence, contract §12.2 rule 7).
3. `valid/minimal-scene.json` must be content-identical to the default
   creation scene in contract §15.
4. Runtime cases in `runtime/non-finite-cases.md` are exercised as in-memory
   objects in the test suite (JSON cannot encode them).

## Notes

- `invalid/non-strict-json.json` is **deliberately unparseable** by a strict
  JSON parser (it contains `NaN`/`Infinity` tokens). It exercises the
  `json_parse_error` path and the retain-original-bytes rule. Do not "fix"
  it; a strict `node:JSON.parse` (or any RFC 8259 parser) must reject it.
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