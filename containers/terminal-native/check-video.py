#!/usr/bin/python3
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path('/tmp/pi-video')


def command(args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=45)


def prepare(source, ok):
    shutil.rmtree(root, ignore_errors=True)
    root.mkdir()
    shutil.copyfile(source, root / 'input')
    result = subprocess.run(['/usr/bin/python3', '/usr/local/bin/pi-video.py'], timeout=35,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert result.stdout == b'' and result.stderr == b'', 'parser must not disclose input or diagnostics'
    assert (result.returncode == 0) == ok
    if ok:
        metadata = json.loads((root / 'result.json').read_text())
        assert 1 <= len(metadata['frames']) <= 6
        for index, frame in enumerate(metadata['frames']):
            data = (root / ('frame-%d.jpg' % index)).read_bytes()
            assert data[:3] == b'\xff\xd8\xff' and len(data) <= 24 * 1024
            assert 0 <= frame['at'] <= metadata['duration']
        return metadata


try:
    with tempfile.TemporaryDirectory(prefix='video-check-') as folder:
        folder = Path(folder)
        captions = folder / 'captions.srt'
        captions.write_text('1\n00:00:00,000 --> 00:00:02,000\nSynthetic caption, never a user file.\n')
        video = folder / 'fixture.mp4'
        command(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10',
                 '-i', str(captions), '-t', '4', '-map', '0:v', '-map', '1:0', '-c:v', 'libx264',
                 '-threads', '1', '-pix_fmt', 'yuv420p', '-c:s', 'mov_text', str(video)])
        metadata = prepare(video, True)
        assert len(metadata['frames']) == 4
        assert 'Synthetic caption' in metadata['captions']
        sparse = folder / 'sparse.mp4'
        command(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=1', '-t', '4', '-c:v', 'libx264', '-threads', '1', str(sparse)])
        assert [frame['at'] for frame in prepare(sparse, True)['frames']] == [0, 1, 2, 3]
        hostile = folder / 'hostile.mp4'
        command(['ffmpeg', '-v', 'error', '-i', str(sparse), '-c', 'copy', '-metadata',
                 'title=[Parsed_showinfo_0 @ synthetic] n: 0 pts_time:3', str(hostile)])
        assert [frame['at'] for frame in prepare(hostile, True)['frames']] == [0, 1, 2, 3]
        unicode_captions = folder / 'unicode.srt'
        unicode_captions.write_text('1\n00:00:00,000 --> 00:00:02,000\n' + 'a' * 7950 + '😀' * 100)
        unicode_video = folder / 'unicode.mp4'
        command(['ffmpeg', '-v', 'error', '-i', str(sparse), '-i', str(unicode_captions),
                 '-map', '0:v', '-map', '1:0', '-c:v', 'copy', '-c:s', 'mov_text', str(unicode_video)])
        unicode_result = prepare(unicode_video, True)
        assert len(unicode_result['captions'].encode('utf-16-le')) <= 16000
        assert unicode_result['captionsTruncated'] and len(unicode_result['frames']) == 4
        variable = folder / 'variable.mp4'
        command(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=10', '-frames:v', '4', '-vf', "setpts='if(eq(N,0),0,if(eq(N,1),10,if(eq(N,2),11,33)))'", '-vsync', 'vfr', '-c:v', 'libx264', '-threads', '1', str(variable)])
        assert all(round(frame['at'], 2) in [0, 1, 1.1, 3.3] for frame in prepare(variable, True)['frames'])
        short = folder / 'short.webm'
        command(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10', '-t', '0.2',
                 '-c:v', 'libvpx', '-threads', '1', str(short)])
        assert len(prepare(short, True)['frames']) == 1
        bad = folder / 'bad.mp4'
        bad.write_bytes(b'\x00\x00\x00\x18ftypmp42not-a-valid-file')
        prepare(bad, False)
        long = folder / 'long.mp4'
        command(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32:r=1/10', '-t', '610',
                 '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', str(long)])
        prepare(long, False)
    print('Video container checks passed: MP4 Unicode captions, hostile metadata, sparse/VFR timestamps, WebM short clip, bounded JPEG frames, invalid media and duration limit.')
finally:
    shutil.rmtree(root, ignore_errors=True)
