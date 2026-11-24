// answer-wait.test.ts — what an answer IS, decided by ONE pure function over
// the task as the surface painted it: a gate of
// the owner's closes through `respond`; anything else is the verb `answer`
// (ONE write, with the question painted). What still holds it comes back
// as `holds`; a dropped dependency among them is said with its labels.
// The three-step recipe and its retry are gone.
import { describe, expect, it, vi } from 'vitest'
import { answerKind, answerTask, droppedOf, paintedAsked, reviewWaitsOnYou, stuckWords, type AnswerApi } from '../src/lib/answer-wait'

vi.mock('../src/lib/api', () => ({ api: { silos: {} } }))

const agents = new Set(['writer', 'builder'])
const task = (over: Record<string, unknown> = {}) => ({
  key: 'k/tasks/t1',
  planKey: 'k',
  owner: 'writer',
  state: 'blocked',
  waitingOn: { owner: 'owner', action: 'decide', asked: 'Publish today?' } as { owner: string; action: string; asked?: string } | null,
  flow: { unblocks: [] as Array<{ id: string; owner: string }> },
  ...over,
})
function fake() {
  const calls: Array<[string, Record<string, unknown>]> = []
  const deps: AnswerApi = {
    respond: vi.fn(async (_s, b) => {
      calls.push(['respond', b])
      return { notified: [{ key: 'k/tasks/t2', owner: 'writer' }] }
    }),
    answer: vi.fn(async (key, text, asked) => {
      calls.push(['answer', { key, text, asked }])
      return { holds: ['t0'] }
    }),
  }
  return { deps, calls }
}

describe("answerKind — one pure choice, the label's too", () => {
  it("a person's task agents wait on directly is a gate; an agent's, or one nobody waits on, is a wait", () => {
    expect(answerKind(task({ owner: 'owner', flow: { unblocks: [{ id: 't2', owner: 'writer' }] } }), agents)).toBe('gate')
    expect(answerKind(task({ owner: 'writer', flow: { unblocks: [{ id: 't2', owner: 'builder' }] } }), agents)).toBe('wait')
    expect(answerKind(task({ owner: 'owner' }), agents)).toBe('wait')
  })
  it("the question painted is the kernel's reading when the row has it, '' when it asked none", () => {
    expect(paintedAsked(task())).toBe('Publish today?')
    expect(paintedAsked(task({ waitingOn: { owner: 'owner', action: 'decide' } }))).toBe('')
    expect(paintedAsked(task({ flow: { waitsOn: { owner: 'owner', action: 'x', asked: ' Ship? ' } } }))).toBe('Ship?')
  })
  it("an agent's review waiting on you offers Approve and Send back; a person's, or one waiting on someone else, does not", () => {
    expect(reviewWaitsOnYou(task({ state: 'in_review' }), agents)).toBe(true)
    expect(reviewWaitsOnYou(task({ state: 'in_review', owner: 'sam' }), agents)).toBe(false)
    expect(reviewWaitsOnYou(task({ state: 'in_review', waitingOn: { owner: 'sam', action: 'review' } }), agents)).toBe(false)
    expect(reviewWaitsOnYou(task({ state: 'blocked' }), agents)).toBe(false)
  })
})

describe('answerTask', () => {
  it('a wait: the verb answer with the text and the question painted — one call; its holds come back', async () => {
    const { deps, calls } = fake()
    expect(await answerTask(task(), ' Yes ', agents, deps)).toEqual({ closed: false, notified: [], holds: ['t0'] })
    expect(calls).toEqual([['answer', { key: 'k/tasks/t1', text: 'Yes', asked: 'Publish today?' }]])
  })
  it('a gate of yours closes through respond — the same gesture as Answer & done', async () => {
    const { deps, calls } = fake()
    expect(await answerTask(task({ owner: 'owner', flow: { unblocks: [{ id: 't2', owner: 'writer' }] } }), 'Yes', agents, deps)).toEqual({
      closed: true,
      notified: [{ key: 'k/tasks/t2', owner: 'writer' }],
      holds: [],
    })
    // the state painted rides with it: the gate's Done is judged on it
    expect(calls).toEqual([['respond', { key: 'k/tasks/t1', text: 'Yes', state: 'blocked' }]])
  })
  it('an empty answer says nothing and sends nothing; a refusal is thrown as the server said it', async () => {
    const { deps, calls } = fake()
    await expect(answerTask(task(), '   ', agents, deps)).rejects.toThrow('an empty answer says nothing')
    expect(calls).toEqual([])
    deps.answer = vi.fn(async () => {
      throw new Error('it asks something else now')
    })
    await expect(answerTask(task(), 'Yes', agents, deps)).rejects.toThrow('it asks something else now')
  })
})

describe('what still holds it, said', () => {
  it('the dropped dependencies among the holds, read from the siblings the surface has, with its labels', () => {
    const sib = (id: string, state: string, title = `Task ${id}`) => ({ key: `k/tasks/${id}`, id, planKey: 'k', state: state as never, title })
    const stuck = droppedOf(['t0', 't5', 'sam (sign)'], { planKey: 'k' }, [sib('t0', 'cancelled', 'Video'), sib('t5', 'in_progress')])
    expect(stuck).toEqual([{ id: 't0', key: 'k/tasks/t0', title: 'Video' }])
    expect(stuckWords(stuck, (id) => `proj#${id}`)).toBe(
      'it still waits on proj#t0 «Video», which was dropped — that never resolves: remove the dependency or reopen it',
    )
    expect(droppedOf([], { planKey: 'k' }, [sib('t0', 'cancelled')])).toEqual([])
  })
})
