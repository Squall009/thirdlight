#!/usr/bin/env python3
"""Clamp near-zero alpha to 0 in 8-bit RGBA PNGs (generated sprites leave a
faint background at alpha 1-7). Pure Python: decode filters, re-encode.

  python3 tools/png-alpha-clean.py <in.png> <out.png> [threshold=7]
"""
import struct, sys, zlib

def chunks(b):
    i = 8
    while i < len(b):
        n = struct.unpack('>I', b[i:i+4])[0]; t = b[i+4:i+8]
        yield t, b[i+8:i+8+n]; i += 12 + n

def decode(b):
    w = h = None; idat = b''
    for t, d in chunks(b):
        if t == b'IHDR':
            w, h, bd, ct = struct.unpack('>IIBB', d[:10])
            if bd != 8 or ct != 6: raise SystemExit('only 8-bit RGBA PNGs')
        elif t == b'IDAT': idat += d
    raw = zlib.decompress(idat); bpp = 4; stride = w * bpp
    out = bytearray(); prev = bytearray(stride); p = 0
    for _ in range(h):
        f = raw[p]; line = bytearray(raw[p+1:p+1+stride]); p += 1 + stride
        for i in range(stride):
            a = line[i-bpp] if i >= bpp else 0; bb = prev[i]; c = prev[i-bpp] if i >= bpp else 0
            if f == 1: line[i] = (line[i] + a) & 255
            elif f == 2: line[i] = (line[i] + bb) & 255
            elif f == 3: line[i] = (line[i] + ((a + bb) >> 1)) & 255
            elif f == 4:
                pa, pb, pc = abs(bb - c), abs(a - c), abs(a + bb - 2*c)
                pr = a if pa <= pb and pa <= pc else (bb if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        out += line; prev = line
    return w, h, out

def encode(w, h, px):
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    stride = w * 4; raw = b''.join(b'\x00' + bytes(px[y*stride:(y+1)*stride]) for y in range(h))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')

src, dst = sys.argv[1], sys.argv[2]; thr = int(sys.argv[3]) if len(sys.argv) > 3 else 7
w, h, px = decode(open(src, 'rb').read())
for i in range(3, len(px), 4):
    if px[i] <= thr: px[i] = 0; px[i-3] = px[i-2] = px[i-1] = 0
open(dst, 'wb').write(encode(w, h, px))
