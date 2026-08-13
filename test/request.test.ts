import { bcs } from '@mysten/bcs';
import { bcs as suiBcs } from '@mysten/sui/bcs';
import { describe, expect, it } from 'vitest';
import { SealError } from '../src/errors.js';
import { validateCertificateTime, validatePtb } from '../src/request.js';
import type { RuntimeConfig } from '../src/types.js';

function ptbBytes(overrides?: { function?: string; package?: string; argument?: { Input: number } | { Result: number } }): Uint8Array {
  return suiBcs.ProgrammableTransaction.serialize({
    inputs: [{ Pure: { bytes: bcs.byteVector().serialize(new Uint8Array([1, 2, 3])).toBase64() } }],
    commands: [
      {
        MoveCall: {
          package: overrides?.package ?? '0x2',
          module: 'policy',
          function: overrides?.function ?? 'seal_approve',
          typeArguments: [],
          arguments: [overrides?.argument ?? { Input: 0 }],
        },
      },
    ],
  }).toBytes();
}

describe('restricted policy PTB validation', () => {
  it('accepts an upstream-compatible seal_approve call and extracts its inner ID', () => {
    const result = validatePtb(ptbBytes());
    expect(result.packageId).toBe(`0x${'2'.padStart(64, '0')}`);
    expect([...result.innerIds[0]]).toEqual([1, 2, 3]);
  });

  it('rejects functions outside the seal_approve namespace', () => {
    expect(() => validatePtb(ptbBytes({ function: 'approve' }))).toThrowError(
      expect.objectContaining<Partial<SealError>>({ code: 'InvalidPTB' }),
    );
  });

  it('rejects command results and other non-input arguments', () => {
    expect(() => validatePtb(ptbBytes({ argument: { Result: 0 } }))).toThrowError(
      expect.objectContaining<Partial<SealError>>({ code: 'InvalidPTB' }),
    );
  });
});

describe('certificate lifetime', () => {
  const config = { sessionKeyTtlMaxMs: 30 * 60_000 } as RuntimeConfig;
  const certificate = {
    user: '0x1',
    session_vk: '',
    signature: '',
    creation_time: 1_000_000,
    ttl_min: 10,
  };

  it('accepts a live certificate and rejects expired, future, and overlong certificates', () => {
    expect(() => validateCertificateTime(certificate, config, 1_100_000)).not.toThrow();
    expect(() => validateCertificateTime(certificate, config, 1_700_001)).toThrowError(
      expect.objectContaining<Partial<SealError>>({ code: 'InvalidCertificate' }),
    );
    expect(() => validateCertificateTime(certificate, config, 999_999)).toThrowError(
      expect.objectContaining<Partial<SealError>>({ code: 'InvalidCertificate' }),
    );
    expect(() => validateCertificateTime({ ...certificate, ttl_min: 31 }, config, 1_100_000)).toThrowError(
      expect.objectContaining<Partial<SealError>>({ code: 'InvalidCertificate' }),
    );
  });
});
