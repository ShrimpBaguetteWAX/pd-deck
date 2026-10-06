import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'

import type { AnyAction } from '@wharfkit/session'

import { atomic } from '@/chain/atomic'
import { blendActions, type BlendRun } from '@/chain/actions/blend'
import { buySalesActions, stakeBoughtAction } from '@/chain/actions/market'
import { addUnit, assignGear as assignGearAction, buyShopItem, createDivision, payForgeLevel } from '@/chain/actions/pd'
import { CardArt, PlanetIcon, rarityColor, TokenIcon } from '@/components/Art'
import { Button } from '@/components/Button'
import { Loading } from '@/components/Loading'
import { Figure, StatTrio } from '@/components/Stat'
import { toast } from '@/components/toast'
import { Tooltip } from '@/components/Tooltip'
import { makeAssetRef, type AssetRef } from '@/data/assets'
import { useBlends, useCollectionTemplates, useOwnedBlendInputs, type Blend } from '@/data/blends'
import {
  useArmy,
  useAssetStats,
  useForgeConfig,
  useMarket,
  useMissionConfig,
  usePlayer,
  useTemplates,
  useWalletNfts,
  type PlayerData,
  type Division
} from '@/data/game'
import { useListings, useSwapPools, type Listing, type SwapPools } from '@/data/market'
import { marketFrom, mintable, planBlend, resultOf, type Market as BlendMarket } from '@/lib/blendEconomy'
import { isTokenLoop, tlmPerHour, cycleSeconds, type MissionEconomics } from '@/lib/loop'
import type { Market as TlmDefMarket } from '@/lib/market'
import { CartIcon, CheckIcon, FlameIcon, MinusIcon, PlusIcon, RocketIcon, TimerIcon } from '@/icons'
import {
  GEAR_KINDS,
  type Bundle,
  type Candidate,
  type GearKind,
  type SlotKind,
  type SolveInput,
  type WarlordOption
} from '@/lib/bundle'
import { buildEconomy, waxFor } from '@/lib/forgeEconomy'
import { formatDuration, formatNumber, formatToken, titleCase } from '@/lib/format'
import { buyExactAction, receiveFor } from '@/lib/pool'
import { missionEconomics } from '@/lib/loop'
import { kindOfCategory, KIND_LABEL, type Kind } from '@/lib/stats'
import { useBundleSolver } from '@/lib/useBundleSolver'
import { useTransaction } from '@/wallet/useTransaction'

import './Market.css'

/**
 * Where a bundle item comes from: a market listing to buy, your reserve, one of your divisions
 * (to take out first), your wallet (to stake), or a blend (materials bought or owned, burned in a
 * recipe; `asset` only describes the result).
 */
type Source =
  | { from: 'market'; listing: Listing }
  | { from: 'reserve'; asset: AssetRef }
  | { from: 'division'; asset: AssetRef; division: number; locked: boolean }
  | { from: 'wallet'; asset: AssetRef }
  | { from: 'blend'; blend: Blend; asset: AssetRef }

/** Copies of one recipe offered to the solver: plenty for one division. */
const MAX_BLEND_COPIES = 12
/** Correction rounds per pass at most; a pass also stops as soon as a round no longer improves. */
const MAX_ROUNDS = 8
/** Stand-in price for a blend whose materials have run out. */
const UNMAKEABLE = 1e12
/** How long the search may sit with nothing to solve before it counts as finished. */
const WATCHDOG_MS = 1500
/** A pass ends after this many rounds in a row without getting cheaper. */
const PATIENCE = 2

/** Where the search for the cheapest bundle stands for one target (see the correction loop). */
interface Refinement {
  target: string
  prices: Map<string, number>
  rounds: number
  phase: 'owned' | 'market'
  /** Cheapest real cost this pass has reached so far. */
  lastTotal: number
  /** Rounds in a row that did not get below lastTotal. */
  stale: number
  /** Solves finished for this target. */
  step: number
  done: boolean
}

const FRESH_REFINEMENT: Refinement = {
  target: '',
  prices: new Map(),
  rounds: 0,
  phase: 'owned',
  lastTotal: Infinity,
  stale: 0,
  step: 0,
  done: false
}

/** A short, stable fingerprint of a long string. */
/** Everything staked inside a division: its leader, its units and their gear. */
const divisionPieces = (d: Division): AssetRef[] =>
  [d.leader, ...d.units.flatMap((u) => [u.asset, u.gear.weapon, u.gear.supply, u.gear.creature, u.gear.lavalux])].filter(
    (a): a is AssetRef => !!a
  )

function hashOf(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = (h * 33) ^ text.charCodeAt(i)
  return (h >>> 0).toString(36)
}

const SOLVABLE: Kind[] = ['mercenary', 'weapon', 'supply', 'creature', 'lavalux']
const GEAR_ORDER: GearKind[] = GEAR_KINDS
const SLOT_LABEL: Record<SlotKind, string> = { weapon: 'equipment', supply: 'supply', lavalux: 'Lava Lux' }

/**
 * The candidates each solver input was built from. While a new input is being solved the page still
 * shows the previous answer, which must be read with its own candidates: after "Use my NFTs" is
 * switched off, for one, the new candidates no longer contain the wallet NFTs that answer uses.
 */
const SOURCES_OF = new WeakMap<SolveInput, Map<string, Source>>()

const assetOf = (s: Source) => (s.from === 'market' ? s.listing.asset : s.asset)

/** A plan being carried out: kept as it was bought, so the division is built from exactly these NFTs. */
/**
 * One transaction of a purchase. Each is complete in itself (a group of sales is checked, paid and
 * bought together; a group of blends deposits and blends its own materials), so a purchase that
 * stops half way never leaves WAX or NFTs in limbo, and the steps after it can be resumed.
 */
interface PurchaseStep {
  label: string
  build: (account: string, permission: string) => AnyAction[]
}

/** Sales per transaction: 4 checks, 1 deposit and 4 purchases make 9 actions (each purchase moves an NFT and pays fees). */
const SALES_PER_TX = 4
/** Blend runs per transaction (their materials are deposited in the same transaction). */
const BLENDS_PER_TX = 4
/** NFTs staked per transaction. */
const STAKE_PER_TX = 20

const chunk = <T,>(list: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size))

interface Locked {
  bundle: Bundle
  sources: Map<string, Source>
  phase: 'buying' | 'bought' | 'building' | 'done'
  /** While buying: the steps, how many are done, and the one that failed (if it stopped). */
  steps?: PurchaseStep[]
  done?: number
  failed?: string
  /** Wallet asset ids of the blended templates before blending, so the new ones can be told apart. */
  known: Set<string>
}

export default function Market() {
  const { account, run, pending, spectating } = useTransaction()
  const player = usePlayer(account)
  const army = useArmy(account)
  const wallet = useWalletNfts(account)
  const listings = useListings()
  const config = useMissionConfig()
  const forge = useForgeConfig()
  const pools = useSwapPools()
  const blends = useBlends()
  const collection = useCollectionTemplates()
  const ownedInputs = useOwnedBlendInputs(account)
  const statsMap = useAssetStats()
  const templatesJson = useTemplates()
  const tlmDef = useMarket()

  const [atkText, setAtkText] = useState('1000')
  const [defText, setDefText] = useState('0')
  // Optional: the division's move cost may not go above this (blank: no limit).
  const [moveText, setMoveText] = useState('')
  // The scan the user started: its targets and toggles, plus a counter so the same values can be rescanned.
  const [scanKey, setScanKey] = useState<string | null>(null)
  // Staked NFTs (the reserve), wallet NFTs and wallet blend materials can each be used or not.
  const [useStaked, setUseStaked] = useState(true)
  const [useDivisions, setUseDivisions] = useState(false)
  const [useWallet, setUseWallet] = useState(true)
  const [useMaterials, setUseMaterials] = useState(true)
  const useOwned = useStaked || useDivisions || useWallet || useMaterials
  const [locked, setLocked] = useState<Locked | null>(null)
  /*
   * Blend prices corrected after a solve (see below), keyed by candidate; cleared when the targets
   * change. Two passes: 'owned' prices each recipe as if your materials were free for it alone;
   * 'market' prices every blend at market cost and lets your materials lower the real cost only when
   * the chosen blends are planned together. Owning more can then never make the answer dearer.
   */
  const [blendPrices, setBlendPrices] = useState<Refinement>(FRESH_REFINEMENT)
  // The cheapest bundle any correction round found for the current target, at its real (joint) cost.
  const [best, setBest] = useState<{
    target: string
    bundle: Bundle
    input: SolveInput
    total: number
    /** The corrections and pass that produced it, so a refresh can rebuild the same answer. */
    prices: Map<string, number>
    phase: Refinement['phase']
  } | null>(null)
  const [browse, setBrowse] = useState<Kind | 'all'>('mercenary')

  const atk = Math.max(0, Math.round(Number(atkText) || 0))
  const def = Math.max(0, Math.round(Number(defText) || 0))
  const maxMove = Math.round(Number(moveText) || 0) > 0 ? Math.round(Number(moveText)) : undefined
  const forgeLevel = player.data?.forgeLevel ?? 0

  // Nothing is searched until the user asks: typing a target should not start a long search.
  const paramsKey = `${atk}/${def}/${maxMove ?? '-'}/${useStaked}/${useDivisions}/${useWallet}/${useMaterials}`
  const scanning = !!scanKey && scanKey.startsWith(paramsKey + '#')
  /*
   * A scan works on a snapshot of the market and your NFTs taken when it starts. Pool prices refresh
   * every minute and listings every two; if those fed into a running scan, every refresh would change
   * its input and restart the search, and a search step longer than a minute would never finish.
   * "Scan again" takes a fresh snapshot.
   */
  const live = {
    listings: listings.data,
    army: army.data,
    wallet: wallet.data,
    player: player.data,
    forge: forge.data,
    pools: pools.data,
    ownedInputs: ownedInputs.data
  }
  const [frozen, setFrozen] = useState<{ key: string; at: number; data: typeof live } | null>(null)
  const scanWith = (a: number, d: number) => {
    if (a <= 0 && d <= 0) return
    const key = `${a}/${d}/${maxMove ?? '-'}/${useStaked}/${useDivisions}/${useWallet}/${useMaterials}#${Date.now()}`
    setScanKey(key)
    setFrozen({ key, at: Date.now(), data: live })
  }
  const scan = () => scanWith(atk, def)
  const snapshot = scanning && frozen?.key === scanKey ? frozen : null
  const snap = snapshot?.data ?? live

  // Every current mission, for the payback panel.
  const missionList = useMemo(
    () => (config.data ? config.data.missions.map((row) => missionEconomics(row, config.data!)) : []),
    [config.data]
  )

  // One-click targets: the requirements of the missions running now.
  const presets = useMemo(() => {
    if (!config.data) return []
    const seen = new Map<string, { atk: number; def: number; title: string; planet: string }>()
    for (const row of config.data.missions) {
      const e = missionEconomics(row, config.data)
      if (e.state !== 'active' || (!e.minAtk && !e.minDef)) continue
      const key = `${e.minAtk}/${e.minDef}`
      if (!seen.has(key)) seen.set(key, { atk: e.minAtk, def: e.minDef, title: e.title, planet: e.planet })
    }
    return [...seen.values()].sort((a, b) => a.atk + a.def - (b.atk + b.def))
  }, [config.data])

  /*
   * Corrected blend prices only apply to the target they were found for. A new target, or a change in
   * what you own, starts the search over. A scan works on its own snapshot (see above), so market
   * refreshes never disturb it.
   */
  const ownedSig = useMemo(
    () =>
      hashOf(
        [
          (snap.wallet ?? []).map((a) => a.assetId).join(','),
          snap.army
            ? Object.values(snap.army.free)
                .flatMap((list) => list.map((a) => a.assetId))
                .join(',')
            : '',
          snap.army ? snap.army.divisions.flatMap((d) => divisionPieces(d).map((a) => a.assetId)).join(',') : '',
          [...(snap.ownedInputs?.entries() ?? [])].map(([t, ids]) => `${t}:${ids.length}`).join(',')
        ].join('|')
      ),
    [snap.wallet, snap.army, snap.ownedInputs]
  )
  const targetKey = `${scanKey}|${ownedSig}`
  // The best bundle is only comparable within one market snapshot.
  const bestKey = targetKey
  const correctedPrices = useMemo(
    () => (blendPrices.target === targetKey ? blendPrices.prices : new Map<string, number>()),
    [blendPrices, targetKey]
  )
  const phase = blendPrices.target === targetKey ? blendPrices.phase : 'owned'

  // Materials on the market and in the wallet, for pricing blends (owned ones only when allowed).
  const blendMarket = useMemo(
    () =>
      snap.listings && collection.data
        ? marketFrom(snap.listings, useMaterials ? (snap.ownedInputs ?? new Map()) : new Map(), collection.data, account)
        : null,
    [snap.listings, collection.data, snap.ownedInputs, useMaterials, account]
  )

  // Everything the solver may use, and where each piece comes from.
  const { input, sources } = useMemo(() => {
    const sources = new Map<string, Source>()
    const items: Candidate[] = []
    const warlords: WarlordOption[] = []
    const add = (key: string, source: Source, cost: number) => {
      const a = assetOf(source)
      const st = a.stats
      const kind = kindOfCategory(st?.category)
      if (!st || !kind) return
      // Ascended NFTs need a Forge level; the solver weighs paying for it.
      const minLevel = Number(st.min_forge_level || 0)
      if (kind === 'warlord') {
        if (st.slots_max > 0) {
          sources.set(key, source)
          warlords.push({ key, slots: Number(st.slots_max), minLevel, cost })
        }
        return
      }
      if (!SOLVABLE.includes(kind)) return
      sources.set(key, source)
      items.push({
        key,
        kind: kind as Candidate['kind'],
        group: `${source.from}:${a.templateId}`,
        atk: Number(st.attack || 0),
        def: Number(st.defense || 0),
        move: Number(st.movecost || 0),
        moveReduction: Number(st.movecost_reduction || 0),
        ...(kind === 'lavalux'
          ? {
              atkMult: Number(st.attack_mult_bp || 10000) / 10000,
              defMult: Number(st.defense_mult_bp || 10000) / 10000,
              moveMult: Number(st.movecost_mult_bp || 10000) / 10000
            }
          : {}),
        minLevel,
        cost
      })
    }
    for (const l of snap.listings ?? [])
      if (l.seller !== account) add(`sale:${l.saleId}`, { from: 'market', listing: l }, l.price)
    if (useStaked && snap.army)
      for (const kind of Object.keys(snap.army.free) as Kind[])
        for (const a of snap.army.free[kind]) add(`own:${a.assetId}`, { from: 'reserve', asset: a }, 0)
    // NFTs inside divisions count as free too: the player takes them out (or disbands) to build
    // this one. Gear that moves over keeps the Forge slot it already has, so a bundle that reuses
    // it needs one slot fewer than counted; a small overstatement on the safe side.
    if (useDivisions && snap.army)
      for (const d of snap.army.divisions)
        for (const a of divisionPieces(d))
          add(`own:${a.assetId}`, { from: 'division', asset: a, division: d.id, locked: !!d.lock }, 0)
    if (useWallet) {
      for (const a of snap.wallet ?? []) add(`wal:${a.assetId}`, { from: 'wallet', asset: a }, 0)
    }
    // Blended NFTs: every recipe whose result goes into a division, a few copies each. Each copy is
    // priced by the materials it still needs (owned ones first), so later copies cost more.
    if (blendMarket && blends.data && statsMap.data && templatesJson.data) {
      for (const b of blends.data) {
        const r = resultOf(b)
        if (!b.active || !r || !statsMap.data.has(r)) continue
        const copies = Math.min(mintable(blendMarket, b), MAX_BLEND_COPIES)
        const reserved = new Map<string, number>()
        const pricing = phase === 'market' ? { ...blendMarket, owned: new Map<string, string[]>() } : blendMarket
        for (let k = 0; k < copies; k++) {
          const planned = planBlend(pricing, b, reserved).cost
          // A price corrected by the joint plan of an earlier solve wins over the stand-alone estimate.
          const cost = Math.max(planned, correctedPrices.get(`blend:${b.id}:${k}`) ?? 0)
          if (!Number.isFinite(cost)) break
          const key = `blend:${b.id}:${k}`
          const schema = blendMarket.templates.get(r)?.schema ?? ''
          add(
            key,
            {
              from: 'blend',
              blend: b,
              asset: makeAssetRef(key, { t: r, s: schema, c: 'planetdefnft' }, statsMap.data, templatesJson.data)
            },
            cost
          )
        }
      }
    }
    const input: SolveInput | null =
      (atk > 0 || def > 0) && snap.listings && snap.player && snap.army && snap.forge && snap.pools
        ? {
            atk,
            def,
            ...(maxMove ? { maxMove } : {}),
            warlords,
            items,
            economy: buildEconomy({
              forgeLevel,
              progress: snap.player.forgeProgress,
              levels: snap.forge.levels,
              shopItems: snap.forge.shopItems,
              powerups: snap.player.powerups,
              used: { weapon: snap.army.gearUsed.weapon, supply: snap.army.gearUsed.supply, lavalux: snap.army.gearUsed.lavalux },
              pools: snap.pools
            })
          }
        : null
    if (input) SOURCES_OF.set(input, sources)
    return { input, sources }
  }, [
    snap.listings,
    snap.army,
    snap.wallet,
    snap.player,
    snap.forge,
    snap.pools,
    blendMarket,
    blends.data,
    correctedPrices,
    phase,
    statsMap.data,
    templatesJson.data,
    useStaked,
    useDivisions,
    useWallet,
    atk,
    def,
    maxMove,
    account,
    forgeLevel
  ])

  const solver = useBundleSolver(locked || !scanning ? null : input)

  /*
   * Each recipe's copies are priced on their own, so two recipes can both count the same owned
   * material as free. After a solve, the chosen blends are planned together; any that turn out
   * dearer get their real price and the bundle is solved again, while that keeps helping.
   * A later round is not always cheaper in truth than an earlier one, so the cheapest is kept.
   */
  useEffect(() => {
    const b = solver.bundle
    // Only an answer to the current input can correct its prices. Refreshes rebuild an input of the
    // same content without solving again, so compare with the solver's own copy.
    const solved = solver.solvedFor
    if (!b || locked || !solved || solved !== solver.current) return
    const sources = SOURCES_OF.get(solved)
    if (!sources) return
    const st: Refinement = blendPrices.target === targetKey ? blendPrices : { ...FRESH_REFINEMENT, target: targetKey }
    let usesBlends = false
    const assumed = new Map(solved.items.map((i) => [i.key, i.cost]))
    const keys = [b.warlord.key, ...b.mercs.map((m) => m.key), ...GEAR_ORDER.flatMap((k) => b.gear[k].map((g) => g.key))]
    const reserved = new Map<string, number>()
    const prices = new Map(correctedPrices)
    let changed = false
    let total = b.slotCost + b.forgeCost
    for (const key of keys) {
      const s = sources.get(key)
      if (s?.from === 'market') total += s.listing.price
      if (s?.from !== 'blend' || !blendMarket) continue
      usesBlends = true
      const real = planBlend(blendMarket, s.blend, reserved).cost
      total += real
      // A blend that cannot be made any more gets a stand-in price far above anything real.
      const next = Number.isFinite(real) ? real : UNMAKEABLE
      if (next > (assumed.get(key) ?? 0) + 0.5) {
        prices.set(key, next)
        changed = true
      }
    }
    // Every blend the solver did not pick: what one more of it really costs on top of the chosen ones.
    // Those use up the cheap materials, so recipes needing the same ones get dearer too; without
    // this the next round would pick them at prices that no longer exist.
    if (blendMarket) {
      const chosen = new Set(keys)
      const byRecipe = new Map<number, { key: string; copy: number; blend: Blend }[]>()
      for (const it of solved.items) {
        if (chosen.has(it.key)) continue
        const s = sources.get(it.key)
        if (s?.from !== 'blend') continue
        const list = byRecipe.get(s.blend.id) ?? []
        list.push({ key: it.key, copy: Number(it.key.split(':')[2] ?? 0), blend: s.blend })
        byRecipe.set(s.blend.id, list)
      }
      for (const list of byRecipe.values()) {
        const after = new Map(reserved)
        for (const c of list.sort((x, y) => x.copy - y.copy)) {
          const real = planBlend(blendMarket, c.blend, after).cost
          const next = Number.isFinite(real) ? real : UNMAKEABLE
          if (next > (assumed.get(c.key) ?? 0) + 0.5) {
            prices.set(c.key, next)
            changed = true
          }
        }
      }
    }
    // Only a price that really moved starts another round: the same prices would mean the same
    // input, which the solver does not solve twice, and the search would wait forever.
    if (changed) changed = [...prices].some(([k, v]) => correctedPrices.get(k) !== v)
    const prevBest = best?.target === bestKey ? best : null
    const winner =
      prevBest && prevBest.total <= total
        ? prevBest
        : { target: bestKey, bundle: b, input: solved, total, prices: correctedPrices, phase: st.phase }
    if (winner !== prevBest) setBest(winner)
    if (st.done) return
    const step = st.step + 1
    // Both passes run until PATIENCE rounds in a row bring nothing cheaper (at most MAX_ROUNDS). The
    // second pass needs its rounds: it is what keeps owning more materials from raising the price.
    // After its first two rounds, the second pass has to beat the best overall, not just itself.
    const bar = st.phase === 'market' && st.rounds >= 2 ? Math.min(st.lastTotal, prevBest?.total ?? Infinity) : st.lastTotal
    const better = total < bar - 1
    const stale = better ? 0 : st.stale + 1
    if (changed && stale < PATIENCE && st.rounds < MAX_ROUNDS)
      setBlendPrices({ ...st, prices, rounds: st.rounds + 1, lastTotal: Math.min(st.lastTotal, total), stale, step })
    // The first pass is done. When it blended and you own materials, try the market-priced pass too.
    else if (st.phase === 'owned' && usesBlends && (blendMarket?.owned.size ?? 0) > 0)
      setBlendPrices({ ...st, prices: new Map(), rounds: 0, phase: 'market', lastTotal: Infinity, stale: 0, step })
    // Done: keep the winning round's corrections, so a market refresh rebuilds that answer (the
    // solver remembers recent answers, so this costs no extra search).
    else setBlendPrices({ ...st, step, done: true, prices: winner.prices, phase: winner.phase })
    // Only a new answer from the solver starts a round.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [solver.bundle, solver.solvedFor])
  const bestNow = best?.target === bestKey ? best : null
  const refinement = blendPrices.target === targetKey ? blendPrices : null
  // After the search, background refreshes still re-solve, but that is not shown as a search.
  const refining = !locked && scanning && !!input && !refinement?.done
  // Watchdog: the search is not done, yet nothing is being solved. A round that changed nothing the
  // solver sees would otherwise leave it waiting forever, so the search ends with the best found.
  useEffect(() => {
    if (!refining || solver.solving) return
    const timer = setTimeout(
      () => setBlendPrices((st) => (st.target === targetKey && !st.done ? { ...st, done: true } : st)),
      WATCHDOG_MS
    )
    return () => clearTimeout(timer)
  }, [refining, solver.solving, blendPrices, targetKey])
  const shownInput = bestNow?.input ?? solver.solvedFor
  const shown = locked?.bundle ?? bestNow?.bundle ?? solver.bundle
  const shownSources = locked?.sources ?? (shownInput ? SOURCES_OF.get(shownInput) : undefined) ?? sources

  if (!listings.data || !player.data || !army.data || !forge.data || !pools.data)
    return <Loading inline label="Reading the market" />

  const plan = shown ? summarize(shown, shownSources, player.data, pools.data, input?.economy ?? null, blendMarket) : null
  const affordable = !plan || player.data.wax >= plan.waxTotal

  /**
   * One transaction, in the order the contracts need it: buy the DEF and TLM the wallet is short of
   * on Alcor, raise the Forge, buy the slots, buy the NFTs and materials, run the blends, stake the
   * NFTs that arrived. Blended NFTs are minted a few seconds later and staked when building.
   */
  /**
   * The purchase as a list of small transactions, in the order the contracts need: Alcor swaps for
   * the DEF and TLM the wallet is short of, Forge levels and slots; then the NFTs and materials in
   * groups (each group checked, paid and bought together); then the blends; then staking. Each step
   * is signed on its own, and a stopped purchase can be resumed at the step that failed.
   */
  function purchaseSteps(): PurchaseStep[] {
    if (!shown || !plan) return []
    const b = shown
    const purchases = [...plan.toBuy, ...plan.materialBuys]
    const stakeIds = [...plan.toBuy.map((l) => l.assetId), ...plan.fromWallet.map((a) => a.assetId)]
    const tlmContract = forge.data?.tokens?.tlm_contract || 'alien.worlds'
    const steps: PurchaseStep[] = []
    const slots = (Object.keys(b.slotsBought) as SlotKind[]).flatMap((k) => b.slotsBought[k])
    if (plan.defShort > 0 || plan.tlmShort > 0 || plan.levelSteps.length || slots.length) {
      const defShort = plan.defShort
      const tlmShort = plan.tlmShort
      const levels = plan.levelSteps
      steps.push({
        label: [
          (defShort > 0 || tlmShort > 0) && 'swap on Alcor',
          levels.length && `Forge level ${b.level}`,
          slots.length && `${slots.length} Forge slot${slots.length === 1 ? '' : 's'}`
        ]
          .filter(Boolean)
          .join(', ')
          .replace(/^./, (c) => c.toUpperCase()),
        build: (a, p) => [
          ...(defShort > 0 ? [buyExactAction(a, p, pools.data!.def, 'DEF', defShort).action] : []),
          ...(tlmShort > 0 ? [buyExactAction(a, p, pools.data!.tlm, 'TLM', tlmShort).action] : []),
          ...levels.map((step) => payForgeLevel(a, p, step.level, step.quantity, tlmContract)),
          ...slots.map((o) => buyShopItem(a, p, o.itemId, o.price, o.priceContract))
        ]
      })
    }
    for (const group of chunk(purchases, SALES_PER_TX)) {
      const wax = group.reduce((n, l) => n + l.price, 0)
      steps.push({
        label: `Buy ${group.length} listing${group.length === 1 ? '' : 's'} (${formatNumber(wax, 2)} WAX)`,
        build: (a, p) =>
          buySalesActions(
            a,
            p,
            group.map((l) => ({ saleId: l.saleId, assetId: l.assetId, listingPrice: l.listingPrice }))
          )
      })
    }
    for (const group of chunk(plan.blendRuns, BLENDS_PER_TX))
      steps.push({
        label: `Blend ${group.length}`,
        build: (a, p) =>
          blendActions(
            a,
            p,
            group.map((r) => ({ blendId: r.blendId, assetIds: r.assetIds }))
          )
      })
    for (const group of chunk(stakeIds, STAKE_PER_TX))
      steps.push({ label: `Stake ${group.length}`, build: (a, p) => [stakeBoughtAction(a, p, group)] })
    return steps
  }

  async function buy() {
    if (!shown || !plan) return
    // What of the blended templates is already in the wallet, so the build step can spot the new ones.
    const blendedTemplates = new Set(plan.blendRuns.map((r) => r.templateId))
    const known = new Set((wallet.data ?? []).filter((a) => blendedTemplates.has(a.templateId)).map((a) => a.assetId))
    const steps = purchaseSteps()
    const start: Locked = { bundle: shown, sources: shownSources, phase: 'buying', known, steps, done: 0 }
    if (!steps.length) {
      setLocked({ ...start, phase: 'bought' })
      return
    }
    setLocked(start)
    await runSteps(start)
  }

  /** Signs the remaining purchase steps one by one; stops at the first that fails, so it can resume. */
  async function runSteps(from: Locked) {
    const steps = from.steps ?? []
    let cur: Locked = { ...from, failed: undefined }
    setLocked(cur)
    for (let i = cur.done ?? 0; i < steps.length; i++) {
      const ok = await run(steps[i].build, `Step ${i + 1} of ${steps.length} done: ${steps[i].label}`, 'buy', {
        split: true
      })
      if (!ok) {
        cur = { ...cur, done: i, failed: steps[i].label }
        setLocked(cur)
        return
      }
      cur = { ...cur, done: i + 1 }
      setLocked(cur)
    }
    setLocked({ ...cur, phase: 'bought', steps: undefined, failed: undefined })
    toast.success('Everything is bought. Build the division next.')
  }

  /**
   * Waits for the blended NFTs to be minted (the random oracle answers within seconds), stakes them
   * with the new division's warlord, then adds the mercenaries and their gear.
   */
  async function build() {
    if (!locked || !account) return
    const b = locked.bundle
    const keys = [b.warlord.key, ...b.mercs.map((m) => m.key), ...GEAR_ORDER.flatMap((k) => b.gear[k].map((g) => g.key))]
    const blended = keys.filter((k) => locked.sources.get(k)?.from === 'blend')
    const minted = new Map<string, string>()
    setLocked({ ...locked, phase: 'building' })

    if (blended.length) {
      toast.info(`Waiting for ${blended.length} blended NFT${blended.length === 1 ? '' : 's'} to be minted…`)
      for (let attempt = 0; attempt < 30 && minted.size < blended.length; attempt++) {
        const assets = await atomic.getOwnedAssets(account, 'planetdefnft').catch(() => [])
        const fresh = assets.filter(
          (a) => a.template && !locked.known.has(a.asset_id) && ![...minted.values()].includes(a.asset_id)
        )
        for (const key of blended) {
          if (minted.has(key)) continue
          const want = assetOf(locked.sources.get(key)!).templateId
          const hit = fresh.find((a) => a.template!.template_id === want && ![...minted.values()].includes(a.asset_id))
          if (hit) minted.set(key, hit.asset_id)
        }
        if (minted.size < blended.length) await new Promise((r) => setTimeout(r, 3000))
      }
      if (minted.size < blended.length) {
        toast.error('The blended NFTs have not arrived yet. Try Build again in a moment.')
        setLocked({ ...locked, phase: 'bought' })
        return
      }
    }
    const idOf = (key: string) => {
      const s = locked.sources.get(key)!
      return s.from === 'market' ? s.listing.assetId : s.from === 'blend' ? minted.get(key)! : s.asset.assetId
    }

    const leader = idOf(b.warlord.key)
    const created = await run(
      (a, p) => [...(minted.size ? [stakeBoughtAction(a, p, [...minted.values()])] : []), createDivision(a, p, leader)],
      'Division created, adding the troops…',
      'build',
      { split: true }
    )
    if (!created) {
      setLocked({ ...locked, phase: 'bought' })
      return
    }
    let divisionId: number | null = null
    for (let i = 0; i < 10 && divisionId === null; i++) {
      const fresh = await army.refetch()
      divisionId = fresh.data?.divisions.find((d) => String(d.row.leader_asset_id) === leader)?.id ?? null
      if (divisionId === null) await new Promise((r) => setTimeout(r, 1500))
    }
    if (divisionId === null) {
      toast.error('The new division has not shown up yet. Open the Army in a moment and use Auto-fill to finish.')
      setLocked({ ...locked, phase: 'bought' })
      return
    }
    const units = b.units
    const id = divisionId
    const equipped = await run(
      (a, p) => [
        ...units.map((u) => addUnit(a, p, id, idOf(u.merc.key))),
        ...units.flatMap((u) =>
          GEAR_ORDER.filter((k) => u.gear[k]).map((k) => assignGearAction(a, p, id, idOf(u.merc.key), k, idOf(u.gear[k]!.key)))
        )
      ],
      `Division #${id} is ready: ${formatNumber(b.atk, 0)} ATK / ${formatNumber(b.def, 0)} DEF`,
      'equip',
      { split: true }
    )
    setLocked({ ...locked, phase: equipped ? 'done' : 'bought' })
  }

  const stepper = (value: number, set: (v: string) => void, by: number) => (
    <span className="stepper">
      <button type="button" aria-label="Less" onClick={() => set(String(Math.max(0, value - by)))}>
        <MinusIcon width={14} height={14} />
      </button>
      <button type="button" aria-label="More" onClick={() => set(String(value + by))}>
        <PlusIcon width={14} height={14} />
      </button>
    </span>
  )

  return (
    <div className="page market">
      <section className="mk-top panel">
        <div className="mk-targets">
          <p className="eyebrow">Division builder</p>
          <h2>Cheapest division from the market</h2>
          <p className="muted">
            Set the attack and defense one division must reach. The cheapest mix of listed warlords, mercenaries and gear
            {useOwned ? ', plus the NFTs you already own,' : ''} is found when you scan.
          </p>
          <div className="mk-inputs">
            <label className="mk-field c-atk">
              <span>ATK</span>
              <input
                className="input num"
                inputMode="numeric"
                value={atkText}
                disabled={!!locked}
                onChange={(e) => setAtkText(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => e.key === 'Enter' && scan()}
              />
              {stepper(atk, setAtkText, 100)}
            </label>
            <label className="mk-field c-def">
              <span>DEF</span>
              <input
                className="input num"
                inputMode="numeric"
                value={defText}
                disabled={!!locked}
                onChange={(e) => setDefText(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => e.key === 'Enter' && scan()}
              />
              {stepper(def, setDefText, 100)}
            </label>
            <Tooltip text="Optional. The division's move cost may not go above this: every move point adds 10 s to each mission lock. Leave it empty for no limit.">
              <label className="mk-field c-mov">
                <span>Max move</span>
                <input
                  className="input num"
                  inputMode="numeric"
                  placeholder="any"
                  value={moveText}
                  disabled={!!locked}
                  onChange={(e) => setMoveText(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={(e) => e.key === 'Enter' && scan()}
                />
              </label>
            </Tooltip>
            <Tooltip text="NFTs already staked in the game but in no division (your reserve) count as free.">
              <button
                type="button"
                className={`cashout ${useStaked ? 'is-on' : ''}`}
                disabled={!!locked}
                onClick={() => setUseStaked((v) => !v)}
                aria-pressed={useStaked}
              >
                <span className="cashout__knob" /> Staked NFTs
              </button>
            </Tooltip>
            <Tooltip text="NFTs inside your divisions count as free as well: you take them out in Army (or disband the division) to build this one. Divisions out on a mission are included; those NFTs are yours again when the division returns.">
              <button
                type="button"
                className={`cashout ${useDivisions ? 'is-on' : ''}`}
                disabled={!!locked}
                onClick={() => setUseDivisions((v) => !v)}
                aria-pressed={useDivisions}
              >
                <span className="cashout__knob" /> In divisions
              </button>
            </Tooltip>
            <Tooltip text="Warlords, mercenaries and gear in your wallet count as free and are staked in the same transaction as the purchase.">
              <button
                type="button"
                className={`cashout ${useWallet ? 'is-on' : ''}`}
                disabled={!!locked}
                onClick={() => setUseWallet((v) => !v)}
                aria-pressed={useWallet}
              >
                <span className="cashout__knob" /> Wallet NFTs
              </button>
            </Tooltip>
            <Tooltip text="Blend materials in your wallet count as free when a bundle blends an NFT. Off: every material a blend needs is bought.">
              <button
                type="button"
                className={`cashout ${useMaterials ? 'is-on' : ''}`}
                disabled={!!locked}
                onClick={() => setUseMaterials((v) => !v)}
                aria-pressed={useMaterials}
              >
                <span className="cashout__knob" /> My materials
              </button>
            </Tooltip>
            <Button
              color="gradientYellow"
              className="mk-scan"
              disabled={!!locked || (atk === 0 && def === 0) || !input || refining}
              isLoading={refining}
              onClick={scan}
            >
              {scanning ? 'Scan again' : 'Scan the market'}
            </Button>
          </div>
          {presets.length > 0 && (
            <div className="mk-presets">
              <span className="faint">Mission targets:</span>
              {presets.map((p) => (
                <button
                  key={`${p.atk}/${p.def}`}
                  type="button"
                  className={`planets__chip ${p.atk === atk && p.def === def ? 'is-on' : ''}`}
                  disabled={!!locked}
                  title={p.title}
                  onClick={() => {
                    setAtkText(String(p.atk))
                    setDefText(String(p.def))
                    scanWith(p.atk, p.def)
                  }}
                >
                  <PlanetIcon planet={p.planet} size={14} /> {p.atk ? formatNumber(p.atk, 0) : '–'} /{' '}
                  {p.def ? formatNumber(p.def, 0) : '–'}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="mk-summary">
          {locked ? (
            locked.phase === 'buying' ? (
              <PurchaseProgress
                locked={locked}
                pending={pending}
                onResume={() => void runSteps(locked)}
                onRescan={() => {
                  setLocked(null)
                  scan()
                }}
              />
            ) : (
              <BuildSteps locked={locked} pending={pending} onBuild={build} onReset={() => setLocked(null)} />
            )
          ) : atk === 0 && def === 0 ? (
            <p className="muted">Set a target above 0.</p>
          ) : !scanning ? (
            <div className="mk-idle">
              <strong>{scanKey ? 'The targets changed' : 'Ready when you are'}</strong>
              <span className="muted">
                {scanKey
                  ? 'Scan again to price a division for these values.'
                  : 'Enter the attack and defense you need, pick what of yours may be used, then scan the market.'}
              </span>
              <Button color="gradientYellow" disabled={!input} onClick={scan}>
                {input
                  ? `Scan for ${formatNumber(atk, 0)} ATK${def ? ` / ${formatNumber(def, 0)} DEF` : ''}`
                  : 'Reading the market…'}
              </Button>
            </div>
          ) : !input ? (
            <p className="muted">Reading the market…</p>
          ) : solver.solving && !plan ? (
            <div className="mk-solving">
              <p>
                <span className="spinner" /> Searching {listings.data.length} listings…
              </p>
              <RefineProgress
                refinement={refinement}
                solving={solver.solving}
                lastMs={solver.ms}
                twoPasses={!!blendMarket && blendMarket.owned.size > 0 && useMaterials}
              />
            </div>
          ) : !plan ? (
            <div className="mk-none">
              <strong>No division can reach this</strong>
              <span className="muted">
                The market{useOwned ? ' and your NFTs' : ''} do not hold enough attack and defense
                {maxMove ? ` within ${maxMove} move` : ''} for one warlord's slots right now.
              </span>
            </div>
          ) : (
            <>
              <div className="mk-price">
                <TokenIcon symbol="WAX" size={22} />
                <b className="num">{formatNumber(plan.total, 2)}</b>
                <span className="faint">{refining ? 'WAX, best so far' : 'WAX total'}</span>
                {solver.solving && <span className="spinner" title="Updating" />}
              </div>
              {snapshot && (
                <small className="faint mk-snapshot">
                  Market as of {new Date(snapshot.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Scan again
                  for the latest prices.
                </small>
              )}
              {refining && (
                <RefineProgress
                  refinement={refinement}
                  solving={solver.solving}
                  lastMs={solver.ms}
                  twoPasses={!!blendMarket && blendMarket.owned.size > 0 && useMaterials}
                />
              )}
              <ul className="mk-breakdown">
                <li>
                  <span>
                    NFTs{' '}
                    <small className="faint">
                      ({plan.toBuy.length} to buy, {plan.owned} yours)
                    </small>
                  </span>
                  <b className="num">{formatNumber(plan.nftWax, 2)}</b>
                </li>
                {plan.blendRuns.length > 0 && (
                  <li>
                    <Tooltip text="NFTs made by blending instead of bought: the materials you own are used first, the rest are bought from the market and burned in the recipe in the same transaction. The result is minted a few seconds later.">
                      <span>
                        Blends{' '}
                        <small className="faint">
                          ({plan.blendRuns.length} to make, {plan.materialBuys.length} materials to buy)
                        </small>
                      </span>
                    </Tooltip>
                    <b className="num">{formatNumber(plan.blendWax, 2)}</b>
                  </li>
                )}
                {!plan.blendsFeasible && (
                  <li className="c-red">
                    <span>Two recipes need the same scarce material: one of them cannot be made right now.</span>
                  </li>
                )}
                {plan.slotCount > 0 && (
                  <li>
                    <Tooltip text="Every equipment, supply and Lava Lux piece needs a Forge slot of its kind. These are the next slots in the shop, paid in DEF; the DEF is priced at what buying it with WAX on Alcor costs.">
                      <span>
                        Forge slots{' '}
                        <small className="faint">
                          ({slotSummary(shown!)} · {formatToken(plan.defNeed)} DEF)
                        </small>
                      </span>
                    </Tooltip>
                    <b className="num">{formatNumber(shown!.slotCost, 2)}</b>
                  </li>
                )}
                {shown!.level > forgeLevel && (
                  <li>
                    <Tooltip text="The slots or NFTs in this bundle need a higher Forge level. Levels are paid in TLM, priced at what buying it with WAX on Alcor costs.">
                      <span>
                        <FlameIcon width={12} height={12} /> Forge {forgeLevel} → {shown!.level}{' '}
                        <small className="faint">({formatToken(plan.tlmNeed)} TLM)</small>
                      </span>
                    </Tooltip>
                    <b className="num">{formatNumber(shown!.forgeCost, 2)}</b>
                  </li>
                )}
                {(plan.defNeed > 0 || plan.tlmNeed > 0 || plan.blendRuns.length > 0) && (
                  <li className="mk-breakdown__pay">
                    <Tooltip
                      text={`DEF and TLM you already hold are used first${plan.defShort || plan.tlmShort ? `; the rest (${[plan.defShort && `${formatToken(plan.defShort)} DEF`, plan.tlmShort && `${formatToken(plan.tlmShort)} TLM`].filter(Boolean).join(', ')}) is bought with WAX on Alcor in the same transaction, with 2% slippage room` : ''}.`}
                    >
                      <span>WAX from your wallet</span>
                    </Tooltip>
                    <b className="num">{formatNumber(plan.waxTotal, 2)}</b>
                  </li>
                )}
              </ul>
              <div className="mk-reached">
                <StatTrio atk={shown!.atk} def={shown!.def} move={plan.move} />
                <span className="faint num">
                  <TimerIcon width={12} height={12} /> +{formatDuration(plan.move * 10)} per mission
                </span>
              </div>
              <Figure label="Your WAX" value={formatNumber(player.data.wax, 0)} tone={affordable ? '' : 'c-red'} />
              <Button
                size="lg"
                color="gradientYellow"
                block
                disabled={!affordable || spectating}
                isLoading={pending === 'buy'}
                onClick={
                  plan.toBuy.length || plan.blendRuns.length || plan.fromWallet.length || plan.slotCount || plan.levelSteps.length
                    ? buy
                    : () => setLocked({ bundle: shown!, sources: shownSources, phase: 'bought', known: new Set() })
                }
              >
                <CartIcon /> {buyLabel(plan)}
              </Button>
              {!affordable && (
                <small className="c-red">You need {formatNumber(plan.waxTotal - player.data.wax, 2)} more WAX.</small>
              )}
              {plan.fromDivisions.length > 0 && (
                <small className="c-yellow">
                  {plan.fromDivisions.length === 1 ? 'One of these NFTs is' : plan.fromDivisions.length + ' of these NFTs are'} in
                  your divisions ({[...new Set(plan.fromDivisions.map((s) => s.division))].map((id) => `#${id}`).join(', ')}):
                  take them out in Army before building this one.
                  {plan.fromDivisions.some((s) => s.locked) &&
                    (plan.fromDivisions.length === 1
                      ? ' It is out on a mission until it returns.'
                      : ' Some are out on a mission until it returns.')}
                </small>
              )}
              <small className="faint">
                Signed in small steps: swaps, Forge and slots first, then the listings {SALES_PER_TX} at a time (each group
                checked, paid and bought together), then blends and staking. A step that fails costs nothing and can be resumed.
              </small>
            </>
          )}
        </div>
      </section>

      {plan && shown && (
        <RoiPanel
          atk={shown.atk}
          def={shown.def}
          move={plan.move}
          invest={plan.waxTotal}
          missions={missionList}
          tlmDef={tlmDef}
          pools={pools.data}
        />
      )}

      {plan && shown && (
        <section className="mk-bundle">
          <div className="section-head">
            <div>
              <h2>The bundle</h2>
              <p>
                {shown.mercs.length} mercenar{shown.mercs.length === 1 ? 'y' : 'ies'} under a {shown.warlord.slots}-slot warlord
                {plan.gearCount ? `, ${plan.gearCount} piece${plan.gearCount === 1 ? '' : 's'} of gear` : ''}. Supplies go to the
                highest move costs.
                {solver.ms !== null && !locked && <span className="faint"> Solved in {formatNumber(solver.ms, 0)} ms.</span>}
              </p>
            </div>
          </div>
          <div className="mk-grid">
            <BundleCard source={shownSources.get(shown.warlord.key)!} role={`Warlord · ${shown.warlord.slots} slots`} />
            {plan.units.map((u) => (
              <article
                key={u.merc.key}
                className="mk-unit"
                style={{ '--rarity': rarityColor(assetOf(shownSources.get(u.merc.key)!).rarity) } as CSSProperties}
              >
                <BundleCard source={shownSources.get(u.merc.key)!} role="Mercenary" />
                {GEAR_ORDER.filter((k) => u.gear[k]).map((k) => (
                  <BundleCard key={k} source={shownSources.get(u.gear[k]!.key)!} role={KIND_LABEL[k]} small />
                ))}
                {GEAR_ORDER.some((k) => u.gear[k]) && (
                  <span className="mk-unit__total num">
                    With gear <StatTrio atk={u.atk} def={u.def} move={u.move} size="sm" />
                  </span>
                )}
              </article>
            ))}
          </div>
          <p className="faint mk-note">
            Every mercenary can carry equipment, a supply, a creature and a Lava Lux pass. Equipment, supplies and Lava Lux need
            Forge slots: you have {input?.economy.slots.weapon.free ?? 0} equipment, {input?.economy.slots.supply.free ?? 0}{' '}
            supply and {input?.economy.slots.lavalux.free ?? 0} Lava Lux slots free; more are bought when that is the cheaper way.
            Lava Lux multiplies a mercenary's whole line (and its move cost), so it goes on the strongest ones.
          </p>
        </section>
      )}

      <ListingBrowser listings={listings.data} kind={browse} onKind={setBrowse} forgeLevel={forgeLevel} />
    </div>
  )
}

/** Totals and lists the page needs from a bundle. */
/**
 * What carrying out a bundle takes from the wallet. The bundle's own cost values DEF and TLM you
 * already hold at market price; here only what you are short of is bought, so the WAX actually
 * spent can be lower.
 */
function summarize(
  b: Bundle,
  sources: Map<string, Source>,
  player: PlayerData,
  pools: SwapPools,
  economy: SolveInput['economy'] | null,
  blendMarket: BlendMarket | null
) {
  const keys = [b.warlord.key, ...b.mercs.map((m) => m.key), ...GEAR_ORDER.flatMap((k) => b.gear[k].map((g) => g.key))]
  const src = keys.map((k) => sources.get(k)!).filter(Boolean)
  const toBuy = src.flatMap((s) => (s.from === 'market' ? [s.listing] : []))
  const fromWallet = src.flatMap((s) => (s.from === 'wallet' ? [s.asset] : []))
  const fromDivisions = src.flatMap((s) => (s.from === 'division' ? [s] : []))
  // The chosen blends, planned together so two recipes never count the same material twice.
  const blendRuns: (BlendRun & { key: string; templateId: string; cost: number })[] = []
  const materialBuys: Listing[] = []
  let blendWax = 0
  let blendsFeasible = true
  if (blendMarket) {
    const reserved = new Map<string, number>()
    for (const key of keys) {
      const s = sources.get(key)
      if (s?.from !== 'blend') continue
      const p = planBlend(blendMarket, s.blend, reserved)
      if (!Number.isFinite(p.cost)) {
        blendsFeasible = false
        continue
      }
      blendRuns.push({ blendId: s.blend.id, assetIds: p.assets, key, templateId: s.asset.templateId, cost: p.cost })
      materialBuys.push(...p.buy)
      blendWax += p.cost
    }
  }
  const slots = Object.values(b.slotsBought).flat()
  const defNeed = slots.reduce((n, o) => n + o.def, 0)
  const tlmNeed = economy?.levelTlm[b.level] ?? 0
  const defShort = Math.max(0, defNeed - player.def)
  const tlmShort = Math.max(0, tlmNeed - player.tlm)
  const swapWax = (defShort ? waxFor(pools.def, 'DEF', defShort) : 0) + (tlmShort ? waxFor(pools.tlm, 'TLM', tlmShort) : 0)
  const levelSteps: { level: number; quantity: string }[] = []
  for (let L = (economy?.forgeLevel ?? b.level) + 1; L <= b.level; L++) {
    const tlm = (economy!.levelTlm[L] ?? 0) - (economy!.levelTlm[L - 1] ?? 0)
    if (tlm > 0) levelSteps.push({ level: L, quantity: `${tlm.toFixed(4)} TLM` })
  }
  return {
    units: b.units,
    move: b.move,
    toBuy,
    fromWallet,
    fromDivisions,
    owned: src.length - toBuy.length - blendRuns.length,
    blendRuns,
    materialBuys,
    blendWax,
    blendsFeasible,
    nftWax: toBuy.reduce((n, l) => n + l.price, 0),
    slotCount: slots.length,
    defNeed,
    tlmNeed,
    defShort,
    tlmShort,
    levelSteps,
    // Swaps get the same slippage room the transaction gives them.
    waxTotal: toBuy.reduce((n, l) => n + l.price, 0) + blendWax + swapWax * 1.02,
    // What the bundle really costs: NFTs, blends as planned together, slots and Forge levels.
    total: toBuy.reduce((n, l) => n + l.price, 0) + blendWax + b.slotCost + b.forgeCost,
    gearCount: GEAR_ORDER.reduce((n, k) => n + b.gear[k].length, 0),
    needsBuild: true
  }
}

/** Says what the button will do: buy, blend, slots, or only stake. */
function buyLabel(plan: ReturnType<typeof summarize>): string {
  const n = (count: number, word: string) => count + ' ' + word + (count === 1 ? '' : 's')
  const parts: string[] = []
  if (plan.toBuy.length) parts.push('Buy ' + n(plan.toBuy.length, 'NFT'))
  if (plan.materialBuys.length) parts.push(n(plan.materialBuys.length, 'material'))
  if (plan.blendRuns.length) parts.push('blend ' + plan.blendRuns.length)
  if (plan.slotCount) parts.push(n(plan.slotCount, 'slot'))
  if (parts.length) return parts.join(', ') + ' & stake'
  if (plan.levelSteps.length) return 'Upgrade the Forge & stake'
  if (plan.fromWallet.length) return 'Stake ' + plan.fromWallet.length + ' from wallet'
  return 'Use what I own'
}

// ---- Payback ----------------------------------------------------------------------------------------

interface Payback {
  e: MissionEconomics
  perHour: number
  waxPerDay: number
  days: number
  cycle: number
}

/**
 * How fast the division pays for itself on each mission it qualifies for: net TLM per hour after the
 * DEF/TLM swaps its loop needs, sold for WAX on Alcor, against the WAX this bundle takes from the
 * wallet. Assumes today's rewards and prices hold and the division is always redeployed on time.
 */
function RoiPanel({
  atk,
  def,
  move,
  invest,
  missions,
  tlmDef,
  pools
}: {
  atk: number
  def: number
  move: number
  invest: number
  missions: MissionEconomics[]
  tlmDef: TlmDefMarket
  pools: SwapPools
}) {
  const rows: Payback[] = missions
    .filter((e) => e.state === 'active' && isTokenLoop(e) && atk >= e.minAtk && def >= e.minDef)
    .map((e) => {
      const perHour = tlmPerHour(e, move, tlmDef)
      // A day's TLM sold at once, so the price impact of that size is included.
      const waxPerDay = perHour > 0 ? receiveFor(pools.tlm, 'TLM', perHour * 24) : 0
      return { e, perHour, waxPerDay, days: waxPerDay > 0 ? invest / waxPerDay : Infinity, cycle: cycleSeconds(e, move) }
    })
    .sort((a, b) => a.days - b.days)
  const best = rows.find((r) => Number.isFinite(r.days))

  return (
    <section className="mk-roi panel panel--tight">
      <div className="mk-roi__head">
        <p className="eyebrow">Return on investment</p>
        {invest <= 0.01 ? (
          <h3>Nothing to pay back: everything in this bundle is already yours.</h3>
        ) : best ? (
          <h3>
            Pays back in{' '}
            <span className="c-tlm num">
              {best.days < 1 ? `${formatNumber(best.days * 24, 1)} hours` : `${formatNumber(best.days, 1)} days`}
            </span>{' '}
            on {best.e.title}
          </h3>
        ) : (
          <h3>No profitable TLM mission for this division yet</h3>
        )}
        {best && invest > 0.01 && (
          <p className="muted">
            Best way: deploy it on <b>{best.e.title}</b> ({titleCase(best.e.planet || '')}) and claim &amp; redeploy every{' '}
            {formatDuration(best.cycle)} from the Deployments page. It nets {formatNumber(best.perHour, 1)} TLM per hour after the
            entry fee{best.e.costDef || best.e.rewardDef ? ' and the DEF swaps its loop needs' : ''}, about{' '}
            {formatNumber(best.waxPerDay, 0)} WAX a day when swapped to WAX. The {formatNumber(invest, 0)} WAX invested counts
            only what leaves your wallet; the NFTs keep their resale value.
          </p>
        )}
      </div>
      {rows.length > 0 && invest > 0.01 && (
        <div className="mk-roi__rows">
          {rows.slice(0, 5).map((r) => (
            <div key={r.e.id} className={`mk-roi__row ${r === best ? 'is-best' : ''}`}>
              <span className="mk-roi__name">
                <PlanetIcon planet={r.e.planet} size={14} /> {r.e.title}
              </span>
              <span className="num faint">
                <TimerIcon width={11} height={11} /> {formatDuration(r.cycle)}
              </span>
              <span className={`num ${r.perHour > 0 ? 'c-tlm' : 'c-red'}`}>
                {r.perHour > 0 ? '+' : ''}
                {formatNumber(r.perHour, 1)} TLM/h
              </span>
              <span className="num">{formatNumber(r.waxPerDay, 0)} WAX/day</span>
              <b className="num">{Number.isFinite(r.days) ? `${formatNumber(r.days, 1)} d` : 'never'}</b>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/** "3 equipment · 1 Lava Lux" */
const slotSummary = (b: Bundle) =>
  (Object.keys(b.slotsBought) as SlotKind[])
    .filter((k) => b.slotsBought[k].length)
    .map((k) => `${b.slotsBought[k].length} ${SLOT_LABEL[k]}`)
    .join(' · ')

function BundleCard({ source, role, small = false }: { source: Source; role: string; small?: boolean }) {
  const a = assetOf(source)
  const st = a.stats
  return (
    <div className={`mk-card ${small ? 'mk-card--small' : ''}`}>
      <CardArt asset={a} shape="square" className="mk-card__art" />
      <div className="mk-card__body">
        <span className="mk-card__role faint">{role}</span>
        <b className="mk-card__name" title={a.name}>
          {a.name}
        </b>
        {st && !small && st.category !== 0 && <StatTrio atk={st.attack} def={st.defense} move={st.movecost} size="sm" />}
        {st && small && (
          <span className="mk-card__gain num">
            <span className="c-atk">+{st.attack}</span> <span className="c-def">+{st.defense}</span>
            {st.movecost_reduction > 0 && <span className="c-mov"> −{st.movecost_reduction} move</span>}
          </span>
        )}
      </div>
      <span className={`mk-card__price ${source.from === 'market' ? '' : 'is-owned'}`}>
        {source.from === 'market' ? (
          <>
            <b className="num">{formatNumber(source.listing.price, 2)}</b> <span className="faint">WAX</span>
          </>
        ) : source.from === 'wallet' ? (
          'in wallet'
        ) : source.from === 'blend' ? (
          <span className="mk-card__blend">blend</span>
        ) : source.from === 'division' ? (
          `in #${source.division}${source.locked ? ' (on mission)' : ''}`
        ) : (
          'reserve'
        )}
      </span>
    </div>
  )
}

/** A purchase in progress: every step, which are signed, and a way on when one fails. */
function PurchaseProgress({
  locked,
  pending,
  onResume,
  onRescan
}: {
  locked: Locked
  pending: string | null
  onResume: () => void
  onRescan: () => void
}) {
  const steps = locked.steps ?? []
  const done = locked.done ?? 0
  const busy = pending === 'buy'
  return (
    <div className="mk-steps">
      <p className="mk-steps__head">
        <b>
          Buying: {done} of {steps.length} transactions signed
        </b>
        <span className="faint">Each one is complete on its own, so nothing is left half done between them.</span>
      </p>
      <ol className="mk-steps__list">
        {steps.map((st, i) => (
          <li key={i} className={i < done ? 'is-done' : i === done ? (locked.failed ? 'is-failed' : 'is-now') : ''}>
            {i < done ? <CheckIcon width={14} height={14} /> : <span className="mk-steps__dot" />} {st.label}
          </li>
        ))}
      </ol>
      {locked.failed && !busy && (
        <>
          <p className="c-red mk-steps__note">
            Step {done + 1} did not go through. Steps 1 to {done} are done and stay done.
          </p>
          <Button size="lg" color="gradientYellow" block onClick={onResume}>
            Resume at step {done + 1}
          </Button>
          <small className="faint">
            If a listing was sold or changed its price in the meantime, resuming fails again: scan again instead. What you already
            bought now counts as yours.
          </small>
          <button type="button" className="mk-link" onClick={onRescan}>
            Scan again with what I have now
          </button>
        </>
      )}
    </div>
  )
}

function BuildSteps({
  locked,
  pending,
  onBuild,
  onReset
}: {
  locked: Locked
  pending: string | null
  onBuild: () => void
  onReset: () => void
}) {
  const busy = pending === 'build' || pending === 'equip' || locked.phase === 'building'
  return (
    <div className="mk-steps">
      <ol>
        <li className="is-done">
          <CheckIcon width={14} height={14} /> NFTs bought and staked
        </li>
        <li className={locked.phase === 'done' ? 'is-done' : 'is-now'}>
          {locked.phase === 'done' ? <CheckIcon width={14} height={14} /> : <span className="mk-steps__dot" />} Division created
          and equipped
        </li>
      </ol>
      {locked.phase === 'done' ? (
        <>
          <Link to="/missions" className="btn btn--gradientYellow btn--lg btn--block">
            <span className="btn__label">
              <RocketIcon /> Send it on a mission
            </span>
          </Link>
          <button type="button" className="mk-link" onClick={onReset}>
            Build another
          </button>
        </>
      ) : (
        <>
          <Button size="lg" color="gradientGreen" block isLoading={busy} onClick={onBuild}>
            Build the division
          </Button>
          <small className="faint">Two signatures: create the division, then add the mercenaries and their gear.</small>
          <button type="button" className="mk-link" onClick={onReset} disabled={busy}>
            Keep them in the reserve instead
          </button>
        </>
      )}
    </div>
  )
}

// ---- All listings -----------------------------------------------------------------------------------

const BROWSE: (Kind | 'all')[] = ['mercenary', 'weapon', 'supply', 'creature', 'lavalux', 'warlord', 'all']

function ListingBrowser({
  listings,
  kind,
  onKind,
  forgeLevel
}: {
  listings: Listing[]
  kind: Kind | 'all'
  onKind: (k: Kind | 'all') => void
  forgeLevel: number
}) {
  const rows = useMemo(() => {
    const list = listings.filter((l): l is Listing & { kind: Kind } => l.kind !== null && (kind === 'all' || l.kind === kind))
    const value = (l: Listing) => {
      const st = l.asset.stats
      const pts = (st?.attack ?? 0) + (st?.defense ?? 0)
      return pts > 0 ? l.price / pts : Infinity
    }
    return kind === 'warlord' || kind === 'lavalux' ? list : [...list].sort((a, b) => value(a) - value(b))
  }, [listings, kind])
  const [limit, setLimit] = useState(30)

  return (
    <section className="mk-list">
      <div className="section-head">
        <div>
          <h2>All listings</h2>
          <p>{listings.length} WAX listings of game NFTs. Sorted by price per stat point, best value first.</p>
        </div>
        <div className="segmented">
          {BROWSE.map((k) => (
            <button key={k} type="button" className={kind === k ? 'is-active' : ''} onClick={() => onKind(k)}>
              {k === 'all' ? 'All' : KIND_LABEL[k]}
            </button>
          ))}
        </div>
      </div>
      <div className="mk-rows">
        {rows.slice(0, limit).map((l) => {
          const st = l.asset.stats
          const pts = (st?.attack ?? 0) + (st?.defense ?? 0)
          const locked = Number(st?.min_forge_level ?? 0) > forgeLevel
          return (
            <a
              key={l.saleId}
              className={`mk-row ${locked ? 'is-locked' : ''}`}
              href={`https://wax.atomichub.io/market/sale/wax-mainnet/${l.saleId}`}
              target="_blank"
              rel="noreferrer"
              title="Open on AtomicHub"
            >
              <CardArt asset={l.asset} shape="square" className="mk-row__art" />
              <span className="mk-row__name">
                <b>{l.asset.name}</b>
                <small style={{ color: rarityColor(l.asset.rarity) }}>
                  {titleCase(l.asset.rarity || '')} {KIND_LABEL[l.kind].toLowerCase()}
                  {l.asset.info?.stars ? ` ${'★'.repeat(l.asset.info.stars)}` : ''}
                  {locked ? ` · needs forge Lv ${st?.min_forge_level}` : ''}
                </small>
              </span>
              <span className="mk-row__stats">
                {l.kind === 'warlord' ? (
                  <span className="num">{st?.slots_max} slots</span>
                ) : l.kind === 'lavalux' ? (
                  <span className="num faint">×{(st?.attack_mult_bp ?? 0) / 10000} ATK/DEF</span>
                ) : (
                  st && (
                    <StatTrio
                      atk={st.attack}
                      def={st.defense}
                      move={l.kind === 'supply' ? -st.movecost_reduction : st.movecost}
                      size="sm"
                    />
                  )
                )}
              </span>
              <span className="mk-row__price num">
                <b>{formatNumber(l.price, 2)}</b> <span className="faint">WAX</span>
                {pts > 0 && <small className="faint">{formatNumber(l.price / pts, 2)} / point</small>}
              </span>
            </a>
          )
        })}
        {rows.length === 0 && <div className="empty">Nothing of this kind is listed right now.</div>}
      </div>
      {rows.length > limit && (
        <button type="button" className="mk-link mk-more" onClick={() => setLimit((n) => n + 30)}>
          Show more ({rows.length - limit} left)
        </button>
      )}
    </section>
  )
}

// ---- Search progress --------------------------------------------------------------------------------

/**
 * How far the search for the cheapest bundle has come: which pass, which step, and roughly how long
 * is left, estimated from how long the last solve took and how many more steps usually follow.
 */
function RefineProgress({
  refinement,
  solving,
  lastMs,
  twoPasses
}: {
  refinement: Refinement | null
  solving: boolean
  lastMs: number | null
  twoPasses: boolean
}) {
  const step = refinement?.step ?? 0
  const phase = refinement?.phase ?? 'owned'
  const rounds = refinement?.rounds ?? 0
  // Typical: two or three rounds in the first pass, one or two in the second.
  const remaining = phase === 'owned' ? Math.max(1, 2 - rounds) + (twoPasses ? 2 : 0) : Math.max(1, 2 - rounds)
  const fraction = Math.min(0.95, (step + (solving ? 0.5 : 0)) / (step + 1 + remaining))
  const eta = lastMs !== null ? (lastMs * (remaining + 0.5)) / 1000 : null
  const passes = twoPasses ? 2 : 1
  const passLabel = phase === 'owned' ? `Pass 1 of ${passes}: your materials first` : 'Pass 2 of 2: every blend at market prices'

  return (
    <div className="mk-refine" role="status">
      <div className="mk-refine__text">
        <b>{passLabel}</b>
        <span className="faint num">
          Step {step + 1}
          {lastMs !== null && ` · about ${formatNumber(lastMs / 1000, lastMs < 10_000 ? 1 : 0)} s each`}
          {eta !== null && ` · about ${eta < 60 ? `${Math.max(1, Math.round(eta))} s` : `${Math.round(eta / 60)} min`} left`}
        </span>
      </div>
      <div className="mk-refine__bar">
        <span className="mk-refine__fill" style={{ width: `${Math.round(fraction * 100)}%` }} />
      </div>
      <small className="faint">
        Each step re-prices the blends that share materials and searches again. The price above is the best found so far and only
        goes down.
      </small>
    </div>
  )
}
