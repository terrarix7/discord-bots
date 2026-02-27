import { u as union, _ as _instanceof, a as any, o as object, n as number, d as date, s as string, b as discriminatedUnion, r as record, l as literal, c as _enum, t as templateLiteral, e as boolean, f as array, g as lazy, h as _null, i as _undefined } from '../../../_libs/zod.mjs';

/**
 * Zod schema for validating SerializedData (Uint8Array).
 * Used for specVersion >= 2.
 */
const BinarySerializedDataSchema = _instanceof(Uint8Array);
/**
 * Legacy schema for serialized data (specVersion 1).
 * Legacy data was stored as JSON, so it can be any value.
 */
const LegacySerializedDataSchemaV1 = any();
/**
 * Union schema that accepts both v2+ (Uint8Array) and legacy (any) serialized data.
 * Use this for validation when data may come from either specVersion.
 */
const SerializedDataSchema = union([
    BinarySerializedDataSchema,
    LegacySerializedDataSchemaV1,
]);

// Event type enum
const EventTypeSchema = _enum([
    // Run lifecycle events
    'run_created',
    'run_started',
    'run_completed',
    'run_failed',
    'run_cancelled',
    // Step lifecycle events
    'step_created',
    'step_completed',
    'step_failed',
    'step_retrying',
    'step_started',
    // Hook lifecycle events
    'hook_created',
    'hook_received',
    'hook_disposed',
    'hook_conflict', // Created by world when hook token already exists
    // Wait lifecycle events
    'wait_created',
    'wait_completed',
]);
// Base event schema with common properties
// TODO: Event data on all specific event schemas can actually be undefined,
// as the world may omit eventData when resolveData is set to 'none'.
// Changing the type here will mainly improve type safety for o11y consumers.
// Note: specVersion is optional for backwards compatibility with legacy data in storage,
// but is always sent by the runtime on new events.
const BaseEventSchema = object({
    eventType: EventTypeSchema,
    correlationId: string().optional(),
    specVersion: number().optional(),
});
// Event schemas (shared between creation requests and server responses)
// Note: Serialized data fields use SerializedDataSchema to support both:
// - specVersion >= 2: Uint8Array (binary devalue format)
// - specVersion 1: any (legacy JSON format)
const StepCompletedEventSchema = BaseEventSchema.extend({
    eventType: literal('step_completed'),
    correlationId: string(),
    eventData: object({
        result: SerializedDataSchema,
    }),
});
const StepFailedEventSchema = BaseEventSchema.extend({
    eventType: literal('step_failed'),
    correlationId: string(),
    eventData: object({
        error: any(),
        stack: string().optional(),
    }),
});
/**
 * Event created when a step fails and will be retried.
 * Sets the step status back to 'pending' and records the error.
 * The error is stored in step.error for debugging.
 */
const StepRetryingEventSchema = BaseEventSchema.extend({
    eventType: literal('step_retrying'),
    correlationId: string(),
    eventData: object({
        error: any(),
        stack: string().optional(),
        retryAfter: date().optional(),
    }),
});
const StepStartedEventSchema = BaseEventSchema.extend({
    eventType: literal('step_started'),
    correlationId: string(),
    eventData: object({
        attempt: number().optional(),
    })
        .optional(),
});
/**
 * Event created when a step is first invoked. The World implementation
 * atomically creates both the event and the step entity.
 */
const StepCreatedEventSchema = BaseEventSchema.extend({
    eventType: literal('step_created'),
    correlationId: string(),
    eventData: object({
        stepName: string(),
        input: SerializedDataSchema,
    }),
});
/**
 * Event created when a hook is first invoked. The World implementation
 * atomically creates both the event and the hook entity.
 */
const HookCreatedEventSchema = BaseEventSchema.extend({
    eventType: literal('hook_created'),
    correlationId: string(),
    eventData: object({
        token: string(),
        metadata: SerializedDataSchema.optional(),
    }),
});
const HookReceivedEventSchema = BaseEventSchema.extend({
    eventType: literal('hook_received'),
    correlationId: string(),
    eventData: object({
        payload: SerializedDataSchema,
    }),
});
const HookDisposedEventSchema = BaseEventSchema.extend({
    eventType: literal('hook_disposed'),
    correlationId: string(),
});
/**
 * Event created by World implementations when a hook_created request
 * conflicts with an existing hook token. This event is NOT user-creatable -
 * it is only returned by the World when a token conflict is detected.
 *
 * When the hook consumer sees this event, it should reject any awaited
 * promises with a HookTokenConflictError.
 */
const HookConflictEventSchema = BaseEventSchema.extend({
    eventType: literal('hook_conflict'),
    correlationId: string(),
    eventData: object({
        token: string(),
    }),
});
const WaitCreatedEventSchema = BaseEventSchema.extend({
    eventType: literal('wait_created'),
    correlationId: string(),
    eventData: object({
        resumeAt: date(),
    }),
});
const WaitCompletedEventSchema = BaseEventSchema.extend({
    eventType: literal('wait_completed'),
    correlationId: string(),
});
// =============================================================================
// Run lifecycle events
// =============================================================================
/**
 * Event created when a workflow run is first created. The World implementation
 * atomically creates both the event and the run entity with status 'pending'.
 */
const RunCreatedEventSchema = BaseEventSchema.extend({
    eventType: literal('run_created'),
    eventData: object({
        deploymentId: string(),
        workflowName: string(),
        input: SerializedDataSchema,
        executionContext: record(string(), any()).optional(),
    }),
});
/**
 * Event created when a workflow run starts executing.
 * Updates the run entity to status 'running'.
 */
const RunStartedEventSchema = BaseEventSchema.extend({
    eventType: literal('run_started'),
});
/**
 * Event created when a workflow run completes successfully.
 * Updates the run entity to status 'completed' with output.
 */
const RunCompletedEventSchema = BaseEventSchema.extend({
    eventType: literal('run_completed'),
    eventData: object({
        output: SerializedDataSchema.optional(),
    }),
});
/**
 * Event created when a workflow run fails.
 * Updates the run entity to status 'failed' with error.
 */
const RunFailedEventSchema = BaseEventSchema.extend({
    eventType: literal('run_failed'),
    eventData: object({
        error: any(),
        errorCode: string().optional(),
    }),
});
/**
 * Event created when a workflow run is cancelled.
 * Updates the run entity to status 'cancelled'.
 */
const RunCancelledEventSchema = BaseEventSchema.extend({
    eventType: literal('run_cancelled'),
});
// Discriminated union for user-creatable events (requests to world.events.create)
// Note: hook_conflict is NOT included here - it can only be created by World implementations
discriminatedUnion('eventType', [
    // Run lifecycle events
    RunCreatedEventSchema,
    RunStartedEventSchema,
    RunCompletedEventSchema,
    RunFailedEventSchema,
    RunCancelledEventSchema,
    // Step lifecycle events
    StepCreatedEventSchema,
    StepCompletedEventSchema,
    StepFailedEventSchema,
    StepRetryingEventSchema,
    StepStartedEventSchema,
    // Hook lifecycle events
    HookCreatedEventSchema,
    HookReceivedEventSchema,
    HookDisposedEventSchema,
    // Wait lifecycle events
    WaitCreatedEventSchema,
    WaitCompletedEventSchema,
]);
// Discriminated union for ALL events (includes World-only events like hook_conflict)
// This is used for reading events from the event log
const AllEventsSchema = discriminatedUnion('eventType', [
    // Run lifecycle events
    RunCreatedEventSchema,
    RunStartedEventSchema,
    RunCompletedEventSchema,
    RunFailedEventSchema,
    RunCancelledEventSchema,
    // Step lifecycle events
    StepCreatedEventSchema,
    StepCompletedEventSchema,
    StepFailedEventSchema,
    StepRetryingEventSchema,
    StepStartedEventSchema,
    // Hook lifecycle events
    HookCreatedEventSchema,
    HookReceivedEventSchema,
    HookDisposedEventSchema,
    HookConflictEventSchema, // World-only: created when hook token conflicts
    // Wait lifecycle events
    WaitCreatedEventSchema,
    WaitCompletedEventSchema,
]);
// Server response includes runId, eventId, and createdAt
// specVersion is optional in database for backwards compatibility
const EventSchema = AllEventsSchema.and(object({
    runId: string(),
    eventId: string(),
    createdAt: date(),
    specVersion: number().optional(),
}));

/**
 * Schema for workflow hooks.
 *
 * Note: metadata uses SerializedDataSchema to support both:
 * - specVersion >= 2: Uint8Array (binary devalue format)
 * - specVersion 1: any (legacy JSON format)
 */
// Hook schemas
const HookSchema = object({
    runId: string(),
    hookId: string(),
    token: string(),
    ownerId: string(),
    projectId: string(),
    environment: string(),
    metadata: SerializedDataSchema.optional(),
    createdAt: date(),
    // Optional in database for backwards compatibility, defaults to 1 (legacy) when reading
    specVersion: number().optional(),
});

const QueuePrefix = union([
    literal('__wkf_step_'),
    literal('__wkf_workflow_'),
]);
const ValidQueueName = templateLiteral([QueuePrefix, string()]);
const MessageId = string()
    .brand()
    .describe('A stored queue message ID');
/**
 * OpenTelemetry trace context for distributed tracing
 */
const TraceCarrierSchema = record(string(), string());
const WorkflowInvokePayloadSchema = object({
    runId: string(),
    traceCarrier: TraceCarrierSchema.optional(),
    requestedAt: date().optional(),
    /** Number of times this message has been re-enqueued due to server errors (5xx) */
    serverErrorRetryCount: number().int().optional(),
});
const StepInvokePayloadSchema = object({
    workflowName: string(),
    workflowRunId: string(),
    workflowStartedAt: number(),
    stepId: string(),
    traceCarrier: TraceCarrierSchema.optional(),
    requestedAt: date().optional(),
});
/**
 * Health check payload - used to verify that the queue pipeline
 * can deliver messages to workflow/step endpoints.
 */
const HealthCheckPayloadSchema = object({
    __healthCheck: literal(true),
    correlationId: string(),
});
const QueuePayloadSchema = union([
    WorkflowInvokePayloadSchema,
    StepInvokePayloadSchema,
    HealthCheckPayloadSchema,
]);

const zodJsonSchema = lazy(() => {
    return union([
        string(),
        number(),
        boolean(),
        _null(),
        array(zodJsonSchema),
        record(string(), zodJsonSchema),
    ]);
});
// Shared schema for paginated responses
const PaginatedResponseSchema = (dataSchema) => object({
    data: array(dataSchema),
    cursor: string().nullable(),
    hasMore: boolean(),
});
/**
 * A standard error schema shape for propogating errors from runs and steps
 */
const StructuredErrorSchema = object({
    message: string(),
    stack: string().optional(),
    code: string().optional(), // TODO: currently unused. make this an enum maybe
});

// Workflow run schemas
const WorkflowRunStatusSchema = _enum([
    'pending',
    'running',
    'completed',
    'failed',
    'cancelled',
]);
/**
 * Base schema for the Workflow runs. Prefer using WorkflowRunSchema
 * which implements a discriminatedUnion for various states.
 *
 * Note: input/output use SerializedDataSchema to support both:
 * - specVersion >= 2: Uint8Array (binary devalue format)
 * - specVersion 1: any (legacy JSON format)
 */
const WorkflowRunBaseSchema = object({
    runId: string(),
    status: WorkflowRunStatusSchema,
    deploymentId: string(),
    workflowName: string(),
    // Optional in database for backwards compatibility, defaults to 1 (legacy) when reading
    specVersion: number().optional(),
    executionContext: record(string(), any()).optional(),
    input: SerializedDataSchema,
    output: SerializedDataSchema.optional(),
    error: StructuredErrorSchema.optional(),
    expiredAt: date().optional(),
    startedAt: date().optional(),
    completedAt: date().optional(),
    createdAt: date(),
    updatedAt: date(),
});
// Discriminated union based on status
const WorkflowRunSchema = discriminatedUnion('status', [
    // Non-final states
    WorkflowRunBaseSchema.extend({
        status: _enum(['pending', 'running']),
        output: _undefined(),
        error: _undefined(),
        completedAt: _undefined(),
    }),
    // Cancelled state
    WorkflowRunBaseSchema.extend({
        status: literal('cancelled'),
        output: _undefined(),
        error: _undefined(),
        completedAt: date(),
    }),
    // Completed state - output can be v1 or v2 format
    WorkflowRunBaseSchema.extend({
        status: literal('completed'),
        output: SerializedDataSchema,
        error: _undefined(),
        completedAt: date(),
    }),
    // Failed state
    WorkflowRunBaseSchema.extend({
        status: literal('failed'),
        output: _undefined(),
        error: StructuredErrorSchema,
        completedAt: date(),
    }),
]);

/**
 * Spec version utilities for backwards compatibility.
 *
 * Uses a branded type to ensure packages import the version constants
 * from @workflow/world rather than using arbitrary numbers.
 */
/** Legacy spec version (pre-event-sourcing). Also used for runs without specVersion. */
/** Current spec version (event-sourced architecture). */
const SPEC_VERSION_CURRENT = 2;
/**
 * Check if a spec version is legacy (< SPEC_VERSION_CURRENT or undefined).
 * Legacy runs require different handling - they use direct entity mutation
 * instead of the event-sourced model.
 *
 * @param v - The spec version number, or undefined/null for legacy runs
 * @returns true if the run is a legacy run
 */
function isLegacySpecVersion(v) {
    if (v === undefined || v === null)
        return true;
    return v < SPEC_VERSION_CURRENT;
}
/**
 * Check if a spec version requires a newer world (> SPEC_VERSION_CURRENT).
 * This happens when a run was created by a newer SDK version.
 *
 * @param v - The spec version number, or undefined/null for legacy runs
 * @returns true if the run requires a newer world version
 */
function requiresNewerWorld(v) {
    if (v === undefined || v === null)
        return false;
    return v > SPEC_VERSION_CURRENT;
}

// Step schemas
const StepStatusSchema = _enum([
    'pending',
    'running',
    'completed',
    'failed',
    'cancelled',
]);
/**
 * Schema for workflow steps.
 *
 * Note: input/output use SerializedDataSchema to support both:
 * - specVersion >= 2: Uint8Array (binary devalue format)
 * - specVersion 1: any (legacy JSON format)
 */
// TODO: implement a discriminated union here just like the run schema
const StepSchema = object({
    runId: string(),
    stepId: string(),
    stepName: string(),
    status: StepStatusSchema,
    input: SerializedDataSchema,
    output: SerializedDataSchema.optional(),
    /**
     * The error from a step_retrying or step_failed event.
     * This tracks the most recent error the step encountered, which may
     * be from a retry attempt (step_retrying) or the final failure (step_failed).
     */
    error: StructuredErrorSchema.optional(),
    attempt: number(),
    /**
     * When the step first started executing. Set by the first step_started event
     * and not updated on subsequent retries.
     */
    startedAt: date().optional(),
    completedAt: date().optional(),
    createdAt: date(),
    updatedAt: date(),
    retryAfter: date().optional(),
    // Optional in database for backwards compatibility, defaults to 1 (legacy) when reading
    specVersion: number().optional(),
});

const WaitStatusSchema = _enum(['waiting', 'completed']);
const WaitSchema = object({
    waitId: string(),
    runId: string(),
    status: WaitStatusSchema,
    resumeAt: date().optional(),
    completedAt: date().optional(),
    createdAt: date(),
    updatedAt: date(),
    specVersion: number().optional(),
});

export { EventSchema as E, HealthCheckPayloadSchema as H, MessageId as M, PaginatedResponseSchema as P, QueuePayloadSchema as Q, SPEC_VERSION_CURRENT as S, ValidQueueName as V, WorkflowInvokePayloadSchema as W, StepInvokePayloadSchema as a, HookSchema as b, WorkflowRunSchema as c, StepSchema as d, WaitSchema as e, StructuredErrorSchema as f, WorkflowRunBaseSchema as g, EventTypeSchema as h, isLegacySpecVersion as i, requiresNewerWorld as r };
