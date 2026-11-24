// OwnToolAdd.tsx — «+ Add a tool» on the agent page's Tools: an MCP server
// that is THIS agent's alone, added where
// its tools are listed. Silos writes it into the agent's own plugin; it
// reaches the agent's next conversations on every engine.
//
// A secret never goes in here: what the server needs is named by its Vault
// entry («SOME_API_KEY»), and the engine reads the value from the agent's
// Secrets at start. The Vault's names are offered as suggestions; the row
// says afterwards which ones this agent does not get.
import { useEffect, useMemo, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { api } from '../../lib/api'
import type { AgentView, OwnToolConfig } from '../../lib/types'
import { BackBar } from './KnowsDetail'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

type Runs = 'command' | 'url'
interface Secret {
  key: string
  vault: string
  bearer: boolean
}

/** The config the server accepts (agent-tools.ts checkOwnToolConfig), built
 *  from the form: every secret as `${VAULT_NAME}`, never a value. */
export function ownToolConfigOf(f: { runs: Runs; command: string; args: string; url: string; sse: boolean; secrets: Secret[] }): OwnToolConfig {
  const refs = f.secrets.filter((s) => s.key.trim() !== '' && s.vault.trim() !== '')
  if (f.runs === 'command') {
    const args = f.args
      .split('\n')
      .map((a) => a.trim())
      .filter(Boolean)
    const env = Object.fromEntries(refs.map((s) => [s.key.trim(), `\${${s.vault.trim()}}`]))
    return { command: f.command.trim(), ...(args.length > 0 ? { args } : {}), ...(refs.length > 0 ? { env } : {}) }
  }
  const headers = Object.fromEntries(refs.map((s) => [s.key.trim(), `${s.bearer ? 'Bearer ' : ''}\${${s.vault.trim()}}`]))
  return { type: f.sse ? 'sse' : 'http', url: f.url.trim(), ...(refs.length > 0 ? { headers } : {}) }
}

export function OwnToolAdd({ agent, onBack, onAdded }: { agent: AgentView; onBack: () => void; onAdded: (name: string) => void }) {
  const [name, setName] = useState('')
  const [runs, setRuns] = useState<Runs>('command')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [url, setUrl] = useState('')
  const [sse, setSse] = useState(false)
  const [secrets, setSecrets] = useState<Secret[]>([])
  const [vaultNames, setVaultNames] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // suggestions only: the row's «needs» says what this agent really gets
  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(() => api.vault.list())
      .then((es) => {
        if (!cancelled) setVaultNames([...new Set((es ?? []).map((e) => e.name))].sort())
      })
      .catch(() => {
        if (!cancelled) setVaultNames([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const nameOk = NAME_RE.test(name.trim())
  const canSave = nameOk && (runs === 'command' ? command.trim() !== '' : /^https?:\/\//.test(url.trim()))
  const keyWord = runs === 'command' ? 'Variable' : 'Header'
  const listId = useMemo(() => `vault-names-${agent.id}`, [agent.id])

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      await api.agents.tools.add(agent.id, name.trim(), ownToolConfigOf({ runs, command, args, url, sse, secrets }))
      onAdded(name.trim())
    } catch (e) {
      setError(errText(e))
    } finally {
      setSaving(false)
    }
  }

  const field = 'w-full rounded-lg border border-line bg-panel px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink-3 focus:border-terracotta'
  const pill = (on: boolean): string =>
    `rounded-full border px-2.5 py-0.5 text-xs ${on ? 'border-ink-2 bg-panel text-ink' : 'border-line text-ink-2 hover:text-ink'}`
  return (
    <div data-testid="own-tool-add">
      <BackBar onBack={onBack} title="Add a tool" />
      <div className="space-y-3 px-4 pb-4 pt-2">
        <p className="text-[12px] leading-snug text-ink-2">
          An MCP server only {agent.name} gets — no other agent of its folder. Its next conversations start with it.
        </p>
        <label className="block">
          <span className="text-[12px] text-ink-2">Name</span>
          <input
            aria-label="Tool name"
            placeholder="books"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={`${field} mt-1 font-mono text-[12.5px]`}
          />
          {name !== '' && !nameOk ? <span className="mt-1 block text-[11.5px] text-terracotta">A letter first, then letters, digits, - or _.</span> : null}
        </label>
        <div>
          <p id="own-tool-runs" className="text-[12px] text-ink-2">
            It runs as
          </p>
          <div role="radiogroup" aria-labelledby="own-tool-runs" className="mt-1 inline-flex gap-1">
            <button type="button" role="radio" aria-checked={runs === 'command'} onClick={() => setRuns('command')} className={pill(runs === 'command')}>
              A command on this machine
            </button>
            <button type="button" role="radio" aria-checked={runs === 'url'} onClick={() => setRuns('url')} className={pill(runs === 'url')}>
              A server at a URL
            </button>
          </div>
        </div>
        {runs === 'command' ? (
          <>
            <input
              aria-label="Command"
              placeholder="npx"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              className={`${field} font-mono text-[12.5px]`}
            />
            <textarea
              aria-label="Arguments"
              placeholder={'Arguments, one per line\n-y\nsome-mcp-server'}
              spellCheck={false}
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              className={`${field} min-h-[4.5rem] resize-y font-mono text-[12px] leading-relaxed`}
            />
          </>
        ) : (
          <>
            <input
              aria-label="URL"
              placeholder="https://mcp.example.com/mcp"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className={`${field} font-mono text-[12.5px]`}
            />
            <label className="flex items-center gap-2 text-[12px] text-ink-2">
              <input type="checkbox" checked={sse} onChange={(e) => setSse(e.target.checked)} /> It streams over SSE (older servers)
            </label>
          </>
        )}
        <div>
          <p className="text-[12px] text-ink-2">Secrets it needs</p>
          <p className="mt-0.5 text-[11.5px] leading-snug text-ink-3">
            Name the {agent.name} Secret each {keyWord.toLowerCase()} takes its value from — the value stays in Secrets, never in the tool.
          </p>
          <datalist id={listId}>
            {vaultNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <ul className="mt-1.5 space-y-1.5">
            {secrets.map((s, i) => (
              <li key={i} className="flex items-center gap-1.5">
                <input
                  aria-label={`${keyWord} name`}
                  placeholder={runs === 'command' ? 'API_KEY' : 'Authorization'}
                  value={s.key}
                  onChange={(e) => setSecrets(secrets.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
                  className={`${field} min-w-0 flex-1 font-mono text-[12px]`}
                />
                <span aria-hidden="true" className="text-ink-3">
                  ←
                </span>
                {runs === 'url' ? (
                  <button
                    type="button"
                    aria-pressed={s.bearer}
                    onClick={() => setSecrets(secrets.map((x, j) => (j === i ? { ...x, bearer: !x.bearer } : x)))}
                    className={`${pill(s.bearer)} shrink-0`}
                  >
                    Bearer
                  </button>
                ) : null}
                <input
                  aria-label="Secret name"
                  list={listId}
                  placeholder="SOME_API_KEY"
                  value={s.vault}
                  onChange={(e) => setSecrets(secrets.map((x, j) => (j === i ? { ...x, vault: e.target.value.toUpperCase() } : x)))}
                  className={`${field} min-w-0 flex-1 font-mono text-[12px]`}
                />
                <button
                  type="button"
                  aria-label="Remove this secret"
                  onClick={() => setSecrets(secrets.filter((_, j) => j !== i))}
                  className="shrink-0 rounded-md p-1 text-ink-3 hover:text-terracotta"
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setSecrets([...secrets, { key: '', vault: '', bearer: runs === 'url' }])}
            className="mt-1.5 inline-flex items-center gap-1 text-[12px] text-ink-2 hover:text-terracotta"
          >
            <Plus size={11} aria-hidden="true" /> {runs === 'command' ? 'A variable from Secrets' : 'A header from Secrets'}
          </button>
        </div>
        {error ? (
          <p role="alert" className="text-xs text-terracotta">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end">
          <button
            type="button"
            disabled={!canSave || saving}
            onClick={() => void save()}
            className="rounded-lg bg-terracotta px-3 py-1.5 text-sm font-medium text-on-terracotta hover:opacity-90 disabled:opacity-50"
          >
            {saving ? 'Adding…' : `Add to ${agent.name}`}
          </button>
        </div>
      </div>
    </div>
  )
}
