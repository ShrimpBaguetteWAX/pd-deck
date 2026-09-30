import { useSyncExternalStore } from 'react'

import { endpointPool, type PoolStatus } from '@/chain/endpoints'

let snapshot: PoolStatus = endpointPool.status()
const subscribers = new Set<() => void>()

endpointPool.subscribe((s) => {
  snapshot = s
  for (const fn of subscribers) fn()
})

function subscribe(fn: () => void) {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

/** Live view of which WAX nodes answered, and how fast. */
export function useNetwork(): PoolStatus {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot
  )
}

export function reprobe() {
  return endpointPool.probe(true)
}
