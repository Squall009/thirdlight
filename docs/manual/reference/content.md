# Content documents

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The project's content: one block per kind of document. Each block lists the ops that write it (the one mutation path).

<a id="content-index"></a>
## Content blocks

| Block | Name | Written by |
|---|---|---|
| [`environment`](content-blocks-environment.md#content-environment) | Environment | `setEnvironment` |
| [`input`](content-blocks-environment.md#content-input) | Input | `setInput` |
| [`materials`](content-blocks-environment.md#content-materials) | Materials | `setMaterial`, `deleteMaterial` |
| [`animators`](content-blocks-animators.md#content-animators) | Animator controllers | `setAnimator`, `deleteAnimator` |
| [`effects`](content-blocks-animators.md#content-effects) | Effects | `setEffect`, `deleteEffect`, `renameEffect`, `graphEdit` |
| [`scriptLibraries`](content-blocks-animators.md#content-scriptLibraries) | Script libraries | `setScriptLibrary`, `deleteScriptLibrary` |
| [`blockTypes`](content-blocks-animators.md#content-blockTypes) | Block types | `setBlockType`, `deleteBlockType` |
| [`cellFields`](content-blocks-animators.md#content-cellFields) | Cell fields | `setCellFields` |
| [`blockStamps`](content-blocks-animators.md#content-blockStamps) | Block stamps | `setBlockStamp`, `deleteBlockStamp` |
| [`uiDocuments`](content-blocks-animators.md#content-uiDocuments) | UI documents | `setUiDocument`, `deleteUiDocument` |
| [`modes`](content-blocks-animators.md#content-modes) | Game modes | `setModes` |
| [`behaviorGroups`](content-blocks-animators.md#content-behaviorGroups) | Behavior groups | `setBehaviorGroups` |
| [`shell`](content-blocks-animators.md#content-shell) | Game shell | `setShell` |
| [`eventCues`](content-blocks-animators.md#content-eventCues) | Event sounds | `setEventCues` |
| [`uiThemes`](content-blocks-animators.md#content-uiThemes) | UI themes | `setUiTheme`, `deleteUiTheme` |
| [`dialogues`](content-blocks-animators.md#content-dialogues) | Dialogues | `setDialogue`, `deleteDialogue`, `graphEdit` |
| [`speakers`](content-blocks-animators.md#content-speakers) | Speakers | `setSpeaker`, `deleteSpeaker` |
| [`dialogueSettings`](content-blocks-animators.md#content-dialogueSettings) | Dialogue settings | `setDialogueSettings` |
| [`timelines`](content-blocks-animators.md#content-timelines) | Timelines | `setTimeline`, `deleteTimeline` |
| [`graphs`](content-blocks-animators.md#content-graphs) | Graphs | `setGraph`, `deleteGraph`, `graphEdit` |
| [`tags`](content-blocks-animators.md#content-tags) | Tags | `setTags` |
| [`loadable`](content-blocks-animators.md#content-loadable) | Loadable resources | `setLabels`, `setAddress` |
| [`collisionLayers`](content-blocks-animators.md#content-collisionLayers) | Collision layers | `setCollisionLayers` |
| [`lightLayers`](content-blocks-animators.md#content-lightLayers) | Light layers | `setLightLayers` |
| [`saveSchema`](content-blocks-save-schema.md#content-saveSchema) | Project saves | `setSaveSchema` |
| [`settings`](content-blocks-save-schema.md#content-settings) | Gameplay settings | `setSettings` |
| [`scenes`](content-blocks-save-schema.md#content-scenes) | Scenes | `createScene`, `renameScene`, `deleteScene` |
| [`startScenes`](content-blocks-save-schema.md#content-startScenes) | Start scenes | `setStartScenes` |
| [`assets`](content-blocks-save-schema.md#content-assets) | Assets | `publishAsset`, `setAssetOptions`, `deleteAsset`, `importAssets`, `setLabels`, `setAddress` |
| [`prefabs`](content-blocks-save-schema.md#content-prefabs) | Prefabs | `createPrefab`, `instantiatePrefab`, `deletePrefab` |
| [`behaviors`](content-blocks-save-schema.md#content-behaviors) | Behaviors | `publishBehavior`, `deleteBehavior` |
| [`behaviorTrust`](content-blocks-save-schema.md#content-behaviorTrust) | Script trust | `acknowledgeBehaviorTrust`, `revokeBehaviorTrust` |
| [`lighting`](content-blocks-save-schema.md#content-lighting) | Baked lighting | `setLighting` |
