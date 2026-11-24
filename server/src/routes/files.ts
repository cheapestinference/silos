// routes/files.ts — the Memories panel (/api/memory*) and the file
// browser (/api/file, /api/mkdir, /api/dir, /api/file/raw), moved VERBATIM
// out of server.ts (split the monoliths by domain,
// behavior unchanged). Path policy lives where it always did — in
// MemoryService/FileService; these routes only translate errors to codes.
import { basename, dirname, isAbsolute } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { FileError, type FileService } from '../file-service.js'
import { MemoryRefusal, type MemoryService } from '../memory-service.js'
import type { SessionIndex } from '../session-index.js'
import type { SessionOwners } from '../session-owner.js'

export interface FileRoutesCtx {
  memory: MemoryService
  files: FileService | undefined
  index: SessionIndex
  owners: SessionOwners
}

export function fileRoutes(app: FastifyInstance, ctx: FileRoutesCtx): void {
  const { memory, files, index, owners } = ctx
  // Memories panel — GET lists the layers (folder omitted = no
  // project/autoMemory; agent omitted = no "Agent memory" layer), GET
  // .../file reads a file, PUT .../file writes it (with an atomic backup
  // first). MemoryService's error messages are plain English; only
  // translated here to the right HTTP code.
  const memoryErrorCode = (message: string, err?: unknown): number => {
    if (err instanceof MemoryRefusal) return err.status
    if (message.includes('not allowed') || message.includes('not recognized')) return 400
    if (message.includes('not found')) return 404
    return 500
  }

  app.get<{ Querystring: { folder?: string; agent?: string } }>('/api/memory', async (req, reply) => {
    try {
      const layers = await memory.list(req.query.folder, req.query.agent)
      // who learned each auto note: the owner of the conversation it was
      // born in (the note's originSessionId, under the same projects folder
      // as the memory dir) — auto memory is the FOLDER's, its authorship is
      // an agent's (each page shows its own scope). A
      // conversation no longer indexed (trashed, purged) has no author.
      for (const n of layers.autoMemory) {
        if (!n.origin) continue
        const meta = index.getMeta(basename(dirname(dirname(n.path))), n.origin)
        if (meta) n.author = owners.agentIdOf(meta)
      }
      return layers
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err)
      return reply.code(memoryErrorCode(message, err)).send({ error: message })
    }
  })

  // ?folder= names the page's folder: any file the engines list for it
  // opens (a CLAUDE.local.md, a rule, an import), never one by its name alone
  app.get<{ Querystring: { path?: string; folder?: string } }>('/api/memory/file', async (req, reply) => {
    if (typeof req.query.path !== 'string' || req.query.path === '') return reply.code(400).send({ error: 'path required' })
    try {
      const content = await memory.read(req.query.path, typeof req.query.folder === 'string' && req.query.folder !== '' ? req.query.folder : undefined)
      return { content }
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err)
      return reply.code(memoryErrorCode(message, err)).send({ error: message })
    }
  })

  // The client names a PATH, never a kind: the server judges it against
  // the engines' own list (memory-service.ts judgeWrite). `folder`: the
  // page's folder; `confirmed`: the owner confirmed a write that reaches
  // every project on the machine; `ignoreLine`: a create asks for the
  // engine's ignore line (written only where it is offered).
  app.put<{ Body: { path?: string; content?: string; folder?: string; confirmed?: boolean; ignoreLine?: boolean } }>('/api/memory/file', async (req, reply) => {
    const { path, content, folder, confirmed, ignoreLine } = req.body ?? {}
    if (typeof path !== 'string' || path === '') return reply.code(400).send({ error: 'path required' })
    if (typeof content !== 'string') return reply.code(400).send({ error: 'content required' })
    if (folder !== undefined && (typeof folder !== 'string' || folder === '')) return reply.code(400).send({ error: 'folder must be a path' })
    try {
      const { backup, ignored } = await memory.write(path, content, {
        ...(folder !== undefined ? { folder } : {}),
        confirmed: confirmed === true,
        ignoreLine: ignoreLine === true,
      })
      return { ok: true, backup, ...(ignored !== undefined ? { ignored } : {}) }
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err)
      return reply.code(memoryErrorCode(message, err)).send({ error: message })
    }
  })

  // File viewer/editor — only if FileService was injected. Behind the
  // global token like the rest of /api/*: local with no auth, remote with
  // login, exactly like the terminal. Serves any ABSOLUTE path (no
  // per-session allowlist — auth IS the boundary), with file-service.ts's
  // hygiene. Bytes are NEVER logged (they're streamed).
  if (files) {
    const fileErrorCode = (reply: FastifyReply, err: unknown): FastifyReply => {
      if (err instanceof FileError) return reply.code(err.status).send({ error: err.message })
      // the raw message of an unexpected error is never leaked (it could
      // carry fs paths/details) — generic and 500.
      return reply.code(500).send({ error: 'could not access the file' })
    }

    // Metadata: how to render the file (kind, size, whether it fits
    // inline, whether it's editable). Doesn't read bytes.
    app.get<{ Querystring: { path?: string } }>('/api/file', async (req, reply) => {
      const p = req.query.path
      if (typeof p !== 'string' || p === '') return reply.code(400).send({ error: 'path required' })
      try {
        return files.meta(p)
      } catch (err) {
        return fileErrorCode(reply, err)
      }
    })

    // Explorer: lists a folder. Same auth/boundary model as /api/file (any
    // authenticated absolute path). Never reads bytes. ?optional=1 is for
    // probes by convention (the team-plan strip looking for plans/): a
    // missing folder answers 200 + empty listing instead of a 404 the
    // browser would paint red in the console on every conversation. Any
    // other error (not a folder, permission) still surfaces as usual.
    // Deliberately creating a folder is how a NEW project is born (the
    // project selector's free path): without this, choosing a fresh path
    // dead-ends on 'invalid cwd' in both engines. mkdir is recursive and
    // idempotent; only absolute paths, same rule as every cwd gate here.
    app.post<{ Body: { path?: string } }>('/api/mkdir', async (req, reply) => {
      const p = req.body?.path
      if (typeof p !== 'string' || !isAbsolute(p)) return reply.code(400).send({ error: 'absolute path required' })
      try {
        mkdirSync(p, { recursive: true })
        return { path: p }
      } catch {
        return reply.code(400).send({ error: 'could not create the folder' })
      }
    })

    app.get<{ Querystring: { path?: string; optional?: string } }>('/api/dir', async (req, reply) => {
      const p = req.query.path
      if (typeof p !== 'string' || p === '') return reply.code(400).send({ error: 'path required' })
      try {
        return files.listDir(p)
      } catch (err) {
        if (req.query.optional === '1' && err instanceof FileError && err.status === 404) {
          return { path: p, entries: [] }
        }
        return fileErrorCode(reply, err)
      }
    })

    // Bytes: streams the file. ?download=1 forces a download (attachment,
    // octet-stream, no cap). Without download, text/markdown above the cap
    // is rejected (413). nosniff + no-store: sensitive content isn't cached.
    app.get<{ Querystring: { path?: string; download?: string } }>('/api/file/raw', async (req, reply) => {
      const p = req.query.path
      if (typeof p !== 'string' || p === '') return reply.code(400).send({ error: 'path required' })
      const download = req.query.download === '1'
      try {
        const { meta, stream } = files.openForServe(p, download)
        void reply
          .header('content-type', download ? 'application/octet-stream' : meta.mime)
          .header('x-content-type-options', 'nosniff')
          .header('cache-control', 'private, no-store')
        // Security (XSS): an ACTIVE type served inline in the SAME origin
        // (image/svg+xml, and defensively html/xml) executes script if this
        // URL is navigated to directly — it would steal the origin's
        // token. nosniff is NOT enough: the content-type is declared
        // explicitly, never sniffed. CSP `sandbox` (without allow-scripts)
        // neutralizes execution on direct navigation; it does NOT affect
        // <img> (which never executes an SVG's script) or a PDF/raster
        // image (not scriptable), so it's applied only to active types.
        // Mirrors harnesses/claude-code/media.ts's criterion.
        const active = /^(image\/svg\+xml|text\/html|application\/xhtml\+xml|(text|application)\/xml)$/i.test(meta.mime)
        if (!download && active) void reply.header('content-security-policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'")
        if (download) {
          // sanitized filename (no quotes or control chars): the real
          // basename goes in filename*, an ascii fallback in filename —
          // avoids breaking the header.
          const safe = meta.name.replace(/["\\\r\n]/g, '_')
          void reply.header('content-disposition', `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(meta.name)}`)
        }
        return reply.send(stream)
      } catch (err) {
        return fileErrorCode(reply, err)
      }
    })

    // Save: text/markdown only, backup BEFORE + atomic tmp+rename. The path
    // is set by whichever file the viewer had open (a natural UX scope).
    app.put<{ Body: { path?: string; content?: string } }>('/api/file', async (req, reply) => {
      const { path, content } = req.body ?? {}
      if (typeof path !== 'string' || path === '') return reply.code(400).send({ error: 'path required' })
      if (typeof content !== 'string') return reply.code(400).send({ error: 'content required' })
      try {
        const { backup } = files.write(path, content)
        return { ok: true, backup }
      } catch (err) {
        return fileErrorCode(reply, err)
      }
    })
  }
}
