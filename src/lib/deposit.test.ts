import { describe, expect, it } from 'vitest'

import { CONTRACTS } from '@/chain/config'

import { coveredBy, quantityOf, walletCosts, walletPart } from './deposit'

describe('game balance', () => {
  it('pays a token from the deposit only when it covers all of it', () => {
    const covered = coveredBy({ tlm: 10, def: 2 }, { tlm: 12, def: 1 })
    expect(covered).toEqual({ tlm: true, def: false })
    expect(walletPart({ tlm: 10, def: 2 }, covered)).toEqual({ tlm: 0, def: 2 })
    const costs = [
      { contract: CONTRACTS.TLM, quantity: '10.0000 TLM' },
      { contract: CONTRACTS.DEF, quantity: '2.00000000 DEF' }
    ]
    expect(walletCosts(costs, covered)).toEqual([costs[1]])
  })

  it('pays nothing from the deposit when nothing is due or nothing is known', () => {
    expect(coveredBy({ tlm: 0, def: 0 }, { tlm: 5, def: 5 })).toEqual({ tlm: false, def: false })
    expect(coveredBy({ tlm: 1, def: 0 }, null)).toEqual({ tlm: false, def: false })
  })

  it('writes quantities with each token’s decimals', () => {
    expect(quantityOf(1.5, 'TLM')).toBe('1.5000 TLM')
    expect(quantityOf(0.02, 'DEF')).toBe('0.02000000 DEF')
  })
})
