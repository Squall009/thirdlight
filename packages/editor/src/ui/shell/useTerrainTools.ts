/**
 * Terrain editing's wiring: the Scene view's terrain tools (a stroke is one
 * `editTerrain`, stored on release), a new terrain object, and the panel's
 * commands (a heightmap staged and imported, a block layer converted).
 */
import { useCallback, useState } from 'react';
import { TERRAIN_TILE_SAMPLES_DEFAULT, terrainTileSize, type TerrainComponent } from '@thirdlight/runtime';
import type { SessionClient } from '../../session/client';
import type { TerrainEditor } from '../../viewport/terrain-editor';
import type { ClientRef, ReportFailure, SetNotice, ViewportRef } from './commands';

/** A new terrain: 2 × 2 tiles of 257 samples a metre apart (512 m square, centred on the origin), heights −128 to 384 m. */
export const NEW_TERRAIN: TerrainComponent = Object.freeze({
  tileSamples: TERRAIN_TILE_SAMPLES_DEFAULT,
  spacing: 1,
  heightRange: [-128, 384],
  tiles: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 0, z: 1 }, { x: 1, z: 1 }],
}) as TerrainComponent;

export interface TerrainToolsDeps {
  clientRef: ClientRef;
  viewportRef: ViewportRef;
  reportFailure: ReportFailure;
  setNotice: SetNotice;
  select: (id: string) => void;
}

export function useTerrainTools(deps: TerrainToolsDeps) {
  const { clientRef, viewportRef, reportFailure, setNotice, select } = deps;
  const [terrainEditor, setTerrainEditor] = useState<TerrainEditor | null>(null);

  /** The Scene view's terrain tools (made once with the session's client). */
  const makeTerrainEditor = useCallback((client: SessionClient) => {
    const ed = viewportRef.current?.terrainEditor({
      onCommit: async (args) => {
        const r = await client.command('editTerrain', args, client.projection.revision);
        if (!r.ok) {
          const res = r.response as { code?: string; message?: string };
          if (res.code !== 'no_change') setNotice(`Terrain edit failed: ${res.message ?? res.code ?? 'unknown error'}`);
          return null;
        }
        return r.terrain?.tiles ?? [];
      },
      onRefused: (message) => setNotice(message),
    });
    setTerrainEditor(ed ?? null);
  }, [viewportRef, setNotice]);

  /** A command of the panel (true: stored). */
  const terrainRun = useCallback(async (what: string, op: string, args: Record<string, unknown>): Promise<boolean> => {
    const c = clientRef.current;
    if (!c) return false;
    const r = await c.command(op, args, c.projection.revision);
    if (!r.ok && (r.response as { code?: string }).code === 'no_change') {
      setNotice(`${what}: nothing changed`);
      return false;
    }
    reportFailure(what, r);
    return r.ok;
  }, [clientRef, reportFailure, setNotice]);

  /** Stage a file for an import (its stage id; null: the upload failed, said in a notice). */
  const stageFile = useCallback(async (bytes: Uint8Array): Promise<string | null> => {
    const c = clientRef.current;
    if (!c) return null;
    const s = await c.stageBytes(bytes);
    if (!s.ok) {
      setNotice(`Upload failed: ${s.error.message}`);
      return null;
    }
    return s.stageId;
  }, [clientRef, setNotice]);

  /** A new terrain object (selected, so its tools show). */
  const createTerrain = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    const half = terrainTileSize(NEW_TERRAIN);
    const res = await c.command('createEntity', { parentId: null, kind: 'group', name: 'Terrain', transform: { position: [-half, 0, -half] } }, c.projection.revision);
    if (!res.ok || res.createdId === undefined) return reportFailure('New terrain', res);
    const id = res.createdId;
    reportFailure('New terrain', await c.command('setComponent', { entityId: id, component: 'terrain', value: NEW_TERRAIN }, c.projection.revision));
    select(id);
  }, [clientRef, reportFailure, select]);

  return { terrainEditor, makeTerrainEditor, terrainRun, stageFile, createTerrain };
}

export type TerrainTools = ReturnType<typeof useTerrainTools>;
