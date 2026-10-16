"""Offline tests for integration/stalwart/prepare-stalwart-cli.sh (audit deploy-4).

The script must refuse any stalwart-cli archive or binary whose SHA-256 is not
the reviewed one, before extracting or running it, including a cached copy.
curl and uname are replaced by fakes on PATH; nothing touches the network.
Run: python3 -m unittest discover -s .github/scripts -p 'test_*.py'
"""
import hashlib
import io
import lzma
import os
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPT = os.path.join(REPO, "integration", "stalwart", "prepare-stalwart-cli.sh")

FAKE_CURL = """#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift 2;; -*) shift;; *) url="$1"; shift;; esac
done
echo "$url" >> "$FAKE_LOG"
[ -n "$FAKE_CURL_FAIL" ] && exit 22
cp "$FAKE_ARCHIVE" "$out"
"""
FAKE_UNAME = '#!/bin/sh\necho "${FAKE_ARCH:-x86_64}"\n'


def make_archive(path, triple, body):
    tar_buf = io.BytesIO()
    with tarfile.open(fileobj=tar_buf, mode="w") as tf:
        info = tarfile.TarInfo(f"stalwart-cli-{triple}/stalwart-cli")
        info.size = len(body)
        info.mode = 0o755
        tf.addfile(info, io.BytesIO(body))
    with open(path, "wb") as f:
        f.write(lzma.compress(tar_buf.getvalue(), format=lzma.FORMAT_XZ))
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def executable(path, text):
    with open(path, "w") as f:
        f.write(text)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


class PrepareStalwartCliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.dir = os.path.join(self.tmp, "stalwart")
        os.makedirs(self.dir)
        self.script = os.path.join(self.dir, "prepare-stalwart-cli.sh")
        shutil.copy(SCRIPT, self.script)
        self.out = os.path.join(self.dir, "stalwart-cli")
        self.bin = os.path.join(self.tmp, "bin")
        os.makedirs(self.bin)
        executable(os.path.join(self.bin, "curl"), FAKE_CURL)
        executable(os.path.join(self.bin, "uname"), FAKE_UNAME)
        self.log = os.path.join(self.tmp, "curl.log")
        self.marker = os.path.join(self.tmp, "EXECUTED")
        # A binary that records being run; any execution of it is a failure
        # unless its hash was deliberately made the reviewed one.
        self.body = f'#!/bin/sh\ntouch "{self.marker}"\necho "stalwart-cli 1.0.6"\n'.encode()
        self.archive = os.path.join(self.tmp, "cli.tar.xz")
        self.archive_sha = make_archive(self.archive, "x86_64-unknown-linux-gnu", self.body)

    def run_script(self, **env):
        e = dict(os.environ, PATH=self.bin + os.pathsep + os.environ["PATH"],
                 FAKE_LOG=self.log, FAKE_ARCHIVE=self.archive)
        e.pop("STALWART_CLI_VERSION", None)
        e.update(env)
        return subprocess.run(["bash", self.script], env=e, capture_output=True, text=True)

    def urls(self):
        return open(self.log).read().split() if os.path.exists(self.log) else []

    def trust_fixture(self, binary=True):
        """Make the fixture's hashes the reviewed ones for 1.0.6/x86_64."""
        text = open(self.script).read()
        block = re.search(r"1\.0\.6/x86_64-unknown-linux-gnu\)\n(.*?);;", text, re.S).group(1)
        new = re.sub(r"TAR_SHA256=\w+", f"TAR_SHA256={self.archive_sha}", block)
        if binary:
            new = re.sub(r"BIN_SHA256=\w+", f"BIN_SHA256={hashlib.sha256(self.body).hexdigest()}", new)
        with open(self.script, "w") as f:
            f.write(text.replace(block, new))

    def test_unknown_version_refused_before_download(self):
        r = self.run_script(STALWART_CLI_VERSION="9.9.9")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("No reviewed checksums", r.stderr)
        self.assertEqual(self.urls(), [])

    def test_architecture_mapping(self):
        for arch, triple in (("x86_64", "x86_64-unknown-linux-gnu"),
                             ("aarch64", "aarch64-unknown-linux-gnu"),
                             ("arm64", "aarch64-unknown-linux-gnu")):
            if os.path.exists(self.log):
                os.remove(self.log)
            self.run_script(FAKE_ARCH=arch)
            self.assertEqual(len(self.urls()), 1, arch)
            self.assertIn(f"/v1.0.6/stalwart-cli-{triple}.tar.xz", self.urls()[0])
        r = self.run_script(FAKE_ARCH="riscv64")
        self.assertNotEqual(r.returncode, 0)

    def test_archive_mismatch_rejected_before_extraction(self):
        r = self.run_script()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("archive checksum mismatch", r.stderr)
        self.assertFalse(os.path.exists(self.out))
        self.assertFalse(os.path.exists(self.marker))

    def test_binary_mismatch_rejected_before_running(self):
        self.trust_fixture(binary=False)
        r = self.run_script()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("binary checksum mismatch", r.stderr)
        self.assertFalse(os.path.exists(self.out))
        self.assertFalse(os.path.exists(self.marker))

    def test_substituted_cached_binary_is_not_run(self):
        executable(self.out, f'#!/bin/sh\ntouch "{self.marker}"\necho "stalwart-cli 1.0.6"\n# other\n')
        r = self.run_script()
        self.assertNotEqual(r.returncode, 0)  # re-download hits the fixture mismatch
        self.assertFalse(os.path.exists(self.marker))
        self.assertFalse(os.path.exists(self.out))
        self.assertEqual(len(self.urls()), 1)

    def test_download_failure(self):
        r = self.run_script(FAKE_CURL_FAIL="1")
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse(os.path.exists(self.out))

    def test_reviewed_binary_installed_then_cached(self):
        self.trust_fixture()
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(os.path.exists(self.marker))  # run once, after verification
        os.remove(self.marker)
        r = self.run_script(FAKE_CURL_FAIL="1")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("already present", r.stdout)
        self.assertEqual(len(self.urls()), 1)  # no second download
        self.assertFalse(os.path.exists(self.marker))


if __name__ == "__main__":
    unittest.main()
