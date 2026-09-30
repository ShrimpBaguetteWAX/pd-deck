import { useEffect, useRef, type ReactNode } from 'react'

import './Modal.css'

interface ModalProps {
  /** Sizes and decorates the panel; the shared look comes from `.modal`. */
  className?: string
  /** Names the dialog for screen readers when it has no visible title to point at. */
  label?: string
  /** While true (e.g. the wallet is signing), Escape and a backdrop click leave the dialog open. */
  locked?: boolean
  onClose: () => void
  children: ReactNode
}

/** A native modal `<dialog>`: focus trap, Escape and backdrop click to close. */
export function Modal({ className = '', label, locked = false, onClose, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null)
  // A press that starts inside the panel and ends on the backdrop (selecting text, dragging) is not a close.
  const pressedBackdrop = useRef(false)

  useEffect(() => {
    const dialog = ref.current
    const opener = document.activeElement
    dialog?.showModal()
    return () => {
      dialog?.close()
      // React has already removed the dialog, so the browser can't hand focus back itself.
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])

  const requestClose = () => {
    if (!locked) onClose()
  }

  return (
    <dialog
      ref={ref}
      className={`modal ${className}`}
      aria-label={label}
      onCancel={(e) => {
        e.preventDefault()
        requestClose()
      }}
      onKeyDown={(e) => {
        // Some browsers skip the cancel event for a second Escape; handle the key directly as well.
        if (e.key !== 'Escape') return
        e.preventDefault()
        // Dialogs can nest (the Builder's exchange confirmation opens inside the Spaceport): close only this one.
        e.stopPropagation()
        requestClose()
      }}
      onMouseDown={(e) => {
        pressedBackdrop.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        if (pressedBackdrop.current && e.target === e.currentTarget) requestClose()
        pressedBackdrop.current = false
      }}
    >
      {children}
    </dialog>
  )
}
