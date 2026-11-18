import json, sys, time, random, re, urllib.request
OUT = sys.argv[1]
UA = {'User-Agent': 'chess-coach calibration (github.com/Mathitos/chess-coach)'}
def get(url):
    for i in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r: return json.load(r)
        except Exception as e:
            if '404' in str(e): return None
            time.sleep(2)
games = json.load(open(OUT))
def band(r): return min(5, int(r // 400))  # 0:<400 ... 5:2000+
cnt = [0]*6
for g in games.values(): cnt[band((g['w']+g['b'])/2)] += 1
WANT = 30
def take(user, cap=3):
    d = get(f'https://api.chess.com/pub/player/{user.lower()}/games/2026/11'); time.sleep(0.4)
    n = 0; opps = []
    for g in (d or {}).get('games', []):
        r = (g['white']['rating'] + g['black']['rating']) / 2
        opps.append((g['white']['username'], g['white']['rating'])); opps.append((g['black']['username'], g['black']['rating']))
        if g.get('accuracies') and g.get('rules') == 'chess' and g.get('pgn') and g['url'] not in games and cnt[band(r)] < WANT:
            games[g['url']] = {'pgn': g['pgn'], 'acc': g['accuracies'], 'tc': g.get('time_class'), 'w': g['white']['rating'], 'b': g['black']['rating']}
            cnt[band(r)] += 1; n += 1
            if n >= cap: break
    return opps
random.seed(11)
seeds = []
for t in ['CM', 'NM', 'WCM', 'FM']:
    seeds += random.sample((get(f'https://api.chess.com/pub/titled/{t}') or {}).get('players', []), 8)
queue = list(seeds); seen = set()
t0 = time.time()
while queue and time.time() - t0 < 500 and min(cnt[2:]) < WANT:
    u = queue.pop(0)
    if u.lower() in seen: continue
    seen.add(u.lower())
    opps = take(u)
    # desce de rating: prioriza oponentes de bandas que faltam
    need = [b for b in range(2, 6) if cnt[b] < WANT]
    for name, r in sorted(opps, key=lambda x: -x[1]):
        if band(r) in need and name.lower() not in seen: queue.append(name)
    queue = queue[:400]
json.dump(games, open(OUT, 'w'))
print(len(games), 'partidas; por banda de 400:', cnt)
