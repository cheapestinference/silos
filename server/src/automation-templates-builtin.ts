// automation-templates-builtin.ts — the templates that come with Silos
// (the built-in catalog).
// Distilled from the shapes our own fleet repeats — a watcher, a nightly
// script whose failure goes to the agent, a close on a fixed day, a periodic
// review — with every business specific left as a blank. Generic and in
// English: none names cheapestinference. Plain data in a .ts file so it
// travels inside server/dist with no copy step; checked at boot
// (AutomationTemplates' constructor) and in tests.

export const BUILTIN_TEMPLATES: readonly unknown[] = [
  {
    kind: 'silos.automation-template',
    version: 1,
    id: 'site-watch',
    name: 'Watch a website',
    sentence: '{{agent}} looks into it when {{url}} changes its answer',
    description:
      'Checks the address every 5 minutes without Claude. A run starts only when the HTTP status changes — when it goes down, and when it comes back.',
    params: [
      { key: 'agent', kind: 'agent', label: 'Who looks into it' },
      { key: 'url', kind: 'url', label: 'Address', placeholder: 'https://example.com/health' },
    ],
    automation: {
      name: 'Watch {{url}}',
      agentId: '{{agent}}',
      prompt:
        "The HTTP status of {{url}} just changed (the check's last output is below: 000 means no answer at all). Find out why: is it down, slow, redirecting, or back up? If it is down and the cause is yours to fix, fix it. If it needs the owner, say exactly what is wrong and what they must do. End with one line: up or down, and why.",
      trigger: {
        kind: 'watch',
        every: '*/5 * * * *',
        runWhen: 'changed',
        check: { type: 'command', cwd: '/', command: "curl -s -o /dev/null -m 20 -w '%{http_code}' '{{url}}'" },
      },
      maxRunsPerDay: 12,
    },
  },
  {
    kind: 'silos.automation-template',
    version: 1,
    id: 'nightly-script',
    name: 'Run a script every night',
    sentence: 'Every night at {{time}} run {{command}}; if it fails, {{agent}} looks into it',
    description:
      'The script runs without Claude, so a night that goes well costs nothing. Only a failure starts a turn of the agent, with the exit code and the end of the log.',
    params: [
      { key: 'command', kind: 'command', label: 'Command', placeholder: '/usr/bin/python3 /srv/jobs/sync.py' },
      { key: 'time', kind: 'time', label: 'At', default: '03:00' },
      { key: 'agent', kind: 'agent', label: 'Who looks into a failure' },
    ],
    automation: {
      name: 'Nightly script ({{time}})',
      agentId: '{{agent}}',
      prompt:
        'The nightly script failed — its exit code and the end of its log are below. Find the cause. Fix it if it is yours to fix, and re-run the script to confirm. If it needs the owner, say what failed and what they must decide. Never run it twice in a way that would duplicate what it writes.',
      trigger: { kind: 'cron', expr: '{{time.m}} {{time.h}} * * *' },
      run: { kind: 'command', argv: ['{{command}}'], onFailure: 'agent' },
    },
  },
  {
    kind: 'silos.automation-template',
    version: 1,
    id: 'monthly-close',
    name: 'Close the month',
    sentence: 'On day {{day}} of each month, {{agent}} closes the previous month: {{what}}',
    description: 'One run a month, early in the morning, with a written close the owner can read.',
    params: [
      { key: 'agent', kind: 'agent', label: 'Who closes it' },
      { key: 'day', kind: 'day', label: 'Day of the month', default: '5' },
      { key: 'what', kind: 'text', label: 'What closing means here', placeholder: 'reconcile sales with the bank and list unpaid invoices' },
    ],
    automation: {
      name: 'Monthly close (day {{day}})',
      agentId: '{{agent}}',
      prompt:
        'Close the previous calendar month. Here, closing means: {{what}}. Work from the real sources, never from memory. Write the close as a short report in a subfolder of your context folder (closes/), named after the month (YYYY-MM). Raise anything that needs the owner as a question, one per decision. End with one line: closed, or what is still open and why.',
      trigger: { kind: 'cron', expr: '7 6 {{day}} * *' },
    },
  },
  {
    kind: 'silos.automation-template',
    version: 1,
    id: 'deadline-review',
    name: 'Review the deadlines every week',
    sentence: 'Every Monday at {{time}}, {{agent}} reviews the deadlines in its plans and folder',
    description:
      'Real deadlines — a filing, a renewal, a certificate that expires — only reach Needs you when a plan task carries them as a due date. This review finds them and writes them there.',
    params: [
      { key: 'agent', kind: 'agent', label: 'Who reviews them' },
      { key: 'time', kind: 'time', label: 'At', default: '08:00' },
    ],
    automation: {
      name: 'Weekly deadline review',
      agentId: '{{agent}}',
      prompt:
        'Review the real deadlines in your area: the plans in plans/*.plan.json and the documents in your context folder. A real deadline is a date the world sets (a filing, a renewal, an expiry), never a wish. For each one: if a plan task covers it, make sure the task has the date as its "due" (YYYY-MM-DD); if none does, add the task. Never invent a date you cannot point to. End with one line: how many deadlines you found and the nearest one.',
      trigger: { kind: 'cron', expr: '{{time.m}} {{time.h}} * * 1' },
    },
  },
  {
    kind: 'silos.automation-template',
    version: 1,
    id: 'folder-intake',
    name: 'File what lands in a folder',
    sentence: 'When files land in {{folder}} matching {{glob}}, {{agent}} files them',
    description: 'For a folder where documents arrive — invoices, receipts, scans. Each batch of new files starts one run.',
    params: [
      { key: 'agent', kind: 'agent', label: 'Who files them' },
      { key: 'folder', kind: 'path', label: 'Folder', placeholder: '/srv/inbox/invoices' },
      { key: 'glob', kind: 'glob', label: 'Files', default: '*.pdf' },
    ],
    automation: {
      name: 'File new documents in {{folder}}',
      agentId: '{{agent}}',
      prompt:
        'Files arrived in {{folder}} — the last one is named below as «File changed»; a batch may hold more. List the folder and take every file you have not filed yet. Read each one and file it where it belongs in your area: record what it is, its date and amount if it has them, and move or copy it only where your instructions say. Never delete an original. Ask the owner about any file you cannot place. End with one line: how many you filed and how many need the owner.',
      trigger: { kind: 'files', folder: '{{folder}}', glob: '{{glob}}' },
    },
  },
  {
    kind: 'silos.automation-template',
    version: 1,
    id: 'finished-review',
    name: 'Check the work when a conversation ends',
    sentence: 'When a conversation of {{source}} finishes, {{agent}} checks the work',
    description: 'A second pair of eyes: another agent reads what was done and says only what is wrong or missing. It reports and never redoes the work.',
    params: [
      { key: 'source', kind: 'agent', label: 'Whose conversations' },
      { key: 'agent', kind: 'agent', label: 'Who checks them' },
    ],
    automation: {
      name: 'Check the work of {{source}}',
      agentId: '{{agent}}',
      prompt:
        'A conversation of {{source}} just finished — its id and final message are below. Check the work against what was asked: is it done, is it correct, and did it leave anything half-way? Look at the real result (files, records, commits), not only at what the conversation claims. Do not redo the work. If everything is right, say so in one line. If not, list each problem with where it is, and raise to the owner only what they must decide.',
      trigger: { kind: 'conversation', when: 'finished', sourceAgentId: '{{source}}' },
      maxRunsPerDay: 12,
    },
  },
]
