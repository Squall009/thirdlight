# Thirdlight — Command & Workspace Fixtures (storage v4)

Normative examples for the command pipeline (request/result shapes,
revision and retry semantics, change/inverse data, history rules) and the
workspace (project files, durability, ownership, external-change handling),
on **storage v4** projects (phase 9.3; the v1 corpus this replaced is kept
under `archive/removed-v1-v2/fixtures-commands-v1/`).

A storage-v4 project is several files (`packages/workspace/src/store-v4.ts`):

```text
project.json            manifest schemaVersion 2 (id, name, engine, createdAt)
content.json            { storageVersion 4, type "project-content", projectId,
                          revision, content, retry }
scenes/<sceneId>.json   { storageVersion 4, type "scene", projectId,
                          scene (schemaVersion 4), retry }
```

The project revision is the highest `revision` of its files; a transaction
writes only the files that changed and appends its retry record to them.
Every command of this corpus edits the one scene, so it writes
`scenes/scene-main.json` only; `content.json` stays at revision 0 with no
records (scenario 08's `acceptExternalState` is the exception: it rewrites
every file with its records cleared and stamps `content.json` with the
project revision).

Machine-readable index: `expected.json` (scenarios → expected outcome
codes/fields, project fixtures → revision/record counts or the expected
load-failure reason and first error code).

## Layout

```text
fixtures/commands/
  expected.json                  machine-readable index (generated)
  verification.md                repeatable verification commands
  tools/generate-fixtures.mjs    fixture construction tool (Node ≥ 22, no deps)
  envelope/
    valid/<name>/                whole v4 project directories (byte-exact)
    invalid/<name>/              whole v4 project directories, one defect each
  scenarios/<NN-name>/
    scenario.md                  narrative: preconditions, steps, expected
                                 observations, what differs from the v1 corpus
    disk-before/<project files>  exact on-disk bytes before the messages
    messages.json                ordered [{ "in": <request|admin op>, "out": <result> }, …]
    disk-after/<project files>   exact on-disk bytes after
    disk-external/…              (scenario 08 only) the external writer's bytes
  examples/commands.json         one request/ack pair per op + a replay + queries
```

(`envelope/` keeps its v1 name: each fixture there is the v4 counterpart of
a v1 authoring-state envelope — a whole project directory.)

Scenario conventions:

- `disk-before` / `disk-after` mirror the real project layout
  (`project.json`, `content.json`, `scenes/scene-main.json`,
  `scenes/.scene-main.json.tmp-*`, `.thirdlight/ownership.json`,
  `.thirdlight/claim-0`, `.thirdlight/recovery/scene-*.json`). A test seeds
  `disk-before` as-is and compares every `disk-after` file byte for byte.
- `messages.json` contains only actual request/result pairs (plus operator
  workspace operations, whose `in` shape is `{ "op": <workspace op>,
  "projectId" }`). Crash/restart steps are narrative in `scenario.md`, not
  messages.
- A live acknowledgement of a v4 project names the edited scene (`sceneId`,
  the last key). The retry record stores the §5.1 payload without it, so an
  identical retry replays the record (`duplicated: true`) **without**
  `sceneId`. The pure commands layer returns the payload without `sceneId`
  too (the workspace appends it).
- File bytes are canonical: UTF-8, LF, 2-space indent, one trailing
  newline, fixed key order.
- Every retry record's `digest` is a **real SHA-256** over the digest-
  canonical request bytes (sorted keys, no whitespace). The tool's `--check`
  mode re-verifies all of them.
- Timestamps, PIDs, backend IDs, and `requestId`s are stable fixture values
  (real clients use wall-clock UTC, real PIDs, and CSPRNG IDs).

## Timelines

A new project (`envelope/valid/demo-0001-rev0`) is what `createProject`
plus the automatic v3 → v4 upgrade produce: `cam-main` and the two starter
lights `light-0001` (Sun) and `light-0002` (Ambient) in `scene-main`
("Main"), an empty content catalog.

**`demo-0001` mainline** (used by scenarios 01–04, 06–09; `requestId`
prefix `req-1…`):

```text
T0 rev 0: [cam-main, light-0001, light-0002]   project creation
T1 rev 1: + box-0001                    A1  req-1…01  browser
T2 rev 2: + box-0002                    A2  req-1…02  browser
T3 rev 3: box-0001 pos [1.5, 0.25, 0]   A3  req-1…03  mcp
T4 rev 4: + group-0001 "Walls"          A4  req-1…04  browser
T5 rev 5: box-0002 rot 90° about X      A5  req-1…05  mcp   ← lost ack (01), ID reuse (02)
T6 rev 6: + box-0003                    A6  req-1…06  browser
T7 rev 7: + box-0004                    A7  req-1…07  mcp   ← crash window (06/07), base state (08/09)
```

- Scenario 03 branches from T5 (stale request, then a re-issue at rev 5 →
  its own rev-6 state).
- Scenario 04 runs four rejected commands at T5 (state never changes).

**`demo-0001` alternate timeline** (scenario 05 only, from revision 0;
prefix `req-2…`): create box-0001 (browser) → setTransform (mcp) → create
box-0002 (browser) → delete box-0002 (mcp) → undo (browser) → undo
(browser) → redo (mcp) → setTransform (mcp) → undo (browser). Final:
rev 9, entities `[cam-main, light-0001, light-0002, box-0001 (pos
[0,0,-0.5]), box-0002]`, depths (3, 1).

**`demo-0002`** (retention fixture, prefix `req-4…`): create box (r1) +
128 setTransforms (r2–r129) → 129 records applied, retention bound 128 →
the oldest record (the create) is evicted; the scene file keeps records
r2–r129.

Each scenario is **self-contained**: its `disk-before` pins the exact state
it starts from. Revisions may coincide across scenarios (different
fictional timelines of the same project).

## Who reads the corpus

- `packages/workspace/tests/scenarios.test.ts` — replays all nine scenarios
  through the real workspace service (storage v4) and compares every
  message and every `disk-after` file.
- `packages/workspace/tests/project-files-v4.test.ts` — loads every
  `envelope/valid` project and rebuilds its files byte-identically; blocks
  every `envelope/invalid` project with the reason in `expected.json`.
- `packages/commands/src/scenario-0{3,4,5}-*.test.ts` — pure replays of the
  command pipeline on the scene + content of `disk-before`.
- Seeds for other workspace and process-level tests (dedup/retry, external
  change, ownership and liveness, write faults, queries, create/scan,
  corrupt startup, `tests/crash-recovery.test.ts`,
  `tests/ownership-claim-processes.test.ts`).

## Tooling — important

`tools/generate-fixtures.mjs` is **fixture construction tooling, not an
implementation**. It contains a minimal project/history model used only to
build consistent, cross-checked fixture bytes (real digests, canonical
serialization, depth progression, eviction, and a forward/inverse
round-trip of scenario 05 are self-verified on every run). Its output is
checked against the real packages by the tests above; where the tool and
the code or contracts disagree, find out which is wrong — never edit a
generated file by hand.

```bash
# regenerate all fixtures (byte-stable; also self-verifies)
node tools/generate-fixtures.mjs
# verify committed fixtures byte-for-byte (no writes; exits non-zero on drift)
node tools/generate-fixtures.mjs --check
```

`verification.md` records the repeatable checks.
