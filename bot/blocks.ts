/*
 * Follows the chain block by block through the trace API: every new block is fetched (about two a
 * second) and the swap logs of Alcor and Taco in it are decoded with the contracts' own ABIs. That
 * shows a swap about a second after it happened, against several seconds through the history nodes.
 */

import { ABI, Serializer } from '@wharfkit/antelope'

import { poolHead, poolTraceBlock, type EndpointPool } from './endpoints.ts'

/** A swap log, in the same shape the history nodes give, so both feeds share one handler. */
export interface FeedAction {
  '@timestamp': string
  global_sequence: string
  trx_id: string
  act: { account: string; name: string; data: Record<string, unknown> }
}

/** The logs the bot reads: swaps and liquidity changes of both exchanges. */
const WANTED: Record<string, Set<string>> = {
  'swap.alcor': new Set(['logswap', 'logmint', 'logburn']),
  'swap.taco': new Set(['exchangelog', 'liquiditylog'])
}

/** How long to wait before asking again for a block that is not out yet. */
const WAIT_MS = 200
/** Never fall further behind than this many blocks: jump to the head instead. */
const MAX_BEHIND = 20
/** How often, while waiting for a block, the head is checked for having fallen behind. */
const HEAD_CHECK_MS = 3000

export class BlockFollower {
  private abis = new Map<string, ABI>()
  private next = 0
  private headCheckedAt = 0
  private running = false
  /** The newest block handled, and when. */
  block = 0
  blockTime = 0
  handledAt = 0
  /** Blocks handled and blocks skipped (when it had to catch up). */
  blocks = 0
  skipped = 0
  failures = 0

  private pool: EndpointPool
  private rpc: (path: string, body: unknown) => Promise<unknown>
  private onActions: (actions: FeedAction[], block: number) => void
  /** Called for every request, so the page can count them. */
  onRequest: (kind: string) => void = () => {}

  constructor(
    pool: EndpointPool,
    rpc: (path: string, body: unknown) => Promise<unknown>,
    onActions: (actions: FeedAction[], block: number) => void
  ) {
    this.pool = pool
    this.rpc = rpc
    this.onActions = onActions
  }

  /** True while blocks arrive: the bot then needs no other feed. */
  get healthy() {
    return this.running && Date.now() - this.handledAt < 5000
  }

  /** Seconds between a block being made and this bot handling it, for the last block. */
  get lagSec() {
    return this.blockTime ? Math.max(0, (this.handledAt - this.blockTime) / 1000) : 0
  }

  private async abiOf(account: string): Promise<ABI> {
    const hit = this.abis.get(account)
    if (hit) return hit
    const res = (await this.rpc('/v1/chain/get_abi', { account_name: account })) as { abi: unknown }
    const abi = ABI.from(res.abi as ABI)
    this.abis.set(account, abi)
    return abi
  }

  start() {
    if (this.running) return
    this.running = true
    void this.loop()
  }

  stop() {
    this.running = false
  }

  private async loop() {
    while (this.running) {
      try {
        if (!this.next) {
          this.onRequest('head')
          this.next = await poolHead(this.pool)
        }
        this.onRequest('block')
        const block = await poolTraceBlock(this.pool, this.next)
        if (!block) {
          // Not out yet. Only every few seconds: check whether we fell far behind (a node outage) and
          // jump to the head if so; usually the block simply comes on the next try.
          if (Date.now() - this.headCheckedAt > HEAD_CHECK_MS) {
            this.headCheckedAt = Date.now()
            this.onRequest('head')
            const head = await poolHead(this.pool).catch(() => this.next)
            if (head - this.next > MAX_BEHIND) {
              this.skipped += head - this.next
              this.next = head
            }
          }
          await sleep(WAIT_MS)
          continue
        }
        await this.handle(block)
        this.next++
        this.failures = 0
      } catch {
        this.failures++
        await sleep(Math.min(5000, 300 * this.failures))
      }
    }
  }

  private async handle(block: Awaited<ReturnType<typeof poolTraceBlock>> & object) {
    const out: FeedAction[] = []
    for (const tx of block.transactions ?? []) {
      for (const a of tx.actions ?? []) {
        // Each log once: where the contract itself received it.
        if (a.receiver !== a.account || !WANTED[a.account]?.has(a.action)) continue
        const abi = await this.abiOf(a.account)
        const decoded = Serializer.decode({ data: a.data, type: a.action, abi })
        out.push({
          '@timestamp': block.timestamp.replace(/Z$/, ''),
          global_sequence: String(a.global_sequence),
          trx_id: tx.id,
          act: { account: a.account, name: a.action, data: Serializer.objectify(decoded) as Record<string, unknown> }
        })
      }
    }
    this.block = block.number
    this.blockTime = Date.parse(block.timestamp.endsWith('Z') ? block.timestamp : block.timestamp + 'Z')
    this.handledAt = Date.now()
    this.blocks++
    if (out.length) this.onActions(out, block.number)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
