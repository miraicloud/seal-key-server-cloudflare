import { fromBase64, fromHex } from '@mysten/bcs';
import { bls12_381 } from '@noble/curves/bls12-381.js';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import { publicKeyFromMasterKey } from '../src/crypto.js';
import type { Env } from '../src/types.js';
import { KEY_SERVER_VERSION } from '../src/version.js';

const SERVICE_ID = `0x${'2'.padStart(64, '0')}`;
const env: Env = {
  NETWORK: 'testnet',
  KEY_SERVER_CONFIG: JSON.stringify({ mode: 'open', keyServerObjectId: SERVICE_ID }),
  MASTER_KEY: '0x' + '00'.repeat(31) + '11',
  CF_VERSION_METADATA: { id: 'test-deployment' },
};

function request(path: string, headers?: HeadersInit): Request {
  return new Request(`https://seal.example${path}`, { headers });
}

describe('Worker API compatibility', () => {
  it('serves health without loading key configuration', async () => {
    const response = await worker.fetch(request('/health'), {} as Env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', service: 'seal-cloudflare', version: KEY_SERVER_VERSION });
  });

  it('enforces the upstream SDK version header contract', async () => {
    const missing = await worker.fetch(request(`/v1/service?service_id=${SERVICE_ID}`), env);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: 'MissingRequiredHeader',
      message: 'Missing required header: Client-Sdk-Version',
    });

    const deprecated = await worker.fetch(
      request(`/v1/service?service_id=${SERVICE_ID}`, {
        'Client-Sdk-Type': 'typescript',
        'Client-Sdk-Version': '0.3.0',
      }),
      env,
    );
    expect(deprecated.status).toBe(426);
    expect((await deprecated.json()) as object).toMatchObject({ error: 'DeprecatedSDKVersion' });
  });

  it('returns an SDK-verifiable proof of possession and version headers', async () => {
    const response = await worker.fetch(
      request(`/v1/service?service_id=${SERVICE_ID}`, {
        'Client-Sdk-Type': 'typescript',
        'Client-Sdk-Version': '1.4.0',
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('X-KeyServer-Version')).toBe(KEY_SERVER_VERSION);
    expect(response.headers.get('X-KeyServer-GitVersion')).toBe('test-deployment');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const body = (await response.json()) as { service_id: string; pop: string };
    expect(body.service_id).toBe(SERVICE_ID);

    const publicKey = publicKeyFromMasterKey(17n);
    const message = new Uint8Array([
      ...new TextEncoder().encode('SUI-SEAL-IBE-BLS12381-POP-00'),
      ...publicKey,
      ...fromHex(SERVICE_ID),
    ]);
    expect(
      bls12_381.shortSignatures.verify(
        fromBase64(body.pop),
        bls12_381.shortSignatures.hash(message),
        publicKey,
      ),
    ).toBe(true);
  });

  it('handles CORS preflight without requiring SDK headers', async () => {
    const response = await worker.fetch(new Request('https://seal.example/v1/fetch_key', { method: 'OPTIONS' }), env);
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('*');
  });

  it('rejects oversized streaming bodies before parsing them', async () => {
    const response = await worker.fetch(
      new Request('https://seal.example/v1/fetch_key', {
        method: 'POST',
        headers: { 'Client-Sdk-Version': '1.4.0' },
        body: 'x'.repeat(180 * 1024 + 1),
      }),
      env,
    );
    expect(response.status).toBe(403);
    expect((await response.json()) as object).toMatchObject({ error: 'InvalidPTB' });
  });

  it('supports optional constant-time API-key gating for protocol routes', async () => {
    const protectedEnv = { ...env, API_KEY_NAME: 'X-Seal-Key', API_KEY: 'correct-horse' };
    const unauthorized = await worker.fetch(
      request(`/v1/service?service_id=${SERVICE_ID}`, { 'Client-Sdk-Version': '1.4.0' }),
      protectedEnv,
    );
    expect(unauthorized.status).toBe(401);
    const authorized = await worker.fetch(
      request(`/v1/service?service_id=${SERVICE_ID}`, {
        'Client-Sdk-Version': '1.4.0',
        'X-Seal-Key': 'correct-horse',
      }),
      protectedEnv,
    );
    expect(authorized.status).toBe(200);
  });
});
