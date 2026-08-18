import { useState, type ReactNode } from 'react';
import { operationInfo } from '../content/operations';

/**
 * The heading every operation screen carries, with the ⓘ that defines it.
 *
 * The definition is collapsed by default and remembered per screen for the
 * session: someone learning the system leaves it open, someone who does this
 * job every day closes it once.
 */
export function OperationHeader({
  operation,
  title,
  children,
}: {
  operation: string;
  title?: string;
  children?: ReactNode;
}) {
  const info = operationInfo(operation);
  const storageKey = `orcms.info.${operation}`;
  const [open, setOpen] = useState(() => sessionStorage.getItem(storageKey) === 'open');

  function toggle() {
    const next = !open;
    setOpen(next);
    sessionStorage.setItem(storageKey, next ? 'open' : 'closed');
  }

  return (
    <>
      <div className="op-head">
        <h2>{title ?? info?.title ?? ''}</h2>
        {children}
        {info && (
          <button
            type="button"
            className="info-btn"
            onClick={toggle}
            aria-expanded={open}
            aria-controls={`info-${operation}`}
            aria-label={open ? `Hide what ${info.title} means` : `What does ${info.title} mean?`}
            title="What is this?"
          >
            i
          </button>
        )}
      </div>

      {info && open && (
        <section className="info-panel" id={`info-${operation}`}>
          <p className="lead">{info.summary}</p>

          <h4>What happens when you save</h4>
          <ul>
            {info.effects.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>

          {info.watchOut && (
            <div className="watch-out">
              <strong>Easy to get wrong</strong>
              {info.watchOut}
            </div>
          )}
        </section>
      )}
    </>
  );
}
