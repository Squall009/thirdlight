/**
 * The project window's state the editor shares: the chosen folder — where
 * new scenes and resources are created (Unity's Create menu uses the project
 * window's folder) and where uploads land — its file commands, and what a
 * double-click opens for each kind of item (its editor; the Scene view for a
 * scene; the Inspector for an asset, a prefab or a shader material).
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
  /** Open an item in the editor window (material, timeline, script, …). */
  openDocument(kind: string, id: string): void;
  /** Whether a behavior is a visual script (it opens as a graph). */
  isVisualScript(behaviorId: string): boolean;
  /** Whether a material is a graph material (it opens as a graph; a shader material shows in the Inspector). */
  isGraphMaterial(materialId: string): boolean;
  /** Open a scene in the Scene view and make it the active one. */
  openScene(sceneId: string): void;
  /** Show an item in the Inspector (a prefab, a shader material, an asset). */
  inspect(item: ProjectItem): void;
  /** Show the environment panel (its presets). */
  showEnvironment(): void;
  /** Choose an asset and realize its preview (in its Inspector). */
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
    if (isAssetKind(item.kind)) {
      openers.inspect(item);
      return openers.previewAsset(item.id);
    }
    if (item.kind === 'scene') return openers.openScene(item.id);
    // A prefab has no editor (copies are placed from its Inspector); nor has a shader material (its values are its Inspector).
    if (item.kind === 'prefab' || (item.kind === 'material' && !openers.isGraphMaterial(item.id))) return openers.inspect(item);
    if (item.kind === 'envpreset') return openers.showEnvironment();
    const doc = documentOfItem(item);
    if (doc === null) return;
    openers.openDocument(item.kind === 'behavior' && openers.isVisualScript(item.id) ? 'visual-script' : doc.kind, doc.id);
  };
  return { folder, setFolder, commands, open };
}
