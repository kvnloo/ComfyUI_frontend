import { afterEach, describe, expect, it, vi } from 'vitest'

import { MultiresolutionMediaScheduler } from './multiresolutionMediaScheduler'

describe('MultiresolutionMediaScheduler', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('blocks refinement during motion and one settle window', () => {
    vi.useFakeTimers()
    const settled = vi.fn()
    const scheduler = new MultiresolutionMediaScheduler({
      maxDecodedBytes: 1024,
      settleMs: 180,
      onSettled: settled
    })

    const generation = scheduler.beginMotion()
    expect(scheduler.canRefine(generation)).toBe(false)

    scheduler.endMotion()
    expect(scheduler.canRefine(generation)).toBe(false)

    vi.advanceTimersByTime(179)
    expect(scheduler.canRefine(generation)).toBe(false)
    expect(settled).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(scheduler.canRefine(generation)).toBe(true)
    expect(settled).toHaveBeenCalledOnce()
    expect(settled).toHaveBeenCalledWith(generation)
  })

  it('new motion invalidates the old generation and coalesces settle', () => {
    vi.useFakeTimers()
    const settled = vi.fn()
    const scheduler = new MultiresolutionMediaScheduler({
      maxDecodedBytes: 1024,
      settleMs: 180,
      onSettled: settled
    })

    const oldGeneration = scheduler.beginMotion()
    scheduler.endMotion()
    vi.advanceTimersByTime(100)

    const newGeneration = scheduler.beginMotion()
    expect(newGeneration).toBeGreaterThan(oldGeneration)
    expect(scheduler.canPublish(oldGeneration)).toBe(false)

    scheduler.endMotion()
    vi.advanceTimersByTime(180)

    expect(settled).toHaveBeenCalledOnce()
    expect(settled).toHaveBeenCalledWith(newGeneration)
    expect(scheduler.canPublish(newGeneration)).toBe(true)
    expect(scheduler.stats().staleCompletions).toBe(1)
  })

  it('source changes invalidate old work without pretending motion', () => {
    const scheduler = new MultiresolutionMediaScheduler({
      maxDecodedBytes: 1024
    })

    const oldGeneration = scheduler.generation
    const newGeneration = scheduler.invalidateViewport()

    expect(newGeneration).toBe(oldGeneration + 1)
    expect(scheduler.motionActive).toBe(false)
    expect(scheduler.canPublish(oldGeneration)).toBe(false)
    expect(scheduler.stats().staleCompletions).toBe(1)
  })

  it('evicts decoded entries by bytes even when entry count is small', () => {
    const scheduler = new MultiresolutionMediaScheduler({
      maxDecodedBytes: 100
    })

    expect(scheduler.retainDecoded('a', 40)).toEqual([])
    expect(scheduler.retainDecoded('b', 40)).toEqual([])
    scheduler.touchDecoded('a')

    expect(scheduler.retainDecoded('c', 40)).toEqual(['b'])
    expect(scheduler.hasDecoded('a')).toBe(true)
    expect(scheduler.hasDecoded('b')).toBe(false)
    expect(scheduler.hasDecoded('c')).toBe(true)
    expect(scheduler.stats()).toMatchObject({
      residentEntries: 2,
      residentBytes: 80,
      evictions: 1
    })
  })

  it('evicts an entry larger than the whole byte budget', () => {
    const scheduler = new MultiresolutionMediaScheduler({
      maxDecodedBytes: 64
    })

    expect(scheduler.retainDecoded('too-large', 128)).toEqual(['too-large'])
    expect(scheduler.stats()).toMatchObject({
      residentEntries: 0,
      residentBytes: 0,
      evictions: 1
    })
  })

  it('destroy cancels settle and releases decoded residency', () => {
    vi.useFakeTimers()
    const settled = vi.fn()
    const scheduler = new MultiresolutionMediaScheduler({
      maxDecodedBytes: 100,
      settleMs: 180,
      onSettled: settled
    })

    scheduler.retainDecoded('a', 40)
    scheduler.beginMotion()
    scheduler.endMotion()
    scheduler.destroy()
    vi.runAllTimers()

    expect(settled).not.toHaveBeenCalled()
    expect(scheduler.stats()).toMatchObject({
      settlePending: false,
      residentEntries: 0,
      residentBytes: 0
    })
  })

  it('rejects invalid budgets and decoded sizes', () => {
    expect(
      () => new MultiresolutionMediaScheduler({ maxDecodedBytes: -1 })
    ).toThrow('maxDecodedBytes')
    expect(
      () =>
        new MultiresolutionMediaScheduler({
          maxDecodedBytes: 1,
          settleMs: Number.NaN
        })
    ).toThrow('settleMs')

    const scheduler = new MultiresolutionMediaScheduler({
      maxDecodedBytes: 1
    })
    expect(() => scheduler.retainDecoded('x', Number.NaN)).toThrow(
      'decoded bytes'
    )
  })
})
