import type { Hex } from "viem";
import type { ReplyCode } from "@vara-eth/api";

type LegacyOrReceiptReply = {
  payload: Hex;
  value: bigint;
  code: ReplyCode;
  txHash?: Hex;
  replyHash?: Hex;
  signature?: Hex;
  address?: string;
};

type MaybeReceipt = {
  error: string | null;
  promise: LegacyOrReceiptReply;
  txHash?: Hex;
  replyHash?: Hex;
  signature?: Hex;
  address?: string;
  validateSignature?: () => Promise<void>;
};

type MaybeLegacyPromise = LegacyOrReceiptReply & {
  validateSignature?: () => Promise<void>;
};

export async function waitForInjectedReply(injected: {
  sendAndWaitForReceipt?: () => Promise<MaybeReceipt>;
  sendAndWaitForPromise?: () => Promise<MaybeLegacyPromise | MaybeReceipt>;
}): Promise<LegacyOrReceiptReply> {
  if (typeof injected.sendAndWaitForReceipt === "function") {
    const receipt = await injected.sendAndWaitForReceipt();
    await receipt.validateSignature?.();
    if (receipt.error) {
      throw new Error(`injected transaction was purged: ${receipt.error}`);
    }
    return {
      ...receipt.promise,
      txHash: receipt.txHash ?? receipt.promise.txHash,
      replyHash: receipt.replyHash ?? receipt.promise.replyHash,
      signature: receipt.signature ?? receipt.promise.signature,
      address: receipt.address ?? receipt.promise.address,
    };
  }

  if (typeof injected.sendAndWaitForPromise !== "function") {
    throw new Error("Injected transaction does not expose a receipt or promise waiter");
  }

  const reply = await injected.sendAndWaitForPromise();
  await reply.validateSignature?.();

  if ("error" in reply) {
    if (reply.error) {
      throw new Error(`injected transaction was purged: ${reply.error}`);
    }
    return {
      ...reply.promise,
      txHash: reply.txHash ?? reply.promise.txHash,
      replyHash: reply.replyHash ?? reply.promise.replyHash,
      signature: reply.signature ?? reply.promise.signature,
      address: reply.address ?? reply.promise.address,
    };
  }

  return reply;
}
