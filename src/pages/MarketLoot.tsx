import { useState } from 'react'

import { buySalesActions } from '@/chain/actions/market'
import { ZoomImg } from '@/components/Art'
import { Button } from '@/components/Button'
import { Figure } from '@/components/Stat'
import { Tooltip } from '@/components/Tooltip'
import { QUANTUM_CHEST, QUANTUM_KEY, useCollectionTemplates } from '@/data/blends'
import { refreshInventory } from '@/data/inventory'
import type { Listing } from '@/data/market'
import { CartIcon, MinusIcon, PlusIcon } from '@/icons'
import { formatNumber } from '@/lib/format'
import { useTransaction } from '@/wallet/useTransaction'

/*
 * The Market's loot shelf: every Quantum Chest and Quantum Key listed right now, cheapest first,
 * and a stepper to buy the cheapest few of either in one press.
 */

/** Listings bought in one transaction at most (each is an assert and a purchase, plus one deposit). */
const MAX_PER_PRESS = 40

function Shelf({
  title,
  templateId,
  listings,
  account,
  wax,
  explain
}: {
  title: string
  templateId: string
  listings: Listing[]
  account: string | null
  wax: number
  explain: string
}) {
  const templates = useCollectionTemplates()
  const { run, pending, spectating } = useTransaction()
  const [count, setCount] = useState(1)
  const mine = listings.filter((l) => l.templateId === templateId && l.seller !== account)
  const n = Math.min(count, mine.length, MAX_PER_PRESS)
  const chosen = mine.slice(0, n)
  const total = chosen.reduce((s, l) => s + l.price, 0)
  const img = templates.data?.get(templateId)?.img ?? mine[0]?.asset.img ?? ''

  async function buy() {
    if (!chosen.length) return
    const ok = await run(
      (a, p) =>
        buySalesActions(
          a,
          p,
          chosen.map((l) => ({ saleId: l.saleId, assetId: l.assetId, listingPrice: l.listingPrice }))
        ),
      `${chosen.length} ${title}${chosen.length === 1 ? '' : 's'} bought for ${formatNumber(total, 2)} WAX`,
      `buy-${templateId}`,
      { split: true }
    )
    if (ok) void refreshInventory(account)
  }

  return (
    <article className="loot panel">
      <div className="loot__head">
        <ZoomImg hash={img} alt="" className="loot__art" name={title} rarity="" />
        <div>
          <h3>{title}</h3>
          <p className="muted">{explain}</p>
        </div>
      </div>
      <div className="loot__figures">
        <Figure label="Listed" value={formatNumber(mine.length, 0)} />
        <Figure label="Floor" value={mine.length ? `${formatNumber(mine[0].price, 2)} WAX` : '–'} />
        <Figure
          label={`Cheapest ${n || ''}`}
          value={chosen.length ? `${formatNumber(total, 2)} WAX` : '–'}
          help={chosen.length > 1 ? `${formatNumber(total / chosen.length, 2)} WAX each on average.` : undefined}
        />
      </div>
      <div className="loot__buy">
        <span className="stepper stepper--row">
          <button type="button" aria-label="Fewer" disabled={count <= 1} onClick={() => setCount((c) => Math.max(1, c - 1))}>
            <MinusIcon width={12} height={12} />
          </button>
          <b className="num">×{n}</b>
          <button
            type="button"
            aria-label="More"
            disabled={count >= Math.min(mine.length, MAX_PER_PRESS)}
            onClick={() => setCount((c) => Math.min(mine.length, MAX_PER_PRESS, c + 1))}
          >
            <PlusIcon width={12} height={12} />
          </button>
        </span>
        <Tooltip
          text={
            !mine.length
              ? 'Nothing is listed right now.'
              : total > wax
                ? `That is ${formatNumber(total - wax, 2)} WAX more than you hold.`
                : 'Buys the cheapest listings, each asserted at its price so a change on the seller’s side fails the purchase instead of paying more.'
          }
        >
          <Button
            color="gradientYellow"
            disabled={!chosen.length || total > wax || spectating}
            isLoading={pending === `buy-${templateId}`}
            onClick={buy}
          >
            <CartIcon /> Buy {n} for {formatNumber(total, 0)} WAX
          </Button>
        </Tooltip>
      </div>
      {mine.length > 0 && (
        <ul className="loot__list">
          {mine.slice(0, 12).map((l, i) => (
            <li key={l.saleId} className={i < n ? 'is-chosen' : ''}>
              <span className="num">{formatNumber(l.price, 2)} WAX</span>
              <span className="faint">{l.seller}</span>
              <a href={`https://wax.atomichub.io/market/sale/wax-mainnet/${l.saleId}`} target="_blank" rel="noreferrer">
                AtomicHub
              </a>
            </li>
          ))}
          {mine.length > 12 && <li className="faint">…and {mine.length - 12} more</li>}
        </ul>
      )}
    </article>
  )
}

export function LootMarket({ account, listings, wax }: { account: string | null; listings: Listing[] | undefined; wax: number }) {
  return (
    <section className="lootmarket">
      <div className="inv__head">
        <div>
          <p className="eyebrow">Chests &amp; keys</p>
          <h2>Quantum Chests and Keys on the market</h2>
          <p className="muted">
            Everything listed right now, cheapest first. Set how many and buy the cheapest ones in one press; open them on the
            Blend page.
          </p>
        </div>
      </div>
      <div className="lootmarket__grid">
        <Shelf
          title="Quantum Chest"
          templateId={QUANTUM_CHEST}
          listings={listings ?? []}
          account={account}
          wax={wax}
          explain="Opens into one material; with a Key, the odds shift to the rarer ones."
        />
        <Shelf
          title="Quantum Key"
          templateId={QUANTUM_KEY}
          listings={listings ?? []}
          account={account}
          wax={wax}
          explain="Opened together with a Chest for better odds."
        />
      </div>
    </section>
  )
}
