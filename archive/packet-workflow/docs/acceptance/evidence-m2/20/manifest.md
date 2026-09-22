# Packet 20 evidence — Model v2 and pure migration

2026-09-18. Owner pre-approval: **owner pre-approval (autonomous M2 build
instruction, 2026-09-18); final manual review pending.** No commit made.

Every artifact here is sanitized (no credentials, no host paths, no tokens).
All commands were run from the repository root with the recorded toolchain
(Node 22.22.1, TypeScript 5.9.3, vitest 5.0.1, esbuild 0.28.2).

## Claim → artifact

| Claim | Artifact |
|---|---|
| The six root checks are green | `full-tests.txt` (67 files / 884 passed), `typecheck.txt`, `check-deps.txt`, `check-boundaries.txt` (10 pkgs / 156 files / 546 specifiers), `build.txt` (4 built), `check-fixtures.txt` (33/33, exit 0) |
| Packet-20 unit + fixture regression suite (43 tests) | `project-model-tests.txt` (6 files / 147 passed) |
| Approved valid fixtures round-trip byte-exactly | `roundtrip-hashes.txt` — committed sha256 == canonical sha256, `byte-identical=true`, for `valid/scene-v2.json` and `valid/content.json` |
| Migration retains the source and IDs | `roundtrip-hashes.txt` — `migration/scene-v1-input.json` sha256 recorded; the conversion deep-equals `migration/scene-v2-expected.json` (same sceneId/revision/entity IDs) |
| Pure SHA-256 and the captured-content digest agree with an independent implementation | `independent-recompute.txt` — `project-model`'s pure `sha256.ts` matches `node:crypto` on 5 fixed vectors; the captured-view `contentDigest` `e85de67f…63fe6` recomputed by `node:crypto` equals the value asserted in `m2-model.test.ts` |
| C19-D7 closed and the promoted M2 fixtures validate | `independent-recompute.txt` §2 — both promoted v2 envelope fixtures' scene + content pass `validateSceneV2`/`validateContent` after `behaviorTrust` was added; `check-fixtures.txt` stays 33/33 |

## Test counts

- Project-model: 104 (M1) → 147 (+43 packet-20 tests); the M1 fixtures
  (`fixtures/project-model/**`) are unchanged and still pass.
- Repository: 841 → 884 tests, 66 → 67 test files.
- `valid/**` fixtures are byte-identical to their canonical serialization;
  `invalid/**` fixtures fail with exactly the pinned code set and their bytes
  are retained unchanged (asserted by the suite).

## Not claimed

- No browser/GPU/WASM/video/frame-timing evidence (none is in packet 20's
  scope). The physics selection remains PROVISIONAL per decision 0002.
- No independent reviewer approval. The recompute above is a second
  implementation of the digest, not a review.

## Recorded deviations

- `fixtures/project-model/**` is byte-unchanged. Two assertions in the M1 test
  file `api-behavior.test.ts` were updated because the binding contract §12.1
  changes `KNOWN_VERSIONS` from `[1]` to the per-document structure and §12.6
  extends `ERROR_CODES`; all other M1 behavior and data fixtures are unchanged.
- Contract-change requests C20-1 (v2 scene validator naming) and C20-2
  (explicit M1→M2 conversion entry point) are recorded in `handoffs/20.md`.
