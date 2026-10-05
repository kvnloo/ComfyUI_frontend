import { describe, expect, it } from 'vitest'

import {
  chooseMultiresolutionLevel,
  visibleTileDemand,
  type MultiresolutionMediaSource
} from './multiresolutionMediaSource'

const fixture: MultiresolutionMediaSource = {
  version: 1,
  width: 8192,
  height: 4096,
  previewUrl: '/fixture/preview.jpg',
  levels: [
    { level: 0, width: 1024, height: 512, tileWidth: 256, tileHeight: 256, urlTemplate: '/fixture/0/{x}_{y}.jpg' },
    { level: 1, width: 2048, height: 1024, tileWidth: 256, tileHeight: 256, urlTemplate: '/fixture/1/{x}_{y}.jpg' },
    { level: 2, width: 4096, height: 2048, tileWidth: 256, tileHeight: 256, urlTemplate: '/fixture/2/{x}_{y}.jpg' },
    { level: 3, width: 8192, height: 4096, tileWidth: 256, tileHeight: 256, urlTemplate: '/fixture/3/{x}_{y}.jpg' }
  ]
}

describe('multiresolution media source', () => {
  it('chooses the coarsest level that does not undersample the viewport', () => {
    expect(chooseMultiresolutionLevel(fixture, 8).level).toBe(0)
    expect(chooseMultiresolutionLevel(fixture, 4).level).toBe(1)
    expect(chooseMultiresolutionLevel(fixture, 2).level).toBe(2)
    expect(chooseMultiresolutionLevel(fixture, 1).level).toBe(3)
    expect(chooseMultiresolutionLevel(fixture, 0.5).level).toBe(3)
  })

  it('requests only tiles intersecting the visible source rectangle', () => {
    const level = fixture.levels[3]
    const demand = visibleTileDemand(fixture, level, { x: 256, y: 256, width: 512, height: 256 })
    expect(demand.map((tile) => tile.key)).toEqual(['3:1:1', '3:2:1'])
    expect(demand.map((tile) => tile.url)).toEqual(['/fixture/3/1_1.jpg', '/fixture/3/2_1.jpg'])
  })

  it('maps full-resolution viewport coordinates into a coarser level', () => {
    const level = fixture.levels[1]
    const demand = visibleTileDemand(fixture, level, { x: 2048, y: 1024, width: 2048, height: 1024 })
    expect(demand.map((tile) => tile.key)).toEqual(['1:2:1', '1:3:1'])
  })

  it('clips demand to the source bounds', () => {
    const level = fixture.levels[3]
    const demand = visibleTileDemand(fixture, level, { x: 8000, y: 3900, width: 1000, height: 1000 })
    expect(demand.map((tile) => tile.key)).toEqual(['3:31:15'])
  })

  it('returns no demand for an empty viewport', () => {
    expect(visibleTileDemand(fixture, fixture.levels[3], { x: 10, y: 10, width: 0, height: 100 })).toEqual([])
  })

  it('rejects malformed level order and incomplete finest coverage', () => {
    expect(() => chooseMultiresolutionLevel({ ...fixture, levels: [fixture.levels[1], fixture.levels[0], fixture.levels[3]] }, 1)).toThrow('increasing level ids')
    expect(() => chooseMultiresolutionLevel({ ...fixture, levels: fixture.levels.slice(0, 3) }, 1)).toThrow('finest source level')
  })
})
