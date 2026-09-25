/**
 * Phase 17.1: the editor's renderer backend choice (the page's `?renderer=`
 * flag, else the project's `render_backend` setting, else the default). The
 * Scene view is told directly; previews and thumbnails read it when they
 * create their renderer.
 */
import { DEFAULT_RENDERER_PREFERENCE, type RendererPreference, type RendererPreferenceSource } from '@thirdlight/three-adapter';

export interface EditorRendererChoice {
  readonly preference: RendererPreference;
  readonly source: RendererPreferenceSource;
}

let current: EditorRendererChoice = { preference: DEFAULT_RENDERER_PREFERENCE, source: 'default' };

export function editorRendererChoice(): EditorRendererChoice {
  return current;
}

export function setEditorRendererChoice(choice: EditorRendererChoice): void {
  current = choice;
}
