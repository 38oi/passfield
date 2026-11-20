from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
icons_dir = ROOT / "static" / "icons"
out = icons_dir / "sprite.svg"

parts = [
    '<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">'
]
count = 0
for path in sorted(icons_dir.glob("*.svg")):
    if path.name == "sprite.svg":
        continue
    text = path.read_text(encoding="utf-8")
    vb = re.search(r'viewBox="([^"]+)"', text)
    view = vb.group(1) if vb else "0 0 24 24"
    inner = re.search(r"<svg[^>]*>(.*)</svg>", text, re.S)
    body = inner.group(1).strip() if inner else ""
    body = re.sub(r"<!--.*?-->", "", body, flags=re.S).strip()
    name = path.stem
    parts.append(
        f'<symbol id="{name}" viewBox="{view}" fill="none" stroke="currentColor" '
        f'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{body}</symbol>'
    )
    count += 1
parts.append("</svg>")
out.write_text("\n".join(parts), encoding="utf-8")
print(f"sprite: {count} icons, {out.stat().st_size} bytes")
