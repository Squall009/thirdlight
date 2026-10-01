/**
 * `paintInstances` in the command layer: the args are checked for their
 * shape, the planner makes the copies from the set's buffer in the set's
 * space, the op stores only what the host prepared as one change (one undo
 * back to the old buffer), and the largest stroke the editor sends fits one
 * command request.
 */
import { describe, expect, it } from 'vitest';
import { INSTANCE_BRUSH_DEFAULTS, INSTANCE_BRUSH_LIMITS, INSTANCE_FLOATS, type SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState, MAX_REQUEST_BYTES, planInstanceStroke, type PaintInstancesArgs } from './index';
import type { CommandState } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
const modelId = (BEFORE.content.assets as unknown as { assetId: string; kind: string }[]).find((a) => a.kind === 'model')!.assetId;

function state(position: [number, number, number] = [0, 0, 0]): CommandState<SceneV4> {
  const set = { id: 'group-0901', name: 'Grove', components: { transform: { position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, instances: { asset: { assetId: modelId }, buffer: OLD, count: 1 } } };
  return createCommandState({ ...BEFORE.scene, entities: [...BEFORE.scene.entities, set] } as SceneV4, BEFORE.content);
}

let seq = 0;
function request(args: Record<string, unknown>, revision: number): Record<string, unknown> {
  seq += 1;
  return { op: 'paintInstances', projectId: BEFORE.projectId, expectedRevision: revision, requestId: `req-${String(0x7a00 + seq).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'test' }, args };
}
const stroke = (over: Partial<PaintInstancesArgs> = {}): PaintInstancesArgs => ({ entityId: 'group-0901', mode: 'paint', dabs: [[10, 0, 0]], brush: { ...INSTANCE_BRUSH_DEFAULTS }, ...over });
const oneCopy = new Uint8Array(new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]).buffer);
const read = () => ({ ok: true as const, bytes: oneCopy });
const flatSurface = (args: PaintInstancesArgs, y: number) => {
  // Every candidate on a flat ground at y (the editor's surface): planned without the scene's block layers.
  const probe = planInstanceStroke(state().scene, BEFORE.content, { ...args, surface: [] }, read);
  const count = !probe.ok && /has 0 entries; the stroke has (\d+)/.exec(probe.error.message)?.[1];
  return Array.from({ length: Number(count) }, () => [y, 0, 0] as [number, number, number]);
};

describe('paintInstances', () => {
  it('checks the stroke for its shape', () => {
    const s = state();
    for (const bad of [{ ...stroke(), mode: 'smear' }, { ...stroke(), dabs: [] }, { ...stroke(), brush: { ...INSTANCE_BRUSH_DEFAULTS, density: 0 } }, { ...stroke(), entityId: 7 }, { ...stroke(), extra: true }]) {
      const r = applyMutation(s, request(bad as Record<string, unknown>, s.scene.revision));
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('refuses a stroke the host did not prepare', () => {
    const s = state();
    const r = applyMutation(s, request(stroke() as unknown as Record<string, unknown>, s.scene.revision));
    expect(r.ok).toBe(false);
  });

  it('plans copies in the set\'s own space: a set moved to x = 10 gets copies around its origin', () => {
    const args = stroke({ surface: undefined });
    const surface = flatSurface(args, 2);
    expect(surface.length).toBeGreaterThan(3);
    const plan = planInstanceStroke(state([10, 0, 0]).scene, BEFORE.content, { ...args, surface }, read);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.added).toBeGreaterThan(0);
    for (let i = 1; i < plan.floats.length / INSTANCE_FLOATS; i++) {
      const [x, y, z] = [plan.floats[i * INSTANCE_FLOATS]!, plan.floats[i * INSTANCE_FLOATS + 1]!, plan.floats[i * INSTANCE_FLOATS + 2]!];
      expect(Math.hypot(x, z)).toBeLessThanOrEqual(INSTANCE_BRUSH_DEFAULTS.radius + 1e-5);
      expect(y).toBeCloseTo(2, 5);
    }
    // No surface and no block layer under it: nothing to paint on.
    const none = planInstanceStroke(state().scene, BEFORE.content, args, read);
    expect(none.ok === false && none.error.code).toBe('no_change');
    // Not an instance set.
    const other = planInstanceStroke(state().scene, BEFORE.content, { ...args, entityId: BEFORE.scene.entities[0]!.id }, read);
    expect(other.ok).toBe(false);
  });

  it('stores the prepared buffer in one change; undo points back to the old one', () => {
    const s = state();
    s.preparedInstanceStroke = { entityId: 'group-0901', buffer: NEW, count: 7 };
    const r = applyMutation(s, request(stroke() as unknown as Record<string, unknown>, s.scene.revision));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.change.type).toBe('setComponent');
    const inst = () => (r.state.scene.entities.find((e) => e.id === 'group-0901')!.components as { instances: { buffer: string; count: number } }).instances;
    expect(inst()).toMatchObject({ buffer: NEW, count: 7, asset: { assetId: modelId } });
    const u = applyMutation(r.state, { ...request({}, r.state.scene.revision), op: 'undo' });
    expect(u.ok).toBe(true);
    if (u.ok) expect((u.state.scene.entities.find((e) => e.id === 'group-0901')!.components as { instances: { buffer: string; count: number } }).instances).toMatchObject({ buffer: OLD, count: 1 });
  });

  it('the largest stroke the editor sends (every dab, every candidate, millimetre numbers far out) fits one request', () => {
    const far = -99_999.999;
    const args = {
      entityId: 'group-0901',
      mode: 'paint',
      dabs: Array.from({ length: INSTANCE_BRUSH_LIMITS.dabs }, () => [far, far, far]),
      brush: { radius: 12.345, density: 0.123, spacing: 0.123, scale: [0.123, 12.345], yaw: 123.456, align: 0.123, seed: 2_147_483_647 },
      surface: Array.from({ length: INSTANCE_BRUSH_LIMITS.samples }, () => [far, -0.123, -0.456]),
    };
    const req = request(args, 1);
    const bytes = new TextEncoder().encode(JSON.stringify(req)).byteLength;
    expect(bytes).toBeLessThan(MAX_REQUEST_BYTES);
    const s = state();
    s.preparedInstanceStroke = { entityId: 'group-0901', buffer: NEW, count: 2 };
    const r = applyMutation(s, { ...req, expectedRevision: s.scene.revision });
    expect(r.ok === false ? r.result : null, 'not refused for its size').toBeNull();
  });
});
