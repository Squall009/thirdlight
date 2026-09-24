/**
 * Phase 16.0: the centre workspace's tab model — Scene and Game (always
 * there, never closable) followed by any number of document tabs (an
 * animator controller, a behavior's script, later materials, effects,
 * graphs). Pure state + reducer, no DOM: the tab strip renders it and the
 * layout storage remembers it per project.
 *
 * A document is `{ kind, id }`: the kind names an entry of the document-kind
 * registry (`ui/workspace/kinds.tsx`), the id is the document's own id
 * (controller id, behavior id…). Layout is presentation only: it never
 * touches project data.
 */

export type FixedTab = 'scene' | 'game';
export const FIXED_TABS: readonly FixedTab[] = ['scene', 'game'];

export interface DocRef {
  kind: string;
  id: string;
}

export interface WorkspaceState {
  /** Open documents in tab order (after Scene and Game). */
  docs: DocRef[];
  /** The active tab: 'scene', 'game' or a document key (`docKey`). */
  active: string;
  /** The centre area fills the window (docks hidden). */
  maximized: boolean;
}

export type WorkspaceAction =
  | { type: 'open'; doc: DocRef }
  | { type: 'activate'; key: string }
  | { type: 'close'; key: string }
  /** Move tab `from` to the place of tab `to` (both document keys). */
  | { type: 'move'; from: string; to: string }
  | { type: 'cycle'; dir: 1 | -1 }
  | { type: 'maximize'; on?: boolean }
  | { type: 'load'; state: WorkspaceState };

export const INITIAL_WORKSPACE: WorkspaceState = { docs: [], active: 'scene', maximized: false };

/** Engine limit protecting the layout storage and the tab strip (not a design value). */
export const MAX_DOCUMENT_TABS = 64;

/** A document's tab key. Kinds are identifiers, so the first ':' separates. */
export const docKey = (d: DocRef): string => `${d.kind}:${d.id}`;

export const isFixedTab = (key: string): key is FixedTab => key === 'scene' || key === 'game';

/** Every tab key in strip order. */
export function tabKeys(s: WorkspaceState): string[] {
  return [...FIXED_TABS, ...s.docs.map(docKey)];
}

/** The active document, or null while Scene or Game is active. */
export function activeDoc(s: WorkspaceState): DocRef | null {
  return s.docs.find((d) => docKey(d) === s.active) ?? null;
}

export function reduceWorkspace(s: WorkspaceState, a: WorkspaceAction): WorkspaceState {
  switch (a.type) {
    case 'open': {
      const key = docKey(a.doc);
      // Opening a document that is open focuses its tab.
      if (s.docs.some((d) => docKey(d) === key)) return s.active === key ? s : { ...s, active: key };
      if (s.docs.length >= MAX_DOCUMENT_TABS) return s;
      return { ...s, docs: [...s.docs, { kind: a.doc.kind, id: a.doc.id }], active: key };
    }
    case 'activate':
      return tabKeys(s).includes(a.key) && s.active !== a.key ? { ...s, active: a.key } : s;
    case 'close': {
      if (isFixedTab(a.key)) return s; // Scene and Game cannot be closed.
      const keys = tabKeys(s);
      const at = keys.indexOf(a.key);
      if (at < 0) return s;
      const docs = s.docs.filter((d) => docKey(d) !== a.key);
      if (s.active !== a.key) return { ...s, docs };
      // The closed tab was active: its right neighbour takes over, else its left one.
      const rest = keys.filter((k) => k !== a.key);
      return { ...s, docs, active: rest[Math.min(at, rest.length - 1)] ?? 'scene' };
    }
    case 'move': {
      if (a.from === a.to) return s;
      const from = s.docs.findIndex((d) => docKey(d) === a.from);
      const to = s.docs.findIndex((d) => docKey(d) === a.to);
      if (from < 0 || to < 0) return s;
      const docs = [...s.docs];
      const [moved] = docs.splice(from, 1);
      docs.splice(to, 0, moved!);
      return { ...s, docs };
    }
    case 'cycle': {
      const keys = tabKeys(s);
      const at = Math.max(0, keys.indexOf(s.active));
      return { ...s, active: keys[(at + a.dir + keys.length) % keys.length]! };
    }
    case 'maximize': {
      const on = a.on ?? !s.maximized;
      return on === s.maximized ? s : { ...s, maximized: on };
    }
    case 'load':
      return a.state;
  }
}

/** Where the layout storage keeps a project's workspace. */
export const workspaceStorageKey = (projectId: string): string => `thirdlight.workspace.v1.${projectId}`;
export const WORKSPACE_STORAGE_PREFIX = 'thirdlight.workspace.v1.';

const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Read a stored workspace. Anything malformed falls back to the initial
 * state; documents of kinds this editor does not know (`knownKinds`) are
 * dropped, and so are duplicates.
 */
export function parseWorkspace(raw: string | null, knownKinds: ReadonlySet<string>): WorkspaceState {
  if (raw === null) return INITIAL_WORKSPACE;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return INITIAL_WORKSPACE;
  }
  if (typeof v !== 'object' || v === null) return INITIAL_WORKSPACE;
  const o = v as Record<string, unknown>;
  const docs: DocRef[] = [];
  const seen = new Set<string>();
  for (const d of Array.isArray(o['docs']) ? o['docs'] : []) {
    if (typeof d !== 'object' || d === null) continue;
    const { kind, id } = d as Record<string, unknown>;
    if (typeof kind !== 'string' || !KIND_RE.test(kind) || !knownKinds.has(kind)) continue;
    if (typeof id !== 'string' || id.length === 0 || id.length > 256) continue;
    const key = docKey({ kind, id });
    if (seen.has(key) || docs.length >= MAX_DOCUMENT_TABS) continue;
    seen.add(key);
    docs.push({ kind, id });
  }
  const state: WorkspaceState = { docs, active: 'scene', maximized: o['maximized'] === true };
  const active = typeof o['active'] === 'string' ? o['active'] : 'scene';
  return tabKeys(state).includes(active) ? { ...state, active } : state;
}

/** The stored form. The Game tab is not restored as active: it is empty until Play runs. */
export function serializeWorkspace(s: WorkspaceState): string {
  return JSON.stringify({ docs: s.docs, active: s.active === 'game' ? 'scene' : s.active, maximized: s.maximized });
}
