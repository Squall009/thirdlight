/**
 * The bottom dock's tabs, in the order the dock and the Window menu list them.
 */
export type BottomTab = 'blocks' | 'assets' | 'materials' | 'environment' | 'lighting' | 'animator' | 'input' | 'prefabs' | 'behaviors' | 'gameplay' | 'tags' | 'saves' | 'media' | 'graphs' | 'effects' | 'timelines' | 'dialogue' | 'libraries' | 'modes' | 'shell' | 'ui' | 'problems' | 'console';

export const BOTTOM_TABS: ReadonlyArray<{ id: BottomTab; label: string }> = [
  { id: 'assets', label: 'Assets' },
  { id: 'materials', label: 'Materials' },
  { id: 'environment', label: 'Environment' },
  { id: 'lighting', label: 'Lighting' },
  { id: 'animator', label: 'Animator' },
  { id: 'input', label: 'Input' },
  { id: 'prefabs', label: 'Prefabs' },
  { id: 'behaviors', label: 'Behaviors' },
  { id: 'gameplay', label: 'Gameplay' },
  { id: 'tags', label: 'Tags' },
  // The project save schema.
  { id: 'saves', label: 'Saves' },
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
  // Game modes and behavior groups.
  { id: 'modes', label: 'Game modes' },
  // The game shell (menus and HUD as UI documents, the scene list).
  { id: 'shell', label: 'Game shell' },
  // Block-layer editing.
  { id: 'blocks', label: 'Blocks' },
  { id: 'problems', label: 'Problems' },
];

