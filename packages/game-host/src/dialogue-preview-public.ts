/**
 * Phase 23.16: the dialogue previewer as its own public subpath
 * (`@thirdlight/game-host/dialogue-preview`), so the editor's dialogue tab
 * plays a conversation with the runtime's runner, the host's UI layer and its
 * audio owner — the code Play and exports use, not a copy. The host
 * composition stays behind `.`.
 */
export { createDialoguePreview, type DialoguePreview, type DialoguePreviewDeps, type DialoguePreviewObservation } from './dialogue-preview';
export { createGameAudioOwner, type AudioContextLike, type GameAudioOwner } from './audio';
export type { FlowUiEdges, UiEdges } from './dom';
