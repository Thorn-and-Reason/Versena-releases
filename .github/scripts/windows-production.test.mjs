import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controllerArguments, downloadAsset, loadReleaseManifest } from './windows-fixtures.mjs';
import {
  validateProductionManifest, prepareProductionFixtures, runProductionWorker, runProductionValidation,
} from './windows-production.mjs';

const tag = 'windows-updater-test-20261025-1234abcd';
const body = Buffer.from('verified public production payload');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const descriptor = file => ({ file, bytes: body.length, sha256: hash(body) });
const versions = {
  Versena: ['0.1.3-beta.1', '0.1.3-beta.2', 'versena.exe'],
  Tessera: ['0.1.1-beta.1', '0.1.1-beta.2', 'tessera-desktop.exe'],
  Lirensa: ['0.1.1-beta.1', '0.1.1-beta.2', 'lirensa-desktop.exe'],
  Consona: ['0.2.1-beta.1', '0.2.1-beta.2', 'consona-desktop.exe'],
};
const environment = {
  GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows',
  PROCESSOR_ARCHITECTURE: 'AMD64', GITHUB_REPOSITORY: 'Thorn-and-Reason/Versena-releases',
  VALIDATION_PUBLIC_REPOSITORY: 'true', FIXTURE_APP: 'Lirensa', TOOLS_TAG: tag,
};
function manifest() {
  return {
    schemaVersion: 1,
    tools: { harness: descriptor('updater-smoke.exe'), controller: descriptor('windows-nsis-smoke.ps1') },
    apps: Object.fromEntries(Object.entries(versions).map(([name, [oldVersion, newVersion, executableName]]) => [name, {
      oldVersion, newVersion, executableName,
      oldInstaller: descriptor(`${name}_${oldVersion}_windows-x86_64-setup.exe`),
      package: descriptor(`${name}_${newVersion}_windows-x86_64-setup.exe`),
      signature: descriptor(`${name}_${newVersion}_windows-x86_64-setup.exe.sig`),
      newExecutable: descriptor(`${name}_${newVersion}_x64-reference.exe`),
      publicKey: descriptor(`${name}-updater.pub`),
    }])),
  };
}
function network(value = manifest(), replace = () => undefined) {
  const content = Buffer.from(JSON.stringify(value)); const requests = [];
  return {
    content, pin: hash(content), requests,
    fetcher: async (url, options) => {
      requests.push(String(url));
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers.authorization, undefined);
      return replace(String(url)) ?? new Response(String(url).endsWith('/windows-production.json') ? content : body);
    },
  };
}
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'production-validation-test-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
const readyForWorker = root => ({
  fixture: validateProductionManifest(manifest()).apps.Consona,
  paths: { package: join(root, 'downloaded.exe') },
});
function workerRunner({ escape = false, corrupt = false, installResult, workerResult } = {}) {
  return (command, args, options) => {
    if (command === 'pwsh.exe') {
      if (installResult) return installResult;
      const root = options.env.CONSONA_FIXTURE_INSTALL_DIR;
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'consona-desktop.exe'), corrupt ? Buffer.from('corrupt') : body);
      mkdirSync(join(root, '_up_', 'assets', 'runtime', 'windows-x86_64'), { recursive: true });
      if (escape) symlinkSync(tmpdir(), join(root, '_up_', 'assets', 'models'), process.platform === 'win32' ? 'junction' : 'dir');
      else mkdirSync(join(root, '_up_', 'assets', 'models'));
      return { status: 0 };
    }
    return workerResult ?? { status: 0, stdout: Buffer.from('{"Ok":[]}'), stderr: Buffer.alloc(0) };
  };
}

test('production manifests accept only the four reviewed beta transitions and exact public filenames', () => {
  const original = manifest(); const accepted = validateProductionManifest(original);
  assert.deepEqual(accepted, original);
  assert.notEqual(accepted, original);
  assert.notEqual(accepted.apps.Consona, original.apps.Consona);
  for (const name of Object.keys(versions)) {
    for (const field of ['oldVersion', 'newVersion', 'executableName']) {
      const bad = structuredClone(original); bad.apps[name][field] = 'unreviewed';
      assert.throws(() => validateProductionManifest(bad), /fixed|reviewed/i);
    }
    for (const field of ['oldInstaller', 'package', 'signature', 'newExecutable', 'publicKey']) {
      const bad = structuredClone(original); bad.apps[name][field].file = 'other.exe';
      assert.throws(() => validateProductionManifest(bad), /filename/i);
    }
  }
});

test('Consona worker reuses the downloaded beta installer and verifies actual installed bytes before generated silence', async t => {
  const root = await directory(t); const ready = readyForWorker(root); const boundary = workerRunner(); let workerInput;
  const result = await runProductionWorker(ready, root, { platform: 'win32', architecture: 'x64', environment, runner: (command, args, options) => {
    if (command !== 'pwsh.exe') {
      workerInput = options.input;
      assert.equal(command, join(root, 'worker-app', 'consona-desktop.exe'));
      assert.deepEqual(args, ['--recognition-worker']);
      assert.equal(options.cwd, join(root, 'worker-app'));
      assert.equal(options.timeout, 120000);
    } else assert.equal(options.env.CONSONA_FIXTURE_INSTALLER, ready.paths.package);
    return boundary(command, args, options);
  } });
  assert.equal(result, 0);
  assert.equal(workerInput.subarray(0, 8).toString(), 'CONSW001');
  const length = workerInput.readUInt32LE(8);
  assert.deepEqual(JSON.parse(workerInput.subarray(12, 12 + length)), { version: 1, sample_rate: 16000, sample_count: 16000 });
  assert.ok(workerInput.subarray(12 + length).equals(Buffer.alloc(64000)));
});

test('Consona worker rejects installer failures, changed executable bytes, escaping resources and failed native results', async t => {
  for (const options of [
    { installResult: { status: 1 } }, { installResult: { status: null, error: new Error('timeout') } },
    { corrupt: true }, { escape: true }, { workerResult: { status: 1 } },
    { workerResult: { status: 0, stdout: Buffer.from('{"Err":"model unavailable"}') } },
  ]) {
    const root = await directory(t);
    await assert.rejects(runProductionWorker(readyForWorker(root), root, { platform: 'win32', architecture: 'x64', environment, runner: workerRunner(options) }), /install|executable|escape|worker|model/i);
  }
});

test('Consona production run checks the beta2 worker without a second package download', async () => {
  const net = network(); const worker = workerRunner(); let calls = 0;
  const message = await runProductionValidation({ platform: 'win32', architecture: 'x64',
    environment: { ...environment, FIXTURE_APP: 'Consona', MANIFEST_SHA256: net.pin }, fetcher: net.fetcher,
    runner: (command, args, options) => ++calls <= 2 ? { status: 0 } : worker(command, args, options),
  });
  assert.equal(calls, 4);
  assert.match(message, /actual packaged Consona worker.*0 segments/i);
  assert.equal(net.requests.filter(x => x.endsWith('/Consona_0.2.1-beta.2_windows-x86_64-setup.exe')).length, 1);
});

test('production manifests reject added origins, missing apps/tools and invalid descriptors before any download', () => {
  for (const change of [
    x => { x.repository = 'elsewhere'; }, x => { x.schemaVersion = 2; },
    x => { delete x.apps.Consona; }, x => { x.apps.Other = x.apps.Consona; },
    x => { x.tools.harness.file = 'another-helper.exe'; },
    x => { x.tools.controller.file = 'another-controller.ps1'; },
    x => { x.apps.Versena.repository = 'another/repo'; },
    x => { x.apps.Versena.publicKey.bytes = 0; },
    x => { x.apps.Tessera.package.sha256 = 'truncated'; },
    x => { x.apps.Lirensa.oldInstaller.file = '../escape.exe'; },
    x => { x.apps.Consona.unversionedSignature = descriptor('forbidden.sig'); },
  ]) {
    const value = manifest(); change(value); assert.throws(() => validateProductionManifest(value));
  }
  for (const value of [null, [], 'manifest']) assert.throws(() => validateProductionManifest(value));
});

test('production manifest bytes must match the approved hash and use the fixed tools release origin', async () => {
  const net = network();
  const value = await loadReleaseManifest(tag, net.pin, 'windows-production.json', net.fetcher);
  assert.deepEqual(value, manifest());
  assert.deepEqual(net.requests, [`https://github.com/Thorn-and-Reason/Versena-releases/releases/download/${tag}/windows-production.json`]);
  await assert.rejects(loadReleaseManifest(tag, '0'.repeat(64), 'windows-production.json', net.fetcher), /SHA-256/);
  await assert.rejects(loadReleaseManifest('beta', net.pin, 'windows-production.json', net.fetcher), /tag/i);
});

test('production preparation reuses normal versioned installers and downloads only one selected app', async t => {
  const root = await directory(t); const net = network();
  const ready = await prepareProductionFixtures('Consona', tag, net.pin, root, net.fetcher);
  assert.equal(ready.application, 'Consona');
  assert.equal(net.requests.length, 8);
  assert.deepEqual(net.requests.filter(x => x.includes('/Consona-releases/')), [
    'https://github.com/Thorn-and-Reason/Consona-releases/releases/download/beta/Consona_0.2.1-beta.1_windows-x86_64-setup.exe',
    'https://github.com/Thorn-and-Reason/Consona-releases/releases/download/beta/Consona_0.2.1-beta.2_windows-x86_64-setup.exe',
    'https://github.com/Thorn-and-Reason/Consona-releases/releases/download/beta/Consona_0.2.1-beta.2_windows-x86_64-setup.exe.sig',
  ]);
  assert.ok(net.requests.every(x => !/\/(Versena|Tessera|Lirensa)-releases\/releases\/download\/beta\//.test(x)));
  assert.equal((await readdir(root)).length, 7);
  assert.deepEqual(await readFile(ready.paths.package), body);
  const args = controllerArguments(ready);
  assert.ok(!args.includes('-UnversionedSignature'));
  assert.ok(args.every(x => typeof x === 'string'));
  assert.equal(args[args.indexOf('-OldVersion') + 1], '0.2.1-beta.1');
  assert.equal(args[args.indexOf('-NewVersion') + 1], '0.2.1-beta.2');
  await assert.rejects(prepareProductionFixtures('Unknown', tag, net.pin, root, net.fetcher), /application/i);
});

test('production download origins reject arbitrary repositories, tags, insecure redirects and corrupt payloads', async t => {
  const root = await directory(t); const file = descriptor('candidate.exe');
  for (const [releaseTag, application] of [['beta', 'other/repository'], ['latest', 'Consona'], ['beta', 'consona']]) {
    await assert.rejects(downloadAsset(releaseTag, file, root, async () => new Response(body), application), /application|tag/i);
  }
  await assert.rejects(downloadAsset('beta', file, root,
    async () => new Response(null, { status: 302, headers: { location: 'https://outside.example/payload' } }), 'Consona'), /redirect/i);
  const net = network(manifest(), url => url.includes('/Consona-releases/') && url.endsWith('.exe') ? new Response('corrupt') : undefined);
  await assert.rejects(prepareProductionFixtures('Consona', tag, net.pin, root, net.fetcher), /size|SHA-256/i);
  assert.ok(!(await readdir(root)).includes('Consona_0.2.1-beta.1_windows-x86_64-setup.exe'));
});

test('the production runner refuses non-hosted and private environments before network or process execution', async () => {
  let calls = 0;
  await assert.rejects(runProductionValidation({ platform: 'darwin', architecture: 'arm64', environment,
    fetcher: () => { calls++; }, runner: () => { calls++; } }), /ephemeral/i);
  assert.equal(calls, 0);
  await assert.rejects(runProductionValidation({ platform: 'win32', architecture: 'x64',
    environment: { ...environment, VALIDATION_PUBLIC_REPOSITORY: 'false' }, fetcher: () => { calls++; }, runner: () => { calls++; } }), /ephemeral/i);
  assert.equal(calls, 0);
  await assert.rejects(runProductionWorker({}, 'unused', { platform: 'darwin', architecture: 'arm64', environment,
    runner: () => { calls++; } }), /ephemeral/i);
  assert.equal(calls, 0);
});

test('the runner executes monitor regression before the genuine production upgrade and cleans verified files', async t => {
  const net = network(); const summary = join(await directory(t), 'summary.md'); const commands = [];
  const message = await runProductionValidation({ platform: 'win32', architecture: 'x64',
    environment: { ...environment, MANIFEST_SHA256: net.pin, GITHUB_STEP_SUMMARY: summary }, fetcher: net.fetcher,
    runner: (command, args) => { commands.push({ command, args }); return { status: 0 }; },
  });
  assert.equal(commands.length, 2);
  assert.equal(commands[0].command, 'pwsh.exe');
  assert.deepEqual(commands[0].args.slice(-1), ['-MonitorSelfTest']);
  assert.ok(commands[1].args.includes('-OldInstaller'));
  assert.ok(commands[1].args.includes('-Signature'));
  assert.match(message, /Lirensa.*0\.1\.1-beta\.1.*0\.1\.1-beta\.2/);
  assert.match(message, /four negative/i);
  assert.match(message, /not GUI startup or project restoration/);
  assert.equal(await readFile(summary, 'utf8'), message);
  const controller = commands[0].args[3]; await assert.rejects(readFile(controller), { code: 'ENOENT' });
});

test('failed controller regression or genuine upgrade stops validation and always removes downloaded executables', async () => {
  for (const failure of [{ status: 1 }, { status: null, error: new Error('process failed') }]) {
    for (const failureStep of [1, 2]) {
      const net = network(); const commands = [];
      await assert.rejects(runProductionValidation({ platform: 'win32', architecture: 'x64',
        environment: { ...environment, MANIFEST_SHA256: net.pin }, fetcher: net.fetcher,
        runner: (_command, args) => { commands.push(args); return commands.length === failureStep ? failure : { status: 0 }; },
      }), failureStep === 1 ? /monitor/i : /NSIS/i);
      assert.equal(commands.length, failureStep);
      await assert.rejects(readFile(commands[0][3]), { code: 'ENOENT' });
    }
  }
});

test('production workflow is manual, public-only, read-only and capped at twenty minutes', async () => {
  // JSON is a YAML 1.2 document; parsing the workflow directly tests its policy without a YAML dependency.
  const workflow = JSON.parse(await readFile(new URL('../workflows/windows-production.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ['tools_tag', 'manifest_sha256']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.deepEqual(Object.keys(workflow.jobs), ['validate']);
  const job = workflow.jobs.validate;
  assert.equal(job.if, "${{ github.repository == 'Thorn-and-Reason/Versena-releases' && github.event.repository.private == false }}");
  assert.equal(job['runs-on'], 'windows-latest');
  assert.equal(job['timeout-minutes'], 20);
  assert.deepEqual(job.strategy.matrix.application, ['Versena', 'Tessera', 'Lirensa', 'Consona']);
  assert.equal(job.strategy['fail-fast'], false);
  assert.equal(job.steps[0].with.repository, 'Thorn-and-Reason/Versena-releases');
  assert.equal(job.steps[0].with.ref, '${{ github.sha }}');
  assert.equal(job.steps[0].with['persist-credentials'], false);
  const validation = job.steps.find(step => step.run === 'node .github/scripts/windows-production.mjs');
  assert.deepEqual(validation.env, {
    FIXTURE_APP: '${{ matrix.application }}', TOOLS_TAG: '${{ inputs.tools_tag }}',
    MANIFEST_SHA256: '${{ inputs.manifest_sha256 }}', VALIDATION_PUBLIC_REPOSITORY: '${{ github.event.repository.private == false }}',
  });
  for (const step of job.steps) {
    assert.ok(!step.uses?.includes('upload'));
    assert.doesNotMatch(JSON.stringify(step), /secrets\.|contents: write|\b(cargo|tauri|npm|pnpm)\s+(build|install|ci)\b/);
  }
});
