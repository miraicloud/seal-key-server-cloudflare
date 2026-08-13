import { bcs, toBase64 } from '@mysten/bcs';
import { SessionKey } from '@mysten/seal';
import { bcs as suiBcs } from '@mysten/sui/bcs';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { describe, expect, it } from 'vitest';
import { signedPersonalMessage, signedRequest, verifySessionSignature } from '../src/crypto.js';
import { parseFetchKeyRequest, validatePtb } from '../src/request.js';

const PACKAGE_ID = `0x${'2'.padStart(64, '0')}`;

function policyPtb(): Uint8Array {
  return suiBcs.ProgrammableTransaction.serialize({
    inputs: [{ Pure: { bytes: bcs.byteVector().serialize(new Uint8Array([9, 8, 7])).toBase64() } }],
    commands: [
      {
        MoveCall: {
          package: PACKAGE_ID,
          module: 'policy',
          function: 'seal_approve',
          typeArguments: [],
          arguments: [{ Input: 0 }],
        },
      },
    ],
  }).toBytes();
}

describe('@mysten/seal client compatibility', () => {
  it('accepts the certificate, ElGamal keys, and request signature emitted by SessionKey', async () => {
    const signer = Ed25519Keypair.generate();
    const client = {
      core: {
        getObject: async () => ({ object: { version: '1' } }),
      },
    };
    const session = await SessionKey.create({
      address: signer.getPublicKey().toSuiAddress(),
      packageId: PACKAGE_ID,
      ttlMin: 10,
      signer,
      suiClient: client as never,
    });
    const ptb = policyPtb();
    const params = await session.createRequestParams(new Uint8Array([0, ...ptb]));
    const certificate = await session.getCertificate();
    const parsed = parseFetchKeyRequest({
      ptb: toBase64(ptb),
      enc_key: toBase64(params.encKeyPk),
      enc_verification_key: toBase64(params.encVerificationKey),
      request_signature: params.requestSignature,
      certificate,
    });

    expect(validatePtb(parsed.ptbBytes).innerIds[0]).toEqual(new Uint8Array([9, 8, 7]));
    expect(
      verifySessionSignature(
        parsed.requestSignatureBytes,
        parsed.sessionPublicKeyBytes,
        signedRequest(parsed.ptbBytes, parsed.encKeyBytes, parsed.encVerificationKeyBytes),
      ),
    ).toBe(true);
    expect(
      signedPersonalMessage(
        PACKAGE_ID,
        parsed.sessionPublicKeyBytes,
        certificate.creation_time,
        certificate.ttl_min,
      ),
    ).toEqual(session.getPersonalMessage());
  });
});
