import type {DraftOption} from './types';

const STYLE_LABELS = ['Natural', 'Playful', 'Direct'];

export function parseOptions(json: string | null): {options: DraftOption[]; warning: string | null} {
  if (!json || !json.trim()) return {options: [], warning: 'This draft has no stored options.'};
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return {options: [], warning: 'Stored options could not be read.'};
  }
  if (!Array.isArray(value)) return {options: [], warning: 'Stored options could not be read.'};
  const options: DraftOption[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const replyEs = typeof record.reply_es === 'string' ? record.reply_es : '';
    const translationEn = typeof record.translation_en === 'string' ? record.translation_en : null;
    if (!replyEs && !translationEn) continue;
    const style = typeof record.style === 'string' && record.style.trim() ? record.style.trim() : 'option';
    const label = typeof record.label === 'string' && record.label.trim() ? record.label.trim() : null;
    options.push({style, label, replyEs, translationEn});
  }
  if (!options.length) return {options: [], warning: 'Stored options could not be read.'};
  return {options, warning: null};
}

export function optionHeading(option: DraftOption): string {
  if (option.style === 'natural' || option.style === 'playful' || option.style === 'direct') {
    return STYLE_LABELS[['natural', 'playful', 'direct'].indexOf(option.style)];
  }
  return option.label || option.style;
}
