# cloudflare-actions-url-forword

[English](README.md) | [简体中文](README.zh-CN.md)

这是一个用于 Forgejo `DEFAULT_ACTIONS_URL` 的 Cloudflare Worker 重定向入口。
当对应仓库存在于你的 Forgejo 实例中时，它会把匿名的 Actions 和 Git 请求发送到
该公开仓库；否则，请求会转到 GitHub 或其他配置的默认源。

## 工作方式

对于以下请求：

```text
https://actions.example.com/actions/checkout@v4
```

Worker 只执行一次来源查询：

1. 从 KV 读取 `repo:v1:{owner}/{repo}`。
2. 缓存未命中时，匿名请求
   `{FORGEJO_BASE_URL}/api/v1/repos/{owner}/{repo}`。
3. API 返回 `200` 时，重定向到对应的 Forgejo 仓库。
4. 否则，重定向到默认源。

`@v4` 便捷后缀只用于缓存查询，重定向前会被移除，因此上例最终转到：

```text
https://forgejo.example.com/actions/checkout
```

仓库子路径和查询字符串会完整保留：

```text
/actions/checkout/archive/main.zip
/actions/checkout/info/refs?service=git-upload-pack
/actions/checkout/git-upload-pack
```

`.git` 后缀只在查询仓库键时移除，重定向目标仍保留原始的 `.git` 路径。

`GET` 和 `HEAD` 使用 `302` 重定向。`POST` 使用 `307`，以保留方法和请求体，同时
不读取也不缓存请求体。`OPTIONS` 返回 `204`，其他方法返回 `405`。

## 环境要求

- Node.js 22 或更高版本
- 已完成 Wrangler 认证的 Cloudflare 账户
- REST API 允许匿名访问的公开 Forgejo 实例
- 支持自定义 `DEFAULT_ACTIONS_URL` 的 Forgejo 版本

部分 Gitea 版本会拒绝自定义 Actions URL。这里的单次重定向设计还要求 Git
客户端跟随第一次重定向；重定向之后的请求会直接发往选定的上游，而不会回到
Worker。

## Cloudflare 一键部署

[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/SpiralTower/cloudflare-actions-url-forword)

## 配置 Cloudflare

安装依赖并认证 Wrangler：

```sh
npm install
npx wrangler login
```

手动部署时，创建生产 KV 命名空间：

```sh
npx wrangler kv namespace create ACTIONS_CACHE
```

将返回的命名空间 ID 写入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "ACTIONS_CACHE"
id = "your-kv-namespace-id"
```

也可以保留不含 `id` 的 `ACTIONS_CACHE` binding，由 `wrangler deploy` 自动
创建 namespace。通过仓库自动部署时，自动创建的资源 ID 可能只显示在
Dashboard，而不会写回仓库。

将 Forgejo 根地址保存为加密 secret。该地址必须使用 `http://` 或 `https://`，
只能是根地址，不能包含路径、查询字符串、片段或结尾斜杠：

```sh
npx wrangler secret put FORGEJO_BASE_URL
# 输入：https://forgejo.example.com
```

默认的回落源是 `https://github.com`。如需修改，请编辑 `wrangler.toml` 中的普通
变量：

```toml
[vars]
FALLBACK_BASE_URL = "https://github.com"
```

验证并部署：

```sh
npm test
npm run format:check
npm run check:worker
npx wrangler deploy
```

在 **Cloudflare Dashboard → Workers & Pages →
cloudflare-actions-url-forword → Settings → Domains & Routes** 中配置 Custom Domain。
将生成的 HTTPS 地址用作 Forgejo 配置值，且不要添加结尾斜杠。

## 配置 Forgejo

在 Forgejo 的 `app.ini` 中将 `DEFAULT_ACTIONS_URL` 设置为 Worker 地址：

```ini
[actions]
DEFAULT_ACTIONS_URL = https://actions.example.com
```

修改 `app.ini` 后重启 Forgejo。仓库及其 API 必须允许公开读取，因为此 Worker
会有意拒绝带有 `Authorization` 的请求。

## 缓存行为

缓存键使用小写形式：

```text
repo:v1:{owner}/{repo}
```

每个值记录所选来源和时间戳：

```json
{
  "upstream": "forgejo",
  "checkedAt": 1795620000,
  "freshUntil": 1795706400,
  "retryAt": 0
}
```

仓库成功发现后，结果在一天内视为新鲜。仓库不存在、未授权或禁止访问时，负结果
也会缓存一天，避免 Worker 对只存在于 GitHub 的仓库反复请求 API。

缓存过期后，Worker 会立即使用旧值完成重定向，同时通过 `ctx.waitUntil()` 在
后台刷新。刷新失败会保留原来源，并在 15 分钟内不再尝试。首次探测遇到 API
限流、服务端错误、网络错误或三秒超时，会临时回落到配置的默认源，并在 15 分钟
后重试。

同一 Worker isolate 内，对同一仓库的并发刷新会合并。KV 在 Cloudflare 各位置
之间是最终一致的，因此全局仍可能出现少量重复探测。

KV 读取失败会按缓存未命中处理。KV 写入失败会记录日志，但不会阻止当前重定向。
KV 项不会自动过期，因此由时间戳而不是存储删除控制新鲜度。

## 日志

Workers Logs 已启用，head sampling rate 为 1。Worker 输出结构化 JSON，包含仓库、
请求方法、目标路径、所选上游、缓存状态、原因和响应状态。API、KV 和后台刷新
错误会附带错误类型。

Authorization 和 Cookie 请求头以及请求查询字符串永远不会写入日志。目标路径会
被记录，但查询字符串不会。

## 部署后检查

部署后，Forgejo 中存在的仓库应只产生一次重定向：

```sh
curl -sSI https://actions.example.com/actions/checkout
git ls-remote https://actions.example.com/actions/checkout
```

确认 Worker 日志显示预期的 `upstream` 和 `cacheState`。第一次重定向后的 Git 和
archive 流量会直接发往 Forgejo 或默认源，因此 Worker 无法观察或再次重定向后续
上游错误。
