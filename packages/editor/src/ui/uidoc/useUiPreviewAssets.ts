/**
 * What the UI preview draws with: the textures and fonts the project's UI
 * documents and themes name, read by id (their summaries give the version
 * the bytes are read at) — not every texture and font of the project.
 *
 * Browser-only (React).
 */
import { useEffect, useMemo, type RefObject } from 'react';
import type { UiDocument, UiTheme } from '@thirdlight/project-model';

import type { SessionClient } from '../../session/client';
import { stringsIn } from '../catalog/catalog-context';
import type { PreviewAssets } from './UiPreview';

export function useUiPreviewAssets(clientRef: RefObject<SessionClient | null>, documents: readonly UiDocument[], themes: readonly UiTheme[], catalogTick: number): PreviewAssets {
  const named = useMemo(() => [...new Set(stringsIn([documents, themes]))].sort(), [documents, themes]);
  const namedKey = named.join('\u0000');
  useEffect(() => {
    if (namedKey !== '') void clientRef.current?.catalog.ensureAssets(namedKey.split('\u0000'));
  }, [namedKey, catalogTick, clientRef]);
  // `id@version` for each named texture or font read so far (a new version is a new path).
  const c = clientRef.current;
  const key = named
    .map((id) => c?.content.getAsset(id))
    .filter((a) => a !== undefined && (a.kind === 'texture' || a.kind === 'font'))
    .map((a) => `${a!.assetId}@${a!.currentVersion}`)
    .join('|');
  return useMemo(
    () => ({
      paths: Object.fromEntries(key === '' ? [] : key.split('|').map((k) => [k.slice(0, k.lastIndexOf('@')), k] as const)),
      read: async (path: string): Promise<ArrayBuffer> => {
        const at = path.lastIndexOf('@');
        const client = clientRef.current;
        if (client === null || at < 0) throw new Error('not connected');
        const bytes = await client.assetBytes(path.slice(0, at), Number(path.slice(at + 1)));
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      },
    }),
    [key, clientRef],
  );
}
