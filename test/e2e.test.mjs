// End-to-end tests in Chromium. Run after `bash build.sh`:  node --test test/e2e.test.mjs
// Set CHROME_PATH to use a local Chrome instead of Playwright's Chromium.
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium } from 'playwright'

const DIST = new URL('../dist/', import.meta.url).pathname
const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' }
let server, browser, base

before(async () => {
  server = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/chess-coach/, '')
    const f = path.join(DIST, u.endsWith('/') ? u + 'index.html' : u)
    if (!f.startsWith(DIST) || !fs.existsSync(f)) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' })
    fs.createReadStream(f).pipe(res)
  })
  await new Promise((r) => server.listen(0, r))
  base = `http://localhost:${server.address().port}/chess-coach/` // same subpath as GitHub Pages
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ['--no-sandbox'] })
})
after(async () => { await browser?.close(); server?.close() })

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(base)
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.uncheck('#useMaia')
  await page.selectOption('#depth', 'fast')
  return { page, errors }
}
async function waitDone(page, sel = '#st-sf', prefix = 'pronto', ms = 180000) {
  await page.waitForFunction(([s, p]) => document.querySelector(s)?.textContent.startsWith(p), [sel, prefix], { timeout: ms })
}
async function sq(page, square, flip = false) {
  const b = await page.locator('#board svg').boundingBox()
  const f = 'abcdefgh'.indexOf(square[0]), r = +square[1] - 1
  const x = (flip ? 7 - f : f) + 0.5, y = (flip ? r : 7 - r) + 0.5
  return [b.x + (x * b.width) / 8, b.y + (y * b.height) / 8]
}
async function drag(page, a, b, flip = false) {
  await page.mouse.move(...(await sq(page, a, flip))); await page.mouse.down()
  await page.mouse.move(...(await sq(page, b, flip)), { steps: 8 }); await page.mouse.up()
}

describe('app', () => {
  test('review completo + Maia + coach', { timeout: 300000 }, async () => {
    const { page, errors } = await newPage()
    await page.check('#useMaia')
    await page.fill('#pgn', read('game2.pgn'))
    await page.click('.chip[data-side=w]')
    await page.click('#go')
    await waitDone(page)
    await waitDone(page, '#st-maia', 'pronto')
    const summary = await page.textContent('#summary')
    assert.match(summary, /Precisão/)
    await page.evaluate(() => document.querySelector('#mv33').click()) // 17.Nf7
    const coach = await page.textContent('#coach')
    assert.match(coach, /capivarada/)
    assert.match(coach, /mate em 1/)
    assert.match(coach, /Maia/)
    assert.deepEqual(errors, [])
  })

  test('tentar de novo arrastando a peça', { timeout: 300000 }, async () => {
    const { page, errors } = await newPage()
    await page.fill('#pgn', read('game2.pgn'))
    await page.click('#go'); await waitDone(page)
    await page.evaluate(() => document.querySelector('#mv33').click())
    await page.click('[data-act=retry]')
    await drag(page, 'a3', 'a4')
    await page.waitForFunction(() => /não é o melhor/.test(document.querySelector('#coach').textContent), null, { timeout: 60000 })
    await page.click('[data-act=reveal]')
    assert.match(await page.textContent('#coach'), /O lance era/)
    assert.deepEqual(errors, [])
  })

  test('explorar variante a partir da partida', { timeout: 300000 }, async () => {
    const { page, errors } = await newPage()
    await page.fill('#pgn', read('game2.pgn'))
    await page.click('#go'); await waitDone(page)
    await page.evaluate(() => document.querySelector('#mv32').click())
    await drag(page, 'g5', 'f7')
    await page.waitForFunction(() => /permite mate em 1/.test(document.querySelector('#coach').textContent), null, { timeout: 60000 })
    assert.match(await page.textContent('#coach'), /Explorando variante/)
    assert.deepEqual(errors, [])
  })

  test('várias partidas, lado das pretas e relógio', { timeout: 300000 }, async () => {
    const { page, errors } = await newPage()
    const clock = read('game-clock.pgn').replace('"matheus_anzzulin"', '"Fulano"').replace('"Ronkolan"', '"matheus_anzzulin"')
    await page.fill('#pgn', read('game2.pgn').trim() + '\n\n' + clock)
    await page.waitForSelector('#gamePick')
    await page.click('.chip[data-side=b]')
    assert.equal(await page.inputValue('#user'), 'matheus_anzzulin')
    await page.click('#go'); await waitDone(page)
    assert.match(await page.textContent('#pBot'), /matheus_anzzulin.*você/) // pretas embaixo
    await page.evaluate(() => document.querySelector('#mv4').click())
    assert.match(await page.textContent('#pTop'), /4:54/)
    assert.match(await page.textContent('#pBot'), /4:35/)
    assert.match(await page.textContent('#moves'), /18s/)
    assert.deepEqual(errors, [])
  })

  test('FEN abre no modo explorar', { timeout: 120000 }, async () => {
    const { page, errors } = await newPage()
    await page.fill('#pgn', 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3')
    await page.click('#go')
    await page.waitForFunction(() => /Melhor aqui/.test(document.querySelector('#coach').textContent), null, { timeout: 60000 })
    assert.deepEqual(errors, [])
  })
})
