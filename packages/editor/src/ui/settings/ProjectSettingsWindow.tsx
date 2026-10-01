/**
 * Project Settings (File → Project Settings): one full window over the
 * editor with a sub-tab per area of the project's settings, as Unity's and
 * Godot's Project Settings windows are, and a search field that filters the
 * sub-tabs by their names and the settings they hold. The panels are the
 * ones the bottom dock used to show, unchanged: every edit is the same
 * ordinary command.
 *
 * Esc (not while typing, not under a modal dialog) or × closes it and the
 * editor returns as it was; opening an item in the editor window (a script
 * double-clicked under Scripts) closes it too.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { DescriptorRegistry } from '@thirdlight/project-model';
import { RENDERING_SETTINGS_GROUP } from '@thirdlight/project-model/limits';
import type { ProjectedEntity } from '../../session/projection';
import type { WorkspaceState } from '../../session/editor-window';
import type { FieldContext } from '../DescriptorFields';
import { GameplayPanel } from '../GameplayPanel';
import { InputPanel } from '../InputPanel';
import { TagsPanel } from '../TagsPanel';
import { CollisionLayersPanel } from '../CollisionLayersPanel';
import { SavesPanel } from '../SavesPanel';
import { ModesPanel } from '../ModesPanel';
import { ShellPanel } from '../ShellPanel';
import { BehaviorPanel } from '../BehaviorPanel';
import { isTyping } from '../workspace/EditorWindow';
import type { ProjectSettings } from '../shell/useProjectSettings';
import type { ProjectContent } from '../shell/useProjectContent';
import type { DocumentCommands } from '../workspace/useDocumentCommands';
import type { Scripting } from '../shell/useScripting';
import type { PlaySession } from '../shell/usePlaySession';
import { QualityPanel } from './QualityPanel';
import { AudioPanel } from './AudioPanel';

export type SettingsSection = 'gameplay' | 'input' | 'tags' | 'layers' | 'quality' | 'audio' | 'saves' | 'modes' | 'shell' | 'scripts';

/**
 * The sub-tabs in the order the window lists them, with the words the search
 * also matches besides the name (Gameplay and Quality add their settings'
 * labels from the settings descriptor).
 */
export const SETTINGS_SECTIONS: ReadonlyArray<{ id: SettingsSection; label: string; keywords: readonly string[] }> = [
  { id: 'gameplay', label: 'Gameplay', keywords: ['settings', 'physics', 'character', 'engine', 'camera'] },
  { id: 'input', label: 'Input', keywords: ['actions', 'bindings', 'keys', 'keyboard', 'gamepad', 'mouse', 'pointer', 'cursor', 'touch'] },
  { id: 'tags', label: 'Tags', keywords: ['tag', 'labels'] },
  { id: 'layers', label: 'Collision layers', keywords: ['physics', 'collision', 'layers', 'masks'] },
  { id: 'quality', label: 'Quality', keywords: ['graphics', 'rendering', 'quality level'] },
  { id: 'audio', label: 'Audio', keywords: ['sound', 'event sounds', 'cues', 'signals'] },
  { id: 'saves', label: 'Saves', keywords: ['save', 'slots', 'schema', 'migrations', 'settings document'] },
  { id: 'modes', label: 'Game modes', keywords: ['modes', 'behavior groups', 'pause'] },
  { id: 'shell', label: 'Game shell', keywords: ['menus', 'hud', 'title', 'scenes', 'ui documents'] },
  { id: 'scripts', label: 'Scripts', keywords: ['behaviors', 'trust', 'publish', 'source', 'declarations', 'visual scripts'] },
];

/** The settings' labels and keys by group (Gameplay: all but Rendering; Quality: Rendering). */
function settingsWords(registry: DescriptorRegistry | null): { gameplay: string[]; quality: string[] } {
  const out = { gameplay: [] as string[], quality: [] as string[] };
  const desc = registry?.content.find((b) => b.key === 'settings')?.value;
  if (desc === undefined || desc.type !== 'object') return out;
  for (const f of desc.fields) (f.group === RENDERING_SETTINGS_GROUP ? out.quality : out.gameplay).push(f.label ?? f.key, f.key);
  return out;
}

/** The sub-tabs a search keeps (all for an empty search). */
export function filterSections(query: string, registry: DescriptorRegistry | null): SettingsSection[] {
  const q = query.trim().toLowerCase();
  if (q === '') return SETTINGS_SECTIONS.map((s) => s.id);
  const words = settingsWords(registry);
  return SETTINGS_SECTIONS.filter((s) => {
    const extra = s.id === 'gameplay' ? words.gameplay : s.id === 'quality' ? words.quality : [];
    return [s.label, ...s.keywords, ...extra].some((w) => w.toLowerCase().includes(q));
  }).map((s) => s.id);
}

export interface SettingsWindowState {
  open: boolean;
  section: SettingsSection;
  show: (section?: SettingsSection) => void;
  close: () => void;
  setSection: (section: SettingsSection) => void;
}

/**
 * Whether the window shows and which sub-tab is in front (kept while it is
 * closed, for this page). An item coming to the front of the editor window
 * closes it: that item is what the person asked to see.
 */
export function useProjectSettingsWindow(workspace: WorkspaceState): SettingsWindowState {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<SettingsSection>('gameplay');
  const front = workspace.open ? workspace.active : null;
  const lastFront = useRef(front);
  useEffect(() => {
    if (front !== null && front !== lastFront.current) setOpen(false);
    lastFront.current = front;
  }, [front]);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    // Capture phase: this window is on top, so its Esc goes before the editor window's and the Scene view's.
    const onEscape = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || !openRef.current || isTyping(e.target)) return;
      if (document.querySelector('[aria-modal="true"]') !== null) return;
      e.preventDefault();
      setOpen(false);
    };
    window.addEventListener('keydown', onEscape, true);
    return () => window.removeEventListener('keydown', onEscape, true);
  }, []);
  const show = useCallback((s?: SettingsSection) => {
    if (s !== undefined) setSection(s);
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  return useMemo(() => ({ open, section, show, close, setSection }), [open, section, show, close]);
}

export interface ProjectSettingsWindowProps {
  state: SettingsWindowState;
  settings: ProjectSettings;
  content: ProjectContent;
  docCmds: DocumentCommands;
  scripting: Scripting;
  play: PlaySession;
  entities: ProjectedEntity[];
  setSelection: (selection: { ids: string[]; primary: string | null }) => void;
  fieldContext: FieldContext;
  gameFieldContext: Omit<FieldContext, 'sceneId'>;
  tagUsage: Map<number, number>;
  layerUsage: Map<string, number>;
  groupUsage: Map<string, number>;
}

/** The full window (rendered only while it shows). */
export function ProjectSettingsWindow(props: ProjectSettingsWindowProps): JSX.Element | null {
  return props.state.open ? <OpenSettingsWindow {...props} /> : null;
}

function OpenSettingsWindow(props: ProjectSettingsWindowProps): JSX.Element {
  const { state } = props;
  const registry = props.content.registry;
  const [query, setQuery] = useState('');
  const kept = useMemo(() => filterSections(query, registry), [query, registry]);
  // The sub-tab in front stays while the search keeps it; otherwise the first one the search keeps shows.
  const shown = kept.includes(state.section) ? state.section : (kept[0] ?? null);
  const label = (id: SettingsSection): string => SETTINGS_SECTIONS.find((s) => s.id === id)!.label;
  return (
    <section className="tl-settings-window" aria-label="project settings">
      <div className="tl-settings-window__head">
        <span className="tl-settings-window__title">Project Settings</span>
        <button type="button" className="tl-editor-window__close" aria-label="Close project settings" title="Back to the editor (Esc)" onClick={state.close}>
          ×
        </button>
      </div>
      <div className="tl-settings-window__body">
        <nav className="tl-settings-window__nav">
          <input
            className="tl-input tl-settings-window__search"
            type="search"
            aria-label="Search project settings"
            placeholder="Search settings"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div role="tablist" aria-orientation="vertical" aria-label="project settings sections" className="tl-settings-window__tabs">
            {kept.map((id) => (
              <button key={id} role="tab" aria-selected={shown === id} className={`tl-settings-window__tab${shown === id ? ' is-active' : ''}`} onClick={() => state.setSection(id)}>
                {label(id)}
              </button>
            ))}
          </div>
          {kept.length === 0 && <p className="tl-hint">No settings match “{query.trim()}”.</p>}
        </nav>
        <div className="tl-settings-window__panel" role="tabpanel" aria-label={shown === null ? 'no matching settings' : label(shown)} data-section={shown ?? ''}>
          {shown !== null && <Section id={shown} {...props} />}
        </div>
      </div>
    </section>
  );
}

function Section(props: ProjectSettingsWindowProps & { id: SettingsSection }): JSX.Element {
  const s = props.settings;
  const { registry, environment } = props.content;
  switch (props.id) {
    case 'gameplay':
      return (
        <GameplayPanel
          entities={props.entities}
          settings={s.settings}
          onSelectEntity={(id) => {
            // The camera's sections are in the Inspector, under this window.
            props.setSelection({ ids: [id], primary: id });
            props.state.close();
          }}
          registry={registry}
          fieldContext={props.gameFieldContext}
          onSaveSettings={(next) => void s.saveSettings(next)}
          backendError={s.gameplayError}
        />
      );
    case 'input':
      return <InputPanel input={s.inputConfig} defaults={s.inputDefaults} onSave={(i) => void s.saveInput(i)} error={s.inputError} />;
    case 'tags':
      return <TagsPanel tags={s.tags} usage={props.tagUsage} error={s.tagsError} onSetTags={(next) => void s.saveTags(next)} />;
    case 'layers':
      return (
        <CollisionLayersPanel
          layers={s.collisionLayers}
          usage={props.layerUsage}
          dimension={s.settings?.['physics_dimension'] === 3 ? 3 : 2}
          error={s.layersError}
          onSetLayers={(next) => void s.saveCollisionLayers(next)}
        />
      );
    case 'quality':
      return (
        <QualityPanel
          registry={registry}
          environment={environment}
          onSaveEnvironment={(env) => void props.docCmds.saveEnvironment(env, environment)}
          environmentError={props.docCmds.materialError}
          settings={s.settings}
          onSaveSettings={(next) => void s.saveSettings(next)}
          settingsError={s.gameplayError}
          fieldContext={props.gameFieldContext}
        />
      );
    case 'audio':
      return <AudioPanel registry={registry} eventCues={s.eventCues} fieldContext={props.fieldContext} eventCuesError={s.eventCuesError} onSetEventCues={(next, base) => void s.saveEventCues(next, base)} />;
    case 'saves':
      return <SavesPanel schema={s.saveSchema} error={s.saveSchemaError} onSave={(next) => void s.saveSaveSchema(next)} note={props.play.playSaveNote} onClearPlaySave={props.play.clearPlaySave} />;
    case 'modes':
      return (
        <ModesPanel
          registry={registry}
          modes={s.modes}
          groups={s.behaviorGroups}
          groupUsage={props.groupUsage}
          fieldContext={props.fieldContext}
          error={s.modesError}
          onSetModes={(next) => void s.saveModes(next)}
          onSetGroups={(next) => void s.saveBehaviorGroups(next)}
        />
      );
    case 'shell':
      return <ShellPanel registry={registry} shell={s.shell} fieldContext={props.fieldContext} error={s.shellError} onSetShell={(next, base) => void s.saveShell(next, base)} />;
    case 'scripts':
      return <BehaviorPanel {...props.scripting.behaviorProps} />;
  }
}
