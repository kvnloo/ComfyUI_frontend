import type { TileDemand } from './multiresolutionMediaSource'
import type { MultiresolutionMediaScheduler } from './multiresolutionMediaScheduler'

export interface MultiresolutionTilePipelineOptions<TFetched, TDecoded> {
  scheduler: MultiresolutionMediaScheduler
  fetchConcurrency?: number
  decodeConcurrency?: number
  fetchTile: (tile: TileDemand, signal: AbortSignal) => Promise<TFetched>
  decodeTile: (
    fetched: TFetched,
    tile: TileDemand,
    signal: AbortSignal
  ) => Promise<TDecoded>
  publishTile: (
    decoded: TDecoded,
    tile: TileDemand,
    generation: number
  ) => void
  disposeDecoded?: (decoded: TDecoded) => void
}

export interface MultiresolutionTilePipelineStats {
  requested: number
  fetched: number
  decoded: number
  published: number
  abortedFetches: number
  staleBeforeDecode: number
  staleBeforePublish: number
  fetchInFlight: number
  decodeInFlight: number
  queuedFetches: number
  queuedDecodes: number
}

interface WorkItem<TFetched = unknown> {
  generation: number
  tile: TileDemand
  fetched?: TFetched
}

interface ActiveFetch {
  generation: number
  controller: AbortController
}

function positiveConcurrency(value: number, field: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`)
  }
}

export class MultiresolutionTilePipeline<TFetched, TDecoded> {
  private readonly fetchConcurrency: number
  private readonly decodeConcurrency: number
  private readonly fetchQueue: WorkItem[] = []
  private readonly decodeQueue: WorkItem<TFetched>[] = []
  private readonly fetchControllers = new Map<string, ActiveFetch>()
  private wantedKeys = new Set<string>()
  private wantedGeneration = 0
  private destroyed = false
  private fetchInFlight = 0
  private decodeInFlight = 0

  private counters = {
    requested: 0,
    fetched: 0,
    decoded: 0,
    published: 0,
    abortedFetches: 0,
    staleBeforeDecode: 0,
    staleBeforePublish: 0
  }

  constructor(
    private readonly options: MultiresolutionTilePipelineOptions<
      TFetched,
      TDecoded
    >
  ) {
    this.fetchConcurrency = options.fetchConcurrency ?? 6
    this.decodeConcurrency = options.decodeConcurrency ?? 2
    positiveConcurrency(this.fetchConcurrency, 'fetchConcurrency')
    positiveConcurrency(this.decodeConcurrency, 'decodeConcurrency')
  }

  /**
   * Replace visible demand for one current viewport generation.
   *
   * Demand is ignored while motion/settle owns the realtime lane. The caller
   * may call again from the scheduler's settle callback.
   */
  setDemand(generation: number, tiles: readonly TileDemand[]) {
    if (this.destroyed) return false
    if (!this.options.scheduler.canRefine(generation)) return false

    const unique = new Map<string, TileDemand>()
    for (const tile of tiles) {
      unique.set(tile.key, tile)
    }

    this.wantedGeneration = generation
    this.wantedKeys = new Set(unique.keys())

    for (const [key, active] of this.fetchControllers) {
      if (active.generation !== generation || !this.wantedKeys.has(key)) {
        active.controller.abort()
        this.fetchControllers.delete(key)
        this.counters.abortedFetches++
      }
    }

    for (let index = this.fetchQueue.length - 1; index >= 0; index--) {
      const item = this.fetchQueue[index]
      if (
        item.generation !== generation ||
        !this.wantedKeys.has(item.tile.key)
      ) {
        this.fetchQueue.splice(index, 1)
      }
    }

    for (let index = this.decodeQueue.length - 1; index >= 0; index--) {
      const item = this.decodeQueue[index]
      if (
        item.generation !== generation ||
        !this.wantedKeys.has(item.tile.key)
      ) {
        this.decodeQueue.splice(index, 1)
        this.counters.staleBeforeDecode++
      }
    }

    const alreadyScheduled = new Set([
      ...this.fetchQueue
        .filter((item) => item.generation === generation)
        .map((item) => item.tile.key),
      ...this.decodeQueue
        .filter((item) => item.generation === generation)
        .map((item) => item.tile.key),
      ...[...this.fetchControllers.entries()]
        .filter(([, active]) => active.generation === generation)
        .map(([key]) => key)
    ])

    for (const tile of unique.values()) {
      if (alreadyScheduled.has(tile.key)) continue
      this.fetchQueue.push({ generation, tile })
      alreadyScheduled.add(tile.key)
      this.counters.requested++
    }

    this.pumpFetch()
    this.pumpDecode()
    return true
  }

  clearDemand() {
    this.wantedKeys.clear()
    this.fetchQueue.splice(0)
    this.decodeQueue.splice(0)
    for (const active of this.fetchControllers.values()) {
      active.controller.abort()
      this.counters.abortedFetches++
    }
    this.fetchControllers.clear()
  }

  stats(): MultiresolutionTilePipelineStats {
    return {
      ...this.counters,
      fetchInFlight: this.fetchInFlight,
      decodeInFlight: this.decodeInFlight,
      queuedFetches: this.fetchQueue.length,
      queuedDecodes: this.decodeQueue.length
    }
  }

  destroy() {
    this.destroyed = true
    this.clearDemand()
  }

  private isWanted(item: WorkItem) {
    return (
      !this.destroyed &&
      item.generation === this.wantedGeneration &&
      item.generation === this.options.scheduler.generation &&
      this.wantedKeys.has(item.tile.key)
    )
  }

  private pumpFetch() {
    while (
      !this.destroyed &&
      this.fetchInFlight < this.fetchConcurrency &&
      this.fetchQueue.length > 0
    ) {
      const item = this.fetchQueue.shift()!
      if (!this.isWanted(item)) continue

      const controller = new AbortController()
      this.fetchControllers.set(item.tile.key, {
        generation: item.generation,
        controller
      })
      this.fetchInFlight++

      void this.options
        .fetchTile(item.tile, controller.signal)
        .then((fetched) => {
          this.counters.fetched++
          if (!this.isWanted(item) || controller.signal.aborted) {
            this.counters.staleBeforeDecode++
            return
          }
          this.decodeQueue.push({ ...item, fetched })
          this.pumpDecode()
        })
        .catch(() => {
          if (!controller.signal.aborted && this.isWanted(item)) {
            // A fetch failure is intentionally not converted into stale work.
            // The fixture/consumer owns retries and presentation.
          }
        })
        .finally(() => {
          const active = this.fetchControllers.get(item.tile.key)
          if (active?.controller === controller) {
            this.fetchControllers.delete(item.tile.key)
          }
          this.fetchInFlight--
          this.pumpFetch()
        })
    }
  }

  private pumpDecode() {
    while (
      !this.destroyed &&
      this.decodeInFlight < this.decodeConcurrency &&
      this.decodeQueue.length > 0
    ) {
      const item = this.decodeQueue.shift()!
      if (!this.isWanted(item)) {
        this.counters.staleBeforeDecode++
        continue
      }

      const controller = new AbortController()
      this.decodeInFlight++

      void this.options
        .decodeTile(item.fetched as TFetched, item.tile, controller.signal)
        .then((decoded) => {
          this.counters.decoded++
          if (
            !this.isWanted(item) ||
            !this.options.scheduler.canPublish(item.generation)
          ) {
            this.counters.staleBeforePublish++
            this.options.disposeDecoded?.(decoded)
            return
          }

          this.options.publishTile(decoded, item.tile, item.generation)
          this.counters.published++
        })
        .catch(() => {
          // Decode failures remain consumer-owned; they are not stale work.
        })
        .finally(() => {
          this.decodeInFlight--
          this.pumpDecode()
        })
    }
  }
}
