// Treinos padrão: puzzles do banco aberto do Lichess (CC0, database.lichess.org),
// separados por tema e em fases de dificuldade (rating do puzzle).
// Formato do Lichess: o 1º lance é do adversário (monta a posição); depois a
// solução alterna você / adversário.
import { Chess } from 'chess.js'

export const THEMES = [
  { key: 'mateIn1', label: 'Mate em 1', icon: '♚', goal: 'Dê xeque-mate em 1 lance.', tip: 'Procure os xeques e veja se o rei tem pra onde fugir.' },
  { key: 'mateIn2', label: 'Mate em 2', icon: '♛', goal: 'Dê xeque-mate em 2 lances.', tip: 'Comece pelos xeques e pelas capturas que tiram as defesas do rei.' },
  { key: 'mateIn3', label: 'Mate em 3', icon: '♜', goal: 'Dê xeque-mate em 3 lances.', tip: 'Lances forçados primeiro: xeques, depois capturas, depois ameaças.' },
  { key: 'backRankMate', label: 'Mate no corredor', icon: '♖', goal: 'Aproveite o rei preso atrás dos peões.', tip: 'O rei sem casa de fuga na última fileira cai com uma torre ou dama ali.' },
  { key: 'fork', label: 'Garfo', icon: '♞', goal: 'Ataque duas peças ao mesmo tempo.', tip: 'Procure uma casa de onde uma peça sua ataca duas do adversário (o cavalo é o rei do garfo).' },
  { key: 'pin', label: 'Cravada', icon: '♝', goal: 'Crave uma peça e ganhe material.', tip: 'Uma peça que não pode sair da frente do rei ou da dama é um alvo.' },
  { key: 'skewer', label: 'Espeto', icon: '♗', goal: 'Ataque uma peça valiosa e pegue a que está atrás.', tip: 'Ataque a peça mais valiosa numa linha; quando ela sair, a de trás cai.' },
  { key: 'discoveredAttack', label: 'Ataque descoberto', icon: '♘', goal: 'Mova uma peça e revele o ataque de outra.', tip: 'Tire uma peça da frente de uma torre, bispo ou dama sua, de preferência com ameaça.' },
  { key: 'hangingPiece', label: 'Peça pendurada', icon: '♙', goal: 'Ache a peça que ficou sem defesa.', tip: 'Confira cada peça do adversário: quem ataca e quem defende.' },
]
export const FASES = [
  { label: 'Fase 1', range: '400–800' },
  { label: 'Fase 2', range: '800–1100' },
  { label: 'Fase 3', range: '1100–1400' },
  { label: 'Fase 4', range: '1400–1700' },
  { label: 'Fase 5', range: '1700–2000' },
]
export const UNLOCK = 7 // resolvidos na fase pra liberar a próxima

export function themeMeta(key) { return THEMES.find((t) => t.key === key) }

// Prepara um puzzle do Lichess pra jogar
export function prepare(raw, theme) {
  const ch = new Chess(raw.fen)
  const first = raw.moves[0]
  const m = ch.move({ from: first.slice(0, 2), to: first.slice(2, 4), promotion: first[4] })
  return { id: raw.id, theme, rating: raw.rating, start: ch.fen(), last: { from: m.from, to: m.to, san: m.san }, sol: raw.moves.slice(1), color: ch.turn() }
}

// Confere o lance do usuário no passo `step` (posição `fen`). No último lance,
// qualquer mate vale (regra do Lichess).
export function check(d, step, fen, uci) {
  const want = d.sol[step]
  if (uci.slice(0, 4) === want.slice(0, 4) && (uci[4] || 'q') === (want[4] || 'q')) return true
  if (step === d.sol.length - 1) {
    const ch = new Chess(fen)
    try { ch.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || 'q' }) } catch { return false }
    return ch.isCheckmate()
  }
  return false
}

// SAN da solução a partir do início (pra "mostrar resposta")
export function solutionSan(d) {
  const ch = new Chess(d.start)
  return d.sol.map((u) => ch.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san)
}

// Progresso: store.drills = { [puzzleId]: { at, first } }
export function faseStats(store, data, theme, f) {
  const list = data?.[theme]?.[f] || []
  const solved = list.filter((p) => store?.drills?.[p.id]).length
  return { solved, total: list.length }
}
export function unlocked(store, data, theme, f) {
  return f === 0 || faseStats(store, data, theme, f - 1).solved >= UNLOCK
}
export function themeStats(store, data, theme) {
  let solved = 0, total = 0
  for (let f = 0; f < FASES.length; f++) { const s = faseStats(store, data, theme, f); solved += s.solved; total += s.total }
  return { solved, total }
}
export function record(store, id, first, now = Date.now()) {
  store.drills ||= {}
  const cur = store.drills[id]
  store.drills[id] = { at: cur?.at || now, first: !!(cur?.first || first) }
  store.updatedAt = now
}
