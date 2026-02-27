globalThis.__nitro_main__ = import.meta.url; import { a as NodeResponse, s as serve } from './_libs/srvx.mjs';
import { d as defineHandler, H as HTTPError, t as toEventHandler, a as H3Core } from './_libs/h3.mjs';
import { H as Hono } from './_libs/hono.mjs';
import { createPublicKey, verify } from 'node:crypto';
import { s as start, r as resumeWebhook, a as registerStepFunction, c as core_star, b as stepEntrypoint, w as workflowEntrypoint } from './_chunks/_libs/@workflow/core.mjs';
import { d as decodePath, w as withLeadingSlash, a as withoutTrailingSlash, j as joinURL } from './_libs/ufo.mjs';
import { promises } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import 'node:http';
import 'node:stream';
import 'node:https';
import 'node:http2';
import './_libs/rou3.mjs';
import './_chunks/_libs/@vercel/functions.mjs';
import './_chunks/_libs/@workflow/errors.mjs';
import './_chunks/_libs/@workflow/utils.mjs';
import './_chunks/_libs/ms.mjs';
import 'node:child_process';
import 'node:fs/promises';
import 'node:util';
import './_libs/ulid.mjs';
import './_chunks/_libs/@workflow/world.mjs';
import './_libs/zod.mjs';
import './_chunks/_libs/@jridgewell/trace-mapping.mjs';
import './_chunks/_libs/@jridgewell/sourcemap-codec.mjs';
import './_chunks/_libs/@jridgewell/resolve-uri.mjs';
import 'node:vm';
import './_libs/nanoid.mjs';
import './_libs/seedrandom.mjs';
import './_chunks/_libs/@workflow/serde.mjs';
import './_chunks/_libs/debug.mjs';
import 'tty';
import 'util';
import './_chunks/_libs/supports-color.mjs';
import 'os';
import './_libs/has-flag.mjs';
import 'node:module';
import './_chunks/_libs/@workflow/world-local.mjs';
import 'node:timers/promises';
import './_chunks/_libs/@vercel/queue.mjs';
import './_libs/mixpart.mjs';
import './_chunks/_libs/@vercel/oidc.mjs';
import 'path';
import 'fs';
import './_chunks/_libs/async-sema.mjs';
import 'events';
import './_chunks/_libs/undici.mjs';
import 'node:assert';
import 'node:net';
import 'node:buffer';
import 'node:querystring';
import 'node:events';
import 'node:diagnostics_channel';
import 'node:tls';
import 'node:zlib';
import 'node:perf_hooks';
import 'node:util/types';
import 'node:worker_threads';
import 'node:async_hooks';
import 'node:console';
import 'node:dns';
import 'string_decoder';
import './_chunks/_libs/@workflow/world-vercel.mjs';
import 'node:os';
import './_libs/cbor-x.mjs';
import './_libs/devalue.mjs';

const errorHandler$1 = (error, event) => {
	const res = defaultHandler(error, event);
	return new NodeResponse(typeof res.body === "string" ? res.body : JSON.stringify(res.body, null, 2), res);
};
function defaultHandler(error, event, opts) {
	const isSensitive = error.unhandled;
	const status = error.status || 500;
	const url = event.url || new URL(event.req.url);
	if (status === 404) {
		const baseURL = "/";
		if (/^\/[^/]/.test(baseURL) && !url.pathname.startsWith(baseURL)) {
			const redirectTo = `${baseURL}${url.pathname.slice(1)}${url.search}`;
			return {
				status: 302,
				statusText: "Found",
				headers: { location: redirectTo },
				body: `Redirecting...`
			};
		}
	}
	// Console output
	if (isSensitive && !opts?.silent) {
		// prettier-ignore
		const tags = [error.unhandled && "[unhandled]"].filter(Boolean).join(" ");
		console.error(`[request error] ${tags} [${event.req.method}] ${url}\n`, error);
	}
	// Send response
	const headers = {
		"content-type": "application/json",
		"x-content-type-options": "nosniff",
		"x-frame-options": "DENY",
		"referrer-policy": "no-referrer",
		"content-security-policy": "script-src 'none'; frame-ancestors 'none';"
	};
	if (status === 404 || !event.res.headers.has("cache-control")) {
		headers["cache-control"] = "no-cache";
	}
	const body = {
		error: true,
		url: url.href,
		status,
		statusText: error.statusText,
		message: isSensitive ? "Server Error" : error.message,
		data: isSensitive ? undefined : error.data
	};
	return {
		status,
		statusText: error.statusText,
		headers,
		body
	};
}

const errorHandlers = [errorHandler$1];

async function errorHandler(error, event) {
  for (const handler of errorHandlers) {
    try {
      const response = await handler(error, event, { defaultHandler });
      if (response) {
        return response;
      }
    } catch(error) {
      // Handler itself thrown, log and continue
      console.error(error);
    }
  }
  // H3 will handle fallback
}

const DISCORD_INTERACTION_PING = 1;
const DISCORD_INTERACTION_APPLICATION_COMMAND = 2;
const DISCORD_EPHEMERAL_FLAG = 64;
const ED25519_SPKI_PREFIX = "302a300506032b6570032100";
function verifyDiscordRequest(rawBody, signatureHex, timestamp, publicKeyHex) {
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
			type: "spki"
		});
		return verify(null, signedMessage, publicKey, signatureBytes);
	} catch {
		return false;
	}
}
function extractPromptFromInteraction(interactionBody) {
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
function isDiscordPingInteraction(interactionBody) {
	return interactionBody.type === DISCORD_INTERACTION_PING;
}
function isDiscordCommandInteraction(interactionBody, commandName) {
	return interactionBody.type === DISCORD_INTERACTION_APPLICATION_COMMAND && interactionBody.data?.name === commandName;
}
function discordEphemeralMessage(content) {
	return {
		type: 4,
		data: {
			content,
			flags: DISCORD_EPHEMERAL_FLAG
		}
	};
}

const PERSONALITIES = [
	{
		id: "elon",
		name: "Elon Musk",
		webhookEnv: "DISCORD_WEBHOOK_ELON",
		delay: "11s",
		style: "concise, first-principles, engineering-heavy, future-focused, occasionally bold claims"
	},
	{
		id: "naval",
		name: "Naval Ravikant",
		webhookEnv: "DISCORD_WEBHOOK_NAVAL",
		delay: "24s",
		style: "calm, reflective, leverage-focused, short aphoristic sentences with practical wisdom"
	},
	{
		id: "jobs",
		name: "Steve Jobs",
		webhookEnv: "DISCORD_WEBHOOK_JOBS",
		delay: "38s",
		style: "product-minded, taste-oriented, focused on simplicity, craft, and meaningful experiences"
	},
	{
		id: "mrbeast",
		name: "MrBeast",
		webhookEnv: "DISCORD_WEBHOOK_MRBEAST",
		delay: "52s",
		style: "high-energy, challenge-oriented, action-first, social and content-creation spin"
	}
];
async function handleDiscordMessage$1(incomingMessage, personalityId) {
	throw new Error("You attempted to execute workflow handleDiscordMessage function directly. To start a workflow, use start(handleDiscordMessage) from workflow/api");
}
handleDiscordMessage$1.workflowId = "workflow//./src/message//handleDiscordMessage";

const app = new Hono();
const DEFAULT_MESSAGE = "I dont have any plans for tomorrow, what should I do";
const DISCORD_COMMAND_NAME = "friends";
async function startAllPersonalityWorkflows(message) {
	await Promise.all(PERSONALITIES.map((personality) => start(handleDiscordMessage$1, [message, personality.id])));
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
	let interactionBody;
	try {
		interactionBody = JSON.parse(rawBody);
	} catch {
		return c.json(discordEphemeralMessage("Invalid interaction payload."), 200);
	}
	if (isDiscordPingInteraction(interactionBody)) {
		return c.json({ type: 1 });
	}
	if (!isDiscordCommandInteraction(interactionBody, DISCORD_COMMAND_NAME)) {
		return c.json(discordEphemeralMessage("Unsupported command. Use /friends."), 200);
	}
	const prompt = extractPromptFromInteraction(interactionBody) ?? DEFAULT_MESSAGE;
	await startAllPersonalityWorkflows(prompt);
	return c.json(discordEphemeralMessage("Queued 4 personalities. Replies will arrive in about 1 minute."), 200);
});
app.post("/message", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const incomingMessage = typeof body?.message === "string" && body.message.trim().length > 0 ? body.message.trim() : DEFAULT_MESSAGE;
	await startAllPersonalityWorkflows(incomingMessage);
	return c.json({
		ok: true,
		message: "Started 4 personality workflows. Responses will arrive within ~1 minute.",
		prompt: incomingMessage
	});
});
app.get("/", async (c) => {
	return c.json({
		ok: true,
		message: "Discord bot is running. Use /friends in Discord to trigger workflows."
	});
});

async function handler(request) {
  const url = new URL(request.url);
  // Extract token from pathname: /.well-known/workflow/v1/webhook/{token}
  const pathParts = url.pathname.split('/');
  const token = decodeURIComponent(pathParts[pathParts.length - 1]);

  if (!token) {
    return new Response('Missing token', { status: 400 });
  }

  try {
    const response = await resumeWebhook(token, request);
    return response;
  } catch (error) {
    // TODO: differentiate between invalid token and other errors
    console.error('Error during resumeWebhook', error);
    return new Response(null, { status: 404 });
  }
}
const POST$1 = handler;

const _n9RDGO = async ({ req }) => {
	try {
		return await POST$1(req);
	} catch (error) {
		console.error("Handler error:", error);
		return new Response("Internal Server Error", { status: 500 });
	}
};

// biome-ignore-all lint: generated file
/* eslint-disable */

var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __reExport = (target, mod, secondTarget) => (__copyProps(target, mod, "default"), secondTarget);
async function __builtin_response_array_buffer(res) {
  return res.arrayBuffer();
}
__name(__builtin_response_array_buffer, "__builtin_response_array_buffer");
async function __builtin_response_json(res) {
  return res.json();
}
__name(__builtin_response_json, "__builtin_response_json");
async function __builtin_response_text(res) {
  return res.text();
}
__name(__builtin_response_text, "__builtin_response_text");
registerStepFunction("__builtin_response_array_buffer", __builtin_response_array_buffer);
registerStepFunction("__builtin_response_json", __builtin_response_json);
registerStepFunction("__builtin_response_text", __builtin_response_text);
async function fetch2(...args) {
  return globalThis.fetch(...args);
}
__name(fetch2, "fetch");
registerStepFunction("step//workflow@4.1.0-beta.60//fetch", fetch2);

// node_modules/workflow/dist/index.js
var dist_exports = {};
__export(dist_exports, {
  fetch: () => fetch2
});
__reExport(dist_exports, core_star);

// src/message.ts
var OPENROUTER_MODEL = "moonshotai/kimi-k2-thinking";
async function handleDiscordMessage(incomingMessage, personalityId) {
  throw new Error("You attempted to execute workflow handleDiscordMessage function directly. To start a workflow, use start(handleDiscordMessage) from workflow/api");
}
__name(handleDiscordMessage, "handleDiscordMessage");
handleDiscordMessage.workflowId = "workflow//./src/message//handleDiscordMessage";
async function generateReply(incomingMessage, personalityName, style) {
  const openRouterApiKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterApiKey) {
    throw new Error("Missing OPENROUTER_API_KEY");
  }
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${openRouterApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        {
          role: "system",
          content: `You are writing a short response in a style inspired by ${personalityName}. Do not claim to be the real person. Keep it practical and specific. Style: ${style}.`
        },
        {
          role: "user",
          content: `User message: "${incomingMessage}"
Reply in 4-7 sentences, with concrete suggestions for tomorrow.`
        }
      ]
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter request failed (${response.status}): ${text}`);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("OpenRouter returned an empty response");
  }
  return content;
}
__name(generateReply, "generateReply");
async function sendToDiscord(webhookUrl, personalityName, incomingMessage, generatedReply) {
  if (!webhookUrl) {
    throw new Error(`Missing webhook URL for ${personalityName}`);
  }
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      content: `**${personalityName} (inspired)**
Prompt: ${incomingMessage}

` + generatedReply
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord webhook request failed (${response.status}): ${text}`);
  }
}
__name(sendToDiscord, "sendToDiscord");
registerStepFunction("step//./src/message//generateReply", generateReply);
registerStepFunction("step//./src/message//sendToDiscord", sendToDiscord);

const _g3m8Xw = async ({ req }) => {
	try {
		return await stepEntrypoint(req);
	} catch (error) {
		console.error("Handler error:", error);
		return new Response("Internal Server Error", { status: 500 });
	}
};

// biome-ignore-all lint: generated file
/* eslint-disable */

const workflowCode = `globalThis.__private_workflows = new Map();
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/ms/index.js
var require_ms = __commonJS({
  "node_modules/ms/index.js"(exports, module2) {
    var s = 1e3;
    var m = s * 60;
    var h = m * 60;
    var d = h * 24;
    var w = d * 7;
    var y = d * 365.25;
    module2.exports = function(val, options) {
      options = options || {};
      var type = typeof val;
      if (type === "string" && val.length > 0) {
        return parse(val);
      } else if (type === "number" && isFinite(val)) {
        return options.long ? fmtLong(val) : fmtShort(val);
      }
      throw new Error("val is not a non-empty string or a valid number. val=" + JSON.stringify(val));
    };
    function parse(str) {
      str = String(str);
      if (str.length > 100) {
        return;
      }
      var match = /^(-?(?:\\d+)?\\.?\\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?\$/i.exec(str);
      if (!match) {
        return;
      }
      var n = parseFloat(match[1]);
      var type = (match[2] || "ms").toLowerCase();
      switch (type) {
        case "years":
        case "year":
        case "yrs":
        case "yr":
        case "y":
          return n * y;
        case "weeks":
        case "week":
        case "w":
          return n * w;
        case "days":
        case "day":
        case "d":
          return n * d;
        case "hours":
        case "hour":
        case "hrs":
        case "hr":
        case "h":
          return n * h;
        case "minutes":
        case "minute":
        case "mins":
        case "min":
        case "m":
          return n * m;
        case "seconds":
        case "second":
        case "secs":
        case "sec":
        case "s":
          return n * s;
        case "milliseconds":
        case "millisecond":
        case "msecs":
        case "msec":
        case "ms":
          return n;
        default:
          return void 0;
      }
    }
    __name(parse, "parse");
    function fmtShort(ms2) {
      var msAbs = Math.abs(ms2);
      if (msAbs >= d) {
        return Math.round(ms2 / d) + "d";
      }
      if (msAbs >= h) {
        return Math.round(ms2 / h) + "h";
      }
      if (msAbs >= m) {
        return Math.round(ms2 / m) + "m";
      }
      if (msAbs >= s) {
        return Math.round(ms2 / s) + "s";
      }
      return ms2 + "ms";
    }
    __name(fmtShort, "fmtShort");
    function fmtLong(ms2) {
      var msAbs = Math.abs(ms2);
      if (msAbs >= d) {
        return plural(ms2, msAbs, d, "day");
      }
      if (msAbs >= h) {
        return plural(ms2, msAbs, h, "hour");
      }
      if (msAbs >= m) {
        return plural(ms2, msAbs, m, "minute");
      }
      if (msAbs >= s) {
        return plural(ms2, msAbs, s, "second");
      }
      return ms2 + " ms";
    }
    __name(fmtLong, "fmtLong");
    function plural(ms2, msAbs, n, name) {
      var isPlural = msAbs >= n * 1.5;
      return Math.round(ms2 / n) + " " + name + (isPlural ? "s" : "");
    }
    __name(plural, "plural");
  }
});

// node_modules/@workflow/utils/dist/time.js
var import_ms = __toESM(require_ms(), 1);

// node_modules/@workflow/core/dist/symbols.js
var WORKFLOW_USE_STEP = Symbol.for("WORKFLOW_USE_STEP");
var WORKFLOW_CREATE_HOOK = Symbol.for("WORKFLOW_CREATE_HOOK");
var WORKFLOW_SLEEP = Symbol.for("WORKFLOW_SLEEP");
var WORKFLOW_CONTEXT = Symbol.for("WORKFLOW_CONTEXT");
var WORKFLOW_GET_STREAM_ID = Symbol.for("WORKFLOW_GET_STREAM_ID");
var STABLE_ULID = Symbol.for("WORKFLOW_STABLE_ULID");
var STREAM_NAME_SYMBOL = Symbol.for("WORKFLOW_STREAM_NAME");
var STREAM_TYPE_SYMBOL = Symbol.for("WORKFLOW_STREAM_TYPE");
var BODY_INIT_SYMBOL = Symbol.for("BODY_INIT");
var WEBHOOK_RESPONSE_WRITABLE = Symbol.for("WEBHOOK_RESPONSE_WRITABLE");
var WORKFLOW_CLASS_REGISTRY = Symbol.for("workflow-class-registry");

// node_modules/@workflow/core/dist/sleep.js
async function sleep(param) {
  const sleepFn = globalThis[WORKFLOW_SLEEP];
  if (!sleepFn) {
    throw new Error("\`sleep()\` can only be called inside a workflow function");
  }
  return sleepFn(param);
}
__name(sleep, "sleep");

// node_modules/workflow/dist/stdlib.js
var fetch = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//workflow@4.1.0-beta.60//fetch");

// src/message.ts
var PERSONALITIES = [
  {
    id: "elon",
    name: "Elon Musk",
    webhookEnv: "DISCORD_WEBHOOK_ELON",
    delay: "11s",
    style: "concise, first-principles, engineering-heavy, future-focused, occasionally bold claims"
  },
  {
    id: "naval",
    name: "Naval Ravikant",
    webhookEnv: "DISCORD_WEBHOOK_NAVAL",
    delay: "24s",
    style: "calm, reflective, leverage-focused, short aphoristic sentences with practical wisdom"
  },
  {
    id: "jobs",
    name: "Steve Jobs",
    webhookEnv: "DISCORD_WEBHOOK_JOBS",
    delay: "38s",
    style: "product-minded, taste-oriented, focused on simplicity, craft, and meaningful experiences"
  },
  {
    id: "mrbeast",
    name: "MrBeast",
    webhookEnv: "DISCORD_WEBHOOK_MRBEAST",
    delay: "52s",
    style: "high-energy, challenge-oriented, action-first, social and content-creation spin"
  }
];
async function handleDiscordMessage(incomingMessage, personalityId) {
  const personality = getPersonality(personalityId);
  const webhookUrl = process.env[personality.webhookEnv];
  await sleep(personality.delay);
  const generated = await generateReply(incomingMessage, personality.name, personality.style);
  await sendToDiscord(webhookUrl, personality.name, incomingMessage, generated);
  return {
    status: "sent",
    personality: personality.id
  };
}
__name(handleDiscordMessage, "handleDiscordMessage");
handleDiscordMessage.workflowId = "workflow//./src/message//handleDiscordMessage";
globalThis.__private_workflows.set("workflow//./src/message//handleDiscordMessage", handleDiscordMessage);
function getPersonality(personalityId) {
  const personality = PERSONALITIES.find((p) => p.id === personalityId);
  if (!personality) {
    throw new Error(\`Unknown personality: \${personalityId}\`);
  }
  return personality;
}
__name(getPersonality, "getPersonality");
var generateReply = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./src/message//generateReply");
var sendToDiscord = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//./src/message//sendToDiscord");
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsibm9kZV9tb2R1bGVzL21zL2luZGV4LmpzIiwgIm5vZGVfbW9kdWxlcy9Ad29ya2Zsb3cvdXRpbHMvc3JjL3RpbWUudHMiLCAibm9kZV9tb2R1bGVzL0B3b3JrZmxvdy9jb3JlL3NyYy9zeW1ib2xzLnRzIiwgIm5vZGVfbW9kdWxlcy9Ad29ya2Zsb3cvY29yZS9zcmMvc2xlZXAudHMiLCAibm9kZV9tb2R1bGVzL3dvcmtmbG93L3NyYy9zdGRsaWIudHMiLCAic3JjL21lc3NhZ2UudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogSGVscGVycy5cbiAqLyB2YXIgcyA9IDEwMDA7XG52YXIgbSA9IHMgKiA2MDtcbnZhciBoID0gbSAqIDYwO1xudmFyIGQgPSBoICogMjQ7XG52YXIgdyA9IGQgKiA3O1xudmFyIHkgPSBkICogMzY1LjI1O1xuLyoqXG4gKiBQYXJzZSBvciBmb3JtYXQgdGhlIGdpdmVuIGB2YWxgLlxuICpcbiAqIE9wdGlvbnM6XG4gKlxuICogIC0gYGxvbmdgIHZlcmJvc2UgZm9ybWF0dGluZyBbZmFsc2VdXG4gKlxuICogQHBhcmFtIHtTdHJpbmd8TnVtYmVyfSB2YWxcbiAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9uc11cbiAqIEB0aHJvd3Mge0Vycm9yfSB0aHJvdyBhbiBlcnJvciBpZiB2YWwgaXMgbm90IGEgbm9uLWVtcHR5IHN0cmluZyBvciBhIG51bWJlclxuICogQHJldHVybiB7U3RyaW5nfE51bWJlcn1cbiAqIEBhcGkgcHVibGljXG4gKi8gbW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbih2YWwsIG9wdGlvbnMpIHtcbiAgICBvcHRpb25zID0gb3B0aW9ucyB8fCB7fTtcbiAgICB2YXIgdHlwZSA9IHR5cGVvZiB2YWw7XG4gICAgaWYgKHR5cGUgPT09ICdzdHJpbmcnICYmIHZhbC5sZW5ndGggPiAwKSB7XG4gICAgICAgIHJldHVybiBwYXJzZSh2YWwpO1xuICAgIH0gZWxzZSBpZiAodHlwZSA9PT0gJ251bWJlcicgJiYgaXNGaW5pdGUodmFsKSkge1xuICAgICAgICByZXR1cm4gb3B0aW9ucy5sb25nID8gZm10TG9uZyh2YWwpIDogZm10U2hvcnQodmFsKTtcbiAgICB9XG4gICAgdGhyb3cgbmV3IEVycm9yKCd2YWwgaXMgbm90IGEgbm9uLWVtcHR5IHN0cmluZyBvciBhIHZhbGlkIG51bWJlci4gdmFsPScgKyBKU09OLnN0cmluZ2lmeSh2YWwpKTtcbn07XG4vKipcbiAqIFBhcnNlIHRoZSBnaXZlbiBgc3RyYCBhbmQgcmV0dXJuIG1pbGxpc2Vjb25kcy5cbiAqXG4gKiBAcGFyYW0ge1N0cmluZ30gc3RyXG4gKiBAcmV0dXJuIHtOdW1iZXJ9XG4gKiBAYXBpIHByaXZhdGVcbiAqLyBmdW5jdGlvbiBwYXJzZShzdHIpIHtcbiAgICBzdHIgPSBTdHJpbmcoc3RyKTtcbiAgICBpZiAoc3RyLmxlbmd0aCA+IDEwMCkge1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIHZhciBtYXRjaCA9IC9eKC0/KD86XFxkKyk/XFwuP1xcZCspICoobWlsbGlzZWNvbmRzP3xtc2Vjcz98bXN8c2Vjb25kcz98c2Vjcz98c3xtaW51dGVzP3xtaW5zP3xtfGhvdXJzP3xocnM/fGh8ZGF5cz98ZHx3ZWVrcz98d3x5ZWFycz98eXJzP3x5KT8kL2kuZXhlYyhzdHIpO1xuICAgIGlmICghbWF0Y2gpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB2YXIgbiA9IHBhcnNlRmxvYXQobWF0Y2hbMV0pO1xuICAgIHZhciB0eXBlID0gKG1hdGNoWzJdIHx8ICdtcycpLnRvTG93ZXJDYXNlKCk7XG4gICAgc3dpdGNoKHR5cGUpe1xuICAgICAgICBjYXNlICd5ZWFycyc6XG4gICAgICAgIGNhc2UgJ3llYXInOlxuICAgICAgICBjYXNlICd5cnMnOlxuICAgICAgICBjYXNlICd5cic6XG4gICAgICAgIGNhc2UgJ3knOlxuICAgICAgICAgICAgcmV0dXJuIG4gKiB5O1xuICAgICAgICBjYXNlICd3ZWVrcyc6XG4gICAgICAgIGNhc2UgJ3dlZWsnOlxuICAgICAgICBjYXNlICd3JzpcbiAgICAgICAgICAgIHJldHVybiBuICogdztcbiAgICAgICAgY2FzZSAnZGF5cyc6XG4gICAgICAgIGNhc2UgJ2RheSc6XG4gICAgICAgIGNhc2UgJ2QnOlxuICAgICAgICAgICAgcmV0dXJuIG4gKiBkO1xuICAgICAgICBjYXNlICdob3Vycyc6XG4gICAgICAgIGNhc2UgJ2hvdXInOlxuICAgICAgICBjYXNlICdocnMnOlxuICAgICAgICBjYXNlICdocic6XG4gICAgICAgIGNhc2UgJ2gnOlxuICAgICAgICAgICAgcmV0dXJuIG4gKiBoO1xuICAgICAgICBjYXNlICdtaW51dGVzJzpcbiAgICAgICAgY2FzZSAnbWludXRlJzpcbiAgICAgICAgY2FzZSAnbWlucyc6XG4gICAgICAgIGNhc2UgJ21pbic6XG4gICAgICAgIGNhc2UgJ20nOlxuICAgICAgICAgICAgcmV0dXJuIG4gKiBtO1xuICAgICAgICBjYXNlICdzZWNvbmRzJzpcbiAgICAgICAgY2FzZSAnc2Vjb25kJzpcbiAgICAgICAgY2FzZSAnc2Vjcyc6XG4gICAgICAgIGNhc2UgJ3NlYyc6XG4gICAgICAgIGNhc2UgJ3MnOlxuICAgICAgICAgICAgcmV0dXJuIG4gKiBzO1xuICAgICAgICBjYXNlICdtaWxsaXNlY29uZHMnOlxuICAgICAgICBjYXNlICdtaWxsaXNlY29uZCc6XG4gICAgICAgIGNhc2UgJ21zZWNzJzpcbiAgICAgICAgY2FzZSAnbXNlYyc6XG4gICAgICAgIGNhc2UgJ21zJzpcbiAgICAgICAgICAgIHJldHVybiBuO1xuICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB9XG59XG4vKipcbiAqIFNob3J0IGZvcm1hdCBmb3IgYG1zYC5cbiAqXG4gKiBAcGFyYW0ge051bWJlcn0gbXNcbiAqIEByZXR1cm4ge1N0cmluZ31cbiAqIEBhcGkgcHJpdmF0ZVxuICovIGZ1bmN0aW9uIGZtdFNob3J0KG1zKSB7XG4gICAgdmFyIG1zQWJzID0gTWF0aC5hYnMobXMpO1xuICAgIGlmIChtc0FicyA+PSBkKSB7XG4gICAgICAgIHJldHVybiBNYXRoLnJvdW5kKG1zIC8gZCkgKyAnZCc7XG4gICAgfVxuICAgIGlmIChtc0FicyA+PSBoKSB7XG4gICAgICAgIHJldHVybiBNYXRoLnJvdW5kKG1zIC8gaCkgKyAnaCc7XG4gICAgfVxuICAgIGlmIChtc0FicyA+PSBtKSB7XG4gICAgICAgIHJldHVybiBNYXRoLnJvdW5kKG1zIC8gbSkgKyAnbSc7XG4gICAgfVxuICAgIGlmIChtc0FicyA+PSBzKSB7XG4gICAgICAgIHJldHVybiBNYXRoLnJvdW5kKG1zIC8gcykgKyAncyc7XG4gICAgfVxuICAgIHJldHVybiBtcyArICdtcyc7XG59XG4vKipcbiAqIExvbmcgZm9ybWF0IGZvciBgbXNgLlxuICpcbiAqIEBwYXJhbSB7TnVtYmVyfSBtc1xuICogQHJldHVybiB7U3RyaW5nfVxuICogQGFwaSBwcml2YXRlXG4gKi8gZnVuY3Rpb24gZm10TG9uZyhtcykge1xuICAgIHZhciBtc0FicyA9IE1hdGguYWJzKG1zKTtcbiAgICBpZiAobXNBYnMgPj0gZCkge1xuICAgICAgICByZXR1cm4gcGx1cmFsKG1zLCBtc0FicywgZCwgJ2RheScpO1xuICAgIH1cbiAgICBpZiAobXNBYnMgPj0gaCkge1xuICAgICAgICByZXR1cm4gcGx1cmFsKG1zLCBtc0FicywgaCwgJ2hvdXInKTtcbiAgICB9XG4gICAgaWYgKG1zQWJzID49IG0pIHtcbiAgICAgICAgcmV0dXJuIHBsdXJhbChtcywgbXNBYnMsIG0sICdtaW51dGUnKTtcbiAgICB9XG4gICAgaWYgKG1zQWJzID49IHMpIHtcbiAgICAgICAgcmV0dXJuIHBsdXJhbChtcywgbXNBYnMsIHMsICdzZWNvbmQnKTtcbiAgICB9XG4gICAgcmV0dXJuIG1zICsgJyBtcyc7XG59XG4vKipcbiAqIFBsdXJhbGl6YXRpb24gaGVscGVyLlxuICovIGZ1bmN0aW9uIHBsdXJhbChtcywgbXNBYnMsIG4sIG5hbWUpIHtcbiAgICB2YXIgaXNQbHVyYWwgPSBtc0FicyA+PSBuICogMS41O1xuICAgIHJldHVybiBNYXRoLnJvdW5kKG1zIC8gbikgKyAnICcgKyBuYW1lICsgKGlzUGx1cmFsID8gJ3MnIDogJycpO1xufVxuIiwgbnVsbCwgbnVsbCwgbnVsbCwgbnVsbCwgImltcG9ydCB7IHNsZWVwIH0gZnJvbSBcIndvcmtmbG93XCI7XG4vKipfX2ludGVybmFsX3dvcmtmbG93c3tcIndvcmtmbG93c1wiOntcInNyYy9tZXNzYWdlLnRzXCI6e1wiaGFuZGxlRGlzY29yZE1lc3NhZ2VcIjp7XCJ3b3JrZmxvd0lkXCI6XCJ3b3JrZmxvdy8vLi9zcmMvbWVzc2FnZS8vaGFuZGxlRGlzY29yZE1lc3NhZ2VcIn19fSxcInN0ZXBzXCI6e1wic3JjL21lc3NhZ2UudHNcIjp7XCJnZW5lcmF0ZVJlcGx5XCI6e1wic3RlcElkXCI6XCJzdGVwLy8uL3NyYy9tZXNzYWdlLy9nZW5lcmF0ZVJlcGx5XCJ9LFwic2VuZFRvRGlzY29yZFwiOntcInN0ZXBJZFwiOlwic3RlcC8vLi9zcmMvbWVzc2FnZS8vc2VuZFRvRGlzY29yZFwifX19fSovO1xuZXhwb3J0IGNvbnN0IFBFUlNPTkFMSVRJRVMgPSBbXG4gICAge1xuICAgICAgICBpZDogXCJlbG9uXCIsXG4gICAgICAgIG5hbWU6IFwiRWxvbiBNdXNrXCIsXG4gICAgICAgIHdlYmhvb2tFbnY6IFwiRElTQ09SRF9XRUJIT09LX0VMT05cIixcbiAgICAgICAgZGVsYXk6IFwiMTFzXCIsXG4gICAgICAgIHN0eWxlOiBcImNvbmNpc2UsIGZpcnN0LXByaW5jaXBsZXMsIGVuZ2luZWVyaW5nLWhlYXZ5LCBmdXR1cmUtZm9jdXNlZCwgb2NjYXNpb25hbGx5IGJvbGQgY2xhaW1zXCJcbiAgICB9LFxuICAgIHtcbiAgICAgICAgaWQ6IFwibmF2YWxcIixcbiAgICAgICAgbmFtZTogXCJOYXZhbCBSYXZpa2FudFwiLFxuICAgICAgICB3ZWJob29rRW52OiBcIkRJU0NPUkRfV0VCSE9PS19OQVZBTFwiLFxuICAgICAgICBkZWxheTogXCIyNHNcIixcbiAgICAgICAgc3R5bGU6IFwiY2FsbSwgcmVmbGVjdGl2ZSwgbGV2ZXJhZ2UtZm9jdXNlZCwgc2hvcnQgYXBob3Jpc3RpYyBzZW50ZW5jZXMgd2l0aCBwcmFjdGljYWwgd2lzZG9tXCJcbiAgICB9LFxuICAgIHtcbiAgICAgICAgaWQ6IFwiam9ic1wiLFxuICAgICAgICBuYW1lOiBcIlN0ZXZlIEpvYnNcIixcbiAgICAgICAgd2ViaG9va0VudjogXCJESVNDT1JEX1dFQkhPT0tfSk9CU1wiLFxuICAgICAgICBkZWxheTogXCIzOHNcIixcbiAgICAgICAgc3R5bGU6IFwicHJvZHVjdC1taW5kZWQsIHRhc3RlLW9yaWVudGVkLCBmb2N1c2VkIG9uIHNpbXBsaWNpdHksIGNyYWZ0LCBhbmQgbWVhbmluZ2Z1bCBleHBlcmllbmNlc1wiXG4gICAgfSxcbiAgICB7XG4gICAgICAgIGlkOiBcIm1yYmVhc3RcIixcbiAgICAgICAgbmFtZTogXCJNckJlYXN0XCIsXG4gICAgICAgIHdlYmhvb2tFbnY6IFwiRElTQ09SRF9XRUJIT09LX01SQkVBU1RcIixcbiAgICAgICAgZGVsYXk6IFwiNTJzXCIsXG4gICAgICAgIHN0eWxlOiBcImhpZ2gtZW5lcmd5LCBjaGFsbGVuZ2Utb3JpZW50ZWQsIGFjdGlvbi1maXJzdCwgc29jaWFsIGFuZCBjb250ZW50LWNyZWF0aW9uIHNwaW5cIlxuICAgIH1cbl07XG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gaGFuZGxlRGlzY29yZE1lc3NhZ2UoaW5jb21pbmdNZXNzYWdlLCBwZXJzb25hbGl0eUlkKSB7XG4gICAgY29uc3QgcGVyc29uYWxpdHkgPSBnZXRQZXJzb25hbGl0eShwZXJzb25hbGl0eUlkKTtcbiAgICBjb25zdCB3ZWJob29rVXJsID0gcHJvY2Vzcy5lbnZbcGVyc29uYWxpdHkud2ViaG9va0Vudl07XG4gICAgYXdhaXQgc2xlZXAocGVyc29uYWxpdHkuZGVsYXkpO1xuICAgIGNvbnN0IGdlbmVyYXRlZCA9IGF3YWl0IGdlbmVyYXRlUmVwbHkoaW5jb21pbmdNZXNzYWdlLCBwZXJzb25hbGl0eS5uYW1lLCBwZXJzb25hbGl0eS5zdHlsZSk7XG4gICAgYXdhaXQgc2VuZFRvRGlzY29yZCh3ZWJob29rVXJsLCBwZXJzb25hbGl0eS5uYW1lLCBpbmNvbWluZ01lc3NhZ2UsIGdlbmVyYXRlZCk7XG4gICAgcmV0dXJuIHtcbiAgICAgICAgc3RhdHVzOiBcInNlbnRcIixcbiAgICAgICAgcGVyc29uYWxpdHk6IHBlcnNvbmFsaXR5LmlkXG4gICAgfTtcbn1cbmhhbmRsZURpc2NvcmRNZXNzYWdlLndvcmtmbG93SWQgPSBcIndvcmtmbG93Ly8uL3NyYy9tZXNzYWdlLy9oYW5kbGVEaXNjb3JkTWVzc2FnZVwiO1xuZ2xvYmFsVGhpcy5fX3ByaXZhdGVfd29ya2Zsb3dzLnNldChcIndvcmtmbG93Ly8uL3NyYy9tZXNzYWdlLy9oYW5kbGVEaXNjb3JkTWVzc2FnZVwiLCBoYW5kbGVEaXNjb3JkTWVzc2FnZSk7XG5mdW5jdGlvbiBnZXRQZXJzb25hbGl0eShwZXJzb25hbGl0eUlkKSB7XG4gICAgY29uc3QgcGVyc29uYWxpdHkgPSBQRVJTT05BTElUSUVTLmZpbmQoKHApPT5wLmlkID09PSBwZXJzb25hbGl0eUlkKTtcbiAgICBpZiAoIXBlcnNvbmFsaXR5KSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihgVW5rbm93biBwZXJzb25hbGl0eTogJHtwZXJzb25hbGl0eUlkfWApO1xuICAgIH1cbiAgICByZXR1cm4gcGVyc29uYWxpdHk7XG59XG52YXIgZ2VuZXJhdGVSZXBseSA9IGdsb2JhbFRoaXNbU3ltYm9sLmZvcihcIldPUktGTE9XX1VTRV9TVEVQXCIpXShcInN0ZXAvLy4vc3JjL21lc3NhZ2UvL2dlbmVyYXRlUmVwbHlcIik7XG52YXIgc2VuZFRvRGlzY29yZCA9IGdsb2JhbFRoaXNbU3ltYm9sLmZvcihcIldPUktGTE9XX1VTRV9TVEVQXCIpXShcInN0ZXAvLy4vc3JjL21lc3NhZ2UvL3NlbmRUb0Rpc2NvcmRcIik7XG4iXSwKICAibWFwcGlu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QUs7QUFDdEI7QUFQc0I7OztBQ3pCbkIsSUFBQSxRQUFBLFdBQUEsT0FBQSxJQUFBLG1CQUFBLENBQUEsRUFBQSxxQ0FBQTs7O0FDVkksSUFBTSxnQkFBZ0I7QUFBQSxFQUN6QjtBQUFBLElBQ0ksSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sWUFBWTtBQUFBLElBQ1osT0FBTztBQUFBLElBQ1AsT0FBTztBQUFBLEVBQ1g7QUFBQSxFQUNBO0FBQUEsSUFDSSxJQUFJO0FBQUEsSUFDSixNQUFNO0FBQUEsSUFDTixZQUFZO0FBQUEsSUFDWixPQUFPO0FBQUEsSUFDUCxPQUFPO0FBQUEsRUFDWDtBQUFBLEVBQ0E7QUFBQSxJQUNJLElBQUk7QUFBQSxJQUNKLE1BQU07QUFBQSxJQUNOLFlBQVk7QUFBQSxJQUNaLE9BQU87QUFBQSxJQUNQLE9BQU87QUFBQSxFQUNYO0FBQUEsRUFDQTtBQUFBLElBQ0ksSUFBSTtBQUFBLElBQ0osTUFBTTtBQUFBLElBQ04sWUFBWTtBQUFBLElBQ1osT0FBTztBQUFBLElBQ1AsT0FBTztBQUFBLEVBQ1g7QUFDSjtBQUNBLGVBQXNCLHFCQUFxQixpQkFBaUIsZUFBZTtBQUN2RSxRQUFNLGNBQWMsZUFBZSxhQUFhO0FBQ2hELFFBQU0sYUFBYSxRQUFRLElBQUksWUFBWSxVQUFVO0FBQ3JELFFBQU0sTUFBTSxZQUFZLEtBQUs7QUFDN0IsUUFBTSxZQUFZLE1BQU0sY0FBYyxpQkFBaUIsWUFBWSxNQUFNLFlBQVksS0FBSztBQUMxRixRQUFNLGNBQWMsWUFBWSxZQUFZLE1BQU0saUJBQWlCLFNBQVM7QUFDNUUsU0FBTztBQUFBLElBQ0gsUUFBUTtBQUFBLElBQ1IsYUFBYSxZQUFZO0FBQUEsRUFDN0I7QUFDSjtBQVZzQjtBQVd0QixxQkFBcUIsYUFBYTtBQUNsQyxXQUFXLG9CQUFvQixJQUFJLGlEQUFpRCxvQkFBb0I7QUFDeEcsU0FBUyxlQUFlLGVBQWU7QUFDbkMsUUFBTSxjQUFjLGNBQWMsS0FBSyxDQUFDLE1BQUksRUFBRSxPQUFPLGFBQWE7QUFDbEUsTUFBSSxDQUFDLGFBQWE7QUFDZCxVQUFNLElBQUksTUFBTSx3QkFBd0IsYUFBYSxFQUFFO0FBQUEsRUFDM0Q7QUFDQSxTQUFPO0FBQ1g7QUFOUztBQU9ULElBQUksZ0JBQWdCLFdBQVcsT0FBTyxJQUFJLG1CQUFtQixDQUFDLEVBQUUsb0NBQW9DO0FBQ3BHLElBQUksZ0JBQWdCLFdBQVcsT0FBTyxJQUFJLG1CQUFtQixDQUFDLEVBQUUsb0NBQW9DOyIsCiAgIm5hbWVzIjogWyJtb2R1bGUiLCAibXMiXQp9Cg==
`;

const POST = workflowEntrypoint(workflowCode);

const _psdlYg = async ({ req }) => {
	try {
		return await POST(req);
	} catch (error) {
		console.error("Handler error:", error);
		return new Response("Internal Server Error", { status: 500 });
	}
};

const assets = {};

function readAsset (id) {
  const serverDir = dirname(fileURLToPath(globalThis.__nitro_main__));
  return promises.readFile(resolve(serverDir, assets[id].path))
}

const publicAssetBases = {};

function isPublicAssetURL(id = '') {
  if (assets[id]) {
    return true
  }
  for (const base in publicAssetBases) {
    if (id.startsWith(base)) { return true }
  }
  return false
}

function getAsset (id) {
  return assets[id]
}

const METHODS = new Set(["HEAD", "GET"]);
const EncodingMap = {
	gzip: ".gz",
	br: ".br"
};
const _wLHxlg = defineHandler((event) => {
	if (event.req.method && !METHODS.has(event.req.method)) {
		return;
	}
	let id = decodePath(withLeadingSlash(withoutTrailingSlash(event.url.pathname)));
	let asset;
	const encodingHeader = event.req.headers.get("accept-encoding") || "";
	const encodings = [...encodingHeader.split(",").map((e) => EncodingMap[e.trim()]).filter(Boolean).sort(), ""];
	if (encodings.length > 1) {
		event.res.headers.append("Vary", "Accept-Encoding");
	}
	for (const encoding of encodings) {
		for (const _id of [id + encoding, joinURL(id, "index.html" + encoding)]) {
			const _asset = getAsset(_id);
			if (_asset) {
				asset = _asset;
				id = _id;
				break;
			}
		}
	}
	if (!asset) {
		if (isPublicAssetURL(id)) {
			event.res.headers.delete("Cache-Control");
			throw new HTTPError({ status: 404 });
		}
		return;
	}
	const ifNotMatch = event.req.headers.get("if-none-match") === asset.etag;
	if (ifNotMatch) {
		event.res.status = 304;
		event.res.statusText = "Not Modified";
		return "";
	}
	const ifModifiedSinceH = event.req.headers.get("if-modified-since");
	const mtimeDate = new Date(asset.mtime);
	if (ifModifiedSinceH && asset.mtime && new Date(ifModifiedSinceH) >= mtimeDate) {
		event.res.status = 304;
		event.res.statusText = "Not Modified";
		return "";
	}
	if (asset.type) {
		event.res.headers.set("Content-Type", asset.type);
	}
	if (asset.etag && !event.res.headers.has("ETag")) {
		event.res.headers.set("ETag", asset.etag);
	}
	if (asset.mtime && !event.res.headers.has("Last-Modified")) {
		event.res.headers.set("Last-Modified", mtimeDate.toUTCString());
	}
	if (asset.encoding && !event.res.headers.has("Content-Encoding")) {
		event.res.headers.set("Content-Encoding", asset.encoding);
	}
	if (asset.size > 0 && !event.res.headers.has("Content-Length")) {
		event.res.headers.set("Content-Length", asset.size.toString());
	}
	return readAsset(id);
});

const findRoute = /* @__PURE__ */ (() => { const $0={route:"/.well-known/workflow/v1/step",handler:toEventHandler(_g3m8Xw)},$1={route:"/.well-known/workflow/v1/flow",handler:toEventHandler(_psdlYg)},$2={route:"/.well-known/workflow/v1/webhook/:token",handler:toEventHandler(_n9RDGO)},$3={route:"/**",handler:toEventHandler(app)}; return (m,p)=>{if(p.charCodeAt(p.length-1)===47)p=p.slice(0,-1)||"/";if(p==="/.well-known/workflow/v1/step"){return {data:$0};}if(p==="/.well-known/workflow/v1/flow"){return {data:$1};}let s=p.split("/"),l=s.length-1;if(s[1]===".well-known"){if(s[2]==="workflow"){if(s[3]==="v1"){if(s[4]==="webhook"){if(l===5||l===4){if(l>=5)return {data:$2,params:{"token":s[5],}};}}}}}return {data:$3,params:{"_":s.slice(1).join('/'),}};}})();

const globalMiddleware = [
  toEventHandler(_wLHxlg)
].filter(Boolean);

const APP_ID = "default";
function useNitroApp() {
	let instance = useNitroApp._instance;
	if (instance) {
		return instance;
	}
	instance = useNitroApp._instance = createNitroApp();
	globalThis.__nitro__ = globalThis.__nitro__ || {};
	globalThis.__nitro__[APP_ID] = instance;
	return instance;
}
function createNitroApp() {
	const hooks = undefined;
	const captureError = (error, errorCtx) => {
		if (errorCtx?.event) {
			const errors = errorCtx.event.req.context?.nitro?.errors;
			if (errors) {
				errors.push({
					error,
					context: errorCtx
				});
			}
		}
	};
	const h3App = createH3App({ onError(error, event) {
		return errorHandler(error, event);
	} });
	let appHandler = (req) => {
		req.context ||= {};
		req.context.nitro = req.context.nitro || { errors: [] };
		return h3App.fetch(req);
	};
	const app = {
		fetch: appHandler,
		h3: h3App,
		hooks,
		captureError
	};
	return app;
}
function createH3App(config) {
	// Create H3 app
	const h3App = new H3Core(config);
	// Compiled route matching
	(h3App["~findRoute"] = (event) => findRoute(event.req.method, event.url.pathname));
	h3App["~middleware"].push(...globalMiddleware);
	return h3App;
}

function _captureError(error, type) {
	console.error(`[${type}]`, error);
	useNitroApp().captureError?.(error, { tags: [type] });
}
function trapUnhandledErrors() {
	process.on("unhandledRejection", (error) => _captureError(error, "unhandledRejection"));
	process.on("uncaughtException", (error) => _captureError(error, "uncaughtException"));
}

const port = Number.parseInt(process.env.NITRO_PORT || process.env.PORT || "") || 3e3;
const host = process.env.NITRO_HOST || process.env.HOST;
const cert = process.env.NITRO_SSL_CERT;
const key = process.env.NITRO_SSL_KEY;
// const socketPath = process.env.NITRO_UNIX_SOCKET; // TODO
const nitroApp = useNitroApp();
serve({
	port,
	hostname: host,
	tls: cert && key ? {
		cert,
		key
	} : undefined,
	fetch: nitroApp.fetch
});
trapUnhandledErrors();
const nodeServer = {};

export { nodeServer as default };
