import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import Sidebar from './sidebar';

export const dynamic = 'force-dynamic';

/**
 * Admin shell: requires a session (redirects to /login otherwise) and
 * renders the sidebar with nav items filtered by the admin's role decoded
 * from the JWT. The backend remains the RBAC authority — hiding a nav item
 * never grants or denies access, it only declutters the UI.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = getSession();
  if (!session) redirect('/login');

  return (
    <div className="shell">
      <Sidebar email={session.admin.email} role={session.admin.role} />
      <main className="main">{children}</main>
    </div>
  );
}
