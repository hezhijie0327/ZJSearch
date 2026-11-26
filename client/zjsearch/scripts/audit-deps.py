#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0 WITH Commons-Clause-1.0
"""audit_deps.py — ZJSearch coupling audit against the DECLARED contract.

The mechanical gate behind AUDIT.md §7 dimension 0 (layer inversions):
builds the real import graphs (AST for the server, specifier parsing for
the client), checks every edge against the declared layer order, and
reports import cycles via SCC.  Runs inside `pnpm run lint` (so also in
`make themes.zjsearch.lint`); exit 1 on any HARD finding.

Server (searx/zjsearch/ai/, eight packages), ranks (only downward edges legal):
    api=5 -> runs=4 -> tools=3 -> agent=2 -> {llm=1, browser=1, prompts=1} -> core=0
    shell=6: searx/zjsearch top-level modules + searx/plugins + searx/result_types
    Lateral edges between same-rank packages are violations.
    Nothing inside zjsearch may import searx.webapp.
    Cross-package import cycles are violations.

Client (client/zjsearch/src/), ranks:
    lib=0 -> components=1 -> features=2 -> pages=3 (src root counts as pages)
    Upward edges are violations.  Deep relative imports (../ escaping the
    current dir) violate the @/ alias doctrine.
    Sanctioned shared surfaces: the overlay context (features/overlay,
    consumed via hooks from components/ and features/) and the aiAnswer
    presentation domain (features/aiAnswer, consumed downward by results
    and knowledge alike).  Other features->features lateral edges are
    WARN-level (review, do not accumulate); pages->pages lateral is the
    documented page-private composition pattern.
    Cross-domain runtime cycles are violations; type-only cycles
    (`import type`, erased at build) are NOTE-level refactor friction.
"""
from __future__ import annotations

import ast
import os
import re
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.normpath(os.path.join(HERE, "..", "..", ".."))

hard: list[str] = []
warn: list[str] = []
note: list[str] = []

# ---------------------------------------------------------------- server

SERVER_RANK = {
    "core": 0, "browser": 1, "llm": 1, "prompts": 1,
    "agent": 2, "tools": 3, "runs": 4, "api": 5,
}
SHELL = 6


def server_layer(mod: str):
    """Classify a dotted module name -> (rank, pkg) or (None, mod) if outside."""
    if mod == "searx.zjsearch" or mod.startswith("searx.zjsearch."):
        parts = mod.split(".")
        if len(parts) == 2:
            return SHELL, "shell"
        if parts[2] == "ai":
            if len(parts) == 3:
                return SHELL, "shell"
            pkg = parts[3]
            if pkg in SERVER_RANK:
                return SERVER_RANK[pkg], pkg
            return SHELL, "shell"
        return SHELL, "shell"
    if mod.startswith("searx.plugins") or mod.startswith("searx.result_types"):
        return SHELL, "shell"
    return None, mod


def module_name(rel_py: str) -> str:
    rel = rel_py.replace("\\", "/")[: -len(".py")]
    parts = [p for p in rel.split("/") if p != "__init__"]
    return ".".join(parts)


def py_imports(path: str, my_mod: str) -> list[str]:
    with open(path, "r", encoding="utf-8") as f:
        tree = ast.parse(f.read())
    out = []
    base = my_mod.split(".") if my_mod else []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out.extend(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                b = base[: len(base) - (node.level - 1)] if node.level > 1 else base
                if node.module:
                    out.append(".".join(b + node.module.split(".")))
                else:
                    out.append(".".join(b))
            elif node.module:
                out.append(node.module)
    return out


def audit_server() -> dict[tuple[str, str], list[str]]:
    root = os.path.join(REPO, "searx")
    py_files: list[str] = []
    for sub in ("zjsearch", "plugins", "result_types"):
        d = os.path.join(root, sub)
        for dirpath, _dirnames, filenames in os.walk(d):
            for fn in filenames:
                if fn.endswith(".py"):
                    py_files.append(os.path.join(dirpath, fn))

    mod_file: dict[str, str] = {}
    file_mod: dict[str, str] = {}
    for p in py_files:
        m = module_name(os.path.relpath(p, root))
        mod_file[m] = p
        file_mod[p] = m

    lateral: dict[tuple[str, str], list[str]] = defaultdict(list)
    edges: dict[str, set[str]] = defaultdict(set)  # module -> imported modules

    for p in py_files:
        my_mod = file_mod[p]
        my_rank, my_pkg = server_layer(my_mod)
        if my_rank is None:
            continue
        for target in py_imports(p, my_mod):
            t_rank, t_pkg = server_layer(target)
            edges[my_mod].add(target)
            if t_rank is None:
                if target == "searx.webapp" or target.startswith("searx.webapp."):
                    hard.append(f"[srv] {my_mod} imports searx.webapp (upstream shell must stay untouched): {target}")
                continue
            if t_pkg == my_pkg:
                continue
            if my_rank < t_rank:
                hard.append(f"[srv] upward {my_pkg}({my_rank}) -> {t_pkg}({t_rank}): {my_mod} imports {target}")
            elif my_rank == t_rank and t_rank != SHELL:
                lateral[(my_pkg, t_pkg)].append(f"{my_mod} -> {target}")
            elif my_rank == SHELL and t_rank == SHELL and my_pkg != t_pkg:
                pass  # shell-internal (plugins -> result_types etc.), fine

    for (a, b), examples in sorted(lateral.items()):
        hard.append(f"[srv] lateral {a} -> {b} ({len(examples)} edge(s)), e.g. {examples[0]}")

    # cycles among zjsearch modules (module-level SCC)
    zmods = [m for m in mod_file if server_layer(m)[0] is not None]
    graph = {m: sorted(t for t in edges.get(m, ()) if t in mod_file) for m in zmods}
    sccs = tarjan(graph)
    for scc in sccs:
        if len(scc) < 2:
            continue
        pkgs = {server_layer(m)[1] for m in scc}
        if len(pkgs) > 1:
            hard.append(f"[srv] cross-package cycle ({', '.join(sorted(pkgs))}): {' <-> '.join(sorted(scc))}")
        else:
            note.append(f"[srv] intra-package cycle in {pkgs.pop()}: {' <-> '.join(sorted(scc))}")
    return lateral


# ---------------------------------------------------------------- client

CLIENT_RANK = {"lib": 0, "components": 1, "features": 2, "pages": 3}
IMPORT_RE = re.compile(
    r"""(?:\bfrom\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]"""
)
# edges that exist only for the type checker and are erased at build time
TYPE_ONLY_RE = re.compile(r"""\b(?:import|export)\s+type\s[^;'"]*?['"]([^'"]+)['"]""")


def client_layer(abs_path: str) -> tuple[int, str]:
    rel = os.path.relpath(abs_path, os.path.join(REPO, "client", "zjsearch", "src")).replace("\\", "/")
    top = rel.split("/", 1)[0]
    if top in CLIENT_RANK:
        return CLIENT_RANK[top], top
    return 3, "src-root"


def client_domain(abs_path: str) -> str:
    """Feature domain = the directory right under features/."""
    rel = os.path.relpath(abs_path, os.path.join(REPO, "client", "zjsearch", "src")).replace("\\", "/")
    parts = rel.split("/")
    if parts[0] == "features" and len(parts) > 1:
        return "features/" + parts[1]
    return parts[0]


def resolve_spec(spec: str, abs_path: str) -> str | None:
    """Return the layer key path ('lib/...', 'components/...' ...) or None."""
    base = os.path.dirname(abs_path)
    if spec.startswith("@/"):
        return os.path.normpath(spec[2:]).replace("\\", "/")
    if spec.startswith("."):
        return os.path.normpath(os.path.join(base, spec)).replace("\\", "/")
    return None


def audit_client() -> None:
    src = os.path.join(REPO, "client", "zjsearch", "src")
    files: list[str] = []
    for dirpath, dirnames, filenames in os.walk(src):
        dirnames[:] = [d for d in dirnames if d != "node_modules"]
        for fn in filenames:
            if fn.endswith((".ts", ".tsx")):
                files.append(os.path.join(dirpath, fn))

    file_layer = {p: client_layer(p) for p in files}
    edges: dict[str, set[str]] = defaultdict(set)          # value edges only
    type_edges: dict[str, set[str]] = defaultdict(set)     # import type edges
    file_of_key: dict[str, str] = {os.path.relpath(p, src).replace("\\", "/"): p for p in files}

    for p in files:
        text = open(p, "r", encoding="utf-8", errors="replace").read()
        type_specs = {m.group(1) for m in TYPE_ONLY_RE.finditer(text)}
        my_rank, my_pkg = file_layer[p]
        rel_key = os.path.relpath(p, src).replace("\\", "/")
        for m in IMPORT_RE.finditer(text):
            spec = m.group(1)
            # TYPE_ONLY_RE captures `import type ...` / `export type ... from`
            # statements directly; those edges are erased at build time
            is_type_edge = spec in type_specs
            line = text.count("\n", 0, m.start()) + 1
            resolved = resolve_spec(spec, p)
            if resolved is None:
                continue
            if spec.startswith(".."):
                hard.append(f"[cli] deep relative import in {rel_key}:{line} -> '{spec}' (use the @/ alias)")
            tgt_top = resolved.split("/", 1)[0]
            t_rank = CLIENT_RANK.get(tgt_top)
            if t_rank is None:
                continue  # src-root target; treat as pages-level
            (type_edges if is_type_edge else edges)[rel_key].add(resolved)
            if t_rank > my_rank:
                if not (resolved.startswith("features/overlay") and my_pkg in ("components", "features")):
                    hard.append(f"[cli] upward {my_pkg}({my_rank}) -> {tgt_top}({t_rank}): {rel_key}:{line} -> '{spec}'")
            elif t_rank == my_rank and my_pkg == "features":
                my_dom = client_domain(p)
                tgt_dom = "features/" + resolved.split("/")[1] if resolved.startswith("features/") else resolved.split("/")[0]
                # sanctioned shared domains: the overlay context and the
                # aiAnswer presentation surface both serve every feature
                shared = resolved.startswith("features/overlay") or resolved.startswith("features/aiAnswer")
                if my_dom != tgt_dom and not shared:
                    kind = "type-only " if is_type_edge else ""
                    warn.append(f"[cli] lateral {kind}features {my_dom} -> {tgt_dom}: {rel_key}:{line} -> '{spec}'")
            elif t_rank == my_rank and my_pkg == "pages" and rel_key.split("/")[0] == "pages":
                # page-private pieces next to the page are the documented
                # composition pattern; pages->pages lateral is sanctioned
                pass

    # cycles at file level — RUNTIME edges only
    graph = {}
    for f_key in file_of_key:
        graph[f_key] = sorted(t for t in edges.get(f_key, ()) if t in file_of_key)
    for scc in tarjan(graph):
        if len(scc) < 2:
            continue
        doms = {client_domain(file_of_key[s]) for s in scc}
        if len(doms) > 1:
            hard.append(f"[cli] cross-domain runtime cycle ({', '.join(sorted(doms))}): {' <-> '.join(sorted(scc))}")
        else:
            note.append(f"[cli] intra-domain runtime cycle in {doms.pop()}: {' <-> '.join(sorted(scc))}")
    # type-only cycles are refactor friction, not runtime coupling
    tgraph = {}
    for f_key in file_of_key:
        merged = (edges.get(f_key, set()) | type_edges.get(f_key, set()))
        tgraph[f_key] = sorted(t for t in merged if t in file_of_key)
    runtime_scc_nodes: set[str] = set()
    for scc in tarjan(graph):
        if len(scc) > 1:
            runtime_scc_nodes.update(scc)
    for scc in tarjan(tgraph):
        if len(scc) < 2 or all(n in runtime_scc_nodes for n in scc):
            continue
        doms = {client_domain(file_of_key[s]) for s in scc}
        label = "cross-domain" if len(doms) > 1 else "intra-domain"
        note.append(f"[cli] {label} TYPE-ONLY cycle: {' <-> '.join(sorted(scc))}")


# ---------------------------------------------------------------- cycles

def tarjan(graph: dict[str, list[str]]) -> list[list[str]]:
    index = {}
    low = {}
    stack: list[str] = []
    onstack: set[str] = set()
    out: list[list[str]] = []
    counter = [0]

    def strongconnect(v: str) -> None:
        index[v] = low[v] = counter[0]
        counter[0] += 1
        stack.append(v)
        onstack.add(v)
        for w in graph.get(v, ()):
            if w not in index:
                strongconnect(w)
                low[v] = min(low[v], low[w])
            elif w in onstack:
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            scc = []
            while True:
                w = stack.pop()
                onstack.discard(w)
                scc.append(w)
                if w == v:
                    break
            out.append(scc)

    for v in graph:
        if v not in index:
            strongconnect(v)
    return out


# ---------------------------------------------------------------- main

if __name__ == "__main__":
    lateral = audit_server()
    audit_client()
    if lateral:
        note.append("[srv] full lateral edge inventory (review before allowlisting):")
        for (a, b), ex in sorted(lateral.items()):
            note.append(f"      {a} -> {b}: {len(ex)} edge(s)")

    for h in hard:
        print("HARD " + h)
    for w in warn:
        print("WARN " + w)
    for n in note:
        print("NOTE " + n)
    print(f"\n== audit-deps: {len(hard)} hard / {len(warn)} warn / {len(note)} note ==")
    sys.exit(1 if hard else 0)
