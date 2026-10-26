"""Check build/publish safeguards without requiring Docker or a registry login."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'script' / 'make-docker.sh'


class DockerScriptTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name)
        self.log = self.folder / 'docker-calls.jsonl'
        fake = self.folder / 'docker'
        fake.write_text('#!/usr/bin/env python3\nimport json,os,sys\nwith open(os.environ["DOCKER_CALLS"],"a") as f: f.write(json.dumps(sys.argv[1:])+"\\n")\n')
        fake.chmod(0o755)
        self.env = {key: value for key, value in os.environ.items() if key not in
            ('IMAGE_NAME', 'IMAGE_TAG', 'BUILD_TARGET', 'PLATFORMS', 'PUSH', 'TAG_LATEST')}
        self.env.update(PATH=str(self.folder)+os.pathsep+os.environ['PATH'], DOCKER_CALLS=str(self.log))

    def run_script(self, *args, **settings):
        result = subprocess.run(['bash', str(SCRIPT), *args], env=dict(self.env, **settings), cwd=self.folder,
                                capture_output=True, text=True)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
        return result, calls

    def test_defaults_build_locally_from_any_directory_without_publishing(self):
        result, calls = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        build = calls[-1]
        self.assertEqual(build[:2], ['buildx', 'build'])
        self.assertIn('sentinel-atlas:local', build)
        self.assertIn('--load', build)
        self.assertNotIn('--push', build)
        self.assertEqual(build[-1], str(ROOT))
        self.assertNotIn('--build-arg', build)

    def test_explicit_publish_uses_repository_version_and_multiarch(self):
        result, calls = self.run_script(IMAGE_NAME='example/sentinel-atlas', IMAGE_TAG='1.2.3', PUSH='true', TAG_LATEST='true')
        self.assertEqual(result.returncode, 0, result.stderr)
        build = calls[-1]
        self.assertIn('--push', build)
        self.assertNotIn('--load', build)
        self.assertIn('linux/amd64,linux/arm64', build)
        self.assertIn('example/sentinel-atlas:1.2.3', build)
        self.assertIn('example/sentinel-atlas:latest', build)

    def test_unsafe_or_incomplete_settings_fail_before_docker(self):
        for values in ({'PUSH': 'yes'}, {'PUSH': 'true'}, {'PUSH': 'true', 'IMAGE_NAME': 'example/sentinel-atlas'},
                       {'BUILD_TARGET': 'unknown'}, {'PLATFORMS': 'linux/amd64,linux/arm64'},
                       {'IMAGE_TAG': 'bad tag'}, {'IMAGE_NAME': 'name;touch /tmp/no'}):
            with self.subTest(values=values):
                result, calls = self.run_script(**values)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, [])

    def test_dry_run_never_contacts_docker_and_options_override_variables(self):
        result, calls = self.run_script('--dry-run', '--image', 'example/atlas', '--tag', 'release', '--target', 'ansible', IMAGE_NAME='ignored', IMAGE_TAG='ignored')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('example/atlas:release', result.stdout)
        self.assertIn('--target ansible', result.stdout)
        self.assertEqual(calls, [])


if __name__ == '__main__':
    unittest.main()
