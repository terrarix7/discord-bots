const DISCORD_API_BASE = "https://discord.com/api/v10";

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

async function registerCommand() {
  const appId = requiredEnv("DISCORD_APPLICATION_ID");
  const token = requiredEnv("DISCORD_BOT_TOKEN");
  const guildId = process.env.DISCORD_GUILD_ID;

  const endpoint = guildId
    ? `${DISCORD_API_BASE}/applications/${appId}/guilds/${guildId}/commands`
    : `${DISCORD_API_BASE}/applications/${appId}/commands`;

  const body = [
    {
      name: "friends",
      description: "Get 4 persona suggestions for your plan",
      options: [
        {
          type: 3,
          name: "prompt",
          description: "Message to send into the persona workflow",
          required: false,
        },
      ],
    },
  ];

  const response = await fetch(endpoint, {
    method: "PUT",
    headers: {
      authorization: `Bot ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Command registration failed (${response.status}): ${text}`);
  }

  const scope = guildId ? `guild ${guildId}` : "global";
  console.log(`Registered /friends command in ${scope} scope.`);
}

registerCommand().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
