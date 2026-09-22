#!/usr/bin/env node
/**
 * fixtures/m4/delivery/tools/check-fixtures.mjs
 *
 * Independent checker for the packet-64 M4 delivery fixtures
 * (`docs/planning/m4-contracts/delivery.md` §2.10). No dependency, no eval,
 * no network, no `three`: it re-derives every fixture fact from the raw
 * bytes and the case files and fails (exit non-zero) on any mismatch.
 *
 * It verifies:
 *   1. GLB container facts (magic/version/chunk table/JSON parse, clip list,
 *      skin/root-motion/joint negatives, channel targets) against
 *      `cases/model-attach-cases.json`;
 *   2. the corrupt GLB's declared-total ≠ file-length (a real container
 *      failure, not a placeholder);
 *   3. the undeclared GLB is a VALID container that the case manifest does
 *      NOT declare (the negative is about declaration, not validity);
 *   4. `index.json` digests/lengths for every data file (re-hashed here);
 *   5. the `load-order` manifest fragment is self-consistent under the
 *      accepted digest rules (sessions.md §17.1.1): sceneDigest,
 *      contentDigest, gameDigest, settingsDigest, mediaDigest and buildId
 *      all re-derive; the ready tuple matches the manifest identity;
 *   6. the crossfade weights and the role selection at the case pins
 *      (the accepted constants/rules, re-implemented here independently);
 *   7. the `querySettings` resolved maps (defaults ⊕ explicit, registry
 *      order) and the committed-fixture `queryProject` content summary
 *      (re-derived from `fixtures/m3/storage/project-v3-demo-0003`);
 *   8. every error code referenced by the case files is in the accepted
 *      closed sets.
 *
 * Usage (repository root):
 *   node fixtures/m4/delivery/tools/check-fixtures.mjs
 *   node fixtures/m4/delivery/tools/check-fixtures.mjs --root <dir>
 *   (an optional `--corrupt <file>` flips one byte of a fixture copy in
 *    memory-free temp form is NOT needed for the negative control: the
 *    negative control copies the fixture tree to a temp dir, flips one
 *    byte, and runs this checker with --root — it must exit non-zero.)
 *
 * Node: pinned Node 22. No dependency.
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '..');

const args = process.argv.slice(2);
let ROOT = DEFAULT_ROOT;
if (args.includes('--root')) ROOT = resolve(args[args.indexOf('--root') + 1]);
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const blockDigest = (value) => {
  if (value === null) return sha256(Buffer.from('null', 'utf8'));
  return sha256(Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
};

const failures = [];
const fail = (msg) => failures.push(msg);
const readJson = (rel) => {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) { fail(`missing file: ${rel}`); return null; }
  try {
    return JSON.parse(readFileSync(abs, 'utf8'));
  } catch (e) {
    fail(`unparseable JSON: ${rel} (${e.message})`);
    return null;
  }
};
const readBuf = (rel) => {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) { fail(`missing file: ${rel}`); return null; }
  return readFileSync(abs);
};

// ---------------------------------------------------------------------------
// 1. GLB container parse (independent of the generator)
// ---------------------------------------------------------------------------

/** Returns { ok, reason, json, declaredTotal, fileSize } or a structural failure. */
function parseGlb(buf) {
  const out = { ok: false, reason: null, json: null, declaredTotal: null, fileSize: buf.length };
  if (buf.length < 12) { out.reason = 'too short'; return out; }
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x46546c67) { out.reason = 'bad magic (not glTF GLB)'; return out; }
  const version = buf.readUInt32LE(4);
  if (version !== 2) { out.reason = `unsupported version ${version}`; return out; }
  const declaredTotal = buf.readUInt32LE(8);
  out.declaredTotal = declaredTotal;
  if (declaredTotal > buf.length) { out.reason = `declared total (${declaredTotal}) exceeds file length (${buf.length})`; return out; }
  if (declaredTotal < 12) { out.reason = 'declared total below the header'; return out; }
  // Walk the chunk table.
  let offset = 12;
  let json = null;
  let bins = 0;
  while (offset + 8 <= buf.length) {
    const chunkLen = buf.readUInt32LE(offset);
    const chunkType = buf.readUInt32LE(offset + 4);
    if (offset + 8 + chunkLen > buf.length) { out.reason = `chunk at ${offset} runs past the file end`; return out; }
    if (chunkType === 0x4e4f534a) {
      if (json !== null) { out.reason = 'duplicate JSON chunk'; return out; }
      try { json = JSON.parse(buf.subarray(offset + 8, offset + 8 + chunkLen).toString('utf8')); }
      catch (e) { out.reason = `JSON chunk does not parse (${e.message})`; return out; }
    } else if (chunkType === 0x004e4942) {
      bins += 1;
      if (bins > 1) { out.reason = 'multiple BIN chunks'; return out; }
    }
    offset += 8 + chunkLen;
  }
  if (offset !== Math.min(declaredTotal, buf.length) && offset > buf.length) { out.reason = 'chunk table overruns the file'; return out; }
  if (json === null) { out.reason = 'no JSON chunk'; return out; }
  out.json = json;
  out.ok = true;
  return out;
}

function glbFacts(parsed) {
  const j = parsed.json;
  const animations = j.animations ?? [];
  const skins = j.skins ?? [];
  const clipNames = animations.map((a) => a.name);
  let rootTranslationChannels = 0;
  let jointsAttributes = 0;
  let nonRootRotationChannels = 0;
  const perClip = animations.map(() => 0);
  for (const mesh of j.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const attrs = prim.attributes ?? {};
      if (attrs.JOINTS_0 !== undefined || attrs.WEIGHTS_0 !== undefined) jointsAttributes += 1;
    }
  }
  animations.forEach((a, c) => {
    for (const ch of a.channels ?? []) {
      const target = ch.target ?? {};
      if (target.path === 'translation' && target.node === 0) rootTranslationChannels += 1;
      if (target.path === 'rotation' && target.node !== 0) {
        nonRootRotationChannels += 1;
        perClip[c] += 1;
      }
    }
  });
  return {
    clips: clipNames,
    meshes: (j.meshes ?? []).length,
    nodes: (j.nodes ?? []).length,
    skins: skins.length,
    rootTranslationChannels,
    jointsAttributes,
    channelsPerClip: perClip,
    allChannelsNonRootRotation: nonRootRotationChannels === (animations.reduce((s, a) => s + (a.channels ?? []).length, 0) - rootTranslationChannels) || animations.length === 0,
  };
}

const modelCases = readJson('cases/model-attach-cases.json');
const loadCases = readJson('cases/load-order-cases.json');
const queryCases = readJson('cases/query-cases.json');
const scanCases = readJson('cases/scan-graph-cases.json');
const indexJson = readJson('index.json');
if (!modelCases || !loadCases || !queryCases || !scanCases || !indexJson) {
  console.error(failures.join('\n'));
  process.exit(1);
}

// 1a. the GLB facts vs the case expectations.
for (const [rel, expectation] of Object.entries(modelCases.glb)) {
  const buf = readBuf(rel);
  if (buf === null) continue;
  const parsed = parseGlb(buf);
  if (!parsed.ok) {
    // The corrupt file is EXPECTED to fail structurally — every other file must parse.
    if (rel === 'glb/corrupt-m4.glb') {
      if (!/declared total|past the file|bad magic/.test(parsed.reason ?? '')) {
        fail(`${rel}: expected a container failure (declared total mismatch / cut chunk), got: ${parsed.reason}`);
      } else {
        // And the header must have PARSED far enough to see the length mismatch
        // (a truncated header would be a different, weaker negative).
        if (parsed.declaredTotal === null) fail(`${rel}: the header itself is truncated — the negative must be a declared-total mismatch`);
      }
    } else {
      fail(`${rel}: should parse as a GLB container, got: ${parsed.reason}`);
    }
    continue;
  }
  const facts = glbFacts(parsed);
  if (expectation.clips && JSON.stringify(facts.clips) !== JSON.stringify(expectation.clips)) {
    fail(`${rel}: clips ${JSON.stringify(facts.clips)} ≠ expected ${JSON.stringify(expectation.clips)}`);
  }
  if (expectation.meshes !== undefined && facts.meshes !== expectation.meshes) fail(`${rel}: meshes ${facts.meshes} ≠ ${expectation.meshes}`);
  if (expectation.skins !== undefined && facts.skins !== expectation.skins) fail(`${rel}: skins ${facts.skins} ≠ ${expectation.skins}`);
  if (expectation.rootTranslationChannels !== undefined && facts.rootTranslationChannels !== expectation.rootTranslationChannels) {
    fail(`${rel}: root translation channels ${facts.rootTranslationChannels} ≠ ${expectation.rootTranslationChannels}`);
  }
  if (expectation.jointsAttributes !== undefined && facts.jointsAttributes !== expectation.jointsAttributes) {
    fail(`${rel}: JOINTS_0/WEIGHTS_0 attributes ${facts.jointsAttributes} ≠ ${expectation.jointsAttributes}`);
  }
  if (expectation.channelsPerClip && JSON.stringify(facts.channelsPerClip) !== JSON.stringify(expectation.channelsPerClip)) {
    fail(`${rel}: channels per clip ${JSON.stringify(facts.channelsPerClip)} ≠ ${JSON.stringify(expectation.channelsPerClip)}`);
  }
  // The positive must have every channel a non-root rotation (the A6-clean shape).
  if (expectation.channelTargets && !facts.allChannelsNonRootRotation) fail(`${rel}: expected all channels to target non-root rotation`);
}

// 3. the undeclared GLB: valid, and absent from the manifest assets.
{
  const undeclaredBuf = readBuf('glb/undeclared-m4.glb');
  if (undeclaredBuf !== null) {
    const parsed = parseGlb(undeclaredBuf);
    if (!parsed.ok) fail('glb/undeclared-m4.glb must be a VALID container (the negative is about declaration)');
    const assetIds = (loadCases.manifestFragment?.assets ?? []).map((a) => a.assetId);
    // The undeclared GLB's identity must not appear as a declared sourceDigest either.
    const digests = (loadCases.manifestFragment?.assets ?? []).map((a) => a.sourceDigest);
    if (digests.includes(sha256(undeclaredBuf))) fail('glb/undeclared-m4.glb is unexpectedly declared by the case manifest');
    if (!assetIds.length) fail('the case manifest declares no assets — the undeclared negative needs a declared set to contrast against');
  }
}

// ---------------------------------------------------------------------------
// 4. index.json: re-hash every listed data file
// ---------------------------------------------------------------------------
{
  for (const [rel, meta] of Object.entries(indexJson)) {
    if (rel === 'index.json') continue;
    const buf = readBuf(rel);
    if (buf === null) continue;
    if (meta.byteLength !== buf.length) fail(`${rel}: index byteLength ${meta.byteLength} ≠ actual ${buf.length}`);
    if (meta.sha256 !== sha256(buf)) fail(`${rel}: index sha256 ${meta.sha256} ≠ actual ${sha256(buf)}`);
  }
  // Every data file that exists must be listed (no orphan bytes).
  for (const dir of ['glb', 'cases']) {
    // (readJson/readBuf already cover the expected set; orphan detection is
    // the generator's --check job — the index is the authoritative list.)
    void dir;
  }
}

// ---------------------------------------------------------------------------
// 5. the manifest fragment self-consistency (accepted digest rules)
// ---------------------------------------------------------------------------
{
  const m = loadCases.manifestFragment;
  const snap = loadCases.snapshotDocument;
  const expect = (label, actual, expected) => {
    if (actual !== expected) fail(`manifest fragment: ${label} mismatch\n  recorded:  ${actual}\n  re-derived: ${expected}`);
  };
  expect('sceneDigest', m.sceneDigest, blockDigest(snap.scene));
  expect('gameDigest', m.gameDigest, blockDigest(m.game));
  expect('settingsDigest', m.settingsDigest, blockDigest(m.settings));
  expect('mediaDigest', m.mediaDigest, blockDigest(m.media));
  // contentDigest over the case content view (assets/prefabs/behaviors/settings/game).
  const contentView = {
    assets: m.assets,
    prefabs: [],
    behaviors: m.behaviors,
    settings: queryCases.querySettings.find((q) => q.id === 'Q2-one-non-default').result.explicit,
    game: m.game,
  };
  expect('contentDigest', m.contentDigest, blockDigest(contentView));
  // buildId: the document serialization WITHOUT the buildId key, fixed key order.
  const { buildId: _omit, ...withoutBuildId } = m;
  const reBuildId = sha256(Buffer.from(`${JSON.stringify(withoutBuildId, null, 2)}\n`, 'utf8'));
  expect('buildId', m.buildId, reBuildId);
  // Identity tuple.
  if (m.snapshotId !== `${m.projectId}@r${m.revision}`) fail('manifest fragment: snapshotId ≠ <projectId>@r<revision>');
  if (snap.snapshotId !== m.snapshotId) fail('snapshot document: snapshotId ≠ the manifest snapshotId');
  if (snap.revision !== m.revision) fail('snapshot document: revision ≠ the manifest revision');
  if (JSON.stringify(snap.game) !== JSON.stringify(m.game)) fail('snapshot document: game ≠ the manifest game (the digest gate would pass but the values differ)');
  // The v3 snapshot document carries the game field (the D-63-9 transport shape).
  if (snap.game === undefined) fail('snapshot document: the v3 document must carry the game field (runtime.md §2)');
  if (snap.scene.schemaVersion !== 3) fail('snapshot document: the case scene must be schemaVersion 3');
  // The asset row's digest/length match the generated runner GLB.
  const runnerBuf = readBuf('glb/runner-m4.glb');
  const assetRow = m.assets.find((a) => a.assetId === 'asset-runner');
  if (assetRow && runnerBuf !== null) {
    if (assetRow.sourceDigest !== sha256(runnerBuf)) fail('manifest fragment: asset-runner sourceDigest ≠ the generated runner GLB digest');
    if (assetRow.sourceByteLength !== runnerBuf.length) fail('manifest fragment: asset-runner sourceByteLength ≠ the generated runner GLB length');
    if (assetRow.path !== `content/sha256/${assetRow.sourceDigest}`) fail('manifest fragment: asset path ≠ content/sha256/<sourceDigest>');
  }
  // The ready tuple matches the manifest identity.
  const readyStep = loadCases.previewSequence.find((s) => s.event === 'tl.ready');
  const t = readyStep?.readyTuple;
  if (!t) fail('preview sequence: the tl.ready step must carry the ready tuple');
  else {
    if (t.buildId !== m.buildId) fail('ready tuple: buildId ≠ the manifest buildId');
    if (t.contentDigest !== m.contentDigest) fail('ready tuple: contentDigest ≠ the manifest contentDigest');
    if (t.snapshotId !== m.snapshotId) fail('ready tuple: snapshotId ≠ the manifest snapshotId');
    if (t.revision !== m.revision) fail('ready tuple: revision ≠ the manifest revision');
    if (!/^[0-9a-f]{64}$/.test(t.contentDigest)) fail('ready tuple: contentDigest must be 64 lowercase hex (the §13.5 validator — the D-63-6 value)');
    if (t.stepIndex !== loadCases.constants.SETTLE_STEPS) fail('ready tuple: stepIndex must be the settle pre-roll (12) at title ready');
    if (t.stepIndex < 0) fail('ready tuple: stepIndex must be non-negative');
  }
  // The media animation identity matches the scene component (the committed mapping).
  const playerModelEntity = snap.scene.entities.find((e) => e.components?.modelAnimation);
  const mediaAnim = m.media.animation.find((a) => a.entityId === playerModelEntity?.id);
  if (!mediaAnim) fail('manifest fragment: media.animation must cover the modelAnimation entity');
  else {
    if (JSON.stringify(mediaAnim.roles) !== JSON.stringify(playerModelEntity.components.modelAnimation.roles)) {
      fail('manifest fragment: media.animation roles ≠ the scene modelAnimation roles');
    }
    if (mediaAnim.assetId !== playerModelEntity.components.modelAnimation.assetId) fail('manifest fragment: media.animation assetId ≠ the scene component assetId');
    expect('media.animation profileDigest', mediaAnim.profileDigest, blockDigest(mediaAnim.roles));
  }
  // The failure injection rows reference the closed codes only (checked in 8).
  for (const inj of loadCases.failureInjection) {
    if (!inj.outcome || typeof inj.outcome.code !== 'string') continue;
    // (closed-set membership is asserted in section 8)
    if (typeof inj.fetches !== 'number' || inj.fetches < 1) fail(`failure injection ${inj.id}: fetches must be a count ≥ 1`);
  }
}

// ---------------------------------------------------------------------------
// 6. crossfade weights + role selection (independent re-implementation)
// ---------------------------------------------------------------------------
{
  const EPS = modelCases.constants.RUN_SPEED_EPS;
  const FADE = modelCases.constants.ANIMATION_CROSSFADE_SECONDS;
  if (EPS !== 0.05) fail('constants: RUN_SPEED_EPS must be 0.05 (accepted)');
  if (FADE !== 0.2) fail('constants: ANIMATION_CROSSFADE_SECONDS must be 0.2 (accepted)');
  const selectRole = (motion) => (!motion.grounded ? 'airborne' : motion.speed > EPS ? 'run' : 'idle');
  for (const c of modelCases.realization.find((r) => r.id === 'R3-role-selection-boundaries').cases) {
    const got = selectRole(c.view);
    if (got !== c.expected) fail(`R3: view ${JSON.stringify(c.view)} → ${got}, expected ${c.expected}`);
  }
  const r4 = modelCases.realization.find((r) => r.id === 'R4-non-player-neutral-pinning').cases;
  for (const c of r4) {
    // Non-player: the pinned neutral motion (NOT the player view).
    const got = selectRole({ speed: 0, grounded: true });
    if (got !== c.expected) fail(`R4: non-player view ${JSON.stringify(c.view)} → ${got}, expected ${c.expected}`);
  }
  const r5 = modelCases.realization.find((r) => r.id === 'R5-crossfade-weights');
  for (const c of r5.cases) {
    const t = c.t;
    const outgoing = Math.max(0, 1 - t / FADE);
    const incoming = Math.min(1, t / FADE);
    const blending = t < FADE;
    const close = (a, b) => Math.abs(a - b) <= (r5.tolerance ?? 1e-9);
    if (!close(outgoing, c.outgoing)) fail(`R5: t=${t} outgoing ${outgoing} ≠ ${c.outgoing}`);
    if (!close(incoming, c.incoming)) fail(`R5: t=${t} incoming ${incoming} ≠ ${c.incoming}`);
    if (blending !== c.blending) fail(`R5: t=${t} blending ${blending} ≠ ${c.blending}`);
  }
}

// ---------------------------------------------------------------------------
// 7. querySettings resolved maps + the committed-fixture summary
// ---------------------------------------------------------------------------
{
  const registry = queryCases.registry;
  const keyOrder = registry.map((r) => r.key);
  const resolvedOf = (explicit) => {
    const out = {};
    for (const row of registry) {
      out[row.key] = Object.prototype.hasOwnProperty.call(explicit, row.key) ? explicit[row.key] : row.default;
    }
    return out;
  };
  for (const q of queryCases.querySettings) {
    let expectedResolved;
    if (q.id === 'Q4-v1-envelope') expectedResolved = {};
    else if (q.id === 'Q1-empty-explicit-v3') expectedResolved = resolvedOf({});
    else if (q.id === 'Q2-one-non-default') expectedResolved = resolvedOf(q.result.explicit);
    else if (q.id === 'Q3-all-six') expectedResolved = resolvedOf(q.explicit);
    if (expectedResolved === undefined) { fail(`query case ${q.id}: the checker has no expected map for it`); continue; }
    if (JSON.stringify(q.result.resolved) !== JSON.stringify(expectedResolved)) {
      fail(`query case ${q.id}: resolved mismatch\n  recorded:  ${JSON.stringify(q.result.resolved)}\n  re-derived: ${JSON.stringify(expectedResolved)}`);
    }
    // Registry key order in the recorded map (insertion order of the JSON).
    const recordedKeys = Object.keys(q.result.resolved);
    if (recordedKeys.length && JSON.stringify(recordedKeys) !== JSON.stringify(keyOrder.slice(0, recordedKeys.length))) {
      fail(`query case ${q.id}: resolved keys not in registry order: ${JSON.stringify(recordedKeys)}`);
    }
    if (q.id !== 'Q4-v1-envelope' && q.result.explicit && JSON.stringify(Object.keys(q.result.explicit)) !== JSON.stringify(Object.keys(q.result.explicit).sort((a, b) => (a < b ? -1 : 1)))) {
      // explicit keys in ascending order (the accepted summary order is registry order;
      // the authored map order in the case is registry order — verify that instead):
      const expectedExplicitOrder = keyOrder.filter((k) => q.result.explicit[k] !== undefined);
      if (JSON.stringify(Object.keys(q.result.explicit)) !== JSON.stringify(expectedExplicitOrder)) {
        fail(`query case ${q.id}: explicit keys not in registry order`);
      }
    }
  }
  // Range sanity: every registry default sits inside its own range.
  for (const row of registry) {
    const d = row.default;
    const loOk = row.loInclusive ? d >= row.lo : d > row.lo;
    const hiOk = row.hiInclusive ? d <= row.hi : d < row.hi;
    if (!loOk || !hiOk) fail(`registry: ${row.key} default ${d} outside [${row.lo}, ${row.hi}]`);
  }
  // The committed-fixture summary: re-derive from the fixture envelope.
  const cf = queryCases.queryProjectSummary.committedFixture;
  const envPath = join(REPO_ROOT, cf.path, cf.envelopeFile);
  if (!existsSync(envPath)) {
    fail(`committed fixture envelope missing: ${envPath}`);
  } else {
    const env = JSON.parse(readFileSync(envPath, 'utf8'));
    const scene = env.scene;
    const content = env.content;
    const assets = content.assets ?? [];
    const reDerived = {
      assets: assets.length,
      prefabs: (content.prefabs ?? []).length,
      behaviors: (content.behaviors ?? []).length,
      settingsKeys: Object.keys(content.settings ?? {}).length,
      game: content.game !== null && content.game !== undefined,
      zones: scene.entities.filter((e) => e.components?.gameZone !== undefined).length,
      spawns: scene.entities.filter((e) => e.components?.playerSpawn !== undefined).length,
      audioAssets: assets.filter((a) => a.kind === 'audio').length,
    };
    if (JSON.stringify(reDerived) !== JSON.stringify(cf.expected)) {
      fail(`queryProject summary for ${cf.path} mismatch\n  recorded:  ${JSON.stringify(cf.expected)}\n  re-derived: ${JSON.stringify(reDerived)}`);
    }
    // Key order: the accepted summary order (v2 four keys, then the v3 adds).
    const expectedOrder = ['assets', 'prefabs', 'behaviors', 'settingsKeys', 'game', 'zones', 'spawns', 'audioAssets'];
    if (JSON.stringify(Object.keys(cf.expected)) !== JSON.stringify(expectedOrder)) {
      fail(`queryProject summary keys not in the accepted order: ${JSON.stringify(Object.keys(cf.expected))}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 8. closed-code membership (every referenced code is accepted)
// ---------------------------------------------------------------------------
{
  // The adapter closed set (packet-26 + 52 + the M4 C64-4 additions) and the
  // sessions/manifest closed codes the cases may name.
  const CLOSED = new Set([
    // three-adapter ERROR_CODES
    'canvas_invalid', 'render_unsupported', 'render_failed', 'screenshot_failed',
    'adapter_disposed', 'render_context_lost', 'asset_source_invalid', 'asset_missing',
    'asset_corrupt', 'asset_extension_unsupported', 'asset_image_invalid',
    'asset_clip_invalid', 'asset_load_cancelled', 'asset_load_stale', 'asset_disposed',
    'preview_invalid', 'animation_role_unresolved',
    'models_config_invalid', 'models_asset_unresolved',
    // sessions/manifest/play codes
    'play_content_not_ready', 'play_build_unavailable', 'play_locator_invalid',
    'play_locator_expired', 'path_rejected', 'blob_missing', 'blob_corrupt',
    'manifest_invalid', 'game_config_invalid',
    // commands query codes
    'project_not_found', 'project_unavailable', 'invalid_request', 'field_value',
    // presentation/animation profile codes
    'animation_role_out_of_range', 'animation_role_duplicate', 'animation_role_mismatch',
    'animation_role_ambiguous', 'animation_skin_unsupported', 'animation_root_motion',
    'limits_exceeded',
  ]);
  const referenced = new Set();
  const collect = (value) => {
    if (Array.isArray(value)) { for (const v of value) collect(v); return; }
    if (value && typeof value === 'object') {
      if (typeof value.code === 'string') referenced.add(value.code);
      for (const v of Object.values(value)) collect(v);
    }
  };
  for (const doc of [modelCases, loadCases, queryCases, scanCases]) collect(doc);
  for (const code of referenced) {
    if (!CLOSED.has(code)) fail(`case files reference a code outside the accepted closed sets: "${code}"`);
  }
}

// ---------------------------------------------------------------------------
// result
// ---------------------------------------------------------------------------
if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} fixture check(s) failed under ${ROOT}`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`OK: packet-64 delivery fixtures verified under ${ROOT} (GLB facts, index digests, manifest identity, selector/crossfade math, query maps, closed codes)`);