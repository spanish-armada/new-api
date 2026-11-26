# OpenAI Codex (ChatGPT OAuth)

This provider plugin logs in with a ChatGPT account and relays OpenAI Responses API requests to the Codex endpoint on `chatgpt.com`. New API stores the OAuth credential in the channel key line, refreshes it before expiry, and keeps the access and refresh tokens out of channel views and logs.

## Setup

1. Upload `plugin.js` on the task plugin page and enable it.
2. Create a **Task Plugin** channel bound to `openai-codex-oauth`. Leave the key empty; the plugin supplies `https://chatgpt.com` as the default Base URL.
3. Enter the models available to the ChatGPT account in the channel model list.
4. Choose **Log in** before saving. Complete authorization, then paste the full `http://127.0.0.1:1455/auth/callback?...` address shown by the browser.
5. Save and test the channel.

The login link uses the Codex CLI's registered loopback callback because the public Codex OAuth client does not accept the gateway callback URL. The callback's one-time code is exchanged server-side with the PKCE verifier held by New API.

## Supported routes

| Client route | Codex upstream route |
| --- | --- |
| `POST /v1/responses` | `/backend-api/codex/responses` |
| `POST /v1/responses/compact` | `/backend-api/codex/responses/compact` |

The regular Responses route sets `store` to `false`, supplies empty `instructions` when absent, and removes parameters the Codex endpoint does not accept. Replies pass through in Responses format, including streaming. Model availability and subscription limits are controlled by OpenAI and the signed-in account.

## Credential lifecycle

- OAuth uses PKCE S256 and the Codex CLI's public client id.
- Expiring credentials refresh through `auth.openai.com`; rotated refresh tokens replace the old token.
- Invalid or revoked refresh tokens mark the credential for a new login.
- Each credential is identified by its ChatGPT account id to prevent duplicate accounts in the gateway.

This plugin uses the OpenAI Codex OAuth and backend endpoints. Their availability and accepted client behavior may change; use only accounts and traffic that you are authorized to connect.
