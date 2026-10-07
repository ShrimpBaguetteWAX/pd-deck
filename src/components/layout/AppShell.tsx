import { useMemo, type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'

import { GUIDE_URL } from '@/chain/config'
import { AccountMenu } from '@/components/layout/AccountMenu'
import { LoopWidget } from '@/components/layout/LoopWidget'
import { useDeployments, usePlayer } from '@/data/game'
import {
  CartIcon,
  ExternalIcon,
  SparkIcon,
  SwapIcon,
  FlameIcon,
  GiftIcon,
  LedgerIcon,
  RocketIcon,
  SwordIcon,
  UsersIcon
} from '@/icons'
import { publicUrl } from '@/lib/publicUrl'
import { useClockFor } from '@/lib/time'
import { useSession } from '@/state/session'

import './AppShell.css'

const NAV = [
  { to: '/army', label: 'Army', icon: UsersIcon },
  { to: '/missions', label: 'Missions', icon: RocketIcon },
  { to: '/deployments', label: 'Deployments', icon: GiftIcon },
  { to: '/forge', label: 'Forge', icon: FlameIcon },
  { to: '/market', label: 'Market', icon: CartIcon },
  { to: '/blend', label: 'Blend', icon: SparkIcon },
  { to: '/swap', label: 'Swap', icon: SwapIcon },
  { to: '/ledger', label: 'Ledger', icon: LedgerIcon }
]

/** The frame of every signed-in page: navigation, the player's balances and the wallet. */
export function AppShell({ children }: { children: ReactNode }) {
  const { account, spectating, logout } = useSession(
    useShallow((s) => ({ account: s.account, spectating: s.spectating, logout: s.logout }))
  )
  const player = usePlayer(account)
  const deployments = useDeployments(account)

  // The deployments badge counts divisions whose cooldown is over: re-render as each one ends.
  const unlocks = useMemo(() => deployments.data?.map((d) => d.unlockAt) ?? [], [deployments.data])
  const now = useClockFor(unlocks)
  const ready = deployments.data?.filter((d) => d.unlockAt <= now).length ?? 0
  const running = (deployments.data?.length ?? 0) - ready

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar__inner">
          <div className="topbar__row">
            <NavLink to="/missions" className="brand">
              <img src={publicUrl('/img/logo_planetary.webp')} alt="" />
              <span>
                <strong>Planetary Defense</strong>
                <small>Command deck</small>
              </span>
            </NavLink>

            {account ? <LoopWidget /> : <span />}

            <div className="topbar__right">
              {account && (
                <AccountMenu
                  account={account}
                  spectating={spectating}
                  balances={player.data ? { tlm: player.data.tlm, def: player.data.def, wax: player.data.wax } : null}
                  onLogout={() => void logout()}
                />
              )}
            </div>
          </div>

          <nav className="nav" aria-label="Main">
            {NAV.map(({ to, label, icon: Icon }) => (
              <NavLink key={to} to={to} className={({ isActive }) => `nav__link ${isActive ? 'is-active' : ''}`}>
                <Icon />
                <span>{label}</span>
                {to === '/deployments' && ready > 0 && <em className="nav__badge nav__badge--ready">{ready}</em>}
                {to === '/deployments' && ready === 0 && running > 0 && <em className="nav__badge">{running}</em>}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>

      <main className="shell__main">{children}</main>

      <footer className="shell__foot">
        <a href={GUIDE_URL} target="_blank" rel="noreferrer">
          Game guide <ExternalIcon width={12} height={12} />
        </a>
        <span className="faint">
          <SwordIcon width={12} height={12} /> Every action is signed by your wallet and runs on the official game contracts.
        </span>
      </footer>
    </div>
  )
}
