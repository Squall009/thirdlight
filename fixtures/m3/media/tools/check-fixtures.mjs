/**
 * fixtures/m3/media/tools/check-fixtures.mjs
 *
 * Fixture consistency checker for packet 41's PROPOSED presentation contract
 * (`docs/planning/m3-contracts/presentation.md`).
 *
 * This is fixture tooling, NOT an implementation of the contract. It contains
 * no renderer, no audio device, no loader and no runtime. It re-derives, from
 * the committed bytes and the committed rules:
 *
 *  1. `index.json` coverage, byte lengths and SHA-256 of every fixture file;
 *  2. canonical JSON bytes (2-space indent, LF, one trailing newline, no BOM,
 *     no trailing whitespace) with a strict parser (duplicate keys rejected);
 *  3. the WAV inspection stages and the exact header arithmetic
 *     (presentation.md §41.4) for every committed `.wav`;
 *  4. the GLB role-profile validation order and the animated-model profile
 *     (presentation.md §41.3.2/§41.3.3) for every committed `.glb` + binding;
 *  5. the light validation rules, the three preset rows and the preset
 *     independence rule (§§41.1/41.2);
 *  6. the shadow degradation outcomes (§41.1.4);
 *  7. the checkpoint activation timeline (§41.5);
 *  8. the ownership/disposal invariants (§41.6);
 *  9. the injected audio-owner rules (§41.4.7);
 * 10. the closed error/diagnostic code sets (§41.7.2).
 *
 * Usage (repository root):
 *   node fixtures/m3/media/tools/check-fixtures.mjs
 *   TL41_FIXTURE_ROOT=<copy> node fixtures/m3/media/tools/check-fixtures.mjs
 *   node fixtures/m3/media/tools/check-fixtures.mjs --report out.json
 *
 * Exit 0 = all checks passed; 1 = at least one failed. The negative control in
 * verification.md copies the tree, corrupts one byte and runs this checker
 * against the copy; it must exit non-zero.
 *
 * Node: pinned Node 22 (`package.json` engines). No dependency, no eval.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const ROOT = process.env.TL41_FIXTURE_ROOT
  ? resolve(process.env.TL41_FIXTURE_ROOT)
  : resolve(HERE, '..');
const reportArg = process.argv.indexOf('--report');
const REPORT = reportArg >= 0 ? process.argv[reportArg + 1] : null;

// ---------------------------------------------------------------------------
// --corrupt-control: every deliberate corruption must be detected
// ---------------------------------------------------------------------------
// Runs the checker (this file) as a real child process against a corrupt copy
// of `fixtures/m3` (media + the sibling contracts tree) and requires a non-zero
// exit for each corruption. The committed tree is never modified.
if (process.argv.includes('--corrupt-control')) {
  const clean = spawnSync(process.execPath, [SELF], {
    env: { ...process.env, TL41_FIXTURE_ROOT: resolve(HERE, '..') },
    encoding: 'utf8',
  });
  const baseRoot = resolve(HERE, '..', '..');
  const corruptions = [
    ['wav-value-channels', (media) => {
      const p = join(media, 'wav', 'cue-start.wav');
      const b = readFileSync(p);
      b[22] = 2;
      writeFileSync(p, b);
    }],
    ['wav-new-rf64-case', (media) => {
      const p = join(media, 'wav', 'rejections', 'rf64.wav');
      const b = readFileSync(p);
      b.write('RIFF', 0, 'latin1');
      writeFileSync(p, b);
    }],
    ['audio-record-recipe-digest', (media) => {
      const p = join(media, 'wav', 'wav-cases.json');
      const d = JSON.parse(readFileSync(p, 'utf8'));
      d.audioRecord.recipeDigest = '0'.repeat(64);
      writeFileSync(p, `${JSON.stringify(d, null, 2)}\n`);
    }],
    ['audio-record-metrics', (media) => {
      const p = join(media, 'wav', 'wav-cases.json');
      const d = JSON.parse(readFileSync(p, 'utf8'));
      d.audioRecord.metrics.frames = 48;
      writeFileSync(p, `${JSON.stringify(d, null, 2)}\n`);
    }],
    ['glb-new-joints-case', (media) => {
      const p = join(media, 'glb', 'bad-joints.glb');
      const b = readFileSync(p);
      const at = b.indexOf(Buffer.from('JOINTS_0'));
      if (at >= 0) b[at + 6] = 'X'.charCodeAt(0);
      writeFileSync(p, b);
    }],
    ['glb-role-expectation', (media) => {
      const p = join(media, 'glb', 'profile-cases.json');
      const d = JSON.parse(readFileSync(p, 'utf8'));
      for (const c of d.cases) {
        if (c.id === 'roles-ok-tracks-at-cap') c.expect = { verdict: 'rejected', code: 'asset_limits_exceeded', limit: 'animation_clips' };
      }
      writeFileSync(p, `${JSON.stringify(d, null, 2)}\n`);
    }],
    ['roles-case-expectation', (media) => {
      const p = join(media, 'roles', 'roles-cases.json');
      const d = JSON.parse(readFileSync(p, 'utf8'));
      for (const c of d.cases) {
        if (c.id === 'roles-stored-order-v1') c.expect = { verdict: 'rejected', code: 'animation_role_mismatch' };
      }
      writeFileSync(p, `${JSON.stringify(d, null, 2)}\n`);
    }],
    ['contracts-audio-record', (_media, contracts) => {
      const p = join(contracts, 'catalog', 'audio-asset-record-v3.json');
      const d = JSON.parse(readFileSync(p, 'utf8'));
      d.content.assets[0].versions[0].metrics.frames = 48;
      writeFileSync(p, `${JSON.stringify(d, null, 2)}\n`);
    }],
    ['index-digest', (media) => {
      const p = join(media, 'index.json');
      const d = JSON.parse(readFileSync(p, 'utf8'));
      d.files['wav/cue-min.wav'].sha256 = '0'.repeat(64);
      writeFileSync(p, `${JSON.stringify(d, null, 2)}\n`);
    }],
    ['code-set', (media) => {
      const p = join(media, 'errors', 'codes.json');
      const d = JSON.parse(readFileSync(p, 'utf8'));
      d.sets.limitNames = d.sets.limitNames.filter((c) => c !== 'audio_pcm_bytes');
      writeFileSync(p, `${JSON.stringify(d, null, 2)}\n`);
    }],
  ];
  let detected = 0;
  for (const [name, mutate] of corruptions) {
    const tmp = mkdtempSync(join(tmpdir(), '.tl41-corrupt-'));
    const copy = join(tmp, 'm3');
    cpSync(baseRoot, copy, { recursive: true });
    mutate(join(copy, 'media'), join(copy, 'contracts'));
    const r = spawnSync(process.execPath, [SELF], {
      env: { ...process.env, TL41_FIXTURE_ROOT: join(copy, 'media') },
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      detected += 1;
      console.log(`  ok   corruption '${name}' detected (exit ${r.status})`);
    } else {
      console.log(`  FAIL corruption '${name}' was NOT detected`);
    }
    rmSync(tmp, { recursive: true, force: true });
  }
  const cleanOk = clean.status === 0;
  console.log(`corruption control: ${detected}/${corruptions.length} detected (clean tree exit ${clean.status})`);
  if (!cleanOk || detected !== corruptions.length) {
    console.log('corruption control FAILED');
    process.exit(1);
  }
  console.log('all corruptions detected');
  process.exit(0);
}

const failures = [];
const passes = [];
const fail = (check, detail) => failures.push({ check, detail });
const pass = (check, detail) => passes.push({ check, detail: detail === undefined ? null : detail });
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const jp = (v) => JSON.stringify(v);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

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
// contract constants (presentation.md)
// ---------------------------------------------------------------------------
const CAPS = {
  clips: 8,
  tracks: 64,
  tracksPerClip: 32,
  trackTimes: 4096,
  clipMs: 10000,
  profileBytes: 4096,
};
const SHADOW = { mapSize: 512, type: 'PCFShadowMap', near: 0.5, distance: 20, margin: 2, halfExtentMax: 64, farMax: 200 };
const ANIMATION_CROSSFADE_SECONDS = 0.2;
const RUN_SPEED_EPS = 0.05;
const WAV = {
  headerBytes: 44, sampleRate: 48000, channels: 1, bitsPerSample: 16,
  byteRate: 96000, blockAlign: 2, maxPcmBytes: 192000, maxFrames: 96000,
  maxDurationMs: 2000, maxSourceBytes: 196608, maxReferencedCues: 6,
};
const AUDIO_MAX_VOICES = 8;
const PRESETS = {
  'matte-ground': { color: '#6f6f6f', roughness: 0.95, metalness: 0, emissive: '#000000', emissiveIntensity: 0 },
  hazard: { color: '#d42a1e', roughness: 0.55, metalness: 0, emissive: '#3a0703', emissiveIntensity: 0.35 },
  beacon: { color: '#2f7fd4', roughness: 0.4, metalness: 0.1, emissive: '#1bc8ff', emissiveIntensity: 1.2 },
};
const PRESET_FIELDS = ['color', 'roughness', 'metalness', 'emissive', 'emissiveIntensity'];
const ROLE_KEYS = ['idle', 'run', 'airborne'];
const CODE_SETS = {
  modelCommand: ['animation_role_out_of_range', 'animation_role_duplicate', 'animation_role_mismatch', 'animation_role_ambiguous', 'animation_skin_unsupported', 'animation_root_motion'],
  limitNames: ['animation_clips', 'animation_tracks', 'animation_track_times', 'animation_clip_duration', 'audio_pcm_bytes', 'audio_cues'],
  audioDiagnostics: ['audio_source_bytes_exceeded', 'audio_container_invalid', 'audio_chunk_invalid', 'audio_format_unsupported', 'audio_channel_unsupported', 'audio_sample_rate_unsupported', 'audio_bit_depth_unsupported', 'audio_data_size_invalid', 'audio_empty'],
  adapter: ['animation_role_unresolved'],
  hostAudio: ['audio_decode_failed', 'audio_unsupported', 'audio_disposed', 'audio_invalid_bytes'],
  hardFailure: ['blob_missing', 'blob_corrupt', 'asset_kind_mismatch', 'export_failed'],
  softFallback: ['sound-off', 'shadow-off'],
};

// ---------------------------------------------------------------------------
// byte helpers
// ---------------------------------------------------------------------------
const read = (rel) => readFileSync(join(ROOT, rel));
const readJson = (rel) => {
  try {
    const text = read(rel).toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) throw new Error('BOM');
    const value = parseStrict(text);
    const canonical = `${JSON.stringify(value, null, 2)}\n`;
    if (text !== canonical) throw new Error('not canonical JSON bytes');
    if (/[ \t]+\n/.test(text)) throw new Error('trailing whitespace');
    return value;
  } catch (e) {
    fail(`json[${rel}]`, e instanceof Error ? e.message : String(e));
    return {};
  }
};
const u16le = (b, o) => b.readUInt16LE(o);
const u32le = (b, o) => b.readUInt32LE(o);

// ---------------------------------------------------------------------------
// 1 + 2. index coverage and canonical bytes
// ---------------------------------------------------------------------------
const walk = (dir, out = []) => {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(relative(ROOT, full).split('\\').join('/'));
  }
  return out;
};
const allFiles = walk(ROOT);
const dataFiles = allFiles.filter((f) => !f.startsWith('tools/') && f !== 'index.json' && f !== 'README.md' && f !== 'verification.md');
const index = readJson('index.json');
if (index.indexVersion !== 1) fail('index[indexVersion]', `${index.indexVersion} != 1`);
else pass('index[indexVersion]');
const listed = Object.keys(index.files ?? {}).sort();
if (!eq(listed, dataFiles.sort())) {
  fail('index[coverage]', `listed ${listed.length} vs on-disk ${dataFiles.length}`);
} else pass('index[coverage]', `${listed.length} files`);
for (const rel of listed) {
  const entry = (index.files ?? {})[rel];
  if (!existsSync(join(ROOT, rel))) { fail(`index[${rel}]`, 'missing'); continue; }
  const buf = read(rel);
  if (buf.length !== entry.bytes) fail(`index[${rel}].bytes`, `${buf.length} != ${entry.bytes}`);
  if (sha256(buf) !== entry.sha256) fail(`index[${rel}].sha256`, 'mismatch');
}
if (!failures.some((f) => f.check.startsWith('index['))) pass('index[digests]', `${listed.length} entries`);

// ---------------------------------------------------------------------------
// 3. WAV inspection (presentation.md §41.4)
// ---------------------------------------------------------------------------
function inspectWav(bytes) {
  if (bytes.length < WAV.headerBytes || bytes.length > WAV.maxSourceBytes) return { code: 'audio_source_bytes_exceeded', stage: 1 };
  if (bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE') return { code: 'audio_container_invalid', stage: 2 };
  if (u32le(bytes, 4) !== bytes.length - 8) return { code: 'audio_container_invalid', stage: 2 };
  if (bytes.toString('latin1', 12, 16) !== 'fmt ' || u32le(bytes, 16) !== 16) return { code: 'audio_chunk_invalid', stage: 3 };
  const dataPos = 36;
  if (bytes.toString('latin1', dataPos, dataPos + 4) !== 'data') return { code: 'audio_chunk_invalid', stage: 3 };
  const declared = u32le(bytes, dataPos + 4);
  if (dataPos + 8 + declared !== bytes.length) return { code: 'audio_chunk_invalid', stage: 3 };
  if (u16le(bytes, 20) !== 1) return { code: 'audio_format_unsupported', stage: 4 };
  if (u16le(bytes, 22) !== 1) return { code: 'audio_channel_unsupported', stage: 5 };
  if (u32le(bytes, 24) !== 48000) return { code: 'audio_sample_rate_unsupported', stage: 6 };
  if (u16le(bytes, 34) !== 16) return { code: 'audio_bit_depth_unsupported', stage: 7 };
  if (u32le(bytes, 28) !== 96000 || u16le(bytes, 32) !== 2) return { code: 'audio_chunk_invalid', stage: 8 };
  const dataBytes = bytes.length - 44;
  if (declared !== dataBytes || dataBytes % 2 !== 0) return { code: 'audio_data_size_invalid', stage: 9 };
  if (dataBytes < 2) return { code: 'audio_empty', stage: 10 };
  if (dataBytes > 192000) return { code: 'asset_limits_exceeded', limit: 'audio_pcm_bytes', stage: 11 };
  const frames = dataBytes / 2;
  return {
    status: 'ok',
    stage: 12,
    metrics: {
      container: 'riff-wave', encoding: 'pcm-s16le', channels: 1, sampleRate: 48000, bitsPerSample: 16,
      frames, durationMs: Math.floor(frames / 48), pcmBytes: dataBytes, dataChunkBytes: dataBytes,
      riffChunkBytes: 36 + dataBytes,
    },
  };
}

const wavCases = readJson('wav/wav-cases.json');
for (const c of Object.entries(wavCases.constants ?? {})) {
  if (wavCases.constants[c[0]] !== WAV[c[0]]) fail('constants[wav]', `${c[0]}: ${wavCases.constants[c[0]]} != ${WAV[c[0]]}`);
}
pass('constants[wav]', 'declared constants match presentation.md §41.4.2');
if (!eq(wavCases.recipe, { profile: 'pcm-wav', recipeVersion: 1, toolchain: { 'asset-pipeline': '0.1.0' } })) {
  fail('wav[recipe]', jp(wavCases.recipe));
} else pass('wav[recipe]');

for (const p of wavCases.positives ?? []) {
  const bytes = read(p.file);
  const r = inspectWav(bytes);
  const g = `wav[${p.file}]`;
  if (r.status !== 'ok') { fail(g, `rejected ${r.code}`); continue; }
  if (r.metrics.frames !== p.frames) fail(`${g}.frames`, `${r.metrics.frames} != ${p.frames}`);
  if (r.metrics.pcmBytes !== p.frames * 2) fail(`${g}.pcmBytes`, `${r.metrics.pcmBytes} != ${p.frames * 2}`);
  if (bytes.length !== 44 + p.frames * 2) fail(`${g}.sourceBytes`, `${bytes.length} != ${44 + p.frames * 2}`);
  if (r.metrics.durationMs !== Math.floor(p.frames / 48)) fail(`${g}.durationMs`, `${r.metrics.durationMs}`);
  if (p.file.endsWith('cue-max.wav') && (r.metrics.frames !== WAV.maxFrames || r.metrics.pcmBytes !== WAV.maxPcmBytes || r.metrics.durationMs !== WAV.maxDurationMs)) {
    fail(`${g}.max`, jp(r.metrics));
  }
  if (!failures.some((f) => f.check.startsWith(g))) pass(g, jp(r.metrics));
}
for (const r0 of wavCases.rejections ?? []) {
  const bytes = read(r0.file);
  const r = inspectWav(bytes);
  const g = `wav[${r0.file}]`;
  if (r.status === 'ok') fail(g, 'accepted, expected rejection');
  else if (r.code !== r0.code || r.stage !== r0.stage || (r0.limit !== undefined && r.limit !== r0.limit)) {
    fail(g, `${r.code}/stage ${r.stage} != ${r0.code}/stage ${r0.stage}`);
  } else pass(g, `${r.code}@${r.stage}`);
}

// ---------------------------------------------------------------------------
// 3b. the committed audio record: recipe / recipeDigest / metadataDigest
//     (project-model.md §18.5/§18.6, presentation.md §41.4.3)
// ---------------------------------------------------------------------------
// commands.md §6.6 rule 2 canonical JSON: object keys sorted codepoint order at
// every level, no insignificant whitespace, shortest string escapes.
function canonicalJsonText(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonText).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJsonText(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
const canonicalDigest = (value) => sha256(Buffer.from(canonicalJsonText(value), 'utf8'));
{
  const rec = wavCases.audioRecord ?? {};
  const g = 'audio[record]';
  const bytes = read(rec.preimage);
  const r = inspectWav(bytes);
  if (r.status !== 'ok') fail(g, `rejected ${r.code}`);
  else {
    if (!eq(r.metrics, rec.metrics)) fail(`${g}.metrics`, `${jp(r.metrics)} != ${jp(rec.metrics)}`);
    if (bytes.length !== rec.sourceByteLength) fail(`${g}.sourceByteLength`, `${bytes.length} != ${rec.sourceByteLength}`);
    if (sha256(bytes) !== rec.sourceDigest) fail(`${g}.sourceDigest`, sha256(bytes));
    if (bytes.length !== 44 + r.metrics.pcmBytes) fail(`${g}.arithmetic`, `${bytes.length} != 44 + ${r.metrics.pcmBytes}`);
    if (!eq(rec.recipe, wavCases.recipe)) fail(`${g}.recipe`, jp(rec.recipe));
    if (canonicalDigest(rec.recipe) !== rec.recipeDigest) fail(`${g}.recipeDigest`, canonicalDigest(rec.recipe));
    const metadataDigest = canonicalDigest({
      status: 'ok',
      kind: 'audio',
      sourceDigest: rec.sourceDigest,
      sourceByteLength: rec.sourceByteLength,
      importRecipe: rec.recipe,
      metrics: r.metrics,
    });
    if (metadataDigest !== rec.metadataDigest) fail(`${g}.metadataDigest`, metadataDigest);
  }
  if (!failures.some((f) => f.check.startsWith(g))) pass(g, `${rec.sourceDigest} recipeDigest ${rec.recipeDigest} metadataDigest ${rec.metadataDigest}`);

  // When the sibling packet-39 tree is present, the same re-derived facts must
  // be exactly what its committed audio records claim.
  const contractsRoot = resolve(ROOT, '..', 'contracts');
  if (existsSync(join(contractsRoot, 'index.json'))) {
    const cIdx = JSON.parse(readFileSync(join(contractsRoot, 'index.json'), 'utf8'));
    const rel = rec.contractsPreimage;
    const cBytes = readFileSync(join(contractsRoot, rel));
    if (!cBytes.equals(bytes)) fail('audio[contracts-preimage]', `${rel} differs from ${rec.preimage}`);
    else {
      const meta = cIdx.fixtures?.[rel];
      if (!meta || meta.sha256 !== sha256(cBytes) || meta.bytes !== cBytes.length) fail('audio[contracts-index]', `${rel} index entry disagrees with the bytes`);
      else pass('audio[contracts-preimage]', `${rel} byte-identical (${cBytes.length} B)`);
    }
    for (const f of [
      'catalog/audio-asset-record-v3.json',
      'envelope/valid/demo-0003-media-v3.json',
      'envelope/invalid/cue-kind-mismatch.json',
    ]) {
      const doc = JSON.parse(readFileSync(join(contractsRoot, f), 'utf8'));
      const record = (doc.content?.assets ?? []).find((a) => a.kind === 'audio');
      const v = record?.versions?.[0];
      const agrees =
        v !== undefined &&
        v.sourceDigest === rec.sourceDigest &&
        v.sourceByteLength === rec.sourceByteLength &&
        eq(v.importRecipe, rec.recipe) &&
        eq(v.metrics, r.metrics);
      if (!agrees) fail(`audio[contracts:${f}]`, 'record does not carry the re-derived preimage recipe/metrics');
      else pass(`audio[contracts:${f}]`, 'recipe/metrics/digest match the real bytes');
    }
  }
}

// ---------------------------------------------------------------------------
// 4. GLB role profile (presentation.md §§41.3.2/41.3.3)
// ---------------------------------------------------------------------------
function parseGlb(bytes) {
  if (bytes.length < 20 || u32le(bytes, 0) !== 0x46546c67 || u32le(bytes, 4) !== 2 || u32le(bytes, 8) !== bytes.length) throw new Error('container');
  if (u32le(bytes, 16) !== 0x4e4f534a) throw new Error('json chunk');
  const len = u32le(bytes, 12);
  if (20 + len > bytes.length) throw new Error('json length');
  const json = parseStrict(bytes.toString('utf8', 20, 20 + len).trimEnd());
  const rootNodes = (json.scenes?.[json.scene ?? 0]?.nodes ?? []);
  const animations = (json.animations ?? []).map((a) => ({
    name: a.name ?? '',
    channels: a.channels ?? [],
    samplers: a.samplers ?? [],
  }));
  const primitives = (json.meshes ?? []).flatMap((m) => (m.primitives ?? []).map((p) => p));
  let jointsPath = null;
  for (const [mi, m] of (json.meshes ?? []).entries()) {
    for (const [pi, p] of (m.primitives ?? []).entries()) {
      for (const name of ['JOINTS_0', 'WEIGHTS_0']) {
        if (p.attributes && name in p.attributes && jointsPath === null) {
          jointsPath = `/meshes/${mi}/primitives/${pi}/attributes/${name}`;
        }
      }
    }
  }
  const hasJoints = jointsPath !== null;
  const clipTimes = animations.map((a) => {
    let keyframes = 0;
    let maxTime = 0;
    for (const sampler of a.samplers) {
      const acc = json.accessors?.[sampler.input];
      if (acc) {
        keyframes += acc.count ?? 0;
        if (Array.isArray(acc.max) && typeof acc.max[0] === 'number') maxTime = Math.max(maxTime, acc.max[0]);
      }
    }
    return { keyframes, maxTime };
  });
  return {
    json, rootNodes, animations, hasJoints, jointsPath,
    skins: (json.skins ?? []).length,
    totalChannels: animations.reduce((n, a) => n + a.channels.length, 0),
    perClipChannels: animations.map((a) => a.channels.length),
    totalKeyframes: clipTimes.reduce((n, c) => n + c.keyframes, 0),
    maxClipMs: Math.round(Math.max(0, ...clipTimes.map((c) => c.maxTime)) * 1000),
    rootTranslationChannels: animations.flatMap((a) => a.channels).filter((ch) => rootNodes.includes(ch.target?.node) && ch.target?.path === 'translation').length,
  };
}

function validateRoles(glb, roles) {
  if (typeof roles !== 'object' || roles === null) return { code: 'field_type', path: '/roles' };
  for (const k of ROLE_KEYS) if (!(k in roles)) return { code: 'field_missing', path: `/roles/${k}` };
  for (const k of Object.keys(roles)) if (!ROLE_KEYS.includes(k)) return { code: 'field_unexpected', path: `/roles/${k}` };
  for (const k of ROLE_KEYS) {
    const b = roles[k];
    if (typeof b !== 'object' || b === null) return { code: 'field_type', path: `/roles/${k}` };
    for (const f of Object.keys(b)) if (f !== 'clipIndex' && f !== 'clipName') return { code: 'field_unexpected', path: `/roles/${k}/${f}` };
    if (!('clipIndex' in b)) return { code: 'field_missing', path: `/roles/${k}/clipIndex` };
    if (!('clipName' in b)) return { code: 'field_missing', path: `/roles/${k}/clipName` };
    if (!Number.isInteger(b.clipIndex) || b.clipIndex < 0) return { code: 'field_type', path: `/roles/${k}/clipIndex` };
    if (typeof b.clipName !== 'string' || b.clipName.length < 1 || b.clipName.length > 128) return { code: 'field_value', path: `/roles/${k}/clipName` };
  }
  for (const k of ROLE_KEYS) if (roles[k].clipIndex >= glb.animations.length) return { code: 'animation_role_out_of_range', role: k, clipIndex: roles[k].clipIndex, clips: glb.animations.length };
  const seen = new Map();
  for (const k of ROLE_KEYS) {
    const idx = roles[k].clipIndex;
    if (seen.has(idx)) return { code: 'animation_role_duplicate', clipIndex: idx, roles: [seen.get(idx), k] };
    seen.set(idx, k);
  }
  for (const k of ROLE_KEYS) {
    const b = roles[k];
    if (glb.animations[b.clipIndex].name !== b.clipName) return { code: 'animation_role_mismatch', role: k, expected: glb.animations[b.clipIndex].name, found: b.clipName };
  }
  for (const k of ROLE_KEYS) {
    const b = roles[k];
    const matches = glb.animations.filter((a) => a.name === b.clipName).length;
    if (matches > 1) return { code: 'animation_role_ambiguous', role: k, clipName: b.clipName, matches };
  }
  // §41.3.3 A1–A6 (after stages 1–6)
  if (glb.animations.length > CAPS.clips) return { code: 'asset_limits_exceeded', limit: 'animation_clips' };
  if (glb.skins > 0) return { code: 'animation_skin_unsupported', path: '/skins' };
  if (glb.hasJoints) return { code: 'animation_skin_unsupported', path: glb.jointsPath };
  if (glb.totalChannels > CAPS.tracks || glb.perClipChannels.some((n) => n > CAPS.tracksPerClip)) return { code: 'asset_limits_exceeded', limit: 'animation_tracks' };
  if (glb.totalKeyframes > CAPS.trackTimes) return { code: 'asset_limits_exceeded', limit: 'animation_track_times' };
  if (glb.maxClipMs > CAPS.clipMs) return { code: 'asset_limits_exceeded', limit: 'animation_clip_duration' };
  if (glb.rootTranslationChannels > 0) {
    const ch = glb.animations.flatMap((a) => a.channels).find((c) => glb.rootNodes.includes(c.target?.node) && c.target?.path === 'translation');
    return { code: 'animation_root_motion', nodeIndex: ch.target.node };
  }
  return { status: 'accepted' };
}

const profileCases = readJson('glb/profile-cases.json');
if (!eq(profileCases.profileCaps ?? {}, CAPS)) fail('constants[profile]', jp(profileCases.profileCaps));
else pass('constants[profile]');
if (!eq(profileCases.roles, ROLE_KEYS)) fail('constants[roles]', jp(profileCases.roles));
else pass('constants[roles]');

const glbCache = new Map();
for (const c of profileCases.cases ?? []) {
  const rel = `glb/${c.file}`;
  if (!glbCache.has(rel)) {
    try { glbCache.set(rel, parseGlb(read(rel))); } catch (e) { glbCache.set(rel, null); fail(`glb[${rel}]`, `parse failed: ${e instanceof Error ? e.message : String(e)}`); }
  }
  const glb = glbCache.get(rel);
  if (glb === null) continue;
  const got = validateRoles(glb, c.roles);
  const g = `glb[${c.id}]`;
  if (c.expect.verdict === 'accepted') {
    if (got.status !== 'accepted') fail(g, `rejected ${got.code}`);
    else pass(g, 'accepted');
  } else {
    if (got.status === 'accepted') fail(g, 'accepted, expected rejection');
    else if (got.code !== c.expect.code || (c.expect.limit !== undefined && got.limit !== c.expect.limit) || (c.expect.path !== undefined && got.path !== c.expect.path)) {
      fail(g, `${got.code}${got.limit ? '/' + got.limit : ''}${got.path ? ' ' + got.path : ''} != ${c.expect.code}${c.expect.limit ? '/' + c.expect.limit : ''}${c.expect.path ? ' ' + c.expect.path : ''}`);
    } else pass(g, got.code);
  }
}
// The reordered positive must have the same clip-name set as the stored-order one.
{
  try {
    const a = parseGlb(read('glb/courier-roles.glb'));
    const b = parseGlb(read('glb/courier-reordered.glb'));
    const names = (x) => x.animations.map((k) => k.name).sort();
    if (!eq(names(a), names(b))) fail('glb[reorder-equivalence]', `${jp(names(a))} != ${jp(names(b))}`);
    else if (eq(b.animations.map((k) => k.name), a.animations.map((k) => k.name))) fail('glb[reorder-equivalence]', 'stored order identical');
    else pass('glb[reorder-equivalence]');
  } catch (e) {
    fail('glb[reorder-equivalence]', e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// 4b. Packet 53 — the real-roles modelAnimation components (presentation.md
//     §41.3.1/§41.3.4; CC-47-1 / Gate L P3). Every verdict is re-derived with
//     the same stage 3 / stage 5–6 function as the profile cases, against the
//     named GLB's loaded clips; the component shape is pinned (canonical key
//     order, §23.3.6 roles ≤ 4096 canonical bytes).
// ---------------------------------------------------------------------------
const rolesCases = readJson('roles/roles-cases.json');
if (!eq(rolesCases.roles ?? [], ROLE_KEYS)) fail('roles[roles]', jp(rolesCases.roles));
else pass('roles[roles]');
for (const c of rolesCases.cases ?? []) {
  const g = `roles[${c.id}]`;
  const comp = c.component ?? {};
  if (!eq(Object.keys(comp), ['assetId', 'version', 'roles'])) { fail(g, `component keys ${jp(Object.keys(comp))}`); continue; }
  if (typeof comp.assetId !== 'string' || comp.assetId !== 'asset-model-courier') { fail(g, `assetId ${jp(comp.assetId)}`); continue; }
  if (!Number.isInteger(comp.version) || comp.version < 1) { fail(g, `version ${jp(comp.version)}`); continue; }
  if (!eq(Object.keys(comp.roles ?? {}), ROLE_KEYS)) { fail(g, `roles keys ${jp(Object.keys(comp.roles ?? {}))}`); continue; }
  const rolesBytes = Buffer.byteLength(JSON.stringify(comp.roles), 'utf8');
  if (rolesBytes > 4096) { fail(g, `roles ${rolesBytes} bytes > 4096`); continue; }
  const rel = `glb/${c.file}`;
  if (!glbCache.has(rel)) {
    try { glbCache.set(rel, parseGlb(read(rel))); } catch (e) { glbCache.set(rel, null); fail(g, `parse failed: ${e instanceof Error ? e.message : String(e)}`); }
  }
  const glb = glbCache.get(rel);
  if (glb === null) continue;
  const got = validateRoles(glb, comp.roles);
  if (c.expect.verdict === 'accepted') {
    if (got.status !== 'accepted') fail(g, `rejected ${got.code}`);
    else pass(g, 'accepted');
  } else {
    if (got.status === 'accepted') fail(g, 'accepted, expected rejection');
    else if (got.code !== c.expect.code) fail(g, `${got.code} != ${c.expect.code}`);
    else pass(g, got.code);
  }
}

// ---------------------------------------------------------------------------
// 5. lights, presets and independence (presentation.md §§41.1/41.2)
// ---------------------------------------------------------------------------
const render = readJson('render/light-surface-cases.json');
if (!eq(render.presets ?? {}, PRESETS)) fail('presets[table]', jp(render.presets));
else pass('presets[table]', 'three frozen rows match model.md §23.3.5');
if (!eq(render.shadow ?? {}, SHADOW)) fail('constants[shadow]', jp(render.shadow));
else pass('constants[shadow]');

const HEX = /^#[0-9a-f]{6}$/;
function validateLight(v) {
  if (typeof v !== 'object' || v === null) return { code: 'field_type' };
  const keys = Object.keys(v);
  if (v.type === undefined) return { code: 'field_missing', path: '/type' };
  if (v.type !== 'directional' && v.type !== 'ambient') return { code: 'field_value', path: '/type' };
  if (v.color === undefined) return { code: 'field_missing', path: '/color' };
  if (typeof v.color !== 'string' || !HEX.test(v.color.toLowerCase())) return { code: 'field_value', path: '/color' };
  if (v.intensity === undefined) return { code: 'field_missing', path: '/intensity' };
  if (typeof v.intensity !== 'number' || !Number.isFinite(v.intensity) || v.intensity < 0 || v.intensity > 8) return { code: 'number_out_of_range', path: '/intensity' };
  if (v.type === 'ambient') {
    if ('direction' in v) return { code: 'field_value', path: '/direction' };
    if ('castShadow' in v) return { code: 'field_value', path: '/castShadow' };
    return { status: 'ok' };
  }
  if (!('direction' in v)) return { code: 'field_missing', path: '/direction' };
  if (!Array.isArray(v.direction) || v.direction.length !== 3) return { code: 'field_type', path: '/direction' };
  if (!v.direction.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1)) return { code: 'number_out_of_range', path: '/direction' };
  if (Math.hypot(...v.direction) < 1e-6) return { code: 'number_out_of_range', path: '/direction' };
  if ('castShadow' in v && typeof v.castShadow !== 'boolean') return { code: 'field_type', path: '/castShadow' };
  for (const k of keys) if (!['type', 'color', 'intensity', 'direction', 'castShadow'].includes(k)) return { code: 'field_unexpected', path: `/${k}` };
  return { status: 'ok' };
}
for (const c of render.lights ?? []) {
  const got = validateLight(c.value);
  const g = `light[${c.id}]`;
  if (c.expect.ok) { if (got.status !== 'ok') fail(g, `rejected ${got.code}`); else pass(g, 'ok'); }
  else if (got.status === 'ok') fail(g, 'accepted, expected rejection');
  else if (got.code !== c.expect.code) fail(g, `${got.code} != ${c.expect.code}`);
  else pass(g, got.code);
}

for (const c of render.shadowCases ?? []) {
  const g = `shadow[${c.id}]`;
  let got;
  if (!c.webgl2) got = { error: 'render_unsupported' };
  else if (!c.castShadow) got = { shadows: 'off', shadowReason: 'cast_shadow_false' };
  else if (!c.probeOk) got = { shadows: 'off', shadowReason: 'shadow_unsupported' };
  else {
    const halfExtent = Math.max((c.level.maxX - c.level.minX) / 2, (c.level.maxY - c.level.minY) / 2) + SHADOW.margin;
    got = halfExtent > SHADOW.halfExtentMax ? { shadows: 'off', shadowReason: 'shadow_bounds_exceeded' } : { shadows: 'on' };
  }
  if (!eq(got, c.expect)) fail(g, `${jp(got)} != ${jp(c.expect)}`);
  else pass(g, jp(got));
}

{
  const pi = render.presetIndependence ?? {};
  const g = 'preset-independence';
  if (!pi.entityA || !pi.entityB) fail(g, 'missing preset-independence data');
  const a = { ...(PRESETS[pi.entityA?.preset] ?? {}) };
  const b = { ...pi.entityB.before };
  const fields = Object.keys(pi.expect.A);
  if (!eq(fields, PRESET_FIELDS)) fail(`${g}.fields`, jp(fields));
  else if (!eq(a, pi.expect.A)) fail(`${g}.A`, jp(a));
  else if (!eq(b, pi.expect.B)) fail(`${g}.B`, jp(b));
  else if (!eq(pi.expect.changedFields, PRESET_FIELDS)) fail(`${g}.changedFields`, jp(pi.expect.changedFields));
  else pass(g, 'A changed to the hazard row; B keeps its own values');
}

// ---------------------------------------------------------------------------
// 6. activation appearance (presentation.md §41.5)
// ---------------------------------------------------------------------------
const activation = readJson('activation/appearance-cases.json');
{
  const a = activation.appearance;
  const ok = typeof a.emissive === 'string' && /^#[0-9a-f]{6}$/.test(a.emissive)
    && typeof a.emissiveIntensity === 'number' && a.emissiveIntensity >= 0 && a.emissiveIntensity <= 4
    && (a.cueAssetId === null || typeof a.cueAssetId === 'string');
  if (!ok) fail('activation[appearance]', jp(a));
  else pass('activation[appearance]');
  let active = false;
  let id = null;
  let bad = 0;
  for (const step of activation.timeline ?? []) {
    if (step.event === 'checkpointActivated') { active = true; id = activation.zone?.entityId ?? null; }
    if (step.event === 'replayed') { active = false; id = null; }
    const marker = active ? 'activated' : 'authored';
    if (step.expect.checkpointActive !== active || step.expect.checkpointId !== id || step.expect.marker !== marker) {
      fail(`activation[${step.step}]`, `${active}/${id}/${marker} != ${jp(step.expect)}`);
      bad += 1;
    }
  }
  if (bad === 0) pass('activation[timeline]', `${activation.timeline.length} steps`);
  if (!activation.zone || typeof activation.zone.entityId !== 'string' || !activation.zone.surface) {
    fail('activation[zone]', 'missing zone/surface');
  } else pass('activation[zone]');
}

// ---------------------------------------------------------------------------
// 7. ownership invariants (presentation.md §41.6)
// ---------------------------------------------------------------------------
const ownership = readJson('ownership/ownership-cases.json');
for (const c of ownership.cases ?? []) {
  const g = `ownership[${c.id}]`;
  if (c.id === 'repeated-dispose-idempotent' || c.id === 'audio-repeated-dispose') {
    const got = [{ ok: true }];
    for (let i = 1; i < c.calls; i += 1) got.push({ ok: true, alreadyDisposed: true });
    if (!eq(got, c.expect)) fail(g, jp(got)); else pass(g, 'idempotent');
  } else if (c.id === 'instance-isolation') {
    const pi = render.presetIndependence ?? {};
    const aAfter = { ...(PRESETS[pi.entityA?.preset] ?? {}) };
    const bAfter = { ...(PRESETS[pi.entityB?.preset] ?? {}) };
    const got = {
      A: eq(aAfter, pi.entityA?.before) ? 'unchanged' : 'changed',
      B: eq(bAfter, pi.entityB?.before) ? 'unchanged' : 'changed',
      shared: 'unchanged',
    };
    if (got.A !== 'changed' || got.B !== c.expect.B || got.shared !== c.expect.shared) fail(g, jp(got));
    else pass(g, 'one instance changed only itself');
  } else if (c.id === 'last-instance-release') {
    let live = c.instances;
    const leases = [];
    for (const _ of c.disposeOrder) { live -= 1; leases.push(live); }
    if (!eq(leases, c.expectLeases)) fail(g, `${jp(leases)} != ${jp(c.expectLeases)}`);
    else pass(g, jp(leases));
  }
}
for (const r of ownership.resources ?? []) {
  if (!r.creator || !r.disposer || !r.counter) fail(`ownership[resource:${r.resource}]`, 'incomplete row');
}
if (!failures.some((f) => f.check.startsWith('ownership[resource:'))) pass('ownership[resources]', `${ownership.resources.length} rows`);

// ---------------------------------------------------------------------------
// 8. injected audio owner (presentation.md §41.4.7)
// ---------------------------------------------------------------------------
const audio = readJson('audio/audio-cases.json');
{
  const g = `audio[voiceCap]`;
  const live = Math.min(audio.voiceCap.events, AUDIO_MAX_VOICES);
  const dropped = audio.voiceCap.events - live;
  if (live !== audio.voiceCap.expectLive || dropped !== audio.voiceCap.dropped || audio.voiceCap.dropReason !== 'voice_cap') fail(g, `${live}/${dropped}`);
  else pass(g, `${live} live, ${dropped} dropped`);
}
{
  const g = 'audio[dedupe]';
  const seen = new Set();
  let played = 0;
  for (const id of audio.dedupe?.ids ?? []) { if (!seen.has(id)) { seen.add(id); played += 1; } }
  if (played !== audio.dedupe?.expectPlayed) fail(g, `${played} != ${audio.dedupe?.expectPlayed}`);
  else pass(g, `${played} played of ${(audio.dedupe?.ids ?? []).length}`);
}
{
  const g = 'audio[runReset]';
  let run = null;
  const seen = new Set();
  let played = 0;
  for (const id of [...(audio.runReset?.idsRunA ?? []), ...(audio.runReset?.runB ?? [])]) {
    const r = id.split('/')[0];
    if (r !== run) { run = r; seen.clear(); }
    if (!seen.has(id)) { seen.add(id); played += 1; }
  }
  if (played !== audio.runReset?.expectPlayed) fail(g, `${played} != ${audio.runReset?.expectPlayed}`);
  else pass(g, `${played} played across two runs`);
}
{
  const g = 'audio[stale]';
  let stale = false;
  let played = 0;
  let discarded = 0;
  for (const op of audio.stale?.sequence ?? []) {
    if (op === 'stop') stale = true;
    else if (op === 'decode-resolve') { if (stale) discarded += 1; else played += 1; }
  }
  if (played !== audio.stale?.expectPlayed || discarded !== audio.stale?.expectDiscarded) fail(g, `${played}/${discarded}`);
  else pass(g, `${played} played, ${discarded} discarded`);
}
{
  const expected = {
    no_audio_context: { state: 'unsupported', reason: 'no_audio_context' },
    resume_rejects: { state: 'blocked', reason: 'autoplay_denied' },
    no_output_device: { state: 'blocked', reason: 'no_device' },
    unlock_ok: { state: 'ready', unlocked: true, muted: false },
    muted: { state: 'ready', muted: true, unlocked: true },
    disposed: { state: 'disposed' },
  };
  for (const s of audio.statuses ?? []) {
    const got = expected[s.environment];
    const matches = got && got.state === s.expect.state
      && (s.expect.reason === undefined || got.reason === s.expect.reason)
      && (s.expect.muted === undefined || got.muted === s.expect.muted)
      && (s.expect.unlocked === undefined || got.unlocked === true);
    if (!matches) fail(`audio[status:${s.id}]`, `${jp(got)} != ${jp(s.expect)}`);
    else pass(`audio[status:${s.id}]`, s.expect.state);
  }
  const untrusted = (audio.gesture?.untrusted ?? []).length;
  const trusted = (audio.gesture?.trusted ?? []).length;
  if (untrusted < 3 || trusted < 3) fail('audio[gesture]', jp(audio.gesture));
  else pass('audio[gesture]', `${trusted} trusted / ${untrusted} untrusted`);
}

// ---------------------------------------------------------------------------
// 9. error-code sets (presentation.md §41.7.2)
// ---------------------------------------------------------------------------
{
  const declared = readJson('errors/codes.json').sets ?? {};
  if (!eq(declared, CODE_SETS)) fail('codes[sets]', jp(declared));
  else pass('codes[sets]', `${Object.keys(CODE_SETS).length} closed sets`);
  const referenced = new Set();
  for (const c of profileCases.cases ?? []) if (c.expect.code) referenced.add(c.expect.code);
  for (const r of wavCases.rejections ?? []) referenced.add(r.code);
  const known = new Set([
    'field_missing', 'field_unexpected', 'field_type', 'field_value', 'number_out_of_range',
    ...CODE_SETS.modelCommand, ...CODE_SETS.audioDiagnostics,
    ...CODE_SETS.limitNames.map(() => 'asset_limits_exceeded'), 'asset_limits_exceeded',
  ]);
  for (const code of referenced) {
    if (!known.has(code)) fail('codes[referenced]', `${code} is not in the declared sets`);
  }
  if (!failures.some((f) => f.check === 'codes[referenced]')) pass('codes[referenced]', `${referenced.size} codes referenced by fixtures`);

  // The runtime role-selector rule is re-derived for the boundary speeds.
  const role = (grounded, speed) => (!grounded ? 'airborne' : speed > RUN_SPEED_EPS ? 'run' : 'idle');
  const cases = [[true, 0, 'idle'], [true, RUN_SPEED_EPS, 'idle'], [true, RUN_SPEED_EPS + 0.001, 'run'], [false, 4, 'airborne']];
  for (const [grounded, speed, want] of cases) {
    if (role(grounded, speed) !== want) fail('selector[role]', `${grounded}/${speed} != ${want}`);
  }
  if (!failures.some((f) => f.check === 'selector[role]')) pass('selector[role]', `${cases.length} cases`);
  if (ANIMATION_CROSSFADE_SECONDS !== 0.2) fail('selector[crossfade]', `${ANIMATION_CROSSFADE_SECONDS}`);
  else pass('selector[crossfade]', '0.2 s');
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
const groups = new Set([...passes, ...failures].map((e) => e.check.split('[')[0]));
const report = {
  packet: 41,
  fixtureRoot: ROOT,
  files: dataFiles.length,
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
process.exit(failures.length === 0 ? 0 : 1);
