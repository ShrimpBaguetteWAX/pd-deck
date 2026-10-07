import { useRef, useState } from 'react'

import { TokenIcon } from '@/components/Art'
import { NetworkLed, NetworkPanel } from '@/components/NetworkStatus'
import { Tooltip } from '@/components/Tooltip'
import { formatCompact } from '@/lib/format'
import { useDismiss } from '@/components/useDismiss'
import { LogoutIcon } from '@/icons'
import { useNetwork } from '@/state/useNetwork'

/**
 * The top bar's account control: one small round button carrying the node LED, which opens a
 * menu with the account, its balances, the WAX nodes and Disconnect. Neither the wallet name nor
 * the balances take room in the bar.
 */
export function AccountMenu({
  account,
  spectating,
  balances,
  onLogout
}: {
  account: string
  spectating: boolean
  balances: { tlm: number; def: number; wax: number } | null
  onLogout: () => void
}) {
  const net = useNetwork()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  useDismiss(open, wrapRef, () => setOpen(false))

  return (
    <div ref={wrapRef} className={`acct ${spectating ? 'is-spectating' : ''}`}>
      <button
        type="button"
        className="acct__button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={spectating ? `Viewing ${account} read-only` : account}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21a8 8 0 0 1 16 0" />
        </svg>
        <NetworkLed state={net.state} />
      </button>

      {open && (
        <div className="acctpop netpop" role="menu">
          <div className="acctpop__who">
            <b>{account}</b>
            {spectating && <span className="account__tag">view only</span>}
          </div>
          <div className="balances acctpop__balances">
            <Tooltip text="Trilium, the Alien Worlds token. Missions pay it and some charge it to enter.">
              <span className="balance">
                <TokenIcon symbol="TLM" />
                <b className="num">{balances ? formatCompact(balances.tlm) : '–'}</b>
              </span>
            </Tooltip>
            <Tooltip text="DEF, the Planetary Defense token. Buys forge slots and enters the richer missions.">
              <span className="balance">
                <TokenIcon symbol="DEF" />
                <b className="num">{balances ? formatCompact(balances.def) : '–'}</b>
              </span>
            </Tooltip>
            <Tooltip text="WAX in your wallet: what the Market and the Blend page spend.">
              <span className="balance">
                <TokenIcon symbol="WAX" />
                <b className="num">{balances ? formatCompact(balances.wax) : '–'}</b>
              </span>
            </Tooltip>
          </div>
          <NetworkPanel />
          <button type="button" className="acctpop__out" role="menuitem" onClick={onLogout}>
            <LogoutIcon width={14} height={14} /> {spectating ? 'Stop viewing' : 'Disconnect'}
          </button>
        </div>
      )}
    </div>
  )
}
