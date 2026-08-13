import { normalizeSuiAddress } from '@mysten/sui/utils';

const SUI_ID = /^(?:0x)?[0-9a-fA-F]{1,64}$/;

export function isSuiId(value: unknown): value is string {
  return typeof value === 'string' && SUI_ID.test(value);
}

export function normalizeSuiId(value: string): string {
  return normalizeSuiAddress(value);
}
