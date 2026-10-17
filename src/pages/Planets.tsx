import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'

import { recalcDivision } from '@/chain/actions/pd'
import { claimSiegeAction, contributeDefAction, depositTlmAction, joinSiegeAction } from '@/chain/actions/siege'
import { PlanetIcon, TokenIcon } from '@/components/Art'
import { Button } from '@/components/Button'
import { Loading } from '@/components/Loading'
import { Figure, StatTrio } from '@/components/Stat'
import { Tooltip } from '@/components/Tooltip'
import { useCollectionTemplates } from '@/data/blends'
import { useArmy, usePlayer, useTemplates, type Division } from '@/data/game'
import {
  joinOpen,
  refreshSieges,
  useContributions,
  useEntryCredit,
  useLeaderboard,
  useRankPrizes,
  useSiegeEntries,
  useSieges,
  useTlmBalance,
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
 * Planetary sieges: six worlds, each unlocked by the community's DEF and then held for a season
 * by everyone's divisions. A division joins for a TLM entry fee, counts its attack and defense
 * towards the season's targets and the player's score, and comes back after a cooldown; the
 * season's ranks pay DEF and NFTs.
 */

const QUICK_DEF = [10, 50, 100, 500]

const STATUS_LABEL: Record<Siege['status'], string> = {
  unopened: 'Not opened yet',
  locked: 'Locked · funding',
  active: 'Season open',
  met: 'Targets met',
  failed: 'Season failed'
}

export default function Planets() {
  const { account, run, pending, spectating } = useTransaction()
  const sieges = useSieges()
  const now = useNow(1000)
  const [picked, setPicked] = useState<string | null>(null)

  // The first world with something going on is open by default: an active season, then one funding.
  const list = sieges.data ?? []
  const fallback = list.find((s) => s.status === 'active')?.planet ?? list.find((s) => s.onChain)?.planet ?? 'magor'
  const planet = picked ?? fallback
  const siege = list.find((s) => s.planet === planet) ?? null

  if (sieges.isLoading && !sieges.data) return <Loading inline label="Surveying the worlds" />

  return (
    <div className="page planets">
      <header className="pl-head panel panel--tight">
        <div>
          <p className="eyebrow">Planetary sieges</p>
          <h2>Six worlds, six campaigns</h2>
          <p className="muted">
            A world opens once the community has sent it enough DEF. Then, for a season, every division that joins counts its
            attack and defense towards the world's targets and your score. Ranks pay DEF and NFTs when the season closes.
          </p>
        </div>
      </header>

      <div className="pl-grid">
        {list.map((s) => (
          <WorldCard key={s.planet} siege={s} now={now} active={s.planet === planet} onPick={() => setPicked(s.planet)} />
        ))}
      </div>

      {siege && (
        <WorldDetail
          key={siege.planet}
          siege={siege}
          account={account}
          now={now}
          run={run}
          pending={pending}
          spectating={spectating}
        />
      )}
    </div>
  )
}

// ---- The six cards ----------------------------------------------------------------------------------------

function WorldCard({ siege: s, now, active, onPick }: { siege: Siege; now: number; active: boolean; onPick: () => void }) {
  const lore = SIEGE_LORE[s.planet]
  const funded = s.thresholdDef > 0 ? Math.min(1, s.fundedDef / s.thresholdDef) : 0
  const atk = s.targetAtk > 0 ? Math.min(1, s.cumAtk / s.targetAtk) : 0
  const def = s.targetDef > 0 ? Math.min(1, s.cumDef / s.targetDef) : 0
  return (
    <button type="button" className={`pl-card ${active ? 'is-active' : ''} is-${s.status}`} onClick={onPick}>
      <img className="pl-card__art" src={publicUrl(`/img/planets/${s.planet}.png`)} alt="" />
      <span className="pl-card__body">
        <span className="pl-card__top">
          <b>{titleCase(s.planet)}</b>
          <em className={`pl-status is-${s.status}`}>{STATUS_LABEL[s.status]}</em>
        </span>
        <small className="pl-card__tag">{lore?.tagline ?? ''}</small>
        {s.status === 'locked' && (
          <span className="pl-bar" title={`${formatNumber(s.fundedDef, 0)} of ${formatNumber(s.thresholdDef, 0)} DEF`}>
            <i style={{ width: `${funded * 100}%` }} />
            <small className="num">
              {formatNumber(s.fundedDef, 0)} / {formatNumber(s.thresholdDef, 0)} DEF
            </small>
          </span>
        )}
        {s.status !== 'locked' && s.onChain && (
          <span className="pl-card__twin">
            <span className="pl-bar is-atk" title="Attack scored against the target">
              <i style={{ width: `${atk * 100}%` }} />
              <small className="num">ATK {formatNumber(atk * 100, 0)}%</small>
            </span>
            <span className="pl-bar is-def" title="Defense scored against the target">
              <i style={{ width: `${def * 100}%` }} />
              <small className="num">DEF {formatNumber(def * 100, 0)}%</small>
            </span>
          </span>
        )}
        <small className="pl-card__foot faint">
          {!s.onChain
            ? 'Intelligence has not opened this world.'
            : s.status === 'active' && s.endAt
              ? `Season ${s.season} · ends in ${shortDuration(s.endAt - now)}`
              : `Season ${s.season} · ${s.durationDays} days once open`}
        </small>
      </span>
    </button>
  )
}

// ---- One world in detail -----------------------------------------------------------------------------------

type Run = ReturnType<typeof useTransaction>['run']

function WorldDetail({
  siege: s,
  account,
  now,
  run,
  pending,
  spectating
}: {
  siege: Siege
  account: string | null
  now: number
  run: Run
  pending: string | null
  spectating: boolean
}) {
  const lore = SIEGE_LORE[s.planet]
  return (
    <section className="pl-detail">
      <header className="pl-detail__head">
        <PlanetIcon planet={s.planet} size={28} />
        <div>
          <p className="eyebrow">{STATUS_LABEL[s.status]}</p>
          <h3>{titleCase(s.planet)}</h3>
          {lore && <p className="muted">{lore.tagline}</p>}
        </div>
        {s.onChain && (
          <div className="pl-detail__figures">
            <Figure label="Season" value={formatNumber(s.season, 0)} />
            <Figure
              label="Entry"
              value={`${formatToken(s.entryTlm)} TLM`}
              help="Taken from the TLM balance core.pdef holds for you when a division joins."
            />
            <Figure
              label="Needs"
              value={`${formatNumber(s.minAtk, 0)} ATK · ${formatNumber(s.minDef, 0)} DEF`}
              help="The least a division must have to join."
            />
            <Figure
              label="Cooldown"
              value={formatDuration(s.cooldownBase)}
              help="Base; each move point of the division adds 10 seconds."
            />
          </div>
        )}
      </header>

      {!s.onChain ? (
        <div className="empty">
          <strong>Sealed</strong>
          <span>Nothing moves here until the game opens the world.</span>
        </div>
      ) : (
        <div className="pl-detail__grid">
          <div className="pl-col">
            {s.status === 'locked' ? (
              <UnlockPanel siege={s} account={account} run={run} pending={pending} spectating={spectating} />
            ) : (
              <SeasonPanel siege={s} account={account} now={now} run={run} pending={pending} spectating={spectating} />
            )}
            <Prizes planetId={s.planetId} />
          </div>
          <div className="pl-col">
            {lore && <Dossier planet={s.planet} lore={lore.lore} />}
            {s.status === 'locked' ? <Contributions siege={s} /> : <Leaderboard siege={s} account={account} />}
          </div>
        </div>
      )}
    </section>
  )
}

// ---- Funding a locked world -----------------------------------------------------------------------------

function UnlockPanel({
  siege: s,
  account,
  run,
  pending,
  spectating
}: {
  siege: Siege
  account: string | null
  run: Run
  pending: string | null
  spectating: boolean
}) {
  const player = usePlayer(account)
  const contributions = useContributions(s.planetId)
  const [text, setText] = useState('')
  const [agreed, setAgreed] = useState(false)
  const amount = Math.max(0, Number(text) || 0)
  const remaining = Math.max(0, s.thresholdDef - s.fundedDef)
  const funded = s.thresholdDef > 0 ? Math.min(1, s.fundedDef / s.thresholdDef) : 0
  const have = player.data?.def ?? 0
  const contributors = new Set((contributions.data ?? []).map((c) => c.account)).size
  const mine = (contributions.data ?? []).filter((c) => c.account === account).reduce((n, c) => n + c.def, 0)

  async function contribute() {
    if (!(amount > 0) || !agreed) return
    const ok = await run(
      (a, p) => contributeDefAction(a, p, s.planetId, amount),
      `${formatToken(amount)} DEF sent to ${titleCase(s.planet)}`,
      'contribute'
    )
    if (ok) {
      setText('')
      setAgreed(false)
      void refreshSieges(account)
    }
  }

  return (
    <article className="pl-panel panel">
      <p className="eyebrow">DEF unlock</p>
      <h4>
        {formatNumber(s.fundedDef, 0)} <small className="faint">of {formatNumber(s.thresholdDef, 0)} DEF</small>
      </h4>
      <p className="muted">
        This world stays locked until the community has sent enough DEF. Anyone can send any amount at any time; the DEF is never
        returned, whatever the season brings.
      </p>
      <span className="pl-bar pl-bar--big">
        <i style={{ width: `${funded * 100}%` }} />
      </span>
      <div className="pl-panel__figures">
        <Figure label="Threshold" value={`${formatNumber(s.thresholdDef, 0)} DEF`} />
        <Figure label="Remaining" value={`${formatNumber(remaining, 0)} DEF`} />
        <Figure label="Contributors" value={contributions.data ? formatNumber(contributors, 0) : '…'} />
        {mine > 0 && <Figure label="Yours" value={`${formatNumber(mine, 0)} DEF`} tone="c-tlm" />}
      </div>

      <div className="pl-form">
        <label className="pl-form__amount">
          <span>Amount to contribute</span>
          <span className="pl-form__input">
            <input
              className="input num"
              inputMode="decimal"
              value={text}
              placeholder="0"
              onChange={(e) => setText(e.target.value.replace(/[^\d.]/g, ''))}
            />
            <TokenIcon symbol="DEF" size={16} /> DEF
          </span>
        </label>
        <span className="pl-form__quick">
          {QUICK_DEF.map((q) => (
            <button key={q} type="button" className="mk-link" onClick={() => setText(String(q))}>
              {q}
            </button>
          ))}
          <button type="button" className="mk-link" disabled={remaining <= 0} onClick={() => setText(String(remaining))}>
            Fill the gap
          </button>
        </span>
        <small className="faint">You hold {formatToken(have)} DEF.</small>
        <label className="pl-form__agree">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>I understand that this DEF will not be returned, whatever the outcome of the season.</span>
        </label>
        <Button
          color="gradientYellow"
          disabled={spectating || !agreed || !(amount > 0) || amount > have}
          isLoading={pending === 'contribute'}
          onClick={contribute}
        >
          Contribute {amount > 0 ? `${formatToken(amount)} DEF` : 'DEF'}
        </Button>
        {amount > have && <small className="c-red">That is more DEF than you hold.</small>}
      </div>
    </article>
  )
}

// ---- An open season: deploy, claim, progress ------------------------------------------------------------

function SeasonPanel({
  siege: s,
  account,
  now,
  run,
  pending,
  spectating
}: {
  siege: Siege
  account: string | null
  now: number
  run: Run
  pending: string | null
  spectating: boolean
}) {
  const army = useArmy(account)
  const entries = useSiegeEntries(account, [s.planetId])
  const balance = useTlmBalance(account)
  const credit = useEntryCredit(account, s.planetId)
  const open = joinOpen(s, now)
  const atk = s.targetAtk > 0 ? Math.min(1, s.cumAtk / s.targetAtk) : 0
  const def = s.targetDef > 0 ? Math.min(1, s.cumDef / s.targetDef) : 0

  const entered = new Set((entries.data ?? []).map((e) => e.divisionId))
  const divisions = (army.data?.divisions ?? []).filter((d) => d.units.length > 0)
  const eligible = divisions.filter(
    (d) => !entered.has(d.id) && d.atk >= s.minAtk && d.def >= s.minDef && !(d.lock && +chainDate(d.lock.locked_until) > now)
  )
  const tooWeak = divisions.filter((d) => !entered.has(d.id) && (d.atk < s.minAtk || d.def < s.minDef))

  // What the entry costs from the wallet: the fee, less credit already paid, less the balance held.
  const shortfall = Math.max(0, s.entryTlm - (credit.data ?? 0) - (balance.data ?? 0))

  async function deploy(d: Division) {
    const ok = await run(
      (a, p) => [
        ...(shortfall > 0 ? [depositTlmAction(a, p, shortfall)] : []),
        ...(d.fresh ? [] : [recalcDivision(a, p, d.id)]),
        joinSiegeAction(a, p, s.planetId, d.id)
      ],
      `Division #${d.id} deployed to ${titleCase(s.planet)}: back in ${formatDuration(missionLockSeconds(s.cooldownBase, d.move))}`,
      `siege-${d.id}`
    )
    if (ok) void refreshSieges(account)
  }

  async function claim(entryId: number, divisionId: number) {
    const ok = await run(
      (a, p) => claimSiegeAction(a, p, s.planetId, entryId),
      `Division #${divisionId} is back from ${titleCase(s.planet)}`,
      `claim-${entryId}`
    )
    if (ok) void refreshSieges(account)
  }

  return (
    <article className="pl-panel panel">
      <p className="eyebrow">Season {s.season}</p>
      <h4>{s.status === 'active' ? (s.endAt ? `Ends in ${shortDuration(s.endAt - now)}` : 'Open') : STATUS_LABEL[s.status]}</h4>
      <div className="pl-targets">
        <span
          className="pl-bar pl-bar--big is-atk"
          title="Attack scored by every division joined this season, against the target"
        >
          <i style={{ width: `${atk * 100}%` }} />
          <small className="num">
            ATK {formatNumber(s.cumAtk, 0)} / {formatNumber(s.targetAtk, 0)}
          </small>
        </span>
        <span className="pl-bar pl-bar--big is-def" title="Defense scored, against the target">
          <i style={{ width: `${def * 100}%` }} />
          <small className="num">
            DEF {formatNumber(s.cumDef, 0)} / {formatNumber(s.targetDef, 0)}
          </small>
        </span>
      </div>
      <div className="pl-panel__figures">
        <Figure label="Participants" value={formatNumber(s.participants, 0)} />
        <Figure label="Deployments" value={formatNumber(s.deployments, 0)} />
        <Figure
          label="Your TLM balance"
          value={balance.data === undefined ? '…' : `${formatToken(balance.data)} TLM`}
          help="Held by core.pdef for entry fees. Whatever an entry still needs is deposited in the same transaction."
        />
        {(credit.data ?? 0) > 0 && <Figure label="Entry credit" value={`${formatToken(credit.data!)} TLM`} />}
      </div>

      {(entries.data ?? []).length > 0 && (
        <>
          <p className="eyebrow">Your divisions here</p>
          <ul className="pl-list">
            {entries.data!.map((e) => {
              const back = e.unlockAt <= now
              return (
                <li key={e.entryId} className="pl-list__row">
                  <b>#{e.divisionId}</b>
                  <StatTrio atk={e.atk} def={e.def} move={e.move} size="sm" />
                  <span className={`num ${back ? 'c-green' : 'faint'}`}>
                    <TimerIcon width={11} height={11} /> {back ? 'back' : cooldownLabel(e.unlockAt, now, 'back')}
                  </span>
                  <Button
                    size="sm"
                    color={back ? 'gradientYellow' : 'ghost'}
                    disabled={!back || spectating}
                    isLoading={pending === `claim-${e.entryId}`}
                    onClick={() => void claim(e.entryId, e.divisionId)}
                  >
                    <CheckIcon width={13} height={13} /> Claim
                  </Button>
                </li>
              )
            })}
          </ul>
        </>
      )}

      <p className="eyebrow">Deploy a division</p>
      {!account ? (
        <p className="muted">Sign in to deploy.</p>
      ) : !open ? (
        <p className="muted">The season is not taking divisions right now.</p>
      ) : army.isLoading ? (
        <p className="muted">Reading your divisions…</p>
      ) : eligible.length === 0 ? (
        <p className="muted">
          No idle division of yours reaches {formatNumber(s.minAtk, 0)} ATK and {formatNumber(s.minDef, 0)} DEF
          {tooWeak.length ? ` (${tooWeak.length} fall short)` : ''}. <Link to="/army">Build one in the Army.</Link>
        </p>
      ) : (
        <ul className="pl-list">
          {eligible
            .sort((a, b) => b.atk + b.def - (a.atk + a.def))
            .map((d) => (
              <li key={d.id} className="pl-list__row">
                <b>#{d.id}</b>
                <StatTrio atk={d.atk} def={d.def} move={d.move} size="sm" />
                <span className="faint num">
                  <TimerIcon width={11} height={11} /> {formatDuration(missionLockSeconds(s.cooldownBase, d.move))}
                </span>
                <Tooltip
                  text={`Entry ${formatToken(s.entryTlm)} TLM${shortfall > 0 ? `, of which ${formatToken(shortfall)} TLM is deposited first` : ', covered by your balance'}. The division scores its ${formatNumber(d.atk, 0)} ATK and ${formatNumber(d.def, 0)} DEF for the season and is back after the cooldown.`}
                >
                  <Button
                    size="sm"
                    color="solidBlue"
                    disabled={spectating}
                    isLoading={pending === `siege-${d.id}`}
                    onClick={() => void deploy(d)}
                  >
                    <RocketIcon /> Deploy
                  </Button>
                </Tooltip>
              </li>
            ))}
        </ul>
      )}
    </article>
  )
}

// ---- Prizes, scores, contributions, lore ---------------------------------------------------------------

function Prizes({ planetId }: { planetId: number }) {
  const prizes = useRankPrizes(planetId)
  const templates = useCollectionTemplates()
  const stats = useTemplates()
  const [all, setAll] = useState(false)
  const rows = prizes.data ?? []
  if (!rows.length) return null
  const name = (t: string) => stats.data?.[t]?.name ?? templates.data?.get(t)?.name ?? `#${t}`
  const shown = all ? rows : rows.slice(0, 10)
  return (
    <article className="pl-panel panel">
      <p className="eyebrow">Season prizes</p>
      <p className="muted">By rank on the leaderboard when the season closes. Lower ranks are grouped where they pay the same.</p>
      <ul className="pl-prizes">
        {shown.map((p) => (
          <li key={p.rank}>
            <b className="num">#{p.rank}</b>
            <span className="num c-deft">{formatNumber(p.def, 0)} DEF</span>
            <span className="pl-prizes__nfts">
              {p.nfts.map((n, i) => (
                <small key={i}>
                  {n.count}× {name(n.templateId)}
                </small>
              ))}
            </span>
          </li>
        ))}
      </ul>
      {rows.length > 10 && (
        <button type="button" className="mk-link" onClick={() => setAll((v) => !v)}>
          {all ? 'Fewer ranks' : `All ${rows.length} ranks`}
        </button>
      )}
    </article>
  )
}

function Leaderboard({ siege, account }: { siege: Siege; account: string | null }) {
  const board = useLeaderboard(siege)
  const rows = board.data ?? []
  const me = rows.find((r) => r.account === account)
  return (
    <article className="pl-panel panel">
      <p className="eyebrow">Leaderboard · season {siege.season}</p>
      {board.isLoading ? (
        <p className="muted">Reading the scores…</p>
      ) : rows.length === 0 ? (
        <p className="muted">No division has joined this season yet.</p>
      ) : (
        <ul className="pl-board">
          {rows.slice(0, 10).map((r) => (
            <li key={r.account} className={r.account === account ? 'is-me' : ''}>
              <b className="num">#{r.rank}</b>
              <span>{r.account}</span>
              <span className="num c-atk">{formatNumber(r.atk, 0)}</span>
              <span className="num c-def">{formatNumber(r.def, 0)}</span>
              <span className="num">{formatNumber(r.score, 0)}</span>
            </li>
          ))}
          {me && me.rank > 10 && (
            <li className="is-me">
              <b className="num">#{me.rank}</b>
              <span>{me.account}</span>
              <span className="num c-atk">{formatNumber(me.atk, 0)}</span>
              <span className="num c-def">{formatNumber(me.def, 0)}</span>
              <span className="num">{formatNumber(me.score, 0)}</span>
            </li>
          )}
        </ul>
      )}
    </article>
  )
}

function Contributions({ siege }: { siege: Siege }) {
  const contributions = useContributions(siege.planetId)
  const rows = contributions.data ?? []
  return (
    <article className="pl-panel panel">
      <p className="eyebrow">Recent contributions</p>
      {contributions.isLoading ? (
        <p className="muted">Reading the history…</p>
      ) : rows.length === 0 ? (
        <p className="muted">No DEF has reached this world yet. The first contribution opens the count.</p>
      ) : (
        <ul className="pl-board">
          {rows.slice(0, 8).map((c) => (
            <li key={c.trxId + c.account}>
              <span>{c.account}</span>
              <span className="num c-deft">{formatNumber(c.def, 0)} DEF</span>
              <span className="faint">{shortDuration(Date.now() - c.at)} ago</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}

/**
 * The dossier, from the lore's blocks: the first block is the header, a short block ending with a
 * colon a title, one ending with a semicolon a bullet, a short one mentioning priority a quote,
 * and a closing line about the Federation the footer.
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
    else if (i === blocks.length - 1 && /federation|worth|proof/i.test(b))
      nodes.push(
        <p key={i} className="pl-dossier__foot">
          {b}
        </p>
      )
    else nodes.push(<p key={i}>{b}</p>)
  })
  flush()
  return (
    <article className={`pl-panel panel pl-dossier ${open ? 'is-open' : ''}`}>
      <p className="eyebrow">Field dossier</p>
      <div className="pl-dossier__body">{nodes}</div>
      <button type="button" className="mk-link" onClick={() => setOpen((v) => !v)}>
        {open ? 'Fold the dossier' : 'Read the whole dossier'}
      </button>
    </article>
  )
}
