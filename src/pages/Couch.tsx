import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'

import { refreshToday, useTodayEarnings } from '@/data/today'
import { formatNumber } from '@/lib/format'
import { useNow } from '@/lib/time'
import { readCashOut, useLoopPlan } from '@/lib/useLoop'
import { useMining } from '@/mining/useMining'
import { useReportCount, useTabTitle } from '@/state/tabCount'
import { useTransaction } from '@/wallet/useTransaction'

import './Couch.css'

/*
 * Couch mode: one screen for the phone lying next to you, with nothing but mining and the loop.
 * Today's TLM at the top (divisions and mining, since local midnight), one calm dial in the middle
 * whose button always does the next thing that's ready (Mine first, otherwise Loop for what's
 * back), and the divisions still out listed quietly at the bottom. It keeps the screen awake and
 * buzzes when something becomes ready.
 */

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const x = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`
}
const tlm = (n: number | undefined) => (n === undefined ? '–' : formatNumber(n, n >= 100 ? 0 : 2))

/** Keeps the screen on while the page is open and visible; the browser drops the lock when hidden. */
function useWakeLock() {
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null
    const nav = navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> } }
    const take = () => {
      if (document.visibilityState !== 'visible' || !nav.wakeLock) return
      nav.wakeLock
        .request('screen')
        .then((l) => (lock = l))
        .catch(() => {})
    }
    take()
    document.addEventListener('visibilitychange', take)
    return () => {
      document.removeEventListener('visibilitychange', take)
      void lock?.release().catch(() => {})
    }
  }, [])
}

export default function Couch() {
  const navigate = useNavigate()
  const { account, runSequence, pending, spectating } = useTransaction()
  const now = useNow(1000)
  const loop = useLoopPlan(account, readCashOut())
  const m = useMining(now)
  const today = useTodayEarnings(account)
  useWakeLock()
  useTabTitle()

  const back = loop.ready
  const out = loop.running
  const plan = back.length ? loop.cycle(loop.ready, loop.loopable) : null
  const looping = pending === 'loop-all'
  const canLoop = !!plan && plan.funding.affordable && !looping && !spectating
  const mineOn = !m.block || m.block === 'loading'
  const mineReady = !m.block && !m.cooling && !!m.pick && !m.busy
  const next: 'mine' | 'loop' | null = mineReady ? 'mine' : canLoop ? 'loop' : null
  useReportCount('mine', mineReady ? 1 : 0)
  useReportCount('loop', back.length)

  // A short buzz when something becomes ready, so the phone only needs a look when there's a reason.
  const wasReady = useRef<string | null>(null)
  useEffect(() => {
    if (next && wasReady.current === null) navigator.vibrate?.(80)
    wasReady.current = next
  }, [next])

  const mineLeft = m.pickReadyAt ? Math.max(0, m.pickReadyAt - now) : null
  const nextOut = out[0]
  // Inner ring: the share of the next returning division's lock that has passed, from when it left
  // (joined its mission) to when it is back. Full while any division is back to loop.
  // A ring that is on never drops below a small start, so it doesn't vanish right after a mine or loop.
  const START = 0.03
  const loopProgress = back.length
    ? 1
    : nextOut
      ? Math.min(1, Math.max(START, (now - nextOut.joinedAt) / Math.max(1, nextOut.unlockAt - nextOut.joinedAt)))
      : 0
  const mineProgress = !mineOn ? 0 : mineReady ? 1 : Math.max(START, m.progress)

  // Back to where it was opened from; to Deployments when it was opened on its own (a home screen icon).
  const close = () => ((window.history.state as { idx?: number } | null)?.idx ? navigate(-1) : navigate('/deployments'))

  async function press() {
    if (next === 'mine') {
      await m.mine()
      refreshToday(account)
    } else if (next === 'loop' && plan) {
      await runSequence(plan.parts, 'loop-all', `Looping ${back.length} division${back.length === 1 ? '' : 's'}`)
      refreshToday(account)
    }
  }

  // What the button says when nothing is ready: the soonest of the mine and the next return.
  const waits = [
    mineOn && mineLeft !== null && !mineReady && !m.busy ? { at: mineLeft, what: 'mine' } : null,
    nextOut ? { at: nextOut.unlockAt - now, what: `#${nextOut.divisionId} back` } : null
  ].filter((w): w is { at: number; what: string } => !!w)
  const soonest = waits.sort((a, b) => a.at - b.at)[0]
  const backTlm = plan ? plan.earnedTlm : 0

  return (
    <div className="couch">
      <button type="button" className="couch__close" onClick={close} aria-label="Close couch mode">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>

      <header className="couch__today" aria-label="Earned today">
        <div className="is-div">
          <small>Divisions today</small>
          <b className="num">
            {tlm(today.data?.divisions)}
            <span>TLM</span>
          </b>
        </div>
        <div className="is-mine">
          <small>Mining today</small>
          <b className="num">
            {tlm(today.data?.mining)}
            <span>TLM</span>
          </b>
        </div>
      </header>

      <main className="couch__middle">
        <div className="couch__dial">
          <svg viewBox="0 0 100 100" aria-hidden="true">
            <circle className="trk" cx="50" cy="50" r="45" />
            <circle
              className={`m${m.busy ? ' is-working' : mineProgress <= 0.005 ? ' is-empty' : ''}`}
              cx="50"
              cy="50"
              r="45"
              pathLength="100"
              strokeDasharray={m.busy ? '100 0' : `${mineProgress * 100} 100`}
            />
            <circle className="trk" cx="50" cy="50" r="33" />
            <circle
              className={`l${looping ? ' is-working' : loopProgress <= 0.005 ? ' is-empty' : ''}`}
              cx="50"
              cy="50"
              r="33"
              pathLength="100"
              strokeDasharray={looping ? '100 0' : `${loopProgress * 100} 100`}
            />
          </svg>
          <button
            type="button"
            className={`couch__core${next ? ` go-${next}` : ''}`}
            onClick={() => void press()}
            disabled={!next}
            aria-live="polite"
          >
            {/* A mine or a loop on its way shows on its own ring; the button stays free for the other. */}
            {next === 'mine' ? (
              <>
                <small>Tap to</small>
                <b>MINE</b>
                <small>≈ {formatNumber(m.pick?.estimatedTlm ?? 0, 2)} TLM</small>
              </>
            ) : next === 'loop' ? (
              <>
                <small>Tap to</small>
                <b>LOOP</b>
                <small>
                  {back.length} back{backTlm > 0 ? ` · +${formatNumber(backTlm, 0)} TLM` : ''}
                </small>
              </>
            ) : looping ? (
              <>
                <small>Sending</small>
                <b>LOOP</b>
                <small>see the progress above</small>
              </>
            ) : (
              <>
                <small>{soonest ? 'Next in' : spectating ? 'Read-only' : m.busy ? 'Mining' : 'Nothing to do'}</small>
                <b className="num">{soonest ? clock(soonest.at) : '–'}</b>
                <small>{soonest?.what ?? ''}</small>
              </>
            )}
          </button>
        </div>
        <p className="couch__legend">
          <span>
            <i className="is-mine" />
            {!mineOn
              ? 'Mine off'
              : m.busy
                ? 'Mining…'
                : mineReady
                  ? 'Mine ready'
                  : mineLeft !== null
                    ? `Mine ${clock(mineLeft)}`
                    : 'Mine…'}
          </span>
          <span>
            <i className="is-loop" />
            {back.length ? `${back.length} back` : nextOut ? `Loop ${clock(nextOut.unlockAt - now)}` : 'None out'}
          </span>
        </p>
      </main>

      <ul className="couch__out" aria-label="Coming back">
        {out.slice(0, 5).map((d) => (
          <li key={`${d.missionId}-${d.divisionId}`}>
            <span>#{d.divisionId}</span>
            <span>{loop.econ.get(d.missionId)?.title ?? `Mission #${d.missionId}`}</span>
            <b className="num">{clock(d.unlockAt - now)}</b>
          </li>
        ))}
      </ul>
    </div>
  )
}
