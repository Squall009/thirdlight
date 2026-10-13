/**
 * The edit-mode shell: the frame every edit mode shares.
 *
 * It takes the work area over as the editor window does (the menus, the
 * toolbar and the status bar stay; the default view under it takes no
 * input): the header (what is edited, Context, undo, Done), the rail of the
 * editor's modes on the left, the live Scene view in the middle — its own
 * canvas, lent with input, never a second renderer — the mode's settings
 * column on the right and the status line with its hints and keys.
 *
 * While it shows, the view draws only the edited object (Context: the rest
 * too, not pickable) — a scene's mode draws the whole scene with only its
 * objects pickable — and the keys of the one key map (`edit-keys.ts`) work:
 * Esc leaves (after a stroke in flight is cancelled), C toggles Context,
 * Home frames the object, Shift+number picks a mode; other keys go to the
 * mode's Scene-view tools. Edits are the same commands as anywhere else, so
 * undo, MCP edits and the change feed reach the mode as they reach the rest.
 *
 * Browser-only (React).
 */
import { useEffect, useRef, useState, type JSX, type RefObject } from 'react';

import { editKeyAction, sharedKeyHints } from '../../session/edit-keys';
import type { Viewport } from '../../viewport/viewport';
import { iconSrc, iconTitle, objectIconFor, type IconKind, type IconTable } from '../../viewport/icons';
import type { SceneViewLending } from '../shell/useSceneViewLending';
import { isTyping } from '../workspace/EditorWindow';
import { EditModeHeader } from './EditModeHeader';
import { EditStatusContext, type EditStatus } from './edit-status';
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

/** The shell while a mode shows (rendered only then). */
export function EditModeShell(p: EditModeShellProps): JSX.Element | null {
  const { state, entity, kind } = p.mode;
  const viewHost = useRef<HTMLDivElement | null>(null);
  const latest = useRef(p);
  latest.current = p;
  const [status, setStatus] = useState<EditStatus | null>(null);

  // The Scene view's canvas, lent with input while the shell shows.
  useEffect(() => {
    const el = viewHost.current;
    if (el === null) return undefined;
    const release = latest.current.sceneView.borrow(el, 'edit');
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => latest.current.sceneView.resize()) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      release();
    };
  }, []);

  // Only the edited object drawn (the rest too with Context), and only it hit; a scene's mode: the whole scene drawn, only its component's objects hit.
  const entityId = state?.entityId ?? null;
  const context = state?.context ?? false;
  const component = kind !== undefined && isSceneMode(kind) ? kind.component : null;
  useEffect(() => {
    if (entityId === null) return undefined;
    p.viewportRef.current?.setIsolation(component !== null ? { ids: [], context: true, component } : { ids: [entityId], context });
    return () => p.viewportRef.current?.setIsolation(null);
  }, [entityId, context, component, p.viewportRef]);

  /** Whether the object shows in the view now (a few points over its middle find it). */
  const onScreen = (id: string): boolean => {
    const r = viewHost.current?.getBoundingClientRect();
    const v = latest.current.viewportRef.current;
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
      const { mode, viewportRef } = latest.current;
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

  // The key map (after the Scene view's own Esc cancelled a stroke, which marks the key taken).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const { mode, viewportRef } = latest.current;
      const k = mode.kind;
      if (e.defaultPrevented || k === undefined || mode.state === null || isTyping(e.target)) return;
      if (document.querySelector('[aria-modal="true"]') !== null) return;
      const action = editKeyAction(e, k.rail.length);
      if (action === null) {
        if (viewportRef.current?.toolKey(e, k.tools) === true) e.preventDefault();
        return;
      }
      // A scene's mode has no object to frame or show alone: Home and C are not its keys.
      if (isSceneMode(k) && (action.kind === 'context' || action.kind === 'frame')) return;
      e.preventDefault();
      if (action.kind === 'done') mode.leave();
      else if (action.kind === 'context') mode.toggleContext();
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
      />
      <div className="tl-editmode__body">
        <ToolRail items={kind.rail} active={rail.id} onPick={p.mode.setMode} />
        <div className="tl-editmode__view">
          {/* Empty for React: the Scene view's canvas is put here (and taken back) by the editor. */}
          <div className="tl-editmode__canvas" ref={viewHost} />
          {scene ? <ViewportChrome objectName={name} context chip={kind.chip} extra={kind.viewExtra?.(sceneView)} /> : <ViewportChrome objectName={name} context={state.context} extra={kind.viewExtra?.({ entity: entity!, mode: rail.id, host: p.host })} />}
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
            {status !== null && status.tool !== rail.label && <span className="tl-editmode__tool">{status.tool}</span>}
          </div>
          <div className="tl-editmode__column-body" key={scene ? kind.kind : entity!.id}>
            <EditStatusContext.Provider value={setStatus}>{scene ? kind.column(sceneView) : kind.column({ entity: entity!, mode: rail.id, host: p.host })}</EditStatusContext.Provider>
          </div>
        </aside>
      </div>
      <StatusHints tool={status?.tool ?? rail.label} text={status?.text ?? rail.hint} keys={[...(status?.keys ?? []), ...(rail.keys ?? []), ...sharedKeyHints(kind.rail.length).filter((h) => !scene || (h.label !== 'Context' && h.label !== 'Frame'))]} {...(status?.right !== undefined ? { right: status.right } : {})} />
    </section>
  );
}
