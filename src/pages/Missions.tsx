import { useEffect, useMemo, useRef, useState } from 'react'

import { deployActions } from '@/chain/actions/pd'
import { IpfsImg, PlanetIcon, TokenIcon } from '@/components/Art'
import { Button } from '@/components/Button'
import { Loading } from '@/components/Loading'
import { Modal } from '@/components/Modal'
import { Figure, StatTrio } from '@/components/Stat'
import { Tooltip } from '@/components/Tooltip'
import {
  freshMarket,
  useArmy,
  useDeployments,
  useGameBalance,
  useMarket,
  useMissionConfig,
  usePlayer,
  useTemplates,
  type Division
} from '@/data/game'
import { coveredBy, walletCosts, walletPart, type GameBalance } from '@/lib/deposit'
import { ChevronIcon, RocketIcon, ShardIcon, ShieldIcon, SwordIcon, TimerIcon, XIcon } from '@/icons'
import { formatDuration, formatNumber, formatSigned, formatToken, percent, titleCase } from '@/lib/format'
import {
  canDeploy,
  costParts,
  cycleRoute,
  cycleSeconds,
  isTokenLoop,
  meetsRequirements,
  missionEconomics,
  rewardParts,
  tlmPerHour,
  type CycleRoute,
  type MissionEconomics
} from '@/lib/loop'
import { SALE_KEEP } from '@/lib/blendEconomy'
import { fundEntries, quoteFunding, type Market } from '@/lib/market'
import { receiveFor } from '@/lib/pool'
import { useSwapPools } from '@/data/market'
import { normalizeHash } from '@/lib/ipfs'
import { publicUrl } from '@/lib/publicUrl'
import { MISSION_THUMBS } from '@/data/missionThumbs'
import { chainDate, shortDuration, useNow } from '@/lib/time'
import { useCollectionTemplates, useTemplatePrices } from '@/data/blends'
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

/** Move per 100 strength when there is no army to read it from. */
const MOVE_DEFAULT = 40
const MOVE_MAX = 100
/** Shards the player counts as 1 TLM, kept between visits. */
const SHARD_KEY = 'pd:missions:tlmPerShard'
/** Earlier visits stored it the other way round: shards per 1 TLM. */
const OLD_SHARD_KEY = 'pd:missions:shardsPerTlm'
const SHARD_DEFAULT = 0.1

/** The TLM a shard is worth, as the player last set it. */
function storedShardValue(): string {
  const now = readStored(SHARD_KEY)
  if (now !== null) return now
  const old = Number(readStored(OLD_SHARD_KEY))
  return old > 0 ? String(Math.round((1 / old) * 100) / 100) : String(SHARD_DEFAULT)
}
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writeStored(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    // Storage blocked: the value lasts for this visit only.
  }
}

const RING_R = 20
const RING_C = 2 * Math.PI * RING_R

/** The efficiency score in a ring filled to its share of the best one in the list. */
function EffRing({ score, share }: { score: number; share: number }) {
  const r = Math.max(0, Math.min(1, share))
  return (
    <span className={`effring num ${score < 0 ? 'is-neg' : ''}`}>
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="24" r={RING_R} className="effring__track" />
        {r > 0 && <circle cx="24" cy="24" r={RING_R} className="effring__fill" strokeDasharray={`${RING_C * r} ${RING_C}`} />}
      </svg>
      <b>{formatNumber(score, Math.abs(score) >= 10 ? 1 : 2)}</b>
    </span>
  )
}

type SortKey = 'mission' | 'requires' | 'entry' | 'reward' | 'cycle' | 'rate'

interface Row {
  e: MissionEconomics
  /** The qualifying division whose time this mission pays best for (lowest move), busy or not. */
  division: Division | null
  /** The same among idle divisions: who would go if you deployed now. */
  idleDivision: Division | null
  move: number
  /** TLM per hour of a division's time, the NFT reward sold at market value and swapped to TLM included. */
  perHour: number
  /** TLM a cycle's NFT reward would fetch: market value after the 7% sale fees, swapped to TLM. 0 when unpriced. */
  loot: number
  /**
   * TLM per hour for every 100 points of the strength the mission asks for (the higher of ATK and
   * DEF), for a division with the assumed move per 100 of strength. Null when the mission pays no
   * TLM or asks for no strength.
   */
  efficiency: number | null
  /** The move the efficiency score assumes for this mission (the slider times what it asks for). */
  assumedMove: number
  /** TLM per hour, NFT loot included, for a division with the assumed move. */
  estPerHour: number
  route: CycleRoute
  eligible: boolean
  deployable: boolean
}

export default function Missions() {
  const { account, runSequence, pending } = useTransaction()
  const config = useMissionConfig()
  const army = useArmy(account)
  const player = usePlayer(account)
  const gameBalance = useGameBalance(account)
  const deployments = useDeployments(account)
  const templates = useTemplates()
  const collection = useCollectionTemplates()
  // What the NFTs a mission pays would fetch: AtomicMarket's median of recent sales, in WAX, and the WAX→TLM pool.
  const prices = useTemplatePrices()
  const pools = useSwapPools()
  const priceByTemplate = useMemo(() => new Map((prices.data ?? []).map((x) => [x.templateId, x.median])), [prices.data])
  const market = useMarket()
  const now = useNow(30_000)
  const [filter, setFilter] = useState<Filter>('all')
  const [expanded, setExpanded] = useState<number | null>(null)
  const [deploying, setDeploying] = useState<MissionEconomics | null>(null)
  // Move per 100 strength the efficiency score assumes; null follows the connected army.
  const [moveSet, setMoveSet] = useState<number | null>(null)
  // Whether the cycle and TLM/h columns show the slider's estimate or your own divisions.
  const [view, setView] = useState<'est' | 'mine'>('est')
  // Which column the table is sorted by; efficiency first, best on top.
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'rate', desc: true })
  // The scoring panel: open from its chip, closed by Escape or a click elsewhere.
  const [scoreOpen, setScoreOpen] = useState(false)
  const scoreRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!scoreOpen) return
    const onDown = (ev: PointerEvent) => {
      if (!scoreRef.current?.contains(ev.target as Node)) setScoreOpen(false)
    }
    const onKey = (ev: KeyboardEvent) => ev.key === 'Escape' && setScoreOpen(false)
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [scoreOpen])
  // How many shards the player takes as worth 1 TLM (10 unless they set it); empty leaves shards out of the score.
  const [shardValue, setShardValue] = useState(storedShardValue)
  const tlmPerShard = Number(shardValue) > 0 ? Number(shardValue) : 0

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
  // How much move the army carries for its strength: the default for the efficiency score.
  const armyMove = useMemo(() => {
    const strength = divisions.reduce((n, d) => n + Math.max(d.atk, d.def), 0)
    return strength > 0 ? Math.min(MOVE_MAX, Math.round((divisions.reduce((n, d) => n + d.move, 0) / strength) * 100)) : null
  }, [divisions])
  const movePer100 = moveSet ?? armyMove ?? MOVE_DEFAULT

  const rows = useMemo<Row[]>(() => {
    const lootOf = (e: MissionEconomics) => {
      if (!e.rewardNft || !pools.data) return 0
      const wax = priceByTemplate.get(String(e.rewardNft.templateId))
      return wax ? receiveFor(pools.data.tlm, 'WAX', wax * e.rewardNft.count * SALE_KEEP) : 0
    }
    const fastest = (list: Division[], e: MissionEconomics) =>
      list.filter((d) => meetsRequirements(e, d.atk, d.def)).sort((a, b) => a.move - b.move)[0] ?? null
    const list = missions.map((e): Row => {
      const division = fastest(divisions, e)
      const idleDivision = fastest(idle, e)
      // Without a qualifying division, rate the mission as if the army's fastest division reached it.
      const move = division?.move ?? Math.min(...divisions.map((d) => d.move), Infinity)
      const m = Number.isFinite(move) ? move : 0
      const loot = lootOf(e)
      const perHour = tlmPerHour(e, m, market) + (loot > 0 ? (loot / cycleSeconds(e, m)) * 3600 : 0)
      const need = Math.max(e.minAtk, e.minDef)
      const assumed = Math.round((need * movePer100) / 100)
      const shards = tlmPerShard > 0 ? e.rewardShards : 0
      const efficiency =
        need > 0 && (isTokenLoop(e) || loot > 0 || shards > 0)
          ? ((tlmPerHour(e, assumed, market) + ((loot + shards * tlmPerShard) / cycleSeconds(e, assumed)) * 3600) / need) * 100
          : null
      return {
        e,
        division,
        idleDivision,
        move: Number.isFinite(move) ? move : 0,
        perHour,
        loot,
        efficiency,
        assumedMove: assumed,
        estPerHour: tlmPerHour(e, assumed, market) + (loot > 0 ? (loot / cycleSeconds(e, assumed)) * 3600 : 0),
        route: cycleRoute(e, market),
        eligible: !!division,
        deployable: e.state === 'active' && !!idleDivision
      }
    })
    const filtered = list.filter(({ e, eligible }) => {
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
    return filtered
  }, [missions, filter, idle, divisions, market, priceByTemplate, pools.data, movePer100, tlmPerShard])

  // The gauges show each mission's share of the most efficient one in the list.
  const bestEfficiency = rows.reduce((n, r) => Math.max(n, r.efficiency ?? 0), 0)

  // Reward NFTs are loot (Quantum Chests), which the stats templates do not cover: the collection's templates name them.
  const nftInfo = (id?: number) => (id ? (templates.data?.[String(id)] ?? collection.data?.get(String(id))) : undefined)
  const nftName = (id?: number) => nftInfo(id)?.name

  const strongest = divisions.reduce<{ atk: number; def: number }>(
    (m, d) => ({ atk: Math.max(m.atk, d.atk), def: Math.max(m.def, d.def) }),
    { atk: 0, def: 0 }
  )

  // What each column sorts by, for the view on screen.
  const sortValue = (r: Row): number | string => {
    const m = view === 'est' ? r.assumedMove : r.move
    switch (sort.key) {
      case 'mission':
        return r.e.title.toLowerCase()
      case 'requires':
        return Math.max(r.e.minAtk, r.e.minDef)
      case 'entry':
        return r.route.tlmIn
      case 'reward':
        return r.route.tlmOut + r.loot + r.e.rewardShards * tlmPerShard
      case 'cycle':
        return cycleSeconds(r.e, m)
      default:
        // Efficiency; missions without one (no TLM, shards not counted) go after, by TLM per hour.
        return r.efficiency ?? -1e12 + (view === 'est' ? r.estPerHour : r.perHour)
    }
  }
  const sorted = [...rows].sort((a, b) => {
    const x = sortValue(a)
    const y = sortValue(b)
    const c = typeof x === 'string' ? x.localeCompare(String(y)) : x - (y as number)
    return (sort.desc ? -c : c) || a.e.title.localeCompare(b.e.title)
  })
  const sortHead = (key: SortKey, label: string, inline = false) => {
    const on = sort.key === key
    const button = (
      <button
        type="button"
        className={`mtable__sort ${on ? 'is-on' : ''}`}
        aria-label={`Sort by ${label}`}
        onClick={() =>
          setSort(
            on
              ? { key, desc: !sort.desc }
              : { key, desc: key !== 'mission' && key !== 'requires' && key !== 'entry' && key !== 'cycle' }
          )
        }
      >
        {label}
        <span aria-hidden="true">{on ? (sort.desc ? ' ▾' : ' ▴') : ''}</span>
      </button>
    )
    return inline ? button : <span aria-sort={on ? (sort.desc ? 'descending' : 'ascending') : 'none'}>{button}</span>
  }

  if (!config.data) return <Loading inline label="Scanning the sector" />

  const balance = player.data ? { tlm: player.data.tlm, def: player.data.def } : null

  return (
    <div className="page missions">
      {/* Filters */}
      <div className="missions__bar">
        <div className="segmented">
          {FILTERS.map((f) => (
            <button key={f.key} type="button" className={filter === f.key ? 'is-active' : ''} onClick={() => setFilter(f.key)}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="effctl">
          <div className={`viewflip is-${view}`} role="group" aria-label="Show the cycle and TLM per hour for">
            <button type="button" className={view === 'est' ? 'is-on' : ''} onClick={() => setView('est')}>
              Estimate
            </button>
            <button
              type="button"
              className="viewflip__switch"
              aria-pressed={view === 'mine'}
              aria-label="Switch between the estimate and my divisions"
              onClick={() => setView(view === 'est' ? 'mine' : 'est')}
            />
            <button type="button" className={view === 'mine' ? 'is-on' : ''} onClick={() => setView('mine')}>
              My divisions
            </button>
          </div>
          <div className="scorepop" ref={scoreRef}>
            <button
              type="button"
              className="scorepop__chip"
              aria-expanded={scoreOpen}
              aria-controls="scorepop"
              onClick={() => setScoreOpen(!scoreOpen)}
            >
              Score: <b className="c-mov num">{movePer100}</b> move ·{' '}
              {tlmPerShard > 0 ? (
                <>
                  <b className="c-tlm num">{formatNumber(tlmPerShard, 2)}</b> per shard
                </>
              ) : (
                'shards not counted'
              )}
              <ChevronIcon className="scorepop__chev" />
            </button>
            {scoreOpen && (
              <div id="scorepop" className="scorepop__panel" role="dialog" aria-label="How missions are scored">
                <h3>How missions are scored</h3>
                <div className="scorefield">
                  <label className="scorefield__top" htmlFor="score-move">
                    <span>Move per 100 strength</span>
                    <b className="c-mov num">{movePer100}</b>
                  </label>
                  <input
                    id="score-move"
                    type="range"
                    min={0}
                    max={MOVE_MAX}
                    step={1}
                    value={movePer100}
                    onChange={(ev) => setMoveSet(Number(ev.target.value))}
                  />
                  <small>
                    {armyMove === null ? 'No divisions to read it from yet.' : `Your army carries ${armyMove}.`} Lower means a
                    faster division and a shorter cycle.
                    {moveSet !== null && armyMove !== null && moveSet !== armyMove && (
                      <button type="button" className="scorefield__reset" onClick={() => setMoveSet(null)}>
                        Back to {armyMove}
                      </button>
                    )}
                  </small>
                </div>
                <div className="scorefield">
                  <div className="scorefield__top">
                    <label htmlFor="score-shard" className="scorefield__unit is-shard">
                      1 <ShardIcon width={12} height={12} /> shard is worth
                    </label>
                    <span className="scorefield__value">
                      <input
                        id="score-shard"
                        type="number"
                        min={0}
                        step={0.01}
                        inputMode="decimal"
                        placeholder="–"
                        value={shardValue}
                        onChange={(ev) => {
                          setShardValue(ev.target.value)
                          writeStored(SHARD_KEY, ev.target.value)
                        }}
                      />
                      <span className="scorefield__unit is-tlm">
                        <TokenIcon symbol="TLM" size={12} /> TLM
                      </span>
                    </span>
                  </div>
                  <small>Shard rewards count toward the score at this value. Empty it to score TLM only.</small>
                </div>
                <div className="scorefield">
                  <div className="scorefield__top">
                    <span className="scorefield__unit is-def">
                      1 <TokenIcon symbol="DEF" size={12} /> DEF is worth
                    </span>
                    <span className="scorefield__value">
                      <output className="num c-tlm">{formatNumber(market.rate, 1)}</output>
                      <span className="scorefield__unit is-tlm">
                        <TokenIcon symbol="TLM" size={12} /> TLM
                      </span>
                      <span className={`scorefield__live ${market.live ? '' : 'is-off'}`}>
                        {market.live ? 'live' : 'typical'}
                      </span>
                    </span>
                  </div>
                  <small>
                    Read from the Alcor pool, not set by you. DEF for entries is bought and DEF rewards are sold at this rate,
                    with the pool's {percent(market.fee)} fee.
                    {market.live ? '' : ' The pool has not been read yet, so a typical rate is used.'}
                  </small>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="mtable" role="table">
        <div className="mtable__head" role="row">
          {sortHead('mission', 'Mission')}
          {sortHead('requires', 'Requires')}
          {sortHead('entry', 'Entry')}
          {sortHead('reward', 'Reward')}
          <span>
            {sortHead('cycle', 'Cycle', true)}{' '}
            <Tooltip
              text={
                view === 'est'
                  ? `How long a division is locked per run: base cooldown + 10 s per point of move. Estimate: a division with ${movePer100} move per 100 strength.`
                  : 'How long your division is locked per run: base cooldown + 10 s per point of its move cost. Your fastest qualifying division is used.'
              }
            />
          </span>
          <span>
            {sortHead('rate', 'TLM / h · Efficiency', true)}{' '}
            <Tooltip
              text={`TLM per hour after the swaps, for ${view === 'est' ? 'the estimate' : 'your fastest qualifying division'}. The ring is the efficiency: net TLM per hour for every 100 points of the strength the mission asks for (ATK, or DEF when it asks for more DEF), for a division with ${movePer100} move per 100 strength. It stays the same in both views.`}
            />
          </span>
          <span />
        </div>
        {rows.length === 0 && (
          <div className="empty">
            <strong>No missions match</strong>
            <span>Try another filter.</span>
          </div>
        )}
        {sorted.map((r) => {
          const { e, division, idleDivision, move, perHour, efficiency, route, eligible, deployable } = r
          const shownMove = view === 'est' ? r.assumedMove : move
          const shownPerHour = view === 'est' ? r.estPerHour : perHour
          const open = expanded === e.id
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
              className={`mrow ${!eligible && divisions.length ? 'is-out' : ''} ${open ? 'is-open' : ''} state-${e.state}`}
            >
              <div className="mrow__main" role="row" onClick={() => setExpanded(open ? null : e.id)}>
                <div className="mrow__mission">
                  <MissionArt image={e.image} className="mrow__art" />
                  <div className="mrow__title">
                    <b>{e.title}</b>
                    <span className="mrow__sub">
                      {e.state === 'upcoming' && <em className="mrow__flag">Starts {shortDuration(e.startAt - now)}</em>}
                      {e.state === 'active' && Number.isFinite(e.endAt) && (
                        <Tooltip text="How long this mission can still be joined. A division already out keeps its lock and reward.">
                          <em className={`mrow__flag ${e.endAt - now < 24 * 3_600_000 ? 'is-red' : ''}`}>
                            Ends in {shortDuration(e.endAt - now)}
                          </em>
                        </Tooltip>
                      )}
                      {e.state === 'full' && <em className="mrow__flag is-red">Full</em>}
                      {e.state === 'capped' && <em className="mrow__flag is-red">Shard budget spent</em>}
                      {e.shardCap ? (
                        <Tooltip
                          text={`This mission can be joined ${formatNumber(e.shardCap.max, 0)} times in all, by every player together. ${formatNumber(e.shardCap.used, 0)} joins are used, ${formatNumber(e.shardCap.max - e.shardCap.used, 0)} are left.`}
                        >
                          <em className={`mrow__cap ${e.shardCap.max - e.shardCap.used < e.shardCap.max / 10 ? 'is-low' : ''}`}>
                            <span className="num">{formatNumber(e.shardCap.max - e.shardCap.used, 0)}</span> <small>joins</small>
                          </em>
                        </Tooltip>
                      ) : null}
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
                  <TimerIcon width={13} height={13} /> {formatDuration(cycleSeconds(e, shownMove))}
                  <small className="faint">
                    {formatDuration(e.cooldownBase)} base ·{' '}
                    {view === 'est'
                      ? `${formatNumber(r.assumedMove, 0)} move`
                      : division
                        ? `#${division.id}`
                        : 'no division qualifies'}
                  </small>
                </div>
                {efficiency !== null || isTokenLoop(e) || r.loot > 0 ? (
                  <div className="mrow__score">
                    {isTokenLoop(e) || r.loot > 0 ? (
                      <div className={`mrow__rate num ${shownPerHour > 0 ? 'is-pos' : shownPerHour < 0 ? 'is-neg' : ''}`}>
                        {formatSigned(shownPerHour)}
                        <small>TLM / hour</small>
                      </div>
                    ) : (
                      <div className="mrow__rate num is-shards">
                        {formatNumber((e.rewardShards / cycleSeconds(e, shownMove)) * 3600, 1)}
                        <small>shards / hour</small>
                      </div>
                    )}
                    {efficiency !== null && (
                      <Tooltip
                        text={`${formatSigned(efficiency)} TLM per hour for every 100 ${e.minDef > e.minAtk ? 'DEF' : 'ATK'} the mission asks for, at ${movePer100} move per 100 strength.`}
                      >
                        <EffRing score={efficiency} share={bestEfficiency > 0 ? efficiency / bestEfficiency : 0} />
                      </Tooltip>
                    )}
                  </div>
                ) : (
                  <>
                    <div className={`mrow__rate num ${e.rewardShards ? 'is-shards' : 'is-nft'}`}>
                      {e.rewardShards
                        ? `${formatNumber((e.rewardShards / cycleSeconds(e, shownMove)) * 3600, 1)}`
                        : e.rewardNft
                          ? `${e.rewardNft.count}× ${nftName(e.rewardNft.templateId) ?? 'NFT'}`
                          : '–'}
                      {e.rewardNft && nftInfo(e.rewardNft.templateId)?.img && (
                        <IpfsImg hash={nftInfo(e.rewardNft.templateId)!.img} alt="" className="mrow__loot" />
                      )}
                      <small>
                        {e.rewardShards ? 'shards / hour' : 'per cycle'}
                        {route.tlmIn > 0 ? ` · costs ${formatToken(route.tlmIn)} TLM` : ''}
                      </small>
                    </div>
                  </>
                )}
                <div className="mrow__act" onClick={(ev) => ev.stopPropagation()}>
                  <Button size="sm" color="ghost" disabled={!deployable} onClick={() => setDeploying(e)} title={reason}>
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
                    <Figure label="Net per cycle" value={`${formatSigned(route.net + r.loot)} TLM`} />
                    {r.loot > 0 && e.rewardNft && (
                      <Figure
                        label="NFT reward at market"
                        value={`${e.rewardNft.count}× ${nftName(e.rewardNft.templateId) ?? 'NFT'} ≈ ${formatNumber(r.loot, 1)} TLM`}
                      />
                    )}
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
          deposit={gameBalance.data ?? null}
          pending={pending}
          onClose={() => setDeploying(null)}
          onDeploy={async (ids) => {
            const chosen = idle.filter((d) => ids.includes(d.id))
            const entries = { tlm: deploying.costTlm * ids.length, def: deploying.costDef * ids.length }
            // What the game balance covers is taken from it by the contract; the rest is sent as before.
            const fromDeposit = coveredBy(entries, gameBalance.data)
            const cost = walletPart(entries, fromDeposit)
            // One transaction per division; the first also buys the DEF all the entries need.
            const done = await runSequence(
              chosen.map((d, i) => ({
                build: async (a: string, p: string) => [
                  ...(i === 0 ? fundEntries(a, p, await freshMarket(market), cost, balance).actions : []),
                  ...deployActions(a, p, deploying.id, d.id, !d.fresh, walletCosts(deploying.costs, fromDeposit))
                ],
                success: `#${d.id} sent to ${deploying.title}`
              })),
              'deploy'
            )
            if (done === chosen.length) setDeploying(null)
          }}
        />
      )}
    </div>
  )
}

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
  /** The game balance: entry fees it covers are taken from it, not sent. */
  deposit: GameBalance | null
  pending: string | null
  onClose: () => void
  onDeploy: (divisionIds: number[]) => Promise<void>
}

function DeployModal({ mission: e, idle, market, balances, deposit, pending, onClose, onDeploy }: DeployProps) {
  const eligible = useMemo(() => idle.filter((d) => canDeploy(e, d)).sort((a, b) => a.move - b.move), [idle, e])
  const [chosen, setChosen] = useState<number[]>(() => eligible.map((d) => d.id))
  const toggle = (id: number) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))
  const n = chosen.length
  const entries = { tlm: e.costTlm * n, def: e.costDef * n }
  const fromDeposit = coveredBy(entries, deposit)
  const funding = quoteFunding(market, walletPart(entries, fromDeposit), balances)
  const paidInGame = [
    fromDeposit.tlm && formatToken(entries.tlm, 'TLM'),
    fromDeposit.def && formatToken(entries.def, 'DEF')
  ].filter(Boolean)
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
          {n} division{n === 1 ? '' : 's'} ·{' '}
          {funding.tlmTotal > 0
            ? `${formatToken(funding.tlmTotal, 'TLM')} in`
            : paidInGame.length
              ? 'nothing from your wallet'
              : 'free entry'}
          {e.costDef > 0 &&
            !fromDeposit.def &&
            funding.defBought === 0 &&
            n > 0 &&
            ` + ${formatToken(e.costDef * n, 'DEF')} from your wallet`}
          {n > 0 && paidInGame.length > 0 && ` · ${paidInGame.join(' + ')} from your game balance`}
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

/** A mission's picture: the tiny thumbnail shipped with the app when there is one, else the IPFS image. */
function MissionArt({ image, className }: { image: string; className?: string }) {
  const cid = normalizeHash(image)
  if (cid && MISSION_THUMBS.has(cid)) {
    return <img className={className} src={publicUrl(`/img/missions/${cid}.webp`)} alt="" loading="lazy" decoding="async" />
  }
  return <IpfsImg hash={image} alt="" className={className} fallback={publicUrl('/img/mission-fallback.webp')} />
}
