import { appendFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  exactKeys, descriptor, loadReleaseManifest, downloadAsset, controllerArguments,
  controllerRegressionArguments, requirePublicWindowsRunner,
} from './windows-fixtures.mjs';
import {
  installerCommand, verifyInstalledExecutable, silenceRequest, parseSpeechResult,
} from './consona-packaged-worker.mjs';

const APPLICATIONS = {
  Versena: ['0.1.3-beta.1', '0.1.3-beta.2', 'versena.exe'],
  Tessera: ['0.1.1-beta.1', '0.1.1-beta.2', 'tessera-desktop.exe'],
  Lirensa: ['0.1.1-beta.1', '0.1.1-beta.2', 'lirensa-desktop.exe'],
  Consona: ['0.2.1-beta.1', '0.2.1-beta.2', 'consona-desktop.exe'],
};
const TOOL_FILES = { harness: 'updater-smoke.exe', controller: 'windows-nsis-smoke.ps1' };
const FILE_FIELDS = ['oldInstaller', 'package', 'signature', 'newExecutable', 'publicKey'];
const NORMAL_RELEASE_FILES = new Set(['oldInstaller', 'package', 'signature']);
const OUTPUT_LIMIT = 64 * 1024;

function namedDescriptor(value, filename) {
  const result = descriptor(value);
  if (result.file !== filename) throw new Error('Production asset filename must match its fixed reviewed role.');
  return result;
}
export function validateProductionManifest(value) {
  exactKeys(value, ['schemaVersion', 'tools', 'apps'], 'Production manifest');
  if (value.schemaVersion !== 1) throw new Error('Unsupported production manifest schema.');
  exactKeys(value.tools, Object.keys(TOOL_FILES), 'Production tools');
  exactKeys(value.apps, Object.keys(APPLICATIONS), 'Production applications');
  const tools = Object.fromEntries(Object.entries(TOOL_FILES).map(([role, file]) => [role, namedDescriptor(value.tools[role], file)]));
  const apps = Object.fromEntries(Object.entries(APPLICATIONS).map(([name, [oldVersion, newVersion, executableName]]) => {
    const item = value.apps[name];
    exactKeys(item, ['oldVersion', 'newVersion', 'executableName', ...FILE_FIELDS], name);
    if (item.oldVersion !== oldVersion || item.newVersion !== newVersion || item.executableName !== executableName) {
      throw new Error('Only the fixed reviewed production beta versions and executable names are allowed.');
    }
    const files = {
      oldInstaller: `${name}_${oldVersion}_windows-x86_64-setup.exe`,
      package: `${name}_${newVersion}_windows-x86_64-setup.exe`,
      signature: `${name}_${newVersion}_windows-x86_64-setup.exe.sig`,
      newExecutable: `${name}_${newVersion}_x64-reference.exe`, publicKey: `${name}-updater.pub`,
    };
    return [name, { oldVersion, newVersion, executableName,
      ...Object.fromEntries(FILE_FIELDS.map(role => [role, namedDescriptor(item[role], files[role])])),
    }];
  }));
  return { schemaVersion: 1, tools, apps };
}
export async function prepareProductionFixtures(application, tag, pin, directory, fetcher = fetch) {
  if (!Object.hasOwn(APPLICATIONS, application)) throw new Error('Unknown production application.');
  const manifest = validateProductionManifest(await loadReleaseManifest(tag, pin, 'windows-production.json', fetcher));
  const fixture = manifest.apps[application];
  const entries = [...Object.entries(manifest.tools), ...FILE_FIELDS.map(role => [role, fixture[role]])];
  let paths = {};
  for (const [role, file] of entries) {
    const normalRelease = NORMAL_RELEASE_FILES.has(role);
    paths = { ...paths, [role]: await downloadAsset(normalRelease ? 'beta' : tag, file,
      directory, fetcher, normalRelease ? application : undefined) };
  }
  return { application, fixture, paths };
}
export async function runProductionWorker(ready, directory, {
  runner = spawnSync, environment = process.env, platform = process.platform, architecture = process.arch,
} = {}) {
  requirePublicWindowsRunner(platform, architecture, environment);
  const installDirectory = join(directory, 'worker-app');
  const command = installerCommand(ready.paths.package, installDirectory, environment);
  const installation = runner('pwsh.exe', command.args, {
    env: command.environment, windowsHide: true, timeout: 190_000, maxBuffer: OUTPUT_LIMIT,
  });
  if (installation.error || installation.status !== 0) throw new Error('Production Consona worker installation failed or exceeded its time/output limit.');
  const executable = join(installDirectory, ready.fixture.executableName);
  await verifyInstalledExecutable(executable, ready.fixture.newExecutable);
  const root = await realpath(installDirectory);
  const resources = join(installDirectory, '_up_', 'assets');
  for (const path of [executable, resources, join(resources, 'models'), join(resources, 'runtime', 'windows-x86_64')]) {
    const local = relative(root, await realpath(path));
    if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) throw new Error('Consona packaged assets escape the disposable production installation.');
  }
  return parseSpeechResult(runner(executable, ['--recognition-worker'], {
    cwd: installDirectory, input: silenceRequest(), windowsHide: true, timeout: 120_000, maxBuffer: OUTPUT_LIMIT,
  }));
}
export async function runProductionValidation({
  platform = process.platform, architecture = process.arch, environment = process.env,
  fetcher = fetch, runner = spawnSync,
} = {}) {
  requirePublicWindowsRunner(platform, architecture, environment);
  const directory = await mkdtemp(join(tmpdir(), 'thorn-public-windows-production-'));
  try {
    const ready = await prepareProductionFixtures(environment.FIXTURE_APP, environment.TOOLS_TAG, environment.MANIFEST_SHA256, directory, fetcher);
    const regression = runner('pwsh.exe', controllerRegressionArguments(ready), { stdio: 'inherit', windowsHide: true, timeout: 30000 });
    if (regression.error || regression.status !== 0) throw new Error('Windows monitor file-sharing and registry regression failed; inspect controller output.');
    const result = runner('pwsh.exe', controllerArguments(ready), { stdio: 'inherit', windowsHide: true, timeout: 600_000 });
    if (result.error || result.status !== 0) throw new Error('Genuine production Windows NSIS validation failed; inspect controller output.');
    const worker = ready.application === 'Consona'
      ? `Actual packaged Consona worker processed generated silence successfully: ${await runProductionWorker(ready, directory, { runner, environment, platform, architecture })} segments.\n`
      : '';
    const message = `${ready.application}: genuine signed production NSIS upgrade ${ready.fixture.oldVersion} to ${ready.fixture.newVersion} passed, including four negative trust cases.\nManifest SHA-256: ${environment.MANIFEST_SHA256.toLowerCase()}\nReference executable SHA-256: ${ready.fixture.newExecutable.sha256}\n${worker}This checks installer replacement, not GUI startup or project restoration.\n`;
    console.log(message);
    if (environment.GITHUB_STEP_SUMMARY) await appendFile(environment.GITHUB_STEP_SUMMARY, message);
    return message;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await runProductionValidation(); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Windows production validation failed.'); process.exitCode = 1; }
}
