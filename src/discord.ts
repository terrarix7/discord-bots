import { createPublicKey, verify } from "node:crypto";

const DISCORD_INTERACTION_PING = 1;
const DISCORD_INTERACTION_APPLICATION_COMMAND = 2;
const DISCORD_EPHEMERAL_FLAG = 64;
const ED25519_SPKI_PREFIX = "302a300506032b6570032100";

type DiscordOption = {
  name?: string;
  type?: number;
  value?: unknown;
};

type DiscordInteractionData = {
  name?: string;
  options?: DiscordOption[];
};

export type DiscordInteractionBody = {
  type?: number;
  data?: DiscordInteractionData;
};

export function verifyDiscordRequest(
  rawBody: string,
  signatureHex: string,
  timestamp: string,
  publicKeyHex: string,
): boolean {
  if (!rawBody || !signatureHex || !timestamp || !publicKeyHex) {
    return false;
  }

  try {
    const publicKeyBytes = Buffer.from(publicKeyHex, "hex");
    const signatureBytes = Buffer.from(signatureHex, "hex");
    const signedMessage = Buffer.from(`${timestamp}${rawBody}`);
    const spkiPrefix = Buffer.from(ED25519_SPKI_PREFIX, "hex");
    const publicKey = createPublicKey({
      key: Buffer.concat([spkiPrefix, publicKeyBytes]),
      format: "der",
      type: "spki",
    });

    return verify(null, signedMessage, publicKey, signatureBytes);
  } catch {
    return false;
  }
}

export function extractPromptFromInteraction(
  interactionBody: DiscordInteractionBody,
): string | undefined {
  const options = interactionBody.data?.options;
  if (!options || options.length === 0) {
    return undefined;
  }

  const promptOption = options.find((option) => option.name === "prompt");
  if (typeof promptOption?.value === "string") {
    const normalized = promptOption.value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  return undefined;
}

export function isDiscordPingInteraction(interactionBody: DiscordInteractionBody) {
  return interactionBody.type === DISCORD_INTERACTION_PING;
}

export function isDiscordCommandInteraction(
  interactionBody: DiscordInteractionBody,
  commandName: string,
) {
  return (
    interactionBody.type === DISCORD_INTERACTION_APPLICATION_COMMAND &&
    interactionBody.data?.name === commandName
  );
}

export function discordEphemeralMessage(content: string) {
  return {
    type: 4,
    data: {
      content,
      flags: DISCORD_EPHEMERAL_FLAG,
    },
  };
}
