import { useMemo, useState } from 'react'

import { IpfsImg } from '@/components/Art'
import { Button } from '@/components/Button'
import { Loading } from '@/components/Loading'
import { Figure } from '@/components/Stat'
import { sellToBuyofferActions } from '@/chain/actions/market'
import { queryClient } from '@/data/queryClient'
import { useWalletInventory, type InventoryRow } from '@/data/walletInventory'
import { formatNumber } from '@/lib/format'
import { useSession } from '@/state/session'
import { useTransaction } from '@/wallet/useTransaction'

import './Inventory.css'

/*
 * Inventory: every NFT in the wallet, from every collection, by template, with the best open buy
 * offer for one and the cheapest listing on AtomicMarket, best offer first. NFTs staked in a game
 * are not in the wallet and do not show. Every row with an offer has a button to sell one NFT into
 * it (after a confirm); where the offer is at least 70% of the cheapest listing the row stands out.
 */

const PAGE = 150
const wax = (n: number | null) => (n === null ? '–' : formatNumber(n, n >= 100 ? 0 : 2))
/** Offer to listing at or above this stands out and can be sold from here. */
const HOT = 0.7
/** What AtomicMarket keeps on a sale besides the collection's cut: 1% each for the two marketplaces. */
const MARKET_CUT = 0.02
const ratioOf = (r: InventoryRow) => (r.offer !== null && r.listing ? r.offer / r.listing : null)

export default function Inventory() {
  const account = useSession((s) => s.account)
  const inventory = useWalletInventory(account)
  const [query, setQuery] = useState('')
  const [onlyOffers, setOnlyOffers] = useState(false)
  const [shown, setShown] = useState(PAGE)
  // The row whose sale is waiting for a confirm.
  const [confirming, setConfirming] = useState<string | null>(null)
  const { run, pending, spectating } = useTransaction()

  async function sell(r: InventoryRow) {
    const offer = r.best
    const assetId = offer?.kind === 'asset' ? offer.assetId : r.sellable[0]
    if (!offer || !assetId) return
    const ok = await run(
      (a, p) => sellToBuyofferActions(a, p, offer, assetId),
      `Sold 1 ${r.name} for ${wax(offer.wax)} WAX`,
      `sell-${r.templateId}`
    )
    setConfirming(null)
    if (ok) void queryClient.invalidateQueries({ queryKey: ['wallet-inventory', account] })
  }

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (inventory.data ?? []).filter(
      (r) =>
        (!onlyOffers || r.offer !== null) &&
        (!q || r.name.toLowerCase().includes(q) || r.collection.includes(q) || r.templateId === q)
    )
  }, [inventory.data, query, onlyOffers])

  if (!account) return <p className="muted">Sign in, or add ?as=account to the address.</p>
  if (inventory.isLoading) return <Loading inline label="Reading every NFT in the wallet, its offers and listings" />
  if (inventory.isError) return <p className="c-red">Could not read the inventory: {String(inventory.error)}</p>

  const all = inventory.data ?? []
  const nfts = all.reduce((n, r) => n + r.assetIds.length, 0)
  const withOffer = all.filter((r) => r.offer !== null)
  // Every NFT sold to the best offer for its template (several of one template still count that one offer each).
  const offerTotal = withOffer.reduce((n, r) => n + r.offer! * r.assetIds.length, 0)

  return (
    <div className="page inv">
      <header className="inv__top panel panel--tight">
        <Figure
          label="NFTs"
          value={formatNumber(nfts, 0)}
          help="NFTs in the wallet that have a template. Staked NFTs are not in the wallet."
        />
        <Figure label="Kinds" value={formatNumber(all.length, 0)} />
        <Figure label="With an offer" value={formatNumber(withOffer.length, 0)} tone="c-green" />
        <Figure
          label="Best offers, all"
          value={`${formatNumber(offerTotal, 0)} WAX`}
          tone="c-gold"
          help="Every NFT sold to the best open offer for its kind, at that price. A buyer's offer usually covers one NFT, so selling several of one kind would go lower."
        />
        <Button
          size="sm"
          color="ghost"
          className="inv__refresh"
          isLoading={inventory.isFetching}
          onClick={() => void inventory.refetch()}
        >
          Refresh
        </Button>
      </header>

      <div className="inv__bar">
        <input
          className="input inv__search"
          type="search"
          placeholder="Search name, collection or template id"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setShown(PAGE)
          }}
        />
        <label className="inv__toggle">
          <input type="checkbox" checked={onlyOffers} onChange={(e) => setOnlyOffers(e.target.checked)} /> Only with an offer
        </label>
        <span className="faint">{formatNumber(rows.length, 0)} shown, best offer first</span>
      </div>

      <div className="inv__table" role="table">
        <div className="inv__row inv__head" role="row">
          <span>NFT</span>
          <span className="num">Held</span>
          <span className="num">Best offer</span>
          <span className="num">Lowest listing</span>
          <span className="num">Offer / listing</span>
          <span />
        </div>
        {rows.slice(0, shown).map((r) => {
          const ratio = ratioOf(r)
          const hot = ratio !== null && ratio >= HOT
          const best = r.best
          const canSell = !!best && (best.kind === 'asset' ? !!best.assetId : r.sellable.length > 0)
          const net = best ? best.wax * (1 - best.collectionFee - MARKET_CUT) : 0
          return (
            <div key={r.templateId} className={`inv__row ${hot ? 'is-hot' : ''}`} role="row">
              <span className="inv__nft">
                <IpfsImg hash={r.img} size={370} loading="lazy" alt="" className="inv__img" />
                <span className="inv__name">
                  <a
                    href={`https://atomichub.io/explorer/template/wax-mainnet/${r.collection}/${r.templateId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {r.name}
                  </a>
                  <small className="faint">
                    {r.collection} · {r.schema} · #{r.templateId}
                  </small>
                </span>
              </span>
              <span className="num">{r.assetIds.length}</span>
              <span className={`num ${r.offer !== null ? 'c-green' : 'faint'}`}>
                {wax(r.offer)}
                {r.offer !== null && <small className="faint"> WAX{r.offerOnAsset ? ' · on yours' : ''}</small>}
              </span>
              <span className="num">
                {wax(r.listing)}
                {r.listing !== null && <small className="faint"> WAX</small>}
              </span>
              <span className={`num ${hot ? 'inv__ratio' : 'faint'}`}>
                {ratio !== null ? `${formatNumber(ratio * 100, 0)}%` : '–'}
              </span>
              <span className="inv__act">
                {best &&
                  (confirming === r.templateId ? (
                    <span className="inv__confirm">
                      <small>
                        Sell 1 for {wax(best!.wax)} WAX, you get about {wax(net)}
                      </small>
                      <Button
                        size="sm"
                        color="gradientYellow"
                        isLoading={pending === `sell-${r.templateId}`}
                        onClick={() => void sell(r)}
                      >
                        Confirm
                      </Button>
                      <Button
                        size="sm"
                        color="ghost"
                        disabled={pending === `sell-${r.templateId}`}
                        onClick={() => setConfirming(null)}
                      >
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      color="ghost"
                      disabled={!canSell || spectating || !!pending}
                      title={
                        spectating
                          ? 'Read-only while spectating.'
                          : !canSell
                            ? 'Every NFT of this kind is listed for sale or cannot be transferred.'
                            : `Sell one into the best offer: ${wax(best!.wax)} WAX`
                      }
                      onClick={() => setConfirming(r.templateId)}
                    >
                      Sell to offer
                    </Button>
                  ))}
              </span>
            </div>
          )
        })}
        {!rows.length && <p className="faint inv__empty">Nothing matches.</p>}
      </div>
      {rows.length > shown && (
        <Button color="ghost" className="inv__more" onClick={() => setShown((n) => n + PAGE)}>
          Show {Math.min(PAGE, rows.length - shown)} more
        </Button>
      )}
    </div>
  )
}
