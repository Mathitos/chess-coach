// Unit + engine tests (Node). Run after `bash build.sh`:  node --test test/unit.test.mjs
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import * as R from '../build/review.node.mjs'
import { Uci } from '../build/uci.node.mjs'
import { preprocess, postprocess } from '../build/maia-core.node.mjs'

const require = createRequire(import.meta.url)
const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8')

describe('entrada', () => {
  test('links do chess.com', () => {
    for (const url of ['https://www.chess.com/game/187383650428', 'https://www.chess.com/game/live/187383650428?move=8', 'https://www.chess.com/analysis/game/live/187383650428']) {
      const d = R.detectInput(url)
      assert.equal(d.kind, 'link'); assert.equal(d.site, 'chesscom'); assert.equal(d.id, '187383650428')
    }
    assert.equal(R.detectInput('https://www.chess.com/game/daily/123456').type, 'daily')
  })
  test('links do Lichess', () => {
    assert.deepEqual(R.detectInput('https://lichess.org/abcdEFGH'), { kind: 'link', site: 'lichess', id: 'abcdEFGH' })
    assert.equal(R.detectInput('https://lichess.org/abcdEFGH1234').id, 'abcdEFGH')
  })
  test('FEN, com e sem os campos finais', () => {
    assert.equal(R.detectInput('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1').kind, 'fen')
    assert.equal(R.detectInput('8/8/8/4k3/8/8/4K3/8 w').kind, 'fen')
  })
  test('PGN simples, sem cabeçalho e com várias partidas', () => {
    assert.equal(R.detectInput(read('game.pgn')).games.length, 1)
    assert.equal(R.detectInput('1. e4 e5 2. Nf3 Nc6').games.length, 1)
    const multi = read('game.pgn').trim() + '\n\n' + read('game2.pgn').trim()
    assert.equal(R.detectInput(multi).games.length, 2)
  })
  test('PGN com variantes, NAGs e comentários', () => {
    const g = R.parseGame('[White "a"]\n[Black "b"]\n\n1. e4 {[%eval 0.3]} e5 $2 {Erro.} (1... d5 2. exd5 Qxd5) 2. Nf3 $1 Nc6 *')
    assert.deepEqual(g.plies.map((p) => p.san), ['e4', 'e5', 'Nf3', 'Nc6'])
  })
})

describe('relógio', () => {
  const pgn = read('game-clock.pgn')
  const game = R.parseGame(pgn)
  const cd = R.clockData(game, pgn)
  test('tempo gasto bate com o %timestamp do chess.com', () => {
    // [%timestamp] em décimos: 22, 66, 33, 184, 93
    assert.deepEqual(cd.spent.map((x) => Math.round(x * 10)), [22, 66, 33, 184, 93])
  })
  test('relógio de cada lado em cada posição', () => {
    assert.equal(cd.base, 300)
    assert.deepEqual(cd.at[0], { w: 300, b: 300 })
    assert.equal(R.fmtClock(cd.at[4].w), '4:54')
    assert.equal(R.fmtClock(cd.at[4].b), '4:35')
  })
  test('controle de tempo com incremento e diário', () => {
    assert.deepEqual(R.parseTimeControl('180+2'), { base: 180, inc: 2 })
    assert.equal(R.parseTimeControl('1/86400'), null)
  })
  test('PGN sem relógio não gera dados', () => {
    const p = read('game.pgn')
    assert.equal(R.clockData(R.parseGame(p), p), null)
  })
})

describe('engine (Stockfish) + classificação', () => {
  let engine, uci
  before(async () => {
    engine = require('stockfish')('lite-single')
    uci = new Uci((c) => engine.processCommand(c))
    engine.listener = (l) => uci.feed(l)
    await uci.init()
  })
  // stockfish.js (emscripten) sets process.exitCode when its main() returns; don't let that fail the run
  after(() => { engine.terminate && engine.terminate(); process.exitCode = undefined })

  async function review(pgn, depth) {
    const game = R.parseGame(pgn)
    const sf = []
    for (const fen of game.positions) sf.push(await uci.analyse(fen, { depth, multipv: 2 }))
    const infos = game.positions.map((f, i) => R.evalInfo(f, sf[i]))
    const threats = []
    for (let k = 0; k < game.plies.length; k++) {
      const na = await uci.analyse(R.nullMoveFen(game.positions[k]), { depth: 8 }).catch(() => null)
      threats.push(na ? R.describeThreat(game.positions[k], na, infos[k], game.plies[k].color) : null)
    }
    return { game, sf, infos, threats, cls: R.classify(game, sf) }
  }

  test('17.Nf7 permite mate em 1 e é capivarada; Qxg2# é o melhor', { timeout: 240000 }, async () => {
    const r = await review(read('game2.pgn'), 10)
    const k = r.game.plies.findIndex((p) => p.san === 'Nf7')
    assert.equal(r.cls[k].cls, 'blunder')
    const t = R.coachText(r.game, r.sf, r.threats, r.cls, k, null)
    assert.match(t.text, /mate em 1/)
    assert.equal(r.cls[k + 1].cls, 'best')
    const acc = R.gameAccuracy(r.game, r.infos, r.cls)
    assert.ok(acc.w > 0 && acc.w < 100 && acc.b > 0 && acc.b < 100)
  })

  test('lance ruim do adversário vira chance de punir (perspectiva do usuário)', { timeout: 240000 }, async () => {
    const r = await review(read('game2.pgn'), 10)
    const badOpp = r.cls.map((c, k) => [c, k]).filter(([c, k]) => r.game.plies[k].color === 'b' && ['mistake', 'blunder'].includes(c.cls))
    assert.ok(badOpp.length > 0)
    for (const [, k] of badOpp) {
      const t = R.coachText(r.game, r.sf, r.threats, r.cls, k, null, { third: true })
      assert.match(t.text, /^O adversário/)
      assert.match(t.text, /Sua chance de punir/)
      assert.doesNotMatch(t.text, /Você ignorou|Sua chance de vitória caiu/)
    }
  })

  test('16.Qxh5 (entrega a dama por um bispo) é no mínimo erro', { timeout: 240000 }, async () => {
    const r = await review(read('game.pgn'), 10)
    const k = r.game.plies.findIndex((p) => p.san === 'Qxh5')
    assert.ok(['mistake', 'blunder'].includes(r.cls[k].cls), r.cls[k].cls)
    const t = R.coachText(r.game, r.sf, r.threats, r.cls, k, null)
    assert.match(t.text, /dama/)
  })

  test('feedback do "tentar de novo"', { timeout: 60000 }, async () => {
    // posição antes de 17.Nf7 na game2: a4 permite Qxg2#
    const g = R.parseGame(read('game2.pgn'))
    const k = g.plies.findIndex((p) => p.san === 'Nf7')
    const fen = g.positions[k]
    const { Chess } = await import('chess.js')
    const ch = new Chess(fen); ch.move('a4')
    const an = await uci.analyse(ch.fen(), { depth: 10 })
    const before = await uci.analyse(fen, { depth: 10 })
    const wb = R.evalInfo(fen, before).wpW
    const fb = R.attemptFeedback(fen, 'a3a4', an, 'w', wb)
    assert.equal(fb.ok, false)
    assert.match(fb.text, /mate em 1/)
  })
})

describe('Maia-3', () => {
  let session, ort
  before(async () => {
    ort = (await import('onnxruntime-node')).default
    // 'basic': the default (all) graph optimizations crash onnxruntime-node on this model
    session = await ort.InferenceSession.create(new URL('../assets/maia3_simplified.onnx', import.meta.url).pathname, { graphOptimizationLevel: 'basic' })
  })
  const run = async (fen, elo) => {
    const pre = preprocess(fen)
    const r = await session.run({
      tokens: new ort.Tensor('float32', pre.tokens, [1, 64, 12]),
      elo_self: new ort.Tensor('float32', Float32Array.from([elo]), [1]),
      elo_oppo: new ort.Tensor('float32', Float32Array.from([elo]), [1]),
    })
    return postprocess(pre, r.logits_move.data, r.logits_value.data)
  }
  const top = (pol) => Object.entries(pol).sort((a, b) => b[1] - a[1])[0][0]

  test('abertura: e4 ou d4 é o lance mais provável', { timeout: 60000 }, async () => {
    const r = await run('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 1500)
    assert.ok(['e2e4', 'd2d4'].includes(top(r.policy)))
    const sum = Object.values(r.policy).reduce((a, b) => a + b, 0)
    assert.ok(Math.abs(sum - 1) < 1e-3)
  })
  test('pretas (tabuleiro espelhado): respostas a 1.e4 são lances de pretas', { timeout: 60000 }, async () => {
    const r = await run('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', 1500)
    assert.ok(['e7e5', 'c7c5', 'e7e6', 'c7c6', 'd7d5'].includes(top(r.policy)), top(r.policy))
  })
  test('dxe4 depois de 6.Nf3 é mais achado por rating alto', { timeout: 60000 }, async () => {
    const fen = R.parseGame('1. e4 Nc6 2. d3 e5 3. g3 Nf6 4. f4 Bc5 5. c4 d5 6. Nf3').positions.at(-1)
    const lo = (await run(fen, 600)).policy.d5e4, hi = (await run(fen, 2200)).policy.d5e4
    assert.ok(hi > lo, `${lo} < ${hi}`)
  })
})
