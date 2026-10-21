import { describe, expect, it } from 'vitest'

import { mineReadyAt, nextFavoriteUpgrade, pickFavoriteLand } from './estimates'
import type { EquippedTool, FavoriteLand } from './types'

const land = (asset_id: string, estimatedTlm: number, shards: number, delay = 10): FavoriteLand => ({
  asset_id,
  landName: asset_id,
  planet: 'eyeke',
  delay,
  estimatedTlm,
  shards
})
const tool = (delay: number, last_use = 0) => ({ delay, last_use, rarity: 'Common' }) as unknown as EquippedTool

describe('mineReadyAt', () => {
  it('scales the slowest tool fully and the second by half with two tools', () => {
    // Land delay 20 = 2x; tools 60 s and 40 s: 2 * (60 + 20) = 160 s after the last mine.
    expect(mineReadyAt(20, [tool(60), tool(40)], '2026-10-21T00:00:00')).toBe(Date.parse('2026-10-21T00:00:00Z') + 160_000)
  })
})

describe('pickFavoriteLand', () => {
  const lands = [land('a', 0.5, 1), land('b', 0.3, 4), land('c', 0.9, 2)]
  const readyAt = (l: FavoriteLand) => (l.asset_id === 'c' ? 1000 : 0)

  it('takes the ready land paying the most of the chosen kind', () => {
    expect(pickFavoriteLand(lands, readyAt, 'tlm', 500)?.asset_id).toBe('a')
    expect(pickFavoriteLand(lands, readyAt, 'shard', 500)?.asset_id).toBe('b')
  })

  it('names the better land still cooling, only once a mine is ready', () => {
    expect(nextFavoriteUpgrade(lands, readyAt, 'tlm', 500)).toEqual({ land: lands[2], at: 1000 })
    expect(nextFavoriteUpgrade(lands, readyAt, 'shard', 500)).toBeNull()
    expect(nextFavoriteUpgrade(lands, () => 1000, 'tlm', 500)).toBeNull()
  })
})
