/**
 * The project window's file operations through the real service and
 * filesystem: `createFolder`, `moveResources` (items and folders) and
 * `renameFolder` move the files (an asset with its sidecar, a resource file,
 * a scene file, and whatever else is in a moved folder), each as one undo;
 * ids stay, the index follows, a reopen finds everything where it went; a
 * taken target or a folder moved into itself is refused. `queryIndex` pages
 * one folder, sorts, and lists a folder's subfolders.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { openWorkspaceService } from './service';
import type { StageInspector, WorkspaceService } from './index';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

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

function project(tag: string): { dir: string; open: () => WorkspaceService } {
  const root = join(tmpdir(), `tl-moves-${tag}-${process.pid}-${Date.now().toString(36)}-${roots.length}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  const open = (): WorkspaceService => openWorkspaceService({ root, assetInspector: stubInspector });
  const s = open();
  expect(s.createProject(PID, 'Demo').ok).toBe(true);
  s.close();
  return { dir: join(root, 'projects', PID), open };
}

function revision(s: WorkspaceService): number {
  return (s.query({ op: 'queryProject', projectId: PID }) as unknown as { revision: number }).revision;
}
type Result = { ok: boolean; error?: { code: string; message?: string }; change?: Record<string, unknown> };
function run(s: WorkspaceService, op: string, args: Record<string, unknown>): Result {
  seq += 1;
  return s.runCommand({ op, projectId: PID, expectedRevision: revision(s), requestId: `req-${(0xb000 + seq).toString(16).padStart(32, '0')}`, args }) as unknown as Result;
}
function ok(s: WorkspaceService, op: string, args: Record<string, unknown>): Result {
  const r = run(s, op, args);
  expect(r.ok, JSON.stringify(r).slice(0, 600)).toBe(true);
  return r;
}
const mat = (id: string): Record<string, unknown> => ({ materialId: id, name: id, shader: 'standard', params: { color: '#808080' }, textures: {} });
function index(s: WorkspaceService, args: Record<string, unknown>): { total: number; entries: { kind: string; id: string; path: string; name: string }[]; folders?: { path: string; name: string; hasFolders: boolean }[] } {
  const r = s.query({ op: 'queryIndex', projectId: PID, args: { refs: false, ...args } }) as unknown as { ok: boolean; total: number; entries: { kind: string; id: string; path: string; name: string }[] };
  expect(r.ok, JSON.stringify(r).slice(0, 400)).toBe(true);
  return r;
}
const pathOf = (s: WorkspaceService, kind: string, id: string): string | undefined => index(s, { kind, id }).entries[0]?.path;

/** A project with an asset (assets/Crate.glb), a material and a scene in levels/. */
function stocked(tag: string): { dir: string; open: () => WorkspaceService } {
  const p = project(tag);
  const s = p.open();
  try {
    s.holdAssetBytes(PID, CRATE);
    ok(s, 'publishAsset', { mode: 'create', assetId: 'crate', kind: 'model', displayName: 'Crate', sourceDigest: sha(CRATE), sourceByteLength: CRATE.length, importRecipe: RECIPE, metrics: METRICS, importedAt: '2026-09-30T10:00:00Z' });
    ok(s, 'setMaterial', { material: mat('stone') });
    ok(s, 'createScene', { name: 'Level 1', sceneId: 'level-1', folder: 'levels' });
    ok(s, 'createEntity', { kind: 'model', name: 'Crate', model: { asset: { assetId: 'crate' } } });
  } finally {
    s.close();
  }
  return p;
}

describe('moving files and folders in the game folder', () => {
  it('moves an asset with its sidecar, a resource file and a scene file into a new folder, one undo, and a reopen finds them there', () => {
    const { dir, open } = stocked('items');
    let s = open();
    try {
      expect(pathOf(s, 'model', 'crate')).toBe('assets/Crate.glb');
      expect(pathOf(s, 'material', 'stone')).toBe('assets/materials/stone.material.json');
      ok(s, 'createFolder', { folder: 'props/big' });
      expect(existsSync(join(dir, 'props', 'big'))).toBe(true);
      const r = ok(s, 'moveResources', { items: [{ kind: 'model', id: 'crate' }, { kind: 'material', id: 'stone' }, { kind: 'scene', id: 'level-1' }], to: 'props/big' });
      expect((r.change as { type: string }).type).toBe('moveResources');
      for (const f of ['Crate.glb', 'Crate.glb.tlasset', 'stone.material.json', 'level-1.scene.json']) expect(existsSync(join(dir, 'props', 'big', f)), f).toBe(true);
      for (const f of ['assets/Crate.glb', 'assets/Crate.glb.tlasset', 'assets/materials/stone.material.json', 'levels/level-1.scene.json']) expect(existsSync(join(dir, f)), f).toBe(false);
      expect(readFileSync(join(dir, 'props', 'big', 'Crate.glb'))).toEqual(Buffer.from(CRATE));
      expect(pathOf(s, 'model', 'crate')).toBe('props/big/Crate.glb');
      expect(pathOf(s, 'material', 'stone')).toBe('props/big/stone.material.json');
      expect(pathOf(s, 'scene', 'level-1')).toBe('props/big/level-1.scene.json');
      // The object still names the asset by id.
      const entities = (s.query({ op: 'queryEntities', projectId: PID }) as unknown as { entities: { components: { model?: { asset: { assetId: string } } } }[] }).entities;
      expect(entities.some((e) => e.components.model?.asset.assetId === 'crate')).toBe(true);
      // One undo puts all three back.
      ok(s, 'undo', {});
      expect(existsSync(join(dir, 'assets', 'Crate.glb'))).toBe(true);
      expect(existsSync(join(dir, 'assets', 'Crate.glb.tlasset'))).toBe(true);
      expect(existsSync(join(dir, 'assets', 'materials', 'stone.material.json'))).toBe(true);
      expect(existsSync(join(dir, 'levels', 'level-1.scene.json'))).toBe(true);
      expect(existsSync(join(dir, 'props', 'big', 'Crate.glb'))).toBe(false);
      expect(pathOf(s, 'material', 'stone')).toBe('assets/materials/stone.material.json');
      ok(s, 'redo', {});
      expect(pathOf(s, 'model', 'crate')).toBe('props/big/Crate.glb');
    } finally {
      s.close();
    }
    s = open();
    try {
      expect(pathOf(s, 'model', 'crate')).toBe('props/big/Crate.glb');
      expect(pathOf(s, 'material', 'stone')).toBe('props/big/stone.material.json');
      expect(pathOf(s, 'scene', 'level-1')).toBe('props/big/level-1.scene.json');
      expect(s.takeOpenProblems(PID)).toEqual([]);
    } finally {
      s.close();
    }
  });

  it('renames and moves whole folders with the files the project does not track, one undo each', () => {
    const { dir, open } = stocked('folders');
    const s = open();
    try {
      ok(s, 'moveResources', { items: [{ kind: 'asset', id: 'crate' }, { kind: 'material', id: 'stone' }], to: 'props' });
      writeFileSync(join(dir, 'props', 'notes.txt'), 'kept with the folder');
      mkdirSync(join(dir, 'props', 'empty'));
      ok(s, 'renameFolder', { folder: 'props', name: 'things' });
      expect(existsSync(join(dir, 'props'))).toBe(false);
      for (const f of ['Crate.glb', 'Crate.glb.tlasset', 'stone.material.json', 'notes.txt', 'empty']) expect(existsSync(join(dir, 'things', f)), f).toBe(true);
      expect(pathOf(s, 'model', 'crate')).toBe('things/Crate.glb');
      ok(s, 'moveResources', { folders: ['things'], to: 'assets' });
      expect(existsSync(join(dir, 'assets', 'things', 'notes.txt'))).toBe(true);
      expect(pathOf(s, 'material', 'stone')).toBe('assets/things/stone.material.json');
      ok(s, 'undo', {});
      ok(s, 'undo', {});
      expect(existsSync(join(dir, 'props', 'notes.txt'))).toBe(true);
      expect(existsSync(join(dir, 'props', 'empty'))).toBe(true);
      expect(existsSync(join(dir, 'things'))).toBe(false);
      expect(pathOf(s, 'model', 'crate')).toBe('props/Crate.glb');
      // A made folder goes with its undo (when it is still empty).
      ok(s, 'createFolder', { folder: 'fresh' });
      expect(existsSync(join(dir, 'fresh'))).toBe(true);
      ok(s, 'undo', {});
      expect(existsSync(join(dir, 'fresh'))).toBe(false);
    } finally {
      s.close();
    }
  });

  it('refuses a taken target, a folder into itself, and what the project does not have', () => {
    const { dir, open } = stocked('refusals');
    const s = open();
    try {
      mkdirSync(join(dir, 'props'), { recursive: true });
      writeFileSync(join(dir, 'props', 'Crate.glb'), 'another file');
      const before = revision(s);
      const cases: [string, Record<string, unknown>][] = [
        ['moveResources', { items: [{ kind: 'model', id: 'crate' }], to: 'props' }],
        ['moveResources', { folders: ['levels'], to: 'levels/inner' }],
        ['moveResources', { items: [{ kind: 'material', id: 'nope' }], to: 'props' }],
        ['moveResources', { items: [{ kind: 'material', id: 'stone' }], to: '.hidden' }],
        ['renameFolder', { folder: 'levels', name: 'props' }],
        ['createFolder', { folder: 'props' }],
      ];
      for (const [op, args] of cases) {
        const r = run(s, op, args);
        expect(r.ok, JSON.stringify(args)).toBe(false);
      }
      const bad = run(s, 'moveResources', { to: 'props' });
      expect(bad.error?.code).toBe('field_value');
      expect(revision(s)).toBe(before);
      expect(pathOf(s, 'model', 'crate')).toBe('assets/Crate.glb');
    } finally {
      s.close();
    }
  });

  it('pages one folder, sorts, and lists subfolders', () => {
    const { open } = stocked('query');
    const s = open();
    try {
      ok(s, 'setMaterial', { material: mat('brick') });
      ok(s, 'createFolder', { folder: 'assets/empty' });
      const top = index(s, { folder: '', folders: true });
      expect(top.total).toBe(0);
      expect(top.folders?.map((f) => f.path)).toEqual(expect.arrayContaining(['assets', 'levels']));
      expect(top.folders?.find((f) => f.path === 'assets')?.hasFolders).toBe(true);
      const assets = index(s, { folder: 'assets', folders: true });
      expect(assets.entries.map((e) => e.id)).toEqual(['crate']);
      expect(assets.folders?.map((f) => f.path)).toEqual(["assets/empty", "assets/materials"]);
      const deep = index(s, { folder: 'assets', recursive: true, sort: 'name' });
      expect(deep.entries.map((e) => e.id)).toEqual(['brick', 'crate', 'stone']);
      const down = index(s, { folder: 'assets', recursive: true, sort: 'name', descending: true });
      expect(down.entries.map((e) => e.id)).toEqual(['stone', 'crate', 'brick']);
      const byKind = index(s, { folder: 'assets', recursive: true, sort: 'kind' });
      expect(byKind.entries.map((e) => e.kind)).toEqual(['material', 'material', 'model']);
      expect(run(s, 'setLabels', { items: [{ kind: 'material', id: 'brick' }, { kind: 'asset', id: 'crate' }], add: ['wall', 'heavy'] }).ok).toBe(true);
      expect(index(s, { labels: ['wall', 'heavy'] }).entries.map((e) => e.id)).toEqual(['brick', 'crate']);
      const wrong = s.query({ op: 'queryIndex', projectId: PID, args: { sort: 'size' } }) as unknown as { ok: boolean };
      expect(wrong.ok).toBe(false);
    } finally {
      s.close();
    }
  });
});
