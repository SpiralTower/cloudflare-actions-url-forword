import { afterEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BASE_ENV, FALLBACK_BASE_URL, FORGEJO_BASE_URL } from './fixtures.js'

const workers = []
const tempDirectories = []
const workerScript = await readFile(
  new URL('../index.js', import.meta.url),
  'utf8',
)

async function createRuntime({ outboundService, kvPersist } = {}) {
  if (!kvPersist) {
    kvPersist = await mkdtemp(join(tmpdir(), 'actions-url-worker-'))
    tempDirectories.push(kvPersist)
  }
  const mf = new Miniflare({
    modules: true,
    script: workerScript,
    scriptName: 'index.js',
    modulesRoot: '.',
    compatibilityDate: '2026-07-30',
    bindings: {
      FORGEJO_BASE_URL: BASE_ENV.FORGEJO_BASE_URL,
      FALLBACK_BASE_URL: BASE_ENV.FALLBACK_BASE_URL,
    },
    kvNamespaces: {
      ACTIONS_CACHE: 'actions-cache',
    },
    kvPersist,
    outboundService,
  })
  workers.push(mf)
  return mf
}

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.dispose()))
  await Promise.all(
    tempDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  )
})

describe('Actions Worker in Miniflare', () => {
  it.each([
    ['HEAD', 302],
    ['POST', 307],
  ])('returns %s %s with an empty body', async (method, status) => {
    const mf = await createRuntime({
      outboundService: async () => new Response(null, { status: 404 }),
    })

    const response = await mf.dispatchFetch(
      'https://worker.example.com/actions/checkout',
      {
        method,
        body: method === 'POST' ? 'action output' : undefined,
        redirect: 'manual',
      },
    )

    expect(response.status).toBe(status)
    expect(response.headers.get('location')).toBe(
      `${FALLBACK_BASE_URL}/actions/checkout`,
    )
    expect(await response.text()).toBe('')
  })

  it('redirects with an upstream request that carries no client credentials', async () => {
    const upstreamRequests = []
    const mf = await createRuntime({
      outboundService: async (request) => {
        upstreamRequests.push(request)
        return new Response('{}', { status: 200 })
      },
    })

    const response = await mf.dispatchFetch(
      'https://worker.example.com/actions/checkout/info/refs?service=git-upload-pack',
      {
        redirect: 'manual',
        headers: {
          Cookie: 'session=must-not-leak',
        },
      },
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      `${FORGEJO_BASE_URL}/actions/checkout/info/refs?service=git-upload-pack`,
    )
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(upstreamRequests).toHaveLength(1)
    expect(upstreamRequests[0].url).toBe(
      `${FORGEJO_BASE_URL}/api/v1/repos/actions/checkout`,
    )
    expect(upstreamRequests[0].headers.get('cookie')).toBeNull()
    expect(upstreamRequests[0].headers.get('authorization')).toBeNull()
  })

  it('persists discovery results in KV and reuses them across runtime restarts', async () => {
    let upstreamRequests = 0
    const outboundService = async () => {
      upstreamRequests += 1
      return new Response(null, { status: 404 })
    }
    const firstPersist = await mkdtemp(join(tmpdir(), 'actions-url-worker-'))
    tempDirectories.push(firstPersist)
    const firstRuntime = await createRuntime({
      outboundService,
      kvPersist: firstPersist,
    })

    await firstRuntime.dispatchFetch(
      'https://worker.example.com/actions/checkout',
      { redirect: 'manual' },
    )
    const cache = await firstRuntime.getKVNamespace('ACTIONS_CACHE')
    expect(await cache.get('repo:v1:actions/checkout', 'json')).toMatchObject({
      upstream: 'fallback',
      retryAt: 0,
    })
    await firstRuntime.dispose()
    workers.splice(workers.indexOf(firstRuntime), 1)

    const secondRuntime = await createRuntime({
      outboundService,
      kvPersist: firstPersist,
    })
    const response = await secondRuntime.dispatchFetch(
      'https://worker.example.com/actions/checkout',
      { redirect: 'manual' },
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(
      `${FALLBACK_BASE_URL}/actions/checkout`,
    )
    expect(upstreamRequests).toBe(1)
  })
})
