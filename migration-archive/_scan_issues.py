
import re, io
from pathlib import Path
REPO = Path(r'C:\Users\ka092\Desktop\HornScribe')
out = io.open(REPO/'_scan_out.txt','w',encoding='utf-8')
files = sorted(list(REPO.glob('_issue*')) + list((REPO/'.work').glob('issue*')) + list((REPO/'.work').glob('new-issue*')) + list(REPO.glob('_issues*')))
for f in files:
    if f.suffix == '.py' or f.is_dir(): continue
    try:
        t = f.read_text(encoding='utf-8', errors='replace')
    except Exception as e:
        out.write(f'{f.name}\tERR {e}\n'); continue
    first = ' '.join(t.strip().split()[:16])
    refs = sorted(set(int(m) for m in re.findall(r'#(\d+)', t)))
    out.write(f'{f.name}\trefs={refs[:10]}\t{first[:160]}\n')
out.close()

