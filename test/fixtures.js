export const FORGEJO_BASE_URL = 'https://forgejo.example.com'
export const FALLBACK_BASE_URL = 'https://github.com'

export const BASE_ENV = {
  FORGEJO_BASE_URL,
  FALLBACK_BASE_URL,
  ACTIONS_CACHE: {
    async get() {
      return null
    },
    async put() {},
  },
}

export function createContext() {
  const pending = []

  return {
    pending,
    waitUntil(promise) {
      pending.push(promise)
    },
  }
}
