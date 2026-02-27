## Setup

1. Copy env file:
```bash
cp .env.example .env
```

2. Install deps:
```bash
npm install
```

3. Run dev server:
```bash
npm run dev
```

## Discord Interaction Endpoint

- Endpoint URL: `POST /discord/interactions`
- Set this URL in Discord Developer Portal under **Interactions Endpoint URL**.
- Signature verification uses `DISCORD_PUBLIC_KEY`.

## Register Slash Command

Registers `/friends` with optional `prompt` option:

```bash
npm run register:discord-command
```

- If `DISCORD_GUILD_ID` is set, registers as a guild command (faster propagation).
- Otherwise, registers globally.

## Manual Trigger Endpoints

- `POST /message` with JSON body `{ "message": "..." }`
- `GET /` triggers with default prompt
