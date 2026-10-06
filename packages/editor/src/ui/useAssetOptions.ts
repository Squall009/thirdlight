/**
 * The asset inspector's options (the Assets tab's side panel): a model's
 * vertex colours and default materials, an audio file's load type and
 * preload, a texture's mip streaming, a model's LOD switch points and cull size. Each change is one `setAssetOptions` command (one undo).
 */
import { useCallback, type MutableRefObject } from 'react';

import type { SessionClient } from '../session/client';

export type AudioLoadTypeChoice = 'decode-on-load' | 'decode-while-playing' | 'stream' | null;

export function useAssetOptions(clientRef: MutableRefObject<SessionClient | null>, reportFailure: (what: string, res: Awaited<ReturnType<SessionClient['command']>>) => void) {
  const setOptions = useCallback(
    async (what: string, args: Record<string, unknown>) => {
      const c = clientRef.current;
      if (!c) return;
      reportFailure(what, await c.command('setAssetOptions', args, c.projection.revision));
    },
    [clientRef, reportFailure],
  );
  const setAssetMaterials = useCallback((assetId: string, mapping: Record<string, string> | null) => setOptions('Default materials', { assetId, materials: mapping }), [setOptions]);
  const setVertexColors = useCallback((assetId: string, mode: 'data' | 'tint') => setOptions('Vertex colours', { assetId, vertexColors: mode }), [setOptions]);
  /** Null: the default for the file's length. */
  const setAudioLoadType = useCallback((assetId: string, loadType: AudioLoadTypeChoice) => setOptions('Audio load type', { assetId, loadType }), [setOptions]);
  const setAudioPreload = useCallback((assetId: string, preload: boolean) => setOptions('Audio preload', { assetId, preload }), [setOptions]);
  /** Null: the default for the texture's size. */
  const setTextureStreaming = useCallback((assetId: string, streaming: boolean | null) => setOptions('Texture streaming', { assetId, streaming }), [setOptions]);
  /** Null: the engine's default switch points, never culled. */
  const setModelLod = useCallback((assetId: string, lod: { screenSizes?: number[]; cullSize?: number } | null) => setOptions('Levels of detail', { assetId, lod }), [setOptions]);
  return { setAssetMaterials, setVertexColors, setAudioLoadType, setAudioPreload, setTextureStreaming, setModelLod };
}

export type AssetOptionActions = ReturnType<typeof useAssetOptions>;
