import { useMemo, type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { useShallow } from 'zustand/react/shallow'

import { GUIDE_URL } from '@/chain/config'
import { TokenIcon } from '@/components/Art'
import { NetworkStatus } from '@/components/NetworkStatus'
import { Tooltip } from '@/components/Tooltip'
import { useDeployments, usePlayer } from '@/data/game'
import {
  CartIcon,
  ExternalIcon,
  SparkIcon,
  SwapIcon,
  FlameIcon,
  GiftIcon,
  LedgerIcon,
  LogoutIcon,
  RocketIcon,
  ShardIcon,
  SwordIcon,
  UsersIcon
} from '@/icons'
import { formatCompact } from '@/lib/format'
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
          <NavLink to="/missions" className="brand">
            <img src={publicUrl('/img/logo_planetary.webp')} alt="" />
            <span>
              <strong>Planetary Defense</strong>
              <small>Command deck</small>
            </span>
          </NavLink>

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

          <div className="topbar__right">
            <div className="balances">
              <Tooltip text="Trilium, the Alien Worlds token. Missions pay it and some charge it to enter.">
                <span className="balance">
                  <TokenIcon symbol="TLM" />
                  <b className="num">{player.data ? formatCompact(player.data.tlm) : '–'}</b>
                </span>
              </Tooltip>
              <Tooltip text="DEF, the Planetary Defense token. Buys forge slots and enters the richer missions.">
                <span className="balance">
                  <TokenIcon symbol="DEF" />
                  <b className="num">{player.data ? formatCompact(player.data.def) : '–'}</b>
                </span>
              </Tooltip>
              <Tooltip text="Alien Worlds shards you can redeem. Shard missions add to these.">
                <span className="balance">
                  <ShardIcon width={16} height={16} />
                  <b className="num">{player.data ? formatCompact(player.data.shards) : '–'}</b>
                </span>
              </Tooltip>
            </div>
            <NetworkStatus />
            <div className={`account ${spectating ? 'is-spectating' : ''}`}>
              <span className="account__name">{account}</span>
              {spectating && <span className="account__tag">view only</span>}
              {player.data && player.data.forgeLevel > 0 && (
                <span className="account__tag account__tag--forge">
                  <FlameIcon width={12} height={12} /> {player.data.forgeLevel}
                </span>
              )}
              <button type="button" className="icon-btn" title="Sign out" onClick={() => void logout()}>
                <LogoutIcon />
              </button>
            </div>
          </div>
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
