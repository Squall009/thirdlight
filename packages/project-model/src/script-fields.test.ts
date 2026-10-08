/**
 * The script access table (what `ctx.entity(ref).get/set`
 * reads and writes) and the descriptor-based write check.
 */
import { describe, expect, it } from 'vitest';

import { DESCRIPTORS } from './descriptors';
import { SCRIPT_ACCESS_SCHEMA_VERSION, checkScriptPatch, scriptAccessTable, scriptComponentAccess, scriptSnapshot } from './script-fields';
import { PROJECT_SCHEMA_VERSION } from './upgrade-v24';

describe('script access marks', () => {
  it('is versioned with the project schema and pinned for it', () => {
    const t = scriptAccessTable();
    expect(t.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(SCRIPT_ACCESS_SCHEMA_VERSION).toBe(7);
    // A field renamed, unmarked or newly marked changes this digest. A rename or an unmarked field is a
    // schema change (bump the project schemaVersion with an upgrade, then re-pin here for the new version);
    // a new optional field or component only adds to what scripts read — nothing they read before
    // changes — and re-pins for the same version.
    const digest = fnv(JSON.stringify(t));
    expect({ schemaVersion: t.schemaVersion, digest }).toEqual({ schemaVersion: 7, digest: PINNED_V7 });
  });

  it('writable fields are exactly the listed first set, all of them readable', () => {
    const t = scriptAccessTable();
    const writable = Object.entries(t.components).filter(([, a]) => a.write.length > 0).map(([c, a]) => `${c}:${a.write.join(',')}`);
    expect(writable).toEqual(['object:active,visible,keepLoaded', 'transform:position,rotation,scale', 'materials:*', 'materialParams:*', 'light:color,intensity,range,lightMask,shadowCasterMask', 'mover:speed,active']);
    for (const a of Object.values(t.components)) for (const w of a.write) expect(a.read).toContain(w);
  });

  it('the fixed-at-run-time data is not writable, and bulk data is not readable', () => {
    for (const c of ['instances', 'blockLayer', 'folder']) expect(scriptComponentAccess(c)).toBeNull();
    for (const [c, key] of [['collider', 'shape'], ['model', 'asset'], ['light', 'type'], ['light', 'castShadow'], ['object', 'static']] as const) {
      expect(scriptComponentAccess(c)?.write ?? []).not.toContain(key);
    }
    // A material swap is written (the renderer loads the material before it shows); the model it dresses is fixed.
    expect(scriptComponentAccess('materials')?.write).toEqual(['*']);
    // `visible` is stored (how the object starts) and scripts write it while the game runs.
    const visible = DESCRIPTORS.entity.fields.find((f) => f.key === 'visible');
    expect(visible?.runtimeOnly).toBeUndefined();
    expect(visible?.runtimeWritable).toBe(true);
  });

  it('checks a patch against the descriptors: unknown, fixed, not applicable, out of range', () => {
    const point = { type: 'point', color: '#ffffff', intensity: 30, range: 8 };
    expect(checkScriptPatch('light', point, { intensity: 60, color: '#FF0000', range: 0 })).toEqual({ ok: true, fields: [['intensity', 60], ['color', '#ff0000'], ['range', 0]] });
    const refused = (component: string, current: Record<string, unknown>, patch: unknown): unknown => {
      const r = checkScriptPatch(component, current, patch);
      return r.ok ? null : { field: r.problem.field, code: r.problem.code };
    };
    expect(refused('light', point, { type: 'spot' })).toEqual({ field: 'light.type', code: 'field_not_writable' });
    expect(refused('light', point, { glow: 1 })).toEqual({ field: 'light.glow', code: 'field_unknown' });
    expect(refused('light', { type: 'directional', color: '#ffffff', intensity: 1 }, { range: 4 })).toEqual({ field: 'light.range', code: 'field_not_applicable' });
    expect(refused('light', point, { intensity: -1 })).toEqual({ field: 'light.intensity', code: 'field_value' });
    expect(refused('light', point, { color: 'red' })).toEqual({ field: 'light.color', code: 'field_value' });
    expect(refused('light', point, 5)).toEqual({ field: 'light', code: 'patch_invalid' });
    expect(refused('light', point, {})).toEqual({ field: 'light', code: 'patch_invalid' });
    expect(refused('instances', {}, { chunkSize: 4 })).toEqual({ field: 'instances', code: 'component_unknown' });
    expect(refused('nothing', {}, {})).toEqual({ field: 'nothing', code: 'component_unknown' });
    // A refused field refuses the whole patch (nothing of it is written).
    expect(refused('light', point, { intensity: 5, type: 'spot' })).toEqual({ field: 'light.type', code: 'field_not_writable' });
    expect(refused('mover', { waypoints: [[1, 0, 0]], speed: 2, mode: 'loop' }, { speed: 0 })).toEqual({ field: 'mover.speed', code: 'field_value' });
    expect(checkScriptPatch('mover', { waypoints: [[1, 0, 0]], speed: 2, mode: 'loop' }, { speed: 5, active: false })).toEqual({ ok: true, fields: [['speed', 5], ['active', false]] });
    expect(refused('object', {}, { static: true })).toEqual({ field: 'object.static', code: 'field_not_writable' });
    expect(refused('object', {}, { components: {} })).toEqual({ field: 'object.components', code: 'field_unknown' });
    // A rotation is normalized; a scale is above 0.
    const rot = checkScriptPatch('transform', {}, { rotation: [0, 0, 0, 2] });
    expect(rot.ok && rot.fields[0]![1]).toEqual([0, 0, 0, 1]);
    expect(refused('transform', {}, { scale: [1, 0, 1] })).toEqual({ field: 'transform.scale', code: 'field_value' });
    expect(refused('transform', {}, { position: [1, 2] })).toEqual({ field: 'transform.position', code: 'field_value' });
    // Material parameters: the value is a map (its values are the runtime's to check).
    expect(checkScriptPatch('materialParams', {}, { glow: { strength: 2 } }).ok).toBe(true);
    expect(refused('materialParams', {}, [1])).toEqual({ field: 'materialParams', code: 'patch_invalid' });
  });

  it('a snapshot holds the readable fields (with the engine defaults), frozen', () => {
    const s = scriptSnapshot('light', { type: 'point', color: '#ffffff', intensity: 30 });
    expect(s).toMatchObject({ type: 'point', color: '#ffffff', intensity: 30, range: 0, decay: 2 });
    expect(Object.isFrozen(s)).toBe(true);
    const obj = scriptSnapshot('object', { id: 'a-000001', active: true, visible: true, locked: true, components: {} } as never);
    expect(Object.keys(obj).sort()).toEqual(['active', 'id', 'keepLoaded', 'parentId', 'static', 'tags', 'visible']);
  });
});

const PINNED_V7 = '5fd2709733b90b3f';

/** 64-bit FNV-1a (two 32-bit lanes) of a text (project-model tests use no Node builtins). */
function fnv(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ (c + 1), 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
