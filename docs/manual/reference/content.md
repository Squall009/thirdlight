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
| [`effects`](content-blocks-materials.md#content-effects) | Effects | `setEffect`, `deleteEffect`, `renameEffect`, `graphEdit` |
| [`scriptLibraries`](content-blocks-script-libraries.md#content-scriptLibraries) | Script libraries | `setScriptLibrary`, `deleteScriptLibrary` |
| [`blockTypes`](content-blocks-script-libraries.md#content-blockTypes) | Block types | `setBlockType`, `deleteBlockType` |
| [`cellFields`](content-blocks-script-libraries.md#content-cellFields) | Cell fields | `setCellFields` |
| [`blockStamps`](content-blocks-script-libraries.md#content-blockStamps) | Block stamps | `setBlockStamp`, `deleteBlockStamp` |
| [`uiDocuments`](content-blocks-script-libraries.md#content-uiDocuments) | UI documents | `setUiDocument`, `deleteUiDocument` |
| [`modes`](content-blocks-script-libraries.md#content-modes) | Game modes | `setModes` |
| [`behaviorGroups`](content-blocks-script-libraries.md#content-behaviorGroups) | Behavior groups | `setBehaviorGroups` |
| [`shell`](content-blocks-script-libraries.md#content-shell) | Game shell | `setShell` |
| [`eventCues`](content-blocks-script-libraries.md#content-eventCues) | Event sounds | `setEventCues` |
| [`uiThemes`](content-blocks-script-libraries.md#content-uiThemes) | UI themes | `setUiTheme`, `deleteUiTheme` |
| [`dialogues`](content-blocks-script-libraries.md#content-dialogues) | Dialogues | `setDialogue`, `deleteDialogue`, `graphEdit` |
| [`speakers`](content-blocks-script-libraries.md#content-speakers) | Speakers | `setSpeaker`, `deleteSpeaker` |
| [`dialogueSettings`](content-blocks-script-libraries.md#content-dialogueSettings) | Dialogue settings | `setDialogueSettings` |
| [`timelines`](content-blocks-script-libraries.md#content-timelines) | Timelines | `setTimeline`, `deleteTimeline` |
| [`graphs`](content-blocks-script-libraries.md#content-graphs) | Graphs | `setGraph`, `deleteGraph`, `graphEdit` |
| [`tags`](content-blocks-script-libraries.md#content-tags) | Tags | `setTags` |
| [`loadable`](content-blocks-script-libraries.md#content-loadable) | Loadable resources | `setLabels`, `setAddress` |
| [`collisionLayers`](content-blocks-script-libraries.md#content-collisionLayers) | Collision layers | `setCollisionLayers` |
| [`lightLayers`](content-blocks-script-libraries.md#content-lightLayers) | Light layers | `setLightLayers` |
| [`saveSchema`](content-blocks-script-libraries.md#content-saveSchema) | Project saves | `setSaveSchema` |
| [`settings`](content-blocks-script-libraries.md#content-settings) | Gameplay settings | `setSettings` |
| [`scenes`](content-blocks-script-libraries.md#content-scenes) | Scenes | `createScene`, `renameScene`, `deleteScene` |
| [`startScenes`](content-blocks-script-libraries.md#content-startScenes) | Start scenes | `setStartScenes` |
| [`assets`](content-blocks-script-libraries.md#content-assets) | Assets | `publishAsset`, `setAssetOptions`, `deleteAsset`, `importAssets`, `setLabels`, `setAddress` |
| [`prefabs`](content-blocks-script-libraries.md#content-prefabs) | Prefabs | `createPrefab`, `instantiatePrefab`, `deletePrefab` |
| [`behaviors`](content-blocks-behaviors.md#content-behaviors) | Behaviors | `publishBehavior`, `deleteBehavior` |
| [`behaviorTrust`](content-blocks-behaviors.md#content-behaviorTrust) | Script trust | `acknowledgeBehaviorTrust`, `revokeBehaviorTrust` |
| [`lighting`](content-blocks-behaviors.md#content-lighting) | Baked lighting | `setLighting` |
