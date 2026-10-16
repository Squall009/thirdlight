/**
 * Docked panels over the edit mode's Scene view, shared by every editor.
 *
 * A mode's column declares its panels with `EditPanels`: each one's id,
 * title, default dock and whether it starts collapsed, what it shows (a
 * render function), a short badge for its title bar (a count, on/off, the
 * picked name) and whether it shows now (a selection's panel only while
 * there is one). The content is rendered where it is declared, so it keeps
 * the column's state and contexts, and is put into the panel's body over
 * the view; the panel can move from dock to dock without its content
 * starting over.
 *
 * The shell holds one dock host per editor (`useDockHost`): the layout the
 * user gave the panels (`session/dock-layout.ts`: docks, collapsed or open,
 * order), remembered per editor in the browser, never in the project. It
 * draws the panels (`DockLayer`) and the view's chip (`PanelsChip`): the
 * Panels switch hides or shows them all, Reset layout puts them back where
 * their modes say.
 *
 * A click on a title bar (or Enter / Space on a focused one) collapses or
 * opens the panel; a drag of it moves the panel to the dock under the pointer
 * (the view's ninths, the drop targets showing; the middle is none, Esc
 * cancels). Panels take the pointer and the wheel themselves, so a press on a
 * panel never reaches a tool, the orbit or the selection; they are an overlay,
 * so docking or collapsing never resizes the view.
 *
 * Browser-only (React).
 */
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { DOCK_NAMES, DOCKS, dockAt, EMPTY_DOCKS, loadDocks, movePanel, PANEL_DRAG_THRESHOLD, panelKeepHeight, placeFor, saveDocks, stacks, togglePanel, type DockId, type PanelDefault, type PanelPlace, type StoredDocks } from '../../session/dock-layout';
import { Glyph } from './glyphs';

/** One panel a mode declares. */
export interface EditPanel {
  /** Stable within the editor: the remembered layout is keyed by it (a panel shared by modes keeps one place). */
  readonly id: string;
  readonly title: string;
  /** Where it docks until the user moves it. */
  readonly dock: DockId;
  /** It starts collapsed to its title bar (absent: open). */
  readonly collapsed?: boolean;
  /** A short summary on the title bar's right, kept while collapsed (a count, on/off, the picked name). */
  readonly badge?: string | number;
  /** It shows now (absent: yes); a selection's panel shows while there is one. */
  readonly shown?: boolean;
  /** It edits the selection: drawn in the selection's colour. */
  readonly selection?: boolean;
  /** Its content (rendered where the panel is declared, shown in the panel's body). */
  render(): ReactNode;
}

/** A shown panel as the host keeps it. */
interface PanelEntry {
  readonly id: string;
  readonly title: string;
  readonly badge: string | null;
  readonly selection: boolean;
  readonly def: PanelDefault;
  /** The element its content is rendered into (moved into the panel's body). */
  readonly content: HTMLElement;
  /** Registration order: panels of one default order stack in the order they came. */
  readonly seq: number;
}

interface DockRegistry {
  register(entry: Omit<PanelEntry, 'seq'>): void;
  unregister(id: string, content: HTMLElement): void;
}

const DockContext = createContext<DockRegistry | null>(null);

function browserStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Storage refused (a private window's policy): the layout lasts for the page.
    return null;
  }
}

/** What the shell holds for its panels. */
export interface DockHost {
  readonly registry: DockRegistry;
  /** The shown panels, in the order they came. */
  readonly panels: readonly PanelEntry[];
  readonly docks: StoredDocks;
  toggle(id: string): void;
  move(id: string, dock: DockId): void;
  setHidden(hidden: boolean): void;
  reset(): void;
}

/** The shell's side: the panels its modes declare and the layout of `editor`'s panels. */
export function useDockHost(editor: string): DockHost {
  const [stored, setStored] = useState<{ editor: string; docks: StoredDocks }>(() => ({ editor, docks: loadDocks(editor, browserStorage()) }));
  // Another editor opened in the same shell: its own layout.
  const docks = stored.editor === editor ? stored.docks : loadDocks(editor, browserStorage());
  if (stored.editor !== editor) setStored({ editor, docks });
  const latest = useRef({ editor, docks });
  latest.current = { editor, docks };
  const entries = useRef(new Map<string, PanelEntry>());
  const seq = useRef(0);
  const [panels, setPanels] = useState<readonly PanelEntry[]>([]);
  const sync = useCallback(() => setPanels([...entries.current.values()].sort((a, b) => a.seq - b.seq)), []);
  const registry = useMemo<DockRegistry>(
    () => ({
      register: (entry) => {
        const was = entries.current.get(entry.id);
        entries.current.set(entry.id, { ...entry, seq: was?.content === entry.content ? was.seq : seq.current++ });
        sync();
      },
      unregister: (id, content) => {
        if (entries.current.get(id)?.content !== content) return;
        entries.current.delete(id);
        sync();
      },
    }),
    [sync],
  );
  const update = useCallback((next: StoredDocks) => {
    const { editor: ed } = latest.current;
    latest.current = { editor: ed, docks: next };
    saveDocks(ed, next, browserStorage());
    setStored({ editor: ed, docks: next });
  }, []);
  const defaults = useCallback((): PanelDefault[] => [...entries.current.values()].sort((a, b) => a.seq - b.seq).map((e) => e.def), []);
  const toggle = useCallback((id: string) => update({ ...latest.current.docks, places: togglePanel(latest.current.docks.places, defaults(), id) }), [update, defaults]);
  const move = useCallback((id: string, dock: DockId) => update({ ...latest.current.docks, places: movePanel(latest.current.docks.places, defaults(), id, dock) }), [update, defaults]);
  const setHidden = useCallback((hidden: boolean) => update({ ...latest.current.docks, hidden }), [update]);
  const reset = useCallback(() => update(EMPTY_DOCKS), [update]);
  return { registry, panels, docks, toggle, move, setHidden, reset };
}

/** The shell gives its dock host to everything it shows. */
export function DockProvider({ host, children }: { host: DockHost; children: ReactNode }): JSX.Element {
  return <DockContext.Provider value={host.registry}>{children}</DockContext.Provider>;
}

/**
 * A mode's panels, declared where their state is kept (its column); outside an
 * editor (no shell) the shown ones are drawn in place, one after another.
 */
export function EditPanels({ panels }: { panels: readonly EditPanel[] }): JSX.Element {
  const registry = useContext(DockContext);
  const elements = useRef(new Map<string, HTMLElement>());
  const contentOf = (id: string): HTMLElement => {
    let el = elements.current.get(id);
    if (el === undefined) {
      el = document.createElement('div');
      el.className = 'tl-dpanel__content';
      elements.current.set(id, el);
    }
    return el;
  };
  const shown = panels.filter((p) => p.shown !== false);
  // What the host draws of each panel, as one value: the registrations change only when it does.
  // A panel's default place in its dock is its place in the declaration (shown or not, so it never shifts).
  const meta = JSON.stringify(shown.map((p) => [p.id, p.title, p.dock, p.collapsed === true, panels.indexOf(p), p.badge ?? null, p.selection === true]));
  useLayoutEffect(() => {
    if (registry === null) return undefined;
    const list = JSON.parse(meta) as [string, string, DockId, boolean, number, string | number | null, boolean][];
    for (const [id, title, dock, collapsed, order, badge, selection] of list) registry.register({ id, title, badge: badge === null ? null : String(badge), selection, def: { id, dock, open: !collapsed, order }, content: contentOf(id) });
    return () => {
      for (const [id] of list) registry.unregister(id, contentOf(id));
    };
  }, [registry, meta]);
  if (registry === null) {
    return (
      <>
        {shown.map((p) => (
          <section key={p.id} className="tl-sec" aria-label={`${p.title} panel`}>
            {p.render()}
          </section>
        ))}
      </>
    );
  }
  return <>{shown.map((p) => createPortal(p.render(), contentOf(p.id), p.id))}</>;
}

/** A panel being dragged by its title bar: where its ghost is (view pixels) and the dock under the pointer. */
interface Drag {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly target: DockId | null;
}

/** The tallest a dragged panel's ghost shows (px): enough to read as the panel, never a wall over the drop targets. */
const GHOST_MAX_HEIGHT = 220;

/** The panels over the Scene view (none while the Panels switch is off), and the drop targets while one is dragged. */
export function DockLayer({ host }: { host: DockHost }): JSX.Element | null {
  const layer = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const { panels, docks } = host;
  if (panels.length === 0 || docks.hidden) return null;
  const defs = panels.map((p) => p.def);
  const inDock = stacks(docks.places, defs);
  const byId = new Map(panels.map((p) => [p.id, p]));
  const placeOf = (id: string): PanelPlace => placeFor(docks.places, byId.get(id)!.def);

  const onHeadDown = (e: ReactPointerEvent<HTMLDivElement>, id: string): void => {
    if (e.button !== 0) return;
    const view = layer.current?.parentElement?.getBoundingClientRect();
    const frame = e.currentTarget.parentElement?.getBoundingClientRect();
    if (view === undefined || frame === undefined) return;
    const head = e.currentTarget;
    const pointer = e.pointerId;
    head.setPointerCapture(pointer);
    const start = [e.clientX, e.clientY] as const;
    const grab = [e.clientX - frame.left, e.clientY - frame.top] as const;
    let dragging = false;
    let target: DockId | null = null;
    const move = (ev: PointerEvent): void => {
      if (!dragging && Math.hypot(ev.clientX - start[0], ev.clientY - start[1]) < PANEL_DRAG_THRESHOLD) return;
      dragging = true;
      target = dockAt(ev.clientX, ev.clientY, view);
      setDrag({ id, x: ev.clientX - view.left - grab[0], y: ev.clientY - view.top - grab[1], width: frame.width, height: Math.min(frame.height, GHOST_MAX_HEIGHT), target });
    };
    const end = (): void => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      head.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', onKey, true);
      if (head.hasPointerCapture(pointer)) head.releasePointerCapture(pointer);
      setDrag(null);
    };
    const up = (): void => {
      end();
      if (!dragging) host.toggle(id);
      else if (target !== null) host.move(id, target);
    };
    const cancel = (): void => end();
    // Esc while a panel is dragged cancels the move (before the editor's own Esc: the key is taken).
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      end();
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', onKey, true);
  };
  const onHeadKey = (e: ReactKeyboardEvent<HTMLDivElement>, id: string): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    host.toggle(id);
  };

  const stack = (d: DockId, extra = ''): JSX.Element => (
    <div className={`tl-vdock tl-vdock--${d}${extra}`} data-dock={d}>
      {inDock[d].map((id) => (
        <PanelFrame key={id} entry={byId.get(id)!} place={placeOf(id)} lifted={drag?.id === id} onHeadDown={onHeadDown} onHeadKey={onHeadKey} />
      ))}
    </div>
  );
  const side = (top: DockId, mid: DockId, bottom: DockId): JSX.Element | null =>
    inDock[top].length + inDock[mid].length + inDock[bottom].length === 0 ? null : (
      <div className="tl-vdocks__side">
        {stack(top)}
        <div className="tl-vdock-gap" />
        {stack(mid)}
        <div className="tl-vdock-gap" />
        {stack(bottom)}
      </div>
    );
  const dragged = drag === null ? null : (byId.get(drag.id) ?? null);
  return (
    <>
      <div className="tl-vdocks" ref={layer} aria-label="panels">
        {side('tl', 'l', 'bl')}
        <div className="tl-vdocks__mid">
          {stack('t')}
          <div className="tl-vdock-gap" />
          {stack('b')}
        </div>
        {side('tr', 'r', 'br')}
      </div>
      {drag !== null && (
        <div className="tl-vdrops" aria-label="drop targets">
          {DOCKS.map((d) => (
            <div key={d} className={`tl-vdrop tl-vdrop--${d}${drag.target === d ? ' is-hot' : ''}`} data-drop={d}>
              <span>{DOCK_NAMES[d]}</span>
            </div>
          ))}
        </div>
      )}
      {drag !== null && dragged !== null && (
        <div className={`tl-dpanel is-ghost${dragged.selection ? ' tl-dpanel--sel' : ''}`} style={{ left: drag.x, top: drag.y, width: drag.width, height: drag.height }} aria-hidden="true">
          <div className="tl-dpanel__head">
            <PanelHead entry={dragged} />
          </div>
        </div>
      )}
    </>
  );
}

function PanelHead({ entry }: { entry: PanelEntry }): JSX.Element {
  return (
    <>
      <span className="tl-dpanel__grip">
        <Glyph name="grip" size={14} />
      </span>
      <span className="tl-dpanel__chev">
        <Glyph name="chevron" size={14} />
      </span>
      <span className="tl-dpanel__title">{entry.title}</span>
      {entry.badge !== null && <span className="tl-dpanel__badge">{entry.badge}</span>}
    </>
  );
}

function PanelFrame({ entry, place, lifted, onHeadDown, onHeadKey }: { entry: PanelEntry; place: PanelPlace; lifted: boolean; onHeadDown: (e: ReactPointerEvent<HTMLDivElement>, id: string) => void; onHeadKey: (e: ReactKeyboardEvent<HTMLDivElement>, id: string) => void }): JSX.Element {
  const frame = useRef<HTMLElement | null>(null);
  const head = useRef<HTMLDivElement | null>(null);
  const body = useRef<HTMLDivElement | null>(null);
  // The declared content goes into the body (and is taken out when the panel moves or goes).
  useLayoutEffect(() => {
    const b = body.current;
    if (b === null) return undefined;
    b.appendChild(entry.content);
    return () => {
      if (entry.content.parentElement === b) b.removeChild(entry.content);
    };
  }, [entry.content]);
  // A short panel keeps its height when its column runs short (the tall ones give way and scroll); a body with more
  // below than it shows says so with a fade at its foot (overlay scrollbars may not show), gone at the bottom.
  useLayoutEffect(() => {
    const f = frame.current;
    const b = body.current;
    const h = head.current;
    if (f === null || b === null || h === null) return undefined;
    const fit = (): void => {
      f.style.minHeight = place.open ? `${panelKeepHeight(h.offsetHeight, entry.content.offsetHeight)}px` : '';
      f.classList.toggle('is-more', place.open && b.scrollTop + b.clientHeight < b.scrollHeight - 1);
    };
    fit();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    ro?.observe(entry.content);
    ro?.observe(b);
    b.addEventListener('scroll', fit, { passive: true });
    return () => {
      ro?.disconnect();
      b.removeEventListener('scroll', fit);
    };
  }, [entry.content, place.open]);
  return (
    <section ref={frame} className={`tl-dpanel${place.open ? '' : ' is-closed'}${entry.selection ? ' tl-dpanel--sel' : ''}${lifted ? ' is-lifted' : ''}`} aria-label={`${entry.title} panel`} data-panel={entry.id} data-dock={place.dock} data-open={place.open}>
      <div
        ref={head}
        className="tl-dpanel__head"
        role="button"
        tabIndex={0}
        aria-expanded={place.open}
        aria-label={entry.title}
        title="Click: collapse or open · drag: move to another edge or corner"
        onPointerDown={(e) => onHeadDown(e, entry.id)}
        onKeyDown={(e) => onHeadKey(e, entry.id)}
      >
        <PanelHead entry={entry} />
      </div>
      <div ref={body} className="tl-dpanel__body" />
    </section>
  );
}

/** The view's chip: the Panels switch and Reset layout (shown while the mode has panels). */
export function PanelsChip({ host }: { host: DockHost }): JSX.Element | null {
  if (host.panels.length === 0) return null;
  const on = !host.docks.hidden;
  const moved = Object.keys(host.docks.places).length > 0;
  return (
    <span className="tl-panelschip" role="group" aria-label="panels layout" title="Panels are remembered per editor">
      <button type="button" className={`tl-panelschip__switch${on ? ' is-on' : ''}`} aria-pressed={on} title={on ? 'Hide the panels' : 'Show the panels'} onClick={() => host.setHidden(on)}>
        <Glyph name="panels" size={14} />
        <span>Panels</span>
      </button>
      <button type="button" className="tl-panelschip__reset" disabled={!moved && on} title="Put the editor's panels back where they start" onClick={host.reset}>
        <Glyph name="reset" size={11} />
        Reset layout
      </button>
    </span>
  );
}
