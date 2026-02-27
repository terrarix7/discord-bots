import { p as parseMultipartStream } from '../../../_libs/mixpart.mjs';
import { d as distExports } from './oidc.mjs';
import * as fs from 'fs';
import * as require$$0 from 'path';

// src/transports.ts
async function streamToBuffer$1(stream) {
  let totalLength = 0;
  const reader = stream.getReader();
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLength += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalLength);
}
var JsonTransport$1 = class JsonTransport {
  contentType = "application/json";
  replacer;
  reviver;
  /**
   * Create a new JsonTransport.
   * @param options - Optional JSON serialization options
   * @param options.replacer - Custom replacer for JSON.stringify
   * @param options.reviver - Custom reviver for JSON.parse
   */
  constructor(options = {}) {
    this.replacer = options.replacer;
    this.reviver = options.reviver;
  }
  serialize(value) {
    return Buffer.from(JSON.stringify(value, this.replacer), "utf8");
  }
  async deserialize(stream) {
    const buffer = await streamToBuffer$1(stream);
    return JSON.parse(buffer.toString("utf8"), this.reviver);
  }
};

// src/types.ts
var MessageNotFoundError$1 = class MessageNotFoundError extends Error {
  constructor(messageId) {
    super(`Message ${messageId} not found`);
    this.name = "MessageNotFoundError";
  }
};
var MessageNotAvailableError$1 = class MessageNotAvailableError extends Error {
  constructor(messageId, reason) {
    super(
      `Message ${messageId} not available for processing${reason ? `: ${reason}` : ""}`
    );
    this.name = "MessageNotAvailableError";
  }
};
var MessageCorruptedError$1 = class MessageCorruptedError extends Error {
  constructor(messageId, reason) {
    super(`Message ${messageId} is corrupted: ${reason}`);
    this.name = "MessageCorruptedError";
  }
};
var UnauthorizedError$1 = class UnauthorizedError extends Error {
  constructor(message = "Missing or invalid authentication token") {
    super(message);
    this.name = "UnauthorizedError";
  }
};
var ForbiddenError$1 = class ForbiddenError extends Error {
  constructor(message = "Queue environment doesn't match token environment") {
    super(message);
    this.name = "ForbiddenError";
  }
};
var BadRequestError$1 = class BadRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "BadRequestError";
  }
};
var InternalServerError$1 = class InternalServerError extends Error {
  constructor(message = "Unexpected server error") {
    super(message);
    this.name = "InternalServerError";
  }
};
var InvalidLimitError$1 = class InvalidLimitError extends Error {
  constructor(limit, min = 1, max = 10) {
    super(`Invalid limit: ${limit}. Limit must be between ${min} and ${max}.`);
    this.name = "InvalidLimitError";
  }
};
var MessageAlreadyProcessedError$1 = class MessageAlreadyProcessedError extends Error {
  constructor(messageId) {
    super(`Message ${messageId} has already been processed`);
    this.name = "MessageAlreadyProcessedError";
  }
};
var DuplicateMessageError$1 = class DuplicateMessageError extends Error {
  idempotencyKey;
  constructor(message, idempotencyKey) {
    super(message);
    this.name = "DuplicateMessageError";
    this.idempotencyKey = idempotencyKey;
  }
};
var ConsumerDiscoveryError$1 = class ConsumerDiscoveryError extends Error {
  deploymentId;
  constructor(message, deploymentId) {
    super(message);
    this.name = "ConsumerDiscoveryError";
    this.deploymentId = deploymentId;
  }
};
var ConsumerRegistryNotConfiguredError$1 = class ConsumerRegistryNotConfiguredError extends Error {
  constructor(message = "Consumer registry not configured") {
    super(message);
    this.name = "ConsumerRegistryNotConfiguredError";
  }
};

// src/dev.ts
var ROUTE_MAPPINGS_KEY$1 = Symbol.for("@vercel/queue.devRouteMappings");
function isDevMode$1() {
  return process.env.NODE_ENV === "development";
}
function clearDevRouteMappings$1() {
  const g = globalThis;
  delete g[ROUTE_MAPPINGS_KEY$1];
}
if (process.env.NODE_ENV === "test" || process.env.VITEST) {
  globalThis.__clearDevRouteMappings = clearDevRouteMappings$1;
}

// src/client.ts
function isDebugEnabled$1() {
  return process.env.VERCEL_QUEUE_DEBUG === "1" || process.env.VERCEL_QUEUE_DEBUG === "true";
}
async function consumeStream$1(stream) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}
function throwCommonHttpError$1(status, statusText, errorText, operation, badRequestDefault = "Invalid parameters") {
  if (status === 400) {
    throw new BadRequestError$1(errorText || badRequestDefault);
  }
  if (status === 401) {
    throw new UnauthorizedError$1(errorText || void 0);
  }
  if (status === 403) {
    throw new ForbiddenError$1(errorText || void 0);
  }
  if (status >= 500) {
    throw new InternalServerError$1(
      errorText || `Server error: ${status} ${statusText}`
    );
  }
  throw new Error(`Failed to ${operation}: ${status} ${statusText}`);
}
function parseQueueHeaders$1(headers) {
  const messageId = headers.get("Vqs-Message-Id");
  const deliveryCountStr = headers.get("Vqs-Delivery-Count") || "0";
  const timestamp = headers.get("Vqs-Timestamp");
  const contentType = headers.get("Content-Type") || "application/octet-stream";
  const receiptHandle = headers.get("Vqs-Receipt-Handle");
  if (!messageId || !timestamp || !receiptHandle) {
    return null;
  }
  const deliveryCount = parseInt(deliveryCountStr, 10);
  if (Number.isNaN(deliveryCount)) {
    return null;
  }
  return {
    messageId,
    deliveryCount,
    createdAt: new Date(timestamp),
    contentType,
    receiptHandle
  };
}
var QueueClient$1 = class QueueClient {
  baseUrl;
  basePath;
  customHeaders;
  providedToken;
  defaultDeploymentId;
  pinToDeployment;
  transport;
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || process.env.VERCEL_QUEUE_BASE_URL || "https://vercel-queue.com";
    this.basePath = options.basePath || process.env.VERCEL_QUEUE_BASE_PATH || "/api/v3/topic";
    this.customHeaders = options.headers || {};
    this.providedToken = options.token;
    this.defaultDeploymentId = options.deploymentId || process.env.VERCEL_DEPLOYMENT_ID;
    this.pinToDeployment = options.pinToDeployment ?? true;
    this.transport = options.transport || new JsonTransport$1();
  }
  getTransport() {
    return this.transport;
  }
  getSendDeploymentId() {
    if (isDevMode$1()) {
      return void 0;
    }
    if (this.pinToDeployment) {
      return this.defaultDeploymentId;
    }
    return void 0;
  }
  getConsumeDeploymentId() {
    if (isDevMode$1()) {
      return void 0;
    }
    return this.defaultDeploymentId;
  }
  async getToken() {
    if (this.providedToken) {
      return this.providedToken;
    }
    const token = await distExports.getVercelOidcToken();
    if (!token) {
      throw new Error(
        "Failed to get OIDC token from Vercel Functions. Make sure you are running in a Vercel Function environment, or provide a token explicitly.\n\nTo set up your environment:\n1. Link your project: 'vercel link'\n2. Pull environment variables: 'vercel env pull'\n3. Run with environment: 'dotenv -e .env.local -- your-command'"
      );
    }
    return token;
  }
  buildUrl(queueName, ...pathSegments) {
    const encodedQueue = encodeURIComponent(queueName);
    const segments = pathSegments.map((s) => encodeURIComponent(s));
    const path2 = segments.length > 0 ? "/" + segments.join("/") : "";
    return `${this.baseUrl}${this.basePath}/${encodedQueue}${path2}`;
  }
  async fetch(url, init) {
    const method = init.method || "GET";
    if (isDebugEnabled$1()) {
      const logData = {
        method,
        url,
        headers: init.headers
      };
      const body = init.body;
      if (body !== void 0 && body !== null) {
        if (body instanceof ArrayBuffer) {
          logData.bodySize = body.byteLength;
        } else if (body instanceof Uint8Array) {
          logData.bodySize = body.byteLength;
        } else if (typeof body === "string") {
          logData.bodySize = body.length;
        } else {
          logData.bodyType = typeof body;
        }
      }
      console.debug("[VQS Debug] Request:", JSON.stringify(logData, null, 2));
    }
    init.headers.set("User-Agent", `@vercel/queue/${"0.0.0-alpha.38"}`);
    init.headers.set("Vqs-Client-Ts", (/* @__PURE__ */ new Date()).toISOString());
    const response = await fetch(url, init);
    if (isDebugEnabled$1()) {
      const logData = {
        method,
        url,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      };
      console.debug("[VQS Debug] Response:", JSON.stringify(logData, null, 2));
    }
    return response;
  }
  /**
   * Send a message to a topic.
   *
   * @param options - Message options including queue name, payload, and optional settings
   * @param options.queueName - Topic name (pattern: `[A-Za-z0-9_-]+`)
   * @param options.payload - Message payload
   * @param options.idempotencyKey - Optional deduplication key (dedup window: min(retention, 24h))
   * @param options.retentionSeconds - Message TTL (default: 86400, min: 60, max: 86400)
   * @param options.delaySeconds - Delivery delay (default: 0, max: retentionSeconds)
   * @returns Promise with the generated messageId
   * @throws {DuplicateMessageError} When idempotency key was already used
   * @throws {ConsumerDiscoveryError} When consumer discovery fails
   * @throws {ConsumerRegistryNotConfiguredError} When registry not configured
   * @throws {BadRequestError} When parameters are invalid
   * @throws {UnauthorizedError} When authentication fails
   * @throws {ForbiddenError} When access is denied
   * @throws {InternalServerError} When server encounters an error
   */
  async sendMessage(options) {
    const transport = this.transport;
    const {
      queueName,
      payload,
      idempotencyKey,
      retentionSeconds,
      delaySeconds,
      headers: optionHeaders
    } = options;
    const headers = new Headers();
    if (this.customHeaders) {
      for (const [name, value] of Object.entries(this.customHeaders)) {
        headers.append(name, value);
      }
    }
    if (optionHeaders) {
      const protectedHeaderNames = /* @__PURE__ */ new Set(["authorization", "content-type"]);
      const isProtectedHeader = (name) => {
        const lower = name.toLowerCase();
        if (protectedHeaderNames.has(lower)) return true;
        return lower.startsWith("vqs-");
      };
      for (const [name, value] of Object.entries(optionHeaders)) {
        if (!isProtectedHeader(name) && value !== void 0) {
          headers.append(name, value);
        }
      }
    }
    headers.set("Authorization", `Bearer ${await this.getToken()}`);
    headers.set("Content-Type", transport.contentType);
    const deploymentId = this.getSendDeploymentId();
    if (deploymentId) {
      headers.set("Vqs-Deployment-Id", deploymentId);
    }
    if (idempotencyKey) {
      headers.set("Vqs-Idempotency-Key", idempotencyKey);
    }
    if (retentionSeconds !== void 0) {
      headers.set("Vqs-Retention-Seconds", retentionSeconds.toString());
    }
    if (delaySeconds !== void 0) {
      headers.set("Vqs-Delay-Seconds", delaySeconds.toString());
    }
    const serialized = transport.serialize(payload);
    const body = Buffer.isBuffer(serialized) ? new Uint8Array(serialized) : serialized;
    const response = await this.fetch(this.buildUrl(queueName), {
      method: "POST",
      body,
      headers
    });
    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 409) {
        throw new DuplicateMessageError$1(
          errorText || "Duplicate idempotency key detected",
          idempotencyKey
        );
      }
      if (response.status === 502) {
        throw new ConsumerDiscoveryError$1(
          errorText || "Consumer discovery failed",
          deploymentId
        );
      }
      if (response.status === 503) {
        throw new ConsumerRegistryNotConfiguredError$1(
          errorText || "Consumer registry not configured"
        );
      }
      throwCommonHttpError$1(
        response.status,
        response.statusText,
        errorText,
        "send message"
      );
    }
    const responseData = await response.json();
    return responseData;
  }
  /**
   * Receive messages from a topic as an async generator.
   *
   * When the queue is empty, the generator completes without yielding any
   * messages. Callers should handle the case where no messages are yielded.
   *
   * @param options - Receive options
   * @param options.queueName - Topic name (pattern: `[A-Za-z0-9_-]+`)
   * @param options.consumerGroup - Consumer group name (pattern: `[A-Za-z0-9_-]+`)
   * @param options.visibilityTimeoutSeconds - Lock duration (default: 30, min: 0, max: 3600)
   * @param options.limit - Max messages to retrieve (default: 1, min: 1, max: 10)
   * @yields Message objects with payload, messageId, receiptHandle, etc.
   *         Yields nothing if queue is empty.
   * @throws {InvalidLimitError} When limit is outside 1-10 range
   * @throws {BadRequestError} When parameters are invalid
   * @throws {UnauthorizedError} When authentication fails
   * @throws {ForbiddenError} When access is denied
   * @throws {InternalServerError} When server encounters an error
   */
  async *receiveMessages(options) {
    const transport = this.transport;
    const { queueName, consumerGroup, visibilityTimeoutSeconds, limit } = options;
    if (limit !== void 0 && (limit < 1 || limit > 10)) {
      throw new InvalidLimitError$1(limit);
    }
    const headers = new Headers({
      Authorization: `Bearer ${await this.getToken()}`,
      Accept: "multipart/mixed",
      ...this.customHeaders
    });
    if (visibilityTimeoutSeconds !== void 0) {
      headers.set(
        "Vqs-Visibility-Timeout-Seconds",
        visibilityTimeoutSeconds.toString()
      );
    }
    if (limit !== void 0) {
      headers.set("Vqs-Max-Messages", limit.toString());
    }
    const effectiveDeploymentId = this.getConsumeDeploymentId();
    if (effectiveDeploymentId) {
      headers.set("Vqs-Deployment-Id", effectiveDeploymentId);
    }
    const response = await this.fetch(
      this.buildUrl(queueName, "consumer", consumerGroup),
      {
        method: "POST",
        headers
      }
    );
    if (response.status === 204) {
      return;
    }
    if (!response.ok) {
      const errorText = await response.text();
      throwCommonHttpError$1(
        response.status,
        response.statusText,
        errorText,
        "receive messages"
      );
    }
    for await (const multipartMessage of parseMultipartStream(response)) {
      try {
        const parsedHeaders = parseQueueHeaders$1(multipartMessage.headers);
        if (!parsedHeaders) {
          console.warn("Missing required queue headers in multipart part");
          await consumeStream$1(multipartMessage.payload);
          continue;
        }
        const deserializedPayload = await transport.deserialize(
          multipartMessage.payload
        );
        const message = {
          ...parsedHeaders,
          payload: deserializedPayload
        };
        yield message;
      } catch (error) {
        console.warn("Failed to process multipart message:", error);
        await consumeStream$1(multipartMessage.payload);
      }
    }
  }
  /**
   * Receive a specific message by its ID.
   *
   * @param options - Receive options
   * @param options.queueName - Topic name (pattern: `[A-Za-z0-9_-]+`)
   * @param options.consumerGroup - Consumer group name (pattern: `[A-Za-z0-9_-]+`)
   * @param options.messageId - Message ID to retrieve
   * @param options.visibilityTimeoutSeconds - Lock duration (default: 30, min: 0, max: 3600)
   * @returns Promise with the message
   * @throws {MessageNotFoundError} When message doesn't exist
   * @throws {MessageNotAvailableError} When message is in wrong state or was a duplicate
   * @throws {MessageAlreadyProcessedError} When message was already processed
   * @throws {BadRequestError} When parameters are invalid
   * @throws {UnauthorizedError} When authentication fails
   * @throws {ForbiddenError} When access is denied
   * @throws {InternalServerError} When server encounters an error
   */
  async receiveMessageById(options) {
    const transport = this.transport;
    const { queueName, consumerGroup, messageId, visibilityTimeoutSeconds } = options;
    const headers = new Headers({
      Authorization: `Bearer ${await this.getToken()}`,
      Accept: "multipart/mixed",
      ...this.customHeaders
    });
    if (visibilityTimeoutSeconds !== void 0) {
      headers.set(
        "Vqs-Visibility-Timeout-Seconds",
        visibilityTimeoutSeconds.toString()
      );
    }
    const effectiveDeploymentId = this.getConsumeDeploymentId();
    if (effectiveDeploymentId) {
      headers.set("Vqs-Deployment-Id", effectiveDeploymentId);
    }
    const response = await this.fetch(
      this.buildUrl(queueName, "consumer", consumerGroup, "id", messageId),
      {
        method: "POST",
        headers
      }
    );
    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 404) {
        throw new MessageNotFoundError$1(messageId);
      }
      if (response.status === 409) {
        let errorData = {};
        try {
          errorData = JSON.parse(errorText);
        } catch {
        }
        if (errorData.originalMessageId) {
          throw new MessageNotAvailableError$1(
            messageId,
            `This message was a duplicate - use originalMessageId: ${errorData.originalMessageId}`
          );
        }
        throw new MessageNotAvailableError$1(messageId);
      }
      if (response.status === 410) {
        throw new MessageAlreadyProcessedError$1(messageId);
      }
      throwCommonHttpError$1(
        response.status,
        response.statusText,
        errorText,
        "receive message by ID"
      );
    }
    for await (const multipartMessage of parseMultipartStream(response)) {
      const parsedHeaders = parseQueueHeaders$1(multipartMessage.headers);
      if (!parsedHeaders) {
        await consumeStream$1(multipartMessage.payload);
        throw new MessageCorruptedError$1(
          messageId,
          "Missing required queue headers in response"
        );
      }
      const deserializedPayload = await transport.deserialize(
        multipartMessage.payload
      );
      const message = {
        ...parsedHeaders,
        payload: deserializedPayload
      };
      return { message };
    }
    throw new MessageNotFoundError$1(messageId);
  }
  /**
   * Delete (acknowledge) a message after successful processing.
   *
   * @param options - Delete options
   * @param options.queueName - Topic name
   * @param options.consumerGroup - Consumer group name
   * @param options.receiptHandle - Receipt handle from the received message (must use same deployment ID as receive)
   * @returns Promise indicating deletion success
   * @throws {MessageNotFoundError} When receipt handle not found
   * @throws {MessageNotAvailableError} When receipt handle invalid or message already processed
   * @throws {BadRequestError} When parameters are invalid
   * @throws {UnauthorizedError} When authentication fails
   * @throws {ForbiddenError} When access is denied
   * @throws {InternalServerError} When server encounters an error
   */
  async deleteMessage(options) {
    const { queueName, consumerGroup, receiptHandle } = options;
    const headers = new Headers({
      Authorization: `Bearer ${await this.getToken()}`,
      ...this.customHeaders
    });
    const effectiveDeploymentId = this.getConsumeDeploymentId();
    if (effectiveDeploymentId) {
      headers.set("Vqs-Deployment-Id", effectiveDeploymentId);
    }
    const response = await this.fetch(
      this.buildUrl(
        queueName,
        "consumer",
        consumerGroup,
        "lease",
        receiptHandle
      ),
      {
        method: "DELETE",
        headers
      }
    );
    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 404) {
        throw new MessageNotFoundError$1(receiptHandle);
      }
      if (response.status === 409) {
        throw new MessageNotAvailableError$1(
          receiptHandle,
          errorText || "Invalid receipt handle, message not in correct state, or already processed"
        );
      }
      throwCommonHttpError$1(
        response.status,
        response.statusText,
        errorText,
        "delete message",
        "Missing or invalid receipt handle"
      );
    }
    return { deleted: true };
  }
  /**
   * Extend or change the visibility timeout of a message.
   * Used to prevent message redelivery while still processing.
   *
   * @param options - Visibility options
   * @param options.queueName - Topic name
   * @param options.consumerGroup - Consumer group name
   * @param options.receiptHandle - Receipt handle from the received message (must use same deployment ID as receive)
   * @param options.visibilityTimeoutSeconds - New timeout (min: 0, max: 3600, cannot exceed message expiration)
   * @returns Promise indicating success
   * @throws {MessageNotFoundError} When receipt handle not found
   * @throws {MessageNotAvailableError} When receipt handle invalid or message already processed
   * @throws {BadRequestError} When parameters are invalid
   * @throws {UnauthorizedError} When authentication fails
   * @throws {ForbiddenError} When access is denied
   * @throws {InternalServerError} When server encounters an error
   */
  async changeVisibility(options) {
    const {
      queueName,
      consumerGroup,
      receiptHandle,
      visibilityTimeoutSeconds
    } = options;
    const headers = new Headers({
      Authorization: `Bearer ${await this.getToken()}`,
      "Content-Type": "application/json",
      ...this.customHeaders
    });
    const effectiveDeploymentId = this.getConsumeDeploymentId();
    if (effectiveDeploymentId) {
      headers.set("Vqs-Deployment-Id", effectiveDeploymentId);
    }
    const response = await this.fetch(
      this.buildUrl(
        queueName,
        "consumer",
        consumerGroup,
        "lease",
        receiptHandle
      ),
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ visibilityTimeoutSeconds })
      }
    );
    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 404) {
        throw new MessageNotFoundError$1(receiptHandle);
      }
      if (response.status === 409) {
        throw new MessageNotAvailableError$1(
          receiptHandle,
          errorText || "Invalid receipt handle, message not in correct state, or already processed"
        );
      }
      throwCommonHttpError$1(
        response.status,
        response.statusText,
        errorText,
        "change visibility",
        "Missing receipt handle or invalid visibility timeout"
      );
    }
    return { success: true };
  }
  /**
   * Alternative endpoint for changing message visibility timeout.
   * Uses the /visibility path suffix and expects visibilityTimeoutSeconds in the body.
   * Functionally equivalent to changeVisibility but follows an alternative API pattern.
   *
   * @param options - Options for changing visibility
   * @returns Promise resolving to change visibility response
   */
  async changeVisibilityAlt(options) {
    const {
      queueName,
      consumerGroup,
      receiptHandle,
      visibilityTimeoutSeconds
    } = options;
    const headers = new Headers({
      Authorization: `Bearer ${await this.getToken()}`,
      "Content-Type": "application/json",
      ...this.customHeaders
    });
    const effectiveDeploymentId = this.getConsumeDeploymentId();
    if (effectiveDeploymentId) {
      headers.set("Vqs-Deployment-Id", effectiveDeploymentId);
    }
    const response = await this.fetch(
      this.buildUrl(
        queueName,
        "consumer",
        consumerGroup,
        "lease",
        receiptHandle,
        "visibility"
      ),
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ visibilityTimeoutSeconds })
      }
    );
    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 404) {
        throw new MessageNotFoundError$1(receiptHandle);
      }
      if (response.status === 409) {
        throw new MessageNotAvailableError$1(
          receiptHandle,
          errorText || "Invalid receipt handle, message not in correct state, or already processed"
        );
      }
      throwCommonHttpError$1(
        response.status,
        response.statusText,
        errorText,
        "change visibility (alt)",
        "Missing receipt handle or invalid visibility timeout"
      );
    }
    return { success: true };
  }
};

// src/client.ts

// src/types.ts
var MessageNotFoundError = class extends Error {
  constructor(messageId) {
    super(`Message ${messageId} not found`);
    this.name = "MessageNotFoundError";
  }
};
var MessageNotAvailableError = class extends Error {
  constructor(messageId, reason) {
    super(
      `Message ${messageId} not available for processing${reason ? `: ${reason}` : ""}`
    );
    this.name = "MessageNotAvailableError";
  }
};
var MessageCorruptedError = class extends Error {
  constructor(messageId, reason) {
    super(`Message ${messageId} is corrupted: ${reason}`);
    this.name = "MessageCorruptedError";
  }
};
var UnauthorizedError = class extends Error {
  constructor(message = "Missing or invalid authentication token") {
    super(message);
    this.name = "UnauthorizedError";
  }
};
var ForbiddenError = class extends Error {
  constructor(message = "Queue environment doesn't match token environment") {
    super(message);
    this.name = "ForbiddenError";
  }
};
var BadRequestError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "BadRequestError";
  }
};
var InternalServerError = class extends Error {
  constructor(message = "Unexpected server error") {
    super(message);
    this.name = "InternalServerError";
  }
};
var InvalidLimitError = class extends Error {
  constructor(limit, min = 1, max = 10) {
    super(`Invalid limit: ${limit}. Limit must be between ${min} and ${max}.`);
    this.name = "InvalidLimitError";
  }
};
var MessageAlreadyProcessedError = class extends Error {
  constructor(messageId) {
    super(`Message ${messageId} has already been processed`);
    this.name = "MessageAlreadyProcessedError";
  }
};
var DuplicateMessageError = class extends Error {
  idempotencyKey;
  constructor(message, idempotencyKey) {
    super(message);
    this.name = "DuplicateMessageError";
    this.idempotencyKey = idempotencyKey;
  }
};
var ConsumerDiscoveryError = class extends Error {
  deploymentId;
  constructor(message, deploymentId) {
    super(message);
    this.name = "ConsumerDiscoveryError";
    this.deploymentId = deploymentId;
  }
};
var ConsumerRegistryNotConfiguredError = class extends Error {
  constructor(message = "Consumer registry not configured") {
    super(message);
    this.name = "ConsumerRegistryNotConfiguredError";
  }
};

// src/dev.ts
var ROUTE_MAPPINGS_KEY = Symbol.for("@vercel/queue.devRouteMappings");
function filePathToUrlPath(filePath) {
  let urlPath = filePath.replace(/^app\//, "/").replace(/^pages\//, "/").replace(/\/route\.(ts|mts|js|mjs|tsx|jsx)$/, "").replace(/\.(ts|mts|js|mjs|tsx|jsx)$/, "");
  if (!urlPath.startsWith("/")) {
    urlPath = "/" + urlPath;
  }
  return urlPath;
}
function filePathToConsumerGroup(filePath) {
  return filePath.replace(/_/g, "__").replace(/\//g, "_S").replace(/\./g, "_D");
}
function getDevRouteMappings() {
  const g = globalThis;
  if (ROUTE_MAPPINGS_KEY in g) {
    return g[ROUTE_MAPPINGS_KEY] ?? null;
  }
  try {
    const vercelJsonPath = require$$0.join(process.cwd(), "vercel.json");
    if (!fs.existsSync(vercelJsonPath)) {
      g[ROUTE_MAPPINGS_KEY] = null;
      return null;
    }
    const vercelJson = JSON.parse(fs.readFileSync(vercelJsonPath, "utf-8"));
    if (!vercelJson.functions) {
      g[ROUTE_MAPPINGS_KEY] = null;
      return null;
    }
    const mappings = [];
    for (const [filePath, config] of Object.entries(vercelJson.functions)) {
      if (!config.experimentalTriggers) continue;
      for (const trigger of config.experimentalTriggers) {
        if (trigger.type?.startsWith("queue/") && trigger.topic) {
          mappings.push({
            urlPath: filePathToUrlPath(filePath),
            topic: trigger.topic,
            consumer: filePathToConsumerGroup(filePath)
          });
        }
      }
    }
    g[ROUTE_MAPPINGS_KEY] = mappings.length > 0 ? mappings : null;
    return g[ROUTE_MAPPINGS_KEY];
  } catch (error) {
    console.warn("[Dev Mode] Failed to read vercel.json:", error);
    g[ROUTE_MAPPINGS_KEY] = null;
    return null;
  }
}
function findMatchingRoutes(topicName) {
  const mappings = getDevRouteMappings();
  if (!mappings) {
    return [];
  }
  return mappings.filter((mapping) => {
    if (mapping.topic.includes("*")) {
      return matchesWildcardPattern(topicName, mapping.topic);
    }
    return mapping.topic === topicName;
  });
}
function isDevMode() {
  return process.env.NODE_ENV === "development";
}
var DEV_VISIBILITY_POLL_INTERVAL = 50;
var DEV_VISIBILITY_MAX_WAIT = 5e3;
var DEV_VISIBILITY_BACKOFF_MULTIPLIER = 2;
async function waitForMessageVisibility(topicName, consumerGroup, messageId) {
  const client = new QueueClient();
  let elapsed = 0;
  let interval = DEV_VISIBILITY_POLL_INTERVAL;
  while (elapsed < DEV_VISIBILITY_MAX_WAIT) {
    try {
      await client.receiveMessageById({
        queueName: topicName,
        consumerGroup,
        messageId,
        visibilityTimeoutSeconds: 0
      });
      return true;
    } catch (error) {
      if (error instanceof MessageNotFoundError) {
        await new Promise((resolve) => setTimeout(resolve, interval));
        elapsed += interval;
        interval = Math.min(
          interval * DEV_VISIBILITY_BACKOFF_MULTIPLIER,
          DEV_VISIBILITY_MAX_WAIT - elapsed
        );
        continue;
      }
      if (error instanceof MessageAlreadyProcessedError) {
        console.log(
          `[Dev Mode] Message already processed: topic="${topicName}" messageId="${messageId}"`
        );
        return false;
      }
      console.error(
        `[Dev Mode] Error polling for message visibility: topic="${topicName}" messageId="${messageId}"`,
        error
      );
      return false;
    }
  }
  console.warn(
    `[Dev Mode] Message visibility timeout after ${DEV_VISIBILITY_MAX_WAIT}ms: topic="${topicName}" messageId="${messageId}"`
  );
  return false;
}
function triggerDevCallbacks(topicName, messageId, delaySeconds) {
  console.log(
    `[Dev Mode] Message sent: topic="${topicName}" messageId="${messageId}"`
  );
  const matchingRoutes = findMatchingRoutes(topicName);
  if (matchingRoutes.length === 0) {
    console.log(
      `[Dev Mode] No matching routes in vercel.json for topic "${topicName}"`
    );
    return;
  }
  const consumerGroups = matchingRoutes.map((r) => r.consumer);
  console.log(
    `[Dev Mode] Scheduling callbacks for topic="${topicName}" messageId="${messageId}" \u2192 consumers: [${consumerGroups.join(", ")}]`
  );
  (async () => {
    const firstRoute = matchingRoutes[0];
    const isVisible = await waitForMessageVisibility(
      topicName,
      firstRoute.consumer,
      messageId
    );
    if (!isVisible) {
      console.warn(
        `[Dev Mode] Skipping callbacks - message not visible: topic="${topicName}" messageId="${messageId}"`
      );
      return;
    }
    const port = process.env.PORT || 3e3;
    const baseUrl = `http://localhost:${port}`;
    for (const route of matchingRoutes) {
      const url = `${baseUrl}${route.urlPath}`;
      console.log(
        `[Dev Mode] Invoking handler: topic="${topicName}" consumer="${route.consumer}" messageId="${messageId}" url="${url}"`
      );
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "ce-type": CLOUD_EVENT_TYPE_V2BETA,
            "ce-vqsqueuename": topicName,
            "ce-vqsconsumergroup": route.consumer,
            "ce-vqsmessageid": messageId
          }
        });
        if (response.ok) {
          try {
            const responseData = await response.json();
            if (responseData.status === "success") {
              console.log(
                `[Dev Mode] \u2713 Message processed successfully: topic="${topicName}" consumer="${route.consumer}" messageId="${messageId}"`
              );
            }
          } catch {
            console.warn(
              `[Dev Mode] Handler returned OK but response was not JSON: topic="${topicName}" consumer="${route.consumer}"`
            );
          }
        } else {
          try {
            const errorData = await response.json();
            console.error(
              `[Dev Mode] \u2717 Handler failed: topic="${topicName}" consumer="${route.consumer}" messageId="${messageId}" error="${errorData.error || response.statusText}"`
            );
          } catch {
            console.error(
              `[Dev Mode] \u2717 Handler failed: topic="${topicName}" consumer="${route.consumer}" messageId="${messageId}" status=${response.status}`
            );
          }
        }
      } catch (error) {
        console.error(
          `[Dev Mode] \u2717 HTTP request failed: topic="${topicName}" consumer="${route.consumer}" messageId="${messageId}" url="${url}"`,
          error
        );
      }
    }
  })();
}
function clearDevRouteMappings() {
  const g = globalThis;
  delete g[ROUTE_MAPPINGS_KEY];
}
if (process.env.NODE_ENV === "test" || process.env.VITEST) {
  globalThis.__clearDevRouteMappings = clearDevRouteMappings;
}

// src/transports.ts
async function streamToBuffer(stream) {
  let totalLength = 0;
  const reader = stream.getReader();
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLength += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalLength);
}
var JsonTransport = class {
  contentType = "application/json";
  replacer;
  reviver;
  /**
   * Create a new JsonTransport.
   * @param options - Optional JSON serialization options
   * @param options.replacer - Custom replacer for JSON.stringify
   * @param options.reviver - Custom reviver for JSON.parse
   */
  constructor(options = {}) {
    this.replacer = options.replacer;
    this.reviver = options.reviver;
  }
  serialize(value) {
    return Buffer.from(JSON.stringify(value, this.replacer), "utf8");
  }
  async deserialize(stream) {
    const buffer = await streamToBuffer(stream);
    return JSON.parse(buffer.toString("utf8"), this.reviver);
  }
};

// src/client.ts
function isDebugEnabled() {
  return process.env.VERCEL_QUEUE_DEBUG === "1" || process.env.VERCEL_QUEUE_DEBUG === "true";
}
async function consumeStream(stream) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}
function throwCommonHttpError(status, statusText, errorText, operation, badRequestDefault = "Invalid parameters") {
  if (status === 400) {
    throw new BadRequestError(errorText || badRequestDefault);
  }
  if (status === 401) {
    throw new UnauthorizedError(errorText || void 0);
  }
  if (status === 403) {
    throw new ForbiddenError(errorText || void 0);
  }
  if (status >= 500) {
    throw new InternalServerError(
      errorText || `Server error: ${status} ${statusText}`
    );
  }
  throw new Error(`Failed to ${operation}: ${status} ${statusText}`);
}
function parseQueueHeaders(headers) {
  const messageId = headers.get("Vqs-Message-Id");
  const deliveryCountStr = headers.get("Vqs-Delivery-Count") || "0";
  const timestamp = headers.get("Vqs-Timestamp");
  const contentType = headers.get("Content-Type") || "application/octet-stream";
  const receiptHandle = headers.get("Vqs-Receipt-Handle");
  if (!messageId || !timestamp || !receiptHandle) {
    return null;
  }
  const deliveryCount = parseInt(deliveryCountStr, 10);
  if (Number.isNaN(deliveryCount)) {
    return null;
  }
  return {
    messageId,
    deliveryCount,
    createdAt: new Date(timestamp),
    contentType,
    receiptHandle
  };
}
var QueueClient = class {
  baseUrl;
  basePath;
  customHeaders;
  providedToken;
  defaultDeploymentId;
  pinToDeployment;
  transport;
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || process.env.VERCEL_QUEUE_BASE_URL || "https://vercel-queue.com";
    this.basePath = options.basePath || process.env.VERCEL_QUEUE_BASE_PATH || "/api/v3/topic";
    this.customHeaders = options.headers || {};
    this.providedToken = options.token;
    this.defaultDeploymentId = options.deploymentId || process.env.VERCEL_DEPLOYMENT_ID;
    this.pinToDeployment = options.pinToDeployment ?? true;
    this.transport = options.transport || new JsonTransport();
  }
  getTransport() {
    return this.transport;
  }
  getSendDeploymentId() {
    if (isDevMode()) {
      return void 0;
    }
    if (this.pinToDeployment) {
      return this.defaultDeploymentId;
    }
    return void 0;
  }
  getConsumeDeploymentId() {
    if (isDevMode()) {
      return void 0;
    }
    return this.defaultDeploymentId;
  }
  async getToken() {
    if (this.providedToken) {
      return this.providedToken;
    }
    const token = await distExports.getVercelOidcToken();
    if (!token) {
      throw new Error(
        "Failed to get OIDC token from Vercel Functions. Make sure you are running in a Vercel Function environment, or provide a token explicitly.\n\nTo set up your environment:\n1. Link your project: 'vercel link'\n2. Pull environment variables: 'vercel env pull'\n3. Run with environment: 'dotenv -e .env.local -- your-command'"
      );
    }
    return token;
  }
  buildUrl(queueName, ...pathSegments) {
    const encodedQueue = encodeURIComponent(queueName);
    const segments = pathSegments.map((s) => encodeURIComponent(s));
    const path2 = segments.length > 0 ? "/" + segments.join("/") : "";
    return `${this.baseUrl}${this.basePath}/${encodedQueue}${path2}`;
  }
  async fetch(url, init) {
    const method = init.method || "GET";
    if (isDebugEnabled()) {
      const logData = {
        method,
        url,
        headers: init.headers
      };
      const body = init.body;
      if (body !== void 0 && body !== null) {
        if (body instanceof ArrayBuffer) {
          logData.bodySize = body.byteLength;
        } else if (body instanceof Uint8Array) {
          logData.bodySize = body.byteLength;
        } else if (typeof body === "string") {
          logData.bodySize = body.length;
        } else {
          logData.bodyType = typeof body;
        }
      }
      console.debug("[VQS Debug] Request:", JSON.stringify(logData, null, 2));
    }
    init.headers.set("User-Agent", `@vercel/queue/${"0.0.0-alpha.38"}`);
    init.headers.set("Vqs-Client-Ts", (/* @__PURE__ */ new Date()).toISOString());
    const response = await fetch(url, init);
    if (isDebugEnabled()) {
      const logData = {
        method,
        url,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      };
      console.debug("[VQS Debug] Response:", JSON.stringify(logData, null, 2));
    }
    return response;
  }
  /**
   * Send a message to a topic.
   *
   * @param options - Message options including queue name, payload, and optional settings
   * @param options.queueName - Topic name (pattern: `[A-Za-z0-9_-]+`)
   * @param options.payload - Message payload
   * @param options.idempotencyKey - Optional deduplication key (dedup window: min(retention, 24h))
   * @param options.retentionSeconds - Message TTL (default: 86400, min: 60, max: 86400)
   * @param options.delaySeconds - Delivery delay (default: 0, max: retentionSeconds)
   * @returns Promise with the generated messageId
   * @throws {DuplicateMessageError} When idempotency key was already used
   * @throws {ConsumerDiscoveryError} When consumer discovery fails
   * @throws {ConsumerRegistryNotConfiguredError} When registry not configured
   * @throws {BadRequestError} When parameters are invalid
   * @throws {UnauthorizedError} When authentication fails
   * @throws {ForbiddenError} When access is denied
   * @throws {InternalServerError} When server encounters an error
   */
  async sendMessage(options) {
    const transport = this.transport;
    const {
      queueName,
      payload,
      idempotencyKey,
      retentionSeconds,
      delaySeconds,
      headers: optionHeaders
    } = options;
    const headers = new Headers();
    if (this.customHeaders) {
      for (const [name, value] of Object.entries(this.customHeaders)) {
        headers.append(name, value);
      }
    }
    if (optionHeaders) {
      const protectedHeaderNames = /* @__PURE__ */ new Set(["authorization", "content-type"]);
      const isProtectedHeader = (name) => {
        const lower = name.toLowerCase();
        if (protectedHeaderNames.has(lower)) return true;
        return lower.startsWith("vqs-");
      };
      for (const [name, value] of Object.entries(optionHeaders)) {
        if (!isProtectedHeader(name) && value !== void 0) {
          headers.append(name, value);
        }
      }
    }
    headers.set("Authorization", `Bearer ${await this.getToken()}`);
    headers.set("Content-Type", transport.contentType);
    const deploymentId = this.getSendDeploymentId();
    if (deploymentId) {
      headers.set("Vqs-Deployment-Id", deploymentId);
    }
    if (idempotencyKey) {
      headers.set("Vqs-Idempotency-Key", idempotencyKey);
    }
    if (retentionSeconds !== void 0) {
      headers.set("Vqs-Retention-Seconds", retentionSeconds.toString());
    }
    if (delaySeconds !== void 0) {
      headers.set("Vqs-Delay-Seconds", delaySeconds.toString());
    }
    const serialized = transport.serialize(payload);
    const body = Buffer.isBuffer(serialized) ? new Uint8Array(serialized) : serialized;
    const response = await this.fetch(this.buildUrl(queueName), {
      method: "POST",
      body,
      headers
    });
    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 409) {
        throw new DuplicateMessageError(
          errorText || "Duplicate idempotency key detected",
          idempotencyKey
        );
      }
      if (response.status === 502) {
        throw new ConsumerDiscoveryError(
          errorText || "Consumer discovery failed",
          deploymentId
        );
      }
      if (response.status === 503) {
        throw new ConsumerRegistryNotConfiguredError(
          errorText || "Consumer registry not configured"
        );
      }
      throwCommonHttpError(
        response.status,
        response.statusText,
        errorText,
        "send message"
      );
    }
    const responseData = await response.json();
    return responseData;
  }
  /**
   * Receive messages from a topic as an async generator.
   *
   * When the queue is empty, the generator completes without yielding any
   * messages. Callers should handle the case where no messages are yielded.
   *
   * @param options - Receive options
   * @param options.queueName - Topic name (pattern: `[A-Za-z0-9_-]+`)
   * @param options.consumerGroup - Consumer group name (pattern: `[A-Za-z0-9_-]+`)
   * @param options.visibilityTimeoutSeconds - Lock duration (default: 30, min: 0, max: 3600)
   * @param options.limit - Max messages to retrieve (default: 1, min: 1, max: 10)
   * @yields Message objects with payload, messageId, receiptHandle, etc.
   *         Yields nothing if queue is empty.
   * @throws {InvalidLimitError} When limit is outside 1-10 range
   * @throws {BadRequestError} When parameters are invalid
   * @throws {UnauthorizedError} When authentication fails
   * @throws {ForbiddenError} When access is denied
   * @throws {InternalServerError} When server encounters an error
   */
  async *receiveMessages(options) {
    const transport = this.transport;
    const { queueName, consumerGroup, visibilityTimeoutSeconds, limit } = options;
    if (limit !== void 0 && (limit < 1 || limit > 10)) {
      throw new InvalidLimitError(limit);
    }
    const headers = new Headers({
      Authorization: `Bearer ${await this.getToken()}`,
      Accept: "multipart/mixed",
      ...this.customHeaders
    });
    if (visibilityTimeoutSeconds !== void 0) {
      headers.set(
        "Vqs-Visibility-Timeout-Seconds",
        visibilityTimeoutSeconds.toString()
      );
    }
    if (limit !== void 0) {
      headers.set("Vqs-Max-Messages", limit.toString());
    }
    const effectiveDeploymentId = this.getConsumeDeploymentId();
    if (effectiveDeploymentId) {
      headers.set("Vqs-Deployment-Id", effectiveDeploymentId);
    }
    const response = await this.fetch(
      this.buildUrl(queueName, "consumer", consumerGroup),
      {
        method: "POST",
        headers
      }
    );
    if (response.status === 204) {
      return;
    }
    if (!response.ok) {
      const errorText = await response.text();
      throwCommonHttpError(
        response.status,
        response.statusText,
        errorText,
        "receive messages"
      );
    }
    for await (const multipartMessage of parseMultipartStream(response)) {
      try {
        const parsedHeaders = parseQueueHeaders(multipartMessage.headers);
        if (!parsedHeaders) {
          console.warn("Missing required queue headers in multipart part");
          await consumeStream(multipartMessage.payload);
          continue;
        }
        const deserializedPayload = await transport.deserialize(
          multipartMessage.payload
        );
        const message = {
          ...parsedHeaders,
          payload: deserializedPayload
        };
        yield message;
      } catch (error) {
        console.warn("Failed to process multipart message:", error);
        await consumeStream(multipartMessage.payload);
      }
    }
  }
  /**
   * Receive a specific message by its ID.
   *
   * @param options - Receive options
   * @param options.queueName - Topic name (pattern: `[A-Za-z0-9_-]+`)
   * @param options.consumerGroup - Consumer group name (pattern: `[A-Za-z0-9_-]+`)
   * @param options.messageId - Message ID to retrieve
   * @param options.visibilityTimeoutSeconds - Lock duration (default: 30, min: 0, max: 3600)
   * @returns Promise with the message
   * @throws {MessageNotFoundError} When message doesn't exist
   * @throws {MessageNotAvailableError} When message is in wrong state or was a duplicate
   * @throws {MessageAlreadyProcessedError} When message was already processed
   * @throws {BadRequestError} When parameters are invalid
   * @throws {UnauthorizedError} When authentication fails
   * @throws {ForbiddenError} When access is denied
   * @throws {InternalServerError} When server encounters an error
   */
  async receiveMessageById(options) {
    const transport = this.transport;
    const { queueName, consumerGroup, messageId, visibilityTimeoutSeconds } = options;
    const headers = new Headers({
      Authorization: `Bearer ${await this.getToken()}`,
      Accept: "multipart/mixed",
      ...this.customHeaders
    });
    if (visibilityTimeoutSeconds !== void 0) {
      headers.set(
        "Vqs-Visibility-Timeout-Seconds",
        visibilityTimeoutSeconds.toString()
      );
    }
    const effectiveDeploymentId = this.getConsumeDeploymentId();
    if (effectiveDeploymentId) {
      headers.set("Vqs-Deployment-Id", effectiveDeploymentId);
    }
    const response = await this.fetch(
      this.buildUrl(queueName, "consumer", consumerGroup, "id", messageId),
      {
        method: "POST",
        headers
      }
    );
    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 404) {
        throw new MessageNotFoundError(messageId);
      }
      if (response.status === 409) {
        let errorData = {};
        try {
          errorData = JSON.parse(errorText);
        } catch {
        }
        if (errorData.originalMessageId) {
          throw new MessageNotAvailableError(
            messageId,
            `This message was a duplicate - use originalMessageId: ${errorData.originalMessageId}`
          );
        }
        throw new MessageNotAvailableError(messageId);
      }
      if (response.status === 410) {
        throw new MessageAlreadyProcessedError(messageId);
      }
      throwCommonHttpError(
        response.status,
        response.statusText,
        errorText,
        "receive message by ID"
      );
    }
    for await (const multipartMessage of parseMultipartStream(response)) {
      const parsedHeaders = parseQueueHeaders(multipartMessage.headers);
      if (!parsedHeaders) {
        await consumeStream(multipartMessage.payload);
        throw new MessageCorruptedError(
          messageId,
          "Missing required queue headers in response"
        );
      }
      const deserializedPayload = await transport.deserialize(
        multipartMessage.payload
      );
      const message = {
        ...parsedHeaders,
        payload: deserializedPayload
      };
      return { message };
    }
    throw new MessageNotFoundError(messageId);
  }
  /**
   * Delete (acknowledge) a message after successful processing.
   *
   * @param options - Delete options
   * @param options.queueName - Topic name
   * @param options.consumerGroup - Consumer group name
   * @param options.receiptHandle - Receipt handle from the received message (must use same deployment ID as receive)
   * @returns Promise indicating deletion success
   * @throws {MessageNotFoundError} When receipt handle not found
   * @throws {MessageNotAvailableError} When receipt handle invalid or message already processed
   * @throws {BadRequestError} When parameters are invalid
   * @throws {UnauthorizedError} When authentication fails
   * @throws {ForbiddenError} When access is denied
   * @throws {InternalServerError} When server encounters an error
   */
  async deleteMessage(options) {
    const { queueName, consumerGroup, receiptHandle } = options;
    const headers = new Headers({
      Authorization: `Bearer ${await this.getToken()}`,
      ...this.customHeaders
    });
    const effectiveDeploymentId = this.getConsumeDeploymentId();
    if (effectiveDeploymentId) {
      headers.set("Vqs-Deployment-Id", effectiveDeploymentId);
    }
    const response = await this.fetch(
      this.buildUrl(
        queueName,
        "consumer",
        consumerGroup,
        "lease",
        receiptHandle
      ),
      {
        method: "DELETE",
        headers
      }
    );
    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 404) {
        throw new MessageNotFoundError(receiptHandle);
      }
      if (response.status === 409) {
        throw new MessageNotAvailableError(
          receiptHandle,
          errorText || "Invalid receipt handle, message not in correct state, or already processed"
        );
      }
      throwCommonHttpError(
        response.status,
        response.statusText,
        errorText,
        "delete message",
        "Missing or invalid receipt handle"
      );
    }
    return { deleted: true };
  }
  /**
   * Extend or change the visibility timeout of a message.
   * Used to prevent message redelivery while still processing.
   *
   * @param options - Visibility options
   * @param options.queueName - Topic name
   * @param options.consumerGroup - Consumer group name
   * @param options.receiptHandle - Receipt handle from the received message (must use same deployment ID as receive)
   * @param options.visibilityTimeoutSeconds - New timeout (min: 0, max: 3600, cannot exceed message expiration)
   * @returns Promise indicating success
   * @throws {MessageNotFoundError} When receipt handle not found
   * @throws {MessageNotAvailableError} When receipt handle invalid or message already processed
   * @throws {BadRequestError} When parameters are invalid
   * @throws {UnauthorizedError} When authentication fails
   * @throws {ForbiddenError} When access is denied
   * @throws {InternalServerError} When server encounters an error
   */
  async changeVisibility(options) {
    const {
      queueName,
      consumerGroup,
      receiptHandle,
      visibilityTimeoutSeconds
    } = options;
    const headers = new Headers({
      Authorization: `Bearer ${await this.getToken()}`,
      "Content-Type": "application/json",
      ...this.customHeaders
    });
    const effectiveDeploymentId = this.getConsumeDeploymentId();
    if (effectiveDeploymentId) {
      headers.set("Vqs-Deployment-Id", effectiveDeploymentId);
    }
    const response = await this.fetch(
      this.buildUrl(
        queueName,
        "consumer",
        consumerGroup,
        "lease",
        receiptHandle
      ),
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ visibilityTimeoutSeconds })
      }
    );
    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 404) {
        throw new MessageNotFoundError(receiptHandle);
      }
      if (response.status === 409) {
        throw new MessageNotAvailableError(
          receiptHandle,
          errorText || "Invalid receipt handle, message not in correct state, or already processed"
        );
      }
      throwCommonHttpError(
        response.status,
        response.statusText,
        errorText,
        "change visibility",
        "Missing receipt handle or invalid visibility timeout"
      );
    }
    return { success: true };
  }
  /**
   * Alternative endpoint for changing message visibility timeout.
   * Uses the /visibility path suffix and expects visibilityTimeoutSeconds in the body.
   * Functionally equivalent to changeVisibility but follows an alternative API pattern.
   *
   * @param options - Options for changing visibility
   * @returns Promise resolving to change visibility response
   */
  async changeVisibilityAlt(options) {
    const {
      queueName,
      consumerGroup,
      receiptHandle,
      visibilityTimeoutSeconds
    } = options;
    const headers = new Headers({
      Authorization: `Bearer ${await this.getToken()}`,
      "Content-Type": "application/json",
      ...this.customHeaders
    });
    const effectiveDeploymentId = this.getConsumeDeploymentId();
    if (effectiveDeploymentId) {
      headers.set("Vqs-Deployment-Id", effectiveDeploymentId);
    }
    const response = await this.fetch(
      this.buildUrl(
        queueName,
        "consumer",
        consumerGroup,
        "lease",
        receiptHandle,
        "visibility"
      ),
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({ visibilityTimeoutSeconds })
      }
    );
    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 404) {
        throw new MessageNotFoundError(receiptHandle);
      }
      if (response.status === 409) {
        throw new MessageNotAvailableError(
          receiptHandle,
          errorText || "Invalid receipt handle, message not in correct state, or already processed"
        );
      }
      throwCommonHttpError(
        response.status,
        response.statusText,
        errorText,
        "change visibility (alt)",
        "Missing receipt handle or invalid visibility timeout"
      );
    }
    return { success: true };
  }
};

// src/consumer-group.ts
var DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 300;
var MIN_VISIBILITY_TIMEOUT_SECONDS = 30;
var MAX_RENEWAL_INTERVAL_SECONDS = 60;
var MIN_RENEWAL_INTERVAL_SECONDS = 10;
var RETRY_INTERVAL_MS = 3e3;
function calculateRenewalInterval(visibilityTimeoutSeconds) {
  return Math.min(
    MAX_RENEWAL_INTERVAL_SECONDS,
    Math.max(MIN_RENEWAL_INTERVAL_SECONDS, visibilityTimeoutSeconds / 5)
  );
}
var ConsumerGroup = class {
  client;
  topicName;
  consumerGroupName;
  visibilityTimeout;
  /**
   * Create a new ConsumerGroup instance.
   *
   * @param client - QueueClient instance to use for API calls (transport is configured on the client)
   * @param topicName - Name of the topic to consume from (pattern: `[A-Za-z0-9_-]+`)
   * @param consumerGroupName - Name of the consumer group (pattern: `[A-Za-z0-9_-]+`)
   * @param options - Optional configuration
   * @param options.visibilityTimeoutSeconds - Message lock duration (default: 300, max: 3600)
   */
  constructor(client, topicName, consumerGroupName, options = {}) {
    this.client = client;
    this.topicName = topicName;
    this.consumerGroupName = consumerGroupName;
    this.visibilityTimeout = Math.max(
      MIN_VISIBILITY_TIMEOUT_SECONDS,
      options.visibilityTimeoutSeconds ?? DEFAULT_VISIBILITY_TIMEOUT_SECONDS
    );
  }
  /**
   * Check if an error is a 4xx client error that should stop retries.
   * 4xx errors indicate the request is fundamentally invalid and retrying won't help.
   * - 409: Ticket mismatch (lost ownership to another consumer)
   * - 404: Message/receipt handle not found
   * - 400, 401, 403: Other client errors
   */
  isClientError(error) {
    return error instanceof MessageNotAvailableError || // 409 - ticket mismatch, lost ownership
    error instanceof MessageNotFoundError || // 404 - receipt handle not found
    error instanceof BadRequestError || // 400 - invalid parameters
    error instanceof UnauthorizedError || // 401 - auth failed
    error instanceof ForbiddenError;
  }
  /**
   * Starts a background loop that periodically extends the visibility timeout for a message.
   *
   * Timing strategy:
   * - Renewal interval: min(60s, max(10s, visibilityTimeout/5))
   * - Extensions request the same duration as the initial visibility timeout
   * - When `visibilityDeadline` is provided (binary mode small body), the first
   *   extension delay is calculated from the time remaining until the deadline
   *   using the same renewal formula, ensuring the first extension fires before
   *   the server-assigned lease expires. Subsequent renewals use the standard interval.
   *
   * Retry strategy:
   * - On transient failures (5xx, network errors): retry every 3 seconds
   * - On 4xx client errors: stop retrying (the lease is lost or invalid)
   *
   * @param receiptHandle - The receipt handle to extend visibility for
   * @param options - Optional configuration
   * @param options.visibilityDeadline - Absolute deadline (from server's `ce-vqsvisibilitydeadline`)
   *   when the current visibility timeout expires. Used to calculate the first extension delay.
   */
  startVisibilityExtension(receiptHandle, options) {
    let isRunning = true;
    let isResolved = false;
    let resolveLifecycle;
    let timeoutId = null;
    const renewalIntervalMs = calculateRenewalInterval(this.visibilityTimeout) * 1e3;
    let firstDelayMs = renewalIntervalMs;
    if (options?.visibilityDeadline) {
      const timeRemainingMs = options.visibilityDeadline.getTime() - Date.now();
      if (timeRemainingMs > 0) {
        const timeRemainingSeconds = timeRemainingMs / 1e3;
        firstDelayMs = calculateRenewalInterval(timeRemainingSeconds) * 1e3;
      } else {
        firstDelayMs = 0;
      }
    }
    const lifecyclePromise = new Promise((resolve) => {
      resolveLifecycle = resolve;
    });
    const safeResolve = () => {
      if (!isResolved) {
        isResolved = true;
        resolveLifecycle();
      }
    };
    const extend = async () => {
      if (!isRunning) {
        safeResolve();
        return;
      }
      try {
        await this.client.changeVisibility({
          queueName: this.topicName,
          consumerGroup: this.consumerGroupName,
          receiptHandle,
          visibilityTimeoutSeconds: this.visibilityTimeout
        });
        if (isRunning) {
          timeoutId = setTimeout(() => extend(), renewalIntervalMs);
        } else {
          safeResolve();
        }
      } catch (error) {
        if (this.isClientError(error)) {
          console.error(
            `Visibility extension failed with client error for receipt handle ${receiptHandle} (stopping retries):`,
            error
          );
          safeResolve();
          return;
        }
        console.error(
          `Failed to extend visibility for receipt handle ${receiptHandle} (will retry in ${RETRY_INTERVAL_MS / 1e3}s):`,
          error
        );
        if (isRunning) {
          timeoutId = setTimeout(() => extend(), RETRY_INTERVAL_MS);
        } else {
          safeResolve();
        }
      }
    };
    timeoutId = setTimeout(() => extend(), firstDelayMs);
    return async (waitForCompletion = false) => {
      isRunning = false;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (waitForCompletion) {
        await lifecyclePromise;
      } else {
        safeResolve();
      }
    };
  }
  async processMessage(message, handler, options) {
    const stopExtension = this.startVisibilityExtension(
      message.receiptHandle,
      options
    );
    try {
      await handler(message.payload, {
        messageId: message.messageId,
        deliveryCount: message.deliveryCount,
        createdAt: message.createdAt,
        topicName: this.topicName,
        consumerGroup: this.consumerGroupName
      });
      await stopExtension();
      await this.client.deleteMessage({
        queueName: this.topicName,
        consumerGroup: this.consumerGroupName,
        receiptHandle: message.receiptHandle
      });
    } catch (error) {
      await stopExtension();
      const transport = this.client.getTransport();
      if (transport.finalize && message.payload !== void 0 && message.payload !== null) {
        try {
          await transport.finalize(message.payload);
        } catch (finalizeError) {
          console.warn("Failed to finalize message payload:", finalizeError);
        }
      }
      throw error;
    }
  }
  /**
   * Process a pre-fetched message directly, without calling `receiveMessageById`.
   *
   * Used by the binary mode (v2beta) small body fast path, where the server
   * pushes the full message payload in the callback request. The message is
   * processed with the same lifecycle guarantees as `consume()`:
   * - Visibility timeout is extended periodically during processing
   * - Message is deleted on successful handler completion
   * - Payload is finalized on error if the transport supports it
   *
   * @param handler - Function to process the message payload and metadata
   * @param message - The complete message including payload and receipt handle
   * @param options - Optional configuration
   * @param options.visibilityDeadline - Absolute deadline when the server-assigned
   *   visibility timeout expires (from `ce-vqsvisibilitydeadline`). Used to
   *   schedule the first visibility extension before the lease expires.
   */
  async consumeMessage(handler, message, options) {
    await this.processMessage(message, handler, options);
  }
  async consume(handler, options) {
    if (options && "messageId" in options) {
      const response = await this.client.receiveMessageById({
        queueName: this.topicName,
        consumerGroup: this.consumerGroupName,
        messageId: options.messageId,
        visibilityTimeoutSeconds: this.visibilityTimeout
      });
      await this.processMessage(response.message, handler);
    } else {
      const limit = options && "limit" in options ? options.limit : 1;
      let messageFound = false;
      for await (const message of this.client.receiveMessages({
        queueName: this.topicName,
        consumerGroup: this.consumerGroupName,
        visibilityTimeoutSeconds: this.visibilityTimeout,
        limit
      })) {
        messageFound = true;
        await this.processMessage(message, handler);
      }
      if (!messageFound) {
        await handler(null, null);
      }
    }
  }
  /**
   * Get the consumer group name
   */
  get name() {
    return this.consumerGroupName;
  }
  /**
   * Get the topic name this consumer group is subscribed to
   */
  get topic() {
    return this.topicName;
  }
};

// src/topic.ts
var Topic = class {
  client;
  topicName;
  /**
   * Create a new Topic instance
   * @param client QueueClient instance to use for API calls (transport is configured on the client)
   * @param topicName Name of the topic to work with
   */
  constructor(client, topicName) {
    this.client = client;
    this.topicName = topicName;
  }
  /**
   * Publish a message to the topic
   * @param payload The data to publish
   * @param options Optional publish options
   * @returns An object containing the message ID
   * @throws {BadRequestError} When request parameters are invalid
   * @throws {UnauthorizedError} When authentication fails
   * @throws {ForbiddenError} When access is denied (environment mismatch)
   * @throws {InternalServerError} When server encounters an error
   */
  async publish(payload, options) {
    const result = await this.client.sendMessage({
      queueName: this.topicName,
      payload,
      idempotencyKey: options?.idempotencyKey,
      retentionSeconds: options?.retentionSeconds,
      delaySeconds: options?.delaySeconds,
      headers: options?.headers
    });
    if (isDevMode()) {
      triggerDevCallbacks(this.topicName, result.messageId);
    }
    return { messageId: result.messageId };
  }
  /**
   * Create a consumer group for this topic
   * @param consumerGroupName Name of the consumer group
   * @param options Optional configuration for the consumer group
   * @returns A ConsumerGroup instance
   */
  consumerGroup(consumerGroupName, options) {
    return new ConsumerGroup(
      this.client,
      this.topicName,
      consumerGroupName,
      options
    );
  }
  /**
   * Get the topic name
   */
  get name() {
    return this.topicName;
  }
};

// src/callback.ts
var CLOUD_EVENT_TYPE_V1BETA = "com.vercel.queue.v1beta";
var CLOUD_EVENT_TYPE_V2BETA = "com.vercel.queue.v2beta";
function matchesWildcardPattern(topicName, pattern) {
  const prefix = pattern.slice(0, -1);
  return topicName.startsWith(prefix);
}
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function parseV1StructuredBody(body, contentType) {
  if (!contentType || !contentType.includes("application/cloudevents+json")) {
    throw new Error(
      "Invalid content type: expected 'application/cloudevents+json'"
    );
  }
  if (!isRecord(body) || !body.type || !body.source || !body.id || !isRecord(body.data)) {
    throw new Error("Invalid CloudEvent: missing required fields");
  }
  if (body.type !== CLOUD_EVENT_TYPE_V1BETA) {
    throw new Error(
      `Invalid CloudEvent type: expected '${CLOUD_EVENT_TYPE_V1BETA}', got '${String(body.type)}'`
    );
  }
  const { data } = body;
  const missingFields = [];
  if (!("queueName" in data)) missingFields.push("queueName");
  if (!("consumerGroup" in data)) missingFields.push("consumerGroup");
  if (!("messageId" in data)) missingFields.push("messageId");
  if (missingFields.length > 0) {
    throw new Error(
      `Missing required CloudEvent data fields: ${missingFields.join(", ")}`
    );
  }
  return {
    queueName: String(data.queueName),
    consumerGroup: String(data.consumerGroup),
    messageId: String(data.messageId)
  };
}
function getHeader(headers, name) {
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
function parseBinaryHeaders(headers) {
  const ceType = getHeader(headers, "ce-type");
  if (ceType !== CLOUD_EVENT_TYPE_V2BETA) {
    throw new Error(
      `Invalid CloudEvent type: expected '${CLOUD_EVENT_TYPE_V2BETA}', got '${ceType}'`
    );
  }
  const queueName = getHeader(headers, "ce-vqsqueuename");
  const consumerGroup = getHeader(headers, "ce-vqsconsumergroup");
  const messageId = getHeader(headers, "ce-vqsmessageid");
  const missingFields = [];
  if (!queueName) missingFields.push("ce-vqsqueuename");
  if (!consumerGroup) missingFields.push("ce-vqsconsumergroup");
  if (!messageId) missingFields.push("ce-vqsmessageid");
  if (missingFields.length > 0) {
    throw new Error(
      `Missing required CloudEvent headers: ${missingFields.join(", ")}`
    );
  }
  const base = {
    queueName,
    consumerGroup,
    messageId
  };
  const receiptHandle = getHeader(headers, "ce-vqsreceipthandle");
  if (!receiptHandle) {
    return base;
  }
  const result = { ...base, receiptHandle };
  const deliveryCount = getHeader(headers, "ce-vqsdeliverycount");
  if (deliveryCount) {
    result.deliveryCount = parseInt(deliveryCount, 10);
  }
  const createdAt = getHeader(headers, "ce-vqscreatedat");
  if (createdAt) {
    result.createdAt = createdAt;
  }
  const contentType = getHeader(headers, "content-type");
  if (contentType) {
    result.contentType = contentType;
  }
  const visibilityDeadline = getHeader(headers, "ce-vqsvisibilitydeadline");
  if (visibilityDeadline) {
    result.visibilityDeadline = visibilityDeadline;
  }
  return result;
}
function parseRawCallback(body, headers) {
  const ceType = getHeader(headers, "ce-type");
  if (ceType === CLOUD_EVENT_TYPE_V2BETA) {
    const result = parseBinaryHeaders(headers);
    if ("receiptHandle" in result) {
      result.parsedPayload = body;
    }
    return result;
  }
  return parseV1StructuredBody(body, getHeader(headers, "content-type"));
}
async function parseCallback(request) {
  const ceType = request.headers.get("ce-type");
  if (ceType === CLOUD_EVENT_TYPE_V2BETA) {
    const result = parseBinaryHeaders(request.headers);
    if ("receiptHandle" in result && request.body) {
      result.rawBody = request.body;
    }
    return result;
  }
  let body;
  try {
    body = await request.json();
  } catch {
    throw new Error("Failed to parse CloudEvent from request body");
  }
  const headers = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return parseRawCallback(body, headers);
}
async function handleCallback(handler, request, options) {
  const { queueName, consumerGroup, messageId } = request;
  const client = options?.client || new QueueClient();
  const topic = new Topic(client, queueName);
  const cg = topic.consumerGroup(
    consumerGroup,
    options?.visibilityTimeoutSeconds !== void 0 ? { visibilityTimeoutSeconds: options.visibilityTimeoutSeconds } : void 0
  );
  if ("receiptHandle" in request) {
    const transport = client.getTransport();
    let payload;
    if (request.rawBody) {
      payload = await transport.deserialize(request.rawBody);
    } else if (request.parsedPayload !== void 0) {
      payload = request.parsedPayload;
    } else {
      throw new Error(
        "Binary mode callback with receipt handle is missing payload"
      );
    }
    const message = {
      messageId,
      payload,
      deliveryCount: request.deliveryCount ?? 1,
      createdAt: request.createdAt ? new Date(request.createdAt) : /* @__PURE__ */ new Date(),
      contentType: request.contentType ?? transport.contentType,
      receiptHandle: request.receiptHandle
    };
    const visibilityDeadline = request.visibilityDeadline ? new Date(request.visibilityDeadline) : void 0;
    await cg.consumeMessage(handler, message, { visibilityDeadline });
  } else {
    await cg.consume(handler, { messageId });
  }
}

// src/web.ts
function handleCallback2(handler, options) {
  return async (request) => {
    try {
      const parsed = await parseCallback(request);
      await handleCallback(handler, parsed, options);
      return Response.json({ status: "success" });
    } catch (error) {
      console.error("Queue callback error:", error);
      if (error instanceof Error && (error.message.includes("Invalid content type") || error.message.includes("Invalid CloudEvent") || error.message.includes("Missing required CloudEvent") || error.message.includes("Failed to parse CloudEvent") || error.message.includes("Binary mode callback"))) {
        return Response.json({ error: error.message }, { status: 400 });
      }
      return Response.json(
        { error: "Failed to process queue message" },
        { status: 500 }
      );
    }
  };
}

export { DuplicateMessageError$1 as D, JsonTransport$1 as J, QueueClient$1 as Q, handleCallback2 as h };
