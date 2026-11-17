import os
import subprocess, time, sys
from playwright.sync_api import sync_playwright
hc = int(sys.argv[1]); depth = sys.argv[2]
srv = subprocess.Popen([sys.executable,'-m','http.server','8765','-d','dist'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(1); logs=[]
try:
    with sync_playwright() as p:
        b=p.chromium.launch(executable_path=os.environ.get('CHROME_PATH') or None,args=['--no-sandbox'])
        pg=b.new_page(viewport={'width':1300,'height':1000})
        pg.add_init_script(f"Object.defineProperty(navigator,'hardwareConcurrency',{{get:()=>{hc}}})")
        pg.on('pageerror', lambda e: logs.append(str(e)))
        pg.goto('http://localhost:8765/index.html'); pg.click('#sample'); pg.uncheck('#useMaia'); pg.select_option('#depth',depth); pg.click('#go')
        time.sleep(3); pg.screenshot(path='build/banner.png', clip={'x':0,'y':0,'width':1300,'height':260})
        print('banner:', pg.inner_text('#analyzing').replace('\n',' | '))
        for _ in range(150):
            if pg.inner_text('#st-sf').startswith('pronto'): break
            time.sleep(1)
        print('SF:', pg.inner_text('#st-sf'), '| summary:', pg.inner_text('#summary').replace('\n',' ')[:200])
        b.close()
finally: srv.terminate()
print(logs)
