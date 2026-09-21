/**
 * UI-005 measurement driver.
 *
 * Serves the production build (vite preview) and drives the in-page harness
 * (src/measure/harness.ts, exposed as window.__ui005) with a real
 * Chromium-family browser via puppeteer-core — Chrome by default (same
 * Blink/V8 family as the WebView2 target; Edge headless conflicts with
 * existing Edge sessions on some machines — see UI-004 results).
 *
 *   node scripts/measure.mjs [--browser=edge|chrome] [--url=http://localhost:4173]
 *                            [--fixture=steady|warped] [--port=4173]
 *
 * Writes measurements/ui-005-<timestamp>.json and prints the same JSON.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import puppeteer from 'puppeteer-core'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '..')
const outDir = join(appDir, 'measurements')

const args = process.argv.slice(2)
const browserArg = args.find((a) => a.startsWith('--browser='))?.split('=')[1] ?? 'chrome'
const explicitUrl = args.find((a) => a.startsWith('--url='))?.split('=')[1]
const fixtures = args.find((a) => a.startsWith('--fixture='))?.split('=')[1]?.split(',') ?? [
  'steady',
  'warped',
]
const port = args.find((a) => a.startsWith('--port='))?.split('=')[1] ?? '4173'

const BROWSERS = {
  edge: [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ],
  chrome: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ],
}

function findBrowser() {
  const candidates = [...(BROWSERS[browserArg] ?? []), ...BROWSERS.chrome, ...BROWSERS.edge]
  for (const p of candidates) if (existsSync(p)) return p
  throw new Error('No Edge/Chrome executable found for puppeteer-core')
}

async function waitForServer(url, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`server did not start: ${url}`)
}

async function main() {
  const browserPath = findBrowser()
  console.log(`browser: ${browserPath}`)

  let server = null
  const baseUrl = explicitUrl ?? `http://localhost:${port}`
  if (!explicitUrl) {
    server = spawn(
      process.execPath,
      [
        join(appDir, 'node_modules/vite/bin/vite.js'),
        'preview',
        '--port',
        port,
        '--strictPort',
      ],
      { cwd: appDir, stdio: 'pipe' },
    )
    server.stderr?.on('data', (d) => process.stderr.write(d))
    await waitForServer(baseUrl)
    console.log(`preview server: ${baseUrl}`)
  }

  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: true,
    protocolTimeout: 600_000,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--disable-renderer-backgrounding',
      '--window-size=1600,900',
      '--no-sandbox',
      `--user-data-dir=${process.env.TEMP ?? '.'}/ui005-measure-profile`,
    ],
  })

  const reports = []
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1600, height: 900 })
    page.on('pageerror', (e) => console.error('pageerror:', e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') console.error('console.error:', m.text())
    })

    await page.goto(baseUrl, { waitUntil: 'networkidle0' })
    await page.waitForFunction('window.__ui005 !== undefined', { timeout: 30000 })

    for (const id of fixtures) {
      console.log(`\n=== fixture ${id} ===`)
      await page.evaluate((fid) => window.__ui005.setFixture(fid), id)
      await page.waitForFunction('window.__ui005.ready()', { timeout: 30000 })
      const report = await page.evaluate(() => window.__ui005.runCurrent(), {
        timeout: 300_000,
      })
      report.fixtureId = id
      reports.push(report)
      console.log(
        `  seek p50=${report.scoreClickSeek?.medianMs?.toFixed(1)}ms ` +
          `wave p50=${report.waveClickSelect?.medianMs?.toFixed(1)}ms ` +
          `sync lag mean=${report.sync?.lagMeanMs?.toFixed(1)}ms ` +
          `react=${report.sync?.reactRenders} verovio=${report.sync?.verovioRenderCalls} ` +
          `loop drift=${report.loopDrift?.periodErrMeanMs?.toFixed(1)}ms`,
      )
    }
  } finally {
    await browser.close()
    server?.kill()
  }

  const doc = {
    tool: 'ui-005-spike',
    timestamp: new Date().toISOString(),
    userAgent: reports.length ? undefined : '',
    browser: browserPath,
    fixtures: reports,
  }
  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, `ui-005-${Date.now()}.json`)
  writeFileSync(file, JSON.stringify(doc, null, 2))
  console.log(`\nwrote ${file}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
