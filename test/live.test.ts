import { bcs } from '@mysten/bcs';
import { bcs as suiBcs } from '@mysten/sui/bcs';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { describe, expect, it } from 'vitest';
import { CommitteeFieldWrapper, KeyServerV2, SealCommittee } from '../src/bcs.js';
import { loadConfig } from '../src/config.js';
import { checkPolicy, validatePtb } from '../src/request.js';
import {
  createSuiClient,
  fetchOriginalPackageId,
  getReferenceGasPrice,
  hasAddressAliases,
  resolveMvrPackage,
} from '../src/sui.js';
import type { Env } from '../src/types.js';

const live = process.env.LIVE_SUI_TESTS === '1' ? describe : describe.skip;
const TESTNET_SEAL_PACKAGE = '0x8c1870cb43a490564f7e0df516098c74c5aa43c6c1b61b17dc99bc6a0bd9436d';
const TESTNET_DEMO_PACKAGE = '0xc5ce2742cac46421b62028557f1d7aea8a4c50f651379a79afdf12cd88628807';
const TESTNET_COMMITTEE_KEY_SERVER = '0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98';

live('live Sui gRPC-web integration', () => {
  const env: Env = {
    NETWORK: 'testnet',
    KEY_SERVER_CONFIG: JSON.stringify({ mode: 'open', keyServerObjectId: '0x2' }),
  };
  const config = loadConfig(env);
  const client = createSuiClient(config.network, config.nodeUrl, env, config.rpcTimeoutMs);

  it('fetches reference gas and original package IDs through the Worker-compatible transport', async () => {
    expect(await getReferenceGasPrice(client, config)).toBeGreaterThan(0n);
    expect(await fetchOriginalPackageId(client, config, TESTNET_SEAL_PACKAGE)).toBe(
      normalizeSuiAddress(TESTNET_SEAL_PACKAGE),
    );
    expect(await hasAddressAliases(client, config, normalizeSuiAddress('0x123456789'))).toBe(false);
  });

  it('strictly resolves the upstream demo MVR name on mainnet and testnet', async () => {
    expect(await resolveMvrPackage(config, env, client, '@pkg/seal-demo-1234')).toBe(
      normalizeSuiAddress(TESTNET_DEMO_PACKAGE),
    );
  });

  it('parses a live V2 committee key-server dynamic field', async () => {
    const result = await client.getDynamicField({
      parentId: TESTNET_COMMITTEE_KEY_SERVER,
      name: { type: 'u64', bcs: bcs.u64().serialize(2).toBytes() },
    });
    const keyServer = KeyServerV2.parse(result.dynamicField.value.bcs);
    expect(keyServer.serverType.$kind).toBe('Committee');
    if (keyServer.serverType.$kind === 'Committee') {
      expect(keyServer.serverType.Committee.partialKeyServers.length).toBeGreaterThan(0);
      expect(keyServer.serverType.Committee.threshold).toBeGreaterThan(0);

      const keyServerObject = await client.getObject({ objectId: TESTNET_COMMITTEE_KEY_SERVER });
      expect(keyServerObject.object.owner?.$kind).toBe('ObjectOwner');
      if (keyServerObject.object.owner?.$kind !== 'ObjectOwner') throw new Error('Unexpected key-server owner');
      const wrapper = await client.getObject({
        objectId: keyServerObject.object.owner.ObjectOwner,
        include: { content: true },
      });
      if (!wrapper.object.content) throw new Error('Missing committee wrapper BCS');
      const committeeId = CommitteeFieldWrapper.parse(wrapper.object.content).name.name;
      const committeeObject = await client.getObject({ objectId: committeeId, include: { content: true } });
      if (!committeeObject.object.content) throw new Error('Missing committee BCS');
      const committee = SealCommittee.parse(committeeObject.object.content);
      expect(committee.members.length).toBe(keyServer.serverType.Committee.partialKeyServers.length);
    }
  });

  it('submits the reconstructed PTB and staleness check to transaction simulation', async () => {
    const ptb = validatePtb(
      suiBcs.ProgrammableTransaction.serialize({
        inputs: [{ Pure: { bytes: bcs.byteVector().serialize(new Uint8Array([1])).toBase64() } }],
        commands: [
          {
            MoveCall: {
              package: '0x2',
              module: 'does_not_exist',
              function: 'seal_approve',
              typeArguments: [],
              arguments: [{ Input: 0 }],
            },
          },
        ],
      }).toBytes(),
    );
    await expect(
      checkPolicy(client, config, ptb, normalizeSuiAddress('0x123456789'), await getReferenceGasPrice(client, config)),
    ).rejects.toEqual(expect.objectContaining({ code: 'InvalidPTB' }));
  });
});
