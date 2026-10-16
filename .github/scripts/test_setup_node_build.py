"""Offline tests for setup.sh's Node.js build path (audit deploy-4).

The build must install exactly the lockfile (npm ci) and stop when a step
fails instead of reporting "Build complete!". npm is replaced by a fake on
PATH; nothing is installed or fetched.
Run: python3 -m unittest discover -s .github/scripts -p 'test_*.py'
"""
import os
import shutil
import stat
import subprocess
import tempfile
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SETUP = os.path.join(REPO, "setup.sh")

FAKE_NPM = """#!/bin/sh
echo "$*" >> "$FAKE_LOG"
case "$1" in
  ci|install) exit "${FAKE_INSTALL_RC:-0}" ;;
  run) exit "${FAKE_BUILD_RC:-0}" ;;
esac
"""


class SetupNodeBuildTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        text = open(SETUP).read()
        # Everything before the entry point, so sourcing defines functions only.
        body = text[:text.index("# When piped (e.g. curl | bash)")]
        self.lib = os.path.join(self.tmp, "setup-lib.sh")
        with open(self.lib, "w") as f:
            f.write(body)
        self.bin = os.path.join(self.tmp, "bin")
        os.makedirs(self.bin)
        npm = os.path.join(self.bin, "npm")
        with open(npm, "w") as f:
            f.write(FAKE_NPM)
        os.chmod(npm, os.stat(npm).st_mode | stat.S_IXUSR)
        self.log = os.path.join(self.tmp, "npm.log")

    def run_build(self, **env):
        harness = (f'source "{self.lib}"\n'
                   f'SCRIPT_DIR="{self.tmp}"; CFG_DEPLOY_METHOD=node; CFG_PORT=3000; DRY_RUN=false\n'
                   'run_deployment\n')
        e = dict(os.environ, PATH=self.bin + os.pathsep + os.environ["PATH"], FAKE_LOG=self.log)
        e.update(env)
        return subprocess.run(["bash", "-c", harness], env=e, capture_output=True, text=True)

    def calls(self):
        return open(self.log).read().splitlines() if os.path.exists(self.log) else []

    def test_installs_with_npm_ci(self):
        r = self.run_build()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.calls()[0].split()[0], "ci")
        self.assertNotIn("install", " ".join(self.calls()))
        self.assertIn("Build complete!", r.stdout)

    def test_failed_install_stops_before_build(self):
        r = self.run_build(FAKE_INSTALL_RC="23")
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual([c.split()[0] for c in self.calls()], ["ci"])
        self.assertNotIn("Build complete!", r.stdout)

    def test_failed_build_is_reported(self):
        r = self.run_build(FAKE_BUILD_RC="1")
        self.assertNotEqual(r.returncode, 0)
        self.assertNotIn("Build complete!", r.stdout)


if __name__ == "__main__":
    unittest.main()
