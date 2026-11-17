import {optionHeading} from '../lib/options';
import {dayText} from '../lib/time';
import type {ConversationEvent} from '../lib/types';

function generatedWhen(iso: string, timeLabel: string): string {
  if (dayText(iso) === 'Today') return timeLabel;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return timeLabel;
  const dated = new Intl.DateTimeFormat('en-US', {month: 'short', day: 'numeric'}).format(date);
  return `${dated}, ${timeLabel}`;
}

type DraftEvent = Extract<ConversationEvent, {kind: 'draft'}>;

export function DraftPanel({
  draft,
  open,
  latest = false,
  onToggle
}: {
  draft: DraftEvent;
  open: boolean;
  latest?: boolean;
  onToggle: (id: string, open: boolean) => void;
}) {
  const selectedMissing = draft.selectedOption != null && !draft.options[draft.selectedOption - 1];
  const when = generatedWhen(draft.timestamp, draft.timeLabel);
  const expiryNote = draft.expiresAt
    ? `${draft.statusLabel === 'Expired' ? 'Expired' : 'Expires'} ${draft.expiresAt}`
    : '';
  const facts = [
    draft.approvedAt ? `Approved ${draft.approvedAt}${draft.selectedOption ? ` · option ${draft.selectedOption}` : ''}` : '',
    draft.status === 'sending' ? 'Submitted' : '',
    draft.status === 'sent' ? `Sent${draft.sentAt ? ` · ${draft.sentAt}` : ''}${draft.hasSendId ? ' · WhatsApp send id recorded' : ''}` : '',
    draft.status === 'uncertain' ? 'Send result uncertain' : ''
  ].filter(Boolean);
  const tone = draft.statusLabel.toLowerCase().replace(/[^a-z]+/g, '-');
  const sent = draft.status === 'sent';
  return (
    <article className={`draft tone-${tone}${draft.sendable ? ' sendable' : ''}${latest ? ' draft-latest' : ''}${open ? '' : ' collapsed'}`} aria-labelledby={`draft-${draft.id}-title`}>
      <h3 id={`draft-${draft.id}-title`}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`draft-${draft.id}-body`}
          onClick={() => onToggle(draft.id, !open)}
        >
          {open || draft.sendable ? (
            <svg className="spark" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 0l3.2 8.8L24 12l-8.8 3.2L12 24l-3.2-8.8L0 12l8.8-3.2z" fill="currentColor"/></svg>
          ) : (
            <svg className="draft-clock" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.8"/><path d="M12 8v5l3 2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
          )}
          <span className="draft-copy">
            <span className="draft-title-row">
              <span className="draft-title">Draft #{draft.id}</span>
              <span className="draft-status">{draft.statusLabel === 'Sent' ? <span aria-hidden="true">✓ </span> : null}{draft.statusLabel}</span>
            </span>
            <span className="draft-time">Generated at {when}{expiryNote ? <span className={draft.statusLabel === 'Expired' ? 'expiry-ember' : undefined}>{` · ${expiryNote}`}</span> : null}</span>
          </span>
          <svg className="chevron" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 10l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </h3>
      <div className="draft-reveal" id={`draft-${draft.id}-body`} inert={open ? undefined : true}>
        <div className="draft-reveal-inner">
          {draft.warning ? <p className="warning">{draft.warning}</p> : null}
          {draft.options.length ? (
            <ol className="options" role="list">
              {draft.options.map((option, index) => {
                const number = index + 1;
                const selected = draft.selectedOption === number;
                const toneClass = selected ? 'option selected' : 'option';
                const path = sent && selected ? ' chosen' : sent && !selected ? ' receded' : '';
                return (
                  <li key={`${draft.id}-${number}`} className={`${toneClass}${path}`}>
                    <span className={`option-index style-${option.style}`}>{number}</span>
                    <p className="option-label">
                      {optionHeading(option)}
                      {selected ? <span className="selected-flag">Selected</span> : null}
                    </p>
                    <div className="option-copy">
                      {option.replyEs ? <p className="option-es" lang="es">{option.replyEs}</p> : <p className="warning">Spanish text unavailable</p>}
                      {option.translationEn ? <p className="option-en" lang="en">{option.translationEn}</p> : <p className="warning">Translation unavailable</p>}
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : null}
          {selectedMissing ? <p className="warning">Option {draft.selectedOption} was recorded, but that option is not in the stored list.</p> : null}
          {draft.sendable ? (
            <p className="send-hint">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v12H4z" fill="none" stroke="currentColor" strokeWidth="1.6"/><path d="M4 7l8 6 8-6" fill="none" stroke="currentColor" strokeWidth="1.6"/></svg>
              To send, reply 1, 2, or 3 to the draft notification in WhatsApp.
            </p>
          ) : null}
          {facts.length ? <p className="draft-facts">{facts.join(' · ')}</p> : null}
        </div>
      </div>
    </article>
  );
}
