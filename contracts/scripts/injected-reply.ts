import type { ReplyCode } from "@vara-eth/api";
import type { Hex } from "viem";

export type InjectedPromiseReply = {
  readonly txHash: Hex;
  readonly payload: Hex;
  readonly value: bigint;
  readonly code: ReplyCode;
  readonly signature?: Hex;
  readonly replyHash?: Hex;
};

type PromiseShape = {
  readonly payload: Hex;
  readonly value: bigint;
  readonly code: ReplyCode;
};

type ReceiptShape = {
  readonly txHash?: unknown;
  readonly signature?: unknown;
  readonly error?: unknown;
  readonly promise?: PromiseShape;
  readonly replyHash?: unknown;
};

function asHex(value: unknown, label: string, field: string): Hex {
  if (typeof value === "string" && value.startsWith("0x")) {
    return value as Hex;
  }
  throw new Error(`${label} injected result is missing ${field}`);
}

function optionalHex(value: unknown): Hex | undefined {
  return typeof value === "string" && value.startsWith("0x")
    ? (value as Hex)
    : undefined;
}

export function unwrapInjectedPromise(
  result: unknown,
  label: string,
): InjectedPromiseReply | null {
  if (!result) return null;
  if (typeof result !== "object") {
    throw new Error(`${label} returned unexpected injected result`);
  }

  const record = result as ReceiptShape & Partial<PromiseShape>;
  if (record.error) {
    throw new Error(`${label} injected transaction purged: ${String(record.error)}`);
  }

  if (record.payload && record.code && typeof record.value === "bigint") {
    return {
      txHash: asHex(record.txHash, label, "txHash"),
      payload: record.payload,
      value: record.value,
      code: record.code,
      signature: optionalHex(record.signature),
      replyHash: optionalHex(record.replyHash),
    };
  }

  try {
    const promise = record.promise;
    if (promise) {
      return {
        txHash: asHex(record.txHash, label, "txHash"),
        payload: promise.payload,
        value: promise.value,
        code: promise.code,
        signature: optionalHex(record.signature),
        replyHash: optionalHex(record.replyHash),
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} injected receipt has no promise: ${message}`);
  }

  throw new Error(`${label} returned injected receipt without a promise`);
}
