/**
 * The zone gesture's placement planning (packet 56; phase 24.5 removed the
 * platformer authoring layer's settings list, game-config form, validation
 * and cue slots, and their tests). The backend remains the sole authority.
 */
import { describe, it, expect } from 'vitest';
import { planCreateZone, DEFAULT_ZONE_SIZE, MIN_ZONE_SPAN_UI, type ZoneRole } from './gameplay';

describe('planCreateZone — the createEntity args with components.gameZone', () => {
  it('creates a root group with a unit-scale identity transform (zone_transform_unsupported cannot trigger)', () => {
    const res = planCreateZone({ role: 'hazard', size: [2, 1], position: [1, 2, 0] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.args).toEqual({
      kind: 'group',
      name: 'zone-hazard',
      transform: { position: [1, 2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      components: { gameZone: { role: 'hazard', size: [2, 1] } },
    });
  });

  it('a checkpoint requires the safeSpawnId in the same value and carries the default activation', () => {
    expect(planCreateZone({ role: 'checkpoint', size: [1.5, 1.5], position: [0, 0, 0] }).ok).toBe(false);
    const res = planCreateZone({ role: 'checkpoint', size: [1.5, 1.5], position: [0, 0, 0], safeSpawnId: 'spawn-0001' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.args.components.gameZone).toEqual({
      role: 'checkpoint',
      size: [1.5, 1.5],
      safeSpawnId: 'spawn-0001',
      activation: { emissive: '#ffffff', emissiveIntensity: 1, cueAssetId: null },
    });
  });

  it('rejects sizes outside (0, 1e6]', () => {
    expect(planCreateZone({ role: 'goal', size: [0, 2], position: [0, 0, 0] }).ok).toBe(false);
    expect(planCreateZone({ role: 'goal', size: [1e7, 2], position: [0, 0, 0] }).ok).toBe(false);
    expect(planCreateZone({ role: 'goal', size: [1e6, 2], position: [0, 0, 0] }).ok).toBe(true);
  });
});

describe('zone tool defaults (the placement fallbacks)', () => {
  it('every role has a positive default size within the §23.3.1 bound', () => {
    for (const role of ['hazard', 'checkpoint', 'goal'] as ZoneRole[]) {
      const [w, h] = DEFAULT_ZONE_SIZE[role];
      expect(w).toBeGreaterThan(0);
      expect(h).toBeGreaterThan(0);
      expect(w).toBeLessThanOrEqual(1e6);
      expect(h).toBeLessThanOrEqual(1e6);
    }
    expect(MIN_ZONE_SPAN_UI).toBeGreaterThan(0);
  });
});