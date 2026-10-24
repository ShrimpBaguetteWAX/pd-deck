import { describe, expect, it } from 'vitest'

import { aggregate, classify, PD_CONTRACTS, type FlowTransfer } from './flow'

const o = { contracts: new Set<string>(PD_CONTRACTS), aliensInside: true }
const tx = (from: string, to: string, amount: number, memo: string, t = Date.now()): FlowTransfer => ({
  t,
  gs: Math.random(),
  from,
  to,
  amount,
  times: 1,
  memo,
  trx: 'x'
})

describe('classify', () => {
  it('sorts money in, money out and transfers between PD contracts', () => {
    expect(classify(tx('a.wam', 'core.pdef', 10, 'deposit'), o)).toMatchObject({
      dir: 'in',
      category: 'deposit',
      account: 'a.wam'
    })
    expect(classify(tx('a.wam', 'miss.pdef', 1, 'entry:34'), o)?.category).toBe('entry')
    expect(classify(tx('team', 'miss.pdef', 1, 'Players Rewards'), o)?.category).toBe('fund')
    expect(classify(tx('miss.pdef', 'a.wam', 5, 'Mission division reward'), o)).toMatchObject({ dir: 'out', category: 'reward' })
    expect(classify(tx('core.pdef', 'miss.pdef', 1, 'Mission 34 entry'), o)?.dir).toBe('internal')
    expect(classify(tx('a.wam', 'b.wam', 1, ''), o)).toBeNull()
  })

  it('counts aliens.pdef as outside when asked to', () => {
    const out = { ...o, aliensInside: false }
    expect(classify(tx('siege.pdef', 'aliens.pdef', 3, 'siege entry planet 5'), o)?.dir).toBe('internal')
    expect(classify(tx('siege.pdef', 'aliens.pdef', 3, 'siege entry planet 5'), out)).toMatchObject({
      dir: 'out',
      category: 'aliens'
    })
  })
})

describe('aggregate', () => {
  it('adds up per day and walks the reward pool back from its balance now', () => {
    const d0 = new Date(2026, 9, 20).getTime()
    const d1 = new Date(2026, 9, 21).getTime()
    const list = [
      tx('a.wam', 'miss.pdef', 100, 'entry:1', d0 + 3600_000),
      tx('miss.pdef', 'a.wam', 30, 'Mission division reward', d0 + 7200_000),
      tx('miss.pdef', 'b.wam', 50, 'Mission division reward', d1 + 3600_000)
    ]
    const bs = aggregate(list, { ...o, from: d0, to: d1, week: false, showInternal: false, account: '', poolNow: 1000 })
    expect(bs.map((b) => [b.inSum, b.outSum])).toEqual([
      [100, 30],
      [0, 50]
    ])
    // End of day 1: 1000 now (nothing after). End of day 0: the 50 paid on day 1 was still there.
    expect(bs.map((b) => b.pool)).toEqual([1050, 1000])
  })
})
