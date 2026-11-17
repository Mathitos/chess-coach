// "Minhas partidas": busca as partidas recentes de um jogador no chess.com ou
// no Lichess (APIs públicas, sem login), resume cada análise e agrega os tipos
// de erro mais frequentes. Funções puras; o motor roda no main.js.
import { evalInfo, lineMotif, splitGames } from './review.js'

export const SITES = { chesscom: 'chess.com', lichess: 'Lichess' }

// Categorias dos seus erros (imprecisões não entram)
export const CATS = {
  mateAllowed: { label: 'Deixou mate', tip: 'o lance permitiu um mate forçado contra você' },
  mateMissed: { label: 'Mate que passou', tip: 'tinha mate forçado e você não jogou' },
  noPunish: { label: 'Não puniu o erro do adversário', tip: 'o adversário errou e você não aproveitou' },
  material: { label: 'Entregou material', tip: 'o lance perdeu 2+ pontos de material' },
  tactic: { label: 'Tática que passou', tip: 'tinha garfo, cravada ou captura que ganhava material' },
  opening: { label: 'Erro na abertura', tip: 'erro nos 10 primeiros lances' },
  positional: { label: 'Posicional', tip: 'piorou a posição sem perder material direto' },
}
const ERR = ['mistake', 'miss', 'blunder']

function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36) }

export function gameId(headers, pgn) {
  const link = headers.Link || (/^https?:\/\//.test(headers.Site || '') ? headers.Site : '')
  if (link) return link.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')
  return 'h' + hash(String(pgn).replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim())
}

export function sideFor(headers, user) {
  const u = String(user || '').trim().toLowerCase()
  if (u && String(headers.Black || '').toLowerCase() === u) return 'b'
  if (u && String(headers.White || '').toLowerCase() === u) return 'w'
  return null
}

// Partidas mais recentes primeiro: [{ pgn }]
export async function fetchRecent(site, user, n, fetchFn = fetch) {
  const u = String(user || '').trim()
  if (!u) throw new Error('preencha o nome do jogador')
  if (site === 'lichess') {
    const url = `https://lichess.org/api/games/user/${encodeURIComponent(u)}?max=${n}&clocks=true&evals=false&opening=false&perfType=ultraBullet,bullet,blitz,rapid,classical,correspondence`
    const r = await fetchFn(url, { headers: { Accept: 'application/x-chess-pgn' } })
    if (r.status === 404) throw new Error(`não achei o jogador ${u} no Lichess`)
    if (!r.ok) throw new Error(`o Lichess respondeu ${r.status}`)
    const text = await r.text()
    return splitGames(text).slice(0, n).map((pgn) => ({ pgn }))
  }
  const ar = await fetchFn(`https://api.chess.com/pub/player/${encodeURIComponent(u.toLowerCase())}/games/archives`)
  if (ar.status === 404) throw new Error(`não achei o jogador ${u} no chess.com`)
  if (!ar.ok) throw new Error(`o chess.com respondeu ${ar.status}`)
  const months = ((await ar.json()).archives || []).slice().reverse()
  const out = []
  for (const m of months) {
    if (out.length >= n) break
    const r = await fetchFn(m)
    if (!r.ok) continue
    const games = ((await r.json()).games || []).filter((g) => g.pgn && (g.rules || 'chess') === 'chess')
    games.sort((a, b) => (b.end_time || 0) - (a.end_time || 0))
    for (const g of games) { if (out.length >= n) break; out.push({ pgn: g.pgn }) }
  }
  return out
}

// Seus erros na partida analisada, com a categoria de cada um.
// A = { game, sf, cls, side, clock }
export function errorList(A) {
  const g = A.game, out = []
  A.cls.forEach((r, k) => {
    if (!r || g.plies[k].color !== A.side || !ERR.includes(r.cls)) return
    const p = g.plies[k], fen = g.positions[k]
    const after = evalInfo(g.positions[k + 1], A.sf[k + 1])
    const best = A.sf[k]?.lines?.[0]
    const motif = best ? lineMotif(fen, best, p.color) : {}
    const prev = k > 0 ? A.cls[k - 1] : null
    let cat
    if (after && after.mateW !== undefined && (p.color === 'w' ? after.mateW < 0 : after.mateW > 0)) cat = 'mateAllowed'
    else if (motif.mate) cat = 'mateMissed'
    else if (prev && ['mistake', 'blunder'].includes(prev.cls)) cat = 'noPunish'
    else if ((r.matLoss || 0) >= 2) cat = 'material'
    else if (motif.fork || motif.pin || motif.freeCapture || motif.winCapture) cat = 'tactic'
    else if (k < 20) cat = 'opening'
    else cat = 'positional'
    let zeit = false
    if (A.clock?.at?.[k]) { const left = A.clock.at[k][p.color]; zeit = left !== null && left < Math.max(30, A.clock.base * 0.1) }
    out.push({ k, san: p.san, cls: r.cls, cat, zeit })
  })
  return out
}

// Resumo guardado no store (vai pro Drive): pequeno, com o PGN pra reabrir depois.
export function summarize(A, pgn, { site = '', depth = '', accuracy = null, now = Date.now() } = {}) {
  const h = A.game.headers
  const errors = errorList(A)
  const counts = {}
  for (const r of A.cls) if (r && A.game.plies[r.k].color === A.side) counts[r.cls] = (counts[r.cls] || 0) + 1
  return {
    id: gameId(h, pgn), site, pgn, side: A.side, depth, analyzedAt: now,
    white: h.White || '', black: h.Black || '', whiteElo: h.WhiteElo || '', blackElo: h.BlackElo || '',
    date: h.UTCDate || h.Date || '', result: h.Result || '', link: h.Link || (/^https?:/.test(h.Site || '') ? h.Site : ''),
    timeControl: h.TimeControl || '', plies: A.game.plies.length,
    accuracy: accuracy ? Math.round(accuracy[A.side] * 10) / 10 : null,
    counts, errors,
  }
}

export function scoreFor(g) {
  if (g.result === '1/2-1/2') return 0.5
  if (g.result === '1-0') return g.side === 'w' ? 1 : 0
  if (g.result === '0-1') return g.side === 'b' ? 1 : 0
  return null
}

// Agrega as últimas `limit` partidas analisadas (mais recentes primeiro)
export function aggregate(games, limit = 20) {
  const list = Object.values(games || {}).sort((a, b) => sortKey(b) - sortKey(a)).slice(0, limit)
  const cats = {}
  let errs = 0, zeit = 0, accSum = 0, accN = 0, wins = 0, draws = 0, losses = 0
  for (const g of list) {
    for (const e of g.errors || []) { cats[e.cat] = (cats[e.cat] || 0) + 1; errs++; if (e.zeit) zeit++ }
    if (g.accuracy !== null && g.accuracy !== undefined) { accSum += g.accuracy; accN++ }
    const s = scoreFor(g); if (s === 1) wins++; else if (s === 0.5) draws++; else if (s === 0) losses++
  }
  const top = Object.entries(cats).sort((a, b) => b[1] - a[1]).map(([cat, n]) => ({ cat, n, ...CATS[cat] }))
  return { n: list.length, errs, zeit, perGame: list.length ? errs / list.length : 0, accuracy: accN ? accSum / accN : null, wins, draws, losses, top }
}
function sortKey(g) {
  const d = String(g.date || '').replace(/\./g, '-')
  const t = Date.parse(d)
  return Number.isFinite(t) ? t : g.analyzedAt || 0
}

// "10+0" -> "Rápida · 10 min", "1/86400" -> "Diária"
export function tcLabel(tc) {
  if (!tc || tc === '-' || tc === '?') return ''
  if (tc.includes('/')) return 'Diária'
  const [b, i] = tc.split('+').map(Number)
  if (!isFinite(b)) return ''
  const est = b + 40 * (i || 0)
  const kind = est < 180 ? 'Bullet' : est < 600 ? 'Blitz' : est < 3600 ? 'Rápida' : 'Clássica'
  const base = b >= 60 ? `${Math.round(b / 60)} min` : `${b}s`
  return `${kind} · ${base}${i ? ' + ' + i + 's' : ''}`
}
