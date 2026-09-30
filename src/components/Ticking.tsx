import type { ReactNode } from 'react'

import { useNow } from '@/lib/time'

interface TickingProps {
  /** What to show at `now`, e.g. a countdown label. */
  render: (now: number) => ReactNode
  intervalMs?: number
}

/**
 * Text that runs on its own clock: only this re-renders every tick, not the page around it.
 * The page decides readiness with `useClockFor`, which re-renders it only when that changes.
 */
export function Ticking({ render, intervalMs = 1000 }: TickingProps) {
  const now = useNow(intervalMs)
  return <>{render(now)}</>
}
