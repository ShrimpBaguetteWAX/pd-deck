import { lazy, Suspense } from 'react'
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'

import { ErrorBoundary } from '@/components/ErrorBoundary'
import { AppShell } from '@/components/layout/AppShell'
import { Loading } from '@/components/Loading'
import { Toaster } from '@/components/Toaster'
import { useSession } from '@/state/session'

const Landing = lazy(() => import('@/pages/Landing'))
const Army = lazy(() => import('@/pages/Army'))
const Missions = lazy(() => import('@/pages/Missions'))
const Deployments = lazy(() => import('@/pages/Deployments'))
const Forge = lazy(() => import('@/pages/Forge'))
const Market = lazy(() => import('@/pages/Market'))
const Blends = lazy(() => import('@/pages/Blends'))
const Swap = lazy(() => import('@/pages/Swap'))
const Ledger = lazy(() => import('@/pages/Ledger'))
const Settings = lazy(() => import('@/pages/Settings'))
const Arbitrage = lazy(() => import('@/pages/Arbitrage'))
const Planets = lazy(() => import('@/pages/Planets'))
const Couch = lazy(() => import('@/pages/Couch'))

/** Pages behind sign-in share the session check and the app shell. */
function PrivateLayout() {
  const { account, restored } = useSession(useShallow((s) => ({ account: s.account, restored: s.restored })))
  const location = useLocation()
  if (!restored) return <Loading />
  if (!account) return <Navigate to={`/?to=${encodeURIComponent(location.pathname.slice(1))}`} replace />
  return (
    <AppShell>
      <ErrorBoundary key={location.pathname}>
        <Suspense fallback={<Loading inline />}>
          <Outlet />
        </Suspense>
      </ErrorBoundary>
    </AppShell>
  )
}

/** Couch mode: signed in like the rest, but full screen, without the top bar and the menu. */
function BareLayout() {
  const { account, restored } = useSession(useShallow((s) => ({ account: s.account, restored: s.restored })))
  const location = useLocation()
  if (!restored) return <Loading />
  if (!account) return <Navigate to={`/?to=${encodeURIComponent(location.pathname.slice(1))}`} replace />
  return (
    <ErrorBoundary key={location.pathname}>
      <Suspense fallback={<Loading />}>
        <Outlet />
      </Suspense>
    </ErrorBoundary>
  )
}

function PublicOnly() {
  const { account, restored } = useSession(useShallow((s) => ({ account: s.account, restored: s.restored })))
  const location = useLocation()
  if (restored && account) {
    const to = new URLSearchParams(location.search).get('to')
    return <Navigate to={`/${to || 'missions'}`} replace />
  }
  return <Landing />
}

export function App() {
  return (
    <>
      <Toaster />
      <ErrorBoundary>
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<PublicOnly />} />
            <Route element={<PrivateLayout />}>
              <Route path="/army" element={<Army />} />
              <Route path="/missions" element={<Missions />} />
              <Route path="/deployments" element={<Deployments />} />
              <Route path="/forge" element={<Forge />} />
              <Route path="/market" element={<Market />} />
              <Route path="/blend" element={<Blends />} />
              <Route path="/swap" element={<Swap />} />
              <Route path="/ledger" element={<Ledger />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/arbitrage" element={<Arbitrage />} />
              <Route path="/planets" element={<Planets />} />
            </Route>
            <Route element={<BareLayout />}>
              <Route path="/couch" element={<Couch />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </>
  )
}
