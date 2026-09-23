/**
 * Packet-24 acceptance: the committed GLB fixture index.
 *
 * Every entry of `fixtures/m2/assets/expected.json` is re-derived here from the
 * exact committed bytes (base64 sidecar → bytes; the digest of the committed
 * `.glb` is re-checked), with a fixed injected job port, and compared field by
 * field against the index: status, ordered diagnostics (code/path/limit), the
 * §18.6 metrics of an accepted model, the §18.5 recipe digest and the packet-24
 * metadata digest. This is acceptance rows A02/A04's "import recipe/source
 * hashes" and "adversarial fixture outputs" evidence at the unit level.
 */

import { describe, expect, it } from 'vitest';

import {
  importMetadataDigest,
  importRecipeDigest,
  inspectGlb,
  M2_GLTF_EXTENSION_ALLOWLIST,
  M2_GLTF_PROFILE_LIMITS,
  M2_GLTF_SOURCE_BYTES,
  type ImportJobPort,
  type ImportProposal,
} from './index';

function proposalSourceBytes(): number {
  return M2_GLTF_SOURCE_BYTES;
}
import { sha256Hex } from './sha256';
import { expectedIndex, fixtureBytes } from './test-fixtures';

const index = expectedIndex();

/** The fixed job port the fixture index was recorded with. */
const job: ImportJobPort = {
  now: () => 0,
  isCancelled: () => false,
  proposalId: () => index.job.proposalId,
  stageId: () => index.job.stageId,
  expiresAt: () => index.job.expiresAt,
  suggestedDisplayName: index.job.suggestedDisplayName,
};

const options = {
  profile: 'gltf-glb',
  recipeVersion: 1,
  toolchain: { three: '0.186.0' },
  job,
} as const;

function inspect(file: string): ImportProposal {
  return inspectGlb(fixtureBytes(file), options);
}

describe('fixture index', () => {
  it('indexes every committed fixture and nothing else', () => {
    expect(index.indexVersion).toBe(1);
    expect(index.entries.length).toBeGreaterThanOrEqual(15);
    const files = index.entries.map((e) => e.file);
    expect([...files].sort()).toEqual(files);
    expect(files).toContain('tiny-v1.glb');
    expect(files).toContain('tiny-v2.glb');
  });

  for (const entry of index.entries) {
    it(`${entry.file} — ${entry.purpose}`, () => {
      const bytes = fixtureBytes(entry.file);
      expect(bytes.length).toBe(entry.byteLength);
      expect(sha256Hex(bytes)).toBe(entry.sha256);

      const proposal = inspect(entry.file);
      expect(proposal.status).toBe(entry.status);
      expect(proposal.sourceDigest).toBe(entry.sha256);
      expect(proposal.sourceByteLength).toBe(entry.byteLength);
      expect(proposal.diagnostics.map((d) => d.code)).toEqual(entry.codes);
      expect(proposal.diagnostics.map((d) => d.path)).toEqual(entry.paths);
      expect(proposal.diagnostics.map((d) => d.limit ?? null)).toEqual(entry.limits);
      expect(proposal.diagnosticCount).toBe(entry.codes.length);
      expect(proposal.diagnostics.length).toBeLessThanOrEqual(10);
      expect(proposal.metrics ?? null).toEqual(entry.metrics ?? null);
      expect(importRecipeDigest(proposal.importRecipe)).toBe(entry.recipeDigest);
      expect(importMetadataDigest(proposal)).toBe(entry.metadataDigest);

      // §8: `kind`/`metrics` are present exactly when the proposal is accepted.
      expect(proposal.kind).toBe(entry.status === 'ok' ? 'model' : undefined);
      expect(proposal.metrics === undefined).toBe(entry.status !== 'ok');

      // §18.5: the recipe is fixed apart from the source's used extensions.
      expect(proposal.importRecipe.profile).toBe('gltf-glb');
      expect(proposal.importRecipe.recipeVersion).toBe(1);
      expect(proposal.importRecipe.toolchain).toEqual({ three: '0.186.0' });
      expect(proposal.importRecipe.extensions).toEqual([]);

      // §8 job identity and the applied caps come from the injected job port.
      expect(proposal.proposalId).toBe(index.job.proposalId);
      expect(proposal.stageId).toBe(index.job.stageId);
      expect(proposal.expiresAt).toBe(index.job.expiresAt);
      expect(proposal.suggestedDisplayName).toBe(index.job.suggestedDisplayName);
      expect(proposal.limits.profile).toBe('gltf-glb');
      expect(proposal.limits.recipeVersion).toBe(1);
      expect(proposal.limits.caps).toEqual(M2_GLTF_PROFILE_LIMITS);
      expect(proposal.limits.timeoutMs).toBe(30_000);

      // Immutable, validated data only (§18.8.3 + packet instruction).
      expect(Object.isFrozen(proposal)).toBe(true);
      expect(Object.isFrozen(proposal.importRecipe)).toBe(true);
      expect(Object.isFrozen(proposal.importRecipe.toolchain)).toBe(true);
      expect(Object.isFrozen(proposal.limits)).toBe(true);
      expect(Object.isFrozen(proposal.limits.caps)).toBe(true);
      expect(Object.isFrozen(proposal.inspection)).toBe(true);
      expect(Object.isFrozen(proposal.diagnostics)).toBe(true);

      // The proposal never carries authoring identity or a placed reference
      // (§18.1: whole-model references only — the importer decides no asset ID).
      expect('assetId' in proposal).toBe(false);
      expect(Object.keys(proposal)).not.toContain('source');
      expect(Object.keys(proposal)).not.toContain('uri');
    });
  }

  it('accepted metrics satisfy every decoded-resource cap', () => {
    for (const entry of index.entries) {
      if (entry.status !== 'ok') continue;
      const metrics = entry.metrics as Record<string, number>;
      expect(metrics['nodes']).toBeLessThanOrEqual(4_096);
      expect(metrics['meshes']).toBeLessThanOrEqual(1_024);
      expect(metrics['vertices']).toBeLessThanOrEqual(2_000_000);
      expect(metrics['triangles']).toBeLessThanOrEqual(4_000_000);
      expect(metrics['clipDurationMs']).toBeLessThanOrEqual(600_000);
      expect(
        (metrics['decodedGeometryBytes'] as number) + (metrics['decodedImageBytes'] as number),
      ).toBeLessThanOrEqual(536_870_912);
      for (const value of Object.values(metrics)) {
        expect(Number.isSafeInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('the proposal metrics/recipe shapes match the accepted model shape lists', () => {
    const metricKeys = [
      'animationChannels',
      'animations',
      'clipDurationMs',
      'decodedGeometryBytes',
      'decodedImageBytes',
      'images',
      'materials',
      'meshes',
      'nodes',
      'primitives',
      'textures',
      'triangles',
      'vertices',
    ];
    const recipeKeys = ['extensions', 'profile', 'recipeVersion', 'toolchain'];
    for (const entry of index.entries) {
      if (entry.status !== 'ok') continue;
      expect(Object.keys(entry.metrics ?? {}).sort()).toEqual(metricKeys);
    }
    const proposal = inspect('tiny-v1.glb');
    expect(Object.keys(proposal.importRecipe).sort()).toEqual(recipeKeys);
    expect(Object.keys(proposal.limits).sort()).toEqual([
      'caps',
      'imageBytes',
      'jsonChunkBytes',
      'profile',
      'recipeVersion',
      'sourceBytes',
      'timeoutMs',
    ]);
  });

  it('the exported profile limits are exactly the contract values (§18.6/§18.7.2)', () => {
    expect(M2_GLTF_PROFILE_LIMITS).toEqual({
      source_bytes: 33_554_432,
      json_chunk_bytes: 8_388_608,
      image_bytes: 33_554_432,
      nodes: 4_096,
      meshes: 1_024,
      primitives: 8_192,
      materials: 512,
      images: 64,
      textures: 512,
      vertices: 2_000_000,
      triangles: 4_000_000,
      animations: 64,
      animation_channels: 4_096,
      clip_duration: 600_000,
      decoded_bytes: 268_435_456,
      total_decoded_bytes: 536_870_912,
      diagnostics: 10,
    });
    expect(proposalSourceBytes()).toBe(33_554_432);
  });

  it('the effective extension allowlist is the pinned no-decoder set and frozen (§18.8.1)', () => {
    expect([...M2_GLTF_EXTENSION_ALLOWLIST]).toEqual(['EXT_texture_webp',  'KHR_materials_clearcoat',  'KHR_materials_emissive_strength',  'KHR_materials_ior',  'KHR_materials_sheen',  'KHR_materials_specular',  'KHR_materials_transmission',  'KHR_materials_unlit',  'KHR_materials_volume',  'KHR_mesh_quantization',  'KHR_texture_transform']);
    expect(Object.isFrozen(M2_GLTF_EXTENSION_ALLOWLIST)).toBe(true);
    // Every committed fixture declares no used extension, so every recipe's
    // extension list is empty.
    for (const entry of index.entries) {
      expect(entry.recipeDigest).toBe(index.entries[0]?.recipeDigest);
    }
  });
});

describe('reimport of the same whole model (acceptance A02/A03 identity)', () => {
  it('keeps the recipe and changes only the source facts when the file is re-exported', () => {
    const v1 = inspect('tiny-v1.glb');
    const v2 = inspect('tiny-v2.glb');
    expect(v1.status).toBe('ok');
    expect(v2.status).toBe('ok');
    expect(v1.sourceDigest).not.toBe(v2.sourceDigest);
    expect(importRecipeDigest(v1.importRecipe)).toBe(importRecipeDigest(v2.importRecipe));
    expect(importMetadataDigest(v1)).not.toBe(importMetadataDigest(v2));
    expect(v1.metrics?.vertices).toBe(3);
    expect(v2.metrics?.vertices).toBe(4);

    // Internal glTF names/indices are *display only* — never part of the
    // recipe, the metrics or the proposal identity (§18.1 rule 3).
    expect(v1.inspection.nodeNames).toEqual(['Root', 'Tri']);
    expect(v2.inspection.nodeNames).toEqual(['Tri', 'Root']);
    expect(v1.inspection.materialNames).toEqual(['MatA', 'MatB']);
    expect(v2.inspection.materialNames).toEqual(['MatB', 'MatA']);
    expect(JSON.stringify(v1.importRecipe)).toBe(JSON.stringify(v2.importRecipe));
    expect(JSON.stringify(v1.metrics)).not.toContain('Tri');
    expect(JSON.stringify(v1.limits)).not.toContain('Tri');
  });
});
