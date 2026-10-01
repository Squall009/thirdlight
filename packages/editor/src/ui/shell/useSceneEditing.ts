/**
 * The Scene view's and the hierarchy's edits: create objects (GameObject
 * menu), delete, rename, move, duplicate, copy and paste, an instance set's
 * copies, the scenes' controls, flags and tags, transforms, undo and redo.
 * Each is an ordinary command through the one client path.
 */
import { useCallback, useRef, type MutableRefObject } from 'react';
import { draggedRoots, subtreeOrder } from '../../session/hierarchy';
import { presetValue } from '../../session/descriptor-fields';
import { withCopy, withoutCopy, type CopyTransform } from '../../session/instance-copies';
import type { DescriptorRegistry, InstanceStroke } from '@thirdlight/project-model';
import type { SceneAction } from '../Hierarchy';
import type { EntityFlag } from '../Inspector';
import { waitFor } from '../wait-for';
import type { ClientRef, ModelsRef, ReportFailure, SetNotice, ViewportRef } from './commands';

export interface SceneEditingDeps {
  clientRef: ClientRef;
  viewportRef: ViewportRef;
  modelInstancesRef: ModelsRef;
  selectedIdRef: MutableRefObject<string | null>;
  selectionRef: MutableRefObject<string[]>;
  setSelectedId: (id: string | null) => void;
  /** Taken before a command is sent: selects what it made when it answers, unless the editor window opened or closed meanwhile. */
  selectLater: () => (id: string | null) => void;
  setSelectedCopy: (index: number | null) => void;
  setNotice: SetNotice;
  reportFailure: ReportFailure;
  registry: DescriptorRegistry | null;
  refreshEntities: () => void;
}

export function useSceneEditing(deps: SceneEditingDeps) {
  const { clientRef, viewportRef, modelInstancesRef, selectedIdRef, selectionRef, setSelectedId, selectLater, setSelectedCopy, setNotice, reportFailure, registry, refreshEntities } = deps;
  // ---- toolbar actions (all delegated to the backend) ---------------------
  const newBox = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    // Spawn where the camera is looking (on the 0.25 m grid) so new boxes don't stack at the origin.
    const focus = viewportRef.current?.focusPoint() ?? [0, 0.5, 0];
    const position = focus.map((v) => Math.round(v * 4) / 4);
    const select = selectLater();
    const res = await c.command(
      'createEntity',
      { kind: 'box', parentId: null, name: `box-${Date.now() % 10000}`, transform: { position } },
      c.projection.revision,
    );
    if (res.ok && res.createdId !== undefined) select(res.createdId);
  }, [clientRef, selectLater, viewportRef]);
  const del = useCallback(async () => {
    const c = clientRef.current;
    if (!c || !selectedIdRef.current) return;
    // A selected copy of an instance set is deleted from its set (the object stays).
    const copy = viewportRef.current?.getSelectedCopy() ?? null;
    if (copy !== null) {
      await editCopiesRef.current.remove(copy.entityId, copy.index);
      return;
    }
    // Every selected subtree (one deleteEntity each; a child of a
    // selected entity goes with it).
    const ids = draggedRoots(c.projection.listEntities(), selectionRef.current.length > 0 ? selectionRef.current : [selectedIdRef.current]);
    for (const entityId of ids) {
      const res = await c.command('deleteEntity', { entityId }, c.projection.revision);
      if (!res.ok) break;
    }
    setSelectedId(null);
  }, [clientRef, selectedIdRef, selectionRef, setSelectedId, viewportRef]);
  const rename = useCallback(async (entityId: string, name: string) => {
    const c = clientRef.current;
    if (!c) return;
    reportFailure('Rename', await c.command('updateEntity', { entityId, name }, c.projection.revision));
  }, [clientRef, reportFailure]);

  // ---- GameObject menu: create at the point the camera looks at -----------
  // (Before the Scene view reports a focus point: [0, 0.5, 0], where a new 1 m
  // box rests on the ground plane — a unit, not a character size.)
  const createEntityAt = useCallback(
    async (what: string, args: Record<string, unknown>, position?: number[]) => {
      const c = clientRef.current;
      if (!c) return;
      const focus = viewportRef.current?.focusPoint() ?? [0, 0.5, 0];
      const at = position ?? focus.map((v) => Math.round(v * 4) / 4);
      const select = selectLater();
      const res = await c.command('createEntity', { parentId: null, transform: { position: at }, ...args }, c.projection.revision);
      if (res.ok && res.createdId !== undefined) select(res.createdId);
      else reportFailure(what, res);
    },
    [clientRef, reportFailure, selectLater, viewportRef],
  );
  const createEmpty = useCallback(() => createEntityAt('Create empty', { kind: 'group', name: `entity-${Date.now() % 10000}` }), [createEntityAt]);
  // The camera and the lights are the descriptor's add value and
  // presets (one table for this menu and "+ Add component").
  const createCamera = useCallback(() => {
    const camera = presetValue(registry, 'camera');
    if (camera === null) return setNotice('Create camera failed: the component defaults have not arrived yet');
    const c = clientRef.current;
    if (!c) return;
    // 4 m in front of the point the Scene view looks at, facing it — the starter camera's framing of the origin.
    const focus = viewportRef.current?.focusPoint() ?? [0, 0.5, 0];
    const at = focus.map((v) => Math.round(v * 4) / 4);
    // createEntity does not add cameras (its component set is closed): an object, then its camera (a setComponent add).
    const select = selectLater();
    void (async () => {
      const made = await c.command('createEntity', { parentId: null, kind: 'group', name: 'Camera', transform: { position: [at[0]!, at[1]!, at[2]! + 4] } }, c.projection.revision);
      if (!made.ok || made.createdId === undefined) return reportFailure('Create camera', made);
      const res = await c.setComponent(made.createdId, 'camera', camera, c.projection.revision);
      if (!res.ok) {
        // Refused (a v4 project keeps exactly one camera in its start scenes): take the empty object away again.
        reportFailure('Create camera', res);
        await c.command('deleteEntity', { entityId: made.createdId }, c.projection.revision);
        return;
      }
      select(made.createdId);
    })();
  }, [clientRef, registry, reportFailure, selectLater, setNotice, viewportRef]);
  const createLight = useCallback(
    (type: 'directional' | 'ambient' | 'point' | 'spot' | 'hemisphere') => {
      const name = `${type.charAt(0).toUpperCase()}${type.slice(1)} light`;
      const light = presetValue(registry, 'light', name);
      if (light === null) return setNotice(`Create ${type} light failed: the component defaults have not arrived yet`);
      return createEntityAt(`Create ${type} light`, { kind: 'group', name, components: { light } }, type === 'directional' ? [0, 10, 0] : type === 'ambient' || type === 'hemisphere' ? [0, 0, 0] : undefined);
    },
    [createEntityAt, registry, setNotice],
  );

  /** The full values of the selection's subtrees (parents first), read from the backend. */
  const selectionValues = useCallback(async (): Promise<Record<string, unknown>[] | null> => {
    const c = clientRef.current;
    if (!c) return null;
    const ids = selectionRef.current.length > 0 ? selectionRef.current : selectedIdRef.current !== null ? [selectedIdRef.current] : [];
    if (ids.length === 0) return null;
    const order = subtreeOrder(c.projection.listEntities(), ids);
    const read = await Promise.all(order.map((id) => c.queryEntity(id)));
    const failed = read.find((r) => !r.ok);
    if (failed !== undefined && !failed.ok) {
      setNotice(`Copy failed: ${failed.error.message}`);
      return null;
    }
    return read.map((r) => (r as { entity: Record<string, unknown> }).entity);
  }, [clientRef, selectedIdRef, selectionRef, setNotice]);

  /** Edit → Duplicate (Ctrl+D): the whole selection with its children, 0.5 m to the right, one undo. */
  const duplicate = useCallback(async () => {
    const c = clientRef.current;
    const values = await selectionValues();
    if (!c || values === null) return;
    const sceneId = c.projection.listEntities().find((e) => e.id === values[0]?.['id'])?.sceneId;
    // The duplicated roots are named "<name> copy" (their children keep their names).
    const ids = new Set(values.map((v) => v['id']));
    const named = values.map((v) => (ids.has(v['parentId']) ? v : { ...v, name: `${String(v['name'] ?? v['id'])} copy`.slice(0, 128) }));
    const select = selectLater();
    const res = await c.command('pasteEntities', { entities: named, offset: [0.5, 0, 0], ...(sceneId !== undefined ? { sceneId } : {}) }, c.projection.revision);
    if (res.ok && res.createdId !== undefined) select(res.createdId);
    else reportFailure('Duplicate', res);
  }, [clientRef, reportFailure, selectionValues, selectLater]);

  /** Edit → Copy (Ctrl+C): remember the selection's values (any scene). */
  const clipboardRef = useRef<Record<string, unknown>[] | null>(null);
  const copySelection = useCallback(async () => {
    const values = await selectionValues();
    if (values === null) return;
    clipboardRef.current = values;
    setNotice(`Copied ${values.length} object${values.length === 1 ? '' : 's'}`);
  }, [selectionValues, setNotice]);

  /** Edit → Paste (Ctrl+V): into the active scene, inside the selected folder if one is selected. */
  const paste = useCallback(async () => {
    const c = clientRef.current;
    const values = clipboardRef.current;
    if (!c || values === null) return;
    const target = selectedIdRef.current !== null ? c.projection.listEntities().find((e) => e.id === selectedIdRef.current) : undefined;
    const parentId = target?.kind === 'folder' ? target.id : null;
    const select = selectLater();
    const res = await c.command('pasteEntities', { entities: values, parentId }, c.projection.revision);
    if (res.ok && res.createdId !== undefined) select(res.createdId);
    else reportFailure('Paste', res);
  }, [clientRef, reportFailure, selectedIdRef, selectLater]);
  const editRef = useRef({ duplicate, copySelection, paste });
  editRef.current = { duplicate, copySelection, paste };

  /**
   * Edit an instance set's copies — the new copy list is
   * published through the buffer route (the one `tl_instance_buffer` uses)
   * and stored with one `setComponent instances` (one undo step).
   */
  const editCopies = async (entityId: string, what: string, make: (floats: Float32Array) => Float32Array | string): Promise<boolean> => {
    const c = clientRef.current;
    const inst = c?.projection.getEntity(entityId)?.instances;
    if (!c || inst === undefined) return false;
    const floats = modelInstancesRef.current?.instanceBuffer(inst.buffer) ?? (await c.instanceBufferBytes(inst.buffer).catch(() => null));
    if (floats === null) {
      setNotice(`${what} failed: the copies are not loaded yet`);
      return false;
    }
    const next = make(floats);
    if (typeof next === 'string') {
      setNotice(`${what}: ${next}`);
      return false;
    }
    const published = await c.publishInstanceBuffer(next);
    if (!published.ok) {
      setNotice(`${what} failed: ${published.error.message}`);
      return false;
    }
    const r = await c.setComponent(entityId, 'instances', { buffer: published.digest, count: published.count }, c.projection.revision);
    if (!r.ok && (r.response as { code?: string }).code === 'no_change') return true;
    reportFailure(what, r);
    return r.ok;
  };
  const editCopiesRef = useRef({
    transform: async (_e: string, _i: number, _t: CopyTransform): Promise<void> => undefined,
    paint: async (_e: string, _s: InstanceStroke): Promise<boolean> => false,
    remove: async (_e: string, _i: number): Promise<void> => undefined,
  });
  editCopiesRef.current = {
    transform: async (entityId, index, t) => {
      await editCopies(entityId, 'Move copy', (f) => withCopy(f, index, t));
    },
    // One instance-brush stroke: one paintInstances (the backend makes the copies; one undo step).
    paint: async (entityId, stroke) => {
      const c = clientRef.current;
      if (!c) return false;
      const r = await c.command('paintInstances', { entityId, ...stroke }, c.projection.revision);
      if (!r.ok && (r.response as { code?: string }).code === 'no_change') {
        setNotice(stroke.mode === 'erase' ? 'Erase: no copies under the stroke' : 'Paint: no place under the stroke takes a copy (nothing that collides there, or copies already within the spacing)');
        return true;
      }
      reportFailure(stroke.mode === 'erase' ? 'Erase' : 'Paint', r);
      return r.ok;
    },
    remove: async (entityId, index) => {
      const ok = await editCopies(entityId, 'Delete copy', (f) => withoutCopy(f, index) ?? 'an instance set keeps at least one copy (delete the object instead)');
      if (ok) {
        viewportRef.current?.setSelectedCopy(null);
        setSelectedCopy(null);
      }
    },
  };

  /** File entities (with their subtrees) under a parent, before a sibling or at the end. */
  const move = useCallback(async (entityIds: string[], parentId: string | null, beforeId: string | null) => {
    const c = clientRef.current;
    if (!c || entityIds.length === 0) return;
    const res = await c.command('moveEntities', { entityIds, parentId, ...(beforeId !== null ? { beforeId } : {}) }, c.projection.revision);
    // Dropping something where it already is changes nothing; not an error.
    if (!res.ok && (res.response as { code?: string }).code === 'no_change') return;
    reportFailure('Move', res);
  }, [clientRef, reportFailure]);
  /** The scene controls (headers, new/open) — index ops are commands, open/active are local. */
  const sceneAction = useCallback(async (action: SceneAction) => {
    const c = clientRef.current;
    if (!c) return;
    switch (action.kind) {
      case 'activate':
        c.setActiveScene(action.sceneId);
        return;
      case 'open':
        c.setSceneOpen(action.sceneId, true);
        return;
      case 'close':
        c.setSceneOpen(action.sceneId, false);
        return;
      case 'create': {
        const taken = new Set(c.projection.scenes.map((r) => r.name));
        let n = c.projection.scenes.length + 1;
        while (taken.has(`Scene ${n}`)) n += 1;
        const before = new Set(c.projection.scenes.map((r) => r.sceneId));
        // A new scene starts from the engine defaults, or copies the look of the scene chosen beside "+ Scene".
        const res = await c.command('createScene', { name: `Scene ${n}`, ...(action.environmentFrom !== undefined ? { environmentFrom: action.environmentFrom } : {}) }, c.projection.revision);
        reportFailure('New scene', res);
        if (res.ok) {
          // The index arrives with mutation.applied; activate the new scene once it is there.
          const created = await waitFor(() => c.projection.scenes.find((r) => !before.has(r.sceneId))?.sceneId ?? null);
          if (created !== null) c.setActiveScene(created);
        }
        return;
      }
      case 'rename':
        reportFailure('Rename scene', await c.command('renameScene', { sceneId: action.sceneId, name: action.name }, c.projection.revision));
        return;
      case 'delete':
        reportFailure('Delete scene', await c.command('deleteScene', { sceneId: action.sceneId }, c.projection.revision));
        return;
      case 'toggleStart': {
        const start = c.projection.startScenes;
        const next = start.includes(action.sceneId) ? start.filter((id) => id !== action.sceneId) : [...start, action.sceneId];
        if (next.length === 0) {
          setNotice('The game needs at least one start scene.');
          return;
        }
        reportFailure('Start scenes', await c.command('setStartScenes', { sceneIds: next }, c.projection.revision));
        return;
      }
    }
  }, [clientRef, reportFailure, setNotice]);
  /** Set an entity's own tags, by name. */
  const setEntityTags = useCallback(async (entityId: string, names: string[]) => {
    const c = clientRef.current;
    if (!c) return;
    reportFailure('Set tags', await c.command('updateEntity', { entityId, tags: names }, c.projection.revision));
  }, [clientRef, reportFailure]);
  /** Set one hierarchy flag (active / locked / static) on an entity. */
  const setFlag = useCallback(async (entityId: string, flag: EntityFlag, value: boolean) => {
    const c = clientRef.current;
    if (!c) return;
    reportFailure(`Set ${flag}`, await c.command('updateEntity', { entityId, [flag]: value }, c.projection.revision));
  }, [clientRef, reportFailure]);
  /** GameObject → Folder: inside the selected folder, else at the root. */
  const createFolder = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    const sel = selectedIdRef.current !== null ? c.projection.getEntity(selectedIdRef.current) : undefined;
    const parentId = sel?.kind === 'folder' ? sel.id : null;
    const select = selectLater();
    const res = await c.command('createEntity', { kind: 'folder', name: 'Folder', parentId }, c.projection.revision);
    if (res.ok && res.createdId !== undefined) select(res.createdId);
    else reportFailure('Create folder', res);
  }, [clientRef, reportFailure, selectedIdRef, selectLater]);
  const editTransform = useCallback(async (entityId: string, patch: { position?: number[]; rotation?: number[]; scale?: number[] }) => {
    const c = clientRef.current;
    if (!c) return;
    const res = await c.command('setTransform', { entityId, transform: patch }, c.projection.revision);
    if (!res.ok) refreshEntities();
    reportFailure('Transform edit', res);
  }, [clientRef, refreshEntities, reportFailure]);
  const undo = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    await c.command('undo', {}, c.projection.revision);
  }, [clientRef]);
  const redo = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    await c.command('redo', {}, c.projection.revision);
  }, [clientRef]);

  return {
    newBox, del, rename, createEntityAt, createEmpty, createCamera, createLight, duplicate, clipboardRef, copySelection, paste, editRef, editCopiesRef,
    move, sceneAction, setEntityTags, setFlag, createFolder, editTransform, undo, redo,
  };
}

export type SceneEditing = ReturnType<typeof useSceneEditing>;
