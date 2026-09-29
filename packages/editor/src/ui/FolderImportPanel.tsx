/**
 * The Assets tab's folders: the folder of the game folder uploads land in,
 * and folder import — a folder already in the game folder, or one picked on
 * the computer (its files are uploaded into the upload folder first). Every
 * supported file comes in as an asset named after its file, with the labels
 * typed here, in one command (one undo). Display and intent only: the
 * session client sends the upload routes and the `importAssets` command.
 */
import { useRef, useState, type JSX } from 'react';

import type { ProjectFileListing } from '../session/client-core';
import { describeFolderImport, parseLabels, planFolderUpload, type FolderImportView, type PickedFile } from '../session/folder-upload';

type ImportResult = { ok: true; added: number; report?: FolderImportView } | { ok: false; error: { code: string; message: string }; report?: FolderImportView };

interface Props {
  uploadFolder: string;
  onUploadFolder: (folder: string) => void;
  /** One folder of the game folder (its subfolders are offered). */
  load: (dir: string) => Promise<{ ok: true; listing: ProjectFileListing } | { ok: false; error: { code: string; message: string } }>;
  upload: (path: string, bytes: Uint8Array) => Promise<{ ok: true; path: string } | { ok: false; error: { code: string; message: string } }>;
  importFolder: (folder: string, labels: string[]) => Promise<ImportResult>;
  /** After an import that added assets (the tab refreshes). */
  onImported: () => void;
}

export function FolderImportPanel(p: Props): JSX.Element {
  const [open, setOpen] = useState(false);
  const [folder, setFolder] = useState(p.uploadFolder);
  const [labelText, setLabelText] = useState('');
  const [subfolders, setSubfolders] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const labels = parseLabels(labelText);

  const browse = async (dir: string): Promise<void> => {
    setFolder(dir);
    const r = await p.load(dir);
    setSubfolders(r.ok ? r.listing.entries.filter((e) => e.kind === 'dir').map((e) => e.path) : []);
  };

  const finish = (r: ImportResult): void => {
    if (r.ok) {
      setResult({ ok: true, text: describeFolderImport(r.added, r.report) });
      p.onImported();
    } else {
      setResult({ ok: false, text: r.error.code === 'no_change' && r.report !== undefined ? describeFolderImport(0, r.report) : `${r.error.code}: ${r.error.message}` });
    }
  };

  const importNow = async (target: string): Promise<void> => {
    setBusy(`importing ${target}…`);
    setResult(null);
    try {
      finish(await p.importFolder(target, labels.labels));
    } finally {
      setBusy(null);
    }
  };

  /** A folder picked on the computer: uploaded into the upload folder under its own name, then imported. */
  const uploadPicked = async (list: FileList): Promise<void> => {
    const picked: PickedFile[] = [...list].map((file) => ({ relativePath: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, file }));
    const listing = await p.load(p.uploadFolder);
    const taken = new Set(listing.ok ? listing.listing.entries.map((e) => e.name.toLowerCase()) : []);
    const plan = planFolderUpload(picked, p.uploadFolder, taken);
    if (plan === null) {
      setResult({ ok: false, text: 'the folder holds no files' });
      return;
    }
    setResult(null);
    try {
      for (let i = 0; i < plan.files.length; i++) {
        const f = plan.files[i]!;
        setBusy(`uploading ${i + 1}/${plan.files.length} into ${plan.folder}…`);
        const r = await p.upload(f.path, new Uint8Array(await f.file.arrayBuffer()));
        if (!r.ok) {
          setResult({ ok: false, text: `${f.path}: ${r.error.message}` });
          return;
        }
      }
      setFolder(plan.folder);
      setBusy(`importing ${plan.folder}…`);
      finish(await p.importFolder(plan.folder, labels.labels));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="tl-assets__folders">
      <label className="tl-field tl-field--inline" title="The folder of the game folder uploaded files go into (made when missing)">
        <span className="tl-field__label">upload to</span>
        <input className="tl-input tl-input--small" aria-label="upload folder" value={p.uploadFolder} onChange={(e) => p.onUploadFolder(e.target.value.trim())} />
      </label>
      <button
        className="tl-btn"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          if (!open) void browse(folder);
        }}
        title="Bring every supported file of a folder in as assets named after their files, subfolders included, with labels — one undo"
      >
        import folder…
      </button>
      {open && (
        <div className="tl-assets__folder-import" role="group" aria-label="Folder import">
          <label className="tl-field">
            <span className="tl-field__label">folder</span>
            <input className="tl-input" aria-label="folder to import" value={folder} onChange={(e) => setFolder(e.target.value.trim())} onBlur={() => void browse(folder)} />
          </label>
          {subfolders.length > 0 && (
            <div className="tl-assets__row" aria-label="subfolders">
              {subfolders.map((d) => (
                <button key={d} className="tl-btn tl-btn--small" onClick={() => void browse(d)} title={`Choose ${d}`}>
                  {d.split('/').pop()}/
                </button>
              ))}
            </div>
          )}
          <label className="tl-field" title="Labels every imported asset gets (a letter or digit, then letters, digits, _ - . /); scripts can load assets by label">
            <span className="tl-field__label">labels</span>
            <input className="tl-input" aria-label="labels" placeholder="voice, level-3" value={labelText} onChange={(e) => setLabelText(e.target.value)} />
          </label>
          {labels.invalid.length > 0 && <div className="tl-assets__error">not labels: {labels.invalid.join(', ')}</div>}
          <div className="tl-assets__row">
            <button className="tl-btn tl-btn--small" disabled={busy !== null || folder === '' || labels.invalid.length > 0} onClick={() => void importNow(folder)}>
              import
            </button>
            <input
              ref={picker}
              className="tl-assets__file tl-assets__folder-input"
              type="file"
              multiple
              {...({ webkitdirectory: '' } as Record<string, string>)}
              onChange={(e) => {
                const files = e.target.files;
                if (files !== null && files.length > 0) void uploadPicked(files);
                e.target.value = '';
              }}
            />
            <button className="tl-btn tl-btn--small" disabled={busy !== null || labels.invalid.length > 0} onClick={() => picker.current?.click()} title={`Upload a folder from this computer into ${p.uploadFolder}/ and import it`}>
              upload a folder…
            </button>
          </div>
        </div>
      )}
      {busy !== null && <div className="tl-assets__status">{busy}</div>}
      {result !== null && (
        <div className={result.ok ? 'tl-assets__status' : 'tl-assets__error'} role="status" data-testid="folder-import-result">
          {result.text}
        </div>
      )}
    </div>
  );
}
