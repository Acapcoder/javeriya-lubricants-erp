import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { api, type NavItem } from '../api';
import { useAuth } from '../auth/AuthContext';
import { Icon, iconForPath } from '../components/Icon';
import { LogoIcon } from '../components/Logo';

/**
 * A full sidebar, always showing every destination the user is allowed to see.
 *
 * The earlier build hid half the app behind "More", which meant the only way
 * to learn what existed was to go looking. Now every permitted screen is
 * listed, grouped, with an icon, and it is permanent from 1024px up and a
 * drawer below that.
 *
 * The server decides what appears (/api/nav is permission filtered); this only
 * decides how it looks.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { user, signOut } = useAuth();
  const [nav, setNav] = useState<NavItem[]>([]);
  const [company, setCompany] = useState('Javeriya Lubricants');
  const [open, setOpen] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const location = useLocation();

  useEffect(() => {
    void api.nav().then((r) => setNav(r.items)).catch(() => setNav([]));
    void api.reference().then((r) => setCompany(r.company?.name || 'Javeriya Lubricants')).catch(() => {});
  }, []);

  useEffect(() => {
    setOpen(false);
    setUserMenu(false);
  }, [location.pathname]);

  // Escape closes the drawer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const initials = (user?.name ?? '?')
    .split(' ')
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  // Top level entries with no children become their own single-item group, so
  // everything renders through one path.
  const groups = nav.map((item) =>
    item.children?.length ? { label: item.label, items: item.children } : { label: null, items: [item] }
  );

  return (
    <div className="app">
      <aside className={open ? 'sidebar open' : 'sidebar'} aria-label="Sections">
        <div className="sidebar-head">
          <LogoIcon size={38} />
          <div className="brand-text">
            <strong>{company}</strong>
            <small>UCO · UEO · Recycling</small>
          </div>
        </div>

        {groups.map((g, i) => (
          <div className="nav-group" key={g.label ?? `top-${i}`}>
            {g.label && <div className="nav-group-label">{g.label}</div>}
            {g.items.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === '/'}
                className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
              >
                <Icon name={iconForPath(item.path, item.label)} size={19} />
                <span>{item.label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </aside>

      {open && <div className="scrim" onClick={() => setOpen(false)} />}

      <header className="topbar">
        <button className="menu-btn" onClick={() => setOpen(true)} aria-label="Open menu" aria-expanded={open}>
          <Icon name="menu" />
        </button>

        <LogoIcon size={34} />
        <div className="brand-text">
          <strong>{company}</strong>
          <small>UCO · UEO · Recycling</small>
        </div>

        <button
          className="user-btn"
          onClick={() => setUserMenu((v) => !v)}
          aria-label="Account"
          aria-expanded={userMenu}
        >
          {initials}
        </button>
      </header>

      {userMenu && (
        <div className="user-sheet" role="menu">
          <div className="who">
            <strong>{user?.name}</strong>
            <small>{user?.roles.join(', ')}</small>
          </div>
          <button className="btn btn-ghost" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      )}

      <main className="content">{children}</main>
    </div>
  );
}
