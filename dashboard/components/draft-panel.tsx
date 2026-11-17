import {useRef, useState} from 'react';
import {optionHeading} from '../lib/options';
import {dayText} from '../lib/time';
import type {ConversationEvent, SendControls} from '../lib/types';

function generatedWhen(iso: string, timeLabel: string): string {
  if (dayText(iso) === 'Today') return timeLabel;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return timeLabel;
  const dated = new Intl.DateTimeFormat('en-US', {month: 'short', day: 'numeric'}).format(date);
  return `${dated}, ${timeLabel}`;
}

type DraftEvent = Extract<ConversationEvent, {kind: 'draft'}>;

const RESULT: Record<string, string> = {
  SENT: 'Sent',
  IN_PROGRESS: 'Sending',
  UNKNOWN_OUTCOME: 'Send status unknown — do not retry',
  INVALID_OPTION: 'That option cannot be sent.',
  UNAUTHORIZED: 'Sending is locked.',
  CONTACT_DISABLED: 'This contact is not approved.',
  DRAFT_NOT_FOUND: 'Draft unavailable.',
  DRAFT_NOT_SENDABLE: 'This draft can no longer be sent.',
  IDENTITY_MISMATCH: 'Recipient identity could not be verified. Nothing was sent.',
  WHATSAPP_UNAVAILABLE: 'WhatsApp is not connected. Nothing was sent.',
  SEND_DISABLED: 'Dashboard send is turned off.',
  NOT_CONFIGURED: 'Dashboard send is not configured on the server.'
};

export function DraftPanel({
  draft,
  open,
  latest = false,
  onToggle,
  sendControls = 'off',
  recipientName = '',
  recipientIdentity = ''
}: {
  draft: DraftEvent;
  open: boolean;
  latest?: boolean;
  onToggle: (id: string, open: boolean) => void;
  sendControls?: SendControls;
  recipientName?: string;
  recipientIdentity?: string;
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
  const canHoverSend = sendControls === 'ready' && draft.sendable;
  const [choice, setChoice] = useState<{option: number; heading: string; replyEs: string} | null>(null);
  const [phase, setPhase] = useState<'idle' | 'sending' | 'done'>('idle');
  const [notice, setNotice] = useState('');
  const idempotencyKey = useRef('');
  const busy = useRef(false);
  const holdSend = phase === 'sending' || notice === 'Sent' || notice === 'Sending' || notice === RESULT.UNKNOWN_OUTCOME;

  async function confirmSend() {
    if (!choice || busy.current) return;
    busy.current = true;
    if (!idempotencyKey.current) idempotencyKey.current = crypto.randomUUID();
    setPhase('sending');
    setNotice('Sending');
    try {
      const response = await fetch(`/api/drafts/${draft.id}/send`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey.current,
          'x-inbox-request': '1'
        },
        body: JSON.stringify({option: choice.option})
      });
      const body = await response.json() as {code?: string};
      const code = body.code || 'UNKNOWN_OUTCOME';
      const text = RESULT[code] || RESULT.DRAFT_NOT_SENDABLE;
      setNotice(code === 'SENT' ? 'Sent' : text);
      setPhase('done');
      setChoice(null);
      if (code !== 'UNKNOWN_OUTCOME' && code !== 'SENT' && code !== 'IN_PROGRESS') {
        idempotencyKey.current = '';
        busy.current = false;
      }
      window.dispatchEvent(new CustomEvent('inbox-refresh'));
    } catch {
      setNotice(RESULT.UNKNOWN_OUTCOME);
      setPhase('done');
      setChoice(null);
    }
  }

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
                const showSend = canHoverSend && !holdSend && Boolean(option.replyEs);
                const classes = ['option'];
                if (selected) classes.push('selected');
                if (showSend) classes.push('sendable-option');
                return (
                  <li key={`${draft.id}-${number}`} className={classes.join(' ')}>
                    <p className="option-label">
                      <span className={`option-index style-${option.style}`}>{number}</span>
                      {optionHeading(option)}
                      {selected ? <span className="selected-flag">Selected</span> : null}
                    </p>
                    <div className="option-copy">
                      {option.replyEs ? <p className="option-es" lang="es">{option.replyEs}</p> : <p className="warning">Spanish text unavailable</p>}
                      {option.translationEn ? <p className="option-en" lang="en">{option.translationEn}</p> : <p className="warning">Translation unavailable</p>}
                    </div>
                    {showSend ? (
                      <button
                        type="button"
                        className="option-send"
                        onClick={() => {
                          idempotencyKey.current = crypto.randomUUID();
                          setNotice('');
                          setPhase('idle');
                          setChoice({option: number, heading: optionHeading(option), replyEs: option.replyEs});
                        }}
                      >
                        Send
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : null}
          {selectedMissing ? <p className="warning">Option {draft.selectedOption} was recorded, but that option is not in the stored list.</p> : null}
          {draft.sendable ? (
            <p className="send-hint">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v12H4z" fill="none" stroke="currentColor" strokeWidth="1.6"/><path d="M4 7l8 6 8-6" fill="none" stroke="currentColor" strokeWidth="1.6"/></svg>
              {canHoverSend
                ? 'Hover an option and choose Send, or reply 1, 2, or 3 to the draft notification in WhatsApp.'
                : 'To send, reply 1, 2, or 3 to the draft notification in WhatsApp.'}
            </p>
          ) : null}
          {draft.status === 'uncertain' ? <p className="warning">Send status unknown — do not retry</p> : null}
          {notice ? <p className="warning" role="status">{notice}</p> : null}
          {facts.length ? <p className="draft-facts">{facts.join(' · ')}</p> : null}
        </div>
      </div>
      {choice ? (
        <div className="send-dialog" role="dialog" aria-modal="true" aria-labelledby={`send-${draft.id}-title`}>
          <div className="send-card">
            <h4 id={`send-${draft.id}-title`}>Confirm send</h4>
            <p><span>To</span> {recipientName || 'Stored contact'}{recipientIdentity ? ` · ${recipientIdentity}` : ''}</p>
            <p><span>Draft</span> #{draft.id}</p>
            <p><span>Option</span> {choice.heading}</p>
            <p className="send-preview" lang="es">{choice.replyEs}</p>
            <div className="send-actions">
              <button type="button" onClick={() => { if (phase !== 'sending') setChoice(null); }} disabled={phase === 'sending'}>Cancel</button>
              <button type="button" className="confirm-send" onClick={() => { void confirmSend(); }} disabled={phase === 'sending'}>
                {phase === 'sending' ? 'Sending' : 'Confirm Send'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
}
