import type { AnyAction } from '@wharfkit/session'

import { CONTRACTS } from '@/chain/config'

/** The AtomicMarket contract every listing lives on. */
export const ATOMICMARKET = 'atomicmarket'

export interface SaleToBuy {
  saleId: string
  assetId: string
  /** Raw listing price in the token's smallest unit (WAX: 8 decimals), as the API gives it. */
  listingPrice: string
}

/** 12345678901 raw units -> "123.45678901 WAX", exact (no floating point). */
export function waxAsset(raw: bigint): string {
  const whole = raw / 100_000_000n
  const frac = (raw % 100_000_000n).toString().padStart(8, '0')
  return `${whole}.${frac} WAX`
}

/**
 * Buys WAX-priced listings the way AtomicHub does: every sale is asserted first (the purchase
 * fails if the seller changed the price or the assets in the meantime), the total is deposited
 * once, then each sale is purchased. Everything lands in one transaction, so it all goes through
 * or nothing does.
 */
export function buySalesActions(account: string, permission: string, sales: SaleToBuy[]): AnyAction[] {
  const auth = [{ actor: account, permission }]
  const total = sales.reduce((n, s) => n + BigInt(s.listingPrice), 0n)
  return [
    ...sales.map((s): AnyAction => ({
      account: ATOMICMARKET,
      name: 'assertsale',
      authorization: auth,
      data: {
        sale_id: s.saleId,
        asset_ids_to_assert: [s.assetId],
        listing_price_to_assert: waxAsset(BigInt(s.listingPrice)),
        settlement_symbol_to_assert: '8,WAX'
      }
    })),
    {
      account: 'eosio.token',
      name: 'transfer',
      authorization: auth,
      data: { from: account, to: ATOMICMARKET, quantity: waxAsset(total), memo: 'deposit' }
    },
    ...sales.map((s): AnyAction => ({
      account: ATOMICMARKET,
      name: 'purchasesale',
      authorization: auth,
      data: { buyer: account, sale_id: s.saleId, intended_delphi_median: 0, taker_marketplace: '' }
    }))
  ]
}

/** The NFTs just bought arrive in the same transaction, so they can be staked right after. */
export const stakeBoughtAction = (account: string, permission: string, assetIds: string[]): AnyAction => ({
  account: CONTRACTS.ATOMICASSETS,
  name: 'transfer',
  authorization: [{ actor: account, permission }],
  data: { from: account, to: CONTRACTS.CORE, asset_ids: assetIds, memo: 'stake' }
})
