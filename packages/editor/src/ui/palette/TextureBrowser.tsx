/**
 * The project's textures (or models: `kinds`) as a grid of pictures with a
 * search box — what an edit mode or the kit editor offers where the project
 * window is out of reach (it lies under them). Each picture is the asset's
 * tile thumbnail (a texture's from the backend, a model's drawn once); the
 * grid reads the project index page by page as it scrolls, so a project of
 * any size opens at once.
 *
 * A click picks the texture; Enter in the search box picks the first match.
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';

import type { TileThumbnails } from '../../viewport/thumbnails';
import { TEXTURE_KINDS } from '../catalog/RefPicker';
import { useIndexList } from '../catalog/useIndexList';
import { VirtualList } from '../catalog/VirtualList';
import { useLayerThumb } from './LayerPalette';

/** Pictures a row of the grid. */
const COLS = 4;
/** A row's height (px): the picture and its name. */
const ROW = 92;
/** Rows in view before the grid scrolls. */
const ROWS_SHOWN = 3;

export function TextureBrowser(p: { aria: string; value: string | null; onPick: (textureId: string) => void; thumbnails: TileThumbnails | null; autoFocus?: boolean; kinds?: readonly string[]; noun?: string }): JSX.Element {
  const [text, setText] = useState('');
  const noun = p.noun ?? 'textures';
  const list = useIndexList({ kinds: p.kinds ?? TEXTURE_KINDS, text, sort: 'name' });
  const total = list.total ?? 0;
  const rows = Math.ceil(total / COLS);
  return (
    <div className="tl-texbrowser" role="group" aria-label={p.aria}>
      <input
        className="tl-input"
        type="search"
        aria-label={`${p.aria} search`}
        placeholder={`Search ${noun}`}
        value={text}
        autoFocus={p.autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          const first = list.entry(0);
          if (e.key === 'Enter' && first !== undefined) p.onPick(first.id);
        }}
      />
      <VirtualList
        as="div"
        role="listbox"
        ariaLabel={`${p.aria} list`}
        className="tl-texbrowser__grid"
        style={{ height: Math.max(1, Math.min(rows, ROWS_SHOWN)) * ROW }}
        count={rows}
        stride={ROW}
        overscan={2}
        onRange={(from, to) => list.need(from * COLS, to * COLS)}
        empty={<div className="tl-picker__empty">{list.total === null ? 'loading…' : text === '' ? `No ${noun} in the project yet: import one in the project window.` : 'nothing matches'}</div>}
        renderItem={(row) => (
          <div key={row} className="tl-texbrowser__row">
            {Array.from({ length: COLS }, (_x, c) => {
              const e = list.entry(row * COLS + c);
              return row * COLS + c < total ? <TextureCell key={c} id={e?.id ?? null} name={e?.name ?? '…'} picked={e !== undefined && e.id === p.value} onPick={p.onPick} thumbnails={p.thumbnails} /> : <span key={c} />;
            })}
          </div>
        )}
      />
    </div>
  );
}

function TextureCell(p: { id: string | null; name: string; picked: boolean; onPick: (id: string) => void; thumbnails: TileThumbnails | null }): JSX.Element {
  const thumb = useLayerThumb(p.id, p.thumbnails);
  return (
    <button type="button" role="option" aria-selected={p.picked} aria-label={p.name} className={`tl-texcell${p.picked ? ' is-active' : ''}`} title={p.name} disabled={p.id === null} onClick={() => p.id !== null && p.onPick(p.id)}>
      <span className="tl-texcell__thumb" data-thumb={thumb.state}>
        {thumb.url !== null && <img src={thumb.url} alt="" draggable={false} />}
      </span>
      <span className="tl-texcell__name">{p.name}</span>
    </button>
  );
}
