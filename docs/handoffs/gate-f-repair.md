# Gate F bounded follow-up repair (GF-1…GF-6)

2026-09-19. Applied under **owner pre-approval (autonomous M2 build instruction,
2026-09-18); final manual review pending**. No commit/install; no packet
started. Gate F verdict: ACCEPT WITH BOUNDED FOLLOW-UPS (docs/handoffs/gate-f.md).

## Outcome — all six items applied; none stopped; GF-5 is the only behavior change

- **GF-1 applied.** Promoted delivery §15 into `sessions.md` as new **§19**
  (routes/auth/origin/results, bounds, failure mapping) plus the additive
  `content` projection in §5.1/§8. Limits reconciled to **128** (`commands.md`
  §4); the fixture pins no page number, so no fixture change. Closes
  C25-1/C25-3/C25-4.
- **GF-2 applied.** `*SceneV2` naming + interchange/`KNOWN_VERSIONS.scene=[1,2]`
  (§12.1); `migrateSceneV1ToV2` (§12.4); controller "at most one in a document,
  runtime exactly one" (§10.8/§21.1/§17, plus the §11.3 deletion rule and §12.6
  error-row coherence alignments); `content`/`manifest` optional pure
  inputs (§6.1); required `importedAt` + reimport `displayName`-replaces
  (§3.1.1/§8.5); full-record `includeDeclaration` (§5.6); closed prefab
  vocabulary incl. `collider`/`controller` (§5.4/§20.2); `asset-pipeline`
  exports + `captureManifest` owning packet 35 (deps §3); glTF 4-byte alignment
  (§18.7.2); `json_chunk_bytes`/`image_bytes` (§18.9.3); §11.3 route-level
  overrides.
- **GF-3 applied.** `prefab-failures.json` F21 → `model-0005` +
  `referencingEntityIds` + missing `hint`; F23 → M1-pinned message/hint.
  Removed the F21 skip and F23 workaround (both now `toEqual`); updated
  `prefabs/expected.json`.
- **GF-4 recorded.** GF-1/GF-2/GF-3 are the reopened-Gate-E repair.
  Re-accepted: sessions §5.1/§8/§11.3/§19; project-model
  §10.8/§12.1/§12.4/§17/§18.7.2/§18.9.3/§20.2/§21.1; commands
  §3.1.1/§5.4/§5.6/§6.1/§8.5; dependencies §3; fixtures `prefab-failures.json`
  and `prefabs/expected.json`.
- **GF-5 applied.** `publishBlob` moved from upload completion into the
  successful inspection path (`content.ts`), bounded by a 30 s inspect / 120 s
  publish job; added a discriminating malformed-GLB regression test.
- **GF-6 applied.** STATUS row 23 count 967→975; harness comment fixed; §19.2
  records no job-count bound is required (no job-listing route). Orphan temp
  roots not cleaned, per instruction.

## Files changed

Contracts `docs/contracts/{sessions,project-model,commands,dependencies}.md`;
fixtures `fixtures/m2/contracts/commands/prefab-failures.json`,
`fixtures/m2/prefabs/expected.json`; code `packages/backend/src/content.ts`;
tests `packages/commands/src/m2-prefab.test.ts`,
`tests/integration/m2-content/{content-security.test.ts,harness.ts}`; records
`docs/STATUS.md`, this file.

## Commands (actual results)

- `npm test` — **81 files / 1132 passed**, exit 0
- `npm run typecheck` — exit 0 (11 packages)
- `npm run check-deps` — `check-deps: OK`
- `npm run check-boundaries` — `OK — 11 package(s), 187 source file(s), 680 specifier(s)`
- `npm run build` — `build: done (4 built, 0 skipped)`
- `node fixtures/m2/contracts/tools/check-fixtures.mjs` — `check OK: 33 group(s) passed, 0 problem(s)`
- `npx vitest run tests/integration/m2-content/content-security.test.ts` — **12 passed** (incl. the GF-5 regression)

Negative control: restoring upload-completion publication makes the GF-5
regression fail (`expected true to be false`); `content.ts` restored
byte-identical.

## Notes

- Delivery §15's `GET …/queries` is realized by the existing `POST /commands`
  query envelopes (the accepted fixture has no such route).
- Inspect can now surface publication errors (`content_quota_exceeded`,
  `content_publish_failed`, `blob_*`) previously surfaced at upload; the
  fixture's error list is a subset. Packet-25 transcripts predate GF-5.
- Browser/UI, physics desktop/gamepad and the trusted-main-thread review remain
  UNVERIFIED.

**Exact next step:** packet 26 (not started).
