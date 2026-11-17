import os, subprocess, time, sys
from playwright.sync_api import sync_playwright
raw = open('test/game-clock.pgn').read()
g2 = open('test/game2.pgn').read()
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8765', '-d', 'dist'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); logs = []
def wait_sf(pg):
    for _ in range(90):
        if pg.inner_text('#st-sf').startswith('pronto'): return
        time.sleep(1)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.environ.get('CHROME_PATH') or None, args=['--no-sandbox'])
        pg = b.new_page(viewport={'width': 1300, 'height': 1050})
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.goto('http://localhost:8765/index.html')
        pg.evaluate("localStorage.clear()"); pg.reload()
        pg.uncheck('#useMaia'); pg.select_option('#depth', 'fast')
        # 1) multi-game PGN, choose game as black
        multi = g2.strip() + '\n\n' + raw.replace('[Event "Live Chess"]', '[Event "Live Chess"]').replace('"matheus_anzzulin"', '"Fulano"').replace('"Ronkolan"', '"matheus_anzzulin"')
        pg.fill('#pgn', multi); time.sleep(.5)
        print('DETECT:', pg.inner_text('#detect').replace('\n', ' | '))
        pg.click('.chip[data-side=b]'); time.sleep(.2)
        print('USER after chip:', pg.input_value('#user'))
        pg.click('#go'); wait_sf(pg)
        print('BARS:', pg.inner_text('#pTop'), '||', pg.inner_text('#pBot'))
        pg.evaluate("document.querySelector('#mv4').click()"); time.sleep(.3)
        print('BARS@4:', pg.inner_text('#pTop'), '||', pg.inner_text('#pBot'))
        print('MOVES:', pg.inner_text('#moves').replace('\n', ' ')[:200])
        pg.screenshot(path='build/clocks.png', clip={'x': 0, 'y': 0, 'width': 1300, 'height': 1050})
        # 2) FEN
        pg.click('#newGame'); pg.fill('#pgn', 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3'); time.sleep(.4)
        print('DETECT FEN:', pg.inner_text('#detect')); pg.click('#go'); time.sleep(3)
        print('FEN COACH:', pg.inner_text('#coach').replace('\n', ' | ')[:200])
        # 3) link (network blocked here -> expect friendly error)
        pg.click('#newGame'); pg.fill('#pgn', 'https://www.chess.com/game/live/187383650428'); time.sleep(.4)
        print('DETECT LINK:', pg.inner_text('#detect')); pg.click('#go'); time.sleep(4)
        print('LINK ERR:', pg.inner_text('#err'))
        b.close()
finally:
    srv.terminate()
print('\n'.join(logs))
