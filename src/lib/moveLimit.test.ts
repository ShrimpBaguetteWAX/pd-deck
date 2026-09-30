import { expect, it } from 'vitest'

import { solveBundle, type Candidate, type SolveInput } from './bundle'
import { bruteForce, economy, rng } from './bundle.testkit'

it('keeps within the move limit and stays close to the true optimum', () => {
  const kinds = ['mercenary', 'mercenary', 'mercenary', 'weapon', 'supply', 'creature'] as const
  let feasible = 0
  let found = 0
  let exact = 0
  let worst = 0
  for (let seed = 1; seed <= 200; seed++) {
    const r = rng(seed)
    const items: Candidate[] = Array.from({ length: 11 }, (_, i) => {
      const kind = kinds[Math.floor(r() * kinds.length)]
      return {
        key: `i${i}`,
        kind,
        group: `t${i}`,
        atk: Math.floor(r() * 300) + 5,
        def: Math.floor(r() * 300) + 5,
        move: kind === 'mercenary' ? Math.floor(r() * 90) + 10 : 0,
        moveReduction: kind === 'supply' ? Math.floor(r() * 30) : 0,
        minLevel: 0,
        cost: Math.floor(r() * 900) + 10
      }
    })
    const base: SolveInput = {
      atk: Math.floor(r() * 700) + 50,
      def: 0,
      warlords: [
        { key: 'a', slots: 1, minLevel: 0, cost: 0 },
        { key: 'b', slots: 4, minLevel: 0, cost: Math.floor(r() * 300) }
      ],
      items,
      economy: economy({ weapon: 2, supply: 2, lavalux: 0 }, Math.floor(r() * 80) + 5, Math.floor(r() * 150) + 20)
    }
    const free = solveBundle(base)
    if (!free || free.move < 20) continue
    // A limit the unlimited answer breaks, so the search has to work for it.
    const input = { ...base, maxMove: Math.floor(free.move * 0.7) }
    const best = bruteForce(input)
    const got = solveBundle(input)
    if (got) {
      expect(got.move).toBeLessThanOrEqual(input.maxMove)
      expect(got.atk).toBeGreaterThanOrEqual(input.atk)
    }
    if (!Number.isFinite(best)) {
      expect(got).toBeNull()
      continue
    }
    feasible++
    if (!got) continue
    found++
    if (Math.abs(got.cost - best) < 1e-6) exact++
    worst = Math.max(worst, got.cost / best - 1)
  }
  // Pricing move is not exact on its own; with the repair step it misses almost nothing.
  expect(feasible).toBeGreaterThan(100)
  expect(found / feasible).toBeGreaterThan(0.97)
  expect(exact / found).toBeGreaterThan(0.85)
  expect(worst).toBeLessThan(0.5)
})
