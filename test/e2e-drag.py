import os, subprocess, time, sys
from playwright.sync_api import sync_playwright
pgn = open('test/game2.pgn').read()
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8765', '-d', 'dist'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); logs = []
def sqc(pg, sq, flip=False):
    b = pg.locator('#board svg').bounding_box()
    f = 'abcdefgh'.index(sq[0]); r = int(sq[1]) - 1
    x = (7 - f if flip else f) + .5; y = (r if flip else 7 - r) + .5
    return b['x'] + x * b['width'] / 8, b['y'] + y * b['height'] / 8
def drag(pg, a, b):
    pg.mouse.move(*sqc(pg, a)); pg.mouse.down(); pg.mouse.move(*sqc(pg, b), steps=8); pg.mouse.up()
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.environ.get('CHROME_PATH') or None, args=['--no-sandbox'])
        pg = b.new_page(viewport={'width': 1300, 'height': 1000})
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.goto('http://localhost:8765/index.html')
        pg.fill('#pgn', pgn); pg.fill('#user', 'matheus_anzzulin'); pg.select_option('#depth', 'fast'); pg.uncheck('#useMaia'); pg.click('#go')
        for _ in range(60):
            if pg.inner_text('#st-sf').startswith('pronto'): break
            time.sleep(1)
        pg.evaluate("document.querySelector('#mv32').click()"); time.sleep(.3)   # position before 17.Nf7 (white to move)
        drag(pg, 'g5', 'f7'); time.sleep(4)
        print('EXPLORE1:', pg.inner_text('#coach').replace('\n', ' | '))
        drag(pg, 'c6', 'g2'); time.sleep(3)
        print('EXPLORE2:', pg.inner_text('#coach').replace('\n', ' | '))
        pg.click('[data-act=xprev]'); pg.click('[data-act=xprev]'); time.sleep(.3)
        # click-click alternative: d3 then f5
        pg.mouse.click(*sqc(pg, 'd3')); time.sleep(.2); pg.mouse.click(*sqc(pg, 'f5')); time.sleep(4)
        print('EXPLORE3:', pg.inner_text('#coach').replace('\n', ' | '))
        pg.locator('#board').screenshot(path='build/explore.png')
        # retry with drag
        pg.click('[data-act=exit]'); pg.evaluate("document.querySelector('#mv33').click()"); time.sleep(.3)
        pg.click('[data-act=retry]'); time.sleep(.3)
        drag(pg, 'a1', 'a2'); time.sleep(4)
        print('RETRY:', pg.inner_text('#coach').replace('\n', ' | '))
        b.close()
finally:
    srv.terminate()
print('\n'.join(logs))
