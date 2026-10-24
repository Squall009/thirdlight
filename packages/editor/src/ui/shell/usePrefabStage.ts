/**
 * A prefab opened on its own (its stage): the objects the prefab edit mode
 * shows and edits.
 *
 * The backend assembles the stage (`queryPrefabs` with `stage`): a copy of
 * the prefab that no scene holds, whose objects' ids the ordinary commands
 * name to change the prefab itself. The editor draws and inspects them as it
 * does a scene's objects (their `sceneId` is `PREFAB_STAGE_SCENE`, which no
 * scene has), and reads the stage again after every applied change while it
 * is open, so an edit, an undo or an MCP edit of the prefab shows in it as it
 * shows in every copy. An object that did not change keeps its projected
 * object, so the Scene view redraws only what did.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { toProjected, type ProjectedEntity } from '../../session/projection';
import type { ClientRef } from './commands';

/** The `sceneId` of a prefab stage's objects (no scene id can start with `~`). */
export const PREFAB_STAGE_SCENE = '~prefab-stage';

export interface PrefabStage {
  readonly prefabId: string;
  readonly rootId: string;
  readonly entities: readonly ProjectedEntity[];
}

/** Whether an object is one of a prefab stage's. */
export const onPrefabStage = (e: { sceneId?: string } | null | undefined): boolean => e?.sceneId === PREFAB_STAGE_SCENE;

export function usePrefabStage(clientRef: ClientRef, revision: number) {
  const [stage, setStage] = useState<PrefabStage | null>(null);
  const stageRef = useRef(stage);
  stageRef.current = stage;
  /** The read last asked for: an older answer arriving late is dropped. */
  const asked = useRef(0);

  const read = useCallback(
    async (prefabId: string): Promise<PrefabStage | null> => {
      const c = clientRef.current;
      if (c === null) return null;
      const n = ++asked.current;
      const r = await c.queryPrefabs({ prefabId, stage: true, limit: 1 }).catch(() => null);
      if (n !== asked.current) return stageRef.current;
      const got = r?.stage;
      if (got === undefined) {
        setStage(null);
        return null;
      }
      const was = new Map((stageRef.current?.prefabId === prefabId ? stageRef.current.entities : []).map((e) => [e.id, e]));
      const entities = got.entities.map((raw) => {
        const p: ProjectedEntity = { ...toProjected(raw), sceneId: PREFAB_STAGE_SCENE };
        const old = was.get(p.id);
        return old !== undefined && JSON.stringify(old) === JSON.stringify(p) ? old : p;
      });
      const same = stageRef.current !== null && stageRef.current.prefabId === prefabId && entities.length === stageRef.current.entities.length && entities.every((e, i) => e === stageRef.current!.entities[i]);
      const next = same ? stageRef.current! : { prefabId, rootId: got.rootId, entities };
      setStage(next);
      return next;
    },
    [clientRef],
  );

  /** Open a prefab's stage; its root's id once read (null: no such prefab). */
  const open = useCallback(async (prefabId: string): Promise<string | null> => (await read(prefabId))?.rootId ?? null, [read]);
  const close = useCallback(() => {
    asked.current++;
    setStage(null);
  }, []);

  /** Read the open stage again now: an object a command just made in it is there once this resolves. */
  const refresh = useCallback(async (): Promise<void> => {
    const id = stageRef.current?.prefabId;
    if (id !== undefined) await read(id);
  }, [read]);

  // Every applied change may have changed the prefab (an edit, an undo, an MCP edit, a nested prefab's edit).
  const prefabId = stage?.prefabId ?? null;
  useEffect(() => {
    if (prefabId !== null) void read(prefabId);
  }, [prefabId, revision, read]);

  return { stage, open, close, refresh };
}

export type PrefabStageHost = ReturnType<typeof usePrefabStage>;
