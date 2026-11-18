# Calibração com a precisão do chess.com

Usa só a API pública do chess.com (partidas que já têm `accuracies`), sem acessar
o site. Passo a passo:

```sh
python3 tools/calib/collect.py /tmp/calib/games.json        # suas partidas + amostra aleatória
python3 tools/calib/collect_more.py /tmp/calib/games.json   # completa as faixas de rating altas
bash build.sh
node tools/calib/analyze.mjs /tmp/calib/games.json /tmp/calib/sf 14 0 1 3600 25   # Stockfish prof. 14, 25 por faixa
node tools/calib/fit.mjs /tmp/calib/games.json /tmp/calib/sf
```

Resultado (nov/2026, 150 partidas, ratings 100 a 2400): a curva do Lichess fica
com RMSE ~10 pontos de precisão por jogador contra o chess.com; curvas por rating
não melhoram fora da amostra. O erro que sobra vem da fórmula de precisão do
chess.com (não publicada), não da curva.
