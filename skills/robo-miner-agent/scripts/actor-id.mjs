#!/usr/bin/env node

function normalizeHex(value) {
  const text = String(value || "").trim();
  const hex = text.startsWith("0x") ? text.slice(2) : text;
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error("expected a hex EVM address or ActorId");
  }
  return hex.toLowerCase();
}

function toActorId(value) {
  const hex = normalizeHex(value);
  if (hex.length === 40) {
    return `0x${"0".repeat(24)}${hex}`;
  }
  if (hex.length === 64) {
    return `0x${hex}`;
  }
  throw new Error("expected 20-byte EVM address or 32-byte ActorId");
}

function embeddedAddress(actorId) {
  const hex = normalizeHex(actorId);
  if (hex.length !== 64) return null;
  if (hex.slice(0, 24) !== "0".repeat(24)) return null;
  return `0x${hex.slice(24)}`;
}

function main() {
  const input = process.argv[2];
  if (!input || input === "-h" || input === "--help") {
    console.error("usage: actor-id.mjs <evm-address-or-actor-id>");
    process.exit(input ? 0 : 1);
  }

  const actorId = toActorId(input);
  const address = embeddedAddress(actorId);
  process.stdout.write(
    `${JSON.stringify({ input, actorId, embeddedAddress: address }, null, 2)}\n`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
