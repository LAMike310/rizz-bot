import {createHash} from 'node:crypto';

export function contactKey(chatId: string): string {
  return createHash('sha256').update(chatId, 'utf8').digest('hex').slice(0, 20);
}

export function isContactKey(value: string): boolean {
  return /^[a-f0-9]{20}$/.test(value);
}
