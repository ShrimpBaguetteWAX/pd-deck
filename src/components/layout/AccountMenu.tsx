import { useRef, useState } from 'react'

import { NetworkLed, NetworkPanel } from '@/components/NetworkStatus'
import { useDismiss } from '@/components/useDismiss'
import { LogoutIcon } from '@/icons'
import { useNetwork } from '@/state/useNetwork'

/**
 * The top bar's account control: one small round button carrying the node LED, which opens a
 * menu with the account, the WAX nodes and Disconnect. The wallet name stays out of the bar.
 */
export function AccountMenu({ account, spectating, onLogout }: { account: string; spectating: boolean; onLogout: () => void }) {
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
          <NetworkPanel />
          <button type="button" className="acctpop__out" role="menuitem" onClick={onLogout}>
            <LogoutIcon width={14} height={14} /> {spectating ? 'Stop viewing' : 'Disconnect'}
          </button>
        </div>
      )}
    </div>
  )
}
