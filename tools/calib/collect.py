import json, os, sys, time, random, urllib.request
OUT = sys.argv[1]
UA = {'User-Agent': 'chess-coach calibration (github.com/Mathitos/chess-coach)'}
def get(url):
    for i in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                return json.load(r)
        except Exception as e:
            if '404' in str(e): return None
            time.sleep(2)
    return None
games = {}
def take(user, months=('2026/11', '2026/10'), cap=4):
    n = 0
    for m in months:
        d = get(f'https://api.chess.com/pub/player/{user.lower()}/games/{m}')
        time.sleep(0.4)
        for g in (d or {}).get('games', []):
            if g.get('accuracies') and g.get('rules') == 'chess' and g.get('pgn') and g['url'] not in games:
                games[g['url']] = {'pgn': g['pgn'], 'acc': g['accuracies'], 'tc': g.get('time_class'), 'w': g['white']['rating'], 'b': g['black']['rating']}
                n += 1
                if n >= cap: return
for u in ['matheus_anzzulin', 'kagaro_na_kamura']:
    take(u, cap=40)
# amostra variada de ratings: jogadores brasileiros aleatórios
lst = (get('https://api.chess.com/pub/country/BR/players') or {}).get('players', [])
random.seed(7); random.shuffle(lst)
for u in lst[:220]:
    take(u, months=('2026/11',), cap=3)
    if len(games) >= 160: break
json.dump(games, open(OUT, 'w'))
rs = sorted((g['w'] + g['b']) / 2 for g in games.values())
print(len(games), 'partidas; ratings', rs[0], rs[len(rs)//4], rs[len(rs)//2], rs[3*len(rs)//4], rs[-1])
