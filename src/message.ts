import { sleep } from "workflow";

export const PERSONALITIES = [
  {
    id: "elon",
    name: "Elon Musk",
    webhookEnv: "DISCORD_WEBHOOK_ELON",
    delay: "11s",
    style:
      "concise, first-principles, engineering-heavy, future-focused, occasionally bold claims",
  },
  {
    id: "naval",
    name: "Naval Ravikant",
    webhookEnv: "DISCORD_WEBHOOK_NAVAL",
    delay: "24s",
    style:
      "calm, reflective, leverage-focused, short aphoristic sentences with practical wisdom",
  },
  {
    id: "jobs",
    name: "Steve Jobs",
    webhookEnv: "DISCORD_WEBHOOK_JOBS",
    delay: "38s",
    style:
      "product-minded, taste-oriented, focused on simplicity, craft, and meaningful experiences",
  },
  {
    id: "mrbeast",
    name: "MrBeast",
    webhookEnv: "DISCORD_WEBHOOK_MRBEAST",
    delay: "52s",
    style:
      "high-energy, challenge-oriented, action-first, social and content-creation spin",
  },
] as const;

type PersonalityId = (typeof PERSONALITIES)[number]["id"];

const OPENROUTER_MODEL = "moonshotai/kimi-k2-thinking";

export async function handleDiscordMessage(
  incomingMessage: string,
  personalityId: PersonalityId,
) {
  "use workflow";

  const personality = getPersonality(personalityId);
  const webhookUrl = process.env[personality.webhookEnv];

  await sleep(personality.delay);
  const generated = await generateReply(incomingMessage, personality.name, personality.style);
  await sendToDiscord(webhookUrl, personality.name, incomingMessage, generated);

  return { status: "sent", personality: personality.id };
}

function getPersonality(personalityId: PersonalityId) {
  const personality = PERSONALITIES.find((p) => p.id === personalityId);
  if (!personality) {
    throw new Error(`Unknown personality: ${personalityId}`);
  }
  return personality;
}

async function generateReply(
  incomingMessage: string,
  personalityName: string,
  style: string,
) {
  "use step";

  const openRouterApiKey = process.env.OPENROUTER_API_KEY;

  if (!openRouterApiKey) {
    throw new Error("Missing OPENROUTER_API_KEY");
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${openRouterApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        {
          role: "system",
          content:
            `You are writing a short response in a style inspired by ${personalityName}. ` +
            `Do not claim to be the real person. Keep it practical and specific. Style: ${style}.`,
        },
        {
          role: "user",
          content:
            `User message: "${incomingMessage}"\n` +
            "Reply in 4-7 sentences, with concrete suggestions for tomorrow.",
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `OpenRouter request failed (${response.status}): ${text}`,
    );
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("OpenRouter returned an empty response");
  }

  return content;
}

async function sendToDiscord(
  webhookUrl: string | undefined,
  personalityName: string,
  incomingMessage: string,
  generatedReply: string,
) {
  "use step";

  if (!webhookUrl) {
    throw new Error(`Missing webhook URL for ${personalityName}`);
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      content:
        `**${personalityName} (inspired)**\n` +
        `Prompt: ${incomingMessage}\n\n` +
        generatedReply,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Discord webhook request failed (${response.status}): ${text}`,
    );
  }
}
