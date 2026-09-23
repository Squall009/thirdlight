/**
 * "Import from project folder": browse the game folder (the folder holding
 * thirdlight.json) and pick a .glb or .wav file. The backend lists only that
 * folder; nothing outside it can be chosen.
 */
import { useEffect, useState, type JSX } from 'react';
import type { ProjectFileListing } from '../session/client';
import { Dialog } from './Dialog';

type Entry = ProjectFileListing['entries'][number];

interface Props {
  title: string;
  /** Start in this folder (e.g. `assets`); falls back to the game folder. */
  startDir: string;
  load: (dir: string) => Promise<{ ok: true; listing: ProjectFileListing } | { ok: false; error: { code: string; message: string } }>;
  onPick: (entry: Entry) => void;
  onClose: () => void;
}

export function ProjectFilePicker(p: Props): JSX.Element {
  const [dir, setDir] = useState(p.startDir);
  const [listing, setListing] = useState<ProjectFileListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { load, startDir } = p;
  useEffect(() => {
    let live = true;
    setError(null);
    void load(dir).then((r) => {
      if (!live) return;
      if (r.ok) setListing(r.listing);
      else if (dir !== '' && dir === startDir) setDir('');
      else setError(r.error.message);
    });
    return () => {
      live = false;
    };
  }, [dir, load, startDir]);
  const crumbs = dir === '' ? [] : dir.split('/');
  return (
    <Dialog title={p.title} onClose={p.onClose}>
      <div className="tl-files">
        <div className="tl-files__crumbs" aria-label="Folder">
          <button className="tl-btn tl-btn--small" onClick={() => setDir('')}>
            game folder
          </button>
          {crumbs.map((c, i) => (
            <span key={i}>
              {' / '}
              <button className="tl-btn tl-btn--small" onClick={() => setDir(crumbs.slice(0, i + 1).join('/'))}>
                {c}
              </button>
            </span>
          ))}
        </div>
        {error !== null && <div className="tl-assets__error">{error}</div>}
        <ul className="tl-files__list" aria-label="Files">
          {dir !== '' && (
            <li>
              <button className="tl-files__entry" onClick={() => setDir(crumbs.slice(0, -1).join('/'))}>
                ..
              </button>
            </li>
          )}
          {(listing?.dir === dir ? listing.entries : []).map((e) => (
            <li key={e.path}>
              <button
                className={`tl-files__entry tl-files__entry--${e.kind}`}
                onClick={() => (e.kind === 'dir' ? setDir(e.path) : p.onPick(e))}
                title={e.path}
              >
                {e.kind === 'dir' ? `${e.name}/` : e.name}
                {e.byteLength !== undefined && <span className="tl-files__size">{formatBytes(e.byteLength)}</span>}
              </button>
            </li>
          ))}
          {listing?.dir === dir && listing.entries.length === 0 && <li className="tl-row tl-row--empty">no folders or .glb/.fbx/.wav files here</li>}
        </ul>
        {listing?.truncated === true && <p className="tl-note">Only the first {listing.entries.length} entries are shown.</p>}
        <p className="tl-note">The file stays where it is. The asset records its path and checksum; rebuild the file and Problems offers a re-import. An .fbx is converted to glTF by Blender on the server; the game uses the converted model.</p>
      </div>
    </Dialog>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
