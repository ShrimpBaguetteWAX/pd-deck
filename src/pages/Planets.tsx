import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { recalcDivision } from '@/chain/actions/pd'
import { claimSiegeAction, contributeDefAction, depositTlmAction, joinSiegeAction } from '@/chain/actions/siege'
import { TokenIcon } from '@/components/Art'
import { Button } from '@/components/Button'
import { Loading } from '@/components/Loading'
import { StatTrio } from '@/components/Stat'
import { Tooltip } from '@/components/Tooltip'
import { useCollectionTemplates } from '@/data/blends'
import { useArmy, usePlayer, useTemplates, type Division } from '@/data/game'
import {
  FUNDER_BONUS,
  joinOpen,
  refreshSieges,
  useEntryCredit,
  useLeaderboard,
  useRankPrizes,
  useSeasonFunders,
  useSiegeEntries,
  useSieges,
  useTlmBalance,
  type Contribution,
  type Funder,
  type RankPrize,
  type Siege
} from '@/data/siege'
import { SIEGE_LORE } from '@/data/siegeLore'
import { CheckIcon, RocketIcon, TimerIcon } from '@/icons'
import { formatDuration, formatNumber, formatToken, titleCase } from '@/lib/format'
import { publicUrl } from '@/lib/publicUrl'
import { missionLockSeconds } from '@/lib/stats'
import { chainDate, cooldownLabel, shortDuration, useNow } from '@/lib/time'
import { useTransaction } from '@/wallet/useTransaction'

import './Planets.css'

/*
 * Planetary sieges. A world goes through three phases: the community funds it with DEF (the three
 * biggest funders earn a score bonus), then for a season divisions join for a TLM fee and each join
 * adds the division's attack and defense to the player's score, then the ranks are paid in DEF and
 * NFTs.
 */

const QUICK_DEF = [10, 50, 100, 500]
const PLACE = ['1st', '2nd', '3rd']
const pct = (b: number) => `+${Math.round(b * 100)}%`

type Run = ReturnType<typeof useTransaction>['run']
interface Tx {
  account: string | null
  run: Run
  pending: string | null
  spectating: boolean
}

/** The phase a world is in: 0 funding, 1 siege, 2 settled; null before the game opens it. */
const phaseOf = (s: Siege) => (!s.onChain ? null : s.status === 'locked' ? 0 : s.status === 'active' ? 1 : 2)

function railStatus(s: Siege, now: number) {
  if (!s.onChain) return 'Sealed'
  if (s.status === 'locked') return `Funding · ${formatNumber((s.fundedDef / (s.thresholdDef || 1)) * 100, 0)}%`
  if (s.status === 'active') return s.endAt ? `Siege · ${shortDuration(s.endAt - now)} left` : 'Siege open'
  return s.status === 'met' ? 'Targets met' : 'Season failed'
}

export default function Planets() {
  const { account, run, pending, spectating } = useTransaction()
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
              title={railStatus(s, now)}
              className={`pl-rail__world is-${s.status} ${s.planet === planet ? 'is-active' : ''}`}
              onClick={() => setPicked(s.planet)}
            >
              <img src={publicUrl(`/img/planets/${s.planet}.png`)} alt="" />
              <b>{titleCase(s.planet)}</b>
              <i className="pl-rail__dot" aria-label={railStatus(s, now)} />
            </button>
          ))}
        </nav>
      </header>

      {siege && <World key={siege.planet} siege={siege} now={now} tx={{ account, run, pending, spectating }} />}
    </div>
  )
}

// ---- One world -----------------------------------------------------------------------------------------

function World({ siege: s, now, tx }: { siege: Siege; now: number; tx: Tx }) {
  const lore = SIEGE_LORE[s.planet]
  const phase = phaseOf(s)
  const { funders, recent, isLoading: fundersLoading } = useSeasonFunders(s)
  // The amount in the funding form; the funder panel can fill it with what a bonus place takes.
  const [amount, setAmount] = useState('')

  return (
    <section className="pl-world">
      <header className="pl-hero">
        <img className="pl-hero__art" src={publicUrl(`/img/planets/${s.planet}.png`)} alt="" />
        <div className="pl-hero__title">
          <h3>{titleCase(s.planet)}</h3>
          {lore && <p>{lore.tagline}</p>}
        </div>
        {s.onChain && (
          <dl className="pl-facts">
            <div>
              <dt>Season</dt>
              <dd className="num">{s.season}</dd>
            </div>
            <div>
              <dt>Length</dt>
              <dd className="num">{s.durationDays} days</dd>
            </div>
            <div>
              <dt>Entry</dt>
              <dd className="num">{formatToken(s.entryTlm)} TLM</dd>
            </div>
            <div className="pl-facts__target">
              <dt>
                Siege target{' '}
                <Tooltip text="Attack and defense every player's joined divisions must reach together this season. Both totals have to be met." />
              </dt>
              <dd className="num">
                <span className="c-atk">{formatNumber(s.targetAtk, 0)} ATK</span> ·{' '}
                <span className="c-def">{formatNumber(s.targetDef, 0)} DEF</span>
              </dd>
            </div>
            <div>
              <dt>Division needs</dt>
              <dd className="num">
                {formatNumber(s.minAtk, 0)} ATK · {formatNumber(s.minDef, 0)} DEF
              </dd>
            </div>
            <div>
              <dt>
                Cooldown <Tooltip text="Base cooldown; each move point of the division adds 10 seconds." />
              </dt>
              <dd className="num">{formatDuration(s.cooldownBase)} + move</dd>
            </div>
          </dl>
        )}
      </header>

      {phase === null ? (
        <div className="empty">
          <strong>Sealed</strong>
          <span>Nothing moves here until the game opens this world.</span>
        </div>
      ) : (
        <>
          <Phases siege={s} phase={phase} />
          <div className="pl-layout">
            <div className="pl-main">
              {phase === 0 ? (
                <FundPanel siege={s} tx={tx} amount={amount} setAmount={setAmount} />
              ) : (
                <SiegePanel siege={s} now={now} tx={tx} />
              )}
              {phase === 0 && <Contributions rows={recent} loading={fundersLoading} account={tx.account} now={now} />}
              {phase > 0 && <Leaderboard siege={s} account={tx.account} funders={funders} />}
            </div>
            <aside className="pl-side">
              <FunderPanel
                funders={funders}
                loading={fundersLoading}
                account={tx.account}
                onTake={phase === 0 ? (def) => setAmount(String(def)) : undefined}
              />
              <Prizes planetId={s.planetId} />
            </aside>
          </div>
          {lore && <Dossier planet={s.planet} lore={lore.lore} />}
        </>
      )}
    </section>
  )
}

/** The three phases of a season, the current one lit, with the funder bonus spelled out. */
function Phases({ siege: s, phase }: { siege: Siege; phase: number }) {
  const steps: { title: string; body: ReactNode }[] = [
    {
      title: 'Fund',
      body: (
        <>
          The community sends {formatNumber(s.thresholdDef, 0)} DEF to open the world. The three biggest funders get{' '}
          <b className="pl-gold">{FUNDER_BONUS.map(pct).join(' / ')}</b> on their score in the siege.
        </>
      )
    },
    {
      title: 'Siege',
      body: (
        <>
          For {s.durationDays} days, divisions join for {formatToken(s.entryTlm)} TLM each. Every join adds the division's ATK and
          DEF to your score.
        </>
      )
    },
    {
      title: 'Prizes',
      body: <>When the season closes, leaderboard ranks are paid in DEF, Quantum Chests and NFTs.</>
    }
  ]
  return (
    <ol className="pl-phases">
      {steps.map((st, i) => (
        <li key={st.title} className={i === phase ? 'is-now' : i < phase ? 'is-done' : ''}>
          <span className="pl-phases__n">{i < phase ? <CheckIcon width={12} height={12} /> : i + 1}</span>
          <div>
            <b>
              {st.title}
              {i === phase && <em>Now</em>}
            </b>
            <p>{st.body}</p>
          </div>
        </li>
      ))}
    </ol>
  )
}

// ---- Phase 1: funding --------------------------------------------------------------------------------------

function FundPanel({
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
  const funded = s.thresholdDef > 0 ? Math.min(1, s.fundedDef / s.thresholdDef) : 0
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
    <article className="panel pl-card">
      <div className="pl-card__head">
        <h4>Open the world</h4>
      </div>
      <div className="pl-progress pl-progress--big">
        <div className="pl-progress__label">
          <span>
            <b className="num">{formatNumber(s.fundedDef, 0)}</b>
            <span className="faint num"> / {formatNumber(s.thresholdDef, 0)} DEF</span>
          </span>
          <span className="faint num">{formatNumber(remaining, 0)} to go</span>
        </div>
        <span className="pl-bar">
          <i style={{ width: `${funded > 0 ? Math.max(funded * 100, 1) : 0}%` }} />
        </span>
      </div>

      <div className="pl-fund">
        <div className="pl-fund__row">
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
        <small className={amount > have ? 'c-red' : 'faint'}>
          {amount > have ? 'More than you hold. ' : ''}You hold {formatToken(have)} DEF.
        </small>
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
    </article>
  )
}

/** The bonus places: who holds them, and what it takes to claim one. */
function FunderPanel({
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
    <article className="panel pl-card">
      <div className="pl-card__head">
        <h4>Funder bonus</h4>
        <Tooltip text="Seen in the contract after the first Magor season: the three biggest DEF funders had 15, 10 and 5 percent added to their siege score at season close. Everyone else gets no bonus, whatever they sent." />
      </div>
      <p className="pl-note">
        {onTake
          ? 'The top three funders of this phase get a bonus on everything they score once the siege starts.'
          : 'Set when the world opened. Added to these players’ scores when the season closes.'}
      </p>
      {loading ? (
        <p className="pl-note">Reading the contributions…</p>
      ) : (
        <ul className="pl-tiers">
          {FUNDER_BONUS.map((bonus, i) => {
            const f = funders[i]
            // To take this place: one whole DEF more than its holder has sent, less what you sent already.
            const need = f ? Math.max(1, Math.floor(f.def - mineDef) + 1) : 1
            const yours = !!f && f.account === account
            return (
              <li key={i} className={yours ? 'is-me' : f ? '' : 'is-open'}>
                <span className="pl-tiers__bonus num">{pct(bonus)}</span>
                <span className="pl-tiers__who">
                  <b>{f ? f.account : 'Open'}</b>
                  <small>
                    {PLACE[i]} funder{f ? ` · ${formatNumber(f.def, 0)} DEF` : ''}
                  </small>
                </span>
                {onTake && !yours && account && (
                  <Tooltip
                    text={`Put ${formatNumber(need, 0)} DEF in the form: enough to pass the ${PLACE[i]} place as it stands now.`}
                  >
                    <button type="button" className="pl-take num" onClick={() => onTake(need)}>
                      {formatNumber(need, 0)} DEF
                    </button>
                  </Tooltip>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {mine && mine.rank > 3 && (
        <p className="pl-note">
          You sent {formatNumber(mine.def, 0)} DEF so far: funder #{mine.rank}.
        </p>
      )}
      {!onTake && !loading && !funders.length && <p className="pl-note">No funders recorded for this season.</p>}
    </article>
  )
}

/** The DEF sent in this funding phase, newest first. */
function Contributions({
  rows,
  loading,
  account,
  now
}: {
  rows: Contribution[]
  loading: boolean
  account: string | null
  now: number
}) {
  const [all, setAll] = useState(false)
  const shown = all ? rows : rows.slice(0, 8)
  return (
    <article className="panel pl-card">
      <div className="pl-card__head">
        <h4>Contributions</h4>
        {rows.length > 0 && <span className="faint num">{rows.length} this phase</span>}
      </div>
      {loading ? (
        <p className="pl-note">Reading the history…</p>
      ) : rows.length === 0 ? (
        <p className="pl-note">Nobody has sent DEF in this phase yet.</p>
      ) : (
        <ul className="pl-contribs">
          {shown.map((c) => (
            <li key={c.trxId + c.account} className={c.account === account ? 'is-me' : ''}>
              <span className="pl-contribs__who">{c.account}</span>
              <span className="num pl-gold">{formatNumber(c.def, 0)} DEF</span>
              <span className="num faint">{shortDuration(Math.max(0, now - c.at))} ago</span>
            </li>
          ))}
        </ul>
      )}
      {rows.length > 8 && (
        <button type="button" className="pl-more" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : 'Show all ' + rows.length}
        </button>
      )}
    </article>
  )
}

// ---- Phase 2: the siege ---------------------------------------------------------------------------------------

function SiegePanel({ siege: s, now, tx }: { siege: Siege; now: number; tx: Tx }) {
  const army = useArmy(tx.account)
  const entries = useSiegeEntries(tx.account, [s.planetId])
  const balance = useTlmBalance(tx.account)
  const credit = useEntryCredit(tx.account, s.planetId)
  const open = joinOpen(s, now)
  const atk = s.targetAtk > 0 ? Math.min(1, s.cumAtk / s.targetAtk) : 0
  const def = s.targetDef > 0 ? Math.min(1, s.cumDef / s.targetDef) : 0

  const entered = new Set((entries.data ?? []).map((e) => e.divisionId))
  const divisions = (army.data?.divisions ?? []).filter((d) => d.units.length > 0)
  const eligible = divisions
    .filter(
      (d) => !entered.has(d.id) && d.atk >= s.minAtk && d.def >= s.minDef && !(d.lock && +chainDate(d.lock.locked_until) > now)
    )
    .sort((a, b) => b.atk + b.def - (a.atk + a.def))
  const tooWeak = divisions.filter((d) => !entered.has(d.id) && (d.atk < s.minAtk || d.def < s.minDef))

  // What an entry takes from the wallet: the fee, less unused credit, less the balance core.pdef holds.
  const shortfall = Math.max(0, s.entryTlm - (credit.data ?? 0) - (balance.data ?? 0))

  async function deploy(d: Division) {
    const ok = await tx.run(
      (a, p) => [
        ...(shortfall > 0 ? [depositTlmAction(a, p, shortfall)] : []),
        ...(d.fresh ? [] : [recalcDivision(a, p, d.id)]),
        joinSiegeAction(a, p, s.planetId, d.id)
      ],
      `Division #${d.id} deployed to ${titleCase(s.planet)}: back in ${formatDuration(missionLockSeconds(s.cooldownBase, d.move))}`,
      `siege-${d.id}`
    )
    if (ok) void refreshSieges(tx.account)
  }

  async function claim(entryId: number, divisionId: number) {
    const ok = await tx.run(
      (a, p) => claimSiegeAction(a, p, s.planetId, entryId),
      `Division #${divisionId} is back from ${titleCase(s.planet)}`,
      `claim-${entryId}`
    )
    if (ok) void refreshSieges(tx.account)
  }

  return (
    <article className="panel pl-card">
      <div className="pl-card__head">
        <h4>{s.status === 'active' ? (s.endAt ? `${shortDuration(s.endAt - now)} left` : 'Siege open') : 'Season over'}</h4>
        <span className="faint num">
          {formatNumber(s.participants, 0)} players · {formatNumber(s.deployments, 0)} joins
        </span>
      </div>
      <div className="pl-targets">
        <Target label="Attack" tone="atk" value={s.cumAtk} target={s.targetAtk} share={atk} />
        <Target label="Defense" tone="def" value={s.cumDef} target={s.targetDef} share={def} />
      </div>

      {(entries.data ?? []).length > 0 && (
        <div className="pl-group">
          <h5>Your divisions here</h5>
          <ul className="pl-rows">
            {entries.data!.map((e) => {
              const back = e.unlockAt <= now
              return (
                <li key={e.entryId}>
                  <b className="num">#{e.divisionId}</b>
                  <StatTrio atk={e.atk} def={e.def} move={e.move} size="sm" />
                  <span className={`num ${back ? 'c-green' : 'faint'}`}>
                    {back ? 'Back' : cooldownLabel(e.unlockAt, now, 'back')}
                  </span>
                  <Button
                    size="sm"
                    color={back ? 'gradientYellow' : 'ghost'}
                    disabled={!back || tx.spectating}
                    isLoading={tx.pending === `claim-${e.entryId}`}
                    onClick={() => void claim(e.entryId, e.divisionId)}
                  >
                    Claim
                  </Button>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      <div className="pl-group">
        <h5>
          Deploy
          <small className="faint num">
            balance {balance.data === undefined ? '…' : `${formatToken(balance.data)} TLM`}
            {(credit.data ?? 0) > 0 ? ` · credit ${formatToken(credit.data!)} TLM` : ''}
          </small>
        </h5>
        {!tx.account ? (
          <p className="pl-note">Sign in to deploy.</p>
        ) : !open ? (
          <p className="pl-note">The season is not taking divisions right now.</p>
        ) : army.isLoading ? (
          <p className="pl-note">Reading your divisions…</p>
        ) : eligible.length === 0 ? (
          <p className="pl-note">
            No idle division reaches {formatNumber(s.minAtk, 0)} ATK and {formatNumber(s.minDef, 0)} DEF
            {tooWeak.length ? ` (${tooWeak.length} fall short)` : ''}. <Link to="/army">Build one in the Army.</Link>
          </p>
        ) : (
          <ul className="pl-rows">
            {eligible.map((d) => (
              <li key={d.id}>
                <b className="num">#{d.id}</b>
                <StatTrio atk={d.atk} def={d.def} move={d.move} size="sm" />
                <span className="faint num">
                  <TimerIcon width={11} height={11} /> {formatDuration(missionLockSeconds(s.cooldownBase, d.move))}
                </span>
                <Tooltip
                  text={`Entry ${formatToken(s.entryTlm)} TLM${shortfall > 0 ? `, of which ${formatToken(shortfall)} TLM is deposited first` : ', paid from your balance'}. Adds ${formatNumber(d.atk + d.def, 0)} to your score.`}
                >
                  <Button
                    size="sm"
                    color="solidBlue"
                    disabled={tx.spectating}
                    isLoading={tx.pending === `siege-${d.id}`}
                    onClick={() => void deploy(d)}
                  >
                    <RocketIcon /> Deploy
                  </Button>
                </Tooltip>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  )
}

function Target({
  label,
  tone,
  value,
  target,
  share
}: {
  label: string
  tone: 'atk' | 'def'
  value: number
  target: number
  share: number
}) {
  return (
    <div className="pl-progress">
      <div className="pl-progress__label">
        <span>{label}</span>
        <span className="num">
          {formatNumber(value, 0)} <span className="faint">/ {formatNumber(target, 0)}</span>
        </span>
      </div>
      <span className={`pl-bar is-${tone}`}>
        <i style={{ width: `${share * 100}%` }} />
      </span>
    </div>
  )
}

function Leaderboard({ siege, account, funders }: { siege: Siege; account: string | null; funders: Funder[] }) {
  const board = useLeaderboard(siege)
  const rows = board.data ?? []
  const me = rows.find((r) => r.account === account)
  const bonusOf = new Map(funders.slice(0, 3).map((f, i) => [f.account, FUNDER_BONUS[i]]))
  const shown = me && me.rank > 10 ? [...rows.slice(0, 10), me] : rows.slice(0, 10)
  return (
    <article className="panel pl-card">
      <div className="pl-card__head">
        <h4>Leaderboard</h4>
        <Tooltip text="Score is the ATK plus DEF of every division joined this season. The funder bonus is added when the season closes." />
      </div>
      {board.isLoading ? (
        <p className="pl-note">Reading the scores…</p>
      ) : rows.length === 0 ? (
        <p className="pl-note">No division has joined this season yet.</p>
      ) : (
        <ol className="pl-board">
          <li className="pl-board__head">
            <span>#</span>
            <span>Player</span>
            <span>Joins</span>
            <span>Score</span>
          </li>
          {shown.map((r) => (
            <li key={r.account} className={r.account === account ? 'is-me' : ''}>
              <span className="num faint">{r.rank}</span>
              <span>
                {r.account}
                {bonusOf.has(r.account) && <em className="pl-gold"> {pct(bonusOf.get(r.account)!)}</em>}
              </span>
              <span className="num faint">{formatNumber(r.deployments, 0)}</span>
              <span className="num">{formatNumber(r.score, 0)}</span>
            </li>
          ))}
        </ol>
      )}
    </article>
  )
}

// ---- Phase 3: prizes --------------------------------------------------------------------------------------------

/** Ranks that pay exactly the same, folded into one row. */
interface PrizeBand {
  from: number
  to: number
  prize: RankPrize
}

const sameAs = (a: RankPrize, b: RankPrize) =>
  a.def === b.def &&
  a.nfts.length === b.nfts.length &&
  a.nfts.every((n, i) => n.templateId === b.nfts[i].templateId && n.count === b.nfts[i].count)

function Prizes({ planetId }: { planetId: number }) {
  const prizes = useRankPrizes(planetId)
  const templates = useCollectionTemplates()
  const stats = useTemplates()
  const [all, setAll] = useState(false)
  const bands = useMemo(() => {
    const out: PrizeBand[] = []
    for (const p of prizes.data ?? []) {
      const last = out[out.length - 1]
      if (last && last.to === p.rank - 1 && sameAs(last.prize, p)) last.to = p.rank
      else out.push({ from: p.rank, to: p.rank, prize: p })
    }
    return out
  }, [prizes.data])
  if (!bands.length) return null
  const name = (t: string) => stats.data?.[t]?.name ?? templates.data?.get(t)?.name ?? `#${t}`
  const shown = all ? bands : bands.slice(0, 5)
  const ranks = bands[bands.length - 1].to
  return (
    <article className="panel pl-card">
      <div className="pl-card__head">
        <h4>Prizes</h4>
        <span className="faint num">{ranks} ranks paid</span>
      </div>
      <ul className="pl-prizes">
        {shown.map((b) => {
          const isChest = (t: string) => /chest/i.test(name(t))
          const chests = b.prize.nfts.filter((n) => isChest(n.templateId)).reduce((n, c) => n + c.count, 0)
          const rest = b.prize.nfts.filter((n) => !isChest(n.templateId))
          return (
            <li key={b.from}>
              <span className="pl-prizes__rank num">{b.from === b.to ? `#${b.from}` : `#${b.from}–${b.to}`}</span>
              <span className="pl-prizes__main">
                <span className="num">
                  <b>{formatNumber(b.prize.def, 0)} DEF</b>
                  {chests > 0 && <span className="faint"> · {chests} chests</span>}
                </span>
                {rest.length > 0 && (
                  <small className="faint">{rest.map((n) => `${n.count}× ${name(n.templateId)}`).join(', ')}</small>
                )}
              </span>
            </li>
          )
        })}
      </ul>
      {bands.length > 5 && (
        <button type="button" className="pl-more" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${ranks} ranks`}
        </button>
      )}
    </article>
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
