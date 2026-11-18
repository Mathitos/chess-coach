// Ajusta a curva de pontos esperados pra precisão bater com a do chess.com
import fs from 'fs'
import * as R from '../../build/review.node.mjs'
const [, , gamesFile, sfDir] = process.argv
const games = JSON.parse(fs.readFileSync(gamesFile, 'utf8'))
const data = []
for (const f of fs.readdirSync(sfDir)) {
  const d = JSON.parse(fs.readFileSync(`${sfDir}/${f}`, 'utf8'))
  if (d.skip) continue
  const g = games[d.url], game = R.parseGame(g.pgn)
  const infos = game.positions.map((p, i) => R.evalInfo(p, d.sf[i]))
  if (infos.some((x) => !x)) continue
  data.push({ game, infos, acc: g.acc, elo: { w: g.w, b: g.b }, tc: g.tc })
}
const sig = (x) => 1 / (1 + Math.exp(-x))
function makeEP(P) {
  return (info, color, elo) => {
    const w = Math.max(0, Math.min(1, (elo - P.e0) / P.span))
    const sgn = color === 'w' ? 1 : -1
    if (info.terminal === 'mate') return color === 'w' ? info.wpW : 100 - info.wpW
    if (info.mateW !== undefined) { const n = Math.max(1, Math.abs(info.mateW)); const ep = 100 - (1 - w) * Math.log2(n); return info.mateW * sgn > 0 ? ep : 100 - ep }
    const pw = (info.cpW * sgn) / 100, ap = Math.abs(pw)
    const fat = Math.sign(pw) * P.a * (ap < 1 ? ap : ap ** P.x)
    return 100 * sig((1 - w) * fat + w * 0.368208 * pw)
  }
}
function accuracy(d, EP, kAcc) {
  const { game, infos } = d, n = infos.length
  const win = Math.max(2, Math.min(8, Math.floor(n / 10)))
  const res = {}
  for (const color of ['w', 'b']) {
    const wps = infos.map((i) => EP(i, 'w', d.elo[color]))
    const acc = [], wt = []
    for (let k = 0; k < game.plies.length; k++) {
      if (game.plies[k].color !== color) continue
      const b = EP(infos[k], color, d.elo[color]), a = EP(infos[k + 1], color, d.elo[color])
      const kk = Math.max(0.01, kAcc + (P_K1 || 0) * (1500 - d.elo[color]) / 1000)
      acc.push(Math.max(0, Math.min(100, 103.1668 * Math.exp(-kk * Math.max(0, b - a)) - 3.1669 + 1)))
      const lo = Math.max(0, Math.min(k, n - win)), seg = wps.slice(lo, lo + win)
      const mean = seg.reduce((x, y) => x + y, 0) / seg.length
      wt.push(Math.max(0.5, Math.min(12, Math.sqrt(seg.reduce((x, y) => x + (y - mean) ** 2, 0) / seg.length))))
    }
    const wmean = acc.reduce((x, v, i) => x + v * wt[i], 0) / wt.reduce((x, y) => x + y, 0)
    const hmean = acc.length / acc.reduce((x, v) => x + 1 / Math.max(v, 1), 0)
    res[color] = (wmean + hmean) / 2
  }
  return res
}
let P_K1 = 0
function score(P, report) {
  P_K1 = P.k1 || 0
  const EP = makeEP(P)
  let se = 0, n = 0, bias = 0
  const bands = {}
  for (const d of data) {
    const a = accuracy(d, EP, P.k)
    for (const c of ['w', 'b']) {
      const ref = c === 'w' ? d.acc.white : d.acc.black
      const e = a[c] - ref; se += e * e; bias += e; n++
      const b = Math.min(5, Math.floor(d.elo[c] / 400)); (bands[b] ||= []).push(e)
    }
  }
  if (report) {
    console.log(report, 'RMSE', Math.sqrt(se / n).toFixed(2), 'viés', (bias / n).toFixed(2), 'n', n)
    for (const [b, es] of Object.entries(bands)) console.log(`   ${b * 400}-${b * 400 + 399}: RMSE ${Math.sqrt(es.reduce((x, y) => x + y * y, 0) / es.length).toFixed(2)} viés ${(es.reduce((x, y) => x + y, 0) / es.length).toFixed(2)} (n=${es.length})`)
  }
  return Math.sqrt(se / n)
}
console.log('partidas', data.length)
score({ e0: 1e9, span: 1, a: 0.368208, x: 1, k: 0.04354 }, 'Lichess puro (antes)')
const cur = { e0: 900, span: 1300, a: 0.42, x: 0.62, k: 0.04354 }
score(cur, 'Atual')

// busca por coordenadas (parte do atual e do Lichess, fica com o melhor)
function search(P0, steps) {
  let best = { ...P0 }, bs = score(best)
  for (let round = 0; round < 6; round++) {
    let improved = false
    for (const [key, st] of Object.entries(steps)) {
      for (const dir of [1, -1]) {
        for (let m = 1; m <= 4; m++) {
          const P = { ...best, [key]: best[key] + dir * st * m / (round + 1) }
          if (P.span <= 50 || P.a <= 0.05 || P.x <= 0.2 || P.k <= 0.005) continue
          const sc = score(P)
          if (sc < bs - 1e-4) { best = P; bs = sc; improved = true }
        }
      }
    }
    if (!improved) break
  }
  return { ...best, s: bs }
}
const steps = { e0: 200, span: 300, a: 0.04, x: 0.06, k: 0.004 }
const r1 = search(cur, steps)
const r2 = search({ e0: 1500, span: 1000, a: 0.368, x: 1, k: 0.04354 }, steps)
const best = r1.s < r2.s ? r1 : r2
console.log('melhor', JSON.stringify(best))
score(best, 'Ajustado')

const lich = { e0: 1e9, span: 1000, a: 0.368208, x: 1, k: 0.04354, k1: 0 }
const kOnly = search(lich, { k: 0.004, k1: 0.004 })
console.log('lichess + k por rating', JSON.stringify(kOnly))
score(kOnly, 'Lichess + k(rating)')
const all = data.slice()
data.length = 0; all.forEach((d, i) => i % 2 === 0 && data.push(d))
const halfK = search(lich, { k: 0.004, k1: 0.004 })
data.length = 0; all.forEach((d, i) => i % 2 === 1 && data.push(d))
score(halfK, 'Validação k(rating)')
score(lich, 'Lichess puro na mesma metade')
