---
locale: zh-CN
---

# Claude Code（claude.ai OAuth）

通过 claude.ai 的 OAuth 流程登录 Claude 账号，并用它转发 Anthropic Messages 请求。

New API 把拿到的 OAuth 凭据保存在渠道的密钥行里，在过期前自动刷新，并按 claude.ai 订阅令牌的要求为每个请求附上 Claude Code 的身份特征。

本插件是自建桥接。把个人 Claude 订阅接到共享网关上可能与厂商服务条款冲突，是否部署由管理员自行判断。

## 渠道设置

1. 在任务插件页上传 `plugin.js`，或 `POST /api/plugin/task` 提交 `{"source": "...", "remark": "claude-code"}`，然后启用插件。
2. 新建类型为 **Task Plugin** 的渠道，绑定 **claude-code**，密钥留空，渠道 Base URL 也可以留空：实际发往哪里由插件配置里的 **上游 API 地址** 决定，留空则使用渠道的 Base URL。
3. 在渠道的模型列表里填入该账号可服务的模型。
4. 在渠道上点击 **登录**。浏览器打开 claude.ai，点 **Authorize** 后会停在 `platform.claude.com` 的验证码页面。复制地址栏中的完整地址（含有 `?code=...&state=...`）粘贴到对话框。
5. 测试渠道，然后启用。

> 想在另一台设备上授权时，直接用对话框在 **打开登录页面** 下方显示的登录地址：旁边的 **复制登录链接** 按钮会复制该地址，可在另一台设备的浏览器、隐身窗口或另一个配置里打开。登录对话框属于 New API，因此该按钮随网关发布，不随插件分发。

在同一渠道上再次登录会追加一个账号：渠道变成多密钥渠道，New API 会在账号间轮询。凭据以 Claude 账号 uuid 作为 account id，因此同一账号不会被重复保存。

## 接口与模型

| 客户端接口 | 行为 |
| --- | --- |
| `POST /v1/messages` | 原样转发，流式与非流式均可用。 |
| `GET /v1/models` | 渠道没有配置前，用插件自带的模型列表回答。 |
| `POST /v1/chat/completions` | 不支持。请使用 Anthropic 原生客户端，或在前置代理里做协议转换。 |
| `POST /v1/messages/count_tokens` | 不支持；客户端自行估算 token。 |

渠道的模型列表是权威来源，插件自带的列表只作为模型发现的后备，两者请保持一致。

## 请求示例

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

## 插件改写了什么

| 成员 | 发往上游的内容 |
| --- | --- |
| 路径 | `/v1/messages?beta=true` |
| `Authorization` | `Bearer <该账号的 access token>` |
| `anthropic-beta` | Claude Code 身份集合，或渠道配置的值 |
| `anthropic-version` | `2023-06-01` |
| `user-agent` | `claude-cli/<版本> (external, cli)` |
| `x-app` | `cli` |
| `model` | 渠道映射后的上游模型 |
| `system` | 若提示词尚未包含 Claude Code 声明，则前置该声明 |
| 响应 | 原样透传，包含流式 |

claude.ai 订阅令牌只有在请求同时携带 Claude Code 的 beta 集合、User-Agent 和系统声明时才会计入订阅额度，否则会被判为第三方应用而改走额外用量甚至被拒。插件的作用就是让这三者始终一致。

## 插件配置

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `apiBaseUrl` | 留空，即使用渠道 Base URL | Messages 请求发往的地址。账号无法直连厂商时填放在 Anthropic 前面的中转地址。 |
| `clientVersion` | `2.1.81` | `user-agent` 中的版本号。厂商要求更新客户端时上调。 |
| `anthropicBeta` | Claude Code 默认集合 | 逗号分隔的 `anthropic-beta` 名称。留空则使用默认集合。 |

三项都是按渠道生效，修改后下一个请求即时生效，无需重新登录。

## 凭据生命周期

- **登录。** 对 `claude.com/cai/oauth/authorize` 使用 PKCE `S256`，验证码在 `platform.claude.com/v1/oauth/token` 兑换。保存的内容是刷新令牌、放进 `Authorization` 的访问令牌、账号与组织 uuid，以及过期时间。
- **刷新。** 访问令牌距过期 30 秒内、以及主节点的后台扫描在临近过期时触发刷新；轮换后的刷新令牌会覆盖旧的。
- **被拒。** 上游返回 401 时刷新一次并重发同一请求。若刷新被拒且原因为 `invalid_grant`，凭据被标记为需要登录，渠道被禁用并发出通知；重新登录即可恢复。

## 限制与注意事项

- 只服务 Anthropic Messages 接口。Chat Completions 流量需要在 New API 前面再加一层转换。
- `anthropic-beta` 由插件设置，客户端额外申请的 beta 不会合并进来。客户端要用某个 beta 后面的能力（例如 100 万上下文），需要把对应名称加进 `anthropicBeta`。
- 回调地址由 client id 固定，因此登录一定以粘贴地址结束；只粘贴验证码不被接受，因为网关无法把它和无效输入区分开。
- 没有余额类钩子：账号的剩余订阅额度 New API 看不到，只有厂商自己的用量页可见。
- 每个账号一行凭据。删除该密钥行（或渠道）即从网关移除凭据；厂商侧的会话要等其自然过期才失效。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| `The pasted address is not a valid callback address` | 粘贴的是裸验证码。改为复制页面完整地址。 |
| `The login was refused` | 授权已过期或被取消，重新发起登录。 |
| 登录成功后仍报 `status 401` | 刷新时报 `invalid_grant`，需要重新登录换新授权。 |
| 响应走额外用量或提示订阅错误 | 身份集合与厂商预期不符。上调 `clientVersion`，并对照当前 Claude CLI 的真实请求核对 `anthropicBeta`。 |
| `status 429` | 该账号的订阅限流。等待窗口恢复，或追加其他账号。 |
| 渠道表单里的模型列表为空 | 手动填写渠道模型；插件自带列表只是后备。 |

## 1.1.0 版本变化

登录对话框现在会显示登录地址并提供复制按钮，因此换设备授权不再需要额外的宿主补丁；插件的登录提示也改为指向该链接。

## 开发

```bash
new-api plugin lint plugin.js
new-api plugin test plugin.js --fixture fixture.json
```

固定用例覆盖：登录起始步骤、请求改写（无 system、字符串 system、数组 system、已是 Claude Code 提示词、渠道配置覆盖）、错误透传，以及本插件未使用的流式钩子。用例不会访问任何令牌接口。
