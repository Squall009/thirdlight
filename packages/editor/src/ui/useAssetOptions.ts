/**
 * The asset inspector's options (the Assets tab's side panel): a model's
 * vertex colours and default materials, an audio file's load type and
 * preload. Each change is one `setAssetOptions` command (one undo).
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
  return { setAssetMaterials, setVertexColors, setAudioLoadType, setAudioPreload };
}
