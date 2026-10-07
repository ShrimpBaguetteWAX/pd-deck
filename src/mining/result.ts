import { getTransactionActions } from '@/chain/history'
import { readMiner } from '@/data/mining'
import { sleep } from '@/lib/format'

/*
 * What a mine paid, from the chain's history, and whether it landed at all.
 */

interface LogMine {
  bounty?: string
  params?: { luck?: number }
}

/**
 * History nodes index a mine within about two seconds. Ask soon, then back off: about 10 s of
 * waiting in all, each lookup given a few seconds, so a slow node cannot keep the button busy.
 */
const POLL_DELAYS_MS = [1500, 1500, 2500, 4000]
const LOOKUP_TIMEOUT_MS = 4000

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([p, sleep(ms).then(() => null)]).catch(() => null)

/** The "You mined …" message for a mine, or null when history has nothing on it yet. */
export async function mineResultMessage(txId: string): Promise<string | null> {
  if (!txId) return null
  for (const delay of POLL_DELAYS_MS) {
    await sleep(delay)
    const actions = await withTimeout(getTransactionActions(txId), LOOKUP_TIMEOUT_MS)
    const data = actions?.find((a) => a.act.name === 'logmine' && (a.act.data as LogMine).bounty)?.act.data as LogMine | undefined
    if (data?.bounty) {
      const shards = data.params?.luck ?? 0
      return shards > 0 ? `You mined ${data.bounty} & ${shards / 10} Shards` : `You mined ${data.bounty}`
    }
  }
  return null
}

/**
 * Did the mine land? The contract stamps the transaction it mined with on the miner row, so the
 * row answers when history is silent. Asked twice: reads rotate across nodes, and one a block or
 * two behind would otherwise have a good mine reported as lost.
 */
export async function mineLanded(account: string, txId: string): Promise<boolean> {
  const wanted = txId.toLowerCase()
  for (const delay of [0, 2500]) {
    if (delay) await sleep(delay)
    try {
      const miner = await readMiner(account)
      if (miner?.last_mine_tx?.toLowerCase() === wanted) return true
    } catch {
      // The row could not be read at all: leave the mine alone rather than call it a failure.
      return true
    }
  }
  return false
}
