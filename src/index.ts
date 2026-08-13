import { toBase64 } from '@mysten/bcs';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { satisfies, valid } from 'semver';
import { loadConfig } from './config.js';
import {
  createProofOfPossession,
  encryptedKeyJson,
  encryptUserSecretKey,
  extractUserSecretKey,
  fullKeyId,
  signedPersonalMessage,
  signedRequest,
  verifySessionSignature,
} from './crypto.js';
import { asSealError, SealError } from './errors.js';
import { isSuiId } from './ids.js';
import { loadStaticKeyStore, masterKeyForPackage } from './keys.js';
import { checkPolicy, parseFetchKeyRequest, validateCertificateTime, validatePtb } from './request.js';
import {
  createSuiClient,
  fetchOriginalPackageId,
  getReferenceGasPrice,
  hasAddressAliases,
  loadCommitteeContext,
  resolveMvrPackage,
  verifyUserSignature,
} from './sui.js';
import type { ClientSdkType, Env, FetchKeyResponse, RuntimeConfig } from './types.js';
import { KEY_SERVER_VERSION } from './version.js';

const MAX_REQUEST_SIZE = 180 * 1024;

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function apiKeyAuthorized(request: Request, env: Env): boolean {
  const name = typeof env.API_KEY_NAME === 'string' && env.API_KEY_NAME.length > 0 ? env.API_KEY_NAME : undefined;
  const value = typeof env.API_KEY === 'string' && env.API_KEY.length > 0 ? env.API_KEY : undefined;
  if (name === undefined && value === undefined) return true;
  if (name === undefined || value === undefined) throw SealError.failure('API_KEY_NAME and API_KEY must be configured together');
  return constantTimeEqual(request.headers.get(name) ?? '', value);
}

function responseHeaders(env: Env): Headers {
  const headers = new Headers({
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': '*',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': '*',
    'X-KeyServer-Version': KEY_SERVER_VERSION,
    'X-KeyServer-GitVersion': env.CF_VERSION_METADATA?.id ?? 'development',
  });
  return headers;
}

function jsonResponse(env: Env, value: unknown, status = 200): Response {
  const headers = responseHeaders(env);
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(value), { status, headers });
}

function errorResponse(env: Env, error: unknown): Response {
  const sealError = asSealError(error);
  if (sealError.cause) console.error(sealError.code, sealError.cause);
  return jsonResponse(env, sealError.toResponseBody(), sealError.status);
}

function sdkType(request: Request): ClientSdkType {
  const value = request.headers.get('Client-Sdk-Type');
  if (value === 'aggregator' || value === 'typescript' || value === 'rust' || value === 'python') return value;
  return 'other';
}

function validateClientHeaders(request: Request, config: RuntimeConfig): void {
  const versionValue = request.headers.get('Client-Sdk-Version');
  if (versionValue === null) {
    throw new SealError('MissingRequiredHeader', 'Missing required header: Client-Sdk-Version');
  }
  if (valid(versionValue) === null) throw new SealError('InvalidSDKVersion', 'Invalid SDK version');
  const requirement = config.sdkVersionRequirements[sdkType(request)];
  if (requirement !== null && !satisfies(versionValue, requirement)) {
    throw new SealError('DeprecatedSDKVersion', 'Deprecated SDK version');
  }
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength !== null && Number(contentLength) > MAX_REQUEST_SIZE) {
    throw SealError.invalidPtb('Request body is too large');
  }
  const reader = request.body?.getReader();
  if (!reader) throw SealError.invalidPtb('Invalid JSON');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_REQUEST_SIZE) {
      await reader.cancel();
      throw SealError.invalidPtb('Request body is too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw SealError.invalidPtb('Invalid JSON');
  }
}

async function handleFetchKey(request: Request, env: Env, config: RuntimeConfig): Promise<Response> {
  const payload = parseFetchKeyRequest(await readJsonBody(request));
  const validPtb = validatePtb(payload.ptbBytes);
  const client = createSuiClient(config.network, config.nodeUrl, env, config.rpcTimeoutMs);
  const staticKeys = loadStaticKeyStore(config, env);
  const firstPackageId = await fetchOriginalPackageId(client, config, validPtb.packageId);
  const committee = config.serverMode.mode === 'committee'
    ? await loadCommitteeContext(client, config, env, config.serverMode)
    : undefined;
  const masterKey = masterKeyForPackage(config, staticKeys, firstPackageId, committee?.masterKey);

  const mvrName = payload.certificate.mvr_name ?? undefined;
  if (mvrName !== undefined) {
    const mvrPackageId = await resolveMvrPackage(config, env, client, mvrName);
    if (mvrPackageId !== firstPackageId) throw new SealError('InvalidMVRName', 'Invalid MVR name');
  }

  validateCertificateTime(payload.certificate, config);
  if (await hasAddressAliases(client, config, payload.certificate.user)) {
    throw new SealError('InvalidSignature', 'Invalid user signature');
  }
  const personalMessage = signedPersonalMessage(
    mvrName ?? firstPackageId,
    payload.sessionPublicKeyBytes,
    payload.certificate.creation_time,
    payload.certificate.ttl_min,
  );
  await verifyUserSignature(
    client,
    config,
    personalMessage,
    payload.certificate.signature,
    payload.certificate.user,
  );
  const requestMessage = signedRequest(
    payload.ptbBytes,
    payload.encKeyBytes,
    payload.encVerificationKeyBytes,
  );
  if (!verifySessionSignature(payload.requestSignatureBytes, payload.sessionPublicKeyBytes, requestMessage)) {
    throw new SealError('InvalidSessionSignature', 'Invalid session key signature');
  }

  const gasPrice = await getReferenceGasPrice(client, config);
  await checkPolicy(client, config, validPtb, payload.certificate.user, gasPrice);

  const response: FetchKeyResponse = {
    decryption_keys: validPtb.innerIds.map((innerId) => {
      const id = fullKeyId(firstPackageId, innerId);
      const key = extractUserSecretKey(masterKey, id);
      return {
        id: Array.from(id),
        encrypted_key: encryptedKeyJson(encryptUserSecretKey(key, payload.encKeyBytes)),
      };
    }),
  };
  return jsonResponse(env, response);
}

async function handleService(request: Request, env: Env, config: RuntimeConfig): Promise<Response> {
  const serviceId = new URL(request.url).searchParams.get('service_id');
  if (!isSuiId(serviceId)) {
    throw new SealError('InvalidServiceId', 'Invalid service ID');
  }
  const normalized = normalizeSuiAddress(serviceId);
  const key = loadStaticKeyStore(config, env).serviceKeys.get(normalized);
  if (key === undefined) throw new SealError('InvalidServiceId', 'Invalid service ID');
  return jsonResponse(env, {
    service_id: normalized,
    pop: toBase64(createProofOfPossession(key, normalized)),
  });
}

async function handleCommitteePartialKey(env: Env, config: RuntimeConfig): Promise<Response> {
  if (config.serverMode.mode !== 'committee') {
    return new Response('Unsupported', { status: 400, headers: responseHeaders(env) });
  }
  const client = createSuiClient(config.network, config.nodeUrl, env, config.rpcTimeoutMs);
  const committee = await loadCommitteeContext(client, config, env, config.serverMode);
  return jsonResponse(env, { partial_pk: toBase64(committee.partialPublicKey) });
}

async function route(request: Request, env: Env): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: responseHeaders(env) });
  const url = new URL(request.url);
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health' || url.pathname === '/-/healthy')) {
    return jsonResponse(env, { status: 'ok', service: 'seal-cloudflare', version: KEY_SERVER_VERSION });
  }
  if (!apiKeyAuthorized(request, env)) {
    return jsonResponse(env, { error: 'Unauthorized', message: 'Unauthorized' }, 401);
  }
  const config = loadConfig(env);
  validateClientHeaders(request, config);
  if (request.method === 'POST' && url.pathname === '/v1/fetch_key') return handleFetchKey(request, env, config);
  if (request.method === 'GET' && url.pathname === '/v1/service') return handleService(request, env, config);
  if (request.method === 'GET' && url.pathname === '/v1/debug/committee_partial_pk') {
    return handleCommitteePartialKey(env, config);
  }
  return jsonResponse(env, { error: 'NotFound', message: 'Not found' }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      return errorResponse(env, error);
    }
  },
} satisfies ExportedHandler<Env>;
