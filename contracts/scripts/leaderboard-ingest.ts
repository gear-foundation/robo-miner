import type { Hex } from "viem";

type FreshOutcomeMessage = {
  id?: string;
  decodedEvent?: {
    fields?: Record<string, unknown>;
  } | null;
};

type IngestOptions = {
  backendUrl?: string;
  programId: Hex;
  txHash?: string;
  messageId?: string;
  source?: string;
};

const WORLD_EVENTS = new Set([
  "AgentDied",
  "AgentExited",
  "AgentMoved",
  "AgentRegistered",
  "AgentSpawned",
  "AgentSurfaced",
  "LadderPlaced",
  "ResourceExtracted",
  "ResourcesMinted",
  "TileDrilled",
]);

const ADMIN_EVENTS = new Set([
  "MapGenerated",
  "ResourceVmtUpdated",
  "SessionFinished",
  "SessionStarted",
]);

export async function ingestFreshOutcomeMessages(
  freshMessages: unknown[],
  options: IngestOptions,
): Promise<{ skipped: true; reason: string } | { skipped: false; events: number; result: unknown }> {
  const backendUrl = normalizeBackendUrl(options.backendUrl ?? process.env.DIGGER_BACKEND_URL ?? process.env.BACKEND_URL);
  if (!backendUrl) return { skipped: true, reason: "DIGGER_BACKEND_URL is not set" };

  const events = freshMessages
    .map((message, index) => outcomeMessageToEvent(message as FreshOutcomeMessage, options, index))
    .filter((event): event is NonNullable<ReturnType<typeof outcomeMessageToEvent>> => Boolean(event));

  if (events.length === 0) return { skipped: true, reason: "no decoded World/Admin events" };

  const response = await fetch(`${backendUrl}/api/ingest/injected`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      txHash: options.txHash,
      messageId: options.messageId,
      events,
    }),
  });

  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`leaderboard ingest failed: ${response.status} ${JSON.stringify(result)}`);
  }

  return { skipped: false, events: events.length, result };
}

function outcomeMessageToEvent(message: FreshOutcomeMessage, options: IngestOptions, index: number) {
  const fields = message.decodedEvent?.fields;
  const eventName = typeof fields?.name === "string" ? fields.name : null;
  if (!eventName || !fields) return null;

  const service = WORLD_EVENTS.has(eventName) ? "World" : ADMIN_EVENTS.has(eventName) ? "Admin" : null;
  if (!service) return null;

  const args = service === "World" ? worldEventArgs(eventName, fields) : adminEventArgs(eventName, fields);
  if (!args) return null;

  return {
    id: [
      "injected-watch",
      options.txHash || "tx",
      options.messageId || message.id || "message",
      index,
      service,
      eventName,
    ].join(":"),
    source: options.source || "agent-step-events",
    programType: "world",
    programId: options.programId,
    service,
    event: eventName,
    args,
    txHash: options.txHash || null,
    messageId: options.messageId || message.id || null,
  };
}

function worldEventArgs(eventName: string, fields: Record<string, unknown>) {
  const base = [stringField(fields, "sessionId"), stringField(fields, "owner")];
  switch (eventName) {
    case "AgentDied":
      return [...base, numberField(fields, "x"), numberField(fields, "y"), numberField(fields, "tile")];
    case "AgentExited":
    case "AgentRegistered":
      return base;
    case "AgentMoved":
      return [...base, numberField(fields, "fromX"), numberField(fields, "fromY"), numberField(fields, "toX"), numberField(fields, "toY")];
    case "AgentSpawned":
      return [...base, numberField(fields, "x"), numberField(fields, "y")];
    case "AgentSurfaced":
      return [...base, numberField(fields, "bankedScrst"), numberField(fields, "bankedBcrst"), numberField(fields, "bankedHcrst")];
    case "LadderPlaced":
      return [...base, numberField(fields, "x"), numberField(fields, "y"), numberField(fields, "laddersRemaining")];
    case "ResourceExtracted":
      return [...base, numberField(fields, "x"), numberField(fields, "y"), resourceKind(fields), numberField(fields, "carriedTotal")];
    case "ResourcesMinted":
      return [...base, numberField(fields, "scrst"), numberField(fields, "bcrst"), numberField(fields, "hcrst")];
    case "TileDrilled":
      return [...base, numberField(fields, "x"), numberField(fields, "y"), numberField(fields, "oldTile"), numberField(fields, "newTile")];
    default:
      return null;
  }
}

function adminEventArgs(eventName: string, fields: Record<string, unknown>) {
  switch (eventName) {
    case "MapGenerated":
      return [stringField(fields, "sessionId"), stringField(fields, "seed")];
    case "ResourceVmtUpdated":
      return [stringField(fields, "previous"), stringField(fields, "next")];
    case "SessionFinished":
    case "SessionStarted":
      return [stringField(fields, "sessionId")];
    default:
      return null;
  }
}

function resourceKind(fields: Record<string, unknown>): number {
  const tile = numberField(fields, "resource");
  if (tile === 10) return 0;
  if (tile === 11) return 1;
  if (tile === 12) return 2;
  return tile;
}

function numberField(fields: Record<string, unknown>, name: string): number {
  return Number(fields[name] ?? 0);
}

function stringField(fields: Record<string, unknown>, name: string): string {
  return String(fields[name] ?? "");
}

function normalizeBackendUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}
