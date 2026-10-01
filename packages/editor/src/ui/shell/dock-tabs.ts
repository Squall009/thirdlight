/**
 * The bottom dock's tabs, in the order the dock and the Window menu list them
 * (the project's settings are in the Project Settings window).
 */
export type BottomTab = 'blocks' | 'assets' | 'materials' | 'environment' | 'lighting' | 'animator' | 'prefabs' | 'media' | 'graphs' | 'effects' | 'timelines' | 'dialogue' | 'libraries' | 'ui' | 'problems' | 'console';

export const BOTTOM_TABS: ReadonlyArray<{ id: BottomTab; label: string }> = [
  { id: 'assets', label: 'Assets' },
  { id: 'materials', label: 'Materials' },
  { id: 'environment', label: 'Environment' },
  { id: 'lighting', label: 'Lighting' },
  { id: 'animator', label: 'Animator' },
  { id: 'prefabs', label: 'Prefabs' },
  { id: 'media', label: 'Media' },
  { id: 'graphs', label: 'Graphs' },
  // Visual effects.
  { id: 'effects', label: 'Effects' },
  // Conversations, speakers, dialogue settings.
  { id: 'dialogue', label: 'Dialogue' },
  // Timelines (sequencer).
  { id: 'timelines', label: 'Timelines' },
  // Shared script libraries.
  { id: 'libraries', label: 'Libraries' },
  // Play script logs and errors at their source locations.
  { id: 'console', label: 'Console' },
  // Project UI documents and themes.
  { id: 'ui', label: 'UI' },
  // Block-layer editing.
  { id: 'blocks', label: 'Blocks' },
  { id: 'problems', label: 'Problems' },
];

