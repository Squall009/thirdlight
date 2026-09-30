/**
 * The project window's state the editor shares: the chosen folder — where
 * new scenes and resources are created (Unity's Create menu uses the project
 * window's folder) and where uploads land — its file commands, and what a
 * double-click opens for each kind of item.
 *
 * Browser-only (React).
 */
import { useCallback, useState, type MutableRefObject } from 'react';

import { DEFAULT_UPLOAD_FOLDER } from '../../session/folder-upload';

import type { SessionClient } from '../../session/client';
import { documentOfItem, isAssetKind, type ProjectItem } from '../../session/project-items';
import { useProjectCommands, type ProjectCommands } from './useProjectCommands';

/** What a double-click on an item needs from the editor. */
export interface ProjectOpeners {
  /** Open a document tab (material, timeline, script, …). */
  openDocument(kind: string, id: string): void;
  /** Whether a behavior is a visual script (it opens as a graph). */
  isVisualScript(behaviorId: string): boolean;
  /** Open a scene in the Scene view and make it the active one. */
  openScene(sceneId: string): void;
  /** Show a prefab in the Prefabs panel. */
  showPrefab(prefabId: string): void;
  /** Show the environment panel (its presets). */
  showEnvironment(): void;
  /** Choose an asset and realize its preview. */
  previewAsset(assetId: string): void;
}

export interface ProjectWindowState {
  readonly folder: string | null;
  setFolder(folder: string | null): void;
  readonly commands: ProjectCommands;
  open(item: ProjectItem): void;
}

export function useProjectWindow(clientRef: MutableRefObject<SessionClient | null>, onUploadFolder: (folder: string) => void, openers: ProjectOpeners): ProjectWindowState {
  const [folder, setFolderState] = useState<string | null>(null);
  const commands = useProjectCommands(clientRef);
  const setFolder = useCallback(
    (f: string | null) => {
      setFolderState(f);
      clientRef.current?.setNewResourceFolder(f ?? '');
      // The top of the game folder is not an upload folder: uploads there go to the asset folder.
      onUploadFolder(f === null || f === '' ? DEFAULT_UPLOAD_FOLDER : f);
    },
    [clientRef, onUploadFolder],
  );
  const open = (item: ProjectItem): void => {
    if (isAssetKind(item.kind)) return openers.previewAsset(item.id);
    if (item.kind === 'scene') return openers.openScene(item.id);
    if (item.kind === 'prefab') return openers.showPrefab(item.id);
    if (item.kind === 'envpreset') return openers.showEnvironment();
    const doc = documentOfItem(item);
    if (doc === null) return;
    openers.openDocument(item.kind === 'behavior' && openers.isVisualScript(item.id) ? 'visual-script' : doc.kind, doc.id);
  };
  return { folder, setFolder, commands, open };
}
