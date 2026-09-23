#!/usr/bin/env python3
"""Dev tool (D21): remove top-level declarations (with their leading doc
comments) from a TypeScript file by name.
  python3 tools/dev/drop-decls.py <file> <name>...
A declaration runs from its line (or its doc comment) to the line before the
next top-level declaration/comment block."""
import re, sys
path, names = sys.argv[1], set(sys.argv[2:])
lines = open(path).read().split('\n')
decl = re.compile(r'^(?:export )?(?:async )?(?:function|const|let|interface|type|class|enum) (\w+)')
top = re.compile(r'^(?:export |async |function |const |let |interface |type |class |enum |/\*\*|// |import )')
out = []; i = 0; removed = []
while i < len(lines):
    m = decl.match(lines[i])
    if m and m.group(1) in names:
        # pop the doc comment already emitted
        k = len(out)
        while k > 0 and (out[k-1].startswith(' *') or out[k-1].startswith('/**') or out[k-1].startswith(' */')):
            k -= 1
        out = out[:k]
        j = i + 1
        while j < len(lines) and not top.match(lines[j]):
            j += 1
        removed.append(m.group(1)); i = j; continue
    out.append(lines[i]); i += 1
open(path, 'w').write(re.sub(r'\n{3,}', '\n\n', '\n'.join(out)))
missing = names - set(removed)
print(f'{path}: removed {sorted(removed)}' + (f'; NOT FOUND {sorted(missing)}' if missing else ''))
