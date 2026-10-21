import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { claimMission, recalcDivision } from '@/chain/actions/pd'
import { claimSiegeAction, contributeDefAction, depositTlmAction, joinSiegeAction } from '@/chain/actions/siege'
import { TokenIcon } from '@/components/Art'
import { Button } from '@/components/Button'
import { Loading } from '@/components/Loading'
import { Tooltip } from '@/components/Tooltip'
import { useCollectionTemplates, useTemplatePrices } from '@/data/blends'
import { useArmy, useDeployments, useMarket, usePlayer, useTemplates, type Division } from '@/data/game'
import { useSwapPools } from '@/data/market'
import {
  FUNDER_BONUS,
  joinOpen,
  refreshSieges,
  useEntryCredit,
  useLeaderboard,
  usePastSeasons,
  useRankPrizes,
  useSeasonFunders,
  useSiegeEntries,
  useSieges,
  useTlmBalance,
  type Funder,
  type PastSeason,
  type RankPrize,
  type ScoreRow,
  type Siege
} from '@/data/siege'
import { SIEGE_LORE } from '@/data/siegeLore'
import { SALE_KEEP } from '@/lib/blendEconomy'
import { formatNumber, formatToken, titleCase } from '@/lib/format'
import { receiveFor } from '@/lib/pool'
import { publicUrl } from '@/lib/publicUrl'
import { fundingEta, joinsUntil, projectSiege, type ProjectedDivision, type Projection } from '@/lib/siegeProjection'
import { missionLockSeconds } from '@/lib/stats'
import { chainDate, shortDuration, useNow } from '@/lib/time'
import { useTransaction } from '@/wallet/useTransaction'

import './Planets.css'

/*
 * Planetary sieges, laid out for planning. A world goes through three phases: the community funds
 * it with DEF (the three biggest funders earn a score bonus), then for a season divisions join for
 * a TLM fee and each join adds the division's attack and defense to the player's score, then the
 * ranks are paid in DEF and NFTs. Every phase opens on a timeline, the figures that matter, and one
 * table of every paid rank with its prize written out.
 */

const QUICK_DEF = [10, 50, 100, 500]
const pct = (b: number) => `+${Math.round(b * 100)}%`
const kfmt = (n: number) =>
  Math.abs(n) >= 1e6 ? `${formatNumber(n / 1e6, 2)}M` : Math.abs(n) >= 1e4 ? `${formatNumber(n / 1e3, 0)}k` : formatNumber(n, 0)
const day = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
const dayTime = (t: number) =>
  new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

type Run = ReturnType<typeof useTransaction>['run']
type RunSequence = ReturnType<typeof useTransaction>['runSequence']
interface Tx {
  account: string | null
  run: Run
  runSequence: RunSequence
  pending: string | null
  spectating: boolean
}

/** What a world shows: funding, a live season, a finished season, or nothing yet. */
type View = { kind: 'sealed' } | { kind: 'fund' } | { kind: 'live' } | { kind: 'settled'; season: number }

function railLabel(s: Siege, now: number) {
  if (!s.onChain) return 'Sealed'
  if (s.status === 'locked') return `Funding · ${formatNumber((s.fundedDef / (s.thresholdDef || 1)) * 100, 1)}%`
  if (s.status === 'active') return s.endAt ? `Siege · ${shortDuration(s.endAt - now)} on the timer` : 'Siege open'
  return s.status === 'met' ? 'Targets met' : 'Season failed'
}

export default function Planets() {
  const { account, run, runSequence, pending, spectating } = useTransaction()
  const sieges = useSieges()
  const now = useNow(1000)
  const [picked, setPicked] = useState<string | null>(null)

  // Open the world with the most going on: an active siege, then one being funded.
  const list = sieges.data ?? []
  const fallback = list.find((s) => s.status === 'active')?.planet ?? list.find((s) => s.onChain)?.planet ?? 'magor'
  const planet = picked ?? fallback
  const siege = list.find((s) => s.planet === planet) ?? null

  if (sieges.isLoading && !sieges.data) return <Loading inline label="Surveying the worlds" />

  return (
    <div className="page pl-page">
      <header className="pl-head">
        <div>
          <p className="eyebrow">Planetary sieges</p>
          <h2>Campaigns</h2>
        </div>
        <nav className="pl-rail" aria-label="Worlds">
          {list.map((s) => (
            <button
              key={s.planet}
              type="button"
              aria-pressed={s.planet === planet}
              className={`pl-rail__world is-${s.status}`}
              onClick={() => setPicked(s.planet)}
            >
              <img src={publicUrl(`/img/planets/${s.planet}.png`)} alt="" />
              <span>
                <b>{titleCase(s.planet)}</b>
                <small>{railLabel(s, now)}</small>
              </span>
            </button>
          ))}
        </nav>
      </header>

      {siege && <World key={siege.planet} siege={siege} now={now} tx={{ account, run, runSequence, pending, spectating }} />}
    </div>
  )
}

// ---- Prize names and what they would fetch ------------------------------------------------------------

interface Valuer {
  name: (templateId: string, count: number) => string
  /** TLM a prize would fetch: DEF at the pool rate, NFTs at their AtomicMarket median after fees. */
  worth: (p: RankPrize | null | undefined) => number
  text: (p: RankPrize | null | undefined) => string
  defTlm: number
}

function useValuer(): Valuer {
  const stats = useTemplates()
  const templates = useCollectionTemplates()
  const prices = useTemplatePrices()
  const pools = useSwapPools()
  const market = useMarket()
  return useMemo(() => {
    const median = new Map((prices.data ?? []).map((p) => [String(p.templateId), p.median]))
    const tlmPerWax = pools.data ? receiveFor(pools.data.tlm, 'WAX', 100) / 100 : 0
    const base = (t: string) => stats.data?.[t]?.name ?? templates.data?.get(t)?.name ?? `#${t}`
    const name = (t: string, count: number) => {
      const n = base(t)
      // Plural only for plain names: not "Luminyx", "DogX403 - The "Hotdog"" or anything ending in a digit.
      return count === 1 || /[sxzy"\d]$/i.test(n) ? n : `${n}s`
    }
    const worth = (p: RankPrize | null | undefined) =>
      p
        ? p.def * market.rate + p.nfts.reduce((n, x) => n + (median.get(x.templateId) ?? 0) * tlmPerWax * SALE_KEEP * x.count, 0)
        : 0
    const text = (p: RankPrize | null | undefined) =>
      p
        ? [
            `${formatNumber(p.def, 0)} DEF`,
            ...p.nfts.map((x) => `${formatNumber(x.count, 0)} ${name(x.templateId, x.count)}`)
          ].join(', ')
        : '–'
    return { name, worth, text, defTlm: market.rate }
  }, [stats.data, templates.data, prices.data, pools.data, market.rate])
}

// ---- One world -----------------------------------------------------------------------------------------

function World({ siege: s, now, tx }: { siege: Siege; now: number; tx: Tx }) {
  const lore = SIEGE_LORE[s.planet]
  const past = usePastSeasons(s.onChain ? s.planetId : null)
  const seasons = past.data ?? []
  const currentView: View = !s.onChain
    ? { kind: 'sealed' }
    : s.status === 'locked'
      ? { kind: 'fund' }
      : s.status === 'active'
        ? { kind: 'live' }
        : { kind: 'settled', season: s.season }
  const [pickedSeason, setPickedSeason] = useState<number | null>(null)
  const view: View = pickedSeason && pickedSeason !== s.season ? { kind: 'settled', season: pickedSeason } : currentView
  const pastSeason = view.kind === 'settled' ? (seasons.find((p) => p.season === view.season) ?? null) : null
  const shown = view.kind === 'settled' ? view.season : s.season

  return (
    <section className="pl-world">
      <header className="pl-world__head">
        <img src={publicUrl(`/img/planets/${s.planet}.png`)} alt="" />
        <h3>{titleCase(s.planet)}</h3>
        <span className={`pl-state ${view.kind === 'live' ? 'is-live' : ''}`}>
          {view.kind === 'sealed'
            ? 'Sealed'
            : view.kind === 'fund'
              ? 'Funding'
              : view.kind === 'live'
                ? 'Siege · live'
                : 'Settled'}
        </span>
        {seasons.length > 0 && (
          <span className="pl-switch" role="group" aria-label="Season">
            {[...Array.from({ length: s.season }, (_, i) => i + 1)].reverse().map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={n === shown}
                disabled={n !== s.season && !seasons.some((p) => p.season === n)}
                onClick={() => setPickedSeason(n === s.season ? null : n)}
              >
                Season {n}
                {n === s.season
                  ? currentView.kind === 'live'
                    ? ' · live'
                    : currentView.kind === 'fund'
                      ? ' · funding'
                      : ''
                  : ''}
              </button>
            ))}
          </span>
        )}
        <span className="pl-world__meta">{metaLine(s, view, pastSeason, now)}</span>
      </header>

      {view.kind === 'sealed' ? (
        <p className="pl-note">{lore?.tagline ?? ''} Nothing moves here until the game opens this world.</p>
      ) : (
        <>
          <Phases siege={s} view={view} past={pastSeason} />
          {view.kind === 'fund' && <FundingView siege={s} now={now} tx={tx} />}
          {view.kind === 'live' && <LiveView siege={s} now={now} tx={tx} />}
          {view.kind === 'settled' && (
            <SettledView siege={s} season={view.season} past={pastSeason} now={now} loading={past.isLoading} />
          )}
        </>
      )}
      {lore && <Dossier planet={s.planet} lore={lore.lore} />}
    </section>
  )
}

function metaLine(s: Siege, view: View, past: PastSeason | null, now: number) {
  const min = `min ${formatNumber(s.minAtk, 0)} ATK / ${formatNumber(s.minDef, 0)} DEF per division`
  if (view.kind === 'fund')
    return `Season ${s.season} · ${s.durationDays}-day siege once open · entry ${formatToken(s.entryTlm)} TLM · ${min}`
  if (view.kind === 'live') {
    const dayNo = s.startAt ? (now - s.startAt) / 86_400_000 : 0
    return `Season ${s.season} · day ${formatNumber(dayNo, 1)} of ${s.durationDays} · entry ${formatToken(s.entryTlm)} TLM · cooldown ${formatNumber(s.cooldownBase / 3600, 1)}h + 10 s per move · ${min}`
  }
  if (view.kind === 'settled')
    return past
      ? `Season ${past.season} · closed ${dayTime(past.closedAt)} · entry ${formatToken(past.entryTlm)} TLM`
      : `Season ${view.season}`
  return ''
}

/** The three phases of a season, the current one marked, with this world's numbers. */
function Phases({ siege: s, view, past }: { siege: Siege; view: View; past: PastSeason | null }) {
  const at = view.kind === 'fund' ? 0 : view.kind === 'live' ? 1 : 3
  const days = view.kind === 'settled' && past ? past.durationDays : s.durationDays
  const entry = view.kind === 'settled' && past ? past.entryTlm : s.entryTlm
  const steps: [string, ReactNode][] = [
    [
      'Fund',
      <>
        The community {at === 0 ? 'sends' : 'sent'}{' '}
        {formatNumber(view.kind === 'settled' && past ? past.thresholdDef : s.thresholdDef, 0)} DEF to open the world. The three
        biggest funders get <b>{FUNDER_BONUS.map(pct).join(' / ')}</b> on their score in the siege.
      </>
    ],
    [
      'Siege',
      <>
        For {days} days, divisions join for {formatToken(entry)} TLM each. Every join adds the division's ATK and DEF to your
        score.
      </>
    ],
    [
      'Prizes',
      view.kind === 'settled' && past ? (
        <>Paid on {day(past.closedAt)} in DEF, Quantum Chests and NFTs.</>
      ) : (
        <>When the season closes, leaderboard ranks are paid in DEF, Quantum Chests and NFTs.</>
      )
    ]
  ]
  return (
    <ol className="pl-phases">
      {steps.map(([title, body], i) => (
        <li key={title} className={i === at ? 'is-now' : i < at ? 'is-done' : ''}>
          <span className="pl-phases__n">{i < at ? '✓' : i + 1}</span>
          <div>
            <b>
              {title}
              {i === at && <em>Now</em>}
            </b>
            <p>{body}</p>
          </div>
        </li>
      ))}
    </ol>
  )
}

// ---- Shared pieces ---------------------------------------------------------------------------------------

interface Mark {
  at: number
  label: string
  sub: string
  tone?: 'now' | 'proj'
}

/** A line from `from` to `to` with labelled marks; the part up to now is drawn solid. */
function Timeline({
  from,
  to,
  now,
  marks,
  band
}: {
  from: number
  to: number
  now: number
  marks: Mark[]
  band?: [number, number]
}) {
  const x = (t: number) => Math.min(100, Math.max(0, ((t - from) / (to - from || 1)) * 100))
  return (
    <div className="pl-tl">
      <div className="pl-tl__axis" />
      <div className="pl-tl__past" style={{ width: `${x(now)}%` }} />
      {band && (
        <div className="pl-tl__band" style={{ left: `${x(band[0])}%`, width: `${Math.max(0.6, x(band[1]) - x(band[0]))}%` }} />
      )}
      {marks.map((m, i) => {
        const pos = x(m.at)
        const edge = pos < 6 ? 'is-l' : pos > 94 ? 'is-r' : ''
        return (
          <div key={i} className={`pl-tl__m ${m.tone ? `is-${m.tone}` : ''} ${edge}`} style={{ left: `${pos}%` }}>
            <span>{m.label}</span>
            <i />
            <small>{m.sub}</small>
          </div>
        )
      })}
    </div>
  )
}

function Figures({ items }: { items: { label: string; value: ReactNode; tone?: string }[] }) {
  return (
    <div className="pl-figs">
      {items.map((f) => (
        <div key={f.label}>
          <small>{f.label}</small>
          <b className={f.tone ?? ''}>{f.value}</b>
        </div>
      ))}
    </div>
  )
}

function Bar({
  label,
  tone,
  value,
  target,
  note
}: {
  label: string
  tone: string
  value: number
  target: number
  note: ReactNode
}) {
  const share = target > 0 ? Math.min(1, value / target) : 0
  return (
    <div className={`pl-bar is-${tone}`}>
      <span className="pl-bar__label">{label}</span>
      <span className="pl-bar__track">
        <i style={{ width: `${Math.max(share > 0 ? 0.5 : 0, share * 100)}%` }} />
      </span>
      <span className="num">
        {formatNumber(value, 0)} / {kfmt(target)} <span className="faint">{note}</span>
      </span>
    </div>
  )
}

interface RankLine {
  rank: number
  /** Null for a paid rank nobody holds. */
  account: string | null
  me?: boolean
  bonus?: number
  cells: ReactNode[]
}

/** Every paid rank (and every player past them) on its own line, the prize written out. */
function RankTable({
  head,
  lines,
  prizes,
  valuer,
  emptyLabel = 'Open'
}: {
  head: string[]
  lines: RankLine[]
  prizes: RankPrize[]
  valuer: Valuer
  emptyLabel?: string
}) {
  const byRank = new Map(prizes.map((p) => [p.rank, p]))
  const last = Math.max(prizes.length ? prizes[prizes.length - 1].rank : 0, lines.length)
  const rows: ReactNode[] = []
  let prev = ''
  for (let rank = 1; rank <= last; rank++) {
    const line = lines[rank - 1]
    const prize = byRank.get(rank)
    const text = valuer.text(prize)
    const tier = rank > 1 && text !== prev
    prev = text
    rows.push(
      <tr key={rank} className={`${line?.me ? 'is-me' : ''} ${line ? '' : 'is-open'} ${tier ? 'is-tier' : ''}`}>
        <td className="num faint">{rank}</td>
        <td>
          {line ? line.account : emptyLabel}
          {line?.me && <span className="pl-tag is-me">you, deploying constantly</span>}
          {line?.bonus ? <span className="pl-tag is-bonus">{pct(line.bonus)} funder</span> : null}
        </td>
        {head.slice(2, -2).map((_, i) => (
          <td key={i} className="r num">
            {line ? line.cells[i] : ''}
          </td>
        ))}
        <td className="r num">{prize ? kfmt(valuer.worth(prize)) : ''}</td>
        <td>{prize ? text : <span className="faint">no prize</span>}</td>
      </tr>
    )
  }
  return (
    <div className="pl-table">
      <table>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h} className={i >= 2 && i < head.length - 1 ? 'r' : ''}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  )
}

// ---- Funding -----------------------------------------------------------------------------------------------

function FundingView({ siege: s, now, tx }: { siege: Siege; now: number; tx: Tx }) {
  const valuer = useValuer()
  const prizes = useRankPrizes(s.planetId)
  const army = useArmy(tx.account)
  const { funders, recent, isLoading } = useSeasonFunders(s)
  const [amount, setAmount] = useState('')
  const since = recent.length ? recent[recent.length - 1].at : null
  const eta = fundingEta(s.fundedDef, s.thresholdDef, since, now)
  const perDay = since ? (s.fundedDef / Math.max(3_600_000, now - since)) * 86_400_000 : 0
  const divisions = (army.data?.divisions ?? []).filter((d) => d.units.length > 0)
  const qualifying = divisions.filter((d) => d.atk >= s.minAtk && d.def >= s.minDef)
  const place = (i: number) => (funders[i] ? Math.floor(funders[i].def) + 1 : 1)
  const ranks = prizes.data ?? []

  return (
    <>
      {since && eta && (
        <Timeline
          from={since}
          to={Math.max(eta, now + 86_400_000)}
          now={now}
          marks={[
            { at: since, label: 'Funding opened', sub: day(since) },
            {
              at: now,
              label: `Now · ${formatNumber((s.fundedDef / (s.thresholdDef || 1)) * 100, 1)}%`,
              sub: day(now),
              tone: 'now'
            },
            { at: eta, label: 'Fully funded at this pace', sub: day(eta), tone: 'proj' }
          ]}
        />
      )}
      <Figures
        items={[
          { label: 'To open', value: `${formatNumber(Math.max(0, s.thresholdDef - s.fundedDef), 0)} DEF` },
          { label: 'Pace', value: `${formatNumber(perDay, 1)} DEF/day` },
          { label: 'Opens ≈', value: eta ? day(eta) : '–' },
          ...FUNDER_BONUS.map((b, i) => ({
            label: `${pct(b)} place`,
            value: `${formatNumber(place(i), 0)} DEF`,
            tone: i === 0 ? 'c-cyan' : ''
          })),
          { label: 'Your divisions', value: tx.account ? `${qualifying.length} of ${divisions.length} qualify` : '–' }
        ]}
      />
      <Bar
        label="Funded"
        tone="fund"
        value={s.fundedDef}
        target={s.thresholdDef}
        note={`${formatNumber((s.fundedDef / (s.thresholdDef || 1)) * 100, 1)}%`}
      />

      <div className="pl-cols">
        <div className="pl-sec">
          <div className="pl-sec__label">
            <span>Campaign requirements</span>
          </div>
          <div className="pl-table">
            <table>
              <tbody>
                <tr>
                  <td className="faint">Community target</td>
                  <td className="r num">
                    {formatNumber(s.targetAtk, 0)} ATK and {formatNumber(s.targetDef, 0)} DEF
                  </td>
                </tr>
                <tr>
                  <td className="faint">Season length</td>
                  <td className="r num">{s.durationDays} days from opening</td>
                </tr>
                <tr>
                  <td className="faint">Division minimum</td>
                  <td className="r num">
                    {formatNumber(s.minAtk, 0)} ATK and {formatNumber(s.minDef, 0)} DEF
                  </td>
                </tr>
                <tr>
                  <td className="faint">Entry per join</td>
                  <td className="r num">{formatToken(s.entryTlm)} TLM</td>
                </tr>
                <tr>
                  <td className="faint">Cooldown</td>
                  <td className="r num">{formatNumber(s.cooldownBase / 3600, 1)}h + 10 s per move</td>
                </tr>
                <tr>
                  <td className="faint">Funder bonus</td>
                  <td className="r num">{FUNDER_BONUS.map(pct).join(' / ')} to the top 3</td>
                </tr>
                <tr>
                  <td className="faint">Paid ranks</td>
                  <td className="r num">{ranks.length || '–'}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {tx.account && divisions.length > 0 && (
            <>
              <div className="pl-sec__label">
                <span>Your divisions</span>
                <span>against this world's minimum</span>
              </div>
              <div className="pl-table">
                <table>
                  <thead>
                    <tr>
                      <th>Division</th>
                      <th className="r">ATK</th>
                      <th className="r">DEF</th>
                      <th className="r">Move</th>
                      <th className="r">Cycle</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {divisions.map((d) => {
                      const ok = d.atk >= s.minAtk && d.def >= s.minDef
                      return (
                        <tr key={d.id} className={ok ? '' : 'is-open'}>
                          <td className="num">#{d.id}</td>
                          <td className="r num c-atk">{formatNumber(d.atk, 0)}</td>
                          <td className="r num c-def">{formatNumber(d.def, 0)}</td>
                          <td className="r num faint">{formatNumber(d.move, 0)}</td>
                          <td className="r num">{ok ? shortDuration(missionLockSeconds(s.cooldownBase, d.move) * 1000) : ''}</td>
                          <td>{ok ? <span className="c-green">qualifies</span> : `below ${s.minAtk} / ${s.minDef}`}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
        <div className="pl-sec">
          <FundForm siege={s} tx={tx} amount={amount} setAmount={setAmount} />
          <FunderPlaces funders={funders} loading={isLoading} account={tx.account} onTake={(def) => setAmount(String(def))} />
        </div>
      </div>

      <div className="pl-sec">
        <div className="pl-sec__label">
          <span>Prizes once the season runs</span>
          <span>{ranks.length} ranks · prize written out per rank</span>
        </div>
        {prizes.isLoading ? (
          <p className="pl-note">Reading the prize table…</p>
        ) : (
          <RankTable head={['#', 'Player', '≈ TLM', 'Prize']} lines={[]} prizes={ranks} valuer={valuer} />
        )}
      </div>
    </>
  )
}

function FundForm({
  siege: s,
  tx,
  amount: text,
  setAmount
}: {
  siege: Siege
  tx: Tx
  amount: string
  setAmount: (v: string) => void
}) {
  const player = usePlayer(tx.account)
  const [agreed, setAgreed] = useState(false)
  const amount = Math.max(0, Number(text) || 0)
  const remaining = Math.max(0, s.thresholdDef - s.fundedDef)
  const have = player.data?.def ?? 0

  async function contribute() {
    if (!(amount > 0) || !agreed) return
    const ok = await tx.run(
      (a, p) => contributeDefAction(a, p, s.planetId, amount),
      `${formatToken(amount)} DEF sent to ${titleCase(s.planet)}`,
      'contribute'
    )
    if (ok) {
      setAmount('')
      setAgreed(false)
      void refreshSieges(tx.account)
    }
  }

  return (
    <div className="pl-box">
      <div className="pl-sec__label">
        <span>Fund this world</span>
        <span>you hold {formatToken(have)} DEF</span>
      </div>
      <div className="pl-fund">
        <span className="pl-fund__input">
          <input
            className="num"
            inputMode="decimal"
            value={text}
            placeholder="0"
            aria-label="DEF to send"
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
          />
          <span>
            <TokenIcon symbol="DEF" size={14} /> DEF
          </span>
        </span>
        <span className="pl-chips">
          {QUICK_DEF.map((q) => (
            <button key={q} type="button" onClick={() => setAmount(String(q))}>
              {q}
            </button>
          ))}
          <button type="button" disabled={remaining <= 0} onClick={() => setAmount(String(Math.ceil(remaining)))}>
            Rest
          </button>
        </span>
      </div>
      {amount > have && <small className="c-red">More than you hold.</small>}
      <label className="pl-fund__agree">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <span>Sent DEF is never returned, whatever happens in the season.</span>
      </label>
      <Button
        color="gradientYellow"
        disabled={tx.spectating || !agreed || !(amount > 0) || amount > have}
        isLoading={tx.pending === 'contribute'}
        onClick={contribute}
      >
        Send {amount > 0 ? `${formatToken(amount)} DEF` : 'DEF'}
      </Button>
    </div>
  )
}

/** The bonus places: who holds them, and what it takes to claim one. */
function FunderPlaces({
  funders,
  loading,
  account,
  onTake
}: {
  funders: Funder[]
  loading: boolean
  account: string | null
  onTake?: (def: number) => void
}) {
  const mine = funders.find((f) => f.account === account)
  const mineDef = mine?.def ?? 0
  return (
    <div className="pl-sec">
      <div className="pl-sec__label">
        <span>Funder places</span>
        <Tooltip text="Seen in the contract after the first Magor season: the three biggest DEF funders had 15, 10 and 5 percent added to their siege score at season close." />
      </div>
      {loading ? (
        <p className="pl-note">Reading the contributions…</p>
      ) : (
        <div className="pl-table">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Funder</th>
                <th className="r">DEF sent</th>
                <th className="r">Bonus</th>
                <th className="r">To take it</th>
              </tr>
            </thead>
            <tbody>
              {FUNDER_BONUS.map((bonus, i) => {
                const f = funders[i]
                // One whole DEF more than the holder has sent, less what you sent already.
                const need = f ? Math.max(1, Math.floor(f.def - mineDef) + 1) : 1
                const yours = !!f && f.account === account
                return (
                  <tr key={i} className={yours ? 'is-me' : f ? '' : 'is-open'}>
                    <td className="num faint">{i + 1}</td>
                    <td>{f ? f.account : 'Open'}</td>
                    <td className="r num">{f ? formatNumber(f.def, 0) : ''}</td>
                    <td className="r num">{pct(bonus)}</td>
                    <td className="r num">
                      {onTake && !yours ? (
                        <button type="button" className="pl-link num" onClick={() => onTake(need)}>
                          {formatNumber(need, 0)} DEF
                        </button>
                      ) : (
                        ''
                      )}
                    </td>
                  </tr>
                )
              })}
              {funders.length > 3 && (
                <tr className="is-open">
                  <td className="num">4–{funders.length}</td>
                  <td colSpan={4}>{funders.length - 3} more funders</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {mine && mine.rank > 3 && (
        <p className="pl-note">
          You sent {formatNumber(mine.def, 0)} DEF so far: funder #{mine.rank}.
        </p>
      )}
    </div>
  )
}

// ---- The live season ---------------------------------------------------------------------------------------

/** What a division can do on this world right now, and the actions that get it in. */
interface DivisionState {
  division: Division
  qualifies: boolean
  readyAt: number
  /** The siege entry or mission it has to be claimed from first. */
  claim: { kind: 'siege'; entryId: number } | { kind: 'mission'; missionId: number } | null
  status: string
}

function LiveView({ siege: s, now, tx }: { siege: Siege; now: number; tx: Tx }) {
  const valuer = useValuer()
  const prizes = useRankPrizes(s.planetId)
  const board = useLeaderboard(s)
  const { funders } = useSeasonFunders(s)
  const army = useArmy(tx.account)
  const entries = useSiegeEntries(tx.account, [s.planetId])
  const missions = useDeployments(tx.account)
  const [boardView, setBoardView] = useState<'now' | 'close'>('now')

  const bonus = useMemo(() => new Map(funders.slice(0, 3).map((f, i) => [f.account, FUNDER_BONUS[i]])), [funders])
  const funded = useMemo(() => new Map(funders.map((f) => [f.account, f.def])), [funders])

  // Every division, with where it is and what it takes to send it here.
  const states = useMemo<DivisionState[]>(() => {
    const inSiege = new Map((entries.data ?? []).filter((e) => e.planetId === s.planetId).map((e) => [e.divisionId, e]))
    const onMission = new Map((missions.data ?? []).map((m) => [m.divisionId, m]))
    return (army.data?.divisions ?? [])
      .filter((d) => d.units.length > 0)
      .map((d) => {
        const qualifies = d.atk >= s.minAtk && d.def >= s.minDef
        const entry = inSiege.get(d.id)
        const mission = onMission.get(d.id)
        const lock = d.lock ? +chainDate(d.lock.locked_until) : 0
        if (entry)
          return entry.unlockAt > now
            ? {
                division: d,
                qualifies,
                readyAt: entry.unlockAt,
                claim: null,
                status: `In the siege, back in ${shortDuration(entry.unlockAt - now)}`
              }
            : {
                division: d,
                qualifies,
                readyAt: now,
                claim: { kind: 'siege' as const, entryId: entry.entryId },
                status: 'Back from the siege, unclaimed'
              }
        if (mission)
          return mission.unlockAt > now
            ? {
                division: d,
                qualifies,
                readyAt: mission.unlockAt,
                claim: null,
                status: `On a mission, back in ${shortDuration(mission.unlockAt - now)}`
              }
            : {
                division: d,
                qualifies,
                readyAt: now,
                claim: { kind: 'mission' as const, missionId: mission.missionId },
                status: `Mission done ${day(mission.unlockAt)}, unclaimed`
              }
        if (lock > now)
          return { division: d, qualifies, readyAt: lock, claim: null, status: `Locked, back in ${shortDuration(lock - now)}` }
        return { division: d, qualifies, readyAt: now, claim: null, status: 'Ready' }
      })
  }, [army.data, entries.data, missions.data, s.planetId, s.minAtk, s.minDef, now])

  const mine: ProjectedDivision[] = states
    .filter((x) => x.qualifies)
    .map((x) => ({ id: x.division.id, atk: x.division.atk, def: x.division.def, move: x.division.move, readyAt: x.readyAt }))
  const rows = board.data ?? []
  const projection = useMemo<Projection | null>(
    () =>
      s.startAt && s.endAt
        ? projectSiege({
            now,
            startAt: s.startAt,
            endAt: s.endAt,
            cumAtk: s.cumAtk,
            cumDef: s.cumDef,
            targetAtk: s.targetAtk,
            targetDef: s.targetDef,
            cooldownBase: s.cooldownBase,
            entry: s.entryTlm,
            board: rows.map((r) => ({ account: r.account, score: r.score, joins: r.deployments })),
            bonus,
            mine,
            me: tx.account
          })
        : null,
    // Re-project every minute, not every second.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s, rows, bonus, JSON.stringify(mine), tx.account, Math.floor(now / 60_000)]
  )

  const ranks = prizes.data ?? []
  const prizeAt = (rank: number) => ranks.find((p) => p.rank === rank)
  const meProjected = projection?.field.find((r) => r.me) ?? null
  const above = meProjected && projection ? projection.field[meProjected.rank - 2] : null
  const meNow = rows.find((r) => r.account === tx.account) ?? null
  const spent = (account: string, joins: number) => joins * s.entryTlm + (funded.get(account) ?? 0) * valuer.defTlm
  const spentCell = (account: string, joins: number) => {
    const def = funded.get(account)
    const total = spent(account, joins)
    return def ? (
      <span
        title={`${formatNumber(joins * s.entryTlm, 0)} TLM in entries + ${formatNumber(def, 0)} DEF funded (≈ ${formatNumber(def * valuer.defTlm, 0)} TLM)`}
      >
        {joins} · {formatNumber(total, 0)} TLM
      </span>
    ) : (
      `${joins} · ${formatNumber(total, 0)} TLM`
    )
  }

  const lines: RankLine[] =
    boardView === 'now' || !projection
      ? rows.map((r: ScoreRow) => ({
          rank: r.rank,
          account: r.account,
          bonus: bonus.get(r.account),
          me: false,
          cells: [formatNumber(r.score, 0), spentCell(r.account, r.deployments)]
        }))
      : projection.field.map((r) => ({
          rank: r.rank,
          account: r.account,
          me: r.me,
          bonus: bonus.get(r.account),
          cells: [
            r.me && !r.score ? '–' : formatNumber(r.score, 0),
            kfmt(r.projected),
            r.me ? (
              <span>
                {projection.joins} · {formatNumber(projection.cost, 0)} TLM <span className="faint">planned</span>
              </span>
            ) : (
              spentCell(r.account, r.joins)
            )
          ]
        }))

  return (
    <>
      {s.startAt && s.endAt && projection && (
        <Timeline
          from={s.startAt}
          to={s.endAt}
          now={now}
          band={[Math.min(projection.close, projection.closeWithout), Math.max(projection.close, projection.closeWithout)]}
          marks={[
            { at: s.startAt, label: 'Launch', sub: day(s.startAt) },
            { at: now, label: 'Now', sub: day(now), tone: 'now' },
            { at: projection.close, label: 'Close ≈', sub: dayTime(projection.close), tone: 'proj' },
            { at: s.endAt, label: 'Timer', sub: dayTime(s.endAt) }
          ]}
        />
      )}
      {projection && (
        <Figures
          items={[
            { label: 'Closes ≈', value: shortDuration(Math.max(0, projection.close - now)) },
            { label: 'Players / paid', value: `${s.participants} / ${ranks.length || '–'}` },
            { label: 'Open ranks', value: Math.max(0, ranks.length - s.participants), tone: 'c-green' },
            ...(meProjected
              ? [
                  {
                    label: 'Your finish, deploying constantly',
                    value: `#${meProjected.rank} · ${kfmt(meProjected.projected)}`,
                    tone: 'c-cyan'
                  },
                  { label: 'Your prize ≈', value: `${kfmt(valuer.worth(prizeAt(meProjected.rank)))} TLM`, tone: 'c-cyan' }
                ]
              : []),
            {
              label: 'Your standing now',
              value: meNow ? `#${meNow.rank} · ${formatNumber(meNow.score, 0)}` : tx.account ? 'no joins yet' : '–'
            },
            ...(meProjected
              ? [{ label: 'Entries to close', value: `${projection.joins} · ${formatNumber(projection.cost, 0)} TLM` }]
              : []),
            ...(meProjected && above
              ? [
                  {
                    label: `To pass #${above.rank}`,
                    value: `+${formatNumber(above.projected - meProjected.projected, 0)}`,
                    tone: 'c-mov'
                  }
                ]
              : [])
          ]}
        />
      )}
      <div className="pl-sec">
        <Bar
          label="Attack"
          tone="atk"
          value={s.cumAtk}
          target={s.targetAtk}
          note={
            projection
              ? `${formatNumber((s.cumAtk / (s.targetAtk || 1)) * 100, 1)}% · ${formatNumber(projection.atkPerHour, 0)}/h · met ≈ ${day(projection.atkMetAt)}`
              : ''
          }
        />
        <Bar
          label="Defense"
          tone="def"
          value={s.cumDef}
          target={s.targetDef}
          note={
            projection
              ? `${formatNumber((s.cumDef / (s.targetDef || 1)) * 100, 1)}% · ${formatNumber(projection.defPerHour, 0)}/h · met ≈ ${day(projection.defMetAt)}`
              : ''
          }
        />
      </div>

      <DeployPanel
        siege={s}
        now={now}
        tx={tx}
        states={states}
        loading={army.isLoading}
        close={projection?.close ?? s.endAt ?? now}
      />

      <div className="pl-sec">
        <div className="pl-sec__label">
          <span className="pl-switch" role="group" aria-label="Leaderboard">
            <button type="button" aria-pressed={boardView === 'now'} onClick={() => setBoardView('now')}>
              Current
            </button>
            <button type="button" aria-pressed={boardView === 'close'} onClick={() => setBoardView('close')}>
              Projected at close
            </button>
          </span>
          <span>{ranks.length} paid ranks · prize written out per rank</span>
        </div>
        {board.isLoading ? (
          <p className="pl-note">Reading the scores…</p>
        ) : (
          <RankTable
            head={
              boardView === 'now'
                ? ['#', 'Player', 'Score now', 'Joins · spent', '≈ TLM', 'Prize at this rank']
                : ['#', 'Player', 'Score now', 'At close ≈', 'Joins · spent', '≈ TLM', 'Prize']
            }
            lines={lines}
            prizes={ranks}
            valuer={valuer}
          />
        )}
        <p className="pl-note">
          Projection: a straight line from the average pace since launch; the season closes when both targets are met or the timer
          runs out; other players keep their pace and the top funders get their bonus at the close. Spent: joins × the entry fee,
          plus DEF funded at the pool rate. ≈ TLM: the prize sold, NFTs at their AtomicMarket median after fees.
        </p>
      </div>
    </>
  )
}

function DeployPanel({
  siege: s,
  now,
  tx,
  states,
  loading,
  close
}: {
  siege: Siege
  now: number
  tx: Tx
  states: DivisionState[]
  loading: boolean
  close: number
}) {
  const balance = useTlmBalance(tx.account)
  const credit = useEntryCredit(tx.account, s.planetId)
  const open = joinOpen(s, now)
  const ready = states.filter((x) => x.qualifies && x.readyAt <= now)
  const [picked, setPicked] = useState<Set<number> | null>(null)
  const chosen = ready.filter((x) => (picked ? picked.has(x.division.id) : true))
  const available = (credit.data ?? 0) + (balance.data ?? 0)

  // A division's join: claim it back first if it has to be, top up the entry fee, refresh its stats, join.
  const actionsFor = (x: DivisionState, deposit: number) => (a: string, p: string) => [
    ...(x.claim?.kind === 'siege' ? [claimSiegeAction(a, p, s.planetId, x.claim.entryId)] : []),
    ...(x.claim?.kind === 'mission' ? [claimMission(a, p, x.claim.missionId, x.division.id)] : []),
    ...(deposit > 0 ? [depositTlmAction(a, p, deposit)] : []),
    ...(x.division.fresh ? [] : [recalcDivision(a, p, x.division.id)]),
    joinSiegeAction(a, p, s.planetId, x.division.id)
  ]
  const lockOf = (x: DivisionState) => formatNumber(missionLockSeconds(s.cooldownBase, x.division.move) / 3600, 1)

  async function deployOne(x: DivisionState) {
    const deposit = Math.max(0, s.entryTlm - available)
    const ok = await tx.run(
      actionsFor(x, deposit),
      `Division #${x.division.id} joined ${titleCase(s.planet)}: back in ${lockOf(x)}h`,
      `siege-${x.division.id}`
    )
    if (ok) void refreshSieges(tx.account)
  }

  async function deployAll() {
    if (!chosen.length) return
    // The first transaction deposits what all the entries need beyond the balance and credit.
    const deposit = Math.max(0, s.entryTlm * chosen.length - available)
    await tx.runSequence(
      chosen.map((x, i) => ({
        build: actionsFor(x, i === 0 ? deposit : 0),
        success: `Division #${x.division.id} joined ${titleCase(s.planet)}`
      })),
      'siege-all'
    )
    setPicked(null)
    void refreshSieges(tx.account)
  }

  return (
    <div className="pl-sec">
      <div className="pl-sec__label">
        <span>Deploy</span>
        <span>
          balance {balance.data === undefined ? '…' : `${formatToken(balance.data)} TLM`}
          {(credit.data ?? 0) > 0 ? ` · credit ${formatToken(credit.data!)} TLM` : ''} · entry fees beyond it are deposited in the
          same transaction
        </span>
      </div>
      {!tx.account ? (
        <p className="pl-note">Sign in to deploy.</p>
      ) : loading ? (
        <p className="pl-note">Reading your divisions…</p>
      ) : !states.length ? (
        <p className="pl-note">
          No divisions yet. <Link to="/army">Build one in the Army.</Link>
        </p>
      ) : (
        <>
          <div className="pl-table">
            <table>
              <thead>
                <tr>
                  <th>Division</th>
                  <th className="r">ATK / DEF</th>
                  <th className="r">Move</th>
                  <th className="r">Score per join</th>
                  <th className="r">Cycle</th>
                  <th className="r">Joins · cost to close</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {states.map((x) => {
                  const d = x.division
                  const isReady = x.qualifies && x.readyAt <= now
                  const joins = x.qualifies
                    ? joinsUntil({ id: d.id, atk: d.atk, def: d.def, move: d.move, readyAt: x.readyAt }, s.cooldownBase, close)
                    : 0
                  return (
                    <tr key={d.id} className={x.qualifies ? '' : 'is-open'}>
                      <td>
                        <label className="pl-pick">
                          <input
                            type="checkbox"
                            disabled={!isReady}
                            checked={isReady && (picked ? picked.has(d.id) : true)}
                            onChange={(e) => {
                              const next = new Set(picked ?? ready.map((r) => r.division.id))
                              if (e.target.checked) next.add(d.id)
                              else next.delete(d.id)
                              setPicked(next)
                            }}
                            aria-label={`Include division #${d.id}`}
                          />
                          <b className="num">#{d.id}</b>
                        </label>
                      </td>
                      <td className="r num">
                        <span className="c-atk">{formatNumber(d.atk, 0)}</span> /{' '}
                        <span className="c-def">{formatNumber(d.def, 0)}</span>
                      </td>
                      <td className="r num faint">{formatNumber(d.move, 0)}</td>
                      <td className="r num">{formatNumber(d.atk + d.def, 0)}</td>
                      <td className="r num">
                        {x.qualifies ? shortDuration(missionLockSeconds(s.cooldownBase, d.move) * 1000) : ''}
                      </td>
                      <td className="r num">{x.qualifies ? `${joins} · ${formatNumber(joins * s.entryTlm, 0)} TLM` : ''}</td>
                      <td className={x.qualifies ? (isReady ? (x.claim ? 'c-mov' : 'c-green') : 'faint') : 'faint'}>
                        {x.qualifies ? x.status : `Below the ${s.minAtk} / ${s.minDef} minimum`}
                      </td>
                      <td className="r">
                        <Button
                          size="sm"
                          color="ghost"
                          disabled={!isReady || !open || tx.spectating}
                          isLoading={tx.pending === `siege-${d.id}`}
                          onClick={() => void deployOne(x)}
                        >
                          {x.claim ? 'Claim and deploy' : 'Deploy'}
                        </Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="pl-deploybar">
            <span className="faint">
              {open
                ? `${chosen.length} selected · ${formatNumber(
                    chosen.reduce((n, x) => n + x.division.atk + x.division.def, 0),
                    0
                  )} score · ${formatToken(chosen.length * s.entryTlm)} TLM`
                : 'The season is not taking divisions right now.'}
            </span>
            <Button
              color="solidBlue"
              disabled={!open || !chosen.length || tx.spectating}
              isLoading={tx.pending === 'siege-all'}
              onClick={() => void deployAll()}
            >
              Deploy {chosen.length} · {formatToken(chosen.length * s.entryTlm)} TLM
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

// ---- A finished season ---------------------------------------------------------------------------------

function SettledView({
  siege: s,
  season,
  past,
  now,
  loading
}: {
  siege: Siege
  season: number
  past: PastSeason | null
  now: number
  loading: boolean
}) {
  const valuer = useValuer()
  // The live prize table still holds a just-closed season's ranks until the next season sets its own.
  const live = useRankPrizes(s.planetId)
  const board = useLeaderboard({ ...s, season })
  const rows = board.data ?? []
  const prizes = past?.prizes.length ? past.prizes : season === s.season ? (live.data ?? []) : []
  const entry = past?.entryTlm ?? s.entryTlm
  const total = rows.reduce((n, r) => n + r.score, 0)
  const closedAt = past?.closedAt ?? s.endAt ?? now
  const openedAt = closedAt - (past?.durationDays ?? s.durationDays) * 86_400_000

  if (loading && !past) return <p className="pl-note">Reading the season's history…</p>
  return (
    <>
      <Timeline
        from={openedAt}
        to={Math.max(now, closedAt)}
        now={now}
        marks={[
          { at: openedAt, label: `Season ${season} opened`, sub: day(openedAt) },
          { at: closedAt, label: 'Closed · paid', sub: day(closedAt) },
          { at: now, label: 'Now', sub: day(now), tone: 'now' }
        ]}
      />
      <Figures
        items={[
          { label: 'Players', value: rows.length },
          { label: 'Total score', value: kfmt(total) },
          { label: 'Winner', value: rows[0]?.account ?? '–' },
          { label: 'Winner spent', value: rows[0] ? `${formatNumber(rows[0].deployments * entry, 0)} TLM` : '–' },
          { label: 'Total spent', value: `${formatNumber(rows.reduce((n, r) => n + r.deployments, 0) * entry, 0)} TLM` },
          { label: 'Unpaid ranks', value: Math.max(0, prizes.length - rows.length) }
        ]}
      />
      <div className="pl-sec">
        <div className="pl-sec__label">
          <span>Final standings and prizes</span>
          <span>{prizes.length} paid ranks · prize written out per rank</span>
        </div>
        {board.isLoading ? (
          <p className="pl-note">Reading the scores…</p>
        ) : (
          <RankTable
            head={['#', 'Player', 'Final score', 'Joins · spent', '≈ TLM', 'Prize paid']}
            lines={rows.map((r) => ({
              rank: r.rank,
              account: r.account,
              cells: [formatNumber(r.score, 0), `${r.deployments} · ${formatNumber(r.deployments * entry, 0)} TLM`]
            }))}
            prizes={prizes}
            valuer={valuer}
            emptyLabel="Unpaid: nobody held this rank"
          />
        )}
        <p className="pl-note">
          Prizes from the contract's own table for this season. Spent: joins × the {formatToken(entry)} TLM entry.
        </p>
      </div>
    </>
  )
}

// ---- The dossier -------------------------------------------------------------------------------------------------

/**
 * The world's lore, folded away. Its blocks: the first is the header, a short block ending with a
 * colon a title, one ending with a semicolon a bullet, a short one mentioning priority a quote.
 */
function Dossier({ planet, lore }: { planet: string; lore: string }) {
  const blocks = useMemo(
    () =>
      lore
        .split(/\n\s*\n/)
        .map((b) => b.trim())
        .filter(Boolean),
    [lore]
  )
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(false), [planet])
  const nodes: ReactNode[] = []
  let bullets: string[] = []
  const flush = () => {
    if (bullets.length)
      nodes.push(
        <ul key={`ul${nodes.length}`}>
          {bullets.map((b, i) => (
            <li key={i}>{b.replace(/;$/, '')}</li>
          ))}
        </ul>
      )
    bullets = []
  }
  blocks.forEach((b, i) => {
    if (i === 0 && /^Directive/i.test(b)) {
      nodes.push(
        <p key={i} className="pl-dossier__from">
          {b}
        </p>
      )
      return
    }
    if (/;$/.test(b)) {
      bullets.push(b)
      return
    }
    flush()
    if (b.length < 60 && /:$/.test(b)) nodes.push(<h5 key={i}>{b.replace(/:$/, '')}</h5>)
    else if (b.length < 80 && /priority/i.test(b)) nodes.push(<blockquote key={i}>{b}</blockquote>)
    else nodes.push(<p key={i}>{b}</p>)
  })
  flush()
  return (
    <article className={`pl-dossier ${open ? 'is-open' : ''}`}>
      <button type="button" className="pl-dossier__toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span>Field dossier</span>
        <small>{open ? 'Fold' : 'Read'}</small>
      </button>
      {open && <div className="pl-dossier__body">{nodes}</div>}
    </article>
  )
}
