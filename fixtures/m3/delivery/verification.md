# fixtures/m3/delivery — verification record (PROPOSED, packet 42)

**Status: PROPOSED fixtures for `docs/planning/m3-contracts/delivery.md`. Not an
implementation, not acceptance evidence.** The checker re-derives every declared
value from the committed files; it contains no builder, host, server or product
import.

## 1. Checker

```
node fixtures/m3/delivery/tools/check-fixtures.mjs
```

Observed 2026-09-19: `groups: 16, checks passed: 153, failed: 0`,
`all checks passed`, exit `0`. Groups: `index`, `canonical`, `manifest`,
`version`, `repro`, `settings`, `wire`, `relay`, `runs`, `controls`, `csp`,
`mime`, `closure`, `graph`, `scan`, `deps`.

`--report out.json` writes the bounded report. `TL42_FIXTURE_ROOT=<copy>` runs
against a copy.

## 2. Deliberate-corruption negative control

```
node fixtures/m3/delivery/tools/check-fixtures.mjs --corrupt-control
```

Observed 2026-09-19, exit `0` for the control itself:

| Control | Corruption | Checker exit |
|---|---|---|
| `digest-corruption` | `manifest/manifest-v2-example.json` `buildId` replaced with 64 zeros | `1` (rejected) |
| `semantic-corruption` | `wire/relay-cases.json` case `R7` (no browser) expectation changed to `code: "ok"` | `1` (rejected) |

Both controls copy the tree to a temp directory first; the committed fixtures are
never modified.

## 3. Independent digest re-derivation (different code path)

`buildId` is defined as `sha256(JSON.stringify(manifestWithoutBuildId, null, 2) +
"\n")` UTF-8 (delivery.md §2.3). Three independent paths were run against the
committed `manifest/manifest-v2-example.json` and all three produced
`41b5a60bc73c3a8f8dd65edd4acf95622ca1e80f1ae577502ba00cecbf2ee536`:

```console
$ node -e "const {createHash}=require('node:crypto');const fs=require('node:fs');
  const m=JSON.parse(fs.readFileSync('manifest/manifest-v2-example.json','utf8'));
  delete m.buildId; const s=JSON.stringify(m,null,2)+'\n';
  console.log(createHash('sha256').update(Buffer.from(s,'utf8')).digest('hex'));"
41b5a60bc73c3a8f8dd65edd4acf95622ca1e80f1ae577502ba00cecbf2ee536

$ python3 -c "import json,hashlib; m=json.load(open('manifest/manifest-v2-example.json'));
  del m['buildId']; s=json.dumps(m,indent=2,ensure_ascii=False,separators=(',',': '))+'\n';
  print(hashlib.sha256(s.encode()).hexdigest())"
41b5a60bc73c3a8f8dd65edd4acf95622ca1e80f1ae577502ba00cecbf2ee536

$ node -e "const fs=require('node:fs');const m=JSON.parse(fs.readFileSync('manifest/manifest-v2-preimage.json','utf8'));
  process.stdout.write(JSON.stringify(m,null,2)+'\n')" | sha256sum
41b5a60bc73c3a8f8dd65edd4acf95622ca1e80f1ae577502ba00cecbf2ee536  -
```

`node:crypto`, CPython `hashlib` and coreutils `sha256sum` are independent
implementations; agreement is evidence that the fixture's canonical bytes and the
declared preimage rule are unambiguous. The checker itself uses `node:crypto`; it
is deliberately not the only derivation.

## 4. Fixture coverage map

| Area | Fixture | Contract section |
|---|---|---|
| digest preimages | `manifest/{scene,content-view}-preimage.json`, `digests/expected.json` | delivery §2.2–§2.3 |
| manifest v2 | `manifest/{manifest-v2-preimage,manifest-v2-example}.json`, `manifest/v1-v2-rules.json` | delivery §2 |
| reproducibility | `manifest/reproducibility.json` | delivery §2.4 |
| C35-5 / B16 | `settings/pinned-run.json`, `manifest/variants/*` | delivery §3 |
| wire | `wire/{control,observe}-{request,result}.json`, `wire/relay-cases.json` | delivery §5–§6 |
| run identity / controls | `runs/run-identity.json`, `controls/control-cases.json` | delivery §4, §5 |
| CSP / MIME / closure | `closure/{csp-rows,mime-cache-rows,fetch-graph,scan-rows,export-tree}.json` | delivery §7 |
| dependencies | `deps/dependency-rows.json` | delivery §3.4 |

## 5. Limits of this verification

- No browser, network, GPU, audio or hardware claim is made or implied. The CSP
  rows cite packet-38 raw files (`docs/acceptance/evidence-m3/38/raw/engine*.json`)
  as *evidence of record*, re-read by the checker only to confirm the recorded
  blocked/allowed outcomes.
- The digest preimages are canonical-bytes stubs for the digest rule, not full
  v3 model-valid scenes (packet 39 owns model validation).
- `csp[acceptedMatchesContract]` compares the fixture text with the accepted
  `docs/contracts/sessions.md` §17.4 fence; it fails if that accepted text
  changes without a corresponding reviewed diff.
