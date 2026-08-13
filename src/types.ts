export type Network = 'mainnet' | 'testnet' | 'devnet';

export interface Env {
  NETWORK?: string;
  NODE_URL?: string;
  MAINNET_NODE_URL?: string;
  SEAL_PACKAGE?: string;
  KEY_SERVER_CONFIG: string;
  MASTER_KEY?: string;
  FULL_NODE_RPC_API_NAME?: string;
  FULL_NODE_RPC_API_KEY?: string;
  MAINNET_FULL_NODE_RPC_API_NAME?: string;
  MAINNET_FULL_NODE_RPC_API_KEY?: string;
  API_KEY_NAME?: string;
  API_KEY?: string;
  SESSION_KEY_TTL_MAX_MINUTES?: string;
  ALLOWED_STALENESS_MS?: string;
  RPC_TIMEOUT_MS?: string;
  RPC_MAX_ATTEMPTS?: string;
  TS_SDK_VERSION_REQUIREMENT?: string;
  RUST_SDK_VERSION_REQUIREMENT?: string;
  PYTHON_SDK_VERSION_REQUIREMENT?: string;
  AGGREGATOR_VERSION_REQUIREMENT?: string;
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
  [name: string]: unknown;
}

export interface OpenModeConfig {
  mode: 'open';
  keyServerObjectId: string;
}

export interface DerivedClientKey {
  type: 'derived';
  derivationIndex: number;
}

export interface ImportedClientKey {
  type: 'imported';
  secretBinding: string;
}

export interface ExportedClientKey {
  type: 'exported';
  deprecatedDerivationIndex: number;
}

export interface PermissionedClientConfig {
  name: string;
  keyServerObjectId: string;
  packageIds: string[];
  key: DerivedClientKey | ImportedClientKey | ExportedClientKey;
}

export interface PermissionedModeConfig {
  mode: 'permissioned';
  clients: PermissionedClientConfig[];
}

export interface CommitteeModeConfig {
  mode: 'committee';
  keyServerObjectId: string;
  memberAddress: string;
  state?: { type: 'active' } | { type: 'rotation'; targetVersion: number };
}

export type ServerModeConfig = OpenModeConfig | PermissionedModeConfig | CommitteeModeConfig;

export interface RuntimeConfig {
  network: Network;
  nodeUrl: string;
  mainnetNodeUrl: string;
  sealPackageId: string;
  serverMode: ServerModeConfig;
  sessionKeyTtlMaxMs: number;
  allowedStalenessMs: number;
  rpcTimeoutMs: number;
  rpcMaxAttempts: number;
  sdkVersionRequirements: Record<ClientSdkType, string | null>;
}

export type ClientSdkType = 'aggregator' | 'typescript' | 'rust' | 'python' | 'other';

export interface Certificate {
  user: string;
  session_vk: string;
  creation_time: number;
  ttl_min: number;
  signature: string;
  mvr_name?: string | null;
}

export interface FetchKeyRequest {
  ptb: string;
  enc_key: string;
  enc_verification_key: string;
  request_signature: string;
  certificate: Certificate;
}

export interface ParsedFetchKeyRequest {
  ptbBytes: Uint8Array;
  encKeyBytes: Uint8Array;
  encVerificationKeyBytes: Uint8Array;
  requestSignatureBytes: Uint8Array;
  sessionPublicKeyBytes: Uint8Array;
  certificate: Certificate;
}

export interface DecryptionKeyResponse {
  id: string;
  encrypted_key: [string, string];
}

export interface FetchKeyResponse {
  decryption_keys: DecryptionKeyResponse[];
}
