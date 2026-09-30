/**
 * The Assets tab's folder controls wired to the session: where uploads land,
 * folder import, and the folder new scenes and resources go into (the
 * session client adds it to every create; the project window takes this
 * role later). Display and intent only.
 */
import { useState, type JSX, type RefObject } from 'react';

import type { ProjectFileListing } from '../session/client-core';
import type { SessionClient } from '../session/client';
import { FolderImportPanel } from './FolderImportPanel';

interface Props {
  clientRef: RefObject<SessionClient | null>;
  uploadFolder: string;
  onUploadFolder: (folder: string) => void;
  /** The KTX2 encoding a folder import applies to PNG/JPEG textures (undefined: as they are). */
  ktx2: 'color' | 'normal' | 'data' | undefined;
  load: (dir: string) => Promise<{ ok: true; listing: ProjectFileListing } | { ok: false; error: { code: string; message: string } }>;
  onImported: () => void;
}

const notConnected = { ok: false as const, error: { code: 'session_unavailable', message: 'not connected' } };

export function AssetFolders(p: Props): JSX.Element {
  const [newFolder, setNewFolder] = useState(p.clientRef.current?.newResourceFolder ?? '');
  return (
    <FolderImportPanel
      uploadFolder={p.uploadFolder}
      onUploadFolder={p.onUploadFolder}
      newFolder={newFolder}
      onNewFolder={(folder) => {
        setNewFolder(folder);
        p.clientRef.current?.setNewResourceFolder(folder);
      }}
      load={p.load}
      upload={(path, bytes) => p.clientRef.current?.uploadFileTo(path, bytes) ?? Promise.resolve(notConnected)}
      importFolder={(folder, labels) => p.clientRef.current?.importFolder(folder, labels, p.ktx2) ?? Promise.resolve(notConnected)}
      onImported={p.onImported}
    />
  );
}
