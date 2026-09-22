# Packet 05 review — accepted

Date: 2026-09-17. Reviewed implementation commit `097e560` (parent
`2ff892b`) and handoff-record commit `9287f7a` against packet 05
(implementation-prompts §05), docs/contracts/project-model.md (v0.2,
authoritative), docs/contracts/dependencies.md (§3/§4.1/§5/§7), and the
fixture index `fixtures/project-model/expected.json` (indexVersion 2) +
runtime case files. Independent review; the reviewer made no code, tool, or
contract changes and made exactly one docs-only commit (recorded below).

## Verdict

**Accepted — packet 05 complete.** The `@thirdlight/project-model` package
implements the §12.1 entry points, strict byte parsing (encoding → syntax →
duplicates → value, in normative order), total boundary validation, the
§12.2 canonical serializer (byte-stable, idempotent, golden-byte exact), and
the §12.4 migration entry points. 234/234 tests re-verified on the real tree
**and** in a clean `npm ci` disposable copy; 113/113 independent probes on
hand-crafted inputs the implementer's suites do not pin all behave per the
contract text. **No P1 findings** — no check or behavior that is wrong or
silently passes. Four non-gating P2 observations (N1–N4) recorded below.
Nothing was pushed.

## Provenance (verified)

- HEAD `9287f7a`; `git show 097e560 --stat`: 19 files, +3760/−1 — the
  `packages/project-model/` package (9 source, 4 test, 3 config files),
  `package-lock.json` (workspace registration, no new dependency), handoff
  05, and the STATUS row. No renderer/UI/server/command code.
- `git show 9287f7a --stat`: one line in `docs/handoffs/05.md` (commit-ID
  record). Docs-only, per precedent.
- Working tree at start: one unrelated uncommitted change
  (`docs/orchestration.md`) — preserved, not staged.

## Re-verified workspace checks (real tree, real CLIs)

| Command | Result |
|---|---|
| `npm run check-deps` | exit 0 — pins match §7 (esbuild 0.28.2, typescript 5.9.3, vitest 5.0.1); "declared dependency specs: all exact versions (no ranges)" |
| `npm run check-boundaries` | exit 0 — "1 package(s) [project-model], 14 source file(s), 31 specifier(s) checked; no boundary violations" (tests included; no Node builtins leaked) |
| `npm run typecheck` | exit 0 — `tsc --noEmit -p packages/project-model` (strict base) |
| `node tools/build.mjs` | exit 0 — "no bundle entries present yet" (expected until packets 10/12) |
| `npm test` | exit 0 — **234/234** (8 files: 4 project-model + 4 tools; 93 + 141 split matches the handoff) |

## Independent probes (not covered by the implementer's suites)

113 hand-crafted probes against the real public exports
(`packages/project-model/src/index.ts`), bundled from source with the pinned
esbuild and run with real exit codes in a disposable `/tmp` workspace — no
mocks. All passed:

- **Strict-JSON bypass forms (byte input):** `01` / `-01` / `00.5` integer
  leading zeros → exactly one `json_parse_error` (V8 ground truth: all
  syntax errors); RFC-legal `1e01` / `1e999999999999999999999` accepted as
  tokens (overflow → `number_not_finite`, not a syntax error); trailing
  values (`[1,2] [3,4]`, `{} null`, `1 2`), trailing comma, missing comma,
  truncated string, truncated mid-escape (`"\u12`), bare `-`, `1e`, `NaN`
  token → each exactly one `json_parse_error` at `""`.
- **Duplicate keys below the pinned levels:** duplicate `position` inside
  `transform` → `duplicate_key` at `/entities/0/components/transform/position`
  with decoded name in `found`; triple `material.color` → single error at
  the first repeat; duplicate + unknown version → duplicate only (parse
  precedence).
- **Numeric semantics:** `1e308` (finite) → `number_out_of_range`, `±1e400`
  → `number_not_finite`; `|v| = 1e6` accepted, `1000001` rejected; scale
  exactly `1e6` accepted; `fovY` 180/0 rejected; `far ≤ near` rejected;
  revision `MAX_SAFE_INTEGER` ok / `2^53` / `-1` / `0.5` →
  `revision_invalid`.
- **Quaternions:** `[0,0,0,-1]` accepted with sign preserved (no sign-flip);
  norm diff `9.99e-5` accepted, `2e-4` rejected (tolerance boundary);
  `[1,0,0,0]` accepted; zero quaternion rejected.
- **`-0` byte input:** parsed valid, normalized to `+0`
  (`Object.is(p0, 0)`), and serialized bytes contain no `-0`.
- **Hierarchy/limits boundaries:** depth exactly 32 ok / 33 →
  `limits_exceeded` (`limit: "depth"`); 1024 entities ok / 1025 →
  `limits_exceeded` (`limit: "entities"`); empty `entities` → exactly one
  `camera_count_invalid` (the §8.1 lower bound surfaces via §10.3, as the
  contract's limit table supports); self-parent found `["a"]`, a↔b cycle
  found `["a","b"]` in walk order; child-before-parent without cycle →
  `order_parent_before_child` only; duplicate ID at the later occurrence.
- **Strict fields at every level:** unknown field at scene root, entity,
  transform, box material, camera, and manifest scene-ref each →
  `field_unexpected` at the exact pointer; nothing stripped.
- **Contract-text alignment (not just the index):** `quaternion_invalid`
  message/expected/hint byte-match the §12.5 example; `schema_version_
  unsupported` carries `found`, `knownVersions: [1]`, and newer/older
  action hints naming known versions and retention; missing `schemaVersion`
  → single unsupported-version error (no `field_missing`); leap-century
  timestamps (1900-02-29 rejected, 2000-02-29 accepted); `engineVersion`
  build metadata rejected per the §6 regex; `ERROR_CODES` is exactly the
  24 §12.6 codes; `KNOWN_VERSIONS` = `[1]`; `validateProject` both-v2 →
  two errors, manifest then scene, tagged; single-doc results carry no
  `document` discriminator; `migrate*` identity / `no_migration_path`
  shapes per §12.4; input bytes byte-identical after failing parses
  (BOM, malformed UTF-8); `validate*` total over `undefined`/`null`/
  scalars/arrays (no throw).
- **Serialize stability:** scrambled key order (scene, entity, component,
  transform, camera, manifest, scene-ref) → byte-identical canonical output;
  explicit defaults vs omitted defaults → byte-identical; key order in the
  emitted text matches §12.2 rule 4 exactly; `parentId: null` and absent
  `name` not emitted; `#ABCDEF` → `#abcdef`; one trailing LF, no trailing
  spaces, no BOM; parse → serialize → reparse → serialize byte-identical;
  parse of `valid/quaternion-round-trip.json` serializes byte-identical to
  the golden `expected/quaternion-round-trip.json`.

## New findings (non-gating)

**N1 — P2: public surface carries one extra function export.**
`index.ts:36` re-exports `parseDocumentBytes` (and the `ByteParse` type)
from `parse-bytes.ts`. dependencies.md §3 names the `.` subpath as
"the project-model.md §12.1 entry points: types, parse*, validate*,
normalize*, migrate*, serializeCanonical, ERROR_CODES, KNOWN_VERSIONS";
§12.1 declares exactly two byte entry points (`parseManifest`,
`parseScene`). `parseDocumentBytes` is the internal pass-1 helper exposed
as a third public entry point. Behavior is correct and nothing consumes it
yet; repair (when convenient): drop it from `index.ts` (it remains
reachable internally) or record the addition in a later contract diff.
Non-blocking.

**N2 — P2: `serializeCanonical` dispatches document kind heuristically.**
`normalize.ts:31–40` treats any object carrying an own `sceneId`/`entities`
property as a scene, else a manifest. Correct for every valid document
(a valid scene always has both fields; a valid manifest has neither) and
the code documents the choice; an *invalid* document of the wrong shape
may be validated under the other kind (still a §12.5 error result, never a
thrown exception). Recorded as an observation; no action required in M1.

**N3 — P2: wrong-length array errors report the length, not the value.**
`checkVector` (validate.ts, position/rotation/scale/size) and the manifest
`scenes` length check set `found` to the numeric length (probed: `3` for a
3-element rotation). §12.5 says `found` is "the offending value (present
when it exists and is bounded)" — the array itself is bounded. Cosmetic
deviation; error code/path/expected are all correct.

**N4 — P2: handoff 05 misnames the exported public types.** The handoff
lists `ComponentMap`, `MaterialComponent`, `SceneSummary`; the actual
`index.ts` type exports are `BoxComponent`, `BoxMaterial`,
`CameraComponent`, `Entity`, `EntityComponents`, `Manifest`, `Quat`,
`Scene`, `SceneRef`, `TransformComponent`, `Vec3` (plus the errors types).
Documentation-accuracy note only; the real surface is the authoritative one.

## Evidence, scope, and next action

- Host: Node `v22.22.1`, npm `9.2.0`; pinned TypeScript 5.9.3, esbuild
  0.28.2, vitest 5.0.1 (all registry-installed via the lockfile).
- Real tree: the five workspace commands above (all exit 0, 234/234).
- Probes: `/tmp/tl-probe-05` (esbuild bundle of the probe against the real
  `index.ts`; real `node` exit codes; 113 passed / 0 failed). Disposable
  workspace removed after review; no repository fixtures added or left.
- Clean copy: `git archive 9287f7a | tar -x -C /tmp/tl-clean-05`,
  `npm ci` exit 0 ("found 0 vulnerabilities"), `npm test` **234/234**, exit
  0. Disposable copy removed after review.
- **Not verified (honest limits):** no visual behavior exists for this
  packet (pure model layer — nothing to browser-verify); envelope
  persistence is packet 07; the P2 items above are deferred, not waived.
- Review-only diff: this report, a short verdict note at the top of
  `docs/handoffs/05.md`, and packet 05's row in `docs/STATUS.md`. No
  implementation, tooling, or contract changes. Verdict accepted ⇒
  committed as **one docs-only review commit**: message `Packet 05 review:
  accepted (05-review.md, handoff note, STATUS row)`.
- No reviewer approval is claimed beyond this record.
- Next action: **packet 06 — Pure commands and history** (prerequisite 05
  now met; not started, not auto-cleared). Gate B stays **pending** until
  packet 07 is reviewed and accepted.