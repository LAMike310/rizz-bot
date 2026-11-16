import Database from 'better-sqlite3';
import {statSync} from 'node:fs';

export class InboxError extends Error {
  code: 'config' | 'busy' | 'read';
  constructor(message: string, code: 'config' | 'busy' | 'read') {
    super(message);
    this.name = 'InboxError';
    this.code = code;
  }
}

const WAL_HINT = 'Any whatsapp.db-wal or whatsapp.db-shm file beside the database must be readable. This dashboard will not copy or replace the database.';

export function openReadonly(file: string): Database.Database {
  if (!file) throw new InboxError('WHATSAPP_DB_PATH is required.', 'config');
  let info;
  try {
    info = statSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new InboxError(`No database file at the configured path. The dashboard does not create one. ${WAL_HINT}`, 'config');
    }
    throw new InboxError(`The database file is not readable. ${WAL_HINT}`, 'config');
  }
  if (!info.isFile()) throw new InboxError('The configured SQLite path is not a file.', 'config');
  try {
    const db = new Database(file, {readonly: true, fileMustExist: true, timeout: 1000});
    db.pragma('query_only = ON');
    return db;
  } catch (error) {
    const code = (error as {code?: string}).code;
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT') {
      throw new InboxError('Temporarily unavailable', 'busy');
    }
    throw new InboxError(`The database could not be opened read-only. ${WAL_HINT}`, 'config');
  }
}

export function guardRead<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof InboxError) throw error;
    const code = (error as {code?: string}).code;
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT') {
      throw new InboxError('Temporarily unavailable', 'busy');
    }
    throw new InboxError('Temporarily unavailable', 'read');
  }
}
