import { describe, expect, it } from 'vitest';

import { DECAL_TOOL_DEFAULTS, decalFrame, decalPlaceCommand, decalPlacement, decalStamp, decalToolSettingsError, turnAboutNormal, type Quat } from './decal-place';

/** A vector turned by a quaternion. */
function turn(q: readonly number[], v: readonly number[]): number[] {
  const [x, y, z, w] = q as Quat;
  const [vx, vy, vz] = v as [number, number, number];
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}
const close = (a: readonly number[], b: readonly number[], digits = 6): void => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, digits));

describe('decal tool placement', () => {
  it('turns the box +Z onto the normal: a floor looks down with its top to −Z, a wall facing +Z keeps the identity', () => {
    close(decalFrame([0, 1, 0], 0), [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
    close(decalFrame([0, 0, 1], 0), [0, 0, 0, 1]);
    for (const n of [[0.3, 0.8, -0.2], [-1, 0, 0], [0, -1, 0], [0.01, 0.99995, 0], [0.6, -0.1, 0.79]]) {
      const l = Math.hypot(...n);
      const unit = n.map((v) => v / l);
      for (const a of [0, 37, -120]) {
        const q = decalFrame(unit as [number, number, number], a);
        close(turn(q, [0, 0, 1]), unit, 5);
        expect(Math.hypot(...q)).toBeCloseTo(1, 9);
        expect(q[3]).toBeGreaterThanOrEqual(0);
        // A turn of the frame about the normal is the frame at that angle.
        const turned = turnAboutNormal(decalFrame(unit as [number, number, number], 0), a);
        close(turn(turned, [1, 0, 0]), turn(q, [1, 0, 0]), 5);
      }
      // On a wall or a slope the image's top points up the slope.
      if (Math.abs(unit[1]!) < 0.999) expect(turn(decalFrame(unit as [number, number, number], 0), [0, 1, 0])[1]).toBeGreaterThan(0);
    }
  });

  it("draws a stamp's turn and size from the seed and its number: the same again, within the settings", () => {
    const st = { turn: 45, scaleMin: 0.5, scaleMax: 2, seed: 7 };
    const a = Array.from({ length: 50 }, (_, i) => decalStamp(st, i));
    expect(Array.from({ length: 50 }, (_, i) => decalStamp(st, i))).toEqual(a);
    for (const s of a) {
      expect(Math.abs(s.turn)).toBeLessThanOrEqual(45);
      expect(s.scale).toBeGreaterThanOrEqual(0.5);
      expect(s.scale).toBeLessThanOrEqual(2);
    }
    expect(new Set(a.map((s) => s.turn.toFixed(6))).size).toBe(50);
    expect(decalStamp({ ...st, seed: 8 }, 0)).not.toEqual(a[0]);
    expect(decalStamp({ ...st, turn: 0, scaleMin: 1, scaleMax: 1 }, 3)).toEqual({ turn: 0, scale: 1 });
  });

  it('places one valid decal component in one createEntity; a click keeps the size, a stamp scales width and height', () => {
    const s = { ...DECAL_TOOL_DEFAULTS, size: [2, 1, 0.4] as [number, number, number], mode: 'clipped' as const };
    const click = decalPlacement(s, 'mat-a', [1.23456, 0, -2], [0, 1, 0], null);
    expect(click.position).toEqual([1.235, 0, -2]);
    expect(click.decal).toEqual({ size: [2, 1, 0.4], material: 'mat-a', mode: 'clipped' });
    const stamp = decalPlacement(s, 'mat-a', [0, 0, 0], [0, 1, 0], 4);
    const k = decalStamp(s.stamp, 4).scale;
    expect(stamp.decal.size).toEqual([Math.round(2 * k * 1000) / 1000, Math.round(k * 1000) / 1000, 0.4]);
    expect(decalPlacement({ ...s, mode: 'projected' }, 'mat-a', [0, 0, 0], [0, 1, 0], null).decal.mode).toBeUndefined();
    const cmd = decalPlaceCommand('scene-main', 'Decal', click);
    expect(cmd).toEqual({ op: 'createEntity', args: { sceneId: 'scene-main', kind: 'group', name: 'Decal', transform: { position: click.position, rotation: click.rotation }, components: { decal: click.decal } } });
  });

  it('refuses settings it cannot place', () => {
    expect(decalToolSettingsError(DECAL_TOOL_DEFAULTS)).toBeNull();
    expect(decalToolSettingsError({ ...DECAL_TOOL_DEFAULTS, size: [0, 1, 1] })).toMatch(/width/);
    expect(decalToolSettingsError({ ...DECAL_TOOL_DEFAULTS, stamp: { ...DECAL_TOOL_DEFAULTS.stamp, scaleMin: 2, scaleMax: 1 } })).toMatch(/stamp sizes/);
    expect(decalToolSettingsError({ ...DECAL_TOOL_DEFAULTS, stamp: { ...DECAL_TOOL_DEFAULTS.stamp, seed: 1.5 } })).toMatch(/seed/);
    expect(decalToolSettingsError({ ...DECAL_TOOL_DEFAULTS, mode: 'flat' as never })).toMatch(/mode/);
  });
});
