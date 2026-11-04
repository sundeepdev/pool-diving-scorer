# Rebuilds public/ddtable.js from the World Aquatics DD tables.
#
# 1. Download the Diving Rules appendix PDF with the "Table of Degree of
#    Difficulty" (springboard Appendix 9, platform Appendix 11), e.g.
#    https://swiss-aquatics.ch/wp-content/uploads/2024/02/7.4.2_DI-Degree-de-Difficulte-formule_EN.pdf
# 2. Extract the text keeping the column layout:
#      pip install pypdf
#      python -c "import pypdf; r=pypdf.PdfReader('dd.pdf'); open('layout.txt','w').write('\n'.join(f'=====PAGE {i+1}\n'+p.extract_text(extraction_mode='layout') for i,p in enumerate(r.pages)))"
# 3. python scripts/parse_dd_table.py layout.txt dd.json
#    It prints any value it couldn't place in a column; check those by hand.
# 4. Regenerate public/ddtable.js from dd.json and run `npm test`, which checks
#    the worked examples printed in the rules.
#
# Page numbers below are for the 2024 PDF; adjust them for a new edition.
import json, re, sys

text = open(sys.argv[1]).read()
pages = re.split(r"=====PAGE (\d+)\n", text)[1:]
pages = {int(pages[i]): pages[i + 1] for i in range(0, len(pages), 2)}

# Springboard table: pages 3-5, heights 1m, 3m. Platform: pages 9-13, heights 10, 7.5, 5.
SECTIONS = [(range(3, 6), ["1", "3"]), (range(9, 14), ["10", "7.5", "5"])]
HEADER = re.compile(r"^\s*(?:[A-Za-z ]*Group|Armstand[A-Za-z ]*)?\s+A\s+B\s+C\s+D(\s+A\s+B\s+C\s+D)+\s*$")
ROW = re.compile(r"^\s*(\d{3,4})\s")
VAL = re.compile(r"(?<!\S)(\d\.\d|-)(?!\S)")

table = {}
problems = []
for pages_range, heights in SECTIONS:
    cols = None
    for p in pages_range:
        page_cols = False
        pending = None
        for line in pages.get(p, "").splitlines():
            if not page_cols and not re.search(r"A\s+B\s+C\s+D", line) and ROW.match(line):
                toks = list(VAL.finditer(line))
                if len(toks) == 4 * len(heights):
                    cols = [t.start() + len(t.group(1)) / 2 - 0.5 for t in toks]
                    page_cols = True
            if not ROW.match(line) and cols and len([v for v in VAL.finditer(line) if v.start() >= cols[0] - 3]) >= 1 and not re.search(r"[ABCD]\s+[ABCD]", line):
                pending = line
                continue
            if ROW.match(line) and pending is not None and not [v for v in VAL.finditer(line) if v.start() >= cols[0] - 3]:
                line = ROW.match(line).group(0) + pending[len(ROW.match(line).group(0)):]
            pending = None
            if re.search(r"(?<!\S)A\s+B\s+C\s+D\s+A\s+B\s+C\s+D", line):
                cols = [m.start() for m in re.finditer(r"(?<!\S)[ABCD](?!\S)", line)]
                page_cols = True
                if len(cols) != 4 * len(heights):
                    problems.append(f"page {p}: header has {len(cols)} cols")
                continue
            m = ROW.match(line)
            if not m or not cols:
                continue
            code = m.group(1)
            # values only to the right of the description: start after first col - small margin
            for v in VAL.finditer(line):
                if v.start() < cols[0] - 3:
                    continue
                x = v.start() + len(v.group(1)) / 2
                idx = min(range(len(cols)), key=lambda i: abs(cols[i] + 0.5 - x))
                if abs(cols[idx] + 0.5 - x) > 4:
                    problems.append(f"page {p} {code}: value {v.group(1)} at {x} far from cols")
                    continue
                if v.group(1) == "-":
                    continue
                h = heights[idx // 4]
                pos = "ABCD"[idx % 4]
                key = f"{code}{pos}"
                table.setdefault(key, {})
                if h in table[key]:
                    problems.append(f"dup {key} {h}")
                table[key][h] = float(v.group(1))

json.dump(table, open(sys.argv[2], "w"), sort_keys=True)
print(len(table), "dives", file=sys.stderr)
for p in problems:
    print(p, file=sys.stderr)
