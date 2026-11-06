"""Import fan-in: how many distinct repo files import each file.

Supported: JS/TS (relative specifiers, configurable aliases like "@/") and Python
(absolute modules resolved by unique dotted-path suffix, and relative imports).
Other languages get fan-in 0 for now.
"""

from __future__ import annotations

import posixpath
import re
from collections import defaultdict
from collections.abc import Callable, Mapping

JS_EXT = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")
_JS_SPEC = re.compile(
    r"""(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]"""
    r"""|import\s*\(\s*['"]([^'"]+)['"]\s*\)"""
    r"""|require\(\s*['"]([^'"]+)['"]\s*\)"""
    r"""|^\s*import\s+['"]([^'"]+)['"]""",
    re.MULTILINE,
)
_PY_FROM = re.compile(r"^\s*from\s+(\.*)([\w.]*)\s+import\s+([^\n#]+)", re.MULTILINE)
_PY_IMPORT = re.compile(r"^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)", re.MULTILINE)


def _js_resolve(spec: str, importer: str, files: set[str], aliases: Mapping[str, str]) -> str | None:
    for prefix, target in aliases.items():
        if spec.startswith(prefix):
            base = posixpath.normpath(target + spec[len(prefix) :])
            break
    else:
        if not spec.startswith("."):
            return None  # package import
        base = posixpath.normpath(posixpath.join(posixpath.dirname(importer), spec))
    stem, ext = posixpath.splitext(base)
    candidates = [base]
    if ext in JS_EXT:  # TS ESM style: "./x.js" refers to x.ts
        candidates += [stem + e for e in JS_EXT]
    candidates += [base + e for e in JS_EXT] + [f"{base}/index{e}" for e in JS_EXT]
    return next((c for c in candidates if c in files), None)


class _PyIndex:
    def __init__(self, files: set[str]) -> None:
        self.exact: dict[str, str] = {}
        suffixes: dict[str, set[str]] = defaultdict(set)
        for f in files:
            if not f.endswith(".py"):
                continue
            parts = f[:-3].split("/")
            if parts[-1] == "__init__":
                parts = parts[:-1]
            if not parts:
                continue
            self.exact[".".join(parts)] = f
            for i in range(1, len(parts)):
                suffixes[".".join(parts[i:])].add(f)
        self.unique = {k: next(iter(v)) for k, v in suffixes.items() if len(v) == 1}

    def resolve(self, dotted: str) -> str | None:
        return self.exact.get(dotted) or self.unique.get(dotted)


def _py_targets(src: str, importer: str, idx: _PyIndex) -> set[str]:
    out: set[str] = set()
    pkg_parts = importer[:-3].split("/")[:-1]
    lookup: Callable[[str], str | None]
    for m in _PY_FROM.finditer(src):
        dots, mod, names = m.group(1), m.group(2), m.group(3)
        if dots:
            up = len(dots) - 1
            base_parts = pkg_parts[: len(pkg_parts) - up] if up else pkg_parts
            base = ".".join(base_parts + ([mod] if mod else []))
            lookup = idx.exact.get
        else:
            base = mod
            lookup = idx.resolve
        clean = names.replace("(", " ").replace(")", " ")
        found_sub = False
        for name in (n.strip().split(" as ")[0].strip() for n in clean.split(",")):
            if name and name != "*":
                t = lookup(f"{base}.{name}" if base else name)
                if t:
                    out.add(t)
                    found_sub = True
        if not found_sub and base:
            t = lookup(base)
            if t:
                out.add(t)
    for m in _PY_IMPORT.finditer(src):
        for mod in (x.strip() for x in m.group(1).split(",")):
            t = idx.resolve(mod)
            if t:
                out.add(t)
    return out


def fan_in(contents: Mapping[str, str], all_files: set[str], aliases: Mapping[str, str]) -> dict[str, int]:
    importers: dict[str, set[str]] = defaultdict(set)
    py_idx = _PyIndex(all_files)
    for path, src in contents.items():
        if path.endswith(JS_EXT):
            for m in _JS_SPEC.finditer(src):
                spec = next(g for g in m.groups() if g)
                t = _js_resolve(spec, path, all_files, aliases)
                if t and t != path:
                    importers[t].add(path)
        elif path.endswith(".py"):
            for t in _py_targets(src, path, py_idx):
                if t != path:
                    importers[t].add(path)
    return {f: len(importers.get(f, ())) for f in all_files}


def is_import_source(path: str) -> bool:
    return path.endswith(JS_EXT) or path.endswith(".py")
