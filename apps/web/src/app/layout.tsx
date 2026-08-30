import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'iCode Host Pro',
  description: 'Self-hosted hosting control plane — Phase 0 diagnostic',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}