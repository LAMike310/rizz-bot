# Agent Inbox

Local, read-only Next.js view of the WhatsApp dating agent's SQLite database. The bot remains the only writer. This app does not send, approve, pause, or migrate anything.

## Schema map

Inspected from `src/db.js`. No columns were added.

| Entity | Table | Canonical key | Fields the inbox uses |
|---|---|---|---|
| Contact | `contacts` | `chat_id` | `display_name`, `phone`, `enabled`, `archived`, `revision`, `created_at` |
| Alias | `contact_aliases` | `alias` → `chat_id` | Aliases are not separate inbox rows |
| Message | `messages` | `id`, unique `whatsapp_id`, `chat_id` | `direction`, `body`, `message_timestamp`, `created_at`, `source_type`, `transcription_status`, `transcription_language` |
| Draft | `drafts` | `id`, `chat_id` | `revision`, `status`, `options_json`, `selected_option`, `approved_at`, `sent_at`, `sent_whatsapp_id` (presence only), `expires_at`, `created_at` |
| Revision link | Not stored | — | `drafts.revision` is the contact's counter at creation time, not a previous draft id |
| Send result | `drafts` | `id` | `status` of `sending`, `sent`, or `uncertain`, plus `selected_option`, `approved_at`, `sent_at`, and whether `sent_whatsapp_id` is present |

Indexes already present: `messages(chat_id, id)`, `drafts(chat_id, id)`, `contact_aliases(chat_id)`, plus primary keys and the unique draft notification/approval ids. There is no index on `messages.message_timestamp` or `drafts.status`. Those lookups scan one contact's rows, or the small set of `active` drafts. V1 does not add indexes.

## What the database cannot show

- No triggering message is stored. Drafts sit on the timeline at `created_at`.
- No `previous_draft_id`. A voice revision inserts a new draft row. The inbox does not label it "Revised from #n".
- Owner voice-feedback transcripts are not stored. They are not shown.
- `drafts.reason` is the constant `three-option draft`, not an explanation.
- `contacts.revision` moving ahead of a draft usually coincides with that draft being marked `stale`, but the inbox does not invent a stale status. The list says **Draft ready** only when a row is `active`, the contact is enabled and not archived, `contacts.revision` equals `drafts.revision`, and `expires_at` is empty or still in the future. The panel itself shows the stored status word.
- Status words: `pending` Pending, `active` Ready, `stale` Stale, `sending` Submitted, `sent` Sent, `uncertain` Uncertain, `failed` Failed, `expired` Expired. Nothing is labeled Delivered or Read.
- `archived = 1` is shown as Removed. That is separate from Paused (`enabled = 0`).
- The raw WhatsApp send id is not printed. The panel says a send id was recorded.
- Contact URLs are the first 20 hex characters of SHA-256(`chat_id`). The phone number is not in the path.

## Run

From `dashboard/`:

```bash
cp .env.example .env.local
# Set WHATSAPP_DB_PATH to the absolute path of the bot's data/whatsapp.db
npm install
npm test
npm run dev
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

Production, still loopback only:

```bash
npm run build
npm start
```

`npm start` runs `next start --hostname 127.0.0.1 --port 3000`. Do not expose this app with a tunnel, `0.0.0.0`, or a cloud host.

The page re-reads SQLite on each request (`force-dynamic`, `no-store`). While the tab is visible, the client calls `router.refresh()` every 4 seconds and again when the tab becomes visible. Overlapping refreshes are skipped. Scroll position and which draft panels you opened stay as you left them. If you are near the bottom, new rows follow. A failed refresh leaves a "Refresh failed" note and tries again. It does not write, checkpoint, or restart the bot.

If `-wal` or `-shm` beside the database is unreadable, the screen explains that and does not copy the file.

## Acceptance

Checked on 15 Nov 2026 against the real file at `data/whatsapp.db` and against fixture databases. The dashboard process is `next start` bound to `127.0.0.1:3000`. `WHATSAPP_DB_PATH` in `dashboard/.env.local` points at that file.

| Check | Result |
|---|---|
| Read-only handle | `query_only` is on. An `INSERT` through the dashboard handle throws, and the application-row fingerprint is unchanged. Repeated reads of the real file left message, draft, and contact counts at 130, 73, and 4. |
| Contact isolation | Aliases collapse to one row. Each thread contains only that `chat_id`. The raw WhatsApp send id is not rendered. |
| Draft status | Actionable means `active`, enabled, not archived, matching `revision`, and not past `expires_at`. The panel shows the stored status word. Selected option 2 is marked from `selected_option`, not by matching message text. |
| Live refresh | On a separate database, with the page left open, a new message and a three-option draft appeared on their own, then the row changed to Paused and the draft to Stale. Scrolling up stayed near the top when another message arrived. |
| Errors | A missing file is not created. Malformed `options_json` shows a warning and no invented options. A pending voice note says the transcript is unavailable. HTML-like message text is escaped. |
| Local only | The listener is `127.0.0.1:3000`. A non-loopback `Host` is rejected. There is no route that serves the SQLite file or the WhatsApp session. |
| Bot unchanged | `src/` and the bot `package.json` have no diff from this work. A live WhatsApp send was not repeated; that would message a real contact. |

The real inbox shows Mikey USA, Monwar, Oscar, and Jader. Draft panels show the stored Spanish options and English translations. Photos, an Activity tab, voice-feedback transcripts, "Revised from #n", and Delivered/Read are not shown, because those are not stored.
