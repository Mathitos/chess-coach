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
const MIME = { '.png': 'image/png', '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' }
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
  await page.selectOption('#depth', 'fast') // padrão é Profunda; nos testes usa a rápida
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
  await page.waitForTimeout(250)
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
    await page.waitForFunction(() => /não é a resposta/.test(document.querySelector('#coach').textContent), null, { timeout: 60000 })
    await page.click('[data-act=reveal]')
    assert.match(await page.textContent('#coach'), /O lance era/)
    assert.deepEqual(errors, [])
  })

  test('variante: arrastar cria fork, ◀ volta pra partida e a variante fica salva', { timeout: 300000 }, async () => {
    const { page, errors } = await newPage()
    await page.fill('#pgn', read('game2.pgn'))
    await page.click('#go'); await waitDone(page)
    await page.evaluate(() => document.querySelector('#mv32').click()) // depois de 16...Qc6, vez das brancas
    await drag(page, 'g5', 'f7') // 17.Nf7 (igual à partida) só avança na linha principal
    assert.equal(await page.textContent('#counter'), '33/34')
    await page.click('#prev')
    await drag(page, 'd3', 'f5') // 17.Bxf5+ é um lance diferente: abre variante
    await page.waitForFunction(() => /Variante/.test(document.querySelector('#coach').textContent), null, { timeout: 60000 })
    await drag(page, 'c8', 'b8') // 17...Kb8 continua a variante
    assert.equal(await page.locator('.varrow .vmv').count(), 2)
    await page.click('#prev'); await page.click('#prev') // volta passando do ponto do fork
    assert.equal(await page.textContent('#counter'), '32/34') // linha principal
    assert.equal(await page.locator('.varrow .vmv').count(), 2) // variante continua no histórico
    await page.click('.varrow .vmv[data-j="2"]') // volta pra dentro da variante pelo histórico
    assert.equal(await page.textContent('#counter'), 'variante')
    await page.click('#prev')
    assert.match(await page.textContent('.vmv.cur'), /Bxf5/)
    await page.click('#next')
    assert.match(await page.textContent('.vmv.cur'), /Kb8/)
    // lance diferente no meio da variante cria outra variante sem apagar a primeira
    await page.click('#prev')
    await drag(page, 'd8', 'd7') // 17...Rd7 (bloqueia o xeque)
    assert.equal(await page.locator('.varrow').count(), 2)
    await page.click('.varrow .vdel >> nth=0')
    assert.equal(await page.locator('.varrow').count(), 1)
    assert.deepEqual(errors, [])
  })

  test('mexer na linha principal com o mesmo lance da partida só avança', { timeout: 300000 }, async () => {
    const { page, errors } = await newPage()
    await page.fill('#pgn', read('game2.pgn'))
    await page.click('#go'); await waitDone(page)
    await page.evaluate(() => document.querySelector('#mv32').click())
    await drag(page, 'g5', 'f7')
    await page.waitForFunction(() => /capivarada/.test(document.querySelector('#coach').textContent), null, { timeout: 60000 })
    assert.equal(await page.locator('.varrow').count(), 0)
    assert.deepEqual(errors, [])
  })

  test('explicar a linha lance a lance, mostrar visual e texto interativo', { timeout: 300000 }, async () => {
    const { page, errors } = await newPage()
    await page.fill('#pgn', read('game2.pgn'))
    await page.click('#go'); await waitDone(page)
    await page.evaluate(() => document.querySelector('#mv33').click()) // 17.Nf7??
    const arrows = () => page.locator('#board svg line').count()
    // botões "Mostrar…"
    const vis = page.locator('[data-vis]')
    assert.ok((await vis.count()) > 0)
    const before = await arrows()
    await vis.first().click()
    assert.ok((await arrows()) > before)
    assert.equal(await page.locator('[data-vis].on').count(), 1)
    // texto interativo: passar o mouse num lance citado desenha no tabuleiro
    await page.click('[data-vis].on') // desliga o overlay
    const base = await arrows()
    await page.hover('#coach .say .ref >> nth=0')
    assert.ok((await page.locator('#board svg rect').count()) > 64 || (await arrows()) > base)
    // explicar passo a passo, sem autoplay
    await page.click('[data-act=punish]')
    assert.match(await page.textContent('#coach'), /lance por lance/)
    await page.waitForTimeout(2000)
    assert.match(await page.textContent('#coach'), /lance 0\//) // não andou sozinho
    await page.click('[data-act=lnext]')
    assert.match(await page.textContent('#coach .say.step'), /Nf7/)
    await page.click('[data-act=lnext]')
    assert.match(await page.textContent('#coach .say.step'), /mate/)
    assert.deepEqual(errors, [])
  })

  test('revisão guiada: autoplay até o momento-chave e puzzle', { timeout: 300000 }, async () => {
    const { page, errors } = await newPage()
    await page.fill('#pgn', read('game2.pgn'))
    await page.click('.chip[data-side=w]')
    await page.click('#go'); await waitDone(page)
    await page.waitForSelector('[data-act=gstart]')
    assert.match(await page.textContent('#guide'), /momentos-chave/)
    await page.click('[data-act=gstart]')
    // autoplay anda 1 lance a cada 1,5s (não pula direto)
    await page.waitForTimeout(3300)
    const n = +(await page.textContent('#counter')).split('/')[0]
    assert.ok(n >= 1 && n <= 3, 'autoplay deveria ter andado 2 lances, andou ' + n)
    await page.waitForFunction(() => /Momento-chave|Acha a punição/.test(document.querySelector('#coach').textContent), null, { timeout: 120000 })
    assert.match(await page.textContent('#guide'), /momento 1 de/)
    // pular pro próximo momento direto
    await page.click('[data-act=reveal]')
    await page.click('#guide [data-act=gskip]')
    assert.match(await page.textContent('#guide'), /momento 2 de/)
    await page.click('[data-act=gstop]')
    assert.equal(await page.locator('[data-act=gstart]').count(), 1)
    assert.deepEqual(errors, [])
  })

  test('salvar desafios e treinar (local, sem login)', { timeout: 300000 }, async () => {
    const { page, errors } = await newPage()
    assert.equal(await page.locator('#acct button').count(), 0) // sem client id do Google: sem botão de login
    assert.equal(await page.isVisible('#loginModal'), false) // nem popup de login
    assert.equal(await page.title(), 'Chess Coach')
    const icon = await page.evaluate(async () => { const r = await fetch(document.querySelector('link[rel=icon]').href); return r.ok && r.headers.get('content-type') })
    assert.match(String(icon), /png/)
    assert.match(await page.textContent('#chal'), /Nenhum desafio ainda/)
    assert.equal(await page.isVisible('#trainBtn'), false) // na tela inicial o treino fica no card
    await page.fill('#pgn', read('game2.pgn'))
    await page.click('.chip[data-side=w]')
    await page.click('#go'); await waitDone(page)
    await page.click('[data-act=gsave]')
    assert.match(await page.textContent('#guide'), /salvo/)
    assert.match(await page.textContent('#trainBtn'), /\d/)
    await page.click('#trainBtn')
    await page.waitForSelector('text=Desafio 1 de')
    await page.click('[data-act=treveal]')
    assert.match(await page.textContent('#coach'), /O lance era/)
    assert.match(await page.textContent('#coach .src'), /Esse desafio veio da partida matheus_anzzulin x Ronkolan/)
    assert.equal(await page.locator('#coach [data-act=tgame]').count(), 1)
    await page.click('[data-act=tline]')
    await page.click('[data-act=lnext]')
    assert.match(await page.textContent('#coach .say.step'), /\w/)
    await page.click('[data-act=exit]') // volta pro desafio
    assert.match(await page.textContent('#coach'), /Desafio 1 de/)
    await page.click('[data-act=tnext]')
    assert.match(await page.textContent('#coach'), /Desafio 2 de/)
    // persistiu no navegador: aparece no card da tela inicial
    await page.reload()
    assert.match(await page.textContent('#chal'), /Últimos desafios/)
    assert.match(await page.textContent('#chal'), /Seu erro|Punir/)
    await page.click('#homeTrain')
    await page.waitForSelector('text=Desafio 1 de')
    await page.click('[data-act=texit]')
    assert.equal(await page.isVisible('#chal'), true) // sair do treino volta pra tela inicial
    // clicar num desafio da lista abre ele
    const first = await page.textContent('#chal .ch-list li:first-child b')
    await page.click('#chal .ch-list li:first-child')
    await page.waitForSelector('text=Desafio 1 de')
    assert.ok(first.length > 3)
    assert.doesNotMatch(await page.textContent('#coach'), /você jogou|seta vermelha/) // puzzle não entrega o lance da partida
    // depois de mostrar a resposta, abre a partida nesse momento
    await page.click('[data-act=treveal]')
    await page.click('[data-act=tgame]')
    await page.waitForFunction(() => !/^0\//.test(document.querySelector('#counter').textContent), null, { timeout: 30000 })
    assert.equal(await page.isVisible('#review'), true)
    await waitDone(page)
    await page.click('#newGame')
    assert.equal(await page.isVisible('#chal'), true)
    assert.deepEqual(errors, [])
  })

  test('minhas partidas: busca no chess.com, analisa em lote, cancela sem perder progresso', { timeout: 400000 }, async () => {
    const { page, errors } = await newPage()
    const g1 = read('game2.pgn'), g2 = read('game-clock.pgn')
    await page.route('https://api.chess.com/**', (r) => {
      const u = r.request().url()
      if (u.endsWith('/games/archives')) return r.fulfill({ json: { archives: ['https://api.chess.com/pub/player/matheus_anzzulin/games/2026/11'] } })
      if (u.endsWith('/2026/11')) return r.fulfill({ json: { games: [{ pgn: g1, end_time: 2, rules: 'chess' }, { pgn: g2, end_time: 1, rules: 'chess' }] } })
      r.fulfill({ status: 404 })
    })
    await page.click('#gear')
    assert.equal(await page.isVisible('#settings'), true)
    assert.equal(await page.isDisabled('#sGen'), true) // sem login do Google
    assert.match(await page.getAttribute('#settings .switch .hint', 'data-tip'), /entrar com o Google/i)
    assert.match(await page.getAttribute('#settings label.row .hint', 'data-tip'), /por partida/)
    await page.fill('#sUser', 'matheus_anzzulin')
    await page.click('#settings [data-site=chesscom]')
    await page.selectOption('#sDepth', 'fast')
    await page.click('#settings [data-lib=run]')
    // primeira partida (a mais recente) termina, aí cancela
    await page.waitForFunction(() => /1\/2 partidas analisadas/.test(document.querySelector('#settings').textContent), null, { timeout: 180000 })
    assert.equal(await page.isVisible('#batchBadge'), true)
    await page.click('#settings [data-lib=cancel]')
    assert.match(await page.textContent('#settings'), /já analisadas \(1 de 2\) ficaram salvas/)
    assert.match(await page.textContent('#stats'), /Na sua última partida analisada/)
    assert.match(await page.textContent('#stats .glist'), /vs Ronkolan/)
    // de novo: pula a que já foi e analisa só a que faltou
    await page.selectOption('#sDepth', 'fast')
    await page.click('#settings [data-lib=run]')
    await page.waitForFunction(() => /Pronto: 1 partida analisada \(1 já estava analisada\)/.test(document.querySelector('#settings').textContent), null, { timeout: 180000 })
    assert.match(await page.textContent('#stats'), /últimas 2 partidas/)
    assert.ok(await page.locator('#stats .cat').count() > 0)
    // fecha o menu clicando fora e abre uma partida pela lista
    await page.mouse.click(200, 600)
    assert.equal(await page.isVisible('#settings'), false)
    await page.click('#stats .glist li >> nth=0')
    await waitDone(page)
    assert.deepEqual(errors, [])
  })

  test('aba Minhas partidas: lista as recentes do usuário configurado e abre uma', { timeout: 300000 }, async () => {
    const { page, errors } = await newPage()
    const g1 = read('game2.pgn'), g2 = read('game-clock.pgn')
    await page.route('https://api.chess.com/**', (r) => {
      const u = r.request().url()
      if (u.endsWith('/games/archives')) return r.fulfill({ json: { archives: ['https://api.chess.com/pub/player/matheus_anzzulin/games/2026/11'] } })
      return r.fulfill({ json: { games: [{ pgn: g1, end_time: 2 }, { pgn: g2, end_time: 1 }] } })
    })
    assert.equal(await page.isVisible('#pgn'), true) // começa na aba de colar
    await page.click('.tab[data-tab=recent]')
    assert.equal(await page.isVisible('#pgn'), false)
    await page.click('#recentPane [data-rc=cfg]') // sem usuário: manda configurar
    assert.equal(await page.isVisible('#settings'), true)
    await page.fill('#sUser', 'matheus_anzzulin')
    await page.mouse.click(640, 30) // fecha o menu (clique no cabeçalho): busca as partidas
    await page.waitForSelector('#recentPane .rlist li')
    assert.equal(await page.locator('#recentPane .rlist li').count(), 2)
    assert.match(await page.textContent('#recentPane'), /vs Ronkolan/)
    assert.match(await page.textContent('#recentPane .rlist li >> nth=0'), /Brancas/)
    await page.click('#recentPane .rlist li >> nth=0')
    await waitDone(page)
    assert.match(await page.textContent('#players'), /Ronkolan/)
    // ao voltar, a aba continua e a partida aparece como analisada
    await page.click('#newGame')
    assert.match(await page.textContent('#recentPane .rlist li >> nth=0'), /✓/)
    await page.click('.tab[data-tab=paste]')
    assert.equal(await page.isVisible('#pgn'), true)
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
    await drag(page, 'f1', 'b5')
    await page.waitForFunction(() => /Variante/.test(document.querySelector('#coach').textContent), null, { timeout: 60000 })
    await page.click('#prev')
    assert.match(await page.textContent('#coach'), /Posição colada/)
    assert.equal(await page.locator('.varrow').count(), 1)
    assert.deepEqual(errors, [])
  })
})

describe('Google Drive (mock do Google)', () => {
  test('login, cria o arquivo no appDataFolder e sincroniza', { timeout: 300000 }, async () => {
    // build separado com client id de teste
    const { execSync } = await import('node:child_process')
    execSync('bash build.sh', { env: { ...process.env, GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com' }, stdio: 'ignore' })
    try {
      const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } })
      const errors = []; page.on('pageerror', (e) => errors.push(String(e)))
      const drive = { file: null, creates: 0, patches: 0 }
      await page.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ contentType: 'text/javascript', body: `window.google={accounts:{oauth2:{initTokenClient:(c)=>({requestAccessToken:()=>setTimeout(()=>c.callback({access_token:'tok',expires_in:3600}),10)}),revoke:(t,cb)=>cb&&cb()}}}` }))
      await page.route('https://www.googleapis.com/**', async (r) => {
        const req = r.request(), url = req.url()
        assert.equal(req.headers().authorization, 'Bearer tok')
        if (url.includes('/oauth2/v3/userinfo')) return r.fulfill({ json: { email: 'teste@exemplo.com', given_name: 'Teste' } })
        if (url.includes('/drive/v3/files?spaces=appDataFolder')) return r.fulfill({ json: { files: drive.file ? [{ id: 'f1' }] : [] } })
        if (url.includes('/drive/v3/files/f1?alt=media')) return r.fulfill({ json: drive.file })
        if (url.includes('/upload/drive/v3/files?uploadType=multipart')) {
          const body = req.postData()
          assert.match(body, /"parents":\["appDataFolder"\]/)
          drive.file = JSON.parse(body.split('\r\n\r\n')[2].split('\r\n--')[0]); drive.creates++
          return r.fulfill({ json: { id: 'f1' } })
        }
        if (url.includes('/upload/drive/v3/files/f1?uploadType=media')) { drive.file = JSON.parse(req.postData()); drive.patches++; return r.fulfill({ json: {} }) }
        r.fulfill({ status: 404 })
      })
      await page.goto(base)
      await page.evaluate(() => localStorage.clear()); await page.reload()
      // primeira visita: popup oferecendo login; "Agora não" fecha e não volta
      await page.waitForSelector('#loginModal:not([hidden])')
      assert.match(await page.textContent('#loginModal'), /Entrar com o Google\?/)
      await page.click('#loginModal [data-lm=no]')
      assert.equal(await page.isVisible('#loginModal'), false)
      await page.reload()
      assert.equal(await page.isVisible('#loginModal'), false)
      await page.uncheck('#useMaia'); await page.selectOption('#depth', 'fast')
      // tela inicial deslogada: desafios pedem login
      assert.equal(await page.locator('#acct [data-acct=in]').count(), 1)
      await page.click('#chal [data-home=warn]')
      assert.match(await page.textContent('#chal'), /Entre com o Google pra ver seus desafios/)
      // salva desafios ANTES do login (ficam locais)
      await page.fill('#pgn', read('game2.pgn')); await page.click('.chip[data-side=w]')
      await page.click('#go'); await waitDone(page)
      await page.click('[data-act=gsave]')
      // login: adota os desafios locais e sobe pro Drive
      await page.click('#acct [data-acct=in]')
      await page.waitForFunction(() => /salvo no Drive/.test(document.querySelector('#acct').textContent), null, { timeout: 30000 })
      assert.equal(drive.creates, 1)
      assert.ok(Object.keys(drive.file.puzzles).length > 0)
      // treinar e responder um desafio sincroniza de novo (PATCH)
      await page.click('#trainBtn'); await page.waitForSelector('text=Desafio 1 de')
      await page.click('[data-act=treveal]')
      await page.waitForFunction(() => /salvo no Drive/.test(document.querySelector('#acct').textContent), null, { timeout: 30000 })
      await page.waitForTimeout(1500)
      assert.ok(drive.patches >= 1)
      assert.ok(Object.values(drive.file.puzzles).some((p) => p.attempts === 1))
      // usuário do chess.com configurado vai pro Drive junto com os desafios
      await page.click('[data-act=texit]'); await page.click('#newGame')
      await page.click('#gear'); await page.fill('#sUser', 'fulano_123'); await page.mouse.click(200, 700)
      for (let i = 0; i < 50 && drive.file.profile?.user !== 'fulano_123'; i++) await page.waitForTimeout(200)
      assert.equal(drive.file.profile?.user, 'fulano_123')
      // logado: tela inicial mostra a conta e os desafios
      assert.match(await page.textContent('#acct'), /Teste/)
      assert.match(await page.textContent('#chal'), /pra revisar hoje/)
      // reload não derruba a sessão (token guardado enquanto vale)
      await page.reload()
      await page.waitForFunction(() => /salvo no Drive|Google Drive/.test(document.querySelector('#acct').textContent), null, { timeout: 30000 })
      assert.doesNotMatch(await page.textContent('#acct'), /pausada|Sincronizar/)
      // Sair esquece o token
      await page.click('#acct [data-acct=out]')
      await page.reload()
      assert.equal(await page.locator('#acct [data-acct=in]').count(), 1)
      assert.deepEqual(errors, [])
      await page.close()
    } finally {
      execSync('bash build.sh', { env: { ...process.env, GOOGLE_CLIENT_ID: '' }, stdio: 'ignore' })
    }
  })
})
