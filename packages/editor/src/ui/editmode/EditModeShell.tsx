/**
 * The edit-mode shell: the frame every edit mode shares.
 *
 * It takes the work area over as the editor window does (the menus, the
 * toolbar and the status bar stay; the default view under it takes no
 * input): the header (what is edited, Context, undo, Done), the rail of the
 * editor's modes on the left, the live Scene view in the middle — its own
 * canvas, lent with input, never a second renderer — the mode's settings
 * column on the right (with its detail column beside it, folded into the
 * settings column on a narrow window) and the status line with its hints
 * and keys.
 *
 * While it shows, the view draws only the edited object (Context: the rest
 * too, not pickable) — a scene's mode draws the whole scene with only its
 * objects pickable — and the keys of the one key map (`edit-keys.ts`) work:
 * Esc leaves a field typed in, then (after a stroke in flight is cancelled)
 * clears the mode's selection, drops the tool, and only then leaves; Space
 * arms the last tool, C toggles Context, Home frames the object,
 * Shift+number picks a mode; other keys go to the mode's Scene-view tools.
 *
 * A mode's column may declare docked panels over the view (`docks.tsx`):
 * the settings of what is picked, collapsible and movable between the
 * view's edges and corners, their layout remembered per editor.
 *
 * Every editor opens in Navigate: no tool armed, a drag orbits and a click
 * selects (`edit-tool.tsx` holds that state for every editor alike). The
 * status line starts with the tool, or "Navigate", and says what Esc does
 * next; Done's Esc badge dims while Esc would not leave. Edits are the same commands as anywhere else, so
 * undo, MCP edits and the change feed reach the mode as they reach the rest.
 *
 * Browser-only (React).
 */
import { useEffect, useRef, useState, useSyncExternalStore, type JSX, type RefObject } from 'react';

import { editKeyAction, escapeStep, sharedKeyHints } from '../../session/edit-keys';
import type { Viewport } from '../../viewport/viewport';
import { iconSrc, iconTitle, objectIconFor, type IconKind, type IconTable } from '../../viewport/icons';
import type { SceneViewLending } from '../shell/useSceneViewLending';
import { isTyping } from '../workspace/EditorWindow';
import { DockLayer, DockProvider, PanelsChip, useDockHost } from './docks';
import { EditModeHeader } from './EditModeHeader';
import { EditStatusContext, type EditStatus } from './edit-status';
import { EditToolContext, useEditToolHost } from './edit-tool';
import { isSceneMode, type EditModeHost } from './modes';
import { StatusHints } from './StatusHints';
import { ToolRail } from './ToolRail';
import type { EditMode } from './useEditMode';
import { ViewportChrome } from './ViewportChrome';

export interface EditModeShellProps {
  mode: EditMode;
  host: EditModeHost;
  sceneView: SceneViewLending;
  viewportRef: RefObject<Viewport | null>;
  icons: IconTable;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** The editor's message over the view (a refused edit), as the Scene view shows it; null: none. */
  notice: string | null;
  onDismissNotice: () => void;
}

/** Points a side the view is sampled at to tell whether an object is on screen (a mode that frames on entering keeps a view that shows it). */
const ON_SCREEN_GRID = 5;

/** What Navigate does where the mode says nothing of its own. */
const NAVIGATE_HINT = 'A drag orbits, a click selects.';

/** A key press on one of these is the control's own (Space presses a button, ticks a box). */
const OWN_SPACE = 'button, input, select, textarea, [role="button"], [role="tab"], [role="slider"], [contenteditable="true"]';

/** Controls a mouse click leaves without the keyboard focus (fields, menus and sliders keep it: they are typed or stepped in). */
const CLICK_RELEASES_FOCUS = 'button, [role="button"], [role="switch"], [role="radio"], [role="tab"], [role="checkbox"], input[type="checkbox"], input[type="radio"]';

/** Narrower than this, a detail column folds into the settings column (the view keeps room to work in). */
const DETAIL_COLUMN_MIN_WIDTH = '(min-width: 1440px)';

/** Whether the window is wide enough for a detail column beside the settings column. */
function useWideWindow(): boolean {
  return useSyncExternalStore(
    (l) => {
      const q = window.matchMedia(DETAIL_COLUMN_MIN_WIDTH);
      q.addEventListener('change', l);
      return () => q.removeEventListener('change', l);
    },
    () => window.matchMedia(DETAIL_COLUMN_MIN_WIDTH).matches,
  );
}

/** The shell while a mode shows (rendered only then). */
export function EditModeShell(p: EditModeShellProps): JSX.Element | null {
  const { state, entity, kind } = p.mode;
  const viewHost = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<EditStatus | null>(null);
  const wide = useWideWindow();
  const railNow = state === null || kind === undefined ? undefined : (kind.rail.find((r) => r.id === state.mode) ?? kind.rail[0]);
  const tool = useEditToolHost(state?.armed ?? false, p.mode.setArmed, railNow?.navigate ?? NAVIGATE_HINT);
  const docks = useDockHost(kind?.kind ?? '');
  /** A mode shows (its section is there). */
  const open = state !== null;
  const latest = useRef({ p, tool });
  latest.current = { p, tool };

  // The Scene view's canvas, lent with input while the shell shows.
  useEffect(() => {
    const el = viewHost.current;
    if (el === null) return undefined;
    const release = latest.current.p.sceneView.borrow(el, 'edit');
    // The control that opened the editor (a Hierarchy row, the Inspector's button) is under it now: the keys are the editor's.
    const focused = document.activeElement as HTMLElement | null;
    if (focused !== null && focused !== document.body && el.closest('.tl-editmode')?.contains(focused) !== true) focused.blur();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => latest.current.p.sceneView.resize()) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      release();
    };
  }, []);

  // Only the edited object drawn (and what belongs to it; the rest too with Context), and only those hit; a scene's
  // mode: the whole scene drawn, only its component's objects hit.
  const entityId = state?.entityId ?? null;
  const context = state?.context ?? false;
  const component = kind !== undefined && isSceneMode(kind) ? kind.component : null;
  const companions = kind !== undefined && !isSceneMode(kind) && entity !== undefined ? (kind.companions?.(entity, p.host.entities) ?? []).join('\u0000') : '';
  useEffect(() => {
    if (entityId === null) return undefined;
    p.viewportRef.current?.setIsolation(component !== null ? { ids: [], context: true, component } : { ids: [entityId, ...(companions === '' ? [] : companions.split('\u0000'))], context });
    return () => p.viewportRef.current?.setIsolation(null);
  }, [entityId, context, component, companions, p.viewportRef]);

  /** Whether the object shows in the view now (a few points over its middle find it). */
  const onScreen = (id: string): boolean => {
    const r = viewHost.current?.getBoundingClientRect();
    const v = latest.current.p.viewportRef.current;
    if (r === undefined || v === null || r.width === 0) return false;
    for (let i = 1; i <= ON_SCREEN_GRID; i++) for (let j = 1; j <= ON_SCREEN_GRID; j++) if (v.pickAt(r.left + (r.width * i) / (ON_SCREEN_GRID + 1), r.top + (r.height * j) / (ON_SCREEN_GRID + 1)) === id) return true;
    return false;
  };

  // On entering, the view looks at a working part of the object (Home frames all of it), once the object is drawn —
  // unless the user's view is already aimed at it, which is kept.
  useEffect(() => {
    if (entityId === null) return undefined;
    let raf = 0;
    let tries = 0;
    const attempt = (): void => {
      const { mode, viewportRef } = latest.current.p;
      const owed = mode.frameOwed();
      if (mode.entity === undefined || mode.kind === undefined || isSceneMode(mode.kind) || owed === null) return;
      const area = mode.kind.workArea?.(mode.entity) ?? null;
      const keepIf = owed === 'away' ? (mode.kind.bounds?.(mode.entity) ?? null) : null;
      const keep = owed === 'away' && (mode.kind.framesOnEnter !== true || onScreen(mode.entity.id));
      const settled = area !== null ? viewportRef.current?.frameWorkArea(mode.entity.id, area, keepIf) : keep || viewportRef.current?.frameEntity(mode.entity.id, mode.kind.bounds?.(mode.entity) ?? undefined);
      // A new object is drawn a few frames after it is made: try again until it is (two seconds at most).
      if (settled === true || ++tries > 120) mode.frameDone();
      else raf = requestAnimationFrame(attempt);
    };
    raf = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(raf);
  }, [entityId]);

  // A mouse click on a button, switch or tile leaves no keyboard focus on it, so Space (the last tool) and the letters
  // reach the editor next rather than pressing that control again; a keyboard's own click (detail 0) keeps its focus.
  useEffect(() => {
    const section = viewHost.current?.closest('.tl-editmode');
    if (section === null || section === undefined) return undefined;
    const onClick = (e: Event): void => {
      const t = e.target as HTMLElement | null;
      if ((e as MouseEvent).detail === 0 || t?.closest?.(CLICK_RELEASES_FOCUS) == null) return;
      const active = document.activeElement as HTMLElement | null;
      if (active !== null && active !== document.body && section.contains(active) && !isTyping(active)) active.blur();
    };
    section.addEventListener('click', onClick);
    return () => section.removeEventListener('click', onClick);
  }, [open]);

  // The key map (after the Scene view's own Esc cancelled a stroke, which marks the key taken).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const { p: q, tool: t } = latest.current;
      const { mode, viewportRef } = q;
      const k = mode.kind;
      if (k === undefined || mode.state === null || document.querySelector('[aria-modal="true"]') !== null) return;
      // Esc in a field of the editor leaves the field (after the field's own Esc put its value back); the editor never sees it.
      if (e.key === 'Escape' && isTyping(e.target) && !e.defaultPrevented && viewHost.current?.closest('.tl-editmode')?.contains(e.target as Node) === true) {
        (e.target as HTMLElement).blur();
        e.preventDefault();
        return;
      }
      if (e.defaultPrevented || isTyping(e.target)) return;
      const action = editKeyAction(e, k.rail.length);
      if (action === null) {
        if (viewportRef.current?.toolKey(e, k.tools) === true) e.preventDefault();
        return;
      }
      // A scene's mode has no object to frame or show alone: Home and C are not its keys.
      if (isSceneMode(k) && (action.kind === 'context' || action.kind === 'frame')) return;
      if (action.kind === 'last-tool') {
        // A control of the editor's own keeps its Space; one outside it (the button that opened the editor, under it now) does not.
        const el = e.target as HTMLElement | null;
        if (el !== null && el.closest?.(OWN_SPACE) != null && viewHost.current?.closest('.tl-editmode')?.contains(el) === true) return;
        e.preventDefault();
        if (t.hasTools()) t.api.arm();
        return;
      }
      e.preventDefault();
      if (action.kind === 'escape') {
        const step = escapeStep({ selection: t.hasSelection(), armed: t.isArmed() });
        if (step === 'deselect') t.clearSelection();
        else if (step === 'drop') t.api.drop();
        else mode.leave();
      } else if (action.kind === 'context') mode.toggleContext();
      else if (action.kind === 'mode') mode.setMode(k.rail[action.index]!.id);
      else if (mode.entity !== undefined && !isSceneMode(k)) viewportRef.current?.frameEntity(mode.entity.id, k.bounds?.(mode.entity) ?? undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (state === null || kind === undefined) return null;
  const scene = isSceneMode(kind);
  if (!scene && entity === undefined) return null;
  const rail = kind.rail.find((r) => r.id === state.mode) ?? kind.rail[0]!;
  const sceneView = { mode: rail.id, host: p.host, focus: state.focus };
  const icon = scene ? null : objectIconFor(entity!, p.icons);
  const name = scene ? (p.host.scene?.name ?? 'Scene') : entity!.name;
  const meta = scene ? kind.meta?.(sceneView) : kind.meta?.(entity!);
  const objectView = scene ? null : { entity: entity!, mode: rail.id, host: p.host };
  const detail = objectView === null || isSceneMode(kind) ? null : (kind.detail?.(objectView) ?? null);
  const navigate = tool.tools && !tool.api.armed;
  const selected = tool.selected[0] ?? null;
  const escLeaves = escapeStep({ selection: selected !== null, armed: tool.api.armed }) === 'leave';
  const shared = sharedKeyHints({ modes: kind.rail.length, tools: tool.tools, armed: tool.api.armed, selection: selected !== null, lastTool: tool.lastTool }).filter((h) => !scene || (h.label !== 'Context' && h.label !== 'Frame'));
  const ownKeys = [...(status?.keys ?? []), ...(rail.keys ?? [])];
  const hintText = navigate ? (selected !== null ? `${selected} selected. A drag orbits; a click selects another.` : (rail.navigate ?? NAVIGATE_HINT)) : (status?.text ?? rail.hint);
  const toolWord = navigate ? (selected !== null ? `Navigate · ${tool.selectedShort[0] ?? selected} selected` : 'Navigate · no tool') : status !== null && status.tool !== rail.label ? status.tool : null;
  return (
    <section className="tl-editmode" aria-label="edit mode" data-edit-mode={kind.kind} data-entity-id={scene ? '' : entity!.id}>
      <EditModeHeader
        icon={iconSrc(scene ? (kind.icon as IconKind) : icon!.kind)}
        iconTitle={scene ? kind.label : iconTitle(icon!)}
        editorLabel={kind.label}
        objectName={name}
        {...(meta !== undefined ? { meta } : {})}
        {...(scene ? (kind.note !== undefined ? { note: kind.note } : {}) : { context: state.context, onContext: p.mode.toggleContext })}
        canUndo={p.canUndo}
        canRedo={p.canRedo}
        onUndo={p.onUndo}
        onRedo={p.onRedo}
        onDone={p.mode.leave}
        escLeaves={escLeaves}
      />
      <EditToolContext.Provider value={tool.api}>
      <DockProvider host={docks}>
      <div className="tl-editmode__body">
        <ToolRail items={kind.rail} active={rail.id} onPick={p.mode.setMode} />
        <div className="tl-editmode__view">
          {/* Empty for React: the Scene view's canvas is put here (and taken back) by the editor. */}
          <div className="tl-editmode__canvas" ref={viewHost} />
          {scene ? <ViewportChrome objectName={name} context chip={kind.chip} extra={kind.viewExtra?.(sceneView)} panels={<PanelsChip host={docks} />} /> : <ViewportChrome objectName={name} context={state.context} extra={kind.viewExtra?.({ entity: entity!, mode: rail.id, host: p.host })} panels={<PanelsChip host={docks} />} />}
          {scene && kind.drawer?.(sceneView)}
          <DockLayer host={docks} />
          {p.notice !== null && (
            <div className="tl-notice" role="alert">
              <span>{p.notice}</span>
              <button className="tl-btn tl-btn--small" onClick={p.onDismissNotice}>
                dismiss
              </button>
            </div>
          )}
        </div>
        <aside className="tl-editmode__column" aria-label="edit mode settings">
          <div className="tl-editmode__column-head">
            <b>{rail.label}</b>
            {toolWord !== null && <span className="tl-editmode__tool">{toolWord}</span>}
          </div>
          <div className="tl-editmode__column-body" key={scene ? kind.kind : entity!.id}>
            <EditStatusContext.Provider value={setStatus}>
              {scene ? kind.column(sceneView) : kind.column(objectView!)}
              {detail !== null && !wide && <div className="tl-editmode__folded">{detail}</div>}
            </EditStatusContext.Provider>
          </div>
        </aside>
        {detail !== null && wide && (
          <aside className="tl-editmode__detail" aria-label="edit mode detail" key={entity!.id}>
            {detail}
          </aside>
        )}
      </div>
      </DockProvider>
      </EditToolContext.Provider>
      <StatusHints tool={navigate ? 'Navigate' : (status?.tool ?? rail.label)} text={hintText} keys={navigate ? [...shared, ...ownKeys] : [...ownKeys, ...shared]} {...(status?.right !== undefined ? { right: status.right } : {})} />
    </section>
  );
}
