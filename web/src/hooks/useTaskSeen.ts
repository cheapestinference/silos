// useTaskSeen — the owner's read marks on plan tasks, one shared reading read
// again on each `silos` tick (another device's marks arrive with the next change).
// Until it is read, nothing is new: a task never turns bold on a guess.
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { mergeBook, newTaskKeys, type SeenBook } from '../lib/task-seen'
import type { TaskView } from '../lib/tasks'

let book: SeenBook | null = null
let readTick: number | null = null
const listeners = new Set<(b: SeenBook | null) => void>()
const publish = (b: SeenBook): void => {
  book = b
  for (const l of listeners) l(b)
}

function load(tick: number): void {
  if (readTick === tick) return
  readTick = tick
  Promise.resolve(api.taskSeen?.read())
    .then((b) => {
      if (b) publish(book ? mergeBook(book, b) : b)
    })
    .catch(() => {
      readTick = null /* the next tick tries again; nothing turns new meanwhile */
    })
}

export function useTaskSeen(): SeenBook | null {
  const tick = useStore((s) => s.siloTick)
  const [b, setB] = useState(book)
  useEffect(() => {
    listeners.add(setB)
    load(tick)
    setB(book)
    return () => {
      listeners.delete(setB)
    }
  }, [tick])
  return b
}

// the tasks among these that are new to the owner
export function useNewTasks(tasks: readonly TaskView[]): ReadonlySet<string> {
  const b = useTaskSeen()
  const agents = useStore((s) => s.agents)
  return useMemo(() => newTaskKeys(tasks, b, new Set(agents.map((a) => a.id))), [tasks, b, agents])
}

// The owner looked at this task, or just settled it into `state`. Said here at
// once, confirmed by the server's clock; a failed write leaves the mark until the
// next reading, which is no worse than the weight coming back later.
export function markTaskSeen(key: string, state: string): void {
  const stamp = (at: number): void => {
    if (book) publish({ ...book, seen: { ...book.seen, [key]: { at, state } } })
  }
  stamp(Date.now())
  Promise.resolve(api.taskSeen?.mark(key, state))
    .then((m) => {
      if (m) stamp(m.at)
    })
    .catch(() => {
      readTick = null
    })
}

// tests: forget the shared reading between cases
export function resetTaskSeen(): void {
  book = null
  readTick = null
}
