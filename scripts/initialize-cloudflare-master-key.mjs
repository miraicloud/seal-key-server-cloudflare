import { bls12_381 } from '@noble/curves/bls12-381.js';
import { bytesToNumberBE, bytesToHex } from '@noble/curves/utils.js';
import { spawnSync } from 'node:child_process';

const wrangler = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function runWrangler(args, input) {
  const result = spawnSync(wrangler, ['wrangler', ...args], {
    encoding: 'utf8',
    env: process.env,
    input,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`wrangler ${args.join(' ')} exited with status ${result.status}`);
}

const listed = spawnSync(wrangler, ['wrangler', 'secret', 'list', '--format=json'], {
  encoding: 'utf8',
  env: process.env,
  maxBuffer: 10 * 1024 * 1024,
});
if (listed.stderr) process.stderr.write(listed.stderr);
if (listed.error) throw listed.error;
if (listed.status !== 0) {
  throw new Error(`wrangler secret list exited with status ${listed.status}`);
}

const secrets = JSON.parse(listed.stdout);
if (secrets.some(({ name }) => name === 'MASTER_KEY')) {
  throw new Error('MASTER_KEY is already configured; refusing to replace the registered Seal identity');
}

const masterKey = bls12_381.utils.randomSecretKey();
try {
  const scalar = bytesToNumberBE(masterKey);
  const publicKey = bls12_381.G2.Point.BASE.multiply(scalar).toBytes();
  runWrangler(['secret', 'put', 'MASTER_KEY'], `0x${bytesToHex(masterKey)}\n`);
  process.stdout.write(`public_key=0x${bytesToHex(publicKey)}\n`);
} finally {
  masterKey.fill(0);
}
