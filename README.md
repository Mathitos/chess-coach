# ♞ Chess Coach

Review de partidas de xadrez lance a lance, no estilo do Game Review do chess.com, rodando **100% no navegador**: sem servidor, sem API key, sem conta.

**App:** https://mathitos.github.io/chess-coach/

Cola a partida do jeito que o chess.com ou o Lichess compartilham (PGN com ou sem tempo, arquivo com várias partidas, link da partida ou FEN) e o app:

- **classifica cada lance** (Brilhante, Ótimo, Melhor, Excelente, Bom, Imprecisão, Erro, Chance perdida, Capivarada) e calcula a precisão de cada jogador;
- **explica o porquê**: peça pendurada, garfo, cravada, mate permitido, ameaça ignorada, rei exposto, peças sem desenvolver, roque pro lado errado, e o que o melhor lance faria;
- **mostra o que humanos do seu nível jogariam** (Maia-3), inclusive quem acharia o melhor lance em cada faixa de rating;
- **Tentar de novo**: nos seus erros, você joga no tabuleiro e o Stockfish confere se achou um lance bom;
- **Ver continuação**: anima no tabuleiro a melhor linha e a punição do adversário;
- mostra o **relógio** de cada jogador em cada momento e o **tempo gasto** em cada lance (a partir do `[%clk]` do PGN);
- **explorar variantes**: arrasta qualquer peça pra testar lances, com avaliação e classificação do Stockfish;
- exporta o **PGN anotado** com os comentários.

Links do chess.com são buscados pela [API pública](https://www.chess.com/news/view/published-data-api) no arquivo do usuário informado (últimos 3 meses); links do Lichess pela API de export. Isso depende de CORS do navegador, então não funciona dentro do claude.ai, só na versão hospedada.

## Como funciona

| Peça | O que faz |
|---|---|
| [Stockfish 19](https://github.com/nmrugg/stockfish.js) (lite, single-thread, WASM) | Avaliação, melhor lance e linha de cada posição (MultiPV 2), mais uma busca de "lance nulo" pra achar a ameaça do adversário. Roda até 4 engines em paralelo (um por núcleo livre). |
| [Maia-3](https://github.com/CSSLab/maia-platform-frontend) (ONNX, via onnxruntime-web) | Rede treinada em partidas humanas: probabilidade de cada lance pra um jogador de 600 a 2600 de rating. |
| `src/review.js` | Classificação, precisão e texto do coach. |

**Classificação.** Converte a avaliação em chance de vitória com a [curva publicada pelo Lichess](https://lichess.org/page/accuracy) e aplica as faixas de pontos esperados do [chess.com](https://support.chess.com/en/articles/8572705-how-are-moves-classified-what-is-a-blunder-or-brilliant-and-etc) (Excelente < 2%, Bom < 5%, Imprecisão < 10%, Erro < 20%, Capivarada acima). Regras extras pra Ótimo (único lance bom), Brilhante (sacrifício correto), Chance perdida (não puniu o erro do adversário) e uma trava de material: entregar 4+ pontos nunca conta como simples imprecisão. A fórmula exata do chess.com é fechada, então os rótulos batem na maioria dos lances, mas não em todos.

**Coach.** Texto gerado por templates a partir dos dados do engine e de detecção de motivos táticos e posicionais com [chess.js](https://github.com/jhlywa/chess.js). Nenhum LLM envolvido.

## Rodando

Precisa de Node 18+ e Python 3 (o build usa um script Python curto).

```bash
npm install
npm run build      # gera dist/
npm run serve      # http://localhost:8765
```

`dist/` é um site estático: dá pra hospedar em GitHub Pages, Netlify, Cloudflare Pages etc. Este repo publica no GitHub Pages a cada push na `main` (`.github/workflows/pages.yml`). O Stockfish e o Maia rodam em Web Workers; não precisa de `SharedArrayBuffer`/COOP/COEP.

O modelo do Maia (`assets/maia3_simplified.onnx`, 45 MB) é dividido em 3 partes no build e baixado pelo navegador na primeira análise.

### Testes

```bash
npm test                         # review completo de test/game.pgn em Node (Stockfish + Maia)
npm run test:maia                # sanity do Maia em Node
pip install playwright && python3 test/e2e2.py   # end-to-end no Chrome (CHROME_PATH opcional)
```

## Estrutura

```
src/
  main.js         UI: tabuleiro SVG, painel do coach, modos "tentar de novo" e "ver continuação"
  review.js       classificação, precisão, motivos táticos/posicionais e textos
  uci.js          cliente UCI mínimo (Web Worker ou Node)
  maia-core.js    pré/pós-processamento do Maia-3 (port do maia-platform-frontend)
  maia-worker.js  worker com onnxruntime-web
  template.html   HTML/CSS (o JS é embutido no build)
assets/           modelo do Maia, índice de lances, peças
test/             partidas de exemplo e testes
```

## Créditos e licenças

- Código deste repositório: **GPL-3.0-or-later** (ver `LICENSE`).
- [Stockfish](https://stockfishchess.org/) / [stockfish.js](https://github.com/nmrugg/stockfish.js): GPL-3.0.
- [Maia-3](https://www.maiachess.com/) e o pré-processamento portado de [CSSLab/maia-platform-frontend](https://github.com/CSSLab/maia-platform-frontend): GPL-3.0. Modelo `maia3_simplified.onnx` do mesmo repositório.
- [onnxruntime-web](https://github.com/microsoft/onnxruntime): MIT.
- [chess.js](https://github.com/jhlywa/chess.js): BSD-2-Clause.
- Peças **Staunty** por sadsnake1, via [Lichess](https://github.com/lichess-org/lila/blob/master/COPYING.md): [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) (uso não comercial).
- Curva de chance de vitória e fórmula de precisão: [Lichess](https://lichess.org/page/accuracy).
