import { useEffect, useRef, type RefObject } from 'react'

/**
 * While `open`, a press outside `ref` or the Escape key calls `onDismiss`: the closing behaviour
 * of every menu, popover and sheet. Put the element that opens it inside `ref`, so pressing it
 * again toggles instead of closing and reopening.
 */
export function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, onDismiss: () => void) {
  // The latest callback, without re-attaching the listeners whenever it changes.
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) dismiss.current()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss.current()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, ref])
}
