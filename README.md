# WhatsApp Dating Agent V1 — draft-only

A **working Node.js implementation** of PRD-002: one approved test contact, local SQLite history, a **45-second quiet-period debounce**, OpenRouter-generated Spanish drafts, and optional draft notifications to your **own** WhatsApp self-chat. This build **never sends an AI response to the test contact**.

> **Important:** This app uses the *unofficial* `whatsapp-web.js` interface, which can break when WhatsApp changes and may put an account at risk of restrictions. Use your test number first. The pairing code/session is sensitive. This ZIP contains **no authentication data and no API key**.

## 0. Keep your existing linked session

You already paired WhatsApp using PRD-001. **Do not delete, move, or overwrite your existing `.wwebjs_auth` directory.** This ZIP is a **new standalone app**, not a replacement for your old login files.

Find the **existing project** that created the authenticated browser session. For example, suppose your original files are at:

```
/Users/YOU/whatsapp-agent/.wwebjs_auth/session-dating-agent/
```

Then your **new** `.env` must use:

```
WHATSAPP_AUTH_PATH=/Users/YOU/whatsapp-agent/.wwebjs_auth
WHATSAPP_CLIENT_ID=dating-agent
```

`WHATSAPP_AUTH_PATH` points to the **parent** of `session-dating-agent`, not the session directory itself. If the old session directory is `session-personal-agent`, instead set `WHATSAPP_CLIENT_ID=personal-agent`.

**Stop the old Node process before starting this one.** Two Chromium instances using the same LocalAuth profile can corrupt or lock that browser profile. You must not run both simultaneously.

To inspect your existing session directory on Mac:

```bash
ls -la ~/whatsapp-agent/.wwebjs_auth/
```

If your old PRD-001 project used a custom `LocalAuth` `dataPath` or `clientId`, match both settings in this app. Otherwise WhatsApp may show a **new** QR code. If it does, stop and check settings rather than deleting the original login session.

## 1. Install and configure

Requirements: macOS (Apple Silicon), Node.js >= 22.13.0, internet access, authenticated WhatsApp account and access to your U.S. test number.

From the unzipped project directory:

```bash
node -v
cp .env.example .env
nano .env
npm install
```

Fill in these keys in `.env`:

```dotenv
TEST_CONTACT_NUMBER=1YOUR_US_NUMBER
OPENROUTER_API_KEY=sk-or-v1-REPLACE_ME
OPENROUTER_MODEL=openrouter/free
DRAFT_ONLY=true
SELF_CHAT_NOTIFICATIONS=true
DEBOUNCE_MS=45000
WHATSAPP_AUTH_PATH=/absolute/path/to/existing/.wwebjs_auth
WHATSAPP_CLIENT_ID=dating-agent
VOICE_SANITY_TEST_ENABLED=false
```

`VOICE_SANITY_TEST_ENABLED` stays `false` except during a live voice-transcription check. Optional: `OPENROUTER_STT_MODEL` (default `openai/whisper-large-v3-turbo`), `VOICE_TEST_MAX_SECONDS` (30), `VOICE_TEST_MAX_BYTES` (5000000), `VOICE_STT_TIMEOUT_MS` (30000). The check reuses `OPENROUTER_API_KEY`.

Incoming voice notes from the approved contact stay off unless `INCOMING_VOICE_ENABLED=true`. `INCOMING_VOICE_LANGUAGE` defaults to `es` (`auto` omits the language hint). Limits: `INCOMING_VOICE_MAX_SECONDS` (120) and `INCOMING_VOICE_MAX_BYTES` (8000000). The same Whisper model and API key transcribe the audio. Audio is sent to OpenRouter and is not saved on disk. A failed transcript is marked in history and does not produce a draft for that burst.

Use **digits only** for `TEST_CONTACT_NUMBER` (including the country code). Do **not** put the owner's primary WhatsApp number there. Give OpenRouter a small spend cap and choose a model available to your key. `openrouter/free` is a model router; outputs, availability and limits may change. Use `OPENROUTER_OUTPUT_MODE=prompt` by default for broad compatibility, or `json_schema` for a chosen model whose endpoint supports structured outputs. Invalid output fails closed.

No `.env`, `.wwebjs_auth`, or database file is included in this ZIP; `.gitignore` excludes them.

## 2. Verify code before using a phone

```bash
npm test       # offline automated tests (58 at last count; the number may grow)
npm run smoke  # full offline demonstration: SQLite + timed agent + mocked API + mock self-chat
npm run check  # JavaScript syntax checks
```

These commands do **not** access your WhatsApp or charge OpenRouter. The tests use Node's built-in SQLite interface if `better-sqlite3` is unavailable; the application prefers `better-sqlite3` when installed. On Node 22, the built-in fallback may show an experimental feature warning.

## 3. Start the live listener

First **stop your old PRD-001 Node process** (`Ctrl+C` in its terminal, or `pm2 stop ...` if managed by PM2). Then:

```bash
npm start
```

Expected lifecycle output:

```
SQLite initialized (...); draft-only policy is enforced
WhatsApp authenticated; waiting for ready event
WhatsApp ready; approved contact resolved to ...
Listener active. Debounce: 45000ms. Model: ...
No automated messages can be sent to the test contact.
```

If a QR code appears despite your previously linked session, verify **auth path, client ID, and that the old process was stopped**. The app displays a QR for first-time pairing only when needed; do not re-pair blindly.

### Manual live end-to-end acceptance test

1. From the **U.S. test number**, send `Hola` to your primary WhatsApp number.
2. Within 10 seconds send `Cómo estás?`; then `Qué haces este viernes?`.
3. Wait **45 seconds after the LAST message**, plus OpenRouter inference latency.
4. On your **primary account**, open **Message Yourself**. Verify you got exactly **one** draft containing Spanish, English, and an internal draft ID.
5. On the **U.S. test account**, confirm that the agent sent **no automatic message**.
6. Send another incoming message and **manually reply** from the primary account within the 45-second interval. Confirm no additional draft appears for that burst.
7. Stop (`Ctrl+C`) and restart. Verify it connects without a new QR and does not resend older drafts.

If self-chat delivery fails, the draft is saved in SQLite and printed to the **local terminal**. The app will **never** fall back to sending it to the test contact.

## 4. Customize the model and voice

Edit `prompts/dating.md` and `prompts/me.json`. They are read **on every generation**, so most edits take effect without restarting. Do not put invented personal details in the profile.

To swap models, update `OPENROUTER_MODEL` in `.env` and restart the process. `OPENROUTER_OUTPUT_MODE` choices:

| Value | Behavior |
|---|---|
| `prompt` | Most model-compatible: explicitly request JSON and validate locally |
| `json_object` | Ask the provider for a JSON object; requires model support |
| `json_schema` | Strict JSON schema where provider endpoint supports it |

OpenRouter does not guarantee all free models comply with structured output; a malformed answer causes an error in the log, not an unsafe send.

## 5. What each file does

```
src/index.js       Launch / wiring / shutdown
src/whatsapp.js    Existing-session WhatsApp client, allowlist, event filtering
src/db.js          SQLite tables, atomic dedupe and revisions
src/agent.js       45s resettable timer, single in-flight request, stale checking
src/openrouter.js  OpenRouter HTTP client, parse and validate JSON
src/drafts.js      Verified self-chat-only notifications / terminal fallback
src/config.js      Safe config loader (small helper)
src/smoke.js       Offline end-to-end demonstration
prompts/dating.md  Editable master prompt
prompts/me.json    Editable user facts/preferences
tests/             No-account automated test suite
```

**Storage** is at `data/whatsapp.db` unless configured otherwise. The database stores approved contact texts, draft content, model ID and usage returned by OpenRouter. The database is not encrypted by SQLite; use FileVault and Mac login protection.

## 6. Safeguards

- **Hard-coded draft-only:** startup rejects `DRAFT_ONLY=false`, and there is **no send-to-contact implementation**.
- **One approved contact:** resolved using the WhatsApp client, not guessed from incoming names.
- **Own-chat destination:** `src/drafts.js` obtains the self-ID from `client.info.wid`; it accepts no recipient from the LLM.
- **45-second debounce:** every new incoming text resets a timer.
- **Duplicate prevention:** unique WhatsApp message ID in SQLite.
- **Stale-response protection:** if any new test-contact message or manual outgoing reply changes the revision, an older model answer is dropped before delivery.
- **Busy-model case:** if the next 45-second window expires during an earlier model request, the newest revision is processed when the previous request settles.
- **No restart replay:** processing is triggered only by approved new live events; old synchronized WhatsApp events are filtered by timestamp with a small tolerance (`MAX_EVENT_AGE_MS`).
- **No infinite retries:** API retries are bounded; invalid JSON never becomes a draft.
- **No recursive notification loop:** self-chat is excluded from both incoming and outgoing test-contact routing.

**Unavoidable race:** If a new incoming message arrives *after* WhatsApp has already accepted the self-chat notification send call, an already-sent draft cannot be retracted automatically. The app checks revision immediately before invoking that send operation to minimize this risk.

## 7. Troubleshooting

| Symptom | What to check |
|---|---|
| It shows a QR again | Correct `WHATSAPP_AUTH_PATH` and `WHATSAPP_CLIENT_ID`; old process stopped |
| Chromium profile locked | Stop all old `node`/`pm2` processes sharing LocalAuth; do not delete session |
| Contact not resolved | WhatsApp number includes country code, has active WhatsApp, and is not your primary number |
| No incoming messages handled | Is `WhatsApp ready` logged? Does WhatsApp use LID identifiers? Alias lookup is best effort; inspect safely with your developer, never disable allowlist |
| `OpenRouter HTTP 401` | Invalid or restricted key |
| `OpenRouter HTTP 429` | Free model limit / rate limiting; switch selected model or retry later |
| Model JSON invalid | Choose a model supporting `json_schema`, set `OPENROUTER_OUTPUT_MODE=json_schema`, or improve instructions |
| No self-chat draft | Check Mac terminal for `Self-chat notification failed` and locally printed fallback; some WhatsApp Web versions may not support message-yourself delivery reliably |
| Native SQLite installation fails | Confirm Node 22+ and macOS build tools; Node built-in SQLite is an optional runtime fallback |
| Old messages unexpectedly processed | Tighten `MAX_EVENT_AGE_MS` carefully; low values may drop legitimate near-ready messages |

## 8. Acceptance and security boundaries

**Verified in the supplied build environment:** JavaScript syntax, 23 offline unit/integration tests, and a complete fake-transport smoke test. See `TEST_REPORT.md`.

**Not verifiable here:** your actual `.wwebjs_auth` session, your live test contact events and LID mapping, the OpenRouter key/account quota, and WhatsApp **Message Yourself** delivery. These require a 2-phone manual acceptance run **on your Mac**. Don't claim they passed until that run succeeds.

This is deliberately **not** a production-grade bulk messaging tool or a guaranteed WhatsApp API integration. It only drafts. The unaudited linked-device session can access the WhatsApp account; secure your Mac and revoke the session at **WhatsApp > Linked Devices** if necessary.
