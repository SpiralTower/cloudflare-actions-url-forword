const DEFAULT_FALLBACK_BASE_URL = 'https://github.com'
const CACHE_KEY_PREFIX = 'repo:v1:'
const FRESH_MS = 24 * 60 * 60 * 1000
const RETRY_MS = 15 * 60 * 1000
const API_TIMEOUT_MS = 3000
const ALLOWED_METHODS = 'GET,HEAD,POST,OPTIONS'
const REDIRECT_STATUSES = {
  GET: 302,
  HEAD: 302,
  POST: 307,
}

export function createWorker({
  fetch = globalThis.fetch,
  now = () => Math.floor(Date.now() / 1000),
  setTimeout = globalThis.setTimeout,
  clearTimeout = globalThis.clearTimeout,
  logger = console,
} = {}) {
  const inFlightRefreshes = new Map()

  async function fetchRepository({
    env,
    forgejoBaseURL,
    owner,
    repo,
    method,
    targetPath,
  }) {
    const key = cacheKey(owner, repo)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
    let outcome = {
      upstream: 'fallback',
      reason: 'api_error',
      errorType: 'Error',
    }

    try {
      const response = await fetch(
        `${forgejoBaseURL}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
          },
          signal: controller.signal,
        },
      )

      if (response.status === 200) {
        const record = {
          upstream: 'forgejo',
          checkedAt: now(),
          freshUntil: now() + FRESH_MS / 1000,
          retryAt: 0,
        }
        await persist(env, key, record, {
          logger,
          repo: `${owner}/${repo}`,
          method,
          targetPath,
        })
        outcome = { upstream: 'forgejo', reason: 'api_ok' }
        return outcome
      }

      if ([401, 403, 404].includes(response.status)) {
        const record = {
          upstream: 'fallback',
          checkedAt: now(),
          freshUntil: now() + FRESH_MS / 1000,
          retryAt: 0,
        }
        await persist(env, key, record, {
          logger,
          repo: `${owner}/${repo}`,
          method,
          targetPath,
        })
        outcome = { upstream: 'fallback', reason: `api_${response.status}` }
        return outcome
      }

      throw new APIError(`http_${response.status}`)
    } catch (error) {
      const record = {
        upstream: 'fallback',
        checkedAt: now(),
        freshUntil: now() + RETRY_MS / 1000,
        retryAt: now() + RETRY_MS / 1000,
      }
      await persist(env, key, record, {
        logger,
        repo: `${owner}/${repo}`,
        method,
        targetPath,
      })
      if (error instanceof APIError) {
        outcome = {
          upstream: 'fallback',
          reason: 'api_error',
          errorType: error.message,
        }
      } else if (error.name === 'AbortError') {
        outcome = {
          upstream: 'fallback',
          reason: 'api_timeout',
          errorType: 'AbortError',
        }
      } else {
        outcome = {
          upstream: 'fallback',
          reason: 'api_error',
          errorType: error.name ?? 'Error',
        }
      }
      return outcome
    } finally {
      clearTimeout(timeout)
    }
  }

  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url)
      const targetPath = requestTargetPath(url.pathname)
      const repo = parseRepositoryPath(targetPath)
      const method = request.method.toUpperCase()

      if (method === 'OPTIONS') {
        return responseWithCORS(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Methods': ALLOWED_METHODS,
          },
        })
      }

      if (!(method in REDIRECT_STATUSES)) {
        return jsonError(405, 'method_not_allowed')
      }
      if (!repo) {
        return jsonError(url.pathname === '/' ? 404 : 400, 'invalid_repository')
      }
      if (request.headers.has('authorization')) {
        return jsonError(401, 'authentication_not_supported')
      }

      let forgejoBaseURL
      let fallbackBaseURL
      try {
        forgejoBaseURL = validateBaseURL(
          env.FORGEJO_BASE_URL,
          'FORGEJO_BASE_URL',
        )
        fallbackBaseURL = validateBaseURL(
          env.FALLBACK_BASE_URL ?? DEFAULT_FALLBACK_BASE_URL,
          'FALLBACK_BASE_URL',
        )
      } catch (error) {
        logger.error(
          JSON.stringify({
            event: 'actions_configuration_invalid',
            method,
            targetPath,
            errorType: error.name ?? 'Error',
          }),
        )
        return jsonError(500, 'worker_configuration_invalid')
      }
      const key = cacheKey(repo.owner, repo.repo)
      const cached = await readCache(env.ACTIONS_CACHE, key, {
        logger,
        repo: `${repo.owner}/${repo.repo}`,
        method,
        targetPath,
      })
      let upstream
      let cacheState
      let reason
      let errorType

      if (cached) {
        upstream = cached.upstream
        cacheState = cached.freshUntil > now() ? 'fresh' : 'stale'
        if (cacheState === 'stale' && cached.retryAt <= now()) {
          scheduleRefresh({
            env,
            key,
            repo,
            cached,
            method,
            targetPath,
            ctx,
            forgejoBaseURL,
          })
        }
      } else {
        cacheState = 'miss'
        const discovery = await fetchRepository({
          env,
          forgejoBaseURL,
          owner: repo.owner,
          repo: repo.repo,
          method,
          targetPath,
        })
        upstream = discovery.upstream
        reason = discovery.reason
        errorType = discovery.errorType
      }

      const baseURL = upstream === 'forgejo' ? forgejoBaseURL : fallbackBaseURL
      const location = `${baseURL}${redirectPath(url.pathname, repo)}${url.search}`
      const logReason =
        reason ?? (cacheState === 'fresh' ? 'cache_fresh' : cacheState)
      logRequest(logger, {
        repo: `${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}`,
        method,
        targetPath,
        upstream,
        cacheState,
        reason: logReason,
        status: REDIRECT_STATUSES[method],
        errorType,
      })
      return responseWithCORS(null, {
        status: REDIRECT_STATUSES[method],
        headers: {
          Location: location,
        },
      })
    },
  }

  function scheduleRefresh({
    env,
    key,
    repo,
    cached,
    method,
    targetPath,
    ctx,
    forgejoBaseURL,
  }) {
    if (inFlightRefreshes.has(key)) {
      return
    }

    const refresh = refreshRepository({
      env,
      key,
      repo,
      cached,
      method,
      targetPath,
      forgejoBaseURL,
    }).finally(() => {
      inFlightRefreshes.delete(key)
    })
    inFlightRefreshes.set(key, refresh)
    ctx?.waitUntil(refresh)
  }

  async function refreshRepository({
    env,
    key,
    repo,
    cached,
    method,
    targetPath,
    forgejoBaseURL,
  }) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS)
    let errorType
    const logContext = {
      logger,
      repo: `${repo.owner}/${repo.repo}`,
      method,
      targetPath,
    }

    try {
      const response = await fetch(
        `${forgejoBaseURL}/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
          },
          signal: controller.signal,
        },
      )

      if (response.status === 200) {
        await persist(
          env,
          key,
          {
            upstream: 'forgejo',
            checkedAt: now(),
            freshUntil: now() + FRESH_MS / 1000,
            retryAt: 0,
          },
          logContext,
        )
        return
      }
      if ([401, 403, 404].includes(response.status)) {
        await persist(
          env,
          key,
          {
            upstream: 'fallback',
            checkedAt: now(),
            freshUntil: now() + FRESH_MS / 1000,
            retryAt: 0,
          },
          logContext,
        )
        return
      }
      errorType = `http_${response.status}`
    } catch (error) {
      errorType = error.name === 'AbortError' ? 'abort' : error.name
    } finally {
      clearTimeout(timeout)
    }

    await persist(
      env,
      key,
      {
        ...cached,
        retryAt: now() + RETRY_MS / 1000,
      },
      logContext,
    )
    logger.error(
      JSON.stringify({
        event: 'actions_refresh_failed',
        repo: `${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}`,
        method,
        targetPath,
        upstream: cached.upstream,
        cacheState: 'stale',
        reason: 'refresh_failed',
        errorType: errorType ?? 'Error',
      }),
    )
  }
}

class APIError extends Error {}

function cacheKey(owner, repo) {
  return `${CACHE_KEY_PREFIX}${owner.toLowerCase()}/${repo.toLowerCase()}`
}

function requestTargetPath(pathname) {
  try {
    return pathname
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/')
  } catch {
    return null
  }
}

function redirectPath(pathname, repo) {
  const secondSlash = pathname.indexOf('/', 1)
  const thirdSlash = pathname.indexOf('/', secondSlash + 1)
  const repoEnd = thirdSlash === -1 ? pathname.length : thirdSlash
  const repoPath = pathname.slice(0, repoEnd)
  return repoPath.replace(/(?:@|%40)[^/]*$/i, '') + pathname.slice(repoEnd)
}

function parseRepositoryPath(targetPath) {
  if (!targetPath) {
    return null
  }

  const segments = targetPath.split('/')
  if (segments.length < 3 || segments[0] !== '') {
    return null
  }

  const owner = segments[1]
  let repo = segments[2]
  if (!owner || !repo || owner === '.' || owner === '..' || repo === '.') {
    return null
  }

  const at = repo.lastIndexOf('@')
  if (at >= 0) {
    repo = repo.slice(0, at)
  }
  if (repo.endsWith('.git')) {
    repo = repo.slice(0, -4)
  }

  if (
    !/^[A-Za-z0-9_.-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(repo) ||
    repo === '.' ||
    repo === '..'
  ) {
    return null
  }

  return { owner, repo }
}

function validateBaseURL(value, name) {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`${name} must be a root HTTP(S) URL`)
  }
  const url = new URL(value)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    value.endsWith('/')
  ) {
    throw new Error(`${name} must be a root HTTP(S) URL without a trailing /`)
  }
  return value
}

async function readCache(cache, key, context) {
  try {
    return await cache.get(key, 'json')
  } catch (error) {
    context.logger.error(
      JSON.stringify({
        event: 'actions_cache_read_failed',
        repo: context.repo.toLowerCase(),
        method: context.method,
        targetPath: context.targetPath,
        errorType: error.name ?? 'Error',
      }),
    )
    return null
  }
}

async function persist(env, key, record, context) {
  try {
    await env.ACTIONS_CACHE.put(key, JSON.stringify(record))
    return null
  } catch (error) {
    const errorType = error.name ?? 'Error'
    context.logger.error(
      JSON.stringify({
        event: 'actions_cache_write_failed',
        repo: context.repo.toLowerCase(),
        method: context.method,
        targetPath: context.targetPath,
        errorType,
      }),
    )
    return errorType
  }
}

function responseWithCORS(body, init = {}) {
  const headers = new Headers(init.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Access-Control-Expose-Headers', 'Location')
  headers.set('Cache-Control', 'no-store')
  return new Response(body, { ...init, headers })
}

function jsonError(status, error) {
  return responseWithCORS(JSON.stringify({ error }), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  })
}

function logRequest(logger, fields) {
  const sanitized = {
    event: 'actions_redirect',
    repo: fields.repo,
    method: fields.method,
    targetPath: fields.targetPath,
    upstream: fields.upstream,
    cacheState: fields.cacheState,
    reason: fields.reason,
    status: fields.status,
  }
  if (fields.errorType) {
    sanitized.errorType = fields.errorType
  }
  logger.log(JSON.stringify(sanitized))
}

const defaultWorker = createWorker()

export default defaultWorker
