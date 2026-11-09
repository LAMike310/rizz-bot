# WhatsApp Dating Agent V1 — Project Overview & Verification Checklist

**Artifact:** `whatsapp-dating-agent-v1.zip`  
**Scope:** PRD-002, draft-only, **one explicitly approved U.S. test number**  
**Environment:** Apple Silicon M1 Mac, Node.js >=22.13.0, local WhatsApp Linked Devices session, OpenRouter API key  
**Verification owner:** Coding agent, assisted by the account owner for phone operations  
**Release gate:** All automated checks AND applicable two-phone tests must pass. Do not equate mocked tests with live integration.

## 1. Mission and operating boundary

The software monitors **only one explicitly configured WhatsApp test contact**. It records incoming and manually sent text in SQLite, waits **45 seconds after the most recent incoming message**, asks an OpenRouter model to propose a Spanish response with English translation, verifies that the conversation has not changed, and saves a draft. Optionally it sends **only the owner** a draft notification via WhatsApp *Message Yourself*.

**Never send AI-generated messages to the U.S. test contact.** `DRAFT_ONLY=true` is compulsory and enforced in code. Self-chat notifications are the one permitted automated outbound message type; they can be disabled for an initial safe test.

```
U.S. WhatsApp test number -> WhatsApp Web event listener (M1)
  -> approved-contact filter -> SQLite message insert + revision
  -> resettable 45-second debounce -> OpenRouter
  -> validated structured response -> revision recheck -> SQLite draft
  -> verified owner's WhatsApp self-chat [optional]
```

**Project modules:**

| File | Responsibility |
|---|---|
| `src/index.js` | Startup, wiring and shutdown |
| `src/whatsapp.js` | LocalAuth session reuse, QR fallback, contact resolution, event filtering |
| `src/db.js` | SQLite contacts, messages, drafts, atomic inserts/revisions |
| `src/agent.js` | 45-second debounce, serial inference, manual takeover, stale-draft rejection |
| `src/openrouter.js` | OpenRouter HTTP request, timeout/retries, JSON parsing and validation |
| `src/drafts.js` | Format draft; self-chat-only send; terminal fallback |
| `src/config.js` | Read and validate `.env`; enforce draft-only |
| `src/smoke.js` | Offline SQLite + mocked OpenRouter + mocked self-chat pipeline test |
| `prompts/dating.md` | Editable reply instructions |
| `prompts/me.json` | Owner profile and style preferences |
| `tests/` | Unit/integration tests using mocks |
| `README.md` | Installation and troubleshooting |
| `TEST_REPORT.md` | Original construction-time test report |

Three SQLite tables: `contacts`, `messages`, `drafts`. No Firebase, dashboard, Calendar integration, or reply-approval sending capability in V1.

## 2. Setup safety — do this before launching

- [ ] Run on the **M1** that owns the existing authenticated WhatsApp Web session.
- [ ] Identify the **parent auth directory** (for example `/Users/you/whatsapp-agent/.wwebjs_auth`) and the **exact LocalAuth client ID** used by PRD-001. The path is **not** `session-dating-agent` itself.
- [ ] **Stop** the original PRD-001 Node/PM2 WhatsApp process. Two processes must not use the same Chromium profile concurrently.
- [ ] Do **not** delete, migrate, commit, or overwrite the original `.wwebjs_auth` directory; back it up securely if making session changes.
- [ ] Node is >=22.13.0 and npm runs: `node -v && npm -v`.
- [ ] Copy `cp .env.example .env` and configure `TEST_CONTACT_NUMBER` (digits incl. leading `1`), `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `WHATSAPP_AUTH_PATH`, `WHATSAPP_CLIENT_ID`.
- [ ] Set `DRAFT_ONLY=true`, `DEBOUNCE_MS=45000`, **`SELF_CHAT_NOTIFICATIONS=false` for the first live test**.
- [ ] Do not expose keys, authentication folders, screenshots of QR sessions, or private conversations in tickets/reports.

**Expected `.env` shape (illustrative only):**

```dotenv
TEST_CONTACT_NUMBER=1XXXXXXXXXX
OPENROUTER_API_KEY=YOUR_PRIVATE_KEY
OPENROUTER_MODEL=openrouter/free
OPENROUTER_OUTPUT_MODE=prompt
WHATSAPP_AUTH_PATH=/Users/YOU/whatsapp-agent/.wwebjs_auth
WHATSAPP_CLIENT_ID=dating-agent
DRAFT_ONLY=true
SELF_CHAT_NOTIFICATIONS=false
DEBOUNCE_MS=45000
MAX_HISTORY_MESSAGES=30
DATABASE_PATH=./data/whatsapp.db
```

If the `clientId` in PRD-001 was `personal-agent`, use `personal-agent` here. **A new QR appearing unexpectedly is a configuration warning, not a reason to delete an existing session.**

## 3. Static and offline verification (must pass first)

In the extracted project root:

```bash
npm install
npm run check
npm test
npm run smoke
```

- [ ] `npm install` succeeds on **macOS/Apple Silicon** (was not verifiable in the original offline Linux build).
- [ ] `npm run check` exits 0: main JavaScript files parse.
- [ ] `npm test` exits 0: **23 passing tests in the supplied archive** (count may grow if modified). Preserve all existing tests when fixing code.
- [ ] `npm run smoke` exits 0 and prints: `PASS: 2-message burst -> SQLite -> mocked OpenRouter -> self-chat only`.
- [ ] Tests have no dependency on real WhatsApp credentials or OpenRouter billing.
- [ ] Inspect `src/drafts.js` and `src/config.js`: only verified self-chat sending exists and `DRAFT_ONLY=false` is rejected.
- [ ] Inspect `.gitignore` to confirm `.env`, `.wwebjs_auth/`, and SQLite files are excluded.

**Recorded baseline, independently rerun in this environment:** Node 22.16.0; 23/23 tests passed; smoke passed; syntax checks passed. These are **offline** results.

## 4. Live Test A — reconnect existing WhatsApp (no model inference yet)

Start:

```bash
npm start
```

- [ ] Log shows `WhatsApp authenticated` and then `WhatsApp ready; approved contact resolved to ...`.
- [ ] It resolves **the U.S. test account**, not the owner's primary number.
- [ ] It does not unexpectedly request a new pairing QR. If it does, stop and correct `WHATSAPP_AUTH_PATH`, `WHATSAPP_CLIENT_ID`, or old-process conflicts.
- [ ] It does not enumerate or process unrelated chats in the logs.
- [ ] Record only **redacted** startup logs and whether reconnect succeeded.

**Stop condition:** If the approved contact fails to resolve (`getNumberId`/LID mapping), do not disable the allowlist. Fix the mapping and rerun.

## 5. Live Test B — one incoming message, local-only draft

Keep `SELF_CHAT_NOTIFICATIONS=false` and restart if this setting was changed.

- [ ] From the **U.S. test number**, send `Hola, cómo estás?` to the linked primary WhatsApp account.
- [ ] Observe **no generation before ~45 seconds of silence**.
- [ ] After quiet period plus OpenRouter latency, see `Generating draft`, then `Saved draft #...`, then `--- LOCAL DRAFT ---` in the Mac terminal.
- [ ] Confirm proposed Spanish `reply_es`, English `translation_en`, and reason are nonempty and contextually relevant.
- [ ] Confirm the test phone receives **zero automated messages**.
- [ ] Inspect local SQLite records using a small read-only query (example below); do not post full private text in the final report.

To inspect database counts (from the project root; default database path):

```bash
node - <<'NODE'
const Database = require('better-sqlite3');
const db = new Database('./data/whatsapp.db', {readonly:true});
for (const table of ['contacts','messages','drafts']) {
  console.log(table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
}
console.table(db.prepare(
  `SELECT id, revision, status, model FROM drafts ORDER BY id DESC LIMIT 5`
).all());
db.close();
NODE
```

If `better-sqlite3` fails to install, report that as a Mac install issue rather than silently bypassing it; the application has a built-in `node:sqlite` fallback but this illustrative query uses `better-sqlite3`.

## 6. Live Test C — three-message burst, one draft

- [ ] From the test number send `Hola!` at t=0, `Cómo estás?` at t≈7s, and `Qué haces este viernes?` at t≈19s.
- [ ] Confirm the debounce **resets** on messages 2 and 3.
- [ ] Confirm one generation starts at approximately t=64s (19 + 45), not at t=45s.
- [ ] Confirm one saved draft, reflecting all three messages. No three separate model requests/drafts.
- [ ] Confirm the U.S. test account still receives no automatic response.

## 7. Live Test D — self-chat notification

Change `SELF_CHAT_NOTIFICATIONS=true`, restart, then repeat a fresh test message.

- [ ] One formatted `DRAFT #...` arrives in **Message Yourself** on the **primary account**.
- [ ] The draft contains the Spanish suggestion, English translation, and internal draft number.
- [ ] The U.S. test account receives **no** automated reply.
- [ ] No recursive draft is generated because a self-chat notification was sent.
- [ ] SQLite draft status becomes `notified` when delivery succeeds.
- [ ] If notification fails, a local fallback draft is printed and the test account still receives nothing; diagnose using redacted logs.

**Important:** Self-chat delivery may vary by WhatsApp Web version. Test on the actual account. Fallback to local output is an acceptable safety result but **not** a pass for the mobile-draft-delivery acceptance criterion.

## 8. Live Test E — manual takeover and stale response safety

- [ ] Send from the test number and manually reply from the primary account **within the 45-second quiet period**.
- [ ] Confirm the timer is canceled and **no AI draft is generated for that burst**.
- [ ] Send another incoming message after the manual reply; confirm a new draft is generated after quiet time.
- [ ] Exercise *incoming during in-flight OpenRouter generation* using an intentionally slow/mock model transport in automated tests; confirm an earlier revision is **discarded**.
- [ ] Confirm a timer expiring while a previous request is running eventually processes the newest revision, without overlapping requests.
- [ ] Confirm duplicate WhatsApp message IDs do not create duplicate DB rows or extra drafts.

The race tests are covered offline. Do not claim they were proven by a single normal phone exchange.

## 9. Live Test F — failure recovery and restart

- [ ] Stop with Ctrl+C; start again with `npm start`.
- [ ] Reconnect to the same Linked Devices session **without re-pairing**, provided WhatsApp session is still valid.
- [ ] Old drafts are **not resent** on restart.
- [ ] Historic/synchronized messages are not spuriously processed on startup.
- [ ] Send a fresh test message; verify new draft generation still works.
- [ ] Temporarily use an **invalid model ID** or mock 429/5xx response; verify generation fails safely and no contact reply is sent; restore valid model.
- [ ] Disconnect/reconnect WhatsApp or simulate disconnection; verify process reports the issue and does not send stale drafts.
- [ ] Recheck database integrity and file protections; never paste secret tokens into logs.

## 10. Required proof and report format

Agent must deliver a short `LIVE_VERIFICATION_REPORT.md` with:

1. **Environment**: macOS, chip, `node -v`, npm version, package install result; no secret credentials.
2. **Run commands/results**: exact exit codes for `npm run check`, `npm test`, `npm run smoke`.
3. **Auth check**: existing session reused? Test contact resolved? New QR needed?
4. **Live test matrix**: tests A–F, PASS/FAIL/BLOCKED, timestamps and redacted evidence.
5. **Message counts**: number of incoming test messages, generated drafts, self-chat notifications, **automated messages to test number (must equal 0)**.
6. **Known failures**: precise symptoms, redacted logs, root cause/fix or blocker.
7. **Files changed**: list and reasons; don't rewrite pairing/session data.
8. **Final go/no-go**: one of `READY FOR DRAFT-ONLY TESTING` or `BLOCKED`; never claim production-ready autonomous messaging.

| Release gate | Required |
|---|---|
| Offline tests | All pass |
| Existing session reconnect | Pass |
| Test contact allowlist | Pass |
| 45s burst -> 1 draft | Pass |
| OpenRouter real request | Pass |
| Mobile self-chat draft | Pass if mobile delivery enabled |
| Manual takeover cancellation | Pass |
| Restart without duplicate drafts | Pass |
| AI sends to test contact | **Exactly 0** |

### Boundaries and acceptance honesty

The supplied project has **not** been verified with the user's live WhatsApp session or key in the original build environment. A mock `sendMessage` proves recipient selection logic, not actual WhatsApp delivery. A mock OpenRouter response proves request/parse logic, not real model output. Declare these distinctions explicitly in the report.

**Do not add** auto-send to matches, Google Calendar, multiple contacts, Tinder integration, a dashboard, or other features while performing V1 verification. If a test fails, fix the narrow failure, add a regression test, and rerun the full suite before repeating live tests.
