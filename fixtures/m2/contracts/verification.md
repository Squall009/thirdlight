# Fixtures/m2/contracts — Verification (packet 15)

Repeatable checks that the committed packet-15 fixtures are internally
consistent and that every byte the fixtures claim about is recomputable.

**Scope limit (read first).** No packet-15 implementation exists: there is no
content storage, no importer, no migration code. These checks establish fixture
self-consistency and the realness of every digest — **not** contract conformance
by code, and not the M2 import profile (the fixtures contain no GLB files; packet
24 owns those). The proposal documents remain the normative source; where the
checker and a proposal disagree, the proposal wins and the checker is a bug.

All commands run from the repository root with the recorded toolchain
(Node v22.22.1).

## 1. Fixture consistency checker (repeatable)

```bash
node fixtures/m2/contracts/tools/check-fixtures.mjs
# actual output (2026-09-18, packet 15):
ok   self-test: 9 invalid + 3 valid parser controls, canon() order-insensitivity
ok   canonical-form: 40 JSON fixture(s) checked
ok   index: 42 index entries, 45 files on disk
ok   code-registry: 10 code(s) used by fixtures, all declared in expected.json.registry; 65 declared (accepted M1 / proposed M2) code(s) are not exercised by a fixture
ok   case-pins: 28 case->section pin(s) verified
ok   cross-ref: content-block-example.json equals envelope/valid/demo-0002-rev7-v2.json content block
ok   cross-ref: 2 catalog records, 2 scene reference(s) resolved
ok   migration: source v1 -> destination v2 transformation verified (identity, versions, revision policy, verbatim entities)
ok   source-retention: 2 source file(s) re-hashed (original-preserving migration evidence)
ok   interrupted-copy: marker phase "manifest", no envelope present (never auto-completed)
ok   preimage: 2 preimage(s) re-hashed
ok   digest-claims: every sourceDigest/sourceByteLength pair matches a committed preimage
ok   content-digest: captured-content-view.json contentDigest 8b7116a759bd251c… verified
check OK: 13 check group(s) passed, 0 problem(s)
```

What the checker actually verifies:

1. **Strict parse + canonical form.** A self-contained strict JSON parser
   (duplicate-key rejection, no `eval`, no dependency) parses every JSON fixture;
   each file must be byte-exactly `JSON.stringify(value, null, 2) + "\n"` with no
   BOM, no CR, no trailing whitespace and exactly one trailing newline.
2. **Index completeness.** Every path in `expected.json` exists, and every
   fixture file on disk is listed (only `README.md`, `verification.md`,
   `expected.json` and `tools/check-fixtures.mjs` are excluded).
3. **Real digests.** Both `source-preimages/*.bin` files are re-hashed, and every
   `sourceDigest`/`sourceByteLength` pair claimed anywhere in the fixtures must
   match a committed preimage exactly (intentionally invalid fixtures are exempt,
   e.g. `envelope/invalid/content-digest-invalid.json`).
4. **Captured view digest.** `contentDigest` is recomputed from the canonical
   JSON of the view with that member removed.
5. **Cross-references.** The standalone content block equals the valid envelope's
   `content`; `content.assets` is sorted and its versions contiguous with a
   matching `currentVersion`; every scene model reference resolves; the migration
   destination is a verbatim entity carry-over with the reset revision policy, v2
   versions, empty containers, a carried name and a new identity; the source
   files' SHA-256 values match `expected.json.sourceHashes`; the interrupted copy
   has a marker and no envelope.
6. **Codes and pins.** Every code used by a fixture is declared in
   `expected.json.registry` (accepted M1 sets + the codes this proposal adds), and
   every `cases/*.json` pin names a section heading that exists in the proposal it
   pins.

`--write` rewrites fixtures into canonical form (used once during authoring; the
committed tree is canonical and `--write` is a no-op now).

### 1.1 Self-test and negative control (the checks are not vacuous)

The checker's `self-test` group runs negative controls on its own strict parser
every time it runs: 9 invalid inputs must be rejected (duplicate key at top level,
via `\u0061` escaping, and nested; trailing garbage; leading zero; raw control
character; unterminated string; missing colon; trailing comma) and 3 valid inputs
must parse to the expected values; `canon()` must be key-order insensitive.

A whole-checker negative control (corrupt one digest in a **copy** of the tree and
confirm the failure is reported) is recorded verbatim in
`docs/acceptance/evidence-m2/15/05-negative-control.txt`:

```bash
cp -r fixtures/m2/contracts /tmp/tl15-neg
# set content.assets[0].versions[0].sourceDigest = 'deadbeef' x 8 in
#   /tmp/tl15-neg/envelope/valid/demo-0002-rev7-v2.json
TL15_REPO_ROOT=$PWD node /tmp/tl15-neg/tools/check-fixtures.mjs
# actual output:
# FAIL cross-ref: catalog/content-block-example.json does not equal the valid envelope content block
# FAIL digest-claims: envelope/valid/demo-0002-rev7-v2.json: sourceDigest deadbeef… matches no committed preimage
# check FAILED: 11 check group(s) passed, 2 problem(s)
```

(One failure is the intended digest failure; the other is expected because the
content block of the valid envelope and the standalone copy must be identical.)
`TL15_REPO_ROOT` exists only so the checker can run against a copy while still
resolving the proposal sections that case fixtures pin.

## 2. Independent recomputation (outside the checker)

```bash
sha256sum fixtures/m2/contracts/source-preimages/placeholder-a.bin \
          fixtures/m2/contracts/source-preimages/placeholder-b.bin
# dc3e9a88ab49347752fb5d66c0e39ab48f371fa57ecc1f4bcb4519259b8c0967  placeholder-a.bin
# e5a1ea14d3910a126a20279038d478a6cd40258cf401b22eea321f94ff95eb41  placeholder-b.bin

python3 - <<'PY'
import hashlib, json, pathlib
r = pathlib.Path('fixtures/m2/contracts')
view = json.loads((r / 'catalog/captured-content-view.json').read_text())
digest = view.pop('contentDigest')
canon = lambda v: ('[' + ','.join(map(canon, v)) + ']') if isinstance(v, list) else (
    '{' + ','.join(json.dumps(k) + ':' + canon(v[k]) for k in sorted(v)) + '}' if isinstance(v, dict)
    else json.dumps(v, separators=(',', ':')))
print(hashlib.sha256(canon(view).encode()).hexdigest() == digest)   # -> True
PY
```

Both agree with the values committed in the fixtures and in
`expected.json`.

## 3. Repository toolchain (must stay green; docs/fixtures-only packet)

```bash
npm test; npm run typecheck; npm run check-deps; npm run check-boundaries; npm run build
```

Recorded output: `docs/acceptance/evidence-m2/15/03-toolchain.txt`
(841/841 tests in 66 files; typecheck clean for all 10 packages (backend, commands, editor, exporter, mcp-adapter, project-model, protocol, runtime, three-adapter, workspace); dependency pins
exact; boundaries OK 10 packages / 150 files / 514 specifiers; build 4 built,
0 skipped). No code, lockfile, package or contract file was changed by packet 15,
so these results are the accepted M1/M2 baseline re-measured, not new evidence
about the proposals.

## 3a. Packet-17 checks (added 2026-09-18)

```bash
node fixtures/m2/contracts/tools/check-fixtures.mjs
# packet-17 check groups in the actual output:
ok   p17-numerics: 34 constants, 8 slope rows, 10 settings cases, 20 validation cases re-derived
ok   p17-traces: 16 traces, 178 sampled step rows and 48 derived expectations replayed
ok   p17-input: 15 mapping cases and 5 step-indexed sequences replayed
ok   p17-catchup: 7 scheduler cases and 8 ownership/combination cases replayed
ok   p17-failures: 21 failure cases checked (codes, state, durable effect)
```

What these groups verify (all against the PROPOSED packet-17 contracts):

1. **`p17-numerics`** — every constant of `physics.md` §7 equals its contract
   value (packet-14-measured vs contract-selected labels included); `cos(45°)`,
   `v²/2g`, the 12-step acceleration and 8-step deceleration counts are
   re-derived; the discrete apex is inside the declared `±0.05 m` tolerance; each
   slope row's `supportNormalY`, `grounded` and `slidesWhenIdle` are recomputed;
   the settings-resolution cases match the six-key registry table (unknown key,
   wrong type, out-of-range and the cross-key rule); and each collider/controller
   validation case declares exactly one outcome or code with a declared limit.
2. **`p17-traces`** — an independent implementation of the `platformer.md` §7
   step order plus the scripted analytic port replays every sampled row
   (position, velocity, grounded, airborne, coyote, buffer, contacts) within the
   fixture's declared `replayToleranceM`, re-derives every derived expectation
   (apex/landing, jump starts, wall/head contact steps, blocked deltas, ledge
   landing) and checks the no-Z-drift columns of the expectation table itself.
3. **`p17-input`** — the dead-zone rescaling, digital/D-pad/stick arbitration,
   jump phase chain, latch semantics, suspension (`awaitingRelease`) and the
   invalid-frame set are replayed; the pressed count of every step-indexed
   sequence matches the declared value exactly.
4. **`p17-catchup`** — the accepted `runtime.md` §5 arithmetic is re-run: the
   8-step cap, drop-and-resync, sub-step frames, non-monotonic clocks, the
   12-step pre-roll, one sample per executed step, contiguous indices (no phantom
   steps) and no repeated press edge; the ownership/combination matrix matches
   `platformer.md` §2.3 and the canonical phase order.
5. **`p17-failures`** — every required failure path declares a runtime state, a
   durable effect, and only codes present in the registry; the fail-stop state
   machine never declares rollback and only allows `failed → disposed`.

The independent recompute is repeatable:

```bash
python3 docs/acceptance/evidence-m2/17/independent-recompute.py --verify
# OK   physics/numerics.json / platformer/traces.json / platformer/failures.json
# OK   input/action-sequences.json / runtime/catchup.json
```

Negative control (a copy of the tree, five corrupted values; recorded verbatim in
`docs/acceptance/evidence-m2/17/05-negative-control.txt`):

```bash
TL15_REPO_ROOT=$PWD node /tmp/tl17-neg/contracts/tools/check-fixtures.mjs
# FAIL code-registry: platformer/failures.json: code "input_phantom" is not declared …
# FAIL p17-numerics: constant groundSnap = 0.2, expected 0.1
# FAIL p17-numerics: accelStepsToRunSpeed must be 12
# FAIL p17-traces: jump-hold-full-height/41: position … != …
# FAIL p17-input: M5-stick-rescaled: frame … != …
# FAIL p17-catchup: C3-stall-drop-and-resync: droppedSteps 112 != 100
# FAIL p17-failures: F01-focus-loss: code input_phantom is not in the runtime/model registry
# check FAILED: 21 check group(s) passed, 7 problem(s)
```

## 4. What is deliberately unverified

- **No GLB is imported.** The M2 import profile (`assets.md` §7), the extension
  allowlist (candidate `KHR_materials_unlit`) and the decoded caps are specified,
  not tested; packet 24 must test them against the pinned loader and record the
  result before the allowlist is fixed at Gate E.
- **No storage/publication code runs.** The declarative `cases/*.json` and
  `cases/constructed-cases.md` are the test specifications for packets 23/24.
- **No migration executes.** The expected destination bytes are a fixture
  expectation; the resume/idempotence behavior of `migrateProjectCopy` is pinned
  by contract text and one case fixture, not by a run.
- **No bytes are claimed to be a valid GLB.** The preimages are opaque
  placeholders (documented in `source-preimages/preimages.json`).
- The bound values in `content-storage.md` §9 / `assets.md` §6 are proposals and
  must be re-checked at Gate E before tests depend on them.
- **No runtime/input/physics code exists.** The packet-17 traces are replayed
  against a *scripted analytic port* (flat ground and axis-aligned statics), not
  against Rapier: no WASM is loaded, no collider is created and no browser or
  gamepad is involved. The real adapter (packet 31), the browser course and the
  physical gamepad evidence (packets 30/32/37) remain unverified, and the
  controller numbers are the *contract's* discrete model, whose step order mirrors
  the probe so the jump trajectory agrees to `3e-7 m` (the probe reported
  `1.2297 m` from the nominal `0.900 m` center; the contract model reports
  `1.2196625 m` from the settled `0.910 m` center — the same trajectory).
- The Rapier pin is not installed: `@dimforge/rapier2d-compat@0.20.0` appears only
  as contract text and a proposed dependency edge (packet 31 adds it to the
  lockfile after Gate E).

## 3b. Packet-18 checks (added 2026-09-18)

```console
# from the repository root, actual output (2026-09-18, packet 18):
$ node fixtures/m2/contracts/tools/check-fixtures.mjs
ok   p18-source-graphs: 41 source-graph case(s) (16 container + 25 constructed) re-derived from behaviors.md §4.3/§6
ok   p18-intents: 6 quantization row(s), 18 intent step(s) and 4 effective-frame row(s) replayed
ok   p18-runtime-failures: 21 runtime failure case(s) and 6 flood case(s) re-derived
ok   p18-publication: 14 publication case(s) replayed through the prepare/publish/build state machine
ok   p18-example: the example manifest is digest-bound, links one pinned module, declares a numeric property and replays its intent trace
ok   p18-container-hash: 16 behavior source container(s) re-hashed and merged into the digest map
check OK: 27 check group(s) passed, 0 problem(s)
```

Second implementation (python3, no shared code with the checker):

```console
$ python3 docs/acceptance/evidence-m2/18/independent-recompute.py
verdict: OK (5 group(s) re-derived, 0 mismatch(es))
```

Negative control (six corrupted values in a copy — one per p18 group):

```console
$ TL15_REPO_ROOT=<repo> node /tmp/tl18-neg/tools/check-fixtures.mjs
FAIL code-registry: behaviors/source-graphs.json: code "behavior_sandbox_escape" is not declared in expected.json registry
FAIL p18-source-graphs: G03-bare-import: containerDigest … != …
FAIL p18-source-graphs: G07-eval-call: code derived "behavior_dynamic_code" != expected "behavior_sandbox_escape"
FAIL p18-intents: I06-range: detail derived "value" != expected "shape"
FAIL p18-runtime-failures: L01-log-flood-single-step: dropped derived 984 != expected 900
FAIL p18-publication: P01-staged-edit-does-not-change-active-play: revision derived 5 != expected 4
FAIL p18-example: manifestDigest 5e97f3c9… != 00000000…
FAIL p18-container-hash: bare-import.json: sha256 … != declared …
check FAILED: 27 check group(s) passed, 17 problem(s)   # exit 1
```

Packet-18 specifics: the containers under `behaviors/source-preimages/` are real
committed byte strings (their SHA-256/lengths are recomputed and merged into the
generic digest check, so `sourceDigest`/`sourceByteLength` claims anywhere in the
fixture set stay verifiable); `drift-example.output.js` is an **opaque stand-in**
for a prepared output (no compiler exists before packet 33) and is labelled as
such in the fixture, the checker note and the evidence manifest; the source-graph
verdicts and the publication/flood/intent models are re-derived by both the Node
checker and the python3 implementation, i.e. they are contract text replayed, not
a record of a compiler run.

## 4b. Packet-18 limits of this evidence

- **No compiler, no runtime host and no command exists.** The packet-18 fixtures
  assert the *proposed* rules: source-graph validation order and codes, compiler
  bounds, the manifest digest chain, the intent validation order and caps, the
  log/intent flood accounting and the prepare → publish → build state machine.
  Nothing here proves that an implementation would agree, and no bundle, byte
  count, timing or browser result is claimed.
- **No script was executed anywhere.** The "valid example" is a manifest plus a
  digest-bound stand-in output and a re-derived intent trace (a declared numeric
  property `speed` mapped to a quantized `control_move`); actual execution is
  packets 33–35, and the trust boundary is untested by construction.
- **The trust disposition is a pre-approval.** `behaviors.md` §2 records "owner
  pre-approval (autonomous M2 build instruction, 2026-09-18); final manual review
  pending" — a pre-approval, not an independent review. The no-timeout /
  no-sandbox limitations are stated normatively and are not mitigated.
- **The compiler timeout (2 000 ms) and every byte bound are proposals** for
  Gate E; no timing was measured (esbuild's synchronous transform cannot be
  preempted mid-call, so the bound is described as cooperative).
- **`behavior_build_failed` and the `preparation_missing` reason are specified,
  not observed**; the build path is packets 33/36.

## 6. Packet-19 additions (delivery fixtures; actual output 2026-09-18)

Six new check groups cover `delivery/**`:

```bash
node fixtures/m2/contracts/tools/check-fixtures.mjs
# actual output (2026-09-18, packet 19):
ok   p19-protocol: 14 route(s) and 8 bridge message(s) re-derived; 51 error mapping(s) checked
ok   p19-locator: 14 locator case(s) re-derived (TTL, grace, traversal/listing, build states, redaction)
ok   p19-upload: 7 upload/stage bound case(s) re-derived (frame, offset, stage, open stages, project cap)
ok   p19-scans: 13 format-aware scan case(s) re-derived (text vs GLB/WASM/closure, no text scan on binaries)
ok   p19-manifest: manifest identity, 2 asset(s), 1 behavior(s), closure fetch count 4 and licenses re-derived
ok   p19-relay: 10 relay case(s) re-derived (step range, exclusive mode, limits, no-browser unavailable)
check OK: 33 check group(s) passed, 0 problem(s)
```

What the new groups establish (and what they do not):

1. **Protocol surface** — every route path is parameterised by identifiers only
   (no `/`, `..`, `//`), authoring routes require a project token + the origin
   allowlist, preview routes are capability-only and are not `/api/v1`
   surfaces, every error code is in the declared registry, every HTTP status
   equals the sessions.md §11.2 class mapping (with `unauthorized` → 401 as the
   accepted §11.3 exception), bridge messages are `tl.*` v2, non-binary and
   within the message bound, and WS state frames forbid binary content.
2. **Locator** — the `contentId` pattern length is derived from `idBytes`,
   then every case's served/status/code/cache-max-age is re-derived from the
   TTL, the grace window and the path kind (declared vs listing/traversal/
   other-content-id/undeclared/build-missing/build-in-flight/malformed-id/
   corrupt-blob); a served read's cache lifetime can never exceed the remaining
   TTL.
3. **Upload bounds** — the limit classification order (frame → offset → stage
   total → open stages → project staged bytes) is re-derived per case, with the
   exact `limit` reason.
4. **Format-aware scans** — GLB/WASM/closure cases are never judged by the
   text scan; text cases always are; the fault→code mapping is the checker's
   own table (independent of the fixture's `expect`).
5. **Manifest** — `buildId` is recomputed as the canonical document digest of
   the manifest without `buildId`; `buildOptionsDigest` is recomputed from the
   option record; the scene/content digests are recomputed from the committed
   envelope/view; every declared asset digest/length is re-hashed from a
   committed preimage/container; paths must be relative and follow
   `content/sha256/<digest>` / `behaviors/<outputDigest>.js`; the closure fetch
   count must be `1 + |declared artifacts|`; licenses and the
   snapshot/build/output identity rule are asserted.
6. **Input relay** — the applied step range is derived from the base step index
   and frame count, exclusive-mode clearing is asserted, and the failure
   precedence (mode → play → browser → physical conflict → limits → ordering →
   timeout) is re-derived.

**Scope limit.** These are shape/arithmetic checks over committed fixtures. No
content byte route, locator, build, manifest or relay exists; nothing is
executed and no browser is involved. The proposals remain normative and the
checker is a bug if it disagrees with them.
