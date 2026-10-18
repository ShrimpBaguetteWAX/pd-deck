import { useQuery } from '@tanstack/react-query'
import { Fragment, useState } from 'react'

import { Button } from '@/components/Button'
import { Loading } from '@/components/Loading'
import { Tooltip } from '@/components/Tooltip'
import {
  floorTo,
  loopSwapAction,
  MAX_TRADE_WAX,
  readLoopResult,
  refreshLoop,
  scanLoops,
  TLM_ID,
  WAX_ID,
  type LoopResult,
  type Opportunity
} from '@/data/arbitrage'
import { refreshPlayer, usePlayer } from '@/data/game'
import { ExternalIcon, RefreshIcon } from '@/icons'
import { rpcCall } from '@/chain/rpc'
import { verifyLoop } from '@/lib/alcorChain'
import { bestSize, type Loop } from '@/lib/clmm'
import { formatNumber } from '@/lib/format'
import { useNow } from '@/lib/time'
import { useTransaction } from '@/wallet/useTransaction'

import './Arbitrage.css'

/*
 * Alcor loops: swaps through two or three pools that start and end in WAX or TLM. The scan finds the
 * loops that pay at their best size; Execute reads the pools again, re-sizes to what you hold, and
 * sends one Alcor swap through every pool with a minimum return above what goes in, so the
 * transaction either makes a profit or fails and changes nothing.
 */

/** The minimum return asks for this share of the expected profit on top of the input. */
const MIN_PROFIT_SHARE = 0.1
/** Below this, in WAX worth, a fresh quote is not worth signing. */
const MIN_SIGN_WAX = 0.001

type StartFilter = 'all' | 'WAX' | 'TLM'

type RunState =
  | { stage: 'reading'; trxId: string; paid: number; expected: number }
  | { stage: 'done'; trxId: string; expected: number; result: LoopResult }
  | { stage: 'unread'; trxId: string; paid: number; expected: number }

/** Amounts in a token's own precision, trimmed. */
const amount = (n: number, decimals: number) => formatNumber(n, Math.min(decimals, Math.abs(n) >= 100 ? 2 : 4))
const signed = (n: number, decimals: number) => `${n > 0 ? '+' : ''}${amount(n, decimals)}`

export default function Arbitrage() {
  const { account, run, pending, spectating } = useTransaction()
  const player = usePlayer(account)
  const now = useNow(5000)
  const [step, setStep] = useState('')
  const [filter, setFilter] = useState<StartFilter>('all')
  const [runs, setRuns] = useState<Record<string, RunState>>({})

  const scan = useQuery({
    queryKey: ['alcor-loops'],
    queryFn: () => scanLoops(setStep),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: 1
  })

  const balanceOf = (id: string) => (id === WAX_ID ? (player.data?.wax ?? 0) : id === TLM_ID ? (player.data?.tlm ?? 0) : 0)
  const shown = (scan.data?.opportunities ?? []).filter((o) => filter === 'all' || o.loop.start.symbol === filter)

  async function execute(o: Opportunity) {
    const start = o.loop.start
    let paid = 0
    let expected = 0
    let trxId = ''
    const ok = await run(
      async (a, p) => {
        // The pools have moved since the scan: read them again, size to what the wallet holds (never
        // more), and let the contract confirm the size in a dry run from this very account.
        const fresh = await refreshLoop(o.loop)
        const cap = floorTo(Math.min(balanceOf(start.id), o.startWax > 0 ? MAX_TRADE_WAX / o.startWax : 1e6), start)
        if (!(cap > 0)) throw new Error(`There is no ${start.symbol} in the wallet to run this loop with.`)
        const guess = Math.min(cap, Math.max(bestSize(fresh, cap).amount, o.best.amount))
        const { best, error } = await verifyLoop(rpcCall, a, fresh, guess, cap)
        if (!best || best.profit * o.startWax < MIN_SIGN_WAX)
          throw new Error(
            `This loop no longer pays${error ? ` (${error})` : ''}: the pools have moved since the scan. Scan again.`
          )
        paid = best.amount
        expected = best.profit
        const unit = 10 ** -start.decimals
        const minOut = best.amount + Math.max(unit, best.profit * MIN_PROFIT_SHARE)
        return loopSwapAction(a, p, fresh, best.amount, minOut)
      },
      '',
      `arb-${o.key}`,
      { register: false, refresh: false, onSigned: (id) => (trxId = id) }
    )
    if (!ok || !trxId || !account) return
    setRuns((r) => ({ ...r, [o.key]: { stage: 'reading', trxId, paid, expected } }))
    const result = await readLoopResult(trxId, account, start)
    setRuns((r) => ({
      ...r,
      [o.key]: result ? { stage: 'done', trxId, expected, result } : { stage: 'unread', trxId, paid, expected }
    }))
    void refreshPlayer(account)
  }

  return (
    <div className="page arb">
      <header className="arb-head">
        <div>
          <p className="eyebrow">Alcor loops</p>
          <h2>Arbitrage</h2>
          <p className="arb-lead">
            Swaps through two or three pools that start and end in WAX or TLM, sized for the most profit. Execute sends one swap
            through every pool, and it only goes through if more comes back than went in.
          </p>
        </div>
        <div className="arb-controls">
          <div className="segmented">
            {(['all', 'WAX', 'TLM'] as const).map((f) => (
              <button key={f} type="button" className={filter === f ? 'is-active' : ''} onClick={() => setFilter(f)}>
                {f === 'all' ? 'Both' : `From ${f}`}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="arb-scan"
            disabled={scan.isFetching}
            onClick={() => void scan.refetch()}
            title="Read every pool again"
          >
            <RefreshIcon width={14} height={14} className={scan.isFetching ? 'is-spinning' : ''} />
            {scan.isFetching ? 'Scanning' : 'Scan again'}
          </button>
        </div>
      </header>

      {scan.data && (
        <p className="arb-facts num">
          {formatNumber(scan.data.pools, 0)} pools read · {formatNumber(scan.data.liquid, 0)} with at least 20 WAX on both sides ·{' '}
          {formatNumber(scan.data.loops, 0)} loops checked · {scan.data.simulated} simulated exactly · {ago(now - scan.data.at)}
        </p>
      )}

      {scan.isLoading ? (
        <Loading inline label={step || 'Reading every Alcor pool'} />
      ) : scan.isError ? (
        <div className="empty">
          <strong>The scan failed</strong>
          <span>{scan.error instanceof Error ? scan.error.message : 'The chain nodes did not answer.'} Try again.</span>
        </div>
      ) : shown.length === 0 ? (
        <div className="empty">
          <strong>No loop pays right now</strong>
          <span>Every loop loses to the pool fees at the moment. Prices move all the time: scan again in a while.</span>
        </div>
      ) : (
        <div className="panel arb-table">
          <div className="arb-row arb-row--head">
            <span>Loop</span>
            <span>Best size</span>
            <span>Comes back</span>
            <span>Profit</span>
            <span>
              With yours{' '}
              <Tooltip text="Execute never puts in more than your wallet holds: below the best size it runs on what you have, sized again and confirmed by a dry run from your account." />
            </span>
            <span />
          </div>
          {shown.map((o) => {
            const t = o.loop.start
            const d = t.decimals
            const have = balanceOf(t.id)
            const usable = account ? have : 0
            const state = runs[o.key]
            return (
              <Fragment key={o.key}>
                <div className="arb-row">
                  <Route loop={o.loop} />
                  <span className="num">
                    {amount(o.best.amount, d)} <small className="faint">{t.symbol}</small>
                  </span>
                  <span className="num">
                    {amount(o.best.received, d)} <small className="faint">{t.symbol}</small>
                  </span>
                  <span className="num arb-profit">
                    <b>
                      {signed(o.best.profit, d)} {t.symbol}
                    </b>
                    <small className="faint">
                      {formatNumber((o.best.profit / o.best.amount) * 100, 2)}%
                      {t.id !== WAX_ID && o.startWax > 0 ? ` · ≈ ${formatNumber(o.best.profit * o.startWax, 2)} WAX` : ''}
                    </small>
                  </span>
                  <span className="num">
                    {!account ? (
                      <span className="faint">Sign in</span>
                    ) : !(have >= 10 ** -d) ? (
                      <span className="faint">No {t.symbol} in the wallet</span>
                    ) : have < o.best.amount ? (
                      <>
                        Up to {amount(have, d)} <small className="faint">{t.symbol}</small>
                      </>
                    ) : (
                      <span className="faint">Best size fits</span>
                    )}
                  </span>
                  <span className="arb-go">
                    <Tooltip
                      text={`Reads the pools again, sizes the loop to at most what you hold, and sends ${t.symbol} through pools ${o.loop.pools.map((p) => p.id).join(', ')} in one Alcor swap. The swap asks for the input plus ${MIN_PROFIT_SHARE * 100}% of the expected profit back; if the pools moved and less would come back, the transaction fails and nothing changes.`}
                    >
                      <Button
                        size="sm"
                        color="gradientYellow"
                        disabled={spectating || !account || !(usable > 0)}
                        isLoading={pending === `arb-${o.key}` || state?.stage === 'reading'}
                        onClick={() => void execute(o)}
                      >
                        Execute
                      </Button>
                    </Tooltip>
                  </span>
                </div>
                {state && <RunLine state={state} symbol={t.symbol} decimals={d} />}
              </Fragment>
            )
          })}
        </div>
      )}

      <p className="arb-note">
        Pool sizes and prices come straight from Alcor&apos;s contract; each listed loop was simulated across its pools&apos;
        price ranges. Loops through small tokens can fail when a token contract refuses the transfer: the transaction then fails
        as a whole and only uses CPU. Other bots chase the same gaps, so a loop can close between the scan and your signature.
      </p>
    </div>
  )
}

function Route({ loop }: { loop: Loop }) {
  return (
    <span className="arb-route">
      <span className="arb-route__tokens">
        {loop.path.map((t, i) => (
          <Fragment key={i}>
            {i > 0 && <i aria-hidden>›</i>}
            <b title={`${t.symbol} (${t.contract})`}>{t.symbol}</b>
          </Fragment>
        ))}
      </span>
      <small className="faint num">pools {loop.pools.map((p) => `${p.id} (${formatNumber(p.fee * 100, 2)}%)`).join(' · ')}</small>
    </span>
  )
}

function RunLine({ state, symbol, decimals }: { state: RunState; symbol: string; decimals: number }) {
  const link = (
    <a href={`https://waxblock.io/transaction/${state.trxId}`} target="_blank" rel="noreferrer" className="arb-link">
      Transaction <ExternalIcon width={11} height={11} />
    </a>
  )
  if (state.stage === 'reading')
    return (
      <div className="arb-run">
        <span>
          Sent {amount(state.paid, decimals)} {symbol}, expecting {signed(state.expected, decimals)} {symbol}. Reading the result
          from the chain…
        </span>
        {link}
      </div>
    )
  if (state.stage === 'unread')
    return (
      <div className="arb-run">
        <span>
          Went through with {amount(state.paid, decimals)} {symbol}. The history nodes have not indexed it yet; the transaction
          shows the result.
        </span>
        {link}
      </div>
    )
  const r = state.result
  return (
    <div className={`arb-run ${r.profit > 0 ? 'is-gain' : 'is-loss'}`}>
      <span className="num">
        Done. Put in {amount(r.paid, decimals)} {symbol}, got back {amount(r.received, decimals)} {symbol}:{' '}
        <b>
          {signed(r.profit, decimals)} {symbol}
        </b>{' '}
        <span className="faint">(expected {signed(state.expected, decimals)}, read from the chain)</span>
      </span>
      {link}
    </div>
  )
}

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`
}
