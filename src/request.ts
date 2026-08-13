import { bcs, fromBase64 } from '@mysten/bcs';
import { bcs as suiBcs } from '@mysten/sui/bcs';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { validateEncryptionPublicKeys } from './crypto.js';
import { SealError } from './errors.js';
import { isSuiId } from './ids.js';
import { withRpcRetries } from './sui.js';
import type { Certificate, FetchKeyRequest, ParsedFetchKeyRequest, RuntimeConfig } from './types.js';

const MAX_COMMANDS = 100;
const MAX_COMPUTATION_UNITS = 55_000n;
const CLOCK_OBJECT_ID = normalizeSuiAddress('0x6');
const CLOCK_INITIAL_SHARED_VERSION = 1;
const STALENESS_MODULE = 'time';
const STALENESS_FUNCTION = 'check_staleness';
const STALE_FULLNODE_ERROR_CODE = '93492';
const STALE_KEY_SERVER_ERROR_CODE = '93493';

export type ParsedPtb = ReturnType<typeof suiBcs.ProgrammableTransaction.parse>;

export interface ValidPtb {
  bytes: Uint8Array;
  value: ParsedPtb;
  packageId: string;
  innerIds: Uint8Array[];
}

function decodeBase64Field(value: unknown, field: string, expectedLength?: number): Uint8Array {
  if (typeof value !== 'string') throw SealError.invalidPtb(`${field} must be base64`);
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(value);
  } catch (error) {
    throw SealError.invalidPtb(`Invalid base64 in ${field}`);
  }
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    throw SealError.invalidPtb(`${field} must decode to ${expectedLength} bytes`);
  }
  return bytes;
}

function parseCertificate(value: unknown): Certificate {
  if (!value || typeof value !== 'object') throw SealError.invalidPtb('certificate must be an object');
  const raw = value as Record<string, unknown>;
  if (!isSuiId(raw.user)) {
    throw SealError.invalidPtb('certificate.user must be a Sui address');
  }
  if (!Number.isSafeInteger(raw.creation_time) || (raw.creation_time as number) < 0) {
    throw SealError.invalidPtb('certificate.creation_time must be a non-negative integer');
  }
  if (!Number.isSafeInteger(raw.ttl_min) || (raw.ttl_min as number) < 0 || (raw.ttl_min as number) > 0xffff) {
    throw SealError.invalidPtb('certificate.ttl_min must be a u16');
  }
  if (typeof raw.signature !== 'string') throw SealError.invalidPtb('certificate.signature must be base64');
  if (raw.mvr_name !== undefined && raw.mvr_name !== null && typeof raw.mvr_name !== 'string') {
    throw SealError.invalidPtb('certificate.mvr_name must be a string or null');
  }
  if (typeof raw.session_vk !== 'string') throw SealError.invalidPtb('certificate.session_vk must be base64');
  return {
    user: normalizeSuiAddress(raw.user),
    session_vk: raw.session_vk,
    creation_time: raw.creation_time as number,
    ttl_min: raw.ttl_min as number,
    signature: raw.signature,
    mvr_name: raw.mvr_name as string | null | undefined,
  };
}

export function parseFetchKeyRequest(value: unknown): ParsedFetchKeyRequest {
  if (!value || typeof value !== 'object') throw SealError.invalidPtb('Request body must be an object');
  const raw = value as Partial<FetchKeyRequest>;
  const ptbBytes = decodeBase64Field(raw.ptb, 'ptb');
  const encKeyBytes = decodeBase64Field(raw.enc_key, 'enc_key', 48);
  const encVerificationKeyBytes = decodeBase64Field(raw.enc_verification_key, 'enc_verification_key', 96);
  const requestSignatureBytes = decodeBase64Field(raw.request_signature, 'request_signature', 64);
  const certificate = parseCertificate(raw.certificate);
  const sessionPublicKeyBytes = decodeBase64Field(certificate.session_vk, 'certificate.session_vk', 32);
  try {
    validateEncryptionPublicKeys(encKeyBytes, encVerificationKeyBytes);
  } catch (error) {
    throw SealError.invalidPtb(error instanceof Error ? error.message : 'Invalid ElGamal keys');
  }
  return {
    ptbBytes,
    encKeyBytes,
    encVerificationKeyBytes,
    requestSignatureBytes,
    sessionPublicKeyBytes,
    certificate,
  };
}

export function validatePtb(bytes: Uint8Array): ValidPtb {
  let ptb: ParsedPtb;
  try {
    ptb = suiBcs.ProgrammableTransaction.parse(bytes);
  } catch (error) {
    throw SealError.invalidPtb('Invalid BCS');
  }
  if (ptb.commands.length > MAX_COMMANDS) throw SealError.invalidPtb(`Too many commands in PTB (more than ${MAX_COMMANDS})`);
  if (ptb.inputs.length === 0 || ptb.commands.length === 0) throw SealError.invalidPtb('Empty PTB input or command');
  const first = ptb.commands[0];
  if (first.$kind !== 'MoveCall') throw SealError.invalidPtb('Invalid first command');
  const packageId = normalizeSuiAddress(first.MoveCall.package);
  const innerIds: Uint8Array[] = [];

  for (const command of ptb.commands) {
    if (command.$kind !== 'MoveCall') throw SealError.invalidPtb('Non MoveCall command');
    for (const argument of command.MoveCall.arguments) {
      if (argument.$kind !== 'Input') throw SealError.invalidPtb('Only pure inputs are allowed');
    }
    const firstArgument = command.MoveCall.arguments[0];
    if (!firstArgument || firstArgument.$kind !== 'Input') throw SealError.invalidPtb('Empty args');
    const input = ptb.inputs[firstArgument.Input];
    if (!input || input.$kind !== 'Pure') {
      throw SealError.invalidPtb('Invalid first parameter for seal_approve');
    }
    try {
      innerIds.push(bcs.byteVector().parse(fromBase64(input.Pure.bytes)));
    } catch (error) {
      throw SealError.invalidPtb('Invalid BCS for first parameter for seal_approve');
    }
    if (
      !command.MoveCall.function.startsWith('seal_approve') ||
      normalizeSuiAddress(command.MoveCall.package) !== packageId
    ) {
      throw SealError.invalidPtb('Invalid function or package id');
    }
  }
  return { bytes, value: ptb, packageId, innerIds };
}

export function validateCertificateTime(certificate: Certificate, config: RuntimeConfig, now = Date.now()): void {
  const ttlMs = certificate.ttl_min * 60_000;
  const elapsed = now - certificate.creation_time;
  if (ttlMs > config.sessionKeyTtlMaxMs || elapsed < 0 || elapsed > ttlMs) {
    throw new SealError('InvalidCertificate', 'Invalid certificate time or ttl');
  }
}

function clonePtb(ptb: ParsedPtb): ParsedPtb {
  return suiBcs.ProgrammableTransaction.parse(suiBcs.ProgrammableTransaction.serialize(ptb).toBytes());
}

function addStalenessCheck(ptbValue: ParsedPtb, config: RuntimeConfig): ParsedPtb {
  const ptb = clonePtb(ptbValue);
  const nowIndex = ptb.inputs.length;
  ptb.inputs.push({ Pure: { bytes: suiBcs.u64().serialize(Date.now()).toBase64() }, $kind: 'Pure' });
  const stalenessIndex = ptb.inputs.length;
  ptb.inputs.push({
    Pure: { bytes: suiBcs.u64().serialize(config.allowedStalenessMs).toBase64() },
    $kind: 'Pure',
  });
  let clockIndex = ptb.inputs.findIndex(
    (input) =>
      input.$kind === 'Object' &&
      input.Object.$kind === 'SharedObject' &&
      normalizeSuiAddress(input.Object.SharedObject.objectId) === CLOCK_OBJECT_ID,
  );
  if (clockIndex < 0) {
    clockIndex = ptb.inputs.length;
    ptb.inputs.push({
      Object: {
        SharedObject: {
          objectId: CLOCK_OBJECT_ID,
          initialSharedVersion: String(CLOCK_INITIAL_SHARED_VERSION),
          mutable: false,
        },
        $kind: 'SharedObject',
      },
      $kind: 'Object',
    });
  }
  ptb.commands.unshift({
    MoveCall: {
      package: config.sealPackageId,
      module: STALENESS_MODULE,
      function: STALENESS_FUNCTION,
      typeArguments: [],
      arguments: [
        { Input: nowIndex, $kind: 'Input' },
        { Input: stalenessIndex, $kind: 'Input' },
        { Input: clockIndex, $kind: 'Input' },
      ],
    },
    $kind: 'MoveCall',
  });
  return ptb;
}

function unresolvedTransaction(ptbValue: ParsedPtb): Transaction {
  const kind = suiBcs.TransactionKind.serialize({ ProgrammableTransaction: ptbValue }).toBytes();
  const transaction = Transaction.fromKind(kind);
  const data = transaction.getData();
  data.inputs = data.inputs.map((input) => {
    if (input.$kind !== 'Object') return input;
    const objectId =
      input.Object.$kind === 'SharedObject'
        ? input.Object.SharedObject.objectId
        : input.Object.$kind === 'ImmOrOwnedObject'
          ? input.Object.ImmOrOwnedObject.objectId
          : input.Object.$kind === 'Receiving'
            ? input.Object.Receiving.objectId
            : undefined;
    return objectId ? { UnresolvedObject: { objectId }, $kind: 'UnresolvedObject' } : input;
  });
  return Transaction.from(JSON.stringify(data));
}

function grpcCode(error: unknown): string | number | undefined {
  return error && typeof error === 'object' ? (error as { code?: string | number }).code : undefined;
}

export async function checkPolicy(
  client: SuiGrpcClient,
  config: RuntimeConfig,
  validPtb: ValidPtb,
  sender: string,
  referenceGasPrice: bigint,
): Promise<void> {
  const transaction = unresolvedTransaction(addStalenessCheck(validPtb.value, config));
  transaction.setSender(sender);
  transaction.setGasOwner(sender);
  transaction.setGasPrice(referenceGasPrice);
  transaction.setGasBudget(MAX_COMPUTATION_UNITS * referenceGasPrice);
  transaction.setGasPayment([]);

  let result;
  try {
    result = await withRpcRetries(config, () =>
      client.simulateTransaction({ transaction, doGasSelection: false, include: { effects: true } }),
    );
  } catch (error) {
    const code = grpcCode(error);
    const message = error instanceof Error ? error.message : String(error);
    if (code === 3 || code === 5 || code === 'INVALID_ARGUMENT' || code === 'NOT_FOUND') {
      throw SealError.invalidParameter(message);
    }
    throw SealError.failure('Simulate transaction failed', error);
  }
  const simulated = result.$kind === 'Transaction' ? result.Transaction : result.FailedTransaction;
  const status = simulated.status;
  if (!status.success) {
    const error = status.error;
    if (
      error.$kind === 'MoveAbort' &&
      normalizeSuiAddress(error.MoveAbort.location?.package ?? '0x0') === config.sealPackageId &&
      error.MoveAbort.location?.module === STALENESS_MODULE
    ) {
      if (error.MoveAbort.abortCode === STALE_FULLNODE_ERROR_CODE) throw SealError.failure('Fullnode is stale');
      if (error.MoveAbort.abortCode === STALE_KEY_SERVER_ERROR_CODE) throw SealError.failure('Key server is stale');
    }
    if (/function.?not.?found/i.test(error.message)) {
      throw SealError.invalidPtb('The seal_approve function was not found on the module');
    }
    throw SealError.noAccess(error.message || error.$kind);
  }
}
