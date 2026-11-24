// WhoStep.tsx — the first run's first step: its first agent — a name, how
// it works, what it takes care of, where its files are (derived; that
// folder is its project). A loose conversation is not offered here (the
// «+» menu keeps it). The name is here so «a name + Create» is the whole
// first run.
import { useState, type KeyboardEvent } from 'react'
import type { Works } from '../../lib/first-run'
import { WorksChoice } from './WorksChoice'
import { AGENT_IS, FOLDER_ASK, NEW_AGENT_ASK, derivedFolder, missionAskFor, missionHelp } from '../../lib/new-agent'

export const field = 'w-full rounded-lg border border-line bg-canvas px-3 py-2 text-ink outline-none placeholder:text-ink-3 focus:border-terracotta'

export interface WhoDraft {
  name: string
  mission: string
  folder: string
  works: Works
}

export function WhoStep({
  draft,
  id,
  hint,
  onDraft,
  onEnter,
}: {
  draft: WhoDraft
  id: string
  hint: string | null
  onDraft: (d: Partial<WhoDraft>) => void
  onEnter: () => void // Enter in a one-line field creates, as a form would
}) {
  const enter = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      onEnter()
    }
  }
  const [choosing, setChoosing] = useState(draft.folder !== '')
  const clean = draft.name.trim()
  return (
    <section data-testid="tour-who">
      <h1 className="font-display text-[26px] leading-tight tracking-tight text-ink">{NEW_AGENT_ASK}</h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{AGENT_IS}</p>

      <label htmlFor="welcome-name" className="sr-only">
        Name
      </label>
      <input
        id="welcome-name"
        autoFocus
        onKeyDown={enter}
        value={draft.name}
        onChange={(e) => onDraft({ name: e.target.value })}
        maxLength={60}
        placeholder="A name"
        className={`mt-5 font-display text-[17px] ${field}`}
      />

      <div className="mt-5">
        <WorksChoice name={clean} works={draft.works} onPick={(w) => onDraft({ works: w })} idPrefix="welcome-works" />
      </div>

      <label htmlFor="welcome-mission" className="mt-5 block text-[14px] text-ink">
        {missionAskFor(clean, draft.works)}
      </label>
      <textarea
        id="welcome-mission"
        rows={3}
        value={draft.mission}
        onChange={(e) => onDraft({ mission: e.target.value })}
        aria-describedby="welcome-mission-help"
        className={`mt-1.5 resize-y font-display text-[15px] leading-snug ${field}`}
      />
      {hint ? (
        <p role="alert" className="mt-1 text-xs text-terracotta">
          {hint}
        </p>
      ) : null}
      <p id="welcome-mission-help" className="mt-1.5 text-xs leading-relaxed text-ink-2">
        {missionHelp(clean)}
      </p>

      <p className="mt-5 text-[14px] text-ink">{FOLDER_ASK}</p>
      {choosing ? (
        <input
          autoFocus
          onKeyDown={enter}
          value={draft.folder}
          onChange={(e) => onDraft({ folder: e.target.value })}
          aria-label="Its folder"
          placeholder="/path/to/the/folder — an existing one, or a new one"
          className={`mt-1.5 font-mono text-[13px] ${field}`}
        />
      ) : (
        <p className="mt-1 text-[13px] text-ink-2" data-testid="welcome-folder">
          <span className="font-mono text-ink">{derivedFolder(id)}</span>
          {' · '}
          <button type="button" onClick={() => setChoosing(true)} className="underline decoration-line underline-offset-2 hover:text-terracotta">
            change
          </button>
        </p>
      )}
    </section>
  )
}
