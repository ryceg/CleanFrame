"""Build the private Home Assistant overlay used by preview and local packaging.

The HA address and long-lived token live in ignored .local/homeassistant.json:
{"url": "https://ha.example", "token": "...", "art_entity": "image.x"}
Public exports and checkouts without that file keep the inert app/assets/ha-config.js.
"""
from pathlib import Path
from urllib.parse import urlsplit
import json
import re

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / '.local/homeassistant.json'
KEYS = ['art_entity', 'weather', 'weather_max', 'weather_text', 'weather_rain', 'heat_pump', 'frame_player']


def ha_config(root=ROOT):
    path = root / '.local/homeassistant.json'
    if not path.is_file():
        return None
    config = json.loads(path.read_text())
    url = str(config.get('url', '')).rstrip('/')
    parts = urlsplit(url)
    if parts.scheme not in ['http', 'https'] or not parts.netloc or not config.get('token'):
        raise SystemExit('.local/homeassistant.json needs an http(s) "url" and a "token".')
    result = {'url': url, 'token': str(config['token'])}
    for key in KEYS:
        if config.get(key):
            result[key] = str(config[key])
    return result


def ha_overlay(root=ROOT, include_private=True):
    """Return package-relative paths mapped to bytes. Empty without private HA config."""
    config = ha_config(root) if include_private else None
    if not config:
        return {}
    origin = '{0.scheme}://{0.netloc}'.format(urlsplit(config['url']))
    manifest = (root / 'app/config.xml').read_text()
    access = '  <access origin="' + origin + '" subdomains="false"/>\n'
    # Tizen's network whitelist: the HA origin is the only remote origin the widget may reach.
    manifest = re.sub(r'(\n</widget>)', '\n' + access.rstrip('\n') + r'\1', manifest, count=1)
    return {
        'assets/ha-config.js': ('window.GrayFrameHA = ' + json.dumps(config) + ';\n').encode(),
        'config.xml': manifest.encode(),
    }
