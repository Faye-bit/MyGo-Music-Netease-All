"""Build a deterministic installable plugin zip; never package host data."""
from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parent.parent
plugin = root / 'plugin'
manifest = json.loads((plugin / 'plugin.json').read_text())
assert manifest['id'] == 'netease-all'
assert manifest['main'] == 'index.js'
repository_manifest = json.loads((root / 'plugin.json').read_text())
assert repository_manifest == {**manifest, 'main': 'plugin/index.js'}
files = ['plugin.json', 'index.js', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md']
assets = [f'assets/{name}.png' for name in ['charts', 'roam', 'familiar', 'explore']]
files += assets
output = root / f"netease-all-{manifest['version']}.zip"
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    for name in files:
        info = zipfile.ZipInfo(name, date_time=(2026, 11, 8, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, ((root if name in assets else plugin) / name).read_bytes())
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
    assert archive.namelist() == files
sha = hashlib.sha256(output.read_bytes()).hexdigest()
(root / (output.name + '.sha256')).write_text(f'{sha}  {output.name}\n')
print(f'{output.name}: {output.stat().st_size} bytes; SHA-256 {sha}')
