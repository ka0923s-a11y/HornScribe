import { describe, expect, it, vi } from 'vitest'
import { TransportCore } from './core'
import { FakeMediaPort } from './fakeMediaPort'
import type { TransportSnapshot } from './types'

function makeCore(duration = 60, opts?: ConstructorParameters<typeof TransportCore>[1]) {
  const port = new FakeMediaPort(duration)
  const core = new TransportCore(port, opts)
  port.seekTo(0)
  port.seeks.length = 0
  core.onLoaded(duration)
  return { core, port }
}

function collect(core: TransportCore) {
  const snaps: TransportSnapshot[] = []
  core.subscribe((s) => snaps.push(s))
  return snaps
}

describe('TransportCore lifecycle', () => {
  it('starts empty and becomes ready on load', () => {
    const port = new FakeMediaPort()
    const core = new TransportCore(port)
    expect(core.getSnapshot().status).toBe('empty')
    core.onLoadStart()
    expect(core.getSnapshot().status).toBe('loading')
    core.onLoaded(30)
    expect(core.getSnapshot().status).toBe('ready')
    expect(core.getDuration()).toBe(30)
  })

  it('rejects play/seek while empty or loading', async () => {
    const port = new FakeMediaPort()
    const core = new TransportCore(port)
    await core.play()
    await core.seek(5)
    expect(port.playCalls).toBe(0)
    expect(port.seeks).toEqual([])
    core.onLoadStart()
    await core.play()
    await core.seek(5)
    expect(port.playCalls).toBe(0)
    expect(port.seeks).toEqual([])
  })

  it('play → pause → ended transitions', async () => {
    const { core, port } = makeCore()
    await core.play()
    expect(core.getSnapshot().status).toBe('playing')
    core.pause()
    expect(core.getSnapshot().status).toBe('paused')
    port.time = port.duration
    core.onEnded()
    expect(core.getSnapshot().status).toBe('ended')
    // play() after end restarts from 0
    port.seeks.length = 0
    await core.play()
    expect(port.seeks).toEqual([0])
    expect(core.getSnapshot().status).toBe('playing')
  })
})

describe('TransportCore seek edges', () => {
  it('clamps seeks to [0, duration]', async () => {
    const { core, port } = makeCore(60)
    await core.seek(-5)
    expect(port.seeks.at(-1)).toBe(0)
    await core.seek(999)
    expect(port.seeks.at(-1)).toBe(60)
    await core.seek(12.5)
    expect(port.seeks.at(-1)).toBe(12.5)
    expect(core.getSnapshot().time).toBe(12.5)
  })

  it('treats NaN/Infinity seeks as 0', async () => {
    const { core, port } = makeCore()
    await core.seek(Number.NaN)
    expect(port.seeks.at(-1)).toBe(0)
    await core.seek(Number.POSITIVE_INFINITY)
    expect(port.seeks.at(-1)).toBe(0)
  })

  it('stop() returns to 0 without a loop and to loop.start with one', async () => {
    const { core, port } = makeCore()
    await core.seek(20)
    core.stop()
    expect(port.seeks.at(-1)).toBe(0)
    expect(core.getSnapshot().status).toBe('paused')

    core.setLoop({ start: 4, end: 8 })
    await core.seek(6)
    core.stop()
    expect(port.seeks.at(-1)).toBe(4)
  })
})

describe('TransportCore loop edges', () => {
  it('rejects degenerate or inverted ranges', () => {
    const { core } = makeCore(60)
    expect(core.setLoop({ start: 10, end: 10 })).toBe(false)
    expect(core.setLoop({ start: 10, end: 9 })).toBe(false)
    expect(core.setLoop({ start: -1, end: 0.001 })).toBe(false)
    expect(core.setLoop({ start: Number.NaN, end: 5 })).toBe(false)
    expect(core.getSnapshot().loop).toBeNull()
  })

  it('clamps ranges into [0, duration]', () => {
    const { core } = makeCore(60)
    expect(core.setLoop({ start: -3, end: 500 })).toBe(true)
    expect(core.getSnapshot().loop).toEqual({ start: 0, end: 60 })
  })

  it('wraps to loop.start when the clock crosses loop.end while playing', async () => {
    const wraps: number[] = []
    const { core, port } = makeCore(60, {
      onLoopWrap: (i) => wraps.push(i.overshoot),
    })
    core.setLoop({ start: 10, end: 12 })
    await core.seek(10.5)
    await core.play()
    port.seeks.length = 0

    port.time = 11.9
    core.onTick()
    expect(port.seeks).toEqual([]) // still inside

    port.time = 12.02 // overshoot the end between ticks
    core.onTick()
    expect(port.seeks.at(-1)).toBe(10)
    expect(wraps).toHaveLength(1)
    expect(wraps[0]).toBeCloseTo(0.02, 5)
    expect(core.getSnapshot().status).toBe('playing')
  })

  it('does not wrap when loop is cleared mid-flight', async () => {
    const { core, port } = makeCore()
    core.setLoop({ start: 10, end: 12 })
    await core.play()
    core.setLoop(null)
    port.seeks.length = 0
    port.time = 15
    core.onTick()
    expect(port.seeks).toEqual([])
    expect(core.getSnapshot().status).toBe('playing')
  })

  it('explicit seek outside the armed loop disarms until re-entry', async () => {
    const { core, port } = makeCore()
    core.setLoop({ start: 10, end: 12 })
    await core.play()

    // Escape: user seeks beyond the loop end while playing.
    await core.seek(20)
    port.seeks.length = 0
    port.time = 20.5
    core.onTick()
    expect(port.seeks).toEqual([]) // no snap-back

    // Playhead re-enters the range → enforcement re-arms.
    port.time = 11
    core.onTick()
    port.time = 12.01
    core.onTick()
    expect(port.seeks.at(-1)).toBe(10)
  })

  it('arming a loop while the playhead is inside enforces immediately', async () => {
    const { core, port } = makeCore()
    await core.play()
    port.time = 10.5
    core.onTick()
    expect(core.setLoop({ start: 10, end: 11 })).toBe(true)
    port.seeks.length = 0
    port.time = 11.05
    core.onTick()
    expect(port.seeks.at(-1)).toBe(10)
  })

  it('arming a loop while the playhead is beyond loop.end does not wrap', async () => {
    const { core, port } = makeCore()
    await core.play()
    port.time = 50
    core.onTick()
    port.seeks.length = 0
    core.setLoop({ start: 10, end: 11 })
    port.time = 55
    core.onTick()
    expect(port.seeks).toEqual([])
    expect(core.getSnapshot().status).toBe('playing')
  })

  it('reaching media end transitions to ended even with an armed loop outside', async () => {
    const { core, port } = makeCore(30)
    await core.play()
    core.setLoop({ start: 5, end: 8 }) // playhead at 0 → loop armed at start…
    port.time = 30
    core.onTick()
    expect(core.getSnapshot().status).toBe('ended')
  })
})

describe('TransportCore rate and pitch', () => {
  it('clamps rate to [MIN_RATE, MAX_RATE] and forwards to the port', () => {
    const { core, port } = makeCore()
    core.setRate(0.75)
    expect(port.rate).toBe(0.75)
    core.setRate(0.01)
    expect(port.rate).toBe(0.25)
    core.setRate(99)
    expect(port.rate).toBe(4)
    core.setRate(Number.NaN)
    expect(port.rate).toBe(4) // unchanged
  })

  it('forwards preservePitch changes', () => {
    const { core, port } = makeCore()
    expect(port.preservePitch).toBe(true)
    core.setPreservePitch(false)
    expect(port.preservePitch).toBe(false)
    expect(core.getSnapshot().preservePitch).toBe(false)
  })
})

describe('TransportCore subscription policy', () => {
  it('does not emit a snapshot for sub-interval time updates', async () => {
    const { core, port } = makeCore(60, { timeEmitInterval: 0.1 })
    await core.play()
    const snaps = collect(core)
    const before = snaps.length
    // 20 ticks × 4 ms = 80 ms < 100 ms threshold → no time-only emission
    for (let i = 0; i < 20; i += 1) {
      port.advance(0.004)
      core.onTick()
    }
    expect(snaps.length).toBe(before)
    port.advance(0.05)
    core.onTick() // cumulative advance past threshold
    expect(snaps.length).toBe(before + 1)
  })

  it('emits immediately on backward time moves (seeks)', async () => {
    const { core, port } = makeCore()
    await core.play()
    const snaps = collect(core)
    const before = snaps.length
    port.time = 1 // moved backward
    core.onTick()
    expect(snaps.length).toBe(before + 1)
  })

  it('unsubscribe stops notifications', async () => {
    const { core } = makeCore()
    const listener = vi.fn()
    const off = core.subscribe(listener)
    await core.play()
    expect(listener).toHaveBeenCalled()
    off()
    core.pause()
    expect(listener.mock.calls.length).toBe(1)
  })
})
