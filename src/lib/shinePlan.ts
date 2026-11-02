import { FRAGMENT_TEMPLATE } from '@/chain/config'
import { costKey, expectedYield, type AscensionConfig } from '@/data/ascension'
import type { Listing } from '@/data/market'

import type { Market } from './blendEconomy'

/*
 * The shine planner's sums: how far a card can still ascend and what each star costs in Fragments,
 * and the cheapest way to get the Fragments on the market: buying Fragments, or buying cards to
 * sacrifice at the altar for theirs (counted at their expected yield), whichever is cheaper per
 * Fragment, one listing at a time.
 */

/** The templates a card ascends through, one per star still to earn. */
export function ascendPath(templateId: string, next: Map<string, string>): string[] {
  const path: string[] = []
  const seen = new Set([templateId])
  for (let t = next.get(templateId); t && !seen.has(t); t = next.get(t)) {
    path.push(t)
    seen.add(t)
  }
  return path
}

/** Fragments to take a card of this rarity `steps` stars up from `fromStars`; null when a step has no price. */
export function fragmentsFor(cfg: AscensionConfig, rarity: string, fromStars: number, steps: number): number | null {
  let n = 0
  for (let i = 0; i < steps; i++) {
    const c = cfg.costs.get(costKey(rarity, fromStars + i))
    if (c === undefined) return null
    n += c
  }
  return n
}

export interface FragmentOffer {
  listing: Listing
  /** Fragments it brings: 1 for a Fragment, the expected yield for a card to sacrifice. */
  fragments: number
  sacrifice: boolean
}

/** Every listing that turns into Fragments, cheapest per Fragment first. */
export function fragmentOffers(market: Market, cfg: AscensionConfig): FragmentOffer[] {
  const offers: FragmentOffer[] = []
  for (const [templateId, list] of market.listings) {
    if (templateId === FRAGMENT_TEMPLATE) {
      for (const listing of list) offers.push({ listing, fragments: 1, sacrifice: false })
      continue
    }
    // Only the game's own playable cards go to the altar.
    if (!market.templates.has(templateId)) continue
    for (const listing of list) {
      if (!listing.kind) continue
      const y = cfg.yields.get(listing.asset.rarity.toLowerCase())
      const fragments = y ? expectedYield(y) : 0
      if (fragments > 0) offers.push({ listing, fragments, sacrifice: true })
    }
  }
  return offers.sort((a, b) => a.listing.price / a.fragments - b.listing.price / b.fragments)
}

export interface FragmentBuy {
  /** WAX for every listing bought. */
  wax: number
  /** Fragments that brings (sacrifices at their expected yield). */
  fragments: number
  boughtFragments: number
  sacrificed: number
  /** Whether the market holds fewer Fragments than needed. */
  short: boolean
  /** The listings to buy, cheapest pick first. */
  picks: FragmentOffer[]
}

/**
 * The cheapest listings that together bring at least `needed` Fragments. Each pick is the listing
 * cheapest for the Fragments still missing, so a big card is not bought for the last one or two.
 */
export function buyFragments(needed: number, offers: FragmentOffer[]): FragmentBuy {
  const out: FragmentBuy = { wax: 0, fragments: 0, boughtFragments: 0, sacrificed: 0, short: false, picks: [] }
  const left = [...offers]
  while (out.fragments < needed - 1e-9 && left.length) {
    const missing = needed - out.fragments
    let best = 0
    for (let i = 1; i < left.length; i++) {
      const cost = (o: FragmentOffer) => o.listing.price / Math.min(o.fragments, missing)
      if (cost(left[i]) < cost(left[best])) best = i
    }
    const [o] = left.splice(best, 1)
    out.picks.push(o)
    out.wax += o.listing.price
    out.fragments += o.fragments
    if (o.sacrifice) out.sacrificed++
    else out.boughtFragments++
  }
  out.short = out.fragments < needed - 1e-9
  return out
}
