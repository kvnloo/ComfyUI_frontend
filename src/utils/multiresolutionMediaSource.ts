export interface MultiresolutionLevel {
  level: number
  width: number
  height: number
  tileWidth: number
  tileHeight: number
  urlTemplate: string
}

export interface MultiresolutionMediaSource {
  version: 1
  width: number
  height: number
  previewUrl: string
  levels: MultiresolutionLevel[]
}

export interface SourceRect {
  x: number
  y: number
  width: number
  height: number
}

export interface TileDemand {
  key: string
  level: number
  column: number
  row: number
  url: string
}

function positiveInteger(value: number, field: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`)
  }
}

function finiteNonNegative(value: number, field: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number`)
  }
}

export function validateMultiresolutionSource(
  source: MultiresolutionMediaSource
) {
  if (source.version !== 1) {
    throw new Error('source.version must equal 1')
  }
  positiveInteger(source.width, 'source.width')
  positiveInteger(source.height, 'source.height')
  if (!source.previewUrl) {
    throw new Error('source.previewUrl must be non-empty')
  }
  if (source.levels.length === 0) {
    throw new Error('source.levels must contain at least one level')
  }

  let previousLevel = -1
  let previousWidth = 0
  let previousHeight = 0

  for (const [index, level] of source.levels.entries()) {
    positiveInteger(level.width, `source.levels[${index}].width`)
    positiveInteger(level.height, `source.levels[${index}].height`)
    positiveInteger(level.tileWidth, `source.levels[${index}].tileWidth`)
    positiveInteger(level.tileHeight, `source.levels[${index}].tileHeight`)
    if (!Number.isInteger(level.level) || level.level <= previousLevel) {
      throw new Error('source levels must have strictly increasing level ids')
    }
    if (
      index > 0 &&
      (level.width < previousWidth || level.height < previousHeight)
    ) {
      throw new Error(
        'source levels must be ordered from coarse to fine resolution'
      )
    }
    if (level.width > source.width || level.height > source.height) {
      throw new Error('source level dimensions cannot exceed source dimensions')
    }
    if (!level.urlTemplate.includes('{x}') || !level.urlTemplate.includes('{y}')) {
      throw new Error('source level urlTemplate must contain {x} and {y}')
    }

    previousLevel = level.level
    previousWidth = level.width
    previousHeight = level.height
  }

  const finest = source.levels.at(-1)!
  if (finest.width !== source.width || finest.height !== source.height) {
    throw new Error('finest source level must match source dimensions')
  }

  return source
}

/**
 * Pick the coarsest level that still provides at least one level pixel for
 * each CSS pixel in the current view. sourcePixelsPerCssPixel is measured in
 * full-resolution source pixels.
 */
export function chooseMultiresolutionLevel(
  source: MultiresolutionMediaSource,
  sourcePixelsPerCssPixel: number
) {
  validateMultiresolutionSource(source)
  if (!Number.isFinite(sourcePixelsPerCssPixel) || sourcePixelsPerCssPixel <= 0) {
    throw new Error('sourcePixelsPerCssPixel must be a finite positive number')
  }

  let selected = source.levels.at(-1)!
  for (const level of source.levels) {
    const downsample = source.width / level.width
    if (downsample <= sourcePixelsPerCssPixel) {
      selected = level
      continue
    }
    break
  }
  return selected
}

export function visibleTileDemand(
  source: MultiresolutionMediaSource,
  level: MultiresolutionLevel,
  sourceViewport: SourceRect
): TileDemand[] {
  validateMultiresolutionSource(source)
  finiteNonNegative(sourceViewport.x, 'sourceViewport.x')
  finiteNonNegative(sourceViewport.y, 'sourceViewport.y')
  finiteNonNegative(sourceViewport.width, 'sourceViewport.width')
  finiteNonNegative(sourceViewport.height, 'sourceViewport.height')

  const knownLevel = source.levels.find(
    (candidate) => candidate.level === level.level
  )
  if (!knownLevel || knownLevel !== level) {
    throw new Error('level must belong to source.levels')
  }
  if (sourceViewport.width === 0 || sourceViewport.height === 0) {
    return []
  }

  const x0 = Math.max(0, Math.min(source.width, sourceViewport.x))
  const y0 = Math.max(0, Math.min(source.height, sourceViewport.y))
  const x1 = Math.max(
    x0,
    Math.min(source.width, sourceViewport.x + sourceViewport.width)
  )
  const y1 = Math.max(
    y0,
    Math.min(source.height, sourceViewport.y + sourceViewport.height)
  )
  if (x1 <= x0 || y1 <= y0) {
    return []
  }

  const scaleX = level.width / source.width
  const scaleY = level.height / source.height
  const levelX0 = x0 * scaleX
  const levelY0 = y0 * scaleY
  const levelX1 = x1 * scaleX
  const levelY1 = y1 * scaleY

  const firstColumn = Math.floor(levelX0 / level.tileWidth)
  const firstRow = Math.floor(levelY0 / level.tileHeight)
  const lastColumn = Math.min(
    Math.ceil(level.width / level.tileWidth) - 1,
    Math.ceil(levelX1 / level.tileWidth) - 1
  )
  const lastRow = Math.min(
    Math.ceil(level.height / level.tileHeight) - 1,
    Math.ceil(levelY1 / level.tileHeight) - 1
  )

  const demand: TileDemand[] = []
  for (let row = firstRow; row <= lastRow; row++) {
    for (let column = firstColumn; column <= lastColumn; column++) {
      demand.push({
        key: `${level.level}:${column}:${row}`,
        level: level.level,
        column,
        row,
        url: level.urlTemplate
          .replaceAll('{x}', String(column))
          .replaceAll('{y}', String(row))
          .replaceAll('{level}', String(level.level))
      })
    }
  }
  return demand
}
