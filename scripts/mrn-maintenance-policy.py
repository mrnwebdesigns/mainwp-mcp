#!/usr/bin/env python3
"""Owner-only MRN local MCP switch. Backups contain policy, never credentials."""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import tomllib

ADDED = ['mrn_mainwp__maintenance_plugins_v1', 'mrn_mainwp__maintenance_themes_v1']
POLICY_KEYS = ['allowedTools', 'blockedTools', 'abilityNamespaces', 'safeMode', 'requireUserConfirmation']
OLD_PIN = '/Users/khofmeyer/Development/MRN-tools/mainwp-mcp-pins/9a86780ab57e68193b6203710feac7e1d82fc0d5/dist/index.js'
PIN_ROOT = Path('/Users/khofmeyer/Development/MRN-tools/mainwp-mcp-pins')
SETTINGS = Path.home() / '.config/mainwp-mcp/settings.json'
CONFIG = Path.home() / '.codex/config.toml'


def require(test, message):
    if not test:
        raise ValueError(message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate configuration key')
        result[key] = value
    return result


def parse_settings(raw):
    result = json.loads(raw, object_pairs_hook=unique_object)
    require(isinstance(result, dict), 'Expected settings object')
    return result


def policy(settings):
    return {k: settings[k] for k in POLICY_KEYS if k in settings}


def replace_allowlist(raw, expected, replacement):
    """Splice only the allowedTools JSON value; credential bytes are untouched."""
    data = parse_settings(raw)
    require(data.get('allowedTools') == expected, 'Unexpected allowlist')
    text = raw.decode('utf-8')
    decoder = json.JSONDecoder()
    i = text.index('{') + 1
    while True:
        while text[i].isspace() or text[i] == ',':
            i += 1
        key, i = decoder.raw_decode(text, i)
        while text[i].isspace():
            i += 1
        require(text[i] == ':', 'Expected settings separator')
        i += 1
        while text[i].isspace():
            i += 1
        start = i
        _, i = decoder.raw_decode(text, i)
        if key == 'allowedTools':
            new = (text[:start] + json.dumps(replacement, ensure_ascii=True) + text[i:]).encode('utf-8')
            require(parse_settings(new) == {**data, 'allowedTools': replacement}, 'Unexpected settings mutation')
            return new


def replace_launch(raw, source, target):
    text = raw.decode('utf-8')
    before = tomllib.loads(text)
    require(before['mcp_servers']['mainwp']['command'] == 'node', 'Unexpected command')
    require(before['mcp_servers']['mainwp']['args'] == [source], 'Unexpected launch pin')
    sections = list(re.finditer(r'^\[mcp_servers\.mainwp\]\s*\n(?:(?!^\[).)*', text, re.M | re.S))
    require(len(sections) == 1 and sections[0].group().count(source) == 1, 'Ambiguous MainWP entry')
    match = sections[0]
    new = text[:match.start()] + match.group().replace(source, target) + text[match.end():]
    before['mcp_servers']['mainwp']['args'] = [target]
    require(tomllib.loads(new) == before, 'Unexpected MCP configuration mutation')
    return new.encode('utf-8')


def snapshot(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid(), 'Configuration must be owner-owned regular file')
    require(stat.S_IMODE(info.st_mode) == 0o600, 'Configuration mode must be 0600')
    raw = path.read_bytes()
    require(path.lstat() == info, 'Concurrent configuration change')
    return info, raw


def atomic_write(path, before, new, before_replace=None):
    info, raw = before
    require(snapshot(path) == before, 'Concurrent configuration change')
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '.maintenance-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(new)
            stream.flush()
            os.fsync(stream.fileno())
        if before_replace:
            before_replace()
        require(snapshot(path) == (info, raw), 'Concurrent configuration change')
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def private_file(path, raw, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())


@contextlib.contextmanager
def lock(directory):
    path = directory / '.maintenance-policy.lock'
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        require(info.st_uid == os.getuid() and stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600, 'Unsafe policy lock')
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def transform(settings_before, config_before, old_pin, new_pin, reverse=False, expected_policy=None):
    current = parse_settings(settings_before)
    require(current.get('dashboardUrl') == 'https://wpcontrol.mrndev.io', 'Unexpected Dashboard')
    require(current.get('safeMode') is False and current.get('requireUserConfirmation') is True, 'Unexpected safety policy')
    require(current.get('abilityNamespaces') == ['mainwp', 'mrn-mainwp'], 'Unexpected namespaces')
    allowed = current.get('allowedTools')
    require(isinstance(allowed, list) and all(isinstance(t, str) for t in allowed) and len(set(allowed)) == len(allowed), 'Expected exact unique allowlist')
    require(not set(ADDED) & set(current.get('blockedTools', [])), 'Maintenance tools explicitly blocked')
    if reverse:
        require(policy(current) == {**expected_policy, 'allowedTools': expected_policy['allowedTools'] + ADDED}, 'Policy changed after switch; review rollback')
        tools = expected_policy['allowedTools']
    else:
        require(not set(ADDED) & set(allowed), 'Maintenance policy already changed')
        require(not any(t in allowed for t in ['update_site_core_v1', 'run_updates_v1', 'update_all_v1', 'update_site_plugins_v1', 'update_site_themes_v1']), 'Unguarded update tool already exposed; review policy')
        tools = allowed + ADDED
    return replace_allowlist(settings_before, allowed, tools), replace_launch(config_before, old_pin, new_pin)


def transaction(settings_path, config_path, replacement):
    before_settings = snapshot(settings_path)
    before_config = snapshot(config_path)
    new_settings, new_config = replacement(before_settings[1], before_config[1])
    # Preflight both files before either mutation, then guard each replacement again.
    require(snapshot(settings_path) == before_settings and snapshot(config_path) == before_config, 'Concurrent configuration change')
    atomic_write(settings_path, before_settings, new_settings)
    try:
        atomic_write(config_path, before_config, new_config)
    except BaseException:
        # Refuse to overwrite any intervening edit during recovery as well.
        current = snapshot(settings_path)
        require(current[1] == new_settings, 'Concurrent policy change prevents automatic recovery')
        atomic_write(settings_path, current, before_settings[1])
        raise
    require(snapshot(settings_path)[1] == new_settings and snapshot(config_path)[1] == new_config, 'Readback mismatch')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['apply', 'rollback'])
    parser.add_argument('--pin')
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    evidence = args.evidence
    evidence.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(not evidence.is_symlink() and evidence.stat().st_uid == os.getuid() and stat.S_IMODE(evidence.stat().st_mode) == 0o700, 'Evidence directory must be owner-owned mode 0700')
    with lock(SETTINGS.parent):
        if args.action == 'apply':
            target = Path(args.pin or '')
            require(target.is_file() and target.parent.name == 'dist' and target.name == 'index.js' and target.parent.parent.parent.resolve() == PIN_ROOT.resolve() and re.fullmatch('[a-f0-9]{40}', target.parent.parent.name), 'Expected built immutable MRN pin')
            old = parse_settings(snapshot(SETTINGS)[1])
            record = {'oldPolicy': policy(old), 'addedTools': ADDED, 'oldPin': OLD_PIN, 'newPin': str(target), 'providerDeploymentRequired': True}
            private_file(evidence / 'policy-before.json', (json.dumps(record, indent=2) + '\n').encode())
            private_file(evidence / 'mrn-maintenance-policy.py', Path(__file__).read_bytes())
            rollback = "#!/usr/bin/env python3\nimport runpy,sys\nfrom pathlib import Path\np=Path(__file__).resolve().parent\nsys.argv=[str(p/'mrn-maintenance-policy.py'),'rollback','--evidence',str(p)]\nrunpy.run_path(sys.argv[0],run_name='__main__')\n"
            private_file(evidence / 'rollback.py', rollback.encode())
            def apply_current(s, c):
                require(policy(parse_settings(s)) == record['oldPolicy'], 'Policy changed while preparing audit record')
                return transform(s, c, OLD_PIN, str(target))
            transaction(SETTINGS, CONFIG, apply_current)
        else:
            record = json.loads((evidence / 'policy-before.json').read_text())
            transaction(SETTINGS, CONFIG, lambda s,c: transform(s,c,record['newPin'],record['oldPin'],True,record['oldPolicy']))
    print(json.dumps({'action': args.action, 'settings_mode': '0600', 'credentials_unchanged': True, 'restart_required': True, 'provider_deployment_required': True}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Never print exception text: a parser or operating-system exception may retain input bytes.
        raise SystemExit('Policy switch refused (' + type(error).__name__ + '); no credential values were logged.')
