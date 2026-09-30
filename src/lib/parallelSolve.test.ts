import { expect, it } from 'vitest'

import { buildAtCount, polish, scanCounts, solveBundle, type Bundle, type Candidate, type SolveInput } from './bundle'
import type { SolveTask } from './bundle.task.worker'
import { economy, rng } from './bundle.testkit'
import { solveBundleParallel } from './parallelSolve'
import type { SolverPool } from './solverPool'

/** A pool that runs every task in this thread, in whatever order the solver hands them out. */
function inlinePool(size: number): SolverPool {
  const run = (task: SolveTask | (() => SolveTask | null)) => {
    const t = typeof task === 'function' ? task() : task
    if (!t) return Promise.resolve(null)
    switch (t.type) {
      case 'scan':
        return Promise.resolve(scanCounts(t.input, t.ta, t.td, t.L, t.counts, t.bound))
      case 'build':
        return Promise.resolve(buildAtCount(t.input, t.ta, t.td, t.L, t.k))
      case 'polish':
        return Promise.resolve(polish(t.bundle, t.input))
    }
  }
  return { size, run } as unknown as SolverPool
}

it('the parallel search finds the same bundle cost as the sequential one', async () => {
  const kinds = ['mercenary', 'mercenary', 'mercenary', 'weapon', 'supply', 'creature'] as const
  let compared = 0
  for (let seed = 1; seed <= 200; seed++) {
    const r = rng(seed)
    const items: Candidate[] = Array.from({ length: 24 }, (_, i) => {
      const kind = kinds[Math.floor(r() * kinds.length)]
      return {
        key: `i${i}`,
        kind,
        group: `t${i % 9}`,
        atk: Math.floor(r() * 300) + 5,
        def: Math.floor(r() * 300) + 5,
        move: 20,
        moveReduction: 0,
        minLevel: r() < 0.15 ? 1 : 0,
        cost: Math.floor(r() * 900) + 10
      }
    })
    const oneStat = r() < 0.5
    const input: SolveInput = {
      atk: Math.floor(r() * 1500) + 50,
      def: oneStat ? 0 : Math.floor(r() * 900) + 50,
      warlords: [
        { key: 'a', slots: 2, minLevel: 0, cost: 0 },
        { key: 'b', slots: 6, minLevel: 0, cost: Math.floor(r() * 300) },
        { key: 'c', slots: 9, minLevel: 1, cost: Math.floor(r() * 300) }
      ],
      items,
      economy: economy(
        { weapon: Math.floor(r() * 3), supply: Math.floor(r() * 2), lavalux: 0 },
        Math.floor(r() * 80) + 5,
        Math.floor(r() * 150) + 20
      )
    }
    const seq = solveBundle(input)
    const par: Bundle | null = await solveBundleParallel(input, inlinePool(1 + (seed % 7)))
    expect(!!par).toBe(!!seq)
    if (seq && par) {
      expect(par.cost).toBeCloseTo(seq.cost, 6)
      compared++
    }
  }
  expect(compared).toBeGreaterThan(50)
})

it('the parallel search keeps within a move limit', async () => {
  let checked = 0
  for (let seed = 1; seed <= 60; seed++) {
    const r = rng(seed)
    const items: Candidate[] = Array.from({ length: 16 }, (_, i) => {
      const kind = (['mercenary', 'mercenary', 'supply', 'weapon'] as const)[Math.floor(r() * 4)]
      return {
        key: `i${i}`,
        kind,
        group: `t${i}`,
        atk: Math.floor(r() * 300) + 5,
        def: 0,
        move: kind === 'mercenary' ? Math.floor(r() * 90) + 10 : 0,
        moveReduction: kind === 'supply' ? Math.floor(r() * 30) : 0,
        minLevel: 0,
        cost: Math.floor(r() * 900) + 10
      }
    })
    const base: SolveInput = {
      atk: Math.floor(r() * 800) + 50,
      def: 0,
      warlords: [{ key: 'b', slots: 5, minLevel: 0, cost: 0 }],
      items,
      economy: economy({ weapon: 3, supply: 3, lavalux: 0 }, 20, 50)
    }
    const free = solveBundle(base)
    if (!free || free.move < 30) continue
    const input = { ...base, maxMove: Math.floor(free.move * 0.7) }
    const seq = solveBundle(input)
    const par = await solveBundleParallel(input, inlinePool(4))
    if (par) {
      expect(par.move).toBeLessThanOrEqual(input.maxMove)
      expect(par.atk).toBeGreaterThanOrEqual(input.atk)
    }
    if (seq && par) {
      expect(par.cost).toBeLessThanOrEqual(seq.cost * 1.25)
      checked++
    }
  }
  expect(checked).toBeGreaterThan(10)
})
