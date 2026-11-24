// BirthFields.tsx — the fields of an agent's birth, the SAME in Welcome and
// the New agent form (lib/birth.ts is their one model), in three pieces:
// ProjectField (one Silos knows, or a new one by name — never a path),
// AgentFields (its name, how it works — WorksChoice: the ladder's three
// rungs —, what it takes care of) and EngineField (only when this machine
// can run more than one). The New agent form draws them all at once
// (BirthFields); Welcome gives the project its own first step and the
// agent the next. Everything else is chosen later, on its page or per
// conversation.
import { useId, type KeyboardEvent, type ReactNode, type Ref } from 'react'
import type { AgentView } from '../../lib/types'
import type { EngineRow } from '../../lib/first-run'
import { AGENT_SLUG_MAX, PROJECT_SLUG_MAX, projectName, slugOf, type Birth, type BirthProblems } from '../../lib/birth'
import {
  ENGINE_FIELD,
  PROJECT_ASK,
  PROJECT_GIVEN,
  PROJECT_NAME_LABEL,
  PROJECT_NEW,
  missionAskFor,
  missionHelp,
  projectJoinNote,
  projectNewNote,
} from '../../lib/new-agent'
import { territoriesOf } from '../../lib/territory'
import { basename } from '../../lib/routes'
import { WorksChoice } from './WorksChoice'
import { ChoiceGroup, ChoiceRow } from './ChoiceRow'

export const field = 'w-full rounded-lg border border-line bg-canvas px-3 py-2 text-ink outline-none placeholder:text-ink-3 focus:border-terracotta'
const label = 'mb-1.5 block text-[14px] text-ink'
const NEW = '' // the select's value for «A new project» (a path is never empty)

type Agentish = Pick<AgentView, 'id' | 'name' | 'folder' | 'folders' | 'archived'>
// the server's refusal, under the field it names
type Errors = { project?: string | null; name?: string | null }
type Engines = { rows: readonly EngineRow[]; value: string; onPick: (id: string) => void }
// Enter in a one-line field acts, as a form would
const enterOn =
  (onEnter?: () => void) =>
  (e: KeyboardEvent<HTMLInputElement>): void => {
    if (onEnter && e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      onEnter()
    }
  }

// its project: a select of the projects Silos knows (plus the folder a door
// handed over) and «A new project», whose name follows the agent's until
// typed. `choose: false` draws the new project's name alone — Welcome on a
// fresh install, where there is nothing else to pick.
export function ProjectField({
  birth,
  onBirth,
  known,
  agents,
  problems,
  errors = {},
  onEnter,
  choose = true,
  autoFocus = false,
  heading,
  idPrefix,
}: {
  birth: Birth
  onBirth: (patch: Partial<Birth>) => void
  known: readonly string[] // knownProjects(agents)
  agents: readonly Agentish[]
  problems: BirthProblems
  errors?: Errors
  onEnter?: () => void
  choose?: boolean
  autoFocus?: boolean
  heading?: ReactNode // the select's label (Project by default)
  idPrefix: string
}) {
  const uid = useId()
  const enter = enterOn(onEnter)
  const p = birth.project
  const picked = p.kind === 'new' ? NEW : p.folder
  // who is already there: the project is a boundary, joining it means knowing them
  const others = p.kind === 'new' ? [] : agents.filter((a) => !a.archived && territoriesOf(a).includes(p.folder)).map((a) => a.name)
  const select = choose || p.kind !== 'new'
  return (
    <div>
      {select ? (
        <>
          <label htmlFor={`${idPrefix}-project`} className={label}>
            {heading ?? PROJECT_ASK}
          </label>
          <select
            id={`${idPrefix}-project`}
            value={picked}
            onChange={(e) =>
              onBirth({
                project:
                  e.target.value === NEW
                    ? { kind: 'new', name: null }
                    : known.includes(e.target.value)
                      ? { kind: 'existing', folder: e.target.value }
                      : { kind: 'given', folder: e.target.value },
              })
            }
            className={`${field} text-[14px]`}
          >
            <option value={NEW}>{PROJECT_NEW}</option>
            {p.kind === 'given' ? (
              <option value={p.folder}>
                {basename(p.folder)} — {PROJECT_GIVEN}
              </option>
            ) : null}
            {known.map((f) => (
              <option key={f} value={f}>
                {basename(f)}
              </option>
            ))}
          </select>
        </>
      ) : null}
      {p.kind === 'new' ? (
        <div className={select ? 'mt-2' : ''}>
          <label htmlFor={`${idPrefix}-project-name`} className={select ? 'sr-only' : label}>
            {PROJECT_NAME_LABEL}
          </label>
          <input
            id={`${idPrefix}-project-name`}
            value={p.name ?? birth.name}
            onKeyDown={enter}
            maxLength={60}
            autoFocus={autoFocus}
            onChange={(e) => onBirth({ project: { kind: 'new', name: e.target.value } })}
            placeholder="Its name — the agent’s, until you type one"
            aria-describedby={`${uid}-pnote`}
            className={select ? `${field} text-[14px]` : `font-display text-[17px] ${field}`}
          />
          <p id={`${uid}-pnote`} className="mt-1 text-xs leading-relaxed text-ink-2">
            {projectNewNote(slugOf(projectName(birth), PROJECT_SLUG_MAX))}
          </p>
        </div>
      ) : (
        <p className="mt-1 text-xs leading-relaxed text-ink-2">
          <span className="font-mono">{p.folder}</span> · {projectJoinNote(others)}
        </p>
      )}
      {problems.project ? (
        <p role="alert" className="mt-1 text-xs text-terracotta">
          {problems.project}
        </p>
      ) : null}
      {errors.project ? (
        <p role="alert" className="mt-1 text-xs text-terracotta">
          {errors.project}
        </p>
      ) : null}
    </div>
  )
}

// the agent itself: its name, how it works, what it takes care of
export function AgentFields({
  birth,
  onBirth,
  problems,
  errors = {},
  onEnter,
  nameRef,
  autoFocusName = false,
  idPrefix,
}: {
  birth: Birth
  onBirth: (patch: Partial<Birth>) => void
  problems: BirthProblems
  errors?: Errors
  onEnter?: () => void
  nameRef?: Ref<HTMLInputElement>
  autoFocusName?: boolean
  idPrefix: string
}) {
  const uid = useId()
  const enter = enterOn(onEnter)
  const name = birth.name.trim()
  const idPreview = slugOf(birth.name, AGENT_SLUG_MAX)
  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}-name`} className={label}>
          Name
        </label>
        <input
          ref={nameRef}
          id={`${idPrefix}-name`}
          autoFocus={autoFocusName}
          required
          value={birth.name}
          onKeyDown={enter}
          maxLength={60}
          placeholder="A name"
          onChange={(e) => onBirth({ name: e.target.value })}
          className={`font-display text-[17px] ${field}`}
        />
        {name !== '' ? (
          problems.nameEmpty ? (
            <p className="mt-1 text-xs text-terracotta">The name needs letters or digits.</p>
          ) : (
            <p className="mt-1 font-mono text-xs text-ink-3">{idPreview}</p>
          )
        ) : null}
        {errors.name ? (
          <p role="alert" className="mt-1 text-xs text-terracotta">
            {errors.name}
          </p>
        ) : null}
      </div>

      <WorksChoice name={name} works={birth.works} onPick={(w) => onBirth({ works: w })} idPrefix={`${idPrefix}-works`} />

      <div>
        <label htmlFor={`${idPrefix}-mission`} className={label}>
          {missionAskFor(name, birth.works)}
        </label>
        <textarea
          id={`${idPrefix}-mission`}
          rows={3}
          value={birth.mission}
          onChange={(e) => onBirth({ mission: e.target.value })}
          aria-describedby={`${uid}-mhelp`}
          className={`resize-y font-display text-[15px] leading-snug ${field}`}
        />
        {problems.mission ? (
          <p role="alert" className="mt-1 text-xs text-terracotta">
            {problems.mission}
          </p>
        ) : null}
        <p id={`${uid}-mhelp`} className="mt-1.5 text-xs leading-relaxed text-ink-2">
          {missionHelp(name)}
        </p>
      </div>
    </>
  )
}

// its engine: drawn only when this machine can run more than one
export function EngineField({ engines, idPrefix }: { engines: Engines; idPrefix: string }) {
  const usable = engines.rows.filter((r) => r.usable)
  if (usable.length < 2) return null
  return (
    <fieldset>
      <legend className="text-[14px] text-ink">{ENGINE_FIELD}</legend>
      <ChoiceGroup label={ENGINE_FIELD}>
        {usable.map((r) => (
          <ChoiceRow
            key={r.id}
            name={`${idPrefix}-engine`}
            value={r.id}
            checked={engines.value === r.id}
            recommended={r.recommended}
            title={
              <>
                {r.label}
                {r.version ? <span className="text-xs text-ink-3">{r.version}</span> : null}
              </>
            }
            onPick={() => engines.onPick(r.id)}
          />
        ))}
      </ChoiceGroup>
    </fieldset>
  )
}

// the New agent form: every piece, in one column
export function BirthFields({
  birth,
  onBirth,
  known,
  agents,
  problems,
  errors = {},
  engines,
  onEnter,
  nameRef,
  autoFocusName = false,
  idPrefix,
}: {
  birth: Birth
  onBirth: (patch: Partial<Birth>) => void
  known: readonly string[] // knownProjects(agents)
  agents: readonly Agentish[]
  problems: BirthProblems
  errors?: Errors
  engines?: Engines // the usable engines and the pick: drawn only when more than one
  onEnter?: () => void // Enter in a one-line field creates
  nameRef?: Ref<HTMLInputElement>
  autoFocusName?: boolean
  idPrefix: string
}) {
  return (
    <div className="flex flex-col gap-5">
      <ProjectField birth={birth} onBirth={onBirth} known={known} agents={agents} problems={problems} errors={errors} onEnter={onEnter} idPrefix={idPrefix} />
      <AgentFields
        birth={birth}
        onBirth={onBirth}
        problems={problems}
        errors={errors}
        onEnter={onEnter}
        nameRef={nameRef}
        autoFocusName={autoFocusName}
        idPrefix={idPrefix}
      />
      {engines ? <EngineField engines={engines} idPrefix={idPrefix} /> : null}
    </div>
  )
}
