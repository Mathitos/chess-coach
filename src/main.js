import { Chess } from 'chess.js'
import { Uci } from './uci.js'
import * as R from './review.js'
import PIECES from './pieces.gen.js'
import * as P from './puzzles.js'
import * as G from './gdrive.js'
import * as L from './library.js'

const $ = (s) => document.querySelector(s)
const store = {
  get(k, d) { try { const v = localStorage.getItem('coach.' + k); return v === null ? d : JSON.parse(v) } catch { return d } },
  set(k, v) { try { localStorage.setItem('coach.' + k, JSON.stringify(v)) } catch {} },
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const SAMPLE = `[Event "Live Chess"]
[Site "Chess.com"]
[White "matheus_anzzulin"]
[Black "sativaleeindica"]
[Result "1-0"]
[WhiteElo "237"]
[BlackElo "113"]

1. e4 Nc6 2. d3 e5 3. g3 Nf6 4. f4 Bc5 5. c4 d5 6. Nf3 Nb4 7. Nxe5 Bg4 8. Nf3 O-O 9. a3 Nc6 10. h3 Bh5 11. Nc3 dxc4 12. dxc4 a5 13. Nd5 g6 14. Nxf6+ Qxf6 15. Qd5 Rad8 16. Qxh5 gxh5 17. e5 Qe7 18. g4 Rfe8 19. gxh5 f6 20. Bd3 fxe5 21. Ke2 Rd4 22. Nxd4 Bxd4 23. fxe5 Qxe5+ 24. Kd2 Qg5+ 25. Kc2 Qc5 26. Rg1+ Kh8 27. h4 b6 28. Rg5 Rg8 29. Rxc5 1-0`

const DEPTHS = { fast: { depth: 12, movetime: 800 }, normal: { depth: 16, movetime: 2000 }, deep: { depth: 20, movetime: 5000 } }
const MAIA_LEVELS = [600, 1200, 1800, 2400]

// ── State ───────────────────────────────────────────────────────────────────
const S = {
  game: null, sf: [], threats: [], infos: [], cls: [], maia: [], idx: 0,
  side: 'w', flip: false, running: false, mode: null, runId: 0, maiaRaw: {}, maiaElo: { w: 600, b: 600 },
}

// ── Engines ─────────────────────────────────────────────────────────────────
let sfPool = []
function makeEngine() {
  const w = new Worker('stockfish-19-lite-single.js')
  const u = new Uci((c) => w.postMessage(c))
  w.onmessage = (e) => u.feed(e.data)
  return { u, w, ready: u.init() }
}
function getPool(n) { while (sfPool.length < n) sfPool.push(makeEngine()); return sfPool.slice(0, n) }
function getStockfish() { return getPool(1)[0] }
function resetStockfish() { for (const e of sfPool) e.w.terminate(); sfPool = [] }
const POOL_SIZE = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1))

let maiaW = null, maiaReady = null, maiaReqId = 0
const maiaPending = new Map()
function getMaia(onProgress) {
  if (maiaReady) return maiaReady
  maiaW = new Worker('maia-worker.js')
  maiaReady = new Promise((resolve, reject) => {
    maiaW.onmessage = (e) => {
      const m = e.data
      if (m.type === 'progress') onProgress && onProgress(`baixando modelo (${m.progress}%)`)
      else if (m.type === 'status' && m.status === 'ready') resolve(true)
      else if (m.type === 'error' && m.id === undefined) reject(new Error(m.message))
      else if (m.type === 'progress-run') maiaPending.get(m.id)?.progress?.(m.done, m.total)
      else if (m.type === 'result') { maiaPending.get(m.id)?.resolve(m.out); maiaPending.delete(m.id) }
      else if (m.type === 'error') { maiaPending.get(m.id)?.reject(new Error(m.message)); maiaPending.delete(m.id) }
    }
    maiaW.onerror = (e) => reject(new Error(e.message || 'worker'))
  })
  maiaW.postMessage({ type: 'init', ortWasm: 'ort-wasm-simd-threaded.wasm', modelParts: ['maia3.part0.wasm', 'maia3.part1.wasm', 'maia3.part2.wasm'], modelBytes: 45683686 })
  maiaReady.catch(() => { maiaReady = null })
  return maiaReady
}
function maiaRun(items, progress) {
  const id = ++maiaReqId
  return new Promise((resolve, reject) => {
    maiaPending.set(id, { resolve, reject, progress })
    maiaW.postMessage({ type: 'run', id, items })
  })
}

// ── Setup screen ────────────────────────────────────────────────────────────
function initSetup() {
  $('#pgn').value = store.get('lastPgn', '')
  $('#user').value = store.get('user', '')
  $('#depth').value = 'deep' // padrão sempre a análise mais profunda
  $('#useMaia').checked = store.get('useMaia', true)
  $('#maiaLevel').value = String(store.get('maiaLevel', 'auto'))
  $('#sample').onclick = () => { $('#pgn').value = SAMPLE; $('#user').value ||= 'matheus_anzzulin'; updateDetect() }
  $('#go').onclick = start
  $('#pgn').addEventListener('input', () => { clearTimeout(S.detT); S.detT = setTimeout(updateDetect, 250) })
  $('#user').addEventListener('change', updateDetect)
  $('#detect').addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return
    S.pick = c.dataset.side
    const h = currentHeaders()
    const nm = S.pick === 'w' ? h.White : h.Black
    if (nm) { $('#user').value = nm; store.set('user', nm) }
    updateDetect()
  })
  $('#detect').addEventListener('change', (e) => { if (e.target.id === 'gamePick') { S.gameIdx = +e.target.value; S.pick = null; updateDetect() } })
  updateDetect()
  $('#newGame').onclick = goHome
  $('#home').onclick = goHome
  $('#chal').onclick = onHomeClick
}

// ── Input detection (PGN / multi-game PGN / link / FEN) ─────────────────────
function currentHeaders() {
  const d = S.det
  if (!d || d.kind !== 'pgn' || !d.games.length) return {}
  return R.gameSummary(d.games[Math.min(S.gameIdx || 0, d.games.length - 1)])
}
function autoSide(h) {
  const u = ($('#user').value || '').trim().toLowerCase()
  if (u && (h.Black || '').toLowerCase() === u) return 'b'
  if (u && (h.White || '').toLowerCase() === u) return 'w'
  return null
}
function updateDetect() {
  const d = R.detectInput($('#pgn').value)
  const prevCount = S.det?.kind === 'pgn' ? S.det.games.length : -1
  S.det = d
  const el = $('#detect')
  if (d.kind === 'empty') { el.innerHTML = ''; return }
  if (d.kind === 'error') { el.innerHTML = `<span class="kind">${esc(d.message)}</span>`; return }
  if (d.kind === 'fen') { el.innerHTML = `<span class="kind">♟ FEN: abre a posição no modo explorar (sem review de partida).</span>`; return }
  if (d.kind === 'link') {
    const site = d.site === 'lichess' ? 'Lichess' : 'chess.com'
    if (d.site === 'chesscom' && !$('#user').value.trim()) $('details.more').open = true
    el.innerHTML = `<span class="kind">🔗 Link do ${site}: vou buscar a partida${d.site === 'chesscom' ? ' no arquivo do usuário acima' : ''}. Só funciona na versão do GitHub Pages; no claude.ai cola o PGN.</span>`
    return
  }
  let html = ''
  if (d.games.length > 1) {
    if (prevCount !== d.games.length) S.gameIdx = d.games.length - 1
    html += `<select id="gamePick">${d.games.map((g, i) => { const h = R.gameSummary(g); return `<option value="${i}"${i === S.gameIdx ? ' selected' : ''}>${i + 1}. ${esc(h.White || '?')} x ${esc(h.Black || '?')} · ${esc(h.Date || '')} · ${esc(h.Result || '')}</option>` }).join('')}</select>`
  } else S.gameIdx = 0
  const h = currentHeaders()
  if (h.White || h.Black) {
    const auto = autoSide(h)
    if (!S.pick || (auto && auto !== S.pick)) S.pick = auto
    html += `<span class="kind">Eu joguei de:</span>`
    html += `<button class="chip${S.pick === 'w' ? ' on' : ''}" data-side="w">♔ ${esc(h.White || 'Brancas')}${h.WhiteElo ? ' (' + esc(h.WhiteElo) + ')' : ''}</button>`
    html += `<button class="chip${S.pick === 'b' ? ' on' : ''}" data-side="b">♚ ${esc(h.Black || 'Pretas')}${h.BlackElo ? ' (' + esc(h.BlackElo) + ')' : ''}</button>`
  } else html += `<span class="kind">PGN sem cabeçalho: revisando como Brancas (dá pra virar o tabuleiro depois).</span>`
  el.innerHTML = html
}

// ── Links: fetch the PGN from Lichess / chess.com public APIs ───────────────
async function fetchLinkPgn(d) {
  if (d.site === 'lichess') {
    const r = await fetch(`https://lichess.org/game/export/${d.id}?clocks=true&evals=false&literate=false`, { headers: { Accept: 'application/x-chess-pgn' }, signal: AbortSignal.timeout(15000) })
    if (!r.ok) throw new Error(`o Lichess respondeu ${r.status}`)
    return await r.text()
  }
  const user = ($('#user').value || '').trim()
  if (!user) throw new Error('preencha seu usuário do chess.com pra eu achar a partida no seu arquivo')
  const arch = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(user.toLowerCase())}/games/archives`, { signal: AbortSignal.timeout(15000) })
  if (!arch.ok) throw new Error(`o chess.com respondeu ${arch.status} pro usuário ${user}`)
  const months = ((await arch.json()).archives || []).slice(-3).reverse()
  for (const url of months) {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!r.ok) continue
    const g = ((await r.json()).games || []).find((x) => String(x.url || '').endsWith('/' + d.id))
    if (g && g.pgn) return g.pgn
  }
  throw new Error(`não achei a partida ${d.id} nos últimos 3 meses de ${user}. O link é de uma partida sua?`)
}

function show(which) {
  $('#setup').hidden = which !== 'setup'
  $('#review').hidden = which !== 'review'
  document.body.dataset.view = which
}

function status(key, text) {
  const el = $('#st-' + key)
  if (el) el.textContent = text
  if (key === 'maia') { const m = $('#an-maia'); if (m) m.textContent = text === 'desligado' ? '' : 'Maia: ' + text }
}

async function start() {
  const text = $('#pgn').value
  const d = R.detectInput(text)
  $('#err').textContent = ''
  const user = $('#user').value.trim()
  store.set('lastPgn', text); store.set('user', user);
  store.set('useMaia', $('#useMaia').checked); store.set('maiaLevel', $('#maiaLevel').value)
  if (d.kind === 'empty') { $('#err').textContent = 'Cola um PGN, link ou FEN.'; return }
  if (d.kind === 'error') { $('#err').textContent = d.message; return }
  if (d.kind === 'fen') return startPosition(d.fen)
  let pgn
  if (d.kind === 'link') {
    $('#go').disabled = true; $('#go').textContent = 'Buscando partida…'
    try { pgn = await fetchLinkPgn(d) } catch (e) {
      const blocked = e instanceof TypeError || e?.name === 'TimeoutError' || e?.name === 'AbortError'
      $('#err').textContent = blocked ? 'Não consegui buscar a partida pelo link (o navegador bloqueou a conexão; no claude.ai links não funcionam). Cola o PGN.' : 'Não consegui buscar a partida: ' + e.message
      return
    } finally { $('#go').disabled = false; $('#go').textContent = 'Revisar partida' }
  } else pgn = d.games[Math.min(S.gameIdx || 0, d.games.length - 1)]
  let game
  try { game = R.parseGame(pgn) } catch (e) { $('#err').textContent = 'Não consegui ler esse PGN: ' + e.message; return }
  if (S.batch?.running) cancelBatch('Pausei a análise em lote pra você revisar essa partida. Clica em Analisar pra continuar de onde parou.')
  S.pgn = pgn; S.pgnSite = d.kind === 'link' ? d.site : /lichess\.org/.test(pgn) ? 'lichess' : /chess\.com/i.test(pgn) ? 'chesscom' : ''
  if (!game.plies.length) { $('#err').textContent = 'O PGN não tem lances.'; return }
  const h = game.headers
  let side = (d.kind === 'pgn' && S.pick) || autoSide(h) || 'w'
  S.clock = R.clockData(game, pgn)
  const lvlSel = $('#maiaLevel').value
  const lvl = (elo) => (lvlSel === 'auto' ? Math.max(600, Math.min(2600, Math.round((+elo || 1000) / 100) * 100)) : +lvlSel)
  Object.assign(S, { game, sf: new Array(game.positions.length), threats: new Array(game.plies.length), infos: [], cls: [], maia: [], maiaRaw: {}, idx: 0, side, flip: side === 'b', maiaElo: { w: lvl(h.WhiteElo), b: lvl(h.BlackElo) } })
  const runId = ++S.runId
  S.vars = []; S.anCache = {}; S.sel = null; S.mode = null; S.guide = false; S.guideMsg = null; stopAuto()
  resetStockfish()
  $('#an-maia').textContent = ''
  show('review')
  $('#players').innerHTML = `<span class="pl w">♔ ${esc(h.White || 'Brancas')} ${h.WhiteElo ? '(' + esc(h.WhiteElo) + ')' : ''}</span> <span class="vs">vs</span> <span class="pl b">♚ ${esc(h.Black || 'Pretas')} ${h.BlackElo ? '(' + esc(h.BlackElo) + ')' : ''}</span> <span class="res">${esc(h.Result || '')}</span>${h.Termination ? `<div class="term">${esc(h.Termination)}</div>` : ''}`
  buildMoveList()
  go(0)
  runStockfish(runId)
  if ($('#useMaia').checked) runMaia(runId)
  else { status('maia', 'desligado'); $('#maiaBox').hidden = true }
}

function startPosition(fen) {
  S.vars = []; S.anCache = {}; S.sel = null; S.mode = null; S.guide = false; S.guideMsg = null; stopAuto()
  const game = { headers: {}, plies: [], positions: [fen] }
  Object.assign(S, { game, sf: [], threats: [], infos: [], cls: [], maia: [], maiaRaw: {}, idx: 0, side: fen.split(' ')[1], flip: fen.split(' ')[1] === 'b', clock: null })
  S.runId++
  resetStockfish()
  show('review')
  $('#analyzing').hidden = true
  $('#players').innerHTML = '<span class="pl">Posição colada (FEN)</span>'
  $('#summary').hidden = true
  status('sf', 'modo explorar'); status('maia', 'desligado')
  buildMoveList()
  render()
  getStockfish().u.analyse(fen, { depth: 16, movetime: 2000 }).then((an) => { S.sf[0] = an; S.infos[0] = R.evalInfo(fen, an); render() })
}

async function runStockfish(runId) {
  const g = S.game
  const opt = DEPTHS[$('#depth').value] || DEPTHS.normal
  const n = g.positions.length
  banner({ sf: 'iniciando o Stockfish…', pct: 0 })
  status('sf', 'iniciando…')
  const engines = getPool(POOL_SIZE)
  try { await Promise.all(engines.map((e) => e.ready)) } catch (e) { status('sf', 'falhou: ' + e.message); banner({ sf: 'o Stockfish não carregou: ' + e.message, error: true }); return }
  const t0 = performance.now()
  let next = 0, done = 0
  const loop = async (eng) => {
    for (;;) {
      if (runId !== S.runId) return
      const i = next++
      if (i >= n) return
      const fen = g.positions[i]
      const ch = new Chess(fen)
      const main = ch.isGameOver() ? { lines: [] } : await eng.u.analyse(fen, { ...opt, multipv: 2 })
      if (runId !== S.runId) return
      S.sf[i] = main
      S.infos[i] = R.evalInfo(fen, main)
      if (i < g.plies.length && !ch.isGameOver() && !ch.inCheck()) {
        try {
          const na = await eng.u.analyse(R.nullMoveFen(fen), { depth: 10, movetime: 300 })
          S.threats[i] = R.describeThreat(fen, na, S.infos[i], g.plies[i].color)
        } catch { S.threats[i] = null }
      }
      if (runId !== S.runId) return
      done++
      recompute()
      const el = (performance.now() - t0) / 1000
      const eta = done >= 6 ? Math.ceil((el / done) * (n - done)) : null
      status('sf', `${done}/${n} posições · ${engines.length} engine${engines.length > 1 ? 's' : ''} em paralelo · ${Math.round(el)}s`)
      $('#sfbar').style.width = `${(done / n) * 100}%`
      banner({ sf: `${done} de ${n} posições${eta !== null ? ` · faltam ~${eta}s` : ''}`, pct: (done / n) * 100 })
      if (i === S.idx || i === S.idx - 1 || done === n) render()
      else { renderMoveList(); renderGraph() }
    }
  }
  await Promise.all(engines.map(loop))
  if (runId !== S.runId) return
  const secs = Math.round((performance.now() - t0) / 1000)
  status('sf', `pronto · ${n} posições em ${secs}s`)
  banner({ done: true, sf: `Análise pronta em ${secs}s` })
  learnSpeed($('#depth').value, (performance.now() - t0) / 1000 / n)
  recordGame(S, S.pgn, S.pgnSite, $('#depth').value)
  renderSummary()
  render()
}

// Loading banner above the board
let bannerHide = null
function banner({ sf, pct, done, error }) {
  const el = $('#analyzing')
  clearTimeout(bannerHide)
  el.hidden = false
  el.classList.toggle('done', !!done)
  el.classList.toggle('error', !!error)
  $('#an-title').textContent = done ? '✓ ' + sf : error ? 'Deu ruim' : 'Analisando a partida…'
  $('#an-detail').textContent = done || error ? (done ? '' : sf) : sf
  if (pct !== undefined) $('#anbar').style.width = `${pct}%`
  if (done) { $('#anbar').style.width = '100%'; bannerHide = setTimeout(() => (el.hidden = true), 2500) }
}

function recompute() {
  const sf = S.sf.map((x) => x || { lines: [] })
  S.cls = R.classify(S.game, sf)
  S.infos = S.game.positions.map((f, i) => (S.sf[i] ? R.evalInfo(f, S.sf[i]) : null))
  buildMaiaView()
}

async function runMaia(runId) {
  status('maia', 'carregando (45 MB na primeira vez)…')
  $('#maiaBox').hidden = false
  try { await getMaia((t) => status('maia', t)) } catch (e) { status('maia', 'não carregou: ' + e.message); return }
  if (runId !== S.runId) return
  const g = S.game
  const items = []
  g.plies.forEach((p, k) => {
    const lv = new Set([S.maiaElo[p.color], ...MAIA_LEVELS])
    for (const elo of lv) items.push({ key: k + '@' + elo, fen: g.positions[k], elo, eloOppo: S.maiaElo[p.color === 'w' ? 'b' : 'w'], wantMove: p.uci })
  })
  status('maia', `analisando 0/${items.length}`)
  try {
    const out = await maiaRun(items, (d, t) => status('maia', `analisando ${d}/${t}`))
    if (runId !== S.runId) return
    for (const o of out) S.maiaRaw[o.key] = o
    status('maia', `pronto · nível ${S.maiaElo[S.side]} pra você`)
    buildMaiaView()
    render()
  } catch (e) { status('maia', 'erro: ' + e.message) }
}

function buildMaiaView() {
  const g = S.game
  if (!g || !Object.keys(S.maiaRaw).length) return
  S.maia = g.plies.map((p, k) => {
    const me = S.maiaRaw[k + '@' + S.maiaElo[p.color]]
    if (!me) return null
    const best = S.cls[k]?.bestUci
    return {
      elo: S.maiaElo[p.color], policy: me.policy, pPlayed: me.full ?? me.policy[p.uci] ?? 0,
      bestByLevel: best ? MAIA_LEVELS.map((L) => [L, S.maiaRaw[k + '@' + L]?.policy[best] ?? 0]) : null,
      playedByLevel: MAIA_LEVELS.map((L) => [L, S.maiaRaw[k + '@' + L]?.full ?? 0]),
    }
  })
}

// ── Board ───────────────────────────────────────────────────────────────────
const FILES = 'abcdefgh'
function sqXY(sq, flip) {
  const f = FILES.indexOf(sq[0]), r = +sq[1] - 1
  return flip ? [(7 - f) * 100, r * 100] : [f * 100, (7 - r) * 100]
}
function arrow(from, to, color, flip, w = 16) {
  const [x1, y1] = sqXY(from, flip), [x2, y2] = sqXY(to, flip)
  const ax = x1 + 50, ay = y1 + 50, bx = x2 + 50, by = y2 + 50
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy)
  const ux = dx / len, uy = dy / len
  const hx = bx - ux * 34, hy = by - uy * 34
  const px = -uy, py = ux
  return `<g opacity=".85"><line x1="${ax + ux * 18}" y1="${ay + uy * 18}" x2="${hx}" y2="${hy}" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>` +
    `<polygon points="${bx - ux * 8},${by - uy * 8} ${hx + px * 26},${hy + py * 26} ${hx - px * 26},${hy - py * 26}" fill="${color}"/></g>`
}
function hexA(c, a) { return c.startsWith('#') ? c + Math.round(a * 255).toString(16).padStart(2, '0') : c }
function addHover(v) {
  v.arrows = v.arrows || []; v.marks = v.marks || []
  const o = S.hover || S.overlay
  if (o) { v.arrows.push(...(o.arrows || []).map((a) => [a[0], a[1], a[2] || '#4a8fd6', a[3] || 13])); v.marks.push(...(o.marks || []).map(([q, c]) => [q, hexA(c || '#4a8fd6', 0.4)])) }
  return v
}
function boardView() {
  const v = boardViewBase()
  if (S.drag && S.drag.started) v.hide = S.drag.from
  return v
}
function boardViewBase() {
  const g = S.game, i = S.idx, M = S.mode
  if (M && M.type === 'explore') {
    const fen = M.fens[M.i]
    const v = { fen, arrows: [], sel: M.sel, dots: [], marks: [] }
    if (M.sel) v.dots = new Chess(fen).moves({ square: M.sel, verbose: true }).map((m) => m.to)
    const mv = M.i > 0 ? M.moves[M.i - 1] : null
    const c = M.i > 0 ? M.cls[M.i - 1] : null
    if (mv) v.last = { from: mv.from, to: mv.to, color: c ? R.CLASSES[c].color : '#f5f682', op: 0.5 }
    if (mv && c) v.badge = [mv.to, R.CLASSES[c]]
    const an = anFor(fen)
    if (an && an.lines?.[0]?.pv?.[0] && $('#showBest').checked) { const u = an.lines[0].pv[0]; v.arrows.push([u.slice(0, 2), u.slice(2, 4), '#81b64c', 14]) }
    v.info = an ? R.evalInfo(fen, an) : null
    return addHover(v)
  }
  if (M && M.type === 'line') {
    const st = M.i > 0 ? M.steps[M.i - 1] : null
    const nxt = M.steps[M.i]
    const v = { fen: M.fens[M.i], last: st && { from: st.from, to: st.to, color: '#74b0e0', op: 0.6 }, arrows: [], marks: [] }
    if (st) { v.arrows.push(...st.vis.arrows.filter((a) => !(a[0] === st.from && a[1] === st.to)).map((a) => [a[0], a[1], a[2], 11])); v.marks.push(...st.vis.marks.map(([q, c]) => [q, hexA(c, 0.35)])) }
    else if (nxt) v.arrows.push([nxt.from, nxt.to, 'rgba(116,176,224,.75)', 10])
    return addHover(v)
  }
  if (M && (M.type === 'retry' || M.type === 'puzzle')) {
    const v = { fen: M.fen, last: null, arrows: [], sel: M.sel, dots: [], marks: [] }
    if (M.sel) v.dots = new Chess(M.fen).moves({ square: M.sel, verbose: true }).map((m) => m.to)
    if (M.last) v.last = { from: M.last.from, to: M.last.to, color: '#f5f682', op: 0.45 }
    // lance certo fica no tabuleiro com um ✓; enquanto confere, a peça fica onde foi solta
    const shown = M.solved || (M.busy && M.pending)
    if (shown) {
      try { const ch = new Chess(M.fen); ch.move({ from: shown.slice(0, 2), to: shown.slice(2, 4), promotion: shown[4] || 'q' }); v.fen = ch.fen() } catch {}
      v.last = { from: shown.slice(0, 2), to: shown.slice(2, 4), color: M.solved ? '#81b64c' : '#f5f682', op: 0.55 }
      if (M.solved) v.badge = [shown.slice(2, 4), { color: '#81b64c', sym: '✓' }]
    } else if (M.wrong) v.badge = [M.wrong.slice(2, 4), { color: '#fa412d', sym: '✗' }]
    if (M.played && !M.wrong && !M.solved && !(M.busy && M.pending)) { v.arrows.push([M.played.slice(0, 2), M.played.slice(2, 4), 'rgba(250,65,45,.75)', 13]); v.marks.push([M.played.slice(0, 2), 'rgba(250,65,45,.28)']) }
    if (M.hint) v.marks.push([M.hint, 'rgba(129,182,76,.55)'])
    if (M.wrong && !shown) v.last = { from: M.wrong.slice(0, 2), to: M.wrong.slice(2, 4), color: '#fa412d', op: 0.45 }
    return addHover(v)
  }
  const last = i > 0 ? g.plies[i - 1] : null
  const r = i > 0 ? S.cls[i - 1] : null
  if (S.overlay?.fen) return addHover({ fen: S.overlay.fen, arrows: [], marks: [] }) // visual that belongs to the position before the move
  const v = { fen: g.positions[i], arrows: [], badge: null, sel: S.sel, dots: [] }
  if (S.sel) v.dots = new Chess(g.positions[i]).moves({ square: S.sel, verbose: true }).map((m) => m.to)
  if (last) v.last = { from: last.from, to: last.to, color: r ? R.CLASSES[r.cls].color : '#f5f682', op: r ? 0.45 : 0.5 }
  if (last && r && !['best', 'forced', 'brilliant', 'great'].includes(r.cls) && r.bestUci && $('#showBest').checked) v.arrows.push([r.bestUci.slice(0, 2), r.bestUci.slice(2, 4), '#81b64c', 16])
  if ($('#showNext').checked && S.sf[i]?.lines?.[0]?.pv?.[0]) { const u = S.sf[i].lines[0].pv[0]; v.arrows.push([u.slice(0, 2), u.slice(2, 4), '#4a8fd6', 12]) }
  if (last && r) v.badge = [last.to, R.CLASSES[r.cls]]
  return addHover(v)
}
function renderBoard() {
  const g = S.game, i = S.idx, flip = S.flip
  const V = boardView()
  const ch = new Chess(V.fen)
  let svg = ''
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const light = (r + f) % 2 === 0
    svg += `<rect x="${f * 100}" y="${r * 100}" width="100" height="100" fill="${light ? '#ebecd0' : '#739552'}"/>`
  }
  if (V.last) for (const sq of [V.last.from, V.last.to]) {
    const [x, y] = sqXY(sq, flip)
    svg += `<rect x="${x}" y="${y}" width="100" height="100" fill="${V.last.color}" opacity="${V.last.op}"/>`
  }
  for (const [sq, col] of V.marks || []) { const [x, y] = sqXY(sq, flip); svg += `<rect x="${x}" y="${y}" width="100" height="100" fill="${col}"/>` }
  if (V.sel) { const [x, y] = sqXY(V.sel, flip); svg += `<rect x="${x}" y="${y}" width="100" height="100" fill="#f5f682" opacity=".7"/>` }
  if (ch.inCheck()) {
    const ksq = ch.findPiece({ type: 'k', color: ch.turn() })[0]
    const [x, y] = sqXY(ksq, flip)
    svg += `<circle cx="${x + 50}" cy="${y + 50}" r="46" fill="url(#chk)"/>`
  }
  for (const row of ch.board()) for (const p of row) {
    if (!p || p.square === V.hide) continue
    const [x, y] = sqXY(p.square, flip)
    svg += `<image href="${PIECES[p.color + p.type.toUpperCase()]}" x="${x}" y="${y}" width="100" height="100"/>`
  }
  for (const sq of V.dots || []) {
    const [x, y] = sqXY(sq, flip)
    svg += ch.get(sq) ? `<circle cx="${x + 50}" cy="${y + 50}" r="44" fill="none" stroke="rgba(0,0,0,.25)" stroke-width="8"/>` : `<circle cx="${x + 50}" cy="${y + 50}" r="15" fill="rgba(0,0,0,.22)"/>`
  }
  // coords
  for (let k = 0; k < 8; k++) {
    const fileLbl = flip ? FILES[7 - k] : FILES[k], rankLbl = flip ? k + 1 : 8 - k
    svg += `<text x="${k * 100 + 92}" y="794" font-size="21" text-anchor="end" fill="${k % 2 ? '#739552' : '#ebecd0'}" font-weight="700">${fileLbl}</text>`
    svg += `<text x="5" y="${k * 100 + 20}" font-size="21" fill="${k % 2 ? '#ebecd0' : '#739552'}" font-weight="700">${rankLbl}</text>`
  }
  for (const [a, b, col, w] of V.arrows) svg += arrow(a, b, col, flip, w)
  if (V.badge) {
    const [sq, C] = V.badge
    const [x, y] = sqXY(sq, flip)
    svg += `<g transform="translate(${Math.min(x + 78, 772)},${Math.max(y + 2, 22)})"><circle r="22" fill="${C.color}" stroke="#fff" stroke-width="3"/><text y="8" text-anchor="middle" font-size="${C.sym.length > 1 ? 20 : 24}" font-weight="800" fill="#fff">${C.sym}</text></g>`
  }
  $('#board').classList.toggle('play', !(S.mode && (S.mode.type === 'retry' || S.mode.type === 'puzzle') && (S.mode.solved || S.mode.busy)))
  $('#board').innerHTML = `<svg viewBox="0 0 800 800"><defs><radialGradient id="chk"><stop offset="0" stop-color="#ff2b2b"/><stop offset="1" stop-color="#ff2b2b" stop-opacity="0"/></radialGradient></defs>${svg}</svg>`
  // eval bar
  const info = V.info !== undefined ? V.info : S.infos[i]
  const wp = info ? info.wpW : 50
  const pct = flip ? 100 - wp : wp
  $('#evalfill').style.height = `${pct}%`
  $('#evalfill').style.background = flip ? '#403d39' : '#fff'
  $('#evalbar').style.background = flip ? '#fff' : '#403d39'
  $('#evaltxt').textContent = info ? info.text.replace('+', '') : '…'
  $('#evaltxt').className = (wp >= 50) !== flip ? 'bottom' : 'top'
  renderPlayerBars(new Chess(V.fen))
}

function renderPlayerBars(ch) {
  const h = S.game.headers, i = S.idx
  const at = S.clock ? S.clock.at[Math.min(i, S.clock.at.length - 1)] : null
  const over = !S.mode && i === S.game.plies.length && S.game.plies.length > 0
  const bar = (c) => {
    const nm = c === 'w' ? h.White || 'Brancas' : h.Black || 'Pretas', elo = c === 'w' ? h.WhiteElo : h.BlackElo
    const active = !over && ch.turn() === c
    const t = at ? at[c] : null
    const low = t !== null && S.clock && t < Math.min(30, S.clock.base * 0.1)
    return `<span class="nm">${c === 'w' ? '♔' : '♚'} ${esc(nm)} ${elo ? `<span class="elo">(${esc(elo)})</span>` : ''}${c === S.side ? ' <span class="tag">você</span>' : ''}</span>` +
      (at ? `<span class="clock ${c === 'w' ? 'white' : 'black'}${active ? ' on' : ''}${low ? ' low' : ''}">${R.fmtClock(t)}</span>` : '')
  }
  const top = S.flip ? 'w' : 'b'
  $('#pTop').innerHTML = bar(top)
  $('#pBot').innerHTML = bar(top === 'w' ? 'b' : 'w')
}

// Interactive coach text: moves and squares light up on the board on hover/tap.
const TOKEN_RE = /(O-O-O|O-O|\b[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?)/g
function linkify(text, ctx) {
  const c = encodeURIComponent(JSON.stringify(ctx.filter(Boolean)))
  return esc(text).replace(TOKEN_RE, (t) => `<span class="ref" data-t="${t}" data-ctx="${c}">${t}</span>`)
}
function resolveRef(tok, ctx) {
  if (/^[a-h][1-8]$/.test(tok)) return { arrows: [], marks: [[tok, '#4a8fd6']] }
  for (const fen of ctx) {
    try { const m = new Chess(fen).move(tok.replace(/[+#]$/, '')); if (m) return { arrows: [[m.from, m.to, '#4a8fd6']], marks: [[m.to, '#4a8fd6']] } } catch {}
  }
  const sq = /([a-h][1-8])(?:=[QRBN])?[+#]?$/.exec(tok)
  return sq ? { arrows: [], marks: [[sq[1], '#4a8fd6']] } : null
}
function onRefOver(e) {
  const el = e.target.closest('.ref'); if (!el) return
  let ctx = []
  try { ctx = JSON.parse(decodeURIComponent(el.dataset.ctx)) } catch {}
  S.hover = resolveRef(el.dataset.t, ctx)
  renderBoard()
}
function onRefOut(e) { if (e.target.closest('.ref') && S.hover) { S.hover = null; renderBoard() } }

// ── Coach panel ─────────────────────────────────────────────────────────────
function renderCoach() {
  const g = S.game, i = S.idx
  const box = $('#coach')
  if (S.mode) return renderModePanel(box)
  if (i === 0 && !g.plies.length) {
    const an = S.sf[0], fen = g.positions[0]
    const best = an?.lines?.[0]?.pv?.length ? R.playLine(fen, an.lines[0].pv, 4).moves.map((x) => x.san) : []
    box.innerHTML = `<div class="coach-head"><div class="avatar">🔍</div><div><b>Posição colada</b><div class="sub">vez das ${new Chess(fen).turn() === 'w' ? 'Brancas' : 'Pretas'} · avaliação ${S.infos[0] ? esc(S.infos[0].text) : '…'}</div></div></div><p class="say">Arrasta uma peça pra testar lances. Cada variante fica salva no histórico.</p>${best.length ? `<p class="human">Melhor aqui: <b>${esc(best[0])}</b> <span class="muted">(${esc(best.join(' '))})</span></p>` : ''}`
    return
  }
  if (i === 0) {
    box.innerHTML = `<div class="coach-head"><div class="avatar">♞</div><div><b>Bora revisar!</b><div class="sub">Use ← → ou os botões. Revisando como ${S.side === 'w' ? 'Brancas' : 'Pretas'}.</div></div></div>${S.cls.length ? '' : '<p class="muted">Analisando com o Stockfish… dá pra ir navegando enquanto isso.</p>'}`
    return
  }
  const k = i - 1, p = g.plies[k], r = S.cls[k]
  const moveLbl = `${Math.floor(k / 2) + 1}${p.color === 'w' ? '.' : '...'} ${p.san}`
  const mine = p.color === S.side
  if (!r) { box.innerHTML = `<div class="coach-head"><div class="avatar">♞</div><div><b>${moveLbl}</b><div class="sub">analisando…</div></div></div>`; return }
  const C = R.CLASSES[r.cls]
  const t = R.coachText(g, S.sf.map((x) => x || { lines: [] }), S.threats, S.cls, k, S.maia.length ? S.maia : null, { third: !mine })
  const who = mine ? '' : `<span class="tag">adversário</span>`
  let html = `<div class="coach-head"><div class="badge" style="background:${C.color}">${C.sym}</div><div><b>${esc(moveLbl)}</b> é <b style="color:${C.color}">${C.label.toLowerCase()}</b> ${who}<div class="sub">avaliação ${esc(r.after.text)} · ${mine ? 'sua chance' : 'chance dele'} ${Math.round(r.wpBefore)}% → ${Math.round(r.wpAfter)}%${S.clock && S.clock.spent[k] != null ? ` · ⏱ ${R.fmtSpent(S.clock.spent[k])}` : ''}</div></div></div>`
  const ctx = [g.positions[k], g.positions[k + 1]]
  S.lastVisuals = t.visuals || []
  html += `<p class="say">${linkify(t.text, ctx)}</p>`
  const sp = S.clock ? S.clock.spent[k] : null
  if (mine && sp !== null && sp !== undefined && ['mistake', 'blunder', 'miss'].includes(r.cls) && sp <= 3) html += `<p class="tip">⏱ Você jogou esse lance em ${R.fmtSpent(sp)}. Num momento crítico assim, vale gastar uns segundos conferindo o que o adversário ameaça.</p>`
  if (t.tip) html += `<p class="tip">💡 ${linkify(t.tip, ctx)}</p>`
  if (S.lastVisuals.length) html += `<div class="acts vis">${S.lastVisuals.map((v, i) => `<button class="btn act ghost${S.overlayIdx === i ? ' on' : ''}" data-vis="${i}" title="${v.note ? esc(v.note) : ''}">👁 ${esc(v.label)}</button>`).join('')}</div>`
  const bad = ['inaccuracy', 'mistake', 'blunder', 'miss'].includes(r.cls)
  html += `<div class="acts">`
  if (mine && bad) html += `<button class="btn act retry" data-act="retry">↻ Tentar de novo</button>`
  if (!mine && bad && g.plies[k + 1] && S.cls[k + 1]) html += `<button class="btn act retry" data-act="punishTry">🎯 Achar a punição</button>`
  if (t.bestLine.length && r.cls !== 'forced') html += `<button class="btn act" data-act="best">▶ ${r.cls === 'best' || p.uci === r.bestUci ? 'Explicar a continuação' : 'Explicar ' + esc(t.bestSan)}</button>`
  if (t.replySan.length && bad) html += `<button class="btn act" data-act="punish">▶ ${r.cls === 'miss' ? 'Ver o que acontece depois' : mine ? 'Ver como o adversário pune' : 'Ver como punir'}</button>`
  html += `</div>`
  // Maia
  const m = S.maia[k]
  if (m) {
    const top = Object.entries(m.policy).sort((a, b) => b[1] - a[1]).slice(0, 4)
    const ch = new Chess(g.positions[k])
    const san = (u) => { try { return ch.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san } catch { return u } finally { ch.load(g.positions[k]) } }
    html += `<div class="maia"><div class="mh">🧠 Maia · o que humanos ~${m.elo} jogariam</div>`
    for (const [u, pr] of top) {
      const isPlayed = u === p.uci, isBest = u === r.bestUci
      html += `<div class="bar"><span class="mv">${esc(san(u))}${isPlayed ? ' <i>jogado</i>' : ''}${isBest ? ' <i class="b">melhor</i>' : ''}</span><span class="track"><span style="width:${Math.max(2, pr * 100)}%;background:${isBest ? '#81b64c' : isPlayed ? C.color : '#8a8784'}"></span></span><span class="pc">${Math.round(pr * 100)}%</span></div>`
    }
    if (!top.find(([u]) => u === p.uci)) html += `<div class="bar"><span class="mv">${esc(p.san)} <i>jogado</i></span><span class="track"><span style="width:${Math.max(2, m.pPlayed * 100)}%;background:${C.color}"></span></span><span class="pc">${Math.round(m.pPlayed * 100)}%</span></div>`
    if (m.bestByLevel && r.bestUci && r.bestUci !== p.uci) {
      html += `<div class="lv">Quem acha o melhor lance (${esc(san(r.bestUci))}) por nível: ${m.bestByLevel.map(([L, pr]) => `<span><b>${L}</b> ${Math.round(pr * 100)}%</span>`).join('')}</div>`
    }
    if (t.human) html += `<p class="human">${esc(t.human)}</p>`
    html += `</div>`
  }
  box.innerHTML = html
}


// ── Modes: line playback and retry ─────────────────────────────────────────
function startLine(k, kind) {
  const g = S.game
  const fen0 = g.positions[k]
  const reply = S.sf[k + 1]?.lines?.[0]?.pv || []
  const pv = kind === 'best' ? (S.sf[k]?.lines?.[0]?.pv || []).slice(0, 10) : [g.plies[k].uci, ...reply].slice(0, 9)
  const p = g.plies[k]
  const firstNote = kind === 'punish' ? `${p.san}: ${p.color === S.side ? 'o lance que você jogou' : 'o lance que o adversário jogou'} na partida.` : null
  const endIdx = kind === 'best' ? k : k + 1
  const steps = R.explainLine(fen0, pv, { side: S.side, firstNote, evalText: kind === 'best' ? S.infos[k]?.text : S.infos[k + 1]?.text })
  const fens = [fen0, ...steps.map((x) => x.fen)]
  const label = kind === 'best' ? `Explicando ${steps[0]?.san || ''}` : S.cls[k]?.cls === 'miss' ? 'O que acontece depois do lance jogado' : (p.color === S.side ? 'Como o adversário pune' : 'Como punir')
  stopTimer()
  S.overlay = null; S.overlayIdx = null
  S.mode = { type: 'line', k, kind, fens, moves: steps, steps, i: 0, label, playing: false, endIdx }
  render()
}
function lineAutoplay() {
  const M = S.mode
  if (M.playing) { stopTimer(); M.playing = false; return render() }
  if (M.i >= M.moves.length) M.i = 0
  M.playing = true
  M.i++; render()
  M.timer = setInterval(() => {
    if (S.mode !== M) return clearInterval(M.timer)
    if (M.i >= M.moves.length) { clearInterval(M.timer); M.timer = null; M.playing = false; return render() }
    M.i++; render()
  }, 1500)
}
function stopTimer() { if (S.mode?.timer) { clearInterval(S.mode.timer); S.mode.timer = null } }
function exitMode() { stopTimer(); S.mode = S.training && S.trainMode ? S.trainMode : null; render() }
function lineStep(d) { const M = S.mode; stopTimer(); M.playing = false; M.i = Math.max(0, Math.min(M.moves.length, M.i + d)); render() }

function startRetry(k, prompt) {
  stopTimer()
  S.overlay = null; S.overlayIdx = null
  const g = S.game, pl = g.plies[k], prev = k > 0 ? g.plies[k - 1] : null
  S.mode = { type: 'retry', k, fen: g.positions[k], sel: null, tries: 0, msg: null, ok: null, hint: null, wrong: null, solved: null, busy: false, prompt,
    played: pl ? pl.from + pl.to : null, last: prev ? { from: prev.from, to: prev.to } : null, prevFen: k > 0 ? g.positions[k - 1] : null }
  render()
}
async function tryMove(uci) {
  const M = S.mode, g = S.game, k = M.k, r = S.cls[k]
  const c = g.plies[k].color
  M.busy = true; M.tries++; M.sel = null; M.wrong = null
  const bestUci = r.bestUci, second = S.sf[k]?.lines?.[1]?.pv?.[0]
  const san = (() => { const ch = new Chess(M.fen); try { return ch.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' }).san } catch { return uci } })()
  if (uci.slice(0, 4) === bestUci?.slice(0, 4)) {
    const best = R.lineMotif(M.fen, S.sf[k].lines[0], c)
    const ex = R.explainBestMove(M.fen, S.sf[k].lines[0], c, best, S.threats[k])
    Object.assign(M, { busy: false, ok: true, solved: uci, msg: `Isso! ${san} era o melhor lance${ex ? ': ' + ex : ''}.` })
    return render()
  }
  M.msg = `Conferindo ${san}…`; M.pending = uci; render()
  try {
    const ch = new Chess(M.fen); ch.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' })
    const an = ch.isGameOver() ? { lines: [] } : await getStockfish().u.analyse(ch.fen(), { depth: 14, movetime: 1200 })
    if (S.mode !== M) return
    const fb = R.attemptFeedback(M.fen, uci, an, c, r.wpBefore, S.sf[k]?.lines?.[0])
    if (fb.ok) Object.assign(M, { ok: true, solved: uci, msg: `Boa! ${fb.text} O engine preferia ${R.playLine(M.fen, [bestUci]).moves[0]?.san}.` })
    else Object.assign(M, { ok: false, wrong: uci, msg: fb.text + (M.tries >= 2 && !M.hint ? ' Quer uma dica?' : '') })
  } catch (e) { M.msg = 'Não consegui conferir: ' + e.message }
  M.busy = false
  render()
}
// ── Board interaction: drag & drop or click-click ─────────────────────────
function squareAt(e) {
  const svg = $('#board svg'); if (!svg) return null
  const rect = svg.getBoundingClientRect()
  const fx = Math.floor(((e.clientX - rect.left) / rect.width) * 8), fy = Math.floor(((e.clientY - rect.top) / rect.height) * 8)
  if (fx < 0 || fx > 7 || fy < 0 || fy > 7) return null
  return S.flip ? FILES[7 - fx] + (fy + 1) : FILES[fx] + (8 - fy)
}
// Position the board is showing right now (any mode).
function shownFen() {
  const M = S.mode
  if (M && (M.type === 'retry' || M.type === 'puzzle')) return M.fen
  if (M && (M.type === 'explore' || M.type === 'line')) return M.fens[M.i]
  return S.game.positions[S.idx]
}
// Position the user can move in (null = not interactive right now).
function interactiveFen() {
  const M = S.mode
  if (M && (M.type === 'retry' || M.type === 'puzzle')) return M.solved || M.busy ? null : M.fen
  return shownFen()
}
function selOwner() { return S.mode && S.mode.type !== 'line' ? S.mode : S }
function legalMove(fen, from, to) {
  const mv = new Chess(fen).moves({ square: from, verbose: true }).find((m) => m.to === to)
  return mv ? mv.from + mv.to + (mv.promotion ? 'q' : '') : null
}
function userMove(uci) {
  const M = S.mode
  S.sel = null
  if (M && M.type === 'retry') return tryMove(uci)
  if (M && M.type === 'puzzle') return tryPuzzle(uci)
  if (M && M.type === 'explore') return exploreMove(uci)
  if (M && M.type === 'line') { stopTimer(); return branchFrom(M.k, M.moves.slice(0, M.i), uci) }
  // main line: same move as the game just advances; otherwise branch
  const p = S.game.plies[S.idx]
  if (p && p.uci.slice(0, 4) === uci.slice(0, 4)) return go(S.idx + 1)
  return branchFrom(S.idx, [], uci)
}
function onPointerDown(e) {
  if (!S.game || e.button > 0) return
  if (S.overlay?.fen) { S.overlay = null; S.overlayIdx = null; render() }
  const sq = squareAt(e); if (!sq) return
  const fen = interactiveFen(); if (!fen) return
  const ch = new Chess(fen)
  const p = ch.get(sq)
  const own = p && p.color === ch.turn()
  const owner = selOwner()
  // click-click: second click on a target square
  if (owner.sel && !own) {
    const uci = legalMove(fen, owner.sel, sq)
    owner.sel = null
    if (uci) return userMove(uci)
    return render()
  }
  if (!own) return
  const rect = $('#board').getBoundingClientRect()
  S.drag = { from: sq, x0: e.clientX, y0: e.clientY, started: false, size: rect.width / 8, piece: p.color + p.type.toUpperCase() }
  try { $('#board').setPointerCapture(e.pointerId) } catch {}
  e.preventDefault()
}
function onPointerMove(e) {
  const d = S.drag; if (!d) return
  if (!d.started && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 6) return
  if (!d.started) {
    d.started = true
    const ghost = document.createElement('img')
    ghost.id = 'ghost'; ghost.src = PIECES[d.piece]
    ghost.style.width = ghost.style.height = d.size + 'px'
    document.body.appendChild(ghost)
    selOwner().sel = d.from
    render()
  }
  const g = $('#ghost'); if (g) { g.style.left = e.clientX - d.size / 2 + 'px'; g.style.top = e.clientY - d.size / 2 + 'px' }
}
function onPointerUp(e) {
  const d = S.drag; if (!d) return
  S.drag = null
  $('#ghost')?.remove()
  const owner = selOwner()
  const sq = squareAt(e)
  const fen = interactiveFen()
  if (d.started) {
    owner.sel = null
    const uci = sq && sq !== d.from && fen ? legalMove(fen, d.from, sq) : null
    if (uci) return userMove(uci)
    return render()
  }
  owner.sel = owner.sel === d.from ? null : d.from
  render()
}

// ── Variations: forks of the game kept as a tree hanging off the main line ──
// Each variation starts at main-line position `fromIdx` and holds its own moves.
// Variation cursor i: 1..moves.length (i = 0 would be the main-line position itself).
let varSeq = 0
function anFor(fen) {
  if (S.anCache[fen]) return S.anCache[fen]
  const j = S.game.positions.indexOf(fen)
  return j >= 0 && S.sf[j] ? S.sf[j] : null
}
function makeVar(fromIdx, moveList) {
  const base = S.game.positions[fromIdx]
  const fens = [base]
  const c = new Chess(base)
  const moves = []
  for (const m of moveList) {
    const mv = c.move({ from: m.from, to: m.to, promotion: m.promotion || undefined })
    moves.push(mv); fens.push(c.fen())
  }
  return { type: 'explore', id: ++varSeq, fromIdx, fens, moves, cls: [], fb: [], i: moves.length, sel: null }
}
function sameUci(m, uci) { return (m.from + m.to) === uci.slice(0, 4) }
function branchFrom(fromIdx, prefix, uci) {
  const c = new Chess(S.game.positions[fromIdx])
  for (const m of prefix) c.move({ from: m.from, to: m.to, promotion: m.promotion || undefined })
  let mv
  try { mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' }) } catch { return render() }
  const all = [...prefix, mv]
  // reuse an existing variation that already contains this exact line
  const hit = S.vars.find((v) => v.fromIdx === fromIdx && v.moves.length >= all.length && all.every((m, j) => sameUci(v.moves[j], m.from + m.to)))
  if (hit) return enterVar(hit, all.length)
  const v = makeVar(fromIdx, all)
  S.vars.push(v)
  enterVar(v, v.moves.length)
}
function enterVar(v, i) {
  stopTimer()
  S.mode = v
  v.i = Math.max(1, Math.min(v.moves.length, i))
  v.sel = null
  render()
  analyseVar(v)
}
async function analyseVar(v) {
  // analyse the positions around the cursor (before and after the current move)
  for (const j of [v.i - 1, v.i]) {
    const fen = v.fens[j]
    if (!fen || anFor(fen)) continue
    const ch = new Chess(fen)
    S.anCache[fen] = ch.isGameOver() ? { lines: [] } : await getStockfish().u.analyse(fen, { depth: 14, movetime: 1000 })
  }
  classifyVar(v)
  render()
}
function classifyVar(v) {
  for (let j = 0; j < v.moves.length; j++) {
    if (v.cls[j]) continue
    const before = anFor(v.fens[j]), after = anFor(v.fens[j + 1])
    if (!before || !after) continue
    const m = v.moves[j], c = m.color
    const ib = R.evalInfo(v.fens[j], before), ia = R.evalInfo(v.fens[j + 1], after)
    if (!ib || !ia) continue
    const wb = c === 'w' ? ib.wpW : 100 - ib.wpW, wa = c === 'w' ? ia.wpW : 100 - ia.wpW
    const uci = m.from + m.to + (m.promotion || '')
    const best = before.lines?.[0]?.pv?.[0]
    const loss = uci === best ? 0 : Math.max(0, wb - wa) / 100
    v.cls[j] = uci === best || loss < 0.001 ? 'best' : loss < 0.02 ? 'excellent' : loss < 0.05 ? 'good' : loss < 0.10 ? 'inaccuracy' : loss < 0.20 ? 'mistake' : 'blunder'
    if (['inaccuracy', 'mistake', 'blunder'].includes(v.cls[j])) {
      const fb = R.attemptFeedback(v.fens[j], uci, after, c, wb)
      const bm = best ? R.playLine(v.fens[j], [best]).moves[0]?.san : null
      v.fb[j] = (fb ? fb.text.replace(/ não é o melhor/, ' não é o melhor lance') : '') + (bm ? ` Melhor era ${bm}.` : '')
    }
  }
}
function exploreMove(uci) {
  const v = S.mode
  // same as the next move already in this variation: just step forward
  if (v.i < v.moves.length && sameUci(v.moves[v.i], uci)) return enterVar(v, v.i + 1)
  if (v.i === v.moves.length) {
    const c = new Chess(v.fens[v.i])
    let mv
    try { mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' }) } catch { return render() }
    v.moves.push(mv); v.fens.push(c.fen())
    return enterVar(v, v.moves.length)
  }
  // a different move in the middle of the variation: new sub-variation, the old one is kept
  return branchFrom(v.fromIdx, v.moves.slice(0, v.i), uci)
}
function varLabel(v) {
  if (v.fromIdx === 0) return 'a posição inicial'
  const p = S.game.plies[v.fromIdx - 1]
  return `depois de ${Math.floor((v.fromIdx - 1) / 2) + 1}${p.color === 'w' ? '.' : '...'} ${p.san}`
}
function deleteVar(id) {
  const v = S.vars.find((x) => x.id === id); if (!v) return
  S.vars = S.vars.filter((x) => x !== v)
  if (S.mode === v) go(v.fromIdx)
  else render()
}

// ── Navigation (navbar + keyboard) works the same in any mode ───────────────
function navStep(d) {
  const M = S.mode
  if (M && M.type === 'line') return lineStep(d)
  if (M && M.type === 'explore') {
    const i = M.i + d
    if (i <= 0) return go(M.fromIdx) // back past the fork point: main line (variation stays saved)
    return enterVar(M, i)
  }
  if (M && M.type === 'retry') return go(S.idx + d)
  go(S.idx + d)
}
function navEnd() {
  const M = S.mode
  if (M && M.type === 'explore') return enterVar(M, M.moves.length)
  if (M && M.type === 'line') { stopTimer(); M.playing = false; M.i = M.moves.length; return render() }
  go(S.game.plies.length)
}

function renderExplorePanel(box) {
  const v = S.mode, fen = v.fens[v.i]
  const an = anFor(fen), info = an ? R.evalInfo(fen, an) : null
  const turn = new Chess(fen).turn() === 'w' ? 'Brancas' : 'Pretas'
  let html = `<div class="coach-head"><div class="avatar">🔍</div><div><b>Variante</b> <span class="tag">${esc(varLabel(v))}</span><div class="sub">vez das ${turn} · avaliação ${info ? esc(info.text) : '…'} · ◀ no começo volta pra partida, a variante fica salva no histórico</div></div></div>`
  const j = v.i - 1
  const m = v.moves[j]
  if (m) {
    const c = v.cls[j]
    if (!c) html += `<p class="say muted">Avaliando ${esc(m.san)}…</p>`
    else if (v.fb[j]) html += `<p class="say badmsg">${linkify(v.fb[j], [v.fens[j], v.fens[j + 1]])}</p>`
    else html += `<p class="say good">${esc(m.san)}: ${R.CLASSES[c].label.toLowerCase()}.</p>`
  }
  const best = an?.lines?.[0]?.pv?.length ? R.playLine(fen, an.lines[0].pv, 4).moves.map((x) => x.san) : []
  if (best.length) html += `<p class="human">Melhor aqui: <b>${esc(best[0])}</b> <span class="muted">(${esc(best.join(' '))})</span></p>`
  html += `<div class="acts">`
  if (best.length) html += `<button class="btn act" data-act="xbest">Jogar o melhor</button>`
  html += `<button class="btn act" data-act="exit">↩ Voltar pra partida</button><button class="btn act" data-act="xdel">🗑 Apagar variante</button></div>`
  box.innerHTML = html
}

function renderModePanel(box) {
  if (S.mode.type === 'explore') return renderExplorePanel(box)
  if (S.mode.type === 'puzzle') return renderPuzzlePanel(box)
  const M = S.mode, g = S.game
  const p = M.k != null ? g.plies[M.k] : null
  const moveLbl = p ? `${Math.floor(M.k / 2) + 1}${p.color === 'w' ? '.' : '...'} ${p.san}` : (M.fromLabel || 'a posição do desafio')
  if (M.type === 'line') {
    let seq = ''
    M.moves.forEach((m, j) => {
      const ply = (M.plyBase ?? M.k) + j
      const num = ply % 2 === 0 ? `${Math.floor(ply / 2) + 1}. ` : j === 0 ? `${Math.floor(ply / 2) + 1}... ` : ''
      seq += `${num}<span class="lm${j + 1 === M.i ? ' cur' : ''}${M.kind === 'punish' && j === 0 ? ' played' : ''}" data-j="${j + 1}">${esc(m.san)}</span> `
    })
    const st = M.i > 0 ? M.steps[M.i - 1] : null
    const ctx = [M.fens[Math.max(0, M.i - 1)], M.fens[M.i]]
    const say = st ? linkify(st.text, ctx) : `Vou explicar a linha lance por lance. Clica em <b>Próximo</b> (ou →) quando quiser avançar.`
    const end = M.i >= M.moves.length
    box.innerHTML = `<div class="coach-head"><div class="avatar">▶</div><div><b>${esc(M.label)}</b><div class="sub">a partir de ${esc(moveLbl)} · lance ${M.i}/${M.moves.length}</div></div></div>
      <p class="seq">${seq}</p>
      <p class="say step">${say}</p>
      <div class="acts"><button class="btn act" data-act="lprev">◀</button>${end ? '' : `<button class="btn act retry" data-act="lnext">Próximo ▶</button>`}<button class="btn act" data-act="lplay" title="Autoplay (1,5s por lance)">${M.playing ? '⏸ Pausar' : '⏵ Autoplay'}</button><button class="btn act" data-act="exit">✕ Voltar pra partida</button>${end && S.guide ? '<button class="btn act retry" data-act="gnext">⏩ Próximo momento</button>' : ''}</div>`
    return
  }
  const side = p.color === 'w' ? 'Brancas' : 'Pretas'
  let html = `<div class="coach-head"><div class="avatar">↻</div><div><b>Tentar de novo: ${esc(moveLbl)}</b><div class="sub">Você joga de ${side}. Arrasta a peça (ou clica nela e depois na casa).${M.played && !M.wrong && !M.solved ? ' <span style="color:#ff8a7a">Seta vermelha: o lance da partida.</span>' : ''}</div></div></div>`
  if (M.msg) html += `<p class="say ${M.ok ? 'good' : M.ok === false ? 'badmsg' : ''}">${linkify(M.msg, [M.fen])}</p>`
  else html += `<p class="say">${linkify(M.prompt || `Na partida você jogou ${p.san}. Acha um lance melhor?`, [M.fen, M.prevFen])}</p>`
  html += `<div class="acts">`
  if (!M.solved) {
    if (!M.hint) html += `<button class="btn act" data-act="hint">💡 Dica</button>`
    html += `<button class="btn act" data-act="reveal">Mostrar resposta</button>`
  } else html += `<button class="btn act" data-act="best">▶ Explicar a linha</button>${S.guide ? '<button class="btn act retry" data-act="gnext">⏩ Próximo momento</button>' : ''}`
  html += `<button class="btn act" data-act="exit">✕ Voltar pra partida</button></div>`
  box.innerHTML = html
}
function onCoachAction(e) {
  const vb = e.target.closest('[data-vis]')
  if (vb) {
    const i = +vb.dataset.vis
    if (S.overlayIdx === i) { S.overlay = null; S.overlayIdx = null } else { S.overlay = S.lastVisuals[i]; S.overlayIdx = i }
    return render()
  }
  const b = e.target.closest('[data-act]')
  const lm = e.target.closest('.lm')
  if (b && ['gstart', 'gauto', 'gskip', 'gnext', 'gprev', 'gstop'].includes(b.dataset.act)) return guideAction(b.dataset.act)
  if (b && b.dataset.act === 'gsave') return savePuzzles()
  if (b && b.dataset.act?.startsWith('t') && S.training && ['texit', 'tagain', 'tnext', 'thint', 'treveal', 'tdel', 'tline', 'tgame'].includes(b.dataset.act)) return trainAction(b.dataset.act)
  if (b && S.mode?.type === 'explore') {
    const act = b.dataset.act, v = S.mode
    if (act === 'xbest') { const u = anFor(v.fens[v.i])?.lines?.[0]?.pv?.[0]; if (u) exploreMove(u); return }
    if (act === 'exit') return go(v.fromIdx)
    if (act === 'xdel') return deleteVar(v.id)
  }
  if (lm && S.mode?.type === 'line') { stopTimer(); S.mode.playing = false; S.mode.i = +lm.dataset.j; return render() }
  if (!b) return
  const k = S.mode ? S.mode.k : S.idx - 1
  const act = b.dataset.act
  if (act === 'retry') startRetry(k)
  else if (act === 'punishTry') { go(k + 1); startRetry(k + 1) }
  else if (act === 'best') startLine(k, 'best')
  else if (act === 'punish') startLine(k, 'punish')
  else if (act === 'exit') exitMode()
  else if (act === 'lprev') lineStep(-1)
  else if (act === 'lnext') lineStep(1)
  else if (act === 'lplay') lineAutoplay()
  else if (act === 'hint') { S.mode.hint = S.cls[k].bestUci.slice(0, 2); S.mode.msg = `Dica: a peça certa está em ${S.mode.hint}.`; S.mode.ok = null; render() }
  else if (act === 'reveal') {
    const M = S.mode, best = S.cls[k].bestUci, c = S.game.plies[k].color
    const bm = R.lineMotif(M.fen, S.sf[k].lines[0], c)
    const ex = R.explainBestMove(M.fen, S.sf[k].lines[0], c, bm, S.threats[k])
    Object.assign(M, { solved: best, ok: null, wrong: null, sel: null, msg: `O lance era ${bm.san}${ex ? ': ' + ex : ''}.` })
    render()
  }
}

// ── Key moments, guided review and autoplay to the next moment ──────────────
function keyMoments(A = S) {
  const g = A.game, out = []
  A.cls.forEach((r, k) => {
    if (!r) return
    const p = g.plies[k], mine = p.color === A.side
    if (mine && ['mistake', 'blunder', 'miss'].includes(r.cls)) out.push({ k, at: k, type: 'erro', label: `${R.CLASSES[r.cls].label}: ${moveName(k, g)}` })
    else if (mine && ['brilliant', 'great'].includes(r.cls)) out.push({ k, at: k + 1, type: 'bom', label: `${R.CLASSES[r.cls].label}: ${moveName(k, g)}` })
    else if (!mine && ['mistake', 'blunder'].includes(r.cls) && g.plies[k + 1] && A.cls[k + 1]) out.push({ k, at: k + 1, type: 'chance', label: `Erro do adversário: ${moveName(k, g)}` })
  })
  const seen = new Set()
  return out.sort((a, b) => a.at - b.at).filter((m) => (seen.has(m.at) ? false : seen.add(m.at)))
}
function moveName(k, g = S.game) { const p = g.plies[k]; return `${Math.floor(k / 2) + 1}${p.color === 'w' ? '.' : '...'} ${p.san}` }
function stopAuto() { if (S.auto) { clearInterval(S.auto.timer); S.auto = null; renderGuide() } }
function baseIdx() { const M = S.mode; return M?.type === 'explore' ? M.fromIdx : M?.type === 'line' ? (M.endIdx ?? M.k) : M?.type === 'retry' ? M.k : S.idx }
// Autoplay the game (1.5s per move) up to the next key moment, then open it.
function autoToNextMoment() {
  if (S.auto) return stopAuto()
  const base = baseIdx()
  if (S.mode) { stopTimer(); S.mode = null; go(base, true) }
  const target = keyMoments().find((m) => m.at > base)
  if (!target) { S.guideMsg = 'Não tem mais momentos-chave daqui pra frente.'; renderGuide(); return }
  S.guideMsg = null
  S.auto = { target, timer: setInterval(() => {
    if (!S.auto) return
    if (S.idx < S.auto.target.at) go(S.idx + 1, true)
    if (S.idx >= S.auto.target.at) { const t = S.auto.target; clearInterval(S.auto.timer); S.auto = null; openMoment(t) }
    renderGuide()
  }, 1500) }
  renderGuide()
}
function openMoment(m) {
  if (S.guide && m.type === 'erro') { go(m.k, true); startRetry(m.k, `Momento-chave: na partida você jogou ${S.game.plies[m.k].san} aqui (${R.CLASSES[S.cls[m.k].cls].label.toLowerCase()}). Acha um lance melhor?`) }
  else if (S.guide && m.type === 'chance') { go(m.k + 1, true); startRetry(m.k + 1, `O adversário errou com ${S.game.plies[m.k].san}. Acha a punição!`) }
  else go(m.at, true)
  renderGuide()
}
function guideAction(act) {
  const ms = keyMoments()
  if (act === 'gstart') { S.guide = true; S.guideMsg = null; if (S.mode) { stopTimer(); S.mode = null } go(0, true); autoToNextMoment() }
  else if (act === 'gstop') { S.guide = false; stopAuto(); S.guideMsg = null; render() }
  else if (act === 'gauto' || act === 'gnext') autoToNextMoment()
  else if (act === 'gskip' || act === 'gprev') {
    stopAuto()
    const base = baseIdx()
    const t = act === 'gskip' ? ms.find((m) => m.at > base) : [...ms].reverse().find((m) => m.at < base)
    if (!t) { S.guideMsg = act === 'gskip' ? 'Não tem mais momentos-chave daqui pra frente.' : 'Esse é o primeiro momento-chave.'; return renderGuide() }
    if (S.mode) { stopTimer(); S.mode = null }
    openMoment(t)
  }
}
function renderGuide() {
  const el = $('#guide'); if (!el || !S.game) return
  const ms = S.cls.length && !S.cls.some((x) => !x) ? keyMoments() : []
  const ready = ms.length > 0
  const base = baseIdx()
  const cur = ms.findIndex((m) => m.at === base)
  const nextM = ms.find((m) => m.at > base)
  let html = ''
  if (S.guide) html += `<div class="g-top"><b>🎓 Revisão guiada</b><span class="muted">${cur >= 0 ? `momento ${cur + 1} de ${ms.length}: ${esc(ms[cur].label)}` : nextM ? `próximo: ${esc(nextM.label)}` : 'fim dos momentos-chave'}</span></div>`
  else if (ready) html += `<div class="g-top"><span class="muted">${ms.length} momentos-chave nesta partida${nextM ? ` · próximo: ${esc(nextM.label)}` : ''}</span></div>`
  if (S.guideMsg) html += `<div class="muted">${esc(S.guideMsg)}</div>`
  html += `<div class="acts">`
  if (!S.guide && ready) html += `<button class="btn act retry" data-act="gstart">🎓 Revisão guiada</button>`
  if (ready) {
    html += `<button class="btn act" data-act="gprev" title="Momento anterior">⏮ momento</button>`
    html += `<button class="btn act${S.auto ? ' on' : ''}" data-act="gauto" title="Autoplay da partida até o próximo momento-chave (1,5s por lance)">${S.auto ? '⏸ Pausar autoplay' : '⏩ Autoplay até o próximo momento'}</button>`
    html += `<button class="btn act" data-act="gskip" title="Pular direto pro próximo momento">⏭ momento</button>`
  }
  if (S.guide) html += `<button class="btn act" data-act="gstop">✕ Sair da guiada</button>`
  const nPz = ready ? ms.filter((m) => m.type === 'erro' || m.type === 'chance').length : 0
  if (nPz) html += S.savedMsg && S.savedFor === S.game ? `<span class="muted sm">${esc(S.savedMsg)}</span>` : `<button class="btn act ghost" data-act="gsave" title="Seus erros e as chances de punir viram desafios pra treinar depois">💾 Salvar ${nPz} desafio${nPz > 1 ? 's' : ''}</button>`
  html += `</div>`
  el.innerHTML = (ready || S.guide) && !S.training ? html : ''
  el.hidden = !(ready || S.guide)
}

// ── Saved challenges (desafios), training and Google Drive sync ─────────────
function localKey() { return 'puzzles.' + (S.account?.email || 'local') }
function loadLocal() { S.store = P.mergeStores(P.emptyStore(), store.get(localKey(), null)) }
function saveLocal() { store.set(localKey(), S.store) }
let syncT = null
function changed() { saveLocal(); renderAcct(); clearTimeout(syncT); syncT = setTimeout(syncDrive, 800) }
// O Google não dá refresh token pra app só de navegador: o access token dura ~1h.
// Pra não cair no meio do uso, renova no primeiro clique quando faltam <10 min
// (o popup do Google abre e fecha sozinho) e, se já venceu, no próximo clique.
let renewArmed = false, renewTimer = null
function armRenew() {
  if (renewArmed || !S.account || !G.available()) return
  renewArmed = true
  const renew = (e) => {
    if (!S.account || e.target.closest('[data-acct]')) return
    document.removeEventListener('pointerdown', renew, true); renewArmed = false
    googleLogin() // sem re-render aqui pra não engolir o clique em andamento
  }
  document.addEventListener('pointerdown', renew, true)
}
function scheduleRenew() {
  clearTimeout(renewTimer)
  const ms = G.expiresIn() - 10 * 60 * 1000
  renewTimer = setTimeout(armRenew, Math.max(0, ms))
}
async function syncDrive() {
  if (!G.signedIn()) { if (S.account) { armRenew(); S.syncMsg = 'sincroniza no próximo clique'; renderAcct() } return }
  S.syncMsg = 'sincronizando…'; renderAcct()
  try {
    const remote = await G.load()
    S.store = P.mergeStores(S.store, remote)
    saveLocal()
    await G.save(S.store)
    S.syncMsg = 'salvo no Drive ✓'
  } catch (e) { S.syncMsg = 'erro ao sincronizar: ' + e.message }
  renderAcct()
}
async function googleLogin() {
  try {
    await G.signIn(S.account?.email)
    const u = await G.userInfo()
    const anon = store.get('puzzles.local', null)
    S.account = { email: u.email, name: u.given_name || u.name || u.email }
    S.homeWarn = false
    store.set('account', S.account)
    loadLocal()
    if (anon) { S.store = P.mergeStores(S.store, anon); store.set('puzzles.local', null) } // adota desafios salvos antes do login
    saveLocal()
    scheduleRenew()
    await syncDrive()
  } catch (e) { S.syncMsg = 'login: ' + e.message; renderAcct(); if (S.account) armRenew() }
}
function googleLogout() {
  G.signOut(); S.account = null; store.set('account', null); S.syncMsg = null
  loadLocal(); renderAcct()
}
const GLOGO = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>'
const TARGET = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#81b64c" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="#81b64c"/></svg>'
const EMPTYBOARD = '<svg width="96" height="96" viewBox="0 0 96 96" aria-hidden="true"><rect x="8" y="8" width="80" height="80" rx="6" fill="none" stroke="#5a5652" stroke-width="2"/>' + [[8, 8], [48, 8], [28, 28], [68, 28], [8, 48], [48, 48], [28, 68], [68, 68]].map(([x, y]) => `<rect x="${x}" y="${y}" width="20" height="20" fill="#3c3936"/>`).join('') + '</svg>'
const loginBtn = (label = 'Entrar com Google') => `<button class="btn gbtn" data-acct="in">${GLOGO}${label}</button>`

function renderAcct() {
  const el = $('#acct'); if (!el) return
  const st = P.stats(S.store || P.emptyStore())
  $('#trainBtn').innerHTML = `🎯 Treinar${st.due ? ` <span class="pill">${st.due}</span>` : st.total ? ` <span class="pill muted">${st.total}</span>` : ''}`
  renderHome()
  if (!G.available()) { el.innerHTML = S.syncMsg ? `<span class="muted sm">${esc(S.syncMsg)}</span>` : ''; return }
  if (S.account) {
    const sub = S.syncMsg || (G.signedIn() ? 'Desafios salvos no Google Drive' : 'Sincronização pausada')
    el.innerHTML = `<div class="av" title="${esc(S.account.email || '')}">${esc((S.account.name || '?')[0].toUpperCase())}</div><div class="acct-txt"><b>${esc(S.account.name || '')}</b><span>${esc(sub)}</span></div>${G.signedIn() ? '' : '<button class="btn" data-acct="in" title="Reconectar pra sincronizar com o Drive">Sincronizar</button>'}<button class="btn outline" data-acct="out">Sair</button>`
  } else el.innerHTML = `${S.syncMsg ? `<span class="muted sm">${esc(S.syncMsg)}</span>` : ''}${loginBtn()}`
}

// Home: card "Meus desafios" (needs Google login when login is available)
function puzzlePrompt(p) {
  const side = p.color === 'w' ? 'Brancas' : 'Pretas'
  if (p.type === 'chance') {
    const opp = p.oppSan || (/jogar (\S+)\. Ache/.exec(p.prompt || '') || [])[1]
    return opp ? `O adversário acabou de jogar ${opp}. Ache a punição!` : `Vez das ${side}. Ache a punição!`
  }
  return `Vez das ${side}. Ache o melhor lance.`
}
function puzzleTitle(p) {
  const n = +(p.fen.split(' ')[5] || 1)
  if (p.type === 'chance') {
    const opp = p.oppSan || (/jogar (\S+)\. Ache/.exec(p.prompt || '') || [])[1] || ''
    const no = p.color === 'w' ? `${n - 1}...` : `${n}.`
    return opp ? `${no} ${opp}: ache a punição` : 'Ache a punição'
  }
  return `Lance ${n} (${p.color === 'w' ? 'Brancas' : 'Pretas'}): ache o melhor lance`
}
function puzzleWhen(p, now = Date.now()) {
  const d = Math.ceil(((p.due || 0) - now) / P.DAY)
  return d <= 0 ? 'hoje' : d === 1 ? 'amanhã' : `em ${d} dias`
}
function renderHome() {
  renderStats()
  if (S.tab === 'recent') renderRecent()
  const el = $('#chal'); if (!el) return
  const head = `<div class="ch-head">${TARGET}<h2>Meus desafios</h2></div>`
  const needLogin = G.available() && !S.account
  if (needLogin) {
    const anon = Object.keys(S.store?.puzzles || {}).length
    el.innerHTML = head + `<p class="ch-p">Seus erros e as chances que você deixa passar viram desafios pra treinar depois, com revisão espaçada até fixar.</p>` +
      (S.homeWarn
        ? `<div class="ch-warn" role="status"><p class="t">Entre com o Google pra ver seus desafios</p><p>Os desafios ficam salvos no seu Google Drive, numa pasta só do app. Assim eles acompanham você em qualquer aparelho.${anon ? ` Os ${anon} desafio${anon > 1 ? 's' : ''} que você já salvou neste navegador vão junto pra sua conta.` : ''}</p><div>${loginBtn()}</div></div>`
        : `<button class="btn big" data-home="warn">Ver meus desafios</button><p class="ch-note">Pra salvar e sincronizar entre aparelhos, entre com sua conta Google.</p>`)
    return
  }
  const st = P.stats(S.store || P.emptyStore())
  const local = !G.available() ? '<p class="ch-note">Aqui os desafios ficam salvos só neste navegador. Na versão do GitHub Pages dá pra entrar com o Google e sincronizar.</p>' : ''
  if (!st.total) {
    el.innerHTML = head + `<div class="ch-empty">${EMPTYBOARD}<p class="t">Nenhum desafio ainda</p><p class="ch-p">Seus desafios vão aparecer aqui conforme você revisar partidas. No fim de cada review, os momentos-chave viram desafios.</p></div>` + local
    return
  }
  const all = Object.values(S.store.puzzles).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  const list = S.homeAll ? all : all.slice(0, 4)
  el.innerHTML = head +
    `<div class="ch-stats"><div><b class="hi">${st.due}</b><span>pra revisar hoje</span></div><div><b>${st.total}</b><span>desafio${st.total > 1 ? 's' : ''}</span></div><div><b>${st.learned}</b><span>aprendido${st.learned === 1 ? '' : 's'}</span></div></div>` +
    `<button class="btn big green" id="homeTrain" data-home="train">${st.due ? `Treinar agora · ${st.due} desafio${st.due > 1 ? 's' : ''}` : 'Treinar mesmo assim'}</button>` +
    (st.due ? '' : '<p class="ch-note">Nada vencido hoje. Os desafios voltam no dia certo pra fixar; dá pra treinar extra mesmo assim.</p>') +
    `<div><h3 class="ch-note" style="font-weight:600;color:#cfcbc6;margin:6px 0 4px">${S.homeAll ? 'Todos os desafios' : 'Últimos desafios'}</h3><ul class="ch-list">` +
    list.map((p) => {
      const opp = p.color === 'w' ? p.game?.black : p.game?.white
      const dt = (p.game?.date || '').split('.')
      return `<li data-pz="${esc(p.id)}" title="Treinar este desafio"><span class="ty ${p.type === 'chance' ? 'chance' : 'erro'}">${p.type === 'chance' ? 'Punir' : 'Seu erro'}</span><div class="mid"><b>${esc(puzzleTitle(p))}</b><span>${opp ? 'vs ' + esc(opp) : ''}${dt.length === 3 ? ' · ' + dt[2] + '/' + dt[1] : ''}</span></div><span class="when">${puzzleWhen(p)}</span></li>`
    }).join('') + `</ul>` +
    (all.length > 4 ? `<button class="linkbtn" data-home="all">${S.homeAll ? 'Mostrar só os últimos' : `Ver todos os ${all.length} desafios`}</button>` : '') + `</div>` + local
}
function onHomeClick(e) {
  const acct = e.target.closest('[data-acct]')
  if (acct) return acct.dataset.acct === 'in' ? googleLogin() : googleLogout()
  const li = e.target.closest('[data-pz]')
  if (li) return startTraining([li.dataset.pz])
  const b = e.target.closest('[data-home]'); if (!b) return
  if (b.dataset.home === 'warn') { S.homeWarn = true; renderHome() }
  else if (b.dataset.home === 'train') startTraining()
  else if (b.dataset.home === 'all') { S.homeAll = !S.homeAll; renderHome() }
}
function goHome() {
  if (S.training) { S.training = null; S.trainMode = null; S.mode = null; S.reviewSnapshot = null; document.body.classList.remove('training') }
  stopAuto(); stopTimer(); S.runId++; resetStockfish(); show('setup'); renderAcct()
}

function makePuzzles(A = S) {
  const g = A.game, h = g.headers, out = []
  const gid = L.gameId(h, A.pgn || '')
  for (const m of keyMoments(A)) {
    if (m.type !== 'erro' && m.type !== 'chance') continue
    const kt = m.type === 'erro' ? m.k : m.k + 1
    const line = A.sf[kt]?.lines?.[0], info = A.infos[kt]
    if (!line || !line.pv.length || !info) continue
    const fen = g.positions[kt], color = g.plies[kt].color
    const motif = R.lineMotif(fen, line, color)
    out.push({
      id: P.puzzleId(fen, line.pv[0]), fen, best: line.pv[0], bestSan: motif.san, pv: line.pv.slice(0, 8), color,
      wpBefore: color === 'w' ? info.wpW : 100 - info.wpW, type: m.type,
      idea: R.explainBestMove(fen, line, color, motif, A.threats[kt]),
      prompt: m.type === 'erro' ? `Na partida você jogou ${g.plies[kt].san} aqui (${R.CLASSES[A.cls[kt].cls].label.toLowerCase()}). Ache um lance melhor.` : `O adversário acabou de jogar ${g.plies[m.k].san}. Ache a punição!`,
      ply: kt,
      played: g.plies[kt].san, oppSan: kt > 0 ? g.plies[kt - 1].san : undefined,
      last: kt > 0 ? { from: g.plies[kt - 1].from, to: g.plies[kt - 1].to } : null, prevFen: kt > 0 ? g.positions[kt - 1] : null,
      game: { id: gid, white: h.White || '', black: h.Black || '', date: h.UTCDate || h.Date || '', result: h.Result || '', link: h.Link || h.Site || '' },
    })
  }
  return out
}
function savePuzzles() {
  const list = makePuzzles()
  const n = P.addPuzzles(S.store, list)
  S.savedFor = S.game
  S.savedMsg = n ? `${n} desafio${n > 1 ? 's' : ''} salvo${n > 1 ? 's' : ''} ✓` : 'esses desafios já estavam salvos ✓'
  changed(); renderGuide()
}


// ── Minhas partidas: análise em lote, resumo e padrões de erro ─────────────
const SPP_DEFAULT = { fast: 0.35, normal: 1.1, deep: 2.6 } // segundos por posição (com o pool), ajusta com o uso
function secPerPos(depth) { return store.get('spp.' + depth, SPP_DEFAULT[depth] || 1) }
function learnSpeed(depth, spp) { if (spp > 0 && spp < 60) store.set('spp.' + depth, Math.round((secPerPos(depth) * 0.6 + spp * 0.4) * 1000) / 1000) }
const fmtDur = (s) => (s < 90 ? `${Math.max(5, Math.round(s / 5) * 5)}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`)
const AVG_POS = 80 // posições numa partida típica (~40 lances)

function recordGame(A, pgn, site, depth) {
  if (!pgn || !A.game?.plies?.length || !S.store) return null
  try {
    const acc = R.gameAccuracy(A.game, A.infos, A.cls)
    const sum = L.summarize(A, pgn, { site, depth, accuracy: acc })
    S.store.games[sum.id] = sum
    S.store.updatedAt = Date.now()
    changed()
    return sum
  } catch (e) { console.warn('resumo da partida falhou', e); return null }
}

// Análise sem UI (mesma lógica do runStockfish), pra rodar em lote
async function analyzeGame(pgn, side, opt, engines, alive, onPos) {
  const game = R.parseGame(pgn)
  const n = game.positions.length
  const sf = new Array(n), threats = new Array(game.plies.length)
  let next = 0, done = 0
  const loop = async (eng) => {
    for (;;) {
      if (!alive()) return
      const i = next++
      if (i >= n) return
      const fen = game.positions[i]
      const ch = new Chess(fen)
      sf[i] = ch.isGameOver() ? { lines: [] } : await eng.u.analyse(fen, { ...opt, multipv: 2 })
      if (!alive()) return
      if (i < game.plies.length && !ch.isGameOver() && !ch.inCheck()) {
        try { threats[i] = R.describeThreat(fen, await eng.u.analyse(R.nullMoveFen(fen), { depth: 10, movetime: 300 }), R.evalInfo(fen, sf[i]), game.plies[i].color) } catch { threats[i] = null }
      }
      done++; onPos?.(done, n)
    }
  }
  await Promise.all(engines.map(loop))
  if (!alive()) return null
  const sfx = sf.map((x) => x || { lines: [] })
  const cls = R.classify(game, sfx)
  const infos = game.positions.map((f, i) => R.evalInfo(f, sfx[i]))
  return { game, sf: sfx, threats, infos, cls, side, pgn, clock: R.clockData(game, pgn) }
}

// Configurações (jogador, site...) ficam no store, que vai pro Google Drive junto com os desafios.
function libSettings() { return { user: '', site: 'chesscom', count: 10, gen: true, ...store.get('lib', {}), ...(S.store?.profile || {}) } }
function setLib(patch) {
  const cur = libSettings()
  if (Object.keys(patch).every((k) => cur[k] === patch[k])) return // nada mudou (ex.: change disparado no blur)
  const next = { ...cur, ...patch, updatedAt: Date.now() }
  delete next.v
  store.set('lib', next) // cópia local (pré-login / migração)
  if (S.store) { S.store.profile = next; S.store.updatedAt = next.updatedAt; changed() }
  if (('user' in patch && patch.user !== cur.user) || ('site' in patch && patch.site !== cur.site)) S.recent = null
}
let batchEngines = []
function stopBatchEngines() { for (const e of batchEngines) e.w.terminate(); batchEngines = [] }
function cancelBatch(msg) {
  const B = S.batch; if (!B?.running) return
  B.cancel = true; B.running = false
  stopBatchEngines()
  B.msg = msg || (B.done ? `Cancelado. As partidas já analisadas (${B.done} de ${B.total}) ficaram salvas.` : 'Cancelado.')
  renderBatchUi()
}
async function runBatch() {
  const cfg = libSettings()
  const depth = $('#sDepth')?.value || 'deep'
  const opt = DEPTHS[depth]
  const canGen = !!S.account && cfg.gen
  const B = S.batch = { running: true, cancel: false, done: 0, total: 0, skipped: 0, newPuzzles: 0, cur: null, pos: 0, posN: 0, msg: 'Buscando partidas…', depth }
  const alive = () => S.batch === B && !B.cancel
  renderBatchUi()
  let list
  try { list = await L.fetchRecent(cfg.site, cfg.user, cfg.count) } catch (e) {
    const blocked = e instanceof TypeError
    B.running = false; B.error = true
    B.msg = blocked ? `Não consegui falar com o ${L.SITES[cfg.site]} (o navegador bloqueou a conexão; no claude.ai isso não funciona, só na versão do GitHub Pages).` : 'Não consegui buscar as partidas: ' + e.message
    return renderBatchUi()
  }
  if (!alive()) return
  const todo = []
  for (const { pgn } of list) {
    const h = R.gameSummary(pgn)
    const id = L.gameId(h, pgn), side = L.sideFor(h, cfg.user)
    if (!side) continue
    if (S.store.games[id]) { B.skipped++; continue }
    todo.push({ pgn, h, id, side })
  }
  B.total = todo.length
  if (!todo.length) { B.running = false; B.msg = list.length ? `As ${list.length} partidas mais recentes já estavam analisadas.` : 'Não achei partidas desse jogador.'; return renderBatchUi() }
  B.msg = null
  stopBatchEngines()
  batchEngines = Array.from({ length: POOL_SIZE }, makeEngine)
  try { await Promise.all(batchEngines.map((e) => e.ready)) } catch (e) { B.running = false; B.error = true; B.msg = 'O Stockfish não carregou: ' + e.message; return renderBatchUi() }
  for (const t of todo) { // mais recentes primeiro
    if (!alive()) return
    B.cur = t.h; B.pos = 0; B.posN = 0; renderBatchUi()
    const t0 = performance.now()
    let A
    try { A = await analyzeGame(t.pgn, t.side, opt, batchEngines, alive, (d, n) => { B.pos = d; B.posN = n; renderBatchUi(true) }) } catch (e) { console.warn('partida pulada', e); B.done++; continue }
    if (!A) return // cancelado no meio: essa partida é descartada, as anteriores ficam
    learnSpeed(depth, (performance.now() - t0) / 1000 / A.game.positions.length)
    recordGame(A, t.pgn, cfg.site, depth)
    if (canGen) B.newPuzzles += P.addPuzzles(S.store, makePuzzles(A))
    B.done++
    changed()
    renderBatchUi()
  }
  stopBatchEngines()
  B.running = false; B.cur = null
  B.msg = `Pronto: ${B.done} partida${B.done > 1 ? 's' : ''} analisada${B.done > 1 ? 's' : ''}${B.skipped ? ` (${B.skipped} já estava${B.skipped > 1 ? 'm' : ''} analisada${B.skipped > 1 ? 's' : ''})` : ''}${canGen ? ` · ${B.newPuzzles} desafio${B.newPuzzles === 1 ? '' : 's'} novo${B.newPuzzles === 1 ? '' : 's'}` : ''}.`
  renderBatchUi()
}

function batchProgressHtml() {
  const B = S.batch
  if (!B) return ''
  if (!B.running) return B.msg ? `<div class="bprog"><span${B.error ? ' style="color:#ff8a7a"' : ''}>${esc(B.msg)}</span></div>` : ''
  if (!B.total) return `<div class="bprog"><span>${esc(B.msg || 'Preparando…')}</span><button class="btn act" data-lib="cancel">Cancelar</button></div>`
  const frac = (B.done + (B.posN ? B.pos / B.posN : 0)) / B.total
  const cur = B.cur ? `${esc(B.cur.White || '?')} x ${esc(B.cur.Black || '?')}${fmtDate(B.cur.UTCDate || B.cur.Date) ? ' · ' + esc(fmtDate(B.cur.UTCDate || B.cur.Date)) : ''}` : ''
  return `<div class="bprog"><b>${B.done}/${B.total} partidas analisadas</b><div class="bar2"><span style="width:${Math.round(frac * 100)}%"></span></div>${cur ? `<span class="muted">Agora: ${cur} · ${B.pos}/${B.posN || '…'} posições</span>` : ''}${B.skipped ? `<span class="muted">${B.skipped} já estava${B.skipped > 1 ? 'm' : ''} analisada${B.skipped > 1 ? 's' : ''} e ${B.skipped > 1 ? 'foram puladas' : 'foi pulada'}.</span>` : ''}<span class="muted">Pode cancelar: as partidas já analisadas ficam salvas.</span><div><button class="btn act" data-lib="cancel">Cancelar</button></div></div>`
}
function fmtDate(d) { const x = String(d || '').split('.'); return x.length === 3 && !/\?/.test(d) ? `${x[2]}/${x[1]}/${x[0].slice(2)}` : '' }

function renderSettings() {
  const el = $('#settings'); if (!el || el.hidden) return
  const cfg = libSettings()
  const running = S.batch?.running
  const depth = $('#sDepth')?.value || 'deep'
  const per = secPerPos(depth) * AVG_POS
  const logged = !!S.account
  const genTip = logged ? 'Os seus erros e as chances de punir de cada partida viram desafios, salvos no seu Google Drive.' : G.available() ? 'Precisa entrar com o Google pra gerar desafios: eles ficam salvos no seu Google Drive.' : 'Precisa entrar com o Google pra gerar desafios. Aqui no claude.ai o login do Google não funciona; use a versão do GitHub Pages.'
  el.innerHTML = `<h3>Minhas partidas</h3>
    <label class="row">Jogador<input type="text" id="sUser" value="${esc(cfg.user)}" placeholder="seu usuário" ${running ? 'disabled' : ''}></label>
    <div class="row">Site<div class="seg">${Object.entries(L.SITES).map(([k, v]) => `<button class="chip${cfg.site === k ? ' on' : ''}" data-site="${k}" ${running ? 'disabled' : ''}>${v}</button>`).join('')}</div></div>
    <label class="row"><span>Quantas partidas <span class="hint" tabindex="0" data-tip="~${fmtDur(per)} por partida na profundidade escolhida (estimativa pra uma partida de ~40 lances neste aparelho; melhora com o uso). Começa pelas mais recentes e pula as que já foram analisadas.">?</span></span>
      <select id="sCount" ${running ? 'disabled' : ''}>${[5, 10, 20, 30, 50].map((n) => `<option${n === +cfg.count ? ' selected' : ''}>${n}</option>`).join('')}</select>
      <span class="est" id="sEst">~${fmtDur(per)} por partida · ~${fmtDur(per * cfg.count)} no total</span></label>
    <label class="row">Profundidade<select id="sDepth" ${running ? 'disabled' : ''}><option value="deep"${depth === 'deep' ? ' selected' : ''}>Profunda (padrão)</option><option value="normal"${depth === 'normal' ? ' selected' : ''}>Normal</option><option value="fast"${depth === 'fast' ? ' selected' : ''}>Rápida</option></select></label>
    <label class="switch${logged ? '' : ' off'}"><input type="checkbox" id="sGen" ${logged && cfg.gen ? 'checked' : ''} ${logged && !running ? '' : 'disabled'}> Gerar desafios <span class="hint" tabindex="0" data-tip="${esc(genTip)}">?</span></label>
    ${batchProgressHtml()}
    ${running ? '' : `<button class="btn big green" data-lib="run">Analisar partidas</button>`}`
}
function renderBatchUi(light) {
  const B = S.batch
  const badge = $('#batchBadge')
  badge.hidden = !B?.running
  if (B?.running) badge.textContent = B.total ? `⏳ ${B.done}/${B.total}` : '⏳'
  if (light && !$('#settings').hidden) { const pr = $('#settings .bprog'); if (pr) { pr.outerHTML = batchProgressHtml(); return } }
  renderSettings()
  if (!light) renderStats()
  else { const pr = $('#stats .bprog'); if (pr) pr.outerHTML = batchProgressHtml() }
}
function toggleSettings(force) {
  const el = $('#settings')
  const was = el.hidden
  el.hidden = force === undefined ? !el.hidden : !force
  if (el.hidden && !was && S.tab === 'recent' && !$('#recentPane').hidden) { if (!S.recent && libSettings().user) loadRecent(20); else renderRecent() }
  if (!el.hidden) { const u = libSettings(); if (!u.user && $('#user').value.trim()) setLib({ user: $('#user').value.trim() }); renderSettings() }
}
function onSettings(e) {
  const cfg = libSettings()
  const site = e.target.closest('[data-site]')
  if (site) { setLib({ site: site.dataset.site }); return renderSettings() }
  const b = e.target.closest('[data-lib]'); if (!b) return
  if (b.dataset.lib === 'cancel') return cancelBatch()
  if (b.dataset.lib === 'run') {
    if (!libSettings().user) { $('#sUser').focus(); $('#sUser').style.borderColor = '#fa412d'; return }
    runBatch()
  }
}
function onSettingsInput(e) {
  const cfg = libSettings()
  if (e.target.id === 'sUser') setLib({ user: e.target.value.trim() })
  else if (e.target.id === 'sCount') { setLib({ count: +e.target.value }); renderSettings() }
  else if (e.target.id === 'sGen') setLib({ gen: e.target.checked })
  else if (e.target.id === 'sDepth') renderSettings()
}

// Card "Seus padrões" na tela inicial
function renderStats() {
  const el = $('#stats'); if (!el) return
  const games = S.store?.games || {}
  const ag = L.aggregate(games, 20)
  if (!ag.n && !S.batch) { el.hidden = true; return }
  el.hidden = false
  let html = `<div class="ch-head"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#81b64c" stroke-width="2" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg><h2>Seus padrões</h2></div>`
  html += batchProgressHtml()
  if (ag.n) {
    html += `<p class="ch-note">${ag.n > 1 ? `Nas suas últimas ${ag.n} partidas analisadas` : 'Na sua última partida analisada'}: ${ag.wins}V ${ag.draws}E ${ag.losses}D${ag.accuracy !== null ? ` · precisão média ${ag.accuracy.toFixed(1)}` : ''} · ${ag.perGame.toFixed(1)} erro${ag.perGame >= 1.95 || ag.perGame < 1 ? 's' : ''} por partida</p>`
    if (ag.top.length) {
      const max = ag.top[0].n
      html += `<div>` + ag.top.map((c) => `<div class="cat" title="${esc(c.tip || '')}"><span>${esc(c.label || c.cat)}</span><b>${c.n}</b><div class="bar2"><span style="width:${Math.round((c.n / max) * 100)}%;background:${c === ag.top[0] ? '#fa412d' : '#81b64c'}"></span></div></div>`).join('') + `</div>`
      if (ag.zeit) html += `<p class="ch-note">⏱ ${ag.zeit} desses erros foram com pouco tempo no relógio.</p>`
    } else html += `<p class="ch-note">Nenhum erro grave nessas partidas. 👏</p>`
    const recent = Object.values(games).sort((a, b) => (b.analyzedAt || 0) - (a.analyzedAt || 0)).slice(0, 5)
    html += `<ul class="glist">` + recent.map((g) => {
      const sc = L.scoreFor(g)
      const opp = g.side === 'w' ? g.black : g.white
      return `<li data-game="${esc(g.id)}" title="Revisar essa partida"><span class="gres ${sc === 1 ? 'w' : sc === 0 ? 'l' : 'd'}">${sc === 1 ? 'V' : sc === 0 ? 'D' : sc === 0.5 ? 'E' : '?'}</span><span style="flex:1">vs ${esc(opp || '?')}${fmtDate(g.date) ? ` <span class="muted">· ${esc(fmtDate(g.date))}</span>` : ''}</span><span class="muted">${(g.errors || []).length} erro${(g.errors || []).length === 1 ? '' : 's'}${g.accuracy !== null && g.accuracy !== undefined ? ' · ' + g.accuracy.toFixed(0) + '%' : ''}</span></li>`
    }).join('') + `</ul>`
  } else if (!S.batch?.running) html += `<p class="ch-note">Analise suas partidas pelo ⚙ no canto de cima pra ver aqui os erros que mais se repetem.</p>`
  el.innerHTML = html
}
function onStatsClick(e) {
  const c = e.target.closest('[data-lib=cancel]'); if (c) return cancelBatch()
  const li = e.target.closest('[data-game]'); if (!li) return
  openStoredGame(li.dataset.game)
}
// Abre a partida guardada; com um desafio, já pula pro momento dele.
async function openStoredGame(id, puzzle) {
  const g = S.store?.games?.[id]; if (!g?.pgn) return false
  if (S.training) { S.training = null; S.trainMode = null; S.mode = null; S.reviewSnapshot = null; document.body.classList.remove('training') }
  $('#pgn').value = g.pgn
  updateDetect()
  S.pick = g.side
  await start()
  if (puzzle && S.game) {
    const key = (f) => f.split(' ').slice(0, 4).join(' ')
    let k = Number.isInteger(puzzle.ply) && S.game.positions[puzzle.ply] && key(S.game.positions[puzzle.ply]) === key(puzzle.fen) ? puzzle.ply : S.game.positions.findIndex((f) => key(f) === key(puzzle.fen))
    if (k >= 0) go(k)
  }
  return true
}

// ── Aba "Minhas partidas" no card de revisar ────────────────────────────────
function setTab(t) {
  S.tab = t
  for (const b of document.querySelectorAll('.tab')) { const on = b.dataset.tab === t; b.classList.toggle('on', on); b.setAttribute('aria-selected', on) }
  $('#pastePane').hidden = t !== 'paste'
  $('#recentPane').hidden = t !== 'recent'
  if (t === 'recent') { renderRecent(); if (!S.recent && libSettings().user) loadRecent(20) }
}
async function loadRecent(n) {
  const cfg = libSettings()
  const R0 = S.recent = { key: cfg.site + ':' + cfg.user.toLowerCase(), n, loading: true, list: S.recent?.list || [] }
  renderRecent()
  try {
    const list = await L.fetchRecent(cfg.site, cfg.user, n)
    if (S.recent !== R0) return
    R0.list = list.map(({ pgn }) => { const h = R.gameSummary(pgn); return { pgn, h, id: L.gameId(h, pgn), side: L.sideFor(h, cfg.user) } }).filter((g) => g.side)
    R0.more = list.length >= n
  } catch (e) {
    if (S.recent !== R0) return
    R0.error = e instanceof TypeError ? `Não consegui falar com o ${L.SITES[cfg.site]} (o navegador bloqueou a conexão; no claude.ai isso não funciona, só na versão do GitHub Pages).` : 'Não consegui buscar as partidas: ' + e.message
  }
  R0.loading = false
  renderRecent()
}
function renderRecent() {
  const el = $('#recentPane'); if (!el || el.hidden) return
  const cfg = libSettings()
  if (!cfg.user) {
    el.innerHTML = `<div class="ch-empty"><p class="t">Qual é o seu usuário?</p><p class="ch-p">Configure seu usuário do chess.com ou do Lichess no ⚙ e as suas partidas recentes aparecem aqui pra revisar com um clique.${S.account ? ' Fica salvo na sua conta do Google.' : ''}</p><button class="btn big green" data-rc="cfg">Configurar usuário</button></div>`
    return
  }
  if (S.recent && S.recent.key !== cfg.site + ':' + cfg.user.toLowerCase()) S.recent = null
  const R0 = S.recent
  if (!R0) {
    el.innerHTML = `<div class="rhead"><span>♟ <b>${esc(cfg.user)}</b> no ${L.SITES[cfg.site]}</span><button class="linkbtn" data-rc="cfg">trocar</button></div><button class="btn big green" data-rc="reload">Buscar minhas partidas</button>`
    return
  }
  let html = `<div class="rhead"><span>♟ <b>${esc(cfg.user)}</b> no ${L.SITES[cfg.site]}</span><button class="linkbtn" data-rc="cfg">trocar</button><span class="grow"></span><button class="btn act" data-rc="reload" ${R0?.loading ? 'disabled' : ''}>${R0?.loading ? 'Buscando…' : '↻ Atualizar'}</button></div>`
  if (R0?.error) html += `<p class="ch-note" style="color:#ff8a7a">${esc(R0.error)}</p>`
  const list = R0?.list || []
  if (!list.length && R0?.loading) html += `<p class="ch-note">Buscando suas partidas…</p>`
  else if (!list.length && !R0?.error) html += `<p class="ch-note">Não achei partidas recentes desse usuário.</p>`
  if (list.length) {
    html += `<ul class="rlist">` + list.map((g, i) => {
      const h = g.h, sc = L.scoreFor({ result: h.Result, side: g.side })
      const opp = g.side === 'w' ? h.Black : h.White, oppElo = g.side === 'w' ? h.BlackElo : h.WhiteElo
      const done = S.store?.games?.[g.id]
      const date = fmtDate(h.UTCDate || h.Date)
      return `<li data-ri="${i}" title="Revisar essa partida"><span class="gres ${sc === 1 ? 'w' : sc === 0 ? 'l' : 'd'}">${sc === 1 ? 'V' : sc === 0 ? 'D' : sc === 0.5 ? 'E' : '?'}</span><span class="who">vs ${esc(opp || '?')}${oppElo ? ` <span class="muted">(${esc(oppElo)})</span>` : ''}</span><span class="tagz">${done ? `<span class="done" title="Já analisada">✓ ${(done.errors || []).length} erro${(done.errors || []).length === 1 ? '' : 's'}${done.accuracy != null ? ' · ' + done.accuracy.toFixed(0) + '%' : ''}</span>` : ''}</span><span class="meta">${g.side === 'w' ? '♔ Brancas' : '♚ Pretas'}${L.tcLabel(h.TimeControl) ? ' · ' + esc(L.tcLabel(h.TimeControl)) : ''}${date ? ' · ' + esc(date) : ''}</span></li>`
    }).join('') + `</ul>`
    if (R0.more && !R0.loading) html += `<button class="linkbtn" data-rc="more" style="margin-top:8px">Carregar mais partidas</button>`
  }
  el.innerHTML = html
}
function onRecentClick(e) {
  const b = e.target.closest('[data-rc]')
  if (b) {
    if (b.dataset.rc === 'cfg') return toggleSettings(true)
    if (b.dataset.rc === 'reload') { S.recent = null; return loadRecent(20) }
    if (b.dataset.rc === 'more') return loadRecent((S.recent?.n || 20) + 20)
  }
  const li = e.target.closest('[data-ri]'); if (!li) return
  const g = S.recent?.list?.[+li.dataset.ri]; if (!g) return
  $('#pgn').value = g.pgn
  updateDetect()
  S.pick = g.side
  start()
}

// Training session
const REVIEW_KEYS = ['game', 'sf', 'threats', 'infos', 'cls', 'maia', 'maiaRaw', 'idx', 'side', 'flip', 'clock', 'vars', 'anCache', 'maiaElo', 'guide']
function startTraining(first) {
  if (G.available() && !S.account) { S.homeWarn = true; goHome(); return }
  const due = P.dueList(S.store)
  const all = Object.values(S.store.puzzles)
  if (!all.length) { alertBox('Você ainda não tem desafios salvos. Revise uma partida e clique em "💾 Salvar desafios".'); return }
  let queue = P.shuffleSpread(due.length ? due : all).slice(0, 15).map((p) => p.id)
  if (first?.length) queue = [...first, ...queue.filter((id) => !first.includes(id))]
  if (!S.training && S.game) S.reviewSnapshot = Object.fromEntries(REVIEW_KEYS.map((k) => [k, S[k]]))
  stopAuto(); stopTimer()
  S.training = { queue, pos: 0, extra: !due.length, done: 0, ok: 0 }
  document.body.classList.add('training')
  show('review')
  openPuzzle()
}
function alertBox(msg) { S.syncMsg = msg; renderAcct(); setTimeout(() => { if (S.syncMsg === msg) { S.syncMsg = null; renderAcct() } }, 6000) }
function openPuzzle() {
  const T = S.training
  const p = S.store.puzzles[T.queue[T.pos]]
  if (!p) return finishTraining()
  const flip = p.color === 'b'
  Object.assign(S, { game: { headers: { White: p.game.white, Black: p.game.black }, plies: [], positions: [p.fen] }, sf: [], threats: [], infos: [], cls: [], maia: [], vars: [], anCache: {}, idx: 0, side: p.color, flip, clock: null, guide: false })
  // desafio é puzzle: não mostra o lance que você jogou na partida
  S.trainMode = { type: 'puzzle', p, fen: p.fen, k: 0, sel: null, tries: 0, msg: null, ok: null, hint: null, wrong: null, solved: null, busy: false, clean: true, played: null, last: p.last || null, prevFen: p.prevFen || null }
  S.mode = S.trainMode
  render()
}
function finishTraining() {
  const T = S.training
  S.trainMode = { type: 'puzzle', p: null, done: true, fen: S.game?.positions?.[0] || new Chess().fen(), k: 0 }
  S.mode = S.trainMode
  render()
  T.finished = true
}
function exitTraining() {
  S.training = null; S.trainMode = null; S.mode = null
  document.body.classList.remove('training')
  if (S.reviewSnapshot) { Object.assign(S, S.reviewSnapshot); S.reviewSnapshot = null; show('review'); buildMoveList(); render() }
  else show('setup')
  renderAcct()
}
async function tryPuzzle(uci) {
  const M = S.mode, p = M.p
  M.busy = true; M.tries++; M.sel = null; M.wrong = null
  const ch = new Chess(M.fen)
  let mv
  try { mv = ch.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' }) } catch { M.busy = false; return render() }
  const solve = (text) => {
    const first = M.clean && M.tries === 1
    Object.assign(M, { busy: false, ok: true, solved: uci, msg: text })
    P.recordResult(S.store, p.id, first)
    S.training.done++; if (first) S.training.ok++
    changed(); render()
  }
  if (uci.slice(0, 4) === p.best.slice(0, 4)) return solve(`Isso! ${mv.san}${p.idea ? ': ' + p.idea : ''}.`)
  M.msg = `Conferindo ${mv.san}…`; M.pending = uci; render()
  try {
    const an = ch.isGameOver() ? { lines: [] } : await getStockfish().u.analyse(ch.fen(), { depth: 14, movetime: 1200 })
    if (S.mode !== M) return
    const fb = R.attemptFeedback(M.fen, uci, an, p.color, p.wpBefore, { pv: p.pv })
    if (fb && fb.ok) return solve(`Boa! ${fb.text} A solução era ${p.bestSan}.`)
    Object.assign(M, { busy: false, ok: false, wrong: uci, msg: (fb ? fb.text : `${mv.san} não é o melhor.`) + (M.tries >= 2 && !M.hint ? ' Quer uma dica?' : '') })
    M.clean = false
  } catch (e) { M.busy = false; M.msg = 'Não consegui conferir: ' + e.message }
  render()
}
function renderPuzzlePanel(box) {
  const M = S.mode, T = S.training
  if (M.done || !M.p) {
    box.innerHTML = `<div class="coach-head"><div class="avatar">🏁</div><div><b>Treino concluído</b><div class="sub">${T.ok} de ${T.done} de primeira</div></div></div><p class="say">${P.stats(S.store).due ? `Ainda tem ${P.stats(S.store).due} desafio(s) pra revisar.` : 'Nada mais pra revisar agora. Os desafios voltam no dia certo pra fixar.'}</p><div class="acts">${P.stats(S.store).due ? '<button class="btn act retry" data-act="tagain">Continuar treinando</button>' : ''}<button class="btn act" data-act="texit">Sair do treino</button></div>`
    return
  }
  const p = M.p
  const st = P.stats(S.store)
  const g = p.game
  let srcHtml = ''
  let html = `<div class="coach-head"><div class="avatar">🎯</div><div><b>Desafio ${T.pos + 1} de ${T.queue.length}</b>${T.extra ? ' <span class="tag">treino extra</span>' : ''}<div class="sub">${esc(g.white)} x ${esc(g.black)}${fmtDate(g.date) ? ' · ' + esc(fmtDate(g.date)) : ''} · você joga de ${p.color === 'w' ? 'Brancas' : 'Pretas'} · ${st.due} pra revisar · ${st.learned}/${st.total} aprendidos</div></div></div>`
  if (M.msg) html += `<p class="say ${M.ok ? 'good' : M.ok === false ? 'badmsg' : ''}">${linkify(M.msg, [M.fen])}</p>`
  else html += `<p class="say">${linkify(puzzlePrompt(p), [M.fen, p.prevFen])}</p>`
  html += `<div class="acts">`
  if (!M.solved) {
    if (!M.hint) html += `<button class="btn act" data-act="thint">💡 Dica</button>`
    html += `<button class="btn act" data-act="treveal">Mostrar resposta</button>`
  } else {
    html += `<button class="btn act retry" data-act="tnext">Próximo desafio ▶</button><button class="btn act" data-act="tline">▶ Explicar a linha</button>`
  }
  if (M.solved) {
    const n = +(p.fen.split(' ')[5] || 1)
    const lance = `${n} (${p.color === 'w' ? 'Brancas' : 'Pretas'})`
    const link = /^https?:\/\//.test(g.link || '') ? g.link : ''
    const stored = g.id && S.store.games?.[g.id]?.pgn
    srcHtml = `<div class="src">♟ Esse desafio veio da partida <b>${esc(g.white)} x ${esc(g.black)}</b>${fmtDate(g.date) ? ' · ' + esc(fmtDate(g.date)) : ''}${g.result ? ' · ' + esc(g.result) : ''}${lance ? ` · lance ${esc(lance)}` : ''}.${link ? ` <a href="${esc(link)}" target="_blank" rel="noopener" style="color:#9cc76a">Abrir no ${/lichess/.test(link) ? 'Lichess' : 'chess.com'} ↗</a>` : ''}</div>${stored ? `<div class="acts"><button class="btn act retry" data-act="tgame">♟ Ver esse momento na partida</button></div>` : ''}`
  }
  html += `<button class="btn act" data-act="tdel" title="Remover este desafio">🗑</button><button class="btn act" data-act="texit">Sair do treino</button></div>`
  box.innerHTML = html + srcHtml
}
function trainAction(act) {
  const M = S.trainMode, T = S.training
  if (act === 'texit') return exitTraining()
  if (act === 'tgame') return openStoredGame(M.p.game.id, M.p)
  if (act === 'tagain') { S.training = null; return startTraining() }
  if (act === 'tnext') { T.pos++; return T.pos < T.queue.length ? openPuzzle() : finishTraining() }
  if (act === 'thint') { M.hint = M.p.best.slice(0, 2); M.clean = false; M.msg = `Dica: a peça certa está em ${M.hint}.`; M.ok = null; return render() }
  if (act === 'treveal') {
    Object.assign(M, { solved: M.p.best, ok: null, wrong: null, sel: null, msg: `O lance era ${M.p.bestSan}${M.p.idea ? ': ' + M.p.idea : ''}.` })
    P.recordResult(S.store, M.p.id, false); T.done++; changed(); return render()
  }
  if (act === 'tdel') { P.removePuzzle(S.store, M.p.id); changed(); T.queue.splice(T.pos, 1); return T.pos < T.queue.length ? openPuzzle() : finishTraining() }
  if (act === 'tline') {
    const p = M.p
    const steps = R.explainLine(p.fen, p.pv, { side: p.color })
    const [, turn, , , , full] = p.fen.split(' ')
    S.mode = { type: 'line', k: null, plyBase: (+full - 1) * 2 + (turn === 'b' ? 1 : 0), kind: 'best', fens: [p.fen, ...steps.map((x) => x.fen)], moves: steps, steps, i: 0, label: `Explicando ${p.bestSan}`, playing: false, fromLabel: 'a posição do desafio' }
    render()
  }
}

// ── Move list / graph / summary ─────────────────────────────────────────────
function varRowHtml(v) {
  let html = `<div class="varrow${S.mode === v ? ' on' : ''}"><span class="vmoves">`
  v.moves.forEach((m, j) => {
    const ply = v.fromIdx + j
    const num = ply % 2 === 0 ? `${ply / 2 + 1}. ` : j === 0 ? `${(ply - 1) / 2 + 1}... ` : ''
    const c = v.cls[j], C = c ? R.CLASSES[c] : null
    html += `${num ? `<span class="vno">${num}</span>` : ''}<button class="vmv${S.mode === v && v.i === j + 1 ? ' cur' : ''}" data-var="${v.id}" data-j="${j + 1}">${C ? `<i class="dot" style="background:${C.color}" title="${C.label}"></i>` : ''}${esc(m.san)}</button> `
  })
  return html + `</span><button class="vdel" data-del="${v.id}" title="Apagar variante">✕</button></div>`
}
function buildMoveList() {
  const g = S.game
  const vars = S.vars || []
  const rowOf = (v) => (g.plies.length ? Math.floor(Math.min(v.fromIdx, g.plies.length - 1) / 2) : -1)
  let html = ''
  if (!g.plies.length) for (const v of vars) html += varRowHtml(v)
  for (let k = 0; k < g.plies.length; k += 2) {
    html += `<div class="row"><span class="no">${k / 2 + 1}.</span>`
    for (const j of [k, k + 1]) {
      if (j < g.plies.length) {
        const sp = S.clock ? S.clock.spent[j] : null
        const mx = S.clock ? Math.max(1, ...S.clock.spent.filter((x) => x !== null)) : 1
        html += `<button class="mv" data-i="${j + 1}" id="mv${j + 1}"><i class="dot"></i>${esc(g.plies[j].san)}${sp !== null && sp !== undefined ? `<span class="tm">${R.fmtSpent(sp)}</span><i class="tbar" style="width:${Math.max(2, (sp / mx) * 60)}%"></i>` : ''}</button>`
      }
    }
    html += `</div>`
    for (const v of vars) if (rowOf(v) === k / 2) html += varRowHtml(v)
  }
  const box = $('#moves')
  const top = box.scrollTop
  box.innerHTML = html
  box.scrollTop = top
  box.onclick = (e) => {
    const del = e.target.closest('[data-del]'); if (del) return deleteVar(+del.dataset.del)
    const vb = e.target.closest('[data-var]'); if (vb) { const v = S.vars.find((x) => x.id === +vb.dataset.var); if (v) enterVar(v, +vb.dataset.j); return }
    const b = e.target.closest('button.mv'); if (b) go(+b.dataset.i)
  }
}
function renderMoveList() {
  buildMoveList()
  S.game.plies.forEach((p, k) => {
    const el = $('#mv' + (k + 1))
    const r = S.cls[k]
    el.classList.toggle('cur', !S.mode && S.idx === k + 1)
    el.classList.toggle('fork', S.mode?.type === 'explore' && S.mode.fromIdx === k)
    const d = el.querySelector('.dot')
    if (r) { d.style.background = R.CLASSES[r.cls].color; d.title = R.CLASSES[r.cls].label; el.dataset.cls = r.cls }
  })
  const cur = S.mode?.type === 'explore' ? $('#moves .vmv.cur') : $('#mv' + S.idx)
  cur?.scrollIntoView({ block: 'nearest' })
}
function renderGraph() {
  const n = S.game.positions.length
  $('#graph').hidden = n < 2
  if (n < 2) return
  const W = 600, H = 90
  const pts = S.infos.map((inf, i) => (inf ? [(i / (n - 1)) * W, H - (inf.wpW / 100) * H] : null))
  let d = ''
  let started = false
  pts.forEach((pt, i) => { if (!pt) return; d += (started ? 'L' : 'M') + pt[0].toFixed(1) + ',' + pt[1].toFixed(1); started = true })
  const lastPt = [...pts].reverse().find(Boolean)
  const area = started ? `${d}L${lastPt[0]},${H}L0,${H}Z` : ''
  let dots = ''
  S.cls.forEach((r, k) => {
    if (!r || !['blunder', 'mistake', 'miss', 'brilliant', 'great'].includes(r.cls)) return
    const pt = pts[k + 1]
    if (pt) dots += `<circle cx="${pt[0]}" cy="${pt[1]}" r="4.5" fill="${R.CLASSES[r.cls].color}" stroke="#222" stroke-width="1"/>`
  })
  const cx = (S.idx / (n - 1)) * W
  $('#graph').innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><rect width="${W}" height="${H}" fill="#403d39"/><path d="${area}" fill="#fff"/><line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" stroke="#888" stroke-dasharray="3 3" stroke-width=".6"/><line x1="${cx}" x2="${cx}" y1="0" y2="${H}" stroke="#4a8fd6" stroke-width="2"/>${dots}</svg>`
}
function graphClick(e) {
  if (S.game.positions.length < 2) return
  const rect = e.currentTarget.getBoundingClientRect()
  const n = S.game.positions.length
  go(Math.round(((e.clientX - rect.left) / rect.width) * (n - 1)))
}

function renderSummary() {
  const g = S.game
  if (!S.cls.length || S.cls.some((x) => !x)) return
  const acc = R.gameAccuracy(g, S.infos, S.cls)
  const counts = { w: {}, b: {} }
  S.cls.forEach((r, k) => { const c = g.plies[k].color; counts[c][r.cls] = (counts[c][r.cls] || 0) + 1 })
  const h = g.headers
  let html = `<table><tr><th></th><th>${esc(h.White || 'Brancas')}</th><th>${esc(h.Black || 'Pretas')}</th></tr>`
  html += `<tr class="acc"><td>Precisão</td><td>${acc.w?.toFixed(1) ?? '-'}</td><td>${acc.b?.toFixed(1) ?? '-'}</td></tr>`
  for (const c of R.CLASS_ORDER) {
    const C = R.CLASSES[c]
    if (!counts.w[c] && !counts.b[c]) continue
    html += `<tr class="cl" data-cls="${c}"><td><span class="badge sm" style="background:${C.color}">${C.sym}</span> ${C.label}</td><td>${counts.w[c] || 0}</td><td>${counts.b[c] || 0}</td></tr>`
  }
  html += '</table>'
  $('#summary').innerHTML = html
  $('#summary').hidden = false
}

function render() {
  if (!S.game) return
  renderBoard(); renderCoach(); renderMoveList(); renderGraph(); renderGuide()
  $('#counter').textContent = S.mode?.type === 'explore' ? 'variante' : `${S.idx}/${S.game.plies.length}`
}
function go(i, internal) {
  S.sel = null
  S.overlay = null; S.overlayIdx = null; S.hover = null
  if (!internal) stopAuto()
  if (S.mode) { stopTimer(); S.mode = null }
  S.idx = Math.max(0, Math.min(S.game.plies.length, i))
  render()
}
function jumpError(dir) {
  const bad = ['inaccuracy', 'mistake', 'blunder', 'miss']
  const n = S.game.plies.length
  for (let i = S.idx + dir; i >= 1 && i <= n; i += dir) {
    const r = S.cls[i - 1]
    if (r && bad.includes(r.cls) && S.game.plies[i - 1].color === S.side) return go(i)
  }
}

// ── Annotated PGN export ────────────────────────────────────────────────────
const NAG = { brilliant: '$3', great: '$1', mistake: '$2', blunder: '$4', inaccuracy: '$6', miss: '$2' }
function annotatedPgn() {
  const g = S.game
  const h = g.headers
  let out = Object.entries(h).filter(([, v]) => v).map(([k, v]) => `[${k} "${String(v).replace(/"/g, "'")}"]`).join('\n') + '\n[Annotator "Coach de Xadrez (Stockfish + Maia)"]\n\n'
  g.plies.forEach((p, k) => {
    if (p.color === 'w') out += `${k / 2 + 1}. `
    else if (k === 0) out += '1... '
    out += p.san
    const r = S.cls[k]
    if (r) {
      if (NAG[r.cls]) out += ' ' + NAG[r.cls]
      const t = R.coachText(g, S.sf.map((x) => x || { lines: [] }), S.threats, S.cls, k, S.maia.length ? S.maia : null)
      out += ` { [%eval ${r.after.mateW ? '#' + r.after.mateW : (r.after.cpW / 100).toFixed(2)}] ${R.CLASSES[r.cls].label}. ${t.text.replace(/[{}]/g, '')}${t.tip ? ' Dica: ' + t.tip.replace(/[{}]/g, '') : ''} }`
    }
    out += ' '
  })
  return out + (h.Result || '*')
}

// ── Wire up ─────────────────────────────────────────────────────────────────
function init() {
  initSetup()
  S.account = store.get('account', null)
  loadLocal()
  if (!S.store.profile && store.get('lib', null)?.user) S.store.profile = { ...store.get('lib', {}), updatedAt: store.get('lib', {}).updatedAt || 1 }
  $('#trainBtn').onclick = () => (S.training ? exitTraining() : startTraining())
  $('#acct').onclick = (e) => { const b = e.target.closest('[data-acct]'); if (!b) return; b.dataset.acct === 'in' ? googleLogin() : googleLogout() }
  $('#gear').onclick = (e) => { e.stopPropagation(); toggleSettings() }
  $('#batchBadge').onclick = (e) => { e.stopPropagation(); toggleSettings(true) }
  $('#settings').addEventListener('click', onSettings)
  $('#settings').addEventListener('input', onSettingsInput)
  $('#settings').addEventListener('change', onSettingsInput)
  $('#stats').onclick = onStatsClick
  for (const b of document.querySelectorAll('.tab')) b.onclick = () => setTab(b.dataset.tab)
  $('#recentPane').onclick = onRecentClick
  document.addEventListener('pointerdown', (e) => { if (!$('#settings').hidden && !e.target.closest('#settings,#gear,#batchBadge,.hint')) toggleSettings(false) })
  // Sessão: conta fica lembrada até clicar em Sair. Se o token venceu, renova
  // sozinho no primeiro clique (o Google exige um clique pra abrir o popup).
  if (S.account && G.available()) { if (G.signedIn()) { syncDrive(); scheduleRenew() } else armRenew() }
  // Primeira visita sem login: oferece entrar com o Google (uma vez só)
  if (G.available() && !S.account && !store.get('loginPrompted', false)) {
    const m = $('#loginModal')
    $('#lmLogin').innerHTML = loginBtn()
    const close = () => { m.hidden = true; store.set('loginPrompted', true); document.removeEventListener('keydown', onKey) }
    const onKey = (e) => { if (e.key === 'Escape') close() }
    m.onclick = (e) => {
      if (e.target === m || e.target.closest('[data-lm=no]')) return close()
      if (e.target.closest('[data-acct=in]')) { close(); googleLogin() }
    }
    document.addEventListener('keydown', onKey)
    m.hidden = false
    m.querySelector('[data-acct=in]').focus()
  }
  document.body.dataset.view = 'setup'
  renderAcct()
  $('#first').onclick = () => go(0)
  $('#prev').onclick = () => navStep(-1)
  $('#next').onclick = () => navStep(1)
  $('#last').onclick = () => navEnd()
  $('#prevErr').onclick = () => guideAction('gprev')
  $('#nextErr').onclick = () => guideAction('gauto')
  $('#flip').onclick = () => { S.flip = !S.flip; render() }
  $('#showBest').onchange = render
  $('#showNext').onchange = render
  $('#graph').onclick = graphClick
  $('#coach').onclick = onCoachAction
  $('#guide').onclick = onCoachAction
  for (const id of ['#coach', '#guide']) { $(id).addEventListener('mouseover', onRefOver); $(id).addEventListener('mouseout', onRefOut) }
  const bd = $('#board')
  bd.addEventListener('pointerdown', onPointerDown)
  bd.addEventListener('pointermove', onPointerMove)
  bd.addEventListener('pointerup', onPointerUp)
  bd.addEventListener('pointercancel', () => { S.drag = null; $('#ghost')?.remove(); render() })
  $('#summary').onclick = (e) => {
    const tr = e.target.closest('tr.cl'); if (!tr) return
    const c = tr.dataset.cls
    const n = S.game.plies.length
    for (let s = 1; s <= n; s++) { const i = ((S.idx + s - 1) % n) + 1; if (S.cls[i - 1]?.cls === c) return go(i) }
  }
  $('#copyPgn').onclick = async () => {
    try { await navigator.clipboard.writeText(annotatedPgn()); $('#copyPgn').textContent = 'PGN copiado ✓' } catch { $('#pgnOut').hidden = false; $('#pgnOut').value = annotatedPgn() }
    setTimeout(() => ($('#copyPgn').textContent = 'Copiar PGN anotado'), 2000)
  }
  document.addEventListener('keydown', (e) => {
    if (document.body.dataset.view !== 'review' || e.target.matches('textarea,input,select')) return
    if (e.key === 'Escape' && S.mode) { S.mode.type === 'explore' ? go(S.mode.fromIdx) : exitMode(); return }
    if (e.key === 'ArrowLeft') { navStep(-1); e.preventDefault() }
    else if (e.key === 'ArrowRight') { navStep(1); e.preventDefault() }
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') navEnd()
  })
  show('setup')
}
init()
