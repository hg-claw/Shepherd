type Props = {
  values: number[]
  width?: number
  height?: number
  className?: string
  ariaLabel?: string
}

export function Sparkline({ values, width = 80, height = 24, className, ariaLabel }: Props) {
  if (values.length < 2) {
    return <svg width={width} height={height} className={className} role="img" aria-label={ariaLabel} />
  }
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const dx = width / (values.length - 1)
  const points = values
    .map((v, i) => {
      const x = i * dx
      const y = height - ((v - min) / span) * height
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  return (
    <svg width={width} height={height} className={className} role="img" aria-label={ariaLabel}>
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        points={points}
      />
    </svg>
  )
}
