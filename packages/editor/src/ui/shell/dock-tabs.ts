/**
 * The bottom dock's tabs, in the order the dock and the Window menu list them:
 * the project window (every asset, resource and scene: each kind is found,
 * made and opened there), the Console and Problems. Items open in the editor
 * window, project settings in the Project Settings window, scene tools float
 * over the Scene view, and what is chosen shows in the Inspector.
 */
export type BottomTab = 'assets' | 'console' | 'problems';

export const BOTTOM_TABS: ReadonlyArray<{ id: BottomTab; label: string }> = [
  { id: 'assets', label: 'Project' },
  // Play script logs and errors at their source locations.
  { id: 'console', label: 'Console' },
  { id: 'problems', label: 'Problems' },
];
