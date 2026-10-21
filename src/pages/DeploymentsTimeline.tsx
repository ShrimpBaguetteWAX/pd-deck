import type { Deployment } from '@/data/game'
import { useNow } from '@/lib/time'

/*
 * The Deployments timeline: a strip from now to the last return, one dot per return (returns too
 * close to tell apart share a dot), labelled with what lands there. Time runs on a square-root
 * scale, so the next hour, where most returns crowd, gets most of the room while a long mission
 * still fits. Tapping a dot picks its divisions in the list below.
 */

export interface TimelineItem {
  key: string
  deployment: Deployment
  /** TLM-equivalent of the reward, for the dot's label and size. */
  value: number
  label: string
}

interface Cluster {
  at: number
  keys: string[]
  value: number
  labels: string[]
  ready: boolean
}

/** Dots closer than this share one (a share of the strip's width). */
const MERGE = 0.03
/** A dot's label is left out when it would sit closer than this to a bigger one. */
const LABEL_GAP = 0.07
/** Clock ticks closer than this to each other (or to now) are left out. */
const TICK_GAP = 0.09
/** How far back the strip reaches before now. */
const LEAD_MS = 60_000

const STEPS_MIN = [15, 30, 60, 120, 240, 360, 720, 1440]

const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export function DeploymentTimeline({
  items,
  selected,
  onPick
}: {
  items: TimelineItem[]
  selected: Set<string>
  onPick: (keys: string[]) => void
}) {
  const now = useNow(15_000)
  if (!items.length) return null
  const begin = now - LEAD_MS
  const last = Math.max(...items.map((i) => i.deployment.unlockAt))
  const end = Math.max(last, now + 30 * 60_000) + (Math.max(last, now) - begin) * 0.04
  const span = end - begin
  const x = (t: number) => Math.sqrt(Math.min(1, Math.max(0, (t - begin) / span)))

  // Returns already in are drawn at "now"; the rest where they land, merged when they crowd.
  const clusters: Cluster[] = []
  for (const it of [...items].sort((a, b) => a.deployment.unlockAt - b.deployment.unlockAt)) {
    const at = Math.max(now, it.deployment.unlockAt)
    const ready = it.deployment.unlockAt <= now
    const prev = clusters.at(-1)
    if (prev && prev.ready === ready && x(at) - x(prev.at) < MERGE) {
      prev.keys.push(it.key)
      prev.value += it.value
      prev.labels.push(it.label)
    } else clusters.push({ at, keys: [it.key], value: it.value, labels: [it.label], ready })
  }

  // Clock ticks on round times, thinned where the scale squeezes them together.
  const ticks: number[] = []
  const offset = new Date().getTimezoneOffset() * 60_000
  let lastTick = x(now)
  for (const m of STEPS_MIN) {
    const step = m * 60_000
    for (let t = Math.ceil((begin - offset) / step) * step + offset; t < end; t += step) {
      if (ticks.includes(t) || x(t) - lastTick < TICK_GAP || x(t) > 0.97) continue
      if (ticks.some((u) => Math.abs(x(u) - x(t)) < TICK_GAP)) continue
      ticks.push(t)
    }
    lastTick = x(now)
  }
  ticks.sort((a, b) => a - b)
  // Labels where they fit, the biggest rewards first.
  const labelled = new Set<Cluster>()
  for (const c of [...clusters].sort((a, b) => b.value - a.value))
    if (c.value > 0 && [...labelled].every((o) => Math.abs(x(o.at) - x(c.at)) >= LABEL_GAP)) labelled.add(c)

  const pct = (t: number) => `${x(t) * 100}%`
  const short = (v: number) => (v >= 100 ? Math.round(v).toString() : v >= 10 ? v.toFixed(0) : v.toFixed(1))

  return (
    <div className="dtl" role="group" aria-label="When your divisions return">
      <span className="dtl__axis" />
      <span className="dtl__past" style={{ width: pct(now) }} />
      {ticks.map((t) => (
        <span key={t} className="dtl__tick" style={{ left: pct(t) }}>
          {hhmm(t)}
        </span>
      ))}
      <span className="dtl__now" style={{ left: pct(now) }}>
        <span>Now</span>
      </span>
      {clusters.map((c) => {
        const on = c.keys.some((k) => selected.has(k))
        const title = `${c.ready ? 'Back now' : `Back at ${hhmm(c.at)}`}: ${c.labels.join(', ')}`
        return (
          <button
            key={c.keys.join(',')}
            type="button"
            className={`dtl__dot${c.ready ? ' is-ready' : ''}${on ? ' is-on' : ''}`}
            style={{ left: pct(c.at) }}
            title={title}
            aria-label={title}
            aria-pressed={on}
            onClick={() => onPick(c.keys)}
          >
            {c.keys.length > 1 && <i>{c.keys.length}</i>}
            {labelled.has(c) && <b className="num">{short(c.value)} TLM</b>}
          </button>
        )
      })}
    </div>
  )
}
