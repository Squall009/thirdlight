/**
 * The pieces every item editor is built from, so they look and behave
 * alike: a toolbar of actions (each with its picture from the icon
 * registry), and an empty state that says what the editor is for and offers
 * its first actions when the item has nothing in it yet.
 *
 * Browser-only (React).
 */
import type { JSX, ReactNode } from 'react';

import { actionIcon, kindIcon, type ToolAction } from '../../session/item-icons';

/** An editor's toolbar: its actions in one row, named for assistive technology ("material toolbar"). */
export function EditorToolbar({ label, children, className }: { label: string; children: ReactNode; className?: string }): JSX.Element {
  return (
    <div className={`tl-editor-toolbar${className !== undefined ? ` ${className}` : ''}`} role="toolbar" aria-label={label}>
      {children}
    </div>
  );
}

/** A thin divider between groups of a toolbar's actions. */
export function ToolbarSeparator(): JSX.Element {
  return <span className="tl-editor-toolbar__sep" aria-hidden="true" />;
}

/** The space that pushes the actions after it to the toolbar's right end. */
export function ToolbarSpacer(): JSX.Element {
  return <span className="tl-editor-toolbar__spacer" />;
}

export interface ToolButtonProps {
  action: ToolAction;
  /** The visible text; absent for a picture-only button (then `aria` names it). */
  label?: string;
  /** The accessible name when it is not the visible text. */
  aria?: string;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  /** The editor's main action (Publish, Save): drawn as the primary button. */
  primary?: boolean;
  /** A toggle's state (Play/Pause is two actions; Snap is one pressed or not). */
  pressed?: boolean;
}

/** One toolbar action: its picture, then its name. */
export function ToolButton(p: ToolButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={`tl-tool-button${p.primary === true ? ' is-primary' : ''}${p.label === undefined ? ' is-icon' : ''}`}
      aria-label={p.aria}
      aria-pressed={p.pressed}
      title={p.title ?? p.aria ?? p.label}
      disabled={p.disabled}
      data-action={p.action}
      onClick={p.onClick}
    >
      <img className="tl-tool-button__icon" src={actionIcon(p.action)} alt="" aria-hidden="true" />
      {p.label !== undefined && <span className="tl-tool-button__label">{p.label}</span>}
    </button>
  );
}

export interface EmptyStateProps {
  /** The item kind whose picture it shows (the registry's kind). */
  kind: string;
  /** What is missing ("No tracks yet"). */
  title: string;
  /** What the editor is for and how to begin. */
  children?: ReactNode;
  /** The first actions (ToolButtons). */
  actions?: ReactNode;
  /** Laid over a canvas (the graph): only its own controls take the pointer. */
  overlay?: boolean;
}

/** What an editor shows while its item has nothing in it: what it is for, and the first actions. */
export function EmptyState(p: EmptyStateProps): JSX.Element {
  return (
    <div className={`tl-empty-state${p.overlay === true ? ' is-overlay' : ''}`} role="region" aria-label={`empty: ${p.title}`}>
      <img className="tl-empty-state__icon" src={kindIcon(p.kind)} alt="" aria-hidden="true" />
      <div className="tl-empty-state__title">{p.title}</div>
      {p.children !== undefined && <div className="tl-empty-state__text">{p.children}</div>}
      {p.actions !== undefined && <div className="tl-empty-state__actions">{p.actions}</div>}
    </div>
  );
}
