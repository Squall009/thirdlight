/**
 * The open Lighting and Environment windows, floating over the Scene view
 * (shown while the Scene view is in front; the editor window, Project
 * Settings and the Game view set them aside without closing them). Each
 * names the scene it edits, the active scene, with a picker to edit another.
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX, type RefObject } from 'react';
import type { ProjectedEntity } from '../../session/projection';
import { bakeIsStale } from '../../viewport/bake-run';
import { EnvironmentPanel } from '../EnvironmentPanel';
import { LightingPanel } from '../LightingPanel';
import type { SceneHeaderView } from '../Hierarchy';
import type { ClientRef, ViewportRef } from '../shell/commands';
import type { ProjectContent } from '../shell/useProjectContent';
import type { LightingBakeState } from '../shell/useLightingBake';
import type { DocumentCommands } from '../workspace/useDocumentCommands';
import { ToolWindow, type SceneChoice } from './ToolWindow';
import { TOOL_WINDOWS, type ToolWindowId, type ToolWindowPlace, type ToolWindows } from './tool-windows';

/**
 * Where a tool window first opens: along the top of the Scene view from its
 * right edge, the `slot`-th from the right (side by side while they fit, else
 * stacked with a small offset), inside the work area.
 */
export function defaultToolPlace(area: HTMLElement | null, stage: HTMLElement | null, slot: number): ToolWindowPlace {
  const a = area?.getBoundingClientRect();
  const s = stage?.getBoundingClientRect();
  if (a === undefined || s === undefined) return { x: 40 + 24 * slot, y: 40 + 24 * slot, width: 380, height: 520 };
  const width = Math.min(380, Math.max(280, s.width - 24));
  const height = Math.min(620, Math.max(200, s.height - 24));
  const right = s.right - a.left - 12;
  const beside = right - (width + 12) * slot - width;
  return beside >= s.left - a.left + 12 ? { x: beside, y: s.top - a.top + 12, width, height } : { x: right - width - 24 * slot, y: s.top - a.top + 12 + 24 * slot, width, height };
}

/** The work area's size, followed as it changes (the windows are kept inside it). */
function useAreaSize(area: RefObject<HTMLElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = area.current;
    if (el === null) return;
    const read = (): void => setSize({ width: el.clientWidth, height: el.clientHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [area]);
  return size;
}

export interface SceneToolWindowsProps {
  tools: ToolWindows;
  area: RefObject<HTMLElement | null>;
  clientRef: ClientRef;
  viewportRef: ViewportRef;
  content: ProjectContent;
  docCmds: DocumentCommands;
  bake: LightingBakeState;
  entities: ProjectedEntity[];
  /** The open scenes, the active one marked. */
  sceneHeaders: readonly SceneHeaderView[] | null;
  /** Make a scene the active one (opening it when it is closed). */
  activateScene: (sceneId: string) => void;
}

export function SceneToolWindows(p: SceneToolWindowsProps): JSX.Element | null {
  const area = useAreaSize(p.area);
  if (p.tools.open.length === 0 || area.width === 0) return null;
  const active = p.sceneHeaders?.find((h) => h.active) ?? null;
  // Every scene in index order (the open ones and the closed ones; App re-renders when they change).
  const scenes: SceneChoice[] = (p.clientRef.current?.projection.scenes ?? []).map((r) => ({ sceneId: r.sceneId, name: r.name }));
  const { environment, sceneLook, lighting } = p.content;
  const { saveEnvironment, saveSceneEnvironment, materialError } = p.docCmds;
  const b = p.bake;
  const body = (id: ToolWindowId): JSX.Element =>
    id === 'environment' ? (
      <EnvironmentPanel
        environment={environment}
        onSave={(env) => void saveEnvironment(env, environment)}
        look={sceneLook}
        onSaveLook={(look) => active !== null && void saveSceneEnvironment(active.sceneId, look, sceneLook)}
        error={materialError}
        presets={{
          lights: p.entities.filter((e) => e.light !== undefined).map((e) => ({ id: e.id, type: e.light!.type, color: e.light!.color, intensity: e.light!.intensity, ...(e.light!.direction !== undefined ? { direction: e.light!.direction } : {}), ...(e.light!.groundColor !== undefined ? { groundColor: e.light!.groundColor } : {}) })),
          onPreview: (weights) => p.viewportRef.current?.previewEnvironmentBlend(weights === null ? null : { weights }, new Map((p.clientRef.current?.getTags() ?? []).map((t) => [t.name, t.bit]))),
        }}
      />
    ) : active === null ? (
      <p className="tl-hint">Lighting bakes need a project with scenes (storage v4).</p>
    ) : (
      <LightingPanel
        bake={lighting[active.sceneId] ?? null}
        stale={lighting[active.sceneId] !== undefined && bakeIsStale(lighting[active.sceneId]!, (p.clientRef.current?.projection.listEntities() ?? []).filter((e) => e.sceneId === active.sceneId), (id) => p.clientRef.current?.getBlockLayers().get(id)?.chunks)}
        settings={b.bakeSettings}
        onSettings={b.setBakeSettings}
        busy={b.bakeBusy}
        finalUnavailable={b.bakeHost}
        message={b.bakeMessage}
        onBakePreview={() => void b.bakePreview()}
        onBakeFinal={() => void b.bakeFinal()}
        onCancel={() => b.bakeAbortRef.current?.abort()}
        onClear={() => void b.clearBake()}
      />
    );
  return (
    <div className="tl-tool-windows">
      {/* A stable DOM order (a window brought to the front keeps its focus); the stacking is the z-index. */}
      {TOOL_WINDOWS.map(({ id }) => {
        const z = p.tools.open.indexOf(id);
        const place = p.tools.places[id];
        if (z < 0 || place === undefined) return null;
        const title = TOOL_WINDOWS.find((t) => t.id === id)!.label;
        return (
          <ToolWindow
            key={id}
            id={id}
            title={title}
            place={place}
            area={area}
            z={z + 1}
            scenes={scenes}
            sceneId={active?.sceneId ?? null}
            onScene={p.activateScene}
            onPlace={(next) => p.tools.place(id, next)}
            onFront={() => p.tools.front(id)}
            onClose={() => p.tools.close(id)}
          >
            {body(id)}
          </ToolWindow>
        );
      })}
    </div>
  );
}
