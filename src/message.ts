import { sleep } from "workflow";

export const PERSONALITIES = [
  {
    id: "elon",
    webhookEnv: "DISCORD_WEBHOOK_ELON",
    personaBrief:
      "First-principles engineering founder: speed, hard constraints, aggressive but practical execution.",
  },
  {
    id: "naval",
    webhookEnv: "DISCORD_WEBHOOK_NAVAL",
    personaBrief:
      "Calm philosopher-operator: leverage, clarity, long-term compounding, peace of mind with practical action.",
  },
  {
    id: "jobs",
    webhookEnv: "DISCORD_WEBHOOK_JOBS",
    personaBrief:
      "Taste-driven product visionary: simplicity, focus, craftsmanship, and doing fewer things better.",
  },
  {
    id: "mrbeast",
    webhookEnv: "DISCORD_WEBHOOK_MRBEAST",
    personaBrief:
      "High-energy creator: action, momentum, challenge-based ideas, social and fun execution.",
  },
] as const;

type PersonalityId = (typeof PERSONALITIES)[number]["id"];

const OPENROUTER_MODEL = "openai/gpt-5.2";
const MASTER_REPLY_KEYS = ["elon", "naval", "jobs", "mrbeast"] as const;

type MasterPersonaReplies = {
  elon: string;
  naval: string;
  jobs: string;
  mrbeast: string;
};

export async function handleDiscordMessage(
  incomingMessage: string,
  personalityId: PersonalityId,
) {
  "use workflow";

  const personality = getPersonality(personalityId);
  const webhookUrl = process.env[personality.webhookEnv];
  const replyLengthInstruction = getReplyLengthInstruction(incomingMessage);

  const generated = await generateReply(
    incomingMessage,
    personality.personaBrief,
    replyLengthInstruction,
  );
  await sendToDiscord(webhookUrl, generated);

  return { status: "sent", personality: personality.id };
}

export async function handleMasterDiscordMessage(incomingMessage: string) {
  "use workflow";

  console.log("[workflow] master generation started");
  const replies = await generateMasterReplies(incomingMessage);
  console.log("[workflow] master generation completed");

  await dispatchReply("elon", replies.elon);
  await sleep("10s");
  await dispatchReply("naval", replies.naval);
  await sleep("10s");
  await dispatchReply("jobs", replies.jobs);
  await sleep("10s");
  await dispatchReply("mrbeast", replies.mrbeast);

  return { status: "sent", mode: "master" };
}

async function dispatchReply(personalityId: PersonalityId, content: string) {
  "use step";

  const personality = getPersonality(personalityId);
  const webhookUrl = process.env[personality.webhookEnv];
  if (!webhookUrl) {
    throw new Error(`Missing webhook URL for ${personalityId}`);
  }

  console.log(`[workflow] dispatching ${personalityId}`);
  await sendToDiscord(webhookUrl, content);
  console.log(`[workflow] dispatched ${personalityId}`);
}

function getPersonality(personalityId: PersonalityId) {
  const personality = PERSONALITIES.find((p) => p.id === personalityId);
  if (!personality) {
    throw new Error(`Unknown personality: ${personalityId}`);
  }
  return personality;
}

async function generateMasterReplies(
  incomingMessage: string,
): Promise<MasterPersonaReplies> {
  "use step";

  const openRouterApiKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterApiKey) {
    throw new Error("Missing OPENROUTER_API_KEY");
  }

  const replyLengthInstruction = getReplyLengthInstruction(incomingMessage);
  const personaBriefs = PERSONALITIES.map(
    (p) => `- ${p.id}: ${p.personaBrief}`,
  ).join("\n");

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
            "You are a master orchestrator that produces four distinct Discord replies.\n" +
            "Analyze the user message once, then generate one reply per persona.\n" +
            "Ensure each persona has materially different advice angle and wording; avoid overlap.\n" +
            "All replies must sound like natural Discord users.\n" +
            "No headings, no labels, no markdown code fences, no 'Prompt:' echoes.\n" +
            "Return JSON only with exactly these keys: elon, naval, jobs, mrbeast.\n\n" +
            "Persona briefs:\n" +
            `${personaBriefs}`,
        },
        {
          role: "user",
          content:
            `User message: "${incomingMessage}"\n` +
            `${replyLengthInstruction}\n` +
            "Each reply should be concrete and useful for tomorrow.",
        },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter request failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const rawContent = data.choices?.[0]?.message?.content;
  if (!rawContent) {
    throw new Error("OpenRouter returned empty master content");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    throw new Error("Master response is not valid JSON");
  }

  return validateMasterReplies(parsed);
}

function validateMasterReplies(input: unknown): MasterPersonaReplies {
  if (!input || typeof input !== "object") {
    throw new Error("Master response JSON is not an object");
  }

  const record = input as Record<string, unknown>;
  for (const key of MASTER_REPLY_KEYS) {
    const value = record[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Master response missing non-empty string for: ${key}`);
    }
  }

  return {
    elon: record.elon as string,
    naval: record.naval as string,
    jobs: record.jobs as string,
    mrbeast: record.mrbeast as string,
  };
}

async function generateReply(
  incomingMessage: string,
  personalityBrief: string,
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
            `Persona brief: ${personalityBrief}\n` +
            "Write as a normal Discord user, natural and conversational.\n" +
            "Never claim to be the real public figure.\n" +
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
    return "For each persona, reply with 4-7 sentences or two short paragraphs.";
  }

  return "For each persona, reply with 1-3 concise sentences.";
}
