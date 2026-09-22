/**
 * Packet 47 — committed media fixtures through the real `@thirdlight/asset-pipeline`.
 *
 * The committed `.wav`/`.glb` bytes and the committed case files are the
 * evidence; this suite drives the real `inspectAudio` / role-aware `inspectGlb`
 * over those bytes, re-derives every digest with `node:crypto` independently,
 * checks the regenerated `fixtures/m3/contracts` audio record through the real
 * `@thirdlight/project-model` loader, and runs the fixture checker together with
 * its deliberate-corruption control as real child processes.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  AUDIO_PCM_WAV_MAX_PCM_BYTES,
  AUDIO_PCM_WAV_MAX_SOURCE_FILE_BYTES,
  AUDIO_PCM_WAV_TOOLCHAIN,
  AUDIO_PIPELINE_VERSION,
  AUDIO_REPORTED_LIMITS,
  importMetadataDigest,
  importRecipeDigest,
  inspectAudio,
  inspectGlb,
  type AudioImportOptions,
  type AudioImportProposal,
  type PcmWavMetrics,
  type ImportJobPort,
  type ImportOptions,
  type ImportProposal,
} from '@thirdlight/asset-pipeline';
import { AUDIO_PCM_WAV_PROFILE, validateContentV3, validateEnvelopeV3 } from '@thirdlight/project-model';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MEDIA = join(REPO_ROOT, 'fixtures', 'm3', 'media');
const CONTRACTS = join(REPO_ROOT, 'fixtures', 'm3', 'contracts');

const bytesOf = (rel: string): Buffer => readFileSync(join(MEDIA, rel));
const sha256 = (buf: Uint8Array): string => createHash('sha256').update(buf).digest('hex');
const json = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;

/** commands.md §6.6 rule 2 canonical JSON (independent of the package's copy). */
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
  profile: 'pcm-wav',
  recipeVersion: 1,
  toolchain: AUDIO_PCM_WAV_TOOLCHAIN,
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
    readonly metrics: PcmWavMetrics;
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

/** The §41.4.2 arithmetic, re-derived here (never read from the proposal). */
function deriveMetrics(bytes: Buffer): PcmWavMetrics {
  const dataBytes = bytes.readUInt32LE(40);
  const frames = dataBytes / 2;
  return {
    container: 'riff-wave',
    encoding: 'pcm-s16le',
    channels: 1,
    sampleRate: 48_000,
    bitsPerSample: 16,
    frames,
    durationMs: Math.floor(frames / 48),
    pcmBytes: dataBytes,
    dataChunkBytes: dataBytes,
    riffChunkBytes: 36 + dataBytes,
  };
}

describe('packet 47 — committed media fixture checker', () => {
  it('passes, and its corruption control detects every corruption', () => {
    const checker = join(MEDIA, 'tools', 'check-fixtures.mjs');
    const ok = spawnSync(process.execPath, [checker], { encoding: 'utf8' });
    expect(ok.status, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout).toContain('all checks passed');
    const control = spawnSync(process.execPath, [checker, '--corrupt-control'], { encoding: 'utf8' });
    expect(control.status, control.stdout + control.stderr).toBe(0);
    // Packet 53 added the `roles-case-expectation` corruption (the new
    // real-roles fixture group) to the media control: 9 → 10.
    expect(control.stdout).toContain('10/10 detected');
    const gen = spawnSync(process.execPath, [join(MEDIA, 'tools', 'generate-fixtures.mjs'), '--check'], { encoding: 'utf8' });
    expect(gen.status, gen.stdout + gen.stderr).toBe(0);
    expect(gen.stdout).toContain('reproduce exactly');
  });
});

describe('packet 47 — inspectAudio over the committed WAV bytes (§41.4.4)', () => {
  it('accepts every committed positive with the exact §41.4.2 metrics', () => {
    expect(wavCases.positives.length).toBeGreaterThanOrEqual(8);
    for (const c of wavCases.positives) {
      const bytes = bytesOf(c.file);
      const proposal = inspectAudio(bytes, AUDIO_OPTIONS);
      expect(proposal.status, c.file).toBe('ok');
      expect(proposal.kind).toBe('audio');
      const derived = deriveMetrics(bytes);
      expect(proposal.metrics, c.file).toEqual(derived);
      expect(proposal.sourceByteLength).toBe(bytes.length);
      expect(proposal.sourceDigest).toBe(sha256(bytes));
      expect(bytes.length).toBe(44 + derived.pcmBytes);
      if (c.frames !== undefined) expect(derived.frames).toBe(c.frames);
      // The recipe has exactly the three accepted keys (no `extensions`).
      expect(Object.keys(proposal.importRecipe).sort()).toEqual(['profile', 'recipeVersion', 'toolchain']);
      expect(proposal.importRecipe.toolchain).toEqual({ 'asset-pipeline': '0.1.0' });
      expect(proposal.importRecipe.profile).toBe('pcm-wav');
      expect(proposal.importRecipe.recipeVersion).toBe(1);
      // The proposal is immutable and carries a bounded summary with no samples.
      expect(Object.isFrozen(proposal)).toBe(true);
      expect(Object.isFrozen(proposal.metrics)).toBe(true);
      expect(proposal.inspection.chunkIds).toEqual(['fmt ', 'data']);
    }
  });

  it('exercises the stage-1/stage-11 byte boundaries with real bytes', () => {
    expect(AUDIO_REPORTED_LIMITS).toEqual(['audio_pcm_bytes']);
    const min = inspectAudio(bytesOf('wav/cue-min.wav'), AUDIO_OPTIONS);
    expect(min.status).toBe('ok');
    expect(min.metrics?.frames).toBe(1);
    expect(min.metrics?.durationMs).toBe(0);
    expect(min.metrics?.pcmBytes).toBe(2);

    const max = inspectAudio(bytesOf('wav/cue-max.wav'), AUDIO_OPTIONS);
    expect(max.status).toBe('ok');
    expect(max.metrics?.frames).toBe(96_000);
    expect(max.metrics?.pcmBytes).toBe(AUDIO_PCM_WAV_MAX_PCM_BYTES);
    expect(max.metrics?.durationMs).toBe(2_000);
    expect(max.sourceByteLength).toBe(192_044);

    // Exactly the 196 608-byte source-file bound passes stage 1 and is refused
    // by the PCM cap; one more byte fails stage 1 itself.
    const atBound = bytesOf('wav/rejections/source-at-bound.wav');
    expect(atBound.length).toBe(AUDIO_PCM_WAV_MAX_SOURCE_FILE_BYTES);
    const atBoundProposal = inspectAudio(atBound, AUDIO_OPTIONS);
    expect(atBoundProposal.status).toBe('rejected');
    expect(atBoundProposal.diagnostics.map((d) => d.code)).toEqual(['asset_limits_exceeded']);
    expect(atBoundProposal.diagnostics[0]?.limit).toBe('audio_pcm_bytes');

    const overBound = inspectAudio(bytesOf('wav/rejections/source-over-bound.wav'), AUDIO_OPTIONS);
    expect(overBound.status).toBe('rejected');
    expect(overBound.diagnostics.map((d) => d.code)).toEqual(['audio_source_bytes_exceeded']);
  });

  it('rejects every committed negative at its contracted stage (fail-fast, code + limit)', () => {
    expect(wavCases.rejections.length).toBeGreaterThanOrEqual(30);
    for (const c of wavCases.rejections) {
      const proposal = inspectAudio(bytesOf(c.file!), AUDIO_OPTIONS);
      expect(proposal.status, c.file).toBe('rejected');
      expect(proposal.diagnostics.length, c.file).toBe(1);
      expect(proposal.diagnostics[0]?.code, c.file).toBe(c.code);
      if (c.limit !== undefined) expect(proposal.diagnostics[0]?.limit, c.file).toBe(c.limit);
      expect(proposal.metrics).toBeUndefined();
      expect(proposal.kind).toBeUndefined();
    }
  });

  it('never accepts a non-WAV, data: or URL form (the bytes alone decide)', () => {
    for (const file of [
      'wav/rejections/non-wav.bin',
      'wav/rejections/data-url.txt',
      'wav/rejections/remote-url.txt',
      'wav/rejections/compressed.bin',
    ]) {
      const proposal = inspectAudio(bytesOf(file), AUDIO_OPTIONS);
      expect(proposal.status, file).toBe('rejected');
      expect(proposal.diagnostics[0]?.code).toBe('audio_container_invalid');
    }
  });

  it('is deterministic and total over hostile bytes', () => {
    const a = inspectAudio(bytesOf('wav/cue-start.wav'), AUDIO_OPTIONS);
    const b = inspectAudio(bytesOf('wav/cue-start.wav'), AUDIO_OPTIONS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // A caller MIME type / declared kind is not an input: only bytes and options.
    expect(inspectAudio(new Uint8Array(44), AUDIO_OPTIONS).status).toBe('rejected');
    expect(inspectAudio(new Uint8Array(0), AUDIO_OPTIONS).diagnostics[0]?.code).toBe('audio_source_bytes_exceeded');
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

describe('packet 47 — cancellation through the accepted job port', () => {
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

describe('packet 47 — role-aware GLB proposal (§41.3.2/§41.3.3)', () => {
  it('reproduces every committed profile case through the real pipeline', () => {
    expect(profileCases.cases.length).toBeGreaterThanOrEqual(20);
    // §41.3.2 stages 1–2 (binding container/fields) are model-owned, so the
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

describe('packet 47 — recipe and metadata digests over supplied records', () => {
  it('matches SHA-256(canonical JSON of the recipe) independently', () => {
    const recipe = wavCases.recipe;
    expect(importRecipeDigest(recipe as never)).toBe(canonicalDigest(recipe));
    expect(importRecipeDigest(recipe as never)).toBe(wavCases.audioRecord.recipeDigest);
    const proposal = inspectAudio(bytesOf('wav/cue-preimage.wav'), AUDIO_OPTIONS);
    expect(proposal.status).toBe('ok');
    expect(importRecipeDigest(proposal.importRecipe)).toBe(wavCases.audioRecord.recipeDigest);
    const metadataDigest = canonicalDigest({
      status: proposal.status,
      kind: proposal.kind,
      sourceDigest: proposal.sourceDigest,
      sourceByteLength: proposal.sourceByteLength,
      importRecipe: proposal.importRecipe,
      metrics: proposal.metrics,
    });
    expect(importMetadataDigest(proposal)).toBe(metadataDigest);
    expect(metadataDigest).toBe(wavCases.audioRecord.metadataDigest);
    expect(proposal.metrics).toEqual(wavCases.audioRecord.metrics);
    expect(proposal.sourceDigest).toBe(wavCases.audioRecord.sourceDigest);
  });

  it('agrees with the regenerated fixtures/m3/contracts audio record (CC-44-2)', () => {
    const rec = wavCases.audioRecord;
    const preimage = readFileSync(join(CONTRACTS, rec.contractsPreimage));
    expect(preimage.equals(bytesOf(rec.preimage))).toBe(true);
    for (const rel of [
      'catalog/audio-asset-record-v3.json',
      'envelope/valid/demo-0003-media-v3.json',
      'envelope/invalid/cue-kind-mismatch.json',
    ]) {
      const doc = json<{ content: { assets: { kind: string; versions: { sourceDigest: string; sourceByteLength: number; importRecipe: unknown; metrics: unknown }[] }[] } }>(
        join(CONTRACTS, rel),
      );
      const version = doc.content.assets.find((a) => a.kind === 'audio')!.versions[0]!;
      expect(version.sourceDigest, rel).toBe(rec.sourceDigest);
      expect(version.sourceByteLength, rel).toBe(rec.sourceByteLength);
      expect(version.importRecipe, rel).toEqual(rec.recipe);
      expect(version.metrics, rel).toEqual(rec.metrics);
      // The recipe digest of the committed record is the canonical-JSON digest.
      expect(importRecipeDigest(version.importRecipe as never), rel).toBe(rec.recipeDigest);
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

describe('packet 47 — project-model loads the promoted pcm-wav record (CC-44-2)', () => {
  it('accepts the regenerated catalog and media envelope', () => {
    const catalog = json<{ content: unknown }>(join(CONTRACTS, 'catalog', 'audio-asset-record-v3.json'));
    expect(validateContentV3(catalog.content).ok).toBe(true);
    const envelope = json<unknown>(join(CONTRACTS, 'envelope', 'valid', 'demo-0003-media-v3.json'));
    expect(validateEnvelopeV3(envelope).ok).toBe(true);
  });

  it('refuses a disagreeing metrics record and the packet-41 placeholder shape', () => {
    const catalog = json<{ content: { assets: { versions: Record<string, unknown>[] }[] } }>(
      join(CONTRACTS, 'catalog', 'audio-asset-record-v3.json'),
    );
    const mutate = (fn: (v: Record<string, unknown>) => void) => {
      const copy = JSON.parse(JSON.stringify(catalog)) as typeof catalog;
      fn(copy.content.assets[0]!.versions[0]!);
      return validateContentV3(copy.content);
    };
    // §41.4.3: sourceByteLength === 44 + pcmBytes, every cap, exact keys.
    const arithmetic = mutate((v) => {
      v['sourceByteLength'] = 237;
    });
    expect(arithmetic.ok).toBe(false);
    if (!arithmetic.ok) expect(arithmetic.errors.some((e) => e.code === 'field_value')).toBe(true);

    const capped = mutate((v) => {
      const m = v['metrics'] as Record<string, number>;
      m['pcmBytes'] = 192_002;
      v['sourceByteLength'] = 44 + 192_002;
    });
    expect(capped.ok).toBe(false);
    if (!capped.ok) expect(capped.errors.some((e) => e.code === 'limits_exceeded' && e.limit === 'audio_pcm_bytes')).toBe(true);

    const extraKey = mutate((v) => {
      (v['metrics'] as Record<string, number>)['nodes'] = 0;
    });
    expect(extraKey.ok).toBe(false);

    const placeholder = mutate((v) => {
      v['importRecipe'] = { profile: 'pcm-wav', recipeVersion: 0, toolchain: {}, extensions: [] };
    });
    expect(placeholder.ok).toBe(false);
    if (!placeholder.ok) expect(placeholder.errors.every((e) => e.code === 'recipe_invalid' || e.code === 'field_unexpected')).toBe(true);
    if (!placeholder.ok) expect(placeholder.errors.some((e) => e.code === 'recipe_invalid')).toBe(true);
  });
});

describe('packet 47 — the pinned profile constants agree across the two packages', () => {
  it('uses the repository package version as the only pcm-wav toolchain entry', () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages', 'asset-pipeline', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(AUDIO_PIPELINE_VERSION).toBe(pkg.version);
    // project-model keeps its own copy (no asset-pipeline dependency); the
    // numbers must be identical or the promoted rules would disagree.
    expect(AUDIO_PCM_WAV_PROFILE.audioPipelineVersion).toBe(pkg.version);
    expect(AUDIO_PCM_WAV_PROFILE.maxPcmBytes).toBe(AUDIO_PCM_WAV_MAX_PCM_BYTES);
    expect(AUDIO_PCM_WAV_PROFILE.maxSourceFileBytes).toBe(AUDIO_PCM_WAV_MAX_SOURCE_FILE_BYTES);
    expect(AUDIO_PCM_WAV_PROFILE.maxSourceBytes).toBe(44 + AUDIO_PCM_WAV_MAX_PCM_BYTES);
    expect(AUDIO_PCM_WAV_PROFILE.maxFrames).toBe(AUDIO_PCM_WAV_MAX_PCM_BYTES / 2);
    expect(AUDIO_PCM_WAV_PROFILE.maxDurationMs).toBe(Math.floor((AUDIO_PCM_WAV_MAX_PCM_BYTES / 2) / 48));
  });
});

describe('packet 47 — no network and no filesystem in the pure inspector', () => {
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
