# Verification — packet 46 storage fixtures

Repeatable checks for `fixtures/m3/storage/`. All commands run from the
repository root with the pinned Node (`package.json` engines: `node 22`;
host recorded 22.22.1).

## 1. Positive check (must exit 0)

```sh
node fixtures/m3/storage/tools/check-fixtures.mjs
echo "EXIT=$?"
```

Recorded result (packet 46): `groups: 9, checks passed: 10, failed: 0`,
`all checks passed`, `EXIT=0`.

Groups: `index`, `canonical`, `project-v3`, `project-v2`, `migration`,
`cases-migration`, `cases-durability`, `cases-media`, `no-sidecar`.

## 2. Negative control — deliberate corruption (must be detected)

The checker's built-in control makes six corrupted copies, runs the same
checks against each and requires every one to fail:

```sh
node fixtures/m3/storage/tools/check-fixtures.mjs --corrupt-control
echo "EXIT=$?"
```

Recorded result (packet 46): `corruption control: 6/6 detected (clean tree
failures: 0)`, `all corruptions detected`, `EXIT=0`. Each corruption exits
non-zero for the corrupted tree; the control itself exits 0 only when all are
detected.

Corruptions: `flip-envelope-byte`, `remove-game-key`, `zero-source-derived`,
`add-sidecar`, `tamper-index`, `v3-only-in-v2-source`.

Manual reproduction of one corrupted tree (the checker must exit 1):

```sh
rm -rf /tmp/m3-46-corrupt && cp -r fixtures/m3/storage /tmp/m3-46-corrupt
node - <<'EOF'
import('node:fs').then(({ readFileSync, writeFileSync }) => {
  const p = '/tmp/m3-46-corrupt/project-v3-demo-0003/scenes/main.json';
  const d = JSON.parse(readFileSync(p, 'utf8'));
  delete d.content.game;                       // §16.3: game is a required key
  writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
});
EOF
TL46_FIXTURE_ROOT=/tmp/m3-46-corrupt node fixtures/m3/storage/tools/check-fixtures.mjs
echo "EXIT=$?"
```

## 3. Real implementation (packet 46 tests)

The fixtures are also executed through the real workspace service:

```sh
npx vitest run packages/workspace/tests/m3-storage.test.ts \
  packages/workspace/tests/m3-migration.test.ts \
  tests/crash/m3-storage-crash.test.ts
```

Covered: the three committed valid v3 envelopes load and rebuild
byte-identically; all 21 invalid v3 envelopes are refused with their recorded
code; a real v3 `setGameConfig` writes the six-key v3 envelope through `W` and
replays a lost-ack retry; real SIGKILL at the v3 envelope boundary and at every
copy marker phase; the copy destination equals the contracts
`expected-v3-destination` fixture; the source tree is byte-identical after
success and after every refusal.
