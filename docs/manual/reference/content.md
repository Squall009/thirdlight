# Content documents

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The project's content: one block per kind of document. Each block lists the ops that write it (the one mutation path).

<a id="content-index"></a>
## Content blocks

| Block | Name | Written by |
|---|---|---|
| [`environment`](content-blocks-environment.md#content-environment) | Environment | `setEnvironment` |
| [`input`](content-blocks-environment.md#content-input) | Input | `setInput` |
| [`materials`](content-blocks-materials.md#content-materials) | Materials | `setMaterial`, `deleteMaterial` |
| [`animators`](content-blocks-materials.md#content-animators) | Animator controllers | `setAnimator`, `deleteAnimator` |
| [`effects`](content-blocks-effects.md#content-effects) | Effects | `setEffect`, `deleteEffect`, `renameEffect`, `graphEdit` |
| [`scriptLibraries`](content-blocks-effects.md#content-scriptLibraries) | Script libraries | `setScriptLibrary`, `deleteScriptLibrary` |
| [`blockTypes`](content-blocks-effects.md#content-blockTypes) | Block types | `setBlockType`, `deleteBlockType` |
| [`cellFields`](content-blocks-effects.md#content-cellFields) | Cell fields | `setCellFields` |
| [`blockStamps`](content-blocks-effects.md#content-blockStamps) | Block stamps | `setBlockStamp`, `deleteBlockStamp` |
| [`kits`](content-blocks-effects.md#content-kits) | Kits | `setKit`, `deleteKit` |
| [`uiDocuments`](content-blocks-effects.md#content-uiDocuments) | UI documents | `setUiDocument`, `deleteUiDocument` |
| [`modes`](content-blocks-effects.md#content-modes) | Game modes | `setModes` |
| [`behaviorGroups`](content-blocks-effects.md#content-behaviorGroups) | Behavior groups | `setBehaviorGroups` |
| [`shell`](content-blocks-effects.md#content-shell) | Game shell | `setShell` |
| [`eventCues`](content-blocks-effects.md#content-eventCues) | Event sounds | `setEventCues` |
| [`uiThemes`](content-blocks-effects.md#content-uiThemes) | UI themes | `setUiTheme`, `deleteUiTheme` |
| [`dialogues`](content-blocks-effects.md#content-dialogues) | Dialogues | `setDialogue`, `deleteDialogue`, `graphEdit` |
| [`speakers`](content-blocks-effects.md#content-speakers) | Speakers | `setSpeaker`, `deleteSpeaker` |
| [`dialogueSettings`](content-blocks-effects.md#content-dialogueSettings) | Dialogue settings | `setDialogueSettings` |
| [`timelines`](content-blocks-effects.md#content-timelines) | Timelines | `setTimeline`, `deleteTimeline` |
| [`graphs`](content-blocks-effects.md#content-graphs) | Graphs | `setGraph`, `deleteGraph`, `graphEdit` |
| [`tags`](content-blocks-effects.md#content-tags) | Tags | `setTags` |
| [`loadable`](content-blocks-effects.md#content-loadable) | Loadable resources | `setLabels`, `setAddress` |
| [`collisionLayers`](content-blocks-effects.md#content-collisionLayers) | Collision layers | `setCollisionLayers` |
| [`lightLayers`](content-blocks-effects.md#content-lightLayers) | Light layers | `setLightLayers` |
| [`saveSchema`](content-blocks-effects.md#content-saveSchema) | Project saves | `setSaveSchema` |
| [`settings`](content-blocks-settings.md#content-settings) | Gameplay settings | `setSettings` |
| [`scenes`](content-blocks-settings.md#content-scenes) | Scenes | `createScene`, `renameScene`, `deleteScene` |
| [`startScenes`](content-blocks-settings.md#content-startScenes) | Start scenes | `setStartScenes` |
| [`assets`](content-blocks-settings.md#content-assets) | Assets | `publishAsset`, `setAssetOptions`, `deleteAsset`, `importAssets`, `setLabels`, `setAddress` |
| [`prefabs`](content-blocks-settings.md#content-prefabs) | Prefabs | `createPrefab`, `updatePrefab`, `instantiatePrefab`, `deletePrefab`, `createPrefabVariant`, `applyPrefabOverrides` |
| [`behaviors`](content-blocks-settings.md#content-behaviors) | Behaviors | `publishBehavior`, `deleteBehavior` |
| [`behaviorTrust`](content-blocks-settings.md#content-behaviorTrust) | Script trust | `acknowledgeBehaviorTrust`, `revokeBehaviorTrust` |
| [`lighting`](content-blocks-settings.md#content-lighting) | Baked lighting | `setLighting` |
