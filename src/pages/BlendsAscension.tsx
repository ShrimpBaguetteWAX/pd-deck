import { useEffect, useMemo, useRef, useState } from 'react'

import { ascendAction, sacrificeAction } from '@/chain/actions/ascend'
import { FRAGMENT_TEMPLATE } from '@/chain/config'
import { CardArt, rarityColor, ZoomImg } from '@/components/Art'
import { Button } from '@/components/Button'
import { Loading } from '@/components/Loading'
import { Figure } from '@/components/Stat'
import { Tooltip } from '@/components/Tooltip'
import type { AssetRef } from '@/data/assets'
import { costKey, expectedYield, useAscensionConfig, usePendingBurns } from '@/data/ascension'
import { useArmy, useAssetStats, useWalletNfts, refreshPlayer } from '@/data/game'
import { MinusIcon, PlusIcon } from '@/icons'
import { SALE_KEEP, valueOf, type Market } from '@/lib/blendEconomy'
import { formatNumber } from '@/lib/format'
import { KIND_LABEL, kindOf } from '@/lib/stats'
import { useTransaction } from '@/wallet/useTransaction'

/*
 * The Ascension tab: the Ascend Nexus (raise a card a star with Fragments) and the Sacrificial
 * Altar (burn cards for Fragments). Both work on cards in the wallet: a staked card has to be
 * unstaked first. Everything that goes in is burned.
 */

const wax = (n: number | null | undefined, digits = 2) => (n == null || !Number.isFinite(n) ? '–' : formatNumber(n, digits))
/** Cards per sacrifice transaction at most. */
const SACRIFICE_PER_TX = 20
const stars = (a: AssetRef) => Number(a.stats?.min_forge_level ?? 0)
const starText = (n: number) => (n > 0 ? '★'.repeat(n) : 'no stars')

export function Ascension({ account, market }: { account: string | null; market: Market }) {
  const config = useAscensionConfig()
  const wallet = useWalletNfts(account)
  const army = useArmy(account)
  const stats = useAssetStats()
  const pending = usePendingBurns(account)
  const { run, pending: busy, spectating } = useTransaction()

  // Fragments in the wallet: the market's owned map holds material by template.
  const fragmentIds = market.owned.get(FRAGMENT_TEMPLATE) ?? []
  const fragmentValue = valueOf(market, FRAGMENT_TEMPLATE)

  // When a pending sacrifice is revealed, the wallet has new Fragments: read it again.
  const pendingCount = pending.data?.length ?? 0
  const lastPending = useRef(0)
  useEffect(() => {
    if (lastPending.current > 0 && pendingCount < lastPending.current) void refreshPlayer(account)
    lastPending.current = pendingCount
  }, [pendingCount, account])

  // Wallet cards by template.
  const groups = useMemo(() => {
    const m = new Map<string, AssetRef[]>()
    for (const a of wallet.data ?? []) m.set(a.templateId, [...(m.get(a.templateId) ?? []), a])
    return m
  }, [wallet.data])

  if (!config.data || !stats.data || (account && !wallet.data)) return <Loading inline label="Reading the Ascension tables" />
  const cfg = config.data
  if (!account) return <p className="muted">Sign in, or add ?as=account to the address, to see your cards.</p>

  // ---- Ascend ----
  const ascendable = [...groups.entries()]
    .map(([templateId, cards]) => {
      const to = cfg.next.get(templateId)
      const sample = cards[0]
      const from = stars(sample)
      const cost = cfg.costs.get(costKey(sample.rarity, from)) ?? null
      const nextStats = to ? stats.data!.get(to) : undefined
      return { templateId, cards, sample, from, to, cost, nextStats }
    })
    .filter((r) => r.to && r.cost !== null)
    .sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0))
  const stakedAscendable = [...(army.data?.assets.values() ?? [])].filter((a) => cfg.next.has(a.templateId)).length

  // ---- Sacrifice ----
  const sacrificeable = [...groups.entries()]
    .map(([templateId, cards]) => {
      const sample = cards[0]
      const y = cfg.yields.get(sample.rarity.toLowerCase()) ?? null
      return { templateId, cards, sample, y, floor: valueOf(market, templateId) }
    })
    .filter((r) => r.y)
    .sort((a, b) => (a.floor ?? 0) - (b.floor ?? 0))

  return (
    <div className="asc">
      {cfg.paused && <p className="bl-verdict is-bad">Ascension is paused by the game right now.</p>}

      <section className="asc__top panel panel--tight">
        <Figure
          label="Your Fragments"
          value={fragmentIds.length}
          help={`Fragments in your wallet. One is worth about ${wax(fragmentValue)} WAX on the market right now.`}
        />
        <Figure label="Fragment value" value={`${wax(fragmentValue)} WAX`} />
        {pendingCount > 0 && (
          <Figure
            label="Awaiting reveal"
            value={`${pending.data!.reduce((n, p) => n + p.min, 0)}–${pending.data!.reduce((n, p) => n + p.max, 0)} Fragments`}
            tone="c-gold"
            help="Sacrifices the oracle has not revealed yet; it usually takes a few seconds. The Fragments appear in your wallet when it does."
          />
        )}
        {stakedAscendable > 0 && (
          <span className="faint asc__note">
            {stakedAscendable} staked card{stakedAscendable === 1 ? '' : 's'} could ascend too, after unstaking (Army page).
          </span>
        )}
      </section>

      <AscendList rows={ascendable} fragmentIds={fragmentIds} paused={cfg.paused} busy={busy} spectating={spectating} run={run} />
      <SacrificeList
        rows={sacrificeable}
        fragmentValue={fragmentValue}
        paused={cfg.paused}
        busy={busy}
        spectating={spectating}
        run={run}
      />
    </div>
  )
}

type Run = ReturnType<typeof useTransaction>['run']

interface AscendRow {
  templateId: string
  cards: AssetRef[]
  sample: AssetRef
  from: number
  to: string | undefined
  cost: number | null
  nextStats: { attack: number; defense: number; movecost: number; movecost_reduction: number } | undefined
}

function AscendList({
  rows,
  fragmentIds,
  paused,
  busy,
  spectating,
  run
}: {
  rows: AscendRow[]
  fragmentIds: string[]
  paused: boolean
  busy: string | null
  spectating: boolean
  run: Run
}) {
  return (
    <section className="bl-section">
      <div>
        <h3 className="asc__h">Ascend Nexus</h3>
        <p className="faint bl-explain">
          A card goes up one star at a time, for Fragments; the card and the Fragments are burned and the next tier of the same
          card is minted to you at once. Each star adds stats; a card with N stars needs Forge level N to be equipped. Common,
          Uncommon and Rare cards go to 3 stars, Epic and above to 5. Only creatures and supplies can ascend so far.
        </p>
      </div>
      {rows.length === 0 ? (
        <div className="empty">
          <strong>No card in your wallet can ascend</strong>
          <span>Creatures and supplies below their last star can. Staked cards have to be unstaked first.</span>
        </div>
      ) : (
        <div className="bl-rows">
          {rows.map((r) => {
            const st = r.sample.stats!
            const isSupply = kindOf(st) === 'supply'
            const enough = fragmentIds.length >= (r.cost ?? Infinity)
            return (
              <article key={r.templateId} className="bl-row asc__row">
                <div className="bl-result">
                  <CardArt asset={r.sample} shape="square" className="asc__art" zoom />
                  <div className="bl-result__text">
                    <b>{r.sample.name}</b>
                    <small style={{ color: rarityColor(r.sample.rarity) }}>
                      {r.sample.rarity} {KIND_LABEL[kindOf(st)!] ?? ''} · {starText(r.from)} · you have {r.cards.length}
                    </small>
                  </div>
                </div>
                <div className="asc__change num">
                  <span>
                    <small className="faint">now</small>
                    <b>
                      {st.attack}/{st.defense}
                      {isSupply ? ` −${st.movecost_reduction} move` : ` · ${st.movecost} move`}
                    </b>
                  </span>
                  <span className="asc__arrow">→</span>
                  <span>
                    <small className="faint">{starText(r.from + 1)}</small>
                    <b className="c-green">
                      {r.nextStats ? `${r.nextStats.attack}/${r.nextStats.defense}` : '?'}
                      {r.nextStats
                        ? isSupply
                          ? ` −${r.nextStats.movecost_reduction} move`
                          : ` · ${r.nextStats.movecost} move`
                        : ''}
                    </b>
                  </span>
                </div>
                <div className="asc__cost">
                  <Figure label="Costs" value={`${r.cost} Fragments`} tone={enough ? '' : 'c-red'} />
                  <small className="faint">needs Forge level {r.from + 1} to equip</small>
                </div>
                <Tooltip
                  text={
                    enough
                      ? `One transaction: ${r.sample.name} and ${r.cost} Fragments go to ascend.pdef and are burned; the ${starText(r.from + 1)} version is minted to you.`
                      : `You have ${fragmentIds.length} Fragments; this star costs ${r.cost}.`
                  }
                >
                  <Button
                    size="sm"
                    color="gradientYellow"
                    disabled={!enough || paused || spectating}
                    isLoading={busy === `ascend-${r.templateId}`}
                    onClick={() =>
                      run(
                        (a, p) => ascendAction(a, p, r.cards[0].assetId, fragmentIds.slice(0, r.cost!)),
                        `${r.sample.name} ascended to ${starText(r.from + 1)}`,
                        `ascend-${r.templateId}`
                      )
                    }
                  >
                    Ascend one
                  </Button>
                </Tooltip>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

interface SacrificeRow {
  templateId: string
  cards: AssetRef[]
  sample: AssetRef
  y: { guaranteed: number; bonus: number; bonusChance: number; rarity: string } | null
  floor: number | null
}

function SacrificeList({
  rows,
  fragmentValue,
  paused,
  busy,
  spectating,
  run
}: {
  rows: SacrificeRow[]
  fragmentValue: number | null
  paused: boolean
  busy: string | null
  spectating: boolean
  run: Run
}) {
  const [picked, setPicked] = useState<Record<string, number>>({})
  const [filter, setFilter] = useState<'all' | 'worth'>('all')
  const count = (t: string) => picked[t] ?? 0
  const total = rows.reduce((n, r) => n + count(r.templateId), 0)
  const setCount = (t: string, n: number, max: number) => setPicked((p) => ({ ...p, [t]: Math.max(0, Math.min(max, n)) }))
  const sum = (f: (r: SacrificeRow) => number) => rows.reduce((n, r) => n + count(r.templateId) * f(r), 0)
  const min = sum((r) => r.y!.guaranteed)
  const max = sum((r) => r.y!.guaranteed + r.y!.bonus)
  const expected = sum((r) => expectedYield(r.y!))
  const cardsValue = sum((r) => (r.floor ?? 0) * SALE_KEEP)
  const fragmentsValue = fragmentValue === null ? null : expected * fragmentValue * SALE_KEEP
  const shown = rows.filter((r) => filter === 'all' || worthIt(r, fragmentValue))

  async function sacrifice() {
    const ids = rows.flatMap((r) => r.cards.slice(0, count(r.templateId)).map((a) => a.assetId)).slice(0, SACRIFICE_PER_TX)
    if (!ids.length) return
    const ok = await run(
      (a, p) => sacrificeAction(a, p, ids),
      `${ids.length} card${ids.length === 1 ? '' : 's'} sacrificed: the Fragments arrive after the reveal, in a few seconds`,
      'sacrifice'
    )
    if (ok) setPicked({})
  }

  return (
    <section className="bl-section">
      <div className="bl-filter">
        <div>
          <h3 className="asc__h">Sacrificial Altar</h3>
          <p className="faint bl-explain">
            Cards are burned for Fragments: a guaranteed number per rarity, plus a bonus by chance. The market value of a card is
            shown next to what its Fragments are worth, so you can see when selling pays more.
          </p>
        </div>
        <div className="segmented">
          <button type="button" className={filter === 'all' ? 'is-active' : ''} onClick={() => setFilter('all')}>
            All cards
          </button>
          <button type="button" className={filter === 'worth' ? 'is-active' : ''} onClick={() => setFilter('worth')}>
            Worth burning
          </button>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="empty">
          <strong>No card in your wallet</strong>
          <span>Only cards in the wallet can be sacrificed. Unstake the ones you want to burn first.</span>
        </div>
      ) : (
        <div className="bl-table">
          <div className="bl-table__head asc__table-head">
            <span>Card</span>
            <span>Fragments each</span>
            <span>Card value</span>
            <span>Fragments value</span>
            <span>Sacrifice</span>
          </div>
          {shown.map((r) => {
            const y = r.y!
            const each = expectedYield(y)
            const fragWorth = fragmentValue === null ? null : each * fragmentValue * SALE_KEEP
            const cardWorth = r.floor === null ? null : r.floor * SALE_KEEP
            const n = count(r.templateId)
            return (
              <div key={r.templateId} className={`bl-table__row asc__table-row ${n > 0 ? 'is-picked' : ''}`}>
                <span className="bl-mat">
                  <ZoomImg hash={r.sample.img} alt="" className="bl-mat__art" name={r.sample.name} rarity={r.sample.rarity} />
                  <span>
                    <b>{r.sample.name}</b>
                    <small style={{ color: rarityColor(r.sample.rarity) }}>
                      {r.sample.rarity} · {starText(stars(r.sample))} · you have {r.cards.length}
                    </small>
                  </span>
                </span>
                <Tooltip
                  text={`${y.guaranteed} guaranteed, plus ${y.bonus} more with a ${formatNumber(y.bonusChance * 100, 0)}% chance.`}
                >
                  <span className="num">
                    {y.guaranteed}
                    <small className="faint">
                      {' '}
                      +{y.bonus} at {formatNumber(y.bonusChance * 100, 0)}%
                    </small>
                  </span>
                </Tooltip>
                <span className="num">{cardWorth === null ? '–' : `${wax(cardWorth)} WAX`}</span>
                <span className={`num ${worthIt(r, fragmentValue) ? 'c-green' : ''}`}>
                  {fragWorth === null ? '–' : `≈ ${wax(fragWorth)} WAX`}
                </span>
                <span className="stepper stepper--row">
                  <button type="button" aria-label="Fewer" onClick={() => setCount(r.templateId, n - 1, r.cards.length)}>
                    <MinusIcon width={12} height={12} />
                  </button>
                  <b className="num">{n}</b>
                  <button type="button" aria-label="More" onClick={() => setCount(r.templateId, n + 1, r.cards.length)}>
                    <PlusIcon width={12} height={12} />
                  </button>
                </span>
              </div>
            )
          })}
        </div>
      )}
      {total > 0 && (
        <div className="asc__summary panel panel--tight">
          <div className="bl-loot__figures">
            <Figure label="Cards" value={total} />
            <Figure label="Fragments" value={`${min}–${max}`} help={`About ${formatNumber(expected, 1)} on average.`} />
            <Figure label="Cards are worth" value={`${wax(cardsValue)} WAX`} help="At market value, after the 7% sale fees." />
            <Figure
              label="Fragments are worth"
              value={fragmentsValue === null ? '–' : `≈ ${wax(fragmentsValue)} WAX`}
              tone={fragmentsValue !== null && fragmentsValue >= cardsValue ? 'c-green' : 'c-red'}
            />
          </div>
          {total > SACRIFICE_PER_TX && (
            <small className="faint">
              {SACRIFICE_PER_TX} cards per transaction: the first {SACRIFICE_PER_TX} go now.
            </small>
          )}
          <Button
            color="danger"
            disabled={paused || spectating}
            isLoading={busy === 'sacrifice'}
            onClick={() => void sacrifice()}
          >
            Sacrifice {Math.min(total, SACRIFICE_PER_TX)} card{Math.min(total, SACRIFICE_PER_TX) === 1 ? '' : 's'}
          </Button>
        </div>
      )}
    </section>
  )
}

/** Whether a card's Fragments are worth more than the card itself on the market. */
function worthIt(r: SacrificeRow, fragmentValue: number | null) {
  if (!r.y || fragmentValue === null) return false
  const frag = expectedYield(r.y) * fragmentValue
  return r.floor === null || frag > r.floor
}
