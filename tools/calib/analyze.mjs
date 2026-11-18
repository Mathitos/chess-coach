// Analisa partidas do dataset de calibração (cache por partida, retomável)
import { createRequire } from 'module'
import fs from 'fs'
import * as R from '../../build/review.node.mjs'
const require = createRequire(import.meta.url)
const [, , gamesFile, outDir, depthS, shardS, nS, budgetS, perBandS] = process.argv
const depth = +depthS, shard = +shardS, nShards = +nS, budget = +budgetS * 1000, perBand = +perBandS
fs.mkdirSync(outDir, { recursive: true })
const games = JSON.parse(fs.readFileSync(gamesFile, 'utf8'))
// subamostra balanceada por banda de rating
const byBand = {}
for (const [url, g] of Object.entries(games)) { const b = Math.min(5, Math.floor((g.w + g.b) / 2 / 400)); (byBand[b] ||= []).push(url) }
const pick = Object.values(byBand).flatMap((a) => a.sort().slice(0, perBand)).sort()
const { Uci } = await import('../../build/uci.node.mjs')
const engine = require('stockfish')('lite-single')
const uci = new Uci((c) => engine.processCommand(c))
engine.listener = (l) => uci.feed(l)
await uci.init()
const t0 = Date.now()
let done = 0, skipped = 0
for (let i = shard; i < pick.length; i += nShards) {
  const url = pick[i], id = url.split('/').pop()
  const file = `${outDir}/${id}.json`
  if (fs.existsSync(file)) { skipped++; continue }
  if (Date.now() - t0 > budget) break
  let game
  try { game = R.parseGame(games[url].pgn) } catch { continue }
  if (game.plies.length < 10) { fs.writeFileSync(file, JSON.stringify({ skip: true })); continue }
  const sf = []
  for (const f of game.positions) sf.push(await uci.analyse(f, { depth, multipv: 2 }))
  fs.writeFileSync(file, JSON.stringify({ url, sf }))
  done++
}
console.log(`shard ${shard}: +${done} (já tinha ${skipped}) de ${Math.ceil(pick.length / nShards)}`)
process.exit(0)
