import { Hono } from "hono";
import { start } from "workflow/api";
import {
  type DiscordInteractionBody,
  discordEphemeralMessage,
  extractPromptFromInteraction,
  isDiscordCommandInteraction,
  isDiscordPingInteraction,
  verifyDiscordRequest,
} from "./discord.js";
import { handleMasterDiscordMessage } from "./message.js";

const app = new Hono();
const DEFAULT_MESSAGE = "I dont have any plans for tomorrow, what should I do";
const DISCORD_COMMAND_NAME = "friends";

async function startMasterWorkflow(message: string) {
  await start(handleMasterDiscordMessage, [message]);
}

app.post("/discord/interactions", async (c) => {
  const rawBody = await c.req.text();
  const signature = c.req.header("x-signature-ed25519");
  const timestamp = c.req.header("x-signature-timestamp");
  const publicKey = process.env.DISCORD_PUBLIC_KEY;

  if (!publicKey) {
    console.error("Missing DISCORD_PUBLIC_KEY");
    return c.text("Server configuration error", 500);
  }

  if (!signature || !timestamp) {
    return c.text("Missing signature headers", 401);
  }

  if (!verifyDiscordRequest(rawBody, signature, timestamp, publicKey)) {
    return c.text("Invalid request signature", 401);
  }

  let interactionBody: DiscordInteractionBody;
  try {
    interactionBody = JSON.parse(rawBody);
  } catch {
    return c.json(
      discordEphemeralMessage("Invalid interaction payload."),
      200,
    );
  }

  if (isDiscordPingInteraction(interactionBody)) {
    return c.json({ type: 1 });
  }

  if (!isDiscordCommandInteraction(interactionBody, DISCORD_COMMAND_NAME)) {
    return c.json(
      discordEphemeralMessage("Unsupported command. Use /friends."),
      200,
    );
  }

  const prompt = extractPromptFromInteraction(interactionBody) ?? DEFAULT_MESSAGE;
  await startMasterWorkflow(prompt);
  return c.json(
    discordEphemeralMessage(
      "Queued 4 personalities. Replies will arrive over ~30 seconds.",
    ),
    200,
  );
});

app.post("/message", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const incomingMessage =
    typeof body?.message === "string" && body.message.trim().length > 0
      ? body.message.trim()
      : DEFAULT_MESSAGE;

  await startMasterWorkflow(incomingMessage);
  return c.json({
    ok: true,
    message: "Started master workflow. Responses will arrive over ~30 seconds.",
    prompt: incomingMessage,
  });
});

app.get("/", async (c) => {
  return c.json({
    ok: true,
    message: "Discord bot is running. Use /friends in Discord to trigger workflows.",
  });
});

export default app;
