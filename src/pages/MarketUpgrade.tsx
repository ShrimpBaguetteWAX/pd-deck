import { useMemo, useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'

import { buySalesActions, stakeBoughtAction } from '@/chain/actions/market'
import { addUnit, assignGear, buyShopItem, unassignGear } from '@/chain/actions/pd'
import { divisionAllowance, FRAGMENT_TEMPLATE } from '@/chain/config'
import { CardArt } from '@/components/Art'
import { Button } from '@/components/Button'
import { Loading } from '@/components/Loading'
import { Tooltip } from '@/components/Tooltip'
import { makeAssetRef, type AssetRef } from '@/data/assets'
import { costKey, expectedYield, useAscensionConfig } from '@/data/ascension'
import { useBlends, useCollectionTemplates, useOwnedBlendInputs, useTemplatePrices } from '@/data/blends'
import {
  useArmy,
  useAssetStats,
  useForgeConfig,
  useMarket,
  useMissionConfig,
  usePlayer,
  useTemplates,
  useWalletNfts
} from '@/data/game'
import { useSwapPools, type Listing } from '@/data/market'
import { marketFrom, mintable, planBlend, resultOf, valueOf } from '@/lib/blendEconomy'
import { buildEconomy, waxFor } from '@/lib/forgeEconomy'
import { formatNumber, parseAsset } from '@/lib/format'
import { missionEconomics } from '@/lib/loop'
import { buyExactAction, receiveFor } from '@/lib/pool'
import { kindOfCategory } from '@/lib/stats'
import {
  findUpgrades,
  kindsOf,
  rankUpgrades,
  type Goal,
  type Offer,
  type Ranked,
  type StepKind,
  type Upgrade,
  type UpgradeSlot
} from '@/lib/upgrades'
import { buildScenarios, piecesOf, planOf, type Plan, type PlanScenario, type PlanSource } from '@/lib/upgradePlans'
import { usePlanSearch } from '@/lib/usePlanSearch'
import { useTransaction } from '@/wallet/useTransaction'

import './MarketUpgrade.css'

/*
 * The Market's Upgrade tab: every change that makes one of your divisions better, cheapest per
 * gain first. Owned NFTs cost nothing, a Forge slot costs its DEF, a listing its price, a blend the
 * materials it still needs, an ascension the Fragments it still needs; all in WAX.
 *
 * Single changes are priced at once. Whole divisions (a new one, an existing one rebuilt for a
 * better mission, or made faster) take the builder's solver a while each, so they are worked out
 * in the background with a progress bar and join the list as they come in.
 */

/** Blend copies of one recipe the division search may use. */
const PLAN_BLEND_COPIES = 4

const KINDS: { key: StepKind; label: string }[] = [
  { key: 'owned', label: 'Owned' },
  { key: 'forge', label: 'Forge' },
  { key: 'blend', label: 'Blend' },
  { key: 'ascend', label: 'Ascend' },
  { key: 'market', label: 'Market' }
]

const GOALS: { key: Goal; label: string; unit: string }[] = [
  { key: 'tlm', label: 'TLM / hour', unit: 'TLM/h' },
  { key: 'atk', label: 'Attack', unit: 'ATK' },
  { key: 'move', label: 'Move cost', unit: 'move' }
]

const SLOT_LABEL: Record<UpgradeSlot, string> = {
  warlord: 'Warlord',
  mercenary: 'Mercenary',
  weapon: 'Equipment',
  supply: 'Supply',
  creature: 'Creature',
  lavalux: 'Lava Lux'
}

const UPGRADE_SLOTS: UpgradeSlot[] = ['warlord', 'mercenary', 'weapon', 'supply', 'creature', 'lavalux']
const empty = (): Record<UpgradeSlot, Offer[]> => ({
  warlord: [],
  mercenary: [],
  weapon: [],
  supply: [],
  creature: [],
  lavalux: []
})
const slotOf = (a: AssetRef): UpgradeSlot | null => {
  const k = kindOfCategory(a.stats?.category)
  return k ?? null
}

const num = (n: number, digits = 1) => formatNumber(n, digits)

/** What the division search is working on, for the progress line. */
const workingLabel = (w: PlanScenario | null) =>
  !w
    ? 'starting'
    : w.kind === 'new'
      ? `the cheapest new division for ${w.mission.title}${w.input.maxMove ? ', faster' : ''}`
      : w.kind === 'rebuild'
        ? `Division #${w.division!.id} rebuilt for ${w.mission.title}${w.input.maxMove ? ', faster' : ''}`
        : `Division #${w.division!.id} with half the move`

/** A row of the list: one NFT somewhere, or a whole division. */
type Row = Upgrade | Plan

export function Upgrades({
  account,
  listings,
  onBuild
}: {
  account: string | null
  listings: Listing[] | undefined
  /** Opens the division builder on these targets. */
  onBuild: (target: { atk: number; def: number; maxMove?: number }) => void
}) {
  const { run, spectating } = useTransaction()
  const player = usePlayer(account)
  const army = useArmy(account)
  const wallet = useWalletNfts(account)
  const config = useMissionConfig()
  const forge = useForgeConfig()
  const pools = useSwapPools()
  const tlmDef = useMarket()
  const blends = useBlends()
  const collection = useCollectionTemplates()
  const ownedInputs = useOwnedBlendInputs(account)
  const statsMap = useAssetStats()
  const templates = useTemplates()
  const ascension = useAscensionConfig()
  const prices = useTemplatePrices()

  const [goal, setGoal] = useState<Goal>('tlm')
  const [off, setOff] = useState<Set<StepKind>>(() => new Set())
  // Upgrades that need what a better one already takes are hidden unless asked for.
  const [showAlt, setShowAlt] = useState(false)

  const blendMarket = useMemo(
    () =>
      listings && collection.data
        ? marketFrom(listings, ownedInputs.data ?? new Map(), collection.data, account, prices.data)
        : null,
    [listings, collection.data, ownedInputs.data, account, prices.data]
  )

  const missions = useMemo(
    () => (config.data ? config.data.missions.map((row) => missionEconomics(row, config.data!)) : []),
    [config.data]
  )

  const ready =
    !!account &&
    !!army.data &&
    !!wallet.data &&
    !!player.data &&
    !!forge.data &&
    !!pools.data &&
    !!listings &&
    !!blendMarket &&
    !!statsMap.data &&
    !!templates.data

  const built = useMemo(() => {
    if (!ready) return null
    const a = army.data!
    const offers = empty()
    const capacity = new Map<string, number>()
    const addOwned = (list: AssetRef[], source: 'reserve' | 'wallet') => {
      const groups = new Map<string, AssetRef[]>()
      for (const x of list) if (slotOf(x)) groups.set(x.templateId, [...(groups.get(x.templateId) ?? []), x])
      for (const [t, copies] of groups) {
        const res = `${source}:${t}`
        capacity.set(res, copies.length)
        offers[slotOf(copies[0])!].push({ asset: copies[0], source, wax: 0, res, capacity: copies.length })
      }
    }
    addOwned(Object.values(a.free).flat(), 'reserve')
    addOwned(wallet.data!, 'wallet')

    // The cheapest listing of each playable template.
    const byTemplate = new Map<string, Listing[]>()
    for (const l of listings!) {
      if (l.seller === account || !l.kind) continue
      byTemplate.set(l.templateId, [...(byTemplate.get(l.templateId) ?? []), l])
    }
    for (const [t, list] of byTemplate) {
      const cheapest = list.reduce((m, l) => (l.price < m.price ? l : m))
      const slot = slotOf(cheapest.asset)
      if (!slot) continue
      const res = `sale:${t}`
      capacity.set(res, list.length)
      offers[slot].push({
        asset: cheapest.asset,
        source: 'market',
        wax: cheapest.price,
        res,
        capacity: list.length,
        listing: cheapest
      })
    }

    // One blend of each recipe whose result goes into a division, owned materials first.
    for (const b of blends.data ?? []) {
      const r = resultOf(b)
      if (!b.active || !r || !statsMap.data!.has(r) || mintable(blendMarket!, b) < 1) continue
      const cost = planBlend(blendMarket!, b).cost
      if (!Number.isFinite(cost)) continue
      const schema = blendMarket!.templates.get(r)?.schema ?? ''
      const asset = makeAssetRef(`blend:${b.id}`, { t: r, s: schema, c: 'planetdefnft' }, statsMap.data!, templates.data!)
      const slot = slotOf(asset)
      if (slot) offers[slot].push({ asset, source: 'blend', wax: cost, res: `blend:${b.id}`, capacity: 1, blend: b })
    }

    // Raising a card a star. Fragments: owned ones first, then the cheaper of buying Fragments and
    // buying cheap cards to sacrifice for them (expected yield, bonus included).
    const ascensions = new Map<string, Offer>()
    const cfg = ascension.data
    if (cfg && !cfg.paused) {
      const owned = blendMarket!.owned.get(FRAGMENT_TEMPLATE)?.length ?? 0
      let fragment: { price: number; via?: { name: string; perCard: number } } | null = null
      const listed = valueOf(blendMarket!, FRAGMENT_TEMPLATE)
      if (listed !== null) fragment = { price: listed }
      for (const l of listings!) {
        const y = l.kind && l.seller !== account ? cfg.yields.get(l.asset.rarity) : undefined
        const perCard = y ? expectedYield(y) : 0
        if (perCard > 0 && (!fragment || l.price / perCard < fragment.price))
          fragment = { price: l.price / perCard, via: { name: l.asset.name, perCard } }
      }
      const ascendOf = (piece: AssetRef, staked: boolean, res: string, capacity: number): Offer | null => {
        const to = cfg.next.get(piece.templateId)
        const need = cfg.costs.get(costKey(piece.rarity, Number(piece.stats?.min_forge_level ?? 0)))
        if (!to || !need || !statsMap.data!.has(to)) return null
        const buy = Math.max(0, need - owned)
        if (buy > 0 && !fragment) return null
        const asset = makeAssetRef(
          `asc:${piece.assetId}`,
          { t: to, s: piece.schema, c: 'planetdefnft' },
          statsMap.data!,
          templates.data!
        )
        return {
          asset,
          source: 'ascend',
          wax: buy * (fragment?.price ?? 0),
          res,
          capacity,
          ascend: { from: piece, fragments: need, owned, staked, via: buy > 0 ? fragment?.via : undefined }
        }
      }
      // Pieces in the divisions, the warlords included.
      for (const d of a.divisions)
        for (const piece of [d.leader, ...d.units.flatMap((u) => [u.asset, ...Object.values(u.gear)])]) {
          if (!piece) continue
          const o = ascendOf(piece, true, `asc:${piece.assetId}`, 1)
          if (o) ascensions.set(piece.assetId, o)
        }
      // Spare cards, raised a star before they go in.
      for (const [list, source] of [
        [Object.values(a.free).flat(), 'reserve'],
        [wallet.data!, 'wallet']
      ] as const) {
        const seen = new Set<string>()
        for (const card of list) {
          const slot = slotOf(card)
          if (!slot || seen.has(card.templateId)) continue
          seen.add(card.templateId)
          const res = `${source}:${card.templateId}`
          const o = ascendOf(card, source === 'reserve', res, capacity.get(res) ?? 1)
          if (o) offers[slot].push(o)
        }
      }
    }

    const economy = buildEconomy({
      forgeLevel: player.data!.forgeLevel,
      progress: player.data!.forgeProgress,
      levels: forge.data!.levels,
      shopItems: forge.data!.shopItems,
      powerups: player.data!.powerups,
      used: { weapon: a.gearUsed.weapon, supply: a.gearUsed.supply, lavalux: a.gearUsed.lavalux },
      pools: pools.data!
    })
    for (const k of ['weapon', 'supply', 'lavalux'] as const) capacity.set(`slot:${k}`, economy.slots[k].free)
    for (const s of UPGRADE_SLOTS) offers[s].sort((x, y) => x.wax - y.wax)

    const list = findUpgrades({ divisions: a.divisions, missions, market: tlmDef, economy, offers, ascensions, capacity })

    // Whole divisions: everything the solver may use, keyed the way the builder keys it.
    const shared: { key: string; source: PlanSource }[] = []
    for (const x of Object.values(a.free).flat())
      shared.push({ key: `own:${x.assetId}`, source: { from: 'reserve', asset: x, wax: 0 } })
    for (const x of wallet.data!) shared.push({ key: `wal:${x.assetId}`, source: { from: 'wallet', asset: x, wax: 0 } })
    for (const l of listings!)
      if (l.seller !== account && l.kind)
        shared.push({ key: `sale:${l.saleId}`, source: { from: 'market', asset: l.asset, wax: l.price } })
    for (const b of blends.data ?? []) {
      const r = resultOf(b)
      if (!b.active || !r || !statsMap.data!.has(r)) continue
      const reserved = new Map<string, number>()
      const schema = blendMarket!.templates.get(r)?.schema ?? ''
      for (let k = 0; k < Math.min(mintable(blendMarket!, b), PLAN_BLEND_COPIES); k++) {
        const cost = planBlend(blendMarket!, b, reserved).cost
        if (!Number.isFinite(cost)) break
        const key = `blend:${b.id}:${k}`
        const asset = makeAssetRef(key, { t: r, s: schema, c: 'planetdefnft' }, statsMap.data!, templates.data!)
        shared.push({ key, source: { from: 'blend', asset, wax: cost } })
      }
    }
    const economyFor = (freeing: (typeof a.divisions)[number] | null) => {
      const minus = (k: 'weapon' | 'supply' | 'lavalux') =>
        a.gearUsed[k] - (freeing ? freeing.units.filter((u) => u.gear[k]).length : 0)
      return buildEconomy({
        forgeLevel: player.data!.forgeLevel,
        progress: player.data!.forgeProgress,
        levels: forge.data!.levels,
        shopItems: forge.data!.shopItems,
        powerups: player.data!.powerups,
        used: { weapon: minus('weapon'), supply: minus('supply'), lavalux: minus('lavalux') },
        pools: pools.data!
      })
    }
    const freePlaces = Math.max(0, divisionAllowance(player.data!.powerups) - a.divisions.length)
    const divItem = forge
      .data!.shopItems.filter((i) => String(i.reward_powerup) === 'divslot')
      .sort((x, y) => Number(x.min_forge_level) - Number(y.min_forge_level) || Number(x.id) - Number(y.id))[
      player.data!.powerups.get('divslot') ?? 0
    ]
    const divDef = divItem ? parseAsset(divItem.price).amount : 0
    const divSlot = divItem ? { def: divDef, wax: waxFor(pools.data!.def, 'DEF', divDef) } : null
    const scenarios = buildScenarios({
      divisions: a.divisions,
      missions,
      market: tlmDef,
      pool: { shared },
      economyFor,
      freePlaces,
      divSlot
    })
    capacity.set('newdiv', freePlaces)
    // The search restarts only when the army or the wallet changes, not on every market refresh.
    const searchKey = [
      account,
      a.divisions.map((d) => `${d.id}:${piecesOf(d).length}`).join(','),
      Object.values(a.free).flat().length,
      wallet.data!.length,
      player.data!.forgeLevel
    ].join('|')
    return { list, capacity, scenarios, searchKey }
  }, [
    ready,
    army.data,
    wallet.data,
    listings,
    blends.data,
    blendMarket,
    ascension.data,
    player.data,
    forge.data,
    pools.data,
    missions,
    tlmDef,
    statsMap.data,
    templates.data,
    account
  ])

  const search = usePlanSearch(built?.searchKey ?? null, built?.scenarios ?? null)
  const forgeLevel = player.data?.forgeLevel ?? 0
  const plans = useMemo(
    () => search.solved.map((x) => planOf(x.scenario, x.bundle, missions, tlmDef, forgeLevel)).filter((x): x is Plan => !!x),
    [search.solved, missions, tlmDef, forgeLevel]
  )

  const ranked = useMemo(() => {
    if (!built) return []
    const rows: Row[] = [...built.list, ...plans]
    const shown = rows.filter((u) => ![...kindsOf(u)].some((k) => off.has(k)))
    return rankUpgrades(shown, goal, built.capacity)
  }, [built, plans, goal, off])

  // What one TLM fetches in WAX on Alcor, for the payback.
  const tlmInWax = pools.data ? receiveFor(pools.data.tlm, 'TLM', 100) / 100 : 0

  if (!account)
    return <p className="muted">Sign in, or add ?as=account to the address, to see the upgrades for your divisions.</p>
  if (!built) return <Loading inline label="Pricing every upgrade for your divisions" />

  const unit = GOALS.find((g) => g.key === goal)!.unit
  const digits = goal === 'tlm' ? 1 : 0
  // Move cost goes down: its gains read as a minus.
  const sign = goal === 'move' ? '−' : '+'
  const counted = ranked.filter((r) => !r.instead)
  const free = counted.filter((r) => r.upgrade.wax <= 0)
  const freeGain = free.reduce((n, r) => n + r.value, 0)
  const total = counted.at(-1)
  const totalTlm = counted.reduce((n, r) => n + r.upgrade.gain.tlm, 0)
  const payback = (wax: number, tlm: number) => (wax > 0 && tlm > 0 && tlmInWax > 0 ? wax / (tlm * 24 * tlmInWax) : null)
  const allPayback = payback(total?.runWax ?? 0, totalTlm)
  const paid = counted.filter((r) => r.upgrade.wax > 0)
  const shown = showAlt ? ranked : counted
  const alternatives = ranked.length - counted.length
  const position = new Map(shown.map((r, i) => [r.upgrade.id, i + 1]))

  async function apply(u: Upgrade) {
    const o = u.offer
    const d = u.division
    const id = o.listing?.assetId ?? o.asset.assetId
    const slotBuy = u.slotNeed?.buy ?? null
    const defShort = slotBuy ? Math.max(0, slotBuy.def - (player.data?.def ?? 0)) : 0
    await run(
      (a, p) => [
        ...(defShort > 0 ? [buyExactAction(a, p, pools.data!.def, 'DEF', defShort).action] : []),
        ...(slotBuy ? [buyShopItem(a, p, slotBuy.itemId, slotBuy.price, slotBuy.priceContract)] : []),
        ...(o.listing
          ? buySalesActions(a, p, [
              { saleId: o.listing.saleId, assetId: o.listing.assetId, listingPrice: o.listing.listingPrice }
            ])
          : []),
        ...(o.source === 'wallet' || o.source === 'market' ? [stakeBoughtAction(a, p, [id])] : []),
        ...(u.replaces && u.unit ? [unassignGear(a, p, d.id, u.unit.asset.assetId, u.replaces.assetId)] : []),
        u.slot === 'mercenary' || u.slot === 'warlord'
          ? addUnit(a, p, d.id, id)
          : assignGear(a, p, d.id, u.unit!.asset.assetId, u.slot, id)
      ],
      `${o.asset.name} is in Division #${d.id}`,
      `upgrade:${u.id}`,
      { split: true }
    )
  }

  const action = (u: Upgrade) => {
    if (u.slot === 'warlord' && u.offer.source !== 'ascend')
      return (
        <Link className="up-go" to="/army">
          Open Army
        </Link>
      )
    if (u.offer.source === 'blend' || u.offer.source === 'ascend')
      return (
        <Link className="up-go" to="/blend">
          Open Blends
        </Link>
      )
    if (u.level > (player.data?.forgeLevel ?? 0))
      return (
        <Link className="up-go" to="/forge">
          Open Forge
        </Link>
      )
    if (u.division.lock)
      return (
        <Tooltip text="This division is out on a mission. Change it once it is back.">
          <span className="up-go is-off">On a mission</span>
        </Tooltip>
      )
    return (
      <Button size="sm" color="solidBlue" disabled={spectating} onClick={() => apply(u)}>
        Do it
      </Button>
    )
  }

  const planRow = (r: Ranked<Row>, p: Plan) => {
    const days = payback(p.wax, p.gain.tlm)
    const d = p.scenario.division
    const title =
      p.scenario.kind === 'new'
        ? 'New division'
        : p.scenario.kind === 'rebuild'
          ? `Rebuild Division #${d!.id}`
          : `Division #${d!.id}, faster`
    return (
      <article key={p.id} className={`up-row is-plan${r.instead ? ' is-alt' : ''}`}>
        <span className="up-rank">{position.get(p.id)}</span>
        <span className="up-art up-art--plan" aria-hidden="true">
          {p.scenario.kind === 'new' ? '+' : '⇪'}
        </span>
        <div className="up-what">
          <h3>
            {title}
            <span>
              {' '}
              · {p.mission ? p.mission.title : 'its mission'} · {formatNumber(p.after.atk, 0)} ATK /{' '}
              {formatNumber(p.after.def, 0)} DEF / {formatNumber(p.after.move, 0)} move
            </span>
          </h3>
          <div className="up-steps">
            {p.steps.map((s, i) => (
              <span key={i} className="up-step-wrap">
                {i > 0 && <span className="up-arrow">+</span>}
                <span className={`up-step k-${s.kind}`}>
                  <em>{s.kind}</em>
                  {s.label}
                  {s.detail && <s>{s.detail}</s>}
                </span>
              </span>
            ))}
          </div>
        </div>
        <div className="up-gain">
          <b className="num">
            {sign}
            {num(r.value, digits)}
            <small>{unit}</small>
          </b>
          <span className="up-stats">
            {goal !== 'tlm' && p.gain.tlm > 0.05 && <span className="up-stat k-tlm">+{num(p.gain.tlm)} TLM/h</span>}
            {d && goal !== 'move' && p.gain.move !== 0 && (
              <span className="up-stat k-mov">
                {p.gain.move > 0 ? '−' : '+'}
                {Math.abs(p.gain.move)} move
              </span>
            )}
            {!d && <span className="up-stat k-places">+1 division</span>}
          </span>
        </div>
        <div className="up-cost">
          <b className={`num${p.wax <= 0 ? ' is-free' : ''}`}>{p.wax <= 0 ? 'Free' : `${num(p.wax, 2)} WAX`}</b>
          {r.instead ? (
            <small>Instead of #{position.get(r.instead.id)}</small>
          ) : (
            <>
              {days !== null && <small>{num(days)} d payback</small>}
              <small>
                Total {p.wax <= 0 ? '' : `${num(r.runWax, 2)} WAX → `}
                {sign}
                {num(r.runGain, digits)} {unit}
              </small>
            </>
          )}
          <button
            type="button"
            className="up-go"
            onClick={() => onBuild({ atk: p.scenario.input.atk, def: p.scenario.input.def, maxMove: p.scenario.input.maxMove })}
          >
            Open in Builder
          </button>
        </div>
      </article>
    )
  }

  const row = (r: Ranked<Row>) => {
    if (r.upgrade.kind === 'plan') return planRow(r, r.upgrade)
    const u = r.upgrade
    const isFree = u.wax <= 0
    const days = payback(u.wax, u.gain.tlm)
    const target =
      u.slot === 'warlord'
        ? u.offer.source === 'ascend'
          ? 'warlord raised a star'
          : 'new warlord'
        : !u.unit
          ? 'new mercenary'
          : u.slot === 'mercenary'
            ? 'mercenary raised a star'
            : `${SLOT_LABEL[u.slot]} for ${u.unit.asset.name}`
    return (
      <article key={u.id} className={`up-row${r.instead ? ' is-alt' : ''}`}>
        <span className="up-rank">{position.get(u.id)}</span>
        <CardArt asset={u.offer.asset} shape="square" className="up-art" />
        <div className="up-what">
          <h3>
            {u.offer.asset.name}
            <span>
              {' '}
              · Division #{u.division.id} · {target}
              {u.replaces && u.offer.source !== 'ascend' ? ` (instead of ${u.replaces.name})` : ''}
            </span>
          </h3>
          <div className="up-steps">
            {u.steps.map((s, i) => (
              <span key={i} className="up-step-wrap">
                {i > 0 && <span className="up-arrow">→</span>}
                <span className={`up-step k-${s.kind}`}>
                  <em>{s.kind}</em>
                  {s.label}
                  {s.detail && <s>{s.detail}</s>}
                </span>
              </span>
            ))}
          </div>
        </div>
        <div className="up-gain">
          <b className="num">
            {sign}
            {num(r.value, digits)}
            <small>{unit}</small>
          </b>
          <span className="up-stats">
            {goal !== 'tlm' && u.gain.tlm > 0.05 && <span className="up-stat k-tlm">+{num(u.gain.tlm)} TLM/h</span>}
            {goal !== 'atk' && u.gain.atk !== 0 && (
              <span className="up-stat k-atk">
                {u.gain.atk > 0 ? '+' : '−'}
                {Math.abs(u.gain.atk)} ATK
              </span>
            )}
            {u.gain.def !== 0 && (
              <span className="up-stat k-def">
                {u.gain.def > 0 ? '+' : '−'}
                {Math.abs(u.gain.def)} DEF
              </span>
            )}
            {goal !== 'move' && u.gain.move !== 0 && (
              <span className="up-stat k-mov">
                {u.gain.move > 0 ? '−' : '+'}
                {Math.abs(u.gain.move)} move
              </span>
            )}
            {u.gain.places > 0 && <span className="up-stat k-places">+{u.gain.places} places</span>}
          </span>
        </div>
        <div className="up-cost">
          <b className={`num${isFree ? ' is-free' : ''}`}>{isFree ? 'Free' : `${num(u.wax, 2)} WAX`}</b>
          {r.instead ? (
            <small>Instead of #{position.get(r.instead.id)}</small>
          ) : (
            <>
              {!isFree && days !== null && <small>{num(days)} d payback</small>}
              <small>
                Total {isFree ? '' : `${num(r.runWax, 2)} WAX → `}
                {sign}
                {num(r.runGain, digits)} {unit}
              </small>
            </>
          )}
          {action(u)}
        </div>
      </article>
    )
  }

  const firstPaid = shown.findIndex((r) => r.upgrade.wax > 0)

  return (
    <div className="upgrade">
      <section className="panel up-controls">
        <div className="up-ctl">
          <span className="eyebrow">Rank by</span>
          <div className="segmented">
            {GOALS.map((g) => (
              <button key={g.key} type="button" className={goal === g.key ? 'is-active' : ''} onClick={() => setGoal(g.key)}>
                {g.label}
              </button>
            ))}
          </div>
        </div>
        <div className="up-ctl">
          <span className="eyebrow">Ways to upgrade</span>
          <div className="up-chips">
            {KINDS.map((k) => (
              <button
                key={k.key}
                type="button"
                className={`up-chip k-${k.key}`}
                aria-pressed={!off.has(k.key)}
                onClick={() =>
                  setOff((s) => {
                    const n = new Set(s)
                    if (n.has(k.key)) n.delete(k.key)
                    else n.add(k.key)
                    return n
                  })
                }
              >
                <i />
                {k.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className={`up-think${search.finished ? ' is-done' : ''}`} aria-live="polite">
        <div className="up-think__text">
          <b>{search.finished ? 'Whole divisions worked out' : 'Working out whole divisions'}</b>
          <small>
            {search.finished
              ? `${plans.length} of ${search.total} plans add TLM per hour: new divisions, rebuilds for better missions, faster divisions.`
              : `Plan ${Math.min(search.done + 1, search.total)} of ${search.total}: ${workingLabel(search.working)}. Single upgrades are listed already.`}
          </small>
        </div>
        {search.finished ? (
          <button type="button" className="up-go" onClick={search.again}>
            Think again
          </button>
        ) : (
          <span
            className="up-think__bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={search.total}
            aria-valuenow={search.done}
          >
            <i style={{ width: `${search.total ? (search.done / search.total) * 100 : 0}%` }} />
          </span>
        )}
      </section>

      <section className="up-plan" aria-live="polite">
        <div className="up-sum">
          <div>
            <span className="eyebrow">Free right now</span>
            <b className="num is-free">
              {sign}
              {num(freeGain, digits)} {unit}
            </b>
            <small>
              {free.length} upgrade{free.length === 1 ? '' : 's'} with what you own
            </small>
          </div>
          <div>
            <span className="eyebrow">Everything below</span>
            <b className="num">
              {sign}
              {num(total?.runGain ?? 0, digits)} {unit}
            </b>
            <small>
              {counted.length} upgrades · {num(total?.runWax ?? 0, 2)} WAX
              {allPayback !== null ? ` · pays back in ${num(allPayback)} days` : ''}
            </small>
          </div>
        </div>
        {paid.length > 0 && (
          <>
            <div className="up-bar">
              {paid.map((r) => {
                const k = r.upgrade.steps.find((s) => s.kind !== 'owned')?.kind ?? 'owned'
                return (
                  <span
                    key={r.upgrade.id}
                    className={`up-seg k-${k}`}
                    title={`#${position.get(r.upgrade.id)} ${r.upgrade.kind === 'plan' ? 'Whole division' : r.upgrade.offer.asset.name}: ${num(r.upgrade.wax, 2)} WAX`}
                    style={{ '--w': r.upgrade.wax / (total?.runWax || 1) } as CSSProperties}
                  >
                    #{position.get(r.upgrade.id)}
                  </span>
                )
              })}
            </div>
            <div className="up-bar-legend">
              <span>0 WAX</span>
              <span>{num(total?.runWax ?? 0, 2)} WAX</span>
            </div>
          </>
        )}
      </section>

      {shown.length === 0 ? (
        <p className="muted">
          Nothing on offer makes your divisions better by this measure right now. Try ranking by Attack or Move cost.
        </p>
      ) : (
        <div className="up-list">
          {firstPaid !== 0 && <h3 className="up-group eyebrow">Free with what you own</h3>}
          {shown.slice(0, firstPaid < 0 ? shown.length : firstPaid).map(row)}
          {firstPaid >= 0 && <h3 className="up-group eyebrow">Costs WAX</h3>}
          {firstPaid >= 0 && shown.slice(firstPaid).map(row)}
        </div>
      )}
      {alternatives > 0 && (
        <button type="button" className="up-more" onClick={() => setShowAlt((v) => !v)}>
          {showAlt
            ? 'Hide the alternatives'
            : `Show ${alternatives} alternative${alternatives === 1 ? '' : 's'}: other places for the same NFT or slot`}
        </button>
      )}
      <p className="muted up-note">
        Each upgrade is valued alone against the division as it is now; a whole-division plan replaces the division (or adds one).
        TLM per hour is the best token mission the division then reaches, after swaps. Payback converts TLM to WAX at the Alcor
        price.
      </p>
    </div>
  )
}
