// slug.ts — the ONE slugifier of names into ids: NFD,
// accents dropped, [a-z0-9-], trimmed of dashes, cut to `max`. An agent's id
// at birth comes from its name here (≤ 32), a role pack's id too (≤ 40).
// '' when the name leaves nothing (the caller says so in its own words).
// (agent-registry.ts's `slug` is something else: a normaliser of message
// senders, which keeps accents.)
export function slugify(s: string, max = 40): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '')
}
