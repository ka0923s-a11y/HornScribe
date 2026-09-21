/**
 * UI-004 measurement driver.
 *
 * Serves the production build (vite preview) and drives it with a real
 * Chromium-family browser via puppeteer-core — Edge by default, which shares
 * the engine WebView2 uses, so numbers approximate the Tauri target.
 *
 *   node scripts/measure.mjs [--quick] [--browser=edge|chrome] [--url=http://localhost:4173]
 *
 * Writes measurements/ui-004-<timestamp>.json (gitignored) and prints the
 * same JSON to stdout.
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
const quick = args.includes('--quick')
// Edge headless conflicts with an existing Edge session on some machines;
// Chrome is the default (same Chromium engine family as WebView2).
const browserArg = args.find((a) => a.startsWith('--browser='))?.split('=')[1] ?? 'chrome'
const explicitUrl = args.find((a) => a.startsWith('--url='))?.split('=')[1]
const only = args.find((a) => a.startsWith('--only='))?.split('=')[1]?.split(',')

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

  // Serve the production build unless an external URL was given.
  let server = null
  const baseUrl = explicitUrl ?? 'http://localhost:4173'
  if (!explicitUrl) {
    // Launch vite directly via node so the child is reliably killable.
    server = spawn(
      process.execPath,
      [join(appDir, 'node_modules/vite/bin/vite.js'), 'preview', '--port', '4173', '--strictPort'],
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
      '--enable-precise-memory-info',
      '--mute-audio',
      '--disable-renderer-backgrounding',
      '--window-size=1600,900',
      '--no-sandbox',
      `--user-data-dir=${process.env.TEMP ?? '.'}/ui004-measure-profile`,
    ],
  })

  const fixtures = only ?? ['30s', '3min', '10min']
  const reports = []
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1600, height: 900 })
    page.on('pageerror', (e) => console.error('pageerror:', e.message))

    for (const id of fixtures) {
      console.log(`\n=== fixture ${id} ===`)
      // Fresh document per fixture so the memory baseline is honest.
      await page.goto(baseUrl, { waitUntil: 'networkidle0' })
      await page.waitForFunction('window.__ui004 !== undefined', { timeout: 20000 })
      const baseline = await page.evaluate(() => window.__ui004.readMemoryMB())

      const label = await page.evaluate(
        (fid) => window.__ui004.loadFixture(fid),
        id,
      )
      console.log(`loaded: ${label}`)

      const report = await page.evaluate(async (q) => {
        return window.__ui004.runCurrent({ quick: q })
      }, quick)
      report.fixture = label || id
      report.memory.beforeLoadMB = baseline
      reports.push(report)
      console.log(
        `  ready=${report.loadReadyMs?.toFixed(0)}ms seek p50=${report.seek?.medianMs?.toFixed(1)}ms ` +
          `loop drift=${report.loop?.periodErrMeanMs?.toFixed(2)}ms mem=${report.memory?.afterLoadMB?.toFixed(1)}MB`,
      )
    }
  } finally {
    await browser.close()
    server?.kill()
  }

  const doc = {
    tool: 'ui-004-spike',
    timestamp: new Date().toISOString(),
    browser: browserPath,
    quick,
    fixtures: reports,
  }
  mkdirSync(outDir, { recursive: true })
  const file = join(outDir, `ui-004-${Date.now()}.json`)
  writeFileSync(file, JSON.stringify(doc, null, 2))
  console.log(`\nwrote ${file}`)
  console.log(JSON.stringify(doc, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
