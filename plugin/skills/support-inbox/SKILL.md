---
name: support-inbox
description: Use when you are in charge of a support mailbox — a heartbeat on that duty, "check support", "review the inbox" — or when a new customer message needs a case, a draft reply, or a note.
---

# Support inbox — cases as files, the mailbox as the store

Messages live in the mailbox. What you keep is a CASE per customer:
status, intent, a summary, internal notes, and pointers to the mail
threads. Silos reads these files (the Support page, Needs you, the
Graph); the owner edits them there too. Never write a message body or a
credential into a case file.

Your product's own support skill defines: `SUPPORT_ADDRESS` (the mailbox
you watch), the list of `intent` labels, how to build the customer's
profile, and what the reply policy is. This skill is only the mechanics.

## Files

```
$SILOS_AGENT_STATE/support/
  cursor.json                { "lastScanAt": "<ISO>", "query": "<the query you ran>" }
  cases/<caseId>.json        one case (caseId = a uuid; file name = id)
```

A case:

```json
{
  "id": "5b1c…", "customerEmail": "jane@example.com", "userId": "optional product id",
  "status": "draft_ready", "intent": "billing", "summary": "one line, in the customer's terms",
  "threads": [{ "threadId": "<mail thread id>", "subject": "…", "lastMessageId": "<last message you processed>", "lastMessageAt": "<ISO>", "draftId": "<optional>", "url": "<optional link to the thread in your mailbox>" }],
  "notes": [{ "at": "<ISO>", "by": "agent", "text": "what you verified and why you did what you did" }],
  "openedAt": "<ISO>", "lastActivityAt": "<ISO>", "updatedAt": "<ISO>", "updatedBy": "agent"
}
```

Fields worth naming:
- `url`: a link to the thread in your mailbox, if it has one — optional.
  The dashboard turns the subject into a link only when you write it; it
  builds no link of its own.

Statuses (fixed): `new` → `needs_owner` | `draft_ready` | `waiting_customer` → `closed`.
`needs_owner` and `draft_ready` are what the owner sees in Needs you.

Writing a file: read the current file first (the owner may have added a
note since your last beat), keep every note that is on disk plus yours,
write to a dot-prefixed temp file with a `.tmp` suffix in the same folder
(e.g. `.case-<uuid>.tmp`) so a concurrent server scan of `cases/*.json`
never sees it, then rename over the target.

## One beat = one sweep

1. **Delta only.** Search the mailbox for `to:<SUPPORT_ADDRESS>` newer than
   `lastScanAt` minus one day. For each thread returned, compare its
   messages with the case's `lastMessageId` for that thread — read ONLY
   the newer messages. A thread with no case: read its latest message.
   Never pull the whole mailbox, never re-read what you already processed.
2. **Nothing new** → say so in one line and stop.
3. **For each customer with news**, find the case by email:
   - an open case (status ≠ closed) → attach the thread there;
   - the newest closed case, whose `updatedAt` is less than 14 days ago →
     reopen it (`status: "new"`, add a note "reopened by new message");
   - otherwise → a new case: set `id` = a new uuid, `openedAt` = now,
     `notes` = `[]`, `status` = `new`.
   Then: build the customer profile the way your product skill says; pick
   ONE intent from the product's list, with a one-line reason in the note;
   apply the product's policy; set the status:
   - you wrote a draft → `draft_ready` (store the `draftId` on the thread);
   - the owner has to decide → `needs_owner`, with the exact question in the note;
   - you replied and the ball is with the customer → `waiting_customer`.
   Update `lastMessageId`/`lastMessageAt` on the thread, `summary`,
   `lastActivityAt`, `updatedAt`, `updatedBy: "agent"` (leave `openedAt`
   untouched on an existing case). Write the file.
4. Update `cursor.json`. End the run with one line: "N cases touched, M
   drafts, K for the owner" — a `needs_owner` case is itself the owner's
   entry in Needs you (the note holds the question), so never ask it again
   with your question tool.

## Drafts, never sends

- Replies are DRAFTS the owner sends. Never send. Never auto-reply.
- Reply on the thread the customer is looking at (the newest one), as a
  reply to their last message, from `SUPPORT_ADDRESS`.
- To change a draft, delete it and create a new one — editing a draft in
  place can detach it from its thread in some mail clients.
- Quote nothing. Write the reply; the mail client threads it.

## Never

- Never paste a message body, a token, a payment detail or a password into
  a case file or a note. Notes are one to three lines of what you verified.
- Never read messages older than the case's `lastMessageId` unless the new
  message cannot be understood alone — and then only that case's threads.
- Never invent a customer's history: if the mailbox connector is
  unavailable, end the run saying so, with the connector's error, and stop.
- Never change a case the owner closed unless a new message arrived.
