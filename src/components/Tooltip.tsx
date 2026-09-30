import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { InfoIcon } from '@/icons'

import './Tooltip.css'

interface TooltipProps {
  /** The explanation; keep it to a sentence or two. */
  text: ReactNode
  children?: ReactNode
  /** Preferred side; the bubble flips when that side has no room. "top" by default. */
  side?: 'top' | 'bottom'
  className?: string
}

/** Space kept between the bubble and the window edge, and between the bubble and its trigger. */
const EDGE = 8
const GAP = 8

interface Placement {
  left: number
  top: number
  side: 'top' | 'bottom'
  /** Where the arrow sits along the bubble, so it still points at the trigger after clamping. */
  arrow: number
}

/**
 * A concise explanation on hover, focus or tap. Without children it renders an info dot, the
 * game's "what is this?" marker next to a label.
 *
 * The bubble is positioned against the window, never against its container, so it cannot be
 * clipped by a scrolling panel or pushed off-screen: it is clamped inside the viewport and flips
 * to the other side of the trigger when the preferred side has no room. It renders into the open
 * <dialog> when the trigger sits inside one (dialogs live in the browser's top layer, above body).
 */
export function Tooltip({ text, children, side = 'top', className = '' }: TooltipProps) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const bubbleRef = useRef<HTMLSpanElement>(null)
  // Set when the bubble was opened by a tap, so the next tap outside closes it.
  const pinned = useRef(false)

  const place = useCallback(() => {
    const anchor = anchorRef.current
    const bubble = bubbleRef.current
    if (!anchor || !bubble) return
    const a = anchor.getBoundingClientRect()
    const w = bubble.offsetWidth
    const h = bubble.offsetHeight
    const vw = document.documentElement.clientWidth
    const vh = window.innerHeight
    const roomAbove = a.top - GAP - EDGE
    const roomBelow = vh - a.bottom - GAP - EDGE
    const useTop = side === 'top' ? roomAbove >= h || roomAbove >= roomBelow : !(roomBelow >= h || roomBelow >= roomAbove)
    const center = a.left + a.width / 2
    const left = Math.min(Math.max(center - w / 2, EDGE), Math.max(EDGE, vw - w - EDGE))
    const top = useTop ? Math.max(EDGE, a.top - GAP - h) : Math.min(a.bottom + GAP, vh - h - EDGE)
    setPlacement({ left, top, side: useTop ? 'top' : 'bottom', arrow: Math.min(Math.max(center - left, 12), w - 12) })
  }, [side])

  // Measure once the bubble is in the document, before the browser paints it.
  useLayoutEffect(() => {
    if (open) place()
    else setPlacement(null)
  }, [open, place, text])

  // Follow the trigger while scrolling (any scroll container) or resizing; close on Escape or a tap elsewhere.
  useEffect(() => {
    if (!open) return
    const onMove = () => place()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onDown = (e: PointerEvent) => {
      if (pinned.current && anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        pinned.current = false
        setOpen(false)
      }
    }
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [open, place])

  const container = open ? ((anchorRef.current?.closest('dialog[open]') as HTMLElement | null) ?? document.body) : null

  return (
    <span
      ref={anchorRef}
      className={`tip ${className}`}
      aria-describedby={open ? id : undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (!pinned.current) setOpen(false)
      }}
      onFocus={() => setOpen(true)}
      onBlur={() => {
        pinned.current = false
        setOpen(false)
      }}
    >
      {children ?? (
        <button
          type="button"
          className="tip__dot"
          aria-label="More info"
          onClick={() => {
            pinned.current = !open || !pinned.current
            setOpen(pinned.current)
          }}
        >
          <InfoIcon width={14} height={14} />
        </button>
      )}
      {container &&
        createPortal(
          <span
            ref={bubbleRef}
            role="tooltip"
            id={id}
            className={`tip__bubble tip__bubble--${placement?.side ?? side} ${placement ? 'is-open' : ''}`}
            style={
              {
                left: placement?.left ?? 0,
                top: placement?.top ?? 0,
                '--arrow': `${placement?.arrow ?? 0}px`
              } as CSSProperties
            }
          >
            {text}
          </span>,
          container
        )}
    </span>
  )
}
