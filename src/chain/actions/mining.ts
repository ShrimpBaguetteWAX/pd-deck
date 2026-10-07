import type { AnyAction } from '@wharfkit/session'

import { CONTRACTS } from '@/chain/config'

/*
 * Alien Worlds mining on m.federation. The player pays their own CPU (or the wallet does), so
 * any wallet may mine here, Anchor included. The `notify` field of `mine` is an optional
 * extension the game's own client uses; it is left out.
 */

const auth = (account: string, permission: string) => [{ actor: account, permission }]

export const mineAction = (account: string, permission: string, nonce: string): AnyAction => ({
  account: CONTRACTS.M_FEDERATION,
  name: 'mine',
  authorization: auth(account, permission),
  data: { miner: account, nonce }
})

export const setLandAction = (account: string, permission: string, landId: string): AnyAction => ({
  account: CONTRACTS.M_FEDERATION,
  name: 'setland',
  authorization: auth(account, permission),
  data: { account, land_id: landId }
})

/** One mine; with `landId`, the land is changed first in the same transaction. */
export function mineActions(account: string, permission: string, nonce: string, landId?: string): AnyAction[] {
  return landId
    ? [setLandAction(account, permission, landId), mineAction(account, permission, nonce)]
    : [mineAction(account, permission, nonce)]
}
