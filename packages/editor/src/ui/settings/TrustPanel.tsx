/**
 * Project Settings → Script trust: every script source the project
 * acknowledged (the exact digest of a script's source or of a script
 * library's version), what still uses each one, and a Revoke per entry.
 *
 * An acknowledgment is what lets a source be published and run; revoking it
 * means the next publication of that exact source asks again. The backend
 * refuses a revocation while a published script was built from the source
 * or against the library version (the refusal names them) — delete or
 * republish those scripts first. One undo brings a revoked entry back.
 *
 * Display + intent only: the list is the backend's (read with the scripts,
 * advanced by the change feed) and Revoke is one ordinary command.
 */
import type { JSX } from 'react';
import type { TrustEntry } from '@thirdlight/project-model';
import type { BehaviorDeclarationView } from '../../session/prefab-projection';

/** How many hex characters of a digest the list shows (the full digest is the row's tooltip). */
const DIGEST_SHOWN = 12;

export interface TrustPanelProps {
  entries: readonly TrustEntry[];
  behaviors: readonly BehaviorDeclarationView[];
  error: { sourceDigest: string; message: string } | null;
  onRevoke: (sourceDigest: string) => void;
}

/** The published scripts built from a digest or against it (a library version): what keeps it from being revoked. */
export function trustUses(digest: string, behaviors: readonly BehaviorDeclarationView[]): string[] {
  const uses: string[] = [];
  for (const b of behaviors) {
    if (b.source === null) continue;
    if (b.source.sourceDigest === digest) uses.push(`script ${b.displayName}`);
    for (const pin of b.source.libraries ?? []) if (pin.sourceDigest === digest) uses.push(`script ${b.displayName} (library ${pin.libraryId})`);
  }
  return uses;
}

export function TrustPanel(p: TrustPanelProps): JSX.Element {
  return (
    <div className="tl-panel tl-trust" aria-label="script trust">
      <div className="tl-panel__title">Script trust — acknowledged sources</div>
      <p className="tl-hint">
        A script runs only from a source someone acknowledged. Revoke an entry to be asked again the next time that exact source is published; a source a
        published script still uses cannot be revoked until that script is deleted or published from another version.
      </p>
      {p.entries.length === 0 ? (
        <p className="tl-hint" data-testid="trust-empty">
          No script source has been acknowledged in this project.
        </p>
      ) : (
        <ul className="tl-trust__list">
          {p.entries.map((e) => {
            const uses = trustUses(e.sourceDigest, p.behaviors);
            const short = e.sourceDigest.slice(0, DIGEST_SHOWN);
            return (
              <li key={e.sourceDigest} className="tl-trust__row" data-digest={e.sourceDigest} title={e.sourceDigest}>
                <code className="tl-trust__digest">{short}…</code>
                <span className="tl-prop__caption">acknowledged at r{e.acknowledgedRevision}</span>
                <span className="tl-trust__uses">{uses.length > 0 ? `used by ${uses.join(', ')}` : 'not used by a published script'}</span>
                <button type="button" className="tl-btn tl-btn--small" aria-label={`revoke trust ${short}`} onClick={() => p.onRevoke(e.sourceDigest)}>
                  revoke
                </button>
                {p.error !== null && p.error.sourceDigest === e.sourceDigest && (
                  <div className="tl-assets__error" role="alert" data-testid="trust-revoke-error">
                    {p.error.message}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
