/**
 * The job-export manifest and route body (neutral shape).
 */
import { describe, expect, it } from 'vitest';

import { parseJobExportManifest, parseJobExportRequest } from './job-export';

const D = 'a'.repeat(64);
const ok = { name: 'Crate', files: [{ path: 'crate.glb', role: 'model', digest: D }, { path: 'img/preview.png', role: 'preview', digest: `sha256:${'B'.repeat(64)}` }], triangles: 12, lods: [12, 6], tool: { any: 'thing' } };

describe('phase 25.22: job export manifest', () => {
  it('reads name, files (digests normalised), triangles and lods; other keys are ignored and listed', () => {
    const r = parseJobExportManifest(ok);
    expect(r).toEqual({ ok: true, manifest: { name: 'Crate', files: [{ path: 'crate.glb', role: 'model', digest: D }, { path: 'img/preview.png', role: 'preview', digest: 'b'.repeat(64) }], triangles: 12, lods: [12, 6], ignoredKeys: ['tool'] } });
  });
  it('refuses a bad manifest with the field', () => {
    const bad: [string, unknown, string][] = [
      ['not an object', [], ''],
      ['no name', { ...ok, name: '' }, '/name'],
      ['no files', { ...ok, files: [] }, '/files'],
      ['escaping path', { ...ok, files: [{ path: '../x.glb', role: 'model', digest: D }] }, '/files/0/path'],
      ['duplicate path', { ...ok, files: [ok.files[0], ok.files[0]] }, '/files/1/path'],
      ['bad role', { ...ok, files: [{ path: 'x.glb', role: 'Model', digest: D }] }, '/files/0/role'],
      ['bad digest', { ...ok, files: [{ path: 'x.glb', role: 'model', digest: 'abc' }] }, '/files/0/digest'],
      ['no model', { ...ok, files: [ok.files[1]] }, '/files'],
      ['two models', { ...ok, files: [ok.files[0], { path: 'y.glb', role: 'model', digest: D }] }, '/files'],
      ['model not a glb', { ...ok, files: [{ path: 'x.fbx', role: 'model', digest: D }] }, '/files'],
      ['bad triangles', { ...ok, triangles: -1 }, '/triangles'],
      ['bad lods', { ...ok, lods: [1.5] }, '/lods'],
    ];
    for (const [what, v, path] of bad) {
      const r = parseJobExportManifest(v);
      expect(r.ok, what).toBe(false);
      if (!r.ok) expect({ what, code: r.error.code, path: r.error.path }).toEqual({ what, code: 'content_invalid', path });
    }
  });
  it('the route body is one of path or stageId, with an optional display name', () => {
    expect(parseJobExportRequest({ path: 'exports/crate' })).toEqual({ ok: true, request: { path: 'exports/crate' } });
    expect(parseJobExportRequest({ stageId: 'stg-0001', displayName: 'Box' }).ok).toBe(true);
    expect(parseJobExportRequest({}).ok).toBe(false);
    expect(parseJobExportRequest({ path: 'a', stageId: 'stg-0001' }).ok).toBe(false);
    expect(parseJobExportRequest({ path: '../a' }).ok).toBe(false);
    expect(parseJobExportRequest({ path: 'a', kind: 'model' }).ok).toBe(false);
  });
});
