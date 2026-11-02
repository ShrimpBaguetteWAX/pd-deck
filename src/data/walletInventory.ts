import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import { atomic, type BuyOffer } from '@/chain/atomic'

/*
 * Everything in a wallet, from every collection, grouped by template: how many are held, the best
 * open buy offer for one (a template buy offer, or an offer made on one of these very NFTs), and the
 * cheapest listing on AtomicMarket. NFTs without a template are left out: they have no offers or
 * listings to compare.
 */

export interface InventoryRow {
  templateId: string
  name: string
  img: string
  collection: string
  schema: string
  assetIds: string[]
  /** Best open buy offer for one, in WAX, and whether it is on a specific NFT of yours. */
  offer: number | null
  offerOnAsset: boolean
  /** That offer, to accept it. */
  best: BuyOffer | null
  /** NFTs of this kind that can be sold now: transferable and not listed for sale. */
  sellable: string[]
  /** Cheapest WAX listing on AtomicMarket. */
  listing: number | null
}

async function fetchInventory(account: string): Promise<InventoryRow[]> {
  const assets = await atomic.getAllOwnedAssets(account)
  const rows = new Map<string, InventoryRow>()
  // NFTs that cannot change hands.
  const locked = new Set(assets.filter((a) => a.is_transferable === false).map((a) => String(a.asset_id)))
  for (const a of assets) {
    const t = a.template?.template_id
    if (!t) continue
    const row = rows.get(t)
    if (row) {
      row.assetIds.push(String(a.asset_id))
      continue
    }
    rows.set(t, {
      templateId: String(t),
      name: typeof a.data.name === 'string' ? a.data.name : `#${t}`,
      img: typeof a.data.img === 'string' ? a.data.img : '',
      collection: a.collection.collection_name,
      schema: a.schema.schema_name,
      assetIds: [String(a.asset_id)],
      offer: null,
      offerOnAsset: false,
      best: null,
      sellable: [],
      listing: null
    })
  }
  const ids = [...rows.keys()]
  const [templateOffers, assetOffers, listings, ownSales] = await Promise.all([
    atomic.getTemplateBuyofferTops(ids, account),
    atomic.getAssetBuyofferTops(account).catch(() => new Map<string, BuyOffer>()),
    atomic.getCheapestListings(ids),
    atomic.getSales({ seller: account }).catch(() => [])
  ])
  // NFTs already listed sit in an offer to the market: they cannot be sold to a buy offer too.
  const listed = new Set(ownSales.flatMap((sale) => sale.assets.map((x) => String(x.asset_id))))
  for (const row of rows.values()) {
    row.sellable = row.assetIds.filter((id) => !listed.has(id) && !locked.has(id))
    row.best = templateOffers.get(row.templateId) ?? null
    for (const id of row.assetIds) {
      const o = assetOffers.get(id)
      if (o && o.wax > (row.best?.wax ?? 0) && !listed.has(id) && !locked.has(id)) row.best = o
    }
    row.offer = row.best?.wax ?? null
    row.offerOnAsset = row.best?.kind === 'asset'
    row.listing = listings.get(row.templateId) ?? null
  }
  return [...rows.values()].sort((a, b) => (b.offer ?? -1) - (a.offer ?? -1) || (b.listing ?? 0) - (a.listing ?? 0))
}

export function useWalletInventory(account: string | null): UseQueryResult<InventoryRow[]> {
  return useQuery({
    queryKey: ['wallet-inventory', account],
    queryFn: () => fetchInventory(account!),
    enabled: !!account,
    staleTime: 5 * 60_000
  })
}
