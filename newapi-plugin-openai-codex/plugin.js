// OpenAI Codex (ChatGPT OAuth) provider plugin for New API.

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const CODEX_AUTH_CLAIM = "https://api.openai.com/auth";

export const meta = {
  apiVersion: 1,
  key: "openai-codex-oauth",
  name: "OpenAI Codex (ChatGPT OAuth)",
  icon: "OpenAI",
  description: {
    en: "OpenAI Codex channel authenticated with a ChatGPT account",
    zh: "使用 ChatGPT 账号 OAuth 授权的 OpenAI Codex 渠道",
  },
  version: "1.1.0",
  author: { name: "QuantumNous" },
  baseUrl: "https://chatgpt.com",
  allowedHosts: ["auth.openai.com"],
  models: ["gpt-6-luna"],
  relay: [
    {
      incoming_path: "/v1/chat/completions",
      upstream_path: "/backend-api/codex/responses",
      converter: "openai_chat_completions_to_openai_responses+plugin",
      auth: { type: "none" },
    },
    {
      incoming_path: "/v1/responses",
      upstream_path: "/backend-api/codex/responses",
      converter: "plugin",
      auth: { type: "none" },
    },
    {
      incoming_path: "/v1/responses/compact",
      upstream_path: "/backend-api/codex/responses/compact",
      converter: "plugin",
      auth: { type: "none" },
    },
  ],
  channelConfig: {
    type: "object",
    properties: {
      pass_through_body: {
        type: "boolean",
        default: false,
        title: { en: "Pass through request body", zh: "透传请求体" },
        description: {
          en: "Forward the client body unchanged; only stream=true is forced because Codex requires it.",
          zh: "原样转发客户端请求体；仅按 Codex 要求强制 stream=true。",
        },
      },
    },
  },
  keyHint: {
    en: "Leave the key empty and use Log in",
    zh: "密钥留空，然后使用登录功能",
  },
};

export function login(ctx, input) {
  if (input === null || input === undefined) {
    const login = ctx.login || {};
    const params = {
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      code_challenge: login.codeChallenge || "",
      code_challenge_method: login.codeChallengeMethod || "S256",
      state: login.state || "",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "codex_cli_rs",
    };
    return {
      type: "paste",
      url: AUTH_URL + "?" + queryString(params),
      hint: {
        en: "After authorization, copy the full localhost callback address from the browser and paste it here.",
        zh: "授权完成后，复制浏览器中的完整 localhost 回调地址并粘贴到这里。",
      },
    };
  }

  if (!input.callback) throw new Error("Paste the full authorization callback address.");
  const callback = input.callback;
  if (callback.error) throw new Error("OpenAI authorization was declined.");
  const code = String(callback.code || "").trim();
  if (!code) throw new Error("The callback address does not contain an authorization code.");

  const login = ctx.login || {};
  const response = utils.fetch({
    url: TOKEN_URL,
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: formString({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: code,
      redirect_uri: REDIRECT_URI,
      code_verifier: login.codeVerifier || "",
    }),
  });
  return { type: "done", ...tokenStep(tokenResponse(response), null) };
}

export function refresh(ctx) {
  const previous = ctx.credential || {};
  const refreshToken = typeof previous.refresh_token === "string" ? previous.refresh_token : "";
  if (!refreshToken) return { relogin: true };

  const response = utils.fetch({
    url: TOKEN_URL,
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
      refresh_reason: "proactive_expiry",
    }),
  });
  const payload = response && response.body && typeof response.body === "object" ? response.body : {};
  if (!response || response.status < 200 || response.status >= 300) {
    const code = errorCode(payload);
    if (response && (response.status === 400 || response.status === 401) || code === "invalid_grant") {
      return { relogin: true };
    }
    throw new Error("OpenAI token refresh failed with status " + (response ? response.status : "unknown") + ".");
  }
  return tokenStep(payload, previous);
}

export function signRequest(ctx) {
  const credential = ctx.credential || {};
  const accessToken = typeof credential.access_token === "string" ? credential.access_token : "";
  const accountId = typeof credential.account_id === "string" ? credential.account_id : "";
  if (!accessToken || !accountId) throw new Error("OpenAI OAuth credential is incomplete; log in again.");
  return {
    headers: {
      Authorization: "Bearer " + accessToken,
      "chatgpt-account-id": accountId,
      "OpenAI-Beta": "responses=experimental",
      originator: "codex_cli_rs",
    },
  };
}

export function convertRequest(ctx, request) {
  const body = request && request.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Codex accepts JSON Responses API requests only.");
  }
  const converted = JSON.parse(JSON.stringify(body));
  if (ctx.path === "/v1/responses/compact" || passThroughBody(ctx)) {
    converted.stream = true;
    return { body: converted, stream: request.stream === true, nativeResponse: request.stream === true };
  }
  if (converted.instructions === undefined) converted.instructions = "";
  converted.store = false;
  delete converted.max_output_tokens;
  delete converted.temperature;
  delete converted.top_p;
  delete converted.frequency_penalty;
  delete converted.presence_penalty;
  // The Codex backend requires streaming in the Responses API JSON payload.
  // The returned `stream` option controls response handling; this field is
  // separately required in the upstream JSON body for Codex.
  converted.stream = true;
  return {
    body: converted,
    stream: request.stream === true,
    nativeResponse: request.stream === true,
    headers: { "OpenAI-Beta": "responses=experimental", originator: "codex_cli_rs" },
  };
}

export function convertResponse(ctx, response) {
  const contentType = headerValue(response.headers, "content-type") || "application/json";
  if (contentType.toLowerCase().includes("text/event-stream")) {
    let completed = null;
    for (const line of String(response.body || "").split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let event;
      try {
        event = JSON.parse(data);
      } catch (_) {
        continue;
      }
      if ((event.type === "response.completed" || event.type === "response.done") && event.response) {
        completed = event.response;
      }
    }
    if (!completed) {
      return { error: { status: 502, message: "OpenAI stream ended without a completed response." } };
    }
    return { body: completed, contentType: "application/json" };
  }
  return {
    body: response.body || "",
    contentType: contentType,
  };
}

export function convertStreamEvent() {
  return {};
}

function tokenStep(payload, previous) {
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
  const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : "";
  if (!accessToken) throw new Error("OpenAI token response did not include an access token.");

  const claims = jwtPayload(accessToken) || jwtPayload(payload.id_token) || {};
  const auth = claims[CODEX_AUTH_CLAIM] || {};
  const accountId = nonEmpty(auth.chatgpt_account_id) || nonEmpty(previous && previous.account_id);
  if (!accountId) throw new Error("OpenAI token response did not include a ChatGPT account id.");
  const email = nonEmpty(claims.email) || nonEmpty(previous && previous.email);
  const expiresIn = Number(payload.expires_in);
  const ttl = Number.isFinite(expiresIn) && expiresIn > 0 ? Math.floor(expiresIn) : 3600;
  const credential = {
    access_token: accessToken,
    refresh_token: refreshToken || nonEmpty(previous && previous.refresh_token),
    account_id: accountId,
    email: email,
    id_token: typeof payload.id_token === "string" ? payload.id_token : nonEmpty(previous && previous.id_token),
  };
  if (!credential.refresh_token) throw new Error("OpenAI token response did not include a refresh token.");

  const result = {
    credential: credential,
    expiresAt: utils.unixNow() + ttl,
    accountId: accountId,
  };
  if (email) result.label = email;
  return result;
}

function tokenResponse(response) {
  const payload = response && response.body && typeof response.body === "object" ? response.body : {};
  if (!response || response.status < 200 || response.status >= 300) {
    throw new Error("OpenAI authorization code exchange failed with status " + (response ? response.status : "unknown") + ".");
  }
  return payload;
}

function errorCode(payload) {
  if (typeof payload.error === "string") return payload.error;
  return payload.error && typeof payload.error.code === "string" ? payload.error.code : "";
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function queryString(values) {
  return Object.keys(values)
    .map(function (key) { return encodeURIComponent(key) + "=" + encodeURIComponent(values[key]); })
    .join("&");
}

function formString(values) {
  return queryString(values).replace(/%20/g, "+");
}

function jwtPayload(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const input = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = "";
    let buffer = 0;
    let bits = 0;
    for (let i = 0; i < input.length; i++) {
      const value = alphabet.indexOf(input.charAt(i));
      if (value < 0) continue;
      buffer = (buffer << 6) | value;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes += String.fromCharCode((buffer >> bits) & 255);
      }
    }
    let escaped = "";
    for (let j = 0; j < bytes.length; j++) escaped += "%" + ("0" + bytes.charCodeAt(j).toString(16)).slice(-2);
    const parsed = JSON.parse(decodeURIComponent(escaped));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    return null;
  }
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return String(headers[key]);
  }
  return "";
}

function passThroughBody(ctx) {
  const config = ctx && ctx.config;
  return !!config && config.pass_through_body === true;
}
