// shell-quote.ts — the one way Silos puts a value into a POSIX shell string
// it writes for someone else to run (a hook command in a settings file, a
// command it shows the owner to paste). The rule: a value is ONE shell word
// whatever it holds — spaces, quotes, `$`, newlines — so it is single-quoted
// unless it is made only of characters no shell treats specially.
// shellWords is the reader's half: how a shell splits such a string into
// words, enough to find the path a command runs (no expansion, no globbing).

const PLAIN = /^[A-Za-z0-9_@%+=:,./-]+$/

/** `value` as one POSIX shell word. */
export function shellQuote(value: string): string {
  if (value !== '' && PLAIN.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** The words a POSIX shell would split `command` into: whitespace outside
 *  quotes separates, '…' is literal, "…" honours \" \\ \$ \`, a backslash
 *  outside quotes escapes the next character. Operators (; | &) are not
 *  special here — they only end up inside a word, which is enough to find a
 *  path. Variables are NOT expanded. */
export function shellWords(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let inWord = false
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (c === "'") {
      const end = command.indexOf("'", i + 1)
      const stop = end === -1 ? command.length : end
      cur += command.slice(i + 1, stop)
      i = stop
      inWord = true
    } else if (c === '"') {
      inWord = true
      for (i++; i < command.length && command[i] !== '"'; i++) {
        const d = command[i]!
        if (d === '\\' && i + 1 < command.length && '"\\$`'.includes(command[i + 1]!)) cur += command[++i]!
        else cur += d
      }
    } else if (c === '\\' && i + 1 < command.length) {
      cur += command[++i]!
      inWord = true
    } else if (/\s/.test(c)) {
      if (inWord) out.push(cur)
      cur = ''
      inWord = false
    } else {
      cur += c
      inWord = true
    }
  }
  if (inWord) out.push(cur)
  return out
}
