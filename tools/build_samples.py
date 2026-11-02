"""Build the piano samples used by the app from the Salamander Grand Piano recordings.

  git clone --depth 1 https://github.com/sfzinstruments/SalamanderGrandPiano.git /tmp/salamander
  python3 tools/build_samples.py /tmp/salamander

macOS only: uses the built-in afconvert to decode FLAC and encode AAC. No other dependencies.

Each recording is trimmed to the part a practice session needs (longer for low notes, which ring
longer), faded out at the end, and saved as AAC. index.json tells the app which keys were recorded,
which loudness layer covers which MIDI velocities, and an overall gain.
"""
import array
import concurrent.futures
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import wave

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LAYERS = list(range(1, 17))               # all 16 of Salamander's loudness layers (v1 softest)
NOTE = {'C': 0, 'C#': 1, 'D': 2, 'D#': 3, 'E': 4, 'F': 5, 'F#': 6, 'G': 7, 'G#': 8, 'A': 9, 'A#': 10, 'B': 11}
FADE = 0.4                                # seconds of fade-out at the end of each trimmed sample


def seconds_for(midi):
    # A0 rings for a long time, C8 for well under a second
    return max(3.0, min(8.0, 10.0 - (midi - 21) * 0.08))


def find_samples(src):
    found = {}
    for root, _, files in os.walk(src):
        for f in files:
            m = re.fullmatch(r'([A-G]#?)(\d)v(\d+)\.flac', f)
            if m:
                midi = 12 * (int(m.group(2)) + 1) + NOTE[m.group(1)]
                found[(midi, int(m.group(3)))] = os.path.join(root, f)
    return found


def velocity_ranges(src):
    """Highest MIDI velocity of each Salamander layer, from its Data/notes.txt."""
    text = open(os.path.join(src, 'Data', 'notes.txt'), encoding='utf-8').read()
    return {int(v): int(hi) for v, hi in re.findall(r'vel_(\d+)\.txt" lovel=\d+ hivel=(\d+)', text)}


def run(*cmd):
    subprocess.run(cmd, check=True, capture_output=True)


def read_wav16(path):
    # afconvert writes WAVE_FORMAT_EXTENSIBLE headers, which the wave module can't read
    buf = open(path, 'rb').read()
    pos, ch, rate = 12, 2, 44100
    while pos + 8 <= len(buf):
        tag, size = buf[pos:pos + 4], int.from_bytes(buf[pos + 4:pos + 8], 'little')
        if tag == b'fmt ':
            ch, rate = int.from_bytes(buf[pos + 10:pos + 12], 'little'), int.from_bytes(buf[pos + 12:pos + 16], 'little')
        elif tag == b'data':
            return ch, rate, buf[pos + 8:pos + 8 + size]
        pos += 8 + size + (size & 1)
    raise ValueError('no audio data in ' + path)


def convert(flac, out, midi, tmp):
    wav, cut = os.path.join(tmp, os.path.basename(out) + '.wav'), os.path.join(tmp, os.path.basename(out) + '.cut.wav')
    run('afconvert', '-f', 'WAVE', '-d', 'LEI16@44100', flac, wav)
    ch, rate, data = read_wav16(wav)
    frames = array.array('h', data[:int(seconds_for(midi) * rate) * ch * 2])
    n = len(frames) // ch
    fade = int(FADE * rate)
    for i in range(max(0, n - fade), n):
        k = (n - i) / fade
        for c in range(ch):
            frames[i * ch + c] = int(frames[i * ch + c] * k)
    peak = max(abs(x) for x in frames) / 32768
    with wave.open(cut, 'wb') as w:
        w.setnchannels(ch); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(frames.tobytes())
    run('afconvert', '-f', 'm4af', '-d', 'aac', '-b', '128000', cut, out)
    os.remove(wav); os.remove(cut)
    return peak


def build(src, layers, dest):
    samples, hivel = find_samples(src), velocity_ranges(src)
    pitches = sorted({m for m, _ in samples})
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    os.makedirs(dest)
    jobs, peaks = {}, {}
    with tempfile.TemporaryDirectory() as tmp, concurrent.futures.ThreadPoolExecutor(8) as pool:
        for m in pitches:
            for v in layers:
                jobs[pool.submit(convert, samples[(m, v)], os.path.join(dest, f'{m}v{v}.m4a'), m, tmp)] = (m, v)
        for job in concurrent.futures.as_completed(jobs):
            peaks[jobs[job]] = job.result()
    # each chosen layer covers the velocities up to halfway to the next chosen layer
    ranges = []
    for i, v in enumerate(layers):
        top = 127 if i == len(layers) - 1 else hivel[(v + layers[i + 1]) // 2]
        ranges.append({'v': v, 'hi': top})
    ref = peaks.get((60, 12), 0.5) or 0.5  # loudness reference: C4, layer 12
    index = {'lo': pitches[0], 'hi': pitches[-1], 'step': pitches[1] - pitches[0],
             'layers': ranges, 'gain': round(0.35 / ref, 3)}
    with open(os.path.join(dest, 'index.json'), 'w') as f:
        json.dump(index, f, indent=1)
    with open(os.path.join(dest, 'README.md'), 'w') as f:
        f.write(f"""# Piano samples

From the [Salamander Grand Piano V3](https://github.com/sfzinstruments/SalamanderGrandPiano) by Alexander Holm,
licensed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).

Changes: the {len(layers)} velocity layers without the release and pedal recordings; each recording trimmed
to its first 3 to 8 seconds with a {FADE} s fade-out, converted to 44.1 kHz AAC. Made with `tools/build_samples.py`.
""")
    size = sum(os.path.getsize(os.path.join(dest, f)) for f in os.listdir(dest))
    print(f'{dest}: {len(jobs)} samples, {size / 1e6:.1f} MB')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    build(sys.argv[1], LAYERS, os.path.join(HERE, 'samples'))
