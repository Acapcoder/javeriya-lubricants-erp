/**
 * Line icons, drawn inline.
 *
 * Inline SVG rather than an icon font or a package: there are about twenty of
 * them, they inherit currentColor so they follow the theme for free, and
 * nothing has to load before the sidebar can paint.
 */
export type IconName =
  | 'home' | 'buy' | 'sell' | 'stock' | 'reports'
  | 'water' | 'batch' | 'droplet'
  | 'wallet' | 'coins' | 'card' | 'receipt' | 'journal' | 'trending'
  | 'truck' | 'users' | 'shield' | 'activity' | 'settings'
  | 'menu' | 'close' | 'back' | 'plus' | 'check';

const PATHS: Record<IconName, string> = {
  home: 'M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5',
  buy: 'M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5M4 17v2.5a1.5 1.5 0 0 0 1.5 1.5h13a1.5 1.5 0 0 0 1.5-1.5V17',
  sell: 'M12 21V9m0 0 4.5 4.5M12 9 7.5 13.5M4 7V4.5A1.5 1.5 0 0 1 5.5 3h13A1.5 1.5 0 0 1 20 4.5V7',
  stock: 'M3 8.5 12 4l9 4.5-9 4.5-9-4.5ZM3 12l9 4.5L21 12M3 15.5 12 20l9-4.5',
  reports: 'M4 20V10m5 10V5m5 15v-7m5 7V8',
  water: 'M12 3s6 6.5 6 10.5A6 6 0 0 1 6 13.5C6 9.5 12 3 12 3Z',
  batch: 'M6 3v6l-3 8.5A2 2 0 0 0 4.9 21h14.2a2 2 0 0 0 1.9-3.5L18 9V3M6 3h12M5.5 15h13',
  droplet: 'M12 3s5 5.5 5 9a5 5 0 0 1-10 0c0-3.5 5-9 5-9Z',
  wallet: 'M3 7.5A1.5 1.5 0 0 1 4.5 6h13A1.5 1.5 0 0 1 19 7.5V9m-16 0v9a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 18v-6a1.5 1.5 0 0 0-1.5-1.5H4.5A1.5 1.5 0 0 1 3 9Zm13.5 4.5h.01',
  coins: 'M12 8c4.4 0 8-1.1 8-2.5S16.4 3 12 3 4 4.1 4 5.5 7.6 8 12 8Zm8-2.5v6c0 1.4-3.6 2.5-8 2.5s-8-1.1-8-2.5v-6m16 6v6c0 1.4-3.6 2.5-8 2.5s-8-1.1-8-2.5v-6',
  card: 'M3 7.5A1.5 1.5 0 0 1 4.5 6h15A1.5 1.5 0 0 1 21 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16.5ZM3 10h18M6.5 14.5h3',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2ZM9 8h6M9 12h6',
  journal: 'M5 4.5A1.5 1.5 0 0 1 6.5 3H19v18H6.5A1.5 1.5 0 0 1 5 19.5ZM5 17h14M9 7.5h6',
  trending: 'M3 17l6-6 4 4 8-8m0 0h-5m5 0v5',
  truck: 'M3 6.5A1.5 1.5 0 0 1 4.5 5H14v10H3ZM14 8.5h3.6l2.9 3.2V15H14ZM7 15a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm10 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
  users: 'M8 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 9v-1a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v1M16 4.5a3.5 3.5 0 0 1 0 7M18 20v-1a5 5 0 0 0-3-4.6',
  shield: 'M12 3l7.5 3v5.5c0 4.6-3.1 8.2-7.5 9.5-4.4-1.3-7.5-4.9-7.5-9.5V6Zm-2.5 8.5 2 2 4-4.5',
  activity: 'M4 6h16M4 12h16M4 18h10M18.5 16.5l1.5 1.5 2.5-2.5',
  settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8-3.5a8 8 0 0 0-.15-1.5l2-1.6-2-3.4-2.4 1a8 8 0 0 0-2.6-1.5L14.5 2h-5l-.35 2.5a8 8 0 0 0-2.6 1.5l-2.4-1-2 3.4 2 1.6a8.2 8.2 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a8 8 0 0 0 2.6 1.5L9.5 22h5l.35-2.5a8 8 0 0 0 2.6-1.5l2.4 1 2-3.4-2-1.6c.1-.5.15-1 .15-1.5Z',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6 6 18',
  back: 'M15 5l-7 7 7 7',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12.5l4.5 4.5L19 7',
};

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Which icon belongs to which destination. Falls back to a neutral mark. */
export function iconForPath(path: string, label: string): IconName {
  const byPath: Record<string, IconName> = {
    '/': 'home',
    '/purchases': 'buy',
    '/sales': 'sell',
    '/inventory': 'stock',
    '/reports/operations': 'reports',
    '/wtd/receptions': 'droplet',
    '/wtd/batches': 'batch',
    '/wtd/water-sales': 'water',
    '/finance/ledgers': 'wallet',
    '/finance/expenses': 'coins',
    '/finance/payments': 'card',
    '/finance/weight-fees': 'receipt',
    '/finance/journal': 'journal',
    '/finance/pnl': 'trending',
    '/drivers': 'truck',
    '/admin/contacts': 'users',
    '/admin/profiles': 'shield',
    '/admin/users': 'users',
    '/admin/activity-log': 'activity',
    '/admin/settings': 'settings',
  };
  if (byPath[path]) return byPath[path];

  const l = label.toLowerCase();
  if (l.includes('driver')) return 'truck';
  if (l.includes('supplier') || l.includes('user')) return 'users';
  if (l.includes('report')) return 'reports';
  if (l.includes('water')) return 'water';
  return 'journal';
}
