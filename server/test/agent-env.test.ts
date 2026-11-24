// agent-env.ts — the one builder of an agent process's env.
import { describe, it, expect, vi } from 'vitest'
import { agentProcessEnv, silosApiUrl } from '../src/agent-env.js'
import { cleanEnv } from '../src/env.js'

describe('agentProcessEnv', () => {
  const agent = { id: 'a1' }

  it('Vault, then agent state, then SILOS_API — a secret can override neither', () => {
    const env = agentProcessEnv(
      {
        vault: { envFor: () => ({ TOKEN_X: 'v', SILOS_AGENT_ID: 'forged', SILOS_API: 'http://evil.example' }) },
        agentState: { envFor: (id) => ({ SILOS_AGENT_ID: id, SILOS_AGENT_STATE: '/s/' + id }) },
        silosApi: 'http://127.0.0.1:4100',
      },
      agent,
      '/p',
    )
    expect(env).toEqual({ TOKEN_X: 'v', SILOS_AGENT_ID: 'a1', SILOS_AGENT_STATE: '/s/a1', SILOS_API: 'http://127.0.0.1:4100' })
  })

  it('SILOS_SESSION_ID only with a key', () => {
    expect(agentProcessEnv({ silosApi: 'http://h:1' }, agent, null)).toEqual({ SILOS_API: 'http://h:1' })
    expect(agentProcessEnv({ silosApi: 'http://h:1' }, agent, null, 'k1')).toEqual({ SILOS_API: 'http://h:1', SILOS_SESSION_ID: 'k1' })
  })

  it('a state store that refuses the id costs the state channel, never the launch', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const env = agentProcessEnv(
        {
          agentState: {
            envFor: () => {
              throw new Error('unsafe id')
            },
          },
          silosApi: 'http://h:1',
        },
        agent,
        '/p',
      )
      expect(env).toEqual({ SILOS_API: 'http://h:1' })
    } finally {
      warn.mockRestore()
    }
  })

  it('no address given: the configured one (SILOS_PORT)', () => {
    const prev = process.env.SILOS_PORT
    process.env.SILOS_PORT = '3299'
    try {
      expect(agentProcessEnv({}, agent, null).SILOS_API).toBe('http://127.0.0.1:3299')
    } finally {
      if (prev === undefined) delete process.env.SILOS_PORT
      else process.env.SILOS_PORT = prev
    }
  })
})

describe('silosApiUrl', () => {
  it('a wildcard bind is reached on loopback; IPv6 in brackets', () => {
    expect(silosApiUrl('127.0.0.1', 3210)).toBe('http://127.0.0.1:3210')
    expect(silosApiUrl('0.0.0.0', 8080)).toBe('http://127.0.0.1:8080')
    expect(silosApiUrl('::', 8080)).toBe('http://127.0.0.1:8080')
    expect(silosApiUrl('::1', 3210)).toBe('http://[::1]:3210')
  })
})

describe('SILOS_API is never inherited', () => {
  it('cleanEnv drops it', () => {
    const prev = process.env.SILOS_API
    process.env.SILOS_API = 'http://127.0.0.1:3210'
    try {
      expect(cleanEnv().SILOS_API).toBeUndefined()
    } finally {
      if (prev === undefined) delete process.env.SILOS_API
      else process.env.SILOS_API = prev
    }
  })
})
