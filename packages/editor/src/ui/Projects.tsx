/**
 * The screens before a project is open: the owner-token form and the
 * project picker (open an existing project or create one from a template).
 * Both talk to the same-origin backend with the bearer token; the token is
 * kept in this browser only.
 */
import { useCallback, useEffect, useState, type FormEvent, type JSX } from 'react';

import { forgetToken, rememberToken } from '../config';
import { Logo } from './Logo';

export interface ProjectRow {
  projectId: string;
  name: string;
  createdAt: string | null;
  loadable: boolean;
  code?: string;
  connected: boolean;
  /** Folder projects: the server folder holding thirdlight.json. */
  folder?: string;
  /** Why an unloadable project cannot be opened. */
  note?: string;
  /** Set when the project's pinned engine differs from this one. */
  enginePin?: { matches: boolean; differences: string[] };
}

interface TemplateRow {
  id: string;
  name: string;
  description: string;
}

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

async function api<T>(path: string, token: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: T }> {
  const res = await fetch(`/api/v1${path}`, {
    method: init?.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as T };
}

/** Asks for the owner token (kept in this browser only). */
export function TokenForm(props: { message?: string }): JSX.Element {
  const [token, setToken] = useState('');
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (token.trim() === '') return;
    rememberToken(token.trim());
    window.location.reload();
  };
  return (
    <form className="tl-connect" onSubmit={submit}>
      <h1><Logo size={26} /></h1>
      {props.message ? <p className="tl-connect__message">{props.message}</p> : null}
      <label>
        Access token
        <input name="token" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoFocus />
      </label>
      <button className="tl-btn" type="submit">
        Open
      </button>
    </form>
  );
}

function openProject(projectId: string): void {
  window.location.search = `?project=${encodeURIComponent(projectId)}`;
}

/** Lists the backend's projects and creates new ones from a template. */
export function ProjectsScreen(props: { token: string; message?: string }): JSX.Element {
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [template, setTemplate] = useState('');
  const [creating, setCreating] = useState(false);
  const [newFolder, setNewFolder] = useState('');
  const [openFolder, setOpenFolder] = useState('');
  const [openError, setOpenError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api<{ ok: boolean; projects?: ProjectRow[]; error?: { code: string; message?: string } }>('/projects', props.token);
      if (list.status === 401) {
        forgetToken();
        setRejected(true);
        return;
      }
      if (!list.body.ok || !list.body.projects) {
        setError(list.body.error?.message ?? `listing projects failed (${list.status})`);
        return;
      }
      setProjects(list.body.projects);
      const t = await api<{ ok: boolean; templates?: TemplateRow[] }>('/templates', props.token);
      setTemplates(t.body.ok && t.body.templates ? t.body.templates : []);
    } catch (e) {
      setError(`the backend is not reachable: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [props.token]);
  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const projectId = newId.trim();
    const name = newName.trim() || projectId;
    if (!PROJECT_ID_RE.test(projectId)) {
      setError('the project id must be 1–64 lowercase letters, digits, "-" or "_", starting with a letter or digit');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const res = await api<{ ok: boolean; created?: boolean; error?: { code: string; message?: string } }>('/admin/projects', props.token, {
        method: 'POST',
        body: { projectId, name, ...(template !== '' ? { template } : {}), ...(newFolder.trim() !== '' ? { folder: newFolder.trim() } : {}) },
      });
      if (!res.body.ok) {
        setError(res.body.error?.message ?? `creating the project failed (${res.status})`);
        return;
      }
      if (res.body.created === false) {
        setError(`project "${projectId}" already exists`);
        await load();
        return;
      }
      openProject(projectId);
    } finally {
      setCreating(false);
    }
  };

  /** Open project folder…: register an existing folder holding thirdlight.json. */
  const register = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const folder = openFolder.trim();
    if (!folder.startsWith('/')) {
      setOpenError('type the absolute path of the folder on the server, e.g. /home/you/projects/my-game');
      return;
    }
    setOpenError(null);
    const res = await api<{ ok: boolean; projectId?: string; error?: { message?: string } }>('/admin/projects/register', props.token, { method: 'POST', body: { folder } });
    if (!res.body.ok || res.body.projectId === undefined) {
      setOpenError(res.body.error?.message ?? `opening the folder failed (${res.status})`);
      return;
    }
    openProject(res.body.projectId);
  };

  /** Forget a folder project (its files stay where they are). */
  const unregister = async (p: ProjectRow): Promise<void> => {
    if (!window.confirm(`Remove "${p.name}" from this list? Its files in ${p.folder ?? 'its folder'} are not touched.`)) return;
    const res = await api<{ ok: boolean; error?: { message?: string } }>(`/admin/projects/${encodeURIComponent(p.projectId)}/unregister`, props.token, { method: 'POST', body: {} });
    if (!res.body.ok) setError(res.body.error?.message ?? `removing the project failed (${res.status})`);
    await load();
  };

  if (rejected) return <TokenForm message="The backend rejected the access token." />;

  return (
    <div className="tl-projects">
      <h1><Logo size={28} /></h1>
      {props.message ? <p className="tl-connect__message">{props.message}</p> : null}
      <section className="tl-projects__list">
        <h2>Projects</h2>
        {projects === null ? (
          <p className="tl-projects__muted">Loading…</p>
        ) : projects.length === 0 ? (
          <p className="tl-projects__muted">No projects yet. Create one below.</p>
        ) : (
          <ul>
            {projects.map((p) => (
              <li key={p.projectId} className="tl-projects__row">
                <button className="tl-projects__open" onClick={() => openProject(p.projectId)} disabled={!p.loadable} title={p.loadable ? `Open ${p.projectId}` : `Not loadable: ${p.code ?? 'unknown'}`}>
                  <span className="tl-projects__name">{p.name}</span>
                  <span className="tl-projects__id">{p.projectId}</span>
                </button>
                <span className="tl-projects__meta" title={p.note ?? p.enginePin?.differences.join('; ') ?? p.folder}>
                  {!p.loadable
                    ? p.code === 'folder_unavailable'
                      ? 'folder unavailable'
                      : `not loadable (${p.code ?? 'unknown'})`
                    : p.enginePin !== undefined
                      ? 'pinned to another engine'
                      : p.connected
                        ? 'open in a browser'
                        : p.createdAt
                          ? `created ${p.createdAt.slice(0, 10)}`
                          : ''}
                  {p.folder !== undefined ? <span className="tl-projects__folder">{p.folder}</span> : null}
                </span>
                {p.folder !== undefined ? (
                  <button className="tl-btn tl-btn--small" type="button" onClick={() => void unregister(p)} title="Remove from this list (files are kept)">
                    remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <form className="tl-projects__new" onSubmit={(e) => void create(e)}>
        <h2>New project</h2>
        <label>
          Project id
          <input name="projectId" value={newId} onChange={(e) => setNewId(e.target.value)} placeholder="my-game" />
        </label>
        <label>
          Name
          <input name="name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="My game" />
        </label>
        <label>
          Folder on the server (optional)
          <input name="folder" value={newFolder} onChange={(e) => setNewFolder(e.target.value)} placeholder="/home/you/projects/my-game — empty keeps it in the Thirdlight data folder" />
        </label>
        <label>
          Template
          <select name="template" value={template} onChange={(e) => setTemplate(e.target.value)}>
            <option value="">Empty scene (camera and lights)</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.description ? ` — ${t.description}` : ''}
              </option>
            ))}
          </select>
        </label>
        {error ? <p className="tl-connect__message">{error}</p> : null}
        <button className="tl-btn" type="submit" disabled={creating}>
          {creating ? 'Creating…' : 'Create and open'}
        </button>
      </form>
      <form className="tl-projects__new" onSubmit={(e) => void register(e)}>
        <h2>Open project folder</h2>
        <label>
          Folder on the server
          <input name="openFolder" value={openFolder} onChange={(e) => setOpenFolder(e.target.value)} placeholder="/home/you/projects/my-game (the folder holding thirdlight.json)" />
        </label>
        {openError ? <p className="tl-connect__message">{openError}</p> : null}
        <button className="tl-btn" type="submit">
          Open folder
        </button>
      </form>
      <p className="tl-projects__muted">
        <button className="tl-btn tl-btn--link" type="button" onClick={() => { forgetToken(); window.location.reload(); }}>
          Forget the access token in this browser
        </button>
      </p>
    </div>
  );
}
