export const CONTACT_PAGE = 50;
export const CONTACT_MAX = 500;
export const MESSAGE_PAGE = 80;
export const MESSAGE_STEP = 80;
export const MESSAGE_MAX = 800;

export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function pageLimit(value: string | undefined, fallback: number, max: number): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}
