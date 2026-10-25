import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { appendFile, link, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const REPOSITORY = 'Thorn-and-Reason/Versena-releases';
const APPLICATIONS = ['Versena', 'Tessera', 'Lirensa', 'Consona'];
const FILES = ['oldInstaller', 'newExecutable', 'package', 'publicKey', 'signature', 'unversionedSignature'];
const EXTENSIONS = { oldInstaller: '.exe', newExecutable: '.exe', package: '.exe', publicKey: '.pub', signature: '.sig', unversionedSignature: '.sig' };
const MAX_ASSET_BYTES = 2 ** 31;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const REDIRECT_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`${label} has missing or unexpected fields.`);
  }
}
function sha256(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new Error('A complete SHA-256 digest is required.');
  return value.toLowerCase();
}
function plainName(value, executable = false) {
  const pattern = executable ? /^[A-Za-z0-9][A-Za-z0-9._ -]*\.exe$/i : /^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/;
  if (typeof value !== 'string' || value.length > 180 || !pattern.test(value)
      || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(value.split('.')[0].trim())) {
    throw new Error('Fixture filenames must be plain, non-reserved Windows basenames.');
  }
  return value;
}
function descriptor(value, extension) {
  exactKeys(value, ['file', 'bytes', 'sha256'], 'File descriptor');
  const file = plainName(value.file);
  if (extension && !file.toLowerCase().endsWith(extension)) throw new Error('Fixture file extension does not match its role.');
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_ASSET_BYTES) {
    throw new Error('Fixture file size must be between one byte and 2 GiB.');
  }
  return { file, bytes: value.bytes, sha256: sha256(value.sha256) };
}
export function validateManifest(value) {
  exactKeys(value, ['schemaVersion', 'tools', 'apps'], 'Manifest');
  if (value.schemaVersion !== 1) throw new Error('Unsupported fixture manifest schema.');
  exactKeys(value.tools, ['harness', 'controller'], 'Tools');
  exactKeys(value.apps, APPLICATIONS, 'Applications');
  const tools = { harness: descriptor(value.tools.harness, '.exe'), controller: descriptor(value.tools.controller, '.ps1') };
  const apps = Object.fromEntries(APPLICATIONS.map(name => {
    const item = value.apps[name];
    exactKeys(item, ['oldVersion', 'newVersion', 'executableName', ...FILES], name);
    if (item.oldVersion !== '0.0.1' || item.newVersion !== '0.0.2') throw new Error('Only the fixed 0.0.1 to 0.0.2 test fixture versions are allowed.');
    return [name, {
      oldVersion: item.oldVersion, newVersion: item.newVersion,
      executableName: plainName(item.executableName, true),
      ...Object.fromEntries(FILES.map(field => [field, descriptor(item[field], EXTENSIONS[field])])),
    }];
  }));
  const names = [tools.harness, tools.controller, ...APPLICATIONS.flatMap(name => FILES.map(field => apps[name][field]))]
    .map(item => item.file.toLowerCase());
  if (new Set(names).size !== names.length) throw new Error('Fixture asset filenames must be unique, including on Windows.');
  return { schemaVersion: 1, tools, apps };
}
function releaseUrl(tag, filename) {
  if (typeof tag !== 'string' || !/^windows-updater-test-[0-9]{8}-[a-f0-9]{8}$/.test(tag)) {
    throw new Error('Fixture tag must use windows-updater-test-YYYYMMDD-8lowerhex.');
  }
  return new URL(`https://github.com/${REPOSITORY}/releases/download/${tag}/${plainName(filename)}`);
}
function checkedRedirect(value, base) {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || !REDIRECT_HOSTS.has(url.hostname) || url.username || url.password || url.hash || url.port) {
    throw new Error('Unsafe public release redirect.');
  }
  return url;
}
async function responseFor(tag, filename, fetcher) {
  let url = releaseUrl(tag, filename);
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetcher(url, {
      redirect: 'manual', signal,
      headers: { accept: 'application/octet-stream', 'user-agent': 'Thorn-and-Reason-public-updater-validation' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirects >= 5) throw new Error('Public release redirect limit or location is invalid.');
      url = checkedRedirect(location, url);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Public fixture download failed (HTTP ${response.status}).`);
    }
    if (response.url) checkedRedirect(response.url, url);
    return response;
  }
}
async function checkLength(response, limit) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^[0-9]+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > limit)) {
    await response.body?.cancel();
    throw new Error('Public fixture download size exceeds its approved bound.');
  }
}
export async function loadManifest(tag, expectedSha256, fetcher = fetch) {
  const expected = sha256(expectedSha256);
  const response = await responseFor(tag, 'windows-fixtures.json', fetcher);
  await checkLength(response, MAX_MANIFEST_BYTES);
  let bytes = 0; let chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_MANIFEST_BYTES) throw new Error('Public manifest download size exceeds 1 MiB.');
    chunks = [...chunks, Buffer.from(chunk)];
  }
  const content = Buffer.concat(chunks, bytes);
  if (createHash('sha256').update(content).digest('hex') !== expected) throw new Error('Manifest SHA-256 does not match the approved value.');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)); }
  catch { throw new Error('Public manifest is not valid UTF-8 JSON.'); }
  return validateManifest(value);
}
export async function downloadAsset(tag, expectedFile, directory, fetcher = fetch) {
  const expected = descriptor(expectedFile);
  const destination = join(directory, expected.file);
  const temporary = join(directory, `.download-${randomUUID()}`);
  try {
    const response = await responseFor(tag, expected.file, fetcher);
    await checkLength(response, expected.bytes);
    let received = 0;
    const hash = createHash('sha256');
    const verifier = new Transform({ transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > expected.bytes) { callback(new Error('Fixture download size exceeded the approved value.')); return; }
      hash.update(chunk); callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), verifier, createWriteStream(temporary, { flags: 'wx' }));
    if (received !== expected.bytes) throw new Error('Fixture download size did not match the approved value.');
    if (hash.digest('hex') !== expected.sha256) throw new Error('Fixture SHA-256 did not match the approved value.');
    // Promote verified bytes without replacing an existing file.
    await link(temporary, destination);
    console.log(`Verified ${expected.file}: ${expected.sha256} (${received} bytes)`);
    return destination;
  } finally { await rm(temporary, { force: true }); }
}
export async function prepareFixtures(application, tag, manifestSha256, directory, fetcher = fetch) {
  if (!APPLICATIONS.includes(application)) throw new Error('Unknown fixture application.');
  const manifest = await loadManifest(tag, manifestSha256, fetcher);
  const fixture = manifest.apps[application];
  const entries = [['harness', manifest.tools.harness], ['controller', manifest.tools.controller], ...FILES.map(field => [field, fixture[field]])];
  let paths = {};
  for (const [field, file] of entries) paths = { ...paths, [field]: await downloadAsset(tag, file, directory, fetcher) };
  return { application, fixture, paths };
}
export function controllerArguments({ fixture, paths }) {
  return ['-NoProfile', '-NonInteractive', '-File', paths.controller,
    '-Harness', paths.harness, '-OldInstaller', paths.oldInstaller,
    '-NewExecutable', paths.newExecutable, '-Package', paths.package,
    '-PublicKey', paths.publicKey, '-Signature', paths.signature,
    '-UnversionedSignature', paths.unversionedSignature,
    '-OldVersion', fixture.oldVersion, '-NewVersion', fixture.newVersion,
    '-ExecutableName', fixture.executableName, '-TimeoutSeconds', '600'];
}
export function controllerRegressionArguments({ paths }) {
  return ['-NoProfile', '-NonInteractive', '-File', paths.controller, '-MonitorSelfTest'];
}
export function requirePublicWindowsRunner(platform, architecture, environment) {
  if (platform !== 'win32' || architecture !== 'x64' || environment.GITHUB_ACTIONS !== 'true'
      || environment.RUNNER_ENVIRONMENT !== 'github-hosted' || environment.RUNNER_OS !== 'Windows'
      || environment.PROCESSOR_ARCHITECTURE !== 'AMD64' || environment.GITHUB_REPOSITORY !== REPOSITORY
      || environment.VALIDATION_PUBLIC_REPOSITORY !== 'true') {
    throw new Error('Use only the fixed public repository on an ephemeral GitHub-hosted x64 Windows runner.');
  }
}
async function run() {
  requirePublicWindowsRunner(process.platform, process.arch, process.env);
  const directory = await mkdtemp(join(tmpdir(), 'thorn-public-windows-fixtures-'));
  try {
    const ready = await prepareFixtures(process.env.FIXTURE_APP, process.env.FIXTURES_TAG, process.env.MANIFEST_SHA256, directory);
    const regression = spawnSync('pwsh.exe', controllerRegressionArguments(ready), { stdio: 'inherit', windowsHide: true, timeout: 30000 });
    if (regression.error || regression.status !== 0) throw new Error('Windows monitor file-sharing and registry regression failed; inspect controller output.');
    const result = spawnSync('pwsh.exe', controllerArguments(ready), { stdio: 'inherit', windowsHide: true, timeout: 1_100_000 });
    if (result.error || result.status !== 0) throw new Error('Genuine Windows NSIS validation failed; inspect the controller output.');
    const message = `${ready.application}: genuine signed NSIS fixture upgrade ${ready.fixture.oldVersion} to ${ready.fixture.newVersion} passed.\nManifest SHA-256: ${sha256(process.env.MANIFEST_SHA256)}\nReference executable SHA-256: ${ready.fixture.newExecutable.sha256}\nThis checks installer replacement, not GUI startup or project restoration.\n`;
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, message);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await run(); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Windows fixture validation failed.'); process.exitCode = 1; }
}
