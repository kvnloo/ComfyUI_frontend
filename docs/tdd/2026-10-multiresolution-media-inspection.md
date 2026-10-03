# Multiresolution media inspection experiment

Status: downstream research only  
Tracks: `Comfy-Org/ComfyUI_frontend#19788`

## Question

Can ComfyUI inspect very large image outputs with cost proportional to the visible
region rather than the full decoded source, while preserving the existing
`MediaLightbox` interaction model for ordinary outputs?

This document is an experiment plan, not an accepted frontend architecture.

## Current seam

The queue lightbox currently resolves an image result to one URL and renders it
through `ComfyImage`:

```
AugmentedResultItem
  -> resultItemUrl()
  -> MediaLightbox
  -> ComfyImage
```

That should remain the normal path.

A multiresolution experiment should introduce an optional source behind the
image branch rather than a second gallery/lightbox product:

```
ordinary result
  -> existing URL
  -> ComfyImage

large-image result
  -> multiresolution source
  -> large-image renderer
  -> same MediaLightbox shell
```

Audio, video, text, gallery navigation, focus restoration, and keyboard
ownership stay unchanged.

## Minimal source contract

The viewer should not need to know whether levels came from a DZI pyramid,
backend-generated derivatives, a workflow output node, or another image
service.

A first experiment can use a static fixture shaped approximately like:

```ts
export interface MultiresolutionMediaSource {
  version: 1
  width: number
  height: number
  previewUrl: string
  levels: Array<{
    level: number
    width: number
    height: number
    tileWidth: number
    tileHeight: number
    columns: number
    rows: number
    urlTemplate: string
  }>
}
```

The first browser prototype should consume only a committed fixture. No backend
API is required to test viewer scheduling.

## Scheduling invariants

The useful result from the Quackles deep-zoom experiments was not a particular
tile format. It was separating the camera-critical path from refinement work.

### 1. Keep a correct coarse image visible

Opening or moving the view must not blank the surface while higher-resolution
detail is unavailable.

The preview/previously committed level remains the underlay until better detail
for the current view is ready.

### 2. One viewport generation owns visible refinement

Each material viewport change increments a monotonically increasing generation.

A fetch/decode/upload completion may publish only if it still belongs to the
current generation and visible demand.

Old generations may finish I/O, but they may not replace newer visible state.

### 3. Do not promote detail during active motion

Pointer/touch/wheel interaction can update transforms using already resident
content.

Expensive detail promotion is admitted after a short settle window. Start with
`180 ms` because that is the proven Quackles experiment value, not because it
is assumed to be optimal for ComfyUI.

The settle interval must be a named experimental parameter and measured before
any production default is proposed.

### 4. Separate request, decode and publication budgets

Network concurrency is not a proxy for decode cost.

Track independently:

- requests in flight;
- decodes/conversions in flight;
- decoded bytes retained;
- visible resident tiles/pages;
- stale bytes/work discarded.

A small first fixture can begin with two concurrent decodes and a bounded
decoded-byte cache. Exact production budgets remain device/benchmark decisions.

### 5. Visible work outranks speculative work

Priority order:

1. missing visible coarse coverage;
2. missing visible target detail;
3. near-viewport/predicted detail;
4. everything else.

Speculative work is always cancellable/deprioritizable.

### 6. Publication is monotonic

A refinement must only improve the currently correct image.

A stale tile, a lower-quality late completion, or a completion for a prior
gallery item cannot replace sharper/current content.

## Why these constraints are worth testing

The separate Quackles runtime used a 1-gigapixel-class tiled source and showed a
large difference when expensive visible refinement was removed from active
camera motion.

In measured pan/reverse experiments, worst interactive frames fell from roughly
`90–116 ms` to roughly `17–42 ms`.

A separate fling/reconciliation experiment changed:

| Metric | Before | After |
| --- | ---: | ---: |
| Requests | 166 | 34 |
| Blank frames | 7 | 0 |
| In-motion detail promotions | 15 | 0 |
| Stale discards | 23 | 2 |

Those numbers are **Quackles evidence only**. They are not ComfyUI performance
claims. Their purpose is to justify testing the scheduling invariants here.

## Browser experiment

### Fixture

Use one committed synthetic/public pyramid large enough to require multiple
levels and enough tiles to exercise eviction.

The fixture must contain no private prompts or user media.

### Interaction trace

Run a fixed trace in `MediaLightbox`:

1. open;
2. wait for coarse coverage;
3. continuous zoom;
4. pan left/right while zoomed;
5. reverse direction;
6. stop and wait for settle;
7. navigate to the next gallery item before some prior detail completes;
8. navigate back.

### Deterministic assertions

The first PR should prefer exact invariants over timing thresholds:

- no blank surface after first coarse coverage;
- zero detail publication while the motion gate is active;
- prior-generation completions never publish;
- decoded-byte residency never exceeds the configured ceiling;
- gallery navigation invalidates previous item generations;
- no timers, decoders or object URLs survive close/unmount.

These align with the repository's existing deterministic-performance guidance.

### Distribution evidence

Follow
`docs/adr/PERF-BENCHMARKS-0022-performance-evidence-and-regression-framework.md`.

Record at least:

- raw in-window rAF intervals;
- p50 / p95 / p99 / worst;
- counts above 33.3 ms and 50 ms;
- request count;
- decoded bytes;
- peak resident bytes;
- stale request/decode bytes;
- cache hit/miss;
- time from final gesture to sharp visible viewport.

Run baseline and treatment sequentially on the same host with interleaved
repetitions. Do not mix headless/software and hardware-GPU histories.

## Relationship to existing rendering guidance

`RENDERING-ATOMICITY-0020` already establishes the useful principle that one
render unit should observe a coherent state rather than mixing snapshots during
one draw.

For large-image inspection the analogous unit is the viewport generation:
detail prepared for generation N must not mutate generation N+1's visible
surface.

This proposal does not change canvas rendering or reinterpret that ADR; it
reuses the same correctness principle at the media-viewer boundary.

## Implementation ladder

### Slice A — fixture + scheduler harness

- static pyramid fixture;
- viewport generation;
- visible tile selection;
- settle gate;
- stale completion refusal;
- decoded-byte LRU;
- deterministic tests and receipts.

No production `MediaLightbox` path yet.

### Slice B — lightbox integration behind an explicit source

- add an optional multiresolution image branch;
- retain the existing single-URL branch exactly;
- reuse lightbox focus/navigation ownership;
- prove gallery-item cancellation.

### Slice C — backend/source production

Only after the frontend experiment wins:

- decide manifest ownership;
- derive/store pyramids;
- define cache/invalidation semantics;
- define cleanup/lifecycle;
- evaluate storage cost.

### Slice D — comparison/workflow surfaces

Comparison modes and node-inline previews are follow-ups. Do not broaden the
first viewer experiment to every image surface.

## Promotion gate

Do not propose a generic production API merely because the fixture works.

A promotion candidate needs:

- deterministic correctness gates green;
- real large-image browser evidence;
- no ordinary-image behavior regression;
- bounded memory;
- materially better interaction tails and/or time-to-sharp;
- an explicit backend/storage cost estimate.

Until then, `#19788` remains a feature/research discussion rather than an
implementation commitment.
