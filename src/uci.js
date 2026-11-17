// Minimal UCI client usable with a Web Worker (browser) or stockfish.js (node).
// send(cmd) posts a command; feed(line) must be called with every engine line.
export class Uci {
  constructor(send) {
    this.send = send
    this.waiters = []
    this.queue = Promise.resolve()
  }
  feed(line) {
    if (typeof line !== 'string') return
    for (const w of [...this.waiters]) w(line)
  }
  waitFor(pred, onLine) {
    return new Promise((resolve) => {
      const w = (line) => {
        onLine && onLine(line)
        if (pred(line)) {
          this.waiters.splice(this.waiters.indexOf(w), 1)
          resolve(line)
        }
      }
      this.waiters.push(w)
    })
  }
  async init() {
    const p = this.waitFor((l) => l === 'uciok')
    this.send('uci')
    await p
    this.send('setoption name Hash value 32')
    await this.ready()
  }
  async ready() {
    const p = this.waitFor((l) => l === 'readyok')
    this.send('isready')
    await p
  }
  // Serialised analysis. Returns { lines:[{cp?,mate?,pv:[uci]}], depth } with
  // scores from the side to move's point of view.
  analyse(fen, { depth = 14, movetime = 0, multipv = 1 } = {}) {
    const job = async () => {
      this.send('setoption name MultiPV value ' + multipv)
      await this.ready()
      const lines = []
      let depthReached = 0
      const done = this.waitFor(
        (l) => l.startsWith('bestmove'),
        (l) => {
          if (!l.startsWith('info') || !l.includes(' pv ')) return
          const d = +(/ depth (\d+)/.exec(l) || [])[1]
          const mpv = +(/ multipv (\d+)/.exec(l) || [0, 1])[1]
          const sc = / score (cp|mate) (-?\d+)/.exec(l)
          if (!sc || / (lowerbound|upperbound)/.test(l)) return
          const pv = l.split(' pv ')[1].trim().split(/\s+/)
          lines[mpv - 1] = sc[1] === 'cp' ? { cp: +sc[2], pv, depth: d } : { mate: +sc[2], pv, depth: d }
          if (mpv === 1) depthReached = d
        },
      )
      this.send('position fen ' + fen)
      this.send('go depth ' + depth + (movetime ? ' movetime ' + movetime : ''))
      const best = await done
      const bm = best.split(' ')[1]
      if (!lines[0] && bm && bm !== '(none)') lines[0] = { cp: 0, pv: [bm], depth: 0 }
      return { lines: lines.filter(Boolean), depth: depthReached }
    }
    const r = this.queue.then(job, job)
    this.queue = r.catch(() => {})
    return r
  }
}
