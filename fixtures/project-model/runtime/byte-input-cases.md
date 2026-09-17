# Constructed byte-input cases — project-model

Normative packet 05 tests for contract §12.1–§12.3 and §13. Use the actual
`parseManifest` / `parseScene` exports, not `JSON.parse` followed by validation.
These constructors keep intentionally malformed UTF-8 out of text fixtures.
`utf8(text)` means `new TextEncoder().encode(text)`. Take `valid` from the
unaltered bytes of `valid/minimal-scene.json`. Keep a copy of each input and
assert byte equality after every call, including failure. Error counts below
are exact; error messages/hints must additionally satisfy the contract.

| Case | Input to `parseScene` | Expected result |
|---|---|---|
| B1 | `valid` | success; same normalized value as `validateScene(JSON.parse(decodedValid))` |
| B2 | `Uint8Array.from([0xef, 0xbb, 0xbf, ...valid])` | one `encoding_invalid`, path `""` (leading BOM must not be silently stripped) |
| B3 | `Uint8Array.from([...utf8('{"name":"'), 0xc3, 0x28, ...utf8('"}')])` | one `encoding_invalid`, path `""`; do not replace malformed UTF-8 with U+FFFD |
| B4 | `utf8('{"schemaVersion":2,"schemaVersion":1,}')` | one `json_parse_error`, path `""`; syntax takes precedence over duplicates and version checking |
| B5 | bytes of `invalid/duplicate-key.json` | one `duplicate_key`, path `/schemaVersion`; compare decoded key names |
| B6 | `utf8('{"schemaVersion":2,"future":{"a/b~":0,"a\\u002fb~":1}}')` | one `duplicate_key`, path `/future/a~1b~0`; nested duplicates precede unsupported-version checking; JSON Pointer escaping is required |
| B7 | `valid` with one ASCII `0x20` appended | success; input whitespace need not already be canonical |
| B8 | `valid` with `utf8(' null')` appended | one `json_parse_error`, path `""` (trailing value) |
| B9 | bytes of `invalid/numeric-overflow.json` | two `number_not_finite` errors at `/entities/0/components/transform/position/0` and `/entities/0/components/transform/position/1`; syntax is valid |
| B10 | bytes of `valid/demo-project/scenes/main.json` | success; repeated `id` / `components` names in separate objects are not duplicates |
| B11 | B3 bytes prefixed with BOM | one `encoding_invalid`, path `""`; no additional error from schema/JSON parsing |

## Project version precedence and error attribution

Use copies of the valid demo manifest and scene. `validateProject` takes
values; the interchange composition in §13 starts with their bytes. Exercise
both routes with the following changes. Expected errors are the complete
ordered list (code, document, path):

| Change | Expected errors |
|---|---|
| Scene version `2`, scene ID mismatched, required fields absent | `schema_version_unsupported`, `scene`, `/schemaVersion` (the committed `invalid/mixed-schema-versions/` case) |
| Manifest version `2`; leave scene valid | `schema_version_unsupported`, `manifest`, `/schemaVersion` |
| Both versions `2` | `schema_version_unsupported`, `manifest`, `/schemaVersion`; then `schema_version_unsupported`, `scene`, `/schemaVersion` |
| Manifest version `2`; remove scene `revision` | `schema_version_unsupported`, `manifest`, `/schemaVersion`; then `field_missing`, `scene`, `/revision` |
| Scene version `0`; leave manifest valid | `schema_version_unsupported`, `scene`, `/schemaVersion` |

No case emits `schema_mixed_versions`: that code is not part of M1. Unsupported
versions stop only their own document's value validation, not the other
independent document's validation. No ID comparison follows a document failure.

For the byte composition, also pair a valid manifest with
`invalid/duplicate-key.json`: expect one `duplicate_key`, `scene`,
`/schemaVersion`; no cross-document checks follow a parse failure.
