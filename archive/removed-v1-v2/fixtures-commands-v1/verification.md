# Fixtures/commands — Verification (packet 02)

Repeatable checks that the committed fixtures match the contract documents
and are internally consistent. No implementation exists yet (packets 06/07);
these checks establish fixture self-consistency only, not contract
conformance by code.

All commands run from `fixtures/commands/` with the recorded toolchain
(`docs/environment.md`: Node v22.22.1, Python 3.14.4).

## 1. Regenerate-and-compare (byte-stability, digests, canonical form)

```bash
node tools/generate-fixtures.mjs --check
# expected: "check OK: 71 files byte-identical, digests + canonical stability verified"
```

The tool, on every run, additionally verifies (and fails non-zero on):

- every retry record's `digest` equals SHA-256 of its request's
  digest-canonical form (commands.md §6.6);
- every generated file round-trips through its canonical serialization
  (workspace.md §4.4; byte-identical re-serialization);
- scenario 05's final scene, revision, and per-step undo/redo depths match
  the contract's history model (commands.md §9.1) via an independent
  forward/inverse replay;
- the retention fixture: 129 applied commands, exactly 128 retained
  records, oldest evicted (commands.md §7.1).

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
env = json.load(open('envelope/valid/demo-0001-rev5.json'))
rec = env['retry']['records'][4]                       # A5 (setTransform box-0002)
req = json.load(open('scenarios/01-retry-lost-ack/messages.json'))[0]['in']
assert rec['requestId'] == req['requestId']
assert rec['digest'] == digest(req), "digest mismatch"
# scenario 02 reuses the same requestId with different content -> different digest
req2 = json.load(open('scenarios/02-request-id-reused/messages.json'))[0]['in']
assert req2['requestId'] == req['requestId'] and digest(req2) != rec['digest']
print("digest cross-check OK")
EOF
```

Note: Python's `json.dumps` matches JavaScript `JSON.stringify` for the
shortest round-trip number serialization and the escape rules used here
(no non-ASCII text appears in request payloads; no `-0` values).

## 3. Envelope structural invariants

```bash
python3 - <<'EOF'
import json
files = [
    ('envelope/valid/demo-0001-rev0.json', 0),
    ('envelope/valid/demo-0001-rev5.json', 5),
    ('envelope/valid/demo-0001-rev6.json', 6),
    ('envelope/valid/demo-0001-rev7.json', 7),
    ('envelope/valid/demo-0002-revision-129.json', 129),
]
for f, want in files:
    env = json.load(open(f))
    recs = [r['appliedRevision'] for r in env['retry']['records']]
    assert env['storageVersion'] == 1 and env['type'] == 'authoring-state'
    assert env['scene']['revision'] == want
    assert env['retry']['retention'] == 128 and len(recs) <= 128
    assert all(recs[i] < recs[i+1] for i in range(len(recs)-1))
    assert (not recs) or max(recs) <= env['scene']['revision']
    assert list(env) == ['storageVersion', 'type', 'projectId', 'scene', 'retry']
print("envelope invariants OK")
EOF
```

## 4. Scenario disk invariants

```bash
python3 - <<'EOF'
import json, glob, os
base = os.getcwd()
def rb(p): return open(os.path.join(base, p), 'rb').read()
# 01/02/04: rejected or replayed commands leave the disk byte-identical
for d in ['01-retry-lost-ack', '02-request-id-reused', '04-invalid-no-partial']:
    assert rb(f'scenarios/{d}/disk-before/scenes/main.json') == rb(f'scenarios/{d}/disk-after/scenes/main.json'), d
# 06: the crash-leftover temp is exactly the (never renamed) new envelope;
#     the post-retry disk equals the canonical rev-7 envelope and the temp is gone
assert rb('scenarios/06-crash-before-replace/disk-before/scenes/.main.json.tmp-4242-7') == rb('envelope/valid/demo-0001-rev7.json')
assert rb('scenarios/06-crash-before-replace/disk-after/scenes/main.json') == rb('envelope/valid/demo-0001-rev7.json')
assert not os.path.exists(os.path.join(base, 'scenarios/06-crash-before-replace/disk-after/scenes/.main.json.tmp-4242-7'))
# 07: replay is a no-op on disk
assert rb('scenarios/07-crash-after-replace/disk-before/scenes/main.json') == rb('scenarios/07-crash-after-replace/disk-after/scenes/main.json')
# 08: the recovery snapshot is byte-identical to the external writer's bytes;
#     the final envelope carries the accepted edit and exactly one retry record
snap = glob.glob('scenarios/08-external-modification/disk-after/.thirdlight/recovery/scene-*.json')[0]
assert rb(snap) == rb('scenarios/08-external-modification/disk-external/scenes/main.json')
ext_hash = json.load(open('scenarios/08-external-modification/messages.json'))[0]['out']['error']['pendingChange']['externalHash']
assert os.path.basename(snap).split('scene-20260917T101500Z-')[1][:8] == ext_hash[:8]
final = json.load(open('scenarios/08-external-modification/disk-after/scenes/main.json'))
assert len(final['retry']['records']) == 1 and final['retry']['records'][0]['appliedRevision'] == 8
# 09: ownership changes; the envelope never does
assert rb('scenarios/09-second-backend-ownership/disk-before/scenes/main.json') == rb('scenarios/09-second-backend-ownership/disk-after/scenes/main.json')
before = json.load(open('scenarios/09-second-backend-ownership/disk-before/.thirdlight/ownership.json'))
after  = json.load(open('scenarios/09-second-backend-ownership/disk-after/.thirdlight/ownership.json'))
assert before['lockEpoch'] == 0 and after['lockEpoch'] == 1 and before['backendId'] != after['backendId']
print("scenario disk invariants OK")
EOF
```

## 5. Scenario outcome codes vs the index

Each `messages.json` outcome sequence must match `expected.json`
(scenarios[*].outcomes). The index was generated together with the
scenarios; `tools/generate-fixtures.mjs --check` regenerates both and
compares them byte-for-byte, so any drift between the two fails the check.

## Recorded run (packet 02, 2026-09-17, Node v22.22.1 / Python 3.14.4)

- `node tools/generate-fixtures.mjs` → `wrote 71 fixture files (digests + canonical stability verified)`
- `node tools/generate-fixtures.mjs --check` → `check OK: 71 files byte-identical, digests + canonical stability verified`
- checks 2–4 above → all printed their OK lines, all assertions passed.

These are fixture-consistency checks. They are **not** evidence that a
command/workspace implementation exists or conforms (packets 06/07).