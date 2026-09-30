/**
 * Project resources as files (environment presets too, their order kept in
 * content.json) and the asset records in their sidecars, through
 * the real service and filesystem: a command writes only the files of the
 * records it changed (and content.json, which carries the revision and the
 * retry record); a resource file moved outside the editor is the same
 * resource at the next open, and of two files with one id the one named
 * after it is the resource (the other is a copy the file check gives a new
 * id); the index
 * answers what references what; a project whose content.json still holds
 * everything (26.3's layout) opens and is written in the files layout with
 * its revision kept.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { openWorkspaceService } from './service';
import { defaultOps } from './write';
import type { StageInspector, WorkspaceService, WriteOps } from './index';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function temp(tag: string): string {
  const dir = join(tmpdir(), `tl-resources-${tag}-${process.pid}-${Date.now().toString(36)}-${roots.length}`);
  mkdirSync(dir, { recursive: true });
  roots.push(dir);
  return dir;
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const CRATE = new TextEncoder().encode('glTF a crate');
const RECIPE = { profile: 'gltf-glb', recipeVersion: 1, toolchain: { three: '0.186.0' }, extensions: [] };
const METRICS = { nodes: 1, meshes: 1, primitives: 1, materials: 1, images: 0, textures: 0, vertices: 3, triangles: 1, animations: 0, animationChannels: 0, clipDurationMs: 0, decodedGeometryBytes: 36, decodedImageBytes: 0 };
const stubInspector: StageInspector = (bytes, job) =>
  ({
    status: 'ok',
    kind: 'model',
    proposalId: job.proposalId(),
    stageId: job.stageId(),
    expiresAt: job.expiresAt(),
    sourceDigest: sha(bytes),
    sourceByteLength: bytes.length,
    importRecipe: RECIPE,
    metrics: METRICS,
    diagnostics: [],
    diagnosticCount: 0,
    suggestedDisplayName: 'asset',
    inspection: { nodeNames: [], materialNames: [], clipNames: [], sceneCount: 1, truncated: false },
  }) as unknown as ReturnType<StageInspector>;

const PID = 'demo';
let seq = 0;
function revision(service: WorkspaceService): number {
  return (service.query({ op: 'queryProject', projectId: PID }) as unknown as { revision: number }).revision;
}
function ok(service: WorkspaceService, op: string, args: Record<string, unknown>): { ok: true; revision: number; createdId?: string } {
  seq += 1;
  const r = service.runCommand({ op, projectId: PID, expectedRevision: revision(service), requestId: `req-${(0xf000 + seq).toString(16).padStart(32, '0')}`, args });
  expect(r.ok, JSON.stringify(r).slice(0, 600)).toBe(true);
  return r as unknown as { ok: true; revision: number; createdId?: string };
}
const mat = (id: string, color: string): Record<string, unknown> => ({ materialId: id, name: id, shader: 'standard', params: { color }, textures: {} });
const json = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

/** Every file a transaction renames into place (what it wrote), in the game folder or the project folder. */
function recordingOps(written: string[]): WriteOps {
  return { ...defaultOps, renameFile: (from: string, to: string) => {
    written.push(to);
    defaultOps.renameFile(from, to);
  } };
}

function project(tag: string, written: string[] = []): { root: string; dir: string; open: () => WorkspaceService } {
  const root = temp(tag);
  const open = (): WorkspaceService => openWorkspaceService({ root, assetInspector: stubInspector, ops: recordingOps(written) });
  const s = open();
  expect(s.createProject(PID, 'Demo').ok).toBe(true);
  s.close();
  return { root, dir: join(root, 'projects', PID), open };
}

describe('project resources as files', () => {
  it('writes each material to its own file; an edit writes that file and content.json only', () => {
    const written: string[] = [];
    const { dir, open } = project('one-file', written);
    const s = open();
    try {
      ok(s, 'setMaterial', { material: mat('stone', '#808080') });
      ok(s, 'setMaterial', { material: mat('grass', '#40a040') });
      const stone = json(join(dir, 'assets', 'materials', 'stone.material.json'));
      expect(stone).toMatchObject({ tlresource: 1, kind: 'material', id: 'stone', data: { materialId: 'stone', params: { color: '#808080' } } });
      const content = json(join(dir, 'content.json')) as { storageVersion: number; content: Record<string, unknown> };
      expect(content.storageVersion).toBe(5);
      expect(content.content['materials']).toBeUndefined();
      expect(content.content['prefabs']).toBeUndefined();

      written.length = 0;
      const r = ok(s, 'setMaterial', { material: mat('stone', '#909090') });
      const inProject = written.map((p) => p.slice(dir.length + 1)).filter((p) => !p.startsWith('.thirdlight/'));
      expect(inProject.sort()).toEqual(['assets/materials/stone.material.json', 'content.json']);
      // The change carries the one material, before and after.
      expect((r as unknown as { change: unknown }).change).toMatchObject({ type: 'setMaterial', materialId: 'stone', previous: { params: { color: '#808080' } }, next: { params: { color: '#909090' } } });

      ok(s, 'deleteMaterial', { materialId: 'grass' });
      expect(existsSync(join(dir, 'assets', 'materials', 'grass.material.json'))).toBe(false);
      ok(s, 'undo', {});
      expect(json(join(dir, 'assets', 'materials', 'grass.material.json'))).toMatchObject({ id: 'grass' });
    } finally {
      s.close();
    }
    const again = open();
    try {
      const cfg = again.query({ op: 'queryGameConfig', projectId: PID }) as unknown as { materials: { materialId: string; params: { color: string } }[] };
      expect(cfg.materials.map((m) => [m.materialId, m.params.color])).toEqual([['grass', '#40a040'], ['stone', '#909090']]);
    } finally {
      again.close();
    }
  });

  it('an edit of a dialogue, a timeline or a UI document writes that one file (the others of its kind stay as they are)', () => {
    const written: string[] = [];
    const { dir, open } = project('per-kind', written);
    const s = open();
    try {
      const timeline = (id: string, duration: number): Record<string, unknown> => ({ timelineId: id, name: id, duration, slots: [], tracks: [{ trackId: 'sig', type: 'signal', keys: [{ time: 1, name: 'go' }] }] });
      for (const id of ['a', 'b', 'c']) {
        ok(s, 'setDialogue', { dialogue: { dialogueId: `talk-${id}`, name: `Talk ${id}` } });
        ok(s, 'setTimeline', { timeline: timeline(`shot-${id}`, 3) });
        ok(s, 'setUiDocument', { document: { uiDocumentId: `hud-${id}`, name: `HUD ${id}`, root: { type: 'text', text: id } } });
      }
      const edits: [string, Record<string, unknown>, string][] = [
        ['setDialogue', { dialogue: { dialogueId: 'talk-b', name: 'Small talk' } }, 'assets/dialogue/talk-b.dialogue.json'],
        ['setTimeline', { timeline: timeline('shot-b', 4) }, 'assets/timelines/shot-b.timeline.json'],
        ['setUiDocument', { document: { uiDocumentId: 'hud-b', name: 'HUD b', root: { type: 'text', text: 'changed' } } }, 'assets/ui/hud-b.ui.json'],
      ];
      for (const [op, args, file] of edits) {
        written.length = 0;
        ok(s, op, args);
        const inProject = written.map((p) => p.slice(dir.length + 1)).filter((p) => !p.startsWith('.thirdlight/'));
        expect(inProject.sort(), op).toEqual([file, 'content.json']);
      }
    } finally {
      s.close();
    }
  });

  it('keeps each environment preset in its own file and their order in content.json', () => {
    const written: string[] = [];
    const { dir, open } = project('presets', written);
    let s = open();
    const env = (dusk: string): Record<string, unknown> => ({ wind: { direction: [1, 0], strength: 1, gust: 0.5, gustFrequency: 0.3, turbulence: 0.2 }, presets: [{ presetId: 'night', name: 'Night', lightmap: { intensity: 0.2 } }, { presetId: 'dusk', name: dusk, lightmap: { intensity: 0.6 } }] });
    try {
      ok(s, 'setEnvironment', { environment: env('Dusk') });
      expect(json(join(dir, 'assets', 'environment', 'dusk.envpreset.json'))).toMatchObject({ kind: 'envpreset', id: 'dusk', data: { presetId: 'dusk', name: 'Dusk' } });
      expect((json(join(dir, 'content.json')) as { content: { environment: { presets: unknown } } }).content.environment.presets).toEqual(['night', 'dusk']);
      written.length = 0;
      ok(s, 'setEnvironment', { environment: env('Late dusk') });
      const inProject = written.map((p) => p.slice(dir.length + 1)).filter((p) => !p.startsWith('.thirdlight/'));
      expect(inProject.sort()).toEqual(['assets/environment/dusk.envpreset.json', 'content.json']);
    } finally {
      s.close();
    }
    s = open();
    try {
      const cfg = s.query({ op: 'queryGameConfig', projectId: PID }) as unknown as { environment: { presets: { presetId: string; name: string }[] } };
      expect(cfg.environment.presets.map((p) => [p.presetId, p.name])).toEqual([['night', 'Night'], ['dusk', 'Late dusk']]);
    } finally {
      s.close();
    }
  });

  it('finds a resource file moved outside the editor at the next open, and writes it where it is', () => {
    const { dir, open } = project('moved');
    let s = open();
    ok(s, 'setMaterial', { material: mat('stone', '#808080') });
    s.close();
    mkdirSync(join(dir, 'levels', 'one'), { recursive: true });
    renameSync(join(dir, 'assets', 'materials', 'stone.material.json'), join(dir, 'levels', 'one', 'rock.material.json'));
    s = open();
    try {
      const idx = s.query({ op: 'queryIndex', projectId: PID, args: { kind: 'material' } }) as unknown as { entries: { id: string; path: string }[] };
      expect(idx.entries).toEqual([expect.objectContaining({ id: 'stone', path: 'levels/one/rock.material.json' })]);
      ok(s, 'setMaterial', { material: mat('stone', '#111111') });
      expect(json(join(dir, 'levels', 'one', 'rock.material.json'))).toMatchObject({ data: { params: { color: '#111111' } } });
      expect(existsSync(join(dir, 'assets', 'materials', 'stone.material.json'))).toBe(false);
    } finally {
      s.close();
    }
    // A copy of the file with the same id opens (the first by path is the resource); the file check gives the copy a new id.
    cpSync(join(dir, 'levels', 'one', 'rock.material.json'), join(dir, 'levels', 'rock-copy.material.json'));
    s = open();
    try {
      const idx = s.query({ op: 'queryIndex', projectId: PID, args: { kind: 'material' } }) as unknown as { entries: { id: string; path: string }[] };
      expect(idx.entries).toEqual([expect.objectContaining({ id: 'stone', path: 'levels/one/rock.material.json' })]);
      const check = s.checkResourceFiles(PID) as { ok: true; prepared: boolean; report: { adopted: unknown[] } };
      expect(check.report.adopted).toEqual([{ kind: 'material', id: 'rock-copy', path: 'levels/rock-copy.material.json', copyOf: 'stone' }]);
      ok(s, 'importResources', {});
      expect(json(join(dir, 'levels', 'rock-copy.material.json'))).toMatchObject({ id: 'rock-copy', data: { materialId: 'rock-copy', params: { color: '#111111' } } });
      expect(json(join(dir, 'levels', 'one', 'rock.material.json'))).toMatchObject({ id: 'stone' });
    } finally {
      s.close();
    }
  });

  it('keeps each asset record in its sidecar; the index says what references what', () => {
    const { dir, open } = project('sidecar');
    const s = open();
    try {
      s.holdAssetBytes(PID, CRATE);
      ok(s, 'publishAsset', { mode: 'create', assetId: 'crate', kind: 'model', displayName: 'Crate', sourceDigest: sha(CRATE), sourceByteLength: CRATE.length, importRecipe: RECIPE, metrics: METRICS, importedAt: '2026-09-30T10:00:00Z' });
      const sidecar = json(join(dir, 'assets', 'Crate.glb.tlasset')) as { tlasset: number; id: string; record: { assetId: string; versions: { sourcePath: string }[] } };
      expect(sidecar).toMatchObject({ tlasset: 2, id: 'crate', record: { assetId: 'crate', versions: [{ sourcePath: 'assets/Crate.glb' }] } });
      expect((json(join(dir, 'content.json')) as { content: { assets: unknown[] } }).content.assets).toEqual([]);

      ok(s, 'setMaterial', { material: mat('stone', '#808080') });
      ok(s, 'createEntity', { kind: 'model', name: 'crate', model: { asset: { assetId: 'crate' } }, components: { materials: { '*': 'stone' } } });
      const users = s.query({ op: 'queryIndex', projectId: PID, args: { referencing: 'stone' } }) as unknown as { entries: { kind: string; id: string }[] };
      expect(users.entries.map((e) => `${e.kind}:${e.id}`)).toEqual(['scene:scene-main']);
      const crate = s.query({ op: 'queryIndex', projectId: PID, args: { id: 'crate' } }) as unknown as { entries: { kind: string; path: string; name: string }[] };
      expect(crate.entries).toEqual([expect.objectContaining({ kind: 'model', path: 'assets/Crate.glb', name: 'Crate' })]);
    } finally {
      s.close();
    }
    // A sidecar removed by hand while the project is open is written back by the file check.
    const t = open();
    try {
      expect(revision(t)).toBeGreaterThan(0);
      unlinkSync(join(dir, 'assets', 'Crate.glb.tlasset'));
      const files = t.assetFiles(PID);
      expect(files.ok && files.entries[0], JSON.stringify(files).slice(0, 400)).toMatchObject({ assetId: 'crate', status: 'ok' });
      expect(json(join(dir, 'assets', 'Crate.glb.tlasset'))).toMatchObject({ tlasset: 2, record: { assetId: 'crate' } });
    } finally {
      t.close();
    }
  });

  it('opens a project whose content.json still holds its resources and asset records, and writes the files layout with the revision kept', () => {
    const { dir, open } = project('layout-upgrade');
    let s = open();
    s.holdAssetBytes(PID, CRATE);
    ok(s, 'publishAsset', { mode: 'create', assetId: 'crate', kind: 'model', displayName: 'Crate', sourceDigest: sha(CRATE), sourceByteLength: CRATE.length, importRecipe: RECIPE, metrics: METRICS, importedAt: '2026-09-30T10:00:00Z' });
    ok(s, 'setMaterial', { material: mat('stone', '#808080') });
    const rev = revision(s);
    s.close();
    // The layout 26.3 wrote: everything in content.json (storageVersion 4), sidecars without records.
    const contentPath = join(dir, 'content.json');
    const file = json(contentPath) as { storageVersion: number; content: Record<string, unknown> };
    const sidecarPath = join(dir, 'assets', 'Crate.glb.tlasset');
    const sidecar = json(sidecarPath) as Record<string, unknown>;
    const material = (json(join(dir, 'assets', 'materials', 'stone.material.json')) as { data: unknown }).data;
    writeFileSync(contentPath, `${JSON.stringify({ ...file, storageVersion: 4, content: { ...file.content, assets: [sidecar['record']], prefabs: [], behaviors: [], materials: [material] } }, null, 2)}\n`);
    const { record: _r, ...older } = sidecar;
    writeFileSync(sidecarPath, `${JSON.stringify({ ...older, tlasset: 1 }, null, 2)}\n`);
    rmSync(join(dir, 'assets', 'materials'), { recursive: true });

    s = open();
    try {
      expect(revision(s)).toBe(rev);
      const upgraded = json(contentPath) as { storageVersion: number; revision: number; content: Record<string, unknown> };
      expect(upgraded.storageVersion).toBe(5);
      expect(upgraded.content['materials']).toBeUndefined();
      expect(upgraded.content['assets']).toEqual([]);
      expect(json(join(dir, 'assets', 'materials', 'stone.material.json'))).toMatchObject({ id: 'stone' });
      expect(json(sidecarPath)).toMatchObject({ tlasset: 2, record: { assetId: 'crate' } });
      // It keeps working: an edit, and the next open reads the files.
      ok(s, 'setMaterial', { material: mat('stone', '#222222') });
    } finally {
      s.close();
    }
    s = open();
    try {
      const cfg = s.query({ op: 'queryGameConfig', projectId: PID }) as unknown as { materials: { params: { color: string } }[] };
      expect(cfg.materials[0]?.params.color).toBe('#222222');
      expect(readdirSync(join(dir, 'assets', 'materials'))).toEqual(['stone.material.json']);
    } finally {
      s.close();
    }
  });
});
