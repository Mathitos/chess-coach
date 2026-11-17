// Saved challenges ("desafios"): positions from key moments with their solution,
// a Leitner-style review schedule and a merge that works across devices.

export const DAY = 24 * 3600 * 1000
export const INTERVALS = [0, 1, 3, 7, 16, 35] // days, by box

export function puzzleId(fen, uci) {
  let h = 5381
  const s = fen.split(' ').slice(0, 4).join(' ') + '|' + uci
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return 'p' + h.toString(36)
}

export function emptyStore() { return { v: 1, updatedAt: 0, puzzles: {}, deleted: {} } }

// Union of two stores: newest version of each puzzle wins; deletions win over older edits.
export function mergeStores(a, b) {
  a = a || emptyStore(); b = b || emptyStore()
  const out = emptyStore()
  for (const src of [a, b]) for (const [id, ts] of Object.entries(src.deleted || {})) out.deleted[id] = Math.max(out.deleted[id] || 0, ts)
  for (const src of [a, b]) for (const [id, p] of Object.entries(src.puzzles || {})) {
    const cur = out.puzzles[id]
    if (!cur || (p.updatedAt || 0) > (cur.updatedAt || 0)) out.puzzles[id] = p
  }
  for (const [id, ts] of Object.entries(out.deleted)) if (out.puzzles[id] && (out.puzzles[id].updatedAt || 0) <= ts) delete out.puzzles[id]
  out.updatedAt = Math.max(a.updatedAt || 0, b.updatedAt || 0)
  return out
}

export function addPuzzles(store, list, now = Date.now()) {
  let added = 0
  for (const p of list) {
    if (store.puzzles[p.id]) continue
    store.puzzles[p.id] = { ...p, box: 0, due: now, attempts: 0, solvedCount: 0, createdAt: now, updatedAt: now }
    delete store.deleted[p.id]
    added++
  }
  if (added) store.updatedAt = now
  return added
}

export function removePuzzle(store, id, now = Date.now()) {
  delete store.puzzles[id]
  store.deleted[id] = now
  store.updatedAt = now
}

// firstTry: solved without wrong attempts, hint or reveal.
export function recordResult(store, id, firstTry, now = Date.now()) {
  const p = store.puzzles[id]
  if (!p) return null
  p.attempts = (p.attempts || 0) + 1
  if (firstTry) {
    p.solvedCount = (p.solvedCount || 0) + 1
    p.box = Math.min(INTERVALS.length - 1, (p.box || 0) + 1)
    p.due = now + INTERVALS[p.box] * DAY
  } else {
    p.box = 0
    p.due = now + 10 * 60 * 1000 // de novo daqui a pouco
  }
  p.lastResult = firstTry ? 'ok' : 'fail'
  p.lastSeen = now
  p.updatedAt = now
  store.updatedAt = now
  return p
}

export function dueList(store, now = Date.now()) {
  return Object.values(store.puzzles).filter((p) => (p.due || 0) <= now).sort((a, b) => (a.due || 0) - (b.due || 0))
}
export function stats(store, now = Date.now()) {
  const all = Object.values(store.puzzles)
  return { total: all.length, due: all.filter((p) => (p.due || 0) <= now).length, learned: all.filter((p) => (p.box || 0) >= 3).length }
}
