import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getToken, api } from '../src/lib/api'

const jsonResponse = (body: unknown, ok = true, status = ok ? 200 : 400): Response =>
  ({
    ok,
    status,
    json: async () => body,
  }) as Response

describe('getToken', () => {
  beforeEach(() => {
    localStorage.clear()
    window.history.pushState({}, '', '/')
  })

  it('extracts ?token= from the URL, stores it in localStorage and clears the query', () => {
    window.history.pushState({}, '', '/?token=abc123')
    const t = getToken()
    expect(t).toBe('abc123')
    expect(localStorage.getItem('silos-token')).toBe('abc123')
    expect(window.location.search).not.toContain('token=')
  })

  it('with no query, reads the token from localStorage', () => {
    localStorage.setItem('silos-token', 'stored-token')
    window.history.pushState({}, '', '/')
    const t = getToken()
    expect(t).toBe('stored-token')
  })

  it('preserves other query params while clearing the token', () => {
    window.history.pushState({}, '', '/?foo=bar&token=xyz')
    getToken()
    expect(window.location.search).toContain('foo=bar')
    expect(window.location.search).not.toContain('token=')
  })
})

describe('api', () => {
  beforeEach(() => {
    localStorage.clear()
    window.history.pushState({}, '', '/')
    localStorage.setItem('silos-token', 'my-token')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('overview() does a GET with the x-token header and returns the body', async () => {
    const overview = { agents: [], now: 123, warming: false }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(overview))
    vi.stubGlobal('fetch', fetchMock)

    const result = await api.overview()

    expect(result).toEqual(overview)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/overview')
    const headers = new Headers(init.headers)
    expect(headers.get('x-token')).toBe('my-token')
  })

  it("throws an Error with the body's message when the response is not ok", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: 'invalid token' }, false, 401))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.overview()).rejects.toThrow('invalid token')
  })

  it('throws a generic HTTP <status> Error when the body has no error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, false, 500))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.overview()).rejects.toThrow('HTTP 500')
  })

  it('sessionDetail() includes since in the querystring when passed', async () => {
    const detail = { meta: {}, turns: [], total: 0 }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(detail))
    vi.stubGlobal('fetch', fetchMock)

    await api.sessionDetail('folderA', 'id1', 5)

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe('/api/sessions/folderA/id1?since=5')
  })

  it('sessionDetail() without since omits it', async () => {
    const detail = { meta: {}, turns: [], total: 0 }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(detail))
    vi.stubGlobal('fetch', fetchMock)

    await api.sessionDetail('folderA', 'id1')

    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe('/api/sessions/folderA/id1')
  })

  it('chat() does a POST with a JSON body and returns turnId', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ turnId: 't1' }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await api.chat('agent1', 'hi', { folder: 'f', id: 'i' })

    expect(result).toEqual({ turnId: 't1' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/agents/agent1/chat')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ text: 'hi', session: { folder: 'f', id: 'i' } })
  })

  it('chat() with a title (naming a new conversation at birth) includes it in the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ turnId: 't1' }))
    vi.stubGlobal('fetch', fetchMock)

    await api.chat('agent1', 'hi', undefined, undefined, undefined, 'My research')

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ text: 'hi', title: 'My research' })
  })

  it('cancel() does a POST and returns ok', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await api.cancel('turn1')

    expect(result).toEqual({ ok: true })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/chat/turn1/cancel')
    expect(init.method).toBe('POST')
  })

  it('chatAlive() does a GET and returns alive', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ alive: true }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await api.chatAlive('turn1')

    expect(result).toEqual({ alive: true })
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe('/api/chat/turn1/alive')
  })

  it('exec() does a POST with command and returns ExecResult', async () => {
    const execResult = { stdout: 'ok', stderr: '', code: 0, ms: 5, truncated: false }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(execResult))
    vi.stubGlobal('fetch', fetchMock)

    const result = await api.exec('agent1', 'ls')

    expect(result).toEqual(execResult)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/agents/agent1/exec')
    expect(JSON.parse(init.body as string)).toEqual({ command: 'ls' })
  })

  it('rename() does a POST to the rename endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, title: 'new' }))
    vi.stubGlobal('fetch', fetchMock)

    await api.rename('folderA', 'id1', 'new')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/sessions/folderA/id1/rename')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ title: 'new' })
  })

  it('trash() does a POST to the trash endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, dest: '/trash/x' }))
    vi.stubGlobal('fetch', fetchMock)

    await api.trash('folderA', 'id1')

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/sessions/folderA/id1/trash')
    expect(init.method).toBe('POST')
    expect(init.body).toBeUndefined() // one session: Maintenance's per-row burial
  })

  it('trash(…, { thread: true }) sends the flag so the server buries the whole thread', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, dest: '/trash/x', buried: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await api.trash('folderA', 'id1', { thread: true })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ thread: true })
  })

  it('complete() does a GET with kind and q, returns items', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: ['a.ts', 'b.ts'] }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await api.complete('agent1', 'files', 'foo bar')

    expect(result).toEqual(['a.ts', 'b.ts'])
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe('/api/agents/agent1/complete?kind=files&q=foo%20bar')
  })

  describe('api.agents', () => {
    it('list() does a GET to /api/agents and returns the list', async () => {
      const agents = [{ id: 'a1', name: 'Ana' }]
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ agents }))
      vi.stubGlobal('fetch', fetchMock)

      const result = await api.agents.list()

      expect(result).toEqual(agents)
      const [url] = fetchMock.mock.calls[0] as [string]
      expect(url).toBe('/api/agents')
    })

    it('list(true) adds ?all=1 to include archived agents', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ agents: [] }))
      vi.stubGlobal('fetch', fetchMock)

      await api.agents.list(true)

      const [url] = fetchMock.mock.calls[0] as [string]
      expect(url).toBe('/api/agents?all=1')
    })

    it('create() does a POST to /api/agents', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ agent: {} }, true, 201))
      vi.stubGlobal('fetch', fetchMock)

      await api.agents.create({ name: 'Ana', folder: '/x' })

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('/api/agents')
      expect(init.method).toBe('POST')
      expect(JSON.parse(init.body as string)).toEqual({ name: 'Ana', folder: '/x' })
    })

    it('update() does a PATCH to /api/agents/:id', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ agent: {} }))
      vi.stubGlobal('fetch', fetchMock)

      await api.agents.update('a1', { name: 'New name' })

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('/api/agents/a1')
      expect(init.method).toBe('PATCH')
      expect(JSON.parse(init.body as string)).toEqual({ name: 'New name' })
    })

    it('archive() does a POST to /api/agents/:id/archive', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ agent: {} }))
      vi.stubGlobal('fetch', fetchMock)

      await api.agents.archive('a1')

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('/api/agents/a1/archive')
      expect(init.method).toBe('POST')
    })

    it('unarchive() does a POST to /api/agents/:id/unarchive', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ agent: {} }))
      vi.stubGlobal('fetch', fetchMock)

      await api.agents.unarchive('a1')

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('/api/agents/a1/unarchive')
      expect(init.method).toBe('POST')
    })
  })

  // support is a silo: its owner verbs are the kernel's
  describe('api.silos — append-item, move-item, the records query', () => {
    it('append() POSTs {key, collection, values, version?} to /record/append', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
      vi.stubGlobal('fetch', fetchMock)
      await api.silos.append('support', { key: 'agent:finance/c1', collection: 'notes', values: { text: 'hi' }, version: 'v1' })
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('/api/silos/support/record/append')
      expect(init.method).toBe('POST')
      expect(JSON.parse(init.body as string)).toEqual({ key: 'agent:finance/c1', collection: 'notes', values: { text: 'hi' }, version: 'v1' })
    })
    it('move() POSTs {key: <child key>, to} to /record/move', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
      vi.stubGlobal('fetch', fetchMock)
      await api.silos.move('support', 'agent:finance/c1/threads/th1', 'agent:finance/c2')
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('/api/silos/support/record/move')
      expect(JSON.parse(init.body as string)).toEqual({ key: 'agent:finance/c1/threads/th1', to: 'agent:finance/c2' })
    })
    it('records() carries id and rank', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}))
      vi.stubGlobal('fetch', fetchMock)
      await api.silos.records('support', { id: 'c1', rank: 'needs-you', facets: { agent: 'finance' } })
      expect((fetchMock.mock.calls[0] as [string])[0]).toBe('/api/silos/support/records?id=c1&rank=needs-you&facet.agent=finance')
    })
  })
})
