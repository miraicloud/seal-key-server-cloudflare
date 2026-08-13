import { bcs, fromBase64, fromHex, toHex } from '@mysten/bcs';
import { bls12_381 } from '@noble/curves/bls12-381.js';
import { describe, expect, it } from 'vitest';
import {
  createProofOfPossession,
  deriveMasterKey,
  encryptUserSecretKey,
  extractUserSecretKey,
  masterKeyToBytes,
  publicKeyFromMasterKey,
  signedPersonalMessage,
  signedRequest,
} from '../src/crypto.js';

const SIGNED_REQUEST_VECTOR =
  '38000100d92bc457b42d48924087ea3f22d35fd2fe9afdf5bdfe38cc51c0f14f3282f6d503626c610e7365616c5f617070726f76655f7800003085946cd4134ecb8f7739bbd3522d1c8fab793c6c431a8b0b77b4f1885d4c096aafab755e7b8bce8688410cee9908fb29608faaf686c0dcbe3f65f1130e8be538d7ea009347d397f517188dfa14417618887a0412e404fff56efbafb63d1fc4970a1187b4ccb6e767a91822312e533fa53dee69f77ef5130be095e147ff3d40e96e8ddc4bf554dae3bcc34048fe9330cccf';

describe('upstream cryptographic compatibility', () => {
  it('matches the Rust HKDF master-key regression vector', () => {
    expect(toHex(masterKeyToBytes(deriveMasterKey(new Uint8Array(32).fill(1), 42)))).toBe(
      '17d496df95e12b5caec0c4a15b09a5ea41b4fb1cf3ba28f1c6c72556846a6db6',
    );
  });

  it('matches the Rust personal-message regression vector', () => {
    const sessionKey = fromBase64('DX2rNYyNrapO+gBJp1sHQ2VVsQo2ghm7aA9wVxNJ13U=');
    const message = signedPersonalMessage(
      '0x0000c457b42d48924087ea3f22d35fd2fe9afdf5bdfe38cc51c0f14f3282f6d5',
      sessionKey,
      1_622_548_800,
      30,
    );
    expect(new TextDecoder().decode(message)).toBe(
      'Accessing keys of package 0x0000c457b42d48924087ea3f22d35fd2fe9afdf5bdfe38cc51c0f14f3282f6d5 for 30 mins from 1970-01-19 18:42:28 UTC, session key DX2rNYyNrapO+gBJp1sHQ2VVsQo2ghm7aA9wVxNJ13U=',
    );
  });

  it('matches the Rust BCS signed-request regression vector', () => {
    const bytes = fromHex(SIGNED_REQUEST_VECTOR);
    const ptb = bytes.slice(1, 1 + 0x38);
    const encryptionKey = bytes.slice(1 + 0x38 + 1, 1 + 0x38 + 1 + 0x30);
    const verificationKey = bytes.slice(1 + 0x38 + 1 + 0x30 + 1);
    expect(toHex(signedRequest(ptb, encryptionKey, verificationKey))).toBe(SIGNED_REQUEST_VECTOR);
  });

  it('extracts and ElGamal-encrypts a verifiable user key', () => {
    const masterKey = 7n;
    const id = bcs.byteVector().serialize(new Uint8Array([1, 2, 3, 4])).toBytes();
    const userKey = extractUserSecretKey(masterKey, id);
    const encryptionSecret = 11n;
    const encryptionPublic = bls12_381.G1.Point.BASE.multiply(encryptionSecret).toBytes();
    const [c0, c1] = encryptUserSecretKey(userKey, encryptionPublic, 13n);
    const decrypted = bls12_381.G1.Point.fromBytes(c1).subtract(
      bls12_381.G1.Point.fromBytes(c0).multiply(encryptionSecret),
    );
    expect(decrypted.equals(bls12_381.G1.Point.fromBytes(userKey))).toBe(true);

    const lhs = bls12_381.pairing(decrypted, bls12_381.G2.Point.BASE);
    const identity = bls12_381.G1.hashToCurve(
      new Uint8Array([...new TextEncoder().encode('SUI-SEAL-IBE-BLS12381-00'), ...id]),
    );
    const rhs = bls12_381.pairing(identity, bls12_381.G2.Point.fromBytes(publicKeyFromMasterKey(masterKey)));
    expect(bls12_381.fields.Fp12.eql(lhs, rhs)).toBe(true);
  });

  it('creates a proof of possession accepted by the TypeScript SDK equation', () => {
    const masterKey = 17n;
    const serviceId = `0x${'2'.padStart(64, '0')}`;
    const publicKey = publicKeyFromMasterKey(masterKey);
    const fullMessage = new Uint8Array([
      ...new TextEncoder().encode('SUI-SEAL-IBE-BLS12381-POP-00'),
      ...publicKey,
      ...fromHex(serviceId),
    ]);
    expect(
      bls12_381.shortSignatures.verify(
        createProofOfPossession(masterKey, serviceId),
        bls12_381.shortSignatures.hash(fullMessage),
        publicKey,
      ),
    ).toBe(true);
  });
});
