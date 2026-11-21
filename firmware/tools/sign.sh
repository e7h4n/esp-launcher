#!/usr/bin/env bash
# Sign an esp-launcher firmware image (docs/protocol.md "Signing").
#
#   tools/sign.sh <image.bin> <private_key.pem> <name> <version> <chip> <role> [outdir]
#
# Writes into outdir (default: next to the image):
#   <name>-<version>-<chip>.bin            copy of the image
#   <name>-<version>-<chip>.sig            base64(DER(ECDSA P-256 over SHA-256(bin))), one line
#   <name>-<version>-<chip>.manifest.json  {name, version, chip, role, size, sha256, sig}
#   manifest.json                          JSON array of every *.manifest.json in outdir
set -euo pipefail

if [ $# -lt 6 ]; then
    sed -n '2,12p' "$0" >&2
    exit 2
fi
bin=$1 key=$2 name=$3 version=$4 chip=$5 role=$6
out=${7:-$(dirname "$bin")}
case "$role" in app|launcher) ;; *) echo "role must be app or launcher" >&2; exit 2 ;; esac
mkdir -p "$out"
base="$name-$version-$chip"
dst="$out/$base.bin"
if [ "$(readlink -f "$bin")" != "$(readlink -f "$dst")" ]; then
    cp "$bin" "$dst"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
openssl dgst -sha256 -sign "$key" -out "$tmp/sig.der" "$dst"
# Sanity: the signature must verify against the key's own public half.
openssl pkey -in "$key" -pubout -out "$tmp/pub.pem" 2>/dev/null
openssl dgst -sha256 -verify "$tmp/pub.pem" -signature "$tmp/sig.der" "$dst" >/dev/null
openssl base64 -A -in "$tmp/sig.der" > "$out/$base.sig"
sig=$(cat "$out/$base.sig")
size=$(wc -c < "$dst" | tr -d ' ')
sha=$(openssl dgst -sha256 -r "$dst" | cut -d' ' -f1)

printf '{"name":"%s","version":"%s","chip":"%s","role":"%s","size":%s,"sha256":"%s","sig":"%s"}\n' \
    "$name" "$version" "$chip" "$role" "$size" "$sha" "$sig" > "$out/$base.manifest.json"

# Combined index (one JSON array) for release pages / CI consumers.
{
    printf '['
    first=1
    for m in "$out"/*.manifest.json; do
        [ -f "$m" ] || continue
        [ $first -eq 1 ] || printf ','
        first=0
        tr -d '\n' < "$m"
    done
    printf ']\n'
} > "$out/manifest.json"

echo "$out/$base.bin size=$size sha256=$sha"
