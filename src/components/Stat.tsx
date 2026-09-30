import type { ReactNode } from 'react'

import { MoveIcon, ShieldIcon, SwordIcon } from '@/icons'
import { formatNumber } from '@/lib/format'

import { Tooltip } from './Tooltip'

import './Stat.css'

export const STAT_HELP = {
  atk: 'Attack. Missions require a minimum per division; it is the sum of every mercenary and their gear.',
  def: 'Defense. Some missions require a minimum per division; summed like attack.',
  mov: 'Move cost. Every mission locks the division for its base cooldown plus 10 seconds per move point, so lower is faster.'
}

/** ATK / DEF / MOVE in one row, the trio that every division and unit shows. */
export function StatTrio({
  atk,
  def,
  move,
  size = 'md',
  help = false
}: {
  atk: number
  def: number
  move: number
  size?: 'sm' | 'md' | 'lg'
  help?: boolean
}) {
  const cell = (cls: string, Icon: typeof SwordIcon, value: number, label: string, tip: string) => {
    const body = (
      <span className={`stat ${cls}`}>
        <Icon />
        <b className="num">{formatNumber(value, 0)}</b>
        {size === 'lg' && <small>{label}</small>}
      </span>
    )
    return help ? <Tooltip text={tip}>{body}</Tooltip> : body
  }
  return (
    <span className={`stat-trio stat-trio--${size}`}>
      {cell('c-atk', SwordIcon, atk, 'ATK', STAT_HELP.atk)}
      {cell('c-def', ShieldIcon, def, 'DEF', STAT_HELP.def)}
      {cell('c-mov', MoveIcon, move, 'MOVE', STAT_HELP.mov)}
    </span>
  )
}

/** A small labelled figure for summary strips. */
export function Figure({ label, value, tone, help }: { label: string; value: ReactNode; tone?: string; help?: string }) {
  return (
    <span className="figure">
      <span className="figure__label">
        {label}
        {help && <Tooltip text={help} />}
      </span>
      <b className={`figure__value num ${tone ?? ''}`}>{value}</b>
    </span>
  )
}
