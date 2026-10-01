/**
 * A floating tool window over the Scene view (Lighting, Environment): a
 * title bar to drag it by, the scene it edits named at the top with a picker
 * to edit another, its panel, and a corner to resize it by. Where it stands
 * is remembered (tool-windows.ts). The scene picker makes the chosen scene
 * the active one (opened if it was closed), because the Scene view previews
 * the active scene's look and lighting: what the window edits is what the
 * view shows (Unity's Lighting window edits the active scene's settings).
 *
 * Browser-only (React).
 */
import { useRef, type JSX, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { clampPlace, type ToolWindowId, type ToolWindowPlace } from './tool-windows';

export interface SceneChoice {
  sceneId: string;
  name: string;
}

interface Props {
  id: ToolWindowId;
  title: string;
  place: ToolWindowPlace;
  /** The work area's size (the window is kept inside it). */
  area: { width: number; height: number };
  /** Stacking order among the tool windows (the last one opened or touched is on top). */
  z: number;
  /** Every scene of the project, in index order, and the one the window edits (the active scene). */
  scenes: readonly SceneChoice[];
  sceneId: string | null;
  onScene: (sceneId: string) => void;
  onPlace: (place: ToolWindowPlace) => void;
  onFront: () => void;
  onClose: () => void;
  children: ReactNode;
}

export function ToolWindow(p: Props): JSX.Element {
  const box = useRef<HTMLElement | null>(null);
  const shown = clampPlace(p.place, p.area.width, p.area.height);
  /** Follow the pointer from where it went down, moving (title bar) or resizing (corner); stored on release. */
  const follow = (e: ReactPointerEvent<HTMLElement>, how: 'move' | 'resize'): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const start = { x: e.clientX, y: e.clientY };
    let last = shown;
    handle.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent): void => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      last = clampPlace(how === 'move' ? { ...shown, x: shown.x + dx, y: shown.y + dy } : { ...shown, width: shown.width + dx, height: shown.height + dy }, p.area.width, p.area.height);
      const el = box.current;
      if (el !== null) Object.assign(el.style, { left: `${last.x}px`, top: `${last.y}px`, width: `${last.width}px`, height: `${last.height}px` });
    };
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      p.onPlace(last);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };
  const scene = p.scenes.find((s) => s.sceneId === p.sceneId) ?? null;
  return (
    <section
      ref={box}
      className="tl-tool-window"
      aria-label={`${p.title} window`}
      data-tool-window={p.id}
      style={{ left: shown.x, top: shown.y, width: shown.width, height: shown.height, zIndex: p.z }}
      onPointerDownCapture={p.onFront}
    >
      <div className="tl-tool-window__title" aria-label={`Move the ${p.title} window`} onPointerDown={(e) => (e.target as HTMLElement).closest('button') === null && follow(e, 'move')}>
        <span className="tl-tool-window__name">{p.title}</span>
        <button type="button" className="tl-editor-window__close" aria-label={`Close the ${p.title} window`} title="Close (Window menu opens it again where it was)" onClick={p.onClose}>
          ×
        </button>
      </div>
      <label className="tl-tool-window__scene" data-scene-id={scene?.sceneId ?? ''} title="The scene this window edits: the active scene, whose look and lighting the Scene view shows. Choosing another makes it active (and opens it).">
        <span className="tl-field__label">Scene</span>
        <select className="tl-input" aria-label={`${p.title} scene`} value={scene?.sceneId ?? ''} disabled={p.scenes.length === 0} onChange={(e) => e.target.value !== '' && p.onScene(e.target.value)}>
          {scene === null && <option value="">— no scene —</option>}
          {p.scenes.map((s) => (
            <option key={s.sceneId} value={s.sceneId}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <div className="tl-tool-window__body">{p.children}</div>
      <div className="tl-tool-window__resize" aria-label={`Resize the ${p.title} window`} onPointerDown={(e) => follow(e, 'resize')} />
    </section>
  );
}
