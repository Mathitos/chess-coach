import { createRequire } from 'module'
import fs from 'fs'
import ort from 'onnxruntime-node'
import * as R from '../build/review.node.mjs'
import { preprocess, postprocess } from '../build/maia-core.node.mjs'
const require = createRequire(import.meta.url)

const pgn = fs.readFileSync(process.argv[2], 'utf8')
const depth = +(process.argv[3] || 14)
const game = R.parseGame(pgn)

const { Uci } = await import('../build/uci.node.mjs')
const engine = require('stockfish')('lite-single')
const uci = new Uci((c) => engine.processCommand(c))
engine.listener = (l) => uci.feed(l)
await uci.init()

const sf = [], threats = []
for (let i = 0; i < game.positions.length; i++) sf.push(await uci.analyse(game.positions[i], { depth, multipv: 2 }))
const infos = game.positions.map((f, i) => R.evalInfo(f, sf[i]))
for (let k = 0; k < game.plies.length; k++) {
  const fen = game.positions[k]
  let t = null
  try {
    const na = await uci.analyse(R.nullMoveFen(fen), { depth: 10 })
    t = R.describeThreat(fen, na, infos[k], game.plies[k].color)
  } catch {}
  threats.push(t)
}
const cls = R.classify(game, sf)

// Maia
const s = await ort.InferenceSession.create('assets/maia3_simplified.onnx', { graphOptimizationLevel: 'basic' })
const run = async (fen, elo) => {
  const pre = preprocess(fen)
  const r = await s.run({ tokens: new ort.Tensor('float32', pre.tokens, [1, 64, 12]), elo_self: new ort.Tensor('float32', Float32Array.from([elo]), [1]), elo_oppo: new ort.Tensor('float32', Float32Array.from([elo]), [1]) })
  return postprocess(pre, r.logits_move.data, r.logits_value.data)
}
const maia = []
for (let k = 0; k < game.plies.length; k++) {
  const elo = 600
  const m = await run(game.positions[k], elo)
  const best = cls[k]?.bestUci
  const bestByLevel = []
  for (const L of [600, 1200, 1800, 2400]) bestByLevel.push([L, best ? (await run(game.positions[k], L)).policy[best] ?? 0 : 0])
  maia.push({ elo, policy: m.policy, bestByLevel })
}
const acc = R.gameAccuracy(game, infos, cls)
console.log('accuracy', acc)
for (let k = 0; k < game.plies.length; k++) {
  const p = game.plies[k]
  const r = cls[k]
  const t = R.coachText(game, sf, threats, cls, k, maia)
  console.log(`${Math.floor(k / 2) + 1}${p.color === 'w' ? '.' : '...'} ${p.san} [${r.cls}] ${infos[k + 1].text} loss=${r.loss.toFixed(3)}${threats[k]?.real ? ' threat=' + threats[k].san : ''}\n   ${t.text}${t.tip ? '\n   DICA: ' + t.tip : ''}${t.human ? '\n   MAIA: ' + t.human : ''}`)
}
engine.terminate && engine.terminate()
process.exit(0)
