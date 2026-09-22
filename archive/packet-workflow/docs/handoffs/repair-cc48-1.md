# Bounded repair CC-48-1 — the v3 query surface was unreachable through the workspace

**Coordinator repair, 2026-09-19. Code + tests only. No contract change, no
fixture change, no commit, no install.** Applied because packet 48's own B02
verdict was "PARTIAL: the query half is blocked" — a required acceptance row
cannot be half-implemented at the last implementation packet before Gate L.

## Finding (re-derived, not taken on trust)

Packet 45 added the pure `queryGameConfig` and the `queryEntities` `component`
filter to `@thirdlight/commands`; packet 48 exposed `queryGameConfig` on the
protocol. But the workspace dispatch — the only path the backend, the editor
and MCP use — still accepted only `queryProject/queryEntity/queryEntities/
queryAssets/queryPrefabs/queryBehaviors` in **two** separate validators
(`service.ts` `validateQueryRequest` and `session.ts` `validateQueryEnvelope`),
and `serveQuery` never called the pure v3 functions. Consequence: a real
`queryGameConfig` request failed `invalid_request /op`, and the packet-45
`queryEntities` component filter was unreachable.

## Repair applied

- `packages/workspace/src/session.ts`
  - `QUERY_OPS` + the envelope validator gain `queryGameConfig`; the expected-op
    string is corrected to list every accepted op.
  - `serveQuery`'s content-query branch now also calls the pure
    `queryGameConfig(state, request)`; args are validated by the pure function
    (no args accepted ⇒ `field_unexpected`).
  - `queryEntities` accepts the optional `component` arg, validates it through
    the pure `filterEntitiesByComponent` helper (unknown name ⇒ `field_value`)
    and pages the filtered set (`total` counts the filtered entities).
- `packages/workspace/src/service.ts` — the duplicate op validator and its type
  union gain `queryGameConfig` (nothing else).
- `packages/workspace/src/types.ts` — additive `QueryGameConfigResult` in the
  `QueryResult` union.
- `packages/mcp-adapter/src/tools.ts` — `tl_content_query` gains the read-only
  `target="game"` (maps to the same `queryGameConfig` command; no new bytes or
  capability). This is the MCP parity half of B02's query requirement; the tool
  schema is implementation-defined (no contract names it), so this is additive
  surface, not a contract change.
- Tests: new `packages/workspace/tests/m3-queries.test.ts` (a v3 state returns
  the normalized block, a legal partial edit is reflected, a v2 state reads
  `null`, the component filter composes with paging, unknown component/args are
  refused) and `tests/integration/m3-content/content-v3.test.ts` extended so the
  same read is asserted over the real MCP stdio client **and** the real backend
  HTTP `/commands` route at the same revision as the preceding edit.

## Commands and results (post-repair)

| Command | Result |
|---|---|
| `npm test` | **147 files / 1866 tests, EXIT 0** (was 146/1863) |
| `npm run typecheck` / `check-deps` | EXIT 0 / EXIT 0 |
| `npm run check-boundaries` | 15 packages, **297 files / 1167 specifiers, 0 violations** (was 296/1163: +1 test file, +4 specifiers — re-measured, not suppressed) |
| `npm run build` | 4 built, 0 skipped, EXIT 0 |
| `tests/integration/m3-content/content-v3.test.ts` | **17/17** (was 16, with the two new transport assertions in-test) |
| M2 contracts checker + all M3 checkers (+ controls) | EXIT 0 (34/34, 39 groups, gameplay 23/127, media 13/115 + 9/9, delivery 16/153, storage 9/10 + 6/6, audit, promotion) |

## State

- B02's query half is now reachable end to end (workspace → backend HTTP → MCP),
  so packet 48's B02 moves from PARTIAL to PASS for the executed transport scope.
- No contract text changed. CC-48-2 (`migrate-copy-v3` route naming) and
  CC-48-3 (full-state `scene.schemaVersion`) remain open for Gate L.
- The remaining packet-48 findings (CC-47-4 wording, CC-47-5 structurally
  unreachable `audio_cues` cap) are Gate L adjudication items, recorded in
  `docs/handoffs/48.md`.
- No commit. Next: **Gate L review** (fresh read-only reviewer), including the
  owed re-review of the reopened contract sections.
