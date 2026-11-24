import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './theme.css'
import { App } from './App'
import { AuthGate } from './components/AuthGate'
import { readDarkPref } from './lib/dark-mode'
import { applyLook, readLookPref } from './lib/look'

function initialDarkMode(): boolean {
  const stored = readDarkPref()
  if (stored === '1') return true
  if (stored === '0') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

if (initialDarkMode()) {
  document.documentElement.classList.add('dark')
} else {
  document.documentElement.classList.remove('dark')
}
// the look (theme + accent) in the same early pass: the first paint is
// already in the owner's colours, never a flash of the default — a look
// from a silo paints from its cached tokens until /api/silos answers.
applyLook(readLookPref())

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('The #root element was not found')
}

createRoot(rootElement).render(
  <StrictMode>
    {/* The owner's credential opens the app: the
        ?token= link, a pasted token («Pair this browser»), or Google login
        when the server opts in. */}
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
)
