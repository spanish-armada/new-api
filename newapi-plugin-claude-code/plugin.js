// Claude Code (claude.ai subscription OAuth) provider plugin for New API.
//
// What it does
//   Binds a Claude account logged in through the claude.ai OAuth flow to a
//   "Task Plugin" (type 61) channel, then relays Anthropic Messages requests
//   to api.anthropic.com with that account's OAuth access token, the Claude
//   Code identity headers the token requires, and the Claude Code system
//   banner. The credential refreshes itself before it expires.
//
// Setup
//   1. Upload this file on the task plugin page (or POST /api/plugin/task) and
//      switch it on.
//   2. Create a channel of type "Task Plugin", bind this plugin, leave the key
//      empty, set the Base URL to https://api.anthropic.com, and list the
//      models the account may serve.
//   3. Start "login" on the channel. The dialog shows the claude.ai sign-in
//      address and copies it for another device. After "Authorize" the browser
//      lands on platform.claude.com and shows the authorization code; copy the
//      whole address from the address bar, which carries ?code=...&state=...,
//      and paste it into the dialog.
//   4. Test the channel. The credential is refreshed automatically, and a
//      rejected token is refreshed and the request retried once.
//
// Behaviour notes
//   - Only /v1/messages is served. OpenAI Chat Completions clients need a
//     translating proxy in front of New API.
//   - The identity headers are what a real Claude CLI sends. Tune them per
//     channel in the plugin config if the vendor changes requirements.
//   - No password is ever stored. The OAuth refresh token lives in the
//     channel's key line, which New API never shows to an administrator or
//     writes to a log.

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
// Fixed by the client id: claude.ai redirects to its own callback page only.
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const SCOPE =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const ANTHROPIC_VERSION = "2023-06-01";
// A real Claude CLI request carries ?beta=true.
const MESSAGES_PATH = "/v1/messages?beta=true";
const CLAUDE_CODE_BANNER = "You are Claude Code, Anthropic's official CLI for Claude.";
// The beta tokens Anthropic uses to tell a Claude Code plan request apart from
// a third-party request. A missing token routes the call to extra usage.
const DEFAULT_ANTHROPIC_BETA =
  "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14";
const DEFAULT_CLIENT_VERSION = "2.1.81";
const TOKEN_ENDPOINT_USER_AGENT = "axios/1.13.6";
// Used only when a token response omits expires_in, so a stored credential is
// never left without an expiry and refreshed on every request.
const FALLBACK_ACCESS_TTL_SECONDS = 3600;

export const meta = {
  apiVersion: 1,
  key: "claude-code",
  name: "Claude Code (claude.ai OAuth)",
  icon: "text:CC",
  description: {
    en: "Claude accounts logged in with claude.ai OAuth, relayed over the Anthropic Messages API",
    zh: "使用 claude.ai OAuth 登录的 Claude 账号，通过 Anthropic Messages 接口转发",
  },
  version: "1.2.0",
  author: { name: "local" },
  baseUrl: "https://api.anthropic.com",
  allowedHosts: ["claude.com", "platform.claude.com"],
  models: [
    "claude-opus-4-6-速度刷",
  ],
  relay: [
    {
      incoming_path: "/v1/messages",
      // {config.apiBaseUrl} is the channel's upstream address; an empty value
      // stands for the channel Base URL, so the plugin works either way.
      upstream_path: "{config.apiBaseUrl}/v1/messages",
      converter: "plugin",
      auth: { type: "none" },
    },
  ],
  channelConfig: {
    type: "object",
    properties: {
      apiBaseUrl: {
        type: "string",
        format: "url",
        title: { en: "Upstream API address", zh: "上游 API 地址" },
        description: {
          en: "Address the Messages requests go to; use a relay in front of Anthropic when the account must not reach it directly. Empty uses the channel Base URL",
          zh: "Messages 请求发往的地址；账号无法直连 Anthropic 时在这里填中转地址。留空则使用渠道的 Base URL",
        },
      },
      clientVersion: {
        type: "string",
        title: { en: "Claude CLI version", zh: "Claude CLI 版本" },
        description: {
          en: "Version in the User-Agent sent upstream, for example 2.1.81",
          zh: "发往上游的 User-Agent 中的版本号，例如 2.1.81",
        },
        pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$",
        default: DEFAULT_CLIENT_VERSION,
      },
      anthropicBeta: {
        type: "string",
        title: { en: "anthropic-beta header", zh: "anthropic-beta 请求头" },
        description: {
          en: "Comma separated beta tokens; empty keeps the Claude Code defaults",
          zh: "逗号分隔的 beta 名称；留空表示使用 Claude Code 默认集合",
        },
        default: DEFAULT_ANTHROPIC_BETA,
      },
    },
  },
  keyHint: {
    en: "Leave the key empty and use login",
    zh: "留空密钥并使用登录按钮",
  },
};

// ---------------------------------------------------------------------------
// Login: claude.ai authorizes the browser and shows the code on its own
// callback page, so the administrator pastes the address it lands on.
// ---------------------------------------------------------------------------

export function login(ctx, input) {
  if (input === null || input === undefined) {
    return {
      type: "paste",
      url: authorizeURL(ctx),
      hint: {
        en: "To authorize on another device, copy the sign-in link shown above and open it there. After authorizing, copy the whole address of the page the browser lands on (it contains ?code=...) and paste it here.",
        zh: "需要在另一台设备上授权时，复制上方显示的登录链接，在那台设备上打开。授权后浏览器会停在展示验证码的页面，把地址栏中的完整地址（含有 ?code=...）粘贴到这里。",
      },
    };
  }
  if (input.callback) {
    return completeLogin(ctx, input.callback);
  }
  throw new Error("The login step accepts a pasted callback address only.");
}

function authorizeURL(ctx) {
  const login = (ctx && ctx.login) || {};
  const params = [
    "code=true",
    "client_id=" + encodeURIComponent(CLIENT_ID),
    "response_type=code",
    "redirect_uri=" + encodeURIComponent(REDIRECT_URI),
    "scope=" + encodeURIComponent(SCOPE),
    "code_challenge=" + encodeURIComponent(login.codeChallenge || ""),
    "code_challenge_method=" + encodeURIComponent(login.codeChallengeMethod || "S256"),
    "state=" + encodeURIComponent(login.state || ""),
  ];
  return AUTHORIZE_URL + "?" + params.join("&");
}

function completeLogin(ctx, callback) {
  const login = (ctx && ctx.login) || {};
  const credential = splitAuthCode(callback.code);
  if (!credential.code) {
    throw new Error("The pasted address carries no authorization code.");
  }
  const payload = {
    code: credential.code,
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: login.codeVerifier || "",
  };
  const state = credential.state || callback.state || "";
  if (state) {
    payload.state = state;
  }
  const response = postToken(payload);
  if (!isSuccess(response)) {
    throw new Error(
      "The Claude token endpoint refused the authorization code: status " +
        response.status +
        vendorErrorSuffix(response.body)
    );
  }
  const step = credentialStep(tokenBody(response.body), null);
  step.type = "done";
  return step;
}

// A callback code is either a plain code or "<code>#<state>", which is the
// form the Claude Code callback page displays.
function splitAuthCode(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  const separator = value.indexOf("#");
  if (separator === -1) {
    return { code: value, state: "" };
  }
  return { code: value.slice(0, separator), state: value.slice(separator + 1) };
}

export function refresh(ctx) {
  const previous = (ctx && ctx.credential) || {};
  const refreshToken = typeof previous.refresh_token === "string" ? previous.refresh_token : "";
  if (!refreshToken) {
    return { relogin: true };
  }
  const response = postToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });
  if (!isSuccess(response)) {
    const code = vendorErrorCode(response.body);
    if (
      response.status === 400 ||
      response.status === 401 ||
      code === "invalid_grant" ||
      code === "invalid_client" ||
      code === "unauthorized_client" ||
      code === "expired_token"
    ) {
      return { relogin: true };
    }
    throw new Error(
      "The Claude token endpoint answered " + response.status + vendorErrorSuffix(response.body)
    );
  }
  return credentialStep(tokenBody(response.body), previous);
}

function postToken(payload) {
  return utils.fetch({
    url: TOKEN_URL,
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json",
      "User-Agent": TOKEN_ENDPOINT_USER_AGENT,
    },
    body: JSON.stringify(payload),
  });
}

function isSuccess(response) {
  return !!response && typeof response.status === "number" && response.status >= 200 && response.status < 300;
}

function tokenBody(body) {
  const value = body && typeof body === "object" ? body : {};
  const organization = value.organization && typeof value.organization === "object" ? value.organization : {};
  const account = value.account && typeof value.account === "object" ? value.account : {};
  const expiresIn = Number(value.expires_in);
  return {
    accessToken: typeof value.access_token === "string" ? value.access_token : "",
    refreshToken: typeof value.refresh_token === "string" ? value.refresh_token : "",
    scope: typeof value.scope === "string" ? value.scope : "",
    expiresIn: isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 0,
    organizationUuid: typeof organization.uuid === "string" ? organization.uuid : "",
    accountUuid: typeof account.uuid === "string" ? account.uuid : "",
    email: typeof account.email_address === "string" ? account.email_address : "",
  };
}

// credentialStep builds the credential of a login (previous is null) or of a
// refresh. The refresh endpoint answers without account details, so the stored
// ones are carried over; accountId and label are omitted on refresh, which
// keeps the stored values.
function credentialStep(token, previous) {
  const data = {
    refresh_token: pick(token.refreshToken, previous, "refresh_token"),
    access_token: token.accessToken,
    account_uuid: pick(token.accountUuid, previous, "account_uuid"),
    organization_uuid: pick(token.organizationUuid, previous, "organization_uuid"),
    email: pick(token.email, previous, "email"),
    scope: pick(token.scope, previous, "scope"),
  };
  if (!token.accessToken) {
    throw new Error("The Claude token endpoint returned no access token.");
  }
  if (!data.refresh_token) {
    throw new Error("The Claude token endpoint returned no refresh token.");
  }
  const step = {
    credential: data,
    headers: { Authorization: "Bearer " + token.accessToken },
  };
  const ttl = token.expiresIn > 0 ? token.expiresIn : FALLBACK_ACCESS_TTL_SECONDS;
  step.expiresAt = utils.unixNow() + Math.round(ttl);
  if (!previous) {
    if (data.account_uuid) {
      step.accountId = data.account_uuid;
    }
    if (data.email) {
      step.label = data.email;
    }
  }
  return step;
}

function pick(value, previous, key) {
  if (value) {
    return value;
  }
  if (previous && typeof previous[key] === "string") {
    return previous[key];
  }
  return "";
}

function vendorErrorCode(body) {
  if (!body || typeof body !== "object") {
    return "";
  }
  const error = body.error;
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && typeof error.type === "string") {
    return error.type;
  }
  return "";
}

function vendorErrorSuffix(body) {
  const code = vendorErrorCode(body);
  return code ? " (" + code + ")" : "";
}

// ---------------------------------------------------------------------------
// Relay: a Claude Messages request rewritten into the shape a claude.ai plan
// token accepts, then handed to the client as it came from the vendor.
// ---------------------------------------------------------------------------

export function convertRequest(ctx, request) {
  const body = requestBody(request);
  if (!body) {
    throw new Error("claude-code serves JSON Anthropic Messages requests only.");
  }
  if (request && typeof request.model === "string" && request.model !== "") {
    body.model = request.model;
  }
  applyClaudeCodeSystem(body);
  return {
    body: body,
    path: MESSAGES_PATH,
    stream: !!(request && request.stream === true),
    nativeResponse: true,
    headers: identityHeaders(ctx && ctx.config),
  };
}

// Only a non-2xx reply reaches this hook: nativeResponse hands a 2xx reply to
// the Claude handler, so the vendor's error body reaches the client unchanged.
export function convertResponse(ctx, response) {
  const status = response && typeof response.status === "number" ? response.status : 0;
  const body = response ? response.body : "";
  if (typeof body === "string" && body.trim() !== "") {
    return {
      body: body,
      contentType: headerValue(response && response.headers, "Content-Type") || "application/json",
    };
  }
  return {
    body: {
      type: "error",
      error: { type: "api_error", message: "The vendor answered status " + status + " without a body." },
    },
  };
}

// Unused with nativeResponse, which keeps streamed replies on the vendor's
// wire format; the route requires the export all the same.
export function convertStreamEvent() {
  return {};
}

function requestBody(request) {
  const raw = request ? request.body : null;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return JSON.parse(JSON.stringify(raw));
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (error) {
      return null;
    }
  }
  return null;
}

function identityHeaders(config) {
  return {
    "anthropic-version": ANTHROPIC_VERSION,
    "anthropic-beta": configuredBeta(config),
    "user-agent": configuredUserAgent(config),
    "x-app": "cli",
  };
}

function configuredBeta(config) {
  const value = config && typeof config.anthropicBeta === "string" ? config.anthropicBeta.trim() : "";
  return value !== "" ? value : DEFAULT_ANTHROPIC_BETA;
}

function configuredUserAgent(config) {
  const version =
    config && typeof config.clientVersion === "string" && config.clientVersion.trim() !== ""
      ? config.clientVersion.trim()
      : DEFAULT_CLIENT_VERSION;
  return "claude-cli/" + version + " (external, cli)";
}

// applyClaudeCodeSystem prepends the Claude Code identity banner to the system
// prompt. A request that already carries it, as real Claude CLI requests do, is
// left untouched.
function applyClaudeCodeSystem(body) {
  const system = body.system;
  if (isEmptySystem(system)) {
    body.system = [bannerBlock()];
    return;
  }
  if (hasClaudeCodeBanner(system)) {
    return;
  }
  if (typeof system === "string") {
    body.system = [bannerBlock(), { type: "text", text: CLAUDE_CODE_BANNER + "\n\n" + system }];
    return;
  }
  if (Array.isArray(system)) {
    const blocks = [bannerBlock()];
    for (let index = 0; index < system.length; index++) {
      blocks.push(normalizeSystemBlock(system[index]));
    }
    body.system = blocks;
  }
}

function isEmptySystem(system) {
  if (system === undefined || system === null) {
    return true;
  }
  if (typeof system === "string") {
    return system.trim() === "";
  }
  if (Array.isArray(system)) {
    return system.length === 0;
  }
  return false;
}

function hasClaudeCodeBanner(system) {
  const texts = systemTexts(system);
  for (let index = 0; index < texts.length; index++) {
    if (texts[index].indexOf(CLAUDE_CODE_BANNER) !== -1) {
      return true;
    }
  }
  return false;
}

function systemTexts(system) {
  const texts = [];
  if (typeof system === "string") {
    texts.push(system);
    return texts;
  }
  if (!Array.isArray(system)) {
    return texts;
  }
  for (let index = 0; index < system.length; index++) {
    const block = system[index];
    if (typeof block === "string") {
      texts.push(block);
    } else if (block && typeof block === "object" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  return texts;
}

function normalizeSystemBlock(block) {
  if (typeof block === "string") {
    return { type: "text", text: block };
  }
  return block;
}

function bannerBlock() {
  return { type: "text", text: CLAUDE_CODE_BANNER, cache_control: { type: "ephemeral" } };
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") {
    return "";
  }
  const wanted = name.toLowerCase();
  const names = Object.keys(headers);
  for (let index = 0; index < names.length; index++) {
    if (names[index].toLowerCase() === wanted) {
      const value = headers[names[index]];
      return typeof value === "string" ? value : "";
    }
  }
  return "";
}
