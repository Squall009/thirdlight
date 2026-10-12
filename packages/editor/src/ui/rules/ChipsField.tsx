/**
 * A list of short names as chips (block types, region names): type a name
 * and press Enter (or a comma) to add it, × or Backspace in the empty box to
 * take one off. No list syntax to get right.
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';

export function ChipsField(p: { label: string; aria: string; values: readonly string[]; onChange: (values: string[]) => void; placeholder?: string; disabled?: boolean; maxLength?: number }): JSX.Element {
  const [text, setText] = useState('');
  const add = (raw: string): void => {
    const names = raw.split(',').map((t) => t.trim()).filter((t) => t !== '' && !p.values.includes(t));
    if (names.length > 0) p.onChange([...p.values, ...names]);
    setText('');
  };
  return (
    <div className="tl-frow tl-frow--stack">
      <span className="tl-frow__label">{p.label}</span>
      <div className="tl-chips" role="group" aria-label={p.aria}>
        {p.values.map((v) => (
          <span key={v} className="tl-chip">
            {v}
            <button type="button" aria-label={`remove ${v}`} disabled={p.disabled} onClick={() => p.onChange(p.values.filter((x) => x !== v))}>
              ×
            </button>
          </span>
        ))}
        <input
          className="tl-chips__input"
          aria-label={`${p.aria} add`}
          value={text}
          maxLength={p.maxLength ?? 64}
          placeholder={p.values.length === 0 ? (p.placeholder ?? 'type a name, Enter') : ''}
          disabled={p.disabled}
          onChange={(e) => (e.target.value.includes(',') ? add(e.target.value) : setText(e.target.value))}
          onBlur={() => text.trim() !== '' && add(text)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(text);
            } else if (e.key === 'Backspace' && text === '' && p.values.length > 0) p.onChange(p.values.slice(0, -1));
          }}
        />
      </div>
    </div>
  );
}
