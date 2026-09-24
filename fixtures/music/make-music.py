"""Makes the music fixtures (phase 9.10) with Blender's audaspace (aud):
a two-tone chord as Ogg Vorbis (3 s), Ogg Opus (1 s) and MP3 (1 s), plus
bytes.base64.json for the unit tests.

    blender -b --factory-startup --python fixtures/music/make-music.py
"""
import aud, base64, json, os

here = os.path.dirname(os.path.abspath(__file__))

def chord(seconds):
    a = aud.Sound.sine(440, 44100).limit(0, seconds).volume(0.2)
    return a.mix(aud.Sound.sine(660, 44100).limit(0, seconds).volume(0.1))

chord(3.0).write(os.path.join(here, 'chord.ogg'), rate=44100, channels=aud.CHANNELS_STEREO, container=aud.CONTAINER_OGG, codec=aud.CODEC_VORBIS, bitrate=96000)
chord(1.0).write(os.path.join(here, 'chord-opus.ogg'), rate=48000, channels=aud.CHANNELS_STEREO, container=aud.CONTAINER_OGG, codec=aud.CODEC_OPUS, bitrate=64000)
chord(1.0).write(os.path.join(here, 'chord.mp3'), rate=44100, channels=aud.CHANNELS_MONO, container=aud.CONTAINER_MP3, codec=aud.CODEC_MP3, bitrate=64000)
out = {}
for name in ('chord.ogg', 'chord-opus.ogg', 'chord.mp3'):
    with open(os.path.join(here, name), 'rb') as f:
        out[name] = base64.b64encode(f.read()).decode('ascii')
with open(os.path.join(here, 'bytes.base64.json'), 'w') as f:
    json.dump(out, f, indent=1, sort_keys=True)
