export interface MultiresolutionSchedulerOptions {
  settleMs?: number
  maxDecodedBytes: number
  onSettled?: (generation: number) => void
}

export interface MultiresolutionSchedulerStats {
  generation: number
  motionActive: boolean
  settlePending: boolean
  residentEntries: number
  residentBytes: number
  maxDecodedBytes: number
  staleCompletions: number
  evictions: number
}

interface ResidentEntry {
  bytes: number
  lastUsed: number
}

/**
 * Downstream experiment for large-image inspection scheduling.
 *
 * This owns no networking or rendering. It only decides when refinement may
 * publish and keeps accounting for a byte-bounded decoded residency set.
 */
export class MultiresolutionMediaScheduler {
  readonly settleMs: number
  readonly maxDecodedBytes: number

  private generationValue = 0
  private motionActiveValue = false
  private settlePendingValue = false
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private resident = new Map<string, ResidentEntry>()
  private residentBytesValue = 0
  private lruClock = 0
  private staleCompletionsValue = 0
  private evictionsValue = 0

  constructor(private readonly options: MultiresolutionSchedulerOptions) {
    this.settleMs = options.settleMs ?? 180
    this.maxDecodedBytes = options.maxDecodedBytes

    if (!Number.isFinite(this.settleMs) || this.settleMs < 0) {
      throw new Error('settleMs must be a finite non-negative number')
    }
    if (
      !Number.isFinite(this.maxDecodedBytes) ||
      this.maxDecodedBytes < 0
    ) {
      throw new Error('maxDecodedBytes must be a finite non-negative number')
    }
  }

  get generation() {
    return this.generationValue
  }

  get motionActive() {
    return this.motionActiveValue
  }

  get settlePending() {
    return this.settlePendingValue
  }

  /**
   * Starts or continues camera/view motion and invalidates work prepared for
   * the previous viewport.
   */
  beginMotion() {
    this.invalidateViewport()
    this.motionActiveValue = true
    return this.generationValue
  }

  /**
   * Invalidates the current viewport generation without changing motion state.
   * Useful for gallery-item/source changes.
   */
  invalidateViewport() {
    this.generationValue++
    this.cancelSettle()
    return this.generationValue
  }

  /**
   * Ends active motion. Refinement remains blocked until the quiet window
   * elapses. Repeated calls coalesce to one settle wake.
   */
  endMotion() {
    this.motionActiveValue = false
    this.cancelSettle()

    this.settlePendingValue = true
    const generation = this.generationValue
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      if (
        this.motionActiveValue ||
        generation !== this.generationValue
      ) {
        return
      }

      this.settlePendingValue = false
      this.options.onSettled?.(generation)
    }, this.settleMs)
  }

  canRefine(generation = this.generationValue) {
    return (
      generation === this.generationValue &&
      !this.motionActiveValue &&
      !this.settlePendingValue
    )
  }

  /**
   * A completion may publish only if it belongs to the current generation and
   * the realtime motion/settle lane is clear.
   */
  canPublish(generation: number) {
    const allowed = this.canRefine(generation)
    if (!allowed && generation !== this.generationValue) {
      this.staleCompletionsValue++
    }
    return allowed
  }

  /**
   * Retains decoded pixels under a strict byte ceiling and returns the keys
   * evicted in least-recently-used order.
   */
  retainDecoded(key: string, bytes: number) {
    if (!key) throw new Error('decoded entry key must be non-empty')
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new Error('decoded bytes must be a finite non-negative number')
    }

    const previous = this.resident.get(key)
    if (previous) {
      this.residentBytesValue -= previous.bytes
      this.resident.delete(key)
    }

    this.resident.set(key, {
      bytes,
      lastUsed: ++this.lruClock
    })
    this.residentBytesValue += bytes

    const evicted: string[] = []
    while (
      this.residentBytesValue > this.maxDecodedBytes &&
      this.resident.size > 0
    ) {
      let oldestKey: string | null = null
      let oldestUse = Number.POSITIVE_INFINITY

      for (const [candidateKey, entry] of this.resident) {
        if (entry.lastUsed < oldestUse) {
          oldestUse = entry.lastUsed
          oldestKey = candidateKey
        }
      }

      if (oldestKey === null) break
      const removed = this.resident.get(oldestKey)
      if (!removed) break

      this.resident.delete(oldestKey)
      this.residentBytesValue -= removed.bytes
      this.evictionsValue++
      evicted.push(oldestKey)
    }

    return evicted
  }

  touchDecoded(key: string) {
    const entry = this.resident.get(key)
    if (!entry) return false
    entry.lastUsed = ++this.lruClock
    return true
  }

  releaseDecoded(key: string) {
    const entry = this.resident.get(key)
    if (!entry) return false
    this.resident.delete(key)
    this.residentBytesValue -= entry.bytes
    return true
  }

  hasDecoded(key: string) {
    return this.resident.has(key)
  }

  stats(): MultiresolutionSchedulerStats {
    return {
      generation: this.generationValue,
      motionActive: this.motionActiveValue,
      settlePending: this.settlePendingValue,
      residentEntries: this.resident.size,
      residentBytes: this.residentBytesValue,
      maxDecodedBytes: this.maxDecodedBytes,
      staleCompletions: this.staleCompletionsValue,
      evictions: this.evictionsValue
    }
  }

  destroy() {
    this.cancelSettle()
    this.resident.clear()
    this.residentBytesValue = 0
  }

  private cancelSettle() {
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
    this.settlePendingValue = false
  }
}
