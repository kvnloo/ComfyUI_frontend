import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TileDemand } from './multiresolutionMediaSource'
import { MultiresolutionMediaScheduler } from './multiresolutionMediaScheduler'
import { MultiresolutionTilePipeline } from './multiresolutionTilePipeline'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tile = (key: string): TileDemand => ({
  key,
  level: 1,
  column: Number(key),
  row: 0,
  url: `/tile/${key}.png`
})

describe('MultiresolutionTilePipeline', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps fetch and decode concurrency independent', async () => {
    const scheduler = new MultiresolutionMediaScheduler({
      maxDecodedBytes: 1024
    })
    const fetches = [deferred<string>(), deferred<string>(), deferred<string>()]
    const decodes = [deferred<string>(), deferred<string>(), deferred<string>()]
    const fetchTile = vi.fn((_tile: TileDemand) => fetches.shift()!.promise)
    const decodeTile = vi.fn((_value: string) => decodes.shift()!.promise)
    const publishTile = vi.fn()
    const pipeline = new MultiresolutionTilePipeline({
      scheduler,
      fetchConcurrency: 2,
      decodeConcurrency: 1,
      fetchTile,
      decodeTile,
      publishTile
    })

    const generation = scheduler.generation
    pipeline.setDemand(generation, [tile('0'), tile('1'), tile('2')])
    expect(fetchTile).toHaveBeenCalledTimes(2)

    fetches[0].resolve('a')
    await Promise.resolve()
    await Promise.resolve()

    expect(decodeTile).toHaveBeenCalledTimes(1)
    expect(fetchTile).toHaveBeenCalledTimes(3)

    fetches[1].resolve('b')
    await Promise.resolve()
    await Promise.resolve()
    expect(decodeTile).toHaveBeenCalledTimes(1)

    decodes[0].resolve('decoded-a')
    await Promise.resolve()
    await Promise.resolve()
    expect(decodeTile).toHaveBeenCalledTimes(2)
    expect(publishTile).toHaveBeenCalledTimes(1)
  })

  it('does not admit visible work while motion or settle owns the lane', () => {
    vi.useFakeTimers()
    const scheduler = new MultiresolutionMediaScheduler({
      maxDecodedBytes: 1024,
      settleMs: 180
    })
    const fetchTile = vi.fn(async () => 'bytes')
    const pipeline = new MultiresolutionTilePipeline({
      scheduler,
      fetchTile,
      decodeTile: async (value) => value,
      publishTile: vi.fn()
    })

    const generation = scheduler.beginMotion()
    expect(pipeline.setDemand(generation, [tile('0')])).toBe(false)
    expect(fetchTile).not.toHaveBeenCalled()

    scheduler.endMotion()
    expect(pipeline.setDemand(generation, [tile('0')])).toBe(false)
    vi.advanceTimersByTime(180)

    expect(pipeline.setDemand(generation, [tile('0')])).toBe(true)
    expect(fetchTile).toHaveBeenCalledOnce()
  })

  it('aborts an in-flight fetch that leaves current visible demand', async () => {
    const scheduler = new MultiresolutionMediaScheduler({
      maxDecodedBytes: 1024
    })
    const gate = deferred<string>()
    let observedSignal: AbortSignal | undefined
    const pipeline = new MultiresolutionTilePipeline({
      scheduler,
      fetchConcurrency: 1,
      fetchTile: async (_tile, signal) => {
        observedSignal = signal
        return gate.promise
      },
      decodeTile: async (value) => value,
      publishTile: vi.fn()
    })

    const generation = scheduler.generation
    pipeline.setDemand(generation, [tile('0')])
    expect(observedSignal?.aborted).toBe(false)

    pipeline.setDemand(generation, [tile('1')])
    expect(observedSignal?.aborted).toBe(true)
    expect(pipeline.stats().abortedFetches).toBe(1)

    gate.resolve('late')
    await Promise.resolve()
    await Promise.resolve()
    expect(pipeline.stats().staleBeforeDecode).toBe(1)
  })

  it('never decodes a fetch completion from an obsolete viewport generation', async () => {
    const scheduler = new MultiresolutionMediaScheduler({
      maxDecodedBytes: 1024
    })
    const fetchGate = deferred<string>()
    const decodeTile = vi.fn(async (value: string) => value)
    const publishTile = vi.fn()
    const pipeline = new MultiresolutionTilePipeline({
      scheduler,
      fetchTile: async () => fetchGate.promise,
      decodeTile,
      publishTile
    })

    const oldGeneration = scheduler.generation
    pipeline.setDemand(oldGeneration, [tile('0')])
    scheduler.invalidateViewport()

    fetchGate.resolve('old-bytes')
    await Promise.resolve()
    await Promise.resolve()

    expect(decodeTile).not.toHaveBeenCalled()
    expect(publishTile).not.toHaveBeenCalled()
    expect(pipeline.stats().staleBeforeDecode).toBe(1)
  })

  it('disposes decoded pixels when their generation becomes stale before publication', async () => {
    const scheduler = new MultiresolutionMediaScheduler({
      maxDecodedBytes: 1024
    })
    const decodeGate = deferred<string>()
    const publishTile = vi.fn()
    const disposeDecoded = vi.fn()
    const pipeline = new MultiresolutionTilePipeline({
      scheduler,
      fetchTile: async () => 'bytes',
      decodeTile: async () => decodeGate.promise,
      publishTile,
      disposeDecoded
    })

    const oldGeneration = scheduler.generation
    pipeline.setDemand(oldGeneration, [tile('0')])
    await Promise.resolve()
    await Promise.resolve()

    scheduler.invalidateViewport()
    decodeGate.resolve('decoded-old')
    await Promise.resolve()
    await Promise.resolve()

    expect(publishTile).not.toHaveBeenCalled()
    expect(disposeDecoded).toHaveBeenCalledWith('decoded-old')
    expect(pipeline.stats().staleBeforePublish).toBe(1)
  })
})
