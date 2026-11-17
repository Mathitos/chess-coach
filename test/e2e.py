import os
import subprocess, time, sys
from playwright.sync_api import sync_playwright

srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8765', '-d', 'dist'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
logs = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.environ.get('CHROME_PATH') or None, args=['--no-sandbox'])
        pg = b.new_page(viewport={'width': 1300, 'height': 1000})
        pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
        pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
        pg.goto('http://localhost:8765/index.html')
        pg.click('#sample')
        pg.select_option('#depth', sys.argv[1] if len(sys.argv) > 1 else 'fast')
        pg.click('#go')
        deadline = time.time() + 240
        while time.time() < deadline:
            st = pg.inner_text('#st-sf'); sm = pg.inner_text('#st-maia')
            if st.startswith('pronto') and (sm.startswith('pronto') or 'erro' in sm or 'não' in sm):
                break
            time.sleep(2)
        print('SF:', pg.inner_text('#st-sf')); print('MAIA:', pg.inner_text('#st-maia'))
        for i in [8, 12, 31, 32, 56]:
            pg.evaluate(f"document.querySelector('#mv{i}').click()")
            time.sleep(0.3)
            print(f'--- ply {i}:', pg.inner_text('#coach')[:900].replace('\n', ' | '))
        pg.evaluate("document.querySelector('#mv12').click()")
        pg.screenshot(path='build/shot.png', full_page=True)
        print('SUMMARY:', pg.inner_text('#summary').replace('\n', ' | '))
        b.close()
finally:
    srv.terminate()
print('\n'.join(l for l in logs if 'error' in l.lower() or 'PAGEERROR' in l)[:3000])
