import type { Metadata } from 'next';
import './globals.css';
import { deriveBrandStyles } from '@/lib/brand-palette';
import { fetchBrandData } from '@/lib/brand-data';
import { BrandProvider } from '@/components/brand-provider';
import { ToastProvider } from '@/components/toast';

// Phase 14 — titre/description pilotés par le branding en base (fallback =
// valeurs par défaut). La couleur est injectée côté serveur (> pas de flash).
export async function generateMetadata(): Promise<Metadata> {
  const brand = await fetchBrandData();
  return {
    title: brand.name,
    description: brand.sub,
  };
}

const themeInit = `try{var t=localStorage.getItem('ihp-theme');if(t!=='light'&&t!=='dark'){t='dark'}document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}`;

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const brand = await fetchBrandData();
  const brandStyle = deriveBrandStyles(brand.primaryColor, brand.accentColor);

  return (
    <html lang="fr" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
        <style id="ihp-brand-style" dangerouslySetInnerHTML={{ __html: brandStyle }} />
      </head>
      <body suppressHydrationWarning>
        <BrandProvider initial={brand}>
          <ToastProvider>{children}</ToastProvider>
        </BrandProvider>
      </body>
    </html>
  );
}