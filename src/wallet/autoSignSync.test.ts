import { describe, expect, it } from 'vitest'

import { isAuthorityError, reconcile } from './autoSignSync'

describe('reconcile', () => {
  const chain = { keys: ['PUB_K1_a', 'PUB_K1_b'], links: ['miss.pdef::join'] }

  it('keeps a key the permission still holds, with the actions linked on the chain', () => {
    expect(reconcile('PUB_K1_b', chain)).toEqual({ active: true, exists: true, links: ['miss.pdef::join'] })
  })

  it('drops a key another browser took away', () => {
    expect(reconcile('PUB_K1_gone', chain).active).toBe(false)
  })

  it('knows when auto-sign is off on the account', () => {
    expect(reconcile('PUB_K1_a', null)).toEqual({ active: false, exists: false, links: [] })
  })
})

describe('isAuthorityError', () => {
  it('spots the chain turning down who signed, not what was asked', () => {
    expect(
      isAuthorityError(new Error('transaction declares authority but does not have signatures for it: unsatisfied_authorization'))
    ).toBe(true)
    expect(isAuthorityError({ json: { error: { name: 'irrelevant_auth_exception' } } })).toBe(true)
    expect(isAuthorityError(new Error('assertion failure with message: division is locked'))).toBe(false)
  })
})
