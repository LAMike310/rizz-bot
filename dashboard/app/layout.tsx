import type {ReactNode} from 'react';
import {AppFrame} from '../components/app-frame';
import './globals.css';

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
    <html lang="en">
      <head>
        <meta name="color-scheme" content="dark" />
      </head>
      <body>
        <AppFrame>{children}</AppFrame>
      </body>
    </html>
  );
}
