import { useState, type CSSProperties, type ImgHTMLAttributes } from 'react'

import { RARITY_COLORS } from '@/chain/config'
import type { AssetRef } from '@/data/assets'
import { imageSources } from '@/lib/ipfs'
import { publicUrl } from '@/lib/publicUrl'

import { Modal } from './Modal'

import './Art.css'

interface IpfsImgProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  hash?: string | null
  size?: 370 | 1110
  fallback?: string
}

/**
 * Card art by IPFS hash: the fast thumbnail CDN first, then the gateways, then a local fallback.
 * Eager by default: the thumbnails are ~16 kB, and lazy images never start in some embedded viewports.
 */
export function IpfsImg({
  hash,
  size = 370,
  fallback = publicUrl('/img/mission-fallback.webp'),
  loading = 'eager',
  ...rest
}: IpfsImgProps) {
  const sources = [...imageSources(hash, size), fallback]
  const [state, setState] = useState({ hash, index: 0 })
  const index = state.hash === hash ? state.index : 0
  return (
    <img
      {...rest}
      loading={loading}
      decoding="async"
      src={sources[Math.min(index, sources.length - 1)]}
      onError={() => setState({ hash, index: Math.min(index + 1, sources.length - 1) })}
    />
  )
}

export const rarityColor = (rarity?: string) => RARITY_COLORS[(rarity || '').toLowerCase()] ?? RARITY_COLORS.common

interface ZoomImgProps extends IpfsImgProps {
  /** Named under the enlarged art. */
  name?: string
  rarity?: string
}

/** Card art that opens full size in an overlay when clicked (Enter or Space from the keyboard). */
export function ZoomImg({ name, rarity, className = '', hash, ...rest }: ZoomImgProps) {
  const [open, setOpen] = useState(false)
  if (!hash) return <IpfsImg hash={hash} className={className} {...rest} />
  return (
    <>
      <IpfsImg
        hash={hash}
        className={`${className} zoomable`}
        role="button"
        tabIndex={0}
        title={name ? `${name} · click to enlarge` : 'Click to enlarge'}
        onClick={(e) => {
          e.stopPropagation()
          setOpen(true)
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          setOpen(true)
        }}
        {...rest}
      />
      {open && (
        <Modal className="lightbox" label={name ?? 'Card art'} onClose={() => setOpen(false)}>
          <figure
            className="lightbox__fig"
            style={{ '--rarity': rarityColor(rarity) } as CSSProperties}
            onClick={() => setOpen(false)}
          >
            <IpfsImg hash={hash} size={1110} alt={name ?? ''} />
            {name && (
              <figcaption>
                <b>{name}</b>
                {rarity && <small style={{ color: rarityColor(rarity) }}>{rarity}</small>}
              </figcaption>
            )}
          </figure>
        </Modal>
      )}
    </>
  )
}

interface CardArtProps {
  asset: AssetRef
  /** "portrait" is the full card; "square" crops to the art window for small tiles. */
  shape?: 'portrait' | 'square'
  className?: string
  size?: 370 | 1110
  /** Clicking the art opens it full size. */
  zoom?: boolean
}

/** An NFT's art with its rarity as the frame colour. */
export function CardArt({ asset, shape = 'portrait', className = '', size = 370, zoom = false }: CardArtProps) {
  return (
    <span
      className={`art art--${shape} ${className}`}
      style={{ '--rarity': rarityColor(asset.rarity) } as CSSProperties}
      title={asset.name}
    >
      {zoom ? (
        <ZoomImg hash={asset.img} alt={asset.name} size={size} name={asset.name} rarity={asset.rarity} />
      ) : (
        <IpfsImg hash={asset.img} alt={asset.name} size={size} />
      )}
    </span>
  )
}

export const TokenIcon = ({ symbol, size = 16 }: { symbol: 'TLM' | 'DEF' | 'WAX'; size?: number }) => (
  <img
    className="token-icon"
    src={publicUrl(
      symbol === 'TLM' ? '/img/Logo_token_TLM.png' : symbol === 'DEF' ? '/img/Logo_token_DEF.webp' : '/img/Logo_token_WAX.png'
    )}
    alt={symbol}
    width={size}
    height={size}
  />
)

export const PlanetIcon = ({ planet, size = 20 }: { planet: string; size?: number }) =>
  planet ? (
    <img className="planet-icon" src={publicUrl(`/img/planets/${planet}.png`)} alt={planet} width={size} height={size} />
  ) : null
