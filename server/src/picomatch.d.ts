// The engine's own glob matcher (Claude Code matches claudeMdExcludes with
// picomatch, dot files on — spec memory-places §4 «Facts»). The package
// ships no types; only what Silos calls is declared.
declare module 'picomatch' {
  interface PicomatchOptions {
    dot?: boolean
  }
  function picomatch(glob: string | string[], options?: PicomatchOptions): (input: string) => boolean
  export default picomatch
}
