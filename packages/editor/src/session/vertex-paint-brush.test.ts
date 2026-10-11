import { describe, expect, it } from 'vitest';

import { paintVerticesArgs, pathTargetAt, stalePaintOf, strokeBrush, VERTEX_PAINT_DEFAULTS, vertexPaintSettingsError, withoutMeshPaint } from './vertex-paint-brush';

describe('vertex paint brush settings', () => {
  it('takes the shared brush bounds and names what is wrong', () => {
    expect(vertexPaintSettingsError(VERTEX_PAINT_DEFAULTS)).toBeNull();
    expect(vertexPaintSettingsError({ ...VERTEX_PAINT_DEFAULTS, radius: 0 })).toMatch(/radius/);
    expect(vertexPaintSettingsError({ ...VERTEX_PAINT_DEFAULTS, radius: 65 })).toMatch(/radius/);
    expect(vertexPaintSettingsError({ ...VERTEX_PAINT_DEFAULTS, strength: 0 })).toMatch(/strength/);
    expect(vertexPaintSettingsError({ ...VERTEX_PAINT_DEFAULTS, channel: 4 })).toMatch(/channel/);
    expect(vertexPaintSettingsError({ ...VERTEX_PAINT_DEFAULTS, view: 5 })).toMatch(/view/);
    expect(vertexPaintSettingsError({ ...VERTEX_PAINT_DEFAULTS, falloff: 'square' as never })).toMatch(/falloff/);
  });

  it('sends the brush with its defaults left out, and one stroke per target kind', () => {
    expect(strokeBrush(VERTEX_PAINT_DEFAULTS)).toEqual({ radius: 0.5, strength: 0.5, channel: 0 });
    expect(strokeBrush({ ...VERTEX_PAINT_DEFAULTS, falloff: 'constant', erase: true, channel: 2 })).toEqual({ radius: 0.5, strength: 0.5, channel: 2, falloff: 'constant', erase: true });
    const brush = strokeBrush(VERTEX_PAINT_DEFAULTS);
    expect(paintVerticesArgs('m', { kind: 'model' }, [[1, 2, 3]], brush)).toEqual({ entityId: 'm', dabs: [[1, 2, 3]], brush });
    expect(paintVerticesArgs('s', { kind: 'copy', copy: 4 }, [[1, 2, 3]], brush)).toMatchObject({ copy: 4 });
    expect(paintVerticesArgs('a', { kind: 'path', path: 'outline:o1', side: 'left' }, [[1, 2, 3]], brush)).toMatchObject({ path: 'outline:o1', side: 'left' });
  });
});

describe('what a press on a generated object paints', () => {
  // A 4 × 4 m room outline (closed, anticlockwise seen from above) and a building beside it.
  const architecture = {
    elements: [],
    outlines: [{ id: 'room', preset: 'p', path: { points: [[0, 0, 0], [4, 0, 0], [4, 0, 4], [0, 0, 4]] as [number, number, number][], closed: true } }],
    buildings: [{ id: 'shed', preset: 'p', path: { points: [[10, 0, 0], [14, 0, 0], [14, 0, 3], [10, 0, 3]] as [number, number, number][], closed: true } }],
  } as never;

  it('the path nearest the point, the side its face looks to', () => {
    // On the room's first wall (z = 0), its face looking −z, then +z.
    const out = pathTargetAt({ architecture }, [2, 1, -0.1], [0, 0, -1]);
    const inn = pathTargetAt({ architecture }, [2, 1, 0.1], [0, 0, 1]);
    expect(out?.path).toBe('outline:room');
    expect(inn?.path).toBe('outline:room');
    expect(out?.side).not.toBe(inn?.side);
    expect(['left', 'right']).toContain(out?.side);
    // The shed's wall, and a face looking up.
    expect(pathTargetAt({ architecture }, [12, 1, -0.1], [0, 0, -1])?.path).toBe('building:shed');
    expect(pathTargetAt({ architecture }, [12, 3, 0], [0, 1, 0])?.side).toBe('top');
  });

  it('a spline paints its own path; an object with no paths paints none', () => {
    const spline = { points: [{ at: [0, 0, 0] }, { at: [10, 0, 0] }], width: 2 } as never;
    expect(pathTargetAt({ spline }, [5, 0.05, 0.5], [0, 1, 0])).toEqual({ path: 'spline', side: 'top' });
    expect(pathTargetAt({}, [0, 0, 0], [0, 1, 0])).toBeNull();
  });
});

describe('stale paint taken off one mesh', () => {
  const rec = (mesh: string) => ({ mesh, vertices: 24, positions: '0123456789abcdef', paint: 'a'.repeat(64) });
  it('a model keeps its other meshes and its paths; the last one takes the component', () => {
    expect(withoutMeshPaint({ vertexPaint: { meshes: [rec('A#0'), rec('B#0')] } }, 'A#0')).toEqual({ component: 'vertexPaint', value: { meshes: [rec('B#0')] } });
    expect(withoutMeshPaint({ vertexPaint: { meshes: [rec('A#0')], paths: [{}] } }, 'A#0')).toEqual({ component: 'vertexPaint', value: { meshes: null } });
    expect(withoutMeshPaint({ vertexPaint: { meshes: [rec('A#0')] } }, 'A#0')).toEqual({ component: 'vertexPaint', value: null });
    expect(withoutMeshPaint({ vertexPaint: { meshes: [rec('A#0')] } }, 'C#0')).toBeNull();
  });
  it('an instance set keeps its table and pools of other meshes; the last one takes its paint', () => {
    const paint = { copies: 'c'.repeat(64), painted: 1, slots: 1, meshes: [rec('A#0'), rec('B#0')] };
    expect(withoutMeshPaint({ instances: { buffer: 'x', count: 3, paint } }, 'B#0')).toEqual({ component: 'instances', value: { paint: { ...paint, meshes: [rec('A#0')] } } });
    expect(withoutMeshPaint({ instances: { buffer: 'x', count: 3, paint: { ...paint, meshes: [rec('A#0')] } } }, 'A#0')).toEqual({ component: 'instances', value: { paint: null } });
  });
});

describe('a refused stroke over stale paint', () => {
  it('is known by its code and the mesh found, whatever the message says', () => {
    expect(stalePaintOf('m', { code: 'vertex_paint_stale', found: 'Body/Hull#0', message: 'any words' })).toEqual({ entityId: 'm', mesh: 'Body/Hull#0', message: 'any words' });
    expect(stalePaintOf('m', { code: 'field_value', found: 'Body/Hull#0', message: "mesh Body/Hull#0's paint was made for other vertices" })).toBeNull();
    expect(stalePaintOf('m', { code: 'vertex_paint_stale' })).toBeNull();
  });
});
