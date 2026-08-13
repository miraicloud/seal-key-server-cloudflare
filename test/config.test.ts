import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { loadStaticKeyStore } from '../src/keys.js';
import { masterKeyToBytes } from '../src/crypto.js';
import type { Env } from '../src/types.js';
import { toHex } from '@mysten/bcs';

const id = (digit: string) => `0x${digit.repeat(64)}`;
const seed = `0x${'01'.repeat(32)}`;
const imported = `0x${'00'.repeat(31)}02`;

describe('deployment configuration', () => {
  it('normalizes short Sui IDs in open mode', () => {
    const config = loadConfig({ KEY_SERVER_CONFIG: JSON.stringify({ mode: 'open', keyServerObjectId: '0x2' }) });
    expect(config.serverMode).toEqual({ mode: 'open', keyServerObjectId: `0x${'0'.repeat(63)}2` });
  });

  it('loads derived and imported permissioned keys while omitting exported clients', () => {
    const env: Env = {
      KEY_SERVER_CONFIG: JSON.stringify({
        mode: 'permissioned',
        clients: [
          {
            name: 'derived',
            keyServerObjectId: id('a'),
            packageIds: [id('1')],
            key: { type: 'derived', derivationIndex: 0 },
          },
          {
            name: 'imported',
            keyServerObjectId: id('b'),
            packageIds: [id('2')],
            key: { type: 'imported', secretBinding: 'CLIENT_B_KEY' },
          },
          {
            name: 'retired',
            keyServerObjectId: id('c'),
            packageIds: [id('3')],
            key: { type: 'exported', deprecatedDerivationIndex: 1 },
          },
        ],
      }),
      MASTER_KEY: seed,
      CLIENT_B_KEY: imported,
    };
    const config = loadConfig(env);
    const keys = loadStaticKeyStore(config, env);
    expect(keys.packageKeys.has(id('1'))).toBe(true);
    expect(toHex(masterKeyToBytes(keys.packageKeys.get(id('2'))!))).toBe(imported.slice(2));
    expect(keys.packageKeys.has(id('3'))).toBe(false);
    expect(keys.serviceKeys.has(id('c'))).toBe(false);
  });

  it('rejects gaps in derivation history and half-configured RPC credentials', () => {
    expect(() =>
      loadConfig({
        KEY_SERVER_CONFIG: JSON.stringify({
          mode: 'permissioned',
          clients: [
            {
              name: 'gap',
              keyServerObjectId: id('a'),
              packageIds: [id('1')],
              key: { type: 'derived', derivationIndex: 1 },
            },
          ],
        }),
      }),
    ).toThrow(/incremental/);
    expect(() =>
      loadConfig({
        KEY_SERVER_CONFIG: JSON.stringify({ mode: 'open', keyServerObjectId: '0x2' }),
        FULL_NODE_RPC_API_KEY: 'secret',
      }),
    ).toThrow(/configured together/);
  });
});
