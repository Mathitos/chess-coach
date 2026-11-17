import { Chess } from 'chess.js'
import { Uci } from './uci.js'
import * as R from './review.js'
import PIECES from './pieces.gen.js'

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
  $('#depth').value = store.get('depth', 'normal')
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
  $('#newGame').onclick = () => { S.runId++; resetStockfish(); show('setup') }
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
  store.set('lastPgn', text); store.set('user', user); store.set('depth', $('#depth').value)
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
  if (!game.plies.length) { $('#err').textContent = 'O PGN não tem lances.'; return }
  const h = game.headers
  let side = (d.kind === 'pgn' && S.pick) || autoSide(h) || 'w'
  S.clock = R.clockData(game, pgn)
  const lvlSel = $('#maiaLevel').value
  const lvl = (elo) => (lvlSel === 'auto' ? Math.max(600, Math.min(2600, Math.round((+elo || 1000) / 100) * 100)) : +lvlSel)
  Object.assign(S, { game, sf: new Array(game.positions.length), threats: new Array(game.plies.length), infos: [], cls: [], maia: [], maiaRaw: {}, idx: 0, side, flip: side === 'b', maiaElo: { w: lvl(h.WhiteElo), b: lvl(h.BlackElo) } })
  const runId = ++S.runId
  S.vars = []; S.anCache = {}; S.sel = null; S.mode = null
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
  S.vars = []; S.anCache = {}; S.sel = null; S.mode = null
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
    return v
  }
  if (M && M.type === 'line') {
    const mv = M.i > 0 ? M.moves[M.i - 1] : null
    const nxt = M.moves[M.i]
    return { fen: M.fens[M.i], last: mv && { from: mv.from, to: mv.to, color: '#74b0e0', op: 0.6 }, arrows: nxt ? [[nxt.from, nxt.to, 'rgba(116,176,224,.75)', 10]] : [] }
  }
  if (M && M.type === 'retry') {
    const v = { fen: M.fen, last: null, arrows: [], sel: M.sel, dots: [], marks: [] }
    if (M.sel) v.dots = new Chess(M.fen).moves({ square: M.sel, verbose: true }).map((m) => m.to)
    if (M.hint) v.marks.push([M.hint, 'rgba(129,182,76,.55)'])
    if (M.wrong) v.last = { from: M.wrong.slice(0, 2), to: M.wrong.slice(2, 4), color: '#fa412d', op: 0.45 }
    if (M.solved) v.last = { from: M.solved.slice(0, 2), to: M.solved.slice(2, 4), color: '#81b64c', op: 0.55 }
    return v
  }
  const last = i > 0 ? g.plies[i - 1] : null
  const r = i > 0 ? S.cls[i - 1] : null
  const v = { fen: g.positions[i], arrows: [], badge: null, sel: S.sel, dots: [] }
  if (S.sel) v.dots = new Chess(g.positions[i]).moves({ square: S.sel, verbose: true }).map((m) => m.to)
  if (last) v.last = { from: last.from, to: last.to, color: r ? R.CLASSES[r.cls].color : '#f5f682', op: r ? 0.45 : 0.5 }
  if (last && r && !['best', 'forced', 'brilliant', 'great'].includes(r.cls) && r.bestUci && $('#showBest').checked) v.arrows.push([r.bestUci.slice(0, 2), r.bestUci.slice(2, 4), '#81b64c', 16])
  if ($('#showNext').checked && S.sf[i]?.lines?.[0]?.pv?.[0]) { const u = S.sf[i].lines[0].pv[0]; v.arrows.push([u.slice(0, 2), u.slice(2, 4), '#4a8fd6', 12]) }
  if (last && r) v.badge = [last.to, R.CLASSES[r.cls]]
  return v
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
  $('#board').classList.toggle('play', !(S.mode && S.mode.type === 'retry' && (S.mode.solved || S.mode.busy)))
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
  html += `<p class="say">${esc(t.text)}</p>`
  const sp = S.clock ? S.clock.spent[k] : null
  if (mine && sp !== null && sp !== undefined && ['mistake', 'blunder', 'miss'].includes(r.cls) && sp <= 3) html += `<p class="tip">⏱ Você jogou esse lance em ${R.fmtSpent(sp)}. Num momento crítico assim, vale gastar uns segundos conferindo o que o adversário ameaça.</p>`
  if (t.tip) html += `<p class="tip">💡 ${esc(t.tip)}</p>`
  const bad = ['inaccuracy', 'mistake', 'blunder', 'miss'].includes(r.cls)
  html += `<div class="acts">`
  if (mine && bad) html += `<button class="btn act retry" data-act="retry">↻ Tentar de novo</button>`
  if (!mine && bad && g.plies[k + 1] && S.cls[k + 1]) html += `<button class="btn act retry" data-act="punishTry">🎯 Achar a punição</button>`
  if (t.bestLine.length && r.cls !== 'forced') html += `<button class="btn act" data-act="best">▶ ${r.cls === 'best' || p.uci === r.bestUci ? 'Ver continuação' : 'Ver melhor lance (' + esc(t.bestSan) + ')'}</button>`
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
  let fen0 = g.positions[k], pv
  const reply = S.sf[k + 1]?.lines?.[0]?.pv || []
  if (kind === 'best') { pv = (S.sf[k]?.lines?.[0]?.pv || []).slice(0, 10); }
  else pv = [g.plies[k].uci, ...reply].slice(0, 9)
  const { moves } = R.playLine(fen0, pv)
  const fens = [fen0]
  const c = new Chess(fen0)
  for (const m of moves) { c.move(m.san); fens.push(c.fen()) }
  const label = kind === 'best' ? `Linha do engine com ${moves[0]?.san || ''}` : S.cls[k]?.cls === 'miss' ? 'O que acontece depois do lance jogado' : (g.plies[k].color === S.side ? 'Como o adversário pune' : 'Como punir')
  stopTimer()
  S.mode = { type: 'line', k, kind, fens, moves, i: 0, label, playing: true }
  render()
  S.mode.timer = setInterval(() => {
    const M = S.mode
    if (!M || M.type !== 'line') return stopTimer()
    if (M.i >= M.moves.length) { M.playing = false; return stopTimer(), render() }
    M.i++; render()
  }, 900)
}
function stopTimer() { if (S.mode?.timer) { clearInterval(S.mode.timer); S.mode.timer = null } }
function exitMode() { stopTimer(); S.mode = null; render() }
function lineStep(d) { const M = S.mode; stopTimer(); M.playing = false; M.i = Math.max(0, Math.min(M.moves.length, M.i + d)); render() }

function startRetry(k) {
  stopTimer()
  S.mode = { type: 'retry', k, fen: S.game.positions[k], sel: null, tries: 0, msg: null, ok: null, hint: null, wrong: null, solved: null, busy: false }
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
  M.msg = `Conferindo ${san}…`; render()
  try {
    const ch = new Chess(M.fen); ch.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' })
    const an = ch.isGameOver() ? { lines: [] } : await getStockfish().u.analyse(ch.fen(), { depth: 14, movetime: 1200 })
    if (S.mode !== M) return
    const fb = R.attemptFeedback(M.fen, uci, an, c, r.wpBefore)
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
  if (M && M.type === 'retry') return M.fen
  if (M && (M.type === 'explore' || M.type === 'line')) return M.fens[M.i]
  return S.game.positions[S.idx]
}
// Position the user can move in (null = not interactive right now).
function interactiveFen() {
  const M = S.mode
  if (M && M.type === 'retry') return M.solved || M.busy ? null : M.fen
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
  if (M && M.type === 'explore') return exploreMove(uci)
  if (M && M.type === 'line') { stopTimer(); return branchFrom(M.k, M.moves.slice(0, M.i), uci) }
  // main line: same move as the game just advances; otherwise branch
  const p = S.game.plies[S.idx]
  if (p && p.uci.slice(0, 4) === uci.slice(0, 4)) return go(S.idx + 1)
  return branchFrom(S.idx, [], uci)
}
function onPointerDown(e) {
  if (!S.game || e.button > 0) return
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
    else if (v.fb[j]) html += `<p class="say badmsg">${esc(v.fb[j])}</p>`
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
  const M = S.mode, g = S.game
  const p = g.plies[M.k]
  const moveLbl = `${Math.floor(M.k / 2) + 1}${p.color === 'w' ? '.' : '...'} ${p.san}`
  if (M.type === 'line') {
    const start = Math.floor(M.k / 2) + 1, wFirst = p.color === 'w'
    let seq = ''
    M.moves.forEach((m, j) => {
      const ply = M.k + j
      const num = ply % 2 === 0 ? `${Math.floor(ply / 2) + 1}. ` : j === 0 ? `${Math.floor(ply / 2) + 1}... ` : ''
      seq += `${num}<span class="lm${j + 1 === M.i ? ' cur' : ''}${M.kind === 'punish' && j === 0 ? ' played' : ''}" data-j="${j + 1}">${esc(m.san)}</span> `
    })
    box.innerHTML = `<div class="coach-head"><div class="avatar">▶</div><div><b>${esc(M.label)}</b><div class="sub">a partir de ${esc(moveLbl)} · lance ${M.i}/${M.moves.length}</div></div></div>
      <p class="seq">${seq}</p>
      <div class="acts"><button class="btn act" data-act="lprev">◀</button><button class="btn act" data-act="lplay">${M.playing ? '⏸' : '⏵'}</button><button class="btn act" data-act="lnext">▶</button><button class="btn act" data-act="exit">✕ Voltar pra partida</button></div>`
    return
  }
  const side = p.color === 'w' ? 'Brancas' : 'Pretas'
  let html = `<div class="coach-head"><div class="avatar">↻</div><div><b>Tentar de novo: ${esc(moveLbl)}</b><div class="sub">Você joga de ${side}. Arrasta a peça (ou clica nela e depois na casa).</div></div></div>`
  if (M.msg) html += `<p class="say ${M.ok ? 'good' : M.ok === false ? 'badmsg' : ''}">${esc(M.msg)}</p>`
  else html += `<p class="say">Na partida você jogou ${esc(p.san)}. Acha um lance melhor?</p>`
  html += `<div class="acts">`
  if (!M.solved) {
    if (!M.hint) html += `<button class="btn act" data-act="hint">💡 Dica</button>`
    html += `<button class="btn act" data-act="reveal">Mostrar resposta</button>`
  } else html += `<button class="btn act" data-act="best">▶ Ver a linha</button><button class="btn act" data-act="nexterr">Próximo erro ▶</button>`
  html += `<button class="btn act" data-act="exit">✕ Voltar pra partida</button></div>`
  box.innerHTML = html
}
function onCoachAction(e) {
  const b = e.target.closest('[data-act]')
  const lm = e.target.closest('.lm')
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
  else if (act === 'lplay') {
    const M = S.mode
    if (M.playing) { stopTimer(); M.playing = false; render() }
    else { if (M.i >= M.moves.length) M.i = 0; M.playing = true; render(); M.timer = setInterval(() => { if (S.mode !== M) return clearInterval(M.timer); if (M.i >= M.moves.length) { clearInterval(M.timer); M.timer = null; M.playing = false; return render() } M.i++; render() }, 900) }
  } else if (act === 'hint') { S.mode.hint = S.cls[k].bestUci.slice(0, 2); S.mode.msg = `Dica: a peça certa está em ${S.mode.hint}.`; S.mode.ok = null; render() }
  else if (act === 'reveal') {
    const M = S.mode, best = S.cls[k].bestUci, c = S.game.plies[k].color
    const bm = R.lineMotif(M.fen, S.sf[k].lines[0], c)
    const ex = R.explainBestMove(M.fen, S.sf[k].lines[0], c, bm, S.threats[k])
    Object.assign(M, { solved: best, ok: null, wrong: null, sel: null, msg: `O lance era ${bm.san}${ex ? ': ' + ex : ''}.` })
    render()
  } else if (act === 'nexterr') { exitMode(); jumpError(1) }
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
  renderBoard(); renderCoach(); renderMoveList(); renderGraph()
  $('#counter').textContent = S.mode?.type === 'explore' ? 'variante' : `${S.idx}/${S.game.plies.length}`
}
function go(i) {
  S.sel = null
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
  $('#first').onclick = () => go(0)
  $('#prev').onclick = () => navStep(-1)
  $('#next').onclick = () => navStep(1)
  $('#last').onclick = () => navEnd()
  $('#prevErr').onclick = () => jumpError(-1)
  $('#nextErr').onclick = () => jumpError(1)
  $('#flip').onclick = () => { S.flip = !S.flip; render() }
  $('#showBest').onchange = render
  $('#showNext').onchange = render
  $('#graph').onclick = graphClick
  $('#coach').onclick = onCoachAction
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
