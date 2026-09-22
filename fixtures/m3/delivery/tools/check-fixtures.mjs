/**
 * fixtures/m3/delivery/tools/check-fixtures.mjs
 *
 * Fixture consistency checker for packet 42's PROPOSED delivery contract
 * (docs/planning/m3-contracts/delivery.md and its sessions/export/dependencies/
 * runtime diffs). This is fixture tooling, NOT an implementation: it contains
 * no builder, no host, no server and no parser of product code. It re-derives
 * every declared value from the committed files with an independent
 * implementation of the declared rules:
 *
 *  1. index coverage + real bytes/sha256 of every fixture;
 *  2. canonical bytes (2-space indent, LF, one trailing newline, no BOM, no
 *     trailing whitespace) with a strict duplicate-key-rejecting parser;
 *  3. manifest v2: required key order, block digests, buildOptionsDigest and the
 *     self-identifying buildId preimage;
 *  4. manifest v1/v2 version rules (what stays v1, authoring project.json 1);
 *  5. the capturedAt reproducibility rule over two simulated trees;
 *  6. B16 settings: defaults vs changed run_speed/gravity_y hashes + numeric
 *     expectations, and the pinned-run rule;
 *  7. wire request/result schemas, bounds and the run-identity tuple;
 *  8. relay failure semantics (stale/expired/origin/source/nonce/no-browser/
 *     timeout/unavailable) and the never-crosses list;
 *  9. control separation, fresh-release and lifecycle cases;
 * 10. CSP (compared against the accepted sessions.md §17.4 text), the export's
 *     own meta policy, MIME/cache and the non-root relative closure;
 * 11. fetch/graph/scan rows incl. the 58/60 re-measure owners;
 * 12. the two new dependency units, their edges and the editor-UI rule.
 *
 * Usage (repository root):
 *   node fixtures/m3/delivery/tools/check-fixtures.mjs
 *   TL42_FIXTURE_ROOT=<copy> node fixtures/m3/delivery/tools/check-fixtures.mjs
 *   node fixtures/m3/delivery/tools/check-fixtures.mjs --report out.json
 *   node fixtures/m3/delivery/tools/check-fixtures.mjs --corrupt-control
 *
 * Exit 0 = all checks passed; 1 = at least one failed. `--corrupt-control`
 * copies the tree, corrupts one fixture (digest) and one semantic expectation,
 * runs this checker against each copy and requires a non-zero exit from both.
 *
 * Node: pinned Node 22. No dependency, no eval.
 */

import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const ROOT = process.env.TL42_FIXTURE_ROOT ? resolve(process.env.TL42_FIXTURE_ROOT) : resolve(HERE, '..');
const REPORT = (() => {
  const i = process.argv.indexOf('--report');
  return i >= 0 ? resolve(process.argv[i + 1]) : null;
})();
const EXCLUDE = new Set(['index.json', 'README.md', 'verification.md']);
const EXCLUDE_DIRS = new Set(['tools']);

const failures = [];
const passes = [];
const fail = (check, detail) => failures.push({ check, detail });
const pass = (check, detail) => passes.push({ check, detail: detail ?? null });
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const canon = (v) => `${JSON.stringify(v, null, 2)}\n`;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const jp = (v) => JSON.stringify(v);
const check = (name, ok, detail) => (ok ? pass(name, detail) : fail(name, detail));
const read = (p) => readFileSync(join(ROOT, p));
const readJson = (p) => JSON.parse(read(p).toString('utf8'));

// ---------------------------------------------------------------------------
// strict JSON parser (duplicate keys rejected, no eval)
// ---------------------------------------------------------------------------
function parseStrict(text) {
  let i = 0;
  const err = (msg) => { throw new Error(`${msg} at offset ${i}`); };
  const ws = () => { while (i < text.length && ' \n\t\r'.includes(text[i])) i += 1; };
  const string = () => {
    if (text[i] !== '"') err('expected string');
    i += 1;
    let out = '';
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') {
        const n = text[i + 1];
        if (n === 'u') { out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)); i += 6; continue; }
        const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (!(n in map)) err('bad escape');
        out += map[n]; i += 2; continue;
      }
      if (c === '"') { i += 1; return out; }
      out += c; i += 1;
    }
    return err('unterminated string');
  };
  const value = () => {
    ws();
    const c = text[i];
    if (c === '{') {
      i += 1; const obj = {}; const keys = new Set(); ws();
      if (text[i] === '}') { i += 1; return obj; }
      for (;;) {
        ws(); const k = string();
        if (keys.has(k)) err(`duplicate key ${jp(k)}`);
        keys.add(k); ws();
        if (text[i] !== ':') err('expected :');
        i += 1; obj[k] = value(); ws();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === '}') { i += 1; return obj; }
        return err('expected , or }');
      }
    }
    if (c === '[') {
      i += 1; const arr = []; ws();
      if (text[i] === ']') { i += 1; return arr; }
      for (;;) {
        arr.push(value()); ws();
        if (text[i] === ',') { i += 1; continue; }
        if (text[i] === ']') { i += 1; return arr; }
        return err('expected , or ]');
      }
    }
    if (c === '"') return string();
    if (text.startsWith('true', i)) { i += 4; return true; }
    if (text.startsWith('false', i)) { i += 5; return false; }
    if (text.startsWith('null', i)) { i += 4; return null; }
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) return err('unexpected token');
    i += m[0].length; return Number(m[0]);
  };
  const out = value(); ws();
  if (i !== text.length) err('trailing content');
  return out;
}

// ---------------------------------------------------------------------------
// fixture discovery
// ---------------------------------------------------------------------------
function listFiles(dir, acc = []) {
  for (const name of readdirSync(join(ROOT, dir)).sort()) {
    const rel = dir === '' ? name : `${dir}/${name}`;
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue;
      listFiles(rel, acc);
    } else if (!EXCLUDE.has(rel)) acc.push(rel);
  }
  return acc;
}
const onDisk = listFiles('');
const index = readJson('index.json');
const listed = Object.keys(index.files).sort();

// ---------------------------------------------------------------------------
// 1. index coverage + real bytes/sha256
// ---------------------------------------------------------------------------
{
  const missing = listed.filter((p) => !onDisk.includes(p));
  const unlisted = onDisk.filter((p) => !listed.includes(p));
  check('index[coverage]', missing.length === 0 && unlisted.length === 0,
    `missing=${jp(missing)} unlisted=${jp(unlisted)}`);
  let bad = 0;
  for (const p of listed) {
    const buf = read(p);
    const entry = index.files[p];
    if (buf.length !== entry.bytes || sha256(buf) !== entry.sha256) { bad += 1; fail(`index[${p}]`, `bytes/sha256 mismatch`); }
  }
  if (bad === 0) pass('index[digests]', `${listed.length} files`);
}

// ---------------------------------------------------------------------------
// 2. canonical serialization
// ---------------------------------------------------------------------------
for (const p of onDisk.filter((f) => f.endsWith('.json'))) {
  const raw = read(p).toString('utf8');
  let parsed;
  try { parsed = parseStrict(raw); } catch (e) { fail(`canonical[${p}]`, `strict parse: ${e.message}`); continue; }
  const ok = raw === canon(parsed) && !raw.includes('\r') && !raw.includes('\uFEFF') && !/\n[ \t]+\n/.test(raw);
  check(`canonical[${p}]`, ok, 'round-trip canonical bytes');
}

// ---------------------------------------------------------------------------
// 3. manifest v2 + digests
// ---------------------------------------------------------------------------
const preimage = readJson('manifest/manifest-v2-preimage.json');
const example = readJson('manifest/manifest-v2-example.json');
const scenePre = readJson('manifest/scene-preimage.json');
const contentPre = readJson('manifest/content-view-preimage.json');
const expected = readJson('digests/expected.json');
const rules = readJson('manifest/v1-v2-rules.json');
{
  const keys = Object.keys(example);
  check('manifest[keyOrder]', eq(keys, rules.v2.requiredKeys), jp(keys));
  check('manifest[buildIdLast]', keys[keys.length - 1] === 'buildId');
  check('manifest[example=preimage+buildId]', eq({ ...example, buildId: undefined }, { ...preimage, buildId: undefined }));
  const derivedBuildId = sha256(Buffer.from(canon({ ...example, buildId: undefined }), 'utf8'));
  check('manifest[buildId]', derivedBuildId === example.buildId, `${derivedBuildId}`);
  check('manifest[buildId=expected]', example.buildId === expected.buildId);
  const sceneDigest = sha256(Buffer.from(canon(scenePre), 'utf8'));
  const contentDigest = sha256(Buffer.from(canon(contentPre), 'utf8'));
  const gameDigest = sha256(Buffer.from(canon(contentPre.game), 'utf8'));
  const settingsDigest = sha256(Buffer.from(canon(contentPre.settings), 'utf8'));
  const mediaDigest = sha256(Buffer.from(canon(example.media), 'utf8'));
  const optionsDigest = sha256(Buffer.from(canon({
    bundler: 'esbuild@0.28.2', bundle: true, platform: 'browser', format: 'iife',
    treeShaking: false, sourcemap: false, minify: false, target: 'es2022', loaders: ['ts', 'tsx'],
  }), 'utf8'));
  for (const [name, got, want] of [
    ['scene', sceneDigest, example.sceneDigest], ['content', contentDigest, example.contentDigest],
    ['game', gameDigest, example.gameDigest], ['settings', settingsDigest, example.settingsDigest],
    ['media', mediaDigest, example.mediaDigest], ['options', optionsDigest, preimage.toolchain.optionsDigest],
  ]) check(`manifest[digest:${name}]`, got === want, got);
  for (const [name, got, want] of [
    ['scene', sceneDigest, expected.sceneDigest], ['content', contentDigest, expected.contentDigest],
    ['game', gameDigest, expected.gameDigest], ['settings', settingsDigest, expected.settingsDigest],
    ['media', mediaDigest, expected.mediaDigest], ['options', optionsDigest, expected.buildOptionsDigest],
  ]) check(`manifest[expected:${name}]`, got === want);
  const assetOrder = example.assets.map((a) => `${a.assetId}@${a.version}`);
  check('manifest[assetOrder]', eq(assetOrder, [...assetOrder].sort()), jp(assetOrder));
  check('manifest[assetPaths]', example.assets.every((a) => a.path === `content/sha256/${a.sourceDigest}`));
  check('manifest[assetKinds]', example.assets.every((a) => rules.v2.assetKinds.includes(a.kind)) && example.assets.some((a) => a.kind === 'audio'));
  check('manifest[moduleOrder]', eq(example.modules.map((m) => m.id), [...example.modules.map((m) => m.id)].sort()));
  check('manifest[enginePinOrder]', eq(example.enginePins.map((p) => p.id), [...example.enginePins.map((p) => p.id)].sort()));
  check('manifest[recipeOrder]', eq(Object.keys(example.recipes), [...Object.keys(example.recipes)].sort()));
  check('manifest[settingsOrder]', eq(Object.keys(example.settings), ['gravity_y', 'run_speed', 'jump_velocity', 'max_fall_speed', 'max_slope_climb_deg', 'min_slope_slide_deg']));
  check('manifest[mediaIdentity]', example.media.animation.length >= 1 && example.media.animation.every((a) => a.profileDigest === sha256(Buffer.from(canon(a.roles), 'utf8'))));
  check('manifest[snapshotId]', example.snapshotId === `${example.projectId}@r${example.revision}`);
}

// ---------------------------------------------------------------------------
// 4. version rules
// ---------------------------------------------------------------------------
{
  check('version[v1Readable]', rules.v1.manifestVersion === 1 && rules.v1.readableUnderOldMeaning === true && rules.v1.inPlaceUpgrade === false);
  check('version[v1NoM3Keys]', !rules.v1.requiredKeys.some((k) => ['gameDigest', 'settingsDigest', 'mediaDigest', 'settings', 'game', 'media'].includes(k)));
  check('version[v1NoKind]', rules.v1.assetRowsHaveKind === false);
  const v2Added = rules.v2.requiredKeys.filter((k) => !rules.v1.requiredKeys.includes(k));
  check('version[v2Added]', eq(v2Added, rules.v2.addedKeys), jp(v2Added));
  check('version[v2Superset]', rules.v1.requiredKeys.every((k) => rules.v2.requiredKeys.includes(k)));
  check('version[authoringProjectJson]', rules.authoringDocument.field === 'schemaVersion' && rules.authoringDocument.value === 1);
  check('version[assetsGainKind]', rules.v2.changedKeyMeanings.some((c) => c.key === 'assets' && c.change.includes('kind')));
  check('version[recipes]', eq(rules.v2.recipes, ['behavior-source', 'gltf-glb', 'pcm-wav']));
}

// ---------------------------------------------------------------------------
// 5. reproducibility
// ---------------------------------------------------------------------------
{
  const repro = readJson('manifest/reproducibility.json');
  check('repro[carriers]', eq(repro.timestampCarriers.map((c) => c.path), ['manifest.json#capturedAt', 'meta.json#exportedAt']));
  const a = { ...preimage, capturedAt: repro.trees[0].capturedAt };
  const b = { ...preimage, capturedAt: repro.trees[1].capturedAt };
  const idA = sha256(Buffer.from(canon(a), 'utf8'));
  const idB = sha256(Buffer.from(canon(b), 'utf8'));
  check('repro[distinctRawBuildIds]', idA !== idB && repro.expectation.distinctRawBuildIds === true);
  const normalize = (m, tree) => ({ ...m, capturedAt: '<normalized>' });
  const nA = sha256(Buffer.from(canon(normalize(a, repro.trees[0])), 'utf8'));
  const nB = sha256(Buffer.from(canon(normalize(b, repro.trees[1])), 'utf8'));
  check('repro[identicalAfterNormalization]', nA === nB && repro.expectation.identicalAfterNormalization === true);
  const m3 = ['gameDigest', 'settingsDigest', 'mediaDigest', 'settings', 'game', 'media'];
  check('repro[m3Additions]', eq(repro.m3Additions, m3) && m3.every((k) => repro.neverNormalized.includes(k)));
  check('repro[neverNormalizeDigests]', ['contentDigest', 'gameDigest', 'settingsDigest', 'mediaDigest'].every((k) => repro.neverNormalized.includes(k)));
}

// ---------------------------------------------------------------------------
// 6. B16 settings + pinned run
// ---------------------------------------------------------------------------
{
  const variant = readJson('manifest/variants/settings-variant.json');
  const changedPre = readJson(variant.changedContentPreimageFile);
  const changedCanon = canon(changedPre);
  check('settings[changedDigest]', sha256(Buffer.from(changedCanon, 'utf8')) === variant.changed.contentDigest);
  check('settings[changedDigest=expected]', variant.changed.contentDigest === expected.changed.contentDigest);
  check('settings[changedSettingsDigest]', sha256(Buffer.from(canon(changedPre.settings), 'utf8')) === variant.changed.settingsDigest && variant.changed.settingsDigest === expected.changed.settingsDigest);
  check('settings[changedValues]', changedPre.settings.run_speed === 6 && changedPre.settings.gravity_y === -30);
  check('settings[unchangedBlocks]', variant.changed.unchanged.sceneDigest === preimage.sceneDigest
    && variant.changed.unchanged.gameDigest === preimage.gameDigest
    && variant.changed.unchanged.mediaDigest === preimage.mediaDigest);
  check('settings[buildIdChanges]', variant.buildIdChanges === true && variant.changed.contentDigest !== preimage.contentDigest);
  // controller: the setting is the target speed; physics: free fall vy = g * steps / hz
  const { runSpeedController, gravityPhysics } = variant.expected;
  const simHz = gravityPhysics.simHz;
  check('settings[controllerTarget]', runSpeedController.setting === changedPre.settings.run_speed && runSpeedController.targetSpeedMps === changedPre.settings.run_speed);
  for (const row of gravityPhysics.freeFallVyAfter) {
    const want = changedPre.settings.gravity_y * (row.steps / simHz);
    check(`settings[physics:${row.steps}]`, Math.abs(want - row.vy) <= gravityPhysics.toleranceMps, `${want} vs ${row.vy}`);
  }
  const pinned = readJson('settings/pinned-run.json');
  check('settings[pinnedRunSpeed]', pinned.expectation.pinnedObservedRunSpeed === 4 && pinned.run.runSpeed === 4);
  check('settings[pinnedGravity]', pinned.expectation.pinnedObservedGravityY === -19.62 && pinned.run.gravityY === -19.62);
  check('settings[pinnedIdentity]', pinned.expectation.pinnedBuildIdUnchanged === true
    && pinned.expectation.pinnedRunIdUnchanged === true
    && pinned.expectation.locatorBytesUnchanged === true
    && pinned.expectation.authoringRevisionChangeDoesNotReloadPinnedRun === true
    && pinned.run.buildId === example.buildId
    && pinned.laterEdit.newRevision === 13);
}

// ---------------------------------------------------------------------------
// 7-8. wire + relay
// ---------------------------------------------------------------------------
{
  const req = readJson('wire/control-request.json');
  const res = readJson('wire/control-result.json');
  const obs = readJson('wire/observe-request.json');
  const obsRes = readJson('wire/observe-result.json');
  const relay = readJson('wire/relay-cases.json');
  const runs = readJson('runs/run-identity.json');
  check('wire[controlCommands]', eq(req.commands, ['start', 'replay', 'mute', 'unmute']) && req.commands.includes(req.body.command));
  check('wire[controlBodyKeys]', eq(Object.keys(req.body).sort(), ['command', 'expectedRunId']));
  check('wire[controlResultKeys]', eq(Object.keys(res), ['ok', 'playSessionId', 'snapshotId', 'buildId', 'runId', 'command', 'state', 'acceptedAtStep', 'inputMode']));
  check('wire[observeRequestKeys]', eq(Object.keys(obs.body), ['timeoutMs']) && obs.bounds.timeoutMs.default === 5000);
  check('wire[observeResultKeys]', eq(Object.keys(obsRes).sort(), ['buildId', 'checkpointActive', 'checkpointId', 'deathCount', 'eventCount', 'eventDropped', 'events', 'failed', 'goalReached', 'inputMode', 'observedAt', 'ok', 'playSessionId', 'revision', 'runId', 'simTime', 'snapshotId', 'sound', 'state', 'stepIndex'].sort()));
  check('wire[observeIdentity]', runs.tuple.every((k) => k === 'playSessionId' || k in obsRes));
  const states = ['awaitingStart', 'playing', 'respawning', 'won', 'failed'];
  check('wire[observeState]', states.includes(obsRes.state));
  check('wire[eventsBound]', obsRes.events.length <= 32 && obsRes.events.every((e) => typeof e.id === 'string' && typeof e.stepIndex === 'number' && typeof e.deathCount === 'number'));
  check('wire[soundStatus]', ['muted', 'blocked', 'ready', 'unavailable'].includes(obsRes.sound.status) && typeof obsRes.sound.unlocked === 'boolean' && typeof obsRes.sound.voices === 'number');
  check('wire[noBinaryOrCapability]', !jp(obsRes).match(/base64|data:image|\/play-content\/|Bearer |contentId/i));
  check('relay[caseCount]', relay.cases.length === 12, `${relay.cases.length}`);
  const codes = new Set(relay.cases.map((c) => c.expect.code).filter(Boolean));
  const require = ['game_run_stale', 'play_locator_expired', 'play_not_found', 'bad_origin', 'game_relay_rejected', 'session_unavailable', 'game_relay_timeout', 'input_relay_conflict', 'game_command_invalid', 'limits_exceeded'];
  check('relay[codes]', require.every((c) => codes.has(c)), jp([...codes]));
  const stale = relay.cases.find((c) => c.id === 'R2');
  check('relay[staleNotApplied]', stale.expect.applied === false && stale.expect.cls === 'conflict');
  const r6 = relay.cases.find((c) => c.id === 'R6');
  check('relay[sourceNonce]', r6.expect.droppedAndCounted === true && r6.expect.http === 503);
  const r7 = relay.cases.find((c) => c.id === 'R7');
  check('relay[noBrowser]', r7.expect.code === 'session_unavailable' && r7.expect.http === 503);
  const r9 = relay.cases.find((c) => c.id === 'R9');
  check('relay[timeout]', r9.expect.code === 'game_relay_timeout');
  check('relay[neverCrosses]', ['GLB bytes', 'WAV bytes', 'base64 media', 'authoring token', 'contentId capability', 'eval interface'].every((s) => relay.neverCrosses.includes(s)));
  check('runs[staleness]', runs.staleness.length === 4 && runs.staleness.some((s) => s.detect.includes('runId')) && runs.staleness.some((s) => s.detect.includes('buildId')));
  check('runs[noMixedInstances]', runs.requirement.includes('never mixes views from two runtime instances'));
}

// ---------------------------------------------------------------------------
// 9. controls
// ---------------------------------------------------------------------------
{
  const c = readJson('controls/control-cases.json');
  check('controls[channels]', eq(c.channels.gameplay.frames, ['moveX', 'jump']) && c.channels.menu.actions.includes('start') && c.channels.menu.actions.includes('replay') && c.channels.menu.actions.includes('mute') && c.channels.menu.actions.includes('menuConfirm'));
  check('controls[m2Bindings]', ['KeyA/ArrowLeft', 'KeyD/ArrowRight', 'Space'].every((b) => c.channels.gameplay.bindings.includes(b)));
  check('controls[menuNotJump]', c.channels.menu.actions.every((a) => !c.channels.gameplay.frames.includes(a)));
  check('controls[freshRelease]', c.freshReleaseRule.includes('release before') || c.freshReleaseRule.includes('requires a release'));
  const byId = Object.fromEntries(c.cases.map((x) => [x.id, x]));
  check('controls[heldStart]', byId.C1?.expect.phantomJump === false && byId.C1.expect.releaseRequiredBeforeJump === true);
  check('controls[noTickStart]', byId.C4?.expect.startSubmits === true && byId.C4.expect.movementSteps === 0);
  check('controls[noTickReplay]', byId.C5?.expect.replaySubmits === true && byId.C5.expect.movementSteps === 0);
  check('controls[race]', byId.C9?.expect.physicalIgnored === true && byId.C9.expect.inputMode === 'test' && byId.C9.expect.conflictCodeOnOverlap === 'input_relay_conflict');
  check('controls[noFakeUnlock]', byId.C10?.expect.soundStatus === 'blocked' && byId.C10.expect.fabricatedRunning === false && byId.C10.expect.trustedGesture === false);
  check('controls[hiddenResume]', byId.C11?.expect.fastForward === false && byId.C11.expect.replayedStaleEdges === false && byId.C11.expect.accumulatedTimeReset === true);
  check('controls[gamepadDisconnect]', byId.C7?.expect.stuckControl === false && byId.C7.expect.keyboardUnaffected === true);
  check('controls[gamepadBlocked]', byId.C8?.expect.unavailable === true && byId.C8.expect.secondOwner === false);
  check('controls[mute]', byId.C13?.expect.persistedInSnapshot === false && byId.C13.expect.scope === 'browser session');
  check('controls[caseCount]', c.cases.length === 13, `${c.cases.length}`);
}

// ---------------------------------------------------------------------------
// 10. CSP (compared against accepted sessions.md §17.4), MIME, closure
// ---------------------------------------------------------------------------
{
  const csp = readJson('closure/csp-rows.json');
  const sessions = readFileSync(join(REPO, 'docs', 'contracts', 'sessions.md'), 'utf8');
  // The docs-only Gate K promotion applied C38-1/S42-8, so the accepted
  // sessions.md §17.4 fence now carries the promoted token; the pre-promotion
  // one-token relationship is still asserted below and in csp-rows.json.
  const fence = /```text\n\s*(default-src 'none'; script-src 'self' 'wasm-unsafe-eval';[\s\S]*?frame-ancestors <exact authoringOrigin>)\n\s*```/.exec(sessions);
  check('csp[promotedQuoteInSessions]', fence !== null);
  if (fence) {
    const acceptedInContract = fence[1].replace(/\s+/g, ' ').trim();
    const fixturePromoted = csp.accepted.replace(csp.acceptedToken, csp.replacementToken).replace(/\s+/g, ' ').trim();
    check('csp[promotedMatchesContract]', acceptedInContract === fixturePromoted, `${acceptedInContract.slice(0, 60)}…`);
  }
  const replaced = csp.accepted.replace(csp.acceptedToken, csp.replacementToken);
  check('csp[oneTokenDiff]', replaced.includes("script-src 'self' 'wasm-unsafe-eval'") && replaced.replace(csp.replacementToken, csp.acceptedToken) === csp.accepted);
  check('csp[noEval]', csp.wasmUnsafeEvalIsNotEval === true && !replaced.includes("'unsafe-eval'"));
  let evidenceOk = true;
  for (const e of csp.evidence) {
    try { statSync(join(REPO, e.file)); } catch { evidenceOk = false; fail(`csp[evidence:${e.file}]`, 'missing'); }
  }
  if (evidenceOk) pass('csp[evidence]', `${csp.evidence.length} files`);
  const engine = JSON.parse(readFileSync(join(REPO, 'docs/acceptance/evidence-m3/38/raw/engine.json'), 'utf8'));
  const engineWasm = JSON.parse(readFileSync(join(REPO, 'docs/acceptance/evidence-m3/38/raw/engine-csp-wasm.json'), 'utf8'));
  const engineNo = JSON.parse(readFileSync(join(REPO, 'docs/acceptance/evidence-m3/38/raw/engine-nocsp.json'), 'utf8'));
  check('csp[evidenceBlocked]', engine.probe?.physicsOk === false && jp(engine.probe).includes('wasm-unsafe-eval') === false && jp(engine.probe.wasmCompile).includes("script-src 'self'"));
  check('csp[evidenceNocspOk]', engineNo.probe?.physicsOk === true);
  check('csp[evidenceWasmOk]', engineWasm.probe?.physicsOk === true);
  check('csp[exportOwnPolicy]', csp.exportOwnPolicy.tokens.includes("script-src 'self' 'wasm-unsafe-eval'") && csp.exportOwnPolicy.omittedTokens.includes('frame-ancestors') && csp.exportOwnPolicy.carrier.includes('meta'));
  check('csp[iframeGamepad]', csp.iframeGamepad.attribute === 'allow="gamepad"' && csp.iframeGamepad.requiredOn.includes('every play iframe'));

  const mime = readJson('closure/mime-cache-rows.json');
  check('mime[classes]', ['text/html; charset=utf-8', 'text/javascript; charset=utf-8', 'application/json', 'application/wasm', 'model/gltf-binary', 'audio/wav'].every((v) => Object.values(mime.contentType).includes(v)));
  check('mime[nosniff]', mime.always['X-Content-Type-Options'] === 'nosniff');
  check('mime[immutableArtifacts]', mime.previewArtifacts['Cache-Control'].includes('immutable') && mime.previewArtifacts.ETag.includes('digest'));
  check('mime[nonRootRelative]', mime.nonRootPrefix.rule.includes('relative') && mime.nonRootPrefix.rule.includes('no absolute'));

  const tree = readJson('closure/export-tree.json');
  check('closure[declaredEqualsEmitted]', tree.declaredEqualsEmitted === true);
  check('closure[standalone]', Object.values(tree.standalone).every((v) => v === false));
  check('closure[previousOutput]', tree.previousOutputPreservedOnFailure === true);
  check('closure[cancelledLoad]', tree.cancelledLoad.presented === false && tree.cancelledLoad.inFlightReadsAborted === true && tree.cancelledLoad.disposed === true && tree.cancelledLoad.pinnedPlayUnaffected === true);
  check('closure[noManifestReplacement]', tree.files.includes('manifest.json') && !tree.files.some((f) => f.includes('snapshot.json')));
}

// ---------------------------------------------------------------------------
// 11. fetch graph + scan rows
// ---------------------------------------------------------------------------
{
  const g = readJson('closure/fetch-graph.json');
  check('graph[fetchRule]', g.rule.includes('1 + |unique declared artifacts|'));
  check('graph[gameHostZeroFetch]', g.gameHostFetches === 0);
  check('graph[noGameJson]', g.noGameJsonSidecar === true && !jp([g.preview, g.export]).includes('game.json'));
  check('graph[previewList]', g.preview.fetches.includes('./manifest.json') && g.preview.fetches.includes('./scene.json') && g.preview.fetches.some((f) => f.includes('unique declared asset path')));
  check('graph[exportList]', g.export.fetches.includes('./manifest.json') && g.export.fetches.includes('./scene.json'));
  check('graph[newUnitsInGraphs]', [...g.graphEdges.preview, ...g.graphEdges.export].includes('game-host') && [...g.graphEdges.preview, ...g.graphEdges.export].includes('platformer-game'));
  check('graph[noExporterInternals]', g.graphEdges.forbiddenInRuntimeBundles.some((f) => f.includes('exporter internals')) && g.graphEdges.forbiddenInRuntimeBundles.some((f) => f.includes('editor internals')));
  check('graph[forbiddenKinds]', ['absolute URL', 'cross-origin', 'undeclared path'].every((f) => g.forbidden.includes(f)));

  const s = readJson('closure/scan-rows.json');
  check('scan[bindings]', s.unchangedBindings.some((b) => b.includes('three@0.186.0')) && s.unchangedBindings.some((b) => b.includes('§5.3')));
  const byPattern = Object.fromEntries(s.rows.map((r) => [r.pattern[0], r]));
  check('scan[fetchRow]', byPattern.d.recorded.includes('Rapier') && byPattern.d.m3Change.includes('game-host'));
  check('scan[noGameJsonFetch]', byPattern.d.m3Change.includes('NOT added'));
  check('scan[jRow]', byPattern.j.m3Change.includes('AudioContext'));
  check('scan[remeasure]', eq(s.remeasureOwners, ['58', '60']) && s.remeasureRule.includes('re-measure'));
  check('scan[narrow]', s.note.includes('never blanket-disabled'));
}

// ---------------------------------------------------------------------------
// 12. dependency rows
// ---------------------------------------------------------------------------
{
  const d = readJson('deps/dependency-rows.json');
  check('deps[units]', eq(d.units.map((u) => u.unit).sort(), ['game-host', 'platformer-game']));
  check('deps[publicSurface]', d.publicSurface['game-host'][0] === '.' && d.publicSurface['game-host'][1].includes('createGameHost') && d.publicSurface['platformer-game'][1].includes('zoneOverlap'));
  check('deps[platformerGameEdges]', eq(d.importEdges['platformer-game'], ['runtime (types)']));
  check('deps[gameHostEdges]', d.importEdges['game-host'].some((e) => e.startsWith('runtime')) && d.importEdges['game-host'].some((e) => e.startsWith('input')));
  check('deps[forbidEditor]', d.forbiddenEdges['game-host'].includes('editor (any subpath)') && d.forbiddenEdges['game-host'].includes('exporter (any subpath)'));
  check('deps[forbidConcrete]', d.forbiddenEdges['game-host'].includes('three (direct)') && d.forbiddenEdges['game-host'].includes('physics-rapier (concrete)'));
  const ui = d.forbiddenEdges['editor-ui'];
  check('deps[editorUiRule]', ['packages/editor/src/ui/**', 'packages/editor/src/session/**', 'packages/editor/src/viewport/**'].every((p) => ui.includes(p)) && ui.some((u) => u.includes('may not import @thirdlight/game-host')) && ui.some((u) => u.includes('packages/editor/src/preview/**')));
  check('deps[bundleGraphs]', d.bundleGraphs.preview.includes('game-host') && d.bundleGraphs.export.includes('game-host') && d.bundleGraphs.editor.includes('must not appear'));
  check('deps[checks]', d.checks.some((c) => c.includes('packages/editor/src/ui/**')) && d.checks.some((c) => c.includes('no duplicate gameplay bootstrap')));
  check('deps[remeasureOwners]', eq(d.fetchRemeasureOwners, ['58', '60']));
  check('deps[forbidRuntimeImport]', d.forbiddenEdges['platformer-game'].includes('three') && d.forbiddenEdges['platformer-game'].includes('DOM'));
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
const groups = new Set([...passes, ...failures].map((e) => e.check.split('[')[0]));
const report = {
  packet: 42,
  fixtureRoot: ROOT,
  files: listed.length,
  groups: [...groups].sort(),
  groupCount: groups.size,
  passes: passes.length,
  failures: failures.length,
  failedChecks: failures,
};
if (REPORT) writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
for (const f of failures) console.error(`FAIL [${f.check}] ${f.detail}`);
console.log(`groups: ${groups.size}, checks passed: ${passes.length}, failed: ${failures.length}`);
console.log(failures.length === 0 ? 'all checks passed' : `${failures.length} check(s) failed`);

if (process.argv.includes('--corrupt-control')) {
  // The deliberate-corruption negative control: each corrupted copy must exit
  // non-zero. A control that passes means the checker has no teeth.
  const { spawnSync } = await import('node:child_process');
  const run = (root) => spawnSync(process.execPath, [join(HERE, 'check-fixtures.mjs')], { env: { ...process.env, TL42_FIXTURE_ROOT: root }, encoding: 'utf8' }).status;
  const results = [];
  // (a) digest corruption
  {
    const dir = mkdtempSync(join(tmpdir(), 'tl42-corrupt-digest-'));
    cpSync(ROOT, dir, { recursive: true });
    const p = join(dir, 'manifest', 'manifest-v2-example.json');
    const text = readFileSync(p, 'utf8').replace(/"buildId": "[0-9a-f]{64}"/, `"buildId": "${'0'.repeat(64)}"`);
    writeFileSync(p, text);
    const status = run(dir);
    results.push({ control: 'digest-corruption', status, ok: status !== 0 });
    rmSync(dir, { recursive: true, force: true });
  }
  // (b) semantic corruption (a relay expectation changed to a wrong code)
  {
    const dir = mkdtempSync(join(tmpdir(), 'tl42-corrupt-semantic-'));
    cpSync(ROOT, dir, { recursive: true });
    const p = join(dir, 'wire', 'relay-cases.json');
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    doc.cases.find((c) => c.id === 'R7').expect.code = 'ok';
    writeFileSync(p, canon(doc));
    const status = run(dir);
    results.push({ control: 'semantic-corruption', status, ok: status !== 0 });
    rmSync(dir, { recursive: true, force: true });
  }
  for (const r of results) console.log(`control [${r.control}] exit=${r.status} ${r.ok ? 'PASS (non-zero)' : 'FAIL (checker accepted corruption)'}`);
  const controlOk = results.every((r) => r.ok);
  console.log(controlOk ? 'negative control passed (both corruptions rejected)' : 'negative control FAILED');
  process.exit(failures.length === 0 && controlOk ? 0 : 1);
}
process.exit(failures.length === 0 ? 0 : 1);
