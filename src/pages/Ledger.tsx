import { useMemo, useState } from 'react'

import { TokenIcon } from '@/components/Art'
import { Loading } from '@/components/Loading'
import { Figure } from '@/components/Stat'
import { Tooltip } from '@/components/Tooltip'
import { useCollectionTemplates, useOwnedBlendInputs, useTemplatePrices } from '@/data/blends'
import { useArmy, useWalletNfts } from '@/data/game'
import {
  CATEGORY_LABEL,
  priceAt,
  useLedger,
  usePriceHistory,
  type Category,
  type LedgerEntry,
  type PriceHistory,
  type Token
} from '@/data/ledger'
import { useListings, useSwapPools } from '@/data/market'
import { marketFrom, SALE_KEEP, valueOf } from '@/lib/blendEconomy'
import { formatNumber } from '@/lib/format'
import { midPrice, type Pool } from '@/lib/pool'
import { useTransaction } from '@/wallet/useTransaction'

import './Ledger.css'

type Unit = 'USD' | 'WAX'

const SPEND: Category[] = ['nft', 'forge-level', 'forge-slot', 'forge-other', 'entry']
const EARN: Category[] = ['mission', 'v2', 'sale']
const LIST_STEP = 50

/** WAX per one unit of \`symbol\` at the pool's mid price. */
const waxPer = (pool: Pool, symbol: string) => (pool.a.symbol === symbol ? midPrice(pool) : 1 / midPrice(pool))

/**
 * Values entries in WAX and USD at the time they happened: WAX and TLM at that day's price
 * (CoinGecko), DEF through today's Alcor DEF/WAX price (DEF has no price history anywhere).
 */
function valuer(prices: PriceHistory | undefined, tlmWaxNow: number, defWaxNow: number) {
  const waxUsd = (t: number) => (prices ? priceAt(prices.wax, t) : null)
  const tlmUsd = (t: number) => (prices ? priceAt(prices.tlm, t) : null)
  const wax = (e: { token: Token; amount: number; time: number }) => {
    if (e.token === 'WAX') return e.amount
    if (e.token === 'DEF') return e.amount * defWaxNow
    const w = waxUsd(e.time)
    const t = tlmUsd(e.time)
    return w && t ? (e.amount * t) / w : e.amount * tlmWaxNow
  }
  const usd = (e: { token: Token; amount: number; time: number }) => {
    const w = waxUsd(e.time)
    if (w === null) return null
    if (e.token === 'TLM') {
      const t = tlmUsd(e.time)
      return t === null ? null : e.amount * t
    }
    return wax(e) * w
  }
  return { wax, usd, waxUsdNow: prices ? (prices.wax[prices.wax.length - 1]?.[1] ?? null) : null }
}

export default function Ledger() {
  const { account } = useTransaction()
  const ledger = useLedger(account)
  const prices = usePriceHistory()
  const pools = useSwapPools()
  const army = useArmy(account)
  const wallet = useWalletNfts(account)
  const materials = useOwnedBlendInputs(account)
  const listings = useListings()
  const templates = useCollectionTemplates()
  const recent = useTemplatePrices()
  const [unit, setUnit] = useState<Unit>('USD')
  const [shown, setShown] = useState(LIST_STEP)
  const [only, setOnly] = useState<Category | 'all'>('all')

  const v = useMemo(
    () => (pools.data ? valuer(prices.data, waxPer(pools.data.tlm, 'TLM'), waxPer(pools.data.def, 'DEF')) : null),
    [prices.data, pools.data]
  )

  // What is still held (staked, in the wallet, materials and loot), at market value after sale fees.
  const holdings = useMemo(() => {
    if (!listings.data || !templates.data || !recent.data) return null
    const market = marketFrom(listings.data, new Map(), templates.data, account, recent.data)
    const counts = new Map<string, number>()
    const add = (templateId: string, n = 1) => counts.set(templateId, (counts.get(templateId) ?? 0) + n)
    for (const a of army.data?.assets.values() ?? []) add(a.templateId)
    for (const a of wallet.data ?? []) add(a.templateId)
    for (const [t, ids] of materials.data ?? []) add(t, ids.length)
    let wax = 0
    let nfts = 0
    let unpriced = 0
    for (const [t, n] of counts) {
      if (!templates.data.has(t)) continue
      nfts += n
      const val = valueOf(market, t)
      if (val === null) unpriced += n
      else wax += val * SALE_KEEP * n
    }
    return { wax, nfts, unpriced }
  }, [listings.data, templates.data, recent.data, army.data, wallet.data, materials.data, account])

  if (!account) return <p className="muted">Sign in, or add ?as=account to the address, to see a ledger.</p>
  if (!ledger.data || !v) return <Loading inline label="Reading your history from the chain" />

  const entries = ledger.data
  const val = (e: LedgerEntry) => (unit === 'USD' ? v.usd(e) : v.wax(e))
  const usdMissing = unit === 'USD' && !prices.data
  const sum = (list: LedgerEntry[]) => list.reduce((n, e) => n + (val(e) ?? 0), 0)
  const spent = sum(entries.filter((e) => e.direction === 'out'))
  const earned = sum(entries.filter((e) => e.direction === 'in'))
  const net = earned - spent
  const holdValue = holdings ? (unit === 'USD' ? (v.waxUsdNow !== null ? holdings.wax * v.waxUsdNow : null) : holdings.wax) : null
  // Sign first, then the currency: −$501.16, +1,200 WAX. Dollars always show their cents.
  const money = (n: number | null, signed = false) => {
    if (n === null) return '–'
    const sign = n < 0 ? '−' : signed && n > 0 ? '+' : ''
    const abs = Math.abs(n)
    return unit === 'USD'
      ? `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : `${sign}${formatNumber(abs, abs < 10 ? 2 : 0)} WAX`
  }

  const byCategory = (cats: Category[]) =>
    cats
      .map((c) => {
        const list = entries.filter((e) => e.category === c)
        const tokens = new Map<Token, number>()
        for (const e of list) tokens.set(e.token, (tokens.get(e.token) ?? 0) + e.amount)
        return { c, n: list.length, tokens, value: sum(list) }
      })
      .filter((r) => r.n > 0)

  const listed = [...entries].reverse().filter((e) => only === 'all' || e.category === only)

  return (
    <div className="page ledger">
      <section className="lg-top panel">
        <div className="lg-head">
          <div>
            <p className="eyebrow">Ledger · {account}</p>
            <h2>Spent and earned on Planetary Defense</h2>
            <p className="muted">
              From the chain: NFTs bought and sold in the collection, the Forge, mission entry fees and rewards, and the old
              game's rewards. Each entry is valued on the day it happened.
            </p>
          </div>
          <div className="segmented" role="group" aria-label="Currency">
            {(['USD', 'WAX'] as Unit[]).map((u) => (
              <button key={u} type="button" className={unit === u ? 'is-active' : ''} onClick={() => setUnit(u)}>
                {u === 'WAX' ? <TokenIcon symbol="WAX" size={14} /> : '$'} {u}
              </button>
            ))}
          </div>
        </div>
        {usdMissing && (
          <p className="c-red lg-warn">USD prices could not be loaded right now. Switch to WAX, or try again later.</p>
        )}
        <div className="lg-figures">
          <div className={`lg-net ${net >= 0 ? 'is-up' : 'is-down'}`}>
            <span className="faint">Net so far</span>
            <b className="num">{money(net, true)}</b>
            <small className="faint">earned minus spent</small>
          </div>
          <Figure label="Spent" value={money(spent)} tone="c-red" />
          <Figure label="Earned" value={money(earned)} tone="c-green" />
          <Tooltip
            text={`What you still hold in the collection (${holdings ? formatNumber(holdings.nfts, 0) : '…'} NFTs, staked, in the wallet and materials), at market value after the 7% sale fees.${holdings?.unpriced ? ` ${holdings.unpriced} have no market price and count as nothing.` : ''}`}
          >
            <Figure label="Holding today" value={money(holdValue)} />
          </Tooltip>
          <Tooltip text="Net so far plus what you hold, if you sold it all today at market value.">
            <Figure
              label="If sold today"
              value={holdValue === null ? '–' : money(net + holdValue, true)}
              tone={holdValue === null ? '' : net + holdValue >= 0 ? 'c-green' : 'c-red'}
            />
          </Tooltip>
        </div>
      </section>

      <div className="lg-split">
        <CategoryPanel title="Spent" rows={byCategory(SPEND)} money={money} tone="c-red" />
        <CategoryPanel title="Earned" rows={byCategory(EARN)} money={money} tone="c-green" />
      </div>

      <MonthChart entries={entries} val={val} money={money} />

      <section className="lg-list panel">
        <header className="lg-list__head">
          <h3>Every entry</h3>
          <div className="segmented">
            {(['all', ...SPEND, ...EARN] as (Category | 'all')[])
              .filter((c) => c === 'all' || entries.some((e) => e.category === c))
              .map((c) => (
                <button
                  key={c}
                  type="button"
                  className={only === c ? 'is-active' : ''}
                  onClick={() => {
                    setOnly(c)
                    setShown(LIST_STEP)
                  }}
                >
                  {c === 'all' ? 'All' : CATEGORY_LABEL[c]}
                </button>
              ))}
          </div>
        </header>
        <div className="lg-rows">
          {listed.slice(0, shown).map((e) => {
            const value = val(e)
            return (
              <div key={e.id} className={`lg-row ${e.direction === 'in' ? 'is-in' : 'is-out'}`}>
                <span className="faint num">{new Date(e.time).toLocaleDateString()}</span>
                <span className="lg-row__what">
                  <b>{CATEGORY_LABEL[e.category]}</b>
                  <small className="faint">{e.note}</small>
                </span>
                <span className="num lg-row__token">
                  <TokenIcon symbol={e.token} size={14} /> {formatNumber(e.amount, e.token === 'WAX' ? 2 : 4)}
                </span>
                <b className={`num ${e.direction === 'in' ? 'c-green' : 'c-red'}`}>
                  {e.direction === 'in' ? '+' : '−'}
                  {money(value)}
                </b>
              </div>
            )
          })}
        </div>
        {listed.length > shown && (
          <button type="button" className="mk-link" onClick={() => setShown((n) => n + LIST_STEP)}>
            Show {Math.min(LIST_STEP, listed.length - shown)} more of {listed.length - shown}
          </button>
        )}
      </section>

      <p className="faint lg-note">
        WAX and TLM are valued at their USD price on the day (CoinGecko, last 365 days; older entries use the oldest price). DEF
        has no price history, so it is valued at today's Alcor price. Token swaps are not counted: they only change what the money
        is held in.
      </p>
    </div>
  )
}

function CategoryPanel({
  title,
  rows,
  money,
  tone
}: {
  title: string
  rows: { c: Category; n: number; tokens: Map<Token, number>; value: number }[]
  money: (n: number | null) => string
  tone: string
}) {
  const total = rows.reduce((n, r) => n + r.value, 0)
  return (
    <section className="lg-cats panel">
      <header>
        <h3>{title}</h3>
        <b className={`num ${tone}`}>{money(total)}</b>
      </header>
      {rows.length === 0 ? (
        <p className="muted">Nothing yet.</p>
      ) : (
        <ul>
          {rows.map((r) => (
            <li key={r.c}>
              <span className="lg-cats__label">
                <b>{CATEGORY_LABEL[r.c]}</b>
                <small className="faint num">
                  {r.n}× · {[...r.tokens].map(([t, n]) => `${formatNumber(n, t === 'WAX' ? 0 : 2)} ${t}`).join(' + ')}
                </small>
              </span>
              <span className="lg-cats__bar">
                <span style={{ width: `${total ? (r.value / total) * 100 : 0}%` }} />
              </span>
              <b className="num">{money(r.value)}</b>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Spent and earned per month, as bars around a zero line. */
function MonthChart({
  entries,
  val,
  money
}: {
  entries: LedgerEntry[]
  val: (e: LedgerEntry) => number | null
  money: (n: number | null, signed?: boolean) => string
}) {
  const months = useMemo(() => {
    const m = new Map<string, { label: string; in: number; out: number }>()
    for (const e of entries) {
      const d = new Date(e.time)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      const row = m.get(key) ?? { label: d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }), in: 0, out: 0 }
      row[e.direction] += val(e) ?? 0
      m.set(key, row)
    }
    if (!entries.length) return []
    const first = new Date(entries[0].time)
    const last = new Date(entries[entries.length - 1].time)
    const out: { label: string; in: number; out: number }[] = []
    for (let d = new Date(first.getFullYear(), first.getMonth(), 1); d <= last; d.setMonth(d.getMonth() + 1)) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      out.push(m.get(key) ?? { label: d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }), in: 0, out: 0 })
    }
    return out
  }, [entries, val])
  if (!months.length) return null
  const top = Math.max(1, ...months.map((m) => Math.max(m.in, m.out)))
  return (
    <section className="lg-chart panel">
      <h3>By month</h3>
      <div className="lg-chart__bars">
        {months.map((m) => (
          <Tooltip
            key={m.label}
            text={`${m.label}: earned ${money(m.in)}, spent ${money(m.out)}, net ${money(m.in - m.out, true)}`}
          >
            <div className="lg-chart__col">
              <span className="lg-chart__up">
                <span style={{ height: `${(m.in / top) * 100}%` }} />
              </span>
              <span className="lg-chart__down">
                <span style={{ height: `${(m.out / top) * 100}%` }} />
              </span>
              <small className="faint">{m.label}</small>
            </div>
          </Tooltip>
        ))}
      </div>
      <p className="faint lg-chart__legend">
        <span className="lg-dot is-in" /> earned <span className="lg-dot is-out" /> spent
      </p>
    </section>
  )
}
