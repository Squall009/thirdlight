/**
 * Committed media fixtures through the real `@thirdlight/asset-pipeline`.
 *
 * The committed `.wav`/`.glb` bytes and the committed case files are the
 * evidence; this suite drives the real `inspectAudio` / role-aware `inspectGlb`
 * over those bytes, re-derives every digest with `node:crypto` independently,
 * checks the `fixtures/m3/contracts` audio record through the real
 * `@thirdlight/project-model` loader, and runs the fixture checker together with
 * its deliberate-corruption control as real child processes. The WAV cases were
 * written for the fixed short-sound profile; the one audio kind takes every
 * well-formed PCM or float file among them and refuses what no browser plays.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  AUDIO_PIPELINE_VERSION,
  AUDIO_TOOLCHAIN,
  importMetadataDigest,
  importRecipeDigest,
  inspectAudio,
  inspectGlb,
  type AudioImportOptions,
  type AudioImportProposal,
  type ImportJobPort,
  type ImportOptions,
  type ImportProposal,
} from '@thirdlight/asset-pipeline';
import { AUDIO_PIPELINE_VERSION as MODEL_AUDIO_PIPELINE_VERSION, validateContentV3, validateEnvelopeV3 } from '@thirdlight/project-model';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MEDIA = join(REPO_ROOT, 'fixtures', 'm3', 'media');
const CONTRACTS = join(REPO_ROOT, 'fixtures', 'm3', 'contracts');

const bytesOf = (rel: string): Buffer => readFileSync(join(MEDIA, rel));
const sha256 = (buf: Uint8Array): string => createHash('sha256').update(buf).digest('hex');
const json = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

/** Canonical JSON (independent of the package's copy). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const canonicalDigest = (value: unknown): string => sha256(Buffer.from(canonicalJson(value), 'utf8'));

const AUDIO_OPTIONS: AudioImportOptions = {
  profile: 'audio',
  recipeVersion: 1,
  toolchain: AUDIO_TOOLCHAIN,
};

const GLTF_OPTIONS: ImportOptions = {
  profile: 'gltf-glb',
  recipeVersion: 1,
  toolchain: { three: '0.186.0' },
};

interface WavCase {
  readonly file: string;
  readonly frames?: number;
  readonly code?: string;
  readonly stage?: number;
  readonly limit?: string;
}

interface WavCases {
  readonly recipe: Record<string, unknown>;
  readonly audioRecord: {
    readonly preimage: string;
    readonly contractsPreimage: string;
    readonly sourceDigest: string;
    readonly sourceByteLength: number;
    readonly recipe: Record<string, unknown>;
    readonly recipeDigest: string;
    readonly metadataDigest: string;
    readonly metrics: Record<string, number | string>;
  };
  readonly positives: readonly WavCase[];
  readonly rejections: readonly WavCase[];
}

interface ProfileCase {
  readonly id: string;
  readonly file: string;
  readonly roles: Record<string, { clipIndex: number; clipName: string }>;
  readonly expect: { verdict: 'accepted' | 'rejected'; code?: string; limit?: string; path?: string };
}

interface ProfileCases {
  readonly cases: readonly ProfileCase[];
}

const wavCases = json<WavCases>(join(MEDIA, 'wav', 'wav-cases.json'));
const profileCases = json<ProfileCases>(join(MEDIA, 'glb', 'profile-cases.json'));

/** A PCM WAV's header facts, re-derived here from its canonical 44-byte header (never read from the proposal). */
function deriveMetrics(bytes: Buffer): Record<string, number | string> {
  const channels = bytes.readUInt16LE(22);
  const sampleRate = bytes.readUInt32LE(24);
  const bitsPerSample = bytes.readUInt16LE(34);
  const frames = bytes.readUInt32LE(40) / (channels * (bitsPerSample / 8));
  return { format: 'wav', channels, sampleRate, bitsPerSample, durationMs: Math.max(1, Math.round((frames / sampleRate) * 1000)) };
}

/** What no browser plays (ADPCM, µ-law, A-law in WAV) and what is not a WAV at all. */
const REFUSED: Readonly<Record<string, string>> = {
  'wav/rejections/adpcm.wav': 'audio_format_unsupported',
  'wav/rejections/mulaw.wav': 'audio_format_unsupported',
  'wav/rejections/alaw.wav': 'audio_format_unsupported',
  'wav/rejections/zero-frames.wav': 'audio_empty',
  'wav/rejections/bad-magic.wav': 'audio_container_invalid',
  'wav/rejections/rf64.wav': 'audio_container_invalid',
  'wav/rejections/bw64.wav': 'audio_container_invalid',
  'wav/rejections/non-wav.bin': 'audio_container_invalid',
  'wav/rejections/data-url.txt': 'audio_container_invalid',
  'wav/rejections/remote-url.txt': 'audio_container_invalid',
  'wav/rejections/compressed.bin': 'audio_container_invalid',
};

describe('committed media fixture checker', () => {
  it('passes, and its corruption control detects every corruption', () => {
    const checker = join(MEDIA, 'tools', 'check-fixtures.mjs');
    const ok = spawnSync(process.execPath, [checker], { encoding: 'utf8' });
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout).toContain('all checks passed');
    const control = spawnSync(process.execPath, [checker, '--corrupt-control'], { encoding: 'utf8' });
    expect(control.status, control.stdout + control.stderr).toBe(0);
    // Ten corruptions, one of them `roles-case-expectation` (the real-roles
    // fixture group).
    expect(control.stdout).toContain('10/10 detected');
    const gen = spawnSync(process.execPath, [join(MEDIA, 'tools', 'generate-fixtures.mjs'), '--check'], { encoding: 'utf8' });
    expect(gen.status, gen.stdout + gen.stderr).toBe(0);
    expect(gen.stdout).toContain('reproduce exactly');
  }, 30_000); // three node child processes; ~3 s alone, slower while the FBX tests run Blender
});

describe('inspectAudio over the committed WAV bytes', () => {
  it('accepts every committed positive with its header facts', () => {
    expect(wavCases.positives.length).toBeGreaterThanOrEqual(8);
    for (const c of wavCases.positives) {
      const bytes = bytesOf(c.file);
      const proposal = inspectAudio(bytes, AUDIO_OPTIONS);
      expect(proposal.status, c.file).toBe('ok');
      expect(proposal.kind).toBe('audio');
      expect(proposal.metrics, c.file).toEqual(deriveMetrics(bytes));
      expect(proposal.sourceByteLength).toBe(bytes.length);
      expect(proposal.sourceDigest).toBe(sha256(bytes));
      // The recipe has exactly the three accepted keys (no `extensions`).
      expect(proposal.importRecipe).toEqual({ profile: 'audio', recipeVersion: 1, toolchain: { 'asset-pipeline': '0.1.0' } });
      expect(Object.isFrozen(proposal)).toBe(true);
    }
  });

  it('takes what the fixed short-sound profile refused and every browser plays: any channels, rate, bit depth, float, length', () => {
    const facts = (file: string) => inspectAudio(bytesOf(file), AUDIO_OPTIONS).metrics;
    expect(facts('wav/rejections/stereo.wav')).toMatchObject({ channels: 2 });
    expect(facts('wav/rejections/rate-44100.wav')).toMatchObject({ sampleRate: 44100 });
    expect(facts('wav/rejections/bit-depth-8.wav')).toMatchObject({ bitsPerSample: 8 });
    expect(facts('wav/rejections/float32.wav')).toMatchObject({ bitsPerSample: 32, float: true });
    // Past the old 2 s / 192 000-byte caps: no duration cap, only the per-file size cap.
    expect(facts('wav/rejections/oversized-pcm.wav')?.durationMs).toBeGreaterThanOrEqual(2000);
    expect(facts('wav/rejections/huge-source.wav')?.durationMs).toBeGreaterThan(2000);
  });

  it('refuses what no browser plays and what is not audio (the bytes alone decide)', () => {
    for (const [file, code] of Object.entries(REFUSED)) {
      const proposal = inspectAudio(bytesOf(file), AUDIO_OPTIONS);
      expect(proposal.status, file).toBe('rejected');
      expect(proposal.diagnostics[0]?.code, file).toBe(code);
      expect(proposal.metrics).toBeUndefined();
      expect(proposal.kind).toBeUndefined();
    }
  });

  it('is deterministic and total over hostile bytes', () => {
    const a = inspectAudio(bytesOf('wav/cue-start.wav'), AUDIO_OPTIONS);
    const b = inspectAudio(bytesOf('wav/cue-start.wav'), AUDIO_OPTIONS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // A caller MIME type / declared kind is not an input: only bytes and options.
    expect(inspectAudio(new Uint8Array(44), AUDIO_OPTIONS).status).toBe('rejected');
    expect(inspectAudio(new Uint8Array(0), AUDIO_OPTIONS).status).toBe('rejected');
    for (const c of wavCases.rejections) expect(['ok', 'rejected']).toContain(inspectAudio(bytesOf(c.file!), AUDIO_OPTIONS).status);
  });

  it('rejects invalid options as a caller programming error', () => {
    const bytes = bytesOf('wav/cue-start.wav');
    expect(() => inspectAudio(bytes, { ...AUDIO_OPTIONS, profile: 'gltf-glb' } as unknown as AudioImportOptions)).toThrow(TypeError);
    expect(() => inspectAudio(bytes, { ...AUDIO_OPTIONS, recipeVersion: 2 } as unknown as AudioImportOptions)).toThrow(TypeError);
    expect(() => inspectAudio(bytes, { ...AUDIO_OPTIONS, toolchain: {} })).toThrow(TypeError);
    expect(() => inspectAudio(bytes, { ...AUDIO_OPTIONS, toolchain: { three: '0.186.0' } })).toThrow(TypeError);
    expect(() => inspectAudio(bytes, { ...AUDIO_OPTIONS, toolchain: { 'asset-pipeline': '0.2.0' } })).toThrow(TypeError);
    expect(() => inspectAudio('nope' as unknown as Uint8Array, AUDIO_OPTIONS)).toThrow(TypeError);
  });
});

describe('cancellation through the accepted job port', () => {
  const job = (over: Partial<ImportJobPort> = {}): ImportJobPort => ({
    now: () => 0,
    isCancelled: () => false,
    proposalId: () => `p-${'a'.repeat(32)}`,
    stageId: () => 'stage-1',
    expiresAt: () => '2030-01-01T00:00:00Z',
    suggestedDisplayName: 'cue',
    ...over,
  });

  it('reports the accepted asset_timeout rejection for a cancelled audio job', () => {
    const proposal = inspectAudio(bytesOf('wav/cue-start.wav'), { ...AUDIO_OPTIONS, job: job({ isCancelled: () => true }) });
    expect(proposal.status).toBe('rejected');
    expect(proposal.diagnostics.map((d) => d.code)).toEqual(['asset_timeout']);
    expect(proposal.proposalId).toBe(`p-${'a'.repeat(32)}`);
    expect(proposal.stageId).toBe('stage-1');
  });

  it('reports the accepted asset_timeout rejection for an over-budget audio job', () => {
    let t = 0;
    const proposal = inspectAudio(bytesOf('wav/cue-start.wav'), {
      ...AUDIO_OPTIONS,
      job: job({ now: () => (t += 60_000), timeoutMs: 30_000 }),
    });
    expect(proposal.status).toBe('rejected');
    expect(proposal.diagnostics[0]?.code).toBe('asset_timeout');
  });

  it('honours the same path for the role-aware GLB inspection', () => {
    const proposal = inspectGlb(bytesOf('glb/courier-roles.glb'), {
      ...GLTF_OPTIONS,
      job: job({ isCancelled: () => true }),
      animation: { roles: profileCases.cases[0]!.roles },
    });
    expect(proposal.status).toBe('rejected');
    expect(proposal.diagnostics[0]?.code).toBe('asset_timeout');
  });
});

describe('role-aware GLB proposal', () => {
  it('reproduces every committed profile case through the real pipeline', () => {
    expect(profileCases.cases.length).toBeGreaterThanOrEqual(20);
    // The animation binding stages 1–2 (container/fields) are model-owned, so the
    // pipeline reports stages 3–6 + A1–A6 only; a structurally malformed
    // request is a caller programming error here (and a `field_*` error at the
    // model boundary).
    const stage12 = new Set(['field_missing', 'field_unexpected', 'field_type', 'field_value']);
    let executed = 0;
    for (const c of profileCases.cases) {
      const bytes = bytesOf(`glb/${c.file}`);
      if (c.expect.code !== undefined && stage12.has(c.expect.code)) {
        expect(
          () => inspectGlb(bytes, { ...GLTF_OPTIONS, animation: { roles: c.roles } }),
          c.id,
        ).toThrow(TypeError);
        continue;
      }
      const proposal: ImportProposal = inspectGlb(bytes, { ...GLTF_OPTIONS, animation: { roles: c.roles } });
      executed += 1;
      if (c.expect.verdict === 'accepted') {
        expect(proposal.status, c.id).toBe('ok');
        expect(proposal.metrics, c.id).toBeTruthy();
      } else {
        expect(proposal.status, c.id).toBe('rejected');
        expect(proposal.diagnostics.length, c.id).toBeGreaterThanOrEqual(1);
        const first = proposal.diagnostics[0]!;
        expect(first.code, c.id).toBe(c.expect.code);
        if (c.expect.limit !== undefined) expect(first.limit, c.id).toBe(c.expect.limit);
        if (c.expect.path !== undefined) expect(first.path, c.id).toBe(c.expect.path);
        if (c.expect.code === 'animation_root_motion') {
          expect(first.nodeIndex, c.id).toBe(0);
          expect(first.nodeName, c.id).toBe('Courier');
        }
      }
    }
    expect(executed).toBe(profileCases.cases.length - 2);
  });

  it('keeps the accepted M2 GLB proposal shape byte-unchanged when no profile is requested', () => {
    // Every animated-profile negative is a *valid* M2 GLB on its own; the
    // profile only applies when the caller asks for it.
    for (const file of ['bad-skin.glb', 'bad-joints.glb', 'bad-root-motion.glb', 'many-clips.glb', 'long-clip.glb']) {
      const proposal = inspectGlb(bytesOf(`glb/${file}`), GLTF_OPTIONS);
      expect(proposal.status, file).toBe('ok');
      expect(proposal.kind).toBe('model');
      expect(proposal.importRecipe.profile).toBe('gltf-glb');
      expect(proposal.importRecipe.extensions).toEqual([]);
      expect(proposal.limits.profile).toBe('gltf-glb');
    }
    // Without `animation` no role/profile diagnostic can appear.
    const without = inspectGlb(bytesOf('glb/bad-joints.glb'), GLTF_OPTIONS);
    expect(without.diagnostics).toEqual([]);
    const withRoles = inspectGlb(bytesOf('glb/bad-joints.glb'), {
      ...GLTF_OPTIONS,
      animation: { roles: profileCases.cases.find((c) => c.id === 'role-joints-rejected')!.roles },
    });
    expect(withRoles.diagnostics[0]?.code).toBe('animation_skin_unsupported');
  });

  it('accepts the reordered mapping and rejects the stored-order mapping for the same bytes', () => {
    const reordered = profileCases.cases.find((c) => c.id === 'roles-ok-reordered')!;
    const swapped: Record<string, { clipIndex: number; clipName: string }> = {
      idle: { clipIndex: 0, clipName: 'Idle' },
      run: { clipIndex: 1, clipName: 'Run' },
      airborne: { clipIndex: 2, clipName: 'Airborne' },
    };
    const ok = inspectGlb(bytesOf('glb/courier-reordered.glb'), { ...GLTF_OPTIONS, animation: { roles: reordered.roles } });
    expect(ok.status).toBe('ok');
    const bad = inspectGlb(bytesOf('glb/courier-reordered.glb'), { ...GLTF_OPTIONS, animation: { roles: swapped } });
    expect(bad.status).toBe('rejected');
    expect(bad.diagnostics[0]?.code).toBe('animation_role_mismatch');
  });

  it('validates the requested mapping shape as a caller programming error', () => {
    const bytes = bytesOf('glb/courier-roles.glb');
    const roles = profileCases.cases[0]!.roles;
    const send = (animation: unknown): ImportProposal =>
      inspectGlb(bytes, { ...GLTF_OPTIONS, animation } as unknown as ImportOptions);
    expect(() => send({ roles: { idle: roles['idle'] } })).toThrow(TypeError);
    expect(() => send({ roles: { ...roles, walk: roles['run'] } })).toThrow(TypeError);
    expect(() => send({ roles: { ...roles, idle: { clipIndex: -1, clipName: 'Idle' } } })).toThrow(TypeError);
    expect(() => send({ roles: { ...roles, idle: { clipIndex: 0.5, clipName: 'Idle' } } })).toThrow(TypeError);
    expect(() => send({ roles: { ...roles, idle: { clipIndex: 0, clipName: 7 } } })).toThrow(TypeError);
    expect(() => send({ roles: { ...roles, idle: { clipIndex: 0 } } })).toThrow(TypeError);
  });
});

describe('recipe and metadata digests over supplied records', () => {
  it('matches SHA-256(canonical JSON of the recipe) independently', () => {
    const proposal = inspectAudio(bytesOf('wav/cue-preimage.wav'), AUDIO_OPTIONS);
    expect(proposal.status).toBe('ok');
    expect(importRecipeDigest(proposal.importRecipe)).toBe(canonicalDigest(proposal.importRecipe));
    const metadataDigest = canonicalDigest({
      status: proposal.status,
      kind: proposal.kind,
      sourceDigest: proposal.sourceDigest,
      sourceByteLength: proposal.sourceByteLength,
      importRecipe: proposal.importRecipe,
      metrics: proposal.metrics,
    });
    expect(importMetadataDigest(proposal)).toBe(metadataDigest);
    expect(proposal.sourceDigest).toBe(wavCases.audioRecord.sourceDigest);
  });

  it('agrees with the fixtures/m3/contracts audio record', () => {
    const rec = wavCases.audioRecord;
    const preimage = readFileSync(join(CONTRACTS, rec.contractsPreimage));
    expect(preimage.equals(bytesOf(rec.preimage))).toBe(true);
    const proposal = inspectAudio(preimage, AUDIO_OPTIONS);
    for (const rel of [
      'catalog/audio-asset-record-v3.json',
      'envelope/valid/demo-0003-media-v3.json',
    ]) {
      const doc = json<{ content: { assets: { kind: string; versions: { sourceDigest: string; sourceByteLength: number; importRecipe: unknown; metrics: unknown }[] }[] } }>(
        join(CONTRACTS, rel),
      );
      const version = doc.content.assets.find((a) => a.kind === 'audio')!.versions[0]!;
      expect(version.sourceDigest, rel).toBe(rec.sourceDigest);
      expect(version.sourceByteLength, rel).toBe(rec.sourceByteLength);
      expect(version.importRecipe, rel).toEqual(proposal.importRecipe);
      expect(version.metrics, rel).toEqual(proposal.metrics);
    }
  });

  it('recomputes every fixtures/m3/media index digest from the bytes', () => {
    const index = json<{ files: Record<string, { bytes: number; sha256: string }> }>(join(MEDIA, 'index.json'));
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else out.push(full);
      }
      return out;
    };
    const files = walk(MEDIA)
      .map((p) => p.slice(MEDIA.length + 1).split('\\').join('/'))
      .filter((f) => !f.startsWith('tools/') && !['index.json', 'README.md', 'verification.md'].includes(f))
      .sort();
    expect(Object.keys(index.files).sort()).toEqual(files);
    for (const rel of files) {
      const buf = readFileSync(join(MEDIA, rel));
      expect(index.files[rel]!.bytes, rel).toBe(buf.length);
      expect(index.files[rel]!.sha256, rel).toBe(sha256(buf));
    }
  });
});

describe('project-model loads the audio record', () => {
  it('accepts the catalog and media envelope', () => {
    const catalog = json<{ content: unknown }>(join(CONTRACTS, 'catalog', 'audio-asset-record-v3.json'));
    expect(validateContentV3(catalog.content).ok).toBe(true);
    const envelope = json<unknown>(join(CONTRACTS, 'envelope', 'valid', 'demo-0003-media-v3.json'));
    expect(validateEnvelopeV3(envelope).ok).toBe(true);
  });

  it('refuses a disagreeing metrics record and the placeholder shape', () => {
    const catalog = json<{ content: { assets: { versions: Record<string, unknown>[] }[] } }>(
      join(CONTRACTS, 'catalog', 'audio-asset-record-v3.json'),
    );
    const mutate = (fn: (v: Record<string, unknown>) => void) => {
      const copy = JSON.parse(JSON.stringify(catalog)) as typeof catalog;
      fn(copy.content.assets[0]!.versions[0]!);
      return validateContentV3(copy.content);
    };
    expect(mutate((v) => void ((v['metrics'] as Record<string, unknown>)['format'] = 'aiff')).ok).toBe(false);
    expect(mutate((v) => void ((v['metrics'] as Record<string, unknown>)['channels'] = 0)).ok).toBe(false);
    expect(mutate((v) => void ((v['metrics'] as Record<string, number>)['nodes'] = 0)).ok).toBe(false);
    const placeholder = mutate((v) => {
      v['importRecipe'] = { profile: 'audio', recipeVersion: 0, toolchain: {}, extensions: [] };
    });
    expect(placeholder.ok).toBe(false);
    if (!placeholder.ok) expect(placeholder.errors.every((e) => e.code === 'recipe_invalid' || e.code === 'field_unexpected')).toBe(true);
    if (!placeholder.ok) expect(placeholder.errors.some((e) => e.code === 'recipe_invalid')).toBe(true);
  });
});

describe('the pinned inspector version agrees across the two packages', () => {
  it('uses the repository package version as the only audio toolchain entry', () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages', 'asset-pipeline', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(AUDIO_PIPELINE_VERSION).toBe(pkg.version);
    expect(MODEL_AUDIO_PIPELINE_VERSION).toBe(pkg.version);
    expect(AUDIO_TOOLCHAIN).toEqual({ 'asset-pipeline': pkg.version });
  });
});

describe('no network and no filesystem in the pure inspector', () => {
  it('inspects every committed WAV and GLB with fetch/XHR/WebSocket stubbed to throw', () => {
    const fetchStub = () => {
      throw new Error('network access attempted by the inspector');
    };
    const globals = globalThis as unknown as Record<string, unknown>;
    const saved = { fetch: globals['fetch'], XMLHttpRequest: globals['XMLHttpRequest'], WebSocket: globals['WebSocket'] };
    globals['fetch'] = fetchStub;
    globals['XMLHttpRequest'] = fetchStub;
    globals['WebSocket'] = fetchStub;
    try {
      for (const c of [...wavCases.positives, ...wavCases.rejections]) {
        const proposal: AudioImportProposal = inspectAudio(bytesOf(c.file!), AUDIO_OPTIONS);
        expect(['ok', 'rejected']).toContain(proposal.status);
      }
      for (const c of profileCases.cases) {
        const stage12 = new Set(['field_missing', 'field_unexpected', 'field_type', 'field_value']);
        if (c.expect.code !== undefined && stage12.has(c.expect.code)) continue;
        const proposal = inspectGlb(bytesOf(`glb/${c.file}`), { ...GLTF_OPTIONS, animation: { roles: c.roles } });
        expect(['ok', 'rejected']).toContain(proposal.status);
      }
      expect(globals['fetch']).toBe(fetchStub);
    } finally {
      globals['fetch'] = saved.fetch;
      globals['XMLHttpRequest'] = saved.XMLHttpRequest;
      globals['WebSocket'] = saved.WebSocket;
    }
  });

  it('has no Node built-in, three.js or dynamic target in the package sources', () => {
    const srcDir = join(REPO_ROOT, 'packages', 'asset-pipeline', 'src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) files.push(full);
      }
    };
    walk(srcDir);
    expect(files.length).toBeGreaterThanOrEqual(8);
    const bad: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const spec = m[1]!;
        if (spec.startsWith('node:')) bad.push(`${file}: node builtin ${spec}`);
        if (spec === 'three' || spec.startsWith('three/')) bad.push(`${file}: three ${spec}`);
        if (spec === 'fs' || spec === 'http' || spec === 'crypto') bad.push(`${file}: builtin ${spec}`);
      }
      if (/\brequire\s*\(/.test(text)) bad.push(`${file}: require()`);
    }
    expect(bad).toEqual([]);
  });
});
