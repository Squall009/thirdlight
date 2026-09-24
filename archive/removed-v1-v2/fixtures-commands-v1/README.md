# Thirdlight — Command & Workspace Fixtures (packet 02)

Normative examples for:

- `docs/contracts/commands.md` v0.1 — request/result schemas, revision and
  retry semantics, change/inverse data, history rules.
- `docs/contracts/workspace.md` v0.1 — the atomic authoring-state envelope,
  durability protocol, ownership, external-change handling.
- `docs/contracts/project-model.md` v0.2 — the logical scene embedded in
  every envelope.

Machine-readable index: `expected.json` (scenarios → expected outcome
codes/fields, envelope fixtures → expected validation codes).

## Layout

```text
fixtures/commands/
  expected.json                  machine-readable index (generated)
  verification.md                repeatable verification commands
  tools/generate-fixtures.mjs    fixture construction tool (Node ≥ 22, no deps)
  envelope/
    valid/                       byte-exact canonical envelopes + manifests
    invalid/                     envelope load-validation failure fixtures
  scenarios/<NN-name>/
    scenario.md                  normative narrative: preconditions, steps,
                                 expected observations, contract clauses pinned
    disk-before/<project-relative paths>   exact on-disk bytes before the messages
    messages.json                ordered [{ "in": <request|admin op>, "out": <result> }, …]
    disk-after/<project-relative paths>    exact on-disk bytes after
    disk-external/…              (scenario 08 only) the external writer's bytes
  examples/commands.json         one request/result pair per op + query examples
```

Scenario conventions:

- `disk-before` / `disk-after` mirror the real project layout
  (`project.json`, `scenes/main.json`, `scenes/.main.json.tmp-*`,
  `.thirdlight/ownership.json`, `.thirdlight/recovery/scene-*.json`).
- `messages.json` contains only actual request/result pairs (plus operator
  workspace operations, whose `in` shape is `{ "op": <workspace op>,
  "projectId" }` per workspace.md §11). Crash/restart/takeover steps are
  narrative in `scenario.md`, not messages.
- Envelope and document bytes are canonical (workspace.md §4.4): UTF-8, LF,
  2-space indent, one trailing newline, fixed key order.
- Every retry record's `digest` is a **real SHA-256** over the digest-
  canonical request bytes (commands.md §6.6). Recompute any of them with
  `python3`/`node` — the tool's `--check` mode re-verifies all of them.
- Timestamps, PIDs, backend IDs, and `requestId`s in fixtures are stable
  fixture values (real clients use wall-clock UTC, real PIDs, and CSPRNG
  IDs per the contracts).

## Timelines

**`demo-0001` mainline** (used by scenarios 01–04, 06–09; `requestId`
prefix `req-1…`):

```text
T0 rev 0: [cam-main]                    project creation (initial envelope)
T1 rev 1: + box-0001                    A1  req-1…01  browser
T2 rev 2: + box-0002                    A2  req-1…02  browser
T3 rev 3: box-0001 pos [1.5, 0.25, 0]   A3  req-1…03  mcp
T4 rev 4: + group-0001 "Walls"          A4  req-1…04  browser
T5 rev 5: box-0002 rot 90° yaw about Y  A5  req-1…05  mcp   ← lost ack (01), ID reuse (02)
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
rev 9, entities `[cam-main, box-0001 (pos [0,0,-0.5]), box-0002]`,
depths (3, 1).

**`demo-0002`** (retention fixture, prefix `req-4…`): create box (r1) +
128 setTransforms (r2–r129) → 129 records applied, retention bound 128 →
the oldest record (the create) is evicted; the envelope keeps records
r2–r129.

Each scenario is **self-contained**: its `disk-before` pins the exact state
it starts from. Revisions may coincide across scenarios (different
fictional timelines of the same project).

## Tooling — important

`tools/generate-fixtures.mjs` is **fixture construction tooling, not an
implementation of the contracts**. It contains a minimal scene/history
model used only to build consistent, cross-checked fixture bytes (real
digests, canonical serialization, depth progression, eviction, and a
forward/inverse round-trip of scenario 05 are self-verified on every run).
The packet 06/07 implementations must be written independently against the
contract documents; where the tool and the contracts ever disagree, the
contracts win and the tool (and its output) is a bug to fix.

```bash
# regenerate all fixtures (byte-stable; also self-verifies)
node tools/generate-fixtures.mjs
# verify committed fixtures byte-for-byte (no writes; exits non-zero on drift)
node tools/generate-fixtures.mjs --check
```

`verification.md` records the repeatable checks run for packet 02.