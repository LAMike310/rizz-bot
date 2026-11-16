import 'server-only';
import {existsSync} from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {InboxError, openReadonly} from './open-db';

let current: {path: string; db: Database.Database} | null = null;

function configuredPath(): string {
  const fromEnv = process.env.WHATSAPP_DB_PATH;
  if (fromEnv) return fromEnv;
  const fallback = path.resolve(process.cwd(), '../data/whatsapp.db');
  return existsSync(fallback) ? fallback : '';
}

export function database(): Database.Database {
  const path = configuredPath();
  if (!path) {
    throw new InboxError('WHATSAPP_DB_PATH is required. Set it to the absolute path of data/whatsapp.db.', 'config');
  }
  if (!path.startsWith('/')) {
    throw new InboxError('WHATSAPP_DB_PATH must be an absolute path.', 'config');
  }
  if (current?.path === path) return current.db;
  if (current) current.db.close();
  current = null;
  const db = openReadonly(path);
  current = {path, db};
  return db;
}
