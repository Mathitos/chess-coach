# ♞ Chess Coach

Review de partidas de xadrez lance a lance, no estilo do Game Review do chess.com, rodando **100% no navegador**: sem servidor, sem API key, sem conta.

**App:** https://mathitos.github.io/chess-coach/

Cola a partida do jeito que o chess.com ou o Lichess compartilham (PGN com ou sem tempo, arquivo com várias partidas, link da partida ou FEN) e o app:

- **classifica cada lance** (Brilhante, Ótimo, Melhor, Excelente, Bom, Imprecisão, Erro, Chance perdida, Capivarada) e calcula a precisão de cada jogador;
- **explica o porquê**: peça pendurada, garfo, cravada, mate permitido, ameaça ignorada, rei exposto, peças sem desenvolver, roque pro lado errado, e o que o melhor lance faria;
- **mostra o que humanos do seu nível jogariam** (Maia-3), inclusive quem acharia o melhor lance em cada faixa de rating;
- **Tentar de novo**: nos seus erros, você joga no tabuleiro e o Stockfish confere se achou um lance bom;
- **Explicar**: percorre a melhor linha (ou a punição) lance a lance, com um comentário e setas em cada passo; avança no seu ritmo ou em autoplay de 1,5s;
- **Revisão guiada**: passa pelos momentos-chave (seus erros, erros do adversário que você podia punir, seus lances bons), dando autoplay de 1,5s por lance até cada um e abrindo um puzzle de "ache o lance";
- **Mostrar…**: botões que desenham no tabuleiro o garfo, a peça pendurada, o mate, a ameaça ou a ideia do melhor lance; lances e casas citados no texto do coach acendem no tabuleiro ao passar o mouse;
- **Variantes**: arraste qualquer peça pra abrir um fork; ele fica salvo no histórico da partida;
- mostra o **relógio** de cada jogador em cada momento e o **tempo gasto** em cada lance (a partir do `[%clk]` do PGN);
- **explorar variantes**: arrasta qualquer peça pra testar lances, com avaliação e classificação do Stockfish;
- exporta o **PGN anotado** com os comentários.
- **Lances humanos** (Maia): painel com os lances que jogadores de cada nível jogariam na posição, com seletor de rating e chance de vitória; clique joga o lance como variante;
- **Treinos**: 9 temas clássicos em 5 fases (puzzles do banco aberto do Lichess, CC0) e a trilha **Ache o mate**, com posições enviadas e conferidas pelo Stockfish (`tools/add-mate.mjs`);
- **Mates perdidos** marcados no replay (♚), no resumo e nos desafios;
- **Minhas partidas** (⚙ no canto de cima): busca suas partidas recentes no chess.com ou no Lichess pelas APIs públicas (sem login nesses sites), analisa em lote começando pelas mais recentes, mostra o progresso e deixa cancelar sem perder as que já terminaram. O card **Seus padrões** agrega os tipos de erro mais frequentes (deixou mate, mate que passou, não puniu o adversário, entregou material, tática que passou, abertura, posicional, e quantos foram com pouco tempo);
- **Desafios**: seus erros e as chances de punir viram desafios com revisão espaçada, salvos no seu Google Drive (pasta oculta do app). No fim de cada desafio aparece de qual partida ele veio, com link pra partida original.

**Sessão do Google.** O app não tem backend, então usa o fluxo de token do Google Identity Services: o token vale ~1h e o Google não entrega refresh token pra app só de navegador. O app guarda o token enquanto ele vale (recarregar a página não pede login), renova no primeiro clique quando faltam menos de 10 min e, se já venceu, no próximo clique (o popup do Google abre e fecha sozinho). A conta fica lembrada até você clicar em Sair.

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

`dist/` é um site estático: dá pra hospedar em GitHub Pages, Netlify, Cloudflare Pages etc. Este repo publica no GitHub Pages a cada push na `main` com os testes passando (`.github/workflows/ci.yml`). O Stockfish e o Maia rodam em Web Workers; não precisa de `SharedArrayBuffer`/COOP/COEP.

O modelo do Maia (`assets/maia3_simplified.onnx`, 45 MB) é dividido em 3 partes no build e baixado pelo navegador na primeira análise.

### Testes

```bash
npm test                           # unitários: entrada/relógio, Stockfish + classificação, Maia (Node)
npx playwright install chromium    # uma vez
npm run test:e2e                   # end-to-end no Chromium (CHROME_PATH=/caminho/do/chrome pra usar um Chrome local)
npm run review -- test/game.pgn 14 # imprime o review de uma partida no terminal
```

O GitHub Actions (`.github/workflows/ci.yml`) roda os dois em todo push e pull request, e só publica no GitHub Pages se passarem.

## Desafios e login com Google

Os momentos-chave de cada partida (seus erros e as chances de punir o adversário) podem ser salvos como **desafios**. A tela **🎯 Treinar** mostra os que estão pra revisar, com repetição espaçada (acertou de primeira: volta em 1, 3, 7, 16 e 35 dias; errou: volta logo).

Sem login, os desafios ficam no navegador. Com **Entrar com Google**, ficam num arquivo oculto do app no Google Drive de cada pessoa (escopo `drive.appdata`, que só enxerga os arquivos do próprio app) e sincronizam entre aparelhos. Não tem servidor: o navegador fala direto com o Google.

Pra ligar o login (uma vez):

1. [Google Cloud Console](https://console.cloud.google.com/) → crie um projeto.
2. **APIs e serviços → Biblioteca** → ative a **Google Drive API**.
3. **Tela de consentimento OAuth**: tipo *Externo*, escopos `.../auth/drive.appdata`, `openid`, `email`, `profile`. Enquanto estiver em *Teste*, só entram os e-mails cadastrados em **Usuários de teste** (até 100).
4. **Credenciais → Criar credenciais → ID do cliente OAuth** → *Aplicativo da Web*. Em **Origens JavaScript autorizadas**: `https://mathitos.github.io` (e `http://localhost:8765` pra desenvolver).
5. Copie o Client ID e, no GitHub, crie a variável **`GOOGLE_CLIENT_ID`** em *Settings → Secrets and variables → Actions → Variables*. Rode o CI de novo.

Local: `GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com npm run build`. Sem a variável, o app funciona igual, só sem o botão do Google.

## Estrutura

```
src/
  main.js         UI: tabuleiro SVG, painel do coach, modos "tentar de novo" e "ver continuação"
  review.js       classificação, precisão, motivos táticos/posicionais e textos
  uci.js          cliente UCI mínimo (Web Worker ou Node)
  maia-core.js    pré/pós-processamento do Maia-3 (port do maia-platform-frontend)
  maia-worker.js  worker com onnxruntime-web
  puzzles.js      desafios salvos: agenda de revisão e merge entre aparelhos
  gdrive.js       login Google (Identity Services) + arquivo no appDataFolder do Drive
  template.html   HTML/CSS (o JS é embutido no build)
assets/           modelo do Maia, índice de lances, peças
test/             partidas de exemplo, testes unitários (node:test) e end-to-end (Playwright)
```

## Créditos e licenças

- Código deste repositório: **GPL-3.0-or-later** (ver `LICENSE`).
- [Stockfish](https://stockfishchess.org/) / [stockfish.js](https://github.com/nmrugg/stockfish.js): GPL-3.0.
- [Maia-3](https://www.maiachess.com/) e o pré-processamento portado de [CSSLab/maia-platform-frontend](https://github.com/CSSLab/maia-platform-frontend): GPL-3.0. Modelo `maia3_simplified.onnx` do mesmo repositório.
- [onnxruntime-web](https://github.com/microsoft/onnxruntime): MIT.
- [chess.js](https://github.com/jhlywa/chess.js): BSD-2-Clause.
- Peças **Hera** por Toan Hoang ([HollowLeaf1981/ChessPieces](https://github.com/HollowLeaf1981/ChessPieces)): [MIT](assets/pieces-hera/LICENSE).
- Curva de chance de vitória e fórmula de precisão: [Lichess](https://lichess.org/page/accuracy).
