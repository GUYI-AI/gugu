"""Build-only evidence. Reads products and signatures; never launches an App or Simulator."""
import argparse, base64, hashlib, json, os, pathlib, plistlib, re, subprocess, sys, urllib.parse

REPO = pathlib.Path.cwd()
ROOT = pathlib.Path(os.environ['DIAG_ROOT'])
EVIDENCE = ROOT / 'evidence'
HERE = REPO / 'scripts/diagnostics/ios-calendar-build'
MANIFEST = json.loads((HERE / 'input-manifest.json').read_text())


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    return sha(path.read_bytes())


def save(name, value):
    (EVIDENCE / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


def command(label, args):
    result = subprocess.run(args, capture_output=True)
    (EVIDENCE / (label + '.stdout.log')).write_bytes(result.stdout)
    (EVIDENCE / (label + '.stderr.log')).write_bytes(result.stderr)
    save(label + '.command.json', {'argv': args, 'exit': result.returncode})
    require(result.returncode == 0, label + ' failed; preserve its original logs')
    return result.stdout


def source():
    head = git('rev-parse', 'HEAD')
    expected = os.environ.get('EXPECTED_REVISION', '')
    require(re.fullmatch('[0-9a-f]{40}', expected) and head == expected == os.environ['GITHUB_SHA'], 'Unreviewed commit')
    base = MANIFEST['base']
    changed = git('diff', '--name-only', base, head).splitlines()
    allowed = set(MANIFEST['files']) | {'.github/workflows/ci-dev-mac.yml', 'scripts/diagnostics/ios-calendar-build/input-manifest.json'}
    require(set(changed) == allowed, 'Unexpected complete-base source difference')
    require(not git('status', '--porcelain'), 'Checkout is not clean')
    for name, expected_hash in MANIFEST['files'].items():
        require(file_sha(REPO / name) == expected_hash, 'Frozen input bytes differ: ' + name)
    version = command('selected-xcode', [os.environ['DEVELOPER_DIR'] + '/usr/bin/xcodebuild', '-version']).decode()
    require(version == 'Xcode 26.6\nBuild version 17F113\n', 'Selected Xcode changed')
    roots = {key: os.environ[key] for key in ['GUGU_HOME', 'GUGU_USER_DATA_DIR']}
    require(len(set(roots.values())) == 2 and all(pathlib.Path(v).parent == ROOT for v in roots.values()), 'Build environment roots differ')
    save('source.json', {'head': head, 'base': base, 'changed': changed, 'files': MANIFEST['files'],
        'workflowSHA256': file_sha(REPO / '.github/workflows/ci-dev-mac.yml'),
        'inputManifestSHA256': file_sha(HERE / 'input-manifest.json'),
        'lockSHA256': file_sha(REPO / 'pnpm-lock.yaml'), 'selectedXcode': version,
        'imageOS': os.environ.get('ImageOS'), 'imageVersion': os.environ.get('ImageVersion'),
        'roots': roots, 'scope': '11 file-protocol cases, 15 CLT time-policy probes, SDK build-for-testing only'})


def public_configuration():
    path = HERE / 'public-backend.snapshot.json'
    require(file_sha(path) == MANIFEST['backendSHA256'], 'Public backend snapshot changed')
    config = json.loads(path.read_text())
    require(set(config) == {'version', 'supabaseUrl', 'anonKey'} and config['version'] == 1, 'Unexpected public fields')
    url = urllib.parse.urlparse(config['supabaseUrl'])
    require(url.scheme == 'https' and url.hostname == 'devdb.gugu.nextmind.space' and not any([url.username, url.password, url.query, url.fragment]), 'Unexpected preproduction URL')
    key = config['anonKey']
    require(isinstance(key, str) and '\n' not in key and '\r' not in key and key.count('.') == 2, 'Invalid public key shape')
    payload = key.split('.')[1]
    claims = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
    require(claims.get('role') == 'anon' and not claims.get('sub') and not claims.get('session_id'), 'Only a public anon key may enter this build')
    return config


def public_env():
    config = public_configuration()
    with open(os.environ['GITHUB_ENV'], 'a') as stream:
        for name, value in [('GUGU_SUPABASE_URL', config['supabaseUrl']), ('VITE_SUPABASE_URL', config['supabaseUrl']),
                            ('GUGU_SUPABASE_ANON_KEY', config['anonKey']), ('VITE_SUPABASE_ANON_KEY', config['anonKey'])]:
            stream.write(name + '=' + value + '\n')
    save('public-configuration.json', {'configurationSHA256': MANIFEST['backendSHA256'],
        'host': urllib.parse.urlparse(config['supabaseUrl']).hostname,
        'urlSHA256': sha(config['supabaseUrl'].encode()), 'anonKeySHA256': sha(config['anonKey'].encode()),
        'keyRole': 'anon', 'userCredentialsIncluded': False, 'configurationSource': 'one reviewed public snapshot'})


def renderer_record(directory, config):
    require((directory / 'index.html').is_file(), 'Current renderer index missing')
    files = list(directory.rglob('*.js'))
    url_hits = [str(p.relative_to(directory)) for p in files if config['supabaseUrl'].encode() in p.read_bytes()]
    key_hits = [str(p.relative_to(directory)) for p in files if config['anonKey'].encode() in p.read_bytes()]
    require(url_hits and key_hits, 'Reviewed public URL/key not found in the current renderer bytes')
    return {'urlContainingFiles': url_hits, 'keyContainingFiles': key_hits,
            'files': {str(p.relative_to(directory)): file_sha(p) for p in sorted(directory.rglob('*')) if p.is_file() and not p.is_symlink()}}


def verify_runtime(directory):
    asset = (directory / 'agent.js').read_bytes()
    manifest = json.loads((directory / 'manifest.json').read_text())
    require(sha(asset) == MANIFEST['runtimeSHA256'] and len(asset) == MANIFEST['runtimeBytes'], 'Frozen a6 runtime differs')
    require(manifest['sha256'] == sha(asset) and manifest['bytes'] == len(asset) and manifest['piVersion'] == '1.4.0' and manifest['protocolVersion'] == 1, 'Runtime manifest differs')
    require(all(not x.startswith('node:') and 'pi-coding-agent/' not in x for x in manifest['inputs']), 'Node-only runtime input')
    notices = json.loads((directory / 'licenses/npm-packages.json').read_text())
    require(len(notices) == 7, 'License index differs from the frozen a6 input')
    for notice in notices:
        require(notice['files'], 'Missing license file names')
        for name in notice['files']:
            relative = pathlib.PurePosixPath(name)
            require(not relative.is_absolute() and '..' not in relative.parts, 'License path escape')
            require((directory / 'licenses' / name).is_file(), 'Missing license body')
    require(file_sha(directory / 'GuguBackend.json') == MANIFEST['backendSHA256'], 'Native backend bytes differ from the same public snapshot')
    return {'sha256': sha(asset), 'bytes': len(asset), 'licensePackages': len(notices), 'backendSHA256': MANIFEST['backendSHA256']}


def packaged():
    config = public_configuration()
    runtime = verify_runtime(REPO / 'apps/mobile/ios/App/App/HostRuntime')
    phone = renderer_record(REPO / 'dist-phone', config)
    copied = renderer_record(REPO / 'apps/mobile/ios/App/App/public', config)
    require(all(copied['files'].get(name) == value for name, value in phone['files'].items()), 'Cap copy changed renderer source assets')
    copied['generatedExtraFiles'] = sorted(set(copied['files']) - set(phone['files']))
    save('packaged-inputs.json', {'runtime': runtime, 'phoneRenderer': phone, 'copiedRenderer': copied,
        'sourceInfoPlistSHA256': file_sha(REPO / 'apps/mobile/ios/App/App/Info.plist'),
        'businessHTTPRequests': 0, 'appOrSimulatorLaunches': 0})
    require(not git('diff', '--name-only') and not git('status', '--porcelain', '--untracked-files=no'), 'Generation changed tracked source')


def offline():
    protocol = json.loads((EVIDENCE / 'protocol-result.json').read_text())
    require(protocol['testsRun'] == 11 and protocol['successful'] and not any(protocol[x] for x in ['failures', 'errors', 'skipped']), 'Unexpected protocol case results')
    policy = json.loads((EVIDENCE / 'time-policy-result.json').read_text())
    require(policy['actualUIActions'] == 0 and policy['simulators'] == 0 and len(policy['cases']) == 15, 'Unexpected policy scope or count')
    require(len({x['name'] for x in policy['cases']}) == 15 and all(x['passed'] is True for x in policy['cases']), 'A policy probe failed')
    save('offline-source-binary.json', {'protocol': protocol, 'policyCaseCount': 15,
        'policySourceSHA256': file_sha(REPO / 'apps/mobile/ios/HostValidationUI/RuntimeUITimePolicy.swift'),
        'probeSourceSHA256': file_sha(HERE / 'time_policy_probes.swift'),
        'probeBinarySHA256': file_sha(ROOT / 'time-policy-probes'),
        'actualUIActions': 0, 'appOrSimulatorLaunches': 0})


def products():
    products_root = ROOT / 'derived/Build/Products'
    regular, links = {}, {}
    for path in sorted(products_root.rglob('*')):
        relative = str(path.relative_to(products_root))
        if path.is_symlink():
            links[relative] = os.readlink(path)
        elif path.is_file():
            regular[relative] = {'sha256': file_sha(path), 'bytes': path.stat().st_size}
    require(regular, 'No built products')
    save('product-files.json', {'files': regular, 'symlinks': links})
    manifests = sorted(products_root.glob('*.xctestrun'))
    require(manifests, 'No original xctestrun')
    run_records = []
    combined = ''
    for path in manifests:
        raw = path.read_bytes()
        value = plistlib.loads(raw)
        combined += repr(value)
        (EVIDENCE / path.name).write_bytes(raw)
        run_records.append({'path': path.name, 'sha256': sha(raw), 'bytes': len(raw)})
    require('HostValidation.xctest' in combined and 'CalendarUIValidation.xctest' in combined, 'Both test products must be present in original manifests')
    app = products_root / 'Debug-iphonesimulator/App.app'
    config = public_configuration()
    app_runtime = verify_runtime(app / 'HostRuntime')
    app_renderer = renderer_record(app / 'public', config)
    source_renderer = renderer_record(REPO / 'apps/mobile/ios/App/App/public', config)
    require(app_renderer['files'] == source_renderer['files'], 'Actual App renderer differs from prepared public assets')
    source_info = plistlib.loads((REPO / 'apps/mobile/ios/App/App/Info.plist').read_bytes())
    info = plistlib.loads((app / 'Info.plist').read_bytes())
    require(info['CFBundleIdentifier'] == 'app.gugu.chat', 'Wrong actual App bundle')
    require(info['CFBundleShortVersionString'] == '0.3.2' and str(info['CFBundleVersion']) == '1', 'Unexpected App version/build')
    require(str(info['DTSDKName']).startswith('iphonesimulator'), 'Wrong App SDK')
    purposes = ['NSCalendarsUsageDescription', 'NSCalendarsFullAccessUsageDescription']
    for key in purposes:
        require(isinstance(source_info.get(key), str) and source_info[key] and info.get(key) == source_info[key], 'Calendar purpose text changed: ' + key)
    write_only_key = 'NSCalendarsWriteOnlyAccessUsageDescription'
    write_only_declared = write_only_key in source_info
    if write_only_declared:
        require(isinstance(source_info[write_only_key], str) and source_info[write_only_key] and info.get(write_only_key) == source_info[write_only_key], 'Calendar purpose text changed: ' + write_only_key)
        purposes.append(write_only_key)
    else:
        require(write_only_key not in info, 'Unexpected calendar write-only purpose declaration')
    required_bundles = []
    for name in ['HostValidation.xctest', 'CalendarUIValidation.xctest']:
        found = sorted(products_root.rglob(name))
        require(found, 'Missing actual test product: ' + name)
        required_bundles.extend(found)
    ui_runners = sorted(products_root.rglob('CalendarUIValidation-Runner.app'))
    require(ui_runners, 'Missing UI test runner')
    required_bundles.extend([app, *ui_runners])
    signed = []
    for index, path in enumerate(dict.fromkeys(required_bundles)):
        label = 'codesign-' + str(index)
        command(label + '-verify', ['codesign', '--verify', '--deep', '--strict', '--verbose=2', str(path)])
        command(label + '-display', ['codesign', '--display', '--verbose=4', str(path)])
        details = (EVIDENCE / (label + '-display.stderr.log')).read_text()
        require('Signature=adhoc' in details, 'Expected ad-hoc Simulator signature')
        bundle_info = plistlib.loads((path / 'Info.plist').read_bytes())
        executable = path / bundle_info['CFBundleExecutable']
        command(label + '-uuid', ['xcrun', 'dwarfdump', '--uuid', str(executable)])
        signed.append({'path': str(path.relative_to(products_root)), 'identifier': bundle_info['CFBundleIdentifier'],
            'executableSHA256': file_sha(executable), 'displayEvidence': label + '-display.stderr.log'})
    entitlement_bytes = command('app-entitlements', ['codesign', '-d', '--entitlements', ':-', str(app)])
    entitlements = plistlib.loads(entitlement_bytes) if entitlement_bytes.strip() else {}
    require('aps-environment' not in entitlements, 'Device push entitlement appeared in Simulator product')
    save('built-app.json', {'head': git('rev-parse', 'HEAD'), 'bundleIdentifier': info['CFBundleIdentifier'],
        'version': info['CFBundleShortVersionString'], 'build': info['CFBundleVersion'], 'sdk': info['DTSDKName'],
        'calendarPurposeStatements': {key: info[key] for key in purposes}, 'runtime': app_runtime,
        'calendarWriteOnlyPurpose': {'declaredInSource': write_only_declared,
            'declaredInProduct': write_only_key in info, 'status': 'declared' if write_only_declared else 'not-declared'},
        'renderer': app_renderer, 'originalXctestruns': run_records, 'signatures': signed,
        'actualAppExecutions': 0, 'actualSimulatorExecutions': 0, 'actualAuthentication': False,
        'actualEventKit': False, 'actualModelHTTP': False})
    require(not git('diff', '--name-only') and not git('status', '--porcelain', '--untracked-files=no'), 'Final tracked source differs')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('phase', choices=['source', 'public-env', 'packaged', 'offline', 'products'])
    args = parser.parse_args()
    {'source': source, 'public-env': public_env, 'packaged': packaged, 'offline': offline, 'products': products}[args.phase]()
