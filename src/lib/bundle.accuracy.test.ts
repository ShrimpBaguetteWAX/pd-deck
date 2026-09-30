import { expect, it } from 'vitest'
import { solveBundle, type Candidate, type SolveInput } from './bundle'
import { bruteForce, economy } from './bundle.testkit'

function rng(seed: number) {
  let s = seed
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296), s / 4294967296)
}

it('accuracy over 300 random two-stat cases', () => {
  let worst = 0
  let exact = 0
  let total = 0
  let wrong = 0
  for (let seed = 1; seed <= 300; seed++) {
    const r = rng(seed)
    const kinds = ['mercenary', 'mercenary', 'mercenary', 'weapon', 'supply', 'creature'] as const
    const items: Candidate[] = Array.from({ length: 11 }, (_, i) => {
      const kind = kinds[Math.floor(r() * kinds.length)]
      return {
        key: `i${i}`,
        kind,
        group: `t${i}`,
        atk: Math.floor(r() * 300) + 5,
        def: Math.floor(r() * 300) + 5,
        move: 20,
        moveReduction: 0,
        minLevel: 0,
        cost: Math.floor(r() * 900) + 10
      }
    })
    const input: SolveInput = {
      atk: Math.floor(r() * 900) + 50,
      def: Math.floor(r() * 900) + 50,
      warlords: [
        { key: 'a', slots: 1, minLevel: 0, cost: 0 },
        { key: 'b', slots: 4, minLevel: 0, cost: Math.floor(r() * 300) }
      ],
      items,
      economy: economy(
        { weapon: Math.floor(r() * 3), supply: Math.floor(r() * 2), lavalux: 0 },
        Math.floor(r() * 80) + 5,
        Math.floor(r() * 150) + 20
      )
    }
    const best = bruteForce(input)
    const got = solveBundle(input)
    // Feasibility must always agree with the brute force: no missed bundle, no invented one.
    if (!Number.isFinite(best) || !got) {
      if (Number.isFinite(best) !== !!got) wrong++
      continue
    }
    total++
    if (got.cost === best) exact++
    worst = Math.max(worst, got.cost / best - 1)
  }
  // Grid rounding may cost a little on bundles that meet a target by a point or two; never feasibility.
  expect(wrong).toBe(0)
  expect(exact / total).toBeGreaterThan(0.95)
  expect(worst).toBeLessThan(0.15)
})
