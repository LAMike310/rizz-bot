import {Avatar} from './avatar';
import type {ConversationEvent} from '../lib/types';

type MessageEvent = Extract<ConversationEvent, {kind: 'message'}>;

export function MessageItem({message, contactName, showAvatar = true}: {message: MessageEvent; contactName: string; showAvatar?: boolean}) {
  const who = message.direction === 'outgoing' ? 'You' : message.direction === 'incoming' ? contactName : 'Unknown';
  const body = message.text ?? message.placeholder;
  const incoming = message.direction !== 'outgoing';
  const compact = message.messageType === 'text' && Boolean(body) && !body!.includes('\n') && body!.length <= 28;
  return (
    <article className={`bubble-row bubble-${message.direction}${showAvatar ? '' : ' grouped'}`}>
      {incoming ? (showAvatar ? <Avatar name={contactName} size={32} /> : <span className="avatar-gap" aria-hidden="true" />) : null}
      <div className={compact ? 'bubble compact' : 'bubble'}>
        <p className="visually-hidden">{who}</p>
        {message.messageType === 'voice' ? <p className="bubble-kind">Voice note</p> : null}
        {message.messageType !== 'voice' && message.messageType !== 'text' ? <p className="bubble-kind">{message.placeholder}</p> : null}
        {message.messageType === 'voice' || message.messageType === 'text' ? (
          <p className="bubble-text" lang={message.language ?? undefined}>{body}</p>
        ) : null}
        <time dateTime={message.timestamp}>
          {message.timeLabel}
          {message.confirmedSend ? <span className="send-mark" aria-label="Send id recorded"> ✓</span> : null}
        </time>
      </div>
    </article>
  );
}
