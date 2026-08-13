import { normalizeSuiAddress } from '@mysten/sui/utils';
import { isSuiId } from './ids.js';
import type {
  ClientSdkType,
  CommitteeModeConfig,
  Env,
  PermissionedModeConfig,
  RuntimeConfig,
  ServerModeConfig,
} from './types.js';

const DEFAULT_NODE_URLS = {
  mainnet: 'https://fullnode.mainnet.sui.io:443',
  testnet: 'https://fullnode.testnet.sui.io:443',
  devnet: 'https://fullnode.devnet.sui.io:443',
} as const;

const SEAL_PACKAGE_IDS = {
  mainnet: '0xbabb2b101000d2f3926ddc2e2b435f4e4c2c634f70eb5671919b0a907df9f2cf',
  testnet: '0x8c1870cb43a490564f7e0df516098c74c5aa43c6c1b61b17dc99bc6a0bd9436d',
} as const;

function stringEnv(env: Env, name: keyof Env): string | undefined {
  const value = env[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function integerEnv(env: Env, name: keyof Env, fallback: number, min: number, max: number): number {
  const value = stringEnv(env, name);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${String(name)} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function normalizeObjectId(value: unknown, label: string): string {
  if (!isSuiId(value)) throw new Error(`${label} must be a valid Sui object ID`);
  return normalizeSuiAddress(value);
}

function normalizeAddress(value: unknown, label: string): string {
  if (!isSuiId(value)) throw new Error(`${label} must be a valid Sui address`);
  return normalizeSuiAddress(value);
}

function nonNegativeInteger(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function validatePermissionedMode(raw: Record<string, unknown>): PermissionedModeConfig {
  if (!Array.isArray(raw.clients)) throw new Error('permissioned mode requires a clients array');
  const names = new Set<string>();
  const derivationIndices = new Set<number>();
  const secretBindings = new Set<string>();
  const objectIds = new Set<string>();

  const clients = raw.clients.map((value, index) => {
    if (!value || typeof value !== 'object') throw new Error(`clients[${index}] must be an object`);
    const client = value as Record<string, unknown>;
    if (typeof client.name !== 'string' || client.name.length === 0) throw new Error(`clients[${index}].name is required`);
    if (!names.add(client.name)) throw new Error(`Duplicate client name: ${client.name}`);
    const keyServerObjectId = normalizeObjectId(client.keyServerObjectId, `clients[${index}].keyServerObjectId`);
    if (!objectIds.add(keyServerObjectId)) throw new Error(`Duplicate key server object ID: ${keyServerObjectId}`);
    if (!Array.isArray(client.packageIds) || client.packageIds.length === 0) {
      throw new Error(`Client configuration must have at least one package ID: ${client.name}`);
    }
    const packageIds = client.packageIds.map((id, packageIndex) => {
      const normalized = normalizeObjectId(id, `clients[${index}].packageIds[${packageIndex}]`);
      if (!objectIds.add(normalized)) throw new Error(`Duplicate package ID: ${normalized}`);
      return normalized;
    });
    if (!client.key || typeof client.key !== 'object') throw new Error(`clients[${index}].key is required`);
    const rawKey = client.key as Record<string, unknown>;
    let key;
    switch (rawKey.type) {
      case 'derived': {
        const derivationIndex = nonNegativeInteger(rawKey.derivationIndex, `clients[${index}].key.derivationIndex`);
        if (!derivationIndices.add(derivationIndex)) throw new Error(`Duplicate derivation index: ${derivationIndex}`);
        key = { type: 'derived' as const, derivationIndex };
        break;
      }
      case 'imported': {
        if (typeof rawKey.secretBinding !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(rawKey.secretBinding)) {
          throw new Error(`clients[${index}].key.secretBinding must be an uppercase Worker binding name`);
        }
        if (!secretBindings.add(rawKey.secretBinding)) throw new Error(`Duplicate secret binding: ${rawKey.secretBinding}`);
        key = { type: 'imported' as const, secretBinding: rawKey.secretBinding };
        break;
      }
      case 'exported': {
        const deprecatedDerivationIndex = nonNegativeInteger(
          rawKey.deprecatedDerivationIndex,
          `clients[${index}].key.deprecatedDerivationIndex`,
        );
        if (!derivationIndices.add(deprecatedDerivationIndex)) {
          throw new Error(`Duplicate derivation index: ${deprecatedDerivationIndex}`);
        }
        key = { type: 'exported' as const, deprecatedDerivationIndex };
        break;
      }
      default:
        throw new Error(`clients[${index}].key.type must be derived, imported, or exported`);
    }
    return { name: client.name, keyServerObjectId, packageIds, key };
  });

  for (let index = 0; index < derivationIndices.size; index += 1) {
    if (!derivationIndices.has(index)) throw new Error('Derivation indexes must be incremental, starting from 0');
  }
  return { mode: 'permissioned', clients };
}

function validateCommitteeMode(raw: Record<string, unknown>): CommitteeModeConfig {
  const stateValue = raw.state;
  let state: CommitteeModeConfig['state'];
  if (stateValue === undefined) {
    state = { type: 'active' };
  } else if (stateValue && typeof stateValue === 'object') {
    const rawState = stateValue as Record<string, unknown>;
    if (rawState.type === 'active') state = { type: 'active' };
    else if (rawState.type === 'rotation') {
      const targetVersion = nonNegativeInteger(rawState.targetVersion, 'state.targetVersion', 0xffff_ffff);
      if (targetVersion === 0) throw new Error('state.targetVersion cannot be zero');
      state = { type: 'rotation', targetVersion };
    } else throw new Error('committee state.type must be active or rotation');
  } else throw new Error('committee state must be an object');
  return {
    mode: 'committee',
    keyServerObjectId: normalizeObjectId(raw.keyServerObjectId, 'keyServerObjectId'),
    memberAddress: normalizeAddress(raw.memberAddress, 'memberAddress'),
    state,
  };
}

function parseServerMode(value: string): ServerModeConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch (error) {
    throw new Error('KEY_SERVER_CONFIG must be valid JSON', { cause: error });
  }
  if (!raw || typeof raw !== 'object') throw new Error('KEY_SERVER_CONFIG must contain an object');
  const object = raw as Record<string, unknown>;
  switch (object.mode) {
    case 'open':
      return { mode: 'open', keyServerObjectId: normalizeObjectId(object.keyServerObjectId, 'keyServerObjectId') };
    case 'permissioned':
      return validatePermissionedMode(object);
    case 'committee':
      return validateCommitteeMode(object);
    default:
      throw new Error('KEY_SERVER_CONFIG.mode must be open, permissioned, or committee');
  }
}

export function loadConfig(env: Env): RuntimeConfig {
  for (const [nameBinding, keyBinding] of [
    ['FULL_NODE_RPC_API_NAME', 'FULL_NODE_RPC_API_KEY'],
    ['MAINNET_FULL_NODE_RPC_API_NAME', 'MAINNET_FULL_NODE_RPC_API_KEY'],
  ] as const) {
    if ((stringEnv(env, nameBinding) === undefined) !== (stringEnv(env, keyBinding) === undefined)) {
      throw new Error(`${nameBinding} and ${keyBinding} must be configured together`);
    }
  }
  const networkValue = (stringEnv(env, 'NETWORK') ?? 'testnet').toLowerCase();
  if (networkValue !== 'mainnet' && networkValue !== 'testnet' && networkValue !== 'devnet') {
    throw new Error(`Unsupported NETWORK: ${networkValue}`);
  }
  const sealPackageId = networkValue === 'devnet'
    ? normalizeObjectId(stringEnv(env, 'SEAL_PACKAGE'), 'SEAL_PACKAGE')
    : normalizeSuiAddress(SEAL_PACKAGE_IDS[networkValue]);
  const requirements: Record<ClientSdkType, string | null> = {
    aggregator: stringEnv(env, 'AGGREGATOR_VERSION_REQUIREMENT') ?? '>=0.6.2',
    typescript: stringEnv(env, 'TS_SDK_VERSION_REQUIREMENT') ?? '>=0.4.5',
    rust: stringEnv(env, 'RUST_SDK_VERSION_REQUIREMENT') ?? '>=0.0.0',
    python: stringEnv(env, 'PYTHON_SDK_VERSION_REQUIREMENT') ?? '>=0.0.0',
    other: null,
  };
  return {
    network: networkValue,
    nodeUrl: stringEnv(env, 'NODE_URL') ?? DEFAULT_NODE_URLS[networkValue],
    mainnetNodeUrl: stringEnv(env, 'MAINNET_NODE_URL') ?? DEFAULT_NODE_URLS.mainnet,
    sealPackageId,
    serverMode: parseServerMode(env.KEY_SERVER_CONFIG),
    sessionKeyTtlMaxMs: integerEnv(env, 'SESSION_KEY_TTL_MAX_MINUTES', 30, 1, 65_535) * 60_000,
    allowedStalenessMs: integerEnv(env, 'ALLOWED_STALENESS_MS', 120_000, 0, Number.MAX_SAFE_INTEGER),
    rpcTimeoutMs: integerEnv(env, 'RPC_TIMEOUT_MS', 60_000, 100, 300_000),
    rpcMaxAttempts: integerEnv(env, 'RPC_MAX_ATTEMPTS', 3, 1, 10),
    sdkVersionRequirements: requirements,
  };
}

export function requiredSecret(env: Env, binding: string): string {
  const value = env[binding];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing Worker secret binding: ${binding}`);
  return value;
}
