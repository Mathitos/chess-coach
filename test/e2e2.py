import os
import subprocess, time, sys
from playwright.sync_api import sync_playwright
pgn = open('test/game2.pgn').read()
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8765', '-d', 'dist'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1); logs = []
def sqc(pg, sq, flip=False):
    b = pg.locator('#board svg').bounding_box()
    f = 'abcdefgh'.index(sq[0]); r = int(sq[1]) - 1
    x = (7 - f if flip else f) + .5; y = (r if flip else 7 - r) + .5
    return b['x'] + x * b['width'] / 8, b['y'] + y * b['height'] / 8
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.environ.get('CHROME_PATH') or None, args=['--no-sandbox'])
        pg = b.new_page(viewport={'width': 1300, 'height': 1000})
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.goto('http://localhost:8765/index.html')
        pg.fill('#pgn', pgn); pg.fill('#user', 'matheus_anzzulin'); pg.select_option('#depth', 'fast'); pg.uncheck('#useMaia'); pg.click('#go')
        for _ in range(60):
            if pg.inner_text('#st-sf').startswith('pronto'): break
            time.sleep(2)
        print('SF:', pg.inner_text('#st-sf'))
        print('SUMMARY:', pg.inner_text('#summary').replace('\n', ' | '))
        pg.evaluate("document.querySelector('#mv33').click()"); time.sleep(.3)
        print('COACH 17.Nf7:', pg.inner_text('#coach').replace('\n', ' | '))
        pg.click('[data-act=retry]'); time.sleep(.3)
        # wrong attempt: Nf7 -> knight g5 to h7? use a3-a4
        pg.mouse.click(*sqc(pg, 'a3')); time.sleep(.2); pg.mouse.click(*sqc(pg, 'a4')); time.sleep(4)
        print('TRY1:', pg.inner_text('#coach').replace('\n', ' | '))
        pg.click('[data-act=hint]'); time.sleep(.2)
        pg.mouse.click(*sqc(pg, 'd3')); time.sleep(.2)
        pg.locator('#board').screenshot(path='build/retry.png')
        pg.mouse.click(*sqc(pg, 'f5')); time.sleep(1)
        print('TRY2:', pg.inner_text('#coach').replace('\n', ' | '))
        pg.click('[data-act=best]'); time.sleep(2)
        print('LINE:', pg.inner_text('#coach').replace('\n', ' | '))
        pg.locator('#board').screenshot(path='build/line.png')
        pg.click('[data-act=exit]'); pg.evaluate("document.querySelector('#mv27').click()"); time.sleep(.3)
        print('COACH 14.O-O:', pg.inner_text('#coach').replace('\n', ' | '))
        pg.click('[data-act=punish]'); time.sleep(.5); pg.click('[data-act=lnext]'); pg.click('[data-act=lnext]')
        print('PUNISH:', pg.inner_text('#coach').replace('\n', ' | '))
        b.close()
finally:
    srv.terminate()
print('\n'.join(logs))
