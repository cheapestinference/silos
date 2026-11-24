// file-viewer.test.tsx — the file viewer/editor: markdown
// (view↔edit↔save), pdf/image (blob), text/code (read-only highlighting),
// other/binary (download only), the Download button and the Esc contract.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FileViewer } from '../src/components/FileViewer'
import { api, ApiError } from '../src/lib/api'
import type { FileMeta } from '../src/lib/types'
import { planRecordOf } from './plan-records'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

function meta(overrides: Partial<FileMeta> = {}): FileMeta {
  return { path: '/p/note.md', name: 'note.md', ext: '.md', kind: 'markdown', mime: 'text/plain', size: 10, tooLarge: false, editable: true, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  // jsdom does not implement objectURL — a stub for the blob branches (img/pdf/download)
  URL.createObjectURL = vi.fn(() => 'blob:mock')
  URL.revokeObjectURL = vi.fn()
})

describe('FileViewer — markdown', () => {
  it('renders the markdown and allows editing and saving', async () => {
    mockedApi.file.meta.mockResolvedValue(meta())
    mockedApi.file.text.mockResolvedValue('# hello\n')
    mockedApi.file.write.mockResolvedValue({ ok: true, backup: '/b/note.md.bak' })
    render(<FileViewer path="/p/note.md" onClose={() => {}} />)

    // the rendered view
    expect(await screen.findByText('hello')).toBeInTheDocument()
    // switch to editing
    fireEvent.click(screen.getByText('Edit'))
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(ta.value).toBe('# hello\n')
    fireEvent.change(ta, { target: { value: '# bye\n' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(mockedApi.file.write).toHaveBeenCalledWith('/p/note.md', '# bye\n'))
    expect(await screen.findByText('Saved')).toBeInTheDocument()
    // back to the view with the new content
    await screen.findByText('bye')
  })

  it('text (not markdown) is read-only: no Edit button', async () => {
    mockedApi.file.meta.mockResolvedValue(meta({ name: 'app.ts', ext: '.ts', kind: 'text', editable: false }))
    mockedApi.file.text.mockResolvedValue('const x = 1\n')
    render(<FileViewer path="/p/app.ts" onClose={() => {}} />)
    expect(await screen.findByText(/const/)).toBeInTheDocument()
    expect(screen.queryByText('Edit')).not.toBeInTheDocument()
  })
})

describe('FileViewer — image / pdf', () => {
  it('image: requests the blob and paints an <img>', async () => {
    mockedApi.file.meta.mockResolvedValue(meta({ name: 'photo.png', ext: '.png', kind: 'image', mime: 'image/png', editable: false }))
    mockedApi.file.blob.mockResolvedValue(new Blob(['x'], { type: 'image/png' }))
    render(<FileViewer path="/p/photo.png" onClose={() => {}} />)
    await waitFor(() => expect(mockedApi.file.blob).toHaveBeenCalledWith('/p/photo.png'))
    const img = await screen.findByAltText('photo.png')
    expect(img).toHaveAttribute('src', 'blob:mock')
  })

  it('pdf: paints an <embed application/pdf>', async () => {
    mockedApi.file.meta.mockResolvedValue(meta({ name: 'doc.pdf', ext: '.pdf', kind: 'pdf', mime: 'application/pdf', editable: false }))
    mockedApi.file.blob.mockResolvedValue(new Blob(['x'], { type: 'application/pdf' }))
    render(<FileViewer path="/p/doc.pdf" onClose={() => {}} />)
    // portaled to document.body → queried in the document, not in `container`
    await waitFor(() => expect(document.querySelector('embed[type="application/pdf"]')).not.toBeNull())
  })
})

describe('FileViewer — download only', () => {
  it('binary: no preview, download only', async () => {
    mockedApi.file.meta.mockResolvedValue(meta({ name: 'a.bin', ext: '.bin', kind: 'binary', editable: false }))
    render(<FileViewer path="/p/a.bin" onClose={() => {}} />)
    expect(await screen.findByText(/No preview available/)).toBeInTheDocument()
  })

  it('text too large: download only (no text fetch)', async () => {
    mockedApi.file.meta.mockResolvedValue(meta({ name: 'big.txt', ext: '.txt', kind: 'text', size: 5_000_000, tooLarge: true, editable: false }))
    render(<FileViewer path="/p/big.txt" onClose={() => {}} />)
    expect(await screen.findByText(/too large to preview/)).toBeInTheDocument()
    expect(mockedApi.file.text).not.toHaveBeenCalled()
  })
})

describe('FileViewer — download and Esc', () => {
  it('the Download button requests the blob with download=true', async () => {
    mockedApi.file.meta.mockResolvedValue(meta())
    mockedApi.file.text.mockResolvedValue('# hello\n')
    mockedApi.file.blob.mockResolvedValue(new Blob(['x']))
    render(<FileViewer path="/p/note.md" onClose={() => {}} />)
    await screen.findByText('hello')
    fireEvent.click(screen.getByLabelText('Download file'))
    await waitFor(() => expect(mockedApi.file.blob).toHaveBeenCalledWith('/p/note.md', true))
  })

  it("Esc closes it (the contract's preventDefault) and calls onClose", async () => {
    mockedApi.file.meta.mockResolvedValue(meta())
    mockedApi.file.text.mockResolvedValue('# hello\n')
    const onClose = vi.fn()
    render(<FileViewer path="/p/note.md" onClose={onClose} />)
    await screen.findByText('hello')
    const ev = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    document.dispatchEvent(ev)
    expect(onClose).toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(true)
  })
})

// the viewer is a ROOT-LEVEL modal — portaled to document.body (nothing
// in the tree clips it), a full-screen scrim above everything (z-[100]),
// closes on Esc and a click on the background, and locks the body's
// scroll behind it.
describe('FileViewer — a root-level modal', () => {
  it("portals to document.body and locks the body's scroll", async () => {
    mockedApi.file.meta.mockResolvedValue(meta())
    mockedApi.file.text.mockResolvedValue('# hello\n')
    const { container } = render(<FileViewer path="/p/note.md" onClose={() => {}} />)
    await screen.findByText('hello')
    // the modal does NOT hang off the render container (a portal): it lives in document.body
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    const dialog = screen.getByRole('dialog')
    const scrim = dialog.parentElement as HTMLElement
    expect(scrim.parentElement).toBe(document.body)
    // the body's scroll is locked while it's open
    expect(document.body.style.overflow).toBe('hidden')
  })

  it('clicking the background (scrim) closes it', async () => {
    mockedApi.file.meta.mockResolvedValue(meta())
    mockedApi.file.text.mockResolvedValue('# hello\n')
    const onClose = vi.fn()
    render(<FileViewer path="/p/note.md" onClose={onClose} />)
    await screen.findByText('hello')
    const scrim = screen.getByRole('dialog').parentElement as HTMLElement
    fireEvent.mouseDown(scrim)
    expect(onClose).toHaveBeenCalled()
  })

  it("restores the body's scroll on unmount", async () => {
    mockedApi.file.meta.mockResolvedValue(meta())
    mockedApi.file.text.mockResolvedValue('# hello\n')
    const { unmount } = render(<FileViewer path="/p/note.md" onClose={() => {}} />)
    await screen.findByText('hello')
    expect(document.body.style.overflow).toBe('hidden')
    unmount()
    expect(document.body.style.overflow).toBe('')
  })
})

// A plan file (plans/*.plan.json) is drawn as the plan the Plans silo reads
// (lib/plan-record.ts — the record by its file); Done is the silo's
// set-field, never a rewrite of the file from the browser; a plan read
// outside Silos' projects is drawn read-only and says so.
describe('FileViewer — a plan file, through the plans silo', () => {
  const path = '/proj/plans/ship.plan.json'
  const text = JSON.stringify({
    title: 'Ship',
    updatedAt: '2026-11-01',
    tasks: [
      { id: 't1', title: 'Decide the org', owner: 'sam', status: 'pending', dependsOn: [] },
      { id: 't2', title: 'Fill package.json', owner: 'writer', status: 'blocked', dependsOn: ['t1'] },
    ],
  })
  beforeEach(() => {
    mockedApi.file.meta.mockResolvedValue(meta({ path, name: 'ship.plan.json', ext: '.json', kind: 'text' }))
    mockedApi.file.text.mockResolvedValue(text)
  })

  it("draws the plan; Done is the owner's verb with the state painted, and says who it unblocked", async () => {
    mockedApi.silos.recordByFile.mockResolvedValue(planRecordOf(path, text))
    mockedApi.tasksAct.mockResolvedValue({
      key: 'k',
      record: { tasks: [] },
      already: false,
      holds: [],
      nowReady: [{ key: 'k', id: 't2', identity: 'Fill package.json', owner: 'writer', wakes: 'task' }],
    })
    render(<FileViewer path={path} onClose={() => {}} />)
    expect(await screen.findByRole('heading', { name: 'Ship' })).toBeInTheDocument()
    // the first task's Done (no agents in the store: both owners read human)
    fireEvent.click(screen.getAllByRole('button', { name: 'Done' })[0]!)
    await waitFor(() => expect(mockedApi.tasksAct).toHaveBeenCalledWith({ key: 'folder:/proj/ship/tasks/t1', verb: 'done', state: expect.any(String) }))
    expect(mockedApi.file.write).not.toHaveBeenCalled()
    expect(await screen.findByText(/Unblocked for writer/)).toBeInTheDocument()
  })

  it("a plan outside Silos' projects is read-only and says so; one the silo does not read shows its raw text", async () => {
    mockedApi.silos.recordByFile.mockResolvedValueOnce(planRecordOf(path, text, { outside: true, version: null }))
    const { unmount } = render(<FileViewer path={path} onClose={() => {}} />)
    expect(await screen.findByTestId('plan-outside')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
    unmount()
    mockedApi.silos.recordByFile.mockRejectedValueOnce(new ApiError('no record', 404, {}))
    render(<FileViewer path={path} onClose={() => {}} />)
    expect(await screen.findByText(/Decide the org/)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Ship' })).toBeNull()
  })
})
