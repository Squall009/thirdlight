/**
 * The project's settings as their panels edit them: the settings registry
 * (Gameplay), input actions, tags, collision and light layers, the save schema, game
 * modes and behavior groups, the game shell and the event → sound table.
 * Each save is one ordinary command; `receive` copies the values from the
 * session client after every applied change.
 */
import { useCallback, useState, type MutableRefObject } from 'react';
import type { EventCue, GameMode, GameShell, InputConfig, SaveSchema } from '@thirdlight/project-model';
import type { SessionClient } from '../../session/client';
import { mergeDocumentEdit, mergeListEdit } from '../../session/own-commands';
import type { GameplayBackendError } from '../GameplayPanel';
import { commandError, refusal } from './commands';
import type { Stable } from './useProjectContent';

/**
 * `refreshRef` holds the editor's refresh (a saved setting shows at once); it
 * is read when a save lands, so it may be filled in after this hook runs.
 */
export function useProjectSettings(clientRef: MutableRefObject<SessionClient | null>, refreshRef: MutableRefObject<() => void>) {
  // The settings registry and the last refused save.
  const [gameplayError, setGameplayError] = useState<GameplayBackendError | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  /** The project tag registry and the last setTags error. */
  const [tags, setTags] = useState<{ bit: number; name: string }[]>([]);
  const [tagsError, setTagsError] = useState<string | null>(null);
  /** The named collision layers and the last setCollisionLayers error. */
  const [collisionLayers, setCollisionLayers] = useState<string[]>([]);
  /** The project save schema and the last setSaveSchema error. */
  const [saveSchema, setSaveSchema] = useState<SaveSchema | null>(null);
  const [saveSchemaError, setSaveSchemaError] = useState<string | null>(null);
  const [layersError, setLayersError] = useState<string | null>(null);
  /** The light layer names and the last setLightLayers error. */
  const [lightLayers, setLightLayers] = useState<string[]>([]);
  const [lightLayersError, setLightLayersError] = useState<string | null>(null);
  /** The game modes, the behavior groups and the last setModes / setBehaviorGroups error. */
  const [modes, setModes] = useState<GameMode[]>([]);
  const [behaviorGroups, setBehaviorGroups] = useState<string[]>([]);
  const [modesError, setModesError] = useState<string | null>(null);
  /** The game shell and the last setShell error. */
  const [shell, setShell] = useState<GameShell | null>(null);
  const [shellError, setShellError] = useState<string | null>(null);
  /** The event → cue table and the last setEventCues error. */
  const [eventCues, setEventCues] = useState<EventCue[]>([]);
  const [eventCuesError, setEventCuesError] = useState<string | null>(null);
  // The input actions (null = the defaults).
  const [inputConfig, setInputConfig] = useState<InputConfig | null>(null);
  const [inputDefaults, setInputDefaults] = useState<InputConfig>({ actions: [] });
  const [inputError, setInputError] = useState<string | null>(null);
  /** Replace the tag registry (one setTags command). */
  const saveTags = useCallback(async (next: { bit?: number; name: string }[]) => {
    const c = clientRef.current;
    if (!c) return;
    const res = await c.command('setTags', { tags: next }, c.projection.revision);
    if (res.ok) setTagsError(null);
    else setTagsError((res.response as { message?: string }).message ?? 'the tags could not be saved');
  }, [clientRef]);
  /** Replace the named collision layers (one setCollisionLayers command). */
  const saveCollisionLayers = useCallback(async (next: string[]) => {
    const c = clientRef.current;
    if (!c) return;
    const res = await c.command('setCollisionLayers', { layers: next }, c.projection.revision);
    if (res.ok) setLayersError(null);
    else setLayersError((res.response as { message?: string }).message ?? 'the collision layers could not be saved');
  }, [clientRef]);
  /** Replace the light layer names (one setLightLayers command). */
  const saveLightLayers = useCallback(async (next: string[]) => {
    const c = clientRef.current;
    if (!c) return;
    const res = await c.command('setLightLayers', { layers: next }, c.projection.revision);
    if (res.ok) setLightLayersError(null);
    else setLightLayersError((res.response as { message?: string }).message ?? 'the light layer names could not be saved');
  }, [clientRef]);
  /** Replace the game modes (one setModes command) or the behavior groups (one setBehaviorGroups). */
  const saveModes = useCallback(async (next: GameMode[]) => {
    const c = clientRef.current;
    if (!c) return;
    const res = await c.command('setModes', { modes: next }, c.projection.revision);
    if (res.ok) setModesError(null);
    else setModesError((res.response as { message?: string }).message ?? 'the game modes could not be saved');
  }, [clientRef]);
  const saveBehaviorGroups = useCallback(async (next: string[]) => {
    const c = clientRef.current;
    if (!c) return;
    const res = await c.command('setBehaviorGroups', { groups: next }, c.projection.revision);
    if (res.ok) setModesError(null);
    else setModesError((res.response as { message?: string }).message ?? 'the behavior groups could not be saved');
  }, [clientRef]);
  /**
   * Replace the game shell (one setShell command; null removes it). The
   * args are built at send time on top of the shell as it is then (an edit made while an earlier
   * one's result is still on its way keeps both).
   */
  const saveShell = useCallback(async (next: GameShell | null, base: GameShell | null) => {
    const c = clientRef.current;
    if (!c) return;
    const build = (): { shell: GameShell | null } => ({ shell: next === null ? null : (mergeDocumentEdit(base, next, c.getShell()) ?? next) });
    const res = await c.command('setShell', build, c.projection.revision);
    if (res.ok) setShellError(null);
    else setShellError((res.response as { message?: string }).message ?? 'the game shell could not be saved');
  }, [clientRef]);
  /** Replace the event → cue table (one setEventCues command; built at send time, row by row on the table as it is then). */
  const saveEventCues = useCallback(async (next: EventCue[], base: EventCue[]) => {
    const c = clientRef.current;
    if (!c) return;
    const build = (): { cues: EventCue[] } => ({ cues: mergeListEdit(base, next, c.getEventCues()) });
    const res = await c.command('setEventCues', build, c.projection.revision);
    if (res.ok) setEventCuesError(null);
    else setEventCuesError((res.response as { message?: string }).message ?? 'the event sounds could not be saved');
  }, [clientRef]);
  /** Replace the project save schema (one setSaveSchema command; null removes it). */
  const saveSaveSchema = useCallback(async (next: SaveSchema | null) => {
    const c = clientRef.current;
    if (!c) return;
    const res = await c.command('setSaveSchema', { schema: next }, c.projection.revision);
    if (res.ok) setSaveSchemaError(null);
    else setSaveSchemaError((res.response as { message?: string }).message ?? 'the save schema could not be saved');
  }, [clientRef]);
  // The settings registry (one setSettings command).
  const saveSettings = useCallback(
    async (settings: Record<string, number>) => {
      const c = clientRef.current;
      if (!c) return;
      setGameplayError(null);
      const res = await c.setSettings(settings, c.projection.revision);
      if (res.ok) {
        refreshRef.current();
        return;
      }
      setGameplayError(commandError(res));
    },
    [clientRef, refreshRef],
  );
  const saveInput = useCallback(async (input: InputConfig | null) => {
    const c = clientRef.current;
    if (!c) return;
    setInputError(refusal(await c.command('setInput', { input }, c.projection.revision)));
  }, [clientRef]);

  /** Copies the settings from the client (the backend stays the sole authority). */
  const receive = useCallback((c: SessionClient, stable: Stable) => {
    setSettings(stable('settings', c.getSettings()));
    setTags(stable('tags', c.getTags()));
    setCollisionLayers(stable('collisionLayers', c.getCollisionLayers()));
    setLightLayers(stable('lightLayers', c.getLightLayers()));
    setModes(stable('modes', c.getModes()));
    setBehaviorGroups(stable('behaviorGroups', c.getBehaviorGroups()));
    setEventCues(stable('eventCues', c.getEventCues()));
    setShell(stable('shell', c.getShell()));
    setSaveSchema(stable('saveSchema', c.getSaveSchema()));
    setInputConfig(stable('inputConfig', c.getInput()));
    setInputDefaults(stable('inputDefaults', c.getInputDefaults()));
  }, []);

  return {
    settings, gameplayError, setGameplayError, saveSettings, tags, tagsError, saveTags, collisionLayers, layersError, saveCollisionLayers,
    lightLayers, lightLayersError, saveLightLayers,
    saveSchema, saveSchemaError, saveSaveSchema, modes, behaviorGroups, modesError, saveModes, saveBehaviorGroups, shell, shellError, saveShell,
    eventCues, eventCuesError, saveEventCues, inputConfig, inputDefaults, inputError, saveInput, receive,
  };
}

export type ProjectSettings = ReturnType<typeof useProjectSettings>;
