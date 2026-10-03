#!/usr/bin/env python3
"""Bounded real inference on existing weights. No model output is executed.
Public result projection is an explicit allowlist; private host identity is never collected.
"""
import hashlib
import json
import platform
import shutil
import sys
import threading
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE = 'http://127.0.0.1:11434'
MODELS = ['qwen2.5-coder:14b', 'ministral-3:14b-instruct-2512-q4_K_M']
CASES = [
    {'id': 'hardware-extraction', 'task': 'Convert measured hardware facts into JSON',
     'prompt': 'Extract only these measured facts: CPU AMD Ryzen 7 5800X, 8 cores, 16 threads. Installed RAM 16 GB. GPU VRAM 16 GB. Return exactly JSON keys cores, threads, ram_gb, vram_gb with numeric values. No explanation.',
     'expected': {'cores': 8, 'threads': 16, 'ram_gb': 16, 'vram_gb': 16}},
    {'id': 'storage-aggregation', 'task': 'Aggregate actual installed storage capacities',
     'prompt': 'Installed disks: Samsung SSD 990 PRO 2TB, capacity 2000398934016 bytes; Samsung SSD 860 EVO 1TB, capacity 1000204886016 bytes. Ignore virtual RAM disks. Return JSON with disk_count and total_bytes. Calculate the exact total; no explanation.',
     'expected': {'disk_count': 2, 'total_bytes': 3000603820032}},
    {'id': 'finnish-hardware-extraction', 'task': 'Extract actual hardware facts from Finnish text',
     'prompt': 'Poimi tiedot JSON-muodossa. Koneessa on Ryzen 7 5800X: 8 ydintä ja 16 säiettä. Emolevy on ASUS TUF GAMING B550-PLUS. Verkkokortti on Realtek RTL8125, 2.5 GbE. Vastaa vain avaimilla cores, threads, ethernet_gbps; arvot numeroina.',
     'expected': {'cores': 8, 'threads': 16, 'ethernet_gbps': 2.5}},
]

def api(path, payload=None, timeout=120):
    body = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(BASE + path, data=body, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.load(response)


def number(path):
    try:
        return int(path.read_text().strip())
    except (OSError, ValueError):
        return None


def available_ram():
    fields = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
    return int(fields['MemAvailable'].split()[0]) * 1024


def gpu_paths():
    for device in Path('/sys/class/drm').glob('card*/device'):
        if number(device / 'mem_info_vram_total'):
            return device, next(iter((device / 'hwmon').glob('hwmon*')), None)
    raise RuntimeError('GPU telemetry unavailable')


def telemetry(device, hwmon):
    temps = [number(p) for p in hwmon.glob('temp*_input')] if hwmon else []
    temps = [v / 1000 for v in temps if v is not None]
    power = number(hwmon / 'power1_average') if hwmon else None
    return {'at_monotonic_s': round(time.monotonic(), 3),
            'vram_used_bytes': number(device / 'mem_info_vram_used'),
            'gpu_busy_percent': number(device / 'gpu_busy_percent'),
            'max_gpu_sensor_c': max(temps) if temps else None,
            'gpu_power_w': power / 1000000 if power is not None else None,
            'ram_available_bytes': available_ram()}


def main():
    output = Path(sys.argv[1])
    output.mkdir(parents=True, exist_ok=False)
    if shutil.disk_usage(output).free < 30 * 1024**3:
        raise RuntimeError('Less than 30 GiB disk reserve')
    if api('/api/ps')['models']:
        raise RuntimeError('Another model is resident; no eviction authorized')
    device, hwmon = gpu_paths()
    tags = {m['name']: m for m in api('/api/tags')['models']}
    selected = [(name, tags[name]) for name in MODELS]
    runtime = shutil.which('ollama')
    runtime_hash = hashlib.sha256(Path(runtime).read_bytes()).hexdigest()
    samples = []
    stopped = threading.Event()
    unsafe = threading.Event()

    def sample():
        while not stopped.is_set():
            try:
                item = telemetry(device, hwmon)
                samples.append(item)
                if item['ram_available_bytes'] < 1024**3 or (item['max_gpu_sensor_c'] or 0) > 95:
                    unsafe.set()
            except Exception:
                unsafe.set()
            stopped.wait(1)

    thread = threading.Thread(target=sample, daemon=True)
    thread.start()
    result = {'schema': 'local-inference-observation.v1', 'machine_alias': 'RDNA4-16',
              'started_at': datetime.now(timezone.utc).isoformat(),
              'runtime': {'name': 'Ollama', 'version': api('/api/version')['version'], 'executable_sha256': runtime_hash},
              'kernel': platform.release(), 'vram_total_bytes': number(device / 'mem_info_vram_total'),
              'options': {'num_ctx': 4096, 'num_predict': 128, 'temperature': 0, 'seed': 42},
              'concurrency': 1, 'repeats_per_case': 3, 'cases': CASES, 'models': [], 'runs': [],
              'limitations': ['Small real-inference data-transformation corpus, not broad model acceptance.',
                              'No HIP/Vulkan A/B, long-context, tool execution, security, soak or calibration acceptance.',
                              'GPU board power is not whole-system energy; sysfs telemetry is observational.',
                              'Model tag manifests are pinned; upstream/conversion provenance remains unverified.',
                              'Backend library version is unverified; do not infer ROCm 10 from the handbook.']}
    current = None
    deadline = time.monotonic() + 900
    try:
        for name, tag in selected:
            current = name
            if unsafe.is_set() or time.monotonic() > deadline:
                raise RuntimeError('Safety/resource/run-time limit')
            started = time.monotonic()
            warm = api('/api/generate', {'model': name, 'prompt': 'Return JSON {"ready":true}',
                       'format': 'json', 'stream': False, 'keep_alive': '3m', 'options': result['options']})
            resident = next(m for m in api('/api/ps')['models'] if m['name'] == name)
            if resident.get('digest') != tag['digest']:
                raise RuntimeError('Model digest changed')
            if resident.get('size_vram', 0) < 0.90 * resident['size']:
                raise RuntimeError('Unexpected CPU offload; profile needs separate review')
            result['models'].append({'name': name, 'manifest_digest': tag['digest'], 'artifact_size_bytes': tag['size'],
                                     'details': tag.get('details', {}), 'resident_size_bytes': resident['size'],
                                     'resident_vram_bytes': resident.get('size_vram'), 'warmup_elapsed_s': round(time.monotonic()-started, 3),
                                     'warmup_load_duration_ns': warm.get('load_duration')})
            for repeat in range(3):
                for case in CASES:
                    if unsafe.is_set() or time.monotonic() > deadline:
                        raise RuntimeError('Safety/resource/run-time limit')
                    if any(m['name'] != name for m in api('/api/ps')['models']):
                        raise RuntimeError('Concurrent model detected')
                    started = time.monotonic()
                    response = api('/api/generate', {'model': name, 'prompt': case['prompt'], 'format': 'json',
                                   'stream': False, 'keep_alive': '3m', 'options': result['options']})
                    text = response.get('response', '')
                    try:
                        parsed = json.loads(text)
                        passed = parsed == case['expected']
                    except (ValueError, TypeError):
                        parsed, passed = None, False
                    row = {'model': name, 'case_id': case['id'], 'repeat': repeat + 1,
                           'elapsed_s': round(time.monotonic() - started, 6), 'output': text,
                           'expected': case['expected'], 'passed': passed, 'done_reason': response.get('done_reason')}
                    for field in ['total_duration', 'load_duration', 'prompt_eval_count', 'prompt_eval_duration', 'eval_count', 'eval_duration']:
                        row[field] = response.get(field)
                    result['runs'].append(row)
                    print(json.dumps({'model': name, 'case': case['id'], 'repeat': repeat+1, 'passed': passed, 'elapsed_s': row['elapsed_s']}), flush=True)
            after = {m['name']: m for m in api('/api/tags')['models']}
            if after[name]['digest'] != tag['digest']:
                raise RuntimeError('Post-run digest changed')
            api('/api/generate', {'model': name, 'keep_alive': 0})
            current = None
        result['status'] = 'completed'
    except Exception as error:
        result['status'] = 'blocked'
        result['error_class'] = type(error).__name__
        result['error'] = str(error) if isinstance(error, RuntimeError) else 'Request failed; inspect private runtime locally'
    finally:
        if current:
            try:
                api('/api/generate', {'model': current, 'keep_alive': 0}, timeout=15)
            except Exception:
                result['cleanup'] = 'Unload unverified; keep-alive expires after 3 minutes'
        stopped.set()
        thread.join(3)
        result['finished_at'] = datetime.now(timezone.utc).isoformat()
        (output / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
        (output / 'telemetry.json').write_text(json.dumps(samples, indent=2) + '\n')
        (output / 'benchmark.sha256').write_text(hashlib.sha256(Path(__file__).read_bytes()).hexdigest() + '\n')
    return 0 if result['status'] == 'completed' else 2

if __name__ == '__main__':
    sys.exit(main())
