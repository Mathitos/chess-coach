// Game review core: classification (chess.com-style expected points on top of
// the published lichess win% curve), accuracy (lichess formula) and coach
// comments built from templates + tactical motif detection.
import { Chess } from 'chess.js'

export const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 }
const NAME = { p: 'peão', n: 'cavalo', b: 'bispo', r: 'torre', q: 'dama', k: 'rei' }
const ART = { p: 'o', n: 'o', b: 'o', r: 'a', q: 'a', k: 'o' }
const named = (t, sq) => `${ART[t]} ${NAME[t]}${sq ? ' de ' + sq : ''}`
const namedEm = (t) => `${ART[t] === 'a' ? 'na' : 'no'} ${NAME[t]}`
const pend = (t) => (ART[t] === 'a' ? 'pendurada' : 'pendurado')
function listPieces(types, prep = '') {
  if (!types.length) return ''
  const cnt = {}
  for (const t of types) cnt[t] = (cnt[t] || 0) + 1
  const t = Object.keys(cnt).sort((a, b) => VAL[b] - VAL[a])[0]
  const NUM = ['', '', 'dois', 'três', 'quatro', 'cinco']
  if (cnt[t] > 1) {
    const plural = { p: 'peões', n: 'cavalos', b: 'bispos', r: 'torres', q: 'damas' }[t]
    return `${prep ? prep + ' ' : ''}${NUM[cnt[t]] || cnt[t]} ${plural}`
  }
  if (prep === 'por') return `${ART[t] === 'a' ? 'pela' : 'pelo'} ${NAME[t]}`
  return named(t)
}
// Pieces won/lost for `color` along settled PV moves, equal types cancelled.
function trade(moves, color) {
  const won = [], lost = []
  for (const m of moves) if (m.captured) (m.color === color ? won : lost).push(m.captured)
  for (let i = won.length - 1; i >= 0; i--) {
    const j = lost.indexOf(won[i])
    if (j >= 0) { lost.splice(j, 1); won.splice(i, 1) }
  }
  return { won, lost }
}
function lossText(mat, color) {
  const { won, lost } = trade(mat.moves, color)
  if (!lost.length) return `perde ${describeMat(-mat.delta)}`
  return won.length ? `perde ${listPieces(lost)} e leva só ${listPieces(won)}` : `perde ${listPieces(lost)}`
}
function gainText(mat, color) {
  const { won, lost } = trade(mat.moves, color)
  if (!won.length) return `ganha ${describeMat(mat.delta)}`
  return lost.length && VAL[lost[0]] >= 3 ? `ganha ${listPieces(won)} ${listPieces(lost, 'por')}` : `ganha ${listPieces(won)}`
}
const opp = (c) => (c === 'w' ? 'b' : 'w')

export const CLASSES = {
  brilliant: { label: 'Brilhante', sym: '!!', color: '#26c2a3' },
  great: { label: 'Ótimo', sym: '!', color: '#749bbf' },
  best: { label: 'Melhor', sym: '★', color: '#81b64c' },
  excellent: { label: 'Excelente', sym: '👍', color: '#81b64c' },
  good: { label: 'Bom', sym: '✓', color: '#95b776' },
  book: { label: 'Teoria', sym: '📖', color: '#a88865' },
  forced: { label: 'Forçado', sym: '□', color: '#97a1ab' },
  inaccuracy: { label: 'Imprecisão', sym: '?!', color: '#f7c631' },
  mistake: { label: 'Erro', sym: '?', color: '#ffa459' },
  miss: { label: 'Chance perdida', sym: '✗', color: '#ff7769' },
  blunder: { label: 'Capivarada', sym: '??', color: '#fa412d' },
}
export const CLASS_ORDER = ['brilliant', 'great', 'best', 'excellent', 'good', 'forced', 'inaccuracy', 'mistake', 'miss', 'blunder']

// ── PGN ─────────────────────────────────────────────────────────────────────
export function parseGame(pgn) {
  const c = new Chess()
  c.loadPgn(pgn.trim())
  const headers = c.getHeaders()
  const hist = c.history({ verbose: true })
  const start = new Chess(headers.FEN || undefined)
  const plies = hist.map((m) => ({
    san: m.san, uci: m.from + m.to + (m.promotion || ''), from: m.from, to: m.to,
    piece: m.piece, captured: m.captured, color: m.color, promotion: m.promotion,
    flags: m.flags, before: m.before, after: m.after,
  }))
  const positions = [start.fen(), ...plies.map((p) => p.after)]
  return { headers, plies, positions }
}

// ── Evaluation helpers ──────────────────────────────────────────────────────
export const winPctFromCp = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1)

// Info for position i, white POV. sfLine is from side-to-move POV.
export function evalInfo(fen, analysis) {
  const ch = new Chess(fen)
  const stm = ch.turn()
  if (ch.isCheckmate()) return { wpW: stm === 'w' ? 0 : 100, mateW: stm === 'w' ? -0 : 0, terminal: 'mate', text: '#', cpW: stm === 'w' ? -10000 : 10000 }
  if (ch.isDraw() || ch.isStalemate()) return { wpW: 50, cpW: 0, terminal: 'draw', text: '½' }
  const l = analysis && analysis.lines && analysis.lines[0]
  if (!l) return null
  const s = stm === 'w' ? 1 : -1
  if (l.mate !== undefined) {
    const mW = l.mate * s
    return { wpW: mW > 0 ? 100 : 0, mateW: mW, cpW: mW > 0 ? 10000 - Math.abs(mW) : -10000 + Math.abs(mW), text: (mW > 0 ? '+' : '-') + 'M' + Math.abs(mW) }
  }
  const cpW = l.cp * s
  return { wpW: winPctFromCp(cpW), cpW, text: (cpW >= 0 ? '+' : '') + (cpW / 100).toFixed(2) }
}
const lineWpFor = (line, stm, color) => {
  if (!line) return null
  const s = stm === color ? 1 : -1
  if (line.mate !== undefined) return line.mate * s > 0 ? 100 : 0
  return winPctFromCp(line.cp * s)
}
const wpFor = (info, color) => (color === 'w' ? info.wpW : 100 - info.wpW)

export function playLine(fen, uciList, max = 99) {
  const ch = new Chess(fen)
  const moves = []
  for (const u of uciList.slice(0, max)) {
    try {
      const m = ch.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] })
      if (!m) break
      moves.push(m)
    } catch { break }
  }
  return { ch, moves }
}
const sanLine = (fen, pv, max = 6) => playLine(fen, pv, max).moves.map((m) => m.san)

function materialDiff(ch) {
  let d = 0
  for (const row of ch.board()) for (const p of row) if (p && p.type !== 'k') d += (p.color === 'w' ? 1 : -1) * VAL[p.type]
  return d
}

// Material swing for `color` along a PV, letting captures settle.
export function pvMaterial(fen, pv, color, base = 8) {
  const start = new Chess(fen)
  const d0 = materialDiff(start)
  const { moves } = playLine(fen, pv, 14)
  let n = Math.min(base, moves.length)
  while (n < moves.length && (moves[n - 1]?.captured || moves[n]?.captured)) n++
  const ch = new Chess(fen)
  for (const m of moves.slice(0, n)) ch.move(m.san)
  const delta = (materialDiff(ch) - d0) * (color === 'w' ? 1 : -1)
  const caps = moves.slice(0, n).filter((m) => m.captured)
  return { delta, caps, moves: moves.slice(0, n) }
}

function hangingValue(ch, sq) {
  const p = ch.get(sq)
  if (!p || p.type === 'k') return 0
  const att = ch.attackers(sq, opp(p.color))
  if (!att.length) return 0
  const def = ch.attackers(sq, p.color)
  const minAtt = Math.min(...att.map((s) => VAL[ch.get(s).type]))
  if (!def.length) return VAL[p.type]
  return Math.max(0, VAL[p.type] - minAtt)
}

// Pieces of `color` hanging on board ch: [{sq,type,amount}]
function hangingPieces(ch, color) {
  const out = []
  for (const row of ch.board()) for (const p of row) {
    if (p && p.color === color && p.type !== 'k' && p.type !== 'p') {
      const a = hangingValue(ch, p.square)
      if (a >= 2) out.push({ sq: p.square, type: p.type, amount: a })
    }
  }
  return out.sort((a, b) => b.amount - a.amount)
}

// After move m was played (ch is the position after it), does the moved piece fork?
function detectFork(ch, m) {
  const me = m.color, pieceVal = VAL[m.promotion || m.piece]
  const targets = []
  for (const row of ch.board()) for (const p of row) {
    if (!p || p.color === me) continue
    if (!ch.attackers(p.square, me).includes(m.to)) continue
    if (p.type === 'k' || VAL[p.type] > pieceVal || (hangingValue(ch, p.square) > 0 && VAL[p.type] >= 3))
      if (p.type !== 'p') targets.push(p)
  }
  return targets.length >= 2 ? targets.sort((a, b) => VAL[b.type] - VAL[a.type]) : null
}

const DIRS = { b: [[1, 1], [1, -1], [-1, 1], [-1, -1]], r: [[1, 0], [-1, 0], [0, 1], [0, -1]] }
DIRS.q = [...DIRS.b, ...DIRS.r]
const sqOf = (f, r) => 'abcdefgh'[f] + (r + 1)
function detectPin(ch, m) {
  const t = m.promotion || m.piece
  if (!DIRS[t]) return null
  const f0 = m.to.charCodeAt(0) - 97, r0 = +m.to[1] - 1
  for (const [df, dr] of DIRS[t]) {
    let f = f0 + df, r = r0 + dr, first = null
    while (f >= 0 && f < 8 && r >= 0 && r < 8) {
      const p = ch.get(sqOf(f, r))
      if (p) {
        if (p.color === m.color) break
        if (!first) first = p
        else {
          if ((p.type === 'k' || VAL[p.type] > VAL[first.type]) && first.type !== 'p') return { pinned: first, behind: p }
          break
        }
      }
      f += df; r += dr
    }
  }
  return null
}

function describeMat(n) {
  if (n >= 8) return 'a dama'
  if (n >= 5) return 'uma torre'
  if (n >= 3) return 'uma peça'
  if (n >= 2) return 'dois peões'
  return 'um peão'
}

// What a line does for the side that starts it.
function lineMotif(fen, line, stm) {
  if (!line || !line.pv || !line.pv.length) return {}
  const { ch, moves } = playLine(fen, line.pv, 1)
  const m = moves[0]
  if (!m) return {}
  const res = { san: m.san, move: m }
  if (line.mate !== undefined && line.mate > 0) {
    res.mate = line.mate
    res.mateLine = sanLine(fen, line.pv, Math.min(line.mate * 2 - 1, 7))
    return res
  }
  const fork = detectFork(ch, m)
  if (fork) res.fork = fork
  const pin = detectPin(ch, m)
  if (pin) res.pin = pin
  const mat = pvMaterial(fen, line.pv, stm)
  res.mat = mat
  if (m.captured) {
    const before = new Chess(fen)
    res.freeCapture = hangingValue(before, m.to) >= VAL[m.captured] - 0.5 ? m.captured : null
    if (!res.freeCapture && VAL[m.captured] > VAL[m.piece]) res.winCapture = { got: m.captured, by: m.piece }
  }
  res.check = m.san.includes('+')
  return res
}

// ── Classification ──────────────────────────────────────────────────────────
export function classify(game, sf, opts = {}) {
  const { plies, positions } = game
  const infos = positions.map((f, i) => evalInfo(f, sf[i]))
  const out = []
  for (let k = 0; k < plies.length; k++) {
    const p = plies[k]
    const before = infos[k], after = infos[k + 1]
    if (!before || !after) { out.push(null); continue }
    const c = p.color
    const fen = positions[k]
    const chB = new Chess(fen)
    const legal = chB.moves().length
    const lines = sf[k].lines || []
    const bestLine = lines[0]
    const bestUci = bestLine && bestLine.pv[0]
    const wpBefore = wpFor(before, c)
    const wpAfter = wpFor(after, c)
    let loss = p.uci === bestUci ? 0 : Math.max(0, wpBefore - wpAfter) / 100
    let cls
    if (legal === 1) cls = 'forced'
    else if (p.uci === bestUci || loss < 0.001) cls = 'best'
    else if (loss < 0.02) cls = 'excellent'
    else if (loss < 0.05) cls = 'good'
    else if (loss < 0.10) cls = 'inaccuracy'
    else if (loss < 0.20) cls = 'mistake'
    else cls = 'blunder'

    // Material floor: for coaching, giving away a lot of material is never just an inaccuracy
    // (the win% curve flattens when a side is already behind).
    let matLoss = 0
    if (bestLine && sf[k + 1] && cls !== 'forced' && p.uci !== bestUci) {
      const replyPv = (sf[k + 1].lines && sf[k + 1].lines[0] && sf[k + 1].lines[0].pv) || []
      matLoss = pvMaterial(fen, bestLine.pv, c).delta - pvMaterial(fen, [p.uci, ...replyPv], c).delta
      if (wpAfter < 90) {
        if (matLoss >= 7 && ['good', 'excellent', 'inaccuracy', 'mistake'].includes(cls)) cls = 'blunder'
        else if (matLoss >= 4 && ['good', 'excellent', 'inaccuracy'].includes(cls)) cls = 'mistake'
      }
    }
    const prev = out[k - 1]
    // Miss: opponent just erred and we gave the chance back without collapsing.
    if ((cls === 'mistake' || cls === 'blunder') && prev && prev.loss >= 0.10 && wpAfter >= 35) cls = 'miss'

    // Great: only good move (2nd best much worse), not an obvious recapture.
    const second = lines[1]
    const wpSecond = second ? lineWpFor(second, c, c) : null
    const recapture = (k > 0 && plies[k - 1].captured && p.to === plies[k - 1].to) ||
      (p.captured && (VAL[p.captured] > VAL[p.piece] || hangingValue(chB, p.to) >= VAL[p.captured]))
    if ((cls === 'best' || cls === 'excellent') && legal > 1 && wpSecond !== null && !recapture) {
      const gap = lineWpFor(bestLine, c, c) - wpSecond
      if (gap >= 15 && wpBefore > 8 && wpBefore < 92) cls = 'great'
    }
    // Brilliant: good piece sacrifice.
    let sac = null
    if (['best', 'excellent', 'great'].includes(cls) && !p.promotion) {
      const chA = new Chess(p.after)
      const hang = hangingPieces(chA, c)
      const capVal = p.captured ? VAL[p.captured] : 0
      const top = hang[0]
      if (top && top.amount - capVal >= 2) {
        const wasHanging = top.sq !== p.to && hangingValue(chB, top.sq) >= 2
        if (!wasHanging && wpAfter >= 50 && wpBefore < 97 && !chA.isCheckmate()) { cls = 'brilliant'; sac = top }
      }
    }
    out.push({ k, cls, loss, matLoss, wpBefore, wpAfter, bestUci, before, after, sac, accuracy: moveAccuracy(wpBefore, wpAfter) })
  }
  return out
}

export const moveAccuracy = (wb, wa) => Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * Math.max(0, wb - wa)) - 3.1669 + 1))

// Lichess-style game accuracy per color.
export function gameAccuracy(game, infos, cls) {
  const wps = infos.map((i) => (i ? i.wpW : null))
  const n = wps.length
  const win = Math.max(2, Math.min(8, Math.floor(n / 10)))
  const res = {}
  for (const color of ['w', 'b']) {
    const acc = [], w = []
    cls.forEach((r, k) => {
      if (!r || game.plies[k].color !== color) return
      const lo = Math.max(0, Math.min(k, n - win)), seg = wps.slice(lo, lo + win).filter((x) => x !== null)
      const mean = seg.reduce((a, b) => a + b, 0) / seg.length
      const sd = Math.sqrt(seg.reduce((a, b) => a + (b - mean) ** 2, 0) / seg.length)
      acc.push(r.accuracy); w.push(Math.max(0.5, Math.min(12, sd)))
    })
    if (!acc.length) { res[color] = null; continue }
    const wmean = acc.reduce((a, x, i) => a + x * w[i], 0) / w.reduce((a, b) => a + b, 0)
    const hmean = acc.length / acc.reduce((a, x) => a + 1 / Math.max(x, 1), 0)
    res[color] = (wmean + hmean) / 2
  }
  return res
}

// ── Coach text ──────────────────────────────────────────────────────────────
const pick = (arr, k) => arr[k % arr.length]
const fmtWp = (wp) => `${Math.round(wp)}%`

function openingTip(game, k) {
  const p = game.plies[k]
  const moveNo = Math.floor(k / 2) + 1
  if (moveNo > 12) return null
  const chB = new Chess(game.positions[k])
  const rights = chB.getCastlingRights(p.color)
  const kingHome = chB.get(p.color === 'w' ? 'e1' : 'e8')?.type === 'k'
  if (p.piece === 'k' && !p.flags.includes('k') && !p.flags.includes('q') && (rights.k || rights.q))
    return 'Mexer o rei na abertura joga fora o roque. Prioridade é rocar e deixar o rei protegido.'
  if (p.piece === 'p' && p.from[0] === 'f' && kingHome && moveNo <= 10)
    return `Empurrar o peão f com o rei ainda no centro abre a diagonal ${p.color === 'w' ? 'e1-h4 e enfraquece f2' : 'e8-h5 e enfraquece f7'}, que é exatamente onde os ataques rápidos entram.`
  if (p.piece === 'q' && moveNo <= 7 && !p.captured)
    return 'Dama muito cedo vira alvo: o adversário desenvolve as peças atacando ela e ganha tempo.'
  if (p.piece === 'p' && 'ah'.includes(p.from[0]) && moveNo <= 10)
    return 'Lance de peão de borda na abertura raramente ajuda. Desenvolve cavalos e bispos e roca primeiro.'
  for (let j = k - 2; j >= 0; j -= 2) {
    if (game.plies[j].to === p.from && p.piece !== 'p' && moveNo <= 10 && !p.captured && kingHome)
      return 'Mexer a mesma peça duas vezes na abertura atrasa o desenvolvimento das outras.'
  }
  return null
}

const HEAD = {
  brilliant: ['Brilhante!! Sacrifício que o engine aprova.', 'Que lance! Sacrifício correto.'],
  great: ['Ótimo lance! Era o único bom aqui.', 'Achou o lance crítico!'],
  best: ['Melhor lance.', 'Isso aí, lance do engine.', 'Perfeito, era o melhor.'],
  excellent: ['Excelente, praticamente o melhor.', 'Muito bom.'],
  good: ['Lance ok, mas tinha melhor.', 'Jogável, mas dava pra mais.'],
  forced: ['Lance forçado, era o único legal.'],
  inaccuracy: ['Imprecisão.', 'Não foi o mais preciso.'],
  mistake: ['Erro.', 'Esse custou caro.'],
  miss: ['Chance perdida!', 'Deixou escapar!'],
  blunder: ['Capivarada.', 'Erro grave.', 'Ai... blunder.'],
}

export function coachText(game, sf, threats, cls, k, maia, opts = {}) {
  const r = cls[k]
  if (!r) return null
  const p = game.plies[k]
  const c = p.color
  const fenB = game.positions[k], fenA = game.positions[k + 1]
  const parts = [pick(HEAD[r.cls], k)]
  const bestLine = sf[k].lines[0]
  const best = lineMotif(fenB, bestLine, c)
  const reply = sf[k + 1] && sf[k + 1].lines && sf[k + 1].lines[0]
  const replyM = lineMotif(fenA, reply, opp(c))
  const prev = cls[k - 1]
  const threat = threats && threats[k]
  const tip = []

  const playedLine = { pv: [p.uci, ...(reply ? reply.pv : [])] }
  const playedMat = pvMaterial(fenB, playedLine.pv, c)
  const chA = new Chess(fenA)

  if (['brilliant', 'great', 'best', 'excellent', 'good', 'forced'].includes(r.cls)) {
    if (r.cls === 'brilliant' && r.sac) parts.push(`Você deixa ${named(r.sac.type, r.sac.sq)} pra ser tomado, mas a posição compensa: o engine segue te dando ${fmtWp(r.wpAfter)} de chance.`)
    if (chA.isCheckmate()) parts.push('Xeque-mate!')
    else if (p.san.includes('+') && bestLine?.mate > 0 && p.uci === r.bestUci) parts.push(`Segue o mate: mate em ${bestLine.mate}.`)
    if (r.cls === 'great') {
      const second = sf[k].lines[1]
      if (second) {
        const s2 = sanLine(fenB, second.pv, 1)[0]
        parts.push(`A segunda melhor opção (${s2}) já deixava sua chance em ${fmtWp(lineWpFor(second, c, c))}, contra ${fmtWp(r.wpAfter)} com o lance jogado.`)
      }
    }
    if (prev && prev.loss >= 0.10 && r.loss < 0.02 && game.plies[k - 1]) parts.push(`Puniu o erro do adversário (${game.plies[k - 1].san}).`)
    const myM = p.uci === r.bestUci ? best : lineMotif(fenB, { pv: playedLine.pv }, c)
    if (!chA.isCheckmate()) {
      if (myM.fork) parts.push(`Garfo: ataca ${myM.fork.map((t) => named(t.type, t.square)).join(' e ')} ao mesmo tempo.`)
      else if (myM.pin) parts.push(`Crava ${named(myM.pin.pinned.type, myM.pin.pinned.square)} contra ${named(myM.pin.behind.type)}.`)
      else if (p.captured && playedMat.delta >= 2) parts.push(`${cap(gainText(playedMat, c))}.`)
    }
    if (threat && threat.real && r.loss < 0.05 && !(reply && reply.pv[0] === threat.uci) && !(p.captured && VAL[p.captured] >= 3)) parts.push(`E neutraliza a ameaça ${threat.san}${threat.why ? ' (' + threat.why + ')' : ''}.`)
    if (r.cls === 'good' && best.san) { const ex = explainBest(fenB, bestLine, c, best, threat); parts.push(`O engine preferia ${best.san}${ex ? ': ' + ex : ''}.`) }
    if (parts.length === 1 && r.cls !== 'forced') { const own = describeIdea(fenB, [p.uci], c, threat); if (own.length) parts.push(cap(joinPt(own)) + '.') }
    if (p.flags.includes('k') || p.flags.includes('q')) parts.push('Rocou: rei seguro e torre entrando no jogo.')
  } else {
    // Why it's bad
    let why = null
    if (replyM.mate) why = `Isso permite mate em ${replyM.mate}: ${replyM.mateLine.join(' ')}.`
    else if (threat && threat.real && reply && reply.pv[0] === threat.uci) why = `Você ignorou a ameaça do adversário: ${threat.san}${threat.why ? ' (' + threat.why + ')' : ''}.`
    if (!why && reply) {
      const loss = -playedMat.delta
      const hang = hangingPieces(chA, c)
      const moved = hang.find((h) => h.sq === p.to)
      const lt = lossText(playedMat, c)
      if (replyM.fork && loss >= 2) why = `Permite o garfo ${replyM.san}, atacando ${replyM.fork.map((t) => named(t.type, t.square)).join(' e ')}.`
      else if (moved && loss >= 2) why = `${cap(named(moved.type))} em ${moved.sq} fica ${pend(moved.type)}: depois de ${replyM.san} você ${lt}.`
      else if (hang.length && loss >= 2) why = `Deixou ${named(hang[0].type, hang[0].sq)} sem defesa: depois de ${replyM.san} você ${lt}.`
      else if (replyM.pin && loss >= 2) why = `${replyM.san} crava ${named(replyM.pin.pinned.type, replyM.pin.pinned.square)} e você ${lt}.`
      else if (loss >= 2) why = `Depois de ${replyM.san} você ${lt} (${sanLine(fenA, reply.pv, 4).join(' ')}).`

    }
    if (r.cls === 'miss' && prev && game.plies[k - 1]) {
      const ex = explainBest(fenB, bestLine, c, best, threat)
      parts.push(`O adversário tinha acabado de errar com ${game.plies[k - 1].san} e dava pra punir com ${best.san}${ex ? ': ' + ex : ''}.`)
      if (replyM.mate) parts.push(why)
      parts.push(`Com o lance jogado sua chance voltou pra ${fmtWp(r.wpAfter)}.`)
    } else {
      if (why) parts.push(why)
      else {
        const pf = positionalFault(game, k, fenB, fenA, reply, c)
        if (pf.length) parts.push(...pf)
        else if (reply && r.wpBefore - r.wpAfter >= 15) parts.push(`A resposta forte é ${replyM.san} (${sanLine(fenA, reply.pv, 5).join(' ')}) e sua chance cai de ${fmtWp(r.wpBefore)} pra ${fmtWp(r.wpAfter)}.`)
        else parts.push(`Sua chance de vitória caiu de ${fmtWp(r.wpBefore)} pra ${fmtWp(r.wpAfter)}.`)
      }
      if (best.san) { const ex = explainBest(fenB, bestLine, c, best, threat); parts.push(`Melhor era ${best.san}${ex ? ': ' + ex : ''}.`) }
    }
    const ot = openingTip(game, k)
    if (ot) tip.push(ot)
  }

  // Maia (human) insight
  let human = null
  if (maia && maia[k]) {
    const pol = maia[k].policy || {}
    const pPlayed = maia[k].pPlayed ?? pol[p.uci] ?? 0
    const pBest = r.bestUci ? pol[r.bestUci] ?? 0 : 0
    const top = Object.entries(pol).sort((a, b) => b[1] - a[1])[0]
    const lvl = maia[k].elo
    const pct = (x) => `${Math.round(x * 100)}%`
    const bad = ['inaccuracy', 'mistake', 'blunder', 'miss'].includes(r.cls)
    if (bad && top && top[0] === p.uci) human = `Esse é o lance mais "natural" pro nível ~${lvl}: o Maia acha que ${pct(pPlayed)} jogariam igual. Erro típico, vale treinar o padrão.`
    else if (bad && pPlayed >= 0.12) human = `Erro comum: o Maia estima que ${pct(pPlayed)} dos jogadores ~${lvl} jogariam isso.`
    else if (bad && pBest < 0.08 && r.bestUci) {
      const hi = maia[k].bestByLevel
      human = `O melhor lance era difícil de achar: só ${pct(pBest)} no nível ~${lvl}` + (hi ? `, contra ${pct(hi[hi.length - 1][1])} em ${hi[hi.length - 1][0]}.` : '.')
    } else if (bad && pPlayed < 0.05 && pBest >= 0.3) human = `Não é um erro típico desse nível: ${pct(pBest)} dos jogadores ~${lvl} achariam ${best.san}. Cheiro de pressa ou relógio, vale olhar a posição com calma antes de jogar.`
    else if (['best', 'excellent', 'great', 'brilliant'].includes(r.cls) && pPlayed < 0.08) human = `Lance pouco óbvio: só ${pct(pPlayed)} dos jogadores ~${lvl} achariam.`
    else if (!bad && r.cls !== 'forced' && pPlayed >= 0.5) human = `Lance natural: ${pct(pPlayed)} dos jogadores ~${lvl} jogariam igual.`
  }
  // board visuals for the "Mostrar…" buttons
  const visuals = []
  const lineArrows = (f, pv, n, col) => playLine(f, pv, n).moves.map((m, i) => [m.from, m.to, i % 2 ? 'rgba(250,65,45,.55)' : col])
  if (reply && reply.pv.length) {
    if (replyM.mate) visuals.push({ label: 'Mostrar o mate', arrows: lineArrows(fenA, reply.pv, Math.min(replyM.mate * 2 - 1, 5), '#fa412d'), marks: [] })
    else if (replyM.fork) visuals.push({ label: 'Mostrar o garfo', arrows: [[replyM.move.from, replyM.move.to, '#fa412d'], ...replyM.fork.map((x) => [replyM.move.to, x.square, '#fa412d'])], marks: replyM.fork.map((x) => [x.square, '#fa412d']) })
    const hang = hangingPieces(chA, c)
    if (hang.length && !['best', 'excellent', 'great', 'brilliant'].includes(r.cls)) {
      const att = chA.attackers(hang[0].sq, opp(c))
      visuals.push({ label: 'Mostrar peça pendurada', arrows: att.slice(0, 2).map((a) => [a, hang[0].sq, '#fa412d']), marks: [[hang[0].sq, '#fa412d']] })
    }
  }
  if (threat && threat.real) visuals.push({ label: 'Mostrar a ameaça', arrows: [[threat.uci.slice(0, 2), threat.uci.slice(2, 4), '#fa412d']], marks: [[threat.uci.slice(2, 4), '#fa412d']] })
  if (bestLine && bestLine.pv.length && p.uci !== r.bestUci) {
    const vis = { arrows: [], marks: [] }
    describeIdea(fenB, bestLine.pv, c, threat, vis)
    visuals.push({ label: `Mostrar a ideia de ${best.san}`, fen: fenB, note: 'posição antes do seu lance', ...vis })
  }
  const out = { text: parts.join(' '), tip: tip[0] || null, human, visuals, bestSan: best.san, bestLine: bestLine ? sanLine(fenB, bestLine.pv, 6) : [], replySan: reply ? sanLine(fenA, reply.pv, 6) : [] }
  if (opts.third) return opponentView(game, sf, threats, cls, k, out, parts)
  return out
}

// Opponent's move, told from the user's point of view: their mistake is your chance.
const OPP_HEAD = {
  brilliant: 'Lance brilhante do adversário.', great: 'Ótimo lance do adversário.', best: 'Bom lance do adversário.',
  excellent: 'Bom lance do adversário.', good: 'Lance ok do adversário.', forced: 'Lance forçado do adversário.',
  inaccuracy: 'O adversário foi impreciso.', mistake: 'O adversário errou!', miss: 'O adversário deixou passar uma chance!', blunder: 'O adversário cometeu uma capivarada!',
}
function opponentView(game, sf, threats, cls, k, out, parts) {
  const r = cls[k], p = game.plies[k]
  const me = opp(p.color)
  const fenA = game.positions[k + 1]
  const bad = ['inaccuracy', 'mistake', 'blunder', 'miss'].includes(r.cls)
  if (new Chess(fenA).isCheckmate()) return { ...out, text: 'Xeque-mate do adversário.', tip: null, human: null, punishSan: [] }
  const say = [OPP_HEAD[r.cls]]
  const mine = game.plies[k + 1]
  const myR = cls[k + 1]
  const myLine = sf[k + 1] && sf[k + 1].lines && sf[k + 1].lines[0]
  if (bad) {
    // why it was bad (reuse the analysis, minus the opening headline and "Melhor era…")
    const why = parts.slice(1).filter((x) => !/^Melhor era/.test(x) && !/^O adversário tinha acabado/.test(x) && !/^Com o lance jogado/.test(x))
    if (why.length) say.push(thirdPerson(why.join(' ')))
    if (myLine && myLine.pv.length) {
      const m = lineMotif(fenA, myLine, me)
      const ex = explainBest(fenA, myLine, me, m, threats && threats[k + 1])
      say.push(`Sua chance de punir: ${m.san}${ex ? ' (' + ex + ')' : ''}.`)
      if (mine && myR) {
        if (mine.uci === myR.bestUci) say.push('E você achou! ✓')
        else say.push(`Na partida você jogou ${mine.san}${['mistake', 'blunder', 'miss'].includes(myR.cls) ? ' e deixou passar' : ''}.`)
      }
    }
  } else {
    const t = threats && threats[k + 1]
    if (t && t.real) say.push(`Agora ele ameaça ${t.san}${t.why ? ' (' + t.why + ')' : ''}: fica de olho.`)
    const own = describeIdea(game.positions[k], [p.uci], p.color, threats && threats[k])
    if (own.length && say.length === 1) say.push(cap(joinPt(own)) + '.')
  }
  const myBest = myLine && myLine.pv.length ? sanLine(fenA, myLine.pv, 6) : []
  const visuals = []
  if (bad && myLine && myLine.pv.length) {
    const vis = { arrows: [], marks: [] }
    describeIdea(fenA, myLine.pv, me, threats && threats[k + 1], vis)
    visuals.push({ label: 'Mostrar a punição', ...vis })
  }
  const t2 = threats && threats[k + 1]
  if (!bad && t2 && t2.real) visuals.push({ label: 'Mostrar a ameaça', arrows: [[t2.uci.slice(0, 2), t2.uci.slice(2, 4), '#fa412d']], marks: [[t2.uci.slice(2, 4), '#fa412d']] })
  return { ...out, text: say.join(' '), tip: null, human: null, visuals, punishSan: bad ? myBest : [] }
}
const cap = (s) => s[0].toUpperCase() + s.slice(1)
function thirdPerson(t) {
  return t.replace(/ameaça do adversário/g, 'sua ameaça').replace(/do seu rei/g, 'do rei dele').replace(/Seu rei/g, 'O rei dele').replace(/seu rei/g, 'o rei dele').replace(/onde seus peões/g, 'onde os peões dele').replace(/seus peões/g, 'os peões dele').replace(/Você/g, 'Ele').replace(/você/g, 'ele').replace(/Sua chance/g, 'A chance dele').replace(/sua chance/g, 'a chance dele')
    .replace(/Deixou escapar!/g, 'Ele deixou escapar!').replace(/Puniu o erro do adversário/g, 'Puniu o seu erro')
    .replace(/O adversário tinha acabado de errar/g, 'Você tinha acabado de errar').replace(/Isso aí, lance do engine\./g, 'Lance do engine.')
    .replace(/^Perfeito, era o melhor\./, 'Era o melhor.').replace(/ te dando /g, ' dando a ele ')
}

function bestWhy(m, c) {
  if (!m.san) return ''
  if (m.mate) return `dá mate em ${m.mate}`
  if (m.fork) return `faz um garfo ${m.fork.map((t) => namedEm(t.type)).join(' e ')}`
  if (m.freeCapture) return `pega ${named(m.freeCapture)} de graça`
  if (m.winCapture) return `pega ${named(m.winCapture.got)} ${listPieces([m.winCapture.by], 'por')}`
  if (m.pin && m.mat && m.mat.delta >= 2) return `crava ${named(m.pin.pinned.type, m.pin.pinned.square)}`
  if (m.mat && m.mat.delta >= 2) return gainText(m.mat, c)
  if (m.mat && m.mat.delta >= 1) return 'ganha um peão'
  return ''
}

const joinPt = (a) => (a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' e ' + a[a.length - 1])
const backRank = (c) => (c === 'w' ? '1' : '8')

// Plain-language ideas behind a move (first move of pv), for `color`.
export function describeIdea(fen, pv, color, threat, vis) {
  const V = vis || { arrows: [], marks: [] }
  if (!pv || !pv.length) return []
  const chB = new Chess(fen)
  const { moves } = playLine(fen, pv, 3)
  const m = moves[0]
  if (!m) return []
  const ch = new Chess(fen)
  ch.move(m.san)
  const ideas = []
  const t = m.promotion || m.piece
  V.arrows.push([m.from, m.to, '#81b64c'])
  if (ch.isCheckmate()) { const ks = ch.findPiece({ type: 'k', color: ch.turn() })[0]; if (ks) V.marks.push([ks, '#fa412d']); return ['é xeque-mate'] }
  if (m.flags.includes('k') || m.flags.includes('q')) ideas.push('roca e tira o rei do centro')
  if (m.captured) {
    V.marks.push([m.to, '#f7c631'])
    if (hangingValue(chB, m.to) >= VAL[m.captured] - 0.5) ideas.push(`pega ${named(m.captured)} de graça`)
    else if (VAL[m.captured] > VAL[m.piece]) ideas.push(`pega ${named(m.captured)} ${listPieces([m.piece], 'por')}`)
  }
  const fork = detectFork(ch, m)
  if (fork) { ideas.push(`faz um garfo ${fork.map((x) => namedEm(x.type)).join(' e ')}`); for (const x of fork) { V.arrows.push([m.to, x.square, '#fa412d']); V.marks.push([x.square, '#fa412d']) } }
  else {
    const pin = detectPin(ch, m)
    if (pin) { ideas.push(`crava ${named(pin.pinned.type, pin.pinned.square)} contra ${named(pin.behind.type)}`); V.arrows.push([m.to, pin.behind.square, '#f7c631']); V.marks.push([pin.pinned.square, '#f7c631']) }
    // direct attacks on valuable or loose pieces
    const hits = []
    for (const row of ch.board()) for (const p of row) {
      if (!p || p.color === color || p.type === 'p' || p.type === 'k') continue
      if (!ch.attackers(p.square, color).includes(m.to)) continue
      if (VAL[p.type] > VAL[t] || hangingValue(ch, p.square) >= 2) hits.push(p)
    }
    if (hits.length) { ideas.push(`ataca ${named(hits[0].type, hits[0].square)}`); V.arrows.push([m.to, hits[0].square, '#fa412d']); V.marks.push([hits[0].square, '#fa412d']) }
  }
  if (m.san.includes('+') && !ideas.length) ideas.push('dá xeque e ganha tempo')
  // escapes / defends
  if (t !== 'p' && hangingValue(chB, m.from) >= 2 && hangingValue(ch, m.to) === 0) ideas.push(`tira ${named(t)} do ataque`)
  for (const h of hangingPieces(chB, color)) {
    if (h.sq === m.from) continue
    if (hangingValue(ch, h.sq) === 0 && ch.get(h.sq)?.color === color) { ideas.push(`defende ${named(h.type, h.sq)}`); V.marks.push([h.sq, '#4a8fd6']); break }
  }
  if (threat && threat.real && !ideas.length) ideas.push(`segura a ameaça ${threat.san}`)
  if ((t === 'n' || t === 'b') && m.from[1] === backRank(color) && !ideas.length) ideas.push(`desenvolve ${named(t)}`)
  if (t === 'p' && ['d4', 'e4', 'd5', 'e5'].includes(m.to) && !ideas.length) ideas.push('briga pelo centro')
  // follow-up threat in the engine line
  const next = moves[2]
  if (next && ideas.length < 3 && (next.san.includes('#') || (next.captured && VAL[next.captured] >= 3))) {
    ideas.push(`prepara ${next.san}${next.san.includes('#') ? ' (mate)' : ''}`)
    V.arrows.push([next.from, next.to, 'rgba(129,182,76,.6)'])
  }
  return ideas.slice(0, 3)
}

// Positional reasons a played move was bad (no material/tactic found).
function positionalFault(game, k, fenB, fenA, reply, color) {
  const p = game.plies[k]
  const chB = new Chess(fenB), chA = new Chess(fenA)
  const moveNo = Math.floor(k / 2) + 1
  const out = []
  // reply that attacks something with tempo
  if (reply && reply.pv.length) {
    const { ch: chR, moves } = playLine(fenA, reply.pv, 1)
    const rm = moves[0]
    if (rm) {
      const hits = []
      for (const row of chR.board()) for (const q of row) {
        if (!q || q.color !== color || q.type === 'p') continue
        if (!chR.attackers(q.square, rm.color).includes(rm.to)) continue
        if (q.type === 'k' || VAL[q.type] > VAL[rm.promotion || rm.piece] || hangingValue(chR, q.square) >= 2) hits.push(q)
      }
      if (hits.length) {
        const h = hits.sort((a, b) => VAL[b.type] - VAL[a.type])[0]
        out.push(h.type === 'k' ? `Permite ${rm.san}, xeque que ganha tempo pro adversário.` : `Permite ${rm.san}, que ataca ${named(h.type, h.square)} e ganha tempo.`)
      }
    }
  }
  // king safety
  const kSq = chA.findPiece({ type: 'k', color })[0]
  if (kSq && (p.flags.includes('k') || p.flags.includes('q'))) {
    const files = p.flags.includes('k') ? ['f', 'g', 'h'] : ['a', 'b', 'c']
    const home = color === 'w' ? '2' : '7'
    const moved = files.filter((f) => { const q = chA.get(f + home); return !(q && q.type === 'p' && q.color === color) })
    if (moved.length >= 2) out.push(`Rocou pro lado onde seus peões já saíram (${moved.join(', ')}): o rei fica sem proteção.`)
  }
  if (kSq && p.piece === 'p') {
    const kf = kSq.charCodeAt(0), pf = p.from.charCodeAt(0)
    const homeRank = color === 'w' ? '2' : '7'
    if (Math.abs(kf - pf) <= 1 && p.from[1] === homeRank && (kSq[1] === backRank(color)))
      out.push(`Empurrar o peão ${p.from[0]} na frente do seu rei abre buracos perto dele.`)
  }
  // development
  if (moveNo <= 14) {
    let undeveloped = 0
    for (const sq of color === 'w' ? ['b1', 'g1', 'c1', 'f1'] : ['b8', 'g8', 'c8', 'f8']) {
      const q = chA.get(sq)
      if (q && q.color === color && (q.type === 'n' || q.type === 'b')) undeveloped++
    }
    const rights = chA.getCastlingRights(color)
    const kingHome = kSq === (color === 'w' ? 'e1' : 'e8')
    if (undeveloped >= 2 && (p.piece === 'p' || p.piece === 'q') && !p.captured) out.push(`Ainda tem ${undeveloped} peças menores em casa e esse lance não desenvolve nada.`)
    else if (kingHome && (rights.k || rights.q) && moveNo >= 8 && !p.flags.includes('k') && !p.flags.includes('q')) out.push('Seu rei continua no centro, e cada lance sem rocar deixa ele mais exposto.')
  }
  return out.slice(0, 2)
}

function explainBest(fenB, bestLine, c, best, threat) {
  const tac = bestWhy(best, c)
  const ideas = describeIdea(fenB, bestLine ? bestLine.pv : [], c, threat)
  if (tac) for (let i = ideas.length - 1; i >= 0; i--) {
    const mm = /^ataca (o|a) (\S+)/.exec(ideas[i])
    if (mm && tac.includes(mm[2])) ideas.splice(i, 1)
  }
  if (tac && !ideas.some((x) => x.startsWith('pega') || x.startsWith('faz um garfo') || x.startsWith('é xeque') || x.startsWith('crava'))) ideas.unshift(tac)
  return ideas.length ? joinPt(ideas.slice(0, 3)) : ''
}

// Threat detection input: null-move FEN (side to move swapped).
export function nullMoveFen(fen) {
  const f = fen.split(' ')
  f[1] = f[1] === 'w' ? 'b' : 'w'
  f[3] = '-'
  return f.join(' ')
}
export function describeThreat(fen, nullAnalysis, curInfo, mover) {
  // fen: position where `mover` is to move. nullAnalysis: opponent to move (null move).
  const ch = new Chess(fen)
  if (ch.inCheck() || !nullAnalysis || !nullAnalysis.lines[0]) return null
  const nf = nullMoveFen(fen)
  const line = nullAnalysis.lines[0]
  const o = opp(mover)
  const wpNull = lineWpFor(line, o, o)
  const wpNow = 100 - wpFor(curInfo, mover)
  const m = lineMotif(nf, line, o)
  if (!m.san) return null
  let why = null
  if (m.mate) why = m.mate === 1 ? 'mate na hora' : `mate em ${m.mate}`
  else if (m.fork) why = `garfo ${m.fork.map((t) => namedEm(t.type)).join(' e ')}`
  else if (m.freeCapture) why = `pegando ${named(m.freeCapture)} de graça`
  else if (m.winCapture) why = `pegando ${named(m.winCapture.got)} ${listPieces([m.winCapture.by], 'por')}`
  return { uci: line.pv[0], san: m.san, why, real: wpNull - wpNow >= 12 && (m.mate || (m.mat && m.mat.delta >= 2)) }
}

// Feedback for a "retry" attempt. analysis: engine result for the position after the attempt.
export function attemptFeedback(fenB, uci, analysis, color, wpBefore, bestLine) {
  const ch = new Chess(fenB)
  let m
  try { m = ch.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' }) } catch { return null }
  const info = evalInfo(ch.fen(), analysis)
  const wp = color === 'w' ? info.wpW : 100 - info.wpW
  const loss = Math.max(0, wpBefore - wp)
  if (info.terminal === 'mate') return { ok: true, san: m.san, wp, text: `${m.san}#! Xeque-mate.` }
  if (loss < 5) return { ok: true, san: m.san, wp, text: `${m.san} também funciona: sua chance fica em ${Math.round(wp)}%.` }
  const reply = analysis && analysis.lines && analysis.lines[0]
  const rm = lineMotif(ch.fen(), reply, opp(color))
  let why = ''
  if (rm.mate) why = `permite mate em ${rm.mate} (${rm.mateLine.join(' ')})`
  else {
    const hang = hangingPieces(ch, color)
    const mat = reply ? pvMaterial(fenB, [m.from + m.to + (m.promotion || ''), ...reply.pv], color) : null
    if (mat && mat.delta <= -2 && hang.length) why = `deixa ${named(hang[0].type, hang[0].sq)} sem defesa`
    else if (mat && mat.delta <= -2) why = `depois de ${rm.san} você ${lossText(mat, color)}`
    else if (mat && mat.delta <= -1) why = `depois de ${rm.san} você ${lossText(mat, color)}`
    else if (rm.fork) why = `a resposta ${rm.san} é um garfo`
    else if (rm.check) why = `a resposta ${rm.san} vem com xeque e o adversário toma a iniciativa`
  }
  // o que a posição tinha de melhor (sem entregar o lance)
  let missed = ''
  if (bestLine && bestLine.pv && bestLine.pv.length) {
    const bm = lineMotif(fenB, bestLine, color)
    if (bm.mate) missed = `tem mate forçado em ${bm.mate} nessa posição`
    else if (bm.mat && bm.mat.delta >= 2) missed = 'tem um lance que ganha material'
    else if (bm.fork) missed = 'tem um garfo nessa posição'
    else if (bm.pin) missed = 'tem uma cravada nessa posição'
  }
  if (!why && !missed && rm.san) why = `depois de ${rm.san} o adversário fica melhor`
  const chance = `Sua chance ficaria em ${Math.round(wp)}%${wpBefore - wp >= 3 ? ` (com o melhor lance, ${Math.round(wpBefore)}%)` : ''}.`
  return { ok: false, san: m.san, wp, text: `${m.san} não é a resposta${why ? ': ' + why : ''}. ${missed ? 'Procura de novo: ' + missed + '. ' : ''}${chance}` }
}
export { explainBest as explainBestMove, lineMotif }

// ── Input formats ───────────────────────────────────────────────────────────
const FEN_RE = /^\s*((?:[rnbqkpRNBQKP1-8]{1,8}\/){7}[rnbqkpRNBQKP1-8]{1,8})\s+([wb])(\s+[KQkq-]+\s+[a-h1-8-]+(\s+\d+\s+\d+)?)?\s*$/
// Detects what the user pasted: chess.com/lichess link, FEN, or one or more PGN games.
export function detectInput(text) {
  const t = (text || '').trim()
  if (!t) return { kind: 'empty' }
  let m = /chess\.com\/(?:[a-z]{2}\/)?(?:analysis\/)?game\/(?:(live|daily)\/)?(\d+)/i.exec(t) || /chess\.com\/(live|daily)\/game\/(\d+)/i.exec(t)
  if (m && !/^\s*\[/.test(t)) return { kind: 'link', site: 'chesscom', type: (m[1] || 'live').toLowerCase(), id: m[2] }
  m = /lichess\.org\/(?:embed\/(?:game\/)?)?([A-Za-z0-9]{8})(?:[A-Za-z0-9]{4})?(?![A-Za-z0-9])/.exec(t)
  if (m && !/^\s*\[/.test(t)) return { kind: 'link', site: 'lichess', id: m[1] }
  if (FEN_RE.test(t)) {
    const fen = t.split(/\s+/).length >= 6 ? t : (t + ' ' + ['-', '-', '0', '1'].slice(t.split(/\s+/).length - 2).join(' ')).trim()
    try { new Chess(fen); return { kind: 'fen', fen } } catch (e) { return { kind: 'error', message: 'FEN inválido: ' + e.message } }
  }
  const games = splitGames(t)
  return { kind: 'pgn', games }
}
// Splits a multi-game PGN (e.g. an archive download) into separate games.
export function splitGames(t) {
  const parts = t.replace(/\r/g, '').split(/\n\s*\n(?=\s*\[Event\s)/)
  return parts.map((s) => s.trim()).filter(Boolean)
}
export function gameSummary(pgn) {
  const h = {}
  for (const m of pgn.matchAll(/^\s*\[(\w+)\s+"([^"]*)"\]/gm)) h[m[1]] = m[2]
  return h
}
// [%clk] per ply (seconds remaining after the move), read in order from the movetext.
export function extractClocks(pgn, nPlies) {
  let body = pgn.replace(/\r/g, '').replace(/^\s*\[[^\]]*\]\s*$/gm, '')
  // drop variations (nested parentheses), keeping comments
  let prev
  do { prev = body; body = body.replace(/\([^()]*\)/g, ' ') } while (body !== prev)
  const clocks = new Array(nPlies).fill(null)
  let ply = -1
  const re = /\{([^}]*)\}|;[^\n]*|(\d+\.(?:\.\.)?)|(\$\d+)|(1-0|0-1|1\/2-1\/2|\*)|([^\s{}()]+)/g
  let m
  while ((m = re.exec(body))) {
    if (m[1] !== undefined) {
      const c = /\[%clk\s+(\d+):(\d+):(\d+(?:\.\d+)?)\]/.exec(m[1].replace(/\s+/g, ' '))
      if (c && ply >= 0 && ply < nPlies) clocks[ply] = +c[1] * 3600 + +c[2] * 60 + +c[3]
    } else if (m[5] !== undefined) {
      if (/^\d+\.+$/.test(m[5])) continue
      ply++
    }
  }
  return clocks.some((x) => x !== null) ? clocks : null
}
export function parseTimeControl(tc) {
  if (!tc || tc === '-' || tc === '?') return null
  if (tc.includes('/')) return null // daily / correspondence
  const [b, i] = tc.split('+')
  const base = +b, inc = +(i || 0)
  return isFinite(base) ? { base, inc } : null
}
// Remaining clock for each side at each position index and time spent per ply.
export function clockData(game, pgn) {
  const clocks = extractClocks(pgn, game.plies.length)
  if (!clocks) return null
  const tc = parseTimeControl(game.headers.TimeControl)
  const base = tc ? tc.base : Math.max(...clocks.filter((x) => x !== null))
  const inc = tc ? tc.inc : 0
  const spent = []
  const last = { w: base, b: base }
  const at = [{ ...last }]
  game.plies.forEach((p, k) => {
    const c = clocks[k]
    if (c !== null) { spent[k] = Math.max(0, last[p.color] - c + inc); last[p.color] = c }
    else spent[k] = null
    at.push({ ...last })
  })
  return { base, inc, spent, at }
}
export function fmtClock(s) {
  if (s === null || s === undefined) return '-'
  if (s >= 3600) return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  if (s < 20) return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${Math.floor((s * 10) % 10)}`
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}
export function fmtSpent(s) {
  if (s === null || s === undefined) return ''
  if (s < 10) return s.toFixed(1) + 's'
  if (s < 60) return Math.round(s) + 's'
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}`
}


// ── Step-by-step explanation of an engine line ("Explicar") ─────────────────
// pv: uci moves starting at fen. Returns one comment (+ board visuals) per move.
export function explainLine(fen, pv, opts = {}) {
  const steps = []
  const c = new Chess(fen)
  const start = fen
  const moves = []
  for (let i = 0; i < pv.length; i++) {
    const u = pv[i]
    const before = c.fen()
    let m
    try { m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }) } catch { break }
    moves.push(m)
    const vis = { arrows: [], marks: [] }
    const ideas = describeIdea(before, pv.slice(i), m.color, null, vis)
    const who = opts.side ? (m.color === opts.side ? 'Você' : 'O adversário') : (m.color === 'w' ? 'As brancas' : 'As pretas')
    let text
    if (i === 0 && opts.firstNote) text = opts.firstNote
    else if (ideas.length) text = `${m.san}: ${joinPt(ideas)}.`
    else if (m.san.includes('+')) text = `${m.san}: xeque.`
    else text = `${m.san}: ${who.toLowerCase() === 'você' ? 'você melhora' : who.toLowerCase() + ' melhora'} a posição.`
    if (c.isCheckmate()) text = `${m.san}: xeque-mate!`
    steps.push({ san: m.san, color: m.color, from: m.from, to: m.to, fen: c.fen(), text, vis })
  }
  // summary on the last step: material balance of the whole line
  if (steps.length) {
    const side = opts.side || moves[0].color
    const mat = pvMaterial(start, pv.slice(0, steps.length), side, steps.length)
    const last = steps[steps.length - 1]
    let sum = ''
    if (new Chess(last.fen).isCheckmate()) sum = ''
    else if (mat.delta >= 2) sum = ` Saldo da linha: você ${gainText(mat, side)}.`
    else if (mat.delta <= -2) sum = ` Saldo da linha: você ${lossText(mat, side)}.`
    if (opts.evalText) sum += ` Avaliação no fim: ${opts.evalText}.`
    last.text += sum
  }
  return steps
}
