import { p as parseDurationToDate } from './utils.mjs';

const BASE_URL = 'https://useworkflow.dev/err';
/**
 * @internal
 * Check if a value is an Error without relying on Node.js utilities.
 * This is needed for error classes that can be used in VM contexts where
 * Node.js imports are not available.
 */
function isError(value) {
    return (typeof value === 'object' &&
        value !== null &&
        'name' in value &&
        'message' in value);
}
/**
 * @internal
 * All the slugs of the errors used for documentation links.
 */
const ERROR_SLUGS = {
    WEBHOOK_INVALID_RESPOND_WITH_VALUE: 'webhook-invalid-respond-with-value',
    WEBHOOK_RESPONSE_NOT_SENT: 'webhook-response-not-sent',
    FETCH_IN_WORKFLOW_FUNCTION: 'fetch-in-workflow',
    TIMEOUT_FUNCTIONS_IN_WORKFLOW: 'timeout-in-workflow',
    HOOK_CONFLICT: 'hook-conflict',
    CORRUPTED_EVENT_LOG: 'corrupted-event-log',
};
/**
 * The base class for all Workflow-related errors.
 *
 * This error is thrown by the Workflow DevKit when internal operations fail.
 * You can use this class with `instanceof` to catch any Workflow DevKit error.
 *
 * @example
 * ```ts
 * try {
 *   await getRun(runId);
 * } catch (error) {
 *   if (error instanceof WorkflowError) {
 *     console.error('Workflow DevKit error:', error.message);
 *   }
 * }
 * ```
 */
class WorkflowError extends Error {
    cause;
    constructor(message, options) {
        const msgDocs = options?.slug
            ? `${message}\n\nLearn more: ${BASE_URL}/${options.slug}`
            : message;
        super(msgDocs, { cause: options?.cause });
        this.cause = options?.cause;
        if (options?.cause instanceof Error) {
            this.stack = `${this.stack}\nCaused by: ${options.cause.stack}`;
        }
    }
    static is(value) {
        return isError(value) && value.name === 'WorkflowError';
    }
}
/**
 * Thrown when a Workflow API request fails.
 *
 * This error is thrown when HTTP requests to the Workflow backend fail,
 * typically due to network issues, invalid requests, or server errors.
 *
 * @example
 * ```ts
 * try {
 *   await startWorkflow('myWorkflow', input);
 * } catch (error) {
 *   if (error instanceof WorkflowAPIError) {
 *     console.error(`API error (${error.status}):`, error.message);
 *   }
 * }
 * ```
 */
class WorkflowAPIError extends WorkflowError {
    status;
    code;
    url;
    /** Retry-After value in seconds, present on 429 responses */
    retryAfter;
    constructor(message, options) {
        super(message, {
            cause: options?.cause,
        });
        this.name = 'WorkflowAPIError';
        this.status = options?.status;
        this.code = options?.code;
        this.url = options?.url;
        this.retryAfter = options?.retryAfter;
    }
    static is(value) {
        return isError(value) && value.name === 'WorkflowAPIError';
    }
}
/**
 * Thrown when a workflow run fails during execution.
 *
 * This error indicates that the workflow encountered a fatal error
 * and cannot continue. The `cause` property contains the underlying
 * error with its message, stack trace, and optional error code.
 *
 * @example
 * ```
 * const run = await getRun(runId);
 * if (run.status === 'failed') {
 *   // WorkflowRunFailedError will be thrown
 * }
 * ```
 */
class WorkflowRunFailedError extends WorkflowError {
    runId;
    constructor(runId, error) {
        // Create a proper Error instance from the StructuredError to set as cause
        // NOTE: custom error types do not get serialized/deserialized. Everything is an Error
        const causeError = new Error(error.message);
        if (error.stack) {
            causeError.stack = error.stack;
        }
        if (error.code) {
            causeError.code = error.code;
        }
        super(`Workflow run "${runId}" failed: ${error.message}`, {
            cause: causeError,
        });
        this.name = 'WorkflowRunFailedError';
        this.runId = runId;
    }
    static is(value) {
        return isError(value) && value.name === 'WorkflowRunFailedError';
    }
}
/**
 * Thrown when attempting to get results from an incomplete workflow run.
 *
 * This error occurs when you try to access the result of a workflow
 * that is still running or hasn't completed yet.
 */
class WorkflowRunNotCompletedError extends WorkflowError {
    runId;
    status;
    constructor(runId, status) {
        super(`Workflow run "${runId}" has not completed`, {});
        this.name = 'WorkflowRunNotCompletedError';
        this.runId = runId;
        this.status = status;
    }
    static is(value) {
        return isError(value) && value.name === 'WorkflowRunNotCompletedError';
    }
}
/**
 * Thrown when the Workflow runtime encounters an internal error.
 *
 * This error indicates an issue with workflow execution, such as
 * serialization failures, starting an invalid workflow function, or
 * other runtime problems.
 */
class WorkflowRuntimeError extends WorkflowError {
    constructor(message, options) {
        super(message, {
            ...options,
        });
        this.name = 'WorkflowRuntimeError';
    }
    static is(value) {
        return isError(value) && value.name === 'WorkflowRuntimeError';
    }
}
class WorkflowRunNotFoundError extends WorkflowError {
    runId;
    constructor(runId) {
        super(`Workflow run "${runId}" not found`, {});
        this.name = 'WorkflowRunNotFoundError';
        this.runId = runId;
    }
    static is(value) {
        return isError(value) && value.name === 'WorkflowRunNotFoundError';
    }
}
class WorkflowRunCancelledError extends WorkflowError {
    runId;
    constructor(runId) {
        super(`Workflow run "${runId}" cancelled`, {});
        this.name = 'WorkflowRunCancelledError';
        this.runId = runId;
    }
    static is(value) {
        return isError(value) && value.name === 'WorkflowRunCancelledError';
    }
}
/**
 * Thrown when attempting to operate on a workflow run that requires a newer World version.
 *
 * This error occurs when a run was created with a newer spec version than the
 * current World implementation supports. Users should upgrade their @workflow packages.
 */
class RunNotSupportedError extends WorkflowError {
    runSpecVersion;
    worldSpecVersion;
    constructor(runSpecVersion, worldSpecVersion) {
        super(`Run requires spec version ${runSpecVersion}, but world supports version ${worldSpecVersion}. ` +
            `Please upgrade 'workflow' package.`);
        this.name = 'RunNotSupportedError';
        this.runSpecVersion = runSpecVersion;
        this.worldSpecVersion = worldSpecVersion;
    }
    static is(value) {
        return isError(value) && value.name === 'RunNotSupportedError';
    }
}
/**
 * A fatal error is an error that cannot be retried.
 * It will cause the step to fail and the error will
 * be bubbled up to the workflow logic.
 */
class FatalError extends Error {
    fatal = true;
    constructor(message) {
        super(message);
        this.name = 'FatalError';
    }
    static is(value) {
        return isError(value) && value.name === 'FatalError';
    }
}
/**
 * An error that can happen during a step execution, allowing
 * for configuration of the retry behavior.
 */
class RetryableError extends Error {
    /**
     * The Date when the step should be retried.
     */
    retryAfter;
    constructor(message, options = {}) {
        super(message);
        this.name = 'RetryableError';
        if (options.retryAfter !== undefined) {
            this.retryAfter = parseDurationToDate(options.retryAfter);
        }
        else {
            // Default to 1 second (1000 milliseconds)
            this.retryAfter = new Date(Date.now() + 1000);
        }
    }
    static is(value) {
        return isError(value) && value.name === 'RetryableError';
    }
}

export { ERROR_SLUGS as E, FatalError as F, RetryableError as R, WorkflowAPIError as W, WorkflowRuntimeError as a, WorkflowRunCancelledError as b, WorkflowRunFailedError as c, WorkflowRunNotCompletedError as d, RunNotSupportedError as e, WorkflowRunNotFoundError as f };
