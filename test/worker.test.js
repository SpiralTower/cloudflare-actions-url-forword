import { describe, expect, it, vi } from 'vitest'

import worker, { createWorker } from '../index.js'
import { BASE_ENV, FORGEJO_BASE_URL, createContext } from './fixtures.js'

const NOW = 1_795_620_000

describe('Actions URL redirect Worker', () => {
  it('redirects an action reference to the matching Forgejo repository', async () => {
    const writes = []
    const env = {
      ...BASE_ENV,
      ACTIONS_CACHE: {
        async get() {
          return null
        },
        async put(key, value) {
          writes.push({ key, value })
        },
      },
    }
    const requests = []
    const handler = createWorker({
      fetch: async (url) => {
        requests.push(url)
        return new Response('{}', { status: 200 })
      },
    })

    const response = await handler.fetch(
      new Request('https://worker.example.com/actions/checkout@v4'),
      env,
      createContext(),
    )

    expect(worker.fetch).toBeTypeOf('function')
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      `${FORGEJO_BASE_URL}/actions/checkout`,
    )
    expect(requests).toEqual([
      `${FORGEJO_BASE_URL}/api/v1/repos/actions/checkout`,
    ])
    expect(writes).toEqual([
      {
        key: 'repo:v1:actions/checkout',
        value: expect.stringContaining('"upstream":"forgejo"'),
      },
    ])
  })

  it('falls back to GitHub and caches a missing Forgejo repository', async () => {
    const writes = []
    const env = cacheEnv(writes)
    const handler = createWorker({
      fetch: async () => new Response(null, { status: 404 }),
      now: () => 1_795_620_000,
    })

    const response = await handler.fetch(
      new Request('https://worker.example.com/actions/checkout'),
      env,
      createContext(),
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      'https://github.com/actions/checkout',
    )
    expect(JSON.parse(writes[0].value)).toEqual({
      upstream: 'fallback',
      checkedAt: 1_795_620_000,
      freshUntil: 1_795_706_400,
      retryAt: 0,
    })
  })

  it('discovers repo.git through the repository without the suffix', async () => {
    const writes = []
    const requests = []
    const handler = createWorker({
      fetch: async (url) => {
        requests.push(url)
        return new Response(null, { status: 200 })
      },
      now: () => NOW,
    })

    const response = await handler.fetch(
      new Request(
        'https://worker.example.com/actions/repo.git/info/refs?service=git-upload-pack',
      ),
      cacheEnv(writes),
      createContext(),
    )

    expect(response.headers.get('location')).toBe(
      `${FORGEJO_BASE_URL}/actions/repo.git/info/refs?service=git-upload-pack`,
    )
    expect(requests).toEqual([`${FORGEJO_BASE_URL}/api/v1/repos/actions/repo`])
    expect(writes[0].key).toBe('repo:v1:actions/repo')
  })

  it('accepts percent-encoded owner and repository names', async () => {
    const requests = []
    const handler = createWorker({
      fetch: async (url) => {
        requests.push(url)
        return new Response(null, { status: 200 })
      },
      now: () => NOW,
    })

    const response = await handler.fetch(
      new Request('https://worker.example.com/%61ctions/check%6Fut@v4'),
      cacheEnv([]),
      createContext(),
    )

    expect(requests).toEqual([
      `${FORGEJO_BASE_URL}/api/v1/repos/actions/checkout`,
    ])
    expect(response.headers.get('location')).toBe(
      `${FORGEJO_BASE_URL}/%61ctions/check%6Fut`,
    )
  })

  it('falls back temporarily when the Forgejo API is unavailable', async () => {
    const writes = []
    const env = cacheEnv(writes)
    const handler = createWorker({
      fetch: async () => new Response(null, { status: 503 }),
      now: () => 1_795_620_000,
    })

    const response = await handler.fetch(
      new Request('https://worker.example.com/actions/checkout'),
      env,
      createContext(),
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      'https://github.com/actions/checkout',
    )
    expect(JSON.parse(writes[0].value)).toEqual({
      upstream: 'fallback',
      checkedAt: 1_795_620_000,
      freshUntil: 1_795_620_900,
      retryAt: 1_795_620_900,
    })
  })

  it('uses a fresh cached source without contacting Forgejo', async () => {
    let requests = 0
    const handler = createWorker({
      fetch: async () => {
        requests += 1
        return new Response()
      },
      now: () => NOW,
    })
    const env = cacheEnv([], {
      upstream: 'forgejo',
      checkedAt: NOW - 10,
      freshUntil: NOW + 100,
      retryAt: 0,
    })

    const response = await handler.fetch(
      new Request(
        'https://worker.example.com/actions/checkout/info/refs?service=git-upload-pack',
      ),
      env,
      createContext(),
    )

    expect(response.headers.get('location')).toBe(
      `${FORGEJO_BASE_URL}/actions/checkout/info/refs?service=git-upload-pack`,
    )
    expect(requests).toBe(0)
  })

  it('serves stale data immediately and refreshes it in the background once', async () => {
    const writes = []
    const context = createContext()
    let release
    const fetchGate = new Promise((resolve) => {
      release = resolve
    })
    let requests = 0
    const handler = createWorker({
      fetch: async () => {
        requests += 1
        await fetchGate
        return new Response(null, { status: 200 })
      },
      now: () => NOW,
    })
    const env = cacheEnv(writes, {
      upstream: 'forgejo',
      checkedAt: NOW - 86_410,
      freshUntil: NOW - 10,
      retryAt: 0,
    })

    const first = await handler.fetch(
      new Request('https://worker.example.com/actions/checkout'),
      env,
      context,
    )
    const second = await handler.fetch(
      new Request('https://worker.example.com/actions/checkout'),
      env,
      context,
    )

    expect(first.headers.get('location')).toBe(
      `${FORGEJO_BASE_URL}/actions/checkout`,
    )
    expect(second.headers.get('location')).toBe(
      `${FORGEJO_BASE_URL}/actions/checkout`,
    )
    expect(requests).toBe(1)
    expect(context.pending).toHaveLength(1)

    release()
    await context.pending[0]

    expect(JSON.parse(writes[0].value)).toEqual({
      upstream: 'forgejo',
      checkedAt: NOW,
      freshUntil: NOW + 86_400,
      retryAt: 0,
    })
  })

  it('keeps the stale source and sets cooldown after a failed refresh', async () => {
    const writes = []
    const context = createContext()
    const handler = createWorker({
      fetch: async () => new Response(null, { status: 500 }),
      now: () => NOW,
    })
    const env = cacheEnv(writes, {
      upstream: 'forgejo',
      checkedAt: NOW - 86_410,
      freshUntil: NOW - 10,
      retryAt: 0,
    })

    const response = await handler.fetch(
      new Request(
        'https://worker.example.com/actions/checkout/archive/main.zip',
      ),
      env,
      context,
    )
    await Promise.all(context.pending)

    expect(response.headers.get('location')).toBe(
      `${FORGEJO_BASE_URL}/actions/checkout/archive/main.zip`,
    )
    expect(JSON.parse(writes[0].value)).toEqual({
      upstream: 'forgejo',
      checkedAt: NOW - 86_410,
      freshUntil: NOW - 10,
      retryAt: NOW + 900,
    })
  })

  it('logs a background refresh KV write failure', async () => {
    const errors = []
    const context = createContext()
    const handler = createWorker({
      fetch: async () => new Response(null, { status: 200 }),
      now: () => NOW,
      logger: {
        log() {},
        error(value) {
          errors.push(JSON.parse(value))
        },
      },
    })
    const env = {
      ...BASE_ENV,
      ACTIONS_CACHE: {
        async get() {
          return {
            upstream: 'forgejo',
            checkedAt: NOW - 86_410,
            freshUntil: NOW - 10,
            retryAt: 0,
          }
        },
        async put() {
          throw new Error('KV write failed')
        },
      },
    }

    const response = await handler.fetch(
      new Request('https://worker.example.com/actions/checkout'),
      env,
      context,
    )
    await Promise.all(context.pending)

    expect(response.status).toBe(302)
    expect(errors).toEqual([
      expect.objectContaining({
        event: 'actions_cache_write_failed',
        repo: 'actions/checkout',
        errorType: 'Error',
      }),
    ])
  })

  it('switches a stale source after a successful refresh', async () => {
    const writes = []
    const context = createContext()
    const handler = createWorker({
      fetch: async () => new Response(null, { status: 404 }),
      now: () => NOW,
    })
    const env = cacheEnv(writes, {
      upstream: 'forgejo',
      checkedAt: NOW - 86_410,
      freshUntil: NOW - 10,
      retryAt: 0,
    })

    const response = await handler.fetch(
      new Request('https://worker.example.com/actions/checkout'),
      env,
      context,
    )
    await Promise.all(context.pending)

    expect(response.headers.get('location')).toBe(
      `${FORGEJO_BASE_URL}/actions/checkout`,
    )
    expect(JSON.parse(writes[0].value)).toEqual({
      upstream: 'fallback',
      checkedAt: NOW,
      freshUntil: NOW + 86_400,
      retryAt: 0,
    })
  })

  it.each([
    [
      '/actions/checkout/archive/main.zip',
      '/actions/checkout/archive/main.zip',
    ],
    [
      '/actions/checkout/info/refs?service=git-upload-pack&x=1',
      '/actions/checkout/info/refs?service=git-upload-pack&x=1',
    ],
    [
      '/actions/checkout/git-upload-pack?service=git-upload-pack',
      '/actions/checkout/git-upload-pack?service=git-upload-pack',
    ],
    ['/actions/checkout@v4', '/actions/checkout'],
    ['/actions/repo.git', '/actions/repo.git'],
    ['/actions/repo.git/info/refs?x=1', '/actions/repo.git/info/refs?x=1'],
    [
      '/actions/checkout/archive/feature%2Fone.zip?download=1',
      '/actions/checkout/archive/feature%2Fone.zip?download=1',
    ],
  ])('preserves %s in the redirect target', async (path, expectedPath) => {
    const handler = createWorker({
      fetch: async () => new Response(),
      now: () => NOW,
    })
    const env = cacheEnv([], {
      upstream: 'forgejo',
      checkedAt: NOW,
      freshUntil: NOW + 100,
      retryAt: 0,
    })

    const response = await handler.fetch(
      new Request(`https://worker.example.com${path}`),
      env,
      createContext(),
    )

    expect(response.headers.get('location')).toBe(
      `${FORGEJO_BASE_URL}${expectedPath}`,
    )
  })

  it.each([
    ['GET', 302],
    ['HEAD', 302],
    ['POST', 307],
  ])(
    'returns %s with status %s without reading a body',
    async (method, status) => {
      const request = new Request(
        'https://worker.example.com/actions/checkout',
        {
          method,
          body: method === 'POST' ? 'request body' : undefined,
        },
      )
      const handler = createWorker({
        fetch: async () => new Response(),
        now: () => NOW,
      })

      const response = await handler.fetch(
        request,
        cacheEnv([], {
          upstream: 'fallback',
          checkedAt: NOW,
          freshUntil: NOW + 100,
          retryAt: 0,
        }),
        createContext(),
      )

      expect(response.status).toBe(status)
      expect(request.bodyUsed).toBe(false)
    },
  )

  it('answers CORS preflight with 204', async () => {
    const response = await worker.fetch(
      new Request('https://worker.example.com/actions/checkout', {
        method: 'OPTIONS',
      }),
      BASE_ENV,
      createContext(),
    )

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-methods')).toBe(
      'GET,HEAD,POST,OPTIONS',
    )
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('rejects unsupported methods with JSON', async () => {
    const response = await worker.fetch(
      new Request('https://worker.example.com/actions/checkout', {
        method: 'PUT',
      }),
      BASE_ENV,
      createContext(),
    )

    expect(response.status).toBe(405)
    expect(response.headers.get('content-type')).toBe('application/json')
  })

  it('rejects authentication without reading the cache or contacting Forgejo', async () => {
    let cacheReads = 0
    let apiRequests = 0
    const handler = createWorker({
      fetch: async () => {
        apiRequests += 1
        return new Response()
      },
    })
    const env = {
      ...BASE_ENV,
      ACTIONS_CACHE: {
        async get() {
          cacheReads += 1
          return null
        },
        async put() {},
      },
    }

    const response = await handler.fetch(
      new Request('https://worker.example.com/actions/checkout', {
        headers: { Authorization: 'Bearer secret-token' },
      }),
      env,
      createContext(),
    )

    expect(response.status).toBe(401)
    expect(cacheReads).toBe(0)
    expect(apiRequests).toBe(0)
  })

  it.each([
    ['/', 404],
    ['/actions', 400],
    ['/actions/', 400],
    ['/actions/%2E%2E%2Fcheckout', 400],
    ['/actions/%2F/checkout', 400],
    ['/actions/%E0%A4%A/checkout', 400],
    ['/actions/a%20b/checkout', 400],
  ])('rejects invalid repository path %s with %s', async (path, status) => {
    const response = await worker.fetch(
      new Request(`https://worker.example.com${path}`),
      BASE_ENV,
      createContext(),
    )

    expect(response.status).toBe(status)
    expect(response.headers.get('content-type')).toBe('application/json')
  })

  it('uses a custom fallback source', async () => {
    const handler = createWorker({
      fetch: async () => new Response(null, { status: 404 }),
      now: () => NOW,
    })
    const env = {
      ...cacheEnv([]),
      FALLBACK_BASE_URL: 'https://mirror.example.com',
    }

    const response = await handler.fetch(
      new Request('https://worker.example.com/actions/checkout@v4'),
      env,
      createContext(),
    )

    expect(response.headers.get('location')).toBe(
      'https://mirror.example.com/actions/checkout',
    )
  })

  it('continues discovery when KV read fails', async () => {
    const errors = []
    let apiRequests = 0
    const handler = createWorker({
      fetch: async () => {
        apiRequests += 1
        return new Response(null, { status: 200 })
      },
      now: () => NOW,
      logger: {
        log() {},
        error(value) {
          errors.push(JSON.parse(value))
        },
      },
    })
    const env = {
      ...BASE_ENV,
      ACTIONS_CACHE: {
        async get() {
          throw new Error('KV read failed')
        },
        async put() {},
      },
    }

    const response = await handler.fetch(
      new Request('https://worker.example.com/actions/checkout'),
      env,
      createContext(),
    )

    expect(response.headers.get('location')).toBe(
      `${FORGEJO_BASE_URL}/actions/checkout`,
    )
    expect(apiRequests).toBe(1)
    expect(errors).toEqual([
      expect.objectContaining({
        event: 'actions_cache_read_failed',
        repo: 'actions/checkout',
        errorType: 'Error',
      }),
    ])
  })

  it('continues redirecting when KV write fails', async () => {
    const errors = []
    const handler = createWorker({
      fetch: async () => new Response(null, { status: 200 }),
      now: () => NOW,
      logger: {
        log() {},
        error(value) {
          errors.push(JSON.parse(value))
        },
      },
    })
    const env = {
      ...BASE_ENV,
      ACTIONS_CACHE: {
        async get() {
          return null
        },
        async put() {
          throw new Error('KV write failed')
        },
      },
    }

    const response = await handler.fetch(
      new Request('https://worker.example.com/actions/checkout'),
      env,
      createContext(),
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      `${FORGEJO_BASE_URL}/actions/checkout`,
    )
    expect(errors).toEqual([
      expect.objectContaining({
        event: 'actions_cache_write_failed',
        repo: 'actions/checkout',
        errorType: 'Error',
      }),
    ])
  })

  it.each([
    ['missing Forgejo URL', {}],
    ['Forgejo URL with path', { FORGEJO_BASE_URL: 'https://forgejo.test/git' }],
    [
      'Forgejo URL with trailing slash',
      { FORGEJO_BASE_URL: 'https://forgejo.test/' },
    ],
    ['non-HTTP fallback', { FALLBACK_BASE_URL: 'ftp://github.com' }],
    [
      'fallback URL with query',
      { FALLBACK_BASE_URL: 'https://github.com?x=1' },
    ],
  ])('rejects invalid configuration: %s', async (_, overrides) => {
    const env = {
      ...BASE_ENV,
      ...overrides,
    }
    if (!('FORGEJO_BASE_URL' in overrides)) {
      delete env.FORGEJO_BASE_URL
    }

    const response = await worker.fetch(
      new Request('https://worker.example.com/actions/checkout'),
      env,
      createContext(),
    )

    expect(response.status).toBe(500)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(await response.json()).toEqual({
      error: 'worker_configuration_invalid',
    })
  })

  it('returns CORS and no-store headers on every public response', async () => {
    const redirect = await worker.fetch(
      new Request('https://worker.example.com/actions/checkout'),
      cacheEnv([], {
        upstream: 'fallback',
        checkedAt: NOW,
        freshUntil: NOW + 100,
        retryAt: 0,
      }),
      createContext(),
    )
    const invalid = await worker.fetch(
      new Request('https://worker.example.com/'),
      BASE_ENV,
      createContext(),
    )

    for (const response of [redirect, invalid]) {
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(response.headers.get('access-control-expose-headers')).toBe(
        'Location',
      )
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
  })

  it('falls back after a three-second Forgejo API timeout', async () => {
    const callbacks = []
    const controllerSignals = []
    const logs = []
    const handler = createWorker({
      fetch: async (_url, init) => {
        controllerSignals.push(init.signal)
        return new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        })
      },
      setTimeout: (callback, milliseconds) => {
        callbacks.push({ callback, milliseconds })
        return callbacks.length
      },
      clearTimeout() {},
      now: () => NOW,
      logger: {
        log(value) {
          logs.push(JSON.parse(value))
        },
      },
    })
    const request = handler.fetch(
      new Request(
        'https://worker.example.com/actions/checkout?token=must-not-log',
      ),
      cacheEnv([]),
      createContext(),
    )
    await vi.waitFor(() => {
      expect(callbacks).toHaveLength(1)
    })

    expect(callbacks[0].milliseconds).toBe(3000)
    callbacks[0].callback()

    const response = await request
    expect(controllerSignals[0].aborted).toBe(true)
    expect(response.headers.get('location')).toBe(
      'https://github.com/actions/checkout?token=must-not-log',
    )
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      method: 'GET',
      upstream: 'fallback',
      cacheState: 'miss',
      reason: 'api_timeout',
      errorType: 'AbortError',
    })
    expect(JSON.stringify(logs)).not.toContain('must-not-log')
  })

  it('does not repeat discovery during temporary failure cooldown', async () => {
    let apiRequests = 0
    const handler = createWorker({
      fetch: async () => {
        apiRequests += 1
        return new Response(null, { status: 503 })
      },
      now: () => NOW,
    })
    const writes = []
    const env = cacheEnv(writes)
    const context = createContext()

    await handler.fetch(
      new Request('https://worker.example.com/actions/checkout'),
      env,
      context,
    )
    const cached = JSON.parse(writes[0].value)
    const cooldownEnv = cacheEnv(writes, cached)
    const response = await handler.fetch(
      new Request('https://worker.example.com/actions/checkout'),
      cooldownEnv,
      context,
    )

    expect(response.headers.get('location')).toBe(
      'https://github.com/actions/checkout',
    )
    expect(apiRequests).toBe(1)
    expect(context.pending).toHaveLength(0)
  })

  it('logs structured fields without authentication or query strings', async () => {
    const logs = []
    const handler = createWorker({
      logger: {
        log(value) {
          logs.push(JSON.parse(value))
        },
      },
      now: () => NOW,
    })

    await handler.fetch(
      new Request(
        'https://worker.example.com/actions/checkout/archive/main.zip?token=secret',
        {},
      ),
      cacheEnv([], {
        upstream: 'fallback',
        checkedAt: NOW,
        freshUntil: NOW + 100,
        retryAt: 0,
      }),
      createContext(),
    )

    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      event: 'actions_redirect',
      repo: 'actions/checkout',
      method: 'GET',
      targetPath: '/actions/checkout/archive/main.zip',
      upstream: 'fallback',
      cacheState: 'fresh',
      reason: 'cache_fresh',
      status: 302,
    })
    expect(JSON.stringify(logs)).not.toContain('super-secret')
    expect(JSON.stringify(logs)).not.toContain('token=secret')
  })
})

function cacheEnv(writes, cached = null) {
  return {
    ...BASE_ENV,
    ACTIONS_CACHE: {
      async get() {
        return cached
      },
      async put(key, value) {
        writes.push({ key, value })
      },
    },
  }
}
