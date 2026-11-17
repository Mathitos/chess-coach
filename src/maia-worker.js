// Maia3 worker: loads ONNX Runtime (bundled) + the model split in parts.
import * as ort from 'onnxruntime-web/wasm'
import { preprocess, postprocess } from './maia-core.js'

let session = null

async function fetchWithProgress(urls, totalBytes) {
  const parts = []
  let got = 0
  for (const u of urls) {
    const res = await fetch(u)
    if (!res.ok) throw new Error(u + ': HTTP ' + res.status)
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
      got += value.length
      postMessage({ type: 'progress', progress: Math.min(99, Math.floor((got / totalBytes) * 100)) })
    }
  }
  const buf = new Uint8Array(got)
  let o = 0
  for (const p of parts) { buf.set(p, o); o += p.length }
  return buf
}

self.onmessage = async (e) => {
  const msg = e.data
  try {
    if (msg.type === 'init') {
      postMessage({ type: 'status', status: 'loading' })
      ort.env.wasm.numThreads = 1
      ort.env.wasm.proxy = false
      const wasm = await (await fetch(msg.ortWasm)).arrayBuffer()
      ort.env.wasm.wasmBinary = wasm
      const model = await fetchWithProgress(msg.modelParts, msg.modelBytes)
      session = await ort.InferenceSession.create(model, { graphOptimizationLevel: 'basic', executionProviders: ['wasm'] })
      postMessage({ type: 'status', status: 'ready' })
    } else if (msg.type === 'run') {
      // msg.items: [{fen, elo}] ; elo_self == elo_oppo == elo
      const out = []
      const B = 16
      for (let s = 0; s < msg.items.length; s += B) {
        const chunk = msg.items.slice(s, s + B)
        const pres = chunk.map((it) => preprocess(it.fen))
        const toks = new Float32Array(chunk.length * 768)
        pres.forEach((p, i) => toks.set(p.tokens, i * 768))
        const elos = Float32Array.from(chunk.map((it) => it.elo))
        const r = await session.run({
          tokens: new ort.Tensor('float32', toks, [chunk.length, 64, 12]),
          elo_self: new ort.Tensor('float32', elos, [chunk.length]),
          elo_oppo: new ort.Tensor('float32', Float32Array.from(chunk.map((it) => it.eloOppo ?? it.elo)), [chunk.length]),
        })
        const lm = r.logits_move.data, lv = r.logits_value.data
        const M = lm.length / chunk.length
        chunk.forEach((it, i) => {
          const res = postprocess(pres[i], lm.subarray(i * M, (i + 1) * M), lv.subarray(i * 3, i * 3 + 3))
          // keep only moves >= 0.5% to shrink messages
          const pol = {}
          for (const [m, p] of Object.entries(res.policy)) if (p >= 0.005) pol[m] = p
          out.push({ key: it.key, policy: pol, full: it.wantMove ? res.policy[it.wantMove] ?? 0 : undefined, winStm: res.winStm })
        })
        postMessage({ type: 'progress-run', id: msg.id, done: Math.min(msg.items.length, s + B), total: msg.items.length })
      }
      postMessage({ type: 'result', id: msg.id, out })
    }
  } catch (err) {
    postMessage({ type: 'error', id: msg.id, message: String(err && err.message || err) })
  }
}
