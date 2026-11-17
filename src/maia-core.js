// Maia3 pre/post-processing (port of CSSLab/maia-platform-frontend, GPL-3.0)
import { Chess } from 'chess.js'
import MOVES_REV from '../assets/all_moves_maia3_reversed.json'

export const MOVE_LIST = Array.from({ length: Object.keys(MOVES_REV).length }, (_, i) => MOVES_REV[i])
const MOVE_INDEX = Object.fromEntries(MOVE_LIST.map((m, i) => [m, i]))
const PIECES = ['P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k']

const swapCase = (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())
const mirrorSquare = (sq) => sq[0] + (9 - parseInt(sq[1]))
export const mirrorMove = (uci) => mirrorSquare(uci.slice(0, 2)) + mirrorSquare(uci.slice(2, 4)) + uci.slice(4)

function mirrorFEN(fen) {
  const [pos, side, castling, ep, half, full] = fen.split(' ')
  const p = pos.split('/').reverse().map((r) => [...r].map((c) => (/[a-z]/i.test(c) ? swapCase(c) : c)).join('')).join('/')
  let c = '-'
  if (castling !== '-') {
    c = [...castling].map(swapCase).join('')
    c = ['K', 'Q', 'k', 'q'].filter((x) => c.includes(x)).join('') || '-'
  }
  return `${p} ${side === 'w' ? 'b' : 'w'} ${c} ${ep !== '-' ? mirrorSquare(ep) : '-'} ${half} ${full}`
}

function tokens(fen) {
  const t = new Float32Array(64 * 12)
  const rows = fen.split(' ')[0].split('/')
  for (let r = 0; r < 8; r++) {
    const row = 7 - r
    let file = 0
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) file += +ch
      else {
        const idx = PIECES.indexOf(ch)
        if (idx >= 0) t[(row * 8 + file) * 12 + idx] = 1
        file++
      }
    }
  }
  return t
}

export function preprocess(fen) {
  const black = fen.split(' ')[1] === 'b'
  const f = black ? mirrorFEN(fen) : fen
  const board = new Chess(f)
  const legal = []
  for (const m of board.moves({ verbose: true })) {
    const i = MOVE_INDEX[m.from + m.to + (m.promotion || '')]
    if (i !== undefined) legal.push(i)
  }
  return { tokens: tokens(f), legal, black }
}

// logits: Float32Array(4352), wdl: 3 logits (loss, draw, win) for side to move
export function postprocess(pre, logits, wdl) {
  const mx = Math.max(wdl[0], wdl[1], wdl[2])
  const eL = Math.exp(wdl[0] - mx), eD = Math.exp(wdl[1] - mx), eW = Math.exp(wdl[2] - mx)
  let win = (eW + 0.5 * eD) / (eL + eD + eW) // side to move
  const ls = pre.legal.map((i) => logits[i])
  const m = Math.max(...ls)
  const ex = ls.map((l) => Math.exp(l - m))
  const s = ex.reduce((a, b) => a + b, 0)
  const policy = {}
  pre.legal.forEach((i, k) => {
    let uci = MOVE_LIST[i]
    if (pre.black) uci = mirrorMove(uci)
    policy[uci] = ex[k] / s
  })
  return { policy, winStm: win }
}
