# Verification — packet 39 v3 contract fixtures

**PROPOSED — not accepted.** Repeatable checks for
`fixtures/m3/contracts/`. All commands run from the repository root with the
pinned Node (`package.json` engines: `node 22`; host recorded 22.22.1).

**Repair 2026-09-19 (`docs/handoffs/repair-cc44-3-4.md`).** Two defects found by
packet 44 are fixed: CC-44-3 (`migration/v2-source/envelope.json` declared
`schemaVersion: 2` while carrying the v3-only `cameraFollow` component,
contradicting `workspace.md` §16.5.1 — the component was removed from the source
and, by verbatim carry, from the destination) and CC-44-4 (the destination's
asset `publishedRevision` stayed `2` while `revision` resets to `0`, failing the
§18.9.2 rule 4 / §13.2 rule 5 bound — `workspace.md` §16.5.2 now resets the
derived revision metadata and the fixture carries `publishedRevision: 0`). The
checker's migration group now re-derives both rules (v2 sources contain no
v3-only component; the destination is loadable and every derived revision value
is 0) and reads the new `index.json` `expect` blocks.

## 1. Positive check (must exit 0)

```sh
node fixtures/m3/contracts/tools/check-fixtures.mjs
echo "EXIT=$?"
```

Expected: `all checks passed`, `EXIT=0`. Recorded result (packet 39, packet-43
Gate K repair 2026-09-19; re-run after the CC-44-3/CC-44-4 repair
2026-09-19): `groups passed: 39`, `all checks passed`, `EXIT=0`
(37 groups at packet 39; the Gate K repair added the `spawn-parented`
`spawn_transform_unsupported` fixture, the `game-extra-field`
`game_config_invalid`/`field_unexpected` fixture and the reason requirement in
the expectations group; the CC-44-3/CC-44-4 repair adds assertions inside the
existing migration group, so the group count is unchanged).

The groups are: canonical bytes + strict parse, declared key order, index
coverage (no orphan, no dangling entry), index `sha256`/`bytes`,
preimage digest/byte-length agreement, version-combination and v3 validation for
every envelope fixture (valid and invalid), migration identity/reset/verbatim
(the v2 source carries no v3-only component; the destination is loadable and
its derived revision metadata is all 0), interrupted-copy suppression, command
scenario replay, no-change replay, reachable failures, and expectation
completeness.

Optional machine-readable report:

```sh
node fixtures/m3/contracts/tools/check-fixtures.mjs --report /tmp/m3-39-report.json
```

## 2. Negative control A — byte corruption (must exit non-zero)

```sh
rm -rf /tmp/m3-corrupt && cp -r fixtures/m3/contracts /tmp/m3-corrupt
# break one value so the document is no longer valid and no longer hashed as recorded
sed -i 's/"spawnId": "spawn-0001"/"spawnId": "spawn-9999"/' \
  /tmp/m3-corrupt/envelope/valid/demo-0003-beacon-min-v3.json
TL39_FIXTURE_ROOT=/tmp/m3-corrupt node fixtures/m3/contracts/tools/check-fixtures.mjs
echo "EXIT=$?"
```

Expected: at least one `[digest]` failure and at least one `[v3-valid]` failure,
`EXIT=1`. Recorded result (packet 39): `EXIT=1` with
`FAIL [digest] env… sha256 mismatch` and
`FAIL [v3-valid] … game_reference_missing /content/game/spawnId`.

`TL39_FIXTURE_ROOT` points the checker at a fixture copy; the committed tree is
never modified by the control.

## 3. Negative control B — key-order corruption (must exit non-zero)
```sh
rm -rf /tmp/m3-corrupt2 && cp -r fixtures/m3/contracts /tmp/m3-corrupt2
python3 - <<'PY'
p = '/tmp/m3-corrupt2/envelope/valid/demo-0003-fresh-v3.json'
s = open(p).read()
s = s.replace('"settings": {},\n    "behaviorTrust": {\n      "entries": []\n    },\n    "game": null',
              '"behaviorTrust": {\n      "entries": []\n    },\n    "settings": {},\n    "game": null')
open(p, 'w').write(s)
PY
TL39_FIXTURE_ROOT=/tmp/m3-corrupt2 node fixtures/m3/contracts/tools/check-fixtures.mjs
echo "EXIT=$?"
```

Expected: a `[key-order]` failure for `/content` plus a `[digest]` failure,
`EXIT=1`. Recorded result (packet 39): `EXIT=1` with
`FAIL [key-order] …/content expected [assets,prefabs,behaviors,settings,behaviorTrust,game] got [assets,prefabs,behaviors,behaviorTrust,settings,game]`.

## 4. Negative controls C/D — the two repaired defect classes (must exit non-zero)

```sh
# C: put the v3-only cameraFollow component back into the schemaVersion 2 source
rm -rf /tmp/m3-cc44-3 && cp -r fixtures/m3/contracts /tmp/m3-cc44-3
python3 - <<'PY'
import json
p = '/tmp/m3-cc44-3/migration/v2-source/envelope.json'
d = json.load(open(p))
d['scene']['entities'][0]['components']['cameraFollow'] = {
    'deadZone': {'x': 0.5, 'y': 0.5}, 'smoothing': 0.2,
    'bounds': {'minX': 0, 'maxX': 48, 'minY': 0, 'maxY': 8}}
open(p, 'w').write(json.dumps(d, indent=2) + '\n')
PY
TL39_FIXTURE_ROOT=/tmp/m3-cc44-3 node fixtures/m3/contracts/tools/check-fixtures.mjs
echo "EXIT=$?"

# D: restore the destination asset's publishedRevision to 2 (revision stays 0)
rm -rf /tmp/m3-cc44-4 && cp -r fixtures/m3/contracts /tmp/m3-cc44-4
python3 - <<'PY'
import json
p = '/tmp/m3-cc44-4/migration/expected-v3-destination/envelope.json'
d = json.load(open(p))
d['content']['assets'][0]['versions'][0]['publishedRevision'] = 2
open(p, 'w').write(json.dumps(d, indent=2) + '\n')
PY
TL39_FIXTURE_ROOT=/tmp/m3-cc44-4 node fixtures/m3/contracts/tools/check-fixtures.mjs
echo "EXIT=$?"
```

Expected: C fails `[migration] v2 source must not carry v3-only components …`;
D fails `[migration] … destination invalid: {"code":"field_value","path":
"/content/assets/0/versions/0/publishedRevision"}; the destination must be
loadable (CC-44-4)`. Recorded result (CC-44-3/CC-44-4 repair 2026-09-19): both
**`EXIT=1`** (plus the expected `[digest]` mismatch in each copy).

## 5. Repository checks (unchanged by packet 39; must stay green)

```sh
npm test
npm run typecheck
npm run check-deps
npm run check-boundaries
npm run build
```

Packet 39 changes no package, contract or lockfile, so these must stay at their
pre-packet result. Recorded exit codes for packet 39 are in
`docs/handoffs/39.md`.

CC-44-3/CC-44-4 repair 2026-09-19: `typecheck`/`check-deps`/
`check-boundaries`/`build` stay **`EXIT=0`**; `npm test` is **1 failing** — the
packet-44 test that pins the pre-repair contradictory destination
(`packages/project-model/src/v3-model.test.ts:234`,
`expect(projectResult.ok).toBe(false)`). The fixture is repaired and the test
must not be edited by this repair; the exact failing assertion and the
recommended test change are routed to **packet 46 (blocking)** in
`docs/handoffs/repair-cc44-3-4.md`.

## 6. What the checker does not prove

- It is fixture tooling, not an implementation of the contracts: it does not
  prove a backend/workspace/command implementation exists (packets 44–48).
- The packet-41 placeholder fields (audio `importRecipe`/`metrics`, animation
  role bindings) are structurally checked only; packet 41 owns their semantics
  and its own fixtures.
- No browser, network, digest-of-bytes-on-disk-for-real-blobs, or
  production-import claim is made here.
