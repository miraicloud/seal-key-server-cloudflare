import { normalizeSuiAddress } from '@mysten/sui/utils';
import { decodeMasterKey, decodeSeed, deriveMasterKey, type MasterKey } from './crypto.js';
import { requiredSecret } from './config.js';
import { SealError } from './errors.js';
import type { Env, RuntimeConfig } from './types.js';

export interface StaticKeyStore {
  openKey?: MasterKey;
  packageKeys: Map<string, MasterKey>;
  serviceKeys: Map<string, MasterKey>;
}

export function loadStaticKeyStore(config: RuntimeConfig, env: Env): StaticKeyStore {
  const packageKeys = new Map<string, MasterKey>();
  const serviceKeys = new Map<string, MasterKey>();
  if (config.serverMode.mode === 'open') {
    const masterKey = decodeMasterKey(requiredSecret(env, 'MASTER_KEY'), true);
    serviceKeys.set(config.serverMode.keyServerObjectId, masterKey);
    return { openKey: masterKey, packageKeys, serviceKeys };
  }
  if (config.serverMode.mode === 'committee') return { packageKeys, serviceKeys };

  const seed = decodeSeed(requiredSecret(env, 'MASTER_KEY'));
  for (const client of config.serverMode.clients) {
    let masterKey: MasterKey | undefined;
    switch (client.key.type) {
      case 'derived':
        masterKey = deriveMasterKey(seed, client.key.derivationIndex);
        break;
      case 'imported':
        masterKey = decodeMasterKey(requiredSecret(env, client.key.secretBinding));
        break;
      case 'exported':
        continue;
    }
    serviceKeys.set(client.keyServerObjectId, masterKey);
    for (const packageId of client.packageIds) packageKeys.set(packageId, masterKey);
  }
  if (packageKeys.size === 0) throw new Error('No clients found in the configuration');
  return { packageKeys, serviceKeys };
}

export function masterKeyForPackage(
  config: RuntimeConfig,
  keyStore: StaticKeyStore,
  firstPackageId: string,
  committeeKey?: MasterKey,
): MasterKey {
  if (config.serverMode.mode === 'open') return keyStore.openKey!;
  if (config.serverMode.mode === 'committee') {
    if (committeeKey === undefined) throw SealError.failure('Committee key was not loaded');
    return committeeKey;
  }
  const key = keyStore.packageKeys.get(normalizeSuiAddress(firstPackageId));
  if (key === undefined) throw new SealError('UnsupportedPackageId', 'Unsupported package ID');
  return key;
}
