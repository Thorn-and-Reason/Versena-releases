import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { silenceRequest, approveFixtureInputs, installerCommand, parseSpeechResult, verifyInstalledExecutable, runPackagedWorker } from './consona-packaged-worker.mjs';
const tag = 'windows-updater-test-20261025-97d566a4';
const pin = 'e7609ff093ed8a64a3a060bb9e2725d211f2260d74537f5ab40e3fbf7e6d14e0';
const result = (value) => ({ status: 0, stdout: Buffer.from(JSON.stringify(value)), stderr: Buffer.alloc(0) });

test('encodes exactly one second of generated silence using the real worker protocol', () => {
  const bytes = silenceRequest();
  assert.equal(bytes.subarray(0, 8).toString(), 'CONSW001');
  const length = bytes.readUInt32LE(8);
  assert.deepEqual(JSON.parse(bytes.subarray(12, 12 + length).toString()), { version: 1, sample_rate: 16000, sample_count: 16000 });
  const samples = bytes.subarray(12 + length);
  assert.equal(samples.length, 64000);
  assert.ok(samples.every(byte => byte === 0));
});
test('limits the check to the already approved public fixture tag and manifest', () => {
  assert.doesNotThrow(() => approveFixtureInputs(tag, pin));
  assert.doesNotThrow(() => approveFixtureInputs(tag, pin.toUpperCase()));
  assert.throws(() => approveFixtureInputs('beta', pin));
  assert.throws(() => approveFixtureInputs(tag, 'a'.repeat(64)));
  assert.throws(() => approveFixtureInputs(tag, undefined));
});
test('uses per-user silent NSIS installation with unquoted /D last and no interpolated paths', () => {
  const env = { GITHUB_ACTIONS: 'true' };
  const command = installerCommand('C:\\Temp\\new installer.exe', 'C:\\Temp\\test app', env);
  assert.deepEqual(env, { GITHUB_ACTIONS: 'true' });
  assert.deepEqual(command.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.ok(command.args[3].includes('"/S /D=$env:CONSONA_FIXTURE_INSTALL_DIR"'));
  assert.ok(!command.args[3].includes('C:\\Temp'));
  assert.equal(command.environment.CONSONA_FIXTURE_INSTALL_DIR, 'C:\\Temp\\test app');
  for (const unsafe of ['C:\\bad"path', 'C:\\bad\npath', 'C:\\bad\0path']) assert.throws(() => installerCommand(unsafe, 'C:\\safe', env));
});
test('accepts only a successful native Result with a transcript array', () => {
  assert.equal(parseSpeechResult(result({ Ok: [] })), 0);
  assert.equal(parseSpeechResult(result({ Ok: [{ text: 'generated output' }] })), 1);
  for (const value of [null, [], {}, { Ok: 'bad' }, { Ok: [], other: true }, { Err: 'models unavailable' }]) assert.throws(() => parseSpeechResult(result(value)));
});
test('rejects timeout, exit failure, invalid UTF-8/JSON, and excessive output', () => {
  for (const value of [
    { ...result({ Ok: [] }), error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) },
    { ...result({ Ok: [] }), status: 1 },
    { ...result({ Ok: [] }), stdout: Buffer.from('not JSON') },
    { ...result({ Ok: [] }), stdout: Buffer.from([0xff]) },
    { ...result({ Ok: [] }), stdout: Buffer.alloc(65537) },
    { ...result({ Ok: [] }), stderr: Buffer.alloc(65537) },
  ]) assert.throws(() => parseSpeechResult(value));
});
test('checks the installed executable against the pinned reference hash and length', async t => {
  const root = await mkdtemp(join(tmpdir(), 'consona-installed-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'app.exe'); const bytes = Buffer.from('fixture bytes');
  await writeFile(path, bytes);
  const expected = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  await verifyInstalledExecutable(path, expected);
  await assert.rejects(verifyInstalledExecutable(path, { ...expected, bytes: 1 }));
  await assert.rejects(verifyInstalledExecutable(path, { ...expected, sha256: 'a'.repeat(64) }));
});

test('actual packaged Windows Consona worker processes generated silence', {
  skip: process.platform !== 'win32' || process.env.VALIDATION_PUBLIC_REPOSITORY !== 'true',
  timeout: 470_000,
}, async () => {
  await runPackagedWorker();
});
