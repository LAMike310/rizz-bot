export type InboxContact = {
  key: string;
  displayName: string;
  phoneNumber: string | null;
  enabled: boolean | null;
  archived: boolean;
  contactStatus: 'Enabled' | 'Paused' | 'Removed';
  lastActivityAt: string | null;
  lastActivityLabel: string | null;
  lastMessagePreview: string | null;
  readyPreview: string | null;
  hasActionableDraft: boolean;
  actionableDraftId: string | null;
  draftStatus: string;
  avatarJpeg: string | null;
};

export type DraftOption = {
  style: string;
  label: string | null;
  replyEs: string;
  translationEn: string | null;
};

export type ConversationEvent =
  | {
      kind: 'message';
      id: string;
      timestamp: string;
      timeLabel: string;
      direction: 'incoming' | 'outgoing' | 'unknown';
      messageType: string;
      text: string | null;
      language: string | null;
      placeholder: string | null;
      confirmedSend: boolean;
    }
  | {
      kind: 'draft';
      id: string;
      timestamp: string;
      timeLabel: string;
      status: string;
      statusLabel: string;
      sendable: boolean;
      options: DraftOption[];
      selectedOption: number | null;
      relatedMessageId: null;
      previousDraftId: null;
      approvedAt: string | null;
      sentAt: string | null;
      expiresAt: string | null;
      hasSendId: boolean;
      warning: string | null;
    };

export type Thread = {
  contact: InboxContact;
  events: ConversationEvent[];
  hasEarlier: boolean;
  messageLimit: number;
};

export type InboxPayload = {
  revision: string;
  contacts: InboxContact[];
  total: number;
  enabled: number;
  paused: number;
  removed: number;
  hasMoreContacts: boolean;
  contactLimit: number;
  messageLimit: number;
  thread: Thread | null;
};
