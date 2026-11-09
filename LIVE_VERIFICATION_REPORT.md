# Live verification report — WhatsApp Dating Agent V1

**Date:** 2026-11-09  
**Recommendation:** **BLOCKED**

Offline checks pass after a narrow WhatsApp-module fix. The release gate also requires an observed two-phone run. That run was not performed. No live WhatsApp event, OpenRouter generation, self-chat delivery, or “zero messages to the test number” result is claimed.

## 1. Environment

| Item | Value |
|---|---|
| OS | macOS 26.5.1 (build 25F80), arm64 |
| Node | v22.17.1 (>= 22.13.0) |
| npm | 10.9.2 |
| `npm install` | Exit 0. Tree already present: `better-sqlite3@11.10.0`, `dotenv@16.6.1`, `qrcode-terminal@0.12.0`, `whatsapp-web.js@1.34.7`. `better-sqlite3` loads in-process. |
| npm audit | Reported 16 vulnerabilities in dependencies. Not changed during verification. |

No API keys, session files, or message text are included here.

## 2. Offline commands

| Command | Exit | Result |
|---|---|---|
| `npm run check` | 0 | Main JavaScript files parse. |
| `npm test` | 0 | **24 / 24** passing after the fix (archive baseline was 23). First run was **20 pass / 3 fail**. |
| `npm run smoke` | 0 | Printed `PASS: 2-message burst -> SQLite -> mocked OpenRouter -> self-chat only`. |

These runs do not use WhatsApp or OpenRouter. Smoke uses real SQLite with a mocked model and a mocked self-chat send. `tests/helpers.js` forces the Node built-in SQLite driver, so the experimental SQLite warning in the test log is expected and is not a `better-sqlite3` install failure.

Static inspection:

- `src/config.js` rejects `DRAFT_ONLY=false`.
- `src/drafts.js` is the only automated `sendMessage` path. The recipient is `client.info.wid`, and delivery is refused when that id equals the test chat.
- `.gitignore` excludes `.env`, `.wwebjs_auth/`, and `*.db`.

## 3. Auth check

| Check | Result |
|---|---|
| Existing session directory | Present: project `.wwebjs_auth/session-dating-agent`. Not deleted, moved, or overwritten. |
| Expected client id | `dating-agent` (directory name `session-dating-agent`). Parent path is `.wwebjs_auth`, not the session folder itself. |
| Competing LocalAuth process | None found (`ps` showed no Node/PM2 process running this agent). |
| `.env` | **Absent.** `.env.example` is also absent, so the documented `cp .env.example .env` step cannot be run. |
| `npm start` | **Not started.** `loadConfig()` requires `TEST_CONTACT_NUMBER`, `OPENROUTER_API_KEY`, and `OPENROUTER_MODEL`. Starting without them would fail closed, and starting with a guessed number could pair or resolve the wrong chat. |
| Session reused / contact resolved / new QR | **BLOCKED — not observed.** |

## 4. Live test matrix

| Test | Result | Evidence |
|---|---|---|
| A. Reconnect existing WhatsApp | **BLOCKED** | Listener was not started. No “WhatsApp authenticated” or “approved contact resolved” log was observed. |
| B. One incoming message, local draft, `SELF_CHAT_NOTIFICATIONS=false` | **BLOCKED** | No message was sent from a U.S. test phone. No 45-second wait, OpenRouter call, or terminal draft was observed. |
| C. Three-message burst → one draft | **BLOCKED** | Not exercised on WhatsApp. Covered only by the mocked agent test and smoke run. |
| D. Self-chat notification | **BLOCKED** | Not enabled and not delivered. Mobile Message Yourself was not checked. |
| E. Manual takeover, duplicates, stale generation | **BLOCKED** on the phone. Offline tests for cancel, duplicate ids, in-flight discard, and busy-model follow-up passed. Those are not a live proof. |
| F. Restart, invalid model, disconnect | **BLOCKED** | Process was not started, so restart, historic-event filtering, and disconnect behavior were not observed live. Offline restart test passed. |

## 5. Message counts

Not applicable. The listener never ran.

| Count | Value |
|---|---|
| Incoming test messages observed | 0 |
| Drafts generated from live WhatsApp | 0 |
| Self-chat notifications observed | 0 |
| Automated messages to the test number | **Not measured.** Cannot be reported as zero from a live run. |

## 6. Bugs found

`src/whatsapp.js` did not match the rest of the PRD-002 app:

- It ignored `WHATSAPP_AUTH_PATH` and `WHATSAPP_CLIENT_ID` and always used a hardcoded path and `dating-agent`.
- It did not export `parseApprovedEvent` or `resolveTestContact`.
- It logged every private or group message and never called the agent, SQLite, debounce, or draft delivery.
- `src/index.js` calls `createWhatsAppClient(config, log, handlers)`, but the previous function took no arguments, so `npm start` would not attach the allowlist or the 45-second agent.

First `npm test` failed exactly on the three WhatsApp tests (`parseApprovedEvent is not a function`, `resolveTestContact is not a function`).

## 7. Changes made

- `src/whatsapp.js` — restored config-based LocalAuth, approved-contact resolution (phone id plus LID alias), incoming/outgoing allowlist filtering, stale-event filtering, and handler wiring. A QR is logged as a session-reuse warning. The module does not send messages to the test contact.
- `tests/whatsapp.test.js` — added `LocalAuth options reuse the configured parent auth path and client id`.

No calendar, auto-reply, extra contacts, or dashboard work was added. The `.wwebjs_auth` directory was not modified.

## 8. Tests added

- Regression: LocalAuth `clientId` and parent `dataPath` come from config, and `dataPath` is not the `session-<id>` directory itself.
- Existing WhatsApp filter and resolver tests are the regression for the missing exports. Full suite after the change: 24 passing.

## 9. Outstanding limitations

- No `.env` and no `.env.example`. Live tests need the approved U.S. number, OpenRouter key, model, `DRAFT_ONLY=true`, `DEBOUNCE_MS=45000`, `WHATSAPP_AUTH_PATH` pointing at this project’s `.wwebjs_auth`, `WHATSAPP_CLIENT_ID=dating-agent`, and `SELF_CHAT_NOTIFICATIONS=false` for the first run.
- A human has to send the test-phone messages and confirm the test phone stays silent. That was not done in this session.
- Mocked `sendMessage` and mocked OpenRouter still do not prove WhatsApp delivery or a real model response.
- `whatsapp-web.js` remains an unofficial client.

## 10. Go / no-go

**BLOCKED**

Do not treat this build as ready for draft-only testing on the live account until Tests A–F are actually run and the success criterion is seen: one burst from the U.S. test number produces exactly one contextual Spanish draft on the owner’s self-chat, and the test number receives zero automated messages.
