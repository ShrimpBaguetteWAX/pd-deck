import { useMemo, useState } from 'react'

import { TokenIcon } from '@/components/Art'
import { Button } from '@/components/Button'
import { Loading } from '@/components/Loading'
import { Tooltip } from '@/components/Tooltip'
import { usePlayer } from '@/data/game'
import { useSwapPools, type SwapPools } from '@/data/market'
import { RefreshIcon } from '@/icons'
import { formatNumber, percent } from '@/lib/format'
import { midPrice, quoteRoute, swapExactInAction, type Pool, type Route } from '@/lib/pool'
import { useTransaction } from '@/wallet/useTransaction'

import './Swap.css'

type Token = 'WAX' | 'TLM' | 'DEF'
const TOKENS: Token[] = ['WAX', 'TLM', 'DEF']
const SLIPPAGES = [0.005, 0.01, 0.02]

/** The pool between two tokens. */
function poolFor(pools: SwapPools, a: Token, b: Token): Pool {
  const pair = [a, b].sort().join('/')
  return pair === 'DEF/WAX' ? pools.def : pair === 'TLM/WAX' ? pools.tlm : pools.tlmdef
}

/** Direct, and through the third token: whichever returns more wins. */
function routesFor(pools: SwapPools, from: Token, to: Token, amount: number): Route[] {
  const via = TOKENS.find((t) => t !== from && t !== to)!
  return [
    quoteRoute([poolFor(pools, from, to)], from, amount),
    quoteRoute([poolFor(pools, from, via), poolFor(pools, via, to)], from, amount)
  ].sort((x, y) => y.out - x.out)
}

/** Mid-market rate of a route (no fee, no size), to show the price impact. */
function midRate(route: Route): number {
  let rate = 1
  route.pools.forEach((p, i) => {
    const sym = route.path[i]
    const aPerB = midPrice(p) // B per A
    rate *= p.a.symbol === sym ? aPerB : 1 / aPerB
  })
  return rate
}

export default function Swap() {
  const { account, run, pending, spectating } = useTransaction()
  const player = usePlayer(account)
  const pools = useSwapPools()
  const [from, setFrom] = useState<Token>('TLM')
  const [to, setTo] = useState<Token>('WAX')
  const [amountText, setAmountText] = useState('1000')
  const [slippage, setSlippage] = useState(0.01)

  const amount = Math.max(0, Number(amountText.replace(',', '.')) || 0)
  const routes = useMemo(
    () => (pools.data && from !== to && amount > 0 ? routesFor(pools.data, from, to, amount) : []),
    [pools.data, from, to, amount]
  )

  if (!pools.data || !player.data) return <Loading inline label="Reading Alcor" />

  const balance: Record<Token, number> = { WAX: player.data.wax, TLM: player.data.tlm, DEF: player.data.def }
  const best = routes[0]
  const impact = best ? 1 - best.rate / midRate(best) : 0
  const minOut = best ? best.out * (1 - slippage) : 0
  const tooMuch = amount > balance[from]

  const pick = (side: 'from' | 'to', t: Token) => {
    if (side === 'from') {
      if (t === to) setTo(from)
      setFrom(t)
    } else {
      if (t === from) setFrom(to)
      setTo(t)
    }
  }

  // Every pair's current rate, for the reference strip.
  const rates = TOKENS.flatMap((a) => TOKENS.filter((b) => b !== a).map((b) => ({ a, b, r: routesFor(pools.data!, a, b, 1)[0] })))

  return (
    <div className="page swap">
      <section className="sw-card panel">
        <header className="sw-head">
          <div>
            <p className="eyebrow">Alcor</p>
            <h2>Swap</h2>
          </div>
          <button
            type="button"
            className={`icon-btn ${pools.isFetching ? 'is-spinning' : ''}`}
            title="Refresh prices"
            onClick={() => void pools.refetch()}
          >
            <RefreshIcon />
          </button>
        </header>

        <div className="sw-side">
          <div className="sw-side__top">
            <span className="faint">You pay</span>
            <button
              type="button"
              className="sw-balance"
              onClick={() => setAmountText(String(Math.floor(balance[from] * 1e4) / 1e4))}
            >
              Balance {formatNumber(balance[from], 4)} · max
            </button>
          </div>
          <div className="sw-side__row">
            <input
              className="sw-amount num"
              inputMode="decimal"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value.replace(/[^\d.,]/g, ''))}
            />
            <TokenPicker value={from} onChange={(t) => pick('from', t)} />
          </div>
        </div>

        <button
          type="button"
          className="sw-flip"
          aria-label="Swap direction"
          onClick={() => {
            setFrom(to)
            setTo(from)
            if (best) setAmountText(String(Number(best.out.toFixed(4))))
          }}
        >
          ⇅
        </button>

        <div className="sw-side">
          <div className="sw-side__top">
            <span className="faint">You receive</span>
            <span className="faint">Balance {formatNumber(balance[to], 4)}</span>
          </div>
          <div className="sw-side__row">
            <span className="sw-amount sw-amount--out num">{best ? formatNumber(best.out, 4) : '0'}</span>
            <TokenPicker value={to} onChange={(t) => pick('to', t)} />
          </div>
        </div>

        {best && (
          <ul className="sw-details">
            <li>
              <span>Rate</span>
              <b className="num">
                1 {from} = {formatNumber(best.rate, best.rate < 1 ? 6 : 4)} {to}
              </b>
            </li>
            <li>
              <Tooltip text="Direct pool, or through the third token when two pools together give more.">
                <span>Route</span>
              </Tooltip>
              <b>{best.path.join(' → ')}</b>
            </li>
            {routes[1] && (
              <li className="faint">
                <span>Other route</span>
                <span className="num">
                  {routes[1].path.join(' → ')}: {formatNumber(routes[1].out, 4)} ({percent(routes[1].out / best.out - 1, 2)})
                </span>
              </li>
            )}
            <li>
              <Tooltip text="How much worse than the pools' mid price this swap fills, pool fees included.">
                <span>Price impact</span>
              </Tooltip>
              <b className={`num ${impact > 0.03 ? 'c-red' : ''}`}>{percent(Math.max(0, impact), 2)}</b>
            </li>
            <li>
              <span>Slippage</span>
              <span className="sw-slip">
                {SLIPPAGES.map((s) => (
                  <button key={s} type="button" className={slippage === s ? 'is-on' : ''} onClick={() => setSlippage(s)}>
                    {percent(s, s < 0.01 ? 1 : 0)}
                  </button>
                ))}
              </span>
            </li>
            <li>
              <Tooltip text="The swap is refused if the pools move and it would return less than this.">
                <span>Minimum received</span>
              </Tooltip>
              <b className="num">
                {formatNumber(minOut, 4)} {to}
              </b>
            </li>
          </ul>
        )}

        <Button
          size="lg"
          color="gradientYellow"
          block
          disabled={!best || tooMuch || spectating}
          isLoading={pending === 'swap'}
          onClick={() =>
            run(
              (a, p) => swapExactInAction(a, p, best!, amount, minOut),
              `Swapped ${formatNumber(amount, 4)} ${from} for about ${formatNumber(best!.out, 4)} ${to}`,
              'swap'
            )
          }
        >
          {tooMuch ? `Not enough ${from}` : `Swap ${from} → ${to}`}
        </Button>
      </section>

      <section className="sw-rates">
        {rates.map(({ a, b, r }) => (
          <button
            key={`${a}${b}`}
            type="button"
            className={`sw-rate ${a === from && b === to ? 'is-on' : ''}`}
            onClick={() => {
              setFrom(a)
              setTo(b)
            }}
          >
            <span>
              <TokenIcon symbol={a} size={14} /> {a} → <TokenIcon symbol={b} size={14} /> {b}
            </span>
            <b className="num">{formatNumber(r.rate, r.rate < 1 ? 5 : 3)}</b>
          </button>
        ))}
      </section>
    </div>
  )
}

function TokenPicker({ value, onChange }: { value: Token; onChange: (t: Token) => void }) {
  return (
    <span className="sw-tokens">
      {TOKENS.map((t) => (
        <button key={t} type="button" className={value === t ? 'is-on' : ''} onClick={() => onChange(t)}>
          <TokenIcon symbol={t} size={16} /> {t}
        </button>
      ))}
    </span>
  )
}
