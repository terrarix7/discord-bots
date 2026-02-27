import { c as getWorkflowPort } from './utils.mjs';
import { mkdir, access, constants, writeFile, unlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as setTimeout$1 } from 'node:timers/promises';
import { J as JsonTransport } from '../@vercel/queue.mjs';
import { l as libExports } from '../async-sema.mjs';
import { m as monotonicFactory, d as decodeTime } from '../../../_libs/ulid.mjs';
import { u as undiciExports } from '../undici.mjs';
import { z, s as string, Z as ZodError, o as object, f as array } from '../../../_libs/zod.mjs';
import { M as MessageId, V as ValidQueueName, b as HookSchema, S as SPEC_VERSION_CURRENT, c as WorkflowRunSchema, r as requiresNewerWorld, i as isLegacySpecVersion, d as StepSchema, e as WaitSchema, E as EventSchema } from './world.mjs';
import { EventEmitter } from 'node:events';
import { promises } from 'node:fs';
import { W as WorkflowAPIError, e as RunNotSupportedError, f as WorkflowRunNotFoundError } from './errors.mjs';

/**
 * Creates a lazily-evaluated, memoized version of the provided function.
 *
 * The returned object exposes a `value` getter that calls `fn` only once,
 * caches its result, and returns the cached value on subsequent accesses.
 *
 * @typeParam T - The return type of the provided function.
 * @param fn - The function to be called once and whose result will be cached.
 * @returns An object with a `value` property that returns the memoized result of `fn`.
 */
function once(fn) {
    const result = {
        get value() {
            const value = fn();
            Object.defineProperty(result, 'value', { value });
            return value;
        },
    };
    return result;
}

const getDataDirFromEnv = () => {
    return process.env.WORKFLOW_LOCAL_DATA_DIR || '.workflow-data';
};
const DEFAULT_RESOLVE_DATA_OPTION = 'all';
const getBaseUrlFromEnv = () => {
    return process.env.WORKFLOW_LOCAL_BASE_URL;
};
const config = once(() => {
    const dataDir = getDataDirFromEnv();
    const baseUrl = getBaseUrlFromEnv();
    return { dataDir, baseUrl };
});
/**
 * Resolves the base URL for queue requests following the priority order:
 * 1. config.baseUrl (highest priority - full override from args)
 * 2. WORKFLOW_LOCAL_BASE_URL env var (checked directly to handle late env var setting)
 * 3. config.port (explicit port override from args)
 * 4. PORT env var (explicit configuration)
 * 5. Auto-detected port via getPort (detect actual listening port)
 */
async function resolveBaseUrl(config) {
    if (config.baseUrl) {
        return config.baseUrl;
    }
    // Check env var directly in case it was set after the config was cached
    // This is important for CLI tools that set the env var after module import
    if (process.env.WORKFLOW_LOCAL_BASE_URL) {
        return process.env.WORKFLOW_LOCAL_BASE_URL;
    }
    if (typeof config.port === 'number') {
        return `http://localhost:${config.port}`;
    }
    if (process.env.PORT) {
        return `http://localhost:${process.env.PORT}`;
    }
    const detectedPort = await getWorkflowPort();
    if (detectedPort) {
        return `http://localhost:${detectedPort}`;
    }
    throw new Error('Unable to resolve base URL for workflow queue.');
}

/** Package name - hardcoded since it doesn't change */
const PACKAGE_NAME = '@workflow/world-local';
let cachedPackageInfo = null;
/**
 * Get the directory path for this module.
 * Works in ESM and falls back to a constant in CJS contexts (which shouldn't happen)
 */
function getModuleDir() {
    // In bundled CJS contexts, import.meta.url may be undefined or empty
    if (typeof import.meta.url === 'string' && import.meta.url) {
        return path.dirname(fileURLToPath(import.meta.url));
    }
    return null;
}
/**
 * Returns the package name and version from package.json.
 * The result is cached after the first read.
 *
 * In bundled contexts where package.json cannot be read,
 * returns 'bundled' as the version.
 */
async function getPackageInfo() {
    if (cachedPackageInfo) {
        return cachedPackageInfo;
    }
    const moduleDir = getModuleDir();
    if (moduleDir) {
        try {
            const content = await readFile(path.join(moduleDir, '../package.json'), 'utf-8');
            cachedPackageInfo = JSON.parse(content);
            return cachedPackageInfo;
        }
        catch {
            // Fall through to bundled fallback
        }
    }
    // Bundled context - package.json not accessible
    cachedPackageInfo = {
        name: PACKAGE_NAME,
        version: 'bundled',
    };
    return cachedPackageInfo;
}
/** Filename for storing version information in the data directory */
const VERSION_FILENAME = 'version.txt';
/**
 * Error thrown when the data directory cannot be accessed or created.
 */
class DataDirAccessError extends Error {
    dataDir;
    code;
    constructor(message, dataDir, code) {
        super(message);
        this.name = 'DataDirAccessError';
        this.dataDir = dataDir;
        this.code = code;
    }
}
/**
 * Error thrown when data directory version is incompatible.
 */
class DataDirVersionError extends Error {
    oldVersion;
    newVersion;
    suggestedVersion;
    constructor(message, oldVersion, newVersion, suggestedVersion) {
        super(message);
        this.name = 'DataDirVersionError';
        this.oldVersion = oldVersion;
        this.newVersion = newVersion;
        this.suggestedVersion = suggestedVersion;
    }
}
/**
 * Parses a version string into its components.
 *
 * @param versionString - Version string like "4.0.1" or "4.0.1-beta.20"
 * @returns Parsed version object with major, minor, patch, and optional prerelease
 */
function parseVersion(versionString) {
    // Match: major.minor.patch with optional prerelease
    const match = versionString.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
    if (!match) {
        throw new Error(`Invalid version string: "${versionString}"`);
    }
    return {
        major: parseInt(match[1], 10),
        minor: parseInt(match[2], 10),
        patch: parseInt(match[3], 10),
        prerelease: match[4],
        raw: versionString,
    };
}
/**
 * Formats a parsed version back to a string.
 */
function formatVersion(version) {
    const base = `${version.major}.${version.minor}.${version.patch}`;
    return version.prerelease ? `${base}-${version.prerelease}` : base;
}
/**
 * Parses the version file content to extract package name and version.
 *
 * @param content - Content like "@workflow/world-local@4.0.1-beta.20"
 * @returns Object with packageName and version
 */
function parseVersionFile(content) {
    const trimmed = content.trim();
    const lastAtIndex = trimmed.lastIndexOf('@');
    if (lastAtIndex <= 0) {
        throw new Error(`Invalid version file content: "${content}"`);
    }
    const packageName = trimmed.substring(0, lastAtIndex);
    const versionString = trimmed.substring(lastAtIndex + 1);
    return {
        packageName,
        version: parseVersion(versionString),
    };
}
/**
 * Formats the version file content.
 */
function formatVersionFile(packageName, version) {
    return `${packageName}@${formatVersion(version)}`;
}
/**
 * Handles version upgrades between old and new versions.
 * This function is called when the data directory was created with a different version.
 *
 * @param oldVersion - The version that created the data directory
 * @param newVersion - The current package version
 * @throws {DataDirVersionError} If the versions are incompatible
 */
function upgradeVersion(oldVersion, newVersion) {
    console.log(`[world-local] Upgrading from version ${formatVersion(oldVersion)} to ${formatVersion(newVersion)}`);
}
/**
 * Ensures the data directory exists and is writable.
 * Creates the directory if it doesn't exist.
 *
 * @param dataDir - The path to the data directory
 * @throws {DataDirAccessError} If the directory cannot be created or accessed
 */
async function ensureDataDir(dataDir) {
    const absolutePath = path.resolve(dataDir);
    // Try to create the directory if it doesn't exist
    try {
        await mkdir(absolutePath, { recursive: true });
    }
    catch (error) {
        const nodeError = error;
        // EEXIST is fine - directory already exists
        if (nodeError.code !== 'EEXIST') {
            throw new DataDirAccessError(`Failed to create data directory "${absolutePath}": ${nodeError.message}`, absolutePath, nodeError.code);
        }
    }
    // Verify the directory is accessible (readable)
    try {
        await access(absolutePath, constants.R_OK);
    }
    catch (error) {
        const nodeError = error;
        throw new DataDirAccessError(`Data directory "${absolutePath}" is not readable: ${nodeError.message}`, absolutePath, nodeError.code);
    }
    // Verify the directory is writable by attempting to write a temp file
    const testFile = path.join(absolutePath, `.workflow-write-test-${Date.now()}`);
    try {
        await writeFile(testFile, '');
        await unlink(testFile);
    }
    catch (error) {
        const nodeError = error;
        throw new DataDirAccessError(`Data directory "${absolutePath}" is not writable: ${nodeError.message}`, absolutePath, nodeError.code);
    }
}
/**
 * Reads the version from the data directory's version file.
 *
 * @param dataDir - Path to the data directory
 * @returns The parsed version info, or null if the file doesn't exist
 */
async function readVersionFile(dataDir) {
    const versionFilePath = path.join(path.resolve(dataDir), VERSION_FILENAME);
    try {
        const content = await readFile(versionFilePath, 'utf-8');
        return parseVersionFile(content);
    }
    catch (error) {
        const nodeError = error;
        if (nodeError.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}
/**
 * Writes the current version to the data directory's version file.
 *
 * @param dataDir - Path to the data directory
 * @param version - The version to write
 */
async function writeVersionFile(dataDir, version) {
    const versionFilePath = path.join(path.resolve(dataDir), VERSION_FILENAME);
    const packageInfo = await getPackageInfo();
    const content = formatVersionFile(packageInfo.name, version);
    await writeFile(versionFilePath, content);
}
/**
 * Gets the suggested downgrade version based on the old version.
 * If a specific version is suggested in the error, use that.
 * Otherwise, suggest the previous minor version if patch is 0,
 * or previous major version if minor is also 0.
 */
function getSuggestedDowngradeVersion(oldVersion, suggestedVersion) {
    if (suggestedVersion) {
        return suggestedVersion;
    }
    // Suggest the old version as the downgrade target
    return formatVersion(oldVersion);
}
/**
 * Initializes the data directory, ensuring it exists, is accessible,
 * and handles version compatibility.
 *
 * @param dataDir - The path to the data directory
 * @throws {DataDirAccessError} If the directory cannot be created or accessed
 */
async function initDataDir(dataDir) {
    // First ensure the directory exists and is accessible
    await ensureDataDir(dataDir);
    const packageInfo = await getPackageInfo();
    const currentVersion = parseVersion(packageInfo.version);
    // Read existing version file
    const existingVersionInfo = await readVersionFile(dataDir);
    if (existingVersionInfo === null) {
        // New data directory - write the current version
        await writeVersionFile(dataDir, currentVersion);
        return;
    }
    const { version: oldVersion } = existingVersionInfo;
    // Check if versions are the same (no upgrade needed)
    if (formatVersion(oldVersion) === formatVersion(currentVersion)) {
        return;
    }
    // Attempt upgrade
    try {
        upgradeVersion(oldVersion, currentVersion);
        // Upgrade succeeded - write the new version
        await writeVersionFile(dataDir, currentVersion);
    }
    catch (error) {
        const suggestedVersion = error instanceof DataDirVersionError ? error.suggestedVersion : undefined;
        const downgradeTarget = getSuggestedDowngradeVersion(oldVersion, suggestedVersion);
        console.error(`[world-local] Failed to upgrade data directory from version ${formatVersion(oldVersion)} to ${formatVersion(currentVersion)}:`, error instanceof Error ? error.message : error);
        console.error(`[world-local] Data is not compatible with the current version. ` +
            `Please downgrade to ${packageInfo.name}@${downgradeTarget}`);
        throw error;
    }
}

// For local queue, there is no technical limit on the message visibility lifespan,
// but the environment variable can be used for testing purposes to set a max visibility limit.
const LOCAL_QUEUE_MAX_VISIBILITY = parseInt(process.env.WORKFLOW_LOCAL_QUEUE_MAX_VISIBILITY ?? '0', 10) ||
    Infinity;
// Maximum safe delay for setTimeout in Node.js (2^31 - 1 milliseconds ≈ 24.85 days)
// Larger values cause "TimeoutOverflowWarning: X does not fit into a 32-bit signed integer"
// When the clamped timeout fires, the handler will recalculate remaining time from
// persistent state and return another timeoutSeconds if needed.
const MAX_SAFE_TIMEOUT_MS = 2147483647;
// The local workers share the same Node.js process and event loop,
// so we need to limit concurrency to avoid overwhelming the system.
const DEFAULT_CONCURRENCY_LIMIT = 1000;
const WORKFLOW_LOCAL_QUEUE_CONCURRENCY = parseInt(process.env.WORKFLOW_LOCAL_QUEUE_CONCURRENCY ?? '0', 10) ||
    DEFAULT_CONCURRENCY_LIMIT;
function createQueue(config) {
    // Create a custom agent optimized for high-concurrency local workflows:
    // - headersTimeout: 0 allows long-running steps
    // - connections: 1000 allows many parallel connections to the same host
    // - pipelining: 1 (default) for HTTP/1.1 compatibility
    // - keepAliveTimeout: 30s keeps connections warm for rapid step execution
    const httpAgent = new undiciExports.Agent({
        headersTimeout: 0,
        connections: 1000,
        keepAliveTimeout: 30_000,
    });
    const transport = new JsonTransport();
    const generateId = monotonicFactory();
    const semaphore = new libExports.Sema(WORKFLOW_LOCAL_QUEUE_CONCURRENCY);
    /**
     * holds inflight messages by idempotency key to ensure
     * that we don't queue the same message multiple times
     */
    const inflightMessages = new Map();
    const queue = async (queueName, message, opts) => {
        const cleanup = [];
        if (opts?.idempotencyKey) {
            const existing = inflightMessages.get(opts.idempotencyKey);
            if (existing) {
                return { messageId: existing };
            }
        }
        const body = transport.serialize(message);
        let pathname;
        if (queueName.startsWith('__wkf_step_')) {
            pathname = `step`;
        }
        else if (queueName.startsWith('__wkf_workflow_')) {
            pathname = `flow`;
        }
        else {
            throw new Error('Unknown queue name prefix');
        }
        const messageId = MessageId.parse(`msg_${generateId()}`);
        if (opts?.idempotencyKey) {
            const key = opts.idempotencyKey;
            inflightMessages.set(key, messageId);
            cleanup.push(() => {
                inflightMessages.delete(key);
            });
        }
        (async () => {
            const token = semaphore.tryAcquire();
            if (!token) {
                console.warn(`[world-local]: concurrency limit (${WORKFLOW_LOCAL_QUEUE_CONCURRENCY}) reached, waiting for queue to free up`);
                await semaphore.acquire();
            }
            try {
                let defaultRetriesLeft = 3;
                const baseUrl = await resolveBaseUrl(config);
                for (let attempt = 0; defaultRetriesLeft > 0; attempt++) {
                    defaultRetriesLeft--;
                    const response = await fetch(`${baseUrl}/.well-known/workflow/v1/${pathname}`, {
                        method: 'POST',
                        duplex: 'half',
                        dispatcher: httpAgent,
                        headers: {
                            ...opts?.headers,
                            'content-type': 'application/json',
                            'x-vqs-queue-name': queueName,
                            'x-vqs-message-id': messageId,
                            'x-vqs-message-attempt': String(attempt + 1),
                        },
                        body,
                    });
                    if (response.ok) {
                        return;
                    }
                    const text = await response.text();
                    if (response.status === 503) {
                        try {
                            const timeoutSeconds = Number(JSON.parse(text).timeoutSeconds);
                            // Clamp to MAX_SAFE_TIMEOUT_MS to avoid Node.js setTimeout overflow warning.
                            // When this fires early, the handler recalculates remaining time from
                            // persistent state and returns another timeoutSeconds if needed.
                            const timeoutMs = Math.min(timeoutSeconds * 1000, MAX_SAFE_TIMEOUT_MS);
                            await setTimeout$1(timeoutMs);
                            defaultRetriesLeft++;
                            continue;
                        }
                        catch { }
                    }
                    console.error(`[local world] Failed to queue message`, {
                        queueName,
                        text,
                        status: response.status,
                        headers: Object.fromEntries(response.headers.entries()),
                        body: body.toString(),
                    });
                }
                console.error(`[local world] Reached max retries of local world queue implementation`);
            }
            finally {
                semaphore.release();
            }
        })()
            .catch((err) => {
            // Silently ignore client disconnect errors (e.g., browser refresh during streaming)
            // These are expected and should not cause unhandled rejection warnings
            const isAbortError = err?.name === 'AbortError' || err?.name === 'ResponseAborted';
            if (!isAbortError) {
                console.error('[local world] Queue operation failed:', err);
            }
        })
            .finally(() => {
            for (const fn of cleanup) {
                fn();
            }
        });
        return { messageId };
    };
    const HeaderParser = z.object({
        'x-vqs-queue-name': ValidQueueName,
        'x-vqs-message-id': MessageId,
        'x-vqs-message-attempt': z.coerce.number(),
    });
    const createQueueHandler = (prefix, handler) => {
        return async (req) => {
            const headers = HeaderParser.safeParse(Object.fromEntries(req.headers));
            if (!headers.success || !req.body) {
                return Response.json({
                    error: !req.body
                        ? 'Missing request body'
                        : 'Missing required headers',
                }, { status: 400 });
            }
            const queueName = headers.data['x-vqs-queue-name'];
            const messageId = headers.data['x-vqs-message-id'];
            const attempt = headers.data['x-vqs-message-attempt'];
            if (!queueName.startsWith(prefix)) {
                return Response.json({ error: 'Unhandled queue' }, { status: 400 });
            }
            const body = await new JsonTransport().deserialize(req.body);
            try {
                const result = await handler(body, { attempt, queueName, messageId });
                let timeoutSeconds = null;
                if (typeof result?.timeoutSeconds === 'number') {
                    timeoutSeconds = Math.min(result.timeoutSeconds, LOCAL_QUEUE_MAX_VISIBILITY);
                }
                if (timeoutSeconds) {
                    return Response.json({ timeoutSeconds }, { status: 503 });
                }
                return Response.json({ ok: true });
            }
            catch (error) {
                return Response.json(String(error), { status: 500 });
            }
        };
    };
    const getDeploymentId = async () => {
        const packageInfo = await getPackageInfo();
        return `dpl_local@${packageInfo.version}`;
    };
    return {
        queue,
        createQueueHandler,
        getDeploymentId,
        async close() {
            await httpAgent.close();
        },
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
// Standard OTEL conventions for peer service mapping
function SemanticConvention(...names) {
    return (value) => Object.fromEntries(names.map((name) => [name, value]));
}
/** The remote service name for Datadog service maps (Datadog-specific: peer.service) */
const PeerService = SemanticConvention('peer.service');
/** RPC system identifier (standard OTEL: rpc.system) */
const RpcSystem = SemanticConvention('rpc.system');
/** RPC service name (standard OTEL: rpc.service) */
const RpcService = SemanticConvention('rpc.service');
/** RPC method name (standard OTEL: rpc.method) */
const RpcMethod = SemanticConvention('rpc.method');

/**
 * Utility to instrument object methods with tracing.
 * This mirrors world-vercel's implementation for consistent observability.
 */
/** Configuration for peer service attribution */
const WORLD_LOCAL_SERVICE = {
    peerService: 'world-local',
    rpcSystem: 'local',
    rpcService: 'world-local',
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
                return trace(spanName, { kind: await getSpanKind('INTERNAL') }, async (span) => {
                    // Add peer service attributes for service maps
                    // Use spanName for rpc.method so Datadog shows event type in resource
                    span?.setAttributes({
                        ...PeerService(WORLD_LOCAL_SERVICE.peerService),
                        ...RpcSystem(WORLD_LOCAL_SERVICE.rpcSystem),
                        ...RpcService(WORLD_LOCAL_SERVICE.rpcService),
                        ...RpcMethod(spanName),
                    });
                    return f(...args);
                });
            };
        }
    }
    return handlers;
}

const ulid = monotonicFactory(() => Math.random());
const Ulid = string().ulid();
const isWindows = process.platform === 'win32';
/**
 * Execute a filesystem operation with retry logic on Windows.
 * On Windows, file operations can fail with EPERM/EBUSY/EACCES when files
 * are briefly locked by another process or antivirus. This wrapper adds
 * exponential backoff retry logic. On non-Windows platforms, executes directly.
 */
async function withWindowsRetry(fn, maxRetries = 5) {
    if (!isWindows)
        return fn();
    const retryableErrors = ['EPERM', 'EBUSY', 'EACCES'];
    const baseDelayMs = 10;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        }
        catch (error) {
            const isRetryable = attempt < maxRetries && retryableErrors.includes(error.code);
            if (!isRetryable)
                throw error;
            // Exponential backoff with jitter
            const delay = baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs;
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
    // TypeScript: unreachable, but satisfies return type
    throw new Error('Retry loop exited unexpectedly');
}
// In-memory cache of created files to avoid expensive fs.access() calls
// This is safe because we only write once per file path (no overwrites without explicit flag)
const createdFilesCache = new Set();
function ulidToDate(maybeUlid) {
    const ulid = Ulid.safeParse(maybeUlid);
    if (!ulid.success) {
        return null;
    }
    return new Date(decodeTime(ulid.data));
}
async function ensureDir(dirPath) {
    try {
        await promises.mkdir(dirPath, { recursive: true });
    }
    catch (_error) {
        // Ignore if already exists
    }
}
/**
 * Custom JSON replacer that encodes Uint8Array as base64 strings.
 * Format: { __type: 'Uint8Array', data: '<base64>' }
 */
function jsonReplacer(_key, value) {
    if (value instanceof Uint8Array) {
        return {
            __type: 'Uint8Array',
            data: Buffer.from(value).toString('base64'),
        };
    }
    return value;
}
/**
 * Custom JSON reviver that decodes base64 strings back to Uint8Array.
 */
function jsonReviver(_key, value) {
    if (value !== null &&
        typeof value === 'object' &&
        value.__type === 'Uint8Array' &&
        typeof value.data === 'string') {
        return new Uint8Array(Buffer.from(value.data, 'base64'));
    }
    return value;
}
async function writeJSON(filePath, data, opts) {
    return write(filePath, JSON.stringify(data, jsonReplacer, 2), opts);
}
/**
 * Writes data to a file using atomic write-rename pattern.
 *
 * Note: While this function uses temp files to avoid partial writes,
 * it does not provide protection against concurrent writes from multiple
 * processes. In a multi-writer scenario, the last writer wins.
 * For production use with multiple writers, consider using a proper
 * database or locking mechanism.
 */
async function write(filePath, data, opts) {
    if (!opts?.overwrite) {
        // Fast path: check in-memory cache first to avoid expensive fs.access() calls
        // This provides significant performance improvement when creating many files
        if (createdFilesCache.has(filePath)) {
            throw new WorkflowAPIError(`File ${filePath} already exists and 'overwrite' is false`, { status: 409 });
        }
        // Slow path: check filesystem for files created before this process started
        try {
            await promises.access(filePath);
            // File exists on disk, add to cache for future checks
            createdFilesCache.add(filePath);
            throw new WorkflowAPIError(`File ${filePath} already exists and 'overwrite' is false`, { status: 409 });
        }
        catch (error) {
            // If file doesn't exist (ENOENT), continue with write
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
    }
    const tempPath = `${filePath}.tmp.${ulid()}`;
    let tempFileCreated = false;
    try {
        await ensureDir(path.dirname(filePath));
        await promises.writeFile(tempPath, data);
        tempFileCreated = true;
        await withWindowsRetry(() => promises.rename(tempPath, filePath));
        // Track this file in cache so future writes know it exists
        createdFilesCache.add(filePath);
    }
    catch (error) {
        // Only try to clean up temp file if it was actually created
        if (tempFileCreated) {
            await withWindowsRetry(() => promises.unlink(tempPath), 3).catch(() => { });
        }
        throw error;
    }
}
async function readJSON(filePath, decoder) {
    try {
        const content = await promises.readFile(filePath, 'utf-8');
        return decoder.parse(JSON.parse(content, jsonReviver));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
async function readBuffer(filePath) {
    const content = await promises.readFile(filePath);
    return content;
}
async function deleteJSON(filePath) {
    try {
        await promises.unlink(filePath);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
}
async function listJSONFiles(dirPath) {
    return listFilesByExtension(dirPath, '.json');
}
async function listFilesByExtension(dirPath, extension) {
    try {
        const files = await promises.readdir(dirPath);
        return files
            .filter((f) => f.endsWith(extension))
            .map((f) => f.slice(0, -extension.length));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw error;
    }
}
function parseCursor(cursor) {
    if (!cursor)
        return null;
    const parts = cursor.split('|');
    return {
        timestamp: new Date(parts[0]),
        id: parts[1] || null,
    };
}
function createCursor(timestamp, id) {
    return id ? `${timestamp.toISOString()}|${id}` : timestamp.toISOString();
}
async function paginatedFileSystemQuery(config) {
    const { directory, schema, filePrefix, filter, sortOrder = 'desc', limit = 20, cursor, getCreatedAt, getId, } = config;
    // 1. Get all JSON files in directory
    const fileIds = await listJSONFiles(directory);
    // 2. Filter by prefix if provided
    const relevantFileIds = filePrefix
        ? fileIds.filter((fileId) => fileId.startsWith(filePrefix))
        : fileIds;
    // 3. ULID Optimization: Filter by cursor using filename timestamps before loading JSON
    const parsedCursor = parseCursor(cursor);
    let candidateFileIds = relevantFileIds;
    if (parsedCursor) {
        candidateFileIds = relevantFileIds.filter((fileId) => {
            const filenameDate = getCreatedAt(`${fileId}.json`);
            if (filenameDate) {
                // Use filename timestamp for cursor filtering
                // We need to be careful here: if parsedCursor has an ID (for tie-breaking),
                // we need to include items with the same timestamp for later ID-based filtering.
                // If no ID, we can use strict inequality for optimization.
                const cursorTime = parsedCursor.timestamp.getTime();
                const fileTime = filenameDate.getTime();
                if (parsedCursor.id) {
                    // Tie-breaking mode: include items at or near cursor timestamp
                    return sortOrder === 'desc'
                        ? fileTime <= cursorTime
                        : fileTime >= cursorTime;
                }
                else {
                    // No tie-breaking: strict inequality
                    return sortOrder === 'desc'
                        ? fileTime < cursorTime
                        : fileTime > cursorTime;
                }
            }
            // Can't extract timestamp from filename (e.g., steps use sequential IDs).
            // Include the file and defer to JSON-based filtering below.
            return true;
        });
    }
    // 4. Load files individually and collect valid items
    const validItems = [];
    for (const fileId of candidateFileIds) {
        const filePath = path.join(directory, `${fileId}.json`);
        let item = null;
        try {
            item = await readJSON(filePath, schema);
        }
        catch (error) {
            // We don't expect zod errors to happen, but if the JSON does get malformed,
            // we skip the item. Preferably, we'd have a way to mark items as malformed,
            // so that the UI can display them as such, with richer messaging. In the meantime,
            // we just log a warning and skip the item.
            if (error instanceof ZodError) {
                console.warn(`Skipping item ${fileId} due to malformed JSON: ${error.message}`);
                continue;
            }
            throw error;
        }
        if (item) {
            // Apply custom filter early if provided
            if (filter && !filter(item))
                continue;
            // Double-check cursor filtering with actual createdAt from JSON
            // (in case ULID timestamp differs from stored createdAt)
            if (parsedCursor) {
                const itemTime = item.createdAt.getTime();
                const cursorTime = parsedCursor.timestamp.getTime();
                if (sortOrder === 'desc') {
                    // For descending order, skip items >= cursor
                    if (itemTime > cursorTime)
                        continue;
                    // If timestamps are equal, use ID for tie-breaking (skip if ID >= cursorId)
                    if (itemTime === cursorTime && parsedCursor.id && getId) {
                        const itemId = getId(item);
                        if (itemId >= parsedCursor.id)
                            continue;
                    }
                }
                else {
                    // For ascending order, skip items <= cursor
                    if (itemTime < cursorTime)
                        continue;
                    // If timestamps are equal, use ID for tie-breaking (skip if ID <= cursorId)
                    if (itemTime === cursorTime && parsedCursor.id && getId) {
                        const itemId = getId(item);
                        if (itemId <= parsedCursor.id)
                            continue;
                    }
                }
            }
            validItems.push(item);
        }
    }
    // 5. Sort by createdAt (and by ID for tie-breaking if getId is provided)
    validItems.sort((a, b) => {
        const aTime = a.createdAt.getTime();
        const bTime = b.createdAt.getTime();
        const timeComparison = sortOrder === 'asc' ? aTime - bTime : bTime - aTime;
        // If timestamps are equal and we have getId, use ID for stable sorting
        if (timeComparison === 0 && getId) {
            const aId = getId(a);
            const bId = getId(b);
            return sortOrder === 'asc'
                ? aId.localeCompare(bId)
                : bId.localeCompare(aId);
        }
        return timeComparison;
    });
    // 6. Apply pagination
    const hasMore = validItems.length > limit;
    const items = hasMore ? validItems.slice(0, limit) : validItems;
    const nextCursor = items.length > 0
        ? createCursor(items[items.length - 1].createdAt, getId?.(items[items.length - 1]))
        : null;
    return {
        data: items,
        cursor: nextCursor,
        hasMore,
    };
}

function filterRunData(run, resolveData) {
    if (resolveData === 'none') {
        return {
            ...run,
            input: undefined,
            output: undefined,
        };
    }
    return run;
}
function filterStepData(step, resolveData) {
    if (resolveData === 'none') {
        return {
            ...step,
            input: undefined,
            output: undefined,
        };
    }
    return step;
}
/**
 * Filter event data based on resolveData setting.
 * When resolveData is 'none', strips eventData to reduce payload size.
 */
function filterEventData(event, resolveData) {
    if (resolveData === 'none') {
        const { eventData: _eventData, ...rest } = event;
        return rest;
    }
    return event;
}
/**
 * Filter hook data based on resolveData setting.
 * When resolveData is 'none', strips metadata to reduce payload size.
 */
function filterHookData(hook, resolveData) {
    if (resolveData === 'none') {
        const { metadata: _metadata, ...rest } = hook;
        return rest;
    }
    return hook;
}

/**
 * Create a monotonic ULID factory that ensures ULIDs are always increasing
 * even when generated within the same millisecond.
 */
const monotonicUlid$1 = monotonicFactory(() => Math.random());
/**
 * Creates a function to extract createdAt date from a filename based on ULID.
 * Used for efficient pagination without reading file contents.
 *
 * @param idPrefix - The prefix to strip from filenames (e.g., 'wrun', 'evnt', 'step')
 * @returns A function that extracts Date from filename, or null if not extractable
 */
const getObjectCreatedAt = (idPrefix) => (filename) => {
    const replaceRegex = new RegExp(`^${idPrefix}_`, 'g');
    const dashIndex = filename.indexOf('-');
    if (dashIndex === -1) {
        // No dash - extract ULID from the filename (e.g., wrun_ULID.json, evnt_ULID.json)
        const ulid = filename.replace(/\.json$/, '').replace(replaceRegex, '');
        return ulidToDate(ulid);
    }
    // For composite keys like {runId}-{stepId}, extract from the appropriate part
    if (idPrefix === 'step') {
        // Steps use sequential IDs (step_0, step_1, etc.) - no timestamp in filename.
        // Return null to skip filename-based optimization and defer to JSON-based filtering.
        return null;
    }
    // For events: wrun_ULID-evnt_ULID.json - extract from the eventId part
    const id = filename.substring(dashIndex + 1).replace(/\.json$/, '');
    const ulid = id.replace(replaceRegex, '');
    return ulidToDate(ulid);
};

/**
 * Creates a hooks storage implementation using the filesystem.
 * Implements the Storage['hooks'] interface with hook CRUD operations.
 */
function createHooksStorage(basedir) {
    // Helper function to find a hook by token (shared between getByToken)
    async function findHookByToken(token) {
        const hooksDir = path.join(basedir, 'hooks');
        const files = await listJSONFiles(hooksDir);
        for (const file of files) {
            const hookPath = path.join(hooksDir, `${file}.json`);
            const hook = await readJSON(hookPath, HookSchema);
            if (hook && hook.token === token) {
                return hook;
            }
        }
        return null;
    }
    async function get(hookId, params) {
        const hookPath = path.join(basedir, 'hooks', `${hookId}.json`);
        const hook = await readJSON(hookPath, HookSchema);
        if (!hook) {
            throw new Error(`Hook ${hookId} not found`);
        }
        const resolveData = params?.resolveData || DEFAULT_RESOLVE_DATA_OPTION;
        return filterHookData(hook, resolveData);
    }
    async function getByToken(token) {
        const hook = await findHookByToken(token);
        if (!hook) {
            throw new Error(`Hook with token ${token} not found`);
        }
        return hook;
    }
    async function list(params) {
        const hooksDir = path.join(basedir, 'hooks');
        const resolveData = params.resolveData || DEFAULT_RESOLVE_DATA_OPTION;
        const result = await paginatedFileSystemQuery({
            directory: hooksDir,
            schema: HookSchema,
            sortOrder: params.pagination?.sortOrder,
            limit: params.pagination?.limit,
            cursor: params.pagination?.cursor,
            filePrefix: undefined, // Hooks don't have ULIDs, so we can't optimize by filename
            filter: (hook) => {
                // Filter by runId if provided
                if (params.runId && hook.runId !== params.runId) {
                    return false;
                }
                return true;
            },
            getCreatedAt: () => {
                // Hook files don't have ULID timestamps in filename
                // We need to read the file to get createdAt, but that's inefficient
                // So we return the hook's createdAt directly (item.createdAt will be used for sorting)
                // Return a dummy date to pass the null check, actual sorting uses item.createdAt
                return new Date(0);
            },
            getId: (hook) => hook.hookId,
        });
        // Transform the data after pagination
        return {
            ...result,
            data: result.data.map((hook) => filterHookData(hook, resolveData)),
        };
    }
    return { get, getByToken, list };
}
/**
 * Helper function to delete all hooks associated with a workflow run.
 * Called when a run reaches a terminal state.
 */
async function deleteAllHooksForRun(basedir, runId) {
    const hooksDir = path.join(basedir, 'hooks');
    const files = await listJSONFiles(hooksDir);
    for (const file of files) {
        const hookPath = path.join(hooksDir, `${file}.json`);
        const hook = await readJSON(hookPath, HookSchema);
        if (hook && hook.runId === runId) {
            await deleteJSON(hookPath);
        }
    }
}

/**
 * Handle events for legacy runs (pre-event-sourcing, specVersion < 2).
 * Legacy runs use different behavior:
 * - run_cancelled: Skip event storage, directly update run
 * - wait_completed: Store event only (no entity mutation)
 * - hook_received: Store event only (hooks exist via old system, no entity mutation)
 * - Other events: Throw error (not supported for legacy runs)
 */
async function handleLegacyEvent(basedir, runId, data, currentRun, params) {
    const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
    switch (data.eventType) {
        case 'run_cancelled': {
            // Legacy: Skip event storage, directly update run to cancelled
            const now = new Date();
            const run = {
                runId: currentRun.runId,
                deploymentId: currentRun.deploymentId,
                workflowName: currentRun.workflowName,
                specVersion: currentRun.specVersion,
                executionContext: currentRun.executionContext,
                input: currentRun.input,
                createdAt: currentRun.createdAt,
                expiredAt: currentRun.expiredAt,
                startedAt: currentRun.startedAt,
                status: 'cancelled',
                output: undefined,
                error: undefined,
                completedAt: now,
                updatedAt: now,
            };
            const runPath = path.join(basedir, 'runs', `${runId}.json`);
            await writeJSON(runPath, run, { overwrite: true });
            await deleteAllHooksForRun(basedir, runId);
            // Return without event (legacy behavior skips event storage)
            // Type assertion: EventResult expects WorkflowRun, filterRunData may return WorkflowRunWithoutData
            return {
                event: undefined,
                run: filterRunData(run, resolveData),
            };
        }
        case 'wait_completed':
        case 'hook_received': {
            // Legacy: Store event only (no entity mutation)
            // - wait_completed: for replay purposes
            // - hook_received: hooks exist via old system, just record the event
            const eventId = `evnt_${monotonicUlid$1()}`;
            const now = new Date();
            const event = {
                ...data,
                runId,
                eventId,
                createdAt: now,
                specVersion: SPEC_VERSION_CURRENT,
            };
            const compositeKey = `${runId}-${eventId}`;
            const eventPath = path.join(basedir, 'events', `${compositeKey}.json`);
            await writeJSON(eventPath, event);
            return { event: filterEventData(event, resolveData) };
        }
        default:
            throw new Error(`Event type '${data.eventType}' not supported for legacy runs ` +
                `(specVersion: ${currentRun.specVersion || 'undefined'}). ` +
                `Please upgrade 'workflow' package.`);
    }
}

/**
 * Helper function to delete all waits associated with a workflow run.
 * Called when a run reaches a terminal state.
 */
async function deleteAllWaitsForRun(basedir, runId) {
    const waitsDir = path.join(basedir, 'waits');
    const files = await listJSONFiles(waitsDir);
    for (const file of files) {
        if (file.startsWith(`${runId}-`)) {
            const waitPath = path.join(waitsDir, `${file}.json`);
            await deleteJSON(waitPath);
        }
    }
}
/**
 * Creates the events storage implementation using the filesystem.
 * Implements the Storage['events'] interface with create, list, and listByCorrelationId operations.
 */
function createEventsStorage(basedir) {
    return {
        async create(runId, data, params) {
            const eventId = `evnt_${monotonicUlid$1()}`;
            const now = new Date();
            // For run_created events, use client-provided runId or generate one server-side
            let effectiveRunId;
            if (data.eventType === 'run_created' && (!runId || runId === '')) {
                effectiveRunId = `wrun_${monotonicUlid$1()}`;
            }
            else if (!runId) {
                throw new Error('runId is required for non-run_created events');
            }
            else {
                effectiveRunId = runId;
            }
            // specVersion is always sent by the runtime, but we provide a fallback for safety
            const effectiveSpecVersion = data.specVersion ?? SPEC_VERSION_CURRENT;
            // Helper to check if run is in terminal state
            const isRunTerminal = (status) => ['completed', 'failed', 'cancelled'].includes(status);
            // Helper to check if step is in terminal state
            const isStepTerminal = (status) => ['completed', 'failed'].includes(status);
            // Get current run state for validation (if not creating a new run)
            // Skip run validation for step_completed and step_retrying - they only operate
            // on running steps, and running steps are always allowed to modify regardless
            // of run state. This optimization saves filesystem reads per step event.
            let currentRun = null;
            const skipRunValidationEvents = ['step_completed', 'step_retrying'];
            if (data.eventType !== 'run_created' &&
                !skipRunValidationEvents.includes(data.eventType)) {
                const runPath = path.join(basedir, 'runs', `${effectiveRunId}.json`);
                currentRun = await readJSON(runPath, WorkflowRunSchema);
            }
            // ============================================================
            // VERSION COMPATIBILITY: Check run spec version
            // ============================================================
            // For events that have fetched the run, check version compatibility.
            // Skip for run_created (no existing run) and runtime events (step_completed, step_retrying).
            if (currentRun) {
                // Check if run requires a newer world version
                if (requiresNewerWorld(currentRun.specVersion)) {
                    throw new RunNotSupportedError(currentRun.specVersion, SPEC_VERSION_CURRENT);
                }
                // Route to legacy handler for pre-event-sourcing runs
                if (isLegacySpecVersion(currentRun.specVersion)) {
                    return handleLegacyEvent(basedir, effectiveRunId, data, currentRun, params);
                }
            }
            // ============================================================
            // VALIDATION: Terminal state and event ordering checks
            // ============================================================
            // Run terminal state validation
            if (currentRun && isRunTerminal(currentRun.status)) {
                const runTerminalEvents = [
                    'run_started',
                    'run_completed',
                    'run_failed',
                ];
                // Idempotent operation: run_cancelled on already cancelled run is allowed
                if (data.eventType === 'run_cancelled' &&
                    currentRun.status === 'cancelled') {
                    // Return existing state (idempotent)
                    const event = {
                        ...data,
                        runId: effectiveRunId,
                        eventId,
                        createdAt: now,
                        specVersion: effectiveSpecVersion,
                    };
                    const compositeKey = `${effectiveRunId}-${eventId}`;
                    const eventPath = path.join(basedir, 'events', `${compositeKey}.json`);
                    await writeJSON(eventPath, event);
                    const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
                    return {
                        event: filterEventData(event, resolveData),
                        run: currentRun,
                    };
                }
                // Run state transitions are not allowed on terminal runs
                if (runTerminalEvents.includes(data.eventType) ||
                    data.eventType === 'run_cancelled') {
                    throw new WorkflowAPIError(`Cannot transition run from terminal state "${currentRun.status}"`, { status: 409 });
                }
                // Creating new entities on terminal runs is not allowed
                if (data.eventType === 'step_created' ||
                    data.eventType === 'hook_created' ||
                    data.eventType === 'wait_created') {
                    throw new WorkflowAPIError(`Cannot create new entities on run in terminal state "${currentRun.status}"`, { status: 409 });
                }
            }
            // Step-related event validation (ordering and terminal state)
            // Store existingStep so we can reuse it later (avoid double read)
            let validatedStep = null;
            const stepEvents = [
                'step_started',
                'step_completed',
                'step_failed',
                'step_retrying',
            ];
            if (stepEvents.includes(data.eventType) && data.correlationId) {
                const stepCompositeKey = `${effectiveRunId}-${data.correlationId}`;
                const stepPath = path.join(basedir, 'steps', `${stepCompositeKey}.json`);
                validatedStep = await readJSON(stepPath, StepSchema);
                // Event ordering: step must exist before these events
                if (!validatedStep) {
                    throw new WorkflowAPIError(`Step "${data.correlationId}" not found`, {
                        status: 404,
                    });
                }
                // Step terminal state validation
                if (isStepTerminal(validatedStep.status)) {
                    throw new WorkflowAPIError(`Cannot modify step in terminal state "${validatedStep.status}"`, { status: 409 });
                }
                // On terminal runs: only allow completing/failing in-progress steps
                if (currentRun && isRunTerminal(currentRun.status)) {
                    if (validatedStep.status !== 'running') {
                        throw new WorkflowAPIError(`Cannot modify non-running step on run in terminal state "${currentRun.status}"`, { status: 410 });
                    }
                }
            }
            // Hook-related event validation (ordering)
            const hookEventsRequiringExistence = ['hook_disposed', 'hook_received'];
            if (hookEventsRequiringExistence.includes(data.eventType) &&
                data.correlationId) {
                const hookPath = path.join(basedir, 'hooks', `${data.correlationId}.json`);
                const existingHook = await readJSON(hookPath, HookSchema);
                if (!existingHook) {
                    throw new WorkflowAPIError(`Hook "${data.correlationId}" not found`, {
                        status: 404,
                    });
                }
            }
            const event = {
                ...data,
                runId: effectiveRunId,
                eventId,
                createdAt: now,
                specVersion: effectiveSpecVersion,
            };
            // Track entity created/updated for EventResult
            let run;
            let step;
            let hook;
            let wait;
            // Create/update entity based on event type (event-sourced architecture)
            // Run lifecycle events
            if (data.eventType === 'run_created' && 'eventData' in data) {
                const runData = data.eventData;
                run = {
                    runId: effectiveRunId,
                    deploymentId: runData.deploymentId,
                    status: 'pending',
                    workflowName: runData.workflowName,
                    // Propagate specVersion from the event to the run entity
                    specVersion: effectiveSpecVersion,
                    executionContext: runData.executionContext,
                    input: runData.input,
                    output: undefined,
                    error: undefined,
                    startedAt: undefined,
                    completedAt: undefined,
                    createdAt: now,
                    updatedAt: now,
                };
                const runPath = path.join(basedir, 'runs', `${effectiveRunId}.json`);
                await writeJSON(runPath, run);
            }
            else if (data.eventType === 'run_started') {
                // Reuse currentRun from validation (already read above)
                if (currentRun) {
                    const runPath = path.join(basedir, 'runs', `${effectiveRunId}.json`);
                    run = {
                        runId: currentRun.runId,
                        deploymentId: currentRun.deploymentId,
                        workflowName: currentRun.workflowName,
                        specVersion: currentRun.specVersion,
                        executionContext: currentRun.executionContext,
                        input: currentRun.input,
                        createdAt: currentRun.createdAt,
                        expiredAt: currentRun.expiredAt,
                        status: 'running',
                        output: undefined,
                        error: undefined,
                        completedAt: undefined,
                        startedAt: currentRun.startedAt ?? now,
                        updatedAt: now,
                    };
                    await writeJSON(runPath, run, { overwrite: true });
                }
            }
            else if (data.eventType === 'run_completed' && 'eventData' in data) {
                const completedData = data.eventData;
                // Reuse currentRun from validation (already read above)
                if (currentRun) {
                    const runPath = path.join(basedir, 'runs', `${effectiveRunId}.json`);
                    run = {
                        runId: currentRun.runId,
                        deploymentId: currentRun.deploymentId,
                        workflowName: currentRun.workflowName,
                        specVersion: currentRun.specVersion,
                        executionContext: currentRun.executionContext,
                        input: currentRun.input,
                        createdAt: currentRun.createdAt,
                        expiredAt: currentRun.expiredAt,
                        startedAt: currentRun.startedAt,
                        status: 'completed',
                        output: completedData.output,
                        error: undefined,
                        completedAt: now,
                        updatedAt: now,
                    };
                    await writeJSON(runPath, run, { overwrite: true });
                    await Promise.all([
                        deleteAllHooksForRun(basedir, effectiveRunId),
                        deleteAllWaitsForRun(basedir, effectiveRunId),
                    ]);
                }
            }
            else if (data.eventType === 'run_failed' && 'eventData' in data) {
                const failedData = data.eventData;
                // Reuse currentRun from validation (already read above)
                if (currentRun) {
                    const runPath = path.join(basedir, 'runs', `${effectiveRunId}.json`);
                    run = {
                        runId: currentRun.runId,
                        deploymentId: currentRun.deploymentId,
                        workflowName: currentRun.workflowName,
                        specVersion: currentRun.specVersion,
                        executionContext: currentRun.executionContext,
                        input: currentRun.input,
                        createdAt: currentRun.createdAt,
                        expiredAt: currentRun.expiredAt,
                        startedAt: currentRun.startedAt,
                        status: 'failed',
                        output: undefined,
                        error: {
                            message: typeof failedData.error === 'string'
                                ? failedData.error
                                : (failedData.error?.message ?? 'Unknown error'),
                            stack: failedData.error?.stack,
                            code: failedData.errorCode,
                        },
                        completedAt: now,
                        updatedAt: now,
                    };
                    await writeJSON(runPath, run, { overwrite: true });
                    await Promise.all([
                        deleteAllHooksForRun(basedir, effectiveRunId),
                        deleteAllWaitsForRun(basedir, effectiveRunId),
                    ]);
                }
            }
            else if (data.eventType === 'run_cancelled') {
                // Reuse currentRun from validation (already read above)
                if (currentRun) {
                    const runPath = path.join(basedir, 'runs', `${effectiveRunId}.json`);
                    run = {
                        runId: currentRun.runId,
                        deploymentId: currentRun.deploymentId,
                        workflowName: currentRun.workflowName,
                        specVersion: currentRun.specVersion,
                        executionContext: currentRun.executionContext,
                        input: currentRun.input,
                        createdAt: currentRun.createdAt,
                        expiredAt: currentRun.expiredAt,
                        startedAt: currentRun.startedAt,
                        status: 'cancelled',
                        output: undefined,
                        error: undefined,
                        completedAt: now,
                        updatedAt: now,
                    };
                    await writeJSON(runPath, run, { overwrite: true });
                    await Promise.all([
                        deleteAllHooksForRun(basedir, effectiveRunId),
                        deleteAllWaitsForRun(basedir, effectiveRunId),
                    ]);
                }
            }
            else if (
            // Step lifecycle events
            data.eventType === 'step_created' &&
                'eventData' in data) {
                // step_created: Creates step entity with status 'pending', attempt=0, createdAt set
                const stepData = data.eventData;
                step = {
                    runId: effectiveRunId,
                    stepId: data.correlationId,
                    stepName: stepData.stepName,
                    status: 'pending',
                    input: stepData.input,
                    output: undefined,
                    error: undefined,
                    attempt: 0,
                    startedAt: undefined,
                    completedAt: undefined,
                    createdAt: now,
                    updatedAt: now,
                    // Propagate specVersion from the event to the step entity
                    specVersion: effectiveSpecVersion,
                };
                const stepCompositeKey = `${effectiveRunId}-${data.correlationId}`;
                const stepPath = path.join(basedir, 'steps', `${stepCompositeKey}.json`);
                await writeJSON(stepPath, step);
            }
            else if (data.eventType === 'step_started') {
                // step_started: Increments attempt, sets status to 'running'
                // Sets startedAt only on the first start (not updated on retries)
                // Reuse validatedStep from validation (already read above)
                if (validatedStep) {
                    // Check if retryAfter timestamp hasn't been reached yet
                    if (validatedStep.retryAfter &&
                        validatedStep.retryAfter.getTime() > Date.now()) {
                        const err = new WorkflowAPIError(`Cannot start step "${data.correlationId}": retryAfter timestamp has not been reached yet`, { status: 425 });
                        // Add meta for step-handler to extract retryAfter timestamp
                        err.meta = {
                            stepId: data.correlationId,
                            retryAfter: validatedStep.retryAfter.toISOString(),
                        };
                        throw err;
                    }
                    const stepCompositeKey = `${effectiveRunId}-${data.correlationId}`;
                    const stepPath = path.join(basedir, 'steps', `${stepCompositeKey}.json`);
                    step = {
                        ...validatedStep,
                        status: 'running',
                        // Only set startedAt on the first start
                        startedAt: validatedStep.startedAt ?? now,
                        // Increment attempt counter on every start
                        attempt: validatedStep.attempt + 1,
                        // Clear retryAfter now that the step has started
                        retryAfter: undefined,
                        updatedAt: now,
                    };
                    await writeJSON(stepPath, step, { overwrite: true });
                }
            }
            else if (data.eventType === 'step_completed' && 'eventData' in data) {
                // step_completed: Terminal state with output
                // Reuse validatedStep from validation (already read above)
                const completedData = data.eventData;
                if (validatedStep) {
                    const stepCompositeKey = `${effectiveRunId}-${data.correlationId}`;
                    const stepPath = path.join(basedir, 'steps', `${stepCompositeKey}.json`);
                    step = {
                        ...validatedStep,
                        status: 'completed',
                        output: completedData.result,
                        completedAt: now,
                        updatedAt: now,
                    };
                    await writeJSON(stepPath, step, { overwrite: true });
                }
            }
            else if (data.eventType === 'step_failed' && 'eventData' in data) {
                // step_failed: Terminal state with error
                // Reuse validatedStep from validation (already read above)
                const failedData = data.eventData;
                if (validatedStep) {
                    const stepCompositeKey = `${effectiveRunId}-${data.correlationId}`;
                    const stepPath = path.join(basedir, 'steps', `${stepCompositeKey}.json`);
                    const error = {
                        message: typeof failedData.error === 'string'
                            ? failedData.error
                            : (failedData.error?.message ?? 'Unknown error'),
                        stack: failedData.stack,
                    };
                    step = {
                        ...validatedStep,
                        status: 'failed',
                        error,
                        completedAt: now,
                        updatedAt: now,
                    };
                    await writeJSON(stepPath, step, { overwrite: true });
                }
            }
            else if (data.eventType === 'step_retrying' && 'eventData' in data) {
                // step_retrying: Sets status back to 'pending', records error
                // Reuse validatedStep from validation (already read above)
                const retryData = data.eventData;
                if (validatedStep) {
                    const stepCompositeKey = `${effectiveRunId}-${data.correlationId}`;
                    const stepPath = path.join(basedir, 'steps', `${stepCompositeKey}.json`);
                    step = {
                        ...validatedStep,
                        status: 'pending',
                        error: {
                            message: typeof retryData.error === 'string'
                                ? retryData.error
                                : (retryData.error?.message ?? 'Unknown error'),
                            stack: retryData.stack,
                        },
                        retryAfter: retryData.retryAfter,
                        updatedAt: now,
                    };
                    await writeJSON(stepPath, step, { overwrite: true });
                }
            }
            else if (
            // Hook lifecycle events
            data.eventType === 'hook_created' &&
                'eventData' in data) {
                const hookData = data.eventData;
                // Check for duplicate token before creating hook
                const hooksDir = path.join(basedir, 'hooks');
                const hookFiles = await listJSONFiles(hooksDir);
                let hasConflict = false;
                for (const file of hookFiles) {
                    const existingHookPath = path.join(hooksDir, `${file}.json`);
                    const existingHook = await readJSON(existingHookPath, HookSchema);
                    if (existingHook && existingHook.token === hookData.token) {
                        hasConflict = true;
                        break;
                    }
                }
                if (hasConflict) {
                    // Create hook_conflict event instead of hook_created
                    // This allows the workflow to continue and fail gracefully when the hook is awaited
                    const conflictEvent = {
                        eventType: 'hook_conflict',
                        correlationId: data.correlationId,
                        eventData: {
                            token: hookData.token,
                        },
                        runId: effectiveRunId,
                        eventId,
                        createdAt: now,
                        specVersion: effectiveSpecVersion,
                    };
                    // Store the conflict event
                    const compositeKey = `${effectiveRunId}-${eventId}`;
                    const eventPath = path.join(basedir, 'events', `${compositeKey}.json`);
                    await writeJSON(eventPath, conflictEvent);
                    const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
                    const filteredEvent = filterEventData(conflictEvent, resolveData);
                    // Return EventResult with conflict event (no hook entity created)
                    return {
                        event: filteredEvent,
                        run,
                        step,
                        hook: undefined,
                    };
                }
                hook = {
                    runId: effectiveRunId,
                    hookId: data.correlationId,
                    token: hookData.token,
                    metadata: hookData.metadata,
                    ownerId: 'local-owner',
                    projectId: 'local-project',
                    environment: 'local',
                    createdAt: now,
                    // Propagate specVersion from the event to the hook entity
                    specVersion: effectiveSpecVersion,
                };
                const hookPath = path.join(basedir, 'hooks', `${data.correlationId}.json`);
                await writeJSON(hookPath, hook);
            }
            else if (data.eventType === 'hook_disposed') {
                // Delete the hook when disposed
                const hookPath = path.join(basedir, 'hooks', `${data.correlationId}.json`);
                await deleteJSON(hookPath);
            }
            else if (data.eventType === 'wait_created' && 'eventData' in data) {
                // wait_created: Creates wait entity with status 'waiting'
                const waitData = data.eventData;
                const waitCompositeKey = `${effectiveRunId}-${data.correlationId}`;
                const waitPath = path.join(basedir, 'waits', `${waitCompositeKey}.json`);
                const existingWait = await readJSON(waitPath, WaitSchema);
                if (existingWait) {
                    throw new WorkflowAPIError(`Wait "${data.correlationId}" already exists`, { status: 409 });
                }
                wait = {
                    waitId: waitCompositeKey,
                    runId: effectiveRunId,
                    status: 'waiting',
                    resumeAt: waitData.resumeAt,
                    completedAt: undefined,
                    createdAt: now,
                    updatedAt: now,
                    specVersion: effectiveSpecVersion,
                };
                await writeJSON(waitPath, wait);
            }
            else if (data.eventType === 'wait_completed') {
                // wait_completed: Transitions wait to 'completed', rejects duplicates
                const waitCompositeKey = `${effectiveRunId}-${data.correlationId}`;
                const waitPath = path.join(basedir, 'waits', `${waitCompositeKey}.json`);
                const existingWait = await readJSON(waitPath, WaitSchema);
                if (!existingWait) {
                    throw new WorkflowAPIError(`Wait "${data.correlationId}" not found`, {
                        status: 404,
                    });
                }
                if (existingWait.status === 'completed') {
                    throw new WorkflowAPIError(`Wait "${data.correlationId}" already completed`, { status: 409 });
                }
                wait = {
                    ...existingWait,
                    status: 'completed',
                    completedAt: now,
                    updatedAt: now,
                };
                await writeJSON(waitPath, wait, { overwrite: true });
            }
            // Note: hook_received events are stored in the event log but don't
            // modify the Hook entity (which doesn't have a payload field)
            // Store event using composite key {runId}-{eventId}
            const compositeKey = `${effectiveRunId}-${eventId}`;
            const eventPath = path.join(basedir, 'events', `${compositeKey}.json`);
            await writeJSON(eventPath, event);
            const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
            const filteredEvent = filterEventData(event, resolveData);
            // Return EventResult with event and any created/updated entity
            return {
                event: filteredEvent,
                run,
                step,
                hook,
                wait,
            };
        },
        async list(params) {
            const { runId } = params;
            const resolveData = params.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
            const result = await paginatedFileSystemQuery({
                directory: path.join(basedir, 'events'),
                schema: EventSchema,
                filePrefix: `${runId}-`,
                // Events in chronological order (oldest first) by default,
                // different from the default for other list calls.
                sortOrder: params.pagination?.sortOrder ?? 'asc',
                limit: params.pagination?.limit,
                cursor: params.pagination?.cursor,
                getCreatedAt: getObjectCreatedAt('evnt'),
                getId: (event) => event.eventId,
            });
            // If resolveData is "none", remove eventData from events
            if (resolveData === 'none') {
                return {
                    ...result,
                    data: result.data.map((event) => {
                        const { eventData: _eventData, ...rest } = event;
                        return rest;
                    }),
                };
            }
            return result;
        },
        async listByCorrelationId(params) {
            const correlationId = params.correlationId;
            const resolveData = params.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
            const result = await paginatedFileSystemQuery({
                directory: path.join(basedir, 'events'),
                schema: EventSchema,
                // No filePrefix - search all events
                filter: (event) => event.correlationId === correlationId,
                // Events in chronological order (oldest first) by default,
                // different from the default for other list calls.
                sortOrder: params.pagination?.sortOrder ?? 'asc',
                limit: params.pagination?.limit,
                cursor: params.pagination?.cursor,
                getCreatedAt: getObjectCreatedAt('evnt'),
                getId: (event) => event.eventId,
            });
            // If resolveData is "none", remove eventData from events
            if (resolveData === 'none') {
                return {
                    ...result,
                    data: result.data.map((event) => {
                        const { eventData: _eventData, ...rest } = event;
                        return rest;
                    }),
                };
            }
            return result;
        },
    };
}

/**
 * Creates the runs storage implementation using the filesystem.
 * Implements the Storage['runs'] interface with get and list operations.
 */
function createRunsStorage(basedir) {
    return {
        get: (async (id, params) => {
            const runPath = path.join(basedir, 'runs', `${id}.json`);
            const run = await readJSON(runPath, WorkflowRunSchema);
            if (!run) {
                throw new WorkflowRunNotFoundError(id);
            }
            const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
            return filterRunData(run, resolveData);
        }),
        list: (async (params) => {
            const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
            const result = await paginatedFileSystemQuery({
                directory: path.join(basedir, 'runs'),
                schema: WorkflowRunSchema,
                filter: (run) => {
                    if (params?.workflowName &&
                        run.workflowName !== params.workflowName) {
                        return false;
                    }
                    if (params?.status && run.status !== params.status) {
                        return false;
                    }
                    return true;
                },
                sortOrder: params?.pagination?.sortOrder ?? 'desc',
                limit: params?.pagination?.limit,
                cursor: params?.pagination?.cursor,
                getCreatedAt: getObjectCreatedAt('wrun'),
                getId: (run) => run.runId,
            });
            // If resolveData is "none", replace input/output with undefined
            if (resolveData === 'none') {
                return {
                    ...result,
                    data: result.data.map((run) => ({
                        ...run,
                        input: undefined,
                        output: undefined,
                    })),
                };
            }
            return result;
        }),
    };
}

/**
 * Creates the steps storage implementation using the filesystem.
 * Implements the Storage['steps'] interface with get and list operations.
 */
function createStepsStorage(basedir) {
    return {
        get: (async (runId, stepId, params) => {
            if (!runId) {
                const fileIds = await listJSONFiles(path.join(basedir, 'steps'));
                const fileId = fileIds.find((fileId) => fileId.endsWith(`-${stepId}`));
                if (!fileId) {
                    throw new Error(`Step ${stepId} not found`);
                }
                runId = fileId.split('-')[0];
            }
            const compositeKey = `${runId}-${stepId}`;
            const stepPath = path.join(basedir, 'steps', `${compositeKey}.json`);
            const step = await readJSON(stepPath, StepSchema);
            if (!step) {
                throw new Error(`Step ${stepId} in run ${runId} not found`);
            }
            const resolveData = params?.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
            return filterStepData(step, resolveData);
        }),
        list: (async (params) => {
            const resolveData = params.resolveData ?? DEFAULT_RESOLVE_DATA_OPTION;
            const result = await paginatedFileSystemQuery({
                directory: path.join(basedir, 'steps'),
                schema: StepSchema,
                filePrefix: `${params.runId}-`,
                sortOrder: params.pagination?.sortOrder ?? 'desc',
                limit: params.pagination?.limit,
                cursor: params.pagination?.cursor,
                getCreatedAt: getObjectCreatedAt('step'),
                getId: (step) => step.stepId,
            });
            // If resolveData is "none", replace input/output with undefined
            if (resolveData === 'none') {
                return {
                    ...result,
                    data: result.data.map((step) => ({
                        ...step,
                        input: undefined,
                        output: undefined,
                    })),
                };
            }
            return result;
        }),
    };
}

/**
 * Creates a complete storage implementation using the filesystem.
 * This is the main entry point that composes all storage implementations.
 *
 * All storage methods are instrumented with tracing spans for observability.
 *
 * @param basedir - The base directory for storing workflow data
 * @returns A complete Storage implementation with tracing
 */
function createStorage(basedir) {
    // Create raw storage implementations
    const storage = {
        runs: createRunsStorage(basedir),
        steps: createStepsStorage(basedir),
        events: createEventsStorage(basedir),
        hooks: createHooksStorage(basedir),
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

// Create a monotonic ULID factory that ensures ULIDs are always increasing
// even when generated within the same millisecond
const monotonicUlid = monotonicFactory(() => Math.random());
// Schema for the run-to-streams mapping file
const RunStreamsSchema = object({
    streams: array(string()),
});
function serializeChunk(chunk) {
    const eofByte = Buffer.from([chunk.eof ? 1 : 0]);
    return Buffer.concat([eofByte, chunk.chunk]);
}
function deserializeChunk(serialized) {
    const eof = serialized[0] === 1;
    // Create a copy instead of a view to prevent ArrayBuffer detachment
    const chunk = Buffer.from(serialized.subarray(1));
    return { eof, chunk };
}
function createStreamer(basedir) {
    const streamEmitter = new EventEmitter();
    // Track which streams have already been registered for a run (in-memory cache)
    const registeredStreams = new Set();
    // Helper to record the runId <> streamId association
    async function registerStreamForRun(runId, streamName) {
        const cacheKey = `${runId}:${streamName}`;
        if (registeredStreams.has(cacheKey)) {
            return; // Already registered in this session
        }
        const runStreamsPath = path.join(basedir, 'streams', 'runs', `${runId}.json`);
        // Read existing streams for this run
        const existing = await readJSON(runStreamsPath, RunStreamsSchema);
        const streams = existing?.streams ?? [];
        // Add stream if not already present
        if (!streams.includes(streamName)) {
            streams.push(streamName);
            await writeJSON(runStreamsPath, { streams }, { overwrite: true });
        }
        registeredStreams.add(cacheKey);
    }
    // Helper to convert a chunk to a Buffer
    function toBuffer(chunk) {
        if (typeof chunk === 'string') {
            return Buffer.from(new TextEncoder().encode(chunk));
        }
        else if (chunk instanceof Buffer) {
            return chunk;
        }
        else {
            return Buffer.from(chunk);
        }
    }
    return {
        async writeToStream(name, _runId, chunk) {
            // Generate ULID synchronously BEFORE any await to preserve call order.
            // This ensures that chunks written in sequence maintain their order even
            // when runId is a promise that multiple writes are waiting on.
            const chunkId = `chnk_${monotonicUlid()}`;
            // Await runId if it's a promise to ensure proper flushing
            const runId = await _runId;
            // Register this stream for the run
            await registerStreamForRun(runId, name);
            // Convert chunk to buffer for serialization
            const chunkBuffer = toBuffer(chunk);
            const serialized = serializeChunk({
                chunk: chunkBuffer,
                eof: false,
            });
            const chunkPath = path.join(basedir, 'streams', 'chunks', `${name}-${chunkId}.bin`);
            await write(chunkPath, serialized);
            // Emit real-time event with Uint8Array (create copy to prevent ArrayBuffer detachment)
            const chunkData = Uint8Array.from(chunkBuffer);
            streamEmitter.emit(`chunk:${name}`, {
                streamName: name,
                chunkData,
                chunkId,
            });
        },
        async writeToStreamMulti(name, _runId, chunks) {
            if (chunks.length === 0)
                return;
            // Generate all ULIDs synchronously BEFORE any await to preserve call order.
            // This ensures that chunks maintain their order even when runId is a promise.
            const chunkIds = chunks.map(() => `chnk_${monotonicUlid()}`);
            // Await runId if it's a promise
            const runId = await _runId;
            // Register this stream for the run
            await registerStreamForRun(runId, name);
            // Prepare chunk data for parallel writes
            const chunkBuffers = chunks.map((chunk) => toBuffer(chunk));
            // Write all chunks in parallel for efficiency, but track individual completion
            const writePromises = chunkBuffers.map(async (chunkBuffer, i) => {
                const chunkId = chunkIds[i];
                const serialized = serializeChunk({
                    chunk: chunkBuffer,
                    eof: false,
                });
                const chunkPath = path.join(basedir, 'streams', 'chunks', `${name}-${chunkId}.bin`);
                await write(chunkPath, serialized);
                // Return data needed for event emission
                return {
                    chunkId,
                    chunkData: Uint8Array.from(chunkBuffer),
                };
            });
            // Emit events in order, waiting for each chunk's write to complete
            // This ensures events are emitted in order while writes happen in parallel
            for (const writePromise of writePromises) {
                const { chunkId, chunkData } = await writePromise;
                streamEmitter.emit(`chunk:${name}`, {
                    streamName: name,
                    chunkData,
                    chunkId,
                });
            }
        },
        async closeStream(name, _runId) {
            // Generate ULID synchronously BEFORE any await to preserve call order.
            const chunkId = `chnk_${monotonicUlid()}`;
            // Await runId if it's a promise to ensure proper flushing
            const runId = await _runId;
            // Register this stream for the run (in case writeToStream wasn't called)
            await registerStreamForRun(runId, name);
            const chunkPath = path.join(basedir, 'streams', 'chunks', `${name}-${chunkId}.bin`);
            await write(chunkPath, serializeChunk({ chunk: Buffer.from([]), eof: true }));
            streamEmitter.emit(`close:${name}`, { streamName: name });
        },
        async listStreamsByRunId(runId) {
            const runStreamsPath = path.join(basedir, 'streams', 'runs', `${runId}.json`);
            const data = await readJSON(runStreamsPath, RunStreamsSchema);
            return data?.streams ?? [];
        },
        async readFromStream(name, startIndex = 0) {
            const chunksDir = path.join(basedir, 'streams', 'chunks');
            let removeListeners = () => { };
            return new ReadableStream({
                async start(controller) {
                    // Track chunks delivered via events to prevent duplicates and maintain order.
                    const deliveredChunkIds = new Set();
                    // Buffer for chunks that arrive via events during disk reading
                    const bufferedEventChunks = [];
                    let isReadingFromDisk = true;
                    // Buffer close event if it arrives during disk reading
                    let pendingClose = false;
                    const chunkListener = (event) => {
                        deliveredChunkIds.add(event.chunkId);
                        // Skip empty chunks to maintain consistency with disk reading behavior
                        // Empty chunks are not enqueued when read from disk (see line 184-186)
                        if (event.chunkData.byteLength === 0) {
                            return;
                        }
                        if (isReadingFromDisk) {
                            // Buffer chunks that arrive during disk reading to maintain order
                            // Create a copy to prevent ArrayBuffer detachment when enqueued later
                            bufferedEventChunks.push({
                                chunkId: event.chunkId,
                                chunkData: Uint8Array.from(event.chunkData),
                            });
                        }
                        else {
                            // After disk reading is complete, deliver chunks immediately
                            // Create a copy to prevent ArrayBuffer detachment
                            controller.enqueue(Uint8Array.from(event.chunkData));
                        }
                    };
                    const closeListener = () => {
                        // Buffer close event if disk reading is still in progress
                        if (isReadingFromDisk) {
                            pendingClose = true;
                            return;
                        }
                        // Remove listeners before closing
                        streamEmitter.off(`chunk:${name}`, chunkListener);
                        streamEmitter.off(`close:${name}`, closeListener);
                        try {
                            controller.close();
                        }
                        catch {
                            // Ignore if controller is already closed (e.g., from cancel() or EOF)
                        }
                    };
                    removeListeners = closeListener;
                    // Set up listeners FIRST to avoid missing events
                    streamEmitter.on(`chunk:${name}`, chunkListener);
                    streamEmitter.on(`close:${name}`, closeListener);
                    // Now load existing chunks from disk.
                    // List both .bin (current) and .json (legacy) chunk files for
                    // backwards compatibility with streams written before this change.
                    const [binFiles, jsonFiles] = await Promise.all([
                        listFilesByExtension(chunksDir, '.bin'),
                        listFilesByExtension(chunksDir, '.json'),
                    ]);
                    const fileExtMap = new Map();
                    for (const f of jsonFiles)
                        fileExtMap.set(f, '.json');
                    for (const f of binFiles)
                        fileExtMap.set(f, '.bin'); // .bin takes precedence
                    const chunkFiles = [...fileExtMap.keys()]
                        .filter((file) => file.startsWith(`${name}-`))
                        .sort(); // ULID lexicographic sort = chronological order
                    // Process existing chunks, skipping any already delivered via events
                    let isComplete = false;
                    for (let i = startIndex; i < chunkFiles.length; i++) {
                        const file = chunkFiles[i];
                        // Extract chunk ID from filename: "streamName-chunkId"
                        const chunkId = file.substring(name.length + 1);
                        // Skip if already delivered via event
                        if (deliveredChunkIds.has(chunkId)) {
                            continue;
                        }
                        const ext = fileExtMap.get(file) ?? '.bin';
                        const chunk = deserializeChunk(await readBuffer(path.join(chunksDir, `${file}${ext}`)));
                        if (chunk?.eof === true) {
                            isComplete = true;
                            break;
                        }
                        if (chunk.chunk.byteLength) {
                            // Create a copy to prevent ArrayBuffer detachment
                            controller.enqueue(Uint8Array.from(chunk.chunk));
                        }
                    }
                    // Finished reading from disk - now deliver buffered event chunks in chronological order
                    isReadingFromDisk = false;
                    // Sort buffered chunks by ULID (chronological order)
                    bufferedEventChunks.sort((a, b) => a.chunkId.localeCompare(b.chunkId));
                    for (const buffered of bufferedEventChunks) {
                        // Create a copy for defense in depth (already copied at storage, but be extra safe)
                        controller.enqueue(Uint8Array.from(buffered.chunkData));
                    }
                    if (isComplete) {
                        removeListeners();
                        try {
                            controller.close();
                        }
                        catch {
                            // Ignore if controller is already closed (e.g., from closeListener event)
                        }
                        return;
                    }
                    // Process any pending close event that arrived during disk reading
                    if (pendingClose) {
                        streamEmitter.off(`chunk:${name}`, chunkListener);
                        streamEmitter.off(`close:${name}`, closeListener);
                        try {
                            controller.close();
                        }
                        catch {
                            // Ignore if controller is already closed
                        }
                    }
                },
                cancel() {
                    removeListeners();
                },
            });
        },
    };
}

/**
 * Creates a local world instance that combines queue, storage, and streamer functionalities.
 *
 * @param args - Optional configuration object
 * @param args.dataDir - Directory for storing workflow data (default: `.workflow-data/`)
 * @param args.port - Port override for queue transport (default: auto-detected)
 * @param args.baseUrl - Full base URL override for queue transport (default: `http://localhost:{port}`)
 * @throws {DataDirAccessError} If the data directory cannot be created or accessed
 * @throws {DataDirVersionError} If the data directory version is incompatible
 */
function createLocalWorld(args) {
    const definedArgs = args
        ? Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined))
        : {};
    const mergedConfig = { ...config.value, ...definedArgs };
    const queue = createQueue(mergedConfig);
    return {
        ...queue,
        ...createStorage(mergedConfig.dataDir),
        ...createStreamer(mergedConfig.dataDir),
        async start() {
            await initDataDir(mergedConfig.dataDir);
        },
        async close() {
            await queue.close();
        },
    };
}

export { createLocalWorld as c };
