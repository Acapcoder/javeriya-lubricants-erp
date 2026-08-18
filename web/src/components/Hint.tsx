import { useEffect, useId, useRef, useState } from 'react';

/**
 * A small ⓘ that explains one field or one panel.
 *
 * Opens on hover where there is a pointer, and on tap where there is not, so
 * the same component works at a desk and on a tablet in the yard. It is a
 * button rather than a title attribute because a native tooltip never appears
 * on touch, and this content is the difference between entering a figure
 * correctly and entering it wrongly.
 */
export function Hint({ text, below = false, label }: { text: string; below?: boolean; label?: string }) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);

  // A tap elsewhere, or Escape, closes it.
  useEffect(() => {
    if (!open) return;

    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const visible = open || hovered;

  return (
    <span className="hint" ref={ref}>
      <button
        type="button"
        className="hint-icon"
        aria-expanded={open}
        aria-describedby={visible ? id : undefined}
        aria-label={label ?? 'What is this?'}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
      >
        i
      </button>

      {visible && (
        <span className={below ? 'hint-bubble below' : 'hint-bubble'} role="tooltip" id={id}>
          {text}
        </span>
      )}
    </span>
  );
}

/** A label with its hint on the same line. */
export function LabelWithHint({
  htmlFor,
  children,
  hint,
  below,
}: {
  htmlFor?: string;
  children: React.ReactNode;
  hint: string;
  below?: boolean;
}) {
  return (
    <div className="label-row">
      {htmlFor ? <label htmlFor={htmlFor}>{children}</label> : <span className="field-label">{children}</span>}
      <Hint text={hint} below={below} />
    </div>
  );
}
