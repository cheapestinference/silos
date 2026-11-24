# Silos — Product North Star

This document is binding. Every feature, surface, or visual change must name
which moment it serves and how it is reached from the story below. A change
that cannot answer both questions is furniture, and furniture is how this
product drifts into patchwork. When a proposal conflicts with this document,
either the proposal changes or this document does — explicitly, never
silently. HOW each piece works (which mechanism, Claude Code's or Silos')
lives in `docs/architecture.md`, kept current; this document does not
repeat it.

## The job

The user runs a fleet of Claude Code agents that work for them — a business,
a codebase, an operation, or several kept apart on one install. They hire
Silos to:

> know what matters, decide what's theirs to decide, and hand out work in a
> sentence — without living on top of the agents.

## The user

The **owner-operator**: someone who runs a fleet of Claude Code agents for a
business, a codebase or an operation. Silos holds two different bars:

- **Using it asks for no thinking and no documentation.** On any screen a
  newcomer sees what this is, what will happen and what to press. Engine
  and machine terms are never the only way to understand or finish
  something. The console is there for whoever wants it; no daily moment
  requires it.
- **Installing it still takes a technical person, once:** one command in
  a terminal; from there the browser takes over, and an operator someone
  else set up never needs to know a CLI exists.

## The three moments

The product IS these three moments. Everything else is machinery in their
service.

1. **What's happening?** — the pulse: who is working right now, what got
   done today. Context, not a destination.
2. **What's mine to decide?** — THE inbox: agent questions, approvals,
   escalations — **Needs you**, what blocks on you — and the tasks you
   own. On Home they are ONE list named Needs you (your to do and what
   needs you are the same thing): what holds someone up first, then your own
   tasks, each row saying which it is («holds up X» / «yours»). The Tasks
   page keeps its **Yours to do** view, and your own tasks' full list
   (opened from Home's «N are your own») keeps that name (the words are
   fixed under *One vocabulary* in the design rules). One place, dispatchable,
   engine-independent (file-borne signals, never only tool-borne ones).
3. **Direct** — talk to an agent, hand out a task, steer a
   conversation. One sentence in, work happens.

## The four nouns

A newcomer must get the model without study. Silos has **four nouns**:
Agent, Project, Task and Conversation. Other things *look like* a task or a
plan and are **not** Silos nouns.

- **Agent** — someone with a name, a mission and a folder (Silos).
- **Project** — the place where work happens: a folder (Silos) — and the
  edge of what its agents know and reach. Folders that nest are one project.
- **Task** — a piece of work with an owner, a status and its history
  (Silos). A task belongs to a project; a task without a project does not
  exist (no fenced agent could read it). «New task» asks what, who and —
  when the owner doesn't settle it — which project; never which plan.
- **Conversation** — talking to an agent, console or chat. The only noun
  native to Claude Code (and OpenCode): the session is the engine's, Silos
  links to it and never owns or embeds it.

| | What it is | Whose | Where it lives |
|---|---|---|---|
| **Task** | work with an owner (an agent or a person), a status and a history; it outlives the conversation | Silos | one entry of `tasks[]` in a plan file of the project: `plans/tasks.plan.json` (the project's list, no name on screen) or a named plan |
| **Plan** (named) | an optional grouping of tasks that coordinate, and that closes | Silos | `plans/<slug>.plan.json`; when finished it moves to `plans/closed/`. The project's list (`plans/tasks.plan.json`) is a plan file, but **on screen it is not «a plan»** |
| **Conversation** | talking to an agent, console or chat | the engine | Claude Code: `$CLAUDE_CONFIG_DIR/projects/<cwd>/<id>.jsonl`. OpenCode: `~/.silos/agents/<id>/opencode.db`; launched by hand, `~/.local/share/opencode/opencode.db` |
| **Checklist** | the steps of ONE conversation | the engine | Claude Code: TaskCreate/TaskUpdate (or TodoWrite) — on by default only on some models (Claude 5.x models need `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, which only the owner turns on — the «Checklist on current models» switch in Settings › Engines). OpenCode: `todowrite`. Silos reads it from the transcript (or OpenCode's database). **It may not exist** |
| **Plan mode's proposal** | what Claude proposes before acting, for someone to approve | Claude Code only | `$CLAUDE_CONFIG_DIR/plans/<slug>.md` — nothing to do with the project's `plans/` |
| **Execution document** | an engineering plan an agent executes step by step | the project and its skill | wherever the project's planning skill writes it (`docs/**/plans/*.md` by default; a project may name its own house, e.g. `plans/*.md`) and its ledger. It gets **one** task «Execute …» |

**Mind the names:** Claude Code calls its Checklist «tasks», and its
subagent tool was called «Task» (today «Agent»). Neither is a Silos Task.

**The rule:** what the engine writes for itself is the engine's; Silos reads
it and never turns it into a task. What has an owner in the team is a Silos
Task. «Your own steps inside this conversation stay here — in the engine's
checklist when it has one — never as Silos tasks. Plan mode's proposal is
Claude Code's; it never goes in `plans/`.»

**A project is a boundary.** An agent works in one or more folders; the
agents that work in a project of its own are the only ones it knows.
Silos tells an agent about, and lets it reach, only that: those agents
in its roster, messages and asks among them, the tasks of its projects'
plans, the files of its folders. Every other project of the install —
its agents, tasks, files and conversations — does not exist for it.
**Only you open a way across**: an agent asks you and you carry it, or
you give the agent that folder (its Profile › Runs on) — it is then of
that project, in sight of everyone there, and it knows both. What you
set up on this machine and what your Claude account sends stay above
every project: they are the engine's and yours, shown on each project
under «From This machine» and «From Your Claude account» and switched
there.

**Where projects live** (owner 24-11, after an adversarial review). A new
project is born in the **Projects folder** — `~/Silos` unless changed, one
per install, `<Projects folder>/<project>`. A folder you already work in (a
repo with its Claude Code history) is **registered where it is**: nothing is
moved, linked or copied, because Claude Code keys a folder's conversations,
memory and permissions by its absolute path — moving it would start them
over. What a project is, is Silos' record (the agents and their folders,
sealed), never what sits on disk: the Projects folder shows the new ones,
it is never read back to decide anything. Every door that gives an agent a
folder (Welcome, New agent, its Profile, a role pack) goes through one
check, on the folder's real path: never your home, `/`, Silos' or the
engine's own folders, the Projects folder itself, nor a folder that holds
another project or sits inside one — an agent works in its project's
folder, never a subfolder of it; working in two projects is giving it the
second folder. A project keeps its name and place: renaming it would mean
moving it. Removing a registered project forgets it and never touches its
files. No agent may write a file the engine loads from above a project (a
`CLAUDE.md` in the Projects folder would reach every project). Inside a
project, `CLAUDE.md` and `.claude/` are the engine's, shared by every agent
there; `plans/` holds its tasks, `context/shared/` what all its agents
read, `context/<agent>/<topic>/` what each one delivers. An agent's own
identity — name, mission, its «Never» lines — is Silos', kept outside the
project: only you write it.

### How tasks work

A named plan shows as a crumb, a unit in the sidebar, the Tree's groups
(«project › plan › task»), the head of its own narrowed view and, once
finished, a line in Tasks › Done's Plans strip; nowhere else does a plan
earn a surface. In the sidebar, per project, the named plans come FIRST,
each a two-line unit: its full name (and the live dot), then a progress
bar with done/total over ALL its tasks — a dropped task leaves the total —
and «N yours to do». Its chevron unfolds its task tree; its name opens its
house. That fraction is ONE number (`planProgress`): the sidebar's, the
plan head's and the conversation column's. Tasks narrowed to exactly one
named plan (never «No plan», never two) wear that plan's head — the serif
name, the bar, and the one wait that names you, when one does. Finished
plans are hidden everywhere else (owner 24-11: no echo of them in the
sidebar); the sidebar's quiet foot door «Finished plans ›» opens Tasks ›
Done, whose Plans strip lists them from `plans/closed/` — a listing only,
each row opening its file read-only; their tasks join no open list. Every
project has a default list, `plans/tasks.plan.json`: a reserved
name, seeded as `{"title": "", "tasks": []}` (the empty title is on purpose),
never closed, with no name in the UI — its tasks sit under the quiet head
«No plan», AFTER the project's plans (only when it holds open tasks), and
where a task has no named plan the one word for that absence
is «No plan». New task always lands in the project's list; a named plan only
when the owner picks it, or opens New task from that plan.
So a task never needs a plan to exist. Light grouping is done in place with
`parent` inside the list; moving tasks between files is not supported.

**Rotation.** Silos rotates the project's list itself, at most once a day: every task finished (`done` or `cancelled`) before the current month began (UTC) — or finished with no date on record — moves to `plans/closed/tasks-<YYYY-MM>.plan.json`, unless an open task still names it in `dependsOn` or `parent`; its id is listed in `retired`, and links to it keep opening.
The sweep only touches a project list that already exists (it never
creates one), `retired` never shrinks (it is the union of the archives'
ids), and when a task is both live and archived the live one wins. The
archive is titled «<project> — closed <YYYY-MM>» and shows under Tasks ›
Done as a fold «Archived · <month> ›».

**Ref and label:** a task of the project's list is named by its
project everywhere it is said — on screen, in the agent's wakes and claim
answers, in notes: `<project>#t3` (or `<project>/tasks#t3` when the
project also has a named plan called like its folder, which team-plan
forbids). The API, ⌘K and every `plan#id` door take `"plan":"<project>"`
for it; `tasks#t3` (the file's name, kept in task keys and URLs) reads
too. The conversation's column never paints the project's list as a plan card: it
says «Tasks of <project> ›».

**The link task ⇄ conversation is made by the gesture**, never by the
agent's memory: the task's door, assigning a task, waking its owner, and
⌘K in a conversation — «Make this a task» and «Link this conversation to a
task…» (they live in ⌘K; the header shows nothing when the conversation
works no task). When an agent takes a task on its own it calls Silos' verb
**`claim`** — the same curl on both engines:

```
curl -s -X POST ${SILOS_API:-http://127.0.0.1:3210}/api/tasks/claim \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $SILOS_AGENT_TOKEN" \
  ${SILOS_AGENT_ID:+-H "X-Silos-Agent: $SILOS_AGENT_ID"} \
  -d '{"plan":"<slug>","task":"<id>","session":"'"${SILOS_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-$SILOS_CONSOLE_KEY}}"'","turn":"'"$SILOS_TURN"'"}'
```

The recipes have ONE source each, `plugin/context/recipes/claim.sh` and
`release.sh`: this document, team-plan and its briefing
fragment quote them verbatim, the SessionStart hook reads the file, and the
server's prompts take them from `recipeText` — a test holds them equal.
Link + `in_progress` + the task's briefing in one write. The session is the
first one set: `SILOS_SESSION_ID` (a Silos console — with Claude Code the
console's key, unchanged by `/clear`; with OpenCode the `ses_…` id Silos'
plugin sets —, or the conversation above a nested `claude -p`),
`CLAUDE_CODE_SESSION_ID` (a Claude Code console Silos did not launch),
`SILOS_CONSOLE_KEY` (a new OpenCode console before its id is known). A conversation Silos doesn't know yet (a
`claude -c` / `--resume` without an id) answers 200 with `linked: false`:
the task is `in_progress`, nothing is linked, and the owner links it from
⌘K. The bearer is the permission (another agent's task → 403, «message its
owner»; a known conversation of another agent → 403); `X-Silos-Agent` only
gives authorship, never permission. Two warnings ride the answer without
blocking: the conversation is another agent's («it's linked, but Y's door
and wakes won't see it»), and you claimed someone else's task («Y is still
its owner»). Refused with an explained 409 only when another conversation
of that task is live (a turn running, or its transcript moved in the last
~10 min: «Builder's conversation «…» is working it, 2 min ago»); `takeover`
passes and Silos writes the hand-over note in the feed. The owner's
gestures never block — they warn. Editing the plan JSON stays a valid
fallback (no server, old skill copies): it is the same data — the session
id appended to `conversations`, plus `{"session", "released": false}` in
`releases` when its last entry there was a release.
The owner's own link is ONE function on the server, `ownerLink` (⌘K Link,
«Make this a task», the task's door `/work` — resuming or new): a
`pending` or `in_progress` task is claimed (it ends `in_progress`); a
`blocked` or `in_review` one gets the conversation in `conversations`
without its status moving, and the header says «Linked to «title»».
**Both sides show the link**, with the same ☑ and the same words: the
conversation's header «☑ Working on «title» ›» while it is open and
current (+N when several), «Linked to «title»» for an owner's link that
left the status alone, «Worked on «title» · <status>» once released while
the task is still open (no ✓), «Worked on ✓» when done, nothing when none;
☑ on its sidebar row only for open current tasks, and the task page says
who works it now — computed only over its current conversations
(«Nobody works it now — last in «title» 2 min ago»; «no conversation yet»
only when it never had one), the released ones listed under Conversations
in quiet ink with «unlinked · <date>».

**`/clear`: a console is ONE conversation for a task, and letting go is a
gesture**. A console (one tmux) is a single
conversation as far as its tasks go: after `/clear` a new row appears in
the sidebar but it **inherits the link** — the written exception to «the
gesture makes the link»: the gesture was on the console. Releasing is its
own verb, `POST /api/tasks/release`; on screen its one name is **Unlink**
(⌘K «Unlink…», and «Unlink…» on the task page's current row only). The
agent's recipe:

```
curl -s -X POST ${SILOS_API:-http://127.0.0.1:3210}/api/tasks/release \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $SILOS_AGENT_TOKEN" \
  ${SILOS_AGENT_ID:+-H "X-Silos-Agent: $SILOS_AGENT_ID"} \
  -d '{"plan":"<slug>","task":"<id>","session":"'"${SILOS_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-$SILOS_CONSOLE_KEY}}"'","turn":"'"$SILOS_TURN"'"}'
```

The conversation stays in the task's history (`releases[]`, append-only)
and stops working it; claiming again revives it in the same write.
**Release carries a disposition:** as it is, the task goes back to
`pending` (to pick up); `"state"` says `done`, `blocked` or `in_review`
instead (anything else is a 400 that lists them). The status moves only
when the task is `in_progress` and the released conversation was the
**last current** one — if another conversation still works it, it stays in
progress there; otherwise the answer says `"kept": "<status>"`. Releasing
twice changes nothing (`"already": "released"`). The owner's Unlink offers
the same choice («Unlink — leave it *to pick up* · *done* · *blocked* ·
*in review*», to pick up by default) only in that case, and plain «Unlink»
otherwise; «blocked» asks in the same sheet what it waits on (a task, a
person, or «blocked — on you»), so no blocker is born without an owner.
**Accepted, written cost:** while a console is *current* on a task, other
conversations' claims get 409 if it moved in the last 10 minutes, and the
owner's wakes for that task wait while its tmux lives. The remedy is to
release it, and the proof of life offers that on every `/clear` — «This
console was working on «title» (plan#id). Continue it — or, if you are
switching to something else, release it (it goes back to pending; add
"state" to say done/blocked/in_review):» followed by the recipe as a fenced
block, filled with that task.

**Asking and waiting have one rule** (written in team-plan): work for another agent is a task
it owns (+ `dependsOn` if you wait) — creating it wakes nobody; a message is
read at its next conversation, never a wake; to move it now, the owner
starts it (its row says «Not started», and an agent On its own may pick it
up when it next thinks). In a folder that is another agent's of your
projects and not yours, only the message, which the receiver turns into a
task. Outside its projects an agent has nobody to message: it asks you. A wait on a person is their task +
`dependsOn`, or `waitingOn {owner, action, asked}` on yours; `in_review`
only when that task IS the review. A wait on the owner always says what it
asks (`asked`, and `options` when the answer is a choice): Needs you quotes
it — «Finance asks: …» — with the options as one-tap answers, each a note +
the wait cleared + the task back to pending; the agent then moves the way
it moves (below). A review that waits on you (an agent's `in_review` task
whose wait names you) is decided in the row, moment 2: **Approve** closes
it — «Approved.», the wait out, done — and **Send back…** asks what to
change, then the answer goes to the agent with the task back to pending;
nothing is sent unsaid.

**One agent asks another through Silos** (moment 2 for you, moment 3
between agents). The request wakes nobody: the asked agent
sees it at its next heartbeat or conversation start, and its answer lands
on the task and wakes the one who waits. The task page says which of two
it is — «<Agent> sees it at its next beat» while Silos carries it, «you
relay» when it can't (the asked agent has no heartbeat in reach, or the
wait was written by hand): then it is a Needs-you row, «X waits on Y —
<what>», and you are the one who tells Y. A wait an agent wrote on itself
says so — «X wrote a wait on itself — <what>».

**Give it to someone who will move it** (moment 2). A
task nobody moves — nobody's, an archived agent's, the wrong agent's, an
agent's that does not work in its project — is
given on its page: «Give to… ›», beside Drop, lists you and the agents
whose folders hold its project, none picked for you. One gesture: the new
owner, a note saying who it came from, the old conversations let go; an
agent On its own starts on it, one Only when told waits for you («Open Y
›»). Needs you's «N tasks sit untouched» leads there through its lens — no
row gives a task in one tap. A task whose owner works in another project
says so on the row («…its owner works in another project; give it to an
agent of its own»); its Untouched line ends in «Give to… ›» and opens the
page on the form, and the page's banner names the agents of its project as
the way out («Give it to Builder, Finance … or you») — each a pick, Give
still the one gesture. Writing to a closed task of an agent reopens
it; writing on a person's is for the record.

**New work is one gesture** (moment 3). New task, the
agent's first «What should <Name> do first?» and «Make it a task instead»
make the task whole in one request — its details as your first note, the
conversation it came from linked — so nothing is ever half-made, and a
task saved for later wakes nobody until you give it.

**A console open and idle holds its wakes** (moment 2). A wake waits for a console that has its conversation open; when nobody
uses that console for two hours, Needs you says it once per console —
«X's console on «title» is open and idle — N wakes wait for it» — with
Open › and Seen; a new hold comes back on its own.

**What happens without you**. ONE setting decides whether anything happens without
you — the agent's **control**, a ladder of three positions where each step
does what the one below does, and more: «Only when told» (it opens with you;
nothing starts without you — except the automations you set, accepted or
kept) · «On its own» (it starts what you give it, then its next step, and
looks at what arrived as often as its heartbeat beats — any period: minutes,
hours, days, weeks, or never; it needs a mission and its territory on) ·
«Proactive» (On its own and more: it goes looking for work — on each
**round** it checks what its mission covers, creates the tasks it finds, up
to a count a day, and starts them). Proactive is never a third value of the
control: it is On its own plus a setting, chosen only by the owner in «Make
X proactive» (how often it does a round, how many tasks a day, whether a
round uses its tools — skills, MCP servers, connectors and the web, the
connectors named from its project's Tools, the Claude account's included —
or its files only, and what holds it); going back to On its own needs no sheet, and «Only when
told» clears it. A cut agent does no rounds: its control's sentence says
«Rounds are off — it can't create work of its own.» (never the rounds it
won't do) and its Proactive row why, from its record, with «Allow again». The
sheet says before the click what holds a round and what doesn't, and a skipped round is marked on its page with its one door. The same control
(`ControlSwitch`) sits on the agent page, the task page (where «Proactive ›»
is a door to the agent's page) and Give; the agent page counts «Started N times today · max
C ›» (C = `ownTurnsPerDay`, 10 by default: its task starts and runs of its
own automations — never its heartbeat, whose rhythm you chose; and a daily
spend cap, which the heartbeat does count; both set right there, in the
control block's Limits row, named after the ladder they bound — «Starts
without you: up to N a day» · «Spends without you: up to $N a day» («On its
own» is a position, and these caps bind every position that starts
anything); the Needs-you row says «started N times without you today»),
says apart what its heartbeat did today («Heartbeat: looked twice today»,
«Heartbeat: 5 rounds today»)
and the plan it runs on by account. Reaching the max or the cap is a
Needs-you row that says why — what the day was made of, in starts or in
money — with «Let it continue today», «Raise ›» and «See today ›». «Task mode» is said only on its silo's page; the
sidebar marks an agent On its own with ⟳ and a proactive one with its own
mark («Proactive — a round <period>»), nothing when it is only told; Map ›
Org paints the same. What an agent decided after reading outside says so
where you take it back — Decided and Since add « — after reading <tool>». **Waking on
assignment is a gesture, never an inference:** New task is **Give** and its
button says what will happen — «Give to X» «Starts
now, on its own» for an agent On its own; «Give and open console ›» /
«Give and open chat ›» «Opens with you — nothing starts without you» for
one Only when told (a console only when it has one) —, and the gesture is
`assign` (Give after it writes the task; «Start X ›» on the task page), which goes through
the usual wake pipe and never wakes twice. A task another agent creates,
or that its agent releases, is a surface, not a wake.

**Not started; untouched.** A `pending` task with nothing open before it
and no current conversation is **Not started** (Start
= without you, Open = you go in): of an agent On its own, «Not started
— nobody is on it» with «Start X ›» and the door, and Home's Working now
sheet ends with «N tasks not started — nobody is on them ›»
(`/tasks?view=idle`); of one Only when told, «Not started — it opens with X
and you» with «Open with X ›» as the main action (or «Waiting for you to
continue X on it — last in «title» <ago>» when it was in progress), counted
in Yours to do («N tasks not started — they open with you ›») and the
digest. None of these lines enters the pulse's headline or Needs you's
lead; what sits with nobody to move it is one due row, «N tasks sit
untouched — nobody is moving them ›». **Stuck** is said only of a task that
stopped after its tries («Stuck — stopped after 2 tries, so it spends no
more · Start again ›»); one waiting on a dropped task reads «Blocked».

**«You» is only the owner**. Every other person is named:
«Sam's turn», «· Sam's», «Writer waits on Sam: …», «Sam's task «t» unblocks
Writer — chase Sam ›» (a Needs-you row with a note and Done in your name); an
owner who is neither an agent nor the owner reads «<name> — not an agent
here». What comes to you before it is ready is «Coming to you · N», a
quiet fold of Yours to do's sheet, each with its wait in words — never in
the pulse.

## The surface map

- **Home** — moment 1 + 2 fused («the list and what is alive»: one list
  for what needs you and what is yours, the rest drawn rather than
  counted): the date line and the pulse sentence on
  top, then two zones — at a desk the list, wide, and a narrow column for
  what only time can say, «This week» over «This month» and the fleet's
  line; on a phone one column in that order (pulse, Needs you, This week,
  This month, the fleet). **Needs you** is ONE list: first every
  row that holds someone up, in the server's order (questions, approvals,
  failed runs, escalations, a silo's waiting rows…), then the tasks you own
  in their projects' order (idle plans last) — one rule,
  `lib/home.ts homeList`. Each row says in a quiet word which it is
  («holds up Finance · 6m ago», «waits on you» when no agent is stopped, or
  «yours · <project>» / «yours · due Nov 29»). The first rows that hold
  someone up AND carry their question in words (at most two: an agent's
  task waiting on you, a permission) are large cards — who is stopped, the
  question in the serif voice, its answers as buttons (the one-tap answer;
  Approve on a review; Allow / Deny on a permission), else the door to where
  it is answered; a conversation's own question is answered in the
  conversation, so its row is the door there. The rest are plain rows with
  their one action (Done on a task of yours) and the row itself the door to
  where it is settled (its task, its conversation, its agent, its install
  review — or the Needs you sheet for what only that list's buttons decide:
  Approve/Skip, Accept, Seen, Keep them all). About seven rows show; the
  head's counts («12 hold someone up · 3 are your own») open the full lists
  — the Needs you sheet (every row with all its buttons, j k) and your own
  tasks plan by plan (with «as a list in Tasks ›») — and the foot says
  what was left out («5 more holding someone up › · 3 more of your own ›»).
  Empty, it says «Nothing needs you.» large. **Who is at work this
  minute** is said by the pulse and, for the conversations you opened, by
  the sidebar — each agent's conversations by activity, the working one's
  dot blinking; agents and projects keep the order you gave them. A
  conversation Silos opens is not a sidebar row: its work shows in the
  pulse and its Working now sheet, on the page of its cause, and — for an
  automation's run — on the agent's ⚡. Never a third column (`fleet` /
  `waitingNow` are the sidebar's signal). The pulse's sentence «X is working on…» is the
  door to the **Working now** sheet (each conversation with its state, what
  a parked one waits on, the tasks nobody is on, the subagents at work) —
  while the pulse speaks of something else, the quiet line under it carries
  that door as the sheet's counts («1 waiting on something ›»); on that same
  line «N conversations finished today ›» opens the digest's sheet («· while
  you were away» beside it while a digest is unread); the figure counts
  every conversation that finished — a wake, a run, a heartbeat and a
  nested `claude -p` are conversations too — and each row of the sheet says
  which it is on its quiet line, as Working now's rows do. On a phone, which
  has no sidebar, the pulse is the one reading of what is alive. **This week**
  — the last 7 days as bars in two colours, with you / on their own (Usage's
  classes cut in two beside the class drawing — `attendanceDay`,
  `attendanceStacking` — so a day's total is the same on both pages), today
  marked, each plan account's weekly window as one meter (Usage's words
  when it can't be read), the week's tokens quiet under it; the whole
  block is the door to Usage; nothing measured yet: Usage's empty words.
  **This month** (moment 1: the shape of what keeps
  happening) — the miniature whose full plate is **System**: the same
  series, the same colour, two sizes, nothing counted twice. It clones This
  week's grammar — a head with its door «System ›» (the whole block is the
  door), thin marks, today marked, no figure at rest — three 30-day
  sparklines with a quiet label on the left: automations (runs a day, in
  Usage's «Automations you set» hue), executions (the kernel's, in «Task
  starts»' hue) and disk (used of the capacity as an area from the base in
  neutral ink, the capacity a dotted line on top, the last point
  terracotta); a day's figure is under the cursor. Admission rule: only a
  series that moves day to day earns a line here — the census is flat for
  weeks and its history lives in System. A series with nothing in it says
  quiet words («no runs this month»); a read that failed draws nothing but
  the door (`GET /api/vitals`, `GET /api/system`). Under it, quiet, **the
  fleet's line** (moment 1, the census with its kinds said): «● Proactive 2
  · ◐ On its own 3 · ○ Only when told 3» — the mark is ink weight (solid ·
  half · hollow: the control ladder is ordinal, never three hues), each
  kind said with its word and its count, a kind with nobody not listed; the
  cursor names the agents of that kind; under it «8 agents · 5 projects · 6
  automations armed». The project page (Home scoped) carries neither week
  nor month: they are fleet figures, Usage's and System's.
  Home holds no tiles: the projects and agents are the
  sidebar's, the silos and the org the date line's lenses (`map · uses ·
  org · silos ›` — Settings › Silos says each silo's term and opens its
  page), a silo's waiting rows are Needs-you rows, and who is on the
  Claude subscription stays the page's last calm line. The pulse speaks
  by priority (moment 1): «Create your first agent ›» when there is none · who needs you · «X is
  working on <task>» · «X decided something ›» · «All quiet.» (with «Next:
  Mon 09:00, X's heartbeat» only when something comes). Under it, coming
  back after a day — or whenever an agent decided something since your last
  visit (`visits.json`, stamped when you open Home) —, the band «Since
  Tuesday: 9 done, 1 automation ran 7 times, 1 stuck, X decided 2 things ›»
  («<n> agents decided <m> things ›» with several), whose sheet lists each
  decision with its Undo (moment 2: what an agent decided alone goes to its
  page and to Since, never to Needs you); the plan's use by account lives
  in This week's meter. A fresh install opens on
  Welcome instead — a short tour on one card, each step saying in a line
  what the thing is, a rail on top naming only the steps that exist and
  what each has picked; it draws the same birth model as the New agent
  form (`lib/birth.ts`), in two steps where the form has one dialog:
  **Project** first («What are you working on?», and that a project is a
  folder its agents work in, the edge of what they know: a fresh install
  knows none, so it is a new one by name, made at `~/Silos/<project>` —
  the folder said under it —, named like the agent until you name it
  yourself; never a path), **Who** («Who do you want working for you?»:
  its first agent — a loose conversation is not offered here, the «+» menu
  keeps it —: a name,
  how it works, asked and never inferred — the control ladder's three rungs
  as one choice: *When you give it work* (recommended), *Also on its own*
  (it wakes once a week for its mission) or *Proactive* (on its own, and it
  looks for work: born with Silos' default limits — a round every 3 hours
  by day, up to 5 tasks a day —, changed on its page); the two upper rungs
  need a mission and the Task mode silo —, and what it takes care of (the
  mission — optional when it works only when given work, and in every case
  the head of each of its conversations)), **Engine** (only when this
  machine can run more than one — with one, it is that one: every
  registered engine with its version here, the default recommended; one
  this machine can't run is shown with its verdict and can't be picked;
  one line says Silos connects to it, the detail — Claude Code's two
  hooks, which Create installs — lives in Settings › Engines, which
  removes them),
  **Runs on** (the machine's own login first — signing in to Claude in
  place —, another account or an API key, connected right there; on an
  engine with its own sign-in by link, its subscriptions too — a ChatGPT
  Plus/Pro one on OpenCode: open the provider's page, enter the code shown,
  and it is picked once it lands; the same block lives in Settings ›
  Accounts & providers),
  **At start** («What should <Name> start with?» — only on an engine that
  declares what a new project starts with; Claude Code does: *Included* is
  what you set up on this machine, a class with its counts and a box,
  Recommended on — what this machine keeps off named apart, never «always
  on»; unticked, a new project turns each of them off in its own Tools and
  Skills, and this machine is not changed —, and the skills
  your Claude account sends, untickable with one line of what goes; *Add if
  you like* are the plugins and the connectors your Claude account sends,
  each naming what the login sends when Silos knows it; «Create» saves the
  choice for every new project, then creates the agent) and
  **Silos** (the recommended ones — Plans, Task mode, System — shown as
  included, each untickable with what it gives up in one line; the optional
  ones that need no agent offered to add). Every step starts
  on its recommended value and «Create» is live from the first: a name and
  «Create» is still the whole first run, no commands; «Skip for now» makes
  nothing and gives the pane to Home. Every later agent is born the same way: the
  **New agent** form (the «+» menu's New agent, a project's «+ agent»,
  New project's proposal — which opens on its project) asks only Project
  (first: a project Silos knows, or a new one by name, by default named like
  the agent), Name, How it works (the same three rungs), Mission and —
  only when this machine can run more than one — Engine; a door that
  opens it on a project has that project picked. No path is typed (adopting
  a folder from outside is New project's), and the agent's folder is its
  project's folder itself. The rest is chosen later: the model per
  conversation (its Run on panel), skills and files on its page («Give
  <Name> something to work with»), what a project starts with in that
  project's Tools. While the install is still empty the
  sidebar's list holds one door, «Start a conversation or a project», and
  its «+» a quiet terracotta mark, both gone once anything exists. The new
  agent's page proves it is alive («<Name> is reading its mission…», then
  its answer as a card), offers «Give <Name> something to work with» —
  optional files (only it, or shared in its folder), skills from its
  folder's catalog and «Tools from your Claude account ›» (its project's
  Tools, where what the account sends is added one by one or as a whole);
  a folder whose file could not be written at its birth says so there,
  with «Tools ›» — and asks «What should <Name> do first?» (moment 3). There is no separate
  board of conversations: what is working or waiting is Home's Working now
  sheet (opened from the pulse, each with its state), what finished today
  is the digest's sheet (each finished conversation a link), and
  Automations has its own page. An unknown path lands on Home. The Map and its
  Uses and Org views are *lenses* opened from Home's date line
  (`map · uses · org` — one line, one family) and ⌘K, not menu
  destinations — the rail carries no door to them (their
  pages stay; a project's Map tab draws its own). The rail
  keeps three doors: Home, Automations (its own page; its dot
  is the only global signal besides Home's) and **System** — ONE house for
  the machine, and the full plate of Home's This month (the
  machine told in Silos' terms — disk by who eats it, memory, the fleet by
  control over time, runs and executions a day; reached from the rail and
  from This month's «System ›»): what runs on it (the System silo's lists, Processes ·
  Worktrees), **Files** and **Vault**, as tabs of one row under the title
  «System». Files carries its own explorer column inside the page (the
  sidebar stays as it is); each tab keeps its own address (`/silo/system…`,
  `/files`, `/vault`) and ⌘K says «System › Files», «System › Vault». The
  door is native: uninstalling the System silo takes its two lists, never
  the way to the keyring — Vitals then says, quietly, «Processes and
  worktrees come with the System silo — Install ›». Tasks has no icon — the sidebar's Conversations |
  Tasks switch is its door (one Tasks, not two). On the narrow icon
  column the doors stack and the switch, with no room for its words, takes
  the shape of a Tasks icon that opens the page — drawn only there. Any other silo granted the
  `rail` slot adds its door — Support among them (an optional
  silo: installing it brings its door, uninstalling it takes it).
  The Map has two views — `Uses | Org`: **Uses** (`/map`, the landing)
  answers "who actually used this?" — an agents/projects/conversations ×
  models/files/tools/MCP/skills/accounts matrix counted from the
  transcripts, each cell opening the conversations behind it; **Org**
  (`/map/org`) draws who reports to whom from the installed
  reporting silo — present only while one is active, and named wherever
  its sibling views are named (the lens line, ⌘K): a view that exists is
  a view you can reach by name. The Map draws what did happen, never what
  the configuration says could. **Org is one word**: Home's date line, a project's tile, the Map's tab, the way back from a count («‹ Org»,
  from the Map or from the reporting silo's page) and that page's section
  all say «Org»; «who reports to whom» is what it draws, never its name.
  One org per project (folders that nest are one project). A line whose
  two agents share no project is drawn **kept apart** under the org of
  the one that reports — a broken stroke, «out of every chain» — with
  «Redraw ›» to the reporting silo's page; the agent's Who card says the
  same in its «Reports to» line.
  On a phone Home is the first screen: the app opens on it, browser back
  returns to it, the list of agents and conversations is one tap away
  (the date line's panel button), and the lens line hides — lenses are
  desk tools.
- **Usage** (`/usage`) — moment 1 asked of money
  and tokens: what the fleet spent. On top, each plan account's limits
  («default — 62% of its weekly window · 5-hour window 40%») and each priced
  provider's dollars; the period (Today · 7 days · 30 days); one bar a day
  stacked by class — With you (chat and console), Task starts, Heartbeat,
  Its automations, Automations you set, then what fell in no turn Silos
  opened (Unattributed, its conversations listed) and what came before the
  register («before <date>», whole, never backfilled). Views, one dimension
  each: By agent (its five classes under it), By task, By automation, By
  conversation (the 20 largest, by thread), By account. A turn on a plan
  shows tokens and «on plan», never dollars; an engine that can't be
  measured says «not measured on <engine>». Empty: «Nothing ran yet. Usage
  shows here from the first turn.» Its views are the header's tabs and the
  period sits at the tabs' right edge, as Tasks keeps its layout; narrowed
  to one agent the title stays «Usage» and the agent is a removable chip,
  as Tasks says a facet. Reached from Home's This week
  («This week … Usage ›» — always there: with nothing measured yet it
  says Usage's own empty words), an agent's Measured and the caps' rows («See today ›»:
  that agent, today), Automations' header («Usage ›», by automation)
  and ⌘K «Usage»; it is not in the sidebar. Over 30 days, By agent,
  it also says what each agent created **on its own** (created · kept ·
  undone) — beside what it spent; a shorter period
  says it in one line with its «30 days ›» (it is not in Settings — a
  report is not a setting).
- **Scope is the first fact**. Everything an agent loads
  belongs to ONE of four owners — **you** (this machine: your personal
  instructions `~/.claude/CLAUDE.md` and its rules, personal skills,
  plugins and their start hooks, `~/.claude.json` MCP), **the project**
  (the folder: its CLAUDE.md and every other instruction file it carries —
  `.claude/CLAUDE.md`, its rules, `AGENTS.md`, `CLAUDE.local.md` private to
  you —, its auto memory — every agent working there reads and writes the
  same notes —, its skills, its `.mcp.json`, its shared files), **the
  agent** (its own memory file, what it wrote for you, its working files,
  its identity, defaults, territory, secrets, automations, duty, messages)
  and **the conversation** (its pins, what it touched, what it learned).
  What a Claude account sends — its plugins, its connectors (claude.ai), its
  skills — is none of these: it is the **Claude account**'s, said with its
  login, and it loads only in conversations that run on that login. **One
  label per thing** (owner 24-11), the same on every screen: **This
  machine** · **Your Claude account · sam@example.com** · **Project · acme**
  · **Agent · 🛠 Builder** · **Conversation · Fix the importer** — the type
  word first, a bare name never alone, an agent's emoji inside its label
  and no other scope symbol. **Two axes, never mixed** (owner 24-11), the
  frame says which: a thing has ONE ORIGIN — where it comes from —, said as
  «From» + the label («From Project · acme», «From This machine»): a group
  head, the «From» filter, an opened item. A choice about loading it has a
  PLACE — where the choice is kept, which is whom it reaches —, said as the
  bare label: a line of «Where it loads», an item of a bulk ▾, a pill, an
  Upload chip. Sentences keep their plain prepositions («off for Builder»,
  «off in this project», «on this machine»): a phrase is not a label. The
  places: **Your Claude account** (a door — «Manage in claude.ai ›»; Silos
  never writes it) · **This machine** (every project and every `claude` on
  it, the ones you start by hand included, on every login Silos connects) ·
  **Project · <name>** (every conversation in the folder) · **Agent ·
  <name>** (the conversations Silos starts for that agent, in any folder it
  works in — not a `claude` started by hand) · **Conversation · <title>**
  (the starts Silos makes of that one conversation; its column's summary
  says «here»). **The thing is its origin's;
  whether a place loads it is that place's**: a plugin is installed on the
  machine, a connector is connected at claude.ai, and Silos does neither —
  what it switches is whether a place loads it. **The narrower place
  wins**: what your organization manages decides above everything, then
  this conversation, then the agent, then the project, then the
  repository's own `.claude/settings.json`, then the machine — Claude
  Code's own order, never one Silos invents. Plugins, skills and auto
  memory can be turned back on at a narrower place («on in this project —
  off on the rest of this machine»); an MCP server, a connector, what an
  account sends as a whole and every instruction file (your personal
  instructions, a project's files, a file in a folder above) only come off
  — off at any place that reaches a conversation is off there, and the line
  that can't bring it back says so. Each row is drawn with ONE control
  wherever it appears: its switch, and ▾ «Where it loads» — one line per
  place, each with its own switch (below, Project page › Tools). A plain
  click acts on the page's own place and never wider: a project page
  switches the project, an agent's page that agent; one conversation is a
  line only on its agent's page opened from it; every other place is chosen
  in the block, on a line that says whom it reaches. Silos writes in
  `~/.claude` only on two clicks (owner 24-11): a click of a «This machine»
  line, which writes your `~/.claude/settings.json` — never at a birth, on
  a timer, on a plain click or a bulk click at another place —, only its
  own entry, the same switch undoing it; and Save of one of your own
  instruction files, from any page that shows it — its reach on the button
  («Save — for every project on this machine»), confirmed first. «Scope» is a word of the code; on screen it
  is «where». Each thing is shown at its owner's page; a page that shows
  what it inherits says so and links to the house — except an instruction
  file, whose house is the FILE (owner 24-11): every page that shows it
  opens the same editor and may save it, its reach said on Save, and what
  differs per page is only the plain switch. A switch says whom it
  reaches («every agent in this folder»). Without it, four agents sharing
  one project would each show the same notes and skills as "theirs" —
  that is the lie this rule removes.
- **Tasks** — every task, across every project, one
  surface with addresses: `/tasks?view=&agent=&project=&plan=` names the
  view, so a counter lands filtered and Back returns to the list it came
  from (layouts list | board | tree). **The task page is the task's house**
  (`/task/<plan>/<id>`): its crumb is «project › plan» — the plan only when
  there is one, the project's list shows none —; it says who works it
  now («Builder is working on it now ›»); its conversations hang from it, and
  it has ONE door to talk about it, for any agent and not only Task mode
  ones: «Continue in X's console › · or chat», opening the owner agent's
  conversation briefed on the task and linked; on a task you own, Done. Its notes are the task's memory
  AND its channel (a note wakes the bound agent, Task mode), its SDD
  executions hang under it, and Done and next walks the list. A closed
  plan never breaks its links: the task opens read-only. Serves moment 2
  (Needs you and Yours to do rows land here) and moment 1 (what the fleet
  works). **One word per set**: the tabs are Yours to do · Open ·
  Untouched · Done, and «open» means the same set everywhere it is counted
  (the tab, the sidebar's «All tasks · N open», a plan's «N open» in the
  column, Org's counts, the facts line). The head sentence counts the kinds
  apart: «18 open — 13 in 3 plans, 5 in no plan, …» — «in N plans» covers
  only tasks in named plans, the rest are said «in no plan», the two always
  sum to open, and the project's list is never counted as «a plan»;
  «Untouched» is the kernel's stalled flow — its
  address says it too (`view=untouched`) and no copy says «stuck» or
  «stalled». `idle` and `start` are addresses, not tabs: each narrows
  Open, so Open stays lit and the narrowing is a removable chip. Doors: the
  sidebar's Conversations | Tasks switch (Tasks as last left —
  the rail carries no Tasks icon, one Tasks and not two), the sidebar's
  «All tasks · N open» (exactly Open), Home's list and its counts, ⌘K, and
  every `plan#id` reference. The switch's «Tasks» shows the task list AND
  opens the page beside it (a task already open stays); «Conversations»
  brings the tree back and leaves the page alone; its «Now» shows the live tasks and your ready ones, and
  its «N more yours to do ›» opens Yours to do — the set it left out.
- **Agent page** — tabs under the header: **Now · Messages · Automations ·
  Files · Memory · Skills · Tools · Secrets · At start · Profile**. **Messages** holds
  both halves of what passes between it and the agents of its projects in
  ONE list — what it received
  (↙) and what it sent (↗), each with the other side, where it stands in the
  recipient's inbox and the answer it got (the moment: «what did it ask,
  what was it asked, who still owes an answer?», across all its
  conversations, not only the one in view). It scales by narrowing:
  Received/Sent and Open/Answered with counts, «with» chips, a search over
  text and answers, one sentence saying what the list is, date bands and
  pages of 25. What waits on you (handed to you, either way) is pinned above
  with Answered / Seen; no filter hides it. The rule that
  places everything (a Profile tab must not compete with tabs that
  already work as settings): **a thing with a list is edited in its
  list; a value is edited in the card that shows it; Profile holds only
  the agent's own fields.** And the agent page splits by tense (owner
  24-11): **Now is what happens and edits nothing** — what is live, then
  how its unattended work went (its control in words, one door to where
  it is set; its heartbeat's last and next round, Run now, Runs ›; what it
  Decided, with Undo; Measured; what was added Outside Silos; its
  automations' last and next runs, three at most, «All N ›») — then the
  tiles. So **Secrets** is a tab of what it reaches
  (`/agent/<id>/secrets`), beside Skills and Tools; **Automations**
  (`/agent/<id>/control`) is what it does without you, SET — the control
  ladder, its heartbeat's rhythm, Proactive, its **limits** (starts a day,
  spend a day) and every automation you gave it, with «New automation ›»
  (each opens its own page, their one house); and **Profile**, the
  last tab (`/agent/<id>/settings`), is one flat page: its **Mission** on
  top (why it acts, its Never rules, its proposals), then two cards, each
  with its own Edit: **Who** (name, whom it reports to) and **Runs on**
  (engine, model, the voice it answers in, provider, folders, and its
  territory with its switch and its token). Under the folders, one derived
  line — **Works with** «Finance and Ops», per folder when it has several,
  or «The only agent in its projects». Changing its folders says before
  Save what that opens and closes: «Scribe will also work in beta: it will
  know and reach Maker there, open that folder, and may carry what it
  learns between acme and beta. Its conversations still start in acme.» —
  and that it takes effect in new conversations (the ones open now keep
  what they started with). No second level.
  Nouns, never questions. ONE tab at a time; every link (a URL facet, the
  conversation's column) lands on its tab. **Now** is the cover — what is
  alive, then a door line per tab. Memory, Files, Skills and Tools show
  **everything the agent reaches** (show it all, filtered by
  origin), each row with its owner: grouped by origin (the agent · the
  project · Silos · you · each Claude account login). A group head says
  origin and nothing else (owner 24-11): «From» · the label · its count ·
  ONE control on the right — the bulk button where the tab has switches,
  the door to the house where it has none, named for what is there
  («Memory in acme ›», «Skills in <project> ›»; your machine's skills
  «Inventory ›», a plugin skill's item «Tools in <project> ›» to its
  plugin's row; your machine's MCP servers no door — ~/.claude.json is
  read, never written). **No reach words on a head**, no «Own /
  Inherited»: whom it reaches is said on the opened item («From Project ·
  acme — every agent in this folder: Builder · Writer») and on the block's
  lines, where it cannot be read as the button's reach. A qualifier only
  where one origin makes two groups (Memory's «a folder above», «private to
  you», «auto memory»; Files' «told at every start» and «papers of its
  conversations»). **ONE filter, «From»**: «All», then a chip per head with
  its count, the page's own origin first; one origin in the list, no row.
  A second row, «Only», is a condition, not an origin — «off on this
  machine», «off for an agent» (on an agent's page «off for Builder»),
  «need your sign-in», «different in «Fix the importer»», Memory's «type:
  project» and the like —, shown only when a chip has rows; each row counts
  with the other's choice applied, so no number on screen contradicts the
  list. Colour stays only as the key of a bar (At start, Context size),
  beside its label. Yours is the machine's, and Silos
  writes it in `~/.claude` only on the click of a row's «This machine» line
  (every project and every login Silos connects, said and confirmed first)
  or on Save of one of your instruction files (its reach on the button,
  confirmed first),
  but it is no longer only a fact: a project, an agent or one conversation
  can leave one of your servers or personal skills out (a plugin or a
  skill can even be turned back on there), and the foot counts it with the
  rest. What a Claude account sends
  is listed under its login, apart from yours, and counted under «Claude
  account»; a row loads only where the conversation runs on that login. **Tools** opens with «From Agent · <agent>» (tools
  are per agent): MCP servers only this agent
  gets, switched (Turn off / Turn on) on their row, removed on their item,
  added with «Add a tool» in the list — its secrets named by their Secret,
  never typed in; the moment served is shaping what the agent can do, and
  the conversation's column counts them in its one Tools line. Below them, complete, every row the folder loads with its health
  — and **its Tools, Skills and Memory are the house of «this agent»**
  (owner 24-11): the tab says once «A switch here is for <agent>. ▾ on a
  row: this machine, its project.» (opened from a conversation, «… or «Fix
  the importer»»), a row's plain switch turns
  it off or on for this agent alone, and its ▾ opens the same «Where it
  loads» as on the project's page, with the machine's, the project's and
  THIS agent's lines (never another agent's). A row the project loads and
  this agent alone keeps off stays in its group, dimmed, «off for
  <agent> only»; a line a wider place locks (an MCP server the machine
  keeps off) writes nothing — the click opens the block on that line,
  saying why. «Check now» on this page reads as this agent (its login,
  its tools, its own choices). Now's Tools door line says where they
  stand («14 load · 1 didn't start · 14 need your sign-in ›», else «all
  connected») and counts what the agent itself holds.
  Its Skills and Tools show what loads for it, so
  their foot always says what is held back — «2 turned off · 5
  could be added — in <project>» with «Skills in <project> ›», and
  «· 3 off only for <agent> ›» (narrowing the list to them) — present
  even when every folder skill is off. Write a note and Upload start
  on «Agent · <agent>» here — the narrower reach; sharing in the
  project is one click and says so. Files ends with one folded line,
  «Given to conversations», opening the files the owner gave single
  conversations, by conversation («no longer listed» for threads whose
  conversations are gone) — never mixed into the agent's own list (Direct). A plain click here is the agent's own:
  what the agent inherits is SHOWN with its owner and switched FOR this
  agent only; changing it for the project or the whole machine is a line
  of the row's ▾, which says whom it reaches. **Memory** is the house of
  «this agent» for instruction files: «From Agent · <agent>» first (its own
  memory file, added when it has none, and who learned each note where
  known), then every instruction file it inherits in the folder its
  conversations start in, by origin, the same rows as the project's Memory
  (below); a row's plain switch is this agent only, its ▾ its project and
  this agent, never another's, and an «off for <agent> only» row stays in
  place, dimmed. A project's file edited here says its reach on Save
  («Save — for every agent here»), unasked; your machine's files ask
  first. An agent that works in other folders gets one line, no rows:
  «<agent> also works in docs — instruction files there do not load».
  **At start** is what a NEW
  conversation of the agent starts with, MEASURED: the median first-reply total of its last conversations per
  mode — console, chat, automation runs, never mixed (an agent can start at
  ~87k in the console and ~50k in its runs) — split by owner (the seven owners:
  the conversation · the agent · the project · Silos platform · This
  machine · your Claude account · Claude Code, each a bar's colour beside
  its label), then its newest conversation part by part,
  each part opening the exact text it received. Never an estimate. The
  project's name in the header is a door to it.
  Nothing opens over a conversation: an agent thing navigates to
  the agent page and its header carries «‹ <conversation>» (`?from=`,
  survives a refresh); the composer's unsent draft is kept per
  conversation and Esc only cancels a turn on screen.
  **Skills carry the capability grammar** (the rule every dimension
  adopts as it is touched: *available / held / active*, and only states the
  engine truly respects), switched on the project page's Skills for the
  project and on the agent page's Skills for that agent —
  the agent page shows what reaches the agent: Active = the copies in its folder (plus personal
  `~/.claude/skills` and what the Claude account sends, which load in every
  folder unless a place switches one there — the project, the agent, one
  conversation, or this whole machine on its own line),
  Held = moved out of the folder into Silos' store — the engine no longer
  sees it, both engines —, Available = Silos' plugin skills not yet copied
  in. Turning off is real at every place: the project's in its folder
  (agents sharing a folder share it), an agent's or a conversation's
  carried by Silos into every process it starts for them — a real
  per-agent switch, its reach said on its line (a project skill's agent
  line only turns it off; a skill the engine locks — a plugin's, a name
  settings can't store — has inert lines saying why). Settings › Skills
  stays the machine's inventory (where each skill sits on disk, a door per folder to
  its Skills; no switch — only «+ Create» for a new skill). Available is exactly what Add
  can do; a skill merely seen elsewhere (a transcript, another folder, a
  plugin that is off) is never offered. On OpenCode, which loads Silos'
  skills from its own skills path too, a held name is denied at launch
  (`permission.skill`), so held is off there as well.
  **An agent never writes a skill — it proposes it.** The three states say
  whether a skill loads, never who may change it: an agent reads and uses
  an active skill and does not edit it, in any turn. When it wants a new
  skill of its own, or a better version of one its project has, it writes
  the whole skill aside and proposes it; you meet it in Needs you («Builder ·
  changed a skill — support — in <project>»), read every file that would
  load — a changed one opens as its diff against the project's copy, a
  removed one struck — and Accept or Dismiss. Accept puts it in place (the
  copy it replaces goes to the trash) and it loads at the next
  conversation; if either side changed after it was proposed, Accept
  refuses and asks you to read it again. An agent proposes only for its own
  project folders, and never over Silos' own skills.
  **What an agent proposes in a conversation is decided there too.** While
  you talk to it, its proposal (a skill, an automation, its mission) shows
  in that conversation's column as «Proposed here» — what it is, the
  agent's why, Accept or Dismiss, and «Read it all» for the same sheet as
  Needs you — so you never leave the conversation to say yes. It is the
  column, never a window over the conversation, and only the conversation
  it was proposed in carries it; Needs you keeps the row for when you were
  not there. A mission and a command stay «Review ›»: their editor decides.
  **At start** answers "why does it
  write like that?": what every conversation receives before its first
  message, read from disk by its engine and never run — the start hooks
  (plugins, settings, Silos' own briefing) with what their last start really
  added, its instruction files as ONE door line to Memory, their house
  («Instructions — 6 files · ≈ 21k tokens at start · Memory ›»), the output style or the plugin
  standing in for one, and the MCP servers it sees (switched in its own
  Tools for this agent, or the project's — no switches here; «Tools in
  <project> ›»). An engine
  that can't say hides it.
  Its Profile tab holds who it is and what it runs on — with its
  **territory**: whether its fence is on — off, it is still kept out of
  other projects' folders, conversations and memory and of the credentials
  Silos keeps (switched there; the roster in
  Settings › Territory is the fleet's view of the three surfaces, and the door
  for network and private paths), what it works in, its token. No conversation
  section: its conversations live in the sidebar — the sidebar is navigation, and an
  automation is not a place: the agent's own row carries one small ⚡ (only
  when it has automations; muted, terracotta when one failed or waits for
  approval, blinking while one runs) that opens the Automations page
  narrowed to that agent — `/automations?agent=<id>`, the title still
  «Automations», the agent a removable chip (Tasks' grammar; there is no
  `/automations/<agent>` page with an «X's automations» title). Its Now shows three of them and «All N ›» to that same list; the
  conversation column's «all N in Automations ›» lands there too. The rail's Automations door
  carries the same dot across every agent: the tree says where things are,
  the rail says what needs you, Home dispatches. The sidebar lists the
  conversations you opened; one Silos opens lives under its cause and is a
  row only while it is open or a search finds it — an automation's kept
  thread on the automation's page (its row, when shown, carries the muted
  ⚡), the conversation Task mode opened for a task on that task's page, one
  Silos opened for a message in the agent's Messages (✉). A run is never a
  row, and a nested `claude -p` shows in the column of the conversation
  that launched it — Silos knows it is nested by the birth marker its
  SessionStart hook writes, so without the hooks installed (or without an
  agent identity) such a session lists as a conversation of the owner's.
  Bulk pruning in Settings › Maintenance.
  Entrances from a conversation — its header's FIRST line is the agent's,
  its title line the conversation's (owner 23-11, after four review rounds
  with Fable + design): «project › [⚡ Dev │▾]  ✉ N new  ⑂ branch», then the
  conversation's title alone (no seal, no role under it). The pill is the
  agent as one control: seal + name open its page (Now, with the way back);
  its ▾ unfolds the agent's sections at the header's foot, under the
  title and its facts — one row of the page's OWN sections as plain links (the pill already names the agent)
  (`lib/agent-tabs.ts`: same list, order and figures as its tab bar),
  Settings after a «·»; nothing selected, no band. Folded by default,
  remembered per viewer; a fold is not a popup, so Esc never stops there.
  On a phone the ▾ opens a sheet of the same, headed by name and role (a
  row there would hide five of nine behind a scroll). «✉ N new» beside the
  pill only while its inbox holds unread messages and the fold is closed
  (open, «Messages N» is there) — opens Messages; the column no longer
  points at them. When THIS conversation runs on its own pin (provider,
  model or style — the column's runs-on truth, `useRunsOn`), the title's
  facts say «on <model> here» (opens the runs-on panel). And every row of
  the column's Knows opens its tab — Memory, Files, Skills, Tools, Secrets,
  At start: what THIS conversation used of each; the fold says the agent's
  totals — on a conversation each is one summary line, and the tab it
  opens is the one where this conversation's own line switches (below,
  Conversation). Nothing in the column opens Settings: beside the runs-on line a
  door there read as the account's, and the agent's default model and
  account are set in the runs-on panel itself («Also make it <name>’s
  default»).
  The sidebar's ⋯ ›
  Edit and ⌘K «Agent · X › Profile» open Profile. Its
  control (Only when told · On its own · Proactive), its heartbeat's
  rhythm, its limits and its automations are set on its Automations tab;
  what they did is on Now, where the heartbeat is seen alive.
  A door that names a territory to turn on lands on the agent's Profile;
  «Raise ›» lands on the Limits row, on Automations, its editor open.
  Machinery never outranks identity.
- **Project page** — the house of what the folder owns. Tabs **Now ·
  Memory · Files · Skills · Tools · Map** — the agent page's nouns in its
  order (each id is its
  tab's name, `/project/<folder>/<tab>`, no aliases): Now is the Home scoped
  to the folder (pulse, inbox, agents, its plans, orphaned conversations;
  its agents follow the one resolver — an agent whose folder is around
  this one is of it too, and its tile says «from acme»; a nested folder's
  page shows its project's Org);
  **Memory** is the house of «this project» for the one class every
  conversation reads before you say anything: **every instruction file
  Claude Code loads here** (owner 24-11) — your machine's (`~/.claude/CLAUDE.md`,
  «Your personal instructions», and its rules), your organization's, a
  file in a folder above, the project's `CLAUDE.md`, `.claude/CLAUDE.md`,
  its rules, `AGENTS.md` (through a CLAUDE.md, or alone in place of one),
  a subfolder's files, the imports each one names (indented under it),
  `CLAUDE.local.md`, the auto memory index and every note (with who
  learned it where known), each agent's own memory. Moment: Direct — «what
  does it read before I say anything, who wrote it, whom does it reach, and
  can I change it here?». Reached from the project's tabs, an agent's
  Memory head, a door in Settings › Memories. The rows are grouped by
  origin in the engine's load order, each head «From» + its label with a
  qualifier only where one origin makes two groups («From This machine ·
  a folder above», «From Project · acme · private to you», «… · auto
  memory»). A row says, without opening anything: its name · whom it
  reaches by default, muted («every project on this machine», «every agent
  here · only for files matching src/**», «every agent here · the
  conversations you open — not wakes or isolated runs», «with CLAUDE.md»
  for an import) · when it loads (at start, or «when it works under web/»)
  · its weight as last loaded («≈ 2.1k tokens», «on disk» until a start
  names it; amber over Claude Code's own size warning) · the amber phrase
  when places disagree · its switch and ▾. **Places, per file**: the plain
  switch is this project, ▾ «Where it loads» has the project's line and
  each agent's («Agent · <name>»: off for that agent's conversations,
  whichever login runs them, computed at each launch so a login added
  later is covered), and the conversation's line on its agent's page
  opened from it. An instruction file only comes off — the file itself is
  untouched («off in this project»; another settings file that already
  keeps it out is named instead, a fact with no switch); there is never a
  machine line for one: for the whole machine it is the file itself,
  edited from this row or in Settings › Memories. Auto memory is the one
  override: it can be off on this machine and on in a project, and its
  machine line says the whole of it and asks first («No project on this
  machine reads these notes or writes new ones — the claude you start by
  hand included.»). Rows with no place say why (your organization's
  files, an agent's own memory, a note — the index decides). Off proves
  itself like every switch: «still loaded — the switch didn't take» when a
  start after it still read the file, proven from the conversation's own
  record of what it loaded (never a guess: a start with no new record
  changed nothing); a conversation's line keeps its when-words («off from
  its next message», «off when this console is reopened») until a start
  has it. **Edited where shown**: a click opens the
  file's text, and Edit saves it in place, Save naming its reach («Save —
  for every agent here»); your machine's files are edited from ANY page
  that shows them (owner 24-11), Save saying «Save — for every project on
  this machine» and asking to confirm. A row Silos doesn't write says where
  it is changed («Read-only here — …»: a folder above, an import from
  outside, an auto memory moved elsewhere). **«+ Write instructions»**
  picks a fixed place, each naming its file and whom it reaches: Agent ·
  <name> (its own memory, kept by Silos) · Project · <name> (`CLAUDE.md`,
  or a rule — always, or only for files matching …) · Project · <name> ·
  only you (`CLAUDE.local.md`) · This machine (`~/.claude/CLAUDE.md` or a
  personal rule, with the confirm above). One conversation has no file:
  you tell it in its composer. The click writes nothing else, except what
  the option says: «Also adds CLAUDE.local.md to .git/info/exclude» —
  only where the folder's `.git` is a directory; where its git is
  elsewhere, «keep CLAUDE.local.md out of your commits yourself». Only the
  folder a conversation starts in loads its instruction files: an agent's
  other folders don't. **Skills** is where the folder's
  skills are switched and **Tools** where its MCP servers, plugins and
  connectors are — a plain click for this project, each switch saying which
  agents it reaches, and ▾ on every row for the other places; both lists
  use the same «From» heads and filter as the agent page (the
  project's own rows switchable, and yours and the Claude account's
  switchable here, for an agent or for this whole machine — what decides
  elsewhere a fact naming its file). Skills
  gives what the engine itself loads three positions, **on · name only ·
  off** («name only»: listed without its description, lighter, still
  callable): your personal skills, and a group «From Your Claude account ·
  <login>» per login with its head («Turn all off in this project» / «Off
  in this project · Turn all on in this project»; adding one while it is off keeps the others off, as Tools
  does). A name a personal skill and the account both carry is said on both
  rows, and a click that reaches both says so first — each line of its
  «Where it loads» says which copies it reaches. The project's own
  skills keep on and off (held in Silos' store, both engines), with no
  machine line; every skill row carries the same ▾ block as Tools, its
  lines with the three positions instead of a switch, and every owner group
  the same «Turn all off in this project ▾» / «Turn all on in this project
  ▾» with its sentence and «Undo»
  («Turns off 5 skills in this project. 1 is decided elsewhere. Skills
  added later will load.» — the account's group by its head, the project's
  own skills through Silos' store; a plugin's skill is decided elsewhere,
  never touched); **Files** has the
  agent page's two parts, **Files · Artifacts**, each an address
  (`…/files/artifacts`), the Artifacts list in the same box on both pages,
  and «Browse the folder ›» — the Files page rooted at the folder
  (`/files?folder=`), where everything in it is; Map is Uses and Org
  pinned to the folder. A door that names a row («Turn off ›» on a
  server that didn't start, a plugin skill's «Tools in <project> ›») lands
  on its tab with that row open.
  Reached from a sidebar group's name and an agent's header.
  **Tools** is everything the folder's conversations load from outside
  Skills — plugins, MCP servers, connectors — ONE row per thing (what it
  is, where it comes from, whether this project loads it, how its last
  starts went, what it weighed), in origin groups: **From Project ·
  <name>** (its `.mcp.json`), **From This machine** (the plugins you
  installed, each with its servers under it, and your `~/.claude.json`
  servers), **From Your Claude account · <login>** (the plugins and
  connectors that account sends, a group per login), and a row Silos sees load but can't
  place («seen when it last loaded — Silos can't tell where it is set
  up»). Moment: Direct — «what does every conversation here start with,
  and is it working?». Reached from the project's tabs, the agent's Tools
  foot and row doors, the column's alert, At start's «Tools in <project>
  ›», a plugin skill's door, the first minute's «Tools from your Claude
  account ›».
  - **State**, the capability grammar: on (this project loads it) · turned
    off (a thing of yours or the project's, off here) · «could add» (a thing
    the Claude account sends that this project has not added). The word
    follows the origin; nothing is remembered.
  - **Switches** are only keys Claude Code documents, the same key at every
    place — a plugin (`enabledPlugins`, an account one as `<name>@synced`),
    a plugin's server or one of yours or a connector (`deniedMcpServers`),
    a project server (`disabledMcpjsonServers`) — kept where the place is:
    **Project · <name>** in `<folder>/.claude/settings.local.json` (kept out of
    git via `.git/info/exclude`); **This machine** in your
    `~/.claude/settings.json`, only on a click of its line; **Agent ·
    <name>** and **Conversation · <title>** kept by Silos and carried into every process
    it starts for them («kept by Silos»). Never `~/.claude.json`, `claude
    mcp remove`, an install or uninstall, the repository's
    `.claude/settings.json`, an extra login's file by hand, or claude.ai. A
    plugin brings what it carries — its servers come on with it, as in
    Claude Code — and each of its servers is a row of its own, switched
    alone. The tab says once what its plain switch reaches — «A switch here
    is for this project — Builder · Writer. ▾ on a row: this machine, or one
    agent. New conversations only.» — never a pill per row. A plain click is this project: off turns it off
    here, on turns it back; where a wider place still keeps it off, a plugin
    is turned on HERE, and an MCP server or a connector can't be — the block
    opens on the line that holds it, saying why. A change only reaches NEW
    conversations, said beside it; unattended turns carry it too — a run
    loads what the screen says, and never more (a heartbeat takes no «on»
    from any place).
  - **Where it loads** — ▾ beside every row's switch opens the row's places,
    broadest first, one line each, one layout on Tools and Skills: the
    place's label and its state on the first line, whom it reaches and
    where it is kept (muted) below, and «follows this machine» / «follows
    the project» / «follows Builder» when it has no choice of its own.
    **This machine** («every project and every claude on this machine, on
    every login Silos connects») · **Project · <name>** (its agents by name,
    and what you start here by hand — on an agent's page too, where it
    switches the project, its reach said first) · **Agent · <name>**, one
    line per agent of the project (five or fewer; else the ones with a
    choice of their own, then «Another agent ▾»). An account thing opens
    with «Your Claude account», the login in its reach line
    («sam@example.com — everywhere it is signed in»), and its door, «Manage in
    claude.ai ›» where Silos knows the page (else «changed in claude.ai»),
    no switch. What Silos never writes sits in its place in the order with
    no switch: «Managed settings — your organization turns it off» on top,
    the repository's `.claude/settings.json` between machine and project, a
    plugin's own default, `~/.claude.json` turning one off for this folder,
    Claude Code's own `/mcp` toggle («off in Claude Code»). A line that can't
    take a click shows its switch off and inert with the reason («Off for
    this whole machine — an MCP server can't be turned back on for one
    project»), the line that holds it right above; a folder whose `.claude`
    is a login's config dir keeps its refusal on the project line only; an
    engine older than the one a line's key was confirmed on says so in
    place of its switch («needs Claude Code 2.1.331 · Update ›»). A line
    that reaches more than its words asks first: a namesake it reaches, a
    server several plugins ship, the machine's «off» («Turns it off in every
    project on this machine and every login Silos connects — 3 projects
    load it now»; a login that didn't follow is named after). A
    conversation is a line with a switch only on its agent's page opened
    from it («‹ Fix the importer» in the header): the block's last line,
    «Conversation · Fix the importer». Opened any other way, where one
    differs the block ends on a fact and a door to it, «Also off in «Fix
    the importer» ›» — the door opens this tab from that conversation.
  - **One phrase when the places disagree**, on the row, itself a door to
    the block on the line it names: «off in this project» · «off on this
    machine» · «on in this project — off on the rest of this machine» ·
    «off for Builder» («off for Builder and Writer», «off for 3 agents») ·
    «only Builder loads it» · on an agent's page «off for Builder only» ·
    «off in «Fix the importer»» / «on only in «Fix the importer»» · a
    fact's own words («off — set in .claude/settings.json», your
    organization). Places that agree say nothing. The «Only» row carries
    the removable chips (Tasks' grammar): «off on this machine · N», «off
    for an agent · N», «need your sign-in · N» — there is no machine Tools
    page: the machine is a line of every row, and the chip lists what it
    holds.
  - **All / nothing**: the head of each origin group, and of the tab,
    carries a button that **names its place** (owner 24-11) — «Turn all off
    in this project ▾» / «Turn all on in this project ▾» on a project's
    page, «Turn all off for Builder ▾» on an agent's —, so the origin head
    beside it is never read as its reach; ▾ lists the other places with
    the labels and reach words of the block («This machine — every project
    and every claude on this machine…», «Agent · Builder — the conversations
    Silos starts for Builder», and on a page opened from a conversation
    «Conversation · Fix the importer — only this conversation»). Before the
    click it says what it reaches and what it can't — «Turns off 23 things
    for Builder — 4 plugins, 14 MCP servers, 5 connectors. 2 are decided
    elsewhere. What you set up later will load.» — and asks; it writes ONE
    change at that place (an account group uses its head, which also covers
    what the account sends later). After it, «Undo» on that head puts back
    exactly what the click changed, while the place still reads as the
    click left it — kept across a restart of Silos, replaced by the next
    bulk click there. A single switch needs none: it is its own undo.
    **«Make it Builder’s alone»**, a verb beside an agent's line (its link
    and its confirm button), is the same family of click — one gesture for
    «this is Builder's alone», said first: for a plugin or a
    skill «off in this project, on for Builder — an agent added later won't
    load it»; for an MCP server or a connector «on in this project, off for
    Writer and Helpdesk — an agent added later WILL load it».
  - **Origin heads**: each Claude account group opens its plugins and its
    connectors under a head with the origin's own switch — «Off in this
    project» · «Turn all on in this project» / «Turn all off in this
    project» — and, while it is off and has
    nothing to list, «See what it sends ›». **Adding one thing never turns
    on another**: «Add» on a row whose origin is off says first «Adds only
    <name> — the others stay off; what your Claude account sends later will
    load here» and asks to confirm; the head closes it again. A head has
    its places too (its own ▾): the account's door, this machine, this
    project, each agent; adding one thing at a place whose head is off
    keeps the others off at THAT place, and a head a wider place keeps off
    locks the narrower lines («open it for this machine first»). Only the
    machine's «off» moves anything, so it says it and asks: for plugins and
    skills «Stops the download for this machine's Claude and every account
    Silos connects. Claude Code moves the copies it had synced to its trash
    (deleted after its retention period) and downloads them again when you
    turn this back on.»; for connectors «Neither this machine's Claude nor
    any account Silos connects fetches or connects them.» A head the
    machine keeps off says «Off on this machine», never «in this project».
  - **What a plugin carries**, opened: its skills, slash commands, subagent
    types, hooks (how many, on which events, what its start hook added), MCP
    servers, placeholders, LSP servers, output styles — names and counts. A
    **placeholder** is a server a plugin declares with no address: it leaves
    that tool to a connector of your Claude account and points at it; two
    plugins naming one address are «the same server as» the first. Neither
    is ever a failure.
  - **Health**, for servers and connectors, each saying how it was read
    («read 2h ago, in a chat of Builder» · «in a run of Builder» · «in a
    check» · «from start notices — they name some failures, not all»):
    connected (with its tool count) · **needs your sign-in** · **didn't
    start** — the engine's reason, how often, since when («the last 12
    times · since 3 Nov», «3 of the last 20 times») — · **still
    connecting** · **off in Claude Code** (the engine's own toggle, its file
    named) · not read yet. A failure never switches anything: it is said,
    counted and offered off. **«Check now»** in the head is the owner's
    click and only that — one per login the folder's agents run on, its cost
    beside it: Silos starts one `claude` in the folder, sends no prompt,
    reads its servers and closes it; no timer, never at a birth or after a
    switch. A project where only consoles ran says its health comes from
    their start notices, with «Check now ›».
  - **Sign-in has a door**: a row that needs your sign-in offers «Sign in ›»
    — a new real console of an agent of the project (the one whose
    conversation saw it waiting, when it starts there), the only place
    Claude Code hands a server its sign-in; above the console, the ask for
    that server with «Copy» — the owner sends it (Silos never types for
    them), Claude gives a link, and when the browser ends on a connection
    error (it is not on the machine running Claude Code) its address is
    pasted back into the console; Silos sees no credential. A server known
    only by its tool id offers «/mcp in a console ›», the same console with
    Claude Code's own menu. A claude.ai connector offers «Connect in
    claude.ai ›», where connectors are connected. «need your sign-in» is a
    removable chip that narrows the list to them.
  - **Weight**: what each row took at the newest measured start in the
    folder (a plugin: its parts and its servers); a plugin this project
    doesn't load, opened, says what it would add («Would add about 2.1k
    tokens to every start — Claude Code’s estimate»). Nothing measured,
    nothing shown.
  - **A switch proves itself**, per place: a reading taken after a switch
    that still lists the thing puts an amber line under its row, naming the
    place — «still loaded — the switch didn't take · read 20 min ago, in a
    chat of Builder», «still loaded for Builder — the switch didn't take»,
    this machine's —, and the other way for a plugin's own «on», «didn't
    load for Builder — its own “on” didn't take»; the block's line says it
    too. Only a reading the place reaches, started after THAT place last
    changed, counts: an agent's line by that agent's conversations, the
    machine's by a reading where nothing narrower turns it back on. Its way
    out is «Check now ›» (on an agent's page, as that agent), or the
    group's head for an account item; never a fix made for him. A
    conversation has no check: its next start is its proof, and until then
    its row says «from its next message» — pending is never «didn't take».
    Health and weight stay the project's: a reading of an agent or a
    conversation that holds the row is skipped, never «not read».
  **OpenCode** has the same places with its own carriers: **This machine**
  is its global `~/.config/opencode/opencode.json(c)` — switched only while
  that file is plain JSON (one with comments is named and refused:
  rewriting it would lose them) —; **Project · <name>**, **Agent · <name>**
  and **Conversation · <title>** are kept by Silos and carried into every OpenCode
  process it starts («the conversations Silos starts here» — the folder's
  own `opencode.json` is the repository's, a fact on its line, never
  written); a managed config and `OPENCODE_PERMISSION` sit above every line
  as facts. Its MCP servers switch at every line, a skill only off; it has
  no account place, no health and no proof, said in one line.
  **What a new project starts with is set by origin, once, at its birth**
  (the first time a folder is given to an agent of an engine, as its folder
  or an extra one): what you set up on this machine loads — except what
  this machine itself keeps off, named —, and the project switches any of it
  item by item. It is a class of its own, Recommended on (nothing changes
  for an install with one business); off, the birth writes, in the new
  folder's local settings and nowhere else, the per-item «off» entries
  «Turn all off in this project» writes, for what exists at that moment —
  what you set up later will load. No control writes `~/.claude` for it,
  and Silos never guesses which project a machine thing belongs to. What
  your Claude account sends
  follows the install's choice — Silos recommends its plugins and
  connectors off and its skills on. A choice already in the folder's file
  wins, a project that already exists is never changed, and undo is the
  group's head in Tools. It is a project's thing, never asked when an
  agent is born: the New agent form says nothing of it, and Welcome's At
  start (the first project) counts what the machine loads and names what
  it keeps off («12 plugins · 3 MCP servers — 2 off on this machine»).
  The agent page's At start points here — the folder is the one house.
- **Conversation** — the work itself: transcript or console, composer, and
  a context column about THIS conversation: what needs you,
  what is live, what it runs on, what it **started with** — its first
  reply's real token count split by owner, every part opening the exact
  text it received —, the tools it has NOW on the account it runs on,
  replayed from its own transcript and said when another claude outside
  Silos wrote its last start (each fact once: Context size keeps only
  their count, a door to Knows › Tools, where they are listed); what it produced; its subagents
  («Subagents»), the `claude -p` runs it launched («Nested runs»), what it
  sent to other conversations and agents («Sent») and what it left running
  on the machine («Processes», each row a door to System); its plans,
  under the label pair «Plan · <name>» («Plans · N» when it works several),
  ONE line each for the OPEN ones (the shared done/total · «N open» · «N
  yours to do» — the very set Tasks › Yours to do shows for that plan;
  the accent still fires only on a task ready for you), the line being
  the door to the plan's view — the column never lists a plan's tasks nor
  marks them done; its finished plans are never lines, only ONE quiet
  «✓ N finished ›» onto Tasks › Done; a plan under its project's
  plans/closed/ is that project's own, never «outside Silos' projects»;
  the project's list is no plan and has no door here (its house is the
  sidebar's «No plan» group) — only this conversation's OWN open loose
  tasks paint in the block, each a row «<project>#tN · title» marked «no
  plan»; **Used here**,
  one folded block with a count line (files · tools · links · events), each
  kind unfolding its own list — what it USED, while what it CAN use is
  Knows. **Knows** says, on a conversation, one summary line per kind as
  THIS conversation loads it — Memory («4 notes · 2 learned here», «your
  instructions off here» while they are, «2 files off here · 1 didn't
  take» for instruction files it keeps off), Files («1 given here · 1 written
  here · 3 told at start»), Skills («9 load · 1 off here»), Tools («12
  load · 2 off here»), Secrets, the agent's Mission — never where a thing
  comes from (its page's list says it). The whole line is a door to its
  agent's tab, opened from this conversation — the column shows a summary
  of each thing and a door to its page: no switch, no fold, no dial, no
  «Turn all off here». **Automations** keeps the column's radius
  dial (owner 24-11: the one filter the column keeps), on «this
  conversation» in every conversation (a wider radius is a moment, never
  remembered). **«This conversation» is switched on its
  agent's page opened from it**: the Tools, Skills and Memory tabs read
  each row as that conversation sees it, and the row's «Where it loads»
  ends on «Conversation · <title>» with its switch (Skills: the
  positions; Memory: on every instruction file and auto memory). When it takes
  effect is said on that line, from the conversation's own record: «off
  from its next message» (a chat; «from its next run» for a thread an
  automation keeps) · «off when this console is reopened» (a running
  console keeps what it started with; a way back to restart it) · «off in
  this conversation» once a start after the click no longer has it ·
  «still loaded — the switch didn't take». The row says it too, «off in
  «Fix the importer»», and the bulk ▾ offers the conversation as a place.
  The plain click stays the agent's; the conversation is chosen on its
  line. A conversation keeps its
  choices across a resume, a sleep, `/clear` and a branch in the same
  project; a fork into another project starts with none. Moment: Direct —
  steering one conversation; reached from its Knows lines, Context size's
  MCP count and a page's «Also off in «title» ›». One house per thing: a file is GIVEN to a conversation in Files —
  its Upload's chips are «Project · <name>» · «Agent · <name>» ·
  «Conversation · <title>» — and there it is listed first («From
  Conversation · <title>»), with «Give to <agent>» and Delete; the column
  has no door of its own for it. The agent's Files tab groups each file by
  origin: the conversation's · «From Agent · <name>» told at every start ·
  … papers of its conversations, told to none · what it inherits. Serves the Direct moment; reached from the
  column's rows (the conversation is the way back).
  The header carries the task it works on, «☑ Working on «title» ›»
  (the four nouns' link; nothing when it works none), and a conversation
  without one shows nothing there — ⌘K offers «Make this a task» and «Link
  this conversation to a task…» (and «Unlink this conversation from
  «title»» when it works one); the column says each plan-shaped thing with
  a label pair, the second word whose it is: «Plan · <name>» (the team's,
  durable) sits ABOVE «Checklist · this conversation» — the engine's own
  per-conversation list by its name, only when it exists, Silos never turns
  it on —, and plan mode's proposal keeps «Plan mode · Claude's plan» and
  its high place, right under what needs you. Its
  «Context size» row says what that size costs: «Each step re-reads
  about this much.» and «X re-read so far.» — the cache reads its replies billed,
  measured, never estimated. At or past half of its model's window (the one
  «% context» uses; unknown → nothing) the row adds ONE quiet line — no
  accent, never Needs you, nothing in the pulse — «Past half of its context
  window.» with one door: working a task of its agent, «Continue in a new
  conversation ›» (a new conversation briefed from the task takes it; this
  one is unlinked, the task's status kept); working none, «Make this a task»
  (⌘K) to continue it in a new one. Chat and console alike. The same row
  carries the conversation's ONE alert about its tools, from THIS
  conversation's own reading (a chat's status reading, a console's start
  notice): one folded line of names and doors — «similarweb didn't start»,
  «3 tools didn't start», «1 tool didn't start · 14 need your sign-in» —,
  never the error text nor a count (those live on the row), never a
  placeholder or the same server twice. **It counts only live failures**
  (owner 24-11): a thing the owner turned off is never a start problem —
  of course it didn't start —, so a server whose row is off where this
  conversation reads it is not counted, its sign-in not asked. Amber only
  when something live didn't start; when only sign-ins remain the line is
  quiet.
  Unfolded, each failing name has «Turn off ›» to its row in its agent's
  Tools — opened from this conversation, like every door that leaves the
  column, so the page offers «‹ <conversation>» back — and ONE line,
  «14 tools need your sign-in ›», opens Tools narrowed to them (or
  claude.ai, when every one is a connector). A name turned off since, at a
  place this conversation follows, says so instead of offering «Turn off»:
  «similarweb didn't start · turned off — new conversations won't load it»
  (a console still running since that start: «— this console still carries
  it until restarted»), its door to the row kept; when every name is, the
  folded line ends «· turned off» and is no longer amber. A later start of
  the same conversation (a console restarted, a chat resumed) replaces what
  the first one said: a clean start clears the alert. No Needs you row,
  no doorbell, nothing in the pulse. A conversation in a folder that is no
  project gets the names and no door. What a
  relaunch re-reads is said before it is confirmed: «Restart
  console»'s second click and the Run on panel (on a started conversation)
  add «The next message re-reads the whole conversation, about N tokens.» —
  one sentence for both, and none when N is not measured. The
  fan-out is seen while it happens: the Subagents block's header says
  «N started · X tokens» and each row its own tokens — Usage's definition of
  a row's tokens (every kind, cache reads included), never a second one. Each
  fact once per screen; no placeholder rows. The column never
  duplicates a page; it points to it. A plan the conversation *wrote* is
  painted wherever the file lives — authorship over territory; a plan in
  another project's folder names its home («in <project> ›») so the owner sees
  the work and where it belongs. Plans merely read are not the thread's. Its machinery reaches as far as the
  operator dials — this conversation by default (the automation that
  produced it, and *that* run), agent · project · everywhere by hand — a
  handful of rows at most, then a pointer; never hiding without naming
  what a wider radius adds.
  **What it runs on and how it answers have one door**: the column's
  runs-on line opens «Run on» — account, model and the **output
  style**, the voice it answers in — in chat and console alike. Run on
  is THE editor of the three: the composer's model and account
  chips show the value and open it (so does `/model`); effort, fast mode and
  permission mode stay chips, being per turn. Its first row, «Agent default
  — <model · account>», clears the conversation's pins; every group under it
  is a real provider (the machine's account included — picking there pins
  it, never the agent's by stealth); a Claude account takes a model id its
  catalog doesn't list yet; a started chat offers «Next message only», the
  one-shot that rides the next send; a key that is missing says «key needed
  — add it below», where the panel adds it. The runs-on line ends «· pinned
  here» when the conversation pins any of the three, and its gear reads
  «<agent>'s defaults — Profile». The style
  is a cockpit field like the others (agent default in the agent's editor,
  pinned per conversation in Run on, never a separate toggle): the values
  are what the engine offers (Claude Code's built-ins plus the style files
  on disk), a set style rules out any global style plugin for that process,
  an unset one leaves the operator's own config untouched, and a live
  console relaunches to take it. The runs-on line names a non-default
  style in a word. An engine without styles (OpenCode) shows none of it.
  The composer's ▾ «Once at… / Every…» turns the sentence being typed into
  an automation without leaving the conversation — a different moment from
  the automation editor, in its own words and parts: «When it runs»
  is the editor's period (Every…) or its schedule sentences (Once at…),
  «How it runs» its conversation and «Ask me before each run», and «More
  options ›» opens the editor with all of it filled in. It only creates.
- **Background** — what every conversation's subagents
  are doing right now, one page (`/background`; not «Tasks», a name
  that belongs to plan tasks). A lens on the fleet's machinery,
  serving moment 1. Doors: ⌘K
  «Background work» and Home's working sheet — never the rail.
- **Vault** — the fleet's keyring, one page: every secret, who sees
  each one (the Knows scope colors), its age, and what deleting it takes
  away — said in plain words, a name collision never silent. Serves the
  Direct moment (handing an agent what it needs to do its job) and the
  standing audit that comes with keys (rotation). Reached from the rail's
  System door (its Vault tab) and ⌘K; the agent's Secrets tab keeps the per-agent view (what
  reaches THIS agent and why) — the page manages the ring, the tab edits
  its own. The secret is the thing, the Vault the place: «Add a
  secret» starts on the place it was opened from — the agent's Secrets
  adds for that agent and opens the Vault on its project («For all of
  acme ›», `/vault?add=project:<folder>`); from the Vault itself nothing is
  picked for you. An entry for every agent says the projects it reaches by
  name — «Every agent · acme + beta», on its row and before it is saved —
  once the install has more than one. Every agent an entry names is the
  door to that agent's Secrets;
  every row of the Secrets tab that is not its own alone (shared, its
  project's, everyone's) says «in the Vault ›» and opens the Vault on that
  entry (`/vault?entry=<id>`).
- **Settings** — the platform's own settings, tabs grouped by what each
  thing IS (one house per thing, edited where it is shown;
  a tab is never «the rest» or «configuration»; each tab has one address,
  `/settings/<id>` — a bare `/settings` opens Access):
  **You** — Access (who can open this Silos: Google sign-in/out; never the
  machine's Claude login, which is an account) · Appearance (theme, console
  text size, each engine's console colours) · Notifications (Silos' doorbell,
  its devices and the digest hour; then «From Claude Code's app», its phone
  push, written in `~/.claude/settings.json`). **Fleet** — Accounts &
  providers (unattended turns, Claude accounts with this machine's own,
  then «New projects — what they start with»: one line for what you set
  up on this machine and one each for the plugins, the connectors and the
  skills your Claude account sends, each with a switch, «Recommended»
  said on each, and «Back to recommended» when one differs; a line this
  machine keeps off says «Off for this whole machine — new projects can't
  add it · change ›», opening its machine line right there — the one house
  of what a new project starts with, reached from Welcome's At start, an
  account group's head in any Tools and
  ⌘K; it changes new projects only —, key providers, each engine's
  providers) · Engines (per engine: version
  and Update, the compatibility verdict, transcript retention, Silos hooks —
  every «update your engine» door lands here) · Territory (the roster of the
  three surfaces, what holds each — the Files post holds other projects'
  folders, conversations and memory for every agent, territory on or off,
  and each agent says what stayed open and why; under each agent's name,
  what the file fence refused today by the project of the path — «12
  refused in beta ›», «2 refused elsewhere ›» — opening its row on the
  conversations where it happened —, private paths) · Archived agents
  (Restore). **Library** — Memories (in three sections, «This machine» ·
  «Projects» · «Agents»: your machine's instruction files, rules
  included, listed, created and edited here — and from every page that
  shows them, Save confirming its reach —, your organization's read-only;
  a project's files, an agent's memory and auto memory read here, each
  with its door to the page where it is changed — the Skills grammar) ·
  Skills (read-only inventory) · Silos. **This install** — Maintenance (the
  Sessions ledger, the muted folders folded under it) · About. (The vault
  has its own page: with per-agent visibility it is fleet
  operation, not platform config.)
- **Silos** — USE and MANAGE are apart: what of a silo waits
  on you is a row of Home's Needs you (Home lists no silo tiles; the
  date line's «silos ›» opens Settings › Silos, where each says its term
  and opens its page), and managing them
  is **Settings › Silos** (`/settings/silos`, its one address;
  ⌘K «Settings › Silos»; every silo page's «Silos» crumb) — the
  inventory in three groups by where each silo stands in what Silos ships:
  **Recommended** (Plans, Task mode, System — installed with Silos, each
  removable from its page, whose uninstall confirmation says plainly what
  goes with it), **Optional** (Support, Hierarchy, Executions, Heather —
  shipped for the asking, «Install…» on each) and **Installed by you**
  (what you or your agents brought). Each tile says its moment: installed
  (each active silo breathing its live pulse term), waiting for approval,
  not installed, uninstalled with what stayed on disk — and «Install a
  silo…», which takes
  a pasted silo.json too (the owner's own door — a found or written
  silo needs no curl; how to write one: `docs/standard/authoring.md`). Every gesture here, «Reinstall…», «Submit for
  approval…», «Install…» and the paste, submits what it holds and hands
  over to the install dialog; nothing is approved on the page itself. Its
  doors stay out of the rail: the «silos ›» line under Home's pulse, the
  pulse's own silo names, ⌘K, and the growth line (moment 2: an uninstalled
  silo still being written is the owner's to decide). Silos is built of
  silos — everything is one, and every one is removable. What comes from an
  installed silo is never labelled as a silo; only a recommended silo's
  ABSENCE names it, with one quiet door where its feature would be: Tasks
  («Tasks come with the Plans silo — Install ›»), the new agent's «Also on
  its own» («Working on its own needs the Task mode silo — Install ›»),
  System's Vitals (the System silo). The door lands on the silo's install
  dialog (or its page when it is installed but off).
- **Role packs** — moment 3 carried to another fleet: an agent's role
  (mission, instructions, its own skills) leaves as one file from its
  Profile tab («Save as role pack») and arrives through New agent's
  «From a role pack…», which shows what the pack brings (and what it
  cannot carry: machine-bound commands, secrets) before the agent is born.
  A role pack is the identity; a silo is the work — two packages.
- **The doorbell** — moment 1 when the owner is away: Silos rings the
  owner's devices (Web Push) when something enters Needs you that holds
  someone up, and once in the morning with the digest. Settings › You ›
  Notifications lists the devices and the hour. A ring carries counts and
  kind words only, never a name or a row's text. It needs the page on
  HTTPS (or localhost) for the browser to subscribe; the keys are
  generated once into `~/.silos/push/`.
- **The seal** — Silos' own control files (and the engine configuration
  it owns) changed by someone other than Silos become ONE Needs you row
  that names the file and what changed, with «Keep the edit» or
  «Discard» — never a silent revert, never a silent adoption. What the
  engine changed in its own configuration is listed, not asked, under
  Settings › Engines.
- **Executions** — when an agent drives a plan with the superpowers
  plugin's subagent-driven development, the plugin's ledger
  (`.superpowers/sdd/<plan>/progress.md`) is what Silos reads: the
  conversation's column shows the live steps under **Executing** and the
  task shows its executions. An optional integration: without that plugin
  the block simply never appears; Silos never writes the ledger. Hanging
  each execution from its task is the optional **Executions** silo (for
  users of the superpowers plugin), installed from Settings › Silos.
- **The window itself** — Silos is installable as its own app window
  (`manifest.webmanifest`: Chrome "Install page as app", iOS "Add to Home
  Screen"). The operator switches to Silos with Alt-Tab, never hunts for it
  among forty tabs; inside, nothing opens as a tab. Same browser underneath:
  reload, DevTools and the new-version banner work unchanged.

What is deliberately NOT a surface: per-capability tabs that exist because a
capability exists (an empty box with a crown, a second door to what the
sidebar already holds). A capability earns exactly the surface its moment
needs. Sections that answer a question — and say their state on the index —
are not that, and a long page you must scroll through is not a virtue.

## Design rules

- **Summaries are boards; lists are destinations** (no page stacks
  lists one under another). A page that
  gathers several things of different kinds (a project's Now, an agent's
  Now, the automations of several agents, the silos) is a grid of tiles —
  `Tile` / `TileGrid` (web/src/components/Tile.tsx): a name, ONE sentence,
  at most three preview lines, one target. A tile may be a **figure**
  instead of a sentence when its fact is a quantity over time. Where
  several things of one kind each have something to say, they are ONE
  compact list of rows, each a door, rather than a tile each — never a wall
  of sentences. **Home is the exception that proves it**: not a board but two zones — ONE list (Needs you,
  bounded, its full lists one click away) beside what is alive and the
  week drawn; never two lists of the same thing side by side. The list
  itself is one click away: a `Sheet` over the page (Esc closes) or the
  page that owns it. A page whose job IS one list (Vault, Files, Tasks, one
  agent's automations, a silo's records) stays a list — with its filter,
  never a second list stacked under it.
- **State decides hierarchy.** The accent and the top slot belong to what is
  alive. An empty capability renders as a quiet invitation at the bottom,
  never as an empty crowned box.
- **Proof of life.** Every rendered state derives from a real signal (file,
  transcript, process). Nothing simulated, nothing guessed; degraded states
  say so honestly.
- **Everything is on screen** (owner 23-11). No capability exists only as
  an API route, a settings key or a CLI step, and no row ends on «type
  this»: what a row can do is a control on that row — a switch, «Check
  now», «Sign in ›», «Connect in claude.ai ›». A change names the screen
  and the control it ships.
- **The razor.** Agent↔platform channels are files and transcripts. Both
  engines write the same truth; features that only work in one engine are
  half-features.
- **Plan-native.** Tasks — agents' and the platform's own — live in
  `plans/*.plan.json` files (a named plan, or the project's list,
  `plans/tasks.plan.json`) where the column and Tasks can paint them;
  the file stays the truth agents share, no database. If the owner can't
  see where you are, you aren't showing your work.
- **Text has a measure.** Running text ~62ch; timestamps mono; one accent
  voice (terracotta) spent on the single live thing per page.
- **One vocabulary.** Conversations (not threads). Plan (not team plan).
  «Fleet» is the owner's word for the whole install and is never said to
  an agent: to an agent it is «your projects» and «the agents of your
  projects». An
  action keeps its name through the whole flow. Native things keep their
  native names: Claude Code's
  per-conversation list (TaskCreate, Ctrl+T) is the **Checklist** — never
  «Plan» or «Tasks»; plan mode stays «Plan mode · Claude's plan». The three
  plan-shaped things take the scope pairs' grammar, the second word saying
  whose: «Plan · <name>» · «Checklist · this conversation» · «Plan mode ·
  Claude's plan». A **Plan** is only a named plan: the project's list is
  never «a plan» nor counted among plans, and its one word is **«No plan»**
  (the sidebar's head, the column's door, the facet). A plan's progress is
  one fraction everywhere (`planProgress`: done over all its tasks, dropped
  out of the total). A
  **Task** is only Silos' task. **Needs you** is what blocks on you —
  and, on Home, the one list that also carries the tasks you own after it;
  **Yours to do** is the tasks you own (the Tasks page's view, the full
  list of your own) — no «On you», «Yours», «ready on you» as its label;
  counted, it is «N yours to do» (a plan's unit in the sidebar, its line in
  the column), always the set that view would show. Written exceptions: «waits / waiting on
  you» is the verb of Needs you; «Yours» stays the quiet word of a row of
  yours, never the tasks' label.
  - **Fixed phrases**: «in any project» and
    «Reading tasks…» when the subject is tasks; «On a mission» for the mission
    pill; one verb for letting go, «Unlink»; a plan view over the project's list
    with nothing of yours says «Nothing yours to do here»; the briefing says
    «The owner follows its tasks live». The first day works: Tasks always has
    «New task» in its header, and an empty install says «Nothing here yet.
    **Give an agent something to do.**» (the gesture is Give).
  - **One word per thing** (binding, applied on every screen): the fence is «territory» on screen («fence» only in code); what is
    scheduled is an «automation» (never scheduled / recurring / on repeat); the
    ceiling counts «started N times» and queues say «things», never «turns»;
    «Stuck» only for what stopped after its tries, what nobody moves «sits
    untouched»; «Not started», never «Ready»; Start = without you, Open = you go
    in, Give = New task's gesture; «Drop» for cancelling a task (shown «dropped»);
    creating an agent is «Create» everywhere;
    what a conversation loads says its health as «didn't start», «needs
    your sign-in», «still connecting», «off in Claude Code» (the engine's
    own toggle); what the Claude
    account sends and a project has not added «could add»; a skill listed
    without its description «name only»; a plugin's server with no address
    a «placeholder», never a failure; the owner's reading is «Check now»;
    each place and origin has ONE label — «This machine», «Your Claude
    account · <login>», «Project · <name>», «Agent · <name>»,
    «Conversation · <title>» (and «Silos platform», «Claude Code», «Your
    organization», «This repository») — the place is the bare label (a
    line of «Where it loads», a bulk ▾ item, a pill, an Upload chip), the
    origin is «From» + the label (a group head, the «From» filter, an
    opened item), so a group's origin never reads like the place it is
    switched at; «Your Claude account» as a place is a door, «Manage in
    claude.ai ›»; «Your personal instructions» is your machine's
    `CLAUDE.md` on every surface; the conversation's summary in its column
    says «here» («off here», «on only here»), its line says «from its next
    message», «when this console is reopened»; the block is «Where it
    loads», a line without a choice of its own «follows» the one above
    («follows this machine», «follows the project», «follows Builder»);
    the filters are «From» (origin) and «Only» (a condition); a group head
    says origin only — never reach words; the all-or-nothing button names
    its place, «Turn all off in this project ▾» / «Turn all off for
    <agent> ▾»; the gesture for one agent is «Make it <agent>’s alone»
    («Only <agent>» is no label); the phrases are «off on this machine»,
    «off in this project», «off for <agent>», «only <agent> loads it»,
    «on in this project — off on the rest of this machine», «off in
    «<title>»»; a row's reach is muted on the row, its disagreement amber;
    no scope symbols (◌ ◉ ▢ ▲ ⌂ ◇ ⚙) anywhere; «scope» is a word of the
    code, never on screen;
    Welcome's step is «At start»; «starting set» is a word of the code,
    never on screen;
    «heartbeat» appears only in its row and in Automations («X's heartbeat ·
    <period> · Runs › · Rhythm › · Run now»; on its Automations tab its row says «<period> ·
    change», on Now «Runs › · Run now» — Run now is its one verb everywhere,
    «Wake now» only the way out of Sleeping, and every sentence that names
    where its rhythm is set is a door there) — the control says «looks at what
    arrived <period>»;
    a heartbeat **looks** (at what arrived), **thinks** (weekly, about its
    mission) or — Proactive — does a **round** (of what its mission covers),
    never «check» (a task's next check is its own word); bytes changed outside Silos are «set
    aside», «held» is a capability state; never «backlog», «check-in», «Moves on
    its own», «In charge of» or «Task mode» outside its silo's page.
- **Behavior ships as platform or plugin, never as instructions in a
  session's memory.** Skills in `plugin/` are the native contract; versions
  travel with the plugin.
- **A view that exists is reachable by name**. A surface's
  sibling views derive their doors — tab, lens line, ⌘K — from one
  registry, never hand-listed in three places; the next view appears
  everywhere or does not compile.
- **One header, the same on every page** (its options
  never shift). `PageHeader` (web/src/components/PageHeader.tsx) is the only
  page header: crumbs (where the page LIVES — each a door up, never
  history: Back is the browser's) with, on their right, where you came
  from when it applies («‹ <conversation>», a list's «N of M ‹ ›») · seal ·
  title · actions (secondary first, the primary filled and last) · one line
  of facts · tabs. The crumbs by place: conversation = project › agent;
  agent = its project (Anywhere: «Anywhere»); project = «Project»; task =
  project › plan (the plan only when there is one); automation =
  Automations (a run: Automations › automation); silo record = Silos ›
  silo; root pages (Home, Tasks, Automations, Map, Vault, Settings…) none
  — their name is the title.
  Options never move: tabs and view switches sit in their own row,
  left-aligned under the title, and a page's views keep every row so
  switching them moves nothing; variable text lives in the facts line
  (one line, truncates), never beside an option. On a phone the crumbs
  fold to «‹ parent» and the list door sits where the seal begins.

## Scope

Silos is a system for any operator's fleet, MIT-licensed, the whole
product in one install: from source (`README.md`) or the Railway
template (`docs/deploy/railway-template.md`; a VPS with
`deploy/docker-compose.yml`). Installing it takes a technical person once:
Node ≥ 22.13, the `claude` CLI and a terminal (`README.md`); from there the browser opens, checks Claude and its
sign-in («Sign in to Claude ›») and walks through the first agent — its
engine, what it runs on and which silos come with it, each already
picked —, with no command on screen. The operator's own Claude subscription is signed in on
their machine; Silos never stores or intermediates those credentials.

CheapestInference is an optional per-agent provider — a way to keep
working when a subscription limit nears, or a cheaper engine for
unattended work (disclosed in `README.md`).

What this rules in: identity per agent — the deny-rule territory fence
and a bearer per agent, agent identity on the API, agents of one project
that message each other (a message is read at the recipient's next
conversation); the project as the edge of what an agent is told, reaches
and opens, the owner the only one who opens a way across; agents that
wake on an assigned task, and the role's own skills (a plugin per agent,
`agent-state/<id>/plugin`, loaded per launch on both engines). The Claude
ACCOUNT is interchangeable fuel that follows the conversation (it can as
well be another provider), so identity never rides it; the stronger
isolation a `CLAUDE_CONFIG_DIR` per identity (or a container per agent)
would give is out of scope. Then a complete Needs you (failed run, stuck
agent, a message nobody read) that reaches the phone; role templates the
fleet can export and import; and the packaging — install in two minutes,
deploy buttons. Projects kept apart are not tenants — one owner sees
everything, and the wall is the fence's kind: what Silos tells, offers and
does, and what file tools open; not a process that sets out to cross it.
What it rules out in the core: org charts (a hierarchy is
an optional silo — Hierarchy — that an operator installs; without it
there is no Org view, no team lens, and escalation goes straight to the
owner), a task database replacing the plan files (tasks come first, but
the file stays the shared truth), multiple users, a hosted multi-tenant
service, and rebuilding agent runtimes others already give away.

## Contributing

How changes land — branches, tests, reviews — is in `CONTRIBUTING.md`;
security reports follow `SECURITY.md`. Every UX change names its moment;
this file is the reviewer.
