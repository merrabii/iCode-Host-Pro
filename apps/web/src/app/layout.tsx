import type { Metadata } from 'next';
import './globals.css';
import { brand } from '@/config/brand';
import { ToastProvider } from '@/components/toast';

export const metadata: Metadata = {
  title: brand.name,
  description: brand.sub,
};

const themeInit = `try{var t=localStorage.getItem('ihp-theme');if(t!=='light'&&t!=='dark'){t='dark'}document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body suppressHydrationWarning>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
