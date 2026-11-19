---
locale: en
translations:
  zh-CN: README.zh-CN.md
---

# Claude Code (claude.ai OAuth)

Log a Claude account in through the claude.ai OAuth flow and relay Anthropic
Messages requests with it.

New API stores the resulting OAuth credential in the channel's key line,
refreshes it before it expires, and sends each request with the Claude Code
identity that a claude.ai plan token requires.

This plugin is a self-hosted bridge. Serving a personal Claude subscription
through a shared gateway can conflict with the vendor's terms of service;
whether to do it is the administrator's decision.

## Channel setup

1. Upload `plugin.js` on the task plugin page, or `POST /api/plugin/task`
   with `{"source": "...", "remark": "claude-code"}`. Switch the plugin on.
2. Create a channel of type **Task Plugin**, bind **claude-code**, and leave
   the key empty. The channel Base URL can stay empty too: the plugin's
   **Upstream API address** setting decides where requests go, and falls back
   to the channel Base URL when it is empty.
3. Fill the channel's model list with the models the account may serve.
4. Press **login** on the channel. The browser opens claude.ai; after
   **Authorize** it lands on `platform.claude.com`, which shows the
   authorization code. Copy the whole address from the address bar — it
   carries `?code=...&state=...` — and paste it into the dialog.
5. Test the channel, then enable it.

> To authorize on another device, use the sign-in address the dialog shows under
> **Open sign-in page**: its **Copy sign-in link** button copies that address, so
> it can be opened in another browser, device or profile. The login dialog
> belongs to New API, so this button ships with the gateway, not with the plugin.

Logging in again on the same channel adds another account: the channel becomes
a multi-key channel and New API polls the stored accounts. A credential keeps
the Claude account uuid as its account id, so the same account is not stored
twice.

## Endpoints and models

| Client endpoint | Behaviour |
| --- | --- |
| `POST /v1/messages` | Relayed; streaming and non-streaming both work. |
| `GET /v1/models` | Answered from the plugin's model list until the channel sets one. |
| `POST /v1/chat/completions` | Not served. Use an Anthropic-native client, or route OpenAI-format traffic through a translating proxy. |
| `POST /v1/messages/count_tokens` | Not served; the client counts tokens locally. |

The channel's model list is authoritative. The plugin's own list is only the
fallback for model discovery, so keep the two consistent.

## Request example

```bash
curl http://localhost:3000/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-api-key: sk-your-new-api-token' \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "hello"}]
  }'
```

## What the plugin changes

| Member | Sent upstream |
| --- | --- |
| Path | `/v1/messages?beta=true` |
| `Authorization` | `Bearer <the account's access token>` |
| `anthropic-beta` | The Claude Code identity set, or the channel's value |
| `anthropic-version` | `2023-06-01` |
| `user-agent` | `claude-cli/<version> (external, cli)` |
| `x-app` | `cli` |
| `model` | The channel's mapped upstream model |
| `system` | The Claude Code banner is prepended, unless the prompt already carries it |
| Reply | Passed through unchanged, streaming included |

A claude.ai plan token is only billed against the plan when the request carries
the Claude Code beta set, user agent and system banner; otherwise the vendor
routes it to extra usage or refuses it. Keeping those three together is the
whole point of the plugin.

## Plugin config

| Field | Default | Meaning |
| --- | --- | --- |
| `apiBaseUrl` | Empty, which means the channel Base URL | Address the Messages requests go to. Point it at a relay in front of Anthropic when the account cannot reach the vendor directly. |
| `clientVersion` | `2.1.81` | Version in the `user-agent`. Raise it when the vendor requires a newer client. |
| `anthropicBeta` | The Claude Code set | Comma separated `anthropic-beta` tokens. Empty keeps the default. |

All three are per channel. Changing them takes effect on the next request; no
re-login is needed.

## Credential lifecycle

- **Login.** PKCE `S256` against `claude.com/cai/oauth/authorize`, code
  exchanged at `platform.claude.com/v1/oauth/token`. The stored credential is
  the refresh token, the access token in the `Authorization` header, the
  account and organization uuid, and the expiry.
- **Refresh.** Run when the credential expires within 30 seconds, and by the
  master node's background scan for credentials expiring soon. A rotated
  refresh token replaces the stored one.
- **Rejection.** An upstream 401 refreshes the credential once and resends the
  request. When the refresh is refused with `invalid_grant`, the credential is
  marked as needing a login, the channel is disabled and a notification is
  sent; log in again to restore it.

## Limits and things to know

- Only the Anthropic Messages API is served. Chat Completions traffic needs a
  translating layer in front of New API.
- The plugin sets `anthropic-beta` itself, so beta tokens a client asks for are
  not merged in. A client that needs a feature behind another beta — the 1M
  context window, for example — needs that token added to `anthropicBeta`.
- The redirect address is fixed by the client id, so login always ends with a
  pasted address. A bare authorization code is not accepted, because the
  gateway cannot tell it from an invalid entry.
- No billing or balance hooks: an account's remaining plan quota is not
  visible to New API, only the vendor's own usage page shows it.
- One credential per account line. Deleting the key line (or the channel)
  removes the credential from the gateway; the vendor's own session stays valid
  until it expires.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `The pasted address is not a valid callback address` | A bare code was pasted. Copy the full address of the page instead. |
| `The login was refused` | The authorization expired or was cancelled. Start the login again. |
| `status 401` after a successful login | `invalid_grant` on refresh. Log in again; the credential needs a new authorization. |
| Responses bill extra usage or return a plan error | The identity set no longer matches the vendor's expectation. Raise `clientVersion`, and check `anthropicBeta` against a current Claude CLI request. |
| `status 429` | The account's plan limit. Wait for the window, or add another account. |
| Model list empty in the channel form | Set the channel's models by hand; the plugin's list is only a fallback. |

## Version 1.1.0

The login dialog now displays the sign-in address and copies it, so authorizing
on another device needs no host patch. The plugin's login hint points at it.

## Development

```bash
new-api plugin lint plugin.js
new-api plugin test plugin.js --fixture fixture.json
```

The fixture covers the login start step, the request rewrite (absent, string
and array system prompts, an already-Claude-Code prompt, channel config), the
error pass-through and the unused stream hook. The token endpoints are never
contacted by a fixture.
