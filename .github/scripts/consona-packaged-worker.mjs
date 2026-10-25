import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadManifest, downloadAsset, requirePublicWindowsRunner } from './windows-fixtures.mjs';

const TAG = 'windows-updater-test-20261025-97d566a4';
const PIN = 'b0821e7dd3c196dd422b8a40db11fd13d241ad658cf7f2af874b3f6f6a277b76';
const OUTPUT_LIMIT = 64 * 1024;
const INSTALL = String.raw`$ErrorActionPreference = 'Stop'
$p = Start-Process -FilePath $env:CONSONA_FIXTURE_INSTALLER -ArgumentList "/S /D=$env:CONSONA_FIXTURE_INSTALL_DIR" -PassThru
if (!$p.WaitForExit(180000)) { $p.Kill(); throw 'Consona fixture installation timed out.' }
if ($p.ExitCode -ne 0) { throw 'Consona fixture installation failed.' }`;

export function approveFixtureInputs(tag, pin) {
  if (tag !== TAG || typeof pin !== 'string' || pin.toLowerCase() !== PIN) {
    throw new Error('This worker check is limited to the existing approved Consona fixture and manifest.');
  }
}
export function silenceRequest() {
  const header = Buffer.from(JSON.stringify({ version: 1, sample_rate: 16000, sample_count: 16000 }));
  const length = Buffer.alloc(4); length.writeUInt32LE(header.length);
  return Buffer.concat([Buffer.from('CONSW001'), length, header, Buffer.alloc(16000 * 4)]);
}
export function installerCommand(installer, directory, environment) {
  if ([installer, directory].some(path => typeof path !== 'string' || !path || /["\r\n\0]/.test(path))) {
    throw new Error('Unsafe fixture installation path.');
  }
  return {
    args: ['-NoProfile', '-NonInteractive', '-Command', INSTALL],
    environment: { ...environment, CONSONA_FIXTURE_INSTALLER: installer, CONSONA_FIXTURE_INSTALL_DIR: directory },
  };
}
export function parseSpeechResult(result) {
  if (result.error || result.status !== 0) throw new Error('Packaged Consona worker failed, timed out, or exceeded its output limit.');
  const stdout = result.stdout ?? Buffer.alloc(0); const stderr = result.stderr ?? Buffer.alloc(0);
  if (stdout.length > OUTPUT_LIMIT || stderr.length > OUTPUT_LIMIT) throw new Error('Packaged Consona worker exceeded its output limit.');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stdout)); }
  catch { throw new Error('Packaged Consona worker did not return valid UTF-8 JSON.'); }
  if (value && typeof value.Err === 'string') throw new Error(`Packaged Consona worker reported: ${value.Err.slice(0, 512)}`);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Array.isArray(value.Ok)) {
    throw new Error('Packaged Consona worker did not return a successful native transcript result.');
  }
  return value.Ok.length;
}
export async function verifyInstalledExecutable(path, expected) {
  const info = await stat(path);
  if (!info.isFile() || info.size !== expected.bytes) throw new Error('Installed Consona executable length does not match the approved reference.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== expected.sha256) throw new Error('Installed Consona executable hash does not match the approved reference.');
}
export async function runPackagedWorker() {
  requirePublicWindowsRunner(process.platform, process.arch, process.env);
  approveFixtureInputs(process.env.FIXTURES_TAG, process.env.MANIFEST_SHA256);
  const directory = await mkdtemp(join(tmpdir(), 'thorn-consona-packaged-worker-'));
  try {
    const manifest = await loadManifest(TAG, PIN);
    const fixture = manifest.apps.Consona;
    const installer = await downloadAsset(TAG, fixture.package, directory);
    const installDirectory = join(directory, 'app');
    const command = installerCommand(installer, installDirectory, process.env);
    const installation = spawnSync('pwsh.exe', command.args, {
      env: command.environment, windowsHide: true, timeout: 190_000, maxBuffer: OUTPUT_LIMIT,
    });
    if (installation.error || installation.status !== 0) throw new Error('Consona fixture installation failed or exceeded its time/output limit.');
    const executable = join(installDirectory, fixture.executableName);
    await verifyInstalledExecutable(executable, fixture.newExecutable);
    const root = await realpath(installDirectory);
    const resources = join(installDirectory, '_up_', 'assets');
    for (const path of [executable, resources, join(resources, 'models'), join(resources, 'runtime', 'windows-x86_64')]) {
      const local = relative(root, await realpath(path));
      if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) throw new Error('Consona packaged assets escape the disposable installation.');
    }
    // No GUI, profile, microphone, project, or external speech-asset argument is used.
    const result = spawnSync(executable, ['--recognition-worker'], {
      cwd: installDirectory, input: silenceRequest(), windowsHide: true, timeout: 120_000, maxBuffer: OUTPUT_LIMIT,
    });
    const segments = parseSpeechResult(result);
    const message = `PASS: actual packaged Consona worker processed 16000 generated silence samples at 16 kHz; native result contained ${segments} segments. Native model/DLL hash checks, DLL loading, model initialisation, and recognition completed.\nManifest SHA-256: ${PIN}\nInstalled executable SHA-256: ${fixture.newExecutable.sha256}\nThis does not test GUI startup, microphone recording, recognition accuracy, or saved projects.\n`;
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, message);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runPackagedWorker(); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Consona packaged worker validation failed.'); process.exitCode = 1; }
}
