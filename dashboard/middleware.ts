import {NextResponse} from 'next/server';
import type {NextRequest} from 'next/server';
import {isAllowedInboxHost} from './lib/host';

export function middleware(request: NextRequest) {
  if (!isAllowedInboxHost(request.headers.get('host'))) {
    return new NextResponse('This inbox is local only.', {
      status: 403,
      headers: {'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8'}
    });
  }
  return NextResponse.next();
}

export const config = {matcher: '/:path*'};
