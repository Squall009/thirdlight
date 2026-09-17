# Packet 01 review-correction checks

Run this block from the repository root with Node and Python 3. No packages,
filesystem writes, or production implementation are needed. It checks fixture
construction, golden bytes, duplicate-key evidence, the old quaternion bug,
and JSON numeric overflow. It **does not** implement or prove the future
project-model validator. Packet 05 must run the normative index and constructed
cases against the actual public APIs; packet 07 must test envelope persistence.

```bash
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
const root = 'fixtures/project-model';
const text = p => fs.readFileSync(path.join(root, p), 'utf8');
const json = p => JSON.parse(text(p));
const index = json('expected.json');
assert.equal(index.indexVersion, 2);
const paths = index.entries.map(e => e.path);
assert.equal(new Set(paths).size, paths.length);
for (const e of index.entries) {
  const files = e.kind === 'project'
    ? [`${e.path}/project.json`, `${e.path}/scenes/main.json`] : [e.path];
  for (const file of files) assert(fs.existsSync(path.join(root, file)), file);
  if (!e.valid) assert(e.expectedCodes.length > 0);
  if (e.expectedErrors) {
    assert.equal(e.expectedErrors.length, e.expectedErrorCount);
    assert.deepEqual([...new Set(e.expectedErrors.map(x => x.code))].sort(),
      [...e.expectedCodes].sort());
  }
  if (e.expectedNormalized) {
    const golden = text(e.expectedNormalized);
    assert.equal(golden, JSON.stringify(JSON.parse(golden), null, 2) + '\n');
  }
}
const failures = [];
let parsed = 0;
function walk(dir) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p);
    else if (p.endsWith('.json')) {
      try { JSON.parse(fs.readFileSync(p, 'utf8')); parsed++; }
      catch { failures.push(path.relative(root, p)); }
    }
  }
}
walk(root);
assert.deepEqual(failures, ['invalid/non-strict-json.json']);
const contract = fs.readFileSync('docs/contracts/project-model.md', 'utf8');
const template = contract.split('## 15. Default scene')[1].match(/```json\n([\s\S]*?)\n```/)[1];
assert.deepEqual(JSON.parse(template), json('valid/minimal-scene.json'));
const input = json('valid/quaternion-round-trip.json');
const golden = json('expected/quaternion-round-trip.json');
assert.equal(input.entities.length, golden.entities.length);
const norm = q => Math.sqrt(q.reduce((sum, v) => sum + v * v, 0));
const oldNormalize = q => q.map(v => v / norm(q));
const q = input.entities[0].components.transform.rotation;
assert.notEqual(JSON.stringify(oldNormalize(q)), JSON.stringify(oldNormalize(oldNormalize(q))));
for (let i = 0; i < input.entities.length; i++) {
  const a = input.entities[i], b = golden.entities[i];
  const t = a.components.transform;
  assert(Math.abs(norm(t.rotation) - 1) <= 1e-4);
  assert.deepEqual(b.components.transform.rotation, t.rotation);
  assert.deepEqual(b.components.transform.scale, [1, 1, 1]);
  assert.deepEqual(b.components.transform.position, [0, 0, 0]);
  assert.equal(a.id, b.id);
}
assert(Object.is(input.entities[0].components.transform.position[0], -0));
assert(!Object.is(golden.entities[0].components.transform.position[0], -0));
assert.deepEqual(golden.entities[0].components.camera,
  { type: 'perspective', fovY: 60, near: 0.1, far: 100 });
assert.equal(JSON.stringify(JSON.parse(JSON.stringify(golden))), JSON.stringify(golden));
const overflow = json('invalid/numeric-overflow.json');
assert.deepEqual(overflow.entities[0].components.transform.position, [Infinity, -Infinity, 0]);
assert.equal(json('invalid/duplicate-key.json').schemaVersion, 1); // evidence of lost duplicate
const mixedManifest = json('invalid/mixed-schema-versions/project.json');
const mixedScene = json('invalid/mixed-schema-versions/scenes/main.json');
assert.equal(mixedManifest.schemaVersion, 1);
assert.equal(mixedScene.schemaVersion, 2);
assert.notEqual(mixedManifest.scenes[0].id, mixedScene.sceneId);
const utf8 = s => new TextEncoder().encode(s);
const malformed = Uint8Array.from([...utf8('{"name":"'), 0xc3, 0x28, ...utf8('"}')]);
assert.throws(() => new TextDecoder('utf-8', { fatal: true }).decode(malformed));
assert.throws(() => JSON.parse('{"schemaVersion":2,"schemaVersion":1,}'));
console.log(`Node: ${index.entries.length} index entries checked; ${parsed} JSON files parsed, one intentional syntax rejection; quaternion/golden/overflow/encoding evidence passed.`);
NODE
python3 <<'PY'
import json
from pathlib import Path

class DuplicateKey(Exception):
    pass

def unique(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise DuplicateKey(key)
        obj[key] = value
    return obj

root = Path('fixtures/project-model')
duplicates = []
for p in sorted(root.rglob('*.json')):
    # Python accepts literal NaN by default: don't use it for syntax evidence.
    # The Node check above owns the intentional non-strict syntax fixture.
    if p.name == 'non-strict-json.json':
        continue
    try:
        json.loads(p.read_text(), object_pairs_hook=unique)
    except DuplicateKey as e:
        duplicates.append((str(p.relative_to(root)), str(e)))
assert duplicates == [('invalid/duplicate-key.json', 'schemaVersion')], duplicates
nested = '{"schemaVersion":2,"future":{"a/b~":0,"a\\u002fb~":1}}'
try:
    json.loads(nested, object_pairs_hook=unique)
    raise AssertionError('escaped nested duplicate missed')
except DuplicateKey as e:
    assert str(e) == 'a/b~'
print('Python: only the intentional escaped-key duplicate was rejected; nested escaped duplicate evidence passed.')
PY
```
