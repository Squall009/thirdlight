/**
 * Packet 31 — physics-transform validation (project-model §21.2).
 *
 * An unsupported authored transform is a validation error, never silently
 * flattened: parented, non-unit scale, off-Z rotation and a tilted controller
 * each produce the contract's reason. An absent optional field means "the
 * model already checked it" and is never guessed.
 */
import { describe, expect, it } from 'vitest';

import { OFF_AXIS_TOLERANCE } from './constants';
import { validateControllerTransform, validateStaticTransform } from './transform';
import type { RapierStaticColliderSpec } from './types';

const spec = (extra: Partial<RapierStaticColliderSpec> = {}): RapierStaticColliderSpec => ({
  entityId: 'c-0001',
  shape: { type: 'box', hx: 1, hy: 1 },
  position: { x: 1, y: 2 },
  rotationZ: 0.5,
  ...extra,
});

const reason = (r: ReturnType<typeof validateStaticTransform>): string | undefined =>
  r.ok ? undefined : r.reason;

describe('static collider transform', () => {
  it('accepts a root collider at unit scale rotated about Z', () => {
    expect(validateStaticTransform(spec(), 's').ok).toBe(true);
    expect(
      validateStaticTransform(
        spec({ parentId: null, scale: [1, 1, 1], rotation: [0, 0, 0.7071067811865476, 0.7071067811865476] }),
        's',
      ).ok,
    ).toBe(true);
  });

  it('refuses a parented collider instead of re-parenting the shape', () => {
    expect(reason(validateStaticTransform(spec({ parentId: 'group-0001' }), 's'))).toBe('parented');
  });

  it('refuses every non-unit scale instead of flattening it into the shape', () => {
    for (const scale of [[2, 1, 1], [1, 1.0000001, 1], [0.5, 0.5, 0.5]] as const) {
      expect(reason(validateStaticTransform(spec({ scale }), 's'))).toBe('scale');
    }
  });

  it('refuses an off-Z rotation at the near-unit tolerance boundary', () => {
    const allowed = OFF_AXIS_TOLERANCE * 0.5;
    expect(
      validateStaticTransform(spec({ rotation: [allowed, 0, 0, 1] }), 's').ok,
    ).toBe(true);
    expect(
      reason(validateStaticTransform(spec({ rotation: [OFF_AXIS_TOLERANCE * 2, 0, 0, 1] }), 's')),
    ).toBe('rotation');
    expect(reason(validateStaticTransform(spec({ rotation: [0, 0.5, 0, 0.5] }), 's'))).toBe('rotation');
  });

  it('refuses non-finite positions and rotations as invalid, never flattened', () => {
    expect(reason(validateStaticTransform(spec({ position: { x: Number.NaN, y: 0 } }), 's'))).toBe(
      'invalid_transform',
    );
    expect(reason(validateStaticTransform(spec({ rotationZ: Number.POSITIVE_INFINITY }), 's'))).toBe(
      'invalid_transform',
    );
    expect(reason(validateStaticTransform(spec({ rotation: [0, 0, 0, Number.NaN] }), 's'))).toBe(
      'invalid_transform',
    );
  });
});

describe('controller transform', () => {
  it('accepts a root, unit-scale, upright character', () => {
    expect(validateControllerTransform({ x: 0, y: 0.9 }).ok).toBe(true);
    expect(
      validateControllerTransform({ x: 0, y: 0.9, parentId: null, scale: [1, 1, 1], rotation: [0, 0, 0, 1] }).ok,
    ).toBe(true);
  });

  it('refuses any authored rotation on the capsule (upright rule)', () => {
    expect(
      validateControllerTransform({ x: 0, y: 0.9, rotation: [0, 0, 0.1, 0.99498743710662] }),
    ).toEqual(
      expect.objectContaining({ ok: false, reason: 'upright' }),
    );
    expect(
      validateControllerTransform({ x: 0, y: 0.9, rotation: [0, 0, 0, -1] }).ok,
    ).toBe(true);
  });

  it('refuses a parented or scaled character', () => {
    expect(
      validateControllerTransform({ x: 0, y: 0.9, parentId: 'group-0001' }),
    ).toEqual(expect.objectContaining({ ok: false, reason: 'parented' }));
    expect(
      validateControllerTransform({ x: 0, y: 0.9, scale: [1, 1, 0.5] }),
    ).toEqual(expect.objectContaining({ ok: false, reason: 'scale' }));
  });

  it('refuses a non-finite character position', () => {
    expect(
      validateControllerTransform({ x: Number.POSITIVE_INFINITY, y: 0.9 }),
    ).toEqual(expect.objectContaining({ ok: false, reason: 'invalid_transform' }));
  });
});
