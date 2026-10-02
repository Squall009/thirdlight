/**
 * The "UI: <name>" tab of the editor window — the visual editor of one UI
 * document (project UI).
 *
 * - Left: the widget hierarchy — select, add (a widget of any type into the
 *   selected container), delete, reorder, reparent (drag a row onto a
 *   container, or "Move into"), duplicate.
 * - The editor window's preview pane shows the stored document at the
 *   chosen resolution over its scene.
 * - Centre: the live preview, drawn by the game host's own UI layer at a
 *   chosen resolution (16:9, 4:3, 21:9, portrait, the document's reference
 *   size) with a safe-area frame. Click selects; dragging an anchored widget
 *   moves it, its grips resize it, both snapping to the parent's and the
 *   siblings' edges and centres (or a grid; Alt drags freely). Arrow keys
 *   nudge (Shift: 10 px), Delete removes, Ctrl+D duplicates.
 * - Right: the Inspector — the selected widget (anchor presets, the widget
 *   descriptor's fields, bindings, styles, own style, actions, world anchor),
 *   the document (its fields, styles, tweens with a play button, icons, the
 *   cancel action) and the view-model mock values (JSON, filled from the
 *   document's bindings) that the preview's bound bars, lists and texts show.
 *
 * Every edit is one `setUiDocument` with the whole document (one undo
 * step); a drag previews locally and sends one command when released.
 * Edits are queued so each is made on the latest stored document.
 *
 * Browser-only (React).
 */
import { UI_LIMITS } from '@thirdlight/project-model/limits';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type JSX, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { FieldDescriptor, ObjectFieldDescriptor, UiDescriptors, UiDocument, UiIcon, UiTheme, UiTween, UiWidget, UiWidgetType } from '@thirdlight/project-model';

import { ObjectFields, type FieldContext } from '../DescriptorFields';
import { deepEqual, setAt, type FieldPath } from '../../session/descriptor-fields';
import {
  ANCHOR_PRESETS,
  DEFAULT_SAFE_AREA_PERCENT,
  RESOLUTION_PRESETS,
  applyAnchorPreset,
  collectIds,
  currentPreset,
  duplicateWidget,
  fillMock,
  flattenTree,
  guidesFor,
  holds,
  insertWidget,
  isAnchored,
  moveWidgetBy,
  NO_SNAP,
  newWidget,
  parentPath,
  parseMock,
  parsePathKey,
  pathKey,
  removeWidget,
  reorderWidget,
  reparentWidget,
  replaceAt,
  resizeWidgetBy,
  styleNames,
  uniqueName,
  WIDGET_TYPES,
  widgetAt,
  widgetLabel,
  withPlacement,
  type Rect,
  type ResizeHandle,
  type SnapOptions,
  type TreeOutcome,
  type WidgetPath,
} from '../../session/ui-edit';
import { ActionsField, BindingField, CommitText, SizeField, StyleEditor, StyleMapEditor, StyleRefField } from './UiFields';
import { EditorToolbar, EmptyState, ToolButton } from '../chrome/EditorChrome';
import { UiPreview, type Measured, type PreviewAssets, type PreviewHandle } from './UiPreview';
import { usePreview } from '../preview/preview-request';
import { RefPicker, TEXTURE_KINDS, useFirstEntry } from '../catalog/RefPicker';

export interface UiDocumentEditorProps {
  uiDocumentId: string;
  documents: readonly UiDocument[];
  themes: readonly UiTheme[];
  descriptors: UiDescriptors | null;
  /** The latest stored document (read when a queued edit runs). */
  current: (uiDocumentId: string) => UiDocument | null;
  /** One `setUiDocument` (resolves with a refusal, or null once applied). */
  onSave: (doc: UiDocument) => Promise<string | null>;
  /** One `setUiTheme` (the document's theme, edited beside its preview). */
  onSaveTheme: (theme: UiTheme) => Promise<string | null>;
  onOpenTheme: (uiThemeId: string) => void;
  entities: readonly { id: string; name: string }[];
  fieldContext: FieldContext;
  assets: PreviewAssets;
  /** Where the mock values are remembered (per project; presentation data, not project data). */
  mockStorageKey: string;
}

const SNAP_THRESHOLD_PX = 6;
const GRIDS = [0, 4, 8, 16, 32];

interface Drag {
  mode: 'move' | 'resize';
  grip: ResizeHandle | null;
  path: WidgetPath;
  startX: number;
  startY: number;
  m: Measured;
  widget: UiWidget;
  base: UiDocument;
  flow: boolean;
  moved: boolean;
  pointerId: number;
}

function readMock(key: string): string {
  try {
    return globalThis.localStorage?.getItem(key) ?? '';
  } catch {
    return '';
  }
}
function writeMock(key: string, text: string): void {
  try {
    globalThis.localStorage?.setItem(key, text);
  } catch {
    /* storage full or refused: the mock lasts for this session */
  }
}

export function UiDocumentEditor(p: UiDocumentEditorProps): JSX.Element {
  const stored = p.documents.find((d) => d.uiDocumentId === p.uiDocumentId) ?? null;
  const [draft, setDraft] = useState<UiDocument | null>(null);
  const draftRef = useRef<UiDocument | null>(null);
  const doc = draft ?? stored;
  const [selKey, setSelKey] = useState<string>('r');
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'widget' | 'document' | 'theme' | 'mock'>('widget');
  const [res, setRes] = useState<string>(RESOLUTION_PRESETS[0]!.id);
  const [safe, setSafe] = useState<number | null>(null);
  const [grid, setGrid] = useState(8);
  const [snapGuides, setSnapGuides] = useState(true);
  const [guides, setGuides] = useState<{ x: number | null; y: number | null; key: string | null }>({ x: null, y: null, key: null });
  const storageKey = `${p.mockStorageKey}.${p.uiDocumentId}`;
  const [mockText, setMockText] = useState(() => readMock(storageKey));
  const [mock, setMock] = useState<Record<string, unknown>>(() => {
    const r = parseMock(readMock(storageKey));
    return r.ok ? r.value : {};
  });
  const [mockError, setMockError] = useState<string | null>(null);
  const previewRef = useRef<PreviewHandle | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());

  const theme = doc?.theme !== undefined ? p.themes.find((t) => t.uiThemeId === doc.theme) : undefined;
  const selPath: WidgetPath = parsePathKey(selKey) ?? [];
  const selected = doc !== null ? widgetAt(doc.root, selPath) : null;
  // A selection that no longer exists (undo, another client) falls back to the root.
  useEffect(() => {
    if (doc !== null && selected === null) setSelKey('r');
  }, [doc, selected]);

  /** Queue one edit of the stored document (made on the latest stored value when its turn comes). */
  const edit = useCallback(
    (fn: (d: UiDocument) => UiDocument | { error: string } | null): Promise<void> => {
      const run = async (): Promise<void> => {
        const cur = p.current(p.uiDocumentId);
        if (cur === null) return;
        const next = fn(cur);
        if (next === null) return;
        if ('error' in next) {
          setError(next.error);
          return;
        }
        if (deepEqual(next, cur)) return;
        const err = await p.onSave(next);
        setError(err);
      };
      queueRef.current = queueRef.current.then(run, run);
      return queueRef.current;
    },
    [p],
  );

  /** A tree operation: sends the new root and selects where the widget went. */
  const treeOp = (op: (root: UiWidget) => TreeOutcome): void => {
    let where: string | null = null;
    void edit((d) => {
      const r = op(d.root);
      if ('error' in r) return r;
      where = pathKey(r.path);
      return { ...d, root: r.root };
    }).then(() => {
      if (where !== null) setSelKey(where);
    });
  };
  const editWidget = (path: WidgetPath, fn: (w: UiWidget) => UiWidget): void => {
    void edit((d) => (widgetAt(d.root, path) === null ? { error: 'the widget is gone' } : { ...d, root: replaceAt(d.root, path, fn) }));
  };

  // ---- size ----------------------------------------------------------------
  const size = useMemo(() => {
    if (res === 'reference' && doc?.scale !== undefined) return { w: doc.scale.reference[0], h: doc.scale.reference[1] };
    const r = RESOLUTION_PRESETS.find((x) => x.id === res) ?? RESOLUTION_PRESETS[0]!;
    return { w: r.w, h: r.h };
  }, [res, doc?.scale]);
  // The editor window's preview pane: the stored document at this resolution over its scene (a drag shows there when released).
  usePreview(useMemo(() => (stored !== null ? { kind: 'ui' as const, doc: stored, themes: p.themes, mock, size, assets: p.assets } : null), [stored, p.themes, mock, size, p.assets]));

  if (doc === null) return <p className="tl-hint">This UI document no longer exists (deleted or undone). Close the tab, or undo the deletion.</p>;
  if (p.descriptors === null) return <p className="tl-hint">Loading the UI descriptors…</p>;
  const D = p.descriptors;

  const ids = [...collectIds(doc.root)].sort();
  const tweenNames = Object.keys(doc.tweens ?? {}).sort();
  const docIds = p.documents.map((d) => d.uiDocumentId);
  const ctx: FieldContext = {
    ...p.fieldContext,
    refs: {
      ...p.fieldContext.refs,
      ...({
        uiTheme: p.themes.map((t) => ({ id: t.uiThemeId, name: t.name })),
        uiTween: tweenNames.map((n) => ({ id: n, name: n })),
        uiWidget: ids.map((n) => ({ id: n, name: n })),
        uiDocument: p.documents.map((d) => ({ id: d.uiDocumentId, name: d.name })),
      } as Record<string, { id: string; name: string }[]>),
    },
  };
  const fail = (m: string): void => setError(m);
  const anchored = selected !== null && isAnchored(doc.root, selPath);
  const flowChild = selected !== null && !anchored && selPath.length > 0 && selected.worldAnchor === undefined;

  // ---- pointer (preview) ---------------------------------------------------
  const snapFor = (m: Measured, flow: boolean, free: boolean): SnapOptions => {
    if (free) return NO_SNAP;
    const g = flow ? { guidesX: [], guidesY: [] } : snapGuides ? guidesFor(m.parent, m.siblings) : { guidesX: [], guidesY: [] };
    return { grid, threshold: SNAP_THRESHOLD_PX, ...g };
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>, grip: ResizeHandle | null): void => {
    const h = previewRef.current;
    if (h === null || e.button !== 0) return;
    (e.currentTarget as HTMLElement).closest<HTMLElement>('.tl-uidoc__overlay')?.focus();
    let key = selKey;
    // Pressing inside the selected widget drags it (even under a sibling); elsewhere picks what is under the pointer.
    if (grip === null && !(selKey !== 'r' && h.contains(selKey, e.clientX, e.clientY))) {
      const hit = h.hit(e.clientX, e.clientY);
      if (hit === null) return;
      key = hit;
      setSelKey(hit);
    }
    const path = parsePathKey(key);
    if (path === null) return;
    const w = widgetAt(doc.root, path);
    if (w === null || stored === null) return;
    const isAnch = isAnchored(doc.root, path);
    const flow = !isAnch && path.length > 0 && w.worldAnchor === undefined;
    // Moving needs anchors; resizing works in a flow too (a size).
    if (grip === null && !isAnch) return;
    if (grip !== null && !isAnch && !flow) return;
    const m = h.measure(key);
    if (m === null) return;
    const overlay = (e.currentTarget as HTMLElement).closest<HTMLElement>('.tl-uidoc__overlay') ?? (e.currentTarget as HTMLElement);
    overlay.setPointerCapture?.(e.pointerId);
    dragRef.current = { mode: grip === null ? 'move' : 'resize', grip, path, startX: e.clientX, startY: e.clientY, m, widget: w, base: stored, flow, moved: false, pointerId: e.pointerId };
    e.preventDefault();
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (d === null || e.pointerId !== d.pointerId) return;
    const dx = (e.clientX - d.startX) / d.m.k;
    const dy = (e.clientY - d.startY) / d.m.k;
    if (!d.moved && Math.abs(e.clientX - d.startX) < 3 && Math.abs(e.clientY - d.startY) < 3) return;
    d.moved = true;
    const snap = snapFor(d.m, d.flow, e.altKey);
    const r = d.mode === 'move' ? moveWidgetBy(d.widget, d.m.rect, dx, dy, snap) : resizeWidgetBy(d.widget, d.m.rect, d.grip!, dx, dy, snap, d.flow);
    const next = { ...d.base, root: replaceAt(d.base.root, d.path, (w) => withPlacement(w, r.patch)) };
    draftRef.current = next;
    setDraft(next);
    setGuides({ x: r.guideX === null ? null : d.m.origin.x + r.guideX * d.m.kp, y: r.guideY === null ? null : d.m.origin.y + r.guideY * d.m.kp, key: pathKey(d.path) });
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current;
    if (d === null || e.pointerId !== d.pointerId) return;
    dragRef.current = null;
    setGuides({ x: null, y: null, key: null });
    const final = draftRef.current;
    if (!d.moved || final === null) {
      draftRef.current = null;
      setDraft(null);
      return;
    }
    // One command for the whole gesture: the placement the drag ended with.
    const placed = widgetAt(final.root, d.path);
    void edit((stored2) => (placed === null || widgetAt(stored2.root, d.path) === null ? null : { ...stored2, root: replaceAt(stored2.root, d.path, (w) => withPlacement(w, placementOf(placed))) })).then(() => {
      if (draftRef.current === final) {
        draftRef.current = null;
        setDraft(null);
      }
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (selected === null) return;
    const step = e.shiftKey ? 10 : 1;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const a = arrows[e.key];
    if (a !== undefined && anchored) {
      e.preventDefault();
      const m = previewRef.current?.measure(selKey);
      if (m === null || m === undefined) return;
      const r = moveWidgetBy(selected, m.rect, a[0], a[1], NO_SNAP);
      editWidget(selPath, (w) => withPlacement(w, r.patch));
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selPath.length > 0) {
      e.preventDefault();
      treeOp((root) => removeWidget(root, selPath));
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && selPath.length > 0) {
      e.preventDefault();
      treeOp((root) => duplicateWidget(root, selPath));
    }
  };

  // ---- mock ----------------------------------------------------------------
  const setMockFromText = (text: string): void => {
    setMockText(text);
    writeMock(storageKey, text);
    const r = parseMock(text);
    if (r.ok) {
      setMock(r.value);
      setMockError(null);
    } else setMockError(r.error);
  };

  return (
    <div className="tl-uidoc" aria-label="UI document editor" data-ui-document={doc.uiDocumentId}>
      <EditorToolbar label="UI document toolbar" className="tl-uidoc__bar">
        <label className="tl-flag">
          Resolution
          <select className="tl-input" aria-label="preview resolution" value={res} onChange={(e) => setRes(e.target.value)}>
            {RESOLUTION_PRESETS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
            {doc.scale !== undefined && <option value="reference">Reference ({doc.scale.reference.join('×')})</option>}
          </select>
        </label>
        <label className="tl-flag" title="Show the safe area (where overscan and screen corners do not cut the UI off)">
          <input type="checkbox" aria-label="show safe area" checked={safe !== null} onChange={(e) => setSafe(e.target.checked ? DEFAULT_SAFE_AREA_PERCENT : null)} />
          safe area
        </label>
        {safe !== null && <input className="tl-input tl-input--num" aria-label="safe area percent" type="number" min={0} max={25} value={safe} onChange={(e) => setSafe(Math.max(0, Math.min(25, Number(e.target.value) || 0)))} />}
        <label className="tl-flag" title="Drags snap to a grid (px of the document)">
          Grid
          <select className="tl-input" aria-label="snap grid" value={grid} onChange={(e) => setGrid(Number(e.target.value))}>
            {GRIDS.map((g) => (
              <option key={g} value={g}>
                {g === 0 ? 'off' : `${g} px`}
              </option>
            ))}
          </select>
        </label>
        <label className="tl-flag" title="Drags snap to the parent's and siblings' edges and centres (hold Alt to drag freely)">
          <input type="checkbox" aria-label="snap to guides" checked={snapGuides} onChange={(e) => setSnapGuides(e.target.checked)} />
          guides
        </label>
      </EditorToolbar>
      {error !== null && (
        <p className="tl-error" role="alert">
          {error}
        </p>
      )}
      <div className="tl-uidoc__main">
        <Hierarchy doc={doc} selKey={selKey} onSelect={setSelKey} treeOp={treeOp} onFail={fail} />
        <UiPreview
          doc={doc}
          themes={p.themes}
          mock={mock}
          size={size}
          assets={p.assets}
          selected={selKey}
          resizable={anchored || flowChild}
          safeAreaPercent={safe}
          guides={guides}
          handleRef={(h) => {
            previewRef.current = h;
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onKeyDown={onKeyDown}
        />
        <div className="tl-uidoc__inspector" aria-label="UI inspector">
          <div className="tl-uidoc__tabs" role="tablist">
            {(['widget', 'document', 'theme', 'mock'] as const).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} className={`tl-tab${tab === t ? ' is-active' : ''}`} onClick={() => setTab(t)}>
                {t === 'widget' ? 'Widget' : t === 'document' ? 'Document' : t === 'theme' ? 'Theme' : 'Mock values'}
              </button>
            ))}
          </div>
          {tab === 'widget' && selected !== null && (
            <WidgetInspector
              key={selKey}
              doc={doc}
              theme={theme}
              path={selPath}
              widget={selected}
              anchored={anchored}
              D={D}
              ctx={ctx}
              docIds={docIds}
              tweens={tweenNames}
              ids={ids}
             
             
              entities={p.entities}
              onEdit={(fn) => editWidget(selPath, fn)}
              onPreset={(preset, keep) => {
                const m = previewRef.current?.measure(selKey);
                if (m === null || m === undefined) return;
                editWidget(selPath, (w) => withPlacement(w, applyAnchorPreset(w, preset, m.rect, m.parent, keep)));
              }}
              onFail={fail}
            />
          )}
          {tab === 'document' && (
            <DocumentInspector doc={doc} D={D} ctx={ctx} docIds={docIds} ids={ids} onEdit={(fn) => void edit(fn)} onOpenTheme={p.onOpenTheme} onPlay={(t) => previewRef.current?.play(t)} onFail={fail} />
          )}
          {tab === 'theme' && (
            <div className="tl-uidoc__panel" aria-label="theme inspector">
              {theme === undefined ? (
                <p className="tl-hint">{doc.theme === undefined ? 'This document has no theme: pick one in Document → Theme (the UI panel creates themes).' : `The theme "${doc.theme}" is not in this project.`}</p>
              ) : (
                <>
                  <div className="tl-subhead">
                    Theme: {theme.name}
                    <button type="button" className="tl-btn tl-btn--small" onClick={() => p.onOpenTheme(theme.uiThemeId)}>
                      Open tab
                    </button>
                  </div>
                  <p className="tl-hint">Shared with every document of this theme; each change is one command.</p>
                  <StyleMapEditor
                    desc={D.style}
                    styles={theme.styles}
                    aria="theme"
                    ctx={ctx}
                   
                    onChange={(next) => void p.onSaveTheme({ ...theme, styles: next }).then(setError)}
                    onFail={fail}
                  />
                </>
              )}
            </div>
          )}
          {tab === 'mock' && (
            <div className="tl-uidoc__mock">
              <p className="tl-hint">View-model values the preview binds to, as scripts would set them with ctx.ui.set (this editor only; not saved in the project). "$flow" feeds $flow.* bindings.</p>
              <textarea className="tl-input tl-uidoc__mocktext" aria-label="mock values" spellCheck={false} rows={14} value={mockText} onChange={(e) => setMockFromText(e.target.value)} />
              {mockError !== null && (
                <p className="tl-error" role="alert">
                  {mockError}
                </p>
              )}
              <button type="button" className="tl-btn tl-btn--small" onClick={() => setMockFromText(JSON.stringify(fillMock(doc, mock), null, 2))} title="Add a sample value for every bound path the mock lacks">
                Fill from bindings
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The placement fields of a widget (a drag writes exactly these). */
function placementOf(w: UiWidget): Pick<UiWidget, 'anchor' | 'pivot' | 'offset' | 'size' | 'stretch' | 'margin'> {
  return { anchor: w.anchor, pivot: w.pivot, offset: w.offset, size: w.size, stretch: w.stretch, margin: w.margin };
}

// ---------------------------------------------------------------------------
// Hierarchy
// ---------------------------------------------------------------------------

const DRAG_TYPE = 'application/x-thirdlight-ui-widget';

function Hierarchy(p: { doc: UiDocument; selKey: string; onSelect: (k: string) => void; treeOp: (op: (root: UiWidget) => TreeOutcome) => void; onFail: (m: string) => void }): JSX.Element {
  const [addType, setAddType] = useState<UiWidgetType>('text');
  const [moveTo, setMoveTo] = useState('');
  const firstTexture = useFirstEntry(TEXTURE_KINDS).first;
  const rows = flattenTree(p.doc.root);
  const sel = parsePathKey(p.selKey) ?? [];
  const selW = widgetAt(p.doc.root, sel);
  const containers = rows.filter((r) => holds(r.widget) === 'children' && !(pathKey(r.path).startsWith(p.selKey) && (pathKey(r.path) === p.selKey || pathKey(r.path).startsWith(`${p.selKey}.`))));
  const add = (type: UiWidgetType = addType): void => {
    const made = newWidget(type, collectIds(p.doc.root), firstTexture);
    if ('error' in made) return p.onFail(made.error);
    p.treeOp((root) => {
      const target = selW !== null && holds(selW) !== null && !(holds(selW) === 'template' && selW.template !== undefined) ? sel : sel.length > 0 ? parentPath(sel) : [];
      const t = widgetAt(root, target);
      const index = target === sel || t === null ? undefined : typeof sel[sel.length - 1] === 'number' ? (sel[sel.length - 1] as number) + 1 : undefined;
      return insertWidget(root, target, made, index);
    });
  };
  const onDrop = (e: DragEvent<HTMLElement>, target: WidgetPath, targetW: UiWidget): void => {
    const from = parsePathKey(e.dataTransfer.getData(DRAG_TYPE));
    if (from === null) return;
    e.preventDefault();
    if (holds(targetW) === 'children') p.treeOp((root) => reparentWidget(root, from, target));
    else if (target.length > 0 && typeof target[target.length - 1] === 'number') p.treeOp((root) => reparentWidget(root, from, parentPath(target), target[target.length - 1] as number));
  };
  return (
    <div className="tl-uidoc__side" aria-label="widget hierarchy">
      <div className="tl-subhead">Widgets</div>
      <div className="tl-uidoc__row">
        <select className="tl-input" aria-label="new widget type" value={addType} onChange={(e) => setAddType(e.target.value as UiWidgetType)}>
          {WIDGET_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <ToolButton action="add" label="Add" aria="add widget" title="Add into the selected container (or next to the selected widget)" onClick={() => add()} />
      </div>
      <div className="tl-uidoc__row">
        <button type="button" className="tl-btn tl-btn--small" aria-label="move widget up" disabled={sel.length === 0} onClick={() => p.treeOp((root) => reorderWidget(root, sel, -1))}>
          ↑
        </button>
        <button type="button" className="tl-btn tl-btn--small" aria-label="move widget down" disabled={sel.length === 0} onClick={() => p.treeOp((root) => reorderWidget(root, sel, 1))}>
          ↓
        </button>
        <button type="button" className="tl-btn tl-btn--small" aria-label="duplicate widget" disabled={sel.length === 0} onClick={() => p.treeOp((root) => duplicateWidget(root, sel))}>
          Duplicate
        </button>
        <ToolButton action="delete" label="Delete" aria="delete widget" disabled={sel.length === 0} onClick={() => p.treeOp((root) => removeWidget(root, sel))} />
      </div>
      <div className="tl-uidoc__row">
        <select className="tl-input" aria-label="move into container" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
          <option value="">move into…</option>
          {containers.map((r) => (
            <option key={pathKey(r.path)} value={pathKey(r.path)}>
              {'  '.repeat(r.depth)}
              {widgetLabel(r.widget)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="tl-btn tl-btn--small"
          aria-label="move widget into"
          disabled={moveTo === '' || sel.length === 0}
          onClick={() => {
            const to = parsePathKey(moveTo);
            if (to !== null) p.treeOp((root) => reparentWidget(root, sel, to));
            setMoveTo('');
          }}
        >
          Move
        </button>
      </div>
      <ul className="tl-uidoc__tree" role="tree" aria-label="widgets">
        {rows.map((r) => {
          const key = pathKey(r.path);
          return (
            <li
              key={key}
              role="treeitem"
              aria-selected={key === p.selKey}
              className={`tl-uidoc__node${key === p.selKey ? ' is-active' : ''}`}
              data-path={key}
              style={{ paddingLeft: 6 + r.depth * 12 }}
              draggable={r.path.length > 0 && r.path[r.path.length - 1] !== 't'}
              onClick={() => p.onSelect(key)}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, key);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                if (Array.from(e.dataTransfer.types).includes(DRAG_TYPE)) e.preventDefault();
              }}
              onDrop={(e) => onDrop(e, r.path, r.widget)}
              title={holds(r.widget) === 'children' ? 'Drop a widget here to move it inside' : 'Drop a widget here to move it before this one'}
            >
              <span className="tl-uidoc__type">{r.widget.type}</span> {r.widget.id ?? ''}
              {r.path[r.path.length - 1] === 't' ? ' (template)' : ''}
            </li>
          );
        })}
      </ul>
      {rows.length === 1 && (
        <EmptyState
          kind="ui"
          title="No widgets yet"
          actions={
            <>
              <ToolButton action="add" label="Text" aria="add a text widget" onClick={() => add('text')} />
              <ToolButton action="add" label="Button" aria="add a button widget" onClick={() => add('button')} />
              <ToolButton action="add" label="Bar" aria="add a bar widget" onClick={() => add('bar')} />
            </>
          }
        >
          A UI document is a tree of widgets inside its root panel, drawn over the game. Add one here, then place it on the canvas and bind its values in the inspector.
        </EmptyState>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Widget inspector
// ---------------------------------------------------------------------------

/** Widget fields with their own control (or edited elsewhere): not drawn by the descriptor rows. */
const WIDGET_CUSTOM = ['type', 'children', 'template', 'size', 'style', 'css', 'visible', 'enabled', 'image', 'value', 'min', 'max', 'startAngle', 'items', 'fillStyle', 'onClick', 'onSubmit', 'onFocus', 'worldAnchor'];

function WidgetInspector(p: {
  doc: UiDocument;
  theme: UiTheme | undefined;
  path: WidgetPath;
  widget: UiWidget;
  anchored: boolean;
  D: UiDescriptors;
  ctx: FieldContext;
  docIds: readonly string[];
  tweens: readonly string[];
  ids: readonly string[];
  entities: readonly { id: string; name: string }[];
  onEdit: (fn: (w: UiWidget) => UiWidget) => void;
  onPreset: (preset: (typeof ANCHOR_PRESETS)[number], keep: boolean) => void;
  onFail: (m: string) => void;
}): JSX.Element {
  const w = p.widget;
  const desc = p.D.widget;
  const field = (key: string): FieldDescriptor | undefined => desc.fields.find((f) => f.key === key && appliesTo(f, w));
  const put = (key: string, v: unknown): void => p.onEdit((cur) => setAt(cur, [key], v) as UiWidget);
  const cur = currentPreset(w);
  const bindings = ['value', 'min', 'max', 'startAngle', 'image', 'items', 'visible', 'enabled'].map(field).filter((f): f is FieldDescriptor => f !== undefined);
  const wa = desc.fields.find((f) => f.key === 'worldAnchor') as ObjectFieldDescriptor;
  const names = styleNames(p.doc, p.theme);
  const [ownStyle, setOwnStyle] = useState(w.css !== undefined);
  return (
    <div className="tl-uidoc__panel" aria-label="widget inspector">
      <div className="tl-subhead">
        {w.type}
        {p.path.length === 0 ? ' (root)' : ''} <span className="tl-hint">{pathKey(p.path)}</span>
      </div>
      {p.anchored && w.worldAnchor === undefined && (
        <div className="tl-uidoc__presets" aria-label="anchor presets" title="Pin the widget to a point or an edge of its parent (it stays where it is; Alt-click moves it onto the anchor)">
          {ANCHOR_PRESETS.map((a) => (
            <button
              key={a.label}
              type="button"
              className={`tl-uidoc__preset${cur === a ? ' is-active' : ''}`}
              aria-label={`anchor ${a.label}`}
              aria-pressed={cur === a}
              onClick={(e) => p.onPreset(a, !e.altKey)}
            >
              <span className="tl-uidoc__preset-dot" style={{ left: a.x === null ? '10%' : `${a.x * 80 + 10}%`, top: a.y === null ? '10%' : `${a.y * 80 + 10}%`, width: a.x === null ? '80%' : undefined, height: a.y === null ? '80%' : undefined }} />
            </button>
          ))}
        </div>
      )}
      {!p.anchored && p.path.length > 0 && w.worldAnchor === undefined && <p className="tl-hint">Its parent lays it out (a stack, grid, list or button): order it in the hierarchy; size and grow apply.</p>}
      <SizeField value={w.size} aria="widget size" disabledAxes={[w.stretch === 'x' || w.stretch === 'both', w.stretch === 'y' || w.stretch === 'both']} onChange={(v) => put('size', v)} />
      <ObjectFields
        desc={desc}
        value={w as unknown as Record<string, unknown>}
        path={[]}
        component="widget"
        ctx={p.ctx}
        skip={WIDGET_CUSTOM}
        onEdit={(path: FieldPath, next: unknown) => p.onEdit((cur2) => setAt(cur2, path, next) as UiWidget)}
        onFail={p.onFail}
      />
      {bindings.length > 0 && <div className="tl-desc__group-title">Values</div>}
      {bindings.map((f) => (
        <BindingField key={f.key} f={f} value={(w as unknown as Record<string, unknown>)[f.key]} aria={`widget ${f.key}`} entities={p.entities} onChange={(v) => put(f.key, v)} />
      ))}
      <div className="tl-desc__group-title">Style</div>
      <StyleRefField label="Styles" aria="widget style" value={w.style} names={names} onChange={(v) => put('style', v)} />
      {w.type === 'bar' && <StyleRefField label="Fill styles" aria="widget fill style" value={w.fillStyle} names={names} onChange={(v) => put('fillStyle', v)} />}
      <label className="tl-flag">
        <input
          type="checkbox"
          aria-label="widget own style"
          checked={ownStyle || w.css !== undefined}
          onChange={(e) => {
            setOwnStyle(e.target.checked);
            if (!e.target.checked && w.css !== undefined) put('css', undefined);
          }}
        />
        own style (this widget only)
      </label>
      {(ownStyle || w.css !== undefined) && <StyleEditor desc={p.D.style} style={w.css ?? {}} aria="widget css" ctx={p.ctx} withStates onChange={(next) => put('css', Object.keys(next).length === 0 ? undefined : next)} onFail={p.onFail} />}
      {field('onClick') !== undefined && <ActionsField label="On click" aria="widget on click" value={w.onClick} docs={p.docIds} tweens={p.tweens} widgets={p.ids} scenes={p.ctx.scenes} onChange={(v) => put('onClick', v)} onFail={p.onFail} />}
      {field('onSubmit') !== undefined && <ActionsField label="On submit" aria="widget on submit" value={w.onSubmit} docs={p.docIds} tweens={p.tweens} widgets={p.ids} scenes={p.ctx.scenes} onChange={(v) => put('onSubmit', v)} onFail={p.onFail} />}
      <ActionsField label="On focus" aria="widget on focus" value={w.onFocus} docs={p.docIds} tweens={p.tweens} widgets={p.ids} scenes={p.ctx.scenes} onChange={(v) => put('onFocus', v)} onFail={p.onFail} />
      <div className="tl-desc__group-title">World anchor</div>
      <label className="tl-flag" title={wa.tooltip}>
        <input type="checkbox" aria-label="widget follows the world" checked={w.worldAnchor !== undefined} onChange={(e) => put('worldAnchor', e.target.checked ? { point: [0, 0, 0] } : undefined)} />
        follow an entity or a world point
      </label>
      {w.worldAnchor !== undefined && (
        <>
          <label className="tl-flag">
            <input
              type="checkbox"
              aria-label="world anchor follows an entity"
              checked={w.worldAnchor.entity !== undefined}
              onChange={(e) => {
                const { entity: _e, point: _p, ...rest } = w.worldAnchor!;
                put('worldAnchor', e.target.checked ? { ...rest, entity: p.entities[0]?.id ?? { bind: 'target' } } : { ...rest, point: [0, 0, 0] });
              }}
            />
            an entity (else a point)
          </label>
          {w.worldAnchor.entity !== undefined && (
            <BindingField f={wa.fields.find((f) => f.key === 'entity')!} value={w.worldAnchor.entity} aria="world anchor entity" entities={p.entities} onChange={(v) => put('worldAnchor', { ...w.worldAnchor, entity: v })} />
          )}
          <ObjectFields
            desc={wa}
            value={w.worldAnchor as unknown as Record<string, unknown>}
            path={['worldAnchor']}
            component="widget"
            ctx={p.ctx}
            skip={['entity', ...(w.worldAnchor.entity !== undefined ? ['point'] : [])]}
            onEdit={(path: FieldPath, next: unknown) => p.onEdit((cur2) => setAt(cur2, path, next) as UiWidget)}
            onFail={p.onFail}
          />
        </>
      )}
    </div>
  );
}

/** A field's `when` holds for this widget (type conditions only). */
function appliesTo(f: FieldDescriptor, w: UiWidget): boolean {
  if (f.when === undefined) return true;
  const list = Array.isArray(f.when) ? f.when : [f.when];
  return list.every((c: { key: string; in: readonly unknown[] }) => c.in.includes((w as unknown as Record<string, unknown>)[c.key]));
}

// ---------------------------------------------------------------------------
// Document inspector
// ---------------------------------------------------------------------------

const DOC_CUSTOM = ['uiDocumentId', 'styles', 'icons', 'tweens', 'root', 'onCancel'];

function DocumentInspector(p: {
  doc: UiDocument;
  D: UiDescriptors;
  ctx: FieldContext;
  docIds: readonly string[];
  ids: readonly string[];
  onEdit: (fn: (d: UiDocument) => UiDocument) => void;
  onOpenTheme: (id: string) => void;
  onPlay: (tween: string) => void;
  onFail: (m: string) => void;
}): JSX.Element {
  const d = p.doc;
  const tweens = d.tweens ?? {};
  const tweenNames = Object.keys(tweens).sort();
  const [tween, setTween] = useState<string | null>(tweenNames[0] ?? null);
  const cur = tween !== null && tweens[tween] !== undefined ? tween : (tweenNames[0] ?? null);
  const setMap = <K extends 'styles' | 'tweens' | 'icons'>(key: K, next: Record<string, unknown>): void =>
    p.onEdit((doc) => {
      const out = { ...doc } as Record<string, unknown>;
      if (Object.keys(next).length === 0) delete out[key];
      else out[key] = next;
      return out as unknown as UiDocument;
    });
  return (
    <div className="tl-uidoc__panel" aria-label="document inspector">
      <div className="tl-subhead">
        Document <span className="tl-hint">{d.uiDocumentId}</span>
        {d.theme !== undefined && (
          <button type="button" className="tl-btn tl-btn--small" onClick={() => p.onOpenTheme(d.theme!)} aria-label="edit theme">
            Edit theme
          </button>
        )}
      </div>
      <ObjectFields desc={p.D.document} value={d as unknown as Record<string, unknown>} path={[]} component="document" ctx={p.ctx} skip={DOC_CUSTOM} onEdit={(path: FieldPath, next: unknown) => p.onEdit((doc) => setAt(doc, path, next) as UiDocument)} onFail={p.onFail} />
      <ActionsField label="On cancel" aria="document on cancel" value={d.onCancel} docs={p.docIds} tweens={tweenNames} widgets={p.ids} scenes={p.ctx.scenes} onChange={(v) => p.onEdit((doc) => setAt(doc, ['onCancel'], v) as UiDocument)} onFail={p.onFail} />
      <div className="tl-desc__group-title">Styles</div>
      <StyleMapEditor desc={p.D.style} styles={d.styles ?? {}} aria="document" ctx={p.ctx} onChange={(next) => setMap('styles', next)} onFail={p.onFail} />
      <div className="tl-desc__group-title">Tweens</div>
      <div className="tl-uidoc__row">
        <select className="tl-input" aria-label="tween" value={cur ?? ''} onChange={(e) => setTween(e.target.value)}>
          {tweenNames.length === 0 && <option value="">no tweens</option>}
          {tweenNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="tl-btn tl-btn--small"
          aria-label="add tween"
          disabled={tweenNames.length >= UI_LIMITS.tweens}
          onClick={() => {
            const n = uniqueName('tween', new Set(tweenNames));
            const t: UiTween = { kind: 'fade', duration: 0.2 };
            setMap('tweens', { ...tweens, [n]: t });
            setTween(n);
          }}
        >
          + Tween
        </button>
        {cur !== null && (
          <>
            <button type="button" className="tl-btn tl-btn--small" aria-label={`play tween ${cur}`} onClick={() => p.onPlay(cur)}>
              ▶ Play
            </button>
            <button
              type="button"
              className="tl-btn tl-btn--small"
              aria-label={`delete tween ${cur}`}
              onClick={() => {
                const { [cur]: _gone, ...rest } = tweens;
                setMap('tweens', rest);
                setTween(null);
              }}
            >
              Delete
            </button>
          </>
        )}
      </div>
      {cur !== null && (
        <ObjectFields
          key={cur}
          desc={p.D.tween}
          value={tweens[cur] as unknown as Record<string, unknown>}
          path={[]}
          component={`tween ${cur}`}
          ctx={p.ctx}
          onEdit={(path: FieldPath, next: unknown) => setMap('tweens', { ...tweens, [cur]: setAt(tweens[cur], path, next) })}
          onFail={p.onFail}
        />
      )}
      <div className="tl-desc__group-title">Icons</div>
      <IconMapEditor icons={d.icons ?? {}} onChange={(next) => setMap('icons', next)} />
    </div>
  );
}

/** Named rich-text icons ([icon=name]): a texture and an optional part of it. */
export function IconMapEditor(p: { icons: Readonly<Record<string, UiIcon>>; onChange: (next: Record<string, UiIcon>) => void }): JSX.Element {
  const names = Object.keys(p.icons).sort();
  const textures = useFirstEntry(TEXTURE_KINDS);
  return (
    <div className="tl-uidoc__icons" aria-label="icons">
      {names.map((n) => {
        const ic = p.icons[n]!;
        return (
          <div key={n} className="tl-uidoc__row" data-icon={n}>
            <span className="tl-hint">{n}</span>
            <RefPicker aria={`icon ${n} texture`} kinds={TEXTURE_KINDS} value={ic.asset} onPick={(id) => id !== '' && p.onChange({ ...p.icons, [n]: { ...ic, asset: id } })} />
            <CommitText
              aria={`icon ${n} part`}
              placeholder="x, y, w, h (whole image)"
              value={ic.rect?.join(', ') ?? ''}
              onCommit={(raw) => {
                const { rect: _r, ...rest } = ic;
                if (raw.trim() === '') return p.onChange({ ...p.icons, [n]: rest });
                const v = raw.split(',').map((x) => Number(x.trim()));
                if (v.length === 4 && v.every((x) => Number.isFinite(x) && x >= 0)) p.onChange({ ...p.icons, [n]: { ...rest, rect: v as [number, number, number, number] } });
              }}
            />
            <button
              type="button"
              className="tl-btn tl-btn--small"
              aria-label={`delete icon ${n}`}
              onClick={() => {
                const { [n]: _gone, ...rest } = p.icons;
                p.onChange(rest);
              }}
            >
              ✕
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="tl-btn tl-btn--small"
        aria-label="add icon"
        disabled={textures.first === null || names.length >= UI_LIMITS.icons}
        title={textures.first === null ? 'Import a texture first' : 'A glyph for rich text: [icon=name]'}
        onClick={() => textures.first !== null && p.onChange({ ...p.icons, [uniqueName('icon', new Set(names))]: { asset: textures.first } })}
      >
        + Icon
      </button>
    </div>
  );
}

export type { Rect };
