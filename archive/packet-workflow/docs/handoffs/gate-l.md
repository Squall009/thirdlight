# Gate L — fresh architectural review of packets 44–48 (M3)

**Verdict: BLOCKED — one P1 (GR-L-1).** Everything else at this gate is green:
the full toolchain, every M3 checker and every deliberate-corruption control, the
independent re-derivation of packets 44–48, and the reopened-section re-review
except for the one bound GR-L-1 breaks.

**This is a session review** — a fresh read-only reviewer subsession that wrote
none of the work. It is **not owner approval and not an independent human
review**, and it is recorded under the owner's M3 execution authorization. No
contract, fixture or product file was edited to make a check pass; the only
artifact written is this file.

## 1. Scope

Packets 44–48 and the two bounded repairs (`repair-cc46-1.md`,
`repair-cc48-1.md`), on the current working tree (`5b746ee` + the uncommitted
M2/M3 work), plus the owed **fresh re-review** of the reopened sections
(`repair-cc44-3-4.md`): `workspace.md` §16.5.1/§16.5.2 and `project-model.md`
§12 step 5, §13.2 rule 5, §18.9.2 rule 4, §22.2 rule 4, §23.11.

## 2. Commands re-run (actual results)

| Command | Result |
|---|---|
| `npm test` | **exit 0 — 147 files / 1866 tests passed** (40 s) |
| `npm run typecheck` | exit 0 (15 packages) |
| `npm run check-deps` | exit 0 (all exact pins) |
| `npm run check-boundaries` | exit 0 — 15 packages, **297 files / 1167 specifiers, 0 violations** |
| `npm run build` | exit 0 — 4 built, 0 skipped |
| `node fixtures/m2/contracts/tools/check-fixtures.mjs` | exit 0 — **34/34** |
| `fixtures/m2/{course,input,physics,runtime}` checkers | exit 0 |
| `fixtures/m3/contracts` checker | exit 0 — **39 groups** |
| controls A/B (byte, key-order) | **exit 1** each, expected checks fire |
| controls C/D (repaired §16.5.1 / §16.5.2 defect classes) | **exit 1** each, expected `[migration]` checks fire |
| CC-46-1 control (`{ok:true}` retry stub restored) | **exit 1** — `source /retry/records/0/result must carry a known op string` |
| `fixtures/m3/gameplay` checker | exit 0 — **23 groups / 127 checks** |
| gameplay manual corruption | **exit 1** — **13 failures in 7 groups** (matches the recorded transcript) |
| `fixtures/m3/media` checker | exit 0 — **13 groups / 115 checks**; `--corrupt-control` **9/9 detected** |
| `fixtures/m3/media/.../generate-fixtures.mjs --check` | exit 0 — **65 files reproduce exactly** |
| `fixtures/m3/delivery` checker | exit 0 — **16 groups / 153 checks**; control both corruptions exit 1 |
| `fixtures/m3/storage` checker | exit 0 — **9 groups / 10 checks**; control **6/6 detected** |
| `fixtures/m3/audit/check-audit` + `check-promotion` | exit 0; controls: 3 and 4 corruptions each detected |
| `npx vitest run tests/integration/m3-content/` | exit 0 — 3 files / **37 tests** |

Independent execution used the real modules (esbuild-bundled probes over
`packages/*/src/index.ts`) and the committed fixtures, not the handoff text and
not the packet checkers (which are pure re-implementations).

**Packet 44.** A probe through the real
`parseEnvelopeV3`→`validateEnvelopeV3`→`normalizeEnvelopeV3` executed every
committed **24 envelope fixtures (3 valid + 21 invalid) and matched the
expected code/path/reason in all 24**; the 3 valid ones round-trip byte- and
digest-identically to the committed bytes, and `migrateSceneV3` carries entities
verbatim with identity on v3. I recomputed all 38 `index.json` sha256/bytes
entries myself: 38/38 consistent. The single `catalog` fixture and the
`interrupted-copy` case are covered by the checker/tests rather than this probe.

**Packet 45.** Real `applyMutation`/`createCommandState`: **7/7 scenario messages**
match revision/change/history/createdId/inverse and the final scene+content
deep-equals `scenario.after.json`; **3/3 no-change** return `no_change` and leave
state untouched; of the 12 failure cases, **11 return the recorded code exactly**,
F4 is the recorded success, and **F10 succeeds as a legal partial edit** — the F10
divergence is honestly recorded (CC-45-3), and `commands.md` §3.1.10/§8.14 does
make a non-empty partial object a legal edit. F1/F8/F9/F12 auxiliary paths differ
from the fixture exactly as documented (real: `references` contains
`/entities/7/components/gameZone/safeSpawnId`; `/args/value/...`).

**Packet 46.** Real `migrateProjectCopyV3` on a real filesystem: the destination
`project.json` and `scenes/main.json` are **byte-equal** to
`migration/expected-v3-destination`, the source tree is **byte-identical after a
successful and a refused copy**, the blob is copied and digest-verified, the
marker is removed, and the destination's `publishedRevision`/`revision` are 0,
`game` is `null`, `retry.records` is empty. The reported object matches §16.5.2
exactly. CC-46-1 is **closed**: the repaired `migration/v2-source` (3380 B,
`ce201778…`) is now genuinely v2-loadable — the real operator loads it and my
`{ok:true}` control fails the new precondition check.

**Packet 47.** My own byte-built WAVs through the real `inspectAudio`: 1 frame →
`frames 1/durationMs 0/pcmBytes 2/riffChunkBytes 38`; 96 frames → `2/192/228`;
the cap → `96000 frames/2000 ms/192044 source`. My own rejections hit the
contracted stages: odd `dataBytes`→`audio_data_size_invalid`,
zero→`audio_empty`, bad `riffSize`→`audio_container_invalid`, `fmt `18/extra
`fact`/trailing byte/bad `byteRate`/`blockAlign`→`audio_chunk_invalid`, tag 3→
`audio_format_unsupported`, stereo/44100/8-bit→the matching `*_unsupported`,
`192002`→`asset_limits_exceeded(audio_pcm_bytes)`, `196610`→
`audio_source_bytes_exceeded`. The `pcm-wav` recipe carries **no** `extensions`,
the metric key order matches §41.4.3 exactly, and `recipeDigest` self-verifies. **CC-44-2 is real:** mutating the committed media envelope
(adding `extensions`, `recipeVersion 0`, wrong toolchain, `sourceByteLength ≠
44+pcmBytes`, over-cap, extra/missing metric key, wrong `durationMs`, wrong
profile) each yields the contracted `field_*`/`recipe_invalid`/`limits_exceeded`
refusal. The three regenerated contracts audio records carry the real
236-byte-preimage values (96 frames/192 pcmBytes/2 ms/228 riff), and
`cue-kind-mismatch` still reports `asset_kind_mismatch`. **CC-44-5** is exactly
the six §41.7.2 A codes and six §41.7.1 limit names. §41.4.5's
`AUDIO_MAX_REFERENCED_CUES = 6` is **independently confirmed structurally
unreachable**: `CUE_KEYS` is the fixed five and
`GAME_ZONE_LIMITS.checkpointZones = 1`, so no valid state can reference 7
distinct audio assets.

**Packet 48.** The integration suite drives a **real esbuild-bundled backend
child process**, a **real `WebSocket`**, and a **real MCP SDK
`Client`/`StdioClientTransport`** (no mocks); re-run green. The no-browser relay
path returns `session_unavailable`/`not_presented` over real stdio MCP — never a
fabricated success — and `game_run_stale`, `game_relay_timeout` (503),
wrong-session-ack drop, binary-free/≤16 KiB observations and the v3 query surface
(`tl_content_query target="game"` and HTTP `queryGameConfig`) are asserted at the
real transports. **CC-48-1 is closed**: the dispatch in
`workspace/src/session.ts`/`service.ts` and the `tools.ts` `target="game"` branch
exist and the transport assertions are non-vacuous.

## 3. Findings

### P1 — GR-L-1: the v2→v3 copy refuses a legal v2 project that carries a prepared behavior
`workspace.md` §16.5.2 mandates resetting `content.behaviors[i].source.publishedRevision`
to `0` on copy, and `project-model.md` §12 step 5 / §22.2 rule 4 were repaired to
read that bound as **`≥ 0` for a record written by the §16.5.2 copy**. The
implementation still enforces `≥ 1` (`packages/project-model/src/content.ts:1020`,
`validateBehaviorSource`: `published < 1` → `number_out_of_range`).

**Reproduction** (esbuild probe, real modules): seed a real project from
`fixtures/m3/contracts/migration/v2-source` plus the committed prepared behavior
record `fixtures/m2/contracts/behaviors/compiled-example.json` (`record`, source
`publishedRevision 4`) and its container blob; then
`svc.query({op:'queryProject'})` → **ok, revision 6** (the source is genuinely
v2-loadable), but:
```
svc.migrateProjectCopyV3('demo-0002','demo-0003')
→ { ok:false, code:'migration_source_invalid',
    details:[{ code:'number_out_of_range', path:'/behaviors/0/source/publishedRevision',
               expected:'integer >= 1', found:0 }],
    message:"the migration source 'demo-0003' is missing or does not load under the M1 pipeline" }
```
The operator's own pre-write `validateContentV3(deriveV3Content(...))`
(`packages/workspace/src/migration.ts:571–582, 614, 635`) resets the value to 0
and then rejects its own output, then **misattributes** the refusal to the source.
Every committed M3 fixture has `behaviors: []`, so packet 46's tests and the
reopened-section repairs never exercise this path. Consequence: the reopened
§16.5.2/§22.2/§12-step-5 text is not internally satisfiable as implemented, and
the destination of a behavior-bearing migration does not exist — so it cannot
satisfy the stated bounds either.

**Minimal bounded repair (one product line + docs):**
1. `content.ts:1020` — accept `published >= 0` (message/`expected` adjusted), and
   re-word §22.2 rule 4 / §12 step 5 as "`≥ 0` at load; `≥ 1` is an
   authoring/publication invariant enforced by the publication path" (a pure
   validator cannot detect "written by the §16.5.2 copy"). A one-line relax is
   safe: the publication path always lands at revision ≥ 1.
2. Add a **non-vacuous** packet-46 test: migrate a v2 source with a non-null
   `behavior.source`, assert `ok`, and assert the destination loads with
   `source.publishedRevision === 0`. Add the same prepared-behavior case to
   `fixtures/m3/storage/**` and the checker.
3. Alternatively (larger) keep `≥ 1` and stop resetting `source.publishedRevision`
   — but then §13.2 rule 5's `≤ scene.revision` bound fails for a destination
   revision 0, so this option also needs a contract change. Option 1 is the
   smallest consistent repair and matches the repaired contract's stated intent.

### P2 — GR-L-2: full-state/`queryProject` `scene.schemaVersion` still reports the manifest's `1`
Confirmed at the code level: `packages/backend/src/backend.ts:434` sets the
full-state scene `schemaVersion` to `q.manifest.schemaVersion` (always `1`), and
the play snapshot derives `state.content !== undefined ? 2 : 1`
(`backend.ts:972`). The accepted `sessions.md` §19.x clause (C35-5, accepted with
diff at Gate I) requires the **scene document's** version (`2` for storage 2,
`1` otherwise; `3` for v3). So CC-48-3 is not merely "a gap": an accepted clause
is unimplemented for v2 too. Bounded repair: add `schemaVersion` to the
`queryProject` scene projection and the full-state projection and serve the loaded
document's version; update `commands.md` §5.5/§12 and `sessions.md` §19.x. Not a
Gate L blocker (read-only projection; no data risk), but it must be owned before
M3 acceptance and it means the earlier C35-5 acceptance was over-credited.

### P3 — evidence hygiene (non-gating)
- `docs/acceptance/evidence-m3/` carries raw artifacts only for packet 38; packets
  44–48 have **no committed raw transcripts**. Their numbers are reproducible
  (I reproduced the checkers and the integration suite), but the report's
  "produced by a command recorded in a handoff" rests on handoff prose only.
- No M1/M2 fixture was found modified with an inconsistent digest (M2 checker
  34/34; all indexes self-consistent), but the **whole M2/M3 tree is uncommitted**
  (`fixtures/m2` and `fixtures/m3` are untracked), so byte-level non-modification
  against a baseline **cannot be proven** from git. I can certify only that the
  repaired M3 artifacts are the named ones (`v2-source` 3380 B `ce201778…`;
  `index.json` 38/38; the three audio records; `fixtures/m3/media` 65 generated
  files) and that no file named in the handoffs is missing.
- `docs/acceptance/m3-report.md` §3 lists a duplicated `B17` row — docs-only typo.

## 4. Re-review of the reopened sections

`workspace.md` §16.5.1 (v2-component-registry precondition) and
`project-model.md` §23.11 (superset definition) are **internally consistent**,
match the repaired fixture, the packet-46 operator (`component_unknown` →
`migration_source_invalid`) and control C. §16.5.2's derived-revision reset is
consistent with §13.2 rule 5, §18.9.2 rule 4 and §12 step 5 / §22.2 rule 4 **as
text**, and the asset half is implemented and verified (destination asset
`publishedRevision 0 ≤ revision 0`, destination loadable). The **behavior half is
not implemented** (GR-L-1), so §16.5.2's guarantee that the destination satisfies
every stated bound holds only for sources without a prepared behavior. The
reopened-section re-review is therefore **blocked on GR-L-1** and cannot be
accepted as-is.

## 5. Contract-change adjudication

| CC | Verdict | Destination a docs-only promotion would touch |
|---|---|---|
| CC-44-1 | **accept-with-diff** | `workspace.md` §16.9 — both the `project-model` bullet (add `validateEnvelopeV3`/`normalizeEnvelopeV3`/`parseEnvelopeV3`/`parseSceneV3`, `canonicalContentV3`, `validateGameConfig`, `EnvelopeV3Load`/`EnvelopeV3Error`) and the `workspace` bullet (`MigrationResultV3`, `MigrationMarkerV3`, `AnyMigrationMarker`, `migrateProjectCopyV3`); packet 46's proposed diff covers only the workspace bullet |
| CC-44-6 | **accept** (implementation verified: explicit version wins, first binding wins) | `project-model.md` §19.2 step 1 **and** `workspace.md` §16.6 item 4 (neither sentence is in the tree yet) |
| CC-45-1 | accept-with-diff | fixture `fixtures/m3/contracts/commands/failures.json` (F1); optionally `commands.md` §5.4 `game_reference_in_use` `references` note |
| CC-45-2 | accept-with-diff | `commands.md` §3 (request-pointer convention) + the F8/F9/F12 fixture paths |
| CC-45-3 | **accept** (contract already legal; fixture fix) | fixture F10 → `ok` |
| CC-45-4 | accept-with-diff | `commands.md` §3.1.1 (`kind` required on a v3 state, `model` default on v2) |
| CC-45-5 | **accept** (bounded) | fixture `fixtures/m2/contracts/commands/prefab-failures.json` (M2 checker must stay 34/34); no contract section |
| CC-45-6 | accept-with-diff | `commands.md` §5.5/§12 (`queryProject` summary: v3 keys only for a v3 state) |
| CC-45-7 | accept-with-diff | `commands.md` §8.5.1 (reimport replaces roles, leaves `modelAnimation.version`) |
| CC-45-8 | accept-with-diff | `commands.md` §5.4 (`game_config_invalid` is envelope-load-only) |
| CC-47-1 | accept | note at the CC-44-2 destination (`project-model.md` §18.5/§18.6 or `presentation.md` §41.4.3) |
| CC-47-2 | **accept** (test-only write-scope exception; no contract change) | — |
| CC-47-3 | **accept** (checker-only) | — |
| CC-47-4 | accept-with-diff | `presentation.md` §41.7.3 (the pipeline's copy of the A codes) |
| CC-47-5 | **accept** (independently confirmed unreachable) | `presentation.md` §41.4.5 + §41.7.1 mark `6` as a maximum, not a rejection bound (or drop `audio_cues` from `commands.md` §5.4 / `project-model.md` §18.9.3) |
| CC-48-2 | accept-with-diff | `sessions.md` §6.3 (`POST …/migrate-copy-v3`) |
| CC-48-3 | accept-with-diff | `sessions.md` §19.x + `commands.md` §5.5/§12 (`scene.schemaVersion` = the document's) — fixes accepted C35-5, see GR-L-2 |
| CC-46-1 | **closed** (verified) | — |
| CC-48-1 | **closed** (verified) | — |

## 6. UNVERIFIED

- Everything browser-, audio- and hardware-dependent: preview/render visuals,
  `decodeAudioData`, **audible output**, physical gamepad, display and hardware
  GPU. No browser run was performed in this review; packet 38's container is the
  only browser evidence and it is not re-exercised here.
- v3 Play/runtime (packets 49–62): the §20 relay was exercised on a committed v2
  project; a v3 play is out of scope, and the relay's correctness for v3 runs is
  untested.
- The GLB animated-profile negatives are repository-generated fixtures
  (self-produced GLBs), not third-party exports; third-party GLB acceptance is
  untested.
- Byte-level non-modification of M1/M2 fixtures (see P3) — no baseline exists.
- `docs/acceptance/m3-report.md` acceptance rows B01/B02/B03/B12/B14/B17/B18 are
  honestly labelled: B02/B03/B12/B14/B17/B18 match the executed evidence I
  re-derived, all browser/hardware halves are **UNVERIFIED**, and B01 should be
  read as **PASS for the executed (behavior-free) fixtures only** pending GR-L-1;
  the duplicate B17 row is a docs typo.

## 7. Next checkpoint

Fix GR-L-1 (owner: packet-46 scope; product owner of
`packages/project-model/src/content.ts` + the §16.5.2/§22.2/§12-step-5 wording),
then re-run `npm test`/typecheck/check-deps/check-boundaries/build, the M2/M3
checkers and the prepared-behavior migration test. Fix or explicitly defer GR-L-2
(C35-5) before M3 acceptance. The CC table then proceeds as one docs-only
promotion (plus the fixture-only CC-45-1/2/3/5 edits) and the reopened sections
can be re-accepted. **Do not start packet 49 until GR-L-1 is repaired and this
gate is re-recorded.**
