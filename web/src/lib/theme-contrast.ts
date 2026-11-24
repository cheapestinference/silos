// theme-contrast.ts — the contrast rule every look of Silos must hold. The
// rule and its maths live ONCE, in server/src/silos/theme-rule.ts: the kernel
// checks a silo's theme with it at validation (conformance), and here the
// web measures its own tokens with the same function — translated through
// the one mapping from the standard's words to theme.css's names (themes.ts
// WEB_TOKEN), so the pairs come back named as the web names them.
import { checkContrast as checkRule, type ContrastCheck } from '../../../server/src/silos/theme-rule'
import { WEB_TOKEN } from './themes'

export { parseColor, composite, luminance, contrastRatio, CONTRAST_RULE, type Rgba, type ContrastCheck } from '../../../server/src/silos/theme-rule'

// Every pair of the rule, measured on a full set of resolved web tokens
// (custom-property name → CSS value). An unreadable colour yields ratio 0.
export function checkContrast(tokens: Record<string, string | undefined>): ContrastCheck[] {
  return checkRule(tokens, (t) => WEB_TOKEN[t])
}

export function contrastFailures(tokens: Record<string, string | undefined>): ContrastCheck[] {
  return checkContrast(tokens).filter((c) => !c.ok)
}
