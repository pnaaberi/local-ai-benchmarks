#!/usr/bin/env python3
"""Bounded installed-model fit check. Outputs are never executed; no downloads.
Run with reviewed benchmark.py beside this file and an explicit shared lock path.
Candidate syntax: public display name=existing local Ollama tag.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import time
import urllib.request

BASE = 'http://127.0.0.1:11434'
BASELINE_SHA = 'f59706898cc0f76faab9748fc44b107dc5740afb8432d6ecd07b38d43c671847'
OPTIONS = {'num_ctx': 4096, 'num_predict': 128, 'temperature': 0, 'seed': 42}
GAME_PATTERNS = ('/steamapps/common/', 'gamescope', 'wine64-preloader', 'proton waitforexitandrun', 'lutris-wrapper', 'heroic')


def api(path, payload=None):
    body = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(BASE + path, data=body, headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)


def sample(device):
    monitor = next((device / 'hwmon').glob('hwmon*'))
    temperatures = {}
    for label in monitor.glob('temp*_label'):
        value = int(label.with_name(label.name.replace('_label','_input')).read_text()) / 1000
        temperatures[label.read_text().strip().lower()] = value
    fields = dict(line.split(':',1) for line in Path('/proc/meminfo').read_text().splitlines())
    available = int(fields['MemAvailable'].split()[0]) * 1024
    if not temperatures or not any('edge' in label or 'junction' in label for label in temperatures):
        raise RuntimeError('Missing temperature admission evidence')
    if available < 3 * 1024**3:
        raise RuntimeError('Less than 3 GiB available RAM')
    if any(value >= (90 if 'mem' in label else 78) for label,value in temperatures.items()):
        raise RuntimeError('Temperature admission limit: core/junction 78 C, memory 90 C')
    processes = subprocess.run(['ps','-eo','args='],capture_output=True,text=True,check=True,timeout=10).stdout.lower()
    if any(pattern in processes for pattern in GAME_PATTERNS):
        raise RuntimeError('Gaming process detected')
    return {'temperatures_c':temperatures, 'ram_available_bytes':available,
            'vram_used_bytes':int((device / 'mem_info_vram_used').read_text()),
            'gpu_busy_percent':int((device / 'gpu_busy_percent').read_text())}


def correct(output, expected):
    try:
        value = json.loads(output)
        return type(value) is dict and value.keys() == expected.keys() and all(
            type(value[key]) is type(expected[key]) and value[key] == expected[key] for key in value)
    except (ValueError,TypeError):
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output',required=True,type=Path)
    parser.add_argument('--lock-path',required=True,type=Path)
    parser.add_argument('--candidate',action='append',required=True)
    args = parser.parse_args()
    baseline = Path(__file__).with_name('benchmark.py')
    if hashlib.sha256(baseline.read_bytes()).hexdigest() != BASELINE_SHA:
        raise RuntimeError('Reviewed baseline changed')
    spec = importlib.util.spec_from_file_location('reviewed_benchmark',baseline)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    candidates = [candidate.split('=',1) for candidate in args.candidate]
    if any(len(candidate) != 2 for candidate in candidates):
        raise RuntimeError('Candidate must be public-name=existing-tag')
    args.output.mkdir(parents=True,exist_ok=False)
    if shutil.disk_usage(args.output).free < 30 * 1024**3:
        raise RuntimeError('Disk reserve below 30 GiB')
    # Shared with the existing GPU evaluator. Never unlink a shared lock inode.
    descriptor = os.open(args.lock_path,os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW,0o600)
    with os.fdopen(descriptor,'r+') as lease:
        fcntl.flock(lease,fcntl.LOCK_EX | fcntl.LOCK_NB)
        if api('/api/ps')['models']:
            raise RuntimeError('Another model resident; no eviction')
        device = next(path for path in Path('/sys/class/drm').glob('card*/device') if (path/'mem_info_vram_total').exists())
        first = sample(device)
        if first['gpu_busy_percent'] >= 25:
            raise RuntimeError('GPU already busy')
        tags = {model['name']:model for model in api('/api/tags')['models']}
        result = {'schema':'installed-model-fit.v1','machine_alias':'RDNA4-16',
                  'runtime':api('/api/version'),'options':OPTIONS,'cases':module.CASES,
                  'repeats_per_case':3,'profiles':[],
                  'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                  'limitations':['Short JSON tasks; not general quality or 4K input acceptance.',
                                 'Thinking disabled when supported; warm prompt cache not disabled.',
                                 'Resource samples before/after calls, not continuous thermal protection.',
                                 'Existing local tags, upstream provenance not independently verified.']}
        deadline = time.monotonic() + 720
        for display,tag in candidates:
            profile = {'name':display,'status':'blocked','runs':[],'samples':[]}
            result['profiles'].append(profile)
            active = False
            abort = False
            try:
                if time.monotonic() > deadline or api('/api/ps')['models']:
                    raise RuntimeError('Runtime limit or concurrent model')
                profile['samples'].append(sample(device))
                entry = tags[tag]
                show = api('/api/show',{'model':tag})
                profile.update(manifest_digest=entry['digest'],artifact_size_bytes=entry['size'],details=entry.get('details',{}))
                think_off = 'thinking' in show.get('capabilities',[])
                profile['thinking_disabled'] = think_off
                payload = {'model':tag,'format':'json','stream':False,'keep_alive':'30s','options':OPTIONS}
                if think_off:
                    payload['think'] = False
                active = True
                started = time.monotonic()
                api('/api/generate',dict(payload,prompt='Return JSON {"ready":true}'))
                profile['warmup_s'] = round(time.monotonic()-started,6)
                resident = next(model for model in api('/api/ps')['models'] if model['name'] == tag)
                if resident['digest'] != entry['digest']:
                    raise RuntimeError('Digest changed')
                profile.update(resident_size_bytes=resident['size'],resident_vram_bytes=resident.get('size_vram',0))
                if resident.get('size_vram',0) < .90 * resident['size']:
                    raise RuntimeError('GPU residency below 90%; CPU-offload profile blocked')
                for repeat in range(1,4):
                    for case in module.CASES:
                        if time.monotonic() > deadline:
                            raise RuntimeError('Runtime limit')
                        if any(model['name'] != tag for model in api('/api/ps')['models']):
                            raise RuntimeError('Concurrent model detected')
                        profile['samples'].append(sample(device))
                        started = time.monotonic()
                        response = api('/api/generate',dict(payload,prompt=case['prompt']))
                        elapsed = time.monotonic()-started
                        row = {'case_id':case['id'],'repeat':repeat,'elapsed_s':round(elapsed,6),
                               'output':response.get('response',''),'expected':case['expected'],
                               'done_reason':response.get('done_reason')}
                        row['passed'] = correct(row['output'],row['expected'])
                        for field in ('total_duration','load_duration','prompt_eval_count','prompt_eval_duration','eval_count','eval_duration'):
                            row[field] = response.get(field)
                        profile['runs'].append(row)
                        profile['samples'].append(sample(device))
                        print(json.dumps({'model':display,'case':case['id'],'repeat':repeat,'passed':row['passed'],'elapsed_s':row['elapsed_s']}),flush=True)
                if next(model for model in api('/api/tags')['models'] if model['name'] == tag)['digest'] != entry['digest']:
                    raise RuntimeError('Post-run digest changed')
                profile['status'] = 'completed'
                profile['correct'] = sum(row['passed'] for row in profile['runs'])
                profile['median_latency_s'] = statistics.median(row['elapsed_s'] for row in profile['runs'])
                rates = [row['eval_count']/(row['eval_duration']/1e9) for row in profile['runs'] if row.get('eval_duration') and row.get('eval_count')]
                profile['median_decode_tps'] = statistics.median(rates) if rates else None
            except Exception as error:
                profile['reason'] = str(error) if isinstance(error,RuntimeError) else type(error).__name__
                print(json.dumps({'model':display,'status':'blocked','reason':profile['reason']}),flush=True)
                abort = isinstance(error,RuntimeError) and any(word in str(error) for word in ('RAM','Temperature','Gaming','Concurrent','concurrent','Digest','digest','Runtime'))
            finally:
                if active:
                    try:
                        api('/api/generate',{'model':tag,'keep_alive':0})
                    except Exception:
                        profile['cleanup'] = 'Unload unverified; 30-second keepalive expiry'
                (args.output/'fits.json').write_text(json.dumps(result,indent=2)+'\n')
            if abort:
                break
        result['cleanup_empty'] = not api('/api/ps')['models']
        (args.output/'fits.json').write_text(json.dumps(result,indent=2)+'\n')
    return 0 if all(profile['status']=='completed' for profile in result['profiles']) else 2


if __name__ == '__main__':
    raise SystemExit(main())
