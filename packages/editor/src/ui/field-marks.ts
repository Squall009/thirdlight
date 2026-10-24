/**
 * Marks on the Inspector's fields that a linked prefab copy overrides: the
 * descriptor fields read this context (null: nothing is marked), so the
 * marks reach every component without each widget knowing about prefabs.
 *
 * Browser-only (React).
 */
import { createContext } from 'react';

export interface FieldMarks {
  /** Whether the copy overrides this field of the component (or something inside it). */
  overridden(component: string, path: readonly (string | number)[]): boolean;
  /** A right-click on a marked field (its Revert / Apply to prefab menu). */
  menu(component: string, path: readonly (string | number)[], at: { x: number; y: number }): void;
}

export const FieldMarksContext = createContext<FieldMarks | null>(null);
