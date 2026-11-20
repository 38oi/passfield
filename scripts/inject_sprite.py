from pathlib import Path

root = Path(__file__).resolve().parents[1]
html_path = root / "static" / "index.html"
sprite = (root / "static" / "icons" / "sprite.svg").read_text(encoding="utf-8").strip()
html = html_path.read_text(encoding="utf-8")
start = "<!-- ICON_SPRITE_START -->"
end = "<!-- ICON_SPRITE_END -->"
block = f"{start}\n{sprite}\n{end}"
if start in html and end in html:
    before, rest = html.split(start, 1)
    _, after = rest.split(end, 1)
    html = before + block + after
else:
    html = html.replace("<body>", f"<body>\n{block}", 1)
html_path.write_text(html, encoding="utf-8")
print("sprite injected")
