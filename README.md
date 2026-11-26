# cloudflare-actions-url-forword

[English](README.md) | [简体中文](README.zh-CN.md)

Cloudflare Worker implementation of a Forgejo `DEFAULT_ACTIONS_URL` redirect
endpoint. It sends anonymous Actions and Git requests to the matching public
repository on your Forgejo instance when that repository exists, and otherwise
to GitHub (or another fallback base URL).

## How it works

For a request such as:

```text
https://actions.example.com/actions/checkout@v4
```

the Worker performs one source lookup:

1. Read `repo:v1:{owner}/{repo}` from KV.
2. On a cache miss, request
   `{FORGEJO_BASE_URL}/api/v1/repos/{owner}/{repo}` anonymously.
3. Redirect to the Forgejo repository when the API returns `200`.
4. Otherwise redirect to the fallback source.

The `@v4` convenience suffix is used only for cache lookup. It is removed from
the redirect, so the example above goes to:

```text
https://forgejo.example.com/actions/checkout
```

Repository subpaths and query strings are preserved:

```text
/actions/checkout/archive/main.zip
/actions/checkout/info/refs?service=git-upload-pack
/actions/checkout/git-upload-pack
```

A `.git` suffix is removed only when looking up the repository key. The
redirect target still contains the original `.git` path.

`GET` and `HEAD` redirect with `302`. `POST` redirects with `307`, which
preserves the method and body without reading or caching the body. `OPTIONS`
returns `204`, and other methods return `405`.

## Requirements

- Node.js 22 or newer
- A Cloudflare account with Wrangler authentication
- A public Forgejo instance whose REST API allows anonymous access
- A Forgejo version that supports a custom `DEFAULT_ACTIONS_URL`

Some Gitea versions reject custom Actions URLs. The one-redirect design also
requires the Git client to follow the initial redirect; requests after that
redirect go directly to the selected upstream rather than returning to the
Worker.

## One-click deployment to Cloudflare

[Deploy to Cloudflare](https://deploy.workers.cloudflare.com/?url=https://github.com/SpiralTower/cloudflare-actions-url-forword)

## Configure Cloudflare

Install dependencies and authenticate Wrangler:

```sh
npm install
npx wrangler login
```

For manual deployment, create the production KV namespace:

```sh
npx wrangler kv namespace create ACTIONS_CACHE
```

Copy the returned namespace ID into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "ACTIONS_CACHE"
id = "your-kv-namespace-id"
```

Alternatively, keep the `ACTIONS_CACHE` binding without an `id` and let
`wrangler deploy` provision the namespace. For repository-based Deploy to
Cloudflare builds, the generated resource ID may be visible in the dashboard
instead of being written back to the repository.

Store the Forgejo root URL as an encrypted secret. It must use `http://` or
`https://`, must be a root URL, and must not have a path, query, fragment, or
trailing slash:

```sh
npx wrangler secret put FORGEJO_BASE_URL
# Enter: https://forgejo.example.com
```

The default fallback is `https://github.com`. To change it, edit the ordinary
variable in `wrangler.toml`:

```toml
[vars]
FALLBACK_BASE_URL = "https://github.com"
```

Validate and deploy:

```sh
npm test
npm run format:check
npm run check:worker
npx wrangler deploy
```

Attach a Custom Domain under **Cloudflare Dashboard → Workers & Pages →
cloudflare-actions-url-forword → Settings → Domains & Routes**. Use the
resulting HTTPS origin as the Forgejo value. Do not add a trailing slash.

## Configure Forgejo

Set `DEFAULT_ACTIONS_URL` to the Worker origin in Forgejo's `app.ini`:

```ini
[actions]
DEFAULT_ACTIONS_URL = https://actions.example.com
```

Restart Forgejo after changing `app.ini`. Repositories and their APIs must be
publicly readable because this Worker intentionally rejects requests carrying
`Authorization`.

## Cache behavior

The cache key is lowercase and uses the form:

```text
repo:v1:{owner}/{repo}
```

Each value records the selected source and timestamps:

```json
{
  "upstream": "forgejo",
  "checkedAt": 1795620000,
  "freshUntil": 1795706400,
  "retryAt": 0
}
```

A successful discovery is fresh for one day. A missing, unauthorized, or
forbidden repository is also cached for one day, allowing the Worker to avoid
repeated API requests for GitHub-only repositories.

An expired record is served immediately while a background refresh runs through
`ctx.waitUntil()`. A failed refresh keeps the existing source and suppresses
another attempt for 15 minutes. Initial API rate limits, server errors, network
errors, and three-second timeouts fall back to the configured fallback source
temporarily and retry after 15 minutes.

Concurrent refreshes for one repository are merged inside a Worker isolate.
KV is eventually consistent across Cloudflare locations, so a few duplicate
probes can still occur globally.

KV read failures are treated as cache misses. KV write failures are logged but
do not block the current redirect. KV entries have no automatic expiration, so
the timestamps, rather than storage deletion, control freshness.

## Logging

Workers Logs are enabled with a head sampling rate of 1. The Worker emits
structured JSON containing the repository, request method, target path,
selected upstream, cache state, reason, and response status. API, KV, and
background refresh errors include an error type.

Authorization and Cookie headers and request query strings are never logged.
The target path is logged, but the query string is not.

## Operational checks

After deployment, a repository that exists on Forgejo should respond with one
redirect:

```sh
curl -sSI https://actions.example.com/actions/checkout
git ls-remote https://actions.example.com/actions/checkout
```

Confirm the Worker log shows the expected `upstream` and `cacheState`. Git and
archive traffic after the first redirect goes directly to Forgejo or the
fallback source, so the Worker cannot observe or redirect later upstream
errors.
