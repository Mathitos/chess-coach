import ort from 'onnxruntime-node'
import { preprocess, postprocess } from '../build/maia-core.node.mjs'

const s = await ort.InferenceSession.create('assets/maia3_simplified.onnx', { graphOptimizationLevel: 'basic' })
console.log('inputs', s.inputNames, 'outputs', s.outputNames)
const fens = [
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
]
{ const { Chess } = await import('chess.js'); const c = new Chess(); for (const m of 'e4 Nc6 d3 e5 g3 Nf6 f4 Bc5 c4 d5 Nf3'.split(' ')) c.move(m); fens.push(c.fen()) }
for (const elo of [600, 1500, 2200]) {
  for (const fen of fens) {
    const pre = preprocess(fen)
    const r = await s.run({
      tokens: new ort.Tensor('float32', pre.tokens, [1, 64, 12]),
      elo_self: new ort.Tensor('float32', Float32Array.from([elo]), [1]),
      elo_oppo: new ort.Tensor('float32', Float32Array.from([elo]), [1]),
    })
    const out = postprocess(pre, r.logits_move.data, r.logits_value.data)
    const top = Object.entries(out.policy).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([m, p]) => `${m} ${(p * 100).toFixed(0)}%`)
    console.log(elo, fen.split(' ')[1], 'win(stm)', out.winStm.toFixed(2), top.join(', '))
  }
}
