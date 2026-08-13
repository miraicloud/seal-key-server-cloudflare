import { fromBase64, fromHex, toHex } from '@mysten/bcs';
import { SealClient, SessionKey } from '@mysten/seal';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const WORKER_URL = 'https://seal-key-server.miraicloud.workers.dev';
const KEY_SERVER_OBJECT_ID = '0x501b8b579470ef879b6c9e581e7b7d9c1ffe7fc749e7e2366bfaa7b655b7b3c3';
const POLICY_PACKAGE_ID = '0xc5ce2742cac46421b62028557f1d7aea8a4c50f651379a79afdf12cd88628807';
const POLICY_OBJECT_ID = '0xe7411c57566894283716ccbed77d36027bb98ec2c696292089c93f983b745ad9';
const TESTNET_GRPC_URL = 'https://fullnode.testnet.sui.io:443';

async function loadSigner(): Promise<Ed25519Keypair> {
  if (process.env.SUI_PRIVATE_KEY) return Ed25519Keypair.fromSecretKey(process.env.SUI_PRIVATE_KEY);

  const expectedAddress = process.env.SUI_ADDRESS;
  if (!expectedAddress) {
    throw new Error('Set SUI_PRIVATE_KEY, or set SUI_ADDRESS to select an Ed25519 key from the Sui CLI keystore');
  }

  const keystorePath = process.env.SUI_KEYSTORE ?? join(homedir(), '.sui', 'sui_config', 'sui.keystore');
  const encodedKeys = JSON.parse(await readFile(keystorePath, 'utf8')) as string[];
  for (const encodedKey of encodedKeys) {
    const key = fromBase64(encodedKey);
    if (key[0] !== 0) continue;
    const signer = Ed25519Keypair.fromSecretKey(key.slice(1));
    if (signer.toSuiAddress() === expectedAddress) return signer;
  }
  throw new Error(`No Ed25519 key for ${expectedAddress} in ${keystorePath}`);
}

const signer = await loadSigner();
const address = signer.toSuiAddress();
const suiClient = new SuiGrpcClient({ network: 'testnet', baseUrl: TESTNET_GRPC_URL });
const workerCalls: string[] = [];
const trackedFetch: typeof fetch = async (input, init) => {
  const rawUrl = typeof input === 'string' || input instanceof URL ? input.toString() : input.url;
  const url = new URL(rawUrl);
  if (url.origin === WORKER_URL) workerCalls.push(url.pathname);
  return fetch(input, init);
};
const sealClient = new SealClient({
  suiClient,
  serverConfigs: [{ objectId: KEY_SERVER_OBJECT_ID, weight: 1 }],
  verifyKeyServers: true,
  fetch: trackedFetch,
});

const plaintext = new TextEncoder().encode('Seal TypeScript SDK → Cloudflare Worker → decrypted');
const id = toHex(new Uint8Array([...fromHex(POLICY_OBJECT_ID), ...randomBytes(5)]));
const { encryptedObject } = await sealClient.encrypt({
  threshold: 1,
  packageId: POLICY_PACKAGE_ID,
  id,
  data: plaintext,
});

const sessionKey = await SessionKey.create({
  address,
  packageId: POLICY_PACKAGE_ID,
  ttlMin: 10,
  signer,
  suiClient,
});
const approval = new Transaction();
approval.moveCall({
  target: `${POLICY_PACKAGE_ID}::allowlist::seal_approve`,
  arguments: [approval.pure.vector('u8', fromHex(id)), approval.object(POLICY_OBJECT_ID)],
});
const txBytes = await approval.build({ client: suiClient, onlyTransactionKind: true });
const decrypted = await sealClient.decrypt({ data: encryptedObject, sessionKey, txBytes });

if (toHex(decrypted) !== toHex(plaintext)) throw new Error('Decrypted bytes do not match the plaintext');
if (!workerCalls.includes('/v1/fetch_key')) throw new Error('The SDK did not call the Worker fetch_key endpoint');

console.log(JSON.stringify({
  status: 'passed',
  address,
  workerUrl: WORKER_URL,
  workerCalls,
  keyServerObjectId: KEY_SERVER_OBJECT_ID,
  policyPackageId: POLICY_PACKAGE_ID,
  policyObjectId: POLICY_OBJECT_ID,
  id,
  encryptedBytes: encryptedObject.length,
  plaintext: new TextDecoder().decode(decrypted),
}, null, 2));
