#!/usr/bin/env bash
# Fetch the stalwart-cli binary used by the Stalwart bootstrap image.
#
# The Dockerfile COPYs ./stalwart-cli instead of downloading it during the
# build, because the base image's apt sources and the build network are
# unreachable in the sandboxed CI environment. This script does the fetch on
# the host (which has working outbound HTTPS) and extracts the binary with
# Python's lzma module (xz is not guaranteed to be installed).
#
# Idempotent: skips the download when a binary with the reviewed hash exists.
set -euo pipefail

CLI_VERSION="${STALWART_CLI_VERSION:-1.0.6}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${HERE}/stalwart-cli"

case "$(uname -m)" in
  x86_64)  TRIPLE=x86_64-unknown-linux-gnu ;;
  aarch64|arm64) TRIPLE=aarch64-unknown-linux-gnu ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

# Reviewed SHA-256 of the release archive and of the binary inside it, per
# version and target. The archive is checked before extraction and the binary
# before it is first run (a cached copy too). A new CLI_VERSION needs new
# entries here: hash the release assets and compare with the release's own
# .sha256 files before adding them.
case "${CLI_VERSION}/${TRIPLE}" in
  1.0.6/x86_64-unknown-linux-gnu)
    TAR_SHA256=864e785b8da1ffd899bb16e3d508d5f105de7e561a73012fd389eedbce5e3fad
    BIN_SHA256=681aaa346f1529f340db715ecddef19b47a6bcacc5fb714196f6f75f8a51673c ;;
  1.0.6/aarch64-unknown-linux-gnu)
    TAR_SHA256=3a4086b9108e77b4491f7c2a3b21e7b57e249fa101e5f84c2fc1397abf211823
    BIN_SHA256=39f48e867069b4fd915398590078191c3042dbd3f06ba874f1fdcbbc64e29a43 ;;
  *) echo "No reviewed checksums for stalwart-cli ${CLI_VERSION} (${TRIPLE}); add them to $0" >&2; exit 1 ;;
esac

sha256_of() {
  python3 -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$1"
}

if [ -f "${OUT}" ] && [ "$(sha256_of "${OUT}")" = "${BIN_SHA256}" ]; then
  chmod 755 "${OUT}"
  echo "stalwart-cli ${CLI_VERSION} already present at ${OUT}"
  exit 0
fi
rm -f "${OUT}"

URL="https://github.com/stalwartlabs/cli/releases/download/v${CLI_VERSION}/stalwart-cli-${TRIPLE}.tar.xz"
TARBALL="$(mktemp)"
trap 'rm -f "${TARBALL}"' EXIT

echo "Downloading ${URL}"
curl -sfL -o "${TARBALL}" "${URL}"

GOT="$(sha256_of "${TARBALL}")"
if [ "${GOT}" != "${TAR_SHA256}" ]; then
  echo "stalwart-cli archive checksum mismatch: got ${GOT}, expected ${TAR_SHA256}" >&2
  exit 1
fi

python3 - "${TARBALL}" "${OUT}" "${BIN_SHA256}" <<'PY'
import hashlib, io, lzma, os, sys, tarfile
tarball, out, want = sys.argv[1], sys.argv[2], sys.argv[3]
with lzma.open(tarball) as f:
    data = f.read()
tf = tarfile.open(fileobj=io.BytesIO(data))
member = next(m for m in tf.getmembers() if m.name.endswith("stalwart-cli"))
binary = tf.extractfile(member).read()
got = hashlib.sha256(binary).hexdigest()
if got != want:
    sys.exit(f"stalwart-cli binary checksum mismatch: got {got}, expected {want}")
with open(out, "wb") as w:
    w.write(binary)
os.chmod(out, 0o755)
print(f"wrote {out}")
PY

"${OUT}" --version
