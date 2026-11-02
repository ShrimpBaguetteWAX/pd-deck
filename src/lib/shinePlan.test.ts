import { describe, expect, it } from 'vitest'

import type { AscensionConfig } from '@/data/ascension'
import type { Listing } from '@/data/market'

import { ascendPath, buyFragments, fragmentsFor, type FragmentOffer } from './shinePlan'

const cfg: AscensionConfig = {
  paused: false,
  yields: new Map(),
  costs: new Map([
    ['epic:0', 5],
    ['epic:1', 10],
    ['epic:2', 20]
  ]),
  next: new Map([
    ['a0', 'a1'],
    ['a1', 'a2'],
    ['a2', 'a3']
  ])
}

const offer = (price: number, fragments: number): FragmentOffer => ({
  listing: { price } as Listing,
  fragments,
  sacrifice: fragments !== 1
})

describe('shine plan', () => {
  it('follows a card up its stars', () => {
    expect(ascendPath('a0', cfg.next)).toEqual(['a1', 'a2', 'a3'])
    expect(ascendPath('a2', cfg.next)).toEqual(['a3'])
    expect(ascendPath('x', cfg.next)).toEqual([])
  })

  it('adds up the Fragments per star', () => {
    expect(fragmentsFor(cfg, 'Epic', 0, 2)).toBe(15)
    expect(fragmentsFor(cfg, 'epic', 1, 2)).toBe(30)
    expect(fragmentsFor(cfg, 'epic', 2, 2)).toBeNull()
  })

  it('buys the cheapest Fragments, without a big card for the last one', () => {
    // A card of 3 at 9 WAX is 3 per Fragment, cheaper than Fragments at 4: take it, then one Fragment.
    const offers = [offer(9, 3), offer(9, 3), offer(4, 1), offer(4.5, 1)]
    const buy = buyFragments(4, offers)
    expect(buy.wax).toBe(13)
    expect(buy.sacrificed).toBe(1)
    expect(buy.boughtFragments).toBe(1)
    expect(buy.short).toBe(false)
  })

  it('says when the market runs out', () => {
    const buy = buyFragments(10, [offer(4, 1), offer(5, 1)])
    expect(buy.short).toBe(true)
    expect(buy.fragments).toBe(2)
  })
})
