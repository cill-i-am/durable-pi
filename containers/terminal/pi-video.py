#!/usr/bin/python3
"""Bounded local-file video sampling. No model, network, user shell or credentials."""
import json
import math
import os
from pathlib import Path
import resource
import re
import subprocess
import time

ROOT = Path('/tmp/pi-video')
DEADLINE = time.monotonic() + 25
MAX_FRAME = 24 * 1024
SOURCE = str(ROOT / 'input')


def limits():
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (20,) * 2)
    resource.setrlimit(resource.RLIMIT_FSIZE, (2 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_NOFILE, (64,) * 2)


def run(args, output=None):
    remaining = DEADLINE - time.monotonic()
    if remaining <= 0:
        raise ValueError('time limit')
    with open(output or os.devnull, 'wb') as out:
        subprocess.run(args, stdin=subprocess.DEVNULL, stdout=out,
                       stderr=subprocess.DEVNULL, timeout=remaining,
                       check=True, preexec_fn=limits, env={'PATH': '/usr/bin:/bin'})


def input_args():
    return ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska,webm']


def extract():
    probe = ROOT / 'probe.json'
    run(['ffprobe', '-v', 'error', *input_args(), '-show_entries',
         'format=duration:stream=codec_type,codec_name,width,height,duration',
         '-of', 'json', SOURCE], probe)
    if probe.stat().st_size > 32768:
        raise ValueError('metadata limit')
    metadata = json.loads(probe.read_text())
    videos = [s for s in metadata.get('streams', []) if s.get('codec_type') == 'video']
    if not videos or not all(0 < videos[0].get(k, 0) <= 4096 for k in ['width', 'height']):
        raise ValueError('video size')
    duration = float(metadata.get('format', {}).get('duration', videos[0].get('duration', 0)))
    if not math.isfinite(duration) or not 0 < duration <= 600:
        raise ValueError('duration')
    count = min(6, max(1, math.ceil(duration)))
    interval = duration / count
    info = ROOT / 'frame-info.log'
    output = str(ROOT / 'frame-%d.jpg')
    remaining = DEADLINE - time.monotonic()
    # Select decoded frames and retain their presentation time. Seeking to requested
    # offsets mislabels sparse/VFR footage and can seek past the last actual frame.
    with info.open('wb') as log:
        subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-v', 'info', '-threads', '1',
                        *input_args(), '-copyts', '-start_at_zero', '-i', SOURCE,
                        '-map', '0:v:0', '-an', '-sn', '-frames:v', str(count),
                        '-vf', "select='isnan(prev_selected_t)+gte(t-prev_selected_t,%f)',scale=384:384:force_original_aspect_ratio=decrease,showinfo" % interval,
                        '-vsync', 'vfr', '-threads', '1', '-q:v', '12', '-start_number', '0', '-y', output],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log,
                       timeout=max(0.01, remaining), check=True, preexec_fn=limits,
                       env={'PATH': '/usr/bin:/bin'})
    if info.stat().st_size > 128000:
        raise ValueError('metadata limit')
    # Metadata is untrusted and is also echoed to stderr. Only accept complete,
    # anchored frame records with a contiguous sequence; injected records fail closed.
    records = re.findall(r'^\[Parsed_showinfo_\d+ @ (?:0x)?[0-9a-fA-F]+\]\s+n:\s*(\d+)\s+pts:\s*-?\d+\s+pts_time:([0-9.eE+-]+)\s', info.read_text(errors='replace'), re.MULTILINE)
    times = []
    for index, (number, value) in enumerate(records):
        at = float(value)
        if int(number) != index or not math.isfinite(at) or (times and at <= times[-1]):
            raise ValueError('frame sequence')
        times.append(at)
    frames = []
    for index in range(count):
        target = ROOT / ('frame-%d.jpg' % index)
        if not target.is_file():
            break
        if index >= len(times) or not math.isfinite(times[index]) or not 0 <= times[index] <= duration:
            raise ValueError('frame time')
        if target.stat().st_size > MAX_FRAME:
            smaller = ROOT / 'smaller.jpg'
            run(['ffmpeg', '-nostdin', '-v', 'error', '-threads', '1', '-i', str(target),
                 '-vf', 'scale=256:256:force_original_aspect_ratio=decrease', '-frames:v', '1',
                 '-threads', '1', '-q:v', '16', '-y', str(smaller)])
            smaller.replace(target)
        if not 0 < target.stat().st_size <= MAX_FRAME:
            raise ValueError('frame size')
        frames.append({'at': times[index]})
    if not frames:
        raise ValueError('no frames')
    captions = ''
    truncated = False
    subtitles = [s for s in metadata.get('streams', []) if s.get('codec_type') == 'subtitle']
    # Image subtitles need OCR. Speech is intentionally not described as transcribed.
    if subtitles and subtitles[0].get('codec_name') in ['mov_text', 'subrip', 'webvtt', 'ass', 'ssa', 'text']:
        target = ROOT / 'captions.vtt'
        try:
            run(['ffmpeg', '-nostdin', '-v', 'error', '-threads', '1', *input_args(),
                 '-i', SOURCE, '-map', '0:s:0', '-t', '600', '-c:s', 'webvtt', '-y', str(target)])
            with target.open('r', encoding='utf-8', errors='replace') as file:
                captions = file.read(8001)
            # TypeScript limits strings in UTF-16 units, not Python codepoints.
            encoded = captions.encode('utf-16-le')
            truncated = len(encoded) > 16000
            captions = encoded[:16000].decode('utf-16-le', errors='ignore')
        except (ValueError, subprocess.SubprocessError, OSError):
            captions = ''
    (ROOT / 'result.json').write_text(json.dumps({'duration': duration, 'frames': frames,
                                                'captions': captions, 'captionsTruncated': truncated}))


if __name__ == '__main__':
    try:
        extract()
    except Exception:
        # Never print parser diagnostics or input metadata.
        raise SystemExit(2)
