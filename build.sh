#!/bin/bash
# Builds dist/: a static site (index.html + workers + wasm + Maia model parts).
set -e
cd "$(dirname "$0")"
mkdir -p build dist

# Piece set as data URIs
python3 - <<'EOF'
import base64, json
m = {}
for c in 'wb':
    for t in 'KQRBNP':
        data = open(f'assets/pieces-hera/{c}{t}.png', 'rb').read()
        m[c + t] = 'data:image/png;base64,' + base64.b64encode(data).decode()
open('src/pieces.gen.js', 'w').write('export default ' + json.dumps(m))
EOF

# App (inlined into index.html) and Maia worker
npx esbuild src/main.js --bundle --format=esm --minify --define:__GOOGLE_CLIENT_ID__="\"${GOOGLE_CLIENT_ID:-}\"" --outfile=build/app.js --log-level=warning
npx esbuild src/maia-worker.js --bundle --format=iife --minify --define:import.meta.url=self.location.href --outfile=dist/maia-worker.js --log-level=warning
python3 - <<'EOF'
t = open('src/template.html').read()
js = open('build/app.js').read().replace('</script', '<\\/script')
open('dist/index.html', 'w').write(t.replace('/*APP*/', js))
EOF

# Engines
cp node_modules/stockfish/bin/stockfish-19-lite-single.js node_modules/stockfish/bin/stockfish-19-lite-single.wasm dist/
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm dist/
cp assets/pieces-hera/wK.png dist/favicon.png # ícone do site: rei branco do set Hera
cp src/drills.json dist/drills.json # treinos (puzzles do Lichess, CC0)

# Maia model split in 3 parts (some hosts cap file size); .wasm extension so any static host serves it.
if [ ! -f dist/maia3.part2.wasm ] || [ assets/maia3_simplified.onnx -nt dist/maia3.part0.wasm ]; then
  rm -f dist/maia3.part*
  split -b 15300000 -d -a 1 assets/maia3_simplified.onnx dist/maia3.part
  for f in dist/maia3.part?; do mv "$f" "$f.wasm"; done
fi

# Node bundles used by the tests
for f in review uci maia-core puzzles library drills; do
  npx esbuild src/$f.js --bundle --format=esm --platform=node --outfile=build/$f.node.mjs --log-level=warning
done

ls -la dist
