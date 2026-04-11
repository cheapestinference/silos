import * as React from 'react';
import {
  Code2,
  Terminal,
  Layers,
  Calendar,
  Bell,
} from 'lucide-react';
import { stripReasoningTags } from '../../lib/reasoning-tags';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Re-export stripReasoningTags from the canonical source (handles orphan close fragments)
export { stripReasoningTags } from '../../lib/reasoning-tags';

// ============== Inline LaTeX → Unicode ==============
// LLMs often emit $\rightarrow$, $\times$, etc. in chat.
// Instead of adding KaTeX (~300KB), we replace common LaTeX commands with Unicode.
const LATEX_SYMBOLS: Record<string, string> = {
  '\\rightarrow': '→', '\\Rightarrow': '⇒', '\\longrightarrow': '⟶', '\\Longrightarrow': '⟹',
  '\\leftarrow': '←', '\\Leftarrow': '⇐', '\\longleftarrow': '⟵', '\\Longleftarrow': '⟸',
  '\\leftrightarrow': '↔', '\\Leftrightarrow': '⇔',
  '\\uparrow': '↑', '\\downarrow': '↓',
  '\\to': '→', '\\gets': '←', '\\mapsto': '↦',
  '\\times': '×', '\\div': '÷', '\\pm': '±', '\\mp': '∓', '\\cdot': '·',
  '\\leq': '≤', '\\geq': '≥', '\\neq': '≠', '\\approx': '≈', '\\equiv': '≡',
  '\\le': '≤', '\\ge': '≥', '\\ne': '≠',
  '\\infty': '∞', '\\emptyset': '∅', '\\forall': '∀', '\\exists': '∃',
  '\\in': '∈', '\\notin': '∉', '\\subset': '⊂', '\\supset': '⊃',
  '\\subseteq': '⊆', '\\supseteq': '⊇',
  '\\cup': '∪', '\\cap': '∩',
  '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ', '\\delta': 'δ', '\\epsilon': 'ε',
  '\\lambda': 'λ', '\\mu': 'μ', '\\pi': 'π', '\\sigma': 'σ', '\\theta': 'θ',
  '\\phi': 'φ', '\\omega': 'ω', '\\rho': 'ρ', '\\tau': 'τ',
  '\\Delta': 'Δ', '\\Sigma': 'Σ', '\\Pi': 'Π', '\\Omega': 'Ω', '\\Lambda': 'Λ',
  '\\star': '⋆', '\\bullet': '•', '\\circ': '∘', '\\diamond': '◇',
  '\\checkmark': '✓', '\\ldots': '…', '\\dots': '…', '\\cdots': '⋯',
  '\\sum': '∑', '\\prod': '∏', '\\int': '∫',
  '\\langle': '⟨', '\\rangle': '⟩',
  '\\neg': '¬', '\\land': '∧', '\\lor': '∨',
};

// Build regex: match $...$ where content is one or more known commands (with optional spaces)
const LATEX_CMD_PATTERN = Object.keys(LATEX_SYMBOLS)
  .map(k => k.replace(/\\/g, '\\\\'))
  .join('|');
const INLINE_LATEX_RE = new RegExp(
  `\\$([^$]*(?:${LATEX_CMD_PATTERN})[^$]*)\\$`,
  'g',
);

function replaceInlineLatex(text: string): string {
  return text.replace(INLINE_LATEX_RE, (_match, inner: string) => {
    let result = inner;
    for (const [cmd, unicode] of Object.entries(LATEX_SYMBOLS)) {
      result = result.split(cmd).join(unicode);
    }
    // Strip leftover LaTeX formatting commands
    result = result.replace(/\\(?:text|mathrm|mathbf|textbf|textit)\{([^}]*)\}/g, '$1');
    return result.trim();
  });
}

// ============== Message Text Extraction ==============

/**
 * Extract text content from various message formats.
 * Handles: string content, array of content items, and text property fallback.
 */
export function extractMessageText(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as Record<string, unknown>;

  if (typeof m.content === 'string') {
    return m.content;
  }

  if (Array.isArray(m.content)) {
    const parts = m.content
      .map((item: unknown) => {
        if (!item) return null;
        if (typeof item === 'string') return item;
        if (typeof item === 'object') {
          const i = item as Record<string, unknown>;
          if (i.type === 'text' && typeof i.text === 'string') {
            return i.text;
          }
          if (i.text && typeof i.text === 'string') {
            return i.text;
          }
        }
        return null;
      })
      .filter((v): v is string => v !== null);

    if (parts.length > 0) {
      return parts.join('\n');
    }
  }

  if (typeof m.text === 'string') {
    return m.text;
  }

  if (m.content) {
    try {
      return typeof m.content === 'object' ? JSON.stringify(m.content, null, 2) : String(m.content);
    } catch {
      return null;
    }
  }

  return null;
}

// ============== Content Truncation ==============

// Prevents browser freeze on very large messages/tool outputs.
// OpenClaw truncates at 140K (messages) and 120K (tool output).
const MAX_RENDER_CHARS = 140_000;

export function truncateForRender(text: string): string {
  if (text.length <= MAX_RENDER_CHARS) return text;
  return text.slice(0, MAX_RENDER_CHARS) + '\n\n---\n*[Output truncated — ' + (text.length - MAX_RENDER_CHARS).toLocaleString() + ' chars omitted]*';
}

// ============== System Message Detection ==============

export function isStructuredMessage(content: string): boolean {
  if (!content || typeof content !== 'string') return false;
  const trimmed = content.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function getStructuredMessageMeta(content: string): { type: string; icon: React.ReactNode; title: string } | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed.schedule || parsed.cronExpression || parsed.wakeMode) {
      return {
        type: 'cron',
        icon: React.createElement(Calendar, { className: 'w-3.5 h-3.5' }),
        title: parsed.name || 'Scheduled Task'
      };
    }
    if (parsed.payload?.kind === 'systemEvent') {
      return {
        type: 'event',
        icon: React.createElement(Bell, { className: 'w-3.5 h-3.5' }),
        title: 'System Event'
      };
    }
    return {
      type: 'json',
      icon: React.createElement(Layers, { className: 'w-3.5 h-3.5' }),
      title: 'Data Object'
    };
  } catch {
    return null;
  }
}

// ============== Language Style Helpers ==============

export function getLangStyle(lang: string): { color: string; icon: React.ReactNode } {
  const styles: Record<string, { color: string; icon: React.ReactNode }> = {
    typescript: { color: 'text-blue-500 dark:text-blue-400', icon: React.createElement(Code2, { className: 'w-3.5 h-3.5' }) },
    javascript: { color: 'text-yellow-600 dark:text-yellow-400', icon: React.createElement(Code2, { className: 'w-3.5 h-3.5' }) },
    python: { color: 'text-green-600 dark:text-green-400', icon: React.createElement(Code2, { className: 'w-3.5 h-3.5' }) },
    bash: { color: 'text-emerald-600 dark:text-emerald-400', icon: React.createElement(Terminal, { className: 'w-3.5 h-3.5' }) },
    shell: { color: 'text-emerald-600 dark:text-emerald-400', icon: React.createElement(Terminal, { className: 'w-3.5 h-3.5' }) },
    json: { color: 'text-orange-600 dark:text-orange-400', icon: React.createElement(Layers, { className: 'w-3.5 h-3.5' }) },
  };
  return styles[lang.toLowerCase()] || { color: 'text-muted-foreground', icon: React.createElement(Code2, { className: 'w-3.5 h-3.5' }) };
}

// ============== Markdown Rendering ==============

// Lazy reference: CodeBlock is set at init to avoid circular deps
let _CodeBlock: React.ComponentType<{ language: string; code: string }> | null = null;

export function setCodeBlockComponent(component: React.ComponentType<{ language: string; code: string }>) {
  _CodeBlock = component;
}

export const markdownComponents: Record<string, React.ComponentType<any>> = {
  code({ className, children }: any) {
    const match = /language-(\w+)/.exec(className || '');
    const text = String(children).replace(/\n$/, '');
    if ((match || text.includes('\n')) && _CodeBlock) {
      return React.createElement(_CodeBlock, { language: match?.[1] || 'text', code: text });
    }
    return React.createElement('code', {
      className: 'px-1.5 py-0.5 rounded bg-muted text-foreground text-xs font-mono'
    }, children);
  },
  pre({ children }: any) { return React.createElement(React.Fragment, null, children); },
  h1: ({ children }: any) => React.createElement('h3', { className: 'text-base font-bold mt-4 mb-2' }, children),
  h2: ({ children }: any) => React.createElement('h4', { className: 'text-sm font-bold mt-3 mb-1.5' }, children),
  h3: ({ children }: any) => React.createElement('h5', { className: 'text-sm font-semibold mt-2 mb-1' }, children),
  p: ({ children }: any) => React.createElement('p', { className: 'mb-2 last:mb-0' }, children),
  ul: ({ children }: any) => React.createElement('ul', { className: 'list-disc pl-5 mb-2 space-y-0.5' }, children),
  ol: ({ children }: any) => React.createElement('ol', { className: 'list-decimal pl-5 mb-2 space-y-0.5' }, children),
  li: ({ children }: any) => React.createElement('li', { className: 'text-sm' }, children),
  table: ({ children }: any) => React.createElement('div', { className: 'overflow-x-auto my-2 rounded-lg border' },
    React.createElement('table', { className: 'min-w-full text-xs' }, children)),
  thead: ({ children }: any) => React.createElement('thead', { className: 'bg-muted/40 border-b' }, children),
  th: ({ children }: any) => React.createElement('th', { className: 'px-3 py-1.5 text-left font-semibold text-muted-foreground' }, children),
  td: ({ children }: any) => React.createElement('td', { className: 'px-3 py-1.5 border-t border-border/40' }, children),
  a: ({ href, children }: any) => React.createElement('a', {
    href, target: '_blank', rel: 'noopener noreferrer',
    className: 'text-primary hover:text-primary/80 underline underline-offset-2 decoration-primary/40 hover:decoration-primary/80'
  }, children),
  blockquote: ({ children }: any) => React.createElement('blockquote', {
    className: 'border-l-2 border-muted-foreground/20 pl-3 my-2 text-muted-foreground italic'
  }, children),
  hr: () => React.createElement('hr', { className: 'my-3 border-border/40' }),
};

export function renderMarkdown(text: string | undefined | null, mode: 'strict' | 'preserve' = 'strict'): React.ReactNode {
  if (!text) return null;
  const textStr = stripReasoningTags(
    (typeof text === 'string' ? text : String(text)).trimStart(),
    mode,
  );
  if (!textStr) return null;
  return React.createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm],
    components: markdownComponents,
  }, truncateForRender(replaceInlineLatex(textStr)));
}
