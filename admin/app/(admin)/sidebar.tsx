'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, getCsrfToken } from '@/lib/api-client';

interface NavItem {
  href: string;
  label: string;
  roles: string[]; // empty = all roles
}

const NAV: { section?: string; items: NavItem[] }[] = [
  {
    items: [
      { href: '/', label: 'Dashboard', roles: ['OWNER', 'FINANCE', 'VIEWER'] },
      { href: '/attribution', label: 'Attribution', roles: ['OWNER', 'FINANCE', 'VIEWER'] },
    ],
  },
  {
    section: 'Sales',
    items: [
      { href: '/catalog', label: 'Catalog', roles: [] },
      { href: '/orders', label: 'Orders', roles: [] },
      { href: '/payments', label: 'Payments', roles: [] },
      { href: '/fulfillment', label: 'Fulfillment', roles: [] },
      { href: '/coupons', label: 'Coupons', roles: [] },
      { href: '/refunds', label: 'Refunds', roles: ['OWNER', 'FINANCE', 'VIEWER'] },
      { href: '/approvals', label: 'Approvals', roles: ['OWNER', 'FINANCE', 'VIEWER'] },
    ],
  },
  {
    section: 'Care',
    items: [
      { href: '/tickets', label: 'Support tickets', roles: [] },
      { href: '/knowledge', label: 'Knowledge base', roles: [] },
    ],
  },
  {
    section: 'System',
    items: [
      { href: '/settings', label: 'Settings', roles: ['OWNER', 'FINANCE', 'VIEWER'] },
      { href: '/audit', label: 'Audit log', roles: [] },
      { href: '/account', label: 'My account', roles: [] },
    ],
  },
];

export default function Sidebar({ email, role }: { email: string; role: string }) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    // Revoke ALL of this admin's sessions server-side first (token_version
    // bump), so tokens copied to other browsers/devices die too. Then clear
    // the local cookie and redirect. Both calls are best-effort.
    await api('auth/logout-all', { method: 'POST' }).catch(() => null);
    const csrf = await getCsrfToken().catch(() => null);
    await fetch('/api/auth/session', {
      method: 'POST',
      headers: csrf ? { 'X-CSRF-Token': csrf } : {},
    }).catch(() => null);
    router.push('/login');
    router.refresh();
  }

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="name">ZenSkil Hub</div>
        <div className="sub">Admin panel</div>
      </div>
      <nav className="nav">
        {NAV.map((group, gi) => (
          <div key={gi}>
            {group.section && <div className="section">{group.section}</div>}
            {group.items
              .filter((i) => i.roles.length === 0 || i.roles.includes(role))
              .map((i) => (
                <Link
                  key={i.href}
                  href={i.href}
                  className={
                    i.href === '/'
                      ? pathname === '/'
                        ? 'active'
                        : ''
                      : pathname === i.href || pathname.startsWith(i.href + '/')
                        ? 'active'
                        : ''
                  }
                >
                  {i.label}
                </Link>
              ))}
          </div>
        ))}
      </nav>
      <div className="whoami">
        <div className="email">{email}</div>
        <span className="role">{role}</span>
        <button className="btn secondary small logout-btn" onClick={logout}>
          Sign out
        </button>
      </div>
    </aside>
  );
}
