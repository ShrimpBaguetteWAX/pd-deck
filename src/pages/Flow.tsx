import { useMemo, useState, type MouseEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import { useFlowData } from '@/data/flowStore'
import {
  aggregate,
  ALIENS,
  CATEGORIES,
  CATEGORY_BY_ID,
  dayOf,
  FLOW_TOKENS,
  nextDay,
  PD_CONTRACTS,
  rowsIn,
  type Bucket,
  type FlowToken,
  type FlowRow
} from '@/lib/flow'

import './Flow.css'

/*
 * Token flow: all TLM (or DEF) going into and out of the Planetary Defense contracts over time, one line each,
 * what is left in the reward pool, a breakdown of the whole timeframe (or a picked day), and the raw
 * transfers. The history behind it is read slowly with a loading bar (see flowStore).
 */

const DAY = 86400000
/**
 * The token shown: set at the top of every render of the page, before its charts render, so the
 * small helpers below format in its unit (TLM in whole tokens, DEF with two decimals).
 */
let unit: { symbol: string; digits: number } = FLOW_TOKENS.TLM
const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: unit.digits, maximumFractionDigits: unit.digits })
const short = (n: number) =>
  Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`
const dayName = (t: number) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
const isoDate = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const niceMax = (v: number) => {
  const p = 10 ** Math.floor(Math.log10(v || 1))
  return Math.ceil((v || 1) / p) * p
}

type Range = 7 | 30 | 90 | 'custom'
const W = 1100
const P = { l: 50, r: 58, t: 12, b: 26 }
const PER_PAGE = 20

/** The x position of bucket i and the bucket under a pointer, shared by the charts. */
function scaleX(n: number) {
  const x = (i: number) => P.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - P.l - P.r))
  const at = (e: MouseEvent<SVGElement>) => {
    const r = (e.currentTarget.ownerSVGElement ?? e.currentTarget).getBoundingClientRect()
    const px = ((e.clientX - r.left) / r.width) * W
    return Math.max(0, Math.min(n - 1, Math.round(((px - P.l) / (W - P.l - P.r)) * (n - 1))))
  }
  return { x, at }
}

function Ticks({ bs, x, h }: { bs: Bucket[]; x: (i: number) => number; h: number }) {
  const step = Math.max(1, Math.ceil(bs.length / 8))
  return (
    <>
      {bs.map((b, i) =>
        i % step === 0 || i === bs.length - 1 ? (
          <text key={b.t} x={x(i)} y={h - 6} textAnchor="middle">
            {dayName(b.t)}
          </text>
        ) : null
      )}
    </>
  )
}

function InOutChart({
  bs,
  pick,
  onPick,
  gran
}: {
  bs: Bucket[]
  pick: number | null
  onPick: (t: number) => void
  gran: string
}) {
  const H = 300
  const [hover, setHover] = useState<number | null>(null)
  const max = niceMax(Math.max(...bs.map((b) => Math.max(b.inSum, b.outSum))))
  const { x, at } = scaleX(bs.length)
  const y = (v: number) => P.t + (1 - v / max) * (H - P.t - P.b)
  const line = (k: 'inSum' | 'outSum') => bs.map((b, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(b[k]).toFixed(1)}`).join('')
  const last = bs.length - 1
  const pickI = bs.findIndex((b) => b.t === pick)
  const hb = hover !== null ? bs[hover] : null
  const rows = (by: Record<string, number>) =>
    Object.entries(by)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => (
        <div className="fl-tip__row" key={k}>
          <span>
            <i style={{ background: CATEGORY_BY_ID.get(k)?.color }} />
            {CATEGORY_BY_ID.get(k)?.name}
          </span>
          <span className="num">{fmt(v)}</span>
        </div>
      ))
  return (
    <div className="fl-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${unit.symbol} in and out per ${gran}`}>
        <g className="fl-axis">
          {[0, 1, 2, 3, 4].map((k) => (
            <g key={k}>
              <line className="fl-grid" x1={P.l} x2={W - P.r} y1={y((max / 4) * k)} y2={y((max / 4) * k)} />
              <text x={P.l - 8} y={y((max / 4) * k) + 3.5} textAnchor="end">
                {short((max / 4) * k)}
              </text>
            </g>
          ))}
          <Ticks bs={bs} x={x} h={H} />
        </g>
        {pickI >= 0 && <line x1={x(pickI)} x2={x(pickI)} y1={P.t} y2={H - P.b} className="fl-pick" />}
        <path d={line('inSum')} className="fl-line is-in" />
        <path d={line('outSum')} className="fl-line is-out" />
        <circle cx={x(last)} cy={y(bs[last].inSum)} r={4} className="fl-end is-in" />
        <circle cx={x(last)} cy={y(bs[last].outSum)} r={4} className="fl-end is-out" />
        <text x={x(last) + 8} y={y(bs[last].inSum) + 4} className="fl-endlab">
          In
        </text>
        <text x={x(last) + 8} y={y(bs[last].outSum) + 4} className="fl-endlab">
          Out
        </text>
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={P.t} y2={H - P.b} className="fl-cross" />}
        <rect
          x={P.l}
          y={P.t}
          width={W - P.l - P.r}
          height={H - P.t - P.b}
          fill="transparent"
          style={{ cursor: 'crosshair' }}
          onPointerMove={(e) => setHover(at(e))}
          onPointerLeave={() => setHover(null)}
          onClick={(e) => onPick(bs[at(e)].t)}
        />
      </svg>
      {hb && (
        <div className="fl-tip" style={{ left: `min(calc(100% - 230px), max(0px, calc(${(x(hover!) / W) * 100}% + 14px)))` }}>
          <h4>{gran === 'day' ? dayName(hb.t) : `${dayName(hb.t)} – ${dayName(hb.end - DAY)}`}</h4>
          <div className="fl-tip__row">
            <span>
              <i style={{ background: 'var(--fl-in)' }} />
              In
            </span>
            <b className="num">{fmt(hb.inSum)}</b>
          </div>
          {rows(hb.inBy)}
          <div className="fl-tip__sep" />
          <div className="fl-tip__row">
            <span>
              <i style={{ background: 'var(--fl-out)' }} />
              Out
            </span>
            <b className="num">{fmt(hb.outSum)}</b>
          </div>
          {rows(hb.outBy)}
          <div className="fl-tip__hint">Tap to look at just this {gran}</div>
        </div>
      )}
    </div>
  )
}

function NetBars({ bs, pick, gran }: { bs: Bucket[]; pick: number | null; gran: string }) {
  const h = 120
  const max = niceMax(Math.max(...bs.map((b) => Math.abs(b.inSum - b.outSum))))
  const bw = (W - P.l - P.r) / bs.length
  const y = (v: number) => 10 + (1 - (v + max) / (2 * max)) * (h - 20)
  return (
    <svg viewBox={`0 0 ${W} ${h}`} role="img" aria-label={`Net ${unit.symbol} per ${gran}`} className="fl-net">
      <g className="fl-axis">
        <line className="fl-zero" x1={P.l} x2={W - P.r} y1={y(0)} y2={y(0)} />
        <text x={P.l - 8} y={y(max) + 3.5} textAnchor="end">
          +{short(max)}
        </text>
        <text x={P.l - 8} y={y(0) + 3.5} textAnchor="end">
          0
        </text>
        <text x={P.l - 8} y={y(-max) + 3.5} textAnchor="end">
          −{short(max)}
        </text>
      </g>
      {bs.map((b, i) => {
        const v = b.inSum - b.outSum
        const w = Math.max(1, bw - 2)
        const y0 = y(Math.max(0, v))
        const y1 = y(Math.min(0, v))
        return (
          <rect
            key={b.t}
            x={P.l + i * bw + 1}
            y={y0}
            width={w}
            height={Math.max(1, y1 - y0)}
            rx={Math.min(3, w / 3)}
            className={v >= 0 ? 'is-in' : 'is-out'}
            opacity={b.t === pick ? 1 : 0.75}
          >
            <title>{`${dayName(b.t)}: ${v >= 0 ? '+' : '−'}${fmt(Math.abs(v))} ${unit.symbol}`}</title>
          </rect>
        )
      })}
    </svg>
  )
}

function PoolChart({ bs }: { bs: Bucket[] }) {
  const h = 200
  const [hover, setHover] = useState<number | null>(null)
  const vals = bs.map((b) => b.pool ?? 0)
  const max = niceMax(Math.max(...vals))
  const { x, at } = scaleX(bs.length)
  const y = (v: number) => 10 + (1 - v / max) * (h - 10 - P.b)
  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
  const last = bs.length - 1
  return (
    <div className="fl-chart">
      <svg viewBox={`0 0 ${W} ${h}`} role="img" aria-label={`${unit.symbol} left for player rewards`}>
        <defs>
          <linearGradient id="fl-pool" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#199e70" stopOpacity=".28" />
            <stop offset="1" stopColor="#199e70" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g className="fl-axis">
          {[0, 1, 2, 3].map((k) => (
            <g key={k}>
              <line className="fl-grid" x1={P.l} x2={W - P.r} y1={y((max / 3) * k)} y2={y((max / 3) * k)} />
              <text x={P.l - 8} y={y((max / 3) * k) + 3.5} textAnchor="end">
                {short((max / 3) * k)}
              </text>
            </g>
          ))}
          <Ticks bs={bs} x={x} h={h} />
        </g>
        <path d={`M${pts.join('L')}L${x(last)},${y(0)}L${x(0)},${y(0)}Z`} fill="url(#fl-pool)" />
        <path d={`M${pts.join('L')}`} className="fl-line is-pool" />
        <circle cx={x(last)} cy={y(vals[last])} r={4} className="fl-end is-pool" />
        <text x={x(last) + 8} y={y(vals[last]) + 4} className="fl-endlab">
          {short(vals[last])}
        </text>
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={10} y2={h - P.b} className="fl-cross" />}
        <rect
          x={P.l}
          y={10}
          width={W - P.l - P.r}
          height={h - 10 - P.b}
          fill="transparent"
          onPointerMove={(e) => setHover(at(e))}
          onPointerLeave={() => setHover(null)}
        />
      </svg>
      {hover !== null && (
        <div className="fl-tip" style={{ left: `min(calc(100% - 230px), max(0px, calc(${(x(hover) / W) * 100}% + 14px)))` }}>
          <h4>{dayName(bs[hover].end - DAY)}</h4>
          <div className="fl-tip__row">
            <span>
              <i style={{ background: 'var(--fl-s3)' }} />
              Left for rewards
            </span>
            <b className="num">{fmt(vals[hover])}</b>
          </div>
          {hover > 0 && (
            <div className="fl-tip__row">
              <span>Change</span>
              <span className="num">
                {vals[hover] - vals[hover - 1] >= 0 ? '+' : '−'}
                {fmt(Math.abs(vals[hover] - vals[hover - 1]))}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Bars({ by, dir }: { by: Record<string, number>; dir: 'in' | 'out' }) {
  const list = CATEGORIES.filter((c) => c.dir === dir && (by[c.id] ?? 0) > 0).sort((a, b) => by[b.id] - by[a.id])
  const max = Math.max(1, ...list.map((c) => by[c.id]))
  if (!list.length) return <p className="fl-empty">Nothing in this filter.</p>
  return (
    <div className="fl-bars">
      {list.map((c) => (
        <div className="fl-bar" key={c.id}>
          <span title={c.name}>{c.name}</span>
          <span className="fl-bar__track">
            <i style={{ width: `${(by[c.id] / max) * 100}%`, background: c.color }} />
          </span>
          <b className="num">{fmt(by[c.id])}</b>
        </div>
      ))}
    </div>
  )
}

export default function Flow() {
  const navigate = useNavigate()
  const param = useParams().token?.toUpperCase()
  const token: FlowToken = param === 'DEF' ? 'DEF' : 'TLM'
  unit = FLOW_TOKENS[token]
  const sym = unit.symbol
  const today = dayOf(Date.now())
  const [range, setRange] = useState<Range>(7)
  const [custom, setCustom] = useState({ from: today - 13 * DAY, to: today })
  const [week, setWeek] = useState(false)
  const [contracts, setContracts] = useState<Set<string>>(() => new Set(PD_CONTRACTS))
  const [showInternal, setShowInternal] = useState(false)
  const [aliensInside, setAliensInside] = useState(true)
  const [account, setAccount] = useState('')
  const [pick, setPick] = useState<number | null>(null)
  const [acctTab, setAcctTab] = useState<'in' | 'out'>('in')
  const [rawDir, setRawDir] = useState<'all' | 'in' | 'out' | 'internal'>('all')
  const [rawQ, setRawQ] = useState('')
  const [sort, setSort] = useState<{ k: 't' | 'a'; d: 1 | -1 }>({ k: 't', d: -1 })
  const [page, setPage] = useState(0)
  const [round, setRound] = useState(0)
  const [copied, setCopied] = useState('')

  const from = range === 'custom' ? Math.min(custom.from, custom.to) : today - (range - 1) * DAY
  const to = range === 'custom' ? Math.max(custom.from, custom.to) : today
  const data = useFlowData(token, from, round)
  const gran = week ? 'week' : 'day'
  const opts = { contracts, aliensInside, showInternal, account }

  const bs = useMemo(
    () =>
      data.loading && !data.transfers.length ? [] : aggregate(data.transfers, { ...opts, from, to, week, poolNow: data.poolNow }),
    // opts is rebuilt every render; its parts are the real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.transfers, data.poolNow, data.loading, from, to, week, contracts, aliensInside, showInternal, account]
  )
  const picked = pick !== null ? (bs.find((b) => b.t === pick) ?? null) : null
  const scope = picked ? [picked] : bs
  const scopeFrom = scope[0]?.t ?? from
  const scopeTo = scope.at(-1)?.end ?? nextDay(to)
  const sum = (key: 'inBy' | 'outBy') => {
    const o: Record<string, number> = {}
    for (const b of scope) for (const [k, v] of Object.entries(b[key])) o[k] = (o[k] ?? 0) + v
    return o
  }
  const inBy = sum('inBy')
  const outBy = sum('outBy')
  const inT = bs.reduce((n, b) => n + b.inSum, 0)
  const outT = bs.reduce((n, b) => n + b.outSum, 0)
  const nDays = Math.round((nextDay(to) - from) / DAY)

  const rows = useMemo(
    () => rowsIn(data.transfers, opts, scopeFrom, scopeTo),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.transfers, scopeFrom, scopeTo, contracts, aliensInside, showInternal, account]
  )
  const byContract = useMemo(() => {
    const m = new Map<string, { i: number; o: number }>()
    for (const r of rows) {
      const e = m.get(r.contract) ?? { i: 0, o: 0 }
      if (r.dir === 'in') e.i += r.amount
      if (r.dir === 'out') e.o += r.amount
      m.set(r.contract, e)
    }
    return [...m].filter(([, v]) => v.i + v.o > 0).sort((a, b) => b[1].i + b[1].o - (a[1].i + a[1].o))
  }, [rows])
  const topAccounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) if (r.dir === acctTab) m.set(r.account, (m.get(r.account) ?? 0) + r.amount)
    return [...m].sort((a, b) => b[1] - a[1]).slice(0, 8)
  }, [rows, acctTab])

  const q = rawQ.trim().toLowerCase()
  const raw = useMemo(() => {
    const list = rows.filter(
      (r) =>
        (rawDir === 'all' || r.dir === rawDir) &&
        (!q || `${r.memo} ${r.account} ${r.trx} ${r.contract}`.toLowerCase().includes(q))
    )
    return list.sort((a, b) => (sort.k === 'a' ? a.amount - b.amount : a.t - b.t) * sort.d)
  }, [rows, rawDir, q, sort])
  const pages = Math.max(1, Math.ceil(raw.length / PER_PAGE))
  const pageNow = Math.min(page, pages - 1)

  const copyCsv = async () => {
    const lines = [
      'time,contract,direction,category,account,tlm,times,memo,tx',
      ...raw.map((r: FlowRow) =>
        [
          new Date(r.t).toISOString(),
          r.contract,
          r.dir,
          CATEGORY_BY_ID.get(r.category)?.name ?? r.category,
          r.account,
          r.amount.toFixed(4),
          r.times,
          `"${r.memo.replace(/"/g, '""')}"`,
          r.trx
        ].join(',')
      )
    ]
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      setCopied('Copied')
    } catch {
      setCopied('Copy blocked')
    }
    setTimeout(() => setCopied(''), 1500)
  }

  const setRangeTo = (r: Range) => {
    setRange(r)
    setPick(null)
    setPage(0)
  }
  const toggleContract = (c: string) =>
    setContracts((s) => {
      const n = new Set(s)
      if (n.has(c) && n.size > 1) n.delete(c)
      else n.add(c)
      return n
    })

  return (
    <div className="page flow">
      <header className="fl-intro">
        <div className="fl-title">
          <h1>{sym} flow</h1>
          <div className="segmented" role="group" aria-label="Token">
            {(['TLM', 'DEF'] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={token === t ? 'is-active' : ''}
                onClick={() => {
                  setPick(null)
                  setPage(0)
                  navigate(t === 'TLM' ? '/flow' : '/flow/def')
                }}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        <p>
          All {sym} going into and out of the Planetary Defense contracts, one line each. Transfers between PD&apos;s own
          contracts are left out, so nothing counts twice. The breakdown and the raw transfers cover the whole timeframe; tap a
          day on the chart to look at just that day.
        </p>
      </header>

      <section className="panel fl-filters" aria-label="Filters">
        <div className="fl-f">
          <span className="eyebrow">Range</span>
          <div className="segmented">
            {([7, 30, 90] as const).map((r) => (
              <button key={r} type="button" className={range === r ? 'is-active' : ''} onClick={() => setRangeTo(r)}>
                {r} D
              </button>
            ))}
            <button type="button" className={range === 'custom' ? 'is-active' : ''} onClick={() => setRangeTo('custom')}>
              Custom
            </button>
          </div>
        </div>
        {range === 'custom' && (
          <div className="fl-f">
            <span className="eyebrow">From – to</span>
            <span className="fl-dates">
              <input
                type="date"
                className="input fl-date"
                value={isoDate(custom.from)}
                max={isoDate(today)}
                onChange={(e) =>
                  e.target.value && setCustom((c) => ({ ...c, from: new Date(`${e.target.value}T00:00`).getTime() }))
                }
                aria-label="From"
              />
              <span className="faint">–</span>
              <input
                type="date"
                className="input fl-date"
                value={isoDate(custom.to)}
                max={isoDate(today)}
                onChange={(e) =>
                  e.target.value && setCustom((c) => ({ ...c, to: new Date(`${e.target.value}T00:00`).getTime() }))
                }
                aria-label="To"
              />
            </span>
          </div>
        )}
        <div className="fl-f">
          <span className="eyebrow">Per</span>
          <div className="segmented">
            <button type="button" className={!week ? 'is-active' : ''} onClick={() => setWeek(false)}>
              Day
            </button>
            <button type="button" className={week ? 'is-active' : ''} onClick={() => setWeek(true)}>
              Week
            </button>
          </div>
        </div>
        <div className="fl-f">
          <span className="eyebrow">Contracts</span>
          <div className="fl-chips">
            {PD_CONTRACTS.map((c) => (
              <button key={c} type="button" className="fl-chip" aria-pressed={contracts.has(c)} onClick={() => toggleContract(c)}>
                {c}
              </button>
            ))}
          </div>
        </div>
        <div className="fl-f">
          <span className="eyebrow">Options</span>
          <div className="fl-chips">
            <label className="fl-check">
              <input type="checkbox" checked={showInternal} onChange={(e) => setShowInternal(e.target.checked)} /> Show internal
              transfers
            </label>
            <label className="fl-check">
              <input type="checkbox" checked={aliensInside} onChange={(e) => setAliensInside(e.target.checked)} /> Count {ALIENS}{' '}
              as PD
            </label>
          </div>
        </div>
        <div className="fl-f">
          <label className="eyebrow" htmlFor="fl-who">
            Account
          </label>
          <input
            id="fl-who"
            className="input fl-search"
            placeholder="any account"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
          />
        </div>
      </section>

      {(data.loading || data.error) && (
        <section className={`fl-load${data.error ? ' is-error' : ''}`} aria-live="polite">
          <div>
            <b>{data.error ? 'The history could not be read' : 'Reading the history'}</b>
            <small>
              {data.error
                ? `${data.error}. Try again in a minute.`
                : `${data.progress?.label ?? 'Starting'} · read slowly so the history nodes don't block us; finished days are kept for next time.`}
            </small>
          </div>
          {data.error ? (
            <button type="button" className="fl-btn" onClick={() => setRound((r) => r + 1)}>
              Try again
            </button>
          ) : (
            <span className="fl-load__bar" role="progressbar" aria-valuenow={Math.round((data.progress?.share ?? 0) * 100)}>
              <i style={{ width: `${(data.progress?.share ?? 0) * 100}%` }} />
            </span>
          )}
        </section>
      )}

      {bs.length > 0 && (
        <>
          <section className="fl-figs" aria-label="Totals">
            <div className="panel fl-fig">
              <span className="eyebrow">
                <span className="fl-sw is-in" />
                {sym} in
              </span>
              <b className="num">
                {fmt(inT)} {sym}
              </b>
              <small>
                ≈ {fmt(inT / nDays)} a day over {nDays} days
              </small>
            </div>
            <div className="panel fl-fig">
              <span className="eyebrow">
                <span className="fl-sw is-out" />
                {sym} out
              </span>
              <b className="num">
                {fmt(outT)} {sym}
              </b>
              <small>
                ≈ {fmt(outT / nDays)} a day over {nDays} days
              </small>
            </div>
            <div className="panel fl-fig">
              <span className="eyebrow">Net</span>
              <b className="num">
                {inT - outT >= 0 ? '+' : '−'}
                {fmt(Math.abs(inT - outT))} {sym}
              </b>
              <small>{inT >= outT ? 'More came in than went out' : 'More went out than came in'}</small>
            </div>
          </section>

          <section className="panel" aria-label="In and out over time">
            <div className="fl-head">
              <h2>In and out over time</h2>
              <span className="fl-legend">
                <span>
                  <i className="is-in" />
                  In
                </span>
                <span>
                  <i className="is-out" />
                  Out
                </span>
              </span>
            </div>
            <InOutChart
              bs={bs}
              pick={pick}
              gran={gran}
              onPick={(t) => {
                setPick(t)
                setPage(0)
              }}
            />
            <div className="fl-head fl-head--net">
              <h3>Net per {gran}</h3>
              <span className="fl-legend">
                <span>
                  <i className="is-in" />
                  more in
                </span>
                <span>
                  <i className="is-out" />
                  more out
                </span>
              </span>
            </div>
            <NetBars bs={bs} pick={pick} gran={gran} />
          </section>

          {data.poolNow !== null && (
            <section className="panel" aria-label="Left for player rewards">
              <div className="fl-head">
                <h2>Left for player rewards</h2>
                <span className="fl-legend">
                  <span>
                    <i className="is-pool" />
                    {'miss.pdef'} balance
                  </span>
                </span>
              </div>
              <p className="fl-sub">
                What the mission contract holds to pay rewards from, at the end of each {gran}: {fmt(data.poolNow)} {sym} now. It
                grows with entry fees and top-ups and shrinks with every reward paid.
              </p>
              <PoolChart bs={bs} />
            </section>
          )}

          <section className="panel" aria-label="Breakdown">
            <div className="fl-head">
              <h2>
                {picked
                  ? week
                    ? `Week of ${dayName(picked.t)}`
                    : new Date(picked.t).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
                  : `Whole timeframe · ${dayName(scopeFrom)} – ${dayName(scopeTo - DAY)}`}
              </h2>
              {picked ? (
                <button type="button" className="fl-btn" onClick={() => setPick(null)}>
                  Whole timeframe
                </button>
              ) : (
                <small className="faint">Tap a day on the chart to look at just that day</small>
              )}
            </div>
            <div className="fl-dive">
              <div>
                <h3>Where it came from</h3>
                <Bars by={inBy} dir="in" />
              </div>
              <div>
                <h3>Where it went</h3>
                <Bars by={outBy} dir="out" />
              </div>
              <div>
                <h3>By contract</h3>
                <table className="fl-mini">
                  <thead>
                    <tr>
                      <th>Contract</th>
                      <th>In</th>
                      <th>Out</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byContract.map(([c, v]) => (
                      <tr key={c}>
                        <td>{c}</td>
                        <td className="num">{fmt(v.i)}</td>
                        <td className="num">{fmt(v.o)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <h3>Biggest accounts</h3>
                <div className="segmented fl-tabs">
                  <button type="button" className={acctTab === 'in' ? 'is-active' : ''} onClick={() => setAcctTab('in')}>
                    Paid in
                  </button>
                  <button type="button" className={acctTab === 'out' ? 'is-active' : ''} onClick={() => setAcctTab('out')}>
                    Received
                  </button>
                </div>
                <table className="fl-mini">
                  <tbody>
                    {topAccounts.map(([a, v]) => (
                      <tr key={a}>
                        <td>
                          <button type="button" className="fl-link" onClick={() => setAccount(a)} title="Show only this account">
                            {a}
                          </button>
                        </td>
                        <td className="num">
                          {fmt(v)} {sym}
                        </td>
                      </tr>
                    ))}
                    {!topAccounts.length && (
                      <tr>
                        <td className="faint">None</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          <section className="panel" aria-label="Raw transfers">
            <div className="fl-head fl-raw-head">
              <h2>Raw transfers</h2>
              <div className="fl-raw-tools">
                <div className="segmented">
                  {(['all', 'in', 'out', ...(showInternal ? ['internal'] : [])] as const).map((d) => (
                    <button
                      key={d}
                      type="button"
                      className={rawDir === d ? 'is-active' : ''}
                      onClick={() => {
                        setRawDir(d as typeof rawDir)
                        setPage(0)
                      }}
                    >
                      {d === 'all' ? 'All' : d === 'in' ? 'In' : d === 'out' ? 'Out' : 'Internal'}
                    </button>
                  ))}
                </div>
                <input
                  className="input fl-search"
                  placeholder="memo, account or tx"
                  value={rawQ}
                  onChange={(e) => {
                    setRawQ(e.target.value)
                    setPage(0)
                  }}
                />
                <button type="button" className="fl-btn" onClick={() => void copyCsv()}>
                  {copied || 'Copy as CSV'}
                </button>
              </div>
            </div>
            <div className="fl-table-wrap">
              <table className="fl-raw">
                <thead>
                  <tr>
                    <th>
                      <button type="button" onClick={() => setSort((s) => ({ k: 't', d: s.k === 't' ? (-s.d as 1 | -1) : -1 }))}>
                        Time {sort.k === 't' ? (sort.d < 0 ? '▾' : '▴') : ''}
                      </button>
                    </th>
                    <th>Contract</th>
                    <th>Direction</th>
                    <th>Category</th>
                    <th>Account</th>
                    <th className="r">
                      <button type="button" onClick={() => setSort((s) => ({ k: 'a', d: s.k === 'a' ? (-s.d as 1 | -1) : -1 }))}>
                        {sym} {sort.k === 'a' ? (sort.d < 0 ? '▾' : '▴') : ''}
                      </button>
                    </th>
                    <th>Memo</th>
                    <th>Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {raw.slice(pageNow * PER_PAGE, pageNow * PER_PAGE + PER_PAGE).map((r) => (
                    <tr key={`${r.gs}-${r.contract}`}>
                      <td className="num">
                        {new Date(r.t).toLocaleString('en-GB', {
                          day: 'numeric',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit'
                        })}
                      </td>
                      <td>{r.contract}</td>
                      <td>
                        <span className={`fl-dir is-${r.dir}`}>
                          <i />
                          {r.dir}
                        </span>
                      </td>
                      <td>{CATEGORY_BY_ID.get(r.category)?.name}</td>
                      <td>{r.account}</td>
                      <td className="r num">
                        {r.amount.toFixed(4)}
                        {r.times > 1 && <small className="faint"> ({r.times}×)</small>}
                      </td>
                      <td className="fl-memo" title={r.memo}>
                        {r.memo}
                      </td>
                      <td>
                        <a className="fl-tx" href={`https://waxblock.io/transaction/${r.trx}`} target="_blank" rel="noreferrer">
                          {r.trx.slice(0, 8)}…
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="fl-pager">
              <span className="faint">
                {raw.length.toLocaleString('en-US')} transfers · page {pageNow + 1} of {pages}
              </span>
              <span>
                <button type="button" className="fl-btn" disabled={pageNow === 0} onClick={() => setPage(pageNow - 1)}>
                  Previous
                </button>{' '}
                <button type="button" className="fl-btn" disabled={pageNow >= pages - 1} onClick={() => setPage(pageNow + 1)}>
                  Next
                </button>
              </span>
            </div>
          </section>

          <section className="fl-notes faint">
            <span>
              <b>In</b>: {sym} sent to a PD contract from outside (game balance deposits, entry fees paid directly, Forge levels
              and slots, reward pool top-ups, campaign entries and funding
              {token === 'DEF' ? ', newly minted DEF from defensetoken' : ''}). <b>Out</b>: {sym} a PD contract sends outside
              (mission rewards, balance withdrawals, campaign payouts). Claims batched in one transaction count once per claim.
            </span>
            <span>
              Data from the WAX history nodes.{' '}
              <button type="button" className="fl-link" onClick={() => setRound((r) => r + 1)}>
                Read it all again
              </button>
            </span>
          </section>
        </>
      )}
    </div>
  )
}
