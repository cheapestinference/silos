// Templates.tsx — automation templates in the web. Moment 3, Direct:
// «hand out a responsibility in a sentence».
//
// - TemplateShelf: at the top of /automation/new — the templates as their
//   sentences, the blanks drawn as empty rules. Picking one puts
//   ?template=<id> in the URL (deep link, Back works). No new door: every
//   «New automation» already lands here.
// - TemplateFill: /automation/new?template=<id> — the template's sentence IS
//   the form. Each blank is its field inside the line. The server says what
//   Create would make (preview, the same validator as Create) in the
//   automation page's own words.
import { Download, Upload } from 'lucide-react'
import { HeaderButton, PageHeader, Seal } from '../PageHeader'
import { AutomationIcon } from '../../lib/icons'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api, ApiError } from '../../lib/api'
import { MASTER_ID } from '../../lib/constants'
import { argvLine } from '../../lib/automations'
import { triggerWords } from '../../../../server/src/automation-words'
import { useStore } from '../../store'
import { goBackTo, replacing, routeOf } from '../../lib/router'
import type { Automation, AutomationTemplate, TemplateParam } from '../../lib/types'

// the sentence cut at its blanks
type Part = { text: string } | { key: string }
export function sentenceParts(sentence: string): Part[] {
  const out: Part[] = []
  let last = 0
  for (const m of sentence.matchAll(/\{\{([a-z][a-zA-Z0-9]*)\}\}/g)) {
    const i = m.index ?? 0
    if (i > last) out.push({ text: sentence.slice(last, i) })
    out.push({ key: m[1]! })
    last = i + m[0].length
  }
  if (last < sentence.length) out.push({ text: sentence.slice(last) })
  return out
}

function useTemplates(): { templates: AutomationTemplate[] | null; error: string | null; reload: () => void } {
  const [templates, setTemplates] = useState<AutomationTemplate[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [n, setN] = useState(0)
  useEffect(() => {
    let alive = true
    api.automationTemplates.list().then(
      (t) => {
        if (alive) {
          setTemplates(t)
          setError(null)
        }
      },
      (e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      },
    )
    return () => {
      alive = false
    }
  }, [n])
  return { templates, error, reload: () => setN((x) => x + 1) }
}

// ---- the shelf --------------------------------------------------------------

export function TemplateShelf({ agentId }: { agentId?: string }) {
  const { templates, error, reload } = useTemplates()
  const [importError, setImportError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const params = useParamsLabels()

  async function onFile(f: File): Promise<void> {
    setImportError(null)
    try {
      const saved = await api.automationTemplates.import(JSON.parse(await f.text()))
      reload()
      useStore.getState().changePage({ kind: 'automation', id: 'new', template: saved.id, ...(agentId ? { agent: agentId } : {}) })
    } catch (e) {
      setImportError(e instanceof SyntaxError ? `${f.name} is not a template file (it is not JSON)` : e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <section className="mb-8" data-testid="template-shelf" aria-label="Start from a template">
      <h2 className="font-display text-[17px] text-ink">Start from a template</h2>
      {error ? <p className="mt-2 text-sm text-terracotta">Templates could not be read: {error}</p> : null}
      <ul className="mt-2 divide-y divide-line/70">
        {(templates ?? []).map((t) => (
          <li key={t.id}>
            <button
              type="button"
              data-testid={`template-${t.id}`}
              onClick={() => useStore.getState().changePage({ kind: 'automation', id: 'new', template: t.id, ...(agentId ? { agent: agentId } : {}) })}
              className="group flex w-full items-baseline gap-3 py-2.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-terracotta"
            >
              <span className="min-w-0 flex-1 text-[15px] leading-relaxed text-ink-2 group-hover:text-ink">
                {sentenceParts(t.sentence).map((p, i) =>
                  'text' in p ? (
                    <span key={i}>{p.text}</span>
                  ) : (
                    <span
                      key={i}
                      className="mx-0.5 inline-block min-w-[5ch] border-b border-ink-3/60 px-0.5 text-[13px] text-ink-3 group-hover:border-terracotta"
                    >
                      {params(t, p.key)}
                    </span>
                  ),
                )}
              </span>
              {t.source === 'user' ? <span className="shrink-0 text-xs text-ink-3">yours</span> : null}
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex items-center gap-3">
        <button type="button" onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-1.5 text-xs text-ink-2 hover:text-terracotta">
          <Upload size={12} /> Import a template file
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          data-testid="template-import"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void onFile(f)
          }}
        />
        {importError ? (
          <span className="text-xs text-terracotta" data-testid="template-import-problem">
            {importError}
          </span>
        ) : null}
      </div>
      <p className="mt-6 text-sm text-ink-3">Or write one from scratch below.</p>
    </section>
  )
}

// a blank's words in the shelf: its label, small and lower-case
function useParamsLabels(): (t: AutomationTemplate, key: string) => string {
  return (t, key) => (t.params.find((p) => p.key === key)?.label ?? key).toLowerCase()
}

// ---- filling one in ---------------------------------------------------------

const fieldBase =
  'mx-1 border-b-2 bg-transparent px-0.5 font-sans text-[0.8em] text-ink outline-none [field-sizing:content] placeholder:text-ink-3 focus:border-terracotta'

function Blank({
  p,
  value,
  onChange,
  invalid,
  agents,
}: {
  p: TemplateParam
  value: string
  onChange: (v: string) => void
  invalid: boolean
  agents: { id: string; name: string; emoji: string }[]
}) {
  const border = invalid ? 'border-terracotta' : value ? 'border-ink-3' : 'border-ink-3/50'
  const common = { 'aria-label': p.label, 'aria-invalid': invalid || undefined, 'data-testid': `blank-${p.key}` }
  if (p.kind === 'agent') {
    return (
      <select {...common} value={value} onChange={(e) => onChange(e.target.value)} className={`${fieldBase} ${border} cursor-pointer`}>
        <option value="">{p.label.toLowerCase()}</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.emoji ? `${a.emoji} ` : ''}
            {a.name}
          </option>
        ))}
      </select>
    )
  }
  if (p.kind === 'time') return <input {...common} type="time" value={value} onChange={(e) => onChange(e.target.value)} className={`${fieldBase} ${border}`} />
  // text, not number: a number input's spinner covers the digits at this size
  if (p.kind === 'day')
    return (
      <input
        {...common}
        type="text"
        inputMode="numeric"
        maxLength={2}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
        className={`${fieldBase} ${border} min-w-[2ch] text-center`}
      />
    )
  return (
    <input
      {...common}
      type="text"
      value={value}
      spellCheck={false}
      placeholder={p.placeholder ?? p.label.toLowerCase()}
      onChange={(e) => onChange(e.target.value)}
      className={`${fieldBase} ${border} min-w-[8ch] max-w-full ${p.kind === 'command' || p.kind === 'path' || p.kind === 'url' || p.kind === 'glob' ? 'font-mono text-[0.72em]' : ''}`}
    />
  )
}

type Preview = { automation: Omit<Automation, 'id' | 'createdAt'> } | { error: string; field?: string } | null

export function TemplateFill({ templateId, agentId }: { templateId: string; agentId?: string }) {
  const { templates, error: listError } = useTemplates()
  const agentsAll = useStore((s) => s.agents)
  const agents = useMemo(() => agentsAll.filter((a) => !a.archived && a.id !== MASTER_ID), [agentsAll])
  const t = templates?.find((x) => x.id === templateId) ?? null
  const [values, setValues] = useState<Record<string, string>>({})
  const [touched, setTouched] = useState(false)
  const [preview, setPreview] = useState<Preview>(null)
  const [busy, setBusy] = useState(false)
  const [createError, setCreateError] = useState<{ error: string; field?: string } | null>(null)
  const [sure, setSure] = useState(false)

  // the opening answers: defaults, and the agent the page was opened for
  // goes in the first agent blank
  useEffect(() => {
    if (!t) return
    const firstAgent = t.params.find((p) => p.kind === 'agent')
    setValues(
      Object.fromEntries(t.params.map((p) => [p.key, p.default ?? (p === firstAgent && agentId && agents.some((a) => a.id === agentId) ? agentId : '')])),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t?.id])

  const complete = !!t && t.params.every((p) => (values[p.key] ?? '').trim() !== '')
  // what Create would make — asked of the server once every blank holds something
  useEffect(() => {
    if (!t || !complete) {
      setPreview(null)
      return
    }
    let alive = true
    const h = setTimeout(() => {
      api.automationTemplates.preview(t.id, values).then(
        (automation) => {
          if (alive) setPreview({ automation })
        },
        (e: unknown) => {
          if (alive) setPreview(errorOf(e))
        },
      )
    }, 250)
    return () => {
      alive = false
      clearTimeout(h)
    }
  }, [t, values, complete])

  // a «back» to the shelf: Back when the shelf is right below, else it goes
  // there replacing
  const back = (): void => {
    const shelf = { kind: 'automation' as const, id: 'new', ...(agentId ? { agent: agentId } : {}) }
    goBackTo(routeOf({ page: shelf }), () => useStore.getState().changePage(shelf))
  }

  if (!t) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 p-8 text-center">
        {templates === null && !listError ? (
          <p className="text-sm text-ink-2">Reading templates…</p>
        ) : (
          <>
            <p className="font-display text-lg text-ink">Template not found</p>
            <button type="button" onClick={back} className="text-sm text-ink underline underline-offset-2 hover:text-terracotta">
              See the templates
            </button>
          </>
        )}
      </div>
    )
  }

  const problem = createError ?? (preview && 'error' in preview ? preview : null)
  const missing = touched ? t.params.filter((p) => (values[p.key] ?? '').trim() === '').map((p) => p.key) : []
  const invalidKey = problem?.field

  async function create(): Promise<void> {
    setTouched(true)
    if (!t || !complete) return
    setBusy(true)
    setCreateError(null)
    try {
      const a = await api.automationTemplates.use(t.id, values)
      await useStore.getState().loadAutomations()
      // the filled template is spent: its automation replaces it
      replacing(() => useStore.getState().changePage({ kind: 'automation', id: a.id }))
    } catch (e) {
      setCreateError(errorOf(e))
    } finally {
      setBusy(false)
    }
  }

  async function download(): Promise<void> {
    if (!t) return
    const text = await api.automationTemplates.file(t.id)
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${t.id}.silos-template.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  const a = preview && 'automation' in preview ? preview.automation : null
  const runner = a ? agents.find((x) => x.id === a.agentId) : null

  return (
    <div className="flex flex-1 flex-col overflow-hidden" data-testid="template-fill">
      <PageHeader
        testId="template-header"
        // where it lives: Automations › New automation (the shelf of templates)
        crumbs={[
          { label: 'Automations', onClick: () => useStore.getState().changePage({ kind: 'automations' }) },
          { label: 'New automation', title: 'Back to the templates', onClick: back },
        ]}
        seal={
          <Seal>
            <AutomationIcon size={17} strokeWidth={2} aria-hidden="true" className="text-terracotta" />
          </Seal>
        }
        title={t.name}
        facts={<span className="truncate">{t.source === 'user' ? 'Your template' : 'A template that comes with Silos'} — fill in the blanks</span>}
        actions={
          t.source === 'user' ? (
            <>
              <HeaderButton onClick={() => void download()} label="Download file">
                <Download size={13} aria-hidden="true" /> Download file
              </HeaderButton>
              <HeaderButton
                onClick={() => {
                  if (!sure) {
                    setSure(true)
                    return
                  }
                  void api.automationTemplates.remove(t.id).then(back)
                }}
                label={sure ? 'Delete — sure?' : 'Delete'}
              >
                {sure ? <span className="text-terracotta">Delete — sure?</span> : 'Delete'}
              </HeaderButton>
            </>
          ) : null
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[46rem] px-4 pb-12 pt-10 sm:px-8 sm:pt-14">
          {/* the sentence IS the form */}
          <p className="font-display text-[26px] leading-[1.9] text-ink sm:text-[30px]" data-testid="template-sentence">
            {sentenceParts(t.sentence).map((part, i) => {
              if ('text' in part) return <span key={i}>{part.text}</span>
              const p = t.params.find((x) => x.key === part.key)
              if (!p) return <span key={i}>{part.key}</span>
              return (
                <Blank
                  key={i}
                  p={p}
                  value={values[p.key] ?? ''}
                  agents={agents}
                  invalid={invalidKey === p.key || missing.includes(p.key)}
                  onChange={(v) => {
                    setValues((s) => ({ ...s, [p.key]: v }))
                    setCreateError(null)
                  }}
                />
              )
            })}
          </p>
          {t.description ? <p className="mt-5 max-w-[60ch] text-[15px] leading-relaxed text-ink-2">{t.description}</p> : null}

          <div className="mt-10 border-t border-line pt-5" aria-live="polite">
            {problem ? (
              <p className="text-sm text-terracotta" data-testid="template-problem">
                {problem.error}
              </p>
            ) : a ? (
              <WhatItWillBe a={a} runner={runner ? `${runner.emoji ? `${runner.emoji} ` : ''}${runner.name}` : a.agentId} />
            ) : (
              <p className="text-sm text-ink-3">{touched && missing.length ? 'Fill in every blank first.' : 'Fill in the blanks to see what it will do.'}</p>
            )}
            <div className="mt-6 flex items-center gap-4">
              <button
                type="button"
                onClick={() => void create()}
                disabled={busy || !!problem}
                data-testid="template-create"
                className="rounded-lg bg-terracotta px-4 py-2 text-sm font-medium text-on-terracotta hover:opacity-90 disabled:opacity-40"
              >
                {busy ? 'Creating…' : 'Create automation'}
              </button>
              <button type="button" onClick={back} className="text-sm text-ink-2 hover:text-ink">
                Choose another template
              </button>
            </div>
            <p className="mt-3 text-xs text-ink-3">Once created it is an automation like any other: edit, pause or delete it on its page.</p>
          </div>
        </div>
      </div>
    </div>
  )
}

function errorOf(e: unknown): { error: string; field?: string } {
  if (e instanceof ApiError) {
    const body = e.body as { field?: unknown } | null
    return { error: e.message, ...(typeof body?.field === 'string' ? { field: body.field } : {}) }
  }
  return { error: e instanceof Error ? e.message : String(e) }
}

// what Create makes, said the way its page will say it
function WhatItWillBe({ a, runner }: { a: Omit<Automation, 'id' | 'createdAt'>; runner: string }) {
  const [open, setOpen] = useState(false)
  const run = a.run
  const lines: ReactNode[] = [
    <>
      <span className="text-ink">{a.name}</span>, {triggerWords(a.trigger)}
    </>,
    run?.kind === 'command' ? (
      <>
        Runs <code className="font-mono text-[12px] text-ink">{argvLine(run.argv)}</code> without Claude; a failure goes to {runner}
      </>
    ) : (
      <>
        Each run is a turn of {runner}
        {a.thread.mode === 'keep' ? ', always in the same conversation' : ', in a new conversation'}
      </>
    ),
  ]
  return (
    <div data-testid="template-preview">
      <p className="text-sm text-ink-2">Create makes:</p>
      <ul className="mt-1.5 space-y-1 text-sm text-ink-2">
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
      {a.prompt ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => setOpen((x) => !x)}
            aria-expanded={open}
            className="text-xs text-ink-2 underline underline-offset-2 hover:text-ink"
          >
            {open ? 'Hide what it asks' : `What it asks ${runner}`}
          </button>
          {open ? <p className="mt-2 whitespace-pre-wrap rounded-lg bg-canvas px-3 py-2 text-[13px] leading-relaxed text-ink">{a.prompt}</p> : null}
        </div>
      ) : null}
    </div>
  )
}
