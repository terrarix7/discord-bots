import { f as functionsExports } from '../@vercel/functions.mjs';
import { W as WorkflowAPIError, a as WorkflowRuntimeError, F as FatalError, E as ERROR_SLUGS, b as WorkflowRunCancelledError, c as WorkflowRunFailedError, d as WorkflowRunNotCompletedError, R as RetryableError } from './errors.mjs';
import { m as monotonicFactory } from '../../../_libs/ulid.mjs';
import { H as HealthCheckPayloadSchema, S as SPEC_VERSION_CURRENT, i as isLegacySpecVersion, a as StepInvokePayloadSchema, W as WorkflowInvokePayloadSchema } from './world.mjs';
import { a as pluralize, o as once, w as withResolvers, p as parseDurationToDate, g as getPort, b as parseWorkflowName } from './utils.mjs';
import { T as TraceMap, o as originalPositionFor } from '../@jridgewell/trace-mapping.mjs';
import { types } from 'node:util';
import { createContext as createContext$1, runInContext } from 'node:vm';
import { c as customRandom, u as urlAlphabet } from '../../../_libs/nanoid.mjs';
import { s as seedrandom } from '../../../_libs/seedrandom.mjs';
import { W as WORKFLOW_DESERIALIZE, a as WORKFLOW_SERIALIZE } from './serde.mjs';
import { d as debug } from '../debug.mjs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { c as createLocalWorld } from './world-local.mjs';
import { c as createVercelWorld } from './world-vercel.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { u as unflatten, p as parse, s as stringify, D as DevalueError } from '../../../_libs/devalue.mjs';

/**
 * Browser-compatible AES-256-GCM encryption module.
 *
 * Uses the Web Crypto API (`globalThis.crypto.subtle`) which works in
 * both modern browsers and Node.js 20+. This module is intentionally
 * free of Node.js-specific imports so it can be bundled for the browser.
 *
 * The World interface (`getEncryptionKeyForRun`) returns a raw 32-byte
 * AES-256 key. Callers should use `importKey()` once to convert it to a
 * `CryptoKey`, then pass that to `encrypt()`/`decrypt()` for all
 * operations within the same run. This avoids repeated `importKey()`
 * calls on every encrypt/decrypt invocation.
 *
 * Wire format: `[nonce (12 bytes)][ciphertext + auth tag]`
 * The `encr` format prefix is NOT part of this module — it's added/stripped
 * by the serialization layer in `maybeEncrypt`/`maybeDecrypt`.
 */
const KEY_LENGTH = 32; // bytes (AES-256)
/**
 * Import a raw AES-256 key as a `CryptoKey` for use with `encrypt()`/`decrypt()`.
 *
 * Callers should call this once per run (after `getEncryptionKeyForRun()`)
 * and pass the resulting `CryptoKey` to all subsequent encrypt/decrypt calls.
 *
 * @param raw - Raw 32-byte AES-256 key (from World.getEncryptionKeyForRun)
 * @returns CryptoKey ready for AES-GCM operations
 */
async function importKey(raw) {
    if (raw.byteLength !== KEY_LENGTH) {
        throw new Error(`Encryption key must be exactly ${KEY_LENGTH} bytes, got ${raw.byteLength}`);
    }
    return globalThis.crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
        'encrypt',
        'decrypt',
    ]);
}

/**
 * An error that is thrown when one or more operations (steps/hooks/etc.) are called but do
 * not yet have corresponding entries in the event log. The workflow
 * dispatcher will catch this error and push the operations
 * onto the queue.
 */
class WorkflowSuspension extends Error {
    steps;
    globalThis;
    stepCount;
    hookCount;
    waitCount;
    constructor(stepsInput, global) {
        // Convert Map to array for iteration and storage
        const steps = [...stepsInput.values()];
        // Single-pass counting for efficiency
        let stepCount = 0;
        let hookCount = 0;
        let waitCount = 0;
        for (const item of steps) {
            if (item.type === 'step')
                stepCount++;
            else if (item.type === 'hook')
                hookCount++;
            else if (item.type === 'wait')
                waitCount++;
        }
        // Build description parts
        const parts = [];
        if (stepCount > 0) {
            parts.push(`${stepCount} ${pluralize('step', 'steps', stepCount)}`);
        }
        if (hookCount > 0) {
            parts.push(`${hookCount} ${pluralize('hook', 'hooks', hookCount)}`);
        }
        if (waitCount > 0) {
            parts.push(`${waitCount} ${pluralize('wait', 'waits', waitCount)}`);
        }
        // Determine verb (has/have) and action (run/created/received)
        const totalCount = stepCount + hookCount + waitCount;
        const hasOrHave = pluralize('has', 'have', totalCount);
        let action;
        if (stepCount > 0) {
            action = 'run';
        }
        else if (hookCount > 0) {
            action = 'created';
        }
        else if (waitCount > 0) {
            action = 'created';
        }
        else {
            action = 'received';
        }
        const description = parts.length > 0
            ? `${parts.join(' and ')} ${hasOrHave} not been ${action} yet`
            : '0 steps have not been run yet'; // Default case for empty array
        super(description);
        this.name = 'WorkflowSuspension';
        this.steps = steps;
        this.globalThis = global;
        this.stepCount = stepCount;
        this.hookCount = hookCount;
        this.waitCount = waitCount;
    }
    static is(value) {
        return value instanceof WorkflowSuspension;
    }
}
function ENOTSUP() {
    throw new Error('Not supported in workflow functions');
}

/**
 * OpenTelemetry semantic conventions for Vercel Workflow telemetry.
 *
 * This module provides standardized telemetry attributes following OpenTelemetry semantic conventions
 * for instrumenting workflow execution, step processing, and related operations. Each exported function
 * creates a properly formatted attribute object that can be used with OpenTelemetry spans.
 *
 * The semantic conventions are organized into several categories:
 * - **Workflow attributes**: Track workflow lifecycle, status, and metadata
 * - **Step attributes**: Monitor individual step execution, retries, and results
 * - **Queue attributes**: Instrument message queue operations
 * - **Deployment attributes**: Capture deployment environment information
 *
 * All attribute functions are type-safe and leverage existing backend types to ensure
 * consistency between telemetry data and actual system state.
 *
 * @example
 * ```typescript
 * import * as Attribute from './telemetry/semantic-conventions.js';
 *
 * // Set workflow attributes on a span
 * span.setAttributes({
 *   ...Attribute.WorkflowName('my-workflow'),
 *   ...Attribute.WorkflowOperation('start'),
 *   ...Attribute.WorkflowRunStatus('running'),
 * });
 *
 * // Set step attributes
 * span.setAttributes({
 *   ...Attribute.StepName('process-data'),
 *   ...Attribute.StepStatus('completed'),
 *   ...Attribute.StepAttempt(1),
 * });
 * ```
 *
 * @see {@link https://opentelemetry.io/docs/specs/semconv/} OpenTelemetry Semantic Conventions
 * @packageDocumentation
 */
/**
 * Creates a semantic convention function that returns an attribute object.
 * @param name - The attribute name following OpenTelemetry semantic conventions
 * @returns A function that takes a value and returns an attribute object
 */
function SemanticConvention(...names) {
    return (value) => Object.fromEntries(names.map((name) => [name, value]));
}
// Workflow attributes
/** The name of the workflow being executed */
const WorkflowName = SemanticConvention('workflow.name');
/** The operation being performed on the workflow */
const WorkflowOperation = SemanticConvention('workflow.operation');
/** Unique identifier for a specific workflow run instance */
const WorkflowRunId = SemanticConvention('workflow.run.id');
/** Current status of the workflow run */
const WorkflowRunStatus = SemanticConvention('workflow.run.status');
/** Timestamp when the workflow execution started (Unix timestamp) */
const WorkflowStartedAt = SemanticConvention('workflow.started_at');
/** Number of events processed during workflow execution */
const WorkflowEventsCount = SemanticConvention('workflow.events.count');
/** Number of arguments passed to the workflow */
const WorkflowArgumentsCount = SemanticConvention('workflow.arguments.count');
/** Type of the workflow result */
const WorkflowResultType = SemanticConvention('workflow.result.type');
/** Whether trace context was propagated to this workflow execution */
const WorkflowTracePropagated = SemanticConvention('workflow.trace.propagated');
/** Name of the error that caused workflow failure */
const WorkflowErrorName = SemanticConvention('workflow.error.name');
/** Error message when workflow fails */
const WorkflowErrorMessage = SemanticConvention('workflow.error.message');
/** Number of steps created during workflow execution */
const WorkflowStepsCreated = SemanticConvention('workflow.steps.created');
/** Number of hooks created during workflow execution */
const WorkflowHooksCreated = SemanticConvention('workflow.hooks.created');
/** Number of waits created during workflow execution */
const WorkflowWaitsCreated = SemanticConvention('workflow.waits.created');
// Step attributes
/** Name of the step function being executed */
const StepName = SemanticConvention('step.name');
/** Unique identifier for the step instance */
const StepId = SemanticConvention('step.id');
/** Current attempt number for step execution (starts at 1) */
const StepAttempt = SemanticConvention('step.attempt');
/** Current status of the step */
const StepStatus = SemanticConvention('step.status');
/** Maximum number of retries allowed for this step */
const StepMaxRetries = SemanticConvention('step.max_retries');
/** Whether trace context was propagated to this step execution */
const StepTracePropagated = SemanticConvention('step.trace.propagated');
/** Whether the step was skipped during execution */
const StepSkipped = SemanticConvention('step.skipped');
/** Reason why the step was skipped */
const StepSkipReason = SemanticConvention('step.skip_reason');
/** Number of arguments passed to the step function */
const StepArgumentsCount = SemanticConvention('step.arguments.count');
/** Type of the step result */
const StepResultType = SemanticConvention('step.result.type');
/** Name of the error that caused step failure */
const StepErrorName = SemanticConvention('step.error.name');
/** Error message when step fails */
const StepErrorMessage = SemanticConvention('step.error.message');
/** Whether the step failed with a fatal error (no retries) */
const StepFatalError = SemanticConvention('step.fatal_error');
/** Whether all retry attempts have been exhausted */
const StepRetryExhausted = SemanticConvention('step.retry.exhausted');
/** Number of seconds to wait before next retry attempt */
const StepRetryTimeoutSeconds = SemanticConvention('step.retry.timeout_seconds');
/** Whether the step will be retried after this failure */
const StepRetryWillRetry = SemanticConvention('step.retry.will_retry');
// Queue/Messaging attributes - Standard OTEL messaging conventions
// See: https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/
/** Messaging system identifier (standard OTEL: messaging.system) */
const MessagingSystem = SemanticConvention('messaging.system');
/** Destination name/queue name (standard OTEL: messaging.destination.name) */
const MessagingDestinationName = SemanticConvention('messaging.destination.name');
/** The message id being handled (standard OTEL: messaging.message.id) */
const MessagingMessageId = SemanticConvention('messaging.message.id');
/** Operation type (standard OTEL: messaging.operation.type) */
const MessagingOperationType = SemanticConvention('messaging.operation.type');
/** Time taken to enqueue the message in milliseconds (workflow-specific) */
const QueueOverheadMs = SemanticConvention('workflow.queue.overhead_ms');
// Deployment attributes
/** Unique identifier for the deployment environment */
const DeploymentId = SemanticConvention('deployment.id');
// Hook attributes
/** Token identifying a specific hook */
const HookToken = SemanticConvention('workflow.hook.token');
/** Unique identifier for a hook instance */
const HookId = SemanticConvention('workflow.hook.id');
/** Whether a hook was found by its token */
const HookFound = SemanticConvention('workflow.hook.found');
// Suspension attributes
const WorkflowSuspensionState = SemanticConvention('workflow.suspension.state');
const WorkflowSuspensionHookCount = SemanticConvention('workflow.suspension.hook_count');
const WorkflowSuspensionStepCount = SemanticConvention('workflow.suspension.step_count');
const WorkflowSuspensionWaitCount = SemanticConvention('workflow.suspension.wait_count');
/** Error type when request fails (standard OTEL: error.type) */
const ErrorType = SemanticConvention('error.type');
// Event loading attributes
/** Number of pagination pages loaded when fetching workflow events */
const WorkflowEventsPagesLoaded = SemanticConvention('workflow.events.pages_loaded');
// Queue timing breakdown attributes (workflow-specific)
/** Time spent deserializing the queue message in milliseconds */
const QueueDeserializeTimeMs = SemanticConvention('workflow.queue.deserialize_time_ms');
/** Time spent executing the handler logic in milliseconds */
const QueueExecutionTimeMs = SemanticConvention('workflow.queue.execution_time_ms');
/** Time spent serializing the response in milliseconds */
const QueueSerializeTimeMs = SemanticConvention('workflow.queue.serialize_time_ms');
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
// Error attributes - Standard OTEL error conventions
// See: https://opentelemetry.io/docs/specs/semconv/exceptions/exceptions-spans/
/** Whether the error is retryable (workflow-specific) */
const ErrorRetryable = SemanticConvention('error.retryable');
/** Error category (workflow-specific: fatal, retryable, transient) */
const ErrorCategory = SemanticConvention('error.category');

// ============================================================
// Trace Context Propagation Utilities
// ============================================================
/**
 * Serializes the current trace context into a format that can be passed through queues
 * @returns A record of strings representing the trace context
 */
async function serializeTraceCarrier() {
    const otel = await OtelApi.value;
    if (!otel)
        return {};
    const carrier = {};
    // Inject the current context into the carrier
    otel.propagation.inject(otel.context.active(), carrier);
    return carrier;
}
/**
 * Deserializes trace context and returns a context that can be used to continue the trace
 * @param traceCarrier The serialized trace context
 * @returns OpenTelemetry context with the restored trace
 */
async function deserializeTraceCarrier(traceCarrier) {
    const otel = await OtelApi.value;
    if (!otel)
        return;
    // Extract the context from the carrier
    return otel.propagation.extract(otel.context.active(), traceCarrier);
}
/**
 * Runs a function within the context of a deserialized trace
 * @param traceCarrier The serialized trace carrier (optional)
 * @param fn The function to run within the trace context
 * @returns The result of the function
 */
async function withTraceContext(traceCarrier, fn) {
    if (!traceCarrier) {
        return fn();
    }
    const otel = await OtelApi.value;
    if (!otel)
        return fn();
    const extractedContext = await deserializeTraceCarrier(traceCarrier);
    if (!extractedContext) {
        return fn();
    }
    return otel.context.with(extractedContext, async () => await fn());
}
const OtelApi = once(async () => {
    try {
        return await import('@opentelemetry/api');
    }
    catch {
        runtimeLogger.info('OpenTelemetry not available, tracing will be disabled');
        return null;
    }
});
const Tracer = once(async () => {
    const api = await OtelApi.value;
    if (!api)
        return null;
    return api.trace.getTracer('workflow');
});
async function trace(spanName, ...args) {
    const [tracer, otel] = await Promise.all([Tracer.value, OtelApi.value]);
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
            applyWorkflowSuspensionToSpan(e, otel, span);
            throw e;
        }
        finally {
            span.end();
        }
    });
}
/**
 * Applies workflow suspension attributes to the given span if the error is a WorkflowSuspension
 * which is technically not an error, but an algebraic effect indicating suspension.
 */
function applyWorkflowSuspensionToSpan(error, otel, span) {
    if (!error || !WorkflowSuspension.is(error)) {
        return;
    }
    span.setStatus({ code: otel.SpanStatusCode.OK });
    span.setAttributes({
        ...WorkflowSuspensionState('suspended'),
        ...WorkflowSuspensionStepCount(error.stepCount),
        ...WorkflowSuspensionHookCount(error.hookCount),
        ...WorkflowSuspensionWaitCount(error.waitCount),
    });
}
async function getSpanContextForTraceCarrier(carrier) {
    const [deserialized, otel] = await Promise.all([
        deserializeTraceCarrier(carrier),
        OtelApi.value,
    ]);
    if (!deserialized || !otel)
        return;
    return otel.trace.getSpanContext(deserialized);
}
async function getActiveSpan() {
    return await withOtel((otel) => otel.trace.getActiveSpan());
}
async function getSpanKind(field) {
    return withOtel((x) => x.SpanKind[field]);
}
async function withOtel(fn) {
    const otel = await OtelApi.value;
    if (!otel)
        return undefined;
    return await fn(otel);
}
function linkToCurrentContext() {
    return withOtel((otel) => {
        const context = otel.trace.getActiveSpan()?.spanContext();
        if (!context)
            return;
        return [{ context }];
    });
}
/**
 * Sets workflow context as OTEL baggage for automatic propagation.
 * Baggage is propagated across service boundaries via HTTP headers.
 * @param context - Workflow context to set as baggage
 * @returns A function to run within the baggage context
 */
async function withWorkflowBaggage(context, fn) {
    const otel = await OtelApi.value;
    if (!otel)
        return fn();
    // Create baggage with workflow context
    const baggage = otel.propagation.createBaggage({
        'workflow.run_id': { value: context.workflowRunId },
        'workflow.name': { value: context.workflowName },
    });
    // Set baggage in context and run function
    const contextWithBaggage = otel.propagation.setBaggage(otel.context.active(), baggage);
    return otel.context.with(contextWithBaggage, () => fn());
}

function createLogger(namespace) {
    const baseDebug = debug(`workflow:${namespace}`);
    const logger = (level) => {
        const levelDebug = baseDebug.extend(level);
        return (message, metadata) => {
            // Always output error/warn to console so users see critical issues
            // debug/info only output when DEBUG env var is set
            if (level === 'error') {
                console.error(`[Workflow] ${message}`, metadata ?? '');
            }
            else if (level === 'warn') {
                console.warn(`[Workflow] ${message}`, metadata ?? '');
            }
            // Also log to debug library for verbose output when DEBUG is enabled
            levelDebug(message, metadata);
            if (levelDebug.enabled) {
                getActiveSpan()
                    .then((span) => {
                    span?.addEvent(`${level}.${namespace}`, { message, ...metadata });
                })
                    .catch(() => {
                    // Silently ignore telemetry errors
                });
            }
        };
    };
    return {
        debug: logger('debug'),
        info: logger('info'),
        warn: logger('warn'),
        error: logger('error'),
    };
}
const stepLogger = createLogger('step');
const runtimeLogger = createLogger('runtime');
const webhookLogger = createLogger('webhook');
const eventsLogger = createLogger('events');
createLogger('adapter');

const require$1 = createRequire(join(process.cwd(), 'index.js'));
const WorldCache = Symbol.for('@workflow/world//cache');
const StubbedWorldCache = Symbol.for('@workflow/world//stubbedCache');
const globalSymbols = globalThis;
function defaultWorld() {
    if (process.env.VERCEL_DEPLOYMENT_ID) {
        return 'vercel';
    }
    return 'local';
}
/**
 * Create a new world instance based on environment variables.
 * WORKFLOW_TARGET_WORLD is used to determine the target world.
 * All other environment variables are specific to the target world
 */
const createWorld = () => {
    const targetWorld = process.env.WORKFLOW_TARGET_WORLD || defaultWorld();
    if (targetWorld === 'vercel') {
        return createVercelWorld({
            token: process.env.WORKFLOW_VERCEL_AUTH_TOKEN,
            projectConfig: {
                environment: process.env.WORKFLOW_VERCEL_ENV,
                projectId: process.env.WORKFLOW_VERCEL_PROJECT, // real ID (prj_xxx)
                projectName: process.env.WORKFLOW_VERCEL_PROJECT_NAME, // slug (my-app)
                teamId: process.env.WORKFLOW_VERCEL_TEAM,
            },
        });
    }
    if (targetWorld === 'local') {
        return createLocalWorld({
            dataDir: process.env.WORKFLOW_LOCAL_DATA_DIR,
        });
    }
    const mod = require$1(targetWorld);
    if (typeof mod === 'function') {
        return mod();
    }
    else if (typeof mod.default === 'function') {
        return mod.default();
    }
    else if (typeof mod.createWorld === 'function') {
        return mod.createWorld();
    }
    throw new Error(`Invalid target world module: ${targetWorld}, must export a default function or createWorld function that returns a World instance.`);
};
/**
 * Some functions from the world are needed at build time, but we do NOT want
 * to cache the world in those instances for general use, since we don't have
 * the correct environment variables set yet. This is a safe function to
 * call at build time, that only gives access to non-environment-bound world
 * functions. The only binding value should be the target world.
 * Once we migrate to a file-based configuration (workflow.config.ts), we should
 * be able to re-combine getWorld and getWorldHandlers into one singleton.
 */
const getWorldHandlers = () => {
    if (globalSymbols[StubbedWorldCache]) {
        return globalSymbols[StubbedWorldCache];
    }
    const _world = createWorld();
    globalSymbols[StubbedWorldCache] = _world;
    return {
        createQueueHandler: _world.createQueueHandler,
    };
};
const getWorld = () => {
    if (globalSymbols[WorldCache]) {
        return globalSymbols[WorldCache];
    }
    globalSymbols[WorldCache] = createWorld();
    return globalSymbols[WorldCache];
};

/**
 * Pattern for safe workflow names. Only allows alphanumeric characters,
 * underscores, hyphens, dots, forward slashes (for namespaced workflows),
 * and at signs (for scoped packages).
 */
const SAFE_WORKFLOW_NAME_PATTERN = /^[a-zA-Z0-9_\-./@]+$/;
/**
 * Validates a workflow name and returns the corresponding queue name.
 * Ensures the workflow name only contains safe characters before
 * interpolating it into the queue name string.
 */
function getWorkflowQueueName(workflowName) {
    if (!SAFE_WORKFLOW_NAME_PATTERN.test(workflowName)) {
        throw new Error(`Invalid workflow name "${workflowName}": must only contain alphanumeric characters, underscores, hyphens, dots, forward slashes, or at signs`);
    }
    return `__wkf_workflow_${workflowName}`;
}
const generateId = monotonicFactory();
/**
 * Returns the stream name for a health check with the given correlation ID.
 */
function getHealthCheckStreamName(correlationId) {
    return `__health_check__${correlationId}`;
}
/**
 * Checks if the given message is a health check payload.
 * If so, returns the parsed payload. Otherwise returns undefined.
 */
function parseHealthCheckPayload(message) {
    const result = HealthCheckPayloadSchema.safeParse(message);
    if (result.success) {
        return result.data;
    }
    return undefined;
}
/**
 * Generates a fake runId for health check streams.
 * This runId passes server validation but is not associated with a real run.
 * The server skips run validation for streams starting with `__health_check__`.
 */
function generateHealthCheckRunId() {
    return `wrun_${generateId()}`;
}
/**
 * Handles a health check message by writing the result to the world's stream.
 * The caller can listen to this stream to get the health check response.
 *
 * @param healthCheck - The parsed health check payload
 * @param endpoint - Which endpoint is responding ('workflow' or 'step')
 */
async function handleHealthCheckMessage(healthCheck, endpoint) {
    const world = getWorld();
    const streamName = getHealthCheckStreamName(healthCheck.correlationId);
    const response = JSON.stringify({
        healthy: true,
        endpoint,
        correlationId: healthCheck.correlationId,
        timestamp: Date.now(),
    });
    // Use a fake runId that passes validation.
    // The stream name includes the correlationId for identification.
    // The server skips run validation for health check streams.
    const fakeRunId = generateHealthCheckRunId();
    await world.writeToStream(streamName, fakeRunId, response);
    await world.closeStream(streamName, fakeRunId);
}
/**
 * Loads all workflow run events by iterating through all pages of paginated results.
 * This ensures that *all* events are loaded into memory before running the workflow.
 * Events must be in chronological order (ascending) for proper workflow replay.
 */
async function getAllWorkflowRunEvents(runId) {
    return trace('workflow.loadEvents', async (span) => {
        span?.setAttributes({
            ...WorkflowRunId(runId),
        });
        const allEvents = [];
        let cursor = null;
        let hasMore = true;
        let pagesLoaded = 0;
        const world = getWorld();
        while (hasMore) {
            // TODO: we're currently loading all the data with resolveRef behaviour. We need to update this
            // to lazyload the data from the world instead so that we can optimize and make the event log loading
            // much faster and memory efficient
            const response = await world.events.list({
                runId,
                pagination: {
                    sortOrder: 'asc', // Required: events must be in chronological order for replay
                    cursor: cursor ?? undefined,
                },
            });
            allEvents.push(...response.data);
            hasMore = response.hasMore;
            cursor = response.cursor;
            pagesLoaded++;
        }
        span?.setAttributes({
            ...WorkflowEventsCount(allEvents.length),
            ...WorkflowEventsPagesLoaded(pagesLoaded),
        });
        return allEvents;
    });
}
/**
 * CORS headers for health check responses.
 * Allows the observability UI to check endpoint health from a different origin.
 */
const HEALTH_CHECK_CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET, HEAD',
    'Access-Control-Allow-Headers': 'Content-Type',
};
/**
 * Wraps a request/response handler and adds a health check "mode"
 * based on the presence of a `__health` query parameter.
 */
function withHealthCheck(handler) {
    return async (req) => {
        const url = new URL(req.url);
        const isHealthCheck = url.searchParams.has('__health');
        if (isHealthCheck) {
            // Handle CORS preflight for health check
            if (req.method === 'OPTIONS') {
                return new Response(null, {
                    status: 204,
                    headers: HEALTH_CHECK_CORS_HEADERS,
                });
            }
            return new Response(`Workflow DevKit "${url.pathname}" endpoint is healthy`, {
                status: 200,
                headers: {
                    'Content-Type': 'text/plain',
                    ...HEALTH_CHECK_CORS_HEADERS,
                },
            });
        }
        return await handler(req);
    };
}
/**
 * Queues a message to the specified queue with tracing.
 */
async function queueMessage(world, ...args) {
    const queueName = args[0];
    await trace('queue.publish', {
        // Standard OTEL messaging conventions
        attributes: {
            ...MessagingSystem('vercel-queue'),
            ...MessagingDestinationName(queueName),
            ...MessagingOperationType('publish'),
            // Peer service for Datadog service maps
            ...PeerService('vercel-queue'),
            ...RpcSystem('vercel-queue'),
            ...RpcService('vqs'),
            ...RpcMethod('publish'),
        },
        kind: await getSpanKind('PRODUCER'),
    }, async (span) => {
        const { messageId } = await world.queue(...args);
        span?.setAttributes(MessagingMessageId(messageId));
    });
}
/**
 * Calculates the queue overhead time in milliseconds for a given message.
 */
function getQueueOverhead(message) {
    if (!message.requestedAt)
        return;
    try {
        return QueueOverheadMs(Date.now() - message.requestedAt.getTime());
    }
    catch {
        return;
    }
}
/**
 * Wraps a queue handler with HTTP 429 throttle retry logic.
 * - retryAfter < 10s: waits in-process via setTimeout, then retries once
 * - retryAfter >= 10s: returns { timeoutSeconds } to defer to the queue
 *
 * Safe to retry the entire handler because 429 is sent from server middleware
 * before the request is processed — no server state has changed.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: matches Queue handler return type
async function withThrottleRetry(fn) {
    try {
        return await fn();
    }
    catch (err) {
        if (WorkflowAPIError.is(err) && err.status === 429) {
            const retryAfterSeconds = Math.max(
            // If we don't have a retry-after value, 30s seems a reasonable default
            // to avoid re-trying during the unknown rate-limiting period.
            1, typeof err.retryAfter === 'number' ? err.retryAfter : 30);
            if (retryAfterSeconds < 10) {
                runtimeLogger.warn('Throttled by workflow-server (429), retrying in-process', {
                    retryAfterSeconds,
                    url: err.url,
                });
                // Short wait: sleep in-process, then retry once
                await new Promise((resolve) => setTimeout(resolve, retryAfterSeconds * 1000));
                try {
                    return await fn();
                }
                catch (retryErr) {
                    // If the retry also gets throttled, defer to queue
                    if (WorkflowAPIError.is(retryErr) && retryErr.status === 429) {
                        const retryRetryAfter = Math.max(1, typeof retryErr.retryAfter === 'number' ? retryErr.retryAfter : 1);
                        runtimeLogger.warn('Throttled again on retry, deferring to queue', {
                            retryAfterSeconds: retryRetryAfter,
                        });
                        return { timeoutSeconds: retryRetryAfter };
                    }
                    throw retryErr;
                }
            }
            // Long wait: defer to queue infrastructure
            runtimeLogger.warn('Throttled by workflow-server (429), deferring to queue', {
                retryAfterSeconds,
                url: err.url,
            });
            return { timeoutSeconds: retryAfterSeconds };
        }
        throw err;
    }
}
/**
 * Retries a function when it throws a 5xx WorkflowAPIError.
 * Used to handle transient workflow-server errors without consuming step attempts.
 *
 * Retries up to 3 times with exponential backoff (500ms, 1s, 2s ≈ 3.5s total).
 * If all retries fail, the original error is re-thrown.
 */
async function withServerErrorRetry(fn) {
    const delays = [500, 1000, 2000];
    for (let attempt = 0; attempt <= delays.length; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            if (WorkflowAPIError.is(err) &&
                err.status !== undefined &&
                err.status >= 500 &&
                attempt < delays.length) {
                runtimeLogger.warn('Server error (5xx) from workflow-server, retrying in-process', {
                    status: err.status,
                    attempt: attempt + 1,
                    maxRetries: delays.length,
                    nextDelayMs: delays[attempt],
                    url: err.url,
                });
                await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
                continue;
            }
            throw err;
        }
    }
    throw new Error('withServerErrorRetry: unreachable');
}

const WORKFLOW_USE_STEP = Symbol.for('WORKFLOW_USE_STEP');
const WORKFLOW_CREATE_HOOK = Symbol.for('WORKFLOW_CREATE_HOOK');
const WORKFLOW_SLEEP = Symbol.for('WORKFLOW_SLEEP');
const WORKFLOW_GET_STREAM_ID = Symbol.for('WORKFLOW_GET_STREAM_ID');
const STABLE_ULID = Symbol.for('WORKFLOW_STABLE_ULID');
const STREAM_NAME_SYMBOL = Symbol.for('WORKFLOW_STREAM_NAME');
const STREAM_TYPE_SYMBOL = Symbol.for('WORKFLOW_STREAM_TYPE');
const BODY_INIT_SYMBOL = Symbol.for('BODY_INIT');
const WEBHOOK_RESPONSE_WRITABLE = Symbol.for('WEBHOOK_RESPONSE_WRITABLE');
/**
 * Symbol used to store the class registry on globalThis in workflow mode.
 * This allows the deserializer to find classes by classId in the VM context.
 */
const WORKFLOW_CLASS_REGISTRY = Symbol.for('workflow-class-registry');

/**
 * Class serialization utilities.
 *
 * This module is separate from private.ts to avoid pulling in Node.js-only
 * dependencies (like async_hooks via get-closure-vars.ts) when used in
 * workflow bundles.
 */
/**
 * Get or create the class registry on the given global object.
 * This works isomorphically in both step mode (main context) and workflow mode (VM context).
 *
 * @param global - The global object to use. Defaults to globalThis, but can be a VM's global.
 */
function getRegistry(global = globalThis) {
    const g = global;
    let registry = g[WORKFLOW_CLASS_REGISTRY];
    if (!registry) {
        registry = new Map();
        g[WORKFLOW_CLASS_REGISTRY] = registry;
    }
    return registry;
}
/**
 * Find a registered class constructor by ID (used during deserialization)
 *
 * @param classId - The class ID to look up
 * @param global - The global object to check. This ensures workflow code running
 *                 in a VM only accesses classes registered on the VM's global,
 *                 matching production serverless behavior where workflow code
 *                 runs in isolation.
 */
function getSerializationClass(classId, global
// biome-ignore lint/complexity/noBannedTypes: We need to use Function to represent class constructors
) {
    return getRegistry(global).get(classId);
}

/**
 * Polling interval (in ms) for lock release detection.
 *
 * The Web Streams API does not expose an event for "lock released but stream
 * still open"; we can only distinguish that state by periodically attempting
 * to acquire a reader/writer. For that reason we use polling instead of a
 * fully event-driven approach here.
 *
 * 100ms is a compromise between:
 * - Latency: how quickly we notice that the user has released their lock, and
 * - Cost/CPU usage: how often timers fire, especially with many concurrent
 *   streams or in serverless environments where billed time matters.
 *
 * This value should only be changed with care, as decreasing it will
 * increase polling frequency (and thus potential cost), while increasing it
 * will add worst-case delay before the `done` promise resolves after a lock
 * is released.
 */
const LOCK_POLL_INTERVAL_MS = 100;
function createFlushableState() {
    return {
        ...withResolvers(),
        pendingOps: 0,
        doneResolved: false,
        streamEnded: false,
    };
}
/**
 * Checks if a WritableStream is unlocked (user released lock) vs closed.
 * When a stream is closed, .locked is false but getWriter() throws.
 * We only want to resolve via polling when the stream is unlocked, not closed.
 * If closed, the pump will handle resolution via the stream ending naturally.
 */
function isWritableUnlockedNotClosed(writable) {
    if (writable.locked)
        return false;
    let writer;
    try {
        // Try to acquire writer - if successful, stream is unlocked (not closed)
        writer = writable.getWriter();
    }
    catch {
        // getWriter() throws if stream is closed/errored - let pump handle it
        return false;
    }
    try {
        writer.releaseLock();
    }
    catch {
        // If releaseLock() throws for any reason, conservatively treat the
        // stream as closed/errored so callers don't assume it's safe to use.
        // The pump will observe the failure via the stream's end state.
        return false;
    }
    return true;
}
/**
 * Checks if a ReadableStream is unlocked (user released lock) vs closed.
 */
function isReadableUnlockedNotClosed(readable) {
    if (readable.locked)
        return false;
    let reader;
    try {
        // Try to acquire reader - if successful, stream is unlocked (not closed)
        reader = readable.getReader();
    }
    catch {
        // getReader() throws if stream is closed/errored - let pump handle it
        return false;
    }
    try {
        reader.releaseLock();
    }
    catch {
        // If releaseLock() throws for any reason, conservatively treat the
        // stream as closed/errored so callers don't assume it's safe to use.
        // The pump will observe the failure via the stream's end state.
        return false;
    }
    return true;
}
/**
 * Polls a WritableStream to check if the user has released their lock.
 * Resolves the done promise when lock is released and no pending ops remain.
 *
 * Note: Only resolves if stream is unlocked but NOT closed. If the user closes
 * the stream, the pump will handle resolution via the stream ending naturally.
 *
 * Protection: If polling is already active on this state, the existing interval
 * is used to avoid creating multiple simultaneous polling operations.
 */
function pollWritableLock(writable, state) {
    // Prevent multiple simultaneous polling on the same state
    if (state.writablePollingInterval !== undefined) {
        return;
    }
    const intervalId = setInterval(() => {
        // Stop polling if already resolved or stream ended
        if (state.doneResolved || state.streamEnded) {
            clearInterval(intervalId);
            state.writablePollingInterval = undefined;
            return;
        }
        // Check if lock is released (not closed) and no pending ops
        if (isWritableUnlockedNotClosed(writable) && state.pendingOps === 0) {
            state.doneResolved = true;
            state.resolve();
            clearInterval(intervalId);
            state.writablePollingInterval = undefined;
        }
    }, LOCK_POLL_INTERVAL_MS);
    state.writablePollingInterval = intervalId;
}
/**
 * Polls a ReadableStream to check if the user has released their lock.
 * Resolves the done promise when lock is released and no pending ops remain.
 *
 * Note: Only resolves if stream is unlocked but NOT closed. If the user closes
 * the stream, the pump will handle resolution via the stream ending naturally.
 *
 * Protection: If polling is already active on this state, the existing interval
 * is used to avoid creating multiple simultaneous polling operations.
 */
function pollReadableLock(readable, state) {
    // Prevent multiple simultaneous polling on the same state
    if (state.readablePollingInterval !== undefined) {
        return;
    }
    const intervalId = setInterval(() => {
        // Stop polling if already resolved or stream ended
        if (state.doneResolved || state.streamEnded) {
            clearInterval(intervalId);
            state.readablePollingInterval = undefined;
            return;
        }
        // Check if lock is released (not closed) and no pending ops
        if (isReadableUnlockedNotClosed(readable) && state.pendingOps === 0) {
            state.doneResolved = true;
            state.resolve();
            clearInterval(intervalId);
            state.readablePollingInterval = undefined;
        }
    }, LOCK_POLL_INTERVAL_MS);
    state.readablePollingInterval = intervalId;
}
/**
 * Creates a flushable pipe from a ReadableStream to a WritableStream.
 * Unlike pipeTo(), this resolves when:
 * 1. The source stream completes (close/error), OR
 * 2. The user releases their lock on userStream AND all pending writes are flushed
 *
 * @param source - The readable stream to read from (e.g., transform's readable)
 * @param sink - The writable stream to write to (e.g., server writable)
 * @param state - The flushable state tracker
 * @returns Promise that resolves when stream ends (not when done promise resolves)
 */
async function flushablePipe(source, sink, state) {
    const reader = source.getReader();
    const writer = sink.getWriter();
    try {
        while (true) {
            // Check if stream has ended
            if (state.streamEnded) {
                return;
            }
            // Read from source - don't count as pending op since we're just waiting for data
            // The important ops are writes to the sink (server)
            const readResult = await reader.read();
            // Check if stream has ended (e.g., due to error in another path) before processing
            if (state.streamEnded) {
                return;
            }
            if (readResult.done) {
                // Source stream completed - close sink and resolve
                state.streamEnded = true;
                await writer.close();
                // Resolve done promise if not already resolved
                if (!state.doneResolved) {
                    state.doneResolved = true;
                    state.resolve();
                }
                return;
            }
            // Count write as a pending op - this is what we need to flush
            state.pendingOps++;
            try {
                await writer.write(readResult.value);
            }
            finally {
                state.pendingOps--;
            }
        }
    }
    catch (err) {
        state.streamEnded = true;
        if (!state.doneResolved) {
            state.doneResolved = true;
            state.reject(err);
        }
        // Propagate error through flushablePipe's own promise as well.
        // Callers that rely on the FlushableStreamState should use `state.promise`,
        // while other callers may depend on this rejection. Some known callers
        // explicitly ignore this rejection (`.catch(() => {})`) and rely solely
        // on `state.reject(err)` for error handling.
        throw err;
    }
    finally {
        reader.releaseLock();
        writer.releaseLock();
    }
}

const contextStorage = /* @__PURE__ */ new AsyncLocalStorage();

/**
 * Utils used by the bundler when transforming code
 */
const registeredSteps = new Map();
function getStepIdAliasCandidates(stepId) {
    const parts = stepId.split('//');
    if (parts.length !== 3 || parts[0] !== 'step') {
        return [];
    }
    const modulePath = parts[1];
    const fnName = parts[2];
    const modulePathAliases = new Set();
    const addAlias = (aliasModulePath) => {
        if (aliasModulePath !== modulePath) {
            modulePathAliases.add(aliasModulePath);
        }
    };
    if (modulePath.startsWith('./workflows/')) {
        const workflowRelativePath = modulePath.slice('./'.length);
        addAlias(`./example/${workflowRelativePath}`);
        addAlias(`./src/${workflowRelativePath}`);
    }
    else if (modulePath.startsWith('./example/workflows/')) {
        const workflowRelativePath = modulePath.slice('./example/'.length);
        addAlias(`./${workflowRelativePath}`);
        addAlias(`./src/${workflowRelativePath}`);
    }
    else if (modulePath.startsWith('./src/workflows/')) {
        const workflowRelativePath = modulePath.slice('./src/'.length);
        addAlias(`./${workflowRelativePath}`);
        addAlias(`./example/${workflowRelativePath}`);
    }
    return Array.from(modulePathAliases, (aliasModulePath) => `step//${aliasModulePath}//${fnName}`);
}
/**
 * Register a step function to be served in the server bundle.
 * Also sets the stepId property on the function for serialization support.
 */
function registerStepFunction(stepId, stepFn) {
    registeredSteps.set(stepId, stepFn);
    stepFn.stepId = stepId;
}
/**
 * Find a registered step function by name
 */
function getStepFunction(stepId) {
    const directMatch = registeredSteps.get(stepId);
    if (directMatch) {
        return directMatch;
    }
    // Support equivalent workflow path aliases in mixed symlink environments.
    for (const aliasStepId of getStepIdAliasCandidates(stepId)) {
        const aliasMatch = registeredSteps.get(aliasStepId);
        if (aliasMatch) {
            return aliasMatch;
        }
    }
    return undefined;
}

// ============================================================================
// Serialization Format Prefix System
// ============================================================================
//
// All serialized payloads are prefixed with a 4-byte format identifier that
// allows the client to determine how to decode the payload. This enables:
//
// 1. Self-describing payloads - The World layer is agnostic to serialization format
// 2. Gradual migration - Old runs keep working, new runs can use new formats
// 3. Composability - Encryption can wrap any format (e.g., "encr" wrapping "devl")
// 4. Debugging - Raw data inspection immediately reveals the format
//
// Format: [4 bytes: format identifier][payload]
//
// The 4-character prefix convention matches other workflow IDs (wrun, step, wait, etc.)
//
// Current formats:
// - "devl" - devalue stringify/parse with TextEncoder/TextDecoder (current default)
//
// Future formats (reserved):
// - "cbor" - CBOR binary serialization
// - "encr" - Encrypted payload (inner payload has its own format prefix)
/**
 * Known serialization format identifiers.
 * Each format ID is exactly 4 ASCII characters, matching the convention
 * used for other workflow IDs (wrun, step, wait, etc.)
 */
const SerializationFormat = {
    /** devalue stringify/parse with TextEncoder/TextDecoder */
    DEVALUE_V1: 'devl',
};
/** Length of the format prefix in bytes */
const FORMAT_PREFIX_LENGTH = 4;
/** TextEncoder instance for format prefix encoding */
const formatEncoder = new TextEncoder();
/** TextDecoder instance for format prefix decoding */
const formatDecoder = new TextDecoder();
/**
 * Encode a payload with a format prefix.
 *
 * @param format - The format identifier (must be exactly 4 ASCII characters)
 * @param payload - The serialized payload bytes
 * @returns A new Uint8Array with format prefix prepended
 */
function encodeWithFormatPrefix(format, payload) {
    if (!(payload instanceof Uint8Array)) {
        return payload;
    }
    const prefixBytes = formatEncoder.encode(format);
    if (prefixBytes.length !== FORMAT_PREFIX_LENGTH) {
        throw new Error(`Format identifier must be exactly ${FORMAT_PREFIX_LENGTH} ASCII characters, got "${format}" (${prefixBytes.length} bytes)`);
    }
    const result = new Uint8Array(FORMAT_PREFIX_LENGTH + payload.length);
    result.set(prefixBytes, 0);
    result.set(payload, FORMAT_PREFIX_LENGTH);
    return result;
}
/**
 * Decode a format-prefixed payload.
 *
 * @param data - The format-prefixed data
 * @returns An object with the format identifier and payload
 * @throws Error if the data is too short or has an unknown format
 */
function decodeFormatPrefix(data) {
    // Compat for legacy specVersion 1 runs that don't have a format prefix,
    // and don't have a binary payload
    if (!(data instanceof Uint8Array)) {
        return {
            format: SerializationFormat.DEVALUE_V1,
            payload: new TextEncoder().encode(JSON.stringify(data)),
        };
    }
    if (data.length < FORMAT_PREFIX_LENGTH) {
        throw new Error(`Data too short to contain format prefix: expected at least ${FORMAT_PREFIX_LENGTH} bytes, got ${data.length}`);
    }
    const prefixBytes = data.subarray(0, FORMAT_PREFIX_LENGTH);
    const format = formatDecoder.decode(prefixBytes);
    // Validate the format is known
    const knownFormats = Object.values(SerializationFormat);
    if (!knownFormats.includes(format)) {
        throw new Error(`Unknown serialization format: "${format}". Known formats: ${knownFormats.join(', ')}`);
    }
    const payload = data.subarray(FORMAT_PREFIX_LENGTH);
    return { format: format, payload };
}
/**
 * Default ULID generator for contexts where VM's seeded `stableUlid` isn't available.
 * Used as a fallback when serializing streams outside the workflow VM context
 * (e.g., when starting a workflow or handling step return values).
 */
const defaultUlid = monotonicFactory();
/**
 * Format a serialization error with context about what failed.
 * Extracts path, value, and reason from devalue's DevalueError when available.
 * Logs the problematic value to the console for better debugging.
 */
function formatSerializationError(context, error) {
    // Use "returning" for return values, "passing" for arguments/inputs
    const verb = context.includes('return value') ? 'returning' : 'passing';
    // Build the error message with path info if available from DevalueError
    let message = `Failed to serialize ${context}`;
    if (error instanceof DevalueError && error.path) {
        message += ` at path "${error.path}"`;
    }
    message += `. Ensure you're ${verb} serializable types (plain objects, arrays, primitives, Date, RegExp, Map, Set).`;
    // Log the problematic value for debugging
    if (error instanceof DevalueError && error.value !== undefined) {
        runtimeLogger.error('Serialization failed', {
            context,
            problematicValue: error.value,
        });
    }
    return message;
}
/**
 * Detect if a readable stream is a byte stream.
 *
 * @param stream
 * @returns `"bytes"` if the stream is a byte stream, `undefined` otherwise
 */
function getStreamType(stream) {
    try {
        const reader = stream.getReader({ mode: 'byob' });
        reader.releaseLock();
        return 'bytes';
    }
    catch { }
}
/**
 * Frame format for stream chunks:
 *   [4-byte big-endian length][format-prefixed payload]
 *
 * Each chunk is independently framed so the deserializer can find
 * chunk boundaries even when multiple chunks are concatenated or
 * split across transport reads.
 */
const FRAME_HEADER_SIZE = 4;
function getSerializeStream(reducers) {
    const encoder = new TextEncoder();
    const stream = new TransformStream({
        transform(chunk, controller) {
            try {
                const serialized = stringify(chunk, reducers);
                const payload = encoder.encode(serialized);
                const prefixed = encodeWithFormatPrefix(SerializationFormat.DEVALUE_V1, payload);
                // Write length-prefixed frame: [4-byte length][prefixed data]
                const frame = new Uint8Array(FRAME_HEADER_SIZE + prefixed.length);
                new DataView(frame.buffer).setUint32(0, prefixed.length, false);
                frame.set(prefixed, FRAME_HEADER_SIZE);
                controller.enqueue(frame);
            }
            catch (error) {
                controller.error(new WorkflowRuntimeError(formatSerializationError('stream chunk', error), { slug: 'serialization-failed', cause: error }));
            }
        },
    });
    return stream;
}
function getDeserializeStream(revivers) {
    const decoder = new TextDecoder();
    let buffer = new Uint8Array(0);
    function appendToBuffer(data) {
        const newBuffer = new Uint8Array(buffer.length + data.length);
        newBuffer.set(buffer, 0);
        newBuffer.set(data, buffer.length);
        buffer = newBuffer;
    }
    function processFrames(controller) {
        // Try to extract complete length-prefixed frames
        while (buffer.length >= FRAME_HEADER_SIZE) {
            const frameLength = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(0, false);
            if (buffer.length < FRAME_HEADER_SIZE + frameLength) {
                break; // Incomplete frame, wait for more data
            }
            const frameData = buffer.slice(FRAME_HEADER_SIZE, FRAME_HEADER_SIZE + frameLength);
            buffer = buffer.slice(FRAME_HEADER_SIZE + frameLength);
            const { format, payload } = decodeFormatPrefix(frameData);
            if (format === SerializationFormat.DEVALUE_V1) {
                const text = decoder.decode(payload);
                controller.enqueue(parse(text, revivers));
            }
        }
    }
    const stream = new TransformStream({
        transform(chunk, controller) {
            // First, try to detect if this is length-prefixed framed data
            // by checking if the first 4 bytes form a plausible length.
            if (buffer.length === 0 && chunk.length >= FRAME_HEADER_SIZE) {
                const possibleLength = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength).getUint32(0, false);
                if (possibleLength > 0 &&
                    possibleLength < 100_000_000 // sanity check: < 100MB
                ) {
                    // Looks like framed data
                    appendToBuffer(chunk);
                    processFrames(controller);
                    return;
                }
            }
            else if (buffer.length > 0) {
                // Already in framed mode (have buffered data)
                appendToBuffer(chunk);
                processFrames(controller);
                return;
            }
            // Legacy format: newline-delimited devalue text (no framing)
            const text = decoder.decode(chunk);
            const lines = text.split('\n');
            for (const line of lines) {
                if (line.length > 0) {
                    controller.enqueue(parse(line, revivers));
                }
            }
        },
        flush(controller) {
            // Process any remaining framed data
            if (buffer.length > 0) {
                processFrames(controller);
            }
        },
    });
    return stream;
}
class WorkflowServerReadableStream extends ReadableStream {
    #reader;
    constructor(name, startIndex) {
        if (typeof name !== 'string' || name.length === 0) {
            throw new Error(`"name" is required, got "${name}"`);
        }
        super({
            // @ts-expect-error Not sure why TypeScript is complaining about this
            type: 'bytes',
            pull: async (controller) => {
                let reader = this.#reader;
                if (!reader) {
                    const world = getWorld();
                    const stream = await world.readFromStream(name, startIndex);
                    reader = this.#reader = stream.getReader();
                }
                if (!reader) {
                    controller.error(new Error('Failed to get reader'));
                    return;
                }
                const result = await reader.read();
                if (result.done) {
                    this.#reader = undefined;
                    controller.close();
                }
                else {
                    controller.enqueue(result.value);
                }
            },
        });
    }
}
/**
 * Default flush interval in milliseconds for buffered stream writes.
 * Chunks are accumulated and flushed together to reduce network overhead.
 */
const STREAM_FLUSH_INTERVAL_MS = 10;
class WorkflowServerWritableStream extends WritableStream {
    constructor(name, runId) {
        if (typeof runId !== 'string') {
            throw new Error(`"runId" must be a string, got "${typeof runId}"`);
        }
        if (typeof name !== 'string' || name.length === 0) {
            throw new Error(`"name" is required, got "${name}"`);
        }
        const world = getWorld();
        // Buffering state for batched writes
        let buffer = [];
        let flushTimer = null;
        let flushPromise = null;
        const flush = async () => {
            if (flushTimer) {
                clearTimeout(flushTimer);
                flushTimer = null;
            }
            if (buffer.length === 0)
                return;
            // Copy chunks to flush, but don't clear buffer until write succeeds
            // This prevents data loss if the write operation fails
            const chunksToFlush = buffer.slice();
            // Use writeToStreamMulti if available for batch writes
            if (typeof world.writeToStreamMulti === 'function' &&
                chunksToFlush.length > 1) {
                await world.writeToStreamMulti(name, runId, chunksToFlush);
            }
            else {
                // Fall back to sequential writes
                for (const chunk of chunksToFlush) {
                    await world.writeToStream(name, runId, chunk);
                }
            }
            // Only clear buffer after successful write to prevent data loss
            buffer = [];
        };
        const scheduleFlush = () => {
            if (flushTimer)
                return; // Already scheduled
            flushTimer = setTimeout(() => {
                flushTimer = null;
                flushPromise = flush();
            }, STREAM_FLUSH_INTERVAL_MS);
        };
        super({
            async write(chunk) {
                // Wait for any in-progress flush to complete before adding to buffer
                if (flushPromise) {
                    await flushPromise;
                    flushPromise = null;
                }
                buffer.push(chunk);
                scheduleFlush();
            },
            async close() {
                // Wait for any in-progress flush to complete
                if (flushPromise) {
                    await flushPromise;
                    flushPromise = null;
                }
                // Flush any remaining buffered chunks
                await flush();
                await world.closeStream(name, runId);
            },
            abort() {
                // Clean up timer to prevent leaks
                if (flushTimer) {
                    clearTimeout(flushTimer);
                    flushTimer = null;
                }
                // Discard buffered chunks - they won't be written
                buffer = [];
            },
        });
    }
}
function revive(str) {
    // biome-ignore lint/security/noGlobalEval: Eval is safe here - we are only passing value from `devalue.stringify()`
    // biome-ignore lint/complexity/noCommaOperator: This is how you do global scope eval
    return (0, eval)(`(${str})`);
}
function getCommonReducers(global = globalThis) {
    const abToBase64 = (value, offset, length) => {
        // Avoid returning falsy value for zero-length buffers
        if (length === 0)
            return '.';
        // Create a proper copy to avoid ArrayBuffer detachment issues
        // Buffer.from(ArrayBuffer, offset, length) creates a view, not a copy
        const uint8 = new Uint8Array(value, offset, length);
        return Buffer.from(uint8).toString('base64');
    };
    const viewToBase64 = (value) => abToBase64(value.buffer, value.byteOffset, value.byteLength);
    return {
        ArrayBuffer: (value) => value instanceof global.ArrayBuffer &&
            abToBase64(value, 0, value.byteLength),
        BigInt: (value) => typeof value === 'bigint' && value.toString(),
        BigInt64Array: (value) => value instanceof global.BigInt64Array && viewToBase64(value),
        BigUint64Array: (value) => value instanceof global.BigUint64Array && viewToBase64(value),
        Date: (value) => {
            if (!(value instanceof global.Date))
                return false;
            const valid = !Number.isNaN(value.getDate());
            // Note: "." is to avoid returning a falsy value when the date is invalid
            return valid ? value.toISOString() : '.';
        },
        Error: (value) => {
            if (!(value instanceof global.Error))
                return false;
            return {
                name: value.name,
                message: value.message,
                stack: value.stack,
            };
        },
        Float32Array: (value) => value instanceof global.Float32Array && viewToBase64(value),
        Float64Array: (value) => value instanceof global.Float64Array && viewToBase64(value),
        Headers: (value) => value instanceof global.Headers && Array.from(value),
        Int8Array: (value) => value instanceof global.Int8Array && viewToBase64(value),
        Int16Array: (value) => value instanceof global.Int16Array && viewToBase64(value),
        Int32Array: (value) => value instanceof global.Int32Array && viewToBase64(value),
        Map: (value) => value instanceof global.Map && Array.from(value),
        RegExp: (value) => value instanceof global.RegExp && {
            source: value.source,
            flags: value.flags,
        },
        Request: (value) => {
            if (!(value instanceof global.Request))
                return false;
            const data = {
                method: value.method,
                url: value.url,
                headers: value.headers,
                body: value.body,
                duplex: value.duplex,
            };
            const responseWritable = value[WEBHOOK_RESPONSE_WRITABLE];
            if (responseWritable) {
                data.responseWritable = responseWritable;
            }
            return data;
        },
        Response: (value) => {
            if (!(value instanceof global.Response))
                return false;
            return {
                type: value.type,
                url: value.url,
                status: value.status,
                statusText: value.statusText,
                headers: value.headers,
                body: value.body,
                redirected: value.redirected,
            };
        },
        Class: (value) => {
            // Check if this is a class constructor with a classId property
            // (set by the SWC plugin for classes with static step/workflow methods)
            if (typeof value !== 'function')
                return false;
            const classId = value.classId;
            if (typeof classId !== 'string')
                return false;
            return { classId };
        },
        Instance: (value) => {
            // Check if this is an instance of a class with custom serialization
            if (value === null || typeof value !== 'object')
                return false;
            const cls = value.constructor;
            if (!cls || typeof cls !== 'function')
                return false;
            // Check if the class has a static WORKFLOW_SERIALIZE method
            const serialize = cls[WORKFLOW_SERIALIZE];
            if (typeof serialize !== 'function') {
                return false;
            }
            // Get the classId from the static class property (set by SWC plugin)
            const classId = cls.classId;
            if (typeof classId !== 'string') {
                throw new Error(`Class "${cls.name}" with ${String(WORKFLOW_SERIALIZE)} must have a static "classId" property.`);
            }
            // Serialize the instance using the custom serializer
            const data = serialize.call(cls, value);
            return { classId, data };
        },
        Set: (value) => value instanceof global.Set && Array.from(value),
        StepFunction: (value) => {
            if (typeof value !== 'function')
                return false;
            const stepId = value.stepId;
            if (typeof stepId !== 'string')
                return false;
            // Check if the step function has closure variables
            const closureVarsFn = value.__closureVarsFn;
            if (closureVarsFn && typeof closureVarsFn === 'function') {
                // Invoke the closure variables function and serialize along with stepId
                const closureVars = closureVarsFn();
                return { stepId, closureVars };
            }
            // No closure variables - return object with just stepId
            return { stepId };
        },
        URL: (value) => value instanceof global.URL && value.href,
        URLSearchParams: (value) => {
            if (!(value instanceof global.URLSearchParams))
                return false;
            // Avoid returning a falsy value when the URLSearchParams is empty
            if (value.size === 0)
                return '.';
            return String(value);
        },
        Uint8Array: (value) => value instanceof global.Uint8Array && viewToBase64(value),
        Uint8ClampedArray: (value) => value instanceof global.Uint8ClampedArray && viewToBase64(value),
        Uint16Array: (value) => value instanceof global.Uint16Array && viewToBase64(value),
        Uint32Array: (value) => value instanceof global.Uint32Array && viewToBase64(value),
    };
}
/**
 * Reducers for serialization boundary from the client side, passing arguments
 * to the workflow handler.
 *
 * @param global
 * @param ops
 * @returns
 */
function getExternalReducers(global = globalThis, ops, runId) {
    return {
        ...getCommonReducers(global),
        ReadableStream: (value) => {
            if (!(value instanceof global.ReadableStream))
                return false;
            // Stream must not be locked when passing across execution boundary
            if (value.locked) {
                throw new Error('ReadableStream is locked');
            }
            const streamId = (global[STABLE_ULID] || defaultUlid)();
            const name = `strm_${streamId}`;
            const type = getStreamType(value);
            const writable = new WorkflowServerWritableStream(name, runId);
            if (type === 'bytes') {
                ops.push(value.pipeTo(writable));
            }
            else {
                ops.push(value
                    .pipeThrough(getSerializeStream(getExternalReducers(global, ops, runId)))
                    .pipeTo(writable));
            }
            const s = { name };
            if (type)
                s.type = type;
            return s;
        },
        WritableStream: (value) => {
            if (!(value instanceof global.WritableStream))
                return false;
            const streamId = (global[STABLE_ULID] || defaultUlid)();
            const name = `strm_${streamId}`;
            const readable = new WorkflowServerReadableStream(name);
            ops.push(readable.pipeTo(value));
            return { name };
        },
    };
}
/**
 * Reducers for serialization boundary from within the workflow execution
 * environment, passing return value to the client side and into step arguments.
 *
 * @param global
 * @returns
 */
function getWorkflowReducers(global = globalThis) {
    return {
        ...getCommonReducers(global),
        // Readable/Writable streams from within the workflow execution environment
        // are simply "handles" that can be passed around to other steps.
        ReadableStream: (value) => {
            if (!(value instanceof global.ReadableStream))
                return false;
            // Check if this is a fake stream storing BodyInit from Request/Response constructor
            const bodyInit = value[BODY_INIT_SYMBOL];
            if (bodyInit !== undefined) {
                // This is a fake stream - serialize the BodyInit directly
                // devalue will handle serializing strings, Uint8Array, etc.
                return { bodyInit };
            }
            const name = value[STREAM_NAME_SYMBOL];
            if (!name) {
                throw new Error('ReadableStream `name` is not set');
            }
            const s = { name };
            const type = value[STREAM_TYPE_SYMBOL];
            if (type)
                s.type = type;
            return s;
        },
        WritableStream: (value) => {
            if (!(value instanceof global.WritableStream))
                return false;
            const name = value[STREAM_NAME_SYMBOL];
            if (!name) {
                throw new Error('WritableStream `name` is not set');
            }
            return { name };
        },
    };
}
/**
 * Reducers for serialization boundary from within the step execution
 * environment, passing return value to the workflow handler.
 *
 * @param global
 * @param ops
 * @param runId
 * @returns
 */
function getStepReducers(global = globalThis, ops, runId) {
    return {
        ...getCommonReducers(global),
        ReadableStream: (value) => {
            if (!(value instanceof global.ReadableStream))
                return false;
            // Stream must not be locked when passing across execution boundary
            if (value.locked) {
                throw new Error('ReadableStream is locked');
            }
            // Check if the stream already has the name symbol set, in which case
            // it's already being sunk to the server and we can just return the
            // name and type.
            let name = value[STREAM_NAME_SYMBOL];
            let type = value[STREAM_TYPE_SYMBOL];
            if (!name) {
                if (!runId) {
                    throw new Error('ReadableStream cannot be serialized without a valid runId');
                }
                const streamId = (global[STABLE_ULID] || defaultUlid)();
                name = `strm_${streamId}`;
                type = getStreamType(value);
                const writable = new WorkflowServerWritableStream(name, runId);
                if (type === 'bytes') {
                    ops.push(value.pipeTo(writable));
                }
                else {
                    ops.push(value
                        .pipeThrough(getSerializeStream(getStepReducers(global, ops, runId)))
                        .pipeTo(writable));
                }
            }
            const s = { name };
            if (type)
                s.type = type;
            return s;
        },
        WritableStream: (value) => {
            if (!(value instanceof global.WritableStream))
                return false;
            let name = value[STREAM_NAME_SYMBOL];
            if (!name) {
                if (!runId) {
                    throw new Error('WritableStream cannot be serialized without a valid runId');
                }
                const streamId = (global[STABLE_ULID] || defaultUlid)();
                name = `strm_${streamId}`;
                ops.push(new WorkflowServerReadableStream(name)
                    .pipeThrough(getDeserializeStream(getStepRevivers(global, ops, runId)))
                    .pipeTo(value));
            }
            return { name };
        },
    };
}
function getCommonRevivers(global = globalThis) {
    function reviveArrayBuffer(value) {
        // Handle sentinel value for zero-length buffers
        const base64 = value === '.' ? '' : value;
        const buffer = Buffer.from(base64, 'base64');
        const arrayBuffer = new global.ArrayBuffer(buffer.length);
        const uint8Array = new global.Uint8Array(arrayBuffer);
        uint8Array.set(buffer);
        return arrayBuffer;
    }
    return {
        ArrayBuffer: reviveArrayBuffer,
        BigInt: (value) => global.BigInt(value),
        BigInt64Array: (value) => {
            const ab = reviveArrayBuffer(value);
            return new global.BigInt64Array(ab);
        },
        BigUint64Array: (value) => {
            const ab = reviveArrayBuffer(value);
            return new global.BigUint64Array(ab);
        },
        Date: (value) => new global.Date(value),
        Error: (value) => {
            const error = new global.Error(value.message);
            error.name = value.name;
            error.stack = value.stack;
            return error;
        },
        Float32Array: (value) => {
            const ab = reviveArrayBuffer(value);
            return new global.Float32Array(ab);
        },
        Float64Array: (value) => {
            const ab = reviveArrayBuffer(value);
            return new global.Float64Array(ab);
        },
        Headers: (value) => new global.Headers(value),
        Int8Array: (value) => {
            const ab = reviveArrayBuffer(value);
            return new global.Int8Array(ab);
        },
        Int16Array: (value) => {
            const ab = reviveArrayBuffer(value);
            return new global.Int16Array(ab);
        },
        Int32Array: (value) => {
            const ab = reviveArrayBuffer(value);
            return new global.Int32Array(ab);
        },
        Map: (value) => new global.Map(value),
        RegExp: (value) => new global.RegExp(value.source, value.flags),
        Class: (value) => {
            const classId = value.classId;
            // Pass the global object to support VM contexts where classes are registered
            // on the VM's global rather than the host's globalThis
            const cls = getSerializationClass(classId, global);
            if (!cls) {
                throw new Error(`Class "${classId}" not found. Make sure the class is registered with registerSerializationClass.`);
            }
            return cls;
        },
        Instance: (value) => {
            const classId = value.classId;
            const data = value.data;
            // Look up the class by classId from the registry
            // Pass the global object to support VM contexts where classes are registered
            // on the VM's global rather than the host's globalThis
            const cls = getSerializationClass(classId, global);
            if (!cls) {
                throw new Error(`Class "${classId}" not found. Make sure the class is registered with registerSerializationClass.`);
            }
            // Get the deserializer from the class
            const deserialize = cls[WORKFLOW_DESERIALIZE];
            if (typeof deserialize !== 'function') {
                throw new Error(`Class "${classId}" does not have a static ${String(WORKFLOW_DESERIALIZE)} method.`);
            }
            // Deserialize the instance using the custom deserializer
            return deserialize.call(cls, data);
        },
        Set: (value) => new global.Set(value),
        URL: (value) => new global.URL(value),
        URLSearchParams: (value) => new global.URLSearchParams(value === '.' ? '' : value),
        Uint8Array: (value) => {
            const ab = reviveArrayBuffer(value);
            return new global.Uint8Array(ab);
        },
        Uint8ClampedArray: (value) => {
            const ab = reviveArrayBuffer(value);
            return new global.Uint8ClampedArray(ab);
        },
        Uint16Array: (value) => {
            const ab = reviveArrayBuffer(value);
            return new global.Uint16Array(ab);
        },
        Uint32Array: (value) => {
            const ab = reviveArrayBuffer(value);
            return new global.Uint32Array(ab);
        },
    };
}
/**
 * Revivers for deserialization boundary from the client side,
 * receiving the return value from the workflow handler.
 *
 * @param global
 * @param ops
 * @param runId
 */
function getExternalRevivers(global = globalThis, ops, runId) {
    return {
        ...getCommonRevivers(global),
        // StepFunction should not be returned from workflows to clients
        StepFunction: () => {
            throw new Error('Step functions cannot be deserialized in client context. Step functions should not be returned from workflows.');
        },
        Request: (value) => {
            return new global.Request(value.url, {
                method: value.method,
                headers: new global.Headers(value.headers),
                body: value.body,
                duplex: value.duplex,
            });
        },
        Response: (value) => {
            // Note: Response constructor only accepts status, statusText, and headers
            // The type, url, and redirected properties are read-only and set by the constructor
            return new global.Response(value.body, {
                status: value.status,
                statusText: value.statusText,
                headers: new global.Headers(value.headers),
            });
        },
        ReadableStream: (value) => {
            // If this has bodyInit, it came from a Response constructor
            // Convert it to a REAL stream now that we're outside the workflow
            if ('bodyInit' in value) {
                const bodyInit = value.bodyInit;
                // Use the native Response constructor to properly convert BodyInit to ReadableStream
                const response = new global.Response(bodyInit);
                return response.body;
            }
            const readable = new WorkflowServerReadableStream(value.name, value.startIndex);
            if (value.type === 'bytes') {
                // For byte streams, use flushable pipe with lock polling
                const state = createFlushableState();
                ops.push(state.promise);
                // Create an identity transform to give the user a readable
                const { readable: userReadable, writable } = new global.TransformStream();
                // Start the flushable pipe in the background
                flushablePipe(readable, writable, state).catch(() => {
                    // Errors are handled via state.reject
                });
                // Start polling to detect when user releases lock
                pollReadableLock(userReadable, state);
                return userReadable;
            }
            else {
                const transform = getDeserializeStream(getExternalRevivers(global, ops, runId));
                const state = createFlushableState();
                ops.push(state.promise);
                // Start the flushable pipe in the background
                flushablePipe(readable, transform.writable, state).catch(() => {
                    // Errors are handled via state.reject
                });
                // Start polling to detect when user releases lock
                pollReadableLock(transform.readable, state);
                return transform.readable;
            }
        },
        WritableStream: (value) => {
            const serialize = getSerializeStream(getExternalReducers(global, ops, runId));
            const serverWritable = new WorkflowServerWritableStream(value.name, runId);
            // Create flushable state for this stream
            const state = createFlushableState();
            ops.push(state.promise);
            // Start the flushable pipe in the background
            flushablePipe(serialize.readable, serverWritable, state).catch(() => {
                // Errors are handled via state.reject
            });
            // Start polling to detect when user releases lock
            pollWritableLock(serialize.writable, state);
            return serialize.writable;
        },
    };
}
/**
 * Revivers for deserialization boundary from within the workflow execution
 * environment, receiving arguments from the client side, and return values
 * from the steps.
 *
 * @param global
 * @returns
 */
function getWorkflowRevivers(global = globalThis) {
    // Get the useStep function from the VM's globalThis
    // This is set up by the workflow runner in workflow.ts
    // Use Symbol.for directly to access the symbol on the global object
    const useStep = global[Symbol.for('WORKFLOW_USE_STEP')];
    return {
        ...getCommonRevivers(global),
        // StepFunction reviver for workflow context - returns useStep wrapper
        // This allows step functions passed as arguments to start() to be called directly
        // from workflow code, just like step functions defined in the same file
        StepFunction: (value) => {
            const stepId = value.stepId;
            const closureVars = value.closureVars;
            if (!useStep) {
                throw new Error('WORKFLOW_USE_STEP not found on global object. Step functions cannot be deserialized outside workflow context.');
            }
            if (closureVars) {
                // For step functions with closure variables, create a wrapper that provides them
                return useStep(stepId, () => closureVars);
            }
            return useStep(stepId);
        },
        Request: (value) => {
            Object.setPrototypeOf(value, global.Request.prototype);
            const responseWritable = value.responseWritable;
            if (responseWritable) {
                value[WEBHOOK_RESPONSE_WRITABLE] = responseWritable;
                delete value.responseWritable;
                value.respondWith = () => {
                    throw new Error('`respondWith()` must be called from within a step function');
                };
            }
            return value;
        },
        Response: (value) => {
            Object.setPrototypeOf(value, global.Response.prototype);
            return value;
        },
        ReadableStream: (value) => {
            // Check if this is a BodyInit that should be wrapped in a fake stream
            if ('bodyInit' in value) {
                // Recreate the fake stream with the BodyInit
                return Object.create(global.ReadableStream.prototype, {
                    [BODY_INIT_SYMBOL]: {
                        value: value.bodyInit,
                        writable: false,
                    },
                });
            }
            // Regular stream handling
            return Object.create(global.ReadableStream.prototype, {
                [STREAM_NAME_SYMBOL]: {
                    value: value.name,
                    writable: false,
                },
                [STREAM_TYPE_SYMBOL]: {
                    value: value.type,
                    writable: false,
                },
            });
        },
        WritableStream: (value) => {
            return Object.create(global.WritableStream.prototype, {
                [STREAM_NAME_SYMBOL]: {
                    value: value.name,
                    writable: false,
                },
            });
        },
    };
}
/**
 * Revivers for deserialization boundary from within the step execution
 * environment, receiving arguments from the workflow handler.
 *
 * @param global
 * @param ops
 * @param runId
 * @returns
 */
function getStepRevivers(global = globalThis, ops, runId) {
    return {
        ...getCommonRevivers(global),
        // StepFunction reviver for step context - returns raw step function
        // with closure variable support via AsyncLocalStorage
        StepFunction: (value) => {
            const stepId = value.stepId;
            const closureVars = value.closureVars;
            const stepFn = getStepFunction(stepId);
            if (!stepFn) {
                throw new Error(`Step function "${stepId}" not found. Make sure the step function is registered.`);
            }
            // If closure variables were serialized, return a wrapper function
            // that sets up AsyncLocalStorage context when invoked
            if (closureVars) {
                const wrappedStepFn = ((...args) => {
                    // Get the current context from AsyncLocalStorage
                    const currentContext = contextStorage.getStore();
                    if (!currentContext) {
                        throw new Error('Cannot call step function with closure variables outside step context');
                    }
                    // Create a new context with the closure variables merged in
                    const newContext = {
                        ...currentContext,
                        closureVars,
                    };
                    // Run the step function with the new context that includes closure vars
                    return contextStorage.run(newContext, () => stepFn(...args));
                });
                // Copy properties from original step function
                Object.defineProperty(wrappedStepFn, 'name', {
                    value: stepFn.name,
                });
                Object.defineProperty(wrappedStepFn, 'stepId', {
                    value: stepId,
                    writable: false,
                    enumerable: false,
                    configurable: false,
                });
                if (stepFn.maxRetries !== undefined) {
                    wrappedStepFn.maxRetries = stepFn.maxRetries;
                }
                return wrappedStepFn;
            }
            return stepFn;
        },
        Request: (value) => {
            const responseWritable = value.responseWritable;
            const request = new global.Request(value.url, {
                method: value.method,
                headers: new global.Headers(value.headers),
                body: value.body,
                duplex: value.duplex,
            });
            if (responseWritable) {
                request.respondWith = async (response) => {
                    const writer = responseWritable.getWriter();
                    await writer.write(response);
                    await writer.close();
                };
            }
            return request;
        },
        Response: (value) => {
            // Note: Response constructor only accepts status, statusText, and headers
            // The type, url, and redirected properties are read-only and set by the constructor
            return new global.Response(value.body, {
                status: value.status,
                statusText: value.statusText,
                headers: new global.Headers(value.headers),
            });
        },
        ReadableStream: (value) => {
            // If this has bodyInit, it came from a Response constructor
            // Convert it to a REAL stream now that we're in the step environment
            if ('bodyInit' in value) {
                const bodyInit = value.bodyInit;
                // Use the native Response constructor to properly convert BodyInit to ReadableStream
                const response = new global.Response(bodyInit);
                return response.body;
            }
            const readable = new WorkflowServerReadableStream(value.name);
            if (value.type === 'bytes') {
                // For byte streams, use flushable pipe with lock polling
                const state = createFlushableState();
                ops.push(state.promise);
                // Create an identity transform to give the user a readable
                const { readable: userReadable, writable } = new global.TransformStream();
                // Start the flushable pipe in the background
                flushablePipe(readable, writable, state).catch(() => {
                    // Errors are handled via state.reject
                });
                // Start polling to detect when user releases lock
                pollReadableLock(userReadable, state);
                return userReadable;
            }
            else {
                const transform = getDeserializeStream(getStepRevivers(global, ops, runId));
                const state = createFlushableState();
                ops.push(state.promise);
                // Start the flushable pipe in the background
                flushablePipe(readable, transform.writable, state).catch(() => {
                    // Errors are handled via state.reject
                });
                // Start polling to detect when user releases lock
                pollReadableLock(transform.readable, state);
                return transform.readable;
            }
        },
        WritableStream: (value) => {
            if (!runId) {
                throw new Error('WritableStream cannot be revived without a valid runId');
            }
            const serialize = getSerializeStream(getStepReducers(global, ops, runId));
            const serverWritable = new WorkflowServerWritableStream(value.name, runId);
            // Create flushable state for this stream
            const state = createFlushableState();
            ops.push(state.promise);
            // Start the flushable pipe in the background
            flushablePipe(serialize.readable, serverWritable, state).catch(() => {
                // Errors are handled via state.reject
            });
            // Start polling to detect when user releases lock
            pollWritableLock(serialize.writable, state);
            return serialize.writable;
        },
    };
}
/**
 * Called from the `start()` function to serialize the workflow arguments
 * into a format that can be saved to the database and then hydrated from
 * within the workflow execution environment.
 *
 * @param value - The workflow arguments to serialize
 * @param runId - The workflow run ID (used for stream serialization)
 * @param _key - Per-run AES-256 encryption key, or undefined to skip encryption
 * @param ops - Array to collect pending async operations (e.g., stream uploads)
 * @param global - The global object for custom type serialization
 * @param v1Compat - Whether to use legacy v1 serialization format
 * @returns The dehydrated value as binary data (Uint8Array) with format prefix
 */
async function dehydrateWorkflowArguments(value, runId, _key, ops = [], global = globalThis, v1Compat = false) {
    try {
        const str = stringify(value, getExternalReducers(global, ops, runId));
        if (v1Compat) {
            return revive(str);
        }
        const payload = new TextEncoder().encode(str);
        return encodeWithFormatPrefix(SerializationFormat.DEVALUE_V1, payload);
    }
    catch (error) {
        throw new WorkflowRuntimeError(formatSerializationError('workflow arguments', error), { slug: 'serialization-failed', cause: error });
    }
}
/**
 * Called from workflow execution environment to hydrate the workflow
 * arguments from the database at the start of workflow execution.
 *
 * @param value - Binary serialized data (Uint8Array) with format prefix
 * @param _runId - The workflow run ID (reserved for future encryption use)
 * @param _key - Per-run AES-256 encryption key, or undefined to skip decryption
 * @param global - The global object for custom type deserialization
 * @param extraRevivers - Additional revivers for custom types
 * @returns The hydrated value
 */
async function hydrateWorkflowArguments(value, _runId, _key, global = globalThis, extraRevivers = {}) {
    if (!(value instanceof Uint8Array)) {
        return unflatten(value, {
            ...getWorkflowRevivers(global),
            ...extraRevivers,
        });
    }
    const { format, payload } = decodeFormatPrefix(value);
    if (format === SerializationFormat.DEVALUE_V1) {
        const str = new TextDecoder().decode(payload);
        const obj = parse(str, {
            ...getWorkflowRevivers(global),
            ...extraRevivers,
        });
        return obj;
    }
    throw new Error(`Unsupported serialization format: ${format}`);
}
/**
 * Called at the end of a completed workflow execution to serialize the
 * return value into a format that can be saved to the database.
 *
 * @param value - The workflow return value to serialize
 * @param _runId - The workflow run ID (reserved for future encryption use)
 * @param _key - Per-run AES-256 encryption key, or undefined to skip encryption
 * @param global - The global object for custom type serialization
 * @param v1Compat - Whether to use legacy v1 serialization format
 * @returns The dehydrated value as binary data (Uint8Array) with format prefix
 */
async function dehydrateWorkflowReturnValue(value, _runId, _key, global = globalThis, v1Compat = false) {
    try {
        const str = stringify(value, getWorkflowReducers(global));
        if (v1Compat) {
            return revive(str);
        }
        const payload = new TextEncoder().encode(str);
        return encodeWithFormatPrefix(SerializationFormat.DEVALUE_V1, payload);
    }
    catch (error) {
        throw new WorkflowRuntimeError(formatSerializationError('workflow return value', error), { slug: 'serialization-failed', cause: error });
    }
}
/**
 * Called from the client side (i.e. the execution environment where
 * the workflow run was initiated from) to hydrate the workflow
 * return value of a completed workflow run.
 *
 * @param value - Binary serialized data (Uint8Array) with format prefix
 * @param runId - The workflow run ID (used for stream deserialization)
 * @param _key - Per-run AES-256 encryption key, or undefined to skip decryption
 * @param ops - Array to collect pending async operations (e.g., stream downloads)
 * @param global - The global object for custom type deserialization
 * @param extraRevivers - Additional revivers for custom types
 * @returns The hydrated return value, ready to be consumed by the client
 */
async function hydrateWorkflowReturnValue(value, runId, _key, ops = [], global = globalThis, extraRevivers = {}) {
    if (!(value instanceof Uint8Array)) {
        return unflatten(value, {
            ...getExternalRevivers(global, ops, runId),
            ...extraRevivers,
        });
    }
    const { format, payload } = decodeFormatPrefix(value);
    if (format === SerializationFormat.DEVALUE_V1) {
        const str = new TextDecoder().decode(payload);
        const obj = parse(str, {
            ...getExternalRevivers(global, ops, runId),
            ...extraRevivers,
        });
        return obj;
    }
    throw new Error(`Unsupported serialization format: ${format}`);
}
/**
 * Called from the workflow handler when a step is being created.
 * Dehydrates values from within the workflow execution environment
 * into a format that can be saved to the database.
 *
 * @param value - The step arguments to serialize
 * @param _runId - The workflow run ID (reserved for future encryption use)
 * @param _key - Per-run AES-256 encryption key, or undefined to skip encryption
 * @param global - The global object for custom type serialization
 * @param v1Compat - Whether to use legacy v1 serialization format
 * @returns The dehydrated value as binary data (Uint8Array) with format prefix
 */
async function dehydrateStepArguments(value, _runId, _key, global = globalThis, v1Compat = false) {
    try {
        const str = stringify(value, getWorkflowReducers(global));
        if (v1Compat) {
            return revive(str);
        }
        const payload = new TextEncoder().encode(str);
        return encodeWithFormatPrefix(SerializationFormat.DEVALUE_V1, payload);
    }
    catch (error) {
        throw new WorkflowRuntimeError(formatSerializationError('step arguments', error), { slug: 'serialization-failed', cause: error });
    }
}
/**
 * Called from the step handler to hydrate the arguments of a step
 * from the database at the start of the step execution.
 *
 * @param value - Binary serialized data (Uint8Array) with format prefix
 * @param runId - The workflow run ID (used for stream deserialization)
 * @param _key - Per-run AES-256 encryption key, or undefined to skip decryption
 * @param ops - Array to collect pending async operations (e.g., stream downloads)
 * @param global - The global object for custom type deserialization
 * @param extraRevivers - Additional revivers for custom types
 * @returns The hydrated value, ready to be consumed by the step user-code function
 */
async function hydrateStepArguments(value, runId, _key, ops = [], global = globalThis, extraRevivers = {}) {
    if (!(value instanceof Uint8Array)) {
        return unflatten(value, {
            ...getStepRevivers(global, ops, runId),
            ...extraRevivers,
        });
    }
    const { format, payload } = decodeFormatPrefix(value);
    if (format === SerializationFormat.DEVALUE_V1) {
        const str = new TextDecoder().decode(payload);
        const obj = parse(str, {
            ...getStepRevivers(global, ops, runId),
            ...extraRevivers,
        });
        return obj;
    }
    throw new Error(`Unsupported serialization format: ${format}`);
}
/**
 * Called from the step handler when a step has completed.
 * Dehydrates values from within the step execution environment
 * into a format that can be saved to the database.
 *
 * @param value - The step return value to serialize
 * @param runId - The workflow run ID (used for stream serialization)
 * @param _key - Per-run AES-256 encryption key, or undefined to skip encryption
 * @param ops - Array to collect pending async operations (e.g., stream uploads)
 * @param global - The global object for custom type serialization
 * @param v1Compat - Whether to use legacy v1 serialization format
 * @returns The dehydrated value as binary data (Uint8Array) with format prefix
 */
async function dehydrateStepReturnValue(value, runId, _key, ops = [], global = globalThis, v1Compat = false) {
    try {
        const str = stringify(value, getStepReducers(global, ops, runId));
        if (v1Compat) {
            return revive(str);
        }
        const payload = new TextEncoder().encode(str);
        return encodeWithFormatPrefix(SerializationFormat.DEVALUE_V1, payload);
    }
    catch (error) {
        throw new WorkflowRuntimeError(formatSerializationError('step return value', error), { slug: 'serialization-failed', cause: error });
    }
}
/**
 * Called from the workflow handler when replaying the event log of a `step_completed` event.
 * Hydrates the return value of a step from the database.
 *
 * @param value - Binary serialized data (Uint8Array) with format prefix
 * @param _runId - The workflow run ID (reserved for future encryption use)
 * @param _key - Per-run AES-256 encryption key, or undefined to skip decryption
 * @param global - The global object for custom type deserialization
 * @param extraRevivers - Additional revivers for custom types
 * @returns The hydrated return value of a step, ready to be consumed by the workflow handler
 */
async function hydrateStepReturnValue(value, _runId, _key, global = globalThis, extraRevivers = {}) {
    if (!(value instanceof Uint8Array)) {
        return unflatten(value, {
            ...getWorkflowRevivers(global),
            ...extraRevivers,
        });
    }
    const { format, payload } = decodeFormatPrefix(value);
    if (format === SerializationFormat.DEVALUE_V1) {
        const str = new TextDecoder().decode(payload);
        const obj = parse(str, {
            ...getWorkflowRevivers(global),
            ...extraRevivers,
        });
        return obj;
    }
    throw new Error(`Unsupported serialization format: ${format}`);
}

/**
 * Extracts W3C trace context headers from a trace carrier for HTTP propagation.
 * Returns an object with `traceparent` and optionally `tracestate` headers.
 */
function extractTraceHeaders(traceCarrier) {
    const headers = {};
    if (traceCarrier.traceparent) {
        headers.traceparent = traceCarrier.traceparent;
    }
    if (traceCarrier.tracestate) {
        headers.tracestate = traceCarrier.tracestate;
    }
    return headers;
}
/**
 * Handles a workflow suspension by processing all pending operations (hooks, steps, waits).
 * Uses an event-sourced architecture where entities (steps, hooks) are created atomically
 * with their corresponding events via events.create().
 *
 * Processing order:
 * 1. Hooks are processed first to prevent race conditions with webhook receivers
 * 2. Steps and waits are processed in parallel after hooks complete
 */
async function handleSuspension({ suspension, world, run, span, }) {
    const runId = run.runId;
    const workflowName = run.workflowName;
    const workflowStartedAt = run.startedAt ? +run.startedAt : Date.now();
    // Separate queue items by type
    const stepItems = suspension.steps.filter((item) => item.type === 'step');
    const hookItems = suspension.steps.filter((item) => item.type === 'hook');
    const waitItems = suspension.steps.filter((item) => item.type === 'wait');
    // Resolve encryption key for this run
    const rawKey = await world.getEncryptionKeyForRun?.(run);
    const encryptionKey = rawKey ? await importKey(rawKey) : undefined;
    // Build hook_created events (World will atomically create hook entities)
    const hookEvents = await Promise.all(hookItems.map(async (queueItem) => {
        const hookMetadata = typeof queueItem.metadata === 'undefined'
            ? undefined
            : (await dehydrateStepArguments(queueItem.metadata, runId, encryptionKey, suspension.globalThis));
        return {
            eventType: 'hook_created',
            specVersion: SPEC_VERSION_CURRENT,
            correlationId: queueItem.correlationId,
            eventData: {
                token: queueItem.token,
                metadata: hookMetadata,
            },
        };
    }));
    // Process hooks first to prevent race conditions with webhook receivers
    // All hook creations run in parallel
    // Track any hook conflicts that occur - these will be handled by re-enqueueing the workflow
    let hasHookConflict = false;
    if (hookEvents.length > 0) {
        await Promise.all(hookEvents.map(async (hookEvent) => {
            try {
                const result = await world.events.create(runId, hookEvent);
                // Check if the world returned a hook_conflict event instead of hook_created
                // The hook_conflict event is stored in the event log and will be replayed
                // on the next workflow invocation, causing the hook's promise to reject
                // Note: hook events always create an event (legacy runs throw, not return undefined)
                if (result.event.eventType === 'hook_conflict') {
                    hasHookConflict = true;
                }
            }
            catch (err) {
                if (WorkflowAPIError.is(err)) {
                    if (err.status === 410) {
                        runtimeLogger.info('Workflow run already completed, skipping hook', {
                            workflowRunId: runId,
                            message: err.message,
                        });
                    }
                    else {
                        throw err;
                    }
                }
                else {
                    throw err;
                }
            }
        }));
    }
    // Build a map of stepId -> step event for steps that need creation
    const stepsNeedingCreation = new Set(stepItems
        .filter((queueItem) => !queueItem.hasCreatedEvent)
        .map((queueItem) => queueItem.correlationId));
    // Process steps and waits in parallel
    // Each step: create event (if needed) -> queue message
    // Each wait: create event (if needed)
    const ops = [];
    // Steps: create event then queue message, all in parallel
    for (const queueItem of stepItems) {
        ops.push((async () => {
            // Create step event if not already created
            if (stepsNeedingCreation.has(queueItem.correlationId)) {
                const dehydratedInput = await dehydrateStepArguments({
                    args: queueItem.args,
                    closureVars: queueItem.closureVars,
                    thisVal: queueItem.thisVal,
                }, runId, encryptionKey, suspension.globalThis);
                const stepEvent = {
                    eventType: 'step_created',
                    specVersion: SPEC_VERSION_CURRENT,
                    correlationId: queueItem.correlationId,
                    eventData: {
                        stepName: queueItem.stepName,
                        input: dehydratedInput,
                    },
                };
                try {
                    await world.events.create(runId, stepEvent);
                }
                catch (err) {
                    if (WorkflowAPIError.is(err) && err.status === 409) {
                        runtimeLogger.info('Step already exists, continuing', {
                            workflowRunId: runId,
                            correlationId: queueItem.correlationId,
                            message: err.message,
                        });
                    }
                    else {
                        throw err;
                    }
                }
            }
            // Queue step execution message
            // Serialize trace context once and include in both payload and headers
            // Payload: for manual context restoration in step handler
            // Headers: for automatic trace propagation by Vercel's infrastructure
            const traceCarrier = await serializeTraceCarrier();
            await queueMessage(world, `__wkf_step_${queueItem.stepName}`, {
                workflowName,
                workflowRunId: runId,
                workflowStartedAt,
                stepId: queueItem.correlationId,
                traceCarrier,
                requestedAt: new Date(),
            }, {
                idempotencyKey: queueItem.correlationId,
                headers: {
                    ...extractTraceHeaders(traceCarrier),
                },
            });
        })());
    }
    // Waits: create events in parallel (no queueing needed for waits)
    for (const queueItem of waitItems) {
        if (!queueItem.hasCreatedEvent) {
            ops.push((async () => {
                const waitEvent = {
                    eventType: 'wait_created',
                    specVersion: SPEC_VERSION_CURRENT,
                    correlationId: queueItem.correlationId,
                    eventData: {
                        resumeAt: queueItem.resumeAt,
                    },
                };
                try {
                    await world.events.create(runId, waitEvent);
                }
                catch (err) {
                    if (WorkflowAPIError.is(err) && err.status === 409) {
                        runtimeLogger.info('Wait already exists, continuing', {
                            workflowRunId: runId,
                            correlationId: queueItem.correlationId,
                            message: err.message,
                        });
                    }
                    else {
                        throw err;
                    }
                }
            })());
        }
    }
    // Wait for all step and wait operations to complete
    functionsExports.waitUntil(Promise.all(ops).catch((opErr) => {
        const isAbortError = opErr?.name === 'AbortError' || opErr?.name === 'ResponseAborted';
        if (!isAbortError)
            throw opErr;
    }));
    await Promise.all(ops);
    // Calculate minimum timeout from waits
    const now = Date.now();
    const minTimeoutSeconds = waitItems.reduce((min, queueItem) => {
        const resumeAtMs = queueItem.resumeAt.getTime();
        const delayMs = Math.max(1000, resumeAtMs - now);
        const timeoutSeconds = Math.ceil(delayMs / 1000);
        if (min === null)
            return timeoutSeconds;
        return Math.min(min, timeoutSeconds);
    }, null);
    span?.setAttributes({
        ...WorkflowRunStatus('workflow_suspended'),
        ...WorkflowStepsCreated(stepItems.length),
        ...WorkflowHooksCreated(hookItems.length),
        ...WorkflowWaitsCreated(waitItems.length),
    });
    // If any hook conflicts occurred, re-enqueue the workflow immediately
    // On the next iteration, the hook consumer will see the hook_conflict event
    // and reject the promise with a WorkflowRuntimeError
    // We do this after processing all other operations (steps, waits) to ensure
    // they are recorded in the event log before the re-execution
    if (hasHookConflict) {
        return { timeoutSeconds: 1 };
    }
    if (minTimeoutSeconds !== null) {
        return { timeoutSeconds: minTimeoutSeconds };
    }
    return {};
}

/**
 * Remaps an error stack trace using inline source maps to show original source locations.
 *
 * @param stack - The error stack trace to remap
 * @param filename - The workflow filename to match in stack frames
 * @param workflowCode - The workflow bundle code containing inline source maps
 * @returns The remapped stack trace with original source locations
 */
function remapErrorStack(stack, filename, workflowCode) {
    // Extract inline source map from workflow code
    const sourceMapMatch = workflowCode.match(/\/\/# sourceMappingURL=data:application\/json;base64,(.+)/);
    if (!sourceMapMatch) {
        return stack; // No source map found
    }
    try {
        const base64 = sourceMapMatch[1];
        const sourceMapJson = Buffer.from(base64, 'base64').toString('utf-8');
        const sourceMapData = JSON.parse(sourceMapJson);
        // Use TraceMap (pure JS, no WASM required)
        const tracer = new TraceMap(sourceMapData);
        // Parse and remap each line in the stack trace
        const lines = stack.split('\n');
        const remappedLines = lines.map((line) => {
            // Match stack frames: "at functionName (filename:line:column)" or "at filename:line:column"
            const frameMatch = line.match(/^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/);
            if (!frameMatch) {
                return line; // Not a stack frame, return as-is
            }
            const [, functionName, file, lineStr, colStr] = frameMatch;
            // Only remap frames from our workflow file
            if (!file.includes(filename)) {
                return line;
            }
            const lineNumber = parseInt(lineStr, 10);
            const columnNumber = parseInt(colStr, 10);
            // Map to original source position
            const original = originalPositionFor(tracer, {
                line: lineNumber,
                column: columnNumber,
            });
            if (original.source && original.line !== null) {
                const func = functionName || original.name || 'anonymous';
                const col = original.column !== null ? original.column : columnNumber;
                return `    at ${func} (${original.source}:${original.line}:${col})`;
            }
            return line; // Couldn't map, return original
        });
        return remappedLines.join('\n');
    }
    catch (e) {
        // If source map processing fails, return original stack
        return stack;
    }
}

function getErrorName(v) {
    if (types.isNativeError(v)) {
        return v.name;
    }
    return 'Error';
}
function getErrorStack(v) {
    if (types.isNativeError(v)) {
        return v.stack ?? '';
    }
    return '';
}
function isThenable(value) {
    return (typeof value === 'object' &&
        value !== null &&
        'then' in value &&
        typeof value.then === 'function');
}
function normalizeSyncError(v) {
    if (types.isNativeError(v)) {
        return {
            name: v.name,
            message: v.message,
            stack: v.stack ?? '',
        };
    }
    if (typeof v === 'string') {
        return {
            name: 'Error',
            message: v,
            stack: '',
        };
    }
    try {
        return {
            name: 'Error',
            message: JSON.stringify(v),
            stack: '',
        };
    }
    catch {
        return {
            name: 'Error',
            message: String(v),
            stack: '',
        };
    }
}
/**
 * Normalizes unknown thrown values into a stable error shape.
 * This handles Promise/thenable throw values so logs/events never end up
 * with unhelpful "[object Promise]" messages.
 */
async function normalizeUnknownError(value) {
    if (isThenable(value)) {
        try {
            const resolved = await value;
            const normalized = await normalizeUnknownError(resolved);
            return {
                ...normalized,
                message: `Promise rejection: ${normalized.message}`,
            };
        }
        catch (rejection) {
            const normalized = await normalizeUnknownError(rejection);
            return {
                ...normalized,
                message: `Promise rejection: ${normalized.message}`,
            };
        }
    }
    return normalizeSyncError(value);
}

/**
 * Builds a workflow suspension log message based on the counts of steps, hooks, and waits.
 * @param runId - The workflow run ID
 * @param stepCount - Number of steps to be enqueued
 * @param hookCount - Number of hooks to be enqueued
 * @param waitCount - Number of waits to be enqueued
 * @returns The formatted log message or null if all counts are 0
 */
function buildWorkflowSuspensionMessage(runId, stepCount, hookCount, waitCount) {
    if (stepCount === 0 && hookCount === 0 && waitCount === 0) {
        return null;
    }
    const parts = [];
    if (stepCount > 0) {
        parts.push(`${stepCount} ${pluralize('step', 'steps', stepCount)}`);
    }
    if (hookCount > 0) {
        parts.push(`${hookCount} ${pluralize('hook', 'hooks', hookCount)}`);
    }
    if (waitCount > 0) {
        parts.push(`${waitCount} ${pluralize('timer', 'timers', waitCount)}`);
    }
    const resumeMsgParts = [];
    if (stepCount > 0) {
        resumeMsgParts.push('steps are completed');
    }
    if (hookCount > 0) {
        resumeMsgParts.push('hooks are received');
    }
    if (waitCount > 0) {
        resumeMsgParts.push('timers have elapsed');
    }
    const resumeMsg = resumeMsgParts.join(' and ');
    return `[Workflows] "${runId}" - ${parts.join(' and ')} to be enqueued\n  Workflow will suspend and resume when ${resumeMsg}`;
}
/**
 * Generates a stream ID for a workflow run.
 * User-defined streams include a "user" segment for isolation from future system-defined streams.
 * Namespaces are base64-encoded to handle characters not allowed in Redis key names.
 *
 * @param runId - The workflow run ID
 * @param namespace - Optional namespace for the stream
 * @returns The stream ID in format: `strm_{ULID}_user_{base64(namespace)?}`
 */
function getWorkflowRunStreamId(runId, namespace) {
    const streamId = `${runId.replace('wrun_', 'strm_')}_user`;
    if (!namespace) {
        return streamId;
    }
    // Base64 encode the namespace to handle special characters that may not be allowed in Redis keys
    const encodedNamespace = Buffer.from(namespace, 'utf-8').toString('base64url');
    return `${streamId}_${encodedNamespace}`;
}
/**
 * A small wrapper around `waitUntil` that also returns
 * the result of the awaited promise.
 */
async function waitedUntil(fn) {
    const result = fn();
    functionsExports.waitUntil(result.catch(() => {
        // Ignore error from the promise being rejected.
        // It's expected that the invoker of `waitedUntil`
        // will handle the error.
    }));
    return result;
}

var EventConsumerResult;
(function (EventConsumerResult) {
    /**
     * Callback consumed the event, but should not be removed from the callbacks list
     */
    EventConsumerResult[EventConsumerResult["Consumed"] = 0] = "Consumed";
    /**
     * Callback did not consume the event, so it should be passed to the next callback
     */
    EventConsumerResult[EventConsumerResult["NotConsumed"] = 1] = "NotConsumed";
    /**
     * Callback consumed the event, and should be removed from the callbacks list
     */
    EventConsumerResult[EventConsumerResult["Finished"] = 2] = "Finished";
})(EventConsumerResult || (EventConsumerResult = {}));
class EventsConsumer {
    eventIndex;
    events = [];
    callbacks = [];
    onUnconsumedEvent;
    pendingUnconsumedCheck = null;
    constructor(events, options) {
        this.events = events;
        this.eventIndex = 0;
        this.onUnconsumedEvent = options.onUnconsumedEvent;
    }
    /**
     * Registers a callback function to be called after an event has been consumed
     * by a different callback. The callback can return:
     *  - `EventConsumerResult.Consumed` the event is considered consumed and will not be passed to any other callback, but the callback will remain in the callbacks list
     *  - `EventConsumerResult.NotConsumed` the event is passed to the next callback
     *  - `EventConsumerResult.Finished` the event is considered consumed and the callback is removed from the callbacks list
     *
     * @param fn - The callback function to register.
     */
    subscribe(fn) {
        this.callbacks.push(fn);
        // Cancel any pending unconsumed check since a new callback may consume the event
        if (this.pendingUnconsumedCheck !== null) {
            clearTimeout(this.pendingUnconsumedCheck);
            this.pendingUnconsumedCheck = null;
        }
        process.nextTick(this.consume);
    }
    consume = () => {
        const currentEvent = this.events[this.eventIndex] ?? null;
        for (let i = 0; i < this.callbacks.length; i++) {
            const callback = this.callbacks[i];
            let handled = EventConsumerResult.NotConsumed;
            try {
                handled = callback(currentEvent);
            }
            catch (error) {
                eventsLogger.error('EventConsumer callback threw an error', { error });
            }
            if (handled === EventConsumerResult.Consumed ||
                handled === EventConsumerResult.Finished) {
                // consumer handled this event, so increase the event index
                this.eventIndex++;
                // remove the callback if it has finished
                if (handled === EventConsumerResult.Finished) {
                    this.callbacks.splice(i, 1);
                }
                // continue to the next event
                process.nextTick(this.consume);
                return;
            }
        }
        // If we reach here, all callbacks returned NotConsumed.
        // If the current event is non-null (a real event, not end-of-events),
        // schedule a deferred check. We use setTimeout (macrotask) so that any
        // pending process.nextTick microtasks (e.g., new subscribes from the
        // workflow code) can complete first. If the event is still unconsumed
        // when the timeout fires, it's truly orphaned.
        if (currentEvent !== null) {
            const unconsumedIndex = this.eventIndex;
            this.pendingUnconsumedCheck = setTimeout(() => {
                this.pendingUnconsumedCheck = null;
                if (this.eventIndex === unconsumedIndex) {
                    this.onUnconsumedEvent(currentEvent);
                }
            }, 0);
        }
    };
}

function createUseStep(ctx) {
    return function useStep(stepName, closureVarsFn) {
        // Use a regular function (not arrow) so we can capture `this` when invoked as a method
        const stepFunction = function (...args) {
            const { promise, resolve, reject } = withResolvers();
            const correlationId = `step_${ctx.generateUlid()}`;
            const queueItem = {
                type: 'step',
                correlationId,
                stepName,
                args,
            };
            // Capture `this` value for method invocations (e.g., MyClass.method())
            // Only include if `this` is defined and not the global object
            if (this !== undefined && this !== null && this !== globalThis) {
                queueItem.thisVal = this;
            }
            // Invoke the closure variables function to get the closure scope
            const closureVars = closureVarsFn?.();
            if (closureVars) {
                queueItem.closureVars = closureVars;
            }
            ctx.invocationsQueue.set(correlationId, queueItem);
            stepLogger.debug('Step consumer setup', {
                correlationId,
                stepName,
                args,
            });
            ctx.eventsConsumer.subscribe((event) => {
                if (!event) {
                    // We've reached the end of the events, so this step has either not been run or is currently running.
                    // Crucially, if we got here, then this step Promise does
                    // not resolve so that the user workflow code does not proceed any further.
                    // Notify the workflow handler that this step has not been run / has not completed yet.
                    setTimeout(() => {
                        ctx.onWorkflowError(new WorkflowSuspension(ctx.invocationsQueue, ctx.globalThis));
                    }, 0);
                    return EventConsumerResult.NotConsumed;
                }
                stepLogger.debug('Step consumer event processing', {
                    correlationId,
                    stepName,
                    args: args.join(', '),
                    incomingCorrelationId: event.correlationId,
                    isMatch: correlationId === event.correlationId,
                    eventType: event.eventType,
                });
                if (event.correlationId !== correlationId) {
                    // We're not interested in this event - the correlationId belongs to a different entity
                    return EventConsumerResult.NotConsumed;
                }
                if (event.eventType === 'step_created') {
                    // Step has been created (registered for execution) - mark as having event
                    // but keep in queue so suspension handler knows to queue execution without
                    // creating a duplicate step_created event
                    const queueItem = ctx.invocationsQueue.get(correlationId);
                    if (!queueItem || queueItem.type !== 'step') {
                        // This indicates event log corruption - step_created received
                        // but the step was never invoked in the workflow during replay.
                        setTimeout(() => {
                            reject(new WorkflowRuntimeError(`Corrupted event log: step ${correlationId} (${stepName}) created but not found in invocation queue`));
                        }, 0);
                        return EventConsumerResult.Finished;
                    }
                    queueItem.hasCreatedEvent = true;
                    // Continue waiting for step_started/step_completed/step_failed events
                    return EventConsumerResult.Consumed;
                }
                if (event.eventType === 'step_started') {
                    // Step was started - don't do anything. The step is left in the invocationQueue which
                    // will allow it to be re-enqueued. We rely on the queue's idempotency to prevent it from
                    // actually being over enqueued.
                    return EventConsumerResult.Consumed;
                }
                if (event.eventType === 'step_retrying') {
                    // Step is being retried - just consume the event and wait for next step_started
                    return EventConsumerResult.Consumed;
                }
                if (event.eventType === 'step_failed') {
                    // Terminal state - we can remove the invocationQueue item
                    ctx.invocationsQueue.delete(event.correlationId);
                    // Step failed - bubble up to workflow
                    setTimeout(() => {
                        const errorData = event.eventData.error;
                        const isErrorObject = typeof errorData === 'object' && errorData !== null;
                        const errorMessage = isErrorObject
                            ? (errorData.message ?? 'Unknown error')
                            : typeof errorData === 'string'
                                ? errorData
                                : 'Unknown error';
                        const errorStack = (isErrorObject ? errorData.stack : undefined) ??
                            event.eventData.stack;
                        const error = new FatalError(errorMessage);
                        if (errorStack) {
                            error.stack = errorStack;
                        }
                        reject(error);
                    }, 0);
                    return EventConsumerResult.Finished;
                }
                if (event.eventType === 'step_completed') {
                    // Terminal state - we can remove the invocationQueue item
                    ctx.invocationsQueue.delete(event.correlationId);
                    // Step has completed, so resolve the Promise with the cached result.
                    // The hydration is async, so we schedule the resolve via setTimeout
                    // after hydration completes to preserve macrotask timing semantics.
                    // We use a single setTimeout that awaits hydration inside it, keeping
                    // the same scheduling order as the original synchronous code path
                    // (where setTimeout was called synchronously from this callback).
                    setTimeout(async () => {
                        try {
                            const hydratedResult = await hydrateStepReturnValue(event.eventData.result, ctx.runId, ctx.encryptionKey, ctx.globalThis);
                            resolve(hydratedResult);
                        }
                        catch (error) {
                            reject(error);
                        }
                    }, 0);
                    return EventConsumerResult.Finished;
                }
                // An unexpected event type has been received, this event log looks corrupted. Let's fail immediately.
                setTimeout(() => {
                    ctx.onWorkflowError(new WorkflowRuntimeError(`Unexpected event type for step ${correlationId} (name: ${stepName}) "${event.eventType}"`));
                }, 0);
                return EventConsumerResult.Finished;
            });
            return promise;
        };
        // Ensure the "name" property matches the original step function name
        // Extract function name from stepName (format: "step//filepath//functionName")
        const functionName = stepName.split('//').pop();
        Object.defineProperty(stepFunction, 'name', {
            value: functionName,
        });
        // Add the step function identifier to the step function for serialization
        Object.defineProperty(stepFunction, 'stepId', {
            value: stepName,
            writable: false,
            enumerable: false,
            configurable: false,
        });
        // Store the closure variables function for serialization
        if (closureVarsFn) {
            Object.defineProperty(stepFunction, '__closureVarsFn', {
                value: closureVarsFn,
                writable: false,
                enumerable: false,
                configurable: false,
            });
        }
        return stepFunction;
    };
}

/**
 * Returns a function that generates a random UUID, based on the given RNG.
 *
 * `rng` is expected to be a seeded random number generator (i.e. `seedrandom.PRNG` instance).
 *
 * @param rng - A function that returns a random number between 0 and 1.
 * @returns A `crypto.randomUUID`-like function.
 */
function createRandomUUID(rng) {
    return function randomUUID() {
        const chars = '0123456789abcdef';
        let uuid = '';
        for (let i = 0; i < 36; i++) {
            if (i === 8 || i === 13 || i === 18 || i === 23) {
                uuid += '-';
            }
            else if (i === 14) {
                uuid += '4'; // Version 4 UUID
            }
            else if (i === 19) {
                uuid += chars[Math.floor(rng() * 4) + 8]; // 8, 9, a, or b
            }
            else {
                uuid += chars[Math.floor(rng() * 16)];
            }
        }
        return uuid;
    };
}

/**
 * Creates a Node.js `vm.Context` configured to be usable for
 * executing workflow logic in a deterministic environment.
 *
 * @param options - The options for the context.
 * @returns The context.
 */
function createContext(options) {
    let { fixedTimestamp } = options;
    const { seed } = options;
    const rng = seedrandom(seed);
    const context = createContext$1();
    const g = runInContext('globalThis', context);
    // Deterministic `Math.random()`
    g.Math.random = rng;
    // Override `Date` constructor to return fixed time when called without arguments
    const Date_ = g.Date;
    // biome-ignore lint/suspicious/noShadowRestrictedNames: We're shadowing the global `Date` property to make it deterministic.
    g.Date = function Date(...args) {
        if (args.length === 0) {
            return new Date_(fixedTimestamp);
        }
        // @ts-expect-error - Args is `Date` constructor arguments
        return new Date_(...args);
    };
    g.Date.prototype = Date_.prototype;
    // Preserve static methods
    Object.setPrototypeOf(g.Date, Date_);
    g.Date.now = () => fixedTimestamp;
    // Deterministic `crypto` using Proxy to avoid mutating global objects
    const originalCrypto = globalThis.crypto;
    const originalSubtle = originalCrypto.subtle;
    function getRandomValues(array) {
        for (let i = 0; i < array.length; i++) {
            array[i] = Math.floor(rng() * 256);
        }
        return array;
    }
    const randomUUID = createRandomUUID(rng);
    const boundDigest = originalSubtle.digest.bind(originalSubtle);
    g.crypto = new Proxy(originalCrypto, {
        get(target, prop) {
            if (prop === 'getRandomValues') {
                return getRandomValues;
            }
            if (prop === 'randomUUID') {
                return randomUUID;
            }
            if (prop === 'subtle') {
                return new Proxy(originalSubtle, {
                    get(target, prop) {
                        if (prop === 'generateKey') {
                            return () => {
                                throw new Error('Not implemented');
                            };
                        }
                        else if (prop === 'digest') {
                            return boundDigest;
                        }
                        return target[prop];
                    },
                });
            }
            return target[prop];
        },
    });
    // Propagate environment variables
    g.process = {
        env: Object.freeze({ ...process.env }),
    };
    // Stateless + synchronous Web APIs that are made available inside the sandbox
    g.Headers = globalThis.Headers;
    g.TextEncoder = globalThis.TextEncoder;
    g.TextDecoder = globalThis.TextDecoder;
    g.console = globalThis.console;
    g.URL = globalThis.URL;
    g.URLSearchParams = globalThis.URLSearchParams;
    g.structuredClone = globalThis.structuredClone;
    // HACK: Shim `exports` for the bundle
    g.exports = {};
    g.module = { exports: g.exports };
    return {
        context,
        globalThis: g,
        updateTimestamp: (timestamp) => {
            fixedTimestamp = timestamp;
        },
    };
}

const WORKFLOW_CONTEXT_SYMBOL = 
/* @__PURE__ */ Symbol.for('WORKFLOW_CONTEXT');

function createCreateHook(ctx) {
    return function createHookImpl(options = {}) {
        // Generate hook ID and token
        const correlationId = `hook_${ctx.generateUlid()}`;
        const token = options.token ?? ctx.generateNanoid();
        // Add hook creation to invocations queue (using Map for O(1) operations)
        ctx.invocationsQueue.set(correlationId, {
            type: 'hook',
            correlationId,
            token,
            metadata: options.metadata,
        });
        // Queue of hook events that have been received but not yet processed
        const payloadsQueue = [];
        // Queue of promises that resolve to the next hook payload
        const promises = [];
        let eventLogEmpty = false;
        // Track if we have a conflict so we can reject future awaits
        let hasConflict = false;
        let conflictErrorRef = null;
        webhookLogger.debug('Hook consumer setup', { correlationId, token });
        ctx.eventsConsumer.subscribe((event) => {
            // If there are no events and there are promises waiting,
            // it means the hook has been awaited, but an incoming payload has not yet been received.
            // In this case, the workflow should be suspended until the hook is resumed.
            if (!event) {
                eventLogEmpty = true;
                if (promises.length > 0) {
                    setTimeout(() => {
                        ctx.onWorkflowError(new WorkflowSuspension(ctx.invocationsQueue, ctx.globalThis));
                    }, 0);
                }
                return EventConsumerResult.NotConsumed;
            }
            if (event.correlationId !== correlationId) {
                // We're not interested in this event - the correlationId belongs to a different entity
                return EventConsumerResult.NotConsumed;
            }
            // Check for hook_created event to remove this hook from the queue if it was already created
            if (event.eventType === 'hook_created') {
                // Remove this hook from the invocations queue (O(1) delete using Map)
                ctx.invocationsQueue.delete(correlationId);
                return EventConsumerResult.Consumed;
            }
            // Handle hook_conflict event - another workflow is using this token
            if (event.eventType === 'hook_conflict') {
                // Remove this hook from the invocations queue
                ctx.invocationsQueue.delete(correlationId);
                // Store the conflict event so we can reject any awaited promises
                const conflictEvent = event;
                const conflictError = new WorkflowRuntimeError(`Hook token "${conflictEvent.eventData.token}" is already in use by another workflow`, { slug: ERROR_SLUGS.HOOK_CONFLICT });
                // Reject any pending promises
                for (const resolver of promises) {
                    resolver.reject(conflictError);
                }
                promises.length = 0;
                // Mark that we have a conflict so future awaits also reject
                hasConflict = true;
                conflictErrorRef = conflictError;
                return EventConsumerResult.Consumed;
            }
            if (event.eventType === 'hook_received') {
                if (promises.length > 0) {
                    const next = promises.shift();
                    if (next) {
                        // Reconstruct the payload from the event data
                        hydrateStepReturnValue(event.eventData.payload, ctx.runId, ctx.encryptionKey, ctx.globalThis)
                            .then((payload) => {
                            next.resolve(payload);
                        })
                            .catch((error) => {
                            next.reject(error);
                        });
                    }
                }
                else {
                    payloadsQueue.push(event);
                }
                return EventConsumerResult.Consumed;
            }
            if (event.eventType === 'hook_disposed') {
                // If a hook is explicitly disposed, we're done processing any more
                // events for it
                return EventConsumerResult.Finished;
            }
            // An unexpected event type has been received, this event log looks corrupted. Let's fail immediately.
            setTimeout(() => {
                ctx.onWorkflowError(new WorkflowRuntimeError(`Unexpected event type for hook ${correlationId} (token: ${token}) "${event.eventType}"`));
            }, 0);
            return EventConsumerResult.Finished;
        });
        // Helper function to create a new promise that waits for the next hook payload
        function createHookPromise() {
            const resolvers = withResolvers();
            // If we have a conflict, reject immediately
            // This handles the iterator case where each await should reject
            if (hasConflict && conflictErrorRef) {
                resolvers.reject(conflictErrorRef);
                return resolvers.promise;
            }
            if (payloadsQueue.length > 0) {
                const nextPayload = payloadsQueue.shift();
                if (nextPayload) {
                    hydrateStepReturnValue(nextPayload.eventData.payload, ctx.runId, ctx.encryptionKey, ctx.globalThis)
                        .then((payload) => {
                        resolvers.resolve(payload);
                    })
                        .catch((error) => {
                        resolvers.reject(error);
                    });
                    return resolvers.promise;
                }
            }
            if (eventLogEmpty) {
                // If the event log is already empty then we know the hook will not be resolved.
                // Treat this case as a "step not run" scenario and suspend the workflow.
                setTimeout(() => {
                    ctx.onWorkflowError(new WorkflowSuspension(ctx.invocationsQueue, ctx.globalThis));
                }, 0);
            }
            promises.push(resolvers);
            return resolvers.promise;
        }
        const hook = {
            token,
            // biome-ignore lint/suspicious/noThenProperty: Intentionally thenable
            then(onfulfilled, onrejected) {
                return createHookPromise().then(onfulfilled, onrejected);
            },
            // Support `for await (const payload of hook) { … }` syntax
            async *[Symbol.asyncIterator]() {
                while (true) {
                    yield await this;
                }
            },
        };
        return hook;
    };
}

function createSleep(ctx) {
    return async function sleepImpl(param) {
        const { promise, resolve } = withResolvers();
        const correlationId = `wait_${ctx.generateUlid()}`;
        // Calculate the resume time
        const resumeAt = parseDurationToDate(param);
        // Add wait to invocations queue (using Map for O(1) operations)
        const waitItem = {
            type: 'wait',
            correlationId,
            resumeAt,
        };
        ctx.invocationsQueue.set(correlationId, waitItem);
        ctx.eventsConsumer.subscribe((event) => {
            // If there are no events and we're waiting for wait_completed,
            // suspend the workflow until the wait fires
            if (!event) {
                setTimeout(() => {
                    ctx.onWorkflowError(new WorkflowSuspension(ctx.invocationsQueue, ctx.globalThis));
                }, 0);
                return EventConsumerResult.NotConsumed;
            }
            if (event.correlationId !== correlationId) {
                // We're not interested in this event - the correlationId belongs to a different entity
                return EventConsumerResult.NotConsumed;
            }
            // Check for wait_created event to mark this wait as having the event created
            if (event.eventType === 'wait_created') {
                // Mark this wait as having the created event, but keep it in the queue
                // O(1) lookup using Map
                const queueItem = ctx.invocationsQueue.get(correlationId);
                if (queueItem && queueItem.type === 'wait') {
                    queueItem.hasCreatedEvent = true;
                    queueItem.resumeAt = event.eventData.resumeAt;
                }
                return EventConsumerResult.Consumed;
            }
            // Check for wait_completed event
            if (event.eventType === 'wait_completed') {
                // Remove this wait from the invocations queue (O(1) delete using Map)
                ctx.invocationsQueue.delete(correlationId);
                // Wait has elapsed, resolve the sleep
                setTimeout(() => {
                    resolve();
                }, 0);
                return EventConsumerResult.Finished;
            }
            // An unexpected event type has been received, this event log looks corrupted. Let's fail immediately.
            setTimeout(() => {
                ctx.onWorkflowError(new WorkflowRuntimeError(`Unexpected event type for wait ${correlationId} "${event.eventType}"`));
            }, 0);
            return EventConsumerResult.Finished;
        });
        return promise;
    };
}

async function runWorkflow(workflowCode, workflowRun, events, encryptionKey) {
    return trace(`workflow.run ${workflowRun.workflowName}`, async (span) => {
        span?.setAttributes({
            ...WorkflowName(workflowRun.workflowName),
            ...WorkflowRunId(workflowRun.runId),
            ...WorkflowRunStatus(workflowRun.status),
            ...WorkflowEventsCount(events.length),
        });
        const startedAt = workflowRun.startedAt;
        if (!startedAt) {
            throw new Error(`Workflow run "${workflowRun.runId}" has no "startedAt" timestamp (should not happen)`);
        }
        // Get the port before creating VM context to avoid async operations
        // affecting the deterministic timestamp
        const port = await getPort();
        const { context, globalThis: vmGlobalThis, updateTimestamp, } = createContext({
            seed: workflowRun.runId,
            fixedTimestamp: +startedAt,
        });
        const workflowDiscontinuation = withResolvers();
        const ulid = monotonicFactory(() => vmGlobalThis.Math.random());
        const generateNanoid = customRandom(urlAlphabet, 21, (size) => new Uint8Array(size).map(() => 256 * vmGlobalThis.Math.random()));
        const eventsConsumer = new EventsConsumer(events, {
            onUnconsumedEvent: (event) => {
                workflowDiscontinuation.reject(new WorkflowRuntimeError(`Unconsumed event in event log: eventType=${event.eventType}, correlationId=${event.correlationId}, eventId=${event.eventId}. This indicates a corrupted or invalid event log.`, { slug: ERROR_SLUGS.CORRUPTED_EVENT_LOG }));
            },
        });
        const workflowContext = {
            runId: workflowRun.runId,
            encryptionKey,
            globalThis: vmGlobalThis,
            onWorkflowError: workflowDiscontinuation.reject,
            eventsConsumer,
            generateUlid: () => ulid(+startedAt),
            generateNanoid,
            invocationsQueue: new Map(),
        };
        // Subscribe to the events log to update the timestamp in the vm context
        workflowContext.eventsConsumer.subscribe((event) => {
            const createdAt = event?.createdAt;
            if (createdAt) {
                updateTimestamp(+createdAt);
            }
            // Never consume events - this is only a passive subscriber
            return EventConsumerResult.NotConsumed;
        });
        // Consume run lifecycle events - these are structural events that don't
        // need special handling in the workflow, but must be consumed to advance
        // past them in the event log
        workflowContext.eventsConsumer.subscribe((event) => {
            if (!event) {
                return EventConsumerResult.NotConsumed;
            }
            // Consume run_created - every run has exactly one
            if (event.eventType === 'run_created') {
                return EventConsumerResult.Consumed;
            }
            // Consume run_started - every run has exactly one
            if (event.eventType === 'run_started') {
                return EventConsumerResult.Consumed;
            }
            return EventConsumerResult.NotConsumed;
        });
        const useStep = createUseStep(workflowContext);
        const createHook = createCreateHook(workflowContext);
        const sleep = createSleep(workflowContext);
        // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
        vmGlobalThis[WORKFLOW_USE_STEP] = useStep;
        // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
        vmGlobalThis[WORKFLOW_CREATE_HOOK] = createHook;
        // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
        vmGlobalThis[WORKFLOW_SLEEP] = sleep;
        // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
        vmGlobalThis[WORKFLOW_GET_STREAM_ID] = (namespace) => getWorkflowRunStreamId(workflowRun.runId, namespace);
        // TODO: there should be a getUrl method on the world interface itself. This
        // solution only works for vercel + local worlds.
        const url = process.env.VERCEL_URL
            ? `https://${process.env.VERCEL_URL}`
            : `http://localhost:${port ?? 3000}`;
        // For the workflow VM, we store the context in a symbol on the `globalThis` object
        const ctx = {
            workflowRunId: workflowRun.runId,
            workflowStartedAt: new vmGlobalThis.Date(+startedAt),
            url,
        };
        // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
        vmGlobalThis[WORKFLOW_CONTEXT_SYMBOL] = ctx;
        // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
        vmGlobalThis[STABLE_ULID] = ulid;
        // NOTE: Will have a config override to use the custom fetch step.
        //       For now `fetch` must be explicitly imported from `workflow`.
        vmGlobalThis.fetch = () => {
            throw new vmGlobalThis.Error(`Global "fetch" is unavailable in workflow functions. Use the "fetch" step function from "workflow" to make HTTP requests.\n\nLearn more: https://useworkflow.dev/err/${ERROR_SLUGS.FETCH_IN_WORKFLOW_FUNCTION}`);
        };
        // Override timeout/interval functions to throw helpful errors
        // These are not supported in workflow functions because they rely on
        // asynchronous scheduling which breaks deterministic replay
        const timeoutErrorMessage = 'Timeout functions like "setTimeout" and "setInterval" are not supported in workflow functions. Use the "sleep" function from "workflow" for time-based delays.';
        vmGlobalThis.setTimeout = () => {
            throw new WorkflowRuntimeError(timeoutErrorMessage, {
                slug: ERROR_SLUGS.TIMEOUT_FUNCTIONS_IN_WORKFLOW,
            });
        };
        vmGlobalThis.setInterval = () => {
            throw new WorkflowRuntimeError(timeoutErrorMessage, {
                slug: ERROR_SLUGS.TIMEOUT_FUNCTIONS_IN_WORKFLOW,
            });
        };
        vmGlobalThis.clearTimeout = () => {
            throw new WorkflowRuntimeError(timeoutErrorMessage, {
                slug: ERROR_SLUGS.TIMEOUT_FUNCTIONS_IN_WORKFLOW,
            });
        };
        vmGlobalThis.clearInterval = () => {
            throw new WorkflowRuntimeError(timeoutErrorMessage, {
                slug: ERROR_SLUGS.TIMEOUT_FUNCTIONS_IN_WORKFLOW,
            });
        };
        vmGlobalThis.setImmediate = () => {
            throw new WorkflowRuntimeError(timeoutErrorMessage, {
                slug: ERROR_SLUGS.TIMEOUT_FUNCTIONS_IN_WORKFLOW,
            });
        };
        vmGlobalThis.clearImmediate = () => {
            throw new WorkflowRuntimeError(timeoutErrorMessage, {
                slug: ERROR_SLUGS.TIMEOUT_FUNCTIONS_IN_WORKFLOW,
            });
        };
        // `Request` and `Response` are special built-in classes that invoke steps
        // for the `json()`, `text()` and `arrayBuffer()` instance methods
        class Request {
            cache;
            credentials;
            destination;
            headers;
            integrity;
            method;
            mode;
            redirect;
            referrer;
            referrerPolicy;
            url;
            keepalive;
            signal;
            duplex;
            body;
            constructor(input, init) {
                // Handle URL input
                if (typeof input === 'string' || input instanceof vmGlobalThis.URL) {
                    const urlString = String(input);
                    // Validate URL format
                    try {
                        new vmGlobalThis.URL(urlString);
                        this.url = urlString;
                    }
                    catch (cause) {
                        throw new TypeError(`Failed to parse URL from ${urlString}`, {
                            cause,
                        });
                    }
                }
                else {
                    // Input is a Request object - clone its properties
                    this.url = input.url;
                    if (!init) {
                        this.method = input.method;
                        this.headers = new vmGlobalThis.Headers(input.headers);
                        this.body = input.body;
                        this.mode = input.mode;
                        this.credentials = input.credentials;
                        this.cache = input.cache;
                        this.redirect = input.redirect;
                        this.referrer = input.referrer;
                        this.referrerPolicy = input.referrerPolicy;
                        this.integrity = input.integrity;
                        this.keepalive = input.keepalive;
                        this.signal = input.signal;
                        this.duplex = input.duplex;
                        this.destination = input.destination;
                        return;
                    }
                    // If init is provided, merge: use source properties, then override with init
                    // Copy all properties from the source Request first
                    this.method = input.method;
                    this.headers = new vmGlobalThis.Headers(input.headers);
                    this.body = input.body;
                    this.mode = input.mode;
                    this.credentials = input.credentials;
                    this.cache = input.cache;
                    this.redirect = input.redirect;
                    this.referrer = input.referrer;
                    this.referrerPolicy = input.referrerPolicy;
                    this.integrity = input.integrity;
                    this.keepalive = input.keepalive;
                    this.signal = input.signal;
                    this.duplex = input.duplex;
                    this.destination = input.destination;
                }
                // Override with init options if provided
                // Set method
                if (init?.method) {
                    this.method = init.method.toUpperCase();
                }
                else if (typeof this.method !== 'string') {
                    // Fallback to default for string input case
                    this.method = 'GET';
                }
                // Set headers
                if (init?.headers) {
                    this.headers = new vmGlobalThis.Headers(init.headers);
                }
                else if (typeof input === 'string' ||
                    input instanceof vmGlobalThis.URL) {
                    // For string/URL input, create empty headers
                    this.headers = new vmGlobalThis.Headers();
                }
                // Set other properties with init values or defaults
                if (init?.mode !== undefined) {
                    this.mode = init.mode;
                }
                else if (typeof this.mode !== 'string') {
                    this.mode = 'cors';
                }
                if (init?.credentials !== undefined) {
                    this.credentials = init.credentials;
                }
                else if (typeof this.credentials !== 'string') {
                    this.credentials = 'same-origin';
                }
                // `any` cast here because @types/node v22 does not yet have `cache`
                if (init?.cache !== undefined) {
                    this.cache = init.cache;
                }
                else if (typeof this.cache !== 'string') {
                    this.cache = 'default';
                }
                if (init?.redirect !== undefined) {
                    this.redirect = init.redirect;
                }
                else if (typeof this.redirect !== 'string') {
                    this.redirect = 'follow';
                }
                if (init?.referrer !== undefined) {
                    this.referrer = init.referrer;
                }
                else if (typeof this.referrer !== 'string') {
                    this.referrer = 'about:client';
                }
                if (init?.referrerPolicy !== undefined) {
                    this.referrerPolicy = init.referrerPolicy;
                }
                else if (typeof this.referrerPolicy !== 'string') {
                    this.referrerPolicy = '';
                }
                if (init?.integrity !== undefined) {
                    this.integrity = init.integrity;
                }
                else if (typeof this.integrity !== 'string') {
                    this.integrity = '';
                }
                if (init?.keepalive !== undefined) {
                    this.keepalive = init.keepalive;
                }
                else if (typeof this.keepalive !== 'boolean') {
                    this.keepalive = false;
                }
                if (init?.signal !== undefined) {
                    // @ts-expect-error - AbortSignal stub
                    this.signal = init.signal;
                }
                else if (!this.signal) {
                    // @ts-expect-error - AbortSignal stub
                    this.signal = { aborted: false };
                }
                if (!this.duplex) {
                    this.duplex = 'half';
                }
                if (!this.destination) {
                    this.destination = 'document';
                }
                const body = init?.body;
                // Validate that GET/HEAD methods don't have a body
                if (body !== null &&
                    body !== undefined &&
                    (this.method === 'GET' || this.method === 'HEAD')) {
                    throw new TypeError(`Request with GET/HEAD method cannot have body.`);
                }
                // Store the original BodyInit for serialization
                if (body !== null && body !== undefined) {
                    // Create a "fake" ReadableStream that stores the original body
                    // This avoids doing async work during workflow replay
                    this.body = Object.create(vmGlobalThis.ReadableStream.prototype, {
                        [BODY_INIT_SYMBOL]: {
                            value: body,
                            writable: false,
                        },
                    });
                }
                else {
                    this.body = null;
                }
            }
            clone() {
                ENOTSUP();
            }
            get bodyUsed() {
                return false;
            }
            // TODO: implement these
            blob;
            formData;
            async arrayBuffer() {
                return resArrayBuffer(this);
            }
            async bytes() {
                return new Uint8Array(await resArrayBuffer(this));
            }
            async json() {
                return resJson(this);
            }
            async text() {
                return resText(this);
            }
        }
        vmGlobalThis.Request = Request;
        const resJson = useStep('__builtin_response_json');
        const resText = useStep('__builtin_response_text');
        const resArrayBuffer = useStep('__builtin_response_array_buffer');
        class Response {
            type;
            url;
            status;
            statusText;
            body;
            headers;
            redirected;
            constructor(body, init) {
                this.status = init?.status ?? 200;
                this.statusText = init?.statusText ?? '';
                this.headers = new vmGlobalThis.Headers(init?.headers);
                this.type = 'default';
                this.url = '';
                this.redirected = false;
                // Validate that null-body status codes don't have a body
                // Per HTTP spec: 204 (No Content), 205 (Reset Content), and 304 (Not Modified)
                if (body !== null &&
                    body !== undefined &&
                    (this.status === 204 || this.status === 205 || this.status === 304)) {
                    throw new TypeError(`Response constructor: Invalid response status code ${this.status}`);
                }
                // Store the original BodyInit for serialization
                if (body !== null && body !== undefined) {
                    // Create a "fake" ReadableStream that stores the original body
                    // This avoids doing async work during workflow replay
                    this.body = Object.create(vmGlobalThis.ReadableStream.prototype, {
                        [BODY_INIT_SYMBOL]: {
                            value: body,
                            writable: false,
                        },
                    });
                }
                else {
                    this.body = null;
                }
            }
            // TODO: implement these
            clone;
            blob;
            formData;
            get ok() {
                return this.status >= 200 && this.status < 300;
            }
            get bodyUsed() {
                return false;
            }
            async arrayBuffer() {
                return resArrayBuffer(this);
            }
            async bytes() {
                return new Uint8Array(await resArrayBuffer(this));
            }
            async json() {
                return resJson(this);
            }
            static json(data, init) {
                const body = JSON.stringify(data);
                const headers = new vmGlobalThis.Headers(init?.headers);
                if (!headers.has('content-type')) {
                    headers.set('content-type', 'application/json');
                }
                return new Response(body, { ...init, headers });
            }
            async text() {
                return resText(this);
            }
            static error() {
                ENOTSUP();
            }
            static redirect(url, status = 302) {
                // Validate status code - only specific redirect codes are allowed
                if (![301, 302, 303, 307, 308].includes(status)) {
                    throw new RangeError(`Invalid redirect status code: ${status}. Must be one of: 301, 302, 303, 307, 308`);
                }
                // Create response with Location header
                const headers = new vmGlobalThis.Headers();
                headers.set('Location', String(url));
                const response = Object.create(Response.prototype);
                response.status = status;
                response.statusText = '';
                response.headers = headers;
                response.body = null;
                response.type = 'default';
                response.url = '';
                response.redirected = false;
                return response;
            }
        }
        vmGlobalThis.Response = Response;
        class ReadableStream {
            constructor() {
                ENOTSUP();
            }
            get locked() {
                return false;
            }
            cancel() {
                ENOTSUP();
            }
            getReader() {
                ENOTSUP();
            }
            pipeThrough() {
                ENOTSUP();
            }
            pipeTo() {
                ENOTSUP();
            }
            tee() {
                ENOTSUP();
            }
            values() {
                ENOTSUP();
            }
            static from() {
                ENOTSUP();
            }
            [Symbol.asyncIterator]() {
                ENOTSUP();
            }
        }
        vmGlobalThis.ReadableStream = ReadableStream;
        class WritableStream {
            constructor() {
                ENOTSUP();
            }
            get locked() {
                return false;
            }
            abort() {
                ENOTSUP();
            }
            close() {
                ENOTSUP();
            }
            getWriter() {
                ENOTSUP();
            }
        }
        vmGlobalThis.WritableStream = WritableStream;
        class TransformStream {
            readable;
            writable;
            constructor() {
                ENOTSUP();
            }
        }
        vmGlobalThis.TransformStream = TransformStream;
        // Eventually we'll probably want to provide our own `console` object,
        // but for now we'll just expose the global one.
        vmGlobalThis.console = globalThis.console;
        // HACK: propagate symbol needed for AI gateway usage
        const SYMBOL_FOR_REQ_CONTEXT = Symbol.for('@vercel/request-context');
        // @ts-expect-error - `@types/node` says symbol is not valid, but it does work
        vmGlobalThis[SYMBOL_FOR_REQ_CONTEXT] = globalThis[SYMBOL_FOR_REQ_CONTEXT];
        // Get a reference to the user-defined workflow function.
        // The filename parameter ensures stack traces show a meaningful name
        // (e.g., "example/workflows/99_e2e.ts") instead of "evalmachine.<anonymous>".
        const parsedName = parseWorkflowName(workflowRun.workflowName);
        const filename = parsedName?.moduleSpecifier || workflowRun.workflowName;
        const workflowFn = runInContext(`${workflowCode}; globalThis.__private_workflows?.get(${JSON.stringify(workflowRun.workflowName)})`, context, { filename });
        if (typeof workflowFn !== 'function') {
            throw new ReferenceError(`Workflow ${JSON.stringify(workflowRun.workflowName)} must be a function, but got "${typeof workflowFn}" instead`);
        }
        const args = await hydrateWorkflowArguments(workflowRun.input, workflowRun.runId, encryptionKey, vmGlobalThis);
        span?.setAttributes({
            ...WorkflowArgumentsCount(args.length),
        });
        // Invoke user workflow
        const result = await Promise.race([
            workflowFn(...args),
            workflowDiscontinuation.promise,
        ]);
        const dehydrated = await dehydrateWorkflowReturnValue(result, workflowRun.runId, encryptionKey, vmGlobalThis);
        span?.setAttributes({
            ...WorkflowResultType(typeof result),
        });
        return dehydrated;
    });
}

/**
 * Internal helper that returns the hook, the associated workflow run,
 * and the resolved encryption key.
 */
async function getHookByTokenWithKey(token) {
    const world = getWorld();
    const hook = await world.hooks.getByToken(token);
    const run = await world.runs.get(hook.runId);
    const rawKey = await world.getEncryptionKeyForRun?.(run);
    const encryptionKey = rawKey ? await importKey(rawKey) : undefined;
    if (typeof hook.metadata !== 'undefined') {
        hook.metadata = await hydrateStepArguments(hook.metadata, hook.runId);
    }
    return { hook, run, encryptionKey };
}
/**
 * Resumes a workflow run by sending a payload to a hook identified by its token.
 *
 * This function is called externally (e.g., from an API route or server action)
 * to send data to a hook and resume the associated workflow run.
 *
 * @param tokenOrHook - The unique token identifying the hook, or the hook object itself
 * @param payload - The data payload to send to the hook
 * @returns Promise resolving to the hook
 * @throws Error if the hook is not found or if there's an error during the process
 *
 * @example
 *
 * ```ts
 * // In an API route
 * import { resumeHook } from '@workflow/core/runtime';
 *
 * export async function POST(request: Request) {
 *   const { token, data } = await request.json();
 *
 *   try {
 *     const hook = await resumeHook(token, data);
 *     return Response.json({ runId: hook.runId });
 *   } catch (error) {
 *     return new Response('Hook not found', { status: 404 });
 *   }
 * }
 * ```
 */
async function resumeHook(tokenOrHook, payload, encryptionKeyOverride) {
    return await waitedUntil(() => {
        return trace('hook.resume', async (span) => {
            const world = getWorld();
            try {
                let hook;
                let workflowRun;
                let encryptionKey;
                if (typeof tokenOrHook === 'string') {
                    const result = await getHookByTokenWithKey(tokenOrHook);
                    hook = result.hook;
                    workflowRun = result.run;
                    encryptionKey = encryptionKeyOverride ?? result.encryptionKey;
                }
                else {
                    hook = tokenOrHook;
                    workflowRun = await world.runs.get(hook.runId);
                    if (encryptionKeyOverride) {
                        encryptionKey = encryptionKeyOverride;
                    }
                    else {
                        const rawKey = await world.getEncryptionKeyForRun?.(workflowRun);
                        encryptionKey = rawKey ? await importKey(rawKey) : undefined;
                    }
                }
                span?.setAttributes({
                    ...HookToken(hook.token),
                    ...HookId(hook.hookId),
                    ...WorkflowRunId(hook.runId),
                });
                // Dehydrate the payload for storage
                const ops = [];
                const v1Compat = isLegacySpecVersion(hook.specVersion);
                const dehydratedPayload = await dehydrateStepReturnValue(payload, hook.runId, encryptionKey, ops, globalThis, v1Compat);
                // NOTE: Workaround instead of injecting catching undefined unhandled rejections in webhook bundle
                functionsExports.waitUntil(Promise.all(ops).catch((err) => {
                    if (err !== undefined)
                        throw err;
                }));
                // Create a hook_received event with the payload
                await world.events.create(hook.runId, {
                    eventType: 'hook_received',
                    specVersion: SPEC_VERSION_CURRENT,
                    correlationId: hook.hookId,
                    eventData: {
                        payload: dehydratedPayload,
                    },
                }, { v1Compat });
                span?.setAttributes({
                    ...WorkflowName(workflowRun.workflowName),
                });
                const traceCarrier = workflowRun.executionContext?.traceCarrier;
                if (traceCarrier) {
                    const context = await getSpanContextForTraceCarrier(traceCarrier);
                    if (context) {
                        span?.addLink?.({ context });
                    }
                }
                // Re-trigger the workflow against the deployment ID associated
                // with the workflow run that the hook belongs to
                await world.queue(getWorkflowQueueName(workflowRun.workflowName), {
                    runId: hook.runId,
                    // attach the trace carrier from the workflow run
                    traceCarrier: workflowRun.executionContext?.traceCarrier ?? undefined,
                }, {
                    deploymentId: workflowRun.deploymentId,
                });
                return hook;
            }
            catch (err) {
                span?.setAttributes({
                    ...HookToken(typeof tokenOrHook === 'string' ? tokenOrHook : tokenOrHook.token),
                    ...HookFound(false),
                });
                throw err;
            }
        });
    });
}
/**
 * Resumes a webhook by sending a {@link https://developer.mozilla.org/en-US/docs/Web/API/Request | Request}
 * object to a hook identified by its token.
 *
 * This function is called externally (e.g., from an API route or server action)
 * to send a request to a webhook and resume the associated workflow run.
 *
 * @param token - The unique token identifying the hook
 * @param request - The request to send to the hook
 * @returns Promise resolving to the response
 * @throws Error if the hook is not found or if there's an error during the process
 *
 * @example
 *
 * ```ts
 * // In an API route
 * import { resumeWebhook } from '@workflow/core/runtime';
 *
 * export async function POST(request: Request) {
 *   const url = new URL(request.url);
 *   const token = url.searchParams.get('token');
 *
 *   if (!token) {
 *     return new Response('Missing token', { status: 400 });
 *   }
 *
 *   try {
 *     const response = await resumeWebhook(token, request);
 *     return response;
 *   } catch (error) {
 *     return new Response('Webhook not found', { status: 404 });
 *   }
 * }
 * ```
 */
async function resumeWebhook(token, request) {
    const { hook, encryptionKey } = await getHookByTokenWithKey(token);
    let response;
    let responseReadable;
    if (hook.metadata &&
        typeof hook.metadata === 'object' &&
        'respondWith' in hook.metadata) {
        if (hook.metadata.respondWith === 'manual') {
            const { readable, writable } = new TransformStream();
            responseReadable = readable;
            // The request instance includes the writable stream which will be used
            // to write the response to the client from within the workflow run
            request[WEBHOOK_RESPONSE_WRITABLE] = writable;
        }
        else if (hook.metadata.respondWith instanceof Response) {
            response = hook.metadata.respondWith;
        }
        else {
            throw new WorkflowRuntimeError(`Invalid \`respondWith\` value: ${hook.metadata.respondWith}`, { slug: ERROR_SLUGS.WEBHOOK_INVALID_RESPOND_WITH_VALUE });
        }
    }
    else {
        // No `respondWith` value implies the default behavior of returning a 202
        response = new Response(null, { status: 202 });
    }
    await resumeHook(hook, request, encryptionKey);
    if (responseReadable) {
        // Wait for the readable stream to emit one chunk,
        // which is the `Response` object
        const reader = responseReadable.getReader();
        const chunk = await reader.read();
        if (chunk.value) {
            response = chunk.value;
        }
        reader.cancel();
    }
    if (!response) {
        throw new WorkflowRuntimeError('Workflow run did not send a response', {
            slug: ERROR_SLUGS.WEBHOOK_RESPONSE_NOT_SENT,
        });
    }
    return response;
}

/**
 * A handler class for a workflow run.
 */
class Run {
    /**
     * The ID of the workflow run.
     */
    runId;
    /**
     * The world object.
     * @internal
     */
    world;
    constructor(runId) {
        this.runId = runId;
        this.world = getWorld();
    }
    /**
     * Cancels the workflow run.
     */
    async cancel() {
        await this.world.events.create(this.runId, {
            eventType: 'run_cancelled',
            specVersion: SPEC_VERSION_CURRENT,
        });
    }
    /**
     * The status of the workflow run.
     */
    get status() {
        return this.world.runs.get(this.runId).then((run) => run.status);
    }
    /**
     * The return value of the workflow run.
     * Polls the workflow return value until it is completed.
     */
    get returnValue() {
        return this.pollReturnValue();
    }
    /**
     * The name of the workflow.
     */
    get workflowName() {
        return this.world.runs.get(this.runId).then((run) => run.workflowName);
    }
    /**
     * The timestamp when the workflow run was created.
     */
    get createdAt() {
        return this.world.runs.get(this.runId).then((run) => run.createdAt);
    }
    /**
     * The timestamp when the workflow run started execution.
     * Returns undefined if the workflow has not started yet.
     */
    get startedAt() {
        return this.world.runs.get(this.runId).then((run) => run.startedAt);
    }
    /**
     * The timestamp when the workflow run completed.
     * Returns undefined if the workflow has not completed yet.
     */
    get completedAt() {
        return this.world.runs.get(this.runId).then((run) => run.completedAt);
    }
    /**
     * The readable stream of the workflow run.
     */
    get readable() {
        return this.getReadable();
    }
    /**
     * Retrieves the workflow run's default readable stream, which reads chunks
     * written to the corresponding writable stream {@link getWritable}.
     *
     * @param options - The options for the readable stream.
     * @returns The `ReadableStream` for the workflow run.
     */
    getReadable(options = {}) {
        const { ops = [], global = globalThis, startIndex, namespace } = options;
        const name = getWorkflowRunStreamId(this.runId, namespace);
        return getExternalRevivers(global, ops, this.runId).ReadableStream({
            name,
            startIndex,
        });
    }
    /**
     * Polls the workflow return value every 1 second until it is completed.
     * @internal
     * @returns The workflow return value.
     */
    async pollReturnValue() {
        while (true) {
            try {
                const run = await this.world.runs.get(this.runId);
                if (run.status === 'completed') {
                    const rawKey = await this.world.getEncryptionKeyForRun?.(run);
                    const encryptionKey = rawKey ? await importKey(rawKey) : undefined;
                    return await hydrateWorkflowReturnValue(run.output, this.runId, encryptionKey);
                }
                if (run.status === 'cancelled') {
                    throw new WorkflowRunCancelledError(this.runId);
                }
                if (run.status === 'failed') {
                    throw new WorkflowRunFailedError(this.runId, run.error);
                }
                throw new WorkflowRunNotCompletedError(this.runId, run.status);
            }
            catch (error) {
                if (WorkflowRunNotCompletedError.is(error)) {
                    await new Promise((resolve) => setTimeout(resolve, 1_000));
                    continue;
                }
                throw error;
            }
        }
    }
}

// Generated by genversion.
const version = '4.1.0-beta.60';

/** ULID generator for client-side runId generation */
const ulid = monotonicFactory();
async function start(workflow, argsOrOptions, options) {
    return await waitedUntil(() => {
        // @ts-expect-error this field is added by our client transform
        const workflowName = workflow?.workflowId;
        if (!workflowName) {
            throw new WorkflowRuntimeError(`'start' received an invalid workflow function. Ensure the Workflow Development Kit is configured correctly and the function includes a 'use workflow' directive.`, { slug: 'start-invalid-workflow-function' });
        }
        return trace(`workflow.start ${workflowName}`, async (span) => {
            span?.setAttributes({
                ...WorkflowName(workflowName),
                ...WorkflowOperation('start'),
            });
            let args = [];
            let opts = {};
            if (Array.isArray(argsOrOptions)) {
                args = argsOrOptions;
            }
            else if (typeof argsOrOptions === 'object') {
                opts = argsOrOptions;
            }
            span?.setAttributes({
                ...WorkflowArgumentsCount(args.length),
            });
            const world = opts?.world ?? getWorld();
            const deploymentId = opts.deploymentId ?? (await world.getDeploymentId());
            const ops = [];
            // Generate runId client-side so we have it before serialization
            // (required for future E2E encryption where runId is part of the encryption context)
            const runId = `wrun_${ulid()}`;
            // Serialize current trace context to propagate across queue boundary
            const traceCarrier = await serializeTraceCarrier();
            const specVersion = opts.specVersion ?? SPEC_VERSION_CURRENT;
            const v1Compat = isLegacySpecVersion(specVersion);
            // Resolve encryption key for the new run. The runId has already been
            // generated above (client-generated ULID) and will be used for both
            // key derivation and the run_created event. The World implementation
            // uses the runId for per-run HKDF key derivation. The opts object is
            // passed as opaque context so the World can read world-specific fields
            // (e.g., deploymentId for world-vercel) needed for key resolution.
            const rawKey = await world.getEncryptionKeyForRun?.(runId, { ...opts });
            const encryptionKey = rawKey ? await importKey(rawKey) : undefined;
            // Create run via run_created event (event-sourced architecture)
            // Pass client-generated runId - server will accept and use it
            const workflowArguments = await dehydrateWorkflowArguments(args, runId, encryptionKey, ops, globalThis, v1Compat);
            const result = await world.events.create(runId, {
                eventType: 'run_created',
                specVersion,
                eventData: {
                    deploymentId: deploymentId,
                    workflowName: workflowName,
                    input: workflowArguments,
                    executionContext: { traceCarrier, workflowCoreVersion: version },
                },
            }, { v1Compat });
            // Assert that the run was created
            if (!result.run) {
                throw new WorkflowRuntimeError("Missing 'run' in server response for 'run_created' event");
            }
            // Verify server accepted our runId
            if (result.run.runId !== runId) {
                throw new WorkflowRuntimeError(`Server returned different runId than requested: expected ${runId}, got ${result.run.runId}`);
            }
            functionsExports.waitUntil(Promise.all(ops).catch((err) => {
                // Ignore expected client disconnect errors (e.g., browser refresh during streaming)
                const isAbortError = err?.name === 'AbortError' || err?.name === 'ResponseAborted';
                if (!isAbortError)
                    throw err;
            }));
            span?.setAttributes({
                ...WorkflowRunId(runId),
                ...WorkflowRunStatus(result.run.status),
                ...DeploymentId(deploymentId),
            });
            await world.queue(getWorkflowQueueName(workflowName), {
                runId,
                traceCarrier,
            }, {
                deploymentId,
            });
            return new Run(runId);
        });
    });
}

const DEFAULT_STEP_MAX_RETRIES = 3;
const stepHandler = getWorldHandlers().createQueueHandler('__wkf_step_', async (message_, metadata) => {
    // Check if this is a health check message
    // NOTE: Health check messages are intentionally unauthenticated for monitoring purposes.
    // They only write a simple status response to a stream and do not expose sensitive data.
    // The stream name includes a unique correlationId that must be known by the caller.
    const healthCheck = parseHealthCheckPayload(message_);
    if (healthCheck) {
        await handleHealthCheckMessage(healthCheck, 'step');
        return;
    }
    const { workflowName, workflowRunId, workflowStartedAt, stepId, traceCarrier: traceContext, requestedAt, } = StepInvokePayloadSchema.parse(message_);
    const spanLinks = await linkToCurrentContext();
    // Execute step within the propagated trace context
    return await withTraceContext(traceContext, async () => {
        // Extract the step name from the topic name
        const stepName = metadata.queueName.slice('__wkf_step_'.length);
        const world = getWorld();
        // Resolve local async values concurrently before entering the trace span
        const [port, spanKind] = await Promise.all([
            getPort(),
            getSpanKind('CONSUMER'),
        ]);
        return trace(`STEP ${stepName}`, { kind: spanKind, links: spanLinks }, async (span) => {
            span?.setAttributes({
                ...StepName(stepName),
                ...StepAttempt(metadata.attempt),
                // Standard OTEL messaging conventions
                ...MessagingSystem('vercel-queue'),
                ...MessagingDestinationName(metadata.queueName),
                ...MessagingMessageId(metadata.messageId),
                ...MessagingOperationType('process'),
                ...getQueueOverhead({ requestedAt }),
            });
            const stepFn = getStepFunction(stepName);
            if (!stepFn) {
                throw new Error(`Step "${stepName}" not found`);
            }
            if (typeof stepFn !== 'function') {
                throw new Error(`Step "${stepName}" is not a function (got ${typeof stepFn})`);
            }
            const maxRetries = stepFn.maxRetries ?? DEFAULT_STEP_MAX_RETRIES;
            span?.setAttributes({
                ...WorkflowName(workflowName),
                ...WorkflowRunId(workflowRunId),
                ...StepId(stepId),
                ...StepMaxRetries(maxRetries),
                ...StepTracePropagated(!!traceContext),
            });
            // step_started validates state and returns the step entity, so no separate
            // world.steps.get() call is needed. The server checks:
            // - Step not in terminal state (returns 409)
            // - retryAfter timestamp reached (returns 425 with Retry-After header)
            // - Workflow still active (returns 410 if completed)
            let step;
            try {
                const startResult = await withServerErrorRetry(() => world.events.create(workflowRunId, {
                    eventType: 'step_started',
                    specVersion: SPEC_VERSION_CURRENT,
                    correlationId: stepId,
                }));
                if (!startResult.step) {
                    throw new WorkflowRuntimeError(`step_started event for "${stepId}" did not return step entity`);
                }
                step = startResult.step;
            }
            catch (err) {
                if (WorkflowAPIError.is(err)) {
                    if (WorkflowAPIError.is(err) && err.status === 429) {
                        const retryRetryAfter = Math.max(1, typeof err.retryAfter === 'number' ? err.retryAfter : 1);
                        runtimeLogger.warn('Throttled again on retry, deferring to queue', {
                            retryAfterSeconds: retryRetryAfter,
                        });
                        return { timeoutSeconds: retryRetryAfter };
                    }
                    // 410 Gone: Workflow has already completed
                    if (err.status === 410) {
                        runtimeLogger.info(`Workflow run "${workflowRunId}" has already completed, skipping step "${stepId}": ${err.message}`);
                        return;
                    }
                    // 409 Conflict: Step in terminal state (completed/failed/cancelled)
                    // Re-enqueue the workflow to continue processing
                    if (err.status === 409) {
                        runtimeLogger.debug('Step in terminal state, re-enqueuing workflow', {
                            stepName,
                            stepId,
                            workflowRunId,
                            error: err.message,
                        });
                        span?.setAttributes({
                            ...StepSkipped(true),
                            // Use 'completed' as a representative terminal state for the skip reason
                            ...StepSkipReason('completed'),
                        });
                        // Add span event for step skip
                        span?.addEvent?.('step.skipped', {
                            'skip.reason': 'terminal_state',
                            'step.name': stepName,
                            'step.id': stepId,
                        });
                        await queueMessage(world, getWorkflowQueueName(workflowName), {
                            runId: workflowRunId,
                            traceCarrier: await serializeTraceCarrier(),
                            requestedAt: new Date(),
                        });
                        return;
                    }
                    // 425 Too Early: retryAfter timestamp not reached yet
                    // Return timeout to queue so it retries later
                    if (err.status === 425) {
                        // Parse retryAfter from error response meta
                        const retryAfterStr = err.meta?.retryAfter;
                        const retryAfter = retryAfterStr
                            ? new Date(retryAfterStr)
                            : new Date(Date.now() + 1000);
                        const timeoutSeconds = Math.max(1, Math.ceil((retryAfter.getTime() - Date.now()) / 1000));
                        span?.setAttributes({
                            ...StepRetryTimeoutSeconds(timeoutSeconds),
                        });
                        // Add span event for delayed retry
                        span?.addEvent?.('step.delayed', {
                            'delay.reason': 'retry_after_not_reached',
                            'delay.timeout_seconds': timeoutSeconds,
                            'delay.retry_after': retryAfter.toISOString(),
                        });
                        runtimeLogger.debug('Step retryAfter timestamp not yet reached', {
                            stepName,
                            stepId,
                            retryAfter,
                            timeoutSeconds,
                        });
                        return { timeoutSeconds };
                    }
                }
                // Re-throw other errors
                throw err;
            }
            runtimeLogger.debug('Step execution details', {
                stepName,
                stepId: step.stepId,
                status: step.status,
                attempt: step.attempt,
            });
            span?.setAttributes({
                ...StepStatus(step.status),
            });
            let result;
            // Check max retries AFTER step_started (attempt was just incremented)
            // step.attempt tracks how many times step_started has been called.
            // Note: maxRetries is the number of RETRIES after the first attempt, so total attempts = maxRetries + 1
            // Use > here (not >=) because this guards against re-invocation AFTER all attempts are used.
            // The post-failure check uses >= to decide whether to retry after a failure.
            if (step.attempt > maxRetries + 1) {
                const retryCount = step.attempt - 1;
                const errorMessage = `Step "${stepName}" exceeded max retries (${retryCount} ${pluralize('retry', 'retries', retryCount)})`;
                stepLogger.error('Step exceeded max retries', {
                    workflowRunId,
                    stepName,
                    retryCount,
                });
                // Fail the step via event (event-sourced architecture)
                try {
                    await world.events.create(workflowRunId, {
                        eventType: 'step_failed',
                        specVersion: SPEC_VERSION_CURRENT,
                        correlationId: stepId,
                        eventData: {
                            error: errorMessage,
                            stack: step.error?.stack,
                        },
                    });
                }
                catch (err) {
                    if (WorkflowAPIError.is(err) && err.status === 409) {
                        runtimeLogger.warn('Tried failing step, but step has already finished.', {
                            workflowRunId,
                            stepId,
                            stepName,
                            message: err.message,
                        });
                        return;
                    }
                    throw err;
                }
                span?.setAttributes({
                    ...StepStatus('failed'),
                    ...StepRetryExhausted(true),
                });
                // Re-invoke the workflow to handle the failed step
                await queueMessage(world, getWorkflowQueueName(workflowName), {
                    runId: workflowRunId,
                    traceCarrier: await serializeTraceCarrier(),
                    requestedAt: new Date(),
                });
                return;
            }
            try {
                // step_started already validated the step is in valid state (pending/running)
                // and returned the updated step entity with incremented attempt
                // step.attempt is now the current attempt number (after increment)
                const attempt = step.attempt;
                if (!step.startedAt) {
                    throw new WorkflowRuntimeError(`Step "${stepId}" has no "startedAt" timestamp`);
                }
                // Capture startedAt for use in async callback (TypeScript narrowing doesn't persist)
                const stepStartedAt = step.startedAt;
                // Hydrate the step input arguments, closure variables, and thisVal
                // NOTE: This captures only the synchronous portion of hydration. Any async
                // operations (e.g., stream loading) are added to `ops` and executed later
                // via Promise.all(ops) - their timing is not included in this measurement.
                const ops = [];
                const rawKey = await world.getEncryptionKeyForRun?.(workflowRunId);
                const encryptionKey = rawKey ? await importKey(rawKey) : undefined;
                const hydratedInput = await trace('step.hydrate', {}, async (hydrateSpan) => {
                    const startTime = Date.now();
                    const result = await hydrateStepArguments(step.input, workflowRunId, encryptionKey, ops);
                    const durationMs = Date.now() - startTime;
                    hydrateSpan?.setAttributes({
                        ...StepArgumentsCount(result.args.length),
                        ...QueueDeserializeTimeMs(durationMs),
                    });
                    return result;
                });
                const args = hydratedInput.args;
                const thisVal = hydratedInput.thisVal ?? null;
                // Execute the step function with tracing
                const executionStartTime = Date.now();
                result = await trace('step.execute', {}, async () => {
                    return await contextStorage.run({
                        stepMetadata: {
                            stepId,
                            stepStartedAt: new Date(+stepStartedAt),
                            attempt,
                        },
                        workflowMetadata: {
                            workflowRunId,
                            workflowStartedAt: new Date(+workflowStartedAt),
                            // TODO: there should be a getUrl method on the world interface itself. This
                            // solution only works for vercel + local worlds.
                            url: process.env.VERCEL_URL
                                ? `https://${process.env.VERCEL_URL}`
                                : `http://localhost:${port ?? 3000}`,
                        },
                        ops,
                        closureVars: hydratedInput.closureVars,
                    }, () => stepFn.apply(thisVal, args));
                });
                const executionTimeMs = Date.now() - executionStartTime;
                span?.setAttributes({
                    ...QueueExecutionTimeMs(executionTimeMs),
                });
                // NOTE: None of the code from this point is guaranteed to run
                // Since the step might fail or cause a function timeout and the process might be SIGKILL'd
                // The workflow runtime must be resilient to the below code not executing on a failed step
                result = await trace('step.dehydrate', {}, async (dehydrateSpan) => {
                    const startTime = Date.now();
                    const dehydrated = await dehydrateStepReturnValue(result, workflowRunId, encryptionKey, ops);
                    const durationMs = Date.now() - startTime;
                    dehydrateSpan?.setAttributes({
                        ...QueueSerializeTimeMs(durationMs),
                        ...StepResultType(typeof dehydrated),
                    });
                    return dehydrated;
                });
                functionsExports.waitUntil(Promise.all(ops).catch((err) => {
                    // Ignore expected client disconnect errors (e.g., browser refresh during streaming)
                    const isAbortError = err?.name === 'AbortError' || err?.name === 'ResponseAborted';
                    if (!isAbortError)
                        throw err;
                }));
                // Run step_completed and trace serialization concurrently;
                // the trace carrier is used in the final queueMessage call below
                let stepCompleted409 = false;
                const [, traceCarrier] = await Promise.all([
                    withServerErrorRetry(() => world.events.create(workflowRunId, {
                        eventType: 'step_completed',
                        specVersion: SPEC_VERSION_CURRENT,
                        correlationId: stepId,
                        eventData: {
                            result: result,
                        },
                    })).catch((err) => {
                        if (WorkflowAPIError.is(err) && err.status === 409) {
                            runtimeLogger.warn('Tried completing step, but step has already finished.', {
                                workflowRunId,
                                stepId,
                                stepName,
                                message: err.message,
                            });
                            stepCompleted409 = true;
                            return;
                        }
                        throw err;
                    }),
                    serializeTraceCarrier(),
                ]);
                if (stepCompleted409) {
                    return;
                }
                span?.setAttributes({
                    ...StepStatus('completed'),
                    ...StepResultType(typeof result),
                });
                // Queue the workflow continuation with the concurrently-resolved trace carrier
                await queueMessage(world, getWorkflowQueueName(workflowName), {
                    runId: workflowRunId,
                    traceCarrier,
                    requestedAt: new Date(),
                });
                return;
            }
            catch (err) {
                const normalizedError = await normalizeUnknownError(err);
                const normalizedStack = normalizedError.stack || getErrorStack(err) || '';
                // Record exception for OTEL error tracking
                if (err instanceof Error) {
                    span?.recordException?.(err);
                }
                // Determine error category and retryability
                const isFatal = FatalError.is(err);
                const isRetryable = RetryableError.is(err);
                const errorCategory = isFatal
                    ? 'fatal'
                    : isRetryable
                        ? 'retryable'
                        : 'transient';
                span?.setAttributes({
                    ...StepErrorName(getErrorName(err)),
                    ...StepErrorMessage(normalizedError.message),
                    ...ErrorType(getErrorName(err)),
                    ...ErrorCategory(errorCategory),
                    ...ErrorRetryable(!isFatal),
                });
                if (WorkflowAPIError.is(err)) {
                    if (err.status === 410) {
                        // Workflow has already completed, so no-op
                        stepLogger.info('Workflow run already completed, skipping step', {
                            workflowRunId,
                            stepId,
                            message: err.message,
                        });
                        return;
                    }
                    // Server errors (5xx) from workflow-server are treated as persistent
                    // infrastructure issues. The withServerErrorRetry wrapper already
                    // retried the call a few times; if we still have a 5xx here it's
                    // likely persistent. Re-throw so the queue can retry the job and
                    // re-invoke this handler. Note: by the time we reach this point,
                    // step_started has already run and incremented step.attempt, and a
                    // subsequent queue retry may increment attempts again depending on
                    // storage semantics, so these retries are not guaranteed to be
                    // "free" with respect to step attempts.
                    if (err.status !== undefined && err.status >= 500) {
                        runtimeLogger.warn('Persistent server error (5xx) during step, deferring to queue retry', {
                            status: err.status,
                            workflowRunId,
                            stepId,
                            error: err.message,
                            url: err.url,
                        });
                        throw err;
                    }
                }
                if (isFatal) {
                    stepLogger.error('Encountered FatalError while executing step, bubbling up to parent workflow', {
                        workflowRunId,
                        stepName,
                        errorStack: normalizedStack,
                    });
                    // Fail the step via event (event-sourced architecture)
                    try {
                        await withServerErrorRetry(() => world.events.create(workflowRunId, {
                            eventType: 'step_failed',
                            specVersion: SPEC_VERSION_CURRENT,
                            correlationId: stepId,
                            eventData: {
                                error: normalizedError.message,
                                stack: normalizedStack,
                            },
                        }));
                    }
                    catch (stepFailErr) {
                        if (WorkflowAPIError.is(stepFailErr) &&
                            stepFailErr.status === 409) {
                            runtimeLogger.warn('Tried failing step, but step has already finished.', {
                                workflowRunId,
                                stepId,
                                stepName,
                                message: stepFailErr.message,
                            });
                            return;
                        }
                        throw stepFailErr;
                    }
                    span?.setAttributes({
                        ...StepStatus('failed'),
                        ...StepFatalError(true),
                    });
                }
                else {
                    const maxRetries = stepFn.maxRetries ?? DEFAULT_STEP_MAX_RETRIES;
                    // step.attempt was incremented by step_started, use it here
                    const currentAttempt = step.attempt;
                    span?.setAttributes({
                        ...StepAttempt(currentAttempt),
                        ...StepMaxRetries(maxRetries),
                    });
                    // Note: maxRetries is the number of RETRIES after the first attempt, so total attempts = maxRetries + 1
                    if (currentAttempt >= maxRetries + 1) {
                        // Max retries reached
                        const retryCount = step.attempt - 1;
                        stepLogger.error('Max retries reached, bubbling error to parent workflow', {
                            workflowRunId,
                            stepName,
                            attempt: step.attempt,
                            retryCount,
                            errorStack: normalizedStack,
                        });
                        const errorMessage = `Step "${stepName}" failed after ${maxRetries} ${pluralize('retry', 'retries', maxRetries)}: ${normalizedError.message}`;
                        // Fail the step via event (event-sourced architecture)
                        try {
                            await withServerErrorRetry(() => world.events.create(workflowRunId, {
                                eventType: 'step_failed',
                                specVersion: SPEC_VERSION_CURRENT,
                                correlationId: stepId,
                                eventData: {
                                    error: errorMessage,
                                    stack: normalizedStack,
                                },
                            }));
                        }
                        catch (stepFailErr) {
                            if (WorkflowAPIError.is(stepFailErr) &&
                                stepFailErr.status === 409) {
                                runtimeLogger.warn('Tried failing step, but step has already finished.', {
                                    workflowRunId,
                                    stepId,
                                    stepName,
                                    message: stepFailErr.message,
                                });
                                return;
                            }
                            throw stepFailErr;
                        }
                        span?.setAttributes({
                            ...StepStatus('failed'),
                            ...StepRetryExhausted(true),
                        });
                    }
                    else {
                        // Not at max retries yet - log as a retryable error
                        if (RetryableError.is(err)) {
                            stepLogger.warn('Encountered RetryableError, step will be retried', {
                                workflowRunId,
                                stepName,
                                attempt: currentAttempt,
                                message: err.message,
                            });
                        }
                        else {
                            stepLogger.warn('Encountered Error, step will be retried', {
                                workflowRunId,
                                stepName,
                                attempt: currentAttempt,
                                errorStack: normalizedStack,
                            });
                        }
                        // Set step to pending for retry via event (event-sourced architecture)
                        // step_retrying records the error and sets status to pending
                        try {
                            await withServerErrorRetry(() => world.events.create(workflowRunId, {
                                eventType: 'step_retrying',
                                specVersion: SPEC_VERSION_CURRENT,
                                correlationId: stepId,
                                eventData: {
                                    error: normalizedError.message,
                                    stack: normalizedStack,
                                    ...(RetryableError.is(err) && {
                                        retryAfter: err.retryAfter,
                                    }),
                                },
                            }));
                        }
                        catch (stepRetryErr) {
                            if (WorkflowAPIError.is(stepRetryErr) &&
                                stepRetryErr.status === 409) {
                                runtimeLogger.warn('Tried retrying step, but step has already finished.', {
                                    workflowRunId,
                                    stepId,
                                    stepName,
                                    message: stepRetryErr.message,
                                });
                                return;
                            }
                            throw stepRetryErr;
                        }
                        const timeoutSeconds = Math.max(1, RetryableError.is(err)
                            ? Math.ceil((+err.retryAfter.getTime() - Date.now()) / 1000)
                            : 1);
                        span?.setAttributes({
                            ...StepRetryTimeoutSeconds(timeoutSeconds),
                            ...StepRetryWillRetry(true),
                        });
                        // Add span event for retry scheduling
                        span?.addEvent?.('retry.scheduled', {
                            'retry.timeout_seconds': timeoutSeconds,
                            'retry.attempt': currentAttempt,
                            'retry.max_retries': maxRetries,
                        });
                        // It's a retryable error - so have the queue keep the message visible
                        // so that it gets retried.
                        return { timeoutSeconds };
                    }
                }
            }
            await queueMessage(world, getWorkflowQueueName(workflowName), {
                runId: workflowRunId,
                traceCarrier: await serializeTraceCarrier(),
                requestedAt: new Date(),
            });
        });
    });
});
/**
 * A single route that handles any step execution request and routes to the
 * appropriate step function. We may eventually want to create different bundles
 * for each step, this is temporary.
 */
const stepEntrypoint = 
/* @__PURE__ */ withHealthCheck(stepHandler);

/**
 * Function that creates a single route which handles any workflow execution
 * request and routes to the appropriate workflow function.
 *
 * @param workflowCode - The workflow bundle code containing all the workflow
 * functions at the top level.
 * @returns A function that can be used as a Vercel API route.
 */
function workflowEntrypoint(workflowCode) {
    const handler = getWorldHandlers().createQueueHandler('__wkf_workflow_', async (message_, metadata) => {
        // Check if this is a health check message
        // NOTE: Health check messages are intentionally unauthenticated for monitoring purposes.
        // They only write a simple status response to a stream and do not expose sensitive data.
        // The stream name includes a unique correlationId that must be known by the caller.
        const healthCheck = parseHealthCheckPayload(message_);
        if (healthCheck) {
            await handleHealthCheckMessage(healthCheck, 'workflow');
            return;
        }
        const { runId, traceCarrier: traceContext, requestedAt, serverErrorRetryCount, } = WorkflowInvokePayloadSchema.parse(message_);
        // Extract the workflow name from the topic name
        const workflowName = metadata.queueName.slice('__wkf_workflow_'.length);
        const spanLinks = await linkToCurrentContext();
        // Invoke user workflow within the propagated trace context and baggage
        return await withTraceContext(traceContext, async () => {
            // Set workflow context as baggage for automatic propagation
            return await withWorkflowBaggage({ workflowRunId: runId, workflowName }, async () => {
                const world = getWorld();
                return trace(`WORKFLOW ${workflowName}`, { links: spanLinks }, async (span) => {
                    span?.setAttributes({
                        ...WorkflowName(workflowName),
                        ...WorkflowOperation('execute'),
                        // Standard OTEL messaging conventions
                        ...MessagingSystem('vercel-queue'),
                        ...MessagingDestinationName(metadata.queueName),
                        ...MessagingMessageId(metadata.messageId),
                        ...MessagingOperationType('process'),
                        ...getQueueOverhead({ requestedAt }),
                    });
                    // TODO: validate `workflowName` exists before consuming message?
                    span?.setAttributes({
                        ...WorkflowRunId(runId),
                        ...WorkflowTracePropagated(!!traceContext),
                    });
                    return await withThrottleRetry(async () => {
                        let workflowStartedAt = -1;
                        let workflowRun = await world.runs.get(runId);
                        try {
                            if (workflowRun.status === 'pending') {
                                // Transition run to 'running' via event (event-sourced architecture)
                                const result = await world.events.create(runId, {
                                    eventType: 'run_started',
                                    specVersion: SPEC_VERSION_CURRENT,
                                });
                                // Use the run entity from the event response (no extra get call needed)
                                if (!result.run) {
                                    throw new WorkflowRuntimeError(`Event creation for 'run_started' did not return the run entity for run "${runId}"`);
                                }
                                workflowRun = result.run;
                            }
                            // At this point, the workflow is "running" and `startedAt` should
                            // definitely be set.
                            if (!workflowRun.startedAt) {
                                throw new WorkflowRuntimeError(`Workflow run "${runId}" has no "startedAt" timestamp`);
                            }
                            workflowStartedAt = +workflowRun.startedAt;
                            span?.setAttributes({
                                ...WorkflowRunStatus(workflowRun.status),
                                ...WorkflowStartedAt(workflowStartedAt),
                            });
                            if (workflowRun.status !== 'running') {
                                // Workflow has already completed or failed, so we can skip it
                                runtimeLogger.info('Workflow already completed or failed, skipping', {
                                    workflowRunId: runId,
                                    status: workflowRun.status,
                                });
                                // TODO: for `cancel`, we actually want to propagate a WorkflowCancelled event
                                // inside the workflow context so the user can gracefully exit. this is SIGTERM
                                // TODO: furthermore, there should be a timeout or a way to force cancel SIGKILL
                                // so that we actually exit here without replaying the workflow at all, in the case
                                // the replaying the workflow is itself failing.
                                return;
                            }
                            // Load all events into memory before running
                            const events = await getAllWorkflowRunEvents(workflowRun.runId);
                            // Check for any elapsed waits and create wait_completed events
                            const now = Date.now();
                            // Pre-compute completed correlation IDs for O(n) lookup instead of O(n²)
                            const completedWaitIds = new Set(events
                                .filter((e) => e.eventType === 'wait_completed')
                                .map((e) => e.correlationId));
                            // Collect all waits that need completion
                            const waitsToComplete = events
                                .filter((e) => e.eventType === 'wait_created' &&
                                e.correlationId !== undefined &&
                                !completedWaitIds.has(e.correlationId) &&
                                now >= e.eventData.resumeAt.getTime())
                                .map((e) => ({
                                eventType: 'wait_completed',
                                specVersion: SPEC_VERSION_CURRENT,
                                correlationId: e.correlationId,
                            }));
                            // Create all wait_completed events
                            for (const waitEvent of waitsToComplete) {
                                try {
                                    const result = await world.events.create(runId, waitEvent);
                                    // Add the event to the events array so the workflow can see it
                                    events.push(result.event);
                                }
                                catch (err) {
                                    if (WorkflowAPIError.is(err) && err.status === 409) {
                                        runtimeLogger.info('Wait already completed, skipping', {
                                            workflowRunId: runId,
                                            correlationId: waitEvent.correlationId,
                                        });
                                        continue;
                                    }
                                    throw err;
                                }
                            }
                            const result = await trace('workflow.replay', {}, async (replaySpan) => {
                                replaySpan?.setAttributes({
                                    ...WorkflowEventsCount(events.length),
                                });
                                // Resolve the encryption key for this run's deployment
                                const rawKey = await world.getEncryptionKeyForRun?.(workflowRun);
                                const encryptionKey = rawKey
                                    ? await importKey(rawKey)
                                    : undefined;
                                return await runWorkflow(workflowCode, workflowRun, events, encryptionKey);
                            });
                            // Complete the workflow run via event (event-sourced architecture)
                            try {
                                await world.events.create(runId, {
                                    eventType: 'run_completed',
                                    specVersion: SPEC_VERSION_CURRENT,
                                    eventData: {
                                        output: result,
                                    },
                                });
                            }
                            catch (err) {
                                if (WorkflowAPIError.is(err) &&
                                    (err.status === 409 || err.status === 410)) {
                                    runtimeLogger.warn('Tried completing workflow run, but run has already finished.', {
                                        workflowRunId: runId,
                                        message: err.message,
                                    });
                                    return;
                                }
                                else {
                                    throw err;
                                }
                            }
                            span?.setAttributes({
                                ...WorkflowRunStatus('completed'),
                                ...WorkflowEventsCount(events.length),
                            });
                        }
                        catch (err) {
                            if (WorkflowSuspension.is(err)) {
                                const suspensionMessage = buildWorkflowSuspensionMessage(runId, err.stepCount, err.hookCount, err.waitCount);
                                if (suspensionMessage) {
                                    runtimeLogger.debug(suspensionMessage);
                                }
                                const result = await handleSuspension({
                                    suspension: err,
                                    world,
                                    run: workflowRun,
                                    span,
                                });
                                if (result.timeoutSeconds !== undefined) {
                                    return { timeoutSeconds: result.timeoutSeconds };
                                }
                            }
                            else {
                                // Retry server errors (5xx) with exponential backoff before failing the run
                                if (WorkflowAPIError.is(err) &&
                                    err.status !== undefined &&
                                    err.status >= 500) {
                                    const retryCount = serverErrorRetryCount ?? 0;
                                    const delaySecondSteps = [5, 30, 120]; // 5s, 30s, 120s
                                    if (retryCount < delaySecondSteps.length) {
                                        runtimeLogger.warn('Server error (5xx), re-enqueueing workflow with backoff', {
                                            workflowRunId: runId,
                                            retryCount,
                                            delaySeconds: delaySecondSteps[retryCount],
                                            error: err.message,
                                        });
                                        await queueMessage(world, getWorkflowQueueName(workflowName), {
                                            runId,
                                            serverErrorRetryCount: retryCount + 1,
                                            traceCarrier: await serializeTraceCarrier(),
                                            requestedAt: new Date(),
                                        }, { delaySeconds: delaySecondSteps[retryCount] });
                                        return; // Don't fail the run, retry later
                                    }
                                    // Fall through to run_failed after exhausting retries
                                }
                                else if (WorkflowAPIError.is(err) &&
                                    err.status === 429) {
                                    // Throw to let withThrottleRetry handle it
                                    throw err;
                                }
                                // NOTE: this error could be an error thrown in user code, or could also be a WorkflowRuntimeError
                                // (for instance when the event log is corrupted, this is thrown by the event consumer). We could
                                // specially handle these if needed.
                                // Record exception for OTEL error tracking
                                if (err instanceof Error) {
                                    span?.recordException?.(err);
                                }
                                const normalizedError = await normalizeUnknownError(err);
                                const errorName = normalizedError.name || getErrorName(err);
                                const errorMessage = normalizedError.message;
                                let errorStack = normalizedError.stack || getErrorStack(err);
                                // Remap error stack using source maps to show original source locations
                                if (errorStack) {
                                    const parsedName = parseWorkflowName(workflowName);
                                    const filename = parsedName?.moduleSpecifier || workflowName;
                                    errorStack = remapErrorStack(errorStack, filename, workflowCode);
                                }
                                runtimeLogger.error('Error while running workflow', {
                                    workflowRunId: runId,
                                    errorName,
                                    errorStack,
                                });
                                // Fail the workflow run via event (event-sourced architecture)
                                try {
                                    await world.events.create(runId, {
                                        eventType: 'run_failed',
                                        specVersion: SPEC_VERSION_CURRENT,
                                        eventData: {
                                            error: {
                                                message: errorMessage,
                                                stack: errorStack,
                                            },
                                            // TODO: include error codes when we define them
                                        },
                                    });
                                }
                                catch (err) {
                                    if (WorkflowAPIError.is(err) &&
                                        (err.status === 409 || err.status === 410)) {
                                        runtimeLogger.warn('Tried failing workflow run, but run has already finished.', {
                                            workflowRunId: runId,
                                            message: err.message,
                                        });
                                        span?.setAttributes({
                                            ...WorkflowErrorName(errorName),
                                            ...WorkflowErrorMessage(errorMessage),
                                            ...ErrorType(errorName),
                                        });
                                        return;
                                    }
                                    else {
                                        throw err;
                                    }
                                }
                                span?.setAttributes({
                                    ...WorkflowRunStatus('failed'),
                                    ...WorkflowErrorName(errorName),
                                    ...WorkflowErrorMessage(errorMessage),
                                    ...ErrorType(errorName),
                                });
                            }
                        }
                    }); // End withThrottleRetry
                }); // End trace
            }); // End withWorkflowBaggage
        }); // End withTraceContext
    });
    return withHealthCheck(handler);
}

/**
 * Creates a {@link Hook} that can be used to suspend and resume the workflow run with a payload.
 *
 * Hooks allow external systems to send arbitrary serializable data into a workflow.
 *
 * @param options - Configuration options for the hook.
 * @returns A `Hook` that can be awaited to receive one or more payloads.
 *
 * @example
 *
 * ```ts
 * export async function workflowWithHook() {
 *   "use workflow";
 *
 *   const hook = createHook<{ message: string }>();
 *   console.log('Hook token:', hook.token);
 *
 *   const payload = await hook;
 *   console.log('Received:', payload.message);
 * }
 * ```
 */
// @ts-expect-error `options` is here for types/docs
function createHook(options) {
    throw new Error('`createHook()` can only be called inside a workflow function');
}
function createWebhook(
// @ts-expect-error `options` is here for types/docs
options) {
    throw new Error('`createWebhook()` can only be called inside a workflow function');
}

/**
 * Defines a typed hook for type-safe hook creation and resumption.
 *
 * This helper provides type safety by allowing you to define the input and output types
 * for the hook's payload, with optional validation and transformation via a schema.
 *
 * @param schema - Schema used to validate and transform the input payload before resuming
 * @returns An object with `create` and `resume` functions pre-typed with the input and output types
 *
 * @example
 *
 * ```ts
 * // Define a hook with a specific payload type
 * const approvalHook = defineHook<{ approved: boolean; comment: string }>();
 *
 * // In a workflow
 * export async function workflowWithApproval() {
 *   "use workflow";
 *
 *   const hook = approvalHook.create();
 *   const result = await hook; // Fully typed as { approved: boolean; comment: string; }
 * }
 *
 * // In an API route
 * export async function POST(request: Request) {
 *   const { token, approved, comment } = await request.json();
 *   await approvalHook.resume(token, { approved, comment }); // Input type
 *   return Response.json({ success: true });
 * }
 * ```
 */
function defineHook({ schema, } = {}) {
    return {
        create(_options) {
            throw new Error('`defineHook().create()` can only be called inside a workflow function.');
        },
        async resume(token, payload) {
            if (!schema?.['~standard']) {
                return await resumeHook(token, payload);
            }
            let result = schema['~standard'].validate(payload);
            if (result instanceof Promise) {
                result = await result;
            }
            // if the `issues` field exists, the validation failed
            if (result.issues) {
                throw new Error(JSON.stringify(result.issues, null, 2));
            }
            return await resumeHook(token, result.value);
        },
    };
}

async function sleep(param) {
    // Inside the workflow VM, the sleep function is stored in the globalThis object behind a symbol
    const sleepFn = globalThis[WORKFLOW_SLEEP];
    if (!sleepFn) {
        throw new Error('`sleep()` can only be called inside a workflow function');
    }
    return sleepFn(param);
}

/**
 * Returns metadata available in the current step function.
 * It uses `AsyncLocalStorage` to store the context and
 * retrieve it in the step function.
 */
function getStepMetadata() {
    const ctx = contextStorage.getStore();
    if (!ctx) {
        throw new Error('`getStepMetadata()` can only be called inside a step function');
    }
    return ctx.stepMetadata;
}

/**
 * Returns metadata available in the current workflow run inside a step function.
 */
function getWorkflowMetadata() {
    const ctx = contextStorage.getStore();
    if (!ctx) {
        throw new Error('`getWorkflowMetadata()` can only be called inside a workflow or step function');
    }
    return ctx.workflowMetadata;
}

/**
 * Retrieves a writable stream that is associated with the current workflow.
 *
 * The writable stream is intended to be used within step functions to write
 * data that can be read outside the workflow by using the readable method of getRun.
 *
 * @param options - Optional configuration for the writable stream
 * @returns The writable stream associated with the current workflow run
 * @throws Error if called outside a workflow or step function
 */
function getWritable(options = {}) {
    const ctx = contextStorage.getStore();
    if (!ctx) {
        throw new Error('`getWritable()` can only be called inside a workflow or step function');
    }
    const { namespace } = options;
    const runId = ctx.workflowMetadata.workflowRunId;
    const name = getWorkflowRunStreamId(runId, namespace);
    // Create a transform stream that serializes chunks and pipes to the workflow server
    const serialize = getSerializeStream(getExternalReducers(globalThis, ctx.ops, runId));
    // Pipe the serialized data to the workflow server stream
    // Register this async operation with the runtime's ops array so it's awaited via waitUntil
    ctx.ops.push(serialize.readable.pipeTo(new WorkflowServerWritableStream(name, runId)));
    // Return the writable side of the transform stream
    return serialize.writable;
}

/**
 * Just the core utilities that are meant to be imported by user
 * steps/workflows. This allows the bundler to tree-shake and limit what goes
 * into the final user bundles. Logic for running/handling steps/workflows
 * should live in runtime. Eventually these might be separate packages
 * `workflow` and `workflow/runtime`?
 *
 * Everything here will get re-exported under the 'workflow' top level package.
 * This should be a minimal set of APIs so **do not anything here** unless it's
 * needed for userland workflow code.
 */

const core_star = /*#__PURE__*/Object.freeze({
    __proto__: null,
    FatalError: FatalError,
    RetryableError: RetryableError,
    createHook: createHook,
    createWebhook: createWebhook,
    defineHook: defineHook,
    getStepMetadata: getStepMetadata,
    getWorkflowMetadata: getWorkflowMetadata,
    getWritable: getWritable,
    sleep: sleep
});

export { registerStepFunction as a, stepEntrypoint as b, core_star as c, resumeWebhook as r, start as s, workflowEntrypoint as w };
