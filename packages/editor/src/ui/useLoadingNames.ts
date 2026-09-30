/**
 * Addresses and labels (the names scripts load assets and resources by):
 * `setLabels` on any number of items and `setAddress` on one, each one
 * command and one undo. Resolves to the failure message, or null.
 */
import { useCallback, useMemo, type MutableRefObject } from 'react';

import type { SessionClient } from '../session/client';

/** An asset (`kind: 'asset'`) or a resource (its kind), by id. */
export interface LoadableItem {
  kind: string;
  id: string;
}

export interface LoadingNameActions {
  setLabels(items: readonly LoadableItem[], add: readonly string[], remove: readonly string[]): Promise<string | null>;
  setAddress(item: LoadableItem, address: string | null): Promise<string | null>;
}

export function useLoadingNames(clientRef: MutableRefObject<SessionClient | null>): LoadingNameActions {
  const run = useCallback(
    async (op: 'setLabels' | 'setAddress', args: Record<string, unknown>): Promise<string | null> => {
      const c = clientRef.current;
      if (c === null) return 'not connected';
      const res = await c.command(op, args, c.projection.revision);
      if (res.ok) return null;
      const r = res.response as { code?: string; message?: string };
      return r.message ?? r.code ?? 'unknown error';
    },
    [clientRef],
  );
  const setLabels = useCallback((items: readonly LoadableItem[], add: readonly string[], remove: readonly string[]) => run('setLabels', { items, ...(add.length > 0 ? { add } : {}), ...(remove.length > 0 ? { remove } : {}) }), [run]);
  const setAddress = useCallback((item: LoadableItem, address: string | null) => run('setAddress', { kind: item.kind, id: item.id, address }), [run]);
  return useMemo(() => ({ setLabels, setAddress }), [setLabels, setAddress]);
}

/** Labels typed as text: separated by commas or spaces. */
export function labelsOf(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).filter((l) => l.length > 0))];
}
