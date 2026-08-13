export type SealErrorCode =
  | 'InvalidPTB'
  | 'InvalidPackage'
  | 'NoAccess'
  | 'InvalidSignature'
  | 'InvalidSessionSignature'
  | 'InvalidCertificate'
  | 'InvalidSDKType'
  | 'InvalidSDKVersion'
  | 'DeprecatedSDKVersion'
  | 'MissingRequiredHeader'
  | 'InvalidParameter'
  | 'InvalidMVRName'
  | 'InvalidServiceId'
  | 'UnsupportedPackageId'
  | 'Failure';

const STATUS_BY_CODE: Record<SealErrorCode, number> = {
  InvalidPTB: 403,
  InvalidPackage: 403,
  NoAccess: 403,
  InvalidSignature: 403,
  InvalidSessionSignature: 403,
  InvalidCertificate: 403,
  InvalidSDKType: 400,
  InvalidSDKVersion: 400,
  DeprecatedSDKVersion: 426,
  MissingRequiredHeader: 400,
  InvalidParameter: 403,
  InvalidMVRName: 403,
  InvalidServiceId: 400,
  UnsupportedPackageId: 400,
  Failure: 503,
};

export class SealError extends Error {
  readonly code: SealErrorCode;
  readonly status: number;
  readonly publicMessage: string;
  readonly cause?: unknown;

  constructor(code: SealErrorCode, publicMessage: string, options?: { cause?: unknown }) {
    super(publicMessage);
    this.name = 'SealError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.publicMessage = publicMessage;
    this.cause = options?.cause;
  }

  static invalidPtb(detail: string): SealError {
    return new SealError('InvalidPTB', `Invalid PTB: ${detail}`);
  }

  static noAccess(detail: string): SealError {
    return new SealError('NoAccess', `Access denied: ${detail}`);
  }

  static invalidParameter(detail: string): SealError {
    return new SealError('InvalidParameter', `Invalid parameter to PTB: ${detail}`);
  }

  static failure(debugMessage: string, cause?: unknown): SealError {
    return new SealError('Failure', 'Internal server error, please try again later', { cause: cause ?? debugMessage });
  }

  toResponseBody(): { error: SealErrorCode; message: string } {
    return { error: this.code, message: this.publicMessage };
  }
}

export function asSealError(error: unknown): SealError {
  if (error instanceof SealError) return error;
  return SealError.failure('Unhandled error', error);
}
