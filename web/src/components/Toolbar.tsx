import { useMemo, useState, type ReactNode } from 'react';

/**
 * Search and filter, used by every list in the app.
 *
 * Filtering happens on what is already loaded. These lists are page-sized, so
 * a round trip per keystroke would be slower and noisier than matching in the
 * browser; the server filters only where the whole set is too large to hold
 * (the journal, the ledger).
 */

export interface FilterOption {
  label: string;
  value: string;
}

export function Toolbar({
  search,
  onSearch,
  placeholder = 'Search',
  filters,
  right,
  resultCount,
  totalCount,
}: {
  search: string;
  onSearch: (v: string) => void;
  placeholder?: string;
  filters?: Array<{
    label: string;
    value: string;
    onChange: (v: string) => void;
    options: FilterOption[];
  }>;
  right?: ReactNode;
  resultCount?: number;
  totalCount?: number;
}) {
  const filtered = totalCount !== undefined && resultCount !== undefined && resultCount !== totalCount;

  return (
    <div className="toolbar">
      <div className="toolbar-search">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
          strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-4-4" />
        </svg>
        <input
          type="search"
          value={search}
          placeholder={placeholder}
          onChange={(e) => onSearch(e.target.value)}
          aria-label={placeholder}
        />
        {search && (
          <button type="button" className="toolbar-clear" onClick={() => onSearch('')} aria-label="Clear search">
            ×
          </button>
        )}
      </div>

      {filters?.map((f) => (
        <select
          key={f.label}
          className="toolbar-filter"
          value={f.value}
          onChange={(e) => f.onChange(e.target.value)}
          aria-label={f.label}
        >
          {f.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ))}

      {right}

      {filtered && (
        <span className="toolbar-count">
          {resultCount} of {totalCount}
        </span>
      )}
    </div>
  );
}

/**
 * Matches a search term against whichever fields the caller names.
 *
 * Case-insensitive, and every whitespace-separated word must appear somewhere,
 * so "imran gulberg" finds the row that has both without them being adjacent.
 */
export function useSearch<T>(rows: T[], search: string, fields: (row: T) => Array<string | null | undefined>): T[] {
  return useMemo(() => {
    const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return rows;

    return rows.filter((row) => {
      const hay = fields(row).filter(Boolean).join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [rows, search, fields]);
}

/** A date range pair, since several screens need the same two inputs. */
export function DateRange({
  from,
  to,
  onFrom,
  onTo,
}: {
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
}) {
  return (
    <div className="range-pair">
      <label>
        <span>From</span>
        <input type="date" value={from} onChange={(e) => onFrom(e.target.value)} />
      </label>
      <label>
        <span>To</span>
        <input type="date" value={to} onChange={(e) => onTo(e.target.value)} />
      </label>
    </div>
  );
}

/** Common presets, because most questions are about this month or this year. */
export function usePeriod() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const today = now.toISOString().slice(0, 10);

  const [from, setFrom] = useState(`${y}-01-01`);
  const [to, setTo] = useState(`${y}-12-31`);

  const presets = [
    { label: 'This month', from: `${y}-${m}-01`, to: today },
    { label: 'This year', from: `${y}-01-01`, to: `${y}-12-31` },
    { label: 'Last year', from: `${y - 1}-01-01`, to: `${y - 1}-12-31` },
  ];

  return { from, to, setFrom, setTo, presets };
}
