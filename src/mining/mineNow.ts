import { mineActions } from '@/chain/actions/mining'
import { toast } from '@/components/toast'
import { refreshPlayer } from '@/data/game'
import { readMiner, refreshMining, type EquippedTool } from '@/data/mining'
import { formatTransactError, isUserCancel, transact } from '@/wallet/session'

import { computeNonce } from './nonce'
import { mineLanded, mineResultMessage } from './result'

interface MineOptions {
  account: string
  permission: string
  tools: EquippedTool[] | undefined
  /** Mine on this land; ignored when it is the current land already. */
  landId?: string
}

/** Proof of work, sign, broadcast, then report what the mine paid. Resolves true on success. */
export async function mineNow({ account, permission, tools, landId }: MineOptions): Promise<boolean> {
  try {
    const miner = await readMiner(account)
    const difficulty = (tools ?? []).reduce((sum, tool) => sum + Number(tool.pow ?? 0), 0)
    const nonce = await computeNonce({ account, lastMineTx: miner?.last_mine_tx, difficulty })
    const target = landId && landId !== String(miner?.current_land) ? landId : undefined

    const txId = await transact(mineActions(account, permission, nonce, target))

    // Resolve only once the result is known and the cooldown data is fresh, so the button stays
    // busy until then instead of showing MINE again right after broadcasting.
    const paid = await mineResultMessage(txId)
    // A node can take a transaction and still never get it into a block: nothing is called a
    // success unless the chain agrees.
    const landed = !!paid || (await mineLanded(account, txId))
    await Promise.all([refreshMining(account), refreshPlayer(account)])
    if (!landed) {
      toast.error('The mine did not reach the chain. Nothing was spent, please try again.')
      return false
    }
    toast.success(paid ?? 'Mine successful')
    return true
  } catch (err) {
    if (!isUserCancel(err)) toast.error(formatTransactError(err))
    void refreshMining(account)
    return false
  }
}
