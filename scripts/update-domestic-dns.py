#!/usr/bin/env python3
"""Review/update the small domestic DNS snapshot from a pinned dler revision.

Usage: python3 scripts/update-domestic-dns.py --revision <40-char commit> [--check]
Only this explicit maintenance command uses the network. Subscription rendering
never downloads domain data or follows upstream changes automatically.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "internal/plugins/subgen/templates"
OUTPUT = BASE / "domestic_dns.json"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def rules(text):
    result = []
    for raw in text.splitlines():
        line = raw.strip().removeprefix("- ").strip("'\"")
        if not line or line.startswith("#") or line == "payload:":
            continue
        fields = [s.strip() for s in line.split(",")]
        result.append(fields)
    return result


def domain_rules(text):
    return {(f[0], f[1].lower()) for f in rules(text)
            if len(f) >= 2 and f[0] in {"DOMAIN", "DOMAIN-SUFFIX"}}


def overlap(a, b):
    ak, av = a
    bk, bv = b
    if av == bv:
        return True
    return ((ak == "DOMAIN-SUFFIX" and bv.endswith("." + av)) or
            (bk == "DOMAIN-SUFFIX" and av.endswith("." + bv)))


def provider_paths():
    """All earlier business groups are conservatively treated as proxy-capable.

    AdBlock is a documented exception: it defaults to blocking, not proxying.
    Changing a runtime group selection does not dynamically change DNS scope.
    """
    found = set()
    surge = (BASE / "oix_surge.tmpl").read_text()
    for line in surge.splitlines():
        if not line.startswith("RULE-SET,"):
            continue
        f = line.split(",")
        if "dler-io/Rules@main/" not in f[1] or f[2] in {"DIRECT", "Domestic", "AdBlock"}:
            continue
        found.add(unquote(f[1].split("dler-io/Rules@main/", 1)[1]))
    clash = (BASE / "oix_clash.tmpl").read_text()
    urls = {}
    for line in clash.splitlines():
        m = re.match(r"\s+(.+?): \{ type: http, behavior: classical, url: '([^']+)'", line)
        if m:
            urls[m[1].strip("'")] = m[2]
    for raw in clash.splitlines():
        line = raw.strip().removeprefix("- ").strip("'")
        if not line.startswith("RULE-SET,"):
            continue
        _, provider, policy, *_ = line.split(",")
        url = urls.get(provider, "")
        if "dler-io/Rules@main/" in url and policy not in {"DIRECT", "Domestic", "AdBlock"}:
            found.add(unquote(url.split("dler-io/Rules@main/", 1)[1]))
    return sorted(found)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.revision):
        parser.error("--revision must be an explicit 40-character commit SHA")
    fetched = subprocess.run(
        ["gh", "api", "repos/dler-io/Rules/zipball/" + args.revision],
        check=True, capture_output=True, timeout=90,
    ).stdout
    archive = zipfile.ZipFile(io.BytesIO(fetched))
    prefix = archive.namelist()[0].split("/", 1)[0] + "/"
    def source(path):
        return archive.read(prefix + path)
    domestic = ["Surge/Surge 3/Provider/Domestic.list", "Clash/Provider/Domestic.yaml"]
    common = domain_rules(source(domestic[0]).decode()) & domain_rules(source(domestic[1]).decode())
    seeds_bytes = (BASE / "domestic_dns_seeds.list").read_bytes()
    seeds = set()
    for f in rules(seeds_bytes.decode()):
        if len(f) != 2 or f[0] not in {"DOMAIN", "DOMAIN-SUFFIX"}:
            raise ValueError("seeds must contain only DOMAIN/DOMAIN-SUFFIX pairs")
        if not re.fullmatch(r"[a-z0-9]+(?:[.-][a-z0-9]+)+", f[1]):
            raise ValueError("invalid seed domain: " + f[1])
        seeds.add(tuple(f))
    missing = seeds - common
    if missing:
        raise ValueError("seeds absent from one/both pinned Domestic formats: " + repr(sorted(missing)))
    paths = provider_paths()
    blockers = set()
    for path in paths:
        content = source(path).decode()
        if any(f[0] in {"DOMAIN-KEYWORD", "DOMAIN-WILDCARD", "DOMAIN-REGEX"} for f in rules(content)):
            raise ValueError("new nontrivial domain matcher needs manual scope review: " + path)
        blockers |= domain_rules(content)
    kept = sorted(s for s in seeds if not any(overlap(s, b) for b in blockers))
    if not kept:
        raise ValueError("no reviewed DNS exceptions remain")
    data = {
        "revision": args.revision,
        "seeds_sha256": digest(seeds_bytes),
        "sources": [{"path": p, "sha256": digest(source(p))} for p in domestic + paths],
        "rules": [{"kind": k, "domain": d} for k, d in kept],
    }
    output = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    if args.check:
        if OUTPUT.read_text() != output:
            raise SystemExit("domestic DNS snapshot differs; review and regenerate explicitly")
    else:
        OUTPUT.write_text(output)
    print(f"{len(seeds)} reviewed seeds -> {len(kept)} domestic DNS exceptions at {args.revision}")
    for item in sorted(seeds - set(kept)):
        print("excluded proxy/service overlap:", ",".join(item))


if __name__ == "__main__":
    main()
