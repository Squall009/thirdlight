# Fixtures/commands — Verification (storage v4)

Repeatable checks that the committed fixtures are internally consistent,
plus the tests that check them against the real packages. All shell
commands run from `fixtures/commands/`.

## 1. Regenerate-and-compare (byte-stability, digests, canonical form)

```bash
node tools/generate-fixtures.mjs --check
# expected: "check OK: 116 files byte-identical, digests + canonical stability verified"
```

The tool, on every run, additionally verifies (and fails non-zero on):

- every retry record's `digest` equals SHA-256 of its request's
  digest-canonical form;
- every generated file round-trips through its canonical serialization
  (byte-identical re-serialization; the duplicate-key fixture excepted);
- scenario 05's final scene, revision, and per-step undo/redo depths via an
  independent forward/inverse replay;
- the retention fixture: 129 applied commands, exactly 128 retained
  records, oldest evicted;
- scenario 06's crash-window temp is exactly the rev-7 scene file.

## 2. Cross-language digest recomputation (independent of the tool)

```bash
python3 - <<'EOF'
import json, hashlib
def canon(o):
    if isinstance(o, dict): return {k: canon(o[k]) for k in sorted(o)}
    if isinstance(o, list): return [canon(x) for x in o]
    return o
def digest(o):
    return hashlib.sha256(json.dumps(canon(o), separators=(',', ':'),
                                     ensure_ascii=False).encode('utf8')).hexdigest()
f = json.load(open('envelope/valid/demo-0001-rev5/scenes/scene-main.json'))
rec = f['retry']['records'][4]                         # A5 (setTransform box-0002)
req = json.load(open('scenarios/01-retry-lost-ack/messages.json'))[0]['in']
assert rec['requestId'] == req['requestId']
assert rec['digest'] == digest(req), "digest mismatch"
# scenario 02 reuses the same requestId with different content -> different digest
req2 = json.load(open('scenarios/02-request-id-reused/messages.json'))[0]['in']
assert req2['requestId'] == req['requestId'] and digest(req2) != rec['digest']
print("digest cross-check OK")
EOF
```

Python's `json.dumps` matches JavaScript `JSON.stringify` for the shortest
round-trip number serialization and the escape rules used here (no
non-ASCII text in request payloads; no `-0` values).

## 3. Project-file structural invariants

```bash
python3 - <<'EOF'
import json
dirs = [('demo-0001-rev0', 0), ('demo-0001-rev5', 5), ('demo-0001-rev6', 6),
        ('demo-0001-rev7', 7), ('demo-0002-revision-129', 129)]
for d, want in dirs:
    base = f'envelope/valid/{d}/'
    man = json.load(open(base + 'project.json'))
    content = json.load(open(base + 'content.json'))
    scene = json.load(open(base + 'scenes/scene-main.json'))
    assert man['schemaVersion'] == 2 and list(man) == ['schemaVersion', 'engineVersion', 'id', 'name', 'createdAt']
    assert list(content) == ['storageVersion', 'type', 'projectId', 'revision', 'content', 'retry']
    assert list(scene) == ['storageVersion', 'type', 'projectId', 'scene', 'retry']
    assert content['storageVersion'] == 4 and content['type'] == 'project-content'
    assert scene['storageVersion'] == 4 and scene['type'] == 'scene' and scene['scene']['schemaVersion'] == 4
    assert [s['sceneId'] for s in content['content']['scenes']] == ['scene-main'] == content['content']['startScenes']
    assert max(content['revision'], scene['scene']['revision']) == want
    for f, rev in ((content, content['revision']), (scene, scene['scene']['revision'])):
        recs = [r['appliedRevision'] for r in f['retry']['records']]
        assert f['retry']['recordVersion'] == 2 and f['retry']['retention'] == 128 and len(recs) <= 128
        assert all(r['result']['sceneId'] == 'scene-main' for r in f['retry']['records'])
        assert all(recs[i] < recs[i+1] for i in range(len(recs)-1))
        assert (not recs) or max(recs) <= rev
print("project-file invariants OK")
EOF
```

## 4. Scenario disk invariants

```bash
python3 - <<'EOF'
import json, glob, os
def rb(p): return open(p, 'rb').read()
S = 'scenes/scene-main.json'
FILES = ['project.json', 'content.json', S]
# 01/02/04/07/09: replayed, rejected or ownership-only steps leave the project files byte-identical
for d in ['01-retry-lost-ack', '02-request-id-reused', '04-invalid-no-partial', '07-crash-after-replace', '09-second-backend-ownership']:
    for f in FILES:
        assert rb(f'scenarios/{d}/disk-before/{f}') == rb(f'scenarios/{d}/disk-after/{f}'), (d, f)
# 06: the crash-leftover temp is exactly the (never renamed) rev-7 scene file; the temp is gone after
assert rb('scenarios/06-crash-before-replace/disk-before/scenes/.scene-main.json.tmp-4242-7') == rb(f'envelope/valid/demo-0001-rev7/{S}')
assert not os.path.exists('scenarios/06-crash-before-replace/disk-after/scenes/.scene-main.json.tmp-4242-7')
a = json.load(open(f'scenarios/06-crash-before-replace/disk-after/{S}'))
b = json.load(open(f'envelope/valid/demo-0001-rev7/{S}'))
assert a['scene'] == b['scene']                        # same state as the mainline T7
assert a['retry']['records'][-1]['result']['history'] == {'undoDepth': 1, 'redoDepth': 0}  # fresh process
# 08: the recovery snapshot is byte-identical to the external writer's bytes;
#     the final scene file carries the accepted edit and exactly one retry record
snap = glob.glob('scenarios/08-external-modification/disk-after/.thirdlight/recovery/scene-*.json')[0]
assert rb(snap) == rb(f'scenarios/08-external-modification/disk-external/{S}')
ext_hash = json.load(open('scenarios/08-external-modification/messages.json'))[0]['out']['error']['pendingChange']['externalHash']
assert os.path.basename(snap).split('scene-20260917T101500Z-')[1][:8] == ext_hash[:8]
final = json.load(open(f'scenarios/08-external-modification/disk-after/{S}'))
assert len(final['retry']['records']) == 1 and final['retry']['records'][0]['appliedRevision'] == 8
content = json.load(open('scenarios/08-external-modification/disk-after/content.json'))
assert content['revision'] == 7 and content['retry']['records'] == []
# 09: ownership changes hands at epoch 1
before = json.load(open('scenarios/09-second-backend-ownership/disk-before/.thirdlight/ownership.json'))
after  = json.load(open('scenarios/09-second-backend-ownership/disk-after/.thirdlight/ownership.json'))
assert before['lockEpoch'] == 0 and after['lockEpoch'] == 1 and before['backendId'] != after['backendId']
print("scenario disk invariants OK")
EOF
```

## 5. Against the real packages

```bash
# from the repo root
npx vitest run packages/workspace/tests/scenarios.test.ts \
  packages/workspace/tests/project-files-v4.test.ts \
  packages/commands/src/scenario-03-revision.test.ts \
  packages/commands/src/scenario-04-failures.test.ts \
  packages/commands/src/scenario-05-history.test.ts
```

`scenarios.test.ts` replays every scenario (01–09) through the real
workspace service and compares every message and every `disk-after` file;
`project-files-v4.test.ts` loads and rebuilds every valid project and
checks every invalid one's reason; the commands tests replay 03–05 through
the pure pipeline.

## Recorded run (phase 9.3, 2026-09-24, Node v22)

- `node tools/generate-fixtures.mjs --check` → `check OK: 116 files byte-identical, digests + canonical stability verified`
- checks 2–4 above → all printed their OK lines.
- step 5 → all tests pass (scenarios 01–09, 15 project-file tests, 10
  commands tests).
- The generator's `envelope/valid/demo-0001-rev{0,5,6,7}` files were also
  compared with a project created by the real service (`createProject` with
  `storageV4: true`, then A1–A7): byte-identical.
