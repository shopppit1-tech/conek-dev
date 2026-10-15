#!/usr/bin/env python3
import json, os, sys
import whisper

if len(sys.argv) != 2:
    raise SystemExit('usage: transcribe.py AUDIO_PATH')
model_name = os.environ.get('WHISPER_MODEL', 'tiny')
model = whisper.load_model(model_name)
result = model.transcribe(sys.argv[1], task='transcribe', verbose=False)
segments = []
for item in result.get('segments', []):
    text = (item.get('text') or '').strip()
    if text:
        segments.append({'start': round(float(item.get('start', 0)), 2), 'end': round(float(item.get('end', 0)), 2), 'text': text})
print(json.dumps({'language': result.get('language', 'auto'), 'segments': segments}, ensure_ascii=False))
