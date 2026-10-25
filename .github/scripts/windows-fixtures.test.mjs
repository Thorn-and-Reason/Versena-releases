import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateManifest, loadManifest, downloadAsset, prepareFixtures,
  controllerArguments, requirePublicWindowsRunner,
} from './windows-fixtures.mjs';

const tag = 'windows-updater-test-20261025-1a2b3c4d';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const body = Buffer.from('public fixture bytes');
const descriptor = (file) => ({ file, bytes: body.length, sha256: hash(body) });
function manifest() {
  return {
    schemaVersion: 1,
    tools: { harness: descriptor('updater-smoke.exe'), controller: descriptor('windows-nsis-smoke.ps1') },
    apps: Object.fromEntries(['Versena', 'Tessera', 'Lirensa', 'Consona'].map((name) => [name, {
      oldVersion: '0.0.1', newVersion: '0.0.2', executableName: `${name.toLowerCase()}.exe`,
      oldInstaller: descriptor(`${name}-old-0.0.1-setup.exe`),
      newExecutable: descriptor(`${name}-new-0.0.2.exe`),
      package: descriptor(`${name}-new-0.0.2-setup.exe`),
      publicKey: descriptor(`${name}-updater.pub`),
      signature: descriptor(`${name}-new.sig`),
      unversionedSignature: descriptor(`${name}-unversioned.sig`),
    }]))
  };
}
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'public-fixtures-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function network(value = manifest(), replace = () => undefined) {
  const bytes = Buffer.from(JSON.stringify(value));
  const requests = [];
  return {
    bytes, sha256: hash(bytes), requests,
    fetcher: async (url, options) => {
      requests.push({ url: String(url), options });
      assert.equal(options.redirect, 'manual');
      return replace(String(url)) ?? new Response(String(url).endsWith('/windows-fixtures.json') ? bytes : body);
    },
  };
}

test('accepts the exact four-app schema without mutating it', () => {
  const value = manifest();
  const before = structuredClone(value);
  const accepted = validateManifest(value);
  assert.deepEqual(accepted, value);
  assert.deepEqual(value, before);
  assert.notEqual(accepted, value);
  assert.notEqual(accepted.apps.Versena, value.apps.Versena);
});

test('requires exact schema, applications, fields, and fixed fixture versions', () => {
  for (const change of [
    v => { v.schemaVersion = 2; },
    v => { v.extra = true; },
    v => { delete v.apps.Consona; },
    v => { v.apps.Other = v.apps.Versena; },
    v => { v.apps.Versena.oldVersion = '0.0.0'; },
    v => { v.apps.Versena.newVersion = '0.0.3'; },
    v => { delete v.apps.Versena.unversionedSignature; },
    v => { v.apps.Versena.package.url = 'https://evil.example/payload.exe'; },
    v => { v.tools.extra = v.tools.harness; },
  ]) {
    const value = manifest(); change(value);
    assert.throws(() => validateManifest(value));
  }
  for (const value of [null, [], 'manifest', 1]) assert.throws(() => validateManifest(value));
});

test('rejects unsafe Windows basenames, reserved devices, extensions, and duplicate names', () => {
  for (const file of ['../bad.exe', 'C:bad.exe', 'a/b.exe', 'a\\b.exe', 'bad\n.exe', 'bad".exe', 'bad;.exe', '.exe', 'NUL.exe', 'com1.exe', 'tool.exe.', 'tool.exe ']) {
    const value = manifest(); value.apps.Versena.package.file = file;
    assert.throws(() => validateManifest(value), file);
  }
  for (const change of [
    v => { v.tools.harness.file = 'harness.ps1'; },
    v => { v.tools.controller.file = 'controller.exe'; },
    v => { v.apps.Versena.executableName = '../versena.exe'; },
    v => { v.apps.Versena.executableName = 'NUL.exe'; },
    v => { v.apps.Versena.publicKey.file = 'key.exe'; },
    v => { v.apps.Versena.signature.file = 'signature.exe'; },
    v => { v.apps.Tessera.package.file = v.apps.Versena.package.file.toUpperCase(); },
  ]) { const value = manifest(); change(value); assert.throws(() => validateManifest(value)); }
});

test('bounds exact file sizes and validates SHA-256 values', () => {
  for (const bytes of [0, -1, 1.5, '10', 2 ** 31 + 1, Number.NaN]) {
    const value = manifest(); value.tools.harness.bytes = bytes;
    assert.throws(() => validateManifest(value));
  }
  for (const sha256 of ['', 'g'.repeat(64), 'a'.repeat(63), null]) {
    const value = manifest(); value.apps.Consona.package.sha256 = sha256;
    assert.throws(() => validateManifest(value));
  }
  const value = manifest(); value.tools.harness.bytes = 2 ** 31;
  value.tools.harness.sha256 = value.tools.harness.sha256.toUpperCase();
  assert.equal(validateManifest(value).tools.harness.sha256, hash(body));
});

test('pins the manifest before JSON parsing and rejects bad inputs before networking', async () => {
  const net = network();
  assert.equal((await loadManifest(tag, net.sha256, net.fetcher)).schemaVersion, 1);
  assert.equal(net.requests[0].url, `https://github.com/Thorn-and-Reason/Versena-releases/releases/download/${tag}/windows-fixtures.json`);
  const never = async () => { throw new Error('Networking must not happen'); };
  for (const badTag of ['beta', '../beta', 'windows-updater-test-20261025-1A2B3C4D', `${tag}/file`]) {
    await assert.rejects(loadManifest(badTag, net.sha256, never), /tag/i);
  }
  await assert.rejects(loadManifest(tag, 'invalid', never), /sha/i);
  await assert.rejects(loadManifest(tag, 'a'.repeat(64), net.fetcher), /sha/i);
  const invalidJson = Buffer.from('{');
  await assert.rejects(loadManifest(tag, hash(invalidJson), async () => new Response(invalidJson)), /JSON/i);
});

test('bounds manifest downloads, handles HTTP errors, and rejects insecure redirects', async () => {
  const net = network();
  for (const response of [new Response('error', { status: 503 }), new Response(null, { status: 200 })]) {
    await assert.rejects(loadManifest(tag, net.sha256, async () => response));
  }
  await assert.rejects(loadManifest(tag, net.sha256, async () => new Response('x', { headers: { 'content-length': String(1024 * 1024 + 1) } })), /size/i);
  await assert.rejects(loadManifest(tag, net.sha256, async () => new Response(Buffer.alloc(1024 * 1024 + 1))), /size/i);
  for (const location of ['http://github.com/payload', 'https://evil.example/payload', 'https://user:password@github.com/payload', 'https://github.com/payload#part', 'https://github.com:444/payload']) {
    await assert.rejects(loadManifest(tag, net.sha256, async () => new Response(null, { status: 302, headers: { location } })), /redirect/i);
  }
  await assert.rejects(loadManifest(tag, net.sha256, async () => new Response(null, { status: 302 })), /redirect/i);
  await assert.rejects(loadManifest(tag, net.sha256, async () => new Response(null, { status: 302, headers: { location: 'https://github.com/loop' } })), /redirect/i);
});

test('follows only bounded HTTPS GitHub release redirects without credentials', async () => {
  const net = network(); let requests = 0;
  const accepted = await loadManifest(tag, net.sha256, async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.authorization, undefined);
    return ++requests === 1
      ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/public-fixture' } })
      : new Response(net.bytes);
  });
  assert.equal(accepted.schemaVersion, 1);
  assert.equal(requests, 2);
});

test('streams assets into fresh files with exact bytes and digest before promotion', async (t) => {
  const root = await directory(t);
  const file = descriptor('new.exe');
  const path = await downloadAsset(tag, file, root, async () => new Response(body));
  assert.deepEqual(await readFile(path), body);
  assert.deepEqual(await readdir(root), ['new.exe']);
  await assert.rejects(downloadAsset(tag, file, root, async () => new Response(body)));
  assert.deepEqual(await readFile(path), body);
});

test('failed, oversized, truncated, and corrupt downloads leave no executable output', async (t) => {
  for (const [expected, response] of [
    [descriptor('asset.exe'), new Response('no', { status: 404 })],
    [descriptor('asset.exe'), new Response(Buffer.concat([body, body]))],
    [descriptor('asset.exe'), new Response(body.subarray(1))],
    [{ ...descriptor('asset.exe'), sha256: 'b'.repeat(64) }, new Response(body)],
    [descriptor('asset.exe'), new Response(body, { headers: { 'content-length': String(body.length + 1) } })],
    [descriptor('asset.exe'), new Response(body, { headers: { 'content-length': 'bad' } })],
  ]) {
    const root = await directory(t);
    await assert.rejects(downloadAsset(tag, expected, root, async () => response));
    assert.deepEqual(await readdir(root), []);
  }
});

test('downloads only tools and the selected application and prepares the exact controller command', async (t) => {
  const root = await directory(t); const net = network();
  const ready = await prepareFixtures('Lirensa', tag, net.sha256, root, net.fetcher);
  assert.equal(net.requests.length, 9);
  assert.ok(net.requests.every(r => !/^(Versena|Tessera|Consona)-/.test(new URL(r.url).pathname.split('/').at(-1))));
  const args = controllerArguments(ready);
  assert.deepEqual(args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-File', join(root, 'windows-nsis-smoke.ps1')]);
  assert.ok(args.includes(join(root, 'Lirensa-unversioned.sig')));
  assert.deepEqual(args.slice(-2), ['-TimeoutSeconds', '600']);
  assert.equal(args[args.indexOf('-ExecutableName') + 1], 'lirensa.exe');
  await assert.rejects(prepareFixtures('Other', tag, net.sha256, root, net.fetcher), /application/i);
});

test('a corrupt selected payload prevents preparation completing', async (t) => {
  const root = await directory(t);
  const net = network(manifest(), (url) => url.endsWith('/Consona-new-0.0.2-setup.exe') ? new Response('corrupt') : undefined);
  await assert.rejects(prepareFixtures('Consona', tag, net.sha256, root, net.fetcher));
  assert.ok(!(await readdir(root)).includes('Consona-new-0.0.2-setup.exe'));
});

test('refuses every environment except the public fixed-repository hosted x64 Windows runner', () => {
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', PROCESSOR_ARCHITECTURE: 'AMD64', GITHUB_REPOSITORY: 'Thorn-and-Reason/Versena-releases', VALIDATION_PUBLIC_REPOSITORY: 'true' };
  assert.doesNotThrow(() => requirePublicWindowsRunner('win32', 'x64', env));
  assert.throws(() => requirePublicWindowsRunner('darwin', 'arm64', env));
  for (const key of Object.keys(env)) assert.throws(() => requirePublicWindowsRunner('win32', 'x64', { ...env, [key]: 'wrong' }), key);
});

test('workflow stays manual, public-only, bounded, and free of private builds or uploads', async () => {
  const workflow = await readFile(new URL('../workflows/windows-fixtures.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+(push|pull_request|schedule):/m);
  assert.ok(workflow.includes("github.repository == 'Thorn-and-Reason/Versena-releases'"));
  assert.ok(workflow.includes('github.event.repository.private == false'));
  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(workflow, /timeout-minutes: 20/);
  assert.match(workflow, /application: \[Versena, Tessera, Lirensa, Consona\]/);
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.match(workflow, /repository: Thorn-and-Reason\/Versena-releases/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /secrets\.|contents: write|upload-artifact|\b(cargo|tauri|npm|pnpm)\s+(build|install|ci)\b/);
});

async function diagnosticsScript() {
  const workflow = await readFile(new URL('../workflows/windows-fixtures.yml', import.meta.url), 'utf8');
  return extractDiagnosticsScript(workflow);
}

function extractDiagnosticsScript(workflow) {
  const step = workflow.replace(/\r\n/g, '\n').match(/      - name: Diagnose retained disposable installation\n([\s\S]+)$/);
  assert.ok(step, 'A failed controller run must expose bounded disposable-installation diagnostics');
  assert.match(step[1], /if: failure\(\)/);
  assert.match(step[1], /shell: pwsh/);
  const script = step[1].split('        run: |\n')[1];
  assert.ok(script);
  return script.split('\n').map(line => line.replace(/^          /, '')).join('\n');
}

test('diagnostics extraction accepts a genuine CRLF Windows checkout', async () => {
  const workflow = await readFile(new URL('../workflows/windows-fixtures.yml', import.meta.url), 'utf8');
  const windowsCheckout = workflow.replace(/\r?\n/g, '\r\n');
  assert.ok(windowsCheckout.includes('        run: |\r\n'));
  const script = extractDiagnosticsScript(windowsCheckout);
  assert.equal(script, extractDiagnosticsScript(workflow.replace(/\r\n/g, '\n')));
  assert.ok(!script.includes('\r'));
});

test('failure diagnostics require direct owned temporary roots and reject reparse points', async () => {
  const script = await diagnosticsScript();
  assert.match(script, /\[IO\.Path\]::GetTempPath\(\)/);
  assert.match(script, /TrimEndingDirectorySeparator\(\[IO\.Path\]::GetTempPath\(\)\)/);
  assert.match(script, /-Directory -Filter 'thorn-updater-smoke-\*'/);
  assert.match(script, /\.Parent\.FullName -ne \$temporaryRoot\.FullName/);
  assert.match(script, /ReadAllText\(\$marker\) -cne 'thorn-updater-smoke-v1'/);
  assert.match(script, /\[IO\.FileAttributes\]::ReparsePoint/);
  assert.match(script, /Get-FileHash -LiteralPath \$executable\.FullName -Algorithm SHA256/);
  assert.match(script, /GetVersionInfo\(\$executable\.FullName\)\.ProductVersion/);
  assert.match(script, /CommandLine -match \$ownedRootPattern/);
  assert.match(script, /Get-Process -Id \$process\.ProcessId/);
  assert.match(script, /MainWindowTitle/);
  assert.doesNotMatch(script, /-Recurse|Get-ChildItem\s+Env:|Get-Content\s+Env:|upload-artifact/);
});

test('native PowerShell parses diagnostics and only reads directly owned fixture logs', { skip: process.platform !== 'win32' }, async (t) => {
  const script = await diagnosticsScript();
  const path = join(await directory(t), 'diagnose.ps1');
  await writeFile(path, script);
  const parse = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseFile($env:DIAGNOSTICS_SCRIPT_PATH, [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | Out-String | Write-Error; exit 1 }'], {
    encoding: 'utf8', env: { ...process.env, DIAGNOSTICS_SCRIPT_PATH: path },
  });
  assert.equal(parse.status, 0, parse.stderr);
  const root = await directory(t);
  for (const [relativePath, marker, log] of [
    ['thorn-updater-smoke-owned', 'thorn-updater-smoke-v1', 'SAFE_OWNED_LOG'],
    ['thorn-updater-smoke-wrong', 'thorn-updater-smoke-v1\n', 'UNSAFE_WRONG_MARKER'],
    ['other-directory', 'thorn-updater-smoke-v1', 'UNSAFE_WRONG_NAME'],
    ['nested/thorn-updater-smoke-nested', 'thorn-updater-smoke-v1', 'UNSAFE_NESTED'],
  ]) {
    const fixture = join(root, relativePath);
    await mkdir(fixture, { recursive: true });
    await writeFile(join(fixture, '.updater-smoke-owned'), marker);
    await writeFile(join(fixture, 'harness.log'), log);
  }
  const linked = await directory(t);
  await writeFile(join(linked, '.updater-smoke-owned'), 'thorn-updater-smoke-v1');
  await writeFile(join(linked, 'harness.log'), 'UNSAFE_LINKED_ROOT');
  await symlink(linked, join(root, 'thorn-updater-smoke-linked'), 'junction');
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path], {
    encoding: 'utf8', env: { ...process.env, TEMP: root, TMP: root },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SAFE_OWNED_LOG/);
  assert.doesNotMatch(result.stdout, /UNSAFE_/);
});
