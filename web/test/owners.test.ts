// owners.test.ts — lib/owners.ts, the one owner vocabulary: every owner
// written with its type word first, in one display order, one luminance
// step each — and ONE label per thing on both axes: an origin is «From» +
// the very label a place line of «Where it loads» says.
import { describe, expect, it } from 'vitest'
import { OWNER_HOUSE, OWNER_ORDER, byOwnerOrder, ownerName, ownerOriginText, ownerText, ownerTone, ownerType, type Owner } from '../src/lib/owners'
import { placeLabel, skillPlaceLabel } from '../src/lib/loads-places'
import type { LoadsLine, SkillLine } from '../src/lib/types'

const ctx = { agentName: 'Builder', agentEmoji: '🛠', folder: '/home/user/acme', accountName: 'sam' }

describe('owners — the vocabulary', () => {
  it('display order: the subject first, the furthest inheritance last', () => {
    expect(OWNER_ORDER).toEqual(['conversation', 'agent', 'project', 'silos', 'you', 'account', 'engine'])
    const shuffled: Owner[] = ['engine', 'you', 'agent', 'conversation', 'account', 'silos', 'project']
    expect([...shuffled].sort(byOwnerOrder)).toEqual(OWNER_ORDER)
  })

  it("never a bare name: without a name the type word stands alone; a project is its folder's basename, never its path", () => {
    for (const o of OWNER_ORDER) expect(ownerText(o)).toBe(ownerType(o))
    expect(ownerText('project', { folder: '/home/user/silos' })).toBe('Project · silos')
    expect(ownerText('project', { folder: '/home/user/silos/' })).toBe('Project · silos')
    expect(ownerName('project', { folder: null })).toBeNull()
    expect(ownerText('agent', { agentName: 'Builder' })).toBe('Agent · Builder')
    // «silos» is never shown alone for any owner
    for (const o of OWNER_ORDER) expect(ownerText(o, { ...ctx, folder: '/x/silos', agentName: 'Silos' })).not.toMatch(/^silos$/i)
  })

  it('every origin text is «From» + its place label — the same words on both axes', () => {
    const names = { project: 'acme', conversation: 'Fix the importer', emojiOf: (id: string) => (id === 'builder' ? '🛠' : undefined) }
    const full = { ...ctx, conversationTitle: 'Fix the importer' }
    const places: [Owner, LoadsLine['place']][] = [
      ['you', 'machine'],
      ['project', 'project'],
      ['agent', 'agent'],
      ['conversation', 'conversation'],
    ]
    for (const [owner, place] of places) {
      const line = { place, result: 'on', agent: 'builder', agentName: 'Builder' } as LoadsLine
      expect(ownerOriginText(owner, full)).toBe(`From ${placeLabel(line, 'Claude Code', names)}`)
      expect(ownerOriginText(owner, full)).toBe(`From ${skillPlaceLabel(line as unknown as SkillLine, names)}`)
    }
  })

  it("an agent's and a project's label never lacks its type word — on either axis", () => {
    for (const c of [{}, ctx, { agentName: 'Silos', folder: '/x/silos' }]) {
      expect(ownerText('agent', c)).toMatch(/^Agent( · |$)/)
      expect(ownerText('project', c)).toMatch(/^Project( · |$)/)
    }
    for (const names of [{}, { project: 'acme' }]) {
      expect(placeLabel({ place: 'agent', result: 'on', agent: 'b', agentName: 'Builder' } as LoadsLine, 'Claude Code', names)).toMatch(/^Agent · /)
      expect(placeLabel({ place: 'project', result: 'on' } as LoadsLine, 'Claude Code', names)).toMatch(/^(Project · |This project$)/)
    }
  })

  it('ownerType: off a conversation the conversation part is its first message', () => {
    expect(ownerType('conversation', { offConversation: true })).toBe('First message')
    expect(ownerType('agent', { offConversation: true })).toBe('Agent')
  })

  it("tones: the page's own owner is the darkest, each step outward lighter; owners nearer than the page clamp to its tone", () => {
    const alpha = (c: string): number => Number(c.split('/')[1])
    const fromAgent = (['agent', 'project', 'silos', 'you', 'account', 'engine'] as Owner[]).map((o) => alpha(ownerTone(o, 'agent')))
    expect(fromAgent).toEqual([...fromAgent].sort((a, b) => b - a))
    expect(new Set(fromAgent).size).toBe(fromAgent.length)
    expect(ownerTone('project', 'project')).toBe(ownerTone('agent', 'agent'))
    expect(ownerTone('agent', 'project')).toBe(ownerTone('project', 'project'))
    expect(OWNER_ORDER.map((o) => ownerTone(o)).every((c) => c.startsWith('bg-ink/'))).toBe(true)
  })

  it("houses: where each owner's things are changed — none for what Silos can't change", () => {
    expect(OWNER_HOUSE.you).toBe('Settings')
    expect(OWNER_HOUSE.project).toBe('the project page')
    expect(OWNER_HOUSE.silos).toBeNull()
    expect(OWNER_HOUSE.account).toBeNull()
    expect(OWNER_HOUSE.engine).toBeNull()
  })
})
