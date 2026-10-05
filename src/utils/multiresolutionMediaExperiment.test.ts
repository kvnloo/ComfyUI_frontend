import { afterEach, describe, expect, it, vi } from 'vitest'

import sourceFixture from './__fixtures__/multiresolution-media-source.json'
import {
  chooseMultiresolutionLevel,
  visibleTileDemand,
  type MultiresolutionMediaSource
} from './multiresolutionMediaSource'
import { MultiresolutionMediaScheduler } from './multiresolutionMediaScheduler'

const source = sourceFixture as MultiresolutionMediaSource

describe('multiresolution media scheduling experiment', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('publishes only current visible demand after motion settles', () => {
    vi.useFakeTimers()

    const scheduler = new MultiresolutionMediaScheduler({
      maxDecodedBytes: 2 * 1024 * 1024,
      settleMs: 180
    })

    const firstGeneration = scheduler.beginMotion()
    const firstLevel = chooseMultiresolutionLevel(source, 4)
    const firstDemand = visibleTileDemand(source, firstLevel, {
      x: 0,
      y: 0,
      width: 2048,
      height: 1024
    })

    expect(firstDemand.length).toBeGreaterThan(0)
    expect(scheduler.canPublish(firstGeneration)).toBe(false)

    scheduler.endMotion()
    vi.advanceTimersByTime(180)
    expect(scheduler.canPublish(firstGeneration)).toBe(true)

    const secondGeneration = scheduler.beginMotion()
    expect(secondGeneration).toBeGreaterThan(firstGeneration)

    // A decode that belonged to the old viewport may finish, but it cannot
    // replace the current visible surface.
    expect(scheduler.canPublish(firstGeneration)).toBe(false)

    scheduler.endMotion()
    vi.advanceTimersByTime(180)

    const secondLevel = chooseMultiresolutionLevel(source, 2)
    const secondDemand = visibleTileDemand(source, secondLevel, {
      x: 4096,
      y: 2048,
      width: 1024,
      height: 1024
    })

    expect(secondLevel.level).toBeGreaterThan(firstLevel.level)
    expect(secondDemand.every((tile) => tile.level === secondLevel.level)).toBe(
      true
    )
    expect(scheduler.canPublish(secondGeneration)).toBe(true)
    expect(scheduler.stats().staleCompletions).toBe(1)
  })

  it('keeps decoded residency within the configured byte ceiling', () => {
    const scheduler = new MultiresolutionMediaScheduler({
      maxDecodedBytes: 512 * 1024
    })

    const tileBytes = 256 * 256 * 4
    expect(scheduler.retainDecoded('a', tileBytes)).toEqual([])
    expect(scheduler.retainDecoded('b', tileBytes)).toEqual([])

    scheduler.touchDecoded('a')
    expect(scheduler.retainDecoded('c', tileBytes)).toEqual(['b'])

    expect(scheduler.stats()).toMatchObject({
      residentEntries: 2,
      residentBytes: 512 * 1024,
      maxDecodedBytes: 512 * 1024,
      evictions: 1
    })
  })
})
