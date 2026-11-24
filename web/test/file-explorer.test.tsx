// file-explorer.test.tsx — the file explorer: navigates folders
// (breadcrumb) and opens files in the viewer. /api/dir mocked.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileViewerHost } from '../src/components/FileViewerHost'
import { useStore as useStoreForSheet } from '../src/store'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FileExplorer } from '../src/components/FileExplorer'
import { api } from '../src/lib/api'
import type { DirEntry } from '../src/lib/types'

vi.mock('../src/lib/api')
const mockedApi = vi.mocked(api, { deep: true })

function dir(entries: DirEntry[], path = '/proj') {
  return { path, entries }
}

beforeEach(() => {
  useStoreForSheet.setState({ viewingFile: null })
  vi.clearAllMocks()
})

describe('FileExplorer', () => {
  it("lists the root's entries (folders and files)", async () => {
    mockedApi.file.dir.mockResolvedValue(
      dir([
        { name: 'src', type: 'dir', size: 0, mtime: 0 },
        { name: 'README.md', type: 'file', size: 10, mtime: 0 },
      ]),
    )
    render(
      <>
        <FileExplorer root="/proj" />
        <FileViewerHost />
      </>,
    )
    expect(await screen.findByText('src')).toBeInTheDocument()
    expect(screen.getByText('README.md')).toBeInTheDocument()
    expect(mockedApi.file.dir).toHaveBeenCalledWith('/proj')
  })

  it('clicking a folder navigates into it (requests /api/dir for the subdir) and the breadcrumb grows', async () => {
    mockedApi.file.dir
      .mockResolvedValueOnce(dir([{ name: 'src', type: 'dir', size: 0, mtime: 0 }]))
      .mockResolvedValueOnce(dir([{ name: 'app.ts', type: 'file', size: 5, mtime: 0 }], '/proj/src'))
    render(
      <>
        <FileExplorer root="/proj" />
        <FileViewerHost />
      </>,
    )
    fireEvent.click(await screen.findByText('src'))
    await waitFor(() => expect(mockedApi.file.dir).toHaveBeenLastCalledWith('/proj/src'))
    expect(await screen.findByText('app.ts')).toBeInTheDocument()
  })

  it('clicking a file opens the viewer (requests its metadata)', async () => {
    mockedApi.file.dir.mockResolvedValue(dir([{ name: 'note.md', type: 'file', size: 10, mtime: 0 }]))
    mockedApi.file.meta.mockResolvedValue({
      path: '/proj/note.md',
      name: 'note.md',
      ext: '.md',
      kind: 'markdown',
      mime: 'text/plain',
      size: 10,
      tooLarge: false,
      editable: true,
    })
    mockedApi.file.text.mockResolvedValue('# hello\n')
    render(
      <>
        <FileExplorer root="/proj" />
        <FileViewerHost />
      </>,
    )
    fireEvent.click(await screen.findByText('note.md'))
    await waitFor(() => expect(mockedApi.file.meta).toHaveBeenCalledWith('/proj/note.md'))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('shows the open file: opens on its folder with the file marked', async () => {
    mockedApi.file.dir.mockImplementation(async (p: string) => ({
      path: p,
      entries:
        p === '/proj/docs'
          ? ([
              { name: 'a.md', type: 'file' },
              { name: 'b.md', type: 'file' },
            ] as DirEntry[])
          : [],
    }))
    render(<FileExplorer root="/proj" selected="/proj/docs/b.md" onOpenFile={() => {}} />)
    const b = await screen.findByText('b.md')
    expect(b.closest('button')).toHaveAttribute('aria-current', 'true')
    expect(screen.getByText('a.md').closest('button')).not.toHaveAttribute('aria-current')
    expect(mockedApi.file.dir).toHaveBeenCalledWith('/proj/docs')
  })
  it('a file outside the tree is named, not silently missing', async () => {
    render(<FileExplorer root="/proj" selected="/elsewhere/x.md" onOpenFile={() => {}} />)
    expect(await screen.findByTestId('explorer-outside')).toHaveTextContent('/elsewhere/x.md')
  })
})
