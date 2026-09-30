/**
 * A picker for a reference to an asset or resource of the project (a model,
 * a texture, a voice clip, a prefab, a material, …), fed by the project index
 * in pages — never by a list the editor holds whole.
 *
 * A choice that fits one page (`PICKER_SELECT_MAX` entries) is a plain
 * `select` (keyboard and screen readers as usual); a longer one is a button
 * that opens a search box over a virtualized list, which reads the index
 * page by page as it scrolls (Unity's object picker). Either way the current
 * value is shown by its name, read by id whatever page it is on.
 *
 * Browser-only (React).
 */
import { INDEX_PAGE_DEFAULT } from '@thirdlight/project-model/limits';
import { useEffect, useRef, useState, type JSX } from 'react';

import type { IndexEntryView } from '../../session/catalog';
import { useCatalog } from './catalog-context';
import { useIndexList } from './useIndexList';
import { VirtualList } from './VirtualList';

/** The most choices a picker shows as a plain select (one index page: the first page has them all); more are searched. */
export const PICKER_SELECT_MAX = INDEX_PAGE_DEFAULT;

/** The index kinds of the usual pickers (one array each, so a picker's query stays the same between draws). */
export const TEXTURE_KINDS: readonly string[] = ['texture'];
export const MODEL_KINDS: readonly string[] = ['model'];
export const AUDIO_KINDS: readonly string[] = ['audio'];
export const FONT_KINDS: readonly string[] = ['font'];

const FIELD_KINDS = new Map<string, readonly string[]>([
  ['texture', TEXTURE_KINDS],
  ['model', MODEL_KINDS],
  ['audio', AUDIO_KINDS],
  ['font', FONT_KINDS],
  // A voice clip is an audio asset of any length.
  ['voice', AUDIO_KINDS],
]);

/** The index kinds a graph field that names an asset (`GraphFieldDef.asset`) offers. */
export function indexKindsOfAssetField(assetKind: string): readonly string[] {
  let kinds = FIELD_KINDS.get(assetKind);
  if (kinds === undefined) {
    kinds = [assetKind];
    FIELD_KINDS.set(assetKind, kinds);
  }
  return kinds;
}

/** One row of the search list (px). */
const ROW = 24;

export interface RefPickerProps {
  /** The accessible name (the select's, or the button's). */
  aria: string;
  /** The index kinds offered (asset kinds such as `model`, resource kinds such as `prefab`). */
  kinds: readonly string[];
  /** The id chosen ('' or null: none). */
  value: string | null;
  onPick: (id: string) => void;
  /** The label of the "no value" choice (null: a value is required). */
  none?: string | null;
  /** Choices that are not index entries (built-in values), shown first. */
  extra?: readonly { value: string; label: string }[];
  /** How a choice is labelled (default: its name, and its kind when several kinds are offered). */
  label?: (e: IndexEntryView) => string;
  className?: string;
  title?: string;
  disabled?: boolean;
}

function defaultLabel(kinds: readonly string[]): (e: IndexEntryView) => string {
  return (e) => (kinds.length > 1 ? `${e.name} (${e.kind})` : e.name);
}

/** The name of one index entry by id (null while it is read; the id itself when there is none). */
export function useEntryName(id: string | null, kinds: readonly string[]): IndexEntryView | null | undefined {
  const { catalog, version } = useCatalog();
  const [entry, setEntry] = useState<{ id: string; e: IndexEntryView | null } | null>(null);
  const kindsKey = kinds.join(',');
  useEffect(() => {
    if (catalog === null || id === null || id === '') return;
    let live = true;
    void catalog.entries([id], kindsKey === '' ? undefined : kindsKey.split(',')).then(
      (list) => {
        if (live) setEntry({ id, e: list[0] ?? null });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [catalog, version, id, kindsKey]);
  if (id === null || id === '') return null;
  return entry !== null && entry.id === id ? entry.e : undefined;
}

/** The first index entry of these kinds (a starting choice) and how many there are (null while read). */
export function useFirstEntry(kinds: readonly string[]): { first: string | null; total: number | null } {
  const l = useIndexList({ kinds });
  return { first: l.entry(0)?.id ?? null, total: l.total };
}

/** The names of several ids (read by id from the index; an id not read yet names itself). */
export function useEntryNames(ids: readonly string[], kinds: readonly string[]): ReadonlyMap<string, string> {
  const { catalog, version } = useCatalog();
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const key = [...new Set(ids)].sort().join('\u0000');
  const kindsKey = kinds.join(',');
  useEffect(() => {
    if (catalog === null || key === '') return;
    let live = true;
    void catalog.entries(key.split('\u0000'), kindsKey === '' ? undefined : kindsKey.split(',')).then(
      (list) => {
        if (live) setNames(new Map(list.map((e) => [e.id, e.name] as const)));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [catalog, version, key, kindsKey]);
  return names;
}

/** An asset's or project item's name, read by id from the index (the id while it is read or when there is none). */
export function EntryName(p: { id: string; kinds: readonly string[] }): JSX.Element {
  const e = useEntryName(p.id, p.kinds);
  return <>{e !== null && e !== undefined ? e.name : p.id}</>;
}

export function RefPicker(p: RefPickerProps): JSX.Element {
  const first = useIndexList({ kinds: p.kinds });
  const labelOf = p.label ?? defaultLabel(p.kinds);
  const value = p.value ?? '';
  const current = useEntryName(value === '' ? null : value, p.kinds);
  const small = first.total !== null && first.total <= PICKER_SELECT_MAX;
  if (first.total === null || small) {
    // Every choice fits the first page: its entries are the options.
    const entries: IndexEntryView[] = [];
    for (let i = 0; i < (first.total ?? 0); i++) {
      const e = first.entry(i);
      if (e !== undefined) entries.push(e);
    }
    const listed = value === '' || entries.some((e) => e.id === value) || (p.extra ?? []).some((x) => x.value === value);
    return (
      <select className={p.className ?? 'tl-input'} aria-label={p.aria} title={p.title} disabled={p.disabled} value={value} onChange={(e) => p.onPick(e.target.value)}>
        {(p.none !== null && p.none !== undefined) || value === '' ? <option value="">{p.none ?? '— choose —'}</option> : null}
        {(p.extra ?? []).map((x) => (
          <option key={`extra:${x.value}`} value={x.value}>
            {x.label}
          </option>
        ))}
        {entries.map((e) => (
          <option key={`${e.kind}:${e.id}`} value={e.id}>
            {labelOf(e)}
          </option>
        ))}
        {!listed && <option value={value}>{current !== undefined && current !== null ? labelOf(current) : current === null ? `${value} (missing)` : value}</option>}
      </select>
    );
  }
  return <SearchPicker {...p} labelOf={labelOf} current={current} />;
}

/** The long form: a button naming the value, opening a search over the index. */
function SearchPicker(p: RefPickerProps & { labelOf: (e: IndexEntryView) => string; current: IndexEntryView | null | undefined }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const list = useIndexList({ kinds: p.kinds, text }, open);
  const value = p.value ?? '';
  const extra = p.extra ?? [];
  const noneRow = p.none !== null && p.none !== undefined ? 1 : 0;
  const lead = noneRow + extra.length;
  const count = lead + (list.total ?? 0);
  useEffect(() => {
    if (!open) return;
    const close = (ev: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [open]);
  useEffect(() => setActive(0), [text]);
  const pickAt = (i: number): void => {
    if (i < noneRow) p.onPick('');
    else if (i < lead) p.onPick(extra[i - noneRow]!.value);
    else {
      const e = list.entry(i - lead);
      if (e === undefined) return;
      p.onPick(e.id);
    }
    setOpen(false);
    setText('');
  };
  const shown = value === '' ? (p.none ?? '') : (extra.find((x) => x.value === value)?.label ?? (p.current !== undefined && p.current !== null ? p.labelOf(p.current) : p.current === null ? `${value} (missing)` : '…'));
  return (
    <span className={`tl-picker${open ? ' is-open' : ''}`} ref={rootRef}>
      <button type="button" className={p.className ?? 'tl-input tl-picker__button'} aria-label={p.aria} aria-haspopup="listbox" aria-expanded={open} title={p.title ?? shown} disabled={p.disabled} data-value={value} onClick={() => setOpen((o) => !o)}>
        {shown === '' ? '\u00a0' : shown}
      </button>
      {open && (
        // Inside a <label>, a click would be passed on to the button (opening the list again): kept here.
        <span className="tl-picker__popup" role="dialog" aria-label={`${p.aria} choices`} onClick={(e) => e.preventDefault()}>
          <input
            className="tl-input tl-picker__search"
            aria-label={`${p.aria} search`}
            placeholder={`Search ${list.total ?? '…'}`}
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setActive((a) => Math.min(count - 1, a + 1));
              else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1));
              else if (e.key === 'Enter') pickAt(active);
              else if (e.key === 'Escape') setOpen(false);
              else return;
              e.preventDefault();
            }}
          />
          <VirtualList
            as="div"
            role="listbox"
            ariaLabel={`${p.aria} list`}
            className="tl-picker__list"
            count={count}
            stride={ROW}
            overscan={8}
            scrollToIndex={active}
            onRange={(from, to) => list.need(Math.max(0, from - lead), Math.max(0, to - lead))}
            empty={<div className="tl-picker__empty">{list.total === null ? 'loading…' : 'nothing matches'}</div>}
            renderItem={(i) => {
              const e = i >= lead ? list.entry(i - lead) : undefined;
              const id = i < noneRow ? '' : i < lead ? extra[i - noneRow]!.value : (e?.id ?? null);
              const label = i < noneRow ? (p.none ?? '') : i < lead ? extra[i - noneRow]!.label : e !== undefined ? p.labelOf(e) : '…';
              return (
                <div
                  key={i}
                  role="option"
                  aria-selected={id !== null && id === value}
                  className={`tl-picker__option${i === active ? ' is-active' : ''}${id !== null && id === value ? ' is-selected' : ''}`}
                  data-id={id ?? undefined}
                  title={e?.path ?? label}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pickAt(i)}
                >
                  {label}
                </div>
              );
            }}
          />
        </span>
      )}
    </span>
  );
}
