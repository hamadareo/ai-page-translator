#!/usr/bin/env python3
"""Print the Chrome extension ID derived from manifest.json's "key" (SHA-256 of the DER key, a-p alphabet)."""
import base64
import hashlib
import json
import sys

with open(sys.argv[1], encoding='utf-8') as f:
    key = json.load(f)['key']
digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
print(''.join(chr(ord('a') + int(c, 16)) for c in digest))
