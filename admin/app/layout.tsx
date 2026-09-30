import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ZenSkil Hub — Admin',
  description: 'Admin panel for the ZenSkil Hub WhatsApp order-management platform.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
