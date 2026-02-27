import { sleep } from "workflow";

export const PERSONALITIES = [
  {
    id: "elon",
    webhookEnv: "DISCORD_WEBHOOK_ELON",
    delay: "11s",
    systemPrompt:
      "Write like a sharp engineering founder. Focus on first principles, speed, and ambitious execution. Offer practical next steps, not motivational fluff.",
  },
  {
    id: "naval",
    webhookEnv: "DISCORD_WEBHOOK_NAVAL",
    delay: "24s",
    systemPrompt:
      "Write like a calm philosopher-operator. Prioritize leverage, clarity, and peace of mind. Keep the tone grounded and practical, with one strong mental model.",
  },
  {
    id: "jobs",
    webhookEnv: "DISCORD_WEBHOOK_JOBS",
    delay: "38s",
    systemPrompt:
      "Write like a product visionary with taste. Emphasize simplicity, focus, craftsmanship, and doing fewer things better. Be direct and decisive.",
  },
  {
    id: "mrbeast",
    webhookEnv: "DISCORD_WEBHOOK_MRBEAST",
    delay: "52s",
    systemPrompt:
      "Write like an energetic creator who loves action and momentum. Suggest fun, social, challenge-based ideas that are realistic to start tomorrow.",
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
  const replyLengthInstruction = getReplyLengthInstruction(incomingMessage);

  await sleep(personality.delay);
  const generated = await generateReply(
    incomingMessage,
    personality.systemPrompt,
    replyLengthInstruction,
  );
  await sendToDiscord(webhookUrl, generated);

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
  personalitySystemPrompt: string,
  replyLengthInstruction: string,
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
            `${personalitySystemPrompt}\n` +
            "Never claim to be the real public figure. Write as a normal Discord user, natural and conversational.\n" +
            "No labels, no headings, no 'Prompt:', no stage directions.",
        },
        {
          role: "user",
          content:
            `User message: "${incomingMessage}"\n` +
            `${replyLengthInstruction}\n` +
            "Give concrete suggestions the user can actually do tomorrow.",
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
  generatedReply: string,
) {
  "use step";

  if (!webhookUrl) {
    throw new Error("Missing webhook URL");
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      content: generatedReply,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Discord webhook request failed (${response.status}): ${text}`,
    );
  }
}

function getReplyLengthInstruction(incomingMessage: string) {
  const messageLength = incomingMessage.trim().length;
  const hasComplexCues = /(why|how|career|relationship|anxious|stuck|depressed|confused|plan|strategy|long[- ]term)/i
    .test(incomingMessage);

  if (messageLength > 180 || hasComplexCues) {
    return "Reply with 5-8 sentences or two short paragraphs.";
  }

  return "Reply with 2-4 concise sentences.";
}
