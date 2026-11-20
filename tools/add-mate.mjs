// Adiciona uma posição à trilha "Ache o mate" (src/custom-drills.json).
// Confere com o Stockfish que existe mate forçado em N e grava a solução.
// Uso (depois de `bash build.sh`):
//   node tools/add-mate.mjs --fen "<FEN com quem joga>" --mate 3 [--last d7e6] [--lastSan Ke6] [--id slug] [--note "texto"]
import fs from 'fs'
import { createRequire } from 'module'
import { Chess } from 'chess.js'
const require = createRequire(import.meta.url)
const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((s) => { const [k, ...v] = s.trim().split(' '); return [k, v.join(' ').replace(/^"|"$/g, '')] }))
const fen = args.fen, N = +args.mate
if (!fen || !N) { console.error('uso: --fen "<FEN>" --mate N [--last uci] [--id slug] [--note texto]'); process.exit(1) }
const ch = new Chess(fen)
const { Uci } = await import('../build/uci.node.mjs')
const engine = require('stockfish')('lite-single')
const uci = new Uci((c) => engine.processCommand(c))
engine.listener = (l) => uci.feed(l)
await uci.init()
const r = await uci.analyse(fen, { depth: 30, multipv: 2 })
const best = r.lines[0]
if (best.mate !== N) { console.error(`Stockfish não confirma mate em ${N}: melhor linha ${best.mate !== undefined ? 'mate em ' + best.mate : best.cp + ' cp'} (${best.pv.slice(0, 6).join(' ')}). Confira a posição.`); process.exit(2) }
const sol = best.pv.slice(0, 2 * N - 1)
const t = new Chess(fen)
for (const u of sol) t.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] })
if (!t.isCheckmate()) { console.error('a linha não termina em mate'); process.exit(3) }
let lastSan = null
if (args.last) { const p = ch.get(args.last.slice(2, 4)); const cap = p?.type === 'p' && args.last[0] !== args.last[2]; lastSan = args.lastSan || (p ? (p.type === 'p' ? (cap ? args.last[0] + 'x' : '') : p.type.toUpperCase()) + args.last.slice(2, 4) : null) } // captura de peça não dá pra saber: use --lastSan
const file = new URL('../src/custom-drills.json', import.meta.url)
const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { acheOMate: [] }
const id = args.id || 'm' + (data.acheOMate.length + 1)
if (data.acheOMate.some((p) => p.start.split(' ').slice(0, 4).join(' ') === fen.split(' ').slice(0, 4).join(' '))) { console.error('essa posição já está na trilha'); process.exit(4) }
data.acheOMate.push({ id, start: fen, last: args.last || null, lastSan, sol, mate: N, note: args.note || undefined, alt: r.lines[1]?.mate === N ? 'tem mais de uma solução' : undefined })
fs.writeFileSync(file, JSON.stringify(data, null, 1) + '\n')
const s = new Chess(fen)
console.log(`ok: ${id} · mate em ${N}: ${sol.map((u) => s.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san).join(' ')}`)
process.exit(0)
