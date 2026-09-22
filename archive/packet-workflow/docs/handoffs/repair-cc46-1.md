# Bounded repair CC-46-1 — the packet-39 v2 migration source is not v2-loadable

**Coordinator repair, 2026-09-19. Fixtures + tests only. No contract change, no
commit, no install.** Performed because this is the one packet-46 finding that
blocked the §16.5.1 precondition from being truthful, and its owning artifact
(`fixtures/m3/contracts/**`) is outside packet 46's write scope.

## Finding (re-derived by the coordinator, not taken on trust)

`fixtures/m3/contracts/migration/v2-source/envelope.json` declared
`storageVersion: 2` and carried one retry record whose `result` was `{"ok": true}`.
`workspace.md` §16.5.1 requires the migration source to be *loadable under the v2
pipeline*, and the §4.3 step-7 retry-block check requires every record's `result`
to be a commands.md §5.1 success payload. The coordinator opened a project seeded
from the committed fixture through the real `openWorkspaceService`:

```
reason: "retry_records_invalid",
errors: [{ code: "retry_records_invalid", path: "/result/op",
           message: "recorded result op is not a known M1/M2 mutation op" }]
```

So the fixture (after the CC-44-3 repair removed the v3-only `cameraFollow`
component) still contradicted §16.5.1: it was not a loadable v2 project, and the
packet-39 checker could not see it because that checker is a pure structural
re-implementation, not the real pipeline. Packet 46 supplied a corrected copy in
its own `fixtures/m3/storage/**` and recorded CC-46-1 rather than silently
editing a fixture it did not own.

## Repair applied

1. `fixtures/m3/contracts/migration/v2-source/envelope.json` — the stale retry
   record is removed (`retry.records: []`); an empty retry block is a legal v2
   envelope (§4.2). Scene, content, identity and the source manifest are byte-
   unchanged, so the destination derivation is unaffected (the copy clears retry
   anyway, §16.5.2). 3629 B → 3380 B.
2. `fixtures/m3/contracts/index.json` — the entry's `sha256`
   (`5dc63193…7820` → `ce201778…7398`) and `bytes` updated, with a note naming
   CC-46-1.
3. `fixtures/m3/contracts/tools/check-fixtures.mjs` group 4 — a **minimal source
   retry-block shape check** added (requestId `req-`+32 hex, digest 64 hex,
   `appliedRevision` an ascending integer ≤ `scene.revision`, `result` an object
   with an `op` string and `result.revision === appliedRevision`). This is
   deliberately about the *precondition* and not a re-implementation of the
   pipeline; it exists so this exact defect class cannot regress unnoticed.
   Negative control: copying the tree, restoring the `{ok:true}` stub and
   running the checker prints the new `[migration]` failure and exits **1**
   (verified).
4. `packages/workspace/tests/m3-migration.test.ts` now seeds its v2 source from
   the **committed contracts fixture itself** (flat `project.json` +
   `envelope.json` written into a real project layout) instead of the packet-46
   copy, so the real operator is exercised against the §16.5.1 precondition
   document. The redundant storage copy stays (the crash and storage-integration
   suites use it).
5. A new test in the same file makes §16.5.2's `retryCleared` **non-vacuous**:
   backend A applies one real `setTransform`, leaving a durable retry record in
   the source; backend B (stale-owned source) copies it and the destination is
   asserted to start with `retry.records: []`, `retention: 128`, `revision: 0`,
   `game: null`. (An earlier draft released the source first; that is wrong —
   `releaseWorkspace` rewrites the envelope with the records cleared by accepted
   §9.1 design — so the test uses the stale-owner path instead and says why.)

## Commands and results

| Command | Exit | Result |
|---|---|---|
| `node fixtures/m3/contracts/tools/check-fixtures.mjs` | 0 | 39 groups, all checks passed |
| same tree, `{ok:true}` stub restored | 1 | new `[migration]` check fires |
| `node fixtures/m3/storage/tools/check-fixtures.mjs` (+`--corrupt-control`) | 0/0 | all checks passed; 6/6 corruptions detected |
| `node fixtures/m3/audit/tools/{check-audit,check-promotion}.mjs` | 0 | all checks passed |
| `npm test` | 0 | **142 files / 1804 tests** (was 1803) |
| `npm run typecheck` / `check-boundaries` | 0/0 | 15 packages, 294 files, 1148 specifiers, 0 violations |
| coordinator probe: seed from the repaired fixture, open the real service | — | loads; `query` returns the v2 project (`revision 6`) |

## State

- The repaired fixture is now genuinely v2-pipeline-loadable and the real
  operator copies it byte-for-byte into the committed
  `migration/expected-v3-destination`. CC-46-1 is **resolved**.
- Not a contract change: §16.5.1/§16.5.2 are unchanged; a broken fixture was
  made to match them. The contract-diff requests for Gate L remain CC-44-1 and
  CC-44-6 (recorded in `handoffs/46.md`).
- No commit. Next: packet 47 (not started here), then Gate L.
