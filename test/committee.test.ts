import { toHex } from '@mysten/bcs';
import { describe, expect, it } from 'vitest';
import { CommitteeFieldWrapper, KeyServerV2, SealCommittee } from '../src/bcs.js';
import { masterKeyToBytes, publicKeyFromMasterKey } from '../src/crypto.js';
import { SealError } from '../src/errors.js';
import { clearSuiCachesForTesting, loadCommitteeContext } from '../src/sui.js';
import type { CommitteeModeConfig, Env, RuntimeConfig } from '../src/types.js';

const fullId = (value: string) => `0x${value.padStart(64, '0')}`;
const KEY_SERVER_ID = fullId('2');
const WRAPPER_ID = fullId('3');
const COMMITTEE_ID = fullId('4');
const MEMBER = fullId('5');

function fixture(version: number, masterKey: bigint) {
  const partialPublicKey = publicKeyFromMasterKey(masterKey);
  const keyServerBcs = KeyServerV2.serialize({
    name: 'committee',
    keyType: 0,
    pk: partialPublicKey,
    serverType: {
      Committee: {
        version,
        threshold: 1,
        partialKeyServers: [{ name: 'member-1', url: 'https://member.example', partialPk: partialPublicKey, partyId: 0 }],
      },
    },
  }).toBytes();
  const wrapperBcs = CommitteeFieldWrapper.serialize({ id: WRAPPER_ID, name: { name: COMMITTEE_ID }, value: KEY_SERVER_ID }).toBytes();
  const committeeBcs = SealCommittee.serialize({
    id: COMMITTEE_ID,
    threshold: 1,
    members: [MEMBER],
    state: { Finalized: true },
    oldCommitteeId: null,
  }).toBytes();
  const client = {
    getDynamicField: async () => ({ dynamicField: { version: String(version), value: { bcs: keyServerBcs } } }),
    getObject: async ({ objectId, include }: { objectId: string; include?: unknown }) => {
      if (objectId === KEY_SERVER_ID) return { object: { owner: { ObjectOwner: WRAPPER_ID, $kind: 'ObjectOwner' } } };
      if (objectId === WRAPPER_ID && include) return { object: { content: wrapperBcs } };
      if (objectId === COMMITTEE_ID && include) return { object: { content: committeeBcs } };
      throw new Error(`Unexpected object ${objectId}`);
    },
  };
  return { client, partialPublicKey };
}

function config(state: CommitteeModeConfig['state']): RuntimeConfig {
  return {
    network: 'testnet',
    nodeUrl: 'https://testnet.example',
    mainnetNodeUrl: 'https://mainnet.example',
    sealPackageId: fullId('6'),
    serverMode: { mode: 'committee', keyServerObjectId: KEY_SERVER_ID, memberAddress: MEMBER, state },
    sessionKeyTtlMaxMs: 1,
    allowedStalenessMs: 1,
    rpcTimeoutMs: 1_000,
    rpcMaxAttempts: 1,
    sdkVersionRequirements: { aggregator: null, typescript: null, rust: null, python: null, other: null },
  };
}

describe('committee share loading', () => {
  it('validates an active share against the on-chain member partial key', async () => {
    clearSuiCachesForTesting();
    const masterKey = 7n;
    const { client, partialPublicKey } = fixture(4, masterKey);
    const env: Env = {
      KEY_SERVER_CONFIG: '',
      MASTER_SHARE_V4: `0x${toHex(masterKeyToBytes(masterKey))}`,
    };
    const result = await loadCommitteeContext(client as never, config({ type: 'active' }), env, config({ type: 'active' }).serverMode as CommitteeModeConfig);
    expect(result.version).toBe(4);
    expect(result.partialPublicKey).toEqual(partialPublicKey);
    expect(result.partyId).toBe(0);
  });

  it('requires the target share before serving during configured rotation', async () => {
    clearSuiCachesForTesting();
    const masterKey = 7n;
    const { client } = fixture(4, masterKey);
    const runtime = config({ type: 'rotation', targetVersion: 5 });
    const env: Env = {
      KEY_SERVER_CONFIG: '',
      MASTER_SHARE_V4: `0x${toHex(masterKeyToBytes(masterKey))}`,
    };
    await expect(
      loadCommitteeContext(client as never, runtime, env, runtime.serverMode as CommitteeModeConfig),
    ).rejects.toEqual(expect.objectContaining<Partial<SealError>>({ code: 'Failure' }));
  });
});
