/**
 * Architecture styles and presets (project-model): the starters are valid
 * graphs, an outline expands through its preset's style into elements the
 * generator makes, presets derive from presets (a base's change reaches
 * them, a cycle is refused), masks vary a parameter across the level,
 * swaps and previews, and a slider changing one preset re-keys only the
 * chunks of the outlines it styles. Browser-free; the page's drag and the
 * pixels are in the layered-material e2e.
 */
import { describe, expect, it } from 'vitest';

import { architectureChunkKeys, generateArchitecture } from '../packages/project-model/src/arch-generate';
import { ARCHITECTURE_PRESET_KIND, ARCHITECTURE_STYLE_KIND } from '../packages/project-model/src/arch-style-kinds';
import { ARCHITECTURE_STARTER_GRAPHS } from '../packages/project-model/src/arch-style-starters';
import { architectureStylesOf, expandArchitecture, paintedMaskAt, resolveArchitecturePreset, validateArchitectureGraphs } from '../packages/project-model/src/arch-style';
import { validateArchitectureComponent, type ArchitectureComponent, type ArchitectureOutline } from '../packages/project-model/src/architecture';
import type { ModelErrorV2 } from '../packages/project-model/src/errors';
import { validateGraphDocuments, type GraphData } from '../packages/project-model/src/graph';
import { GRAPH_KINDS } from '../packages/project-model/src/graph-kinds';
import { defaultTrimSheet } from '../packages/project-model/src/trim-sheet';

const SHEETS = { '*': defaultTrimSheet() };
const ORIGIN = [0, 0, 0];

const room = (id: string, x: number, z: number, preset = 'starter-room', w = 8, d = 6): ArchitectureOutline => ({
  id,
  preset,
  path: { points: [[x, 0, z], [x + w, 0, z], [x + w, 0, z + d], [x, 0, z + d]], closed: true },
  openings: [{ id: 'door', at: w / 2, width: 1.2, bottom: 0, top: 2.2, frameSides: 'both' }],
});

function presetGraph(style: string, base: string, values: Record<string, number> = {}, extra: GraphData['nodes'] = []): GraphData {
  return {
    nodes: [{ id: 'preset', type: 'preset', position: [0, 0], data: { style, base, sheet: '' } }, ...Object.entries(values).map(([parameter, value], i) => ({ id: `v${i}`, type: 'value', position: [0, 100 * (i + 1)] as [number, number], data: { parameter, value } })), ...extra],
    edges: [],
  };
}

describe('architecture styles and presets', () => {
  it('the starters are valid graph documents of their kinds', () => {
    const errors: ModelErrorV2[] = [];
    validateGraphDocuments(GRAPH_KINDS, ARCHITECTURE_STARTER_GRAPHS, '/graphs', errors);
    expect(errors).toEqual([]);
    expect(ARCHITECTURE_STARTER_GRAPHS.filter((g) => g.kind === ARCHITECTURE_STYLE_KIND).length).toBeGreaterThanOrEqual(3);
    expect(ARCHITECTURE_STARTER_GRAPHS.filter((g) => g.kind === ARCHITECTURE_PRESET_KIND).length).toBeGreaterThanOrEqual(3);
  });

  it('an outline expands through each starter into a valid component the generator makes without problems', () => {
    const table = architectureStylesOf([]);
    const c: ArchitectureComponent = {
      elements: [],
      chunkSize: 16,
      outlines: [room('a', 0, 0), room('b', 12, 0, 'starter-room-tall'), room('c', 0, 12, 'starter-hall', 10, 6), { id: 'fence', preset: 'starter-rail', path: { points: [[0, 0, 24], [10, 0, 24], [14, 0, 28]] } }],
    };
    const errors: ModelErrorV2[] = [];
    validateArchitectureComponent(c, '/a', errors);
    expect(errors).toEqual([]);
    const x = expandArchitecture(c, ORIGIN, table);
    expect(x.problems).toEqual([]);
    expect(x.component.outlines).toBeUndefined();
    const valid: ModelErrorV2[] = [];
    validateArchitectureComponent(x.component, '/x', valid);
    expect(valid).toEqual([]);
    // Each room: walls, baseboard, crown, floor and a ceiling (the hall: a vault and pilasters); the fence: posts and a rail.
    expect(x.component.elements.filter((e) => e.id.startsWith('a-')).map((e) => e.kind).sort()).toEqual(['fill', 'fill', 'sweep', 'sweep', 'sweep']);
    expect(x.component.elements.some((e) => e.id.startsWith('c-') && e.kind === 'repeat')).toBe(true);
    expect(x.component.elements.filter((e) => e.id.startsWith('fence-')).map((e) => e.kind).sort()).toEqual(['repeat', 'sweep']);
    const walls = x.component.elements.find((e) => e.id.startsWith('a-') && e.kind === 'sweep' && (e.openings?.length ?? 0) > 0);
    expect(walls?.kind === 'sweep' && walls.openings?.[0]?.frame).toBeTruthy();
    const chunks = generateArchitecture(x.component, SHEETS);
    expect(chunks.flatMap((k) => k.problems)).toEqual([]);
    expect(chunks.reduce((n, k) => n + k.meshes.reduce((m, s) => m + s.mesh.indices.length / 3, 0), 0)).toBeGreaterThan(1000);
    // Deterministic: the same input expands to the same text.
    expect(JSON.stringify(expandArchitecture(c, ORIGIN, architectureStylesOf([...[]])).component)).toBe(JSON.stringify(x.component));
  });

  it('presets derive from presets: values over the base, a base change reaches the derived, a cycle is refused', () => {
    const graphs = [
      { graphId: 'house', kind: ARCHITECTURE_PRESET_KIND, name: 'House', graph: presetGraph('starter-room-style', '', { ceiling_height: 3.5 }) },
      { graphId: 'house-attic', kind: ARCHITECTURE_PRESET_KIND, name: 'Attic', graph: presetGraph('', 'house', { moulding_depth: 0 }) },
    ];
    const r = resolveArchitecturePreset(architectureStylesOf(graphs), 'house-attic');
    expect(r.problem).toBeNull();
    expect(r.chain).toEqual(['house-attic', 'house']);
    expect(r.values).toEqual({ ceiling_height: 3.5, moulding_depth: 0 });
    const changed = [{ ...graphs[0]!, graph: presetGraph('starter-room-style', '', { ceiling_height: 5 }) }, graphs[1]!];
    expect(resolveArchitecturePreset(architectureStylesOf(changed), 'house-attic').values['ceiling_height']).toBe(5);
    // The attic's 0 moulding depth leaves its crown out (a 0 profile makes nothing).
    const x = expandArchitecture({ elements: [], outlines: [room('r', 0, 0, 'house-attic')] }, ORIGIN, architectureStylesOf(graphs));
    expect(x.component.elements.filter((e) => e.kind === 'sweep').length).toBe(2);
    // A derived starter: a project preset may derive from the engine's.
    expect(resolveArchitecturePreset(architectureStylesOf([{ graphId: 'mine', kind: ARCHITECTURE_PRESET_KIND, name: 'Mine', graph: presetGraph('', 'starter-room-tall') }]), 'mine').values['ceiling_height']).toBe(4.2);
    const cyc = [
      { graphId: 'p1', kind: ARCHITECTURE_PRESET_KIND, name: 'A', graph: presetGraph('', 'p2') },
      { graphId: 'p2', kind: ARCHITECTURE_PRESET_KIND, name: 'B', graph: presetGraph('', 'p1') },
    ];
    const errors: ModelErrorV2[] = [];
    validateArchitectureGraphs(cyc, '/graphs', errors);
    expect(errors.map((e) => e.code)).toEqual(['hierarchy_cycle', 'hierarchy_cycle']);
    expect(expandArchitecture({ elements: [], outlines: [room('r', 0, 0, 'p1')] }, ORIGIN, architectureStylesOf(cyc)).problems[0]).toMatch(/derives from itself/);
  });

  it('a mask drives a parameter across the level: noise, height, and a painted mask', () => {
    const mask = (data: Record<string, number | string>): GraphData['nodes'][number] => ({ id: 'm', type: 'mask', position: [200, 0], data: { parameter: 'ceiling_height', to: 6, ...data } });
    const heightOf = (graph: GraphData, c: ArchitectureComponent, origin = ORIGIN): number[] => {
      const x = expandArchitecture(c, origin, architectureStylesOf([{ graphId: 'v', kind: ARCHITECTURE_PRESET_KIND, name: 'V', graph }]));
      return (c.outlines ?? []).map((o) => {
        const top = x.component.elements.find((e) => e.id.startsWith(`${o.id}-`) && e.kind === 'fill' && e.face === 'down');
        return top?.kind === 'fill' ? top.path.points[0]![1] : NaN;
      });
    };
    const many: ArchitectureComponent = { elements: [], outlines: Array.from({ length: 12 }, (_, i) => room(`r${i}`, i * 40, 0, 'v')) };
    const noise = heightOf(presetGraph('starter-room-style', '', {}, [mask({ source: 'noise', scale: 30, low: 0.2, high: 0.8 })]), many);
    expect(new Set(noise.map((h) => h.toFixed(3))).size).toBeGreaterThan(3);
    for (const h of noise) expect(h).toBeGreaterThanOrEqual(3 - 1e-9) && expect(h).toBeLessThanOrEqual(6 + 1e-9);
    // Height: the object's world height (its origin) reaches the mask.
    const one: ArchitectureComponent = { elements: [], outlines: [room('r', 0, 0, 'v')] };
    const byHeight = presetGraph('starter-room-style', '', {}, [mask({ source: 'height', low: 0, high: 10 })]);
    expect(heightOf(byHeight, one, [0, 0, 0])[0]).toBeCloseTo(3);
    expect(heightOf(byHeight, one, [0, 5, 0])[0]).toBeCloseTo(4.5);
    // Painted: a dab over the second room only.
    const painted: ArchitectureComponent = { elements: [], outlines: [room('r0', 0, 0, 'v'), room('r1', 20, 0, 'v')], masks: { tall: { points: [[24, 3, 5, 1]] } } };
    expect(heightOf(presetGraph('starter-room-style', '', {}, [mask({ source: 'painted', mask: 'tall' })]), painted)).toEqual([3, 6]);
    expect(paintedMaskAt([[0, 0, 4, 1]], 3, 0)).toBeGreaterThan(0);
    expect(paintedMaskAt([[0, 0, 4, 1]], 4, 0)).toBe(0);
  });

  it('swaps and previews: a swap restyles every outline naming a preset; a preview reaches the presets derived from its preset', () => {
    const table = architectureStylesOf([]);
    const c: ArchitectureComponent = { elements: [], outlines: [room('a', 0, 0), room('b', 20, 0, 'starter-room-tall')] };
    const plain = expandArchitecture(c, ORIGIN, table);
    const swapped = expandArchitecture(c, ORIGIN, table, { swaps: { 'starter-room': 'starter-hall' } });
    expect(swapped.component.elements.some((e) => e.id.startsWith('a-') && e.kind === 'repeat')).toBe(true);
    expect(swapped.component.elements.filter((e) => e.id.startsWith('b-'))).toEqual(plain.component.elements.filter((e) => e.id.startsWith('b-')));
    const preview = expandArchitecture(c, ORIGIN, table, { preview: { preset: 'starter-room', values: { wall_thickness: 0.5 } } });
    expect(preview.presets.has('starter-room')).toBe(true);
    const wallOf = (x: typeof plain, id: string): string => {
      const e = x.component.elements.find((q) => q.id.startsWith(`${id}-`) && q.kind === 'sweep' && (q.openings?.length ?? 0) > 0);
      return e?.kind === 'sweep' ? JSON.stringify(x.component.profiles?.[e.profile]) : '';
    };
    expect(wallOf(preview, 'a')).not.toBe(wallOf(plain, 'a'));
    // The tall room derives from the room: the dragged thickness reaches it too.
    expect(wallOf(preview, 'b')).not.toBe(wallOf(plain, 'b'));
  });

  it('a slider changing one preset re-keys only the chunks of the outlines it styles', () => {
    const graphs = [
      { graphId: 'east', kind: ARCHITECTURE_PRESET_KIND, name: 'East', graph: presetGraph('', 'starter-room') },
      { graphId: 'west', kind: ARCHITECTURE_PRESET_KIND, name: 'West', graph: presetGraph('', 'starter-room') },
    ];
    const c: ArchitectureComponent = { elements: [], chunkSize: 16, outlines: [room('e', 0, 0, 'east'), room('w', 64, 0, 'west')] };
    const table = architectureStylesOf(graphs);
    const before = architectureChunkKeys(expandArchitecture(c, ORIGIN, table).component, SHEETS);
    const after = architectureChunkKeys(expandArchitecture(c, ORIGIN, table, { preview: { preset: 'east', values: { moulding_depth: 0.3 } } }).component, SHEETS);
    const changed = [...after].filter(([k, v]) => before.get(k)?.key !== v.key).map(([k]) => k);
    expect(changed.length).toBeGreaterThan(0);
    for (const k of changed) expect(Number(k.split(',')[0])).toBeLessThan(2);
    expect([...after.keys()].some((k) => Number(k.split(',')[0]) >= 4)).toBe(true);
  });
});
