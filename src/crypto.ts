import { fromBase64, fromHex, toBase64 } from '@mysten/bcs';
import { bls12_381 } from '@noble/curves/bls12-381.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToNumberBE, concatBytes, numberToBytesBE } from '@noble/curves/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { RequestFormat } from './bcs.js';

const DST_ID = new TextEncoder().encode('SUI-SEAL-IBE-BLS12381-00');
const DST_POP = new TextEncoder().encode('SUI-SEAL-IBE-BLS12381-POP-00');
const SCALAR_ORDER = bls12_381.fields.Fr.ORDER;

export type MasterKey = bigint;

function scalarFromBytes(bytes: Uint8Array): MasterKey {
  if (bytes.length !== 32) throw new Error('Master key must be 32 bytes');
  const scalar = bytesToNumberBE(bytes);
  if (scalar <= 0n || scalar >= SCALAR_ORDER) throw new Error('Master key is not a valid non-zero BLS scalar');
  return scalar;
}

export function decodeMasterKey(value: string, allowBase64 = false): MasterKey {
  const trimmed = value.trim();
  if (/^(?:0x)?[0-9a-fA-F]{64}$/.test(trimmed)) return scalarFromBytes(fromHex(trimmed));
  if (allowBase64) return scalarFromBytes(fromBase64(trimmed));
  throw new Error('Expected a 32-byte hex-encoded BLS scalar');
}

export function decodeSeed(value: string): Uint8Array {
  const trimmed = value.trim();
  if (!/^(?:0x)?[0-9a-fA-F]{64}$/.test(trimmed)) throw new Error('Expected a 32-byte hex-encoded seed');
  return fromHex(trimmed);
}

export function deriveMasterKey(seed: Uint8Array, derivationIndex: number): MasterKey {
  if (seed.length !== 32) throw new Error('Seed must be 32 bytes');
  if (!Number.isSafeInteger(derivationIndex) || derivationIndex < 0) throw new Error('Invalid derivation index');
  const info = new Uint8Array(8);
  new DataView(info.buffer).setBigUint64(0, BigInt(derivationIndex), false);
  const uniformBytes = hkdf(sha3_256, seed, new Uint8Array(), info, 64);
  const scalar = bytesToNumberBE(uniformBytes) % SCALAR_ORDER;
  if (scalar === 0n) throw new Error('Derived an invalid zero BLS scalar');
  return scalar;
}

export function masterKeyToBytes(masterKey: MasterKey): Uint8Array {
  return numberToBytesBE(masterKey, 32);
}

export function publicKeyFromMasterKey(masterKey: MasterKey): Uint8Array {
  return bls12_381.G2.Point.BASE.multiply(masterKey).toBytes();
}

export function extractUserSecretKey(masterKey: MasterKey, id: Uint8Array): Uint8Array {
  const identityPoint = bls12_381.G1.hashToCurve(concatBytes(DST_ID, id));
  return identityPoint.multiply(masterKey).toBytes();
}

export function encryptUserSecretKey(
  userSecretKey: Uint8Array,
  encryptionPublicKey: Uint8Array,
  randomness?: MasterKey,
): [Uint8Array, Uint8Array] {
  const message = bls12_381.G1.Point.fromBytes(userSecretKey);
  const publicKey = bls12_381.G1.Point.fromBytes(encryptionPublicKey);
  const r = randomness ?? scalarFromBytes(bls12_381.utils.randomSecretKey());
  const c0 = bls12_381.G1.Point.BASE.multiply(r);
  const c1 = publicKey.multiply(r).add(message);
  return [c0.toBytes(), c1.toBytes()];
}

export function validateEncryptionPublicKeys(
  encryptionPublicKey: Uint8Array,
  encryptionVerificationKey: Uint8Array,
): void {
  if (encryptionPublicKey.length !== 48) throw new Error('ElGamal public key must be 48 bytes');
  if (encryptionVerificationKey.length !== 96) throw new Error('ElGamal verification key must be 96 bytes');
  bls12_381.G1.Point.fromBytes(encryptionPublicKey);
  bls12_381.G2.Point.fromBytes(encryptionVerificationKey);
}

export function createProofOfPossession(masterKey: MasterKey, serviceId: string): Uint8Array {
  const publicKey = publicKeyFromMasterKey(masterKey);
  const message = concatBytes(DST_POP, publicKey, fromHex(serviceId));
  const hashed = bls12_381.shortSignatures.hash(message);
  return bls12_381.shortSignatures.sign(hashed, masterKeyToBytes(masterKey)).toBytes();
}

export function signedRequest(
  ptbBytes: Uint8Array,
  encKeyBytes: Uint8Array,
  encVerificationKeyBytes: Uint8Array,
): Uint8Array {
  return RequestFormat.serialize({
    ptb: ptbBytes,
    encKey: encKeyBytes,
    encVerificationKey: encVerificationKeyBytes,
  }).toBytes();
}

export function verifySessionSignature(
  signature: Uint8Array,
  sessionPublicKey: Uint8Array,
  message: Uint8Array,
): boolean {
  return ed25519.verify(signature, message, sessionPublicKey);
}

export function signedPersonalMessage(
  packageName: string,
  sessionPublicKey: Uint8Array,
  creationTimeMs: number,
  ttlMin: number,
): Uint8Array {
  const creationTimeUtc = new Date(Math.floor(creationTimeMs / 1000) * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ') + ' UTC';
  return new TextEncoder().encode(
    `Accessing keys of package ${packageName} for ${ttlMin} mins from ${creationTimeUtc}, session key ${toBase64(sessionPublicKey)}`,
  );
}

export function fullKeyId(packageId: string, innerId: Uint8Array): Uint8Array {
  return concatBytes(fromHex(packageId), innerId);
}

export function encryptedKeyJson(encryptedKey: [Uint8Array, Uint8Array]): [string, string] {
  return [toBase64(encryptedKey[0]), toBase64(encryptedKey[1])];
}
