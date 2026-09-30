"""Makes the audio fixtures with Blender's audaspace (aud): a two-tone chord
as Ogg Vorbis (3 s), Ogg Opus (1 s) and MP3 (1 s), plus bytes.base64.json
for the unit tests; and, for the audio importer's header tests, FLAC
(stereo 44.1 kHz 24-bit), 5.1 Ogg Vorbis and a 24-bit stereo 44.1 kHz WAV.

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
chord(1.0).write(os.path.join(here, 'chord.flac'), rate=44100, channels=aud.CHANNELS_STEREO, format=aud.FORMAT_S24, container=aud.CONTAINER_FLAC, codec=aud.CODEC_FLAC)
chord(0.5).write(os.path.join(here, 'chord-51.ogg'), rate=48000, channels=aud.CHANNELS_SURROUND51, container=aud.CONTAINER_OGG, codec=aud.CODEC_VORBIS, bitrate=128000)
chord(0.25).write(os.path.join(here, 'chord-24.wav'), rate=44100, channels=aud.CHANNELS_STEREO, format=aud.FORMAT_S24, container=aud.CONTAINER_WAV, codec=aud.CODEC_PCM)
out = {}
for name in ('chord.ogg', 'chord-opus.ogg', 'chord.mp3', 'chord.flac', 'chord-51.ogg', 'chord-24.wav'):
    with open(os.path.join(here, name), 'rb') as f:
        out[name] = base64.b64encode(f.read()).decode('ascii')
with open(os.path.join(here, 'bytes.base64.json'), 'w') as f:
    json.dump(out, f, indent=1, sort_keys=True)
