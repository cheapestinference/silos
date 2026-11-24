// helpers/module-specifiers.ts — every module specifier a TypeScript file
// names, read from a real parse (rolldown's oxc parser, ESTree-shaped AST),
// never from a lexer or a regex: comments, strings, templates and regex
// literals are the parser's business. Collected anywhere in the tree:
// ImportDeclaration (value and `import type`, bare `import '…'`),
// ExportNamedDeclaration / ExportAllDeclaration with a source, ImportExpression
// with a string literal or an expression-free template (`import('…')`),
// TSImportType (`typeof import('…')`) and TSImportEqualsDeclaration
// (`import x = require('…')`). A file that fails
// to parse throws — a boundary check must never pass on an empty list.
// stringLiterals reads the same parse for every string literal a file holds
// (`.tsx` parsed as tsx).
import { parseAst } from 'rolldown/parseAst'

type Node = { type?: unknown; [k: string]: unknown }

// a string literal, or a template with no expressions (`import(\`@x\`)`): its one cooked segment
const literal = (n: unknown): string | null => {
  const l = n as Node | null | undefined
  if (!l) return null
  if (l.type === 'Literal') return typeof l.value === 'string' ? l.value : null
  if (l.type === 'TemplateLiteral' && Array.isArray(l.expressions) && l.expressions.length === 0 && Array.isArray(l.quasis) && l.quasis.length === 1) {
    const cooked = ((l.quasis[0] as Node).value as { cooked?: unknown } | undefined)?.cooked
    return typeof cooked === 'string' ? cooked : null
  }
  return null
}

// One parse per file per test file: the boundary tests walk the same sources
// from several angles (specifiers, literals, words), and re-parsing all of
// server/src and web/src in each test was most of their time. Keyed by name,
// valid only while the text is the same; the walks below only read the AST.
const parsed = new Map<string, { code: string; ast: unknown }>()

function parse(code: string, filename: string): unknown {
  const hit = parsed.get(filename)
  if (hit && hit.code === code) return hit.ast
  let ast: unknown
  try {
    ast = parseAst(code, { lang: filename.endsWith('.tsx') ? 'tsx' : 'ts' }, filename)
  } catch (err) {
    throw new Error(`module-specifiers: ${filename} does not parse: ${err instanceof Error ? err.message : String(err)}`)
  }
  parsed.set(filename, { code, ast })
  return ast
}

/** The specifiers a file loads AT RUNTIME when it is evaluated: top-level
 *  static `import` / `export … from` that survive type erasure. Left out:
 *  `import type` / `export type`, a declaration whose every specifier is
 *  `type`, dynamic `import()` (loaded later, never part of the evaluation
 *  order) and `typeof import()` (a type). What a module cycle is made of. */
export function runtimeImports(code: string, filename = 'input.ts'): string[] {
  const ast = parse(code, filename) as { body?: Node[] }
  const out: string[] = []
  for (const n of ast.body ?? []) {
    if (n.type !== 'ImportDeclaration' && n.type !== 'ExportNamedDeclaration' && n.type !== 'ExportAllDeclaration') continue
    const spec = literal(n.source)
    if (spec === null) continue // a local `export { a }` / `export const …`
    if ((n.importKind ?? n.exportKind) === 'type') continue
    const specifiers = Array.isArray(n.specifiers) ? (n.specifiers as Node[]) : []
    if (specifiers.length > 0 && specifiers.every((x) => (x.importKind ?? x.exportKind) === 'type')) continue
    out.push(spec)
  }
  return out
}

export function moduleSpecifiers(code: string, filename = 'input.ts'): string[] {
  const ast = parse(code, filename)
  const out: { at: number; spec: string }[] = []
  const take = (n: Node, spec: string | null): void => {
    if (spec !== null) out.push({ at: typeof n.start === 'number' ? n.start : 0, spec })
  }
  const walk = (n: unknown): void => {
    if (n === null || typeof n !== 'object') return
    if (Array.isArray(n)) {
      for (const c of n) walk(c)
      return
    }
    const node = n as Node
    switch (node.type) {
      case 'ImportDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
      case 'ImportExpression':
        take(node, literal(node.source))
        break
      case 'TSImportType': {
        // oxc: `source: Literal`; older ESTree-TS shapes: `argument: TSLiteralType{literal}`
        const arg = node.argument as Node | undefined
        take(node, literal(node.source) ?? literal(arg?.literal))
        break
      }
      case 'TSImportEqualsDeclaration': {
        const ref = node.moduleReference as Node | undefined
        if (ref?.type === 'TSExternalModuleReference') take(node, literal(ref.expression))
        break
      }
    }
    for (const k of Object.keys(node)) {
      const v = node[k]
      if (v !== null && typeof v === 'object') walk(v)
    }
  }
  walk(ast)
  return out.sort((a, b) => a.at - b.at).map((x) => x.spec)
}

/** Every string a file spells as a literal, in source order: each string
 *  `Literal` anywhere in the tree (expressions, TS literal types, JSX
 *  attribute values, import sources) and each template with no expressions.
 *  Comments and JSX text are not literals, so they never count. */
export function stringLiterals(code: string, filename = 'input.ts'): string[] {
  const ast = parse(code, filename)
  const out: { at: number; value: string }[] = []
  const walk = (n: unknown): void => {
    if (n === null || typeof n !== 'object') return
    if (Array.isArray(n)) {
      for (const c of n) walk(c)
      return
    }
    const node = n as Node
    if (node.type === 'Literal' || node.type === 'TemplateLiteral') {
      const v = literal(node)
      if (v !== null) out.push({ at: typeof node.start === 'number' ? node.start : 0, value: v })
    }
    for (const k of Object.keys(node)) {
      const v = node[k]
      if (v !== null && typeof v === 'object') walk(v)
    }
  }
  walk(ast)
  return out.sort((a, b) => a.at - b.at).map((x) => x.value)
}

/** Every word a file's CODE holds, comments excluded: identifier names
 *  (JSX ones too), string literal values, every template chunk (cooked) and
 *  JSX text — what the engine-name ratchet reads (harness-boundary.test.ts). */
export function codeWords(code: string, filename = 'input.ts'): string[] {
  const ast = parse(code, filename)
  const out: { at: number; value: string }[] = []
  const walk = (n: unknown): void => {
    if (n === null || typeof n !== 'object') return
    if (Array.isArray(n)) {
      for (const c of n) walk(c)
      return
    }
    const node = n as Node
    let v: unknown = null
    if (node.type === 'Identifier' || node.type === 'JSXIdentifier' || node.type === 'PrivateIdentifier') v = node.name
    else if (node.type === 'Literal') v = node.value
    else if (node.type === 'TemplateElement')
      v = (node.value as { cooked?: unknown; raw?: unknown } | undefined)?.cooked ?? (node.value as { raw?: unknown } | undefined)?.raw
    else if (node.type === 'JSXText') v = node.value
    if (typeof v === 'string') out.push({ at: typeof node.start === 'number' ? node.start : 0, value: v })
    for (const k of Object.keys(node)) {
      const c = node[k]
      if (c !== null && typeof c === 'object') walk(c)
    }
  }
  walk(ast)
  return out.sort((a, b) => a.at - b.at).map((x) => x.value)
}
