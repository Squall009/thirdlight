/**
 * Phase 9.7: skinned model caps — at most 4 skins per file, 128 joints per
 * skin and 32 morph targets per primitive (more than 4 influences cannot
 * be expressed: only JOINTS_0/WEIGHTS_0 are allowed attributes).
 */
import { describe, expect, it } from 'vitest';

import { inspectGlb, type ImportProposal } from './index';
import { buildGlb, cloneJson, splitGlb } from './test-glb';
import { fixtureBytes } from './test-fixtures';

const base = splitGlb(fixtureBytes('tiny-v1.glb'));

function inspect(edit: (json: Record<string, unknown>) => void): ImportProposal {
  const json = cloneJson(base.json) as Record<string, unknown>;
  edit(json);
  return inspectGlb(buildGlb(json, base.bin), { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' } });
}

/** `count` extra joint nodes and `skins` skins, each over `joints` of them. */
function withSkins(json: Record<string, unknown>, skins: number, joints: number): void {
  const nodes = json['nodes'] as unknown[];
  const first = nodes.length;
  for (let i = 0; i < joints; i++) nodes.push({ name: `j${i}` });
  json['skins'] = Array.from({ length: skins }, () => ({ joints: Array.from({ length: joints }, (_, i) => first + i) }));
}

function withTargets(json: Record<string, unknown>, targets: number): void {
  const prim = ((json['meshes'] as { primitives: Record<string, unknown>[] }[])[0]!).primitives[0]!;
  const position = (prim['attributes'] as Record<string, number>)['POSITION']!;
  prim['targets'] = Array.from({ length: targets }, () => ({ POSITION: position }));
}

const limitOf = (p: ImportProposal): string | undefined => (p.diagnostics[0] as { limit?: string } | undefined)?.limit;

describe('skinned model caps', () => {
  it('accepts 4 skins of 128 joints and 32 morph targets', () => {
    const p = inspect((j) => {
      withSkins(j, 4, 128);
      withTargets(j, 32);
    });
    expect(p.status, JSON.stringify(p).slice(0, 400)).toBe('ok');
  });

  it('refuses a fifth skin, a skin of 129 joints and 33 morph targets', () => {
    expect(limitOf(inspect((j) => withSkins(j, 5, 2)))).toBe('skins');
    expect(limitOf(inspect((j) => withSkins(j, 1, 129)))).toBe('skin_joints');
    expect(limitOf(inspect((j) => withTargets(j, 33)))).toBe('morph_targets');
  });
});
