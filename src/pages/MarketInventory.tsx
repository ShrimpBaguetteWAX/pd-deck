import { useMemo, useState } from 'react'

import { cancelSaleAction, listSalesActions, type SaleToList } from '@/chain/actions/market'
import { ZoomImg, rarityColor } from '@/components/Art'
import { Button } from '@/components/Button'
import { Loading } from '@/components/Loading'
import { Tooltip } from '@/components/Tooltip'
import {
  INVENTORY_KINDS,
  INVENTORY_LABEL,
  refreshInventory,
  useInventory,
  useOwnListings,
  type InventoryKind
} from '@/data/inventory'
import type { Listing } from '@/data/market'
import { MinusIcon, PlusIcon } from '@/icons'
import { formatNumber, titleCase } from '@/lib/format'
import { useTransaction } from '@/wallet/useTransaction'

/*
 * The Market's inventory: everything of the collection in the wallet, by template, with the market
 * floor beside each. Pick how many of a template to sell and at what price, and one press lists
 * them all on AtomicMarket (two actions per sale, ten actions to a transaction).
 */

const SINGULAR: Record<InventoryKind, string> = {
  warlord: 'warlord',
  mercenary: 'mercenary',
  weapon: 'equipment',
  supply: 'supply',
  creature: 'creature',
  lavalux: 'Lava Lux',
  material: 'material',
  loot: 'loot'
}

/** A template's worth of NFTs in the wallet. */
interface Group {
  templateId: string
  kind: InventoryKind
  name: string
  rarity: string
  img: string
  /** Asset ids not on sale, lowest first. */
  free: string[]
  /** The player's own listings of this template. */
  listed: { saleId: string; assetId: string; price: number }[]
  /** Cheapest listing of this template on the market, in WAX, or null when none. */
  floor: number | null
}

export function Inventory({ account, listings }: { account: string | null; listings: Listing[] | undefined }) {
  const inventory = useInventory(account)
  const own = useOwnListings(account)
  const { run, pending, spectating } = useTransaction()
  const [kind, setKind] = useState<InventoryKind | 'all'>('all')
  /** How many of each template to list, and at what price (text, so the player can type freely). */
  const [picks, setPicks] = useState<Record<string, { count: number; price: string }>>({})

  const groups = useMemo<Group[]>(() => {
    const listedByAsset = new Map((own.data ?? []).map((l) => [l.assetId, l]))
    const floors = new Map<string, number>()
    for (const l of listings ?? []) {
      if (l.seller === account) continue
      const f = floors.get(l.templateId)
      if (f === undefined || l.price < f) floors.set(l.templateId, l.price)
    }
    const byTemplate = new Map<string, Group>()
    for (const item of inventory.data ?? []) {
      const a = item.asset
      const g = byTemplate.get(a.templateId) ?? {
        templateId: a.templateId,
        kind: item.kind,
        name: a.name,
        rarity: a.rarity,
        img: a.img,
        free: [],
        listed: [],
        floor: floors.get(a.templateId) ?? null
      }
      const l = listedByAsset.get(a.assetId)
      if (l) g.listed.push({ saleId: l.saleId, assetId: a.assetId, price: l.price })
      else g.free.push(a.assetId)
      byTemplate.set(a.templateId, g)
    }
    return [...byTemplate.values()]
      .map((g) => ({ ...g, free: g.free.sort() }))
      .sort((x, y) => INVENTORY_KINDS.indexOf(x.kind) - INVENTORY_KINDS.indexOf(y.kind) || (y.floor ?? 0) - (x.floor ?? 0))
  }, [inventory.data, own.data, listings, account])

  const shown = groups.filter((g) => kind === 'all' || g.kind === kind)
  const kinds = INVENTORY_KINDS.filter((k) => groups.some((g) => g.kind === k))

  // The floor, to the cent, is the price a pick starts at.
  const pickOf = (g: Group) =>
    picks[g.templateId] ?? { count: 0, price: g.floor !== null ? String(Math.round(g.floor * 100) / 100) : '' }
  const setPick = (g: Group, next: Partial<{ count: number; price: string }>) =>
    setPicks((p) => ({ ...p, [g.templateId]: { ...pickOf(g), ...next } }))

  // What one press would list.
  const sales: (SaleToList & { name: string })[] = groups.flatMap((g) => {
    const pick = pickOf(g)
    const price = Number(pick.price)
    if (pick.count <= 0 || !(price > 0)) return []
    return g.free.slice(0, pick.count).map((assetId) => ({ assetId, priceWax: price, name: g.name }))
  })
  const total = sales.reduce((n, s) => n + s.priceWax, 0)
  const unpriced = groups.some((g) => pickOf(g).count > 0 && !(Number(pickOf(g).price) > 0))

  async function list() {
    if (!sales.length) return
    const ok = await run(
      (a, p) => listSalesActions(a, p, sales),
      `${sales.length} NFT${sales.length === 1 ? '' : 's'} listed for ${formatNumber(total, 2)} WAX in all`,
      'list',
      { split: true }
    )
    if (ok) {
      setPicks({})
      void refreshInventory(account)
    }
  }

  async function cancel(saleId: string, name: string) {
    const ok = await run((a, p) => cancelSaleAction(a, p, saleId), `${name} taken off the market`, `cancel-${saleId}`)
    if (ok) void refreshInventory(account)
  }

  if (inventory.isLoading) return <Loading inline label="Reading your wallet" />

  return (
    <section className="inv">
      <div className="inv__head">
        <div>
          <p className="eyebrow">Inventory</p>
          <h2>What is in your wallet</h2>
          <p className="muted">
            Every NFT of the collection you hold, by template, with the cheapest listing of it on the market beside. Pick how many
            to sell and the price; one press lists them all. Staked NFTs are in the game contract, not here.
          </p>
        </div>
        <div className="segmented">
          <button type="button" className={kind === 'all' ? 'is-active' : ''} onClick={() => setKind('all')}>
            All
          </button>
          {kinds.map((k) => (
            <button key={k} type="button" className={kind === k ? 'is-active' : ''} onClick={() => setKind(k)}>
              {INVENTORY_LABEL[k]}
            </button>
          ))}
        </div>
      </div>

      {!groups.length ? (
        <div className="empty">
          <strong>Nothing of the collection in your wallet</strong>
          <span>Staked NFTs live in the game contract; unstake them on the Army page to sell them.</span>
        </div>
      ) : (
        <div className="inv__rows">
          <div className="inv__row inv__row--head">
            <span>NFT</span>
            <span>You hold</span>
            <Tooltip text="The cheapest listing of this template on the market right now, by anyone but you.">
              <span>Floor</span>
            </Tooltip>
            <span>Sell</span>
            <span>Price each</span>
            <span>Listed</span>
          </div>
          {shown.map((g) => {
            const pick = pickOf(g)
            const price = Number(pick.price)
            const belowFloor = g.floor !== null && price > 0 && price < g.floor
            return (
              <div key={g.templateId} className={`inv__row ${pick.count > 0 ? 'is-picked' : ''}`}>
                <span className="inv__nft">
                  <ZoomImg hash={g.img} alt="" className="inv__art" name={g.name} rarity={g.rarity} />
                  <span>
                    <b>{g.name}</b>
                    <small style={{ color: rarityColor(g.rarity) }}>
                      {titleCase(g.rarity)} {SINGULAR[g.kind]}
                    </small>
                  </span>
                </span>
                <span className="num">
                  {g.free.length + g.listed.length}
                  {g.listed.length > 0 && <small className="faint"> · {g.listed.length} on sale</small>}
                </span>
                <span className="num">
                  {g.floor === null ? <span className="faint">none listed</span> : `${formatNumber(g.floor, 2)} WAX`}
                </span>
                <span className="stepper stepper--row">
                  <button
                    type="button"
                    aria-label="Fewer"
                    disabled={pick.count <= 0}
                    onClick={() => setPick(g, { count: pick.count - 1 })}
                  >
                    <MinusIcon width={12} height={12} />
                  </button>
                  <b className="num">
                    {pick.count}
                    <small className="faint"> / {g.free.length}</small>
                  </b>
                  <button
                    type="button"
                    aria-label="More"
                    disabled={pick.count >= g.free.length}
                    onClick={() => setPick(g, { count: Math.min(g.free.length, pick.count + 1) })}
                  >
                    <PlusIcon width={12} height={12} />
                  </button>
                </span>
                <span className="inv__price">
                  <input
                    className={`input num ${belowFloor ? 'is-warn' : ''}`}
                    inputMode="decimal"
                    placeholder={g.floor !== null ? String(g.floor) : 'WAX'}
                    value={pick.price}
                    onChange={(e) => setPick(g, { price: e.target.value.replace(/[^\d.]/g, '') })}
                  />
                  <small className="faint">WAX{belowFloor ? ' · under the floor' : ''}</small>
                </span>
                <span className="inv__listed">
                  {g.listed.map((l) => (
                    <button
                      key={l.saleId}
                      type="button"
                      className="mk-link"
                      disabled={spectating || pending === `cancel-${l.saleId}`}
                      title="Take this listing off the market"
                      onClick={() => void cancel(l.saleId, g.name)}
                    >
                      {formatNumber(l.price, 2)} WAX ×
                    </button>
                  ))}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {groups.length > 0 && (
        <footer className="inv__foot panel panel--tight">
          <span className="muted">
            {sales.length ? (
              <>
                <b className="num">{sales.length}</b> listing{sales.length === 1 ? '' : 's'} for{' '}
                <b className="num">{formatNumber(total, 2)} WAX</b> in all. Two actions per sale, ten to a transaction, signed one
                after another. AtomicMarket and the collection take their fees when something sells.
              </>
            ) : unpriced ? (
              'Give the picked NFTs a price.'
            ) : (
              'Pick how many of a template to sell, and a price each.'
            )}
          </span>
          <Button color="gradientYellow" disabled={!sales.length || spectating} isLoading={pending === 'list'} onClick={list}>
            List {sales.length || ''} for sale
          </Button>
        </footer>
      )}
    </section>
  )
}
