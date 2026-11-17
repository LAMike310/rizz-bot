import type {ReactNode} from 'react';
import {Fraunces, Outfit} from 'next/font/google';
import {AppFrame} from '../components/app-frame';
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

export const metadata = {
  title: 'Agent Inbox',
  description: 'Local read-only view of WhatsApp dating-agent conversations.',
  robots: {index: false, follow: false}
};

export default function RootLayout({children}: {children: ReactNode}) {
  return (
    <html lang="en" className={`${display.variable} ${ui.variable}`}>
      <head>
        <meta name="color-scheme" content="dark" />
      </head>
      <body>
        <AppFrame>{children}</AppFrame>
      </body>
    </html>
  );
}
