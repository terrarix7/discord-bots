import { webcrypto } from 'node:crypto';
import { a as distExports } from '../@vercel/oidc.mjs';
import { o as object, s as string, n as number, u as union, _ as _instanceof, a as any, z } from '../../../_libs/zod.mjs';
import { h as handleCallback2, Q as QueueClient, D as DuplicateMessageError } from '../@vercel/queue.mjs';
import os from 'node:os';
import { inspect } from 'node:util';
import { W as WorkflowAPIError, f as WorkflowRunNotFoundError } from './errors.mjs';
import { e as encode, d as decode } from '../../../_libs/cbor-x.mjs';
import { f as StructuredErrorSchema, M as MessageId, V as ValidQueueName, Q as QueuePayloadSchema, P as PaginatedResponseSchema, g as WorkflowRunBaseSchema, d as StepSchema, E as EventSchema, h as EventTypeSchema, b as HookSchema, c as WorkflowRunSchema } from './world.mjs';

/**
 * Vercel-specific key management for workflow encryption.
 *
 * This module handles:
 * - HKDF key derivation (deployment key + projectId + runId → per-run key)
 * - Cross-deployment key retrieval via the Vercel API
 *
 * The actual AES-GCM encrypt/decrypt operations are in @workflow/core/encryption
 * which is browser-compatible. This module is Node.js only (uses node:crypto
 * for HKDF and the Vercel API for key retrieval).
 */
const KEY_BYTES = 32; // 256 bits = 32 bytes (AES-256)
/**
 * Derive a per-run AES-256 encryption key using HKDF-SHA256.
 *
 * The derivation uses `projectId|runId` as the HKDF info parameter,
 * ensuring that each run has a unique encryption key even when sharing
 * the same deployment key.
 *
 * @param deploymentKey - Raw 32-byte deployment key
 * @param projectId - Vercel project ID for context isolation
 * @param runId - Workflow run ID for per-run key isolation
 * @returns Raw 32-byte AES-256 key
 */
async function deriveRunKey(deploymentKey, projectId, runId) {
    if (deploymentKey.length !== KEY_BYTES) {
        throw new Error(`Invalid deployment key length: expected ${KEY_BYTES} bytes for AES-256, got ${deploymentKey.length} bytes`);
    }
    if (!projectId || typeof projectId !== 'string') {
        throw new Error('projectId must be a non-empty string');
    }
    const baseKey = await webcrypto.subtle.importKey('raw', deploymentKey, 'HKDF', false, ['deriveBits']);
    const info = new TextEncoder().encode(`${projectId}|${runId}`);
    // Zero salt is acceptable per RFC 5869 Section 3.1 when the input key
    // material has high entropy (as is the case with our random deployment key).
    // The `info` parameter provides per-run context separation.
    const derivedBits = await webcrypto.subtle.deriveBits({
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(32),
        info,
    }, baseKey, KEY_BYTES * 8 // bits
    );
    return new Uint8Array(derivedBits);
}
/**
 * Fetch the per-run encryption key from the Vercel API.
 *
 * The API performs HKDF-SHA256 derivation server-side, so the raw
 * deployment key never leaves the API boundary. The returned key
 * is ready-to-use for AES-GCM encrypt/decrypt operations.
 *
 * Uses OIDC token authentication (for cross-deployment runtime calls like
 * resumeHook) or falls back to VERCEL_TOKEN (for external tooling like o11y).
 *
 * @param deploymentId - The deployment ID that holds the base key material
 * @param projectId - The project ID for HKDF context isolation
 * @param runId - The workflow run ID for per-run key derivation
 * @param options.token - Auth token (from config). Falls back to OIDC or VERCEL_TOKEN.
 * @returns Derived 32-byte per-run AES-256 key
 */
async function fetchRunKey(deploymentId, projectId, runId, options) {
    // Authenticate via provided token (CLI/config), OIDC token (runtime),
    // or VERCEL_TOKEN env var (external tooling)
    const oidcToken = await distExports.getVercelOidcToken().catch(() => null);
    const token = options?.token ?? oidcToken ?? process.env.VERCEL_TOKEN;
    if (!token) {
        throw new Error('Cannot fetch run key: no OIDC token or VERCEL_TOKEN available');
    }
    const params = new URLSearchParams({ projectId, runId });
    const response = await fetch(`https://api.vercel.com/v1/workflow/run-key/${deploymentId}?${params}`, {
        headers: {
            Authorization: `Bearer ${token}`,
        },
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch run key for ${runId} (deployment ${deploymentId}): HTTP ${response.status}`);
    }
    const data = await response.json();
    const result = object({ key: string() }).safeParse(data);
    if (!result.success) {
        throw new Error('Invalid response from Vercel API, missing "key" field');
    }
    return Buffer.from(result.data.key, 'base64');
}
/**
 * Create the `getEncryptionKeyForRun` implementation for a Vercel World.
 *
 * Resolves the per-run AES-256 key by either:
 * - Deriving it locally via HKDF when the run belongs to the current deployment
 * - Fetching it from the Vercel API when the run belongs to a different deployment
 *
 * @param projectId - Vercel project ID for HKDF context isolation
 * @param token - Optional auth token from config
 * @returns The `getEncryptionKeyForRun` function, or `undefined` if no projectId
 */
function createGetEncryptionKeyForRun(projectId, token) {
    if (!projectId)
        return undefined;
    const currentDeploymentId = process.env.VERCEL_DEPLOYMENT_ID;
    // Parse the local deployment key from env (lazy, only when encryption is used)
    let localDeploymentKey;
    function getLocalDeploymentKey() {
        if (localDeploymentKey)
            return localDeploymentKey;
        const deploymentKeyBase64 = process.env.VERCEL_DEPLOYMENT_KEY;
        if (!deploymentKeyBase64)
            return undefined;
        localDeploymentKey = Buffer.from(deploymentKeyBase64, 'base64');
        return localDeploymentKey;
    }
    return async function getEncryptionKeyForRun(run, context) {
        const runId = typeof run === 'string' ? run : run.runId;
        const deploymentId = typeof run === 'string'
            ? context?.deploymentId
            : run.deploymentId;
        // Same deployment, or no deploymentId provided (e.g., start() on
        // current deployment, or step-handler during same-deployment execution)
        // → use local deployment key + local HKDF derivation
        if (!deploymentId || deploymentId === currentDeploymentId) {
            const localKey = getLocalDeploymentKey();
            if (!localKey)
                return undefined;
            return deriveRunKey(localKey, projectId, runId);
        }
        // Different deployment — fetch the derived per-run key from the
        // Vercel API. The API performs HKDF derivation server-side so the
        // raw deployment key never leaves the API boundary.
        // Covers cross-deployment resumeHook() (OIDC auth) and o11y
        // tooling reading data from other deployments (VERCEL_TOKEN).
        return fetchRunKey(deploymentId, projectId, runId, { token });
    };
}

// Lazy load OpenTelemetry API to make it optional
let otelApiPromise = null;
async function getOtelApi() {
    if (!otelApiPromise) {
        otelApiPromise = import('@opentelemetry/api').catch(() => null);
    }
    return otelApiPromise;
}
let tracerPromise = null;
async function getTracer() {
    if (!tracerPromise) {
        tracerPromise = getOtelApi().then((otel) => otel ? otel.trace.getTracer('workflow') : null);
    }
    return tracerPromise;
}
/**
 * Wrap an async function with a trace span.
 * No-op if OpenTelemetry is not available.
 */
async function trace(spanName, ...args) {
    const [tracer, otel] = await Promise.all([getTracer(), getOtelApi()]);
    const { fn, opts } = typeof args[0] === 'function'
        ? { fn: args[0], opts: {} }
        : { fn: args[1], opts: args[0] };
    if (!fn)
        throw new Error('Function to trace must be provided');
    if (!tracer || !otel) {
        return await fn();
    }
    return tracer.startActiveSpan(spanName, opts, async (span) => {
        try {
            const result = await fn(span);
            span.setStatus({ code: otel.SpanStatusCode.OK });
            return result;
        }
        catch (e) {
            span.setStatus({
                code: otel.SpanStatusCode.ERROR,
                message: e.message,
            });
            throw e;
        }
        finally {
            span.end();
        }
    });
}
/**
 * Get SpanKind enum value by name.
 * Returns undefined if OpenTelemetry is not available.
 */
async function getSpanKind(field) {
    const otel = await getOtelApi();
    if (!otel)
        return undefined;
    return otel.SpanKind[field];
}
// Semantic conventions for World/Storage tracing
// Standard OTEL conventions: https://opentelemetry.io/docs/specs/semconv/http/http-spans/
function SemanticConvention(...names) {
    return (value) => Object.fromEntries(names.map((name) => [name, value]));
}
/** HTTP request method (standard OTEL: http.request.method) */
const HttpRequestMethod = SemanticConvention('http.request.method');
/** Full URL of the request (standard OTEL: url.full) */
const UrlFull = SemanticConvention('url.full');
/** Server hostname (standard OTEL: server.address) */
const ServerAddress = SemanticConvention('server.address');
/** Server port (standard OTEL: server.port) */
const ServerPort = SemanticConvention('server.port');
/** HTTP response status code (standard OTEL: http.response.status_code) */
const HttpResponseStatusCode = SemanticConvention('http.response.status_code');
/** Error type when request fails (standard OTEL: error.type) */
const ErrorType = SemanticConvention('error.type');
/** Format used for parsing response body (cbor or json) */
const WorldParseFormat = SemanticConvention('workflow.world.parse.format');
// RPC/Peer Service attributes - For service maps and dependency tracking
// See: https://opentelemetry.io/docs/specs/semconv/rpc/rpc-spans/
/** The remote service name for Datadog service maps (Datadog-specific: peer.service) */
const PeerService = SemanticConvention('peer.service');
/** RPC system identifier (standard OTEL: rpc.system) */
const RpcSystem = SemanticConvention('rpc.system');
/** RPC service name (standard OTEL: rpc.service) */
const RpcService = SemanticConvention('rpc.service');
/** RPC method name (standard OTEL: rpc.method) */
const RpcMethod = SemanticConvention('rpc.method');

// Generated by genversion.
const version = '4.1.0-beta.34';

const DEFAULT_RESOLVE_DATA_OPTION = 'all';
/**
 * Helper to deserialize error field from the backend into a StructuredError object.
 * Handles multiple formats from the backend:
 * - If error is already a structured object → validate and use directly
 * - If error is a JSON string with {message, stack, code} → parse into StructuredError
 * - If error is a plain string → treat as error message with no stack
 * - If no error → undefined
 *
 * This function transforms objects from wire format (where error may be a JSON string
 * or already structured) to domain format (where error is a StructuredError object).
 * The generic type parameter should be the expected output type (WorkflowRun or Step).
 *
 * Note: The type assertion is necessary because the wire format types from Zod schemas
 * have `error?: string | StructuredError` while the domain types have complex error types
 * (e.g., discriminated unions with `error: void` or `error: StructuredError` depending on
 * status), but the transformation preserves all other fields correctly.
 */
function deserializeError(obj) {
    const { error, ...rest } = obj;
    if (!error) {
        return obj;
    }
    // If error is already an object (new format), validate and use directly
    if (typeof error === 'object' && error !== null) {
        const result = StructuredErrorSchema.safeParse(error);
        if (result.success) {
            return {
                ...rest,
                error: {
                    message: result.data.message,
                    stack: result.data.stack,
                    code: result.data.code,
                },
            };
        }
        // Fall through to treat as unknown format
    }
    // If error is a string, try to parse as structured error JSON
    if (typeof error === 'string') {
        try {
            const parsed = StructuredErrorSchema.parse(JSON.parse(error));
            return {
                ...rest,
                error: {
                    message: parsed.message,
                    stack: parsed.stack,
                    code: parsed.code,
                },
            };
        }
        catch {
            // Backwards compatibility: error is just a plain string
            return {
                ...rest,
                error: {
                    message: error,
                },
            };
        }
    }
    // Unknown format - return as-is and let downstream handle it
    return obj;
}
const getUserAgent = () => {
    const deploymentId = process.env.VERCEL_DEPLOYMENT_ID;
    if (deploymentId) {
        return `@workflow/world-vercel/${version} node-${process.version} ${os.platform()} (${os.arch()}) ${deploymentId}`;
    }
    return `@workflow/world-vercel/${version} node-${process.version} ${os.platform()} (${os.arch()})`;
};
const getHttpUrl = (config) => {
    const projectConfig = config?.projectConfig;
    const defaultHost = 'https://vercel-workflow.com';
    const customProxyUrl = process.env.WORKFLOW_VERCEL_BACKEND_URL;
    const defaultProxyUrl = 'https://api.vercel.com/v1/workflow';
    // Use proxy when we have project config (for authentication via Vercel API)
    const usingProxy = Boolean(projectConfig?.projectId && projectConfig?.teamId);
    // When using proxy, requests go through api.vercel.com (with x-vercel-workflow-api-url header if override is set)
    // When not using proxy, use the default workflow-server URL (with /api path appended)
    const baseUrl = usingProxy
        ? customProxyUrl || defaultProxyUrl
        : `${defaultHost}/api`;
    return { baseUrl, usingProxy };
};
const getHeaders = (config, options) => {
    const projectConfig = config?.projectConfig;
    const headers = new Headers(config?.headers);
    headers.set('User-Agent', getUserAgent());
    if (projectConfig) {
        headers.set('x-vercel-environment', projectConfig.environment || 'production');
        if (projectConfig.projectId) {
            headers.set('x-vercel-project-id', projectConfig.projectId);
        }
        if (projectConfig.teamId) {
            headers.set('x-vercel-team-id', projectConfig.teamId);
        }
    }
    return headers;
};
async function getHttpConfig(config) {
    const { baseUrl, usingProxy } = getHttpUrl(config);
    const headers = getHeaders(config);
    const token = config?.token ?? (await distExports.getVercelOidcToken());
    if (token) {
        headers.set('Authorization', `Bearer ${token}`);
    }
    return { baseUrl, headers, usingProxy };
}
async function makeRequest({ endpoint, options = {}, config = {}, schema, data, }) {
    const method = options.method || 'GET';
    const { baseUrl, headers } = await getHttpConfig(config);
    const url = `${baseUrl}${endpoint}`;
    // Parse server address and port from URL for OTEL attributes
    let serverAddress;
    let serverPort;
    try {
        const parsedUrl = new URL(url);
        serverAddress = parsedUrl.hostname;
        serverPort = parsedUrl.port
            ? parseInt(parsedUrl.port, 10)
            : parsedUrl.protocol === 'https:'
                ? 443
                : 80;
    }
    catch {
        // URL parsing failed, skip these attributes
    }
    // Standard OTEL span name for HTTP client: "{method}"
    // See: https://opentelemetry.io/docs/specs/semconv/http/http-spans/#name
    return trace(`http ${method}`, { kind: await getSpanKind('CLIENT') }, async (span) => {
        // Set standard OTEL HTTP client attributes
        span?.setAttributes({
            ...HttpRequestMethod(method),
            ...UrlFull(url),
            ...(serverAddress && ServerAddress(serverAddress)),
            ...(serverPort && ServerPort(serverPort)),
            // Peer service for Datadog service maps
            ...PeerService('workflow-server'),
            ...RpcSystem('http'),
            ...RpcService('workflow-server'),
        });
        headers.set('Accept', 'application/cbor');
        // NOTE: Add a unique header to bypass RSC request memoization.
        // See: https://github.com/vercel/workflow/issues/618
        headers.set('X-Request-Time', Date.now().toString());
        // Encode body as CBOR if data is provided
        let body;
        if (data !== undefined) {
            headers.set('Content-Type', 'application/cbor');
            body = encode(data);
        }
        const request = new Request(url, {
            ...options,
            body,
            headers,
        });
        const response = await fetch(request);
        span?.setAttributes({
            ...HttpResponseStatusCode(response.status),
        });
        if (!response.ok) {
            const errorData = await parseResponseBody(response)
                .then((r) => r.data)
                .catch(() => ({}));
            if (process.env.DEBUG === '1') {
                const stringifiedHeaders = Array.from(headers.entries())
                    .map(([key, value]) => `-H "${key}: ${value}"`)
                    .join(' ');
                console.error(`Failed to fetch, reproduce with:\ncurl -X ${request.method} ${stringifiedHeaders} "${url}"`);
            }
            // Parse Retry-After header for 429 responses (value is in seconds)
            let retryAfter;
            if (response.status === 429) {
                const retryAfterHeader = response.headers.get('Retry-After');
                if (retryAfterHeader) {
                    const parsed = parseInt(retryAfterHeader, 10);
                    if (!Number.isNaN(parsed)) {
                        retryAfter = parsed;
                    }
                }
            }
            const error = new WorkflowAPIError(errorData.message ||
                `${request.method} ${endpoint} -> HTTP ${response.status}: ${response.statusText}`, { url, status: response.status, code: errorData.code, retryAfter });
            // Record error attributes per OTEL conventions
            span?.setAttributes({
                ...ErrorType(errorData.code || `HTTP ${response.status}`),
            });
            span?.recordException?.(error);
            throw error;
        }
        // Parse the response body (CBOR or JSON) with tracing
        let parseResult;
        try {
            parseResult = await trace('world.parse', async (parseSpan) => {
                const result = await parseResponseBody(response);
                // Extract format and size from debug context for attributes
                const contentType = response.headers.get('Content-Type') || '';
                const isCbor = contentType.includes('application/cbor');
                parseSpan?.setAttributes({
                    ...WorldParseFormat(isCbor ? 'cbor' : 'json'),
                });
                return result;
            });
        }
        catch (error) {
            const contentType = response.headers.get('Content-Type') || 'unknown';
            throw new WorkflowAPIError(`Failed to parse response body for ${request.method} ${endpoint} (Content-Type: ${contentType}):\n\n${error}`, { url, cause: error });
        }
        // Validate against the schema with tracing
        const result = await trace('world.validate', async () => {
            const validationResult = schema.safeParse(parseResult.data);
            if (!validationResult.success) {
                throw new WorkflowAPIError(`Schema validation failed for ${request.method} ${endpoint}:\n\n${validationResult.error}\n\nResponse context: ${parseResult.getDebugContext()}`, { url, cause: validationResult.error });
            }
            return validationResult.data;
        });
        return result;
    });
}
/** Max length for response preview in error messages */
const MAX_PREVIEW_LENGTH = 500;
/**
 * Create a truncated preview of data for error messages.
 */
function createPreview(data) {
    const str = inspect(data, { depth: 3, maxArrayLength: 10, breakLength: 120 });
    return str.length > MAX_PREVIEW_LENGTH
        ? `${str.slice(0, MAX_PREVIEW_LENGTH)}...`
        : str;
}
/**
 * Parse response body based on Content-Type header.
 * Supports both CBOR and JSON responses.
 * Returns parsed data along with a lazy debug context generator for error reporting.
 */
async function parseResponseBody(response) {
    const contentType = response.headers.get('Content-Type') || '';
    if (contentType.includes('application/cbor')) {
        const buffer = await response.arrayBuffer();
        const data = decode(new Uint8Array(buffer));
        return {
            data,
            getDebugContext: () => `Content-Type: ${contentType}, ${buffer.byteLength} bytes (CBOR), preview: ${createPreview(data)}`,
        };
    }
    // Fall back to JSON parsing
    const text = await response.text();
    const data = JSON.parse(text);
    return {
        data,
        getDebugContext: () => `Content-Type: ${contentType}, ${text.length} bytes, preview: ${createPreview(data)}`,
    };
}

const MessageWrapper = object({
    payload: QueuePayloadSchema,
    queueName: ValidQueueName,
    /**
     * The deployment ID to use when re-enqueueing the message.
     * This ensures the message is processed by the same deployment.
     */
    deploymentId: string().optional(),
});
/**
 * Sleep Implementation via Message Delays
 *
 * VQS v3 supports `delaySeconds` which delays the initial delivery of a message.
 * We use this for implementing sleep() by creating a new message with the delay,
 * rather than using visibility timeouts on the same message.
 *
 * Benefits of this approach:
 * - Fresh 24-hour lifetime with each message (no message age tracking needed)
 * - Messages fire at the scheduled time (no short-circuit + recheck pattern)
 * - Simpler conceptual model: messages are triggers with delivery schedules
 *
 * For sleeps > 24 hours (max delay), we use chaining:
 * 1. Schedule message with max delay (~23h, leaving buffer)
 * 2. When it fires, workflow checks if sleep is complete
 * 3. If not, another delayed message is queued for remaining time
 * 4. Process repeats until the full sleep duration has elapsed
 *
 * The workflow runtime handles this via event sourcing - the `wait_created` event
 * stores the `resumeAt` timestamp, and on each invocation the runtime checks
 * if `now >= resumeAt`. If not, it returns another `timeoutSeconds`.
 *
 * These constants can be overridden via environment variables for testing.
 */
const MAX_DELAY_SECONDS = Number(process.env.VERCEL_QUEUE_MAX_DELAY_SECONDS || 82800 // 23 hours - leave 1h buffer before 24h retention limit
);
/**
 * Extract known identifiers from a queue payload and return them as VQS headers.
 * This ensures observability headers are always set without relying on callers.
 */
function getHeadersFromPayload(payload) {
    const headers = {};
    if ('runId' in payload && typeof payload.runId === 'string') {
        headers['x-workflow-run-id'] = payload.runId;
    }
    if ('workflowRunId' in payload && typeof payload.workflowRunId === 'string') {
        headers['x-workflow-run-id'] = payload.workflowRunId;
    }
    if ('stepId' in payload && typeof payload.stepId === 'string') {
        headers['x-workflow-step-id'] = payload.stepId;
    }
    return Object.keys(headers).length > 0 ? headers : undefined;
}
function createQueue(config) {
    const { baseUrl, usingProxy } = getHttpUrl(config);
    const headers = getHeaders(config);
    const clientOptions = {
        baseUrl: usingProxy ? baseUrl : undefined,
        // The proxy will strip `/queues` from the path, and add `/api` in front,
        // so this ends up being `/api/v3/topic` when arriving at the queue server,
        // which is the same as the default basePath in VQS client.
        basePath: usingProxy ? '/queues/v3/topic' : undefined,
        token: usingProxy ? config?.token : undefined,
        headers: Object.fromEntries(headers.entries()),
    };
    const queue = async (queueName, payload, opts) => {
        // Check if we have a deployment ID either from options or environment
        const deploymentId = opts?.deploymentId ?? process.env.VERCEL_DEPLOYMENT_ID;
        if (!deploymentId) {
            throw new Error('No deploymentId provided and VERCEL_DEPLOYMENT_ID environment variable is not set. ' +
                'Queue messages require a deployment ID to route correctly. ' +
                'Either set VERCEL_DEPLOYMENT_ID or provide deploymentId in options.');
        }
        const client = new QueueClient({
            ...clientOptions,
            deploymentId,
        });
        // zod v3 doesn't have the `encode` method. We only support zod v4 officially,
        // but codebases that pin zod v3 are still common.
        const hasEncoder = typeof MessageWrapper.encode === 'function';
        if (!hasEncoder) {
            console.warn('Using zod v3 compatibility mode for queue() calls - this may not work as expected');
        }
        const encoder = hasEncoder
            ? MessageWrapper.encode
            : (data) => data;
        const encoded = encoder({
            payload,
            queueName,
            // Store deploymentId in the message so it can be preserved when re-enqueueing
            deploymentId: opts?.deploymentId,
        });
        const sanitizedQueueName = queueName.replace(/[^A-Za-z0-9-_]/g, '-');
        try {
            const { messageId } = await client.sendMessage({
                queueName: sanitizedQueueName,
                payload: encoded,
                idempotencyKey: opts?.idempotencyKey,
                delaySeconds: opts?.delaySeconds,
                headers: {
                    ...getHeadersFromPayload(payload),
                    ...opts?.headers,
                },
            });
            return { messageId: MessageId.parse(messageId) };
        }
        catch (error) {
            // Silently handle idempotency key conflicts - the message was already queued.
            // This matches the behavior of world-local and world-postgres.
            if (error instanceof DuplicateMessageError) {
                // Return a placeholder messageId since the original is not available from the error.
                // Callers using idempotency keys shouldn't depend on the returned messageId.
                return {
                    messageId: MessageId.parse(`msg_duplicate_${error.idempotencyKey ?? opts?.idempotencyKey ?? 'unknown'}`),
                };
            }
            throw error;
        }
    };
    const createQueueHandler = (_prefix, handler) => {
        return handleCallback2(async (message, metadata) => {
            if (!message || !metadata) {
                return;
            }
            const { payload, queueName, deploymentId } = MessageWrapper.parse(message);
            const result = await handler(payload, {
                queueName,
                messageId: MessageId.parse(metadata.messageId),
                attempt: metadata.deliveryCount,
            });
            if (typeof result?.timeoutSeconds === 'number') {
                // Send new message with delay, then acknowledge the current one.
                // Clamp to max delay (23h) - for longer sleeps, the workflow will chain
                // multiple delayed messages until the full sleep duration has elapsed.
                const delaySeconds = Math.min(result.timeoutSeconds, MAX_DELAY_SECONDS);
                // Send new message with delay BEFORE acknowledging current message.
                // This ensures crash safety: if process dies after send but before ack,
                // we may get a duplicate invocation but won't lose the scheduled wakeup.
                await queue(queueName, payload, { deploymentId, delaySeconds });
            }
        }, { client: new QueueClient(clientOptions) });
    };
    const getDeploymentId = async () => {
        const deploymentId = process.env.VERCEL_DEPLOYMENT_ID;
        if (!deploymentId) {
            throw new Error('VERCEL_DEPLOYMENT_ID environment variable is not set');
        }
        return deploymentId;
    };
    return { queue, createQueueHandler, getDeploymentId };
}

/**
 * Wire format schema for workflow runs coming from the backend.
 * The backend may return error either as:
 * - A JSON string (legacy format) that needs deserialization
 * - An already structured object (new format) with { message, stack?, code? }
 *
 * This is used for validation in makeRequest(), then deserializeError()
 * normalizes both formats into the expected StructuredError object.
 */
const WorkflowRunWireBaseSchema = WorkflowRunBaseSchema.omit({
    error: true,
}).extend({
    // Backend returns error as either a JSON string or structured object
    error: union([string(), StructuredErrorSchema]).optional(),
});
// Wire schema for resolved data (full input/output)
const WorkflowRunWireSchema = WorkflowRunWireBaseSchema;
// Wire schema for lazy mode with refs instead of data
// input/output can be Uint8Array (v2) or any JSON (legacy v1)
const WorkflowRunWireWithRefsSchema = WorkflowRunWireBaseSchema.omit({
    input: true,
    output: true,
}).extend({
    // We discard the results of the refs, so we don't care about the type here
    inputRef: any().optional(),
    outputRef: any().optional(),
    // Accept both Uint8Array (v2 format) and any (legacy v1 JSON format)
    input: union([_instanceof(Uint8Array), any()]).optional(),
    output: union([_instanceof(Uint8Array), any()]).optional(),
    blobStorageBytes: number().optional(),
    streamStorageBytes: number().optional(),
});
// Implementation
function filterRunData(run, resolveData) {
    if (resolveData === 'none') {
        const { inputRef: _inputRef, outputRef: _outputRef, ...rest } = run;
        const deserialized = deserializeError(rest);
        return {
            ...deserialized,
            input: undefined,
            output: undefined,
        };
    }
    return deserializeError(run);
}
async function listWorkflowRuns(params = {}, config) {
    const { workflowName, status, pagination, resolveData = DEFAULT_RESOLVE_DATA_OPTION, } = params;
    const searchParams = new URLSearchParams();
    if (workflowName)
        searchParams.set('workflowName', workflowName);
    if (status)
        searchParams.set('status', status);
    if (pagination?.limit)
        searchParams.set('limit', pagination.limit.toString());
    if (pagination?.cursor)
        searchParams.set('cursor', pagination.cursor);
    if (pagination?.sortOrder)
        searchParams.set('sortOrder', pagination.sortOrder);
    // Map resolveData to internal RemoteRefBehavior
    const remoteRefBehavior = resolveData === 'none' ? 'lazy' : 'resolve';
    searchParams.set('remoteRefBehavior', remoteRefBehavior);
    const queryString = searchParams.toString();
    const endpoint = `/v2/runs${queryString ? `?${queryString}` : ''}`;
    const response = (await makeRequest({
        endpoint,
        options: { method: 'GET' },
        config,
        schema: PaginatedResponseSchema(remoteRefBehavior === 'lazy'
            ? WorkflowRunWireWithRefsSchema
            : WorkflowRunWireSchema),
    }));
    return {
        ...response,
        data: response.data.map((run) => filterRunData(run, resolveData)),
    };
}
async function createWorkflowRunV1(data, config) {
    const run = await makeRequest({
        endpoint: '/v1/runs/create',
        options: { method: 'POST' },
        data,
        config,
        schema: WorkflowRunWireSchema,
    });
    return deserializeError(run);
}
async function getWorkflowRun(id, params, config) {
    const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
    const remoteRefBehavior = resolveData === 'none' ? 'lazy' : 'resolve';
    const searchParams = new URLSearchParams();
    searchParams.set('remoteRefBehavior', remoteRefBehavior);
    const queryString = searchParams.toString();
    const endpoint = `/v2/runs/${id}${queryString ? `?${queryString}` : ''}`;
    try {
        const run = await makeRequest({
            endpoint,
            options: { method: 'GET' },
            config,
            schema: (remoteRefBehavior === 'lazy'
                ? WorkflowRunWireWithRefsSchema
                : WorkflowRunWireSchema),
        });
        return filterRunData(run, resolveData);
    }
    catch (error) {
        if (error instanceof WorkflowAPIError && error.status === 404) {
            throw new WorkflowRunNotFoundError(id);
        }
        throw error;
    }
}
async function cancelWorkflowRunV1(id, params, config) {
    const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
    const remoteRefBehavior = resolveData === 'none' ? 'lazy' : 'resolve';
    const searchParams = new URLSearchParams();
    searchParams.set('remoteRefBehavior', remoteRefBehavior);
    const queryString = searchParams.toString();
    const endpoint = `/v1/runs/${id}/cancel${queryString ? `?${queryString}` : ''}`;
    try {
        const run = await makeRequest({
            endpoint,
            options: { method: 'PUT' },
            config,
            schema: (remoteRefBehavior === 'lazy'
                ? WorkflowRunWireWithRefsSchema
                : WorkflowRunWireSchema),
        });
        return filterRunData(run, resolveData);
    }
    catch (error) {
        if (error instanceof WorkflowAPIError && error.status === 404) {
            throw new WorkflowRunNotFoundError(id);
        }
        throw error;
    }
}

/**
 * Wire format schema for steps coming from the backend.
 * Handles error deserialization from wire format.
 */
const StepWireSchema = StepSchema.omit({
    error: true,
}).extend({
    // Backend returns error either as:
    // - A JSON string (legacy/lazy mode)
    // - An object {message, stack} (when errorRef is resolved)
    // This will be deserialized and mapped to error
    error: union([
        string(),
        object({
            message: string(),
            stack: string().optional(),
            code: string().optional(),
        }),
    ])
        .optional(),
    errorRef: any().optional(),
});
// Wire schema for lazy mode with refs instead of data
const StepWireWithRefsSchema = StepWireSchema.omit({
    input: true,
    output: true,
}).extend({
    // We discard the results of the refs, so we don't care about the type here
    inputRef: any().optional(),
    outputRef: any().optional(),
    input: _instanceof(Uint8Array).optional(),
    output: _instanceof(Uint8Array).optional(),
});
/**
 * Transform step from wire format to Step interface format.
 * Maps:
 * - error/errorRef → error (deserializing JSON string to StructuredError)
 */
function deserializeStep(wireStep) {
    const { error, errorRef, ...rest } = wireStep;
    const result = {
        ...rest,
    };
    // Deserialize error to StructuredError
    // The backend returns error as:
    // - error: JSON string (legacy) or object (when resolved)
    // - errorRef: resolved object {message, stack} when remoteRefBehavior=resolve
    const errorSource = error ?? errorRef;
    if (errorSource) {
        if (typeof errorSource === 'string') {
            try {
                const parsed = JSON.parse(errorSource);
                if (typeof parsed === 'object' && parsed.message !== undefined) {
                    result.error = {
                        message: parsed.message,
                        stack: parsed.stack,
                        code: parsed.code,
                    };
                }
                else {
                    // Parsed but not an object with message
                    result.error = { message: String(parsed) };
                }
            }
            catch {
                // Not JSON, treat as plain string
                result.error = { message: errorSource };
            }
        }
        else if (typeof errorSource === 'object' && errorSource !== null) {
            // Already an object (from resolved ref)
            result.error = {
                message: errorSource.message ?? 'Unknown error',
                stack: errorSource.stack,
                code: errorSource.code,
            };
        }
    }
    return result;
}
// Implementation - when resolveData='none', returns Step with input/output set to undefined
// to match other World implementations (world-local, world-postgres)
function filterStepData(step, resolveData) {
    if (resolveData === 'none') {
        const { inputRef: _inputRef, outputRef: _outputRef, ...rest } = step;
        const deserialized = deserializeStep(rest);
        return {
            ...deserialized,
            input: undefined,
            output: undefined,
        };
    }
    return deserializeStep(step);
}
async function listWorkflowRunSteps(params, config) {
    const { runId, pagination, resolveData = DEFAULT_RESOLVE_DATA_OPTION, } = params;
    const searchParams = new URLSearchParams();
    if (pagination?.cursor)
        searchParams.set('cursor', pagination.cursor);
    if (pagination?.limit)
        searchParams.set('limit', pagination.limit.toString());
    if (pagination?.sortOrder)
        searchParams.set('sortOrder', pagination.sortOrder);
    // Map resolveData to internal RemoteRefBehavior
    const remoteRefBehavior = resolveData === 'none' ? 'lazy' : 'resolve';
    searchParams.set('remoteRefBehavior', remoteRefBehavior);
    const queryString = searchParams.toString();
    const endpoint = `/v2/runs/${runId}/steps${queryString ? `?${queryString}` : ''}`;
    const response = (await makeRequest({
        endpoint,
        options: { method: 'GET' },
        config,
        schema: PaginatedResponseSchema(remoteRefBehavior === 'lazy' ? StepWireWithRefsSchema : StepWireSchema),
    }));
    return {
        ...response,
        data: response.data.map((step) => filterStepData(step, resolveData)),
    };
}
async function getStep(runId, stepId, params, config) {
    const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
    const remoteRefBehavior = resolveData === 'none' ? 'lazy' : 'resolve';
    const searchParams = new URLSearchParams();
    searchParams.set('remoteRefBehavior', remoteRefBehavior);
    const queryString = searchParams.toString();
    const endpoint = runId
        ? `/v2/runs/${runId}/steps/${stepId}${queryString ? `?${queryString}` : ''}`
        : `/v2/steps/${stepId}${queryString ? `?${queryString}` : ''}`;
    const step = await makeRequest({
        endpoint,
        options: { method: 'GET' },
        config,
        schema: (remoteRefBehavior === 'lazy'
            ? StepWireWithRefsSchema
            : StepWireSchema),
    });
    return filterStepData(step, resolveData);
}

// Helper to filter event data based on resolveData setting
function filterEventData(event, resolveData) {
    if (resolveData === 'none') {
        const { eventData: _eventData, ...rest } = event;
        return rest;
    }
    return event;
}
// Schema for EventResult wire format returned by events.create
// Uses wire format schemas for step to handle field name mapping
const EventResultWireSchema = z.object({
    event: EventSchema,
    run: WorkflowRunSchema.optional(),
    step: StepWireSchema.optional(),
    hook: HookSchema.optional(),
});
// Would usually "EventSchema.omit({ eventData: true })" but that doesn't work
// on zod unions. Re-creating the schema manually.
// specVersion defaults to 1 (legacy) when parsing responses from storage
const EventWithRefsSchema = z.object({
    eventId: z.string(),
    runId: z.string(),
    eventType: EventTypeSchema,
    correlationId: z.string().optional(),
    eventDataRef: z.any().optional(),
    createdAt: z.coerce.date(),
    specVersion: z.number().default(1),
});
// Events where the client uses the response entity data need 'resolve' (default).
// Events where the client discards the response can use 'lazy' to skip expensive
// S3 ref resolution on the server, saving ~200-460ms per event.
const eventsNeedingResolve = new Set([
    'run_created', // client reads result.run.runId
    'run_started', // client reads result.run (checks startedAt, status)
    'step_started', // client reads result.step (checks attempt, state)
]);
// Functions
async function getWorkflowRunEvents(params, config) {
    const searchParams = new URLSearchParams();
    const { pagination, resolveData = DEFAULT_RESOLVE_DATA_OPTION } = params;
    let runId;
    let correlationId;
    if ('runId' in params) {
        runId = params.runId;
    }
    else {
        correlationId = params.correlationId;
    }
    if (!runId && !correlationId) {
        throw new Error('Either runId or correlationId must be provided');
    }
    if (pagination?.limit)
        searchParams.set('limit', pagination.limit.toString());
    if (pagination?.cursor)
        searchParams.set('cursor', pagination.cursor);
    if (pagination?.sortOrder)
        searchParams.set('sortOrder', pagination.sortOrder);
    if (correlationId)
        searchParams.set('correlationId', correlationId);
    const remoteRefBehavior = resolveData === 'none' ? 'lazy' : 'resolve';
    searchParams.set('remoteRefBehavior', remoteRefBehavior);
    const queryString = searchParams.toString();
    const query = queryString ? `?${queryString}` : '';
    const endpoint = correlationId
        ? `/v2/events${query}`
        : `/v2/runs/${runId}/events${query}`;
    const response = (await makeRequest({
        endpoint,
        options: { method: 'GET' },
        config,
        schema: PaginatedResponseSchema(remoteRefBehavior === 'lazy' ? EventWithRefsSchema : EventSchema),
    }));
    return {
        ...response,
        data: response.data.map((event) => filterEventData(event, resolveData)),
    };
}
async function createWorkflowRunEvent(id, data, params, config) {
    const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
    const v1Compat = params?.v1Compat ?? false;
    if (v1Compat) {
        if (data.eventType === 'run_cancelled' && id) {
            const run = await cancelWorkflowRunV1(id, params, config);
            return { run: run };
        }
        else if (data.eventType === 'run_created') {
            const run = await createWorkflowRunV1(data.eventData, config);
            return { run };
        }
        const wireResult = await makeRequest({
            endpoint: `/v1/runs/${id}/events`,
            options: { method: 'POST' },
            data,
            config,
            schema: EventSchema,
        });
        return { event: wireResult };
    }
    // For run_created events, runId may be client-provided or null
    const runIdPath = id === null ? 'null' : id;
    const remoteRefBehavior = eventsNeedingResolve.has(data.eventType)
        ? 'resolve'
        : 'lazy';
    const wireResult = await makeRequest({
        endpoint: `/v2/runs/${runIdPath}/events`,
        options: { method: 'POST' },
        data: { ...data, remoteRefBehavior },
        config,
        schema: EventResultWireSchema,
    });
    // Transform wire format to interface format
    return {
        event: filterEventData(wireResult.event, resolveData),
        run: wireResult.run,
        step: wireResult.step ? deserializeStep(wireResult.step) : undefined,
        hook: wireResult.hook,
    };
}

// Helper to filter hook data based on resolveData setting
function filterHookData(hook, resolveData) {
    if (resolveData === 'none') {
        const { metadataRef: _metadataRef, ...rest } = hook;
        return rest;
    }
    return hook;
}
const HookWithRefsSchema = HookSchema.omit({
    metadata: true,
}).extend({
    metadataRef: z.any().optional(),
});
async function listHooks(params, config) {
    const { runId, pagination, resolveData = DEFAULT_RESOLVE_DATA_OPTION, } = params;
    const searchParams = new URLSearchParams();
    if (pagination?.limit)
        searchParams.set('limit', pagination.limit.toString());
    if (pagination?.cursor)
        searchParams.set('cursor', pagination.cursor);
    if (pagination?.sortOrder)
        searchParams.set('sortOrder', pagination.sortOrder);
    // Map resolveData to internal RemoteRefBehavior
    const remoteRefBehavior = resolveData === 'none' ? 'lazy' : 'resolve';
    searchParams.set('remoteRefBehavior', remoteRefBehavior);
    if (runId)
        searchParams.set('runId', runId);
    const queryString = searchParams.toString();
    const endpoint = `/v2/hooks${queryString ? `?${queryString}` : ''}`;
    const response = (await makeRequest({
        endpoint,
        options: { method: 'GET' },
        config,
        schema: PaginatedResponseSchema(remoteRefBehavior === 'lazy' ? HookWithRefsSchema : HookSchema),
    }));
    return {
        ...response,
        data: response.data.map((hook) => filterHookData(hook, resolveData)),
    };
}
async function getHook(hookId, params, config) {
    const resolveData = params?.resolveData || 'all';
    const endpoint = `/v2/hooks/${hookId}`;
    const hook = await makeRequest({
        endpoint,
        options: { method: 'GET' },
        config,
        schema: HookSchema,
    });
    return filterHookData(hook, resolveData);
}
async function getHookByToken(token, config) {
    return makeRequest({
        endpoint: `/v2/hooks/by-token?token=${encodeURIComponent(token)}`,
        options: {
            method: 'GET',
        },
        config,
        schema: HookSchema,
    });
}

/**
 * Utility to instrument object methods with tracing.
 * This is a minimal version for world-vercel to avoid circular dependencies with @workflow/core.
 */
/** Configuration for peer service attribution */
const WORKFLOW_SERVER_SERVICE = {
    peerService: 'workflow-server',
    rpcSystem: 'http',
    rpcService: 'workflow-server',
};
/**
 * Extracts the event type from arguments for events.create calls.
 * The event data is the second argument and contains eventType.
 */
function extractEventType(args) {
    if (args.length >= 2 && typeof args[1] === 'object' && args[1] !== null) {
        const data = args[1];
        if (typeof data.eventType === 'string') {
            return data.eventType;
        }
    }
    return undefined;
}
/**
 * Wraps all methods of an object with tracing spans.
 * @param prefix - Prefix for span names (e.g., "world.runs")
 * @param o - Object with methods to instrument
 * @returns Instrumented object with same interface
 */
function instrumentObject(prefix, o) {
    const handlers = {};
    for (const key of Object.keys(o)) {
        if (typeof o[key] !== 'function') {
            handlers[key] = o[key];
        }
        else {
            const f = o[key];
            const methodName = String(key);
            // @ts-expect-error - dynamic function wrapping
            handlers[key] = async (...args) => {
                // Build span name - for events.create, include the event type
                let spanName = `${prefix}.${methodName}`;
                if (prefix === 'world.events' && methodName === 'create') {
                    const eventType = extractEventType(args);
                    if (eventType) {
                        spanName = `${prefix}.${methodName} ${eventType}`;
                    }
                }
                return trace(spanName, { kind: await getSpanKind('CLIENT') }, async (span) => {
                    // Add peer service attributes for service maps
                    // Use spanName for rpc.method so Datadog shows event type in resource
                    span?.setAttributes({
                        ...PeerService(WORKFLOW_SERVER_SERVICE.peerService),
                        ...RpcSystem(WORKFLOW_SERVER_SERVICE.rpcSystem),
                        ...RpcService(WORKFLOW_SERVER_SERVICE.rpcService),
                        ...RpcMethod(spanName),
                    });
                    return f(...args);
                });
            };
        }
    }
    return handlers;
}

function createStorage(config) {
    const storage = {
        // Storage interface with namespaced methods
        runs: {
            get: ((id, params) => getWorkflowRun(id, params, config)),
            list: ((params) => listWorkflowRuns(params, config)),
        },
        steps: {
            get: ((runId, stepId, params) => getStep(runId, stepId, params, config)),
            list: ((params) => listWorkflowRunSteps(params, config)),
        },
        events: {
            create: (runId, data, params) => createWorkflowRunEvent(runId, data, params, config),
            list: (params) => getWorkflowRunEvents(params, config),
            listByCorrelationId: (params) => getWorkflowRunEvents(params, config),
        },
        hooks: {
            get: (hookId, params) => getHook(hookId, params, config),
            getByToken: (token) => getHookByToken(token, config),
            list: (params) => listHooks(params, config),
        },
    };
    // Instrument all storage methods with tracing
    // NOTE: Span names are lowercase per OTEL semantic conventions
    return {
        runs: instrumentObject('world.runs', storage.runs),
        steps: instrumentObject('world.steps', storage.steps),
        events: instrumentObject('world.events', storage.events),
        hooks: instrumentObject('world.hooks', storage.hooks),
    };
}

function getStreamUrl(name, runId, httpConfig) {
    if (runId) {
        return new URL(`${httpConfig.baseUrl}/v2/runs/${runId}/stream/${encodeURIComponent(name)}`);
    }
    return new URL(`${httpConfig.baseUrl}/v2/stream/${encodeURIComponent(name)}`);
}
/**
 * Encode multiple chunks into a length-prefixed binary format.
 * Format: [4 bytes big-endian length][chunk bytes][4 bytes length][chunk bytes]...
 *
 * This preserves chunk boundaries so the server can store them as separate
 * chunks, maintaining correct startIndex semantics for readers.
 *
 * @internal Exported for testing purposes
 */
function encodeMultiChunks(chunks) {
    const encoder = new TextEncoder();
    // Convert all chunks to Uint8Array and calculate total size
    const binaryChunks = [];
    let totalSize = 0;
    for (const chunk of chunks) {
        const binary = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
        binaryChunks.push(binary);
        totalSize += 4 + binary.length; // 4 bytes for length prefix
    }
    // Allocate buffer and write length-prefixed chunks
    const result = new Uint8Array(totalSize);
    const view = new DataView(result.buffer);
    let offset = 0;
    for (const binary of binaryChunks) {
        view.setUint32(offset, binary.length, false); // big-endian
        offset += 4;
        result.set(binary, offset);
        offset += binary.length;
    }
    return result;
}
function createStreamer(config) {
    return {
        async writeToStream(name, runId, chunk) {
            // Await runId if it's a promise to ensure proper flushing
            const resolvedRunId = await runId;
            const httpConfig = await getHttpConfig(config);
            await fetch(getStreamUrl(name, resolvedRunId, httpConfig), {
                method: 'PUT',
                body: chunk,
                headers: httpConfig.headers,
                duplex: 'half',
            });
        },
        async writeToStreamMulti(name, runId, chunks) {
            if (chunks.length === 0)
                return;
            // Await runId if it's a promise to ensure proper flushing
            const resolvedRunId = await runId;
            const httpConfig = await getHttpConfig(config);
            // Signal to server that this is a multi-chunk batch
            httpConfig.headers.set('X-Stream-Multi', 'true');
            const body = encodeMultiChunks(chunks);
            await fetch(getStreamUrl(name, resolvedRunId, httpConfig), {
                method: 'PUT',
                body,
                headers: httpConfig.headers,
                duplex: 'half',
            });
        },
        async closeStream(name, runId) {
            // Await runId if it's a promise to ensure proper flushing
            const resolvedRunId = await runId;
            const httpConfig = await getHttpConfig(config);
            httpConfig.headers.set('X-Stream-Done', 'true');
            await fetch(getStreamUrl(name, resolvedRunId, httpConfig), {
                method: 'PUT',
                headers: httpConfig.headers,
            });
        },
        async readFromStream(name, startIndex) {
            const httpConfig = await getHttpConfig(config);
            const url = getStreamUrl(name, undefined, httpConfig);
            if (typeof startIndex === 'number') {
                url.searchParams.set('startIndex', String(startIndex));
            }
            const res = await fetch(url, { headers: httpConfig.headers });
            if (!res.ok)
                throw new Error(`Failed to fetch stream: ${res.status}`);
            return res.body;
        },
        async listStreamsByRunId(runId) {
            const httpConfig = await getHttpConfig(config);
            const url = new URL(`${httpConfig.baseUrl}/v2/runs/${runId}/streams`);
            const res = await fetch(url, { headers: httpConfig.headers });
            if (!res.ok)
                throw new Error(`Failed to list streams: ${res.status}`);
            return (await res.json());
        },
    };
}

function createVercelWorld(config) {
    // Project ID for HKDF key derivation context.
    // Use config value first (set correctly by CLI/web), fall back to env var (runtime).
    const projectId = config?.projectConfig?.projectId || process.env.VERCEL_PROJECT_ID;
    return {
        ...createQueue(config),
        ...createStorage(config),
        ...createStreamer(config),
        getEncryptionKeyForRun: createGetEncryptionKeyForRun(projectId, config?.token),
    };
}

export { createVercelWorld as c };
