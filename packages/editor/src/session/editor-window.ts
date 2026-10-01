/**
 * The editor window's model and the default view's centre. An item opened
 * from the project window (a material, a graph, a script, a timeline, …)
 * shows in one full window over the editor; several open items are tabs
 * inside that window. The default view's centre shows the Scene or the Game
 * view, nothing else. Pure state + reducer, no DOM: the window renders it
 * and the layout storage remembers it per project.
 *
 * Closing the window (Esc, its ×) returns to the default view and keeps the
 * window's tabs, so the next item opened joins them (the project window, the
 * Hierarchy and the docks are under the window while it shows, so a person
 * opens a second item from there). Closing a tab closes that item; closing
 * the last one closes the window.
 *
 * A document is `{ kind, id }`: the kind names an entry of the document-kind
 * registry (`ui/workspace/kinds.tsx`), the id is the document's own id
 * (controller id, behavior id…). Layout is presentation only: it never
 * touches project data.
 */

export type CentreView = 'scene' | 'game';

export interface DocRef {
  kind: string;
  id: string;
}

export interface WorkspaceState {
  /** The editor window's tabs, in order (empty: no item is open). */
  docs: DocRef[];
  /** The tab in front of the window (a `docKey`), null when no item is open. */
  active: string | null;
  /** The window shows over the editor (only with an item open). */
  open: boolean;
  /** The default view's centre: the editor scene or the running game. */
  view: CentreView;
  /** The default view's centre fills the editor (docks hidden). */
  maximized: boolean;
}

export type WorkspaceAction =
  /** Open an item in the window (its tab comes to the front; an open item is not added twice). */
  | { type: 'open'; doc: DocRef }
  /** Bring a tab to the front (the window shows). */
  | { type: 'activate'; key: string }
  | { type: 'close'; key: string }
  /** Move tab `from` to the place of tab `to` (both document keys). */
  | { type: 'move'; from: string; to: string }
  /** Ctrl+Tab: the window's tabs while it shows, else the Scene and Game views. */
  | { type: 'cycle'; dir: 1 | -1 }
  /** Show or hide the window (default: toggle); it shows only with an item open. */
  | { type: 'show'; on?: boolean }
  /** Show the Scene or the Game view in the default view's centre (the window stays as it is). */
  | { type: 'view'; view: CentreView }
  | { type: 'maximize'; on?: boolean }
  | { type: 'load'; state: WorkspaceState };

export const INITIAL_WORKSPACE: WorkspaceState = { docs: [], active: null, open: false, view: 'scene', maximized: false };

/** Engine limit protecting the layout storage and the window's tab strip (not a design value). */
export const MAX_DOCUMENT_TABS = 64;

/** A document's tab key. Kinds are identifiers, so the first ':' separates. */
export const docKey = (d: DocRef): string => `${d.kind}:${d.id}`;

/** Every window tab key in strip order. */
export function tabKeys(s: WorkspaceState): string[] {
  return s.docs.map(docKey);
}

/** The document in front of the window, or null while the window is closed. */
export function activeDoc(s: WorkspaceState): DocRef | null {
  if (!s.open) return null;
  return s.docs.find((d) => docKey(d) === s.active) ?? null;
}

export function reduceWorkspace(s: WorkspaceState, a: WorkspaceAction): WorkspaceState {
  switch (a.type) {
    case 'open': {
      const key = docKey(a.doc);
      // Opening a document that is open brings its tab to the front.
      if (s.docs.some((d) => docKey(d) === key)) return s.active === key && s.open ? s : { ...s, active: key, open: true };
      if (s.docs.length >= MAX_DOCUMENT_TABS) return s;
      return { ...s, docs: [...s.docs, { kind: a.doc.kind, id: a.doc.id }], active: key, open: true };
    }
    case 'activate':
      if (!s.docs.some((d) => docKey(d) === a.key)) return s;
      return s.active === a.key && s.open ? s : { ...s, active: a.key, open: true };
    case 'close': {
      const keys = tabKeys(s);
      const at = keys.indexOf(a.key);
      if (at < 0) return s;
      const docs = s.docs.filter((d) => docKey(d) !== a.key);
      if (docs.length === 0) return { ...s, docs, active: null, open: false };
      if (s.active !== a.key) return { ...s, docs };
      // The closed tab was in front: its right neighbour takes over, else its left one.
      const rest = keys.filter((k) => k !== a.key);
      return { ...s, docs, active: rest[Math.min(at, rest.length - 1)]! };
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
      if (!s.open || s.docs.length === 0) return { ...s, view: s.view === 'scene' ? 'game' : 'scene' };
      const keys = tabKeys(s);
      const at = Math.max(0, keys.indexOf(s.active ?? ''));
      const next = keys[(at + a.dir + keys.length) % keys.length]!;
      return next === s.active ? s : { ...s, active: next };
    }
    case 'show': {
      const on = (a.on ?? !s.open) && s.docs.length > 0;
      return on === s.open ? s : { ...s, open: on };
    }
    case 'view':
      return s.view === a.view ? s : { ...s, view: a.view };
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
 * dropped, and so are duplicates. An entry stored before the window existed
 * (no `open`) had its front document as a centre tab: the window opens on it.
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
  const maximized = o['maximized'] === true;
  if (docs.length === 0) return { ...INITIAL_WORKSPACE, maximized };
  const keys = docs.map(docKey);
  const stored = typeof o['active'] === 'string' ? o['active'] : null;
  const front = stored !== null && keys.includes(stored);
  const open = typeof o['open'] === 'boolean' ? o['open'] && front : front;
  return { docs, active: front ? stored : keys[0]!, open, view: 'scene', maximized };
}

/** The stored form. The Game view is not restored: it is empty until Play runs. */
export function serializeWorkspace(s: WorkspaceState): string {
  return JSON.stringify({ docs: s.docs, active: s.active, open: s.open, maximized: s.maximized });
}
