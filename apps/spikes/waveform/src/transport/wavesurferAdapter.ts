import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin, { type Region } from 'wavesurfer.js/dist/plugins/regions.js'
import { TransportCore, type MediaPort, type TransportCoreOptions } from './core'
import type {
  AudioSource,
  LoopWrapInfo,
  TimeRange,
  TransportController,
  TransportListener,
  TransportSnapshot,
  Unsubscribe,
} from './types'

export interface WaveSurferAdapterOptions extends TransportCoreOptions {
  container: HTMLElement
  height?: number
  waveColor?: string
  progressColor?: string
  cursorColor?: string
  /** Region fill while it is a plain selection (loop off). */
  selectionColor?: string
  /** Region fill while the selection is armed as the A-B loop. */
  loopColor?: string
  /** Called when a loop wrap occurs (measurement hook). */
  onLoopWrap?: (info: LoopWrapInfo) => void
}

/**
 * wavesurfer.js adapter for the HornScribe TransportController.
 *
 * Boundary rules (MASTER_PLAN §4.7/§10):
 *  - TransportCore owns state + policy; this class only translates between
 *    wavesurfer/HTMLMediaElement and the core.
 *  - The clock is the media element clock, pumped through a rAF loop owned
 *    here — never React state and never wavesurfer view state.
 *  - The loop region is a *view* of TransportCore.loop + the current drag
 *    selection; engine details (Regions plugin) do not leak past this file.
 */
export class WaveSurferTransportAdapter implements TransportController {
  readonly core: TransportCore
  private ws: WaveSurfer
  private regions: RegionsPlugin
  private unsubscribers: Unsubscribe[] = []
  private rafId: number | null = null
  private selectionRegion: Region | null = null
  /** Current waveform selection (region view state, not core state). */
  private selection: TimeRange | null = null
  private syncingRegion = false
  private loadTiming: { fetchDecodeMs: number; readyMs: number } | null = null
  private wrapListeners = new Set<(info: LoopWrapInfo) => void>()
  private selectionListener: ((sel: TimeRange | null) => void) | null = null

  constructor(opts: WaveSurferAdapterOptions) {
    const ws = WaveSurfer.create({
      container: opts.container,
      height: opts.height ?? 112,
      waveColor: opts.waveColor ?? '#4a6f9e',
      progressColor: opts.progressColor ?? '#7fb3ff',
      cursorColor: opts.cursorColor ?? '#e8b339',
      cursorWidth: 2,
      autoScroll: true,
      autoCenter: false,
      // dragToSeek MUST stay off: its document-level pointermove handler calls
      // preventDefault(), which starves the Regions plugin's drag-selection
      // stream (it bails on event.defaultPrevented). Drag = range select;
      // click = seek via the normal interaction path.
      dragToSeek: false,
      minPxPerSec: 0,
      fillParent: true,
      hideScrollbar: false,
    })
    this.ws = ws

    this.regions = ws.registerPlugin(RegionsPlugin.create())
    this.regions.enableDragSelection({
      color: opts.selectionColor ?? 'rgba(232, 179, 57, 0.25)',
      drag: true,
      resize: true,
    })

    const port: MediaPort = {
      play: () => ws.play(),
      pause: () => ws.pause(),
      seekTo: (t) => ws.setTime(t),
      setRate: (rate) => ws.setPlaybackRate(rate, this.core.getSnapshot().preservePitch),
      setPreservePitch: (on) => this.applyPreservePitch(on),
      getTime: () => {
        const media = ws.getMediaElement()
        return media ? media.currentTime : ws.getCurrentTime()
      },
      getDuration: () => ws.getDuration(),
    }
    this.core = new TransportCore(port, {
      ...opts,
      onLoopWrap: (info) => {
        for (const cb of this.wrapListeners) cb(info)
        opts.onLoopWrap?.(info)
      },
    })

    this.wireEvents()
  }

  // ---- TransportController ------------------------------------------------

  async load(source: AudioSource): Promise<void> {
    const t0 = performance.now()
    let decodeAt = 0
    const offs: Unsubscribe[] = []
    const ready = new Promise<void>((resolve, reject) => {
      const cleanup = () => offs.splice(0).forEach((off) => off())
      offs.push(
        this.ws.once('ready', () => {
          this.loadTiming = { fetchDecodeMs: decodeAt - t0, readyMs: performance.now() - t0 }
          cleanup()
          resolve()
        }),
        this.ws.once('error', (err) => {
          cleanup()
          reject(err instanceof Error ? err : new Error(String(err)))
        }),
        this.ws.on('decode', () => {
          decodeAt = performance.now()
        }),
      )
    })
    this.core.onLoadStart()
    if (source.kind === 'blob') {
      void this.ws.loadBlob(source.blob)
    } else {
      void this.ws.load(source.url)
    }
    await ready
  }

  /** Wall-clock ms for fetch+decode ('load'→'decode') and total to 'ready'. */
  getLoadTiming(): { fetchDecodeMs: number; readyMs: number } | null {
    return this.loadTiming
  }

  play(): Promise<void> {
    return this.core.play()
  }

  pause(): void {
    this.core.pause()
  }

  stop(): void {
    this.core.stop()
  }

  async seek(seconds: number): Promise<void> {
    // Attach the 'seeked' waiter BEFORE issuing the seek — a fast seek can
    // complete before a post-hoc listener is attached.
    const media = this.ws.getMediaElement()
    let finish: () => void = () => {}
    const settled = new Promise<void>((resolve) => {
      if (!media) return resolve()
      let done = false
      finish = () => {
        if (done) return
        done = true
        media.removeEventListener('seeked', finish)
        resolve()
      }
      media.addEventListener('seeked', finish)
      setTimeout(finish, 800)
    })
    await this.core.seek(seconds)
    // If the UA applied the seek synchronously there is nothing to wait for.
    if (!media || !media.seeking) finish()
    await settled
  }

  setRate(rate: number): void {
    this.core.setRate(rate)
  }

  setPreservePitch(on: boolean): void {
    this.core.setPreservePitch(on)
  }

  private applyPreservePitch(on: boolean): void {
    const media = this.ws.getMediaElement()
    if (media && 'preservesPitch' in media) {
      media.preservesPitch = on
    }
    // wavesurfer re-asserts preservesPitch on every setPlaybackRate call;
    // re-apply with the current rate so the flag takes effect now.
    this.ws.setPlaybackRate(this.core.getSnapshot().rate, on)
  }

  setLoop(range: TimeRange | null): void {
    const applied = this.core.setLoop(range)
    if (!applied) return
    if (range !== null) {
      // Contract callers may arm a loop with no prior selection: materialize
      // the region view so the loop is visible and adjustable.
      const s = this.core.getSnapshot().loop
      if (s) {
        this.selection = { ...s }
        this.syncingRegion = true
        if (!this.selectionRegion || this.selectionRegion.isRemoved) {
          this.selectionRegion = this.regions.addRegion({
            start: s.start,
            end: s.end,
            drag: true,
            resize: true,
            color: 'rgba(96, 203, 148, 0.30)',
          })
        } else {
          this.selectionRegion.setOptions({ start: s.start, end: s.end })
        }
        this.syncingRegion = false
      }
    }
    this.refreshRegionStyle()
  }

  getCurrentTime(): number {
    return this.core.getTime()
  }

  getDuration(): number {
    return this.core.getDuration()
  }

  getSnapshot(): TransportSnapshot {
    return this.core.getSnapshot()
  }

  subscribe(listener: TransportListener): Unsubscribe {
    return this.core.subscribe(listener)
  }

  dispose(): void {
    this.stopClock()
    for (const off of this.unsubscribers) off()
    this.ws.destroy()
  }

  // ---- adapter extras (view/measurement surface, not contract) ------------

  /** Escape hatch for the spike view layer (plugins, scroll, peaks). */
  getWavesurfer(): WaveSurfer {
    return this.ws
  }

  /** Regions plugin handle (measurement/tests; region objects are view state). */
  getRegionsPlugin(): RegionsPlugin {
    return this.regions
  }

  /** Observe loop wraps (measurement). Returns an unsubscribe function. */
  onLoopWrap(cb: (info: LoopWrapInfo) => void): Unsubscribe {
    this.wrapListeners.add(cb)
    return () => this.wrapListeners.delete(cb)
  }

  /** Selection (region) changes — view-level state, distinct from the loop. */
  setSelectionListener(cb: ((sel: TimeRange | null) => void) | null): void {
    this.selectionListener = cb
  }

  private emitSelection(): void {
    this.selectionListener?.(this.selection ? { ...this.selection } : null)
  }

  getSelection(): TimeRange | null {
    return this.selection ? { ...this.selection } : null
  }

  clearSelection(): void {
    this.selection = null
    this.syncingRegion = true
    this.selectionRegion?.remove()
    this.selectionRegion = null
    this.syncingRegion = false
    this.setLoop(null)
    this.emitSelection()
  }

  /** Play the current selection once (stops at its end). */
  async playSelection(): Promise<void> {
    if (!this.selection) return
    await this.core.seek(this.selection.start)
    await this.core.play()
    // One-shot playback-to-end: park the "stop" via a tick watcher.
    const end = this.selection.end
    const off = this.core.subscribe(() => {
      if (this.core.getTime() >= end && this.core.isPlaying()) {
        off()
        this.core.pause()
      }
    })
  }

  /** Zoom in pixels-per-second; clamped to fit-parent..4000. */
  zoom(pxPerSec: number): void {
    const duration = this.ws.getDuration()
    const width = this.ws.getWidth() || 1
    const fitPx = duration > 0 ? width / duration : 1
    const clamped = Math.max(fitPx, Math.min(4000, pxPerSec))
    this.ws.zoom(clamped)
  }

  getZoomPxPerSec(): number {
    const duration = this.ws.getDuration()
    if (this.ws.options.minPxPerSec && this.ws.options.minPxPerSec > 0) {
      return this.ws.options.minPxPerSec
    }
    const width = this.ws.getWidth() || 1
    return duration > 0 ? width / duration : 1
  }

  /** Ctrl+wheel zoom anchored at the cursor position (copy deck: Ctrl+ホイール). */
  attachWheelZoom(): Unsubscribe {
    const wrapper = this.ws.getWrapper()
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return
      e.preventDefault()
      const duration = this.ws.getDuration()
      if (!duration) return
      const rect = wrapper.getBoundingClientRect()
      const x = e.clientX - rect.left
      const px = this.getZoomPxPerSec()
      const pointerTime = (this.ws.getScroll() + x) / px
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2
      const next = Math.min(4000, Math.max(rect.width / duration, px * factor))
      this.ws.zoom(next)
      wrapper.scrollLeft = Math.max(0, pointerTime * next - x)
    }
    wrapper.addEventListener('wheel', onWheel, { passive: false })
    return () => wrapper.removeEventListener('wheel', onWheel)
  }

  setFollow(on: boolean): void {
    this.ws.setOptions({ autoScroll: on, autoCenter: on })
  }

  // ---- engine wiring -------------------------------------------------------

  private wireEvents(): void {
    const ws = this.ws
    this.unsubscribers.push(
      ws.on('ready', (d) => {
        this.core.onLoaded(d)
        this.applyPreservePitch(this.core.getSnapshot().preservePitch)
      }),
      ws.on('play', () => {
        this.core.onPlayStart()
        this.startClock()
      }),
      ws.on('pause', () => {
        this.core.onPaused()
        this.stopClock()
      }),
      ws.on('finish', () => {
        this.core.onEnded()
        this.stopClock()
      }),
      ws.on('error', () => {
        this.core.onError()
        this.stopClock()
      }),
      ws.on('seeking', () => this.core.onTick()),
      ws.on('timeupdate', () => {
        // Covers seeks while paused and any timeupdate outside the rAF pump.
        if (!this.core.isPlaying()) this.core.onTick()
      }),
    )

    this.unsubscribers.push(
      this.regions.on('region-created', (region) => {
        if (this.syncingRegion) return
        // Drag-select replaces the previous selection region.
        if (this.selectionRegion && this.selectionRegion !== region) {
          this.syncingRegion = true
          this.selectionRegion.remove()
          this.syncingRegion = false
        }
        this.selectionRegion = region
        // 'region-updated' does NOT fire for the initial drag — capture the
        // range here; handle drags come through 'region-updated' below.
        this.selection = { start: region.start, end: region.end }
        this.emitSelection()
        this.refreshRegionStyle()
      }),
      this.regions.on('region-updated', (region) => {
        if (this.syncingRegion || region !== this.selectionRegion) return
        this.selection = { start: region.start, end: region.end }
        this.emitSelection()
        // While a loop is armed, moving the selection moves the loop.
        if (this.core.getSnapshot().loop) {
          this.core.setLoop(this.selection)
        }
      }),
      this.regions.on('region-removed', (region) => {
        if (region === this.selectionRegion) {
          this.selectionRegion = null
          this.selection = null
          this.emitSelection()
          if (this.core.getSnapshot().loop) this.core.setLoop(null)
        }
      }),
      this.regions.on('region-double-clicked', (region, e) => {
        e.stopPropagation()
        if (region === this.selectionRegion) this.clearSelection()
      }),
    )
  }

  /** rAF clock pump: the transport owns loop enforcement + time emission. */
  private startClock(): void {
    if (this.rafId !== null) return
    const tick = () => {
      this.core.onTick()
      if (this.core.isPlaying()) {
        this.rafId = requestAnimationFrame(tick)
      } else {
        this.rafId = null
      }
    }
    this.rafId = requestAnimationFrame(tick)
  }

  private stopClock(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  private refreshRegionStyle(): void {
    const looped = this.core.getSnapshot().loop !== null
    this.selectionRegion?.setOptions({
      color: looped ? 'rgba(96, 203, 148, 0.30)' : 'rgba(232, 179, 57, 0.25)',
    })
  }
}
