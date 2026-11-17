import type {ReactNode} from 'react';
import type {Metadata, Viewport} from 'next';
import {cookies} from 'next/headers';
import {Fraunces, Outfit} from 'next/font/google';
import {AppFrame} from '../components/app-frame';
import {sendControlMode} from '../lib/owner-auth';
import './globals.css';

const display = Fraunces({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap'
});

const ui = Outfit({
  subsets: ['latin'],
  variable: '--font-ui',
  display: 'swap'
});

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export const metadata: Metadata = {
  title: 'Agent Inbox',
  description: 'Local read-only view of WhatsApp dating-agent conversations.',
  applicationName: 'RizzBot',
  robots: {index: false, follow: false},
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'RizzBot',
    statusBarStyle: 'black-translucent'
  },
  icons: {
    icon: '/icon.png',
    apple: '/apple-touch-icon.png'
  }
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#050909'
};

export default async function RootLayout({children}: {children: ReactNode}) {
  const jar = await cookies();
  const desktopSend = sendControlMode(jar.get('inbox_owner')?.value) !== 'off';
  return (
    <html lang="en" className={`${display.variable} ${ui.variable}`}>
      <head>
        <meta name="color-scheme" content="dark" />
      </head>
      <body>
        <AppFrame desktopSend={desktopSend}>{children}</AppFrame>
      </body>
    </html>
  );
}
