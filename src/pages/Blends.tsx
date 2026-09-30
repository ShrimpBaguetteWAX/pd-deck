import { useEffect, useMemo, useState, type CSSProperties } from 'react'

import { blendActions, type BlendRun } from '@/chain/actions/blend'
import { atomic, type AtomicAsset } from '@/chain/atomic'
import { buySalesActions } from '@/chain/actions/market'
import { IpfsImg, rarityColor } from '@/components/Art'
import { Button } from '@/components/Button'
import { Loading } from '@/components/Loading'
import { Figure, StatTrio } from '@/components/Stat'
import { Tooltip } from '@/components/Tooltip'
import {
  QUANTUM_CHEST,
  QUANTUM_KEY,
  useBlends,
  useCollectionTemplates,
  useOwnedBlendInputs,
  useTemplatePrices,
  type Blend,
  type Ingredient
} from '@/data/blends'
import { useAssetStats } from '@/data/game'
import { queryClient } from '@/data/queryClient'
import { useListings } from '@/data/market'
import { MinusIcon, PlusIcon, SparkIcon, XIcon } from '@/icons'
import {
  floorOf,
  ingredientValue,
  marketFrom,
  materialValues,
  mintable,
  openingValue,
  planBlend,
  resultOf,
  SALE_KEEP,
  valueOf,
  type Market,
  type MaterialValue,
  type Opening
} from '@/lib/blendEconomy'
import { formatNumber, percent, titleCase } from '@/lib/format'
import { useTransaction } from '@/wallet/useTransaction'

import './Blends.css'

type Tab = 'recipes' | 'materials' | 'chests'

const CATEGORY_ORDER = ['warlord', 'mercenary', 'equipment', 'supplies', 'creature', 'services', 'material']
const CATEGORY_LABEL: Record<string, string> = {
  warlord: 'Warlords',
  mercenary: 'Mercenaries',
  equipment: 'Equipment',
  supplies: 'Supplies',
  creature: 'Creatures',
  services: 'Lava Lux',
  material: 'Materials'
}

const SINGULAR: Record<string, string> = {
  warlord: 'warlord',
  mercenary: 'mercenary',
  equipment: 'equipment',
  supplies: 'supply',
  creature: 'creature',
  services: 'Lava Lux',
  material: 'material'
}

const wax = (n: number | null | undefined, digits = 2) => (n == null || !Number.isFinite(n) ? '–' : formatNumber(n, digits))

export default function Blends() {
  const { account, run, pending, spectating } = useTransaction()
  const blends = useBlends()
  const templates = useCollectionTemplates()
  const listings = useListings()
  const owned = useOwnedBlendInputs(account)
  const prices = useTemplatePrices()
  const stats = useAssetStats()
  const [tab, setTab] = useState<Tab>('recipes')
  const reveal = useReveal(account, run)

  const market = useMemo(
    () =>
      listings.data && templates.data && prices.data
        ? marketFrom(listings.data, owned.data ?? new Map(), templates.data, account, prices.data)
        : null,
    [listings.data, templates.data, owned.data, account, prices.data]
  )
  const values = useMemo(() => (market && blends.data ? materialValues(market, blends.data) : null), [market, blends.data])

  if (!market || !blends.data || !values) return <Loading inline label="Reading the recipes" />

  const byTemplate = new Map(values.materials.map((m) => [m.templateId, m]))

  return (
    <div className="page blends">
      <header className="bl-top panel panel--tight">
        <div>
          <p className="eyebrow">Blend Sphere</p>
          <h2>Blending</h2>
          <p className="muted">
            {blends.data.filter((b) => b.active).length} recipes on NeftyBlocks. Prices are AtomicMarket floors in WAX; what you
            own is used first and counted as free.
          </p>
        </div>
        <div className="segmented">
          {(
            [
              ['recipes', 'Recipes'],
              ['materials', 'Materials'],
              ['chests', 'Chests & keys']
            ] as [Tab, string][]
          ).map(([k, label]) => (
            <button key={k} type="button" className={tab === k ? 'is-active' : ''} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>
      </header>

      {tab === 'recipes' && (
        <Recipes
          blends={blends.data}
          market={market}
          byTemplate={byTemplate}
          stats={stats.data}
          run={run}
          pending={pending}
          spectating={spectating}
        />
      )}
      {tab === 'materials' && <Materials materials={values.materials} />}
      {tab === 'chests' && (
        <Chests
          openings={values.openings}
          market={market}
          byTemplate={byTemplate}
          reveal={reveal}
          run={run}
          pending={pending}
          spectating={spectating}
        />
      )}
    </div>
  )
}

type Run = ReturnType<typeof useTransaction>['run']

// ---- Recipes ----------------------------------------------------------------------------------------

function Recipes({
  blends,
  market,
  byTemplate,
  stats,
  run,
  pending,
  spectating
}: {
  blends: Blend[]
  market: Market
  byTemplate: Map<string, MaterialValue>
  stats: Map<string, { attack: number; defense: number; movecost: number }> | undefined
  run: Run
  pending: string | null
  spectating: boolean
}) {
  const [category, setCategory] = useState<string>('all')
  const [counts, setCounts] = useState<Record<number, number>>({})

  const rows = useMemo(() => {
    return blends
      .filter((b) => b.active && resultOf(b))
      .map((b) => {
        const result = resultOf(b)!
        const t = market.templates.get(result)
        const plan = planBlend(market, b)
        // What the ingredients are worth even if you own them (you could sell them instead).
        const value = b.ingredients.reduce((n, ing) => n + (ingredientValue(market, ing) ?? NaN), 0)
        // Expected cost if the materials came from opening chests at today's prices.
        const viaChests = b.ingredients.reduce((n, ing) => {
          if (ing.type !== 'template') return NaN
          return n + ing.amount * (byTemplate.get(ing.templateId)?.fair ?? NaN)
        }, 0)
        const floor = valueOf(market, result)
        return {
          blend: b,
          result,
          template: t,
          schema: t?.schema ?? 'other',
          plan,
          value,
          viaChests,
          floor,
          // Selling the result keeps 93% of its value (collection and marketplace fees).
          margin: floor !== null && Number.isFinite(value) ? floor * SALE_KEEP - value : null,
          left: mintable(market, b)
        }
      })
      .sort((a, b) => (b.margin ?? -Infinity) - (a.margin ?? -Infinity))
  }, [blends, market, byTemplate])

  const shown = rows.filter((r) => category === 'all' || r.schema === category)
  const categories = CATEGORY_ORDER.filter((c) => rows.some((r) => r.schema === c))

  async function blendNow(r: (typeof rows)[number], times: number) {
    const reserved = new Map<string, number>()
    const plans = Array.from({ length: times }, () => planBlend(market, r.blend, reserved))
    if (plans.some((p) => !Number.isFinite(p.cost))) return
    const buy = plans.flatMap((p) => p.buy)
    await run(
      (a, p) => [
        ...(buy.length
          ? buySalesActions(
              a,
              p,
              buy.map((l) => ({ saleId: l.saleId, assetId: l.assetId, listingPrice: l.listingPrice }))
            )
          : []),
        ...blendActions(
          a,
          p,
          plans.map((pl) => ({ blendId: r.blend.id, assetIds: pl.assets }))
        )
      ],
      `${times}× ${r.template?.name ?? 'blend'} on its way: it is minted in a few seconds`,
      `blend-${r.blend.id}`
    )
  }

  return (
    <section className="bl-section">
      <div className="bl-filter">
        <div className="segmented">
          <button type="button" className={category === 'all' ? 'is-active' : ''} onClick={() => setCategory('all')}>
            All
          </button>
          {categories.map((c) => (
            <button key={c} type="button" className={category === c ? 'is-active' : ''} onClick={() => setCategory(c)}>
              {CATEGORY_LABEL[c] ?? titleCase(c)}
            </button>
          ))}
        </div>
        <span className="faint">
          Most profitable first: the result at its market value after the 7% sale fees, minus the ingredients at theirs (yours
          count too: you could sell them instead). Market value is the floor or the recent sale median, whichever is lower.
        </span>
      </div>
      <div className="bl-rows">
        {shown.map((r) => {
          const st = stats?.get(r.result)
          const times = counts[r.blend.id] ?? 1
          const missing = r.plan.buy.length
          const canBlend = r.left > 0 && Number.isFinite(r.plan.cost)
          return (
            <article key={r.blend.id} className={`bl-row ${r.left <= 0 ? 'is-capped' : ''}`}>
              <div className="bl-result">
                <IpfsImg hash={r.template?.img} alt="" className="bl-result__art" />
                <div className="bl-result__text">
                  <b>{r.template?.name ?? `#${r.result}`}</b>
                  <small style={{ color: rarityColor(r.template?.rarity) }}>
                    {r.template?.rarity} {SINGULAR[r.schema] ?? r.schema}
                  </small>
                  {st && <StatTrio atk={st.attack} def={st.defense} move={st.movecost} size="sm" />}
                  <small className="faint">
                    {r.left === Infinity ? 'unlimited' : r.left <= 0 ? 'minted out' : `${formatNumber(r.left, 0)} left to mint`}
                  </small>
                </div>
              </div>
              <div className="bl-ings">
                {r.blend.ingredients.map((ing, i) => (
                  <IngredientChip key={i} ing={ing} market={market} line={r.plan.lines[i]} />
                ))}
              </div>
              <div className="bl-money num">
                <Tooltip text="What the result sells for: its floor or its recent sale median, whichever is lower.">
                  <Figure label="Result value" value={wax(r.floor)} />
                </Tooltip>
                <Tooltip text="Every ingredient at its market value, including the ones you own.">
                  <Figure label="Ingredients" value={wax(r.value)} />
                </Tooltip>
                <Tooltip text="WAX you actually pay: only the ingredients you are missing, at today's floors.">
                  <Figure label="You pay" value={wax(r.plan.cost)} tone={r.plan.cost === 0 ? 'c-green' : ''} />
                </Tooltip>
                <Tooltip text="Expected cost if every ingredient came from opening Quantum Chests (and Keys) at today's prices.">
                  <Figure label="Via chests" value={wax(r.viaChests)} />
                </Tooltip>
                <Figure
                  label="Profit"
                  value={r.margin === null ? '–' : `${r.margin > 0 ? '+' : ''}${wax(r.margin)}`}
                  tone={r.margin === null ? '' : r.margin > 0 ? 'c-green' : 'c-red'}
                />
              </div>
              <div className="bl-act">
                <span className="stepper stepper--row">
                  <button
                    type="button"
                    aria-label="Fewer"
                    onClick={() => setCounts((c) => ({ ...c, [r.blend.id]: Math.max(1, times - 1) }))}
                  >
                    <MinusIcon width={12} height={12} />
                  </button>
                  <b className="num">×{times}</b>
                  <button
                    type="button"
                    aria-label="More"
                    onClick={() => setCounts((c) => ({ ...c, [r.blend.id]: Math.min(20, r.left, times + 1) }))}
                  >
                    <PlusIcon width={12} height={12} />
                  </button>
                </span>
                <Button
                  size="sm"
                  color={missing ? 'gradientYellow' : 'gradientGreen'}
                  disabled={!canBlend || spectating}
                  isLoading={pending === `blend-${r.blend.id}`}
                  onClick={() => blendNow(r, times)}
                >
                  <SparkIcon /> {missing ? 'Buy & blend' : 'Blend'}
                </Button>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function IngredientChip({ ing, market, line }: { ing: Ingredient; market: Market; line?: { cost: number; owned: number } }) {
  const t = ing.type === 'template' ? market.templates.get(ing.templateId) : null
  const label =
    ing.type === 'template'
      ? (t?.name ?? `#${ing.templateId}`)
      : ing.type === 'attribute'
        ? `any ${ing.attributes.map((a) => a.values.join('/')).join(' ')} ${ing.schema || 'NFT'}`
        : ing.label
  const have = line?.owned ?? 0
  const complete = have >= ing.amount
  return (
    <Tooltip
      text={
        <>
          {ing.amount}× {label}. You own {have}.{' '}
          {complete
            ? 'Covered by your wallet.'
            : Number.isFinite(line?.cost ?? NaN)
              ? `The rest costs ${wax(line!.cost)} WAX.`
              : 'Not enough listed right now.'}
        </>
      }
    >
      <span
        className={`bl-ing ${complete ? 'is-owned' : Number.isFinite(line?.cost ?? NaN) ? '' : 'is-missing'}`}
        style={{ '--rarity': rarityColor(t?.rarity) } as React.CSSProperties}
      >
        {t?.img && <IpfsImg hash={t.img} alt="" className="bl-ing__art" />}
        <span className="bl-ing__name">{label}</span>
        <b className="num">
          {have}/{ing.amount}
        </b>
      </span>
    </Tooltip>
  )
}

// ---- Materials --------------------------------------------------------------------------------------

function Materials({ materials }: { materials: MaterialValue[] }) {
  const sorted = [...materials].sort(
    (a, b) => (a.source ?? 'z').localeCompare(b.source ?? 'z') || b.chance - a.chance || a.name.localeCompare(b.name)
  )
  return (
    <section className="bl-section">
      <p className="faint bl-explain">
        <b>Fair value</b> is a material's share of an opening: the price of a chest (plus key) split across the possible drops by
        the market's price level per rarity, so opening breaks even at fair values. <b>Pull cost</b> is what getting this exact
        one costs on average. <b>Blend value</b> is one unit's share of the best recipe's result, split by the ingredients' market
        values. <b>Market</b> is the floor or the recent sale median, whichever is lower; most Epic and rarer materials are never
        listed but sell often.
      </p>
      <div className="bl-table">
        <div className="bl-table__head">
          <span>Material</span>
          <span>Drops from</span>
          <span>Market</span>
          <span>Fair value</span>
          <span>Pull cost</span>
          <span>Blend value</span>
          <span>Verdict</span>
        </div>
        {sorted.map((m) => {
          const ratio = m.value !== null && m.fair ? m.value / m.fair : null
          const verdict = ratio === null ? null : ratio < 0.85 ? 'cheap' : ratio > 1.15 ? 'dear' : 'fair'
          return (
            <div key={m.templateId} className="bl-table__row">
              <span className="bl-mat">
                <IpfsImg hash={m.img} alt="" className="bl-mat__art" />
                <span>
                  <b>{m.name}</b>
                  <small style={{ color: rarityColor(m.rarity) }}>
                    {m.rarity}
                    {m.owned ? ` · you own ${m.owned}` : ''}
                  </small>
                </span>
              </span>
              <span className="num">
                {m.source ? `${m.source === 'chest' ? 'Chest' : 'Chest + Key'} · ${percent(m.chance, 0)}` : '–'}
              </span>
              <Tooltip
                text={`Floor ${wax(m.floor)} (${m.listed} listed) · recent sales ${m.recent !== null ? `around ${wax(m.recent)}` : 'too few'}`}
              >
                <span className="num">
                  {wax(m.value)} <small className="faint">{m.floor === null ? 'sold' : `${m.listed} listed`}</small>
                </span>
              </Tooltip>
              <span className="num">{wax(m.fair)}</span>
              <span className="num">{wax(m.pullCost, 0)}</span>
              <span className="num">
                {m.blendValue !== null ? (
                  <Tooltip
                    text={`Best use: blend ${m.blendVia ? `recipe #${m.blendVia.id}` : ''} and sell the result at its market value.`}
                  >
                    <b className="c-green">{wax(m.blendValue)}</b>
                  </Tooltip>
                ) : (
                  '–'
                )}
              </span>
              <span>
                {verdict === 'cheap' && <span className="chip chip--green">below fair</span>}
                {verdict === 'fair' && <span className="chip">fair</span>}
                {verdict === 'dear' && <span className="chip chip--red">above fair</span>}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ---- Chests & keys ----------------------------------------------------------------------------------

function Chests({
  openings,
  market,
  byTemplate,
  reveal,
  run,
  pending,
  spectating
}: {
  openings: { chest: Opening | null; chestKey: Opening | null }
  market: Market
  byTemplate: Map<string, MaterialValue>
  reveal: ReturnType<typeof useReveal>
  run: Run
  pending: string | null
  spectating: boolean
}) {
  const chestFloor = floorOf(market, QUANTUM_CHEST)
  const keyFloor = floorOf(market, QUANTUM_KEY)
  const chestValue = openings.chest ? openingValue(openings.chest, byTemplate) : null
  const ckValue = openings.chestKey ? openingValue(openings.chestKey, byTemplate) : null
  // A key is only useful with a chest: its worth is what adding it to an opening gains.
  const keyValue =
    ckValue && chestValue
      ? {
          sell: ckValue.sell - chestValue.sell,
          best: ckValue.best - chestValue.best,
          unpricedSell: Math.max(ckValue.unpricedSell, chestValue.unpricedSell),
          unpricedBest: Math.max(ckValue.unpricedBest, chestValue.unpricedBest)
        }
      : null
  const ownedChests = market.owned.get(QUANTUM_CHEST) ?? []
  const ownedKeys = market.owned.get(QUANTUM_KEY) ?? []

  return (
    <section className="bl-section bl-chests">
      <LootCard
        title="Quantum Chest"
        templateId={QUANTUM_CHEST}
        market={market}
        price={chestFloor}
        value={chestValue}
        explain="One Common, Uncommon or Rare material (50 / 35 / 15%)."
        run={run}
        pending={pending}
        spectating={spectating}
        open={
          openings.chest && ownedChests.length
            ? {
                max: Math.min(MAX_OPEN, ownedChests.length),
                owned: ownedChests.length,
                label: (n) => `Open ${n}`,
                busy: pending === 'open-chest',
                start: (n) =>
                  void reveal.open(
                    ownedChests.slice(0, n).map((c) => ({ blendId: openings.chest!.blend.id, assetIds: [c] })),
                    false,
                    chestFloor,
                    'open-chest'
                  )
              }
            : null
        }
      />
      <LootCard
        title="Quantum Key"
        templateId={QUANTUM_KEY}
        market={market}
        price={keyFloor}
        value={keyValue}
        explain="Opened together with a chest: one Epic, Legendary or Mythic material (70 / 25 / 5%) instead of a lower one. Its worth is what it adds to opening that chest."
        run={run}
        pending={pending}
        spectating={spectating}
        open={
          openings.chestKey && ownedChests.length && ownedKeys.length
            ? {
                max: Math.min(MAX_OPEN, ownedChests.length, ownedKeys.length),
                owned: Math.min(ownedChests.length, ownedKeys.length),
                label: (n) => `Open ${n} with key${n === 1 ? '' : 's'}`,
                busy: pending === 'open-key',
                start: (n) =>
                  void reveal.open(
                    Array.from({ length: n }, (_, i) => ({
                      blendId: openings.chestKey!.blend.id,
                      assetIds: [ownedChests[i], ownedKeys[i]]
                    })),
                    true,
                    chestFloor !== null && keyFloor !== null ? chestFloor + keyFloor : null,
                    'open-key'
                  )
              }
            : null
        }
      />
      {reveal.state && <RevealPanel reveal={reveal.state} market={market} byTemplate={byTemplate} onClose={reveal.close} />}
      {openings.chest && openings.chestKey && (
        <div className="bl-outcomes panel panel--tight">
          <h3>What comes out</h3>
          {[openings.chest, openings.chestKey].map((o) => (
            <div key={o.blend.id} className="bl-outcomes__group">
              <p className="eyebrow">{o.withKey ? 'Chest + Key' : 'Chest'}</p>
              <div className="bl-outcomes__grid">
                {o.outcomes.map((out) => {
                  const m = byTemplate.get(out.templateId)
                  return (
                    <span key={out.templateId} className="bl-outcome">
                      <IpfsImg hash={m?.img} alt="" className="bl-mat__art" />
                      <span>
                        <b>{m?.name ?? out.templateId}</b>
                        <small className="faint num">
                          {percent(out.chance, 0)} · {m?.worth != null ? `worth ${wax(m.worth)}` : 'no price yet'}
                        </small>
                      </span>
                    </span>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function LootCard({
  title,
  templateId,
  market,
  price,
  value,
  explain,
  run,
  pending,
  spectating,
  open
}: {
  title: string
  templateId: string
  market: Market
  price: number | null
  /** After-fee value of one: selling its materials, or using them the best way; and the share with no price. */
  value: { sell: number; best: number; unpricedSell: number; unpricedBest: number } | null
  explain: string
  run: Run
  pending: string | null
  spectating: boolean
  /** Opening the ones you own: how many at most in one transaction, and how to start it. */
  open: { max: number; owned: number; label: (n: number) => string; busy: boolean; start: (n: number) => void } | null
}) {
  const [qty, setQty] = useState(1)
  const [openQty, setOpenQty] = useState(1)
  const opening = open ? Math.max(1, Math.min(openQty, open.max)) : 0
  const t = market.templates.get(templateId)
  const listings = market.listings.get(templateId) ?? []
  const buying = listings.slice(0, qty)
  const total = buying.reduce((n, l) => n + l.price, 0)
  // A verdict needs most of the outcomes priced; below that it is only a lower bound.
  const judge = (v: number, unpriced: number) => {
    if (price === null) return { text: 'No listing to compare with.', tone: '' }
    const edge = v / price - 1
    if (unpriced > 0.5 && v <= 0)
      return { text: `${percent(unpriced, 0)} of the outcomes have no price, so this cannot be valued yet.`, tone: '' }
    if (unpriced > 0.5)
      return {
        text: `${percent(unpriced, 0)} of the outcomes have no price yet: at least ${wax(v)} WAX back (${edge >= 0 ? '+' : ''}${percent(edge, 0)}).`,
        tone: edge >= 0 ? 'is-good' : ''
      }
    return {
      text: `${wax(v)} WAX back on average: ${edge >= 0 ? `${percent(edge, 0)} more than` : `${percent(-edge, 0)} less than`} its floor.`,
      tone: edge >= 0 ? 'is-good' : 'is-bad'
    }
  }
  const sellVerdict = value ? judge(value.sell, value.unpricedSell) : null
  const bestVerdict = value ? judge(value.best, value.unpricedBest) : null
  // Only as many as are listed below what one is worth used the best way.
  const worthIt = value ? listings.filter((l) => l.price <= value.best).length : 0

  return (
    <article className="bl-loot panel">
      <div className="bl-loot__head">
        {t?.img && <IpfsImg hash={t.img} alt="" className="bl-loot__art" />}
        <div>
          <h3>{title}</h3>
          <p className="muted">{explain}</p>
        </div>
      </div>
      <div className="bl-loot__figures">
        <Figure label="Floor" value={wax(price)} />
        <Tooltip text="Expected WAX back if every material from it is sold at its market value (floor or recent sales, whichever is lower), after the 7% sale fees.">
          <Figure label="If sold" value={wax(value?.sell)} />
        </Tooltip>
        <Tooltip text="Expected WAX back using every material the best way: sold, or blended into a result that is sold (its share of the result, after fees), whichever pays more.">
          <Figure label="Best use" value={wax(value?.best)} />
        </Tooltip>
        <Figure label="You own" value={market.owned.get(templateId)?.length ?? 0} />
      </div>
      {sellVerdict && bestVerdict && (
        <div className="bl-verdicts">
          <p className={`bl-verdict ${sellVerdict.tone}`}>
            <b>Selling the materials:</b> {sellVerdict.text}
          </p>
          <p className={`bl-verdict ${bestVerdict.tone}`}>
            <b>Blending where it pays:</b> {bestVerdict.text}
            {bestVerdict.tone === 'is-good' && worthIt > 0 ? ` ${worthIt} listed at or below that.` : ''}
          </p>
        </div>
      )}
      <div className="bl-loot__buy">
        <span className="stepper stepper--row">
          <button type="button" aria-label="Fewer" onClick={() => setQty((q) => Math.max(1, q - 1))}>
            <MinusIcon width={12} height={12} />
          </button>
          <b className="num">{qty}</b>
          <button type="button" aria-label="More" onClick={() => setQty((q) => Math.min(listings.length || 1, q + 1))}>
            <PlusIcon width={12} height={12} />
          </button>
        </span>
        <Button
          size="sm"
          color="gradientYellow"
          disabled={!buying.length || spectating}
          isLoading={pending === `buy-${templateId}`}
          onClick={() =>
            run(
              (a, p) =>
                buySalesActions(
                  a,
                  p,
                  buying.map((l) => ({ saleId: l.saleId, assetId: l.assetId, listingPrice: l.listingPrice }))
                ),
              `Bought ${buying.length} ${title}${buying.length === 1 ? '' : 's'}`,
              `buy-${templateId}`
            )
          }
        >
          Buy {qty} for {wax(total)} WAX
        </Button>
      </div>
      {open && (
        <div className="bl-loot__buy bl-loot__open">
          <span className="stepper stepper--row">
            <button type="button" aria-label="Fewer" onClick={() => setOpenQty(Math.max(1, opening - 1))}>
              <MinusIcon width={12} height={12} />
            </button>
            <input
              className="num"
              inputMode="numeric"
              aria-label="How many to open"
              value={opening}
              onChange={(e) => setOpenQty(Number(e.target.value.replace(/\D/g, '')) || 1)}
            />
            <button type="button" aria-label="More" onClick={() => setOpenQty(Math.min(open.max, opening + 1))}>
              <PlusIcon width={12} height={12} />
            </button>
          </span>
          <button type="button" className="bl-max" onClick={() => setOpenQty(open.max)}>
            max {open.max}
          </button>
          <Button size="sm" color="gradientGreen" disabled={spectating} isLoading={open.busy} onClick={() => open.start(opening)}>
            {open.label(opening)}
          </Button>
          {open.owned > open.max && <small className="faint">{MAX_OPEN} per transaction</small>}
        </div>
      )}
    </article>
  )
}

// ---- Opening reveal ---------------------------------------------------------------------------------

/** Openings per transaction: each is its own blend action, and a wallet's CPU has limits. */
const MAX_OPEN = 50
const REVEAL_POLL_MS = 3_000
/** After this the reveal stops waiting; late materials still arrive in the wallet. */
const REVEAL_TIMEOUT_MS = 120_000

interface Reveal {
  expected: number
  withKey: boolean
  /** WAX one opening cost at today's floors, for the comparison. */
  costEach: number | null
  before: Set<string>
  found: AtomicAsset[]
  started: number
  done: boolean
}

/**
 * Opens chests and then watches the wallet for what the random oracle mints: every material that
 * was not there before the transaction is a result.
 */
function useReveal(account: string | null, run: Run) {
  const [state, setState] = useState<Reveal | null>(null)

  async function open(runs: BlendRun[], withKey: boolean, costEach: number | null, key: string) {
    if (!account) return
    // What the wallet held before, so the new materials can be told apart.
    const before = await atomic
      .getOwnedAssets(account, 'planetdefnft')
      .then((list) => new Set(list.map((a) => a.asset_id)))
      .catch(() => null)
    if (!before) return
    const ok = await run((a, p) => blendActions(a, p, runs), `${runs.length} opened: watching for what comes out`, key)
    if (ok) setState({ expected: runs.length, withKey, costEach, before, found: [], started: Date.now(), done: false })
  }

  useEffect(() => {
    if (!state || state.done || !account) return
    const timer = setTimeout(async () => {
      const assets = await atomic.getOwnedAssets(account, 'planetdefnft').catch(() => null)
      setState((r) => {
        if (r !== state) return r
        const found = assets ? assets.filter((a) => a.schema.schema_name === 'material' && !r.before.has(a.asset_id)) : r.found
        return { ...r, found, done: found.length >= r.expected || Date.now() - r.started > REVEAL_TIMEOUT_MS }
      })
    }, REVEAL_POLL_MS)
    return () => clearTimeout(timer)
  }, [state, account])

  // The wallet changed: refresh what the recipes and cards count as owned.
  const done = state?.done ?? false
  useEffect(() => {
    if (done) void queryClient.invalidateQueries({ queryKey: ['owned-blend-inputs'] })
  }, [done])

  return { state, open, close: () => setState(null) }
}

function RevealPanel({
  reveal,
  market,
  byTemplate,
  onClose
}: {
  reveal: Reveal
  market: Market
  byTemplate: Map<string, MaterialValue>
  onClose: () => void
}) {
  const counts = new Map<string, number>()
  for (const a of reveal.found) {
    const t = a.template?.template_id ?? '?'
    counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  const items = [...counts]
    .map(([t, n]) => ({ t, n, tpl: market.templates.get(t), mv: byTemplate.get(t) }))
    .sort((a, b) => (b.mv?.value ?? 0) - (a.mv?.value ?? 0))
  const worth = items.reduce((sum, i) => sum + i.n * (i.mv?.value ?? 0) * SALE_KEEP, 0)
  const cost = reveal.costEach !== null ? reveal.costEach * reveal.found.length : null
  const arrived = reveal.found.length
  const what = reveal.withKey ? 'chest + key' : 'chest'

  return (
    <section className="bl-reveal panel" aria-live="polite">
      <header className="bl-reveal__head">
        <div>
          <p className="eyebrow">
            Opened {reveal.expected} × {what}
          </p>
          <h3>
            {!reveal.done
              ? `Revealing… ${arrived} of ${reveal.expected}`
              : arrived >= reveal.expected
                ? 'Here is what came out'
                : `${arrived} of ${reveal.expected} arrived so far`}
          </h3>
        </div>
        {!reveal.done && <span className="spinner" />}
        {arrived > 0 && (
          <Tooltip text="What these materials sell for at market value after the 7% sale fees, against what the openings cost at today's floors.">
            <span className="bl-reveal__sum num">
              <span className="faint">Worth</span> <b>{wax(worth)}</b>
              {cost !== null && (
                <>
                  {' '}
                  <span className="faint">vs cost</span> <b>{wax(cost)}</b>{' '}
                  <b className={worth >= cost ? 'c-green' : 'c-red'}>
                    ({worth >= cost ? '+' : ''}
                    {wax(worth - cost)})
                  </b>
                </>
              )}
            </span>
          </Tooltip>
        )}
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          <XIcon width={14} height={14} />
        </button>
      </header>
      {arrived === 0 && !reveal.done && (
        <p className="muted">The random oracle mints the materials a few seconds after the transaction.</p>
      )}
      {reveal.done && arrived < reveal.expected && (
        <p className="muted">The rest has not been minted yet. It will show up in your wallet once the oracle gets to it.</p>
      )}
      <div className="bl-reveal__grid">
        {items.map((i) => (
          <div key={i.t} className="bl-reveal__item" style={{ '--rarity': rarityColor(i.tpl?.rarity) } as CSSProperties}>
            <IpfsImg hash={i.tpl?.img} alt="" className="bl-reveal__art" />
            <b className="bl-reveal__count num">×{i.n}</b>
            <span className="bl-reveal__name">{i.tpl?.name ?? `#${i.t}`}</span>
            <small style={{ color: rarityColor(i.tpl?.rarity) }}>
              {i.tpl?.rarity}
              {i.mv?.value != null ? ` · ${wax(i.mv.value)} each` : ''}
            </small>
          </div>
        ))}
      </div>
    </section>
  )
}
