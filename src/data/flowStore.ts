import { useEffect, useState } from 'react'

import { CONTRACTS } from '@/chain/config'
import { getActionsPage, HISTORY_PAGE, timesRun, type HistoryAction } from '@/chain/history'
import { getRows } from '@/chain/rpc'
import { parseAsset } from '@/lib/format'
import { dayKey, dayOf, FLOW_ACCOUNTS, nextDay, REWARD_POOL, type FlowTransfer } from '@/lib/flow'

/*
 * The TLM flow's data: every TLM transfer of the PD contracts over the days asked for. History is
 * read gently: one request at a time with a pause between them (the history nodes rate-limit),
 * a page of 1 000 transfers each, walking forward in time. Finished days are kept in this browser
 * (IndexedDB), so a second visit only reads today and whatever is missing.
 */

/** Pause between two history requests. */
const GAP_MS = 700
/** A day counts as finished (safe to keep) this long after it ended: history nodes lag a little. */
const SETTLE_MS = 15 * 60_000

// ---- IndexedDB: one record per finished day, its transfers ------------------------------------

const DB = 'pd-flow'
const STORE = 'days'
let dbp: Promise<IDBDatabase | null> | null = null
function db(): Promise<IDBDatabase | null> {
  dbp ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbp
}
async function readDay(key: string): Promise<FlowTransfer[] | undefined> {
  const d = await db()
  if (!d) return undefined
  return new Promise((resolve) => {
    const req = d.transaction(STORE).objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result as FlowTransfer[] | undefined)
    req.onerror = () => resolve(undefined)
  })
}
async function writeDays(days: Map<string, FlowTransfer[]>) {
  const d = await db()
  if (!d) return
  await new Promise<void>((resolve) => {
    const tx = d.transaction(STORE, 'readwrite')
    for (const [k, v] of days) tx.objectStore(STORE).put(v, k)
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
  })
}

/** Days already read this session, so switching ranges back and forth costs nothing. */
const memory = new Map<string, FlowTransfer[]>()

// ---- Reading the history ----------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const iso = (t: number) => new Date(t).toISOString()

function toTransfer(a: HistoryAction): FlowTransfer | null {
  const d = a.act.data
  const q = parseAsset(String(d.quantity ?? ''))
  if (q.symbol !== 'TLM' || !(q.amount > 0)) return null
  const times = timesRun(a)
  const t = Date.parse(a['@timestamp'].endsWith('Z') ? a['@timestamp'] : `${a['@timestamp']}Z`)
  return {
    t,
    gs: Number(a.global_sequence ?? 0),
    from: String(d.from ?? ''),
    to: String(d.to ?? ''),
    amount: q.amount * times,
    times,
    memo: String(d.memo ?? ''),
    trx: a.trx_id
  }
}

export interface FlowProgress {
  /** 0–1 */
  share: number
  label: string
}

/**
 * Reads [from, to) for every flow account, page after page, pausing between requests. `onPage`
 * reports how far it got; `alive` stops it when the page has moved on.
 */
async function readSpan(
  from: number,
  to: number,
  onProgress: (share: number, label: string) => void,
  alive: () => boolean
): Promise<FlowTransfer[]> {
  const seen = new Set<number>()
  const out: FlowTransfer[] = []
  for (let i = 0; i < FLOW_ACCOUNTS.length; i++) {
    const account = FLOW_ACCOUNTS[i]
    let cursor = from
    for (;;) {
      if (!alive()) return out
      const page = await getActionsPage(account, {
        filter: `${CONTRACTS.TLM}:transfer`,
        after: iso(cursor),
        before: iso(to)
      })
      await sleep(GAP_MS)
      let last = cursor
      for (const a of page) {
        const x = toTransfer(a)
        const t = Date.parse(a['@timestamp'].endsWith('Z') ? a['@timestamp'] : `${a['@timestamp']}Z`)
        if (t > last) last = t
        if (!x || seen.has(x.gs)) continue
        seen.add(x.gs)
        out.push(x)
      }
      const covered = Math.min(1, (last - from) / Math.max(1, to - from))
      onProgress(
        (i + (page.length < HISTORY_PAGE ? 1 : covered)) / FLOW_ACCOUNTS.length,
        `${account} · ${new Date(last).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
      )
      // A short page is the end; a full one carries on from its last moment (the same moment
      // may hold more transfers, which the seen-set keeps from counting twice).
      if (page.length < HISTORY_PAGE || last <= cursor) break
      cursor = last
    }
  }
  return out
}

/** The reward pool's TLM balance now. */
async function poolBalance(): Promise<number | null> {
  try {
    const rows = await getRows<{ balance: string }>({ code: CONTRACTS.TLM, table: 'accounts', scope: REWARD_POOL })
    const hit = rows.map((r) => parseAsset(r.balance)).find((a) => a.symbol === 'TLM')
    return hit?.amount ?? 0
  } catch {
    return null
  }
}

export interface FlowData {
  transfers: FlowTransfer[]
  poolNow: number | null
  loading: boolean
  progress: FlowProgress | null
  error: string | null
  /** The first day the data covers. */
  from: number
}

/**
 * Every TLM transfer of the PD contracts from `from` to now. Kept and finished days come from the
 * browser; the rest is read, gently, with progress reported as it goes.
 */
export function useFlowData(from: number, round: number): FlowData {
  const [state, setState] = useState<FlowData>({ transfers: [], poolNow: null, loading: true, progress: null, error: null, from })
  useEffect(() => {
    let live = true
    const alive = () => live
    void (async () => {
      setState((s) => ({ ...s, loading: true, error: null, progress: { share: 0, label: 'Opening what this browser kept' } }))
      const now = Date.now()
      const days: number[] = []
      for (let d = dayOf(from); d <= now; d = nextDay(d)) days.push(d)
      // What is kept, then the spans still to read (today is always read again).
      const have = new Map<string, FlowTransfer[]>()
      for (const d of days) {
        const k = dayKey(d)
        const finished = nextDay(d) + SETTLE_MS < now
        if (!finished || round > 0) continue
        const m = memory.get(k) ?? (await readDay(k))
        if (m) {
          have.set(k, m)
          memory.set(k, m)
        }
      }
      const spans: [number, number][] = []
      for (const d of days) {
        if (have.has(dayKey(d))) continue
        const last = spans.at(-1)
        if (last && last[1] === d) last[1] = nextDay(d)
        else spans.push([d, nextDay(d)])
      }
      const total = spans.reduce((n, [a, b]) => n + (b - a), 0)
      let doneMs = 0
      const fresh: FlowTransfer[] = []
      try {
        for (const [a, b] of spans) {
          const end = Math.min(b, now)
          const got = await readSpan(
            a,
            end,
            (share, label) =>
              alive() &&
              setState((s) => ({
                ...s,
                progress: { share: (doneMs + share * (b - a)) / Math.max(1, total), label: `Reading ${label}` }
              })),
            alive
          )
          if (!alive()) return
          fresh.push(...got)
          doneMs += b - a
          // Keep the finished days of this span.
          const byDay = new Map<string, FlowTransfer[]>()
          for (let d = a; d < b; d = nextDay(d)) if (nextDay(d) + SETTLE_MS < now) byDay.set(dayKey(d), [])
          for (const x of got) byDay.get(dayKey(x.t))?.push(x)
          for (const [k, v] of byDay) memory.set(k, v)
          void writeDays(byDay)
        }
        const poolNow = await poolBalance()
        if (!alive()) return
        const transfers = [...[...have.values()].flat(), ...fresh].sort((x, y) => x.t - y.t)
        setState({ transfers, poolNow, loading: false, progress: null, error: null, from })
      } catch (err) {
        if (!alive()) return
        setState((s) => ({ ...s, loading: false, progress: null, error: err instanceof Error ? err.message : String(err) }))
      }
    })()
    return () => {
      live = false
    }
  }, [from, round])

  return state
}
