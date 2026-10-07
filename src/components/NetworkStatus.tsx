import { useRef, useState } from 'react'

import { reprobe, useNetwork } from '@/state/useNetwork'

import { useDismiss } from './useDismiss'

import './NetworkStatus.css'

const host = (url: string) => url.replace(/^https?:\/\//, '')

/** "15/17 · 48ms", "…" while probing, "Offline" when nothing answers. */
export function networkLabel(net: ReturnType<typeof useNetwork>): string {
  const best = net.healthy[0]
  return net.state === 'probing' || net.state === 'idle'
    ? '…'
    : net.state === 'offline'
      ? 'Offline'
      : `${net.healthy.length}/${net.all.length} · ${Math.round(best?.latency ?? 0)}ms`
}

/** The coloured dot that says how the nodes are doing. */
export function NetworkLed({ state }: { state: ReturnType<typeof useNetwork>['state'] }) {
  return (
    <span className={`netdot netdot--${state} netdot--bare`}>
      <span className="netdot__led" />
    </span>
  )
}

/** The list of nodes with their latency and a re-check button; the body of the popover. */
export function NetworkPanel() {
  const net = useNetwork()
  return (
    <>
      <div className="netpop__head">
        <span>WAX nodes · {networkLabel(net)}</span>
        <button type="button" onClick={() => void reprobe()} disabled={net.state === 'probing'}>
          {net.state === 'probing' ? '…' : 'Re-check'}
        </button>
      </div>
      <div className="netlist">
        {[...net.all]
          .sort((a, b) => a.latency - b.latency)
          .map((e) => (
            <div className="netlist__row" key={e.url}>
              <span className={`netlist__led ${e.ok ? 'is-ok' : ''}`} />
              <span className="netlist__host">{host(e.url)}</span>
              <span className="netlist__ms">{e.ok ? `${Math.round(e.latency)}ms` : 'down'}</span>
            </div>
          ))}
      </div>
    </>
  )
}

/** Which WAX nodes answered this session, and how fast; reads rotate across the healthy ones. */
export function NetworkStatus() {
  const net = useNetwork()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useDismiss(open, wrapRef, () => setOpen(false))

  return (
    <div ref={wrapRef} className="netstatus">
      <button
        type="button"
        className={`netdot netdot--${net.state}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="WAX nodes"
      >
        <span className="netdot__led" />
        <span>{networkLabel(net)}</span>
      </button>

      {open && (
        <div className="netpop">
          <NetworkPanel />
        </div>
      )}
    </div>
  )
}
