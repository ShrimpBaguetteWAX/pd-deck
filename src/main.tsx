import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'

import { endpointPool } from '@/chain/endpoints'
import { queryClient } from '@/data/queryClient'
import { useSession } from '@/state/session'
import { App } from './App'

import './styles/global.css'
import './styles/modals.css'

// Hash links from the old site (/#/attack) open the matching page here.
if (window.location.hash.startsWith('#/')) {
  const map: Record<string, string> = { attack: 'missions', divisions: 'army', forge: 'forge', claims: 'deployments' }
  const target = map[window.location.hash.slice(2)] ?? ''
  window.history.replaceState(null, '', `${import.meta.env.BASE_URL}${target}${window.location.search}`)
}

// Rank the WAX nodes and restore any stored wallet session before the first screen.
void endpointPool.probe()
void useSession.getState().restore()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
)
