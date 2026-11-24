# birth.py — every session presents itself at birth (SessionStart).
#
# Claude Code pipes the hook a JSON object on stdin (session_id, cwd,
# source: startup|resume|clear|compact). When the session runs as a Silos
# agent ($SILOS_AGENT_STATE + $SILOS_AGENT_ID, set by both engines) this
# writes $SILOS_AGENT_STATE/births/<session_id>.json:
#   { sessionId, agentId, parent, cwd, source, at }
# `parent` is $SILOS_SESSION_ID — the session that launched this one (both
# engines set it to the conversation's own id when it is known at launch;
# a `claude -p` an agent runs from Bash inherits it). File-borne, zero
# tokens, no API: the server (births-store.ts) reads these to fold nested
# runs under their parent instead of listing them as the owner's
# conversations. First birth wins (never overwritten); any failure is
# silent — the caller ignores our exit code and still prints the briefing.
import datetime
import json
import os
import re
import select
import sys
import tempfile


def main():
    state = os.environ.get('SILOS_AGENT_STATE') or ''
    agent = os.environ.get('SILOS_AGENT_ID') or ''
    if not state or not agent:
        return
    # stdin is Claude Code's, closed after the JSON; never block a launch
    # on a caller that left it open.
    ready, _, _ = select.select([sys.stdin], [], [], 2)
    if not ready:
        return
    data = json.loads(sys.stdin.read() or '{}')
    if not isinstance(data, dict):
        return
    sid = data.get('session_id')
    if not isinstance(sid, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}', sid):
        return
    births = os.path.join(state, 'births')
    os.makedirs(births, mode=0o700, exist_ok=True)
    path = os.path.join(births, sid + '.json')
    if os.path.exists(path):
        return  # first birth wins: a resume/clear of a recorded id is a no-op
    parent = os.environ.get('SILOS_SESSION_ID') or None
    if parent == sid:
        parent = None  # Silos' own launch names itself; it has no parent
    cwd = data.get('cwd')
    source = data.get('source')
    record = {
        'sessionId': sid,
        'agentId': agent,
        'parent': parent,
        'cwd': cwd if isinstance(cwd, str) else None,
        'source': source if isinstance(source, str) else None,
        'at': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'),
    }
    # atomic, and the marker only ever has ONE name: write a 0600 temp file
    # (mkstemp: exclusive), then rename it into place. Never link-then-unlink:
    # for that instant the marker had two names, and Silos refuses a file
    # with more than one (a hard link into another agent's state looks just
    # like it) — a hook killed in between left it unreadable for good. First
    # birth wins: an existing marker is never replaced (checked again right
    # before the rename; only the same session's hook racing itself within
    # that instant could land second, with the same facts).
    fd, tmp = tempfile.mkstemp(dir=births, prefix='.' + sid + '.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(record, f)
            f.write('\n')
            f.flush()
            os.fsync(f.fileno())
        if not os.path.lexists(path):
            os.rename(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


try:
    main()
except Exception:
    pass
