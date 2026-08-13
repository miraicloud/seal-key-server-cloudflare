import { bcs } from '@mysten/bcs';
import { bcs as suiBcs } from '@mysten/sui/bcs';
import { GrpcWebFetchTransport, SuiGrpcClient } from '@mysten/sui/grpc';
import { deriveDynamicFieldID, normalizeSuiAddress } from '@mysten/sui/utils';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import { AppRecord, CommitteeFieldWrapper, KeyServerV2, MvrName, PackageInfo, SealCommittee } from './bcs.js';
import { publicKeyFromMasterKey, decodeMasterKey, type MasterKey } from './crypto.js';
import { requiredSecret } from './config.js';
import { SealError } from './errors.js';
import type { CommitteeModeConfig, Env, Network, RuntimeConfig } from './types.js';

const MVR_REGISTRY = '0xe8417c530cde59eddf6dfb760e8a0e3e2c6f17c69ddaab5a73dd6a6e65fc463b';
const MVR_CORE = '0x62c1f5b1cb9e3bfc3dd1f73c95066487b662048a6358eabdbf67f6cdeca6db4b';
const TESTNET_ID = '4c78adac';
const ADDRESS_ALIAS_STATE_OBJECT_ID = '0xa';
const CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface CommitteeContext {
  version: number;
  dynamicFieldVersion: string;
  masterKey: MasterKey;
  partialPublicKey: Uint8Array;
  partyId: number;
  serverName: string;
}

const packageIdCache = new Map<string, CacheEntry<string>>();
const mvrCache = new Map<string, CacheEntry<string>>();
const committeeCache = new Map<string, CommitteeContext>();
const gasPriceCache = new Map<string, CacheEntry<bigint>>();

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function withRpcAuthAndTimeout(env: Env, timeoutMs: number, mainnetFallback: boolean): typeof fetch {
  const nameBinding = mainnetFallback ? 'MAINNET_FULL_NODE_RPC_API_NAME' : 'FULL_NODE_RPC_API_NAME';
  const keyBinding = mainnetFallback ? 'MAINNET_FULL_NODE_RPC_API_KEY' : 'FULL_NODE_RPC_API_KEY';
  const headerName = typeof env[nameBinding] === 'string' ? env[nameBinding] : undefined;
  const headerValue = typeof env[keyBinding] === 'string' ? env[keyBinding] : undefined;
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    if (headerName && headerValue) headers.set(headerName, headerValue);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetch(input, { ...init, headers, signal });
  };
}

export function createSuiClient(
  network: Network,
  nodeUrl: string,
  env: Env,
  timeoutMs: number,
  mainnetFallback = false,
): SuiGrpcClient {
  const transport = new GrpcWebFetchTransport({
    baseUrl: nodeUrl,
    format: 'binary',
    fetch: withRpcAuthAndTimeout(env, timeoutMs, mainnetFallback),
  });
  return new SuiGrpcClient({ network, transport });
}

function errorCode(error: unknown): string | number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  return (error as { code?: string | number }).code;
}

function isRetriableRpcError(error: unknown): boolean {
  const code = errorCode(error);
  if (typeof code === 'number') return [1, 4, 8, 10, 14].includes(code);
  if (typeof code === 'string') {
    return ['CANCELLED', 'DEADLINE_EXCEEDED', 'RESOURCE_EXHAUSTED', 'ABORTED', 'UNAVAILABLE'].includes(
      code.toUpperCase(),
    );
  }
  if (error instanceof TypeError) return true;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  return /timeout|timed out|temporar|unavailable|connection|network|fetch failed|rate limit/.test(message);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function withRpcRetries<T>(config: RuntimeConfig, operation: () => Promise<T>): Promise<T> {
  let backoffMs = 100;
  let lastError: unknown;
  for (let attempt = 1; attempt <= config.rpcMaxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === config.rpcMaxAttempts || !isRetriableRpcError(error)) throw error;
      await delay(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 10_000);
    }
  }
  throw lastError;
}

export async function fetchOriginalPackageId(
  client: SuiGrpcClient,
  config: RuntimeConfig,
  packageId: string,
): Promise<string> {
  const normalized = normalizeSuiAddress(packageId);
  const cacheKey = `${config.network}:${config.nodeUrl}:${normalized}`;
  const cached = packageIdCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const response = await withRpcRetries(config, async () =>
      client.movePackageService.getPackage({ packageId: normalized }).then((call) => call.response),
    );
    const originalId = response.package?.originalId;
    if (!originalId) throw new SealError('InvalidPackage', 'Invalid package ID');
    const value = normalizeSuiAddress(originalId);
    packageIdCache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch (error) {
    if (error instanceof SealError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/not.?found|invalid.?argument|invalid package/i.test(message)) {
      throw new SealError('InvalidPackage', 'Invalid package ID', { cause: error });
    }
    throw SealError.failure('Failed to resolve package ID', error);
  }
}

export async function getReferenceGasPrice(client: SuiGrpcClient, config: RuntimeConfig): Promise<bigint> {
  const cacheKey = `${config.network}:${config.nodeUrl}`;
  const cached = gasPriceCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const result = await withRpcRetries(config, () => client.getReferenceGasPrice());
    const value = BigInt(result.referenceGasPrice);
    gasPriceCache.set(cacheKey, { value, expiresAt: Date.now() + 60_000 });
    return value;
  } catch (error) {
    throw SealError.failure('Failed to fetch reference gas price', error);
  }
}

export async function hasAddressAliases(
  client: SuiGrpcClient,
  config: RuntimeConfig,
  address: string,
): Promise<boolean> {
  const fieldId = deriveDynamicFieldID(
    ADDRESS_ALIAS_STATE_OBJECT_ID,
    '0x2::address_alias::AliasKey',
    suiBcs.Address.serialize(address).toBytes(),
  );
  try {
    const { objects } = await withRpcRetries(config, () => client.getObjects({ objectIds: [fieldId] }));
    return !(objects[0] instanceof Error);
  } catch (error) {
    throw SealError.failure('Failed to check address aliases', error);
  }
}

export async function verifyUserSignature(
  client: SuiGrpcClient,
  config: RuntimeConfig,
  message: Uint8Array,
  signature: string,
  address: string,
): Promise<void> {
  try {
    await withRpcRetries(config, () =>
      verifyPersonalMessageSignature(message, signature, { client, address }).then(() => undefined),
    );
  } catch (error) {
    if (isRetriableRpcError(error)) throw SealError.failure('Signature verification RPC failed', error);
    throw new SealError('InvalidSignature', 'Invalid user signature', { cause: error });
  }
}

function parseMvrName(name: string): { org: { labels: string[] }; app: string[] } {
  const match = /^([a-z0-9.@-]*)\/([a-z0-9.-]*)(?:\/(\d+))?$/.exec(name);
  if (!match || match[3] !== undefined) throw new SealError('InvalidMVRName', 'Invalid MVR name');
  const [, organization, app] = match;
  const validateLabel = (label: string) => {
    if (label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) {
      throw new SealError('InvalidMVRName', 'Invalid MVR name');
    }
    return label;
  };
  let dotDomain: string;
  if (organization.includes('@')) {
    const pieces = organization.split('@');
    if (pieces.length !== 2 || pieces[1].includes('.') || pieces[1].length === 0) {
      throw new SealError('InvalidMVRName', 'Invalid MVR name');
    }
    dotDomain = [pieces[0], pieces[1], 'sui'].filter(Boolean).join('.');
  } else {
    dotDomain = organization;
  }
  if (organization.length > 200) throw new SealError('InvalidMVRName', 'Invalid MVR name');
  const labels = dotDomain.split('.').map(validateLabel).reverse();
  if (labels.length < 2) throw new SealError('InvalidMVRName', 'Invalid MVR name');
  return { org: { labels }, app: [validateLabel(app)] };
}

function vecMapToMap<K, V>(value: { contents: Array<{ key: K; value: V }> }): Map<K, V> {
  return new Map(value.contents.map((entry) => [entry.key, entry.value]));
}

export async function resolveMvrPackage(
  config: RuntimeConfig,
  env: Env,
  networkClient: SuiGrpcClient,
  mvrName: string,
): Promise<string> {
  const cacheKey = `${config.network}:${config.nodeUrl}:${config.mainnetNodeUrl}:${mvrName}`;
  const cached = mvrCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const mainnetClient = config.network === 'mainnet'
    ? networkClient
    : createSuiClient('mainnet', config.mainnetNodeUrl, env, config.rpcTimeoutMs, true);
  try {
    const parsedName = parseMvrName(mvrName);
    const recordResult = await withRpcRetries(config, () =>
      mainnetClient.getDynamicField({
        parentId: MVR_REGISTRY,
        name: {
          type: `${MVR_CORE}::name::Name`,
          bcs: MvrName.serialize(parsedName).toBytes(),
        },
      }),
    );
    const record = AppRecord.parse(recordResult.dynamicField.value.bcs);
    let packageAddress: string | null | undefined;
    if (config.network === 'mainnet') {
      if (!record.appInfo) throw new SealError('InvalidMVRName', 'Invalid MVR name');
      if (!record.appInfo.packageAddress) {
        throw SealError.failure(`No package address for MVR name ${mvrName} on mainnet`);
      }
      packageAddress = record.appInfo.packageAddress;
    } else if (config.network === 'testnet') {
      const appInfo = vecMapToMap(record.networks).get(TESTNET_ID);
      if (!appInfo) throw new SealError('InvalidMVRName', 'Invalid MVR name');
      const packageInfoId = appInfo.packageInfoId;
      if (!packageInfoId) throw SealError.failure(`No package info ID for MVR name ${mvrName} on testnet`);
      const result = await withRpcRetries(config, () =>
        networkClient.getObject({ objectId: packageInfoId, include: { content: true } }),
      );
      if (!result.object.content) throw new SealError('InvalidPackage', 'Invalid package ID');
      const packageInfo = PackageInfo.parse(result.object.content);
      const metadata = vecMapToMap(packageInfo.metadata);
      const defaultName = metadata.get('default');
      if (defaultName === undefined) throw SealError.failure("No 'default' field on package info object");
      if (defaultName !== mvrName) throw new SealError('InvalidMVRName', 'Invalid MVR name');
      packageAddress = packageInfo.packageAddress;
    } else {
      throw SealError.failure('MVR resolution is only supported on mainnet and testnet');
    }
    if (!packageAddress) throw new SealError('InvalidMVRName', 'Invalid MVR name');
    const value = normalizeSuiAddress(packageAddress);
    mvrCache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch (error) {
    if (error instanceof SealError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/not.?found|failed to resolve|invalid name/i.test(message)) {
      throw new SealError('InvalidMVRName', 'Invalid MVR name', { cause: error });
    }
    throw SealError.failure(`Failed to resolve MVR name ${mvrName}`, error);
  }
}

export async function loadCommitteeContext(
  client: SuiGrpcClient,
  config: RuntimeConfig,
  env: Env,
  mode: CommitteeModeConfig,
): Promise<CommitteeContext> {
  let versioned;
  try {
    versioned = await withRpcRetries(config, () =>
      client.getDynamicField({
        parentId: mode.keyServerObjectId,
        name: { type: 'u64', bcs: bcs.u64().serialize(2).toBytes() },
      }),
    );
  } catch (error) {
    throw SealError.failure('Failed to fetch committee key server version', error);
  }
  const cacheKey = `${config.network}:${config.nodeUrl}:${mode.keyServerObjectId}`;
  const cached = committeeCache.get(cacheKey);
  if (cached?.dynamicFieldVersion === versioned.dynamicField.version) return cached;

  const keyServer = KeyServerV2.parse(versioned.dynamicField.value.bcs);
  if (keyServer.keyType !== 0) throw SealError.failure(`Unsupported committee key type: ${keyServer.keyType}`);
  if (keyServer.serverType.$kind !== 'Committee') throw SealError.failure('Key server is not in committee mode');
  const version = keyServer.serverType.Committee.version;
  const state = mode.state ?? { type: 'active' as const };
  if (state.type === 'rotation' && version !== state.targetVersion && version + 1 !== state.targetVersion) {
    throw SealError.failure(
      `Rotation mode mismatch: version ${version} does not match ${state.targetVersion - 1} or ${state.targetVersion}`,
    );
  }
  if (state.type === 'rotation' && version + 1 === state.targetVersion) {
    try {
      decodeMasterKey(requiredSecret(env, `MASTER_SHARE_V${state.targetVersion}`));
    } catch (error) {
      throw SealError.failure(`Rotation requires MASTER_SHARE_V${state.targetVersion}`, error);
    }
  }
  let masterKey: MasterKey;
  try {
    masterKey = decodeMasterKey(requiredSecret(env, `MASTER_SHARE_V${version}`));
  } catch (error) {
    throw SealError.failure(`Cannot serve committee traffic without MASTER_SHARE_V${version}`, error);
  }

  try {
    const keyServerObject = await withRpcRetries(config, () => client.getObject({ objectId: mode.keyServerObjectId }));
    const owner = keyServerObject.object.owner;
    if (owner?.$kind !== 'ObjectOwner') {
      throw new Error('Committee key server is not owned by its dynamic object field wrapper');
    }
    const wrapper = await withRpcRetries(config, () =>
      client.getObject({ objectId: owner.ObjectOwner, include: { content: true } }),
    );
    if (!wrapper.object.content) throw new Error('Committee wrapper has no BCS content');
    const committeeId = CommitteeFieldWrapper.parse(wrapper.object.content).name.name;
    const committeeObject = await withRpcRetries(config, () =>
      client.getObject({ objectId: committeeId, include: { content: true } }),
    );
    if (!committeeObject.object.content) throw new Error('Committee has no BCS content');
    const committee = SealCommittee.parse(committeeObject.object.content);
    const partyId = committee.members.findIndex((member) => normalizeSuiAddress(member) === mode.memberAddress);
    if (partyId < 0) throw new Error(`Member ${mode.memberAddress} is not in committee ${committeeId}`);
    const partial = keyServer.serverType.Committee.partialKeyServers.find((server) => server.partyId === partyId);
    if (!partial) throw new Error(`No partial key server for party ${partyId}`);
    const localPublicKey = publicKeyFromMasterKey(masterKey);
    if (!bytesEqual(localPublicKey, partial.partialPk)) {
      throw new Error('Configured committee master share public key does not match on-chain partial public key');
    }
    const context: CommitteeContext = {
      version,
      dynamicFieldVersion: versioned.dynamicField.version,
      masterKey,
      partialPublicKey: localPublicKey,
      partyId,
      serverName: partial.name,
    };
    committeeCache.set(cacheKey, context);
    return context;
  } catch (error) {
    if (error instanceof SealError) throw error;
    throw SealError.failure('Failed to validate committee master share', error);
  }
}

export function clearSuiCachesForTesting(): void {
  packageIdCache.clear();
  mvrCache.clear();
  committeeCache.clear();
  gasPriceCache.clear();
}

export type { CommitteeContext };
