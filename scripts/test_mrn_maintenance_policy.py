"""Policy mutation tests use artificial credentials in temporary directories only."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('policy', Path(__file__).with_name('mrn-maintenance-policy.py'))
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class PolicyTest(unittest.TestCase):
    def setUp(self):
        self.data = {'dashboardUrl': 'https://wpcontrol.mrndev.io', 'safeMode': False, 'requireUserConfirmation': True,
                     'abilityNamespaces': ['mainwp', 'mrn-mainwp'], 'allowedTools': ['get_site_v1'], 'appPassword': 'fixture\\u0020password'}
        self.raw = (json.dumps(self.data, indent=2) + '\n').encode()
        self.config = ('[mcp_servers.mainwp]\ncommand = "node"\nargs = ["' + policy.OLD_PIN + '"]\n\n[mcp_servers.other]\ncommand = "unchanged"\n').encode()
        self.target = '/fixture/new/dist/index.js'

    def test_exact_apply_and_round_trip(self):
        settings, config = policy.transform(self.raw, self.config, policy.OLD_PIN, self.target)
        self.assertEqual(json.loads(settings), {**self.data, 'allowedTools': ['get_site_v1'] + policy.ADDED})
        restored, old_config = policy.transform(settings, config, self.target, policy.OLD_PIN, True, policy.policy(self.data))
        self.assertEqual(json.loads(restored), self.data)
        self.assertEqual(old_config, self.config)
        old_tail = self.raw[self.raw.index(b'"appPassword"'):]
        self.assertEqual(settings[settings.index(b'"appPassword"'):], old_tail)

    def test_refuses_changed_policy_during_rollback(self):
        settings, config = policy.transform(self.raw, self.config, policy.OLD_PIN, self.target)
        changed = json.loads(settings); changed['allowedTools'].append('another')
        with self.assertRaises(ValueError):
            policy.transform(json.dumps(changed).encode(), config, self.target, policy.OLD_PIN, True, policy.policy(self.data))

    def test_duplicate_settings_keys_rejected(self):
        with self.assertRaises(ValueError):
            policy.parse_settings(b'{"allowedTools":[],"allowedTools":[]}')

    def test_no_secret_in_policy_snapshot(self):
        self.assertNotIn('appPassword', policy.policy(self.data))
        self.assertNotIn(self.data['appPassword'], json.dumps(policy.policy(self.data)))

    def test_safety_policy_and_unguarded_core_are_not_overridden(self):
        for patch in [{'safeMode': True}, {'requireUserConfirmation': False}, {'allowedTools': ['update_site_core_v1']},
                      {'allowedTools': ['run_updates_v1']}, {'blockedTools': [policy.ADDED[0]]}, {'dashboardUrl': 'https://other.example'}]:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                policy.transform(json.dumps({**self.data, **patch}).encode(), self.config, policy.OLD_PIN, self.target)

    def test_atomic_write_guards_concurrent_edits_and_cleans_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / 'settings.json'; p.write_bytes(self.raw); p.chmod(0o600)
            before = policy.snapshot(p)
            with self.assertRaises(ValueError):
                policy.atomic_write(p, before, b'new', before_replace=lambda: p.write_bytes(b'concurrent'))
            self.assertEqual(p.read_bytes(), b'concurrent')
            self.assertEqual(list(Path(directory).iterdir()), [p])

    def test_symlink_and_insecure_mode_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / 'settings.json'; p.write_bytes(self.raw); p.chmod(0o644)
            with self.assertRaises(ValueError): policy.snapshot(p)
            p.chmod(0o600); link = Path(directory) / 'link'; link.symlink_to(p)
            with self.assertRaises(ValueError): policy.snapshot(link)

    def test_transaction_preserves_unrelated_settings_and_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            s = Path(directory) / 'settings.json'; c = Path(directory) / 'config.toml'
            s.write_bytes(self.raw); c.write_bytes(self.config); s.chmod(0o600); c.chmod(0o600)
            policy.transaction(s,c,lambda a,b: policy.transform(a,b,policy.OLD_PIN,self.target))
            self.assertEqual(s.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(s.read_bytes())['appPassword'], self.data['appPassword'])
            self.assertIn(b'command = "unchanged"', c.read_bytes())
            self.assertEqual(set(os.listdir(directory)), {'settings.json','config.toml'})


if __name__ == '__main__':
    unittest.main()
