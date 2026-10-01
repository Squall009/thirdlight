/**
 * The project's content as the editor's panels and document tabs read it:
 * graphs, materials, the environment, bakes, controllers, effects,
 * conversations, timelines, script libraries, UI documents, the descriptors,
 * prefabs and behaviors. `receive` copies it from the session client after
 * every applied change; the backend stays the sole authority.
 */
import { useCallback, useState } from 'react';
import type { AnimatorController, DescriptorRegistry, DialogueDocument as DialogueDoc, DialogueSettings, DialogueSpeaker, EffectDef, EnvironmentConfig, GraphDocument, SceneEnvironment, LightingBake, MaterialDef, PropertyDeclaration, ScriptLibrary, TimelineAsset, UiDocument, UiTheme, UiDocument as ProjectUiDocument, UiTheme as ProjectUiTheme } from '@thirdlight/project-model';
import type { SessionClient } from '../../session/client';
import type { BehaviorDeclarationView, PrefabSummaryView } from '../../session/prefab-projection';
import type { GraphKindDef } from '../../graph/model';

/**
 * Keeps a slice's previous object while its content is the same, so a refresh
 * after every applied change does not hand React new objects for what did not change.
 */
export type Stable = <T>(slot: string, value: T, key?: string) => T;

export function useProjectContent() {
  // Standalone graphs; each opens as a `graph` document tab.
  const [graphs, setGraphs] = useState<readonly GraphDocument[]>([]);
  const [graphKinds, setGraphKinds] = useState<Readonly<Record<string, GraphKindDef>>>({});
  /** False until the first projection is applied (remembered graph tabs must not close before). */
  const [graphsLoaded, setGraphsLoaded] = useState(false);
  /** The project materials and the environment, for the panels. */
  const [materials, setMaterials] = useState<MaterialDef[]>([]);
  const [environment, setEnvironment] = useState<EnvironmentConfig | null>(null);
  /** The active scene's look, and what the Scene view and the previews show (that look with the project's quality and presets). */
  const [sceneLook, setSceneLook] = useState<SceneEnvironment | null>(null);
  const [shownEnvironment, setShownEnvironment] = useState<(EnvironmentConfig & SceneEnvironment) | null>(null);
  const [lighting, setLighting] = useState<Record<string, LightingBake>>({});
  // The animator controllers.
  const [animators, setAnimators] = useState<AnimatorController[]>([]);
  // The visual effects.
  const [effects, setEffects] = useState<readonly EffectDef[]>([]);
  // Conversations, speakers, the dialogue settings and the project UI (the previewer draws with it).
  const [dialogues, setDialogues] = useState<readonly DialogueDoc[]>([]);
  const [speakers, setSpeakers] = useState<readonly DialogueSpeaker[]>([]);
  const [dialogueSettings, setDialogueSettings] = useState<DialogueSettings | null>(null);
  const [projectUiDocs, setProjectUiDocs] = useState<readonly ProjectUiDocument[]>([]);
  const [projectUiThemes, setProjectUiThemes] = useState<readonly ProjectUiTheme[]>([]);
  // The timelines.
  const [timelines, setTimelines] = useState<readonly TimelineAsset[]>([]);
  // The shared script libraries.
  const [scriptLibraries, setScriptLibraries] = useState<readonly ScriptLibrary[]>([]);
  // The project UI documents and themes (the UI list and their tabs).
  const [uiDocuments, setUiDocuments] = useState<readonly UiDocument[]>([]);
  const [uiThemes, setUiThemes] = useState<readonly UiTheme[]>([]);
  // The component and content descriptors the Inspector is built from.
  const [registry, setRegistry] = useState<DescriptorRegistry | null>(null);
  // Prefab definitions and the declared properties of behaviors.
  const [prefabSummaries, setPrefabSummaries] = useState<PrefabSummaryView[]>([]);
  const [declarations, setDeclarations] = useState<Map<string, PropertyDeclaration>>(() => new Map());
  // The published behaviors (scripts and visual scripts).
  const [behaviorViews, setBehaviorViews] = useState<BehaviorDeclarationView[]>([]);

  /** Copies the content from the client; returns what the Scene view also draws with. */
  const receive = useCallback((c: SessionClient, stable: Stable) => {
    setPrefabSummaries(stable('prefabSummaries', c.prefabs.listSummaries()));
    setDeclarations(stable('declarations', c.prefabs.declarationMap()));
    setBehaviorViews(stable('behaviorViews', [...c.prefabs.listDeclarations()]));
    setRegistry(c.getDescriptors());
    const mats = stable('materials', c.getMaterials());
    const env = stable('environment', c.getEnvironment());
    setMaterials(mats);
    setEnvironment(env);
    const active = c.getSceneView().active;
    setSceneLook(stable('sceneLook', active === null ? null : c.getSceneEnvironment(active)));
    setShownEnvironment(stable('shownEnvironment', c.getShownEnvironment()));
    setAnimators(stable('animators', c.getAnimators()));
    setEffects(c.getEffects());
    setDialogues(c.getDialogues());
    setSpeakers(c.getSpeakers());
    setDialogueSettings(c.getDialogueSettings());
    setProjectUiDocs(c.getUiDocuments());
    setProjectUiThemes(c.getUiThemes());
    setTimelines(c.getTimelines());
    setScriptLibraries(c.getScriptLibraries());
    setUiDocuments(c.getUiDocuments());
    setUiThemes(c.getUiThemes());
    setGraphs(c.getGraphs());
    setGraphKinds(c.getGraphKinds());
    // The graphs arrive with the content (the same full-state query).
    setGraphsLoaded(c.getContentLoaded());
    // The scenes' bakes (lightmaps in the Scene view with game lighting).
    const lit = c.getLighting();
    const lightingKey = JSON.stringify(lit);
    const lighting = stable('lighting', lit, lightingKey);
    setLighting(lighting);
    return { materials: mats, lighting, lightingKey };
  }, []);

  return {
    graphs, graphKinds, graphsLoaded, materials, environment, sceneLook, shownEnvironment, lighting, animators, effects, dialogues, setDialogues, speakers, dialogueSettings, projectUiDocs, projectUiThemes,
    timelines, scriptLibraries, uiDocuments, uiThemes, registry, prefabSummaries, declarations, behaviorViews, receive,
  };
}

export type ProjectContent = ReturnType<typeof useProjectContent>;
