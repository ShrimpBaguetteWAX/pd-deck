import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { deployActions } from '@/chain/actions/pd'
import { IpfsImg, PlanetIcon, TokenIcon } from '@/components/Art'
import { Button } from '@/components/Button'
import { Loading } from '@/components/Loading'
import { Modal } from '@/components/Modal'
import { Figure, StatTrio } from '@/components/Stat'
import { Tooltip } from '@/components/Tooltip'
import { useArmy, useDeployments, useMarket, useMissionConfig, usePlayer, useTemplates, type Division } from '@/data/game'
import { ChevronIcon, RocketIcon, ShardIcon, ShieldIcon, SwordIcon, TimerIcon, XIcon } from '@/icons'
import { formatDuration, formatNumber, formatSigned, formatToken, percent, titleCase } from '@/lib/format'
import {
  canDeploy,
  costParts,
  cycleRoi,
  cycleRoute,
  cycleSeconds,
  isTokenLoop,
  meetsRequirements,
  missionEconomics,
  planLoops,
  rewardParts,
  tlmPerHour,
  type CycleRoute,
  type MissionEconomics,
  type PlanLine
} from '@/lib/loop'
import { fundEntries, quoteFunding, type Market } from '@/lib/market'
import { publicUrl } from '@/lib/publicUrl'
import { chainDate, shortDuration, useNow } from '@/lib/time'
import { useTransaction } from '@/wallet/useTransaction'

import './Missions.css'

type Filter = 'all' | 'eligible' | 'tlm' | 'def' | 'shards' | 'nft'
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'eligible', label: 'For my army' },
  { key: 'tlm', label: 'TLM' },
  { key: 'def', label: 'DEF' },
  { key: 'shards', label: 'Shards' },
  { key: 'nft', label: 'NFT' }
]

interface Row {
  e: MissionEconomics
  /** The qualifying division whose time this mission pays best for (lowest move), busy or not. */
  division: Division | null
  /** The same among idle divisions: who would go if you deployed now. */
  idleDivision: Division | null
  move: number
  perHour: number
  route: CycleRoute
  eligible: boolean
  deployable: boolean
}

export default function Missions() {
  const { account, run, pending } = useTransaction()
  const config = useMissionConfig()
  const army = useArmy(account)
  const player = usePlayer(account)
  const deployments = useDeployments(account)
  const templates = useTemplates()
  const market = useMarket()
  const now = useNow(30_000)
  const [filter, setFilter] = useState<Filter>('all')
  const [planet, setPlanet] = useState('')
  const [expanded, setExpanded] = useState<number | null>(null)
  const [deploying, setDeploying] = useState<MissionEconomics | null>(null)
  const [planOpen, setPlanOpen] = useState(false)

  const missions = useMemo(
    () =>
      config.data
        ? config.data.missions.map((m) => missionEconomics(m, config.data!, now)).filter((e) => e.state !== 'closed')
        : [],
    [config.data, now]
  )

  const divisions = useMemo(() => (army.data?.divisions ?? []).filter((d) => d.units.length > 0), [army.data])
  const busy = useMemo(() => new Set(deployments.data?.map((d) => d.divisionId) ?? []), [deployments.data])
  const idle = useMemo(
    () => divisions.filter((d) => !busy.has(d.id) && !(d.lock && +chainDate(d.lock.locked_until) > now)),
    [divisions, busy, now]
  )
  const plan = useMemo(() => planLoops(idle, missions, market), [idle, missions, market])
  const planPerDay = plan.reduce((n, l) => n + l.perHour * 24, 0)

  const rows = useMemo<Row[]>(() => {
    const fastest = (list: Division[], e: MissionEconomics) =>
      list.filter((d) => meetsRequirements(e, d.atk, d.def)).sort((a, b) => a.move - b.move)[0] ?? null
    const list = missions.map((e): Row => {
      const division = fastest(divisions, e)
      const idleDivision = fastest(idle, e)
      // Without a qualifying division, rate the mission as if the army's fastest division reached it.
      const move = division?.move ?? Math.min(...divisions.map((d) => d.move), Infinity)
      const perHour = tlmPerHour(e, Number.isFinite(move) ? move : 0, market)
      return {
        e,
        division,
        idleDivision,
        move: Number.isFinite(move) ? move : 0,
        perHour,
        route: cycleRoute(e, market),
        eligible: !!division,
        deployable: e.state === 'active' && !!idleDivision
      }
    })
    const filtered = list.filter(({ e, eligible }) => {
      if (planet && e.planet !== planet) return false
      switch (filter) {
        case 'eligible':
          return eligible
        case 'tlm':
          return e.rewardTlm > 0
        case 'def':
          return e.rewardDef > 0
        case 'shards':
          return e.rewardShards > 0
        case 'nft':
          return !!e.rewardNft
        default:
          return true
      }
    })
    // Missions your army can run, by TLM per hour after swaps; then shard/NFT missions; then losing
    // loops; then what is still out of reach, best first so the next target is visible.
    const tier = (r: Row) => {
      if (r.e.state !== 'active') return 0
      if (!r.eligible) return 1
      if (!isTokenLoop(r.e)) return 3
      return r.perHour > 0 ? 4 : 2
    }
    return filtered.sort((a, b) => tier(b) - tier(a) || b.perHour - a.perHour)
  }, [missions, filter, planet, idle, divisions, market])

  const planets = useMemo(() => [...new Set(missions.map((e) => e.planet).filter(Boolean))], [missions])
  const nftName = (id?: number) => (id ? templates.data?.[String(id)]?.name : undefined)

  // The best loop the army can run at all, and the best one just out of reach.
  const allRows = useMemo(() => {
    const fastest = (e: MissionEconomics) =>
      divisions.filter((d) => meetsRequirements(e, d.atk, d.def)).sort((a, b) => a.move - b.move)[0]
    return missions
      .filter((e) => e.state === 'active' && isTokenLoop(e))
      .map((e) => {
        const d = fastest(e)
        const move = d?.move ?? Math.min(...divisions.map((x) => x.move))
        return { e, d, perHour: tlmPerHour(e, Number.isFinite(move) ? move : 0, market) }
      })
      .sort((a, b) => b.perHour - a.perHour)
  }, [missions, divisions, market])
  const best = allRows.find((r) => r.d && r.perHour > 0)
  const target = allRows.find((r) => !r.d && r.perHour > (best?.perHour ?? 0))
  const strongest = divisions.reduce<{ atk: number; def: number }>(
    (m, d) => ({ atk: Math.max(m.atk, d.atk), def: Math.max(m.def, d.def) }),
    { atk: 0, def: 0 }
  )

  if (!config.data) return <Loading inline label="Scanning the sector" />

  const balance = player.data ? { tlm: player.data.tlm, def: player.data.def } : null
  const planCostTlm = plan.reduce((n, l) => n + l.mission.costTlm, 0)
  const planCostDef = plan.reduce((n, l) => n + l.mission.costDef, 0)
  const planFunding = quoteFunding(market, { tlm: planCostTlm, def: planCostDef }, balance)

  async function deployPlan() {
    if (!plan.length) return
    const byMission = new Map<number, PlanLine[]>()
    for (const l of plan) byMission.set(l.mission.id, [...(byMission.get(l.mission.id) ?? []), l])
    const ok = await run(
      (a, p) => [
        ...fundEntries(a, p, market, { tlm: planCostTlm, def: planCostDef }, balance).actions,
        ...[...byMission.entries()].flatMap(([id, lines]) =>
          deployActions(
            a,
            p,
            id,
            lines.map((l) => l.division.id),
            lines.filter((l) => !l.division.fresh).map((l) => l.division.id),
            lines[0].mission.costs
          )
        )
      ],
      `${plan.length} division${plan.length === 1 ? '' : 's'} deployed`,
      'plan'
    )
    if (ok) setPlanOpen(false)
  }

  const bestRow = best ? rows.find((r) => r.e.id === best.e.id) : undefined

  return (
    <div className="page missions">
      {/* Loop planner */}
      <section className={`plan panel ${plan.length ? 'is-live' : ''}`}>
        <div className="plan__text">
          <p className="eyebrow">Best TLM loop for your army</p>
          {army.isLoading ? (
            <h2>Reading your divisions…</h2>
          ) : divisions.length === 0 ? (
            <>
              <h2>No divisions yet</h2>
              <p className="muted">
                Build one in the <Link to="/army">Army</Link> and this panel will pick its most profitable mission.
              </p>
            </>
          ) : (
            <>
              {best ? (
                <h2>
                  <PlanetIcon planet={best.e.planet} size={20} /> {best.e.title}{' '}
                  <span className="c-tlm num">{formatSigned(best.perHour)}</span>{' '}
                  <small className="muted">TLM/h per division</small>
                </h2>
              ) : (
                <h2>No profitable TLM loop for your divisions yet</h2>
              )}
              {best && <RouteLine route={cycleRoute(best.e, market)} className="plan__route" />}
              {plan.length > 0 ? (
                <>
                  <p className="plan__sub">
                    Deploying every idle division to its best loop:{' '}
                    <b className="c-tlm num">{formatSigned(planPerDay)} TLM/day</b> · {plan.length} division
                    {plan.length === 1 ? '' : 's'}, one transaction
                  </p>
                  <ul className="plan__lines">
                    {plan.slice(0, 6).map((l) => (
                      <li key={l.division.id}>
                        <b>#{l.division.id}</b>
                        <span className="plan__arrow">→</span>
                        <span className="plan__mission">
                          <PlanetIcon planet={l.mission.planet} size={14} /> {l.mission.title}
                        </span>
                        <span className="num c-tlm">{formatSigned(l.perHour)}/h</span>
                        <span className="faint num">{formatDuration(l.seconds)} per cycle</span>
                      </li>
                    ))}
                    {plan.length > 6 && <li className="faint">…and {plan.length - 6} more</li>}
                  </ul>
                </>
              ) : (
                <p className="plan__sub muted">
                  {idle.length === 0 ? (
                    <>
                      Every division is out. Claim and loop them on the <Link to="/deployments">Deployments</Link> page.
                    </>
                  ) : (
                    'No idle division reaches a profitable TLM loop right now.'
                  )}
                </p>
              )}
              {target && (
                <p className="plan__target">
                  Next target: <b>{target.e.title}</b> pays <b className="c-tlm num">{formatSigned(target.perHour)}/h</b> and
                  needs{' '}
                  {target.e.minAtk > strongest.atk && (
                    <b className="c-atk num">
                      {formatNumber(target.e.minAtk, 0)} ATK (+{formatNumber(target.e.minAtk - strongest.atk, 0)})
                    </b>
                  )}
                  {target.e.minAtk > strongest.atk && target.e.minDef > strongest.def && ' and '}
                  {target.e.minDef > strongest.def && (
                    <b className="c-def num">
                      {formatNumber(target.e.minDef, 0)} DEF (+{formatNumber(target.e.minDef - strongest.def, 0)})
                    </b>
                  )}{' '}
                  on one division. <Link to="/army">Merge or equip in the Army</Link>.
                </p>
              )}
            </>
          )}
        </div>
        {plan.length > 0 && (
          <div className="plan__cta">
            <div className="plan__cost">
              <Figure
                label="TLM in"
                value={planFunding.tlmTotal > 0 ? formatToken(planFunding.tlmTotal, 'TLM') : 'Free'}
                help={
                  planFunding.defBought > 0
                    ? `Includes buying ${formatToken(planFunding.defBought)} DEF for entry fees on Alcor, in the same transaction.`
                    : 'Entry fees paid from your wallet in the same transaction.'
                }
              />
              <Figure
                label="Net per cycle"
                value={formatSigned(
                  plan.reduce((n, l) => n + l.net, 0),
                  'TLM'
                )}
                tone="c-tlm"
              />
            </div>
            <Button
              size="lg"
              color="gradientYellow"
              disabled={!planFunding.affordable}
              isLoading={pending === 'plan'}
              onClick={() => setPlanOpen(true)}
            >
              <RocketIcon /> Deploy plan
            </Button>
            {!planFunding.affordable && (
              <small className="c-red">
                Needs {formatToken(planFunding.tlmTotal, 'TLM')}; you hold {formatToken(balance?.tlm ?? 0, 'TLM')}.
              </small>
            )}
          </div>
        )}
      </section>

      {/* Filters */}
      <div className="missions__bar">
        <div className="segmented">
          {FILTERS.map((f) => (
            <button key={f.key} type="button" className={filter === f.key ? 'is-active' : ''} onClick={() => setFilter(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="planets">
          <button type="button" className={`planets__chip ${planet === '' ? 'is-on' : ''}`} onClick={() => setPlanet('')}>
            All planets
          </button>
          {planets.map((p) => (
            <button
              key={p}
              type="button"
              className={`planets__chip ${planet === p ? 'is-on' : ''}`}
              onClick={() => setPlanet(planet === p ? '' : p)}
            >
              <PlanetIcon planet={p} size={16} /> {titleCase(p)}
            </button>
          ))}
        </div>
        <Tooltip
          text={`Every loop is valued in TLM out minus TLM in: DEF an entry needs is bought with TLM on Alcor, DEF a reward pays is sold for TLM, both at the pool's live quote with its ${percent(market.fee)} fee.${market.live ? '' : ' Pool not read yet: using a typical rate.'}`}
        >
          <span className="chip">
            <TokenIcon symbol="DEF" size={14} /> 1 DEF ≈ {formatNumber(market.rate, 1)} TLM
          </span>
        </Tooltip>
      </div>

      {/* Table */}
      <div className="mtable" role="table">
        <div className="mtable__head" role="row">
          <span>Mission</span>
          <span>Requires</span>
          <span>Entry</span>
          <span>Reward</span>
          <span>
            Cycle{' '}
            <Tooltip text="How long your division is locked per run: base cooldown + 10 s per point of its move cost. Your fastest qualifying division is used." />
          </span>
          <span>
            TLM / hour{' '}
            <Tooltip text="Net Trilium per hour of division time after the swaps: TLM (and DEF bought with TLM) in, TLM (and DEF sold for TLM) out." />
          </span>
          <span>ROI</span>
          <span />
        </div>
        {rows.length === 0 && (
          <div className="empty">
            <strong>No missions match</strong>
            <span>Try another filter or planet.</span>
          </div>
        )}
        {rows.map((r) => {
          const { e, division, idleDivision, move, perHour, route, eligible, deployable } = r
          const open = expanded === e.id
          const roi = cycleRoi(e, market)
          const isBest = r === bestRow
          const atkOk = divisions.some((d) => d.atk >= e.minAtk && d.def >= e.minDef) || strongest.atk >= e.minAtk
          const defOk = divisions.some((d) => d.atk >= e.minAtk && d.def >= e.minDef) || strongest.def >= e.minDef
          const reason = !divisions.length
            ? ''
            : !eligible
              ? 'No division meets the requirements'
              : !idleDivision
                ? 'Every qualifying division is out on a mission'
                : ''
          return (
            <article
              key={e.id}
              className={`mrow ${isBest ? 'is-best' : ''} ${!eligible && divisions.length ? 'is-out' : ''} ${open ? 'is-open' : ''} state-${e.state}`}
            >
              <div className="mrow__main" role="row" onClick={() => setExpanded(open ? null : e.id)}>
                <div className="mrow__mission">
                  <IpfsImg hash={e.image} alt="" className="mrow__art" fallback={publicUrl('/img/mission-fallback.webp')} />
                  <div className="mrow__title">
                    <b>{e.title}</b>
                    <span className="mrow__sub">
                      <PlanetIcon planet={e.planet} size={14} /> {titleCase(e.planet || 'unknown')} · OP-
                      {String(e.id).padStart(3, '0')}
                      {isBest && <em className="mrow__best">Best loop</em>}
                      {isBest && !deployable && <em className="mrow__flag">division out</em>}
                      {e.state === 'upcoming' && <em className="mrow__flag">Starts {shortDuration(e.startAt - now)}</em>}
                      {e.state === 'full' && <em className="mrow__flag is-red">Full</em>}
                      {e.state === 'capped' && <em className="mrow__flag is-red">Shard budget spent</em>}
                    </span>
                  </div>
                </div>
                <div className="mrow__req">
                  <span className={`req ${e.minAtk ? (atkOk ? 'is-ok' : 'is-no') : 'is-none'}`}>
                    <SwordIcon /> {e.minAtk || '–'}
                  </span>
                  <span className={`req ${e.minDef ? (defOk ? 'is-ok' : 'is-no') : 'is-none'}`}>
                    <ShieldIcon /> {e.minDef || '–'}
                  </span>
                </div>
                <div className="mrow__entry">
                  {costParts(e).length ? (
                    costParts(e).map((c) => <Amount key={c} text={c} />)
                  ) : (
                    <span className="c-green">Free</span>
                  )}
                </div>
                <div className="mrow__reward">
                  {rewardParts(e, nftName(e.rewardNft?.templateId)).map((part) => (
                    <Amount key={part} text={part} />
                  ))}
                </div>
                <div className="mrow__cycle num">
                  <TimerIcon width={13} height={13} /> {formatDuration(cycleSeconds(e, move))}
                  <small className="faint">{formatDuration(e.cooldownBase)} base</small>
                </div>
                {isTokenLoop(e) ? (
                  <>
                    <div className={`mrow__rate num ${perHour > 0 ? 'is-pos' : perHour < 0 ? 'is-neg' : ''}`}>
                      {formatSigned(perHour)}
                      <small>
                        {formatSigned(route.net)} / cycle
                        {(route.buyDef > 0 || route.sellDef > 0) && <span className="mrow__swap"> · {routeTag(route)}</span>}
                      </small>
                    </div>
                    <div className="mrow__roi num">{roi === Infinity ? '∞' : route.tlmIn > 0 ? percent(roi) : '–'}</div>
                  </>
                ) : (
                  <>
                    <div className={`mrow__rate num ${e.rewardShards ? 'is-shards' : 'is-nft'}`}>
                      {e.rewardShards
                        ? `${formatNumber((e.rewardShards / cycleSeconds(e, move)) * 3600, 1)}`
                        : e.rewardNft
                          ? `${e.rewardNft.count}× NFT`
                          : '–'}
                      <small>
                        {e.rewardShards ? 'shards / hour' : 'per cycle'}
                        {route.tlmIn > 0 ? ` · costs ${formatToken(route.tlmIn)} TLM` : ''}
                      </small>
                    </div>
                    <div className="mrow__roi num faint">–</div>
                  </>
                )}
                <div className="mrow__act" onClick={(ev) => ev.stopPropagation()}>
                  <Button
                    size="sm"
                    color={isBest ? 'gradientYellow' : deployable ? 'solidBlue' : 'ghost'}
                    disabled={!deployable}
                    onClick={() => setDeploying(e)}
                    title={reason}
                  >
                    <RocketIcon /> Deploy
                  </Button>
                  <ChevronIcon className="mrow__chev" />
                </div>
              </div>
              {open && (
                <div className="mrow__detail rise">
                  <div className="mrow__lore">
                    <p className="eyebrow">Loop route, per division per cycle</p>
                    <RouteSteps e={e} route={route} market={market} />
                    <p className="eyebrow">Field intel</p>
                    {e.lore ? (
                      e.lore.split(/\n{2,}/).map((para, i) => <p key={i}>{para}</p>)
                    ) : (
                      <p className="muted">No briefing filed.</p>
                    )}
                  </div>
                  <div className="mrow__facts">
                    <Figure label="Window ends" value={Number.isFinite(e.endAt) ? shortDuration(e.endAt - now) : '–'} />
                    <Figure label="Divisions engaged" value={formatNumber(e.joined, 0)} />
                    {e.shardCap && (
                      <Figure label="Shard budget" value={`${e.shardCap.max - e.shardCap.used} / ${e.shardCap.max} joins left`} />
                    )}
                    <Figure
                      label="Fastest division"
                      value={division ? `#${division.id} (${division.move} move)` : divisions.length ? 'None qualifies' : '–'}
                    />
                    {division && idleDivision && idleDivision !== division && (
                      <Figure label="Idle now" value={`#${idleDivision.id} (${idleDivision.move} move)`} />
                    )}
                  </div>
                </div>
              )}
            </article>
          )
        })}
      </div>

      {deploying && (
        <DeployModal
          mission={deploying}
          idle={idle}
          market={market}
          balances={balance}
          pending={pending}
          onClose={() => setDeploying(null)}
          onDeploy={async (ids) => {
            const chosen = idle.filter((d) => ids.includes(d.id))
            const cost = { tlm: deploying.costTlm * ids.length, def: deploying.costDef * ids.length }
            const ok = await run(
              (a, p) => [
                ...fundEntries(a, p, market, cost, balance).actions,
                ...deployActions(
                  a,
                  p,
                  deploying.id,
                  ids,
                  chosen.filter((d) => !d.fresh).map((d) => d.id),
                  deploying.costs
                )
              ],
              `${ids.length} division${ids.length === 1 ? '' : 's'} sent to ${deploying.title}`,
              'deploy'
            )
            if (ok) setDeploying(null)
          }}
        />
      )}

      {planOpen && (
        <Modal className="picker deploy" onClose={() => setPlanOpen(false)} label="Deploy plan">
          <header className="picker__head">
            <div>
              <p className="eyebrow">One transaction</p>
              <h3>Deploy the plan</h3>
              <p className="muted">
                Each idle division goes to the mission that pays it the most TLM per hour.
                {planFunding.defBought > 0
                  ? ` ${formatToken(planFunding.defBought)} DEF for the entry fees is bought with TLM on Alcor first, in the same transaction.`
                  : ' Entry fees are paid in the same transaction.'}
              </p>
            </div>
            <button type="button" className="icon-btn" onClick={() => setPlanOpen(false)} aria-label="Close">
              <XIcon />
            </button>
          </header>
          <ul className="deploy__list">
            {plan.map((l) => (
              <li key={l.division.id} className="deploy__line">
                <b>#{l.division.id}</b>
                <StatTrio atk={l.division.atk} def={l.division.def} move={l.division.move} size="sm" />
                <span className="deploy__to">
                  <PlanetIcon planet={l.mission.planet} size={14} /> {l.mission.title}
                </span>
                <span className="num faint">{formatDuration(l.seconds)}</span>
                <span className="num c-tlm">{formatSigned(l.net, 'TLM')}</span>
              </li>
            ))}
          </ul>
          <footer className="picker__foot">
            <span className="muted">
              TLM in: {formatToken(planFunding.tlmTotal, 'TLM')} · net{' '}
              {formatSigned(
                plan.reduce((n, l) => n + l.net, 0),
                'TLM'
              )}{' '}
              per cycle
            </span>
            <Button color="gradientYellow" isLoading={pending === 'plan'} disabled={!planFunding.affordable} onClick={deployPlan}>
              <RocketIcon /> Deploy {plan.length}
            </Button>
          </footer>
        </Modal>
      )}
    </div>
  )
}

/** "TLM→DEF", "DEF→TLM" or both: which swaps a loop needs. */
const routeTag = (r: CycleRoute) => [r.buyDef > 0 && 'TLM→DEF', r.sellDef > 0 && 'DEF→TLM'].filter(Boolean).join(' · ')

/** The whole loop in one line: TLM in → (DEF) → mission → (DEF) → TLM out. */
function RouteLine({ route, className = '' }: { route: CycleRoute; className?: string }) {
  return (
    <p className={`route ${className}`}>
      <span className="route__step c-tlm">
        <TokenIcon symbol="TLM" size={13} /> {formatToken(route.tlmIn)} in
      </span>
      {route.buyDef > 0 && (
        <>
          <span className="route__arrow">→</span>
          <span className="route__step c-deft">
            <TokenIcon symbol="DEF" size={13} /> {formatToken(route.buyDef)}
          </span>
        </>
      )}
      <span className="route__arrow">→</span>
      <span className="route__step">mission</span>
      {route.sellDef > 0 && (
        <>
          <span className="route__arrow">→</span>
          <span className="route__step c-deft">
            <TokenIcon symbol="DEF" size={13} /> {formatToken(route.sellDef)}
          </span>
        </>
      )}
      <span className="route__arrow">→</span>
      <span className="route__step c-tlm">
        <TokenIcon symbol="TLM" size={13} /> {formatToken(route.tlmOut)} out
      </span>
    </p>
  )
}

function RouteSteps({ e, route, market }: { e: MissionEconomics; route: CycleRoute; market: Market }) {
  const steps: string[] = []
  if (route.buyDef > 0) steps.push(`Buy ${formatToken(route.buyDef)} DEF on Alcor for ≈${formatToken(route.buyTlm)} TLM`)
  if (e.costTlm > 0 || e.costDef > 0) steps.push(`Pay the entry: ${costParts(e).join(' + ')}`)
  else steps.push('Free entry')
  steps.push(`Earn ${rewardParts(e).join(' + ') || 'nothing'} on claim`)
  if (route.sellDef > 0) steps.push(`Sell ${formatToken(route.sellDef)} DEF on Alcor for ≈${formatToken(route.sellTlm)} TLM`)
  if (route.buyDef === 0 && route.sellDef === 0 && e.costDef > 0 && e.rewardDef > 0)
    steps.push('The DEF reward pays the next entry, no swap needed')
  return (
    <div className="route-steps">
      <RouteLine route={route} />
      <ol>
        {steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <p className="faint">
        Net {formatSigned(route.net, 'TLM')} per cycle at the live pool quote (1 DEF ≈ {formatNumber(market.rate, 1)} TLM,{' '}
        {percent(market.fee)} fee).
      </p>
    </div>
  )
}

/** "300 TLM" with its token icon, "2× Quantum Chest", "300 shards" with the shard crystal. */
function Amount({ text }: { text: string }) {
  const sym = / TLM$/.test(text) ? 'TLM' : / DEF$/.test(text) ? 'DEF' : null
  return (
    <span
      className={`amount ${sym === 'TLM' ? 'c-tlm' : sym === 'DEF' ? 'c-deft' : /shards$/.test(text) ? 'c-cyan' : 'c-purple'}`}
    >
      {sym ? <TokenIcon symbol={sym} size={14} /> : /shards$/.test(text) ? <ShardIcon width={14} height={14} /> : null}
      {text}
    </span>
  )
}

// ---- Deploy modal: which idle divisions go ----------------------------------------------------------------

interface DeployProps {
  mission: MissionEconomics
  idle: Division[]
  market: Market
  balances: { tlm: number; def: number } | null
  pending: string | null
  onClose: () => void
  onDeploy: (divisionIds: number[]) => Promise<void>
}

function DeployModal({ mission: e, idle, market, balances, pending, onClose, onDeploy }: DeployProps) {
  const eligible = useMemo(() => idle.filter((d) => canDeploy(e, d)).sort((a, b) => a.move - b.move), [idle, e])
  const [chosen, setChosen] = useState<number[]>(() => eligible.map((d) => d.id))
  const toggle = (id: number) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))
  const n = chosen.length
  const funding = quoteFunding(market, { tlm: e.costTlm * n, def: e.costDef * n }, balances)
  const route = cycleRoute(e, market)

  return (
    <Modal className="picker deploy" onClose={onClose} label={`Deploy to ${e.title}`}>
      <header className="picker__head">
        <div>
          <p className="eyebrow">
            <PlanetIcon planet={e.planet} size={14} /> {titleCase(e.planet || '')} · OP-{String(e.id).padStart(3, '0')}
          </p>
          <h3>{e.title}</h3>
          <p className="muted">
            Requires <b className="c-atk">{e.minAtk || 0} ATK</b>
            {e.minDef ? (
              <>
                {' '}
                and <b className="c-def">{e.minDef} DEF</b>
              </>
            ) : null}
            . Pays {rewardParts(e).join(' + ') || 'nothing'} per division per cycle
            {costParts(e).length ? `; entry ${costParts(e).join(' + ')} each` : ''}.
          </p>
          {isTokenLoop(e) && <RouteLine route={route} />}
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <XIcon />
        </button>
      </header>

      {eligible.length === 0 ? (
        <div className="empty">
          <strong>No idle division qualifies</strong>
          <span>Every division that meets the requirements is already deployed, or none reaches them yet.</span>
        </div>
      ) : (
        <ul className="deploy__list">
          {eligible.map((d) => {
            const on = chosen.includes(d.id)
            const seconds = cycleSeconds(e, d.move)
            const perHour = tlmPerHour(e, d.move, market)
            return (
              <li key={d.id}>
                <button
                  type="button"
                  className={`deploy__line deploy__line--pick ${on ? 'is-on' : ''}`}
                  onClick={() => toggle(d.id)}
                >
                  <span className={`deploy__check ${on ? 'is-on' : ''}`} />
                  <b>#{d.id}</b>
                  <StatTrio atk={d.atk} def={d.def} move={d.move} size="sm" />
                  <span className="num faint">
                    <TimerIcon width={12} height={12} /> {formatDuration(seconds)}
                  </span>
                  <span className={`num ${perHour >= 0 ? 'c-tlm' : 'c-red'}`}>
                    {isTokenLoop(e) ? `${formatSigned(perHour)}/h` : ''}
                  </span>
                  {!d.fresh && (
                    <Tooltip text="Stats cache is from an older epoch; it is recalculated in the same transaction.">
                      <span className="chip chip--gold">recalc</span>
                    </Tooltip>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <footer className="picker__foot">
        <span className="muted">
          {n} division{n === 1 ? '' : 's'} · {funding.tlmTotal > 0 ? `${formatToken(funding.tlmTotal, 'TLM')} in` : 'free entry'}
          {e.costDef > 0 && funding.defBought === 0 && n > 0 && ` + ${formatToken(e.costDef * n, 'DEF')} from your wallet`}
          {funding.defBought > 0 && ` (buys ${formatToken(funding.defBought)} DEF on Alcor)`}
          {!funding.affordable && <b className="c-red"> · not enough TLM</b>}
        </span>
        <Button
          color="gradientYellow"
          disabled={!n || !funding.affordable}
          isLoading={pending === 'deploy'}
          onClick={() => onDeploy(chosen)}
        >
          <RocketIcon /> Deploy {n || ''}
        </Button>
      </footer>
    </Modal>
  )
}
