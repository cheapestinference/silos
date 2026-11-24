# compose.py — the Silos briefing for ONE session, from plugin/context/briefing.d/.
#
#   python3 compose.py --has team-plan,heartbeat               the whole briefing
#   python3 compose.py --has team-plan --budget 6000           the briefing in at most 6000 characters
#   printf '%s' "$dynamic" | python3 compose.py --hook [--static [--slim]] --has … --cap 9500
#                                                              the SessionStart hook's JSON output
#
# A session is never told to use a skill it does not have: base.md names no
# skill; each skill-bound rule is a pair of fragments,
# <name>.with.md (points at the skill) and <name>.without.md (the minimal
# recipe, no skill). Order: base, then FRAGMENTS below; each part's trailing
# newlines dropped, joined by "\n", no final newline. The server composes the
# same bytes (server/src/harnesses/briefing.ts briefingText — keep both in
# step; server/test/briefing-compose.test.ts compares them). A part that
# cannot be read is left out; nothing is printed when none can.
#
# What a rule needs only now and then (the other automation triggers, the
# task file's format) lives in plugin/context/reference/ and the rule names
# the file: a fragment writes `{{context}}` and both composers put the real
# path of plugin/context there, so the agent can read it from any folder.
#
# --slim: a session with no Silos identity ($SILOS_AGENT_TOKEN empty — a
# claude a person started by hand) cannot act on the API recipes, so it gets
# plugin/context/hand-started.md instead of the briefing: what Silos is and
# the few rules that still apply to it. Hook-only; the server never
# composes it (every process Silos launches has its bearer).
#
# The hook's cap. Claude Code keeps a hook's additionalContext only up to
# 10,000 characters; beyond that the model gets a file path and a 2,000-
# character preview instead of the rules. So what the hook emits is ALWAYS
# under the cap (--cap; session-start.sh passes 9500, a margin for how the
# engine counts): the dynamic part (roster, inbox, the /clear reminder —
# each bounded where it is rendered) comes first in the budget, and the
# briefing gets what is left (--budget):
#   1. the whole briefing, when it fits;
#   2. else every rule's first line stays, and each rule's DETAIL (its
#      continuation lines: recipes, formats) is kept in order while it fits;
#      a detail that does not fit becomes one line naming the file it lives
#      in — the agent reads it there when it needs it;
#   3. else whole rules fold, the last first, into their bold title and the
#      file that holds them;
#   4. else (a budget no real composition reaches) the header and one line
#      naming every part's file.
# A last guard cuts at a line boundary, so nothing over the cap is ever
# printed. The server's routes (a system-prompt append, OpenCode's context
# file) have no such cap: they always carry the whole briefing.
import json
import os
import sys

FRAGMENTS = ['team-plan', 'vault-secrets', 'heartbeat']
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'context', 'briefing.d')
SLIM = 'hand-started.md'  # beside briefing.d, in plugin/context
CONTEXT_MARK = '{{context}}'


def units(s):
    """Length as the engine (JavaScript) counts it: UTF-16 code units."""
    return len(s.encode('utf-16-le')) // 2


def context_dir(root):
    """plugin/context as the path a fragment's {{context}} stands for: the
    real path of briefing.d's parent (the server writes the same one)."""
    return os.path.realpath(os.path.join(root, '..'))


def read(path):
    try:
        with open(path, encoding='utf-8') as f:
            text = f.read().rstrip('\n')
    except Exception:
        return ''
    if CONTEXT_MARK in text:
        # a fragment lives in briefing.d, the slim briefing beside it
        here = os.path.dirname(os.path.abspath(path))
        base = here if os.path.basename(path) == SLIM else os.path.join(here, '..')
        text = text.replace(CONTEXT_MARK, os.path.realpath(base))
    return text


def compose_slim(root, budget=None):
    """The slim briefing (see the top), whole or cut at a line boundary."""
    text = read(os.path.join(root, '..', SLIM))
    return text if budget is None else cut(text, budget)


def part_paths(has, root):
    paths = [os.path.join(root, 'base.md')]
    for name in FRAGMENTS:
        paths.append(os.path.join(root, '%s.%s.md' % (name, 'with' if name in has else 'without')))
    return paths


def compose(has, root):
    parts = [read(p) for p in part_paths(has, root)]
    return '\n'.join(p for p in parts if p != '')


def pointer(path):
    return '  The rest of this rule (its recipes and formats) is in `%s` — read it before you act on this rule.' % os.path.realpath(path)


def blocks(text):
    """A part as [(head, detail)]: the lines before its first rule (head
    only), then one block per rule — a line starting "- **" is the rule,
    every line after it until the next rule is its detail."""
    out = []
    head, detail = [], []
    for line in text.split('\n'):
        if line.startswith('- **'):
            out.append(('\n'.join(head), '\n'.join(detail)))
            head, detail = [line], []
        elif head and head[0].startswith('- **'):
            detail.append(line)
        else:
            head.append(line)
    out.append(('\n'.join(head), '\n'.join(detail)))
    return [(h, d) for h, d in out if h != '' or d != '']


def compose_within(has, root, budget):
    """The briefing in at most `budget` UTF-16 units (see the top)."""
    full = compose(has, root)
    if units(full) <= budget:
        return full
    # every rule's first line; each detail inlined in order while it fits
    pieces = []  # [head, detail, pointer] per block; detail None = no detail
    for path in part_paths(has, root):
        text = read(path)
        if text == '':
            continue
        for h, d in blocks(text):
            pieces.append([h, d if d != '' else None, pointer(path)])

    def render(inline):
        lines = []
        for i, (h, d, p) in enumerate(pieces):
            if h != '':
                lines.append(h)
            if d is not None:
                lines.append(d if inline[i] else p)
        return '\n'.join(lines)

    inline = [False] * len(pieces)
    if units(render(inline)) <= budget:
        for i, (_, d, _) in enumerate(pieces):
            if d is None:
                continue
            inline[i] = True
            if units(render(inline)) > budget:
                inline[i] = False
        return render(inline)
    # still too long: whole rules fold into their title and the file they
    # live in, the last rule first (the header and the first rules — where
    # deliverables go, how to schedule, how to message — stay longest)
    for i in range(len(pieces) - 1, -1, -1):
        h, d, p = pieces[i]
        if not h.startswith('- **') or h.find('**', 4) < 0:
            continue
        title = h[: h.find('**', 4) + 2]
        path = p[p.find('`') + 1: p.rfind('`')]
        pieces[i] = ['%s The rule is in `%s` — read it before you act on it.' % (title, path), None, p]
        if units(render(inline)) <= budget:
            return render(inline)
    # the header and where every part lives
    head = pieces[0][0].split('\n')[0] if pieces else ''
    files = ', '.join('`%s`' % os.path.realpath(p) for p in part_paths(has, root) if read(p) != '')
    least = '%s\n\nThe Silos rules for this session did not fit in its start context. Read them before you write a deliverable, schedule work, message an agent or touch `plans/`: %s.' % (head, files)
    return least if units(least) <= budget else ''


def cut(text, cap):
    """The last guard: whole lines while they fit, then one line saying so."""
    if units(text) <= cap:
        return text
    note = '… (cut here: the start context is capped at %d characters)' % cap
    out = []
    used = units(note)
    for line in text.split('\n'):
        if used + units(line) + 1 > cap:
            break
        out.append(line)
        used += units(line) + 1
    return '\n'.join(out + [note])


def parse_has(args):
    has = set()
    for i, a in enumerate(args):
        if a == '--has' and i + 1 < len(args):
            has = {n.strip() for n in args[i + 1].split(',') if n.strip()}
        elif a.startswith('--has='):
            has = {n.strip() for n in a[len('--has='):].split(',') if n.strip()}
    return has


def number(args, flag):
    for i, a in enumerate(args):
        if a == flag and i + 1 < len(args):
            return int(args[i + 1])
    return None


def hook(has, args):
    """session-start.sh's last step: the briefing (with --static) within
    what the dynamic part on stdin leaves of --cap, then the dynamic part,
    a blank line between; the SessionStart JSON on stdout, nothing when
    there is nothing to say."""
    cap = number(args, '--cap') or 9500
    dynamic = cut(sys.stdin.buffer.read().decode('utf-8', 'replace').strip('\n'), cap)
    static = ''
    if '--static' in args:
        left = cap - units(dynamic) - (2 if dynamic else 0)
        if left <= 0:
            static = ''
        elif '--slim' in args:
            static = compose_slim(ROOT, left)
        else:
            static = compose_within(has, ROOT, left)
    ctx = cut('\n\n'.join(p for p in (static, dynamic) if p != ''), cap)
    if ctx == '':
        return
    out = {'hookSpecificOutput': {'hookEventName': 'SessionStart', 'additionalContext': ctx}}
    sys.stdout.write(json.dumps(out) + '\n')


# What a resumed or forked session's context already holds from an earlier
# start: the hook's additionalContext is saved in the transcript as an
# `attachment` record of type `hook_additional_context`, and a compaction
# (a `compact_boundary` record) drops what came before it from the model's
# context. The heading each part starts with is how it is recognized.
# (the briefing's heading, or the slim briefing's).
CARRIED = [('briefing', ('# You are running inside Silos', '# Silos runs on this machine')), ('roster', ('Your fleet (Silos):',))]
SCAN_MAX = 64 * 1024 * 1024  # a transcript longer than this is read from its last SCAN_MAX bytes


def carries(path):
    held = set()
    try:
        with open(path, 'rb') as f:
            # what counts is the END of the transcript (since its last
            # compaction), so a long one is read from its tail: an injection
            # older than that reads as «not held» and is sent again — the
            # safe side (the first bytes would miss a later compaction and
            # leave the session without its rules)
            size = os.fstat(f.fileno()).st_size
            if size > SCAN_MAX:
                f.seek(size - SCAN_MAX)
                f.readline()  # the line the seek landed inside
            for raw in f:
                if b'"compact_boundary"' in raw:
                    held = set()
                    continue
                if b'"hook_additional_context"' not in raw:
                    continue
                try:
                    rec = json.loads(raw)
                except Exception:
                    continue
                att = rec.get('attachment') if isinstance(rec, dict) else None
                if not isinstance(att, dict) or att.get('type') != 'hook_additional_context':
                    continue
                content = att.get('content')
                texts = content if isinstance(content, list) else [content]
                for t in texts:
                    if not isinstance(t, str):
                        continue
                    for name, headings in CARRIED:
                        if any(h in t for h in headings):
                            held.add(name)
    except Exception:
        return set()
    return held


def main():
    args = sys.argv[1:]
    has = parse_has(args)
    if '--carries' in args:
        i = args.index('--carries')
        if i + 1 < len(args):
            sys.stdout.write(' '.join(sorted(carries(args[i + 1]))))
        return
    if '--hook' in args:
        hook(has, args)
        return
    budget = number(args, '--budget')
    if '--slim' in args:
        text = compose_slim(ROOT, budget)
    else:
        text = compose(has, ROOT) if budget is None else compose_within(has, ROOT, budget)
    sys.stdout.buffer.write(text.encode('utf-8'))


if __name__ == '__main__':
    main()
