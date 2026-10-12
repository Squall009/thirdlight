/**
 * A tool's brush settings in React: the store's current settings, redrawn
 * whenever they change (the panel, a key or a drag in the Scene view).
 *
 * Browser-only (React).
 */
import { useSyncExternalStore } from 'react';

import type { BrushSettings, BrushStore } from '../../session/brush';

export function useBrush(store: BrushStore): BrushSettings {
  return useSyncExternalStore(store.subscribe, store.get);
}
