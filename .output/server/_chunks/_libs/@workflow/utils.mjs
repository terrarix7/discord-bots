import { m as ms } from '../ms.mjs';
import { execFile } from 'node:child_process';
import { readdir, readlink, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

/**
 * Returns the singular or plural form of a word based on count.
 *
 * @param singular - The singular form of the word
 * @param plural - The plural form of the word
 * @param count - The count to determine which form to use
 * @returns The singular form if count is 1, otherwise the plural form
 *
 * @example
 * pluralize('step', 'steps', 1) // 'step'
 * pluralize('step', 'steps', 3) // 'steps'
 * pluralize('retry', 'retries', 0) // 'retries'
 */
function pluralize(singular, plural, count) {
    return count === 1 ? singular : plural;
}

/**
 * Polyfill for `Promise.withResolvers()`.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/withResolvers
 */
function withResolvers() {
    let resolve;
    let reject;
    const promise = new Promise((_resolve, _reject) => {
        resolve = _resolve;
        reject = _reject;
    });
    return { promise, resolve, reject };
}
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

/**
 * Parses a duration parameter (string, number, or Date) and returns a Date object
 * representing when the duration should elapse.
 *
 * - For strings: Parses duration strings like "1s", "5m", "1h", etc. using the `ms` library
 * - For numbers: Treats as milliseconds from now
 * - For Date objects: Returns the date directly (handles both Date instances and date-like objects from deserialization)
 *
 * @param param - The duration parameter (StringValue, Date, or number of milliseconds)
 * @returns A Date object representing when the duration should elapse
 * @throws {Error} If the parameter is invalid or cannot be parsed
 */
function parseDurationToDate(param) {
    if (typeof param === 'string') {
        const durationMs = ms(param);
        if (typeof durationMs !== 'number' || durationMs < 0) {
            throw new Error(`Invalid duration: "${param}". Expected a valid duration string like "1s", "1m", "1h", etc.`);
        }
        return new Date(Date.now() + durationMs);
    }
    else if (typeof param === 'number') {
        if (param < 0 || !Number.isFinite(param)) {
            throw new Error(`Invalid duration: ${param}. Expected a non-negative finite number of milliseconds.`);
        }
        return new Date(Date.now() + param);
    }
    else if (param instanceof Date ||
        (param &&
            typeof param === 'object' &&
            typeof param.getTime === 'function')) {
        // Handle both Date instances and date-like objects (from deserialization)
        return param instanceof Date ? param : new Date(param.getTime());
    }
    else {
        throw new Error(`Invalid duration parameter. Expected a duration string, number (milliseconds), or Date object.`);
    }
}

/**
 * Parse a machine readable name.
 *
 * @see {@link ../../swc-plugin-workflow/transform/src/naming.rs} for the naming scheme.
 */
function parseName(tag, name) {
    if (typeof name !== 'string') {
        return null;
    }
    // Looks like {prefix}//{moduleSpecifier}//{function_name}"
    // Where:
    // - {prefix} is either 'workflow', 'step', or 'class'
    // - {moduleSpecifier} is either:
    //   - A module specifier (e.g., `point@0.0.1`, `@myorg/shared@1.2.3`) when provided via plugin config
    //   - A relative path prefixed with `./` (e.g., `./src/jobs/order`) when no specifier is provided
    // - {function_name} is the name of the function (with nested functions using `/` separators)
    const [prefix, moduleSpecifier, ...functionNameParts] = name.split('//');
    if (prefix !== tag || !moduleSpecifier || functionNameParts.length === 0) {
        return null;
    }
    const functionName = functionNameParts.join('//');
    // For nested functions like "processOrder/innerStep", get just "innerStep"
    let shortName = functionName.split('/').at(-1) ?? '';
    // Extract a reasonable name for default exports
    // For module specifiers like "point@0.0.1", use the package name "point"
    // For relative paths like "./src/jobs/order", use the last segment "order"
    let moduleShortName = '';
    if (moduleSpecifier.startsWith('./')) {
        // Relative path: use the last path segment
        moduleShortName = moduleSpecifier.split('/').at(-1) ?? '';
    }
    else {
        // Module specifier: extract package name (strip version and scope)
        // e.g., "@myorg/shared@1.2.3" -> "shared", "point@0.0.1" -> "point"
        const withoutVersion = moduleSpecifier.split('@').slice(0, -1).join('@') ||
            moduleSpecifier.split('@')[0];
        moduleShortName = withoutVersion?.split('/').at(-1) ?? '';
    }
    // Default exports will use the module short name. "__default" was only
    // used for one package version, so this is a minor backwards compatibility fix.
    if (['default', '__default'].includes(shortName) && moduleShortName) {
        shortName = moduleShortName;
    }
    return {
        shortName,
        moduleSpecifier,
        functionName,
    };
}
/**
 * Parse a workflow name into its components.
 *
 * @param name - The workflow name to parse (e.g., "workflow//./src/jobs/order//processOrder" or "workflow//mypackage@1.0.0//processOrder").
 * @returns An object with `shortName`, `moduleSpecifier`, and `functionName` properties.
 * When the name is invalid, returns `null`.
 */
function parseWorkflowName(name) {
    return parseName('workflow', name);
}

const execFileAsync = promisify(execFile);
/**
 * Parses a port string and returns it if valid (0-65535), otherwise undefined.
 */
function parsePort(value, radix = 10) {
    const port = parseInt(value, radix);
    if (!Number.isNaN(port) && port >= 0 && port <= 65535) {
        return port;
    }
    return undefined;
}
// NOTE: We build /proc paths dynamically to prevent @vercel/nft from tracing them.
// NFT's static analysis tries to bundle any file path literal it finds (e.g., '/proc/net/tcp').
// Since /proc is a virtual Linux filesystem, this causes build failures in @sveltejs/adapter-vercel.
const join = (arr, sep) => arr.join(sep);
const PROC_ROOT = join(['', 'proc'], '/');
/**
 * Gets ALL listening ports for the current process on Linux by reading /proc filesystem.
 * Returns ports in order of file descriptor (deterministic ordering).
 */
async function getLinuxPorts(pid) {
    const listenState = '0A'; // TCP LISTEN state in /proc/net/tcp
    const tcpFiles = [`${PROC_ROOT}/net/tcp`, `${PROC_ROOT}/net/tcp6`];
    // Step 1: Get socket inodes from /proc/<pid>/fd/ in order
    // We preserve order to maintain deterministic behavior
    // Use both array (for order) and Set (for O(1) lookup)
    const socketInodes = [];
    const socketInodesSet = new Set();
    const fdPath = `${PROC_ROOT}/${pid}/fd`;
    try {
        const fds = await readdir(fdPath);
        // Sort FDs numerically to ensure deterministic order (FDs are always numeric strings)
        const sortedFds = fds.sort((a, b) => {
            const numA = Number.parseInt(a, 10);
            const numB = Number.parseInt(b, 10);
            return numA - numB;
        });
        const results = await Promise.allSettled(sortedFds.map(async (fd) => {
            const link = await readlink(`${fdPath}/${fd}`);
            // Socket links look like: socket:[12345]
            const match = link.match(/^socket:\[(\d+)\]$/);
            return match?.[1] ?? null;
        }));
        for (const result of results) {
            if (result.status === 'fulfilled' && result.value) {
                socketInodes.push(result.value);
                socketInodesSet.add(result.value);
            }
        }
    }
    catch {
        // Process might not exist or no permission
        return [];
    }
    if (socketInodes.length === 0) {
        return [];
    }
    // Step 2: Read /proc/net/tcp and /proc/net/tcp6 to find listening sockets
    // Format: sl local_address rem_address st ... inode
    // local_address is hex IP:port, st=0A means LISTEN
    const inodeToPort = new Map();
    for (const tcpFile of tcpFiles) {
        try {
            const content = await readFile(tcpFile, 'utf8');
            const lines = content.split('\n').slice(1); // Skip header
            for (const line of lines) {
                if (!line.trim())
                    continue; // Skip empty lines
                const parts = line.trim().split(/\s+/);
                if (parts.length < 10)
                    continue;
                const localAddr = parts[1]; // e.g., "00000000:0BB8" (0.0.0.0:3000)
                const state = parts[3]; // "0A" = LISTEN
                const inode = parts[9];
                if (!localAddr || state !== listenState || !inode)
                    continue;
                if (!socketInodesSet.has(inode))
                    continue;
                // Extract port from hex format (e.g., "0BB8" -> 3000)
                const colonIndex = localAddr.indexOf(':');
                if (colonIndex === -1)
                    continue;
                const portHex = localAddr.slice(colonIndex + 1);
                if (!portHex)
                    continue;
                const port = parsePort(portHex, 16);
                if (port !== undefined) {
                    inodeToPort.set(inode, port);
                }
            }
        }
        catch { }
    }
    // Return all ports in socket inode order (deterministic)
    const ports = [];
    for (const inode of socketInodes) {
        const port = inodeToPort.get(inode);
        if (port !== undefined) {
            ports.push(port);
        }
    }
    return ports;
}
/**
 * Gets ALL listening ports for the current process on macOS using lsof.
 * Returns ports in the order they appear in lsof output.
 */
async function getDarwinPorts(pid) {
    try {
        const { stdout } = await execFileAsync('lsof', [
            '-a',
            '-i',
            '-P',
            '-n',
            '-p',
            pid.toString(),
        ]);
        const ports = [];
        const lines = stdout.split('\n');
        for (const line of lines) {
            if (line.includes('LISTEN')) {
                // Column 9 (0-indexed: 8) contains the address like "*:3000" or "127.0.0.1:3000"
                const parts = line.trim().split(/\s+/);
                const addr = parts[8];
                if (addr) {
                    const colonIndex = addr.lastIndexOf(':');
                    if (colonIndex !== -1) {
                        const port = parsePort(addr.slice(colonIndex + 1));
                        if (port !== undefined) {
                            ports.push(port);
                        }
                    }
                }
            }
        }
        return ports;
    }
    catch {
        return [];
    }
}
/**
 * Gets ALL listening ports for the current process on Windows using netstat.
 * Returns ports in the order they appear in netstat output.
 */
async function getWindowsPorts(pid) {
    try {
        const { stdout } = await execFileAsync('cmd', [
            '/c',
            `netstat -ano | findstr ${pid} | findstr LISTENING`,
        ]);
        const ports = [];
        const trimmedOutput = stdout.trim();
        if (trimmedOutput) {
            const lines = trimmedOutput.split('\n');
            for (const line of lines) {
                // Extract port from the local address column
                // Matches both IPv4 (e.g., "127.0.0.1:3000") and IPv6 bracket notation (e.g., "[::1]:3000")
                const match = line
                    .trim()
                    .match(/^\s*TCP\s+(?:\[[\da-f:]+\]|[\d.]+):(\d+)\s+/i);
                if (match) {
                    const port = parsePort(match[1]);
                    if (port !== undefined) {
                        ports.push(port);
                    }
                }
            }
        }
        return ports;
    }
    catch {
        return [];
    }
}
/**
 * Gets all listening ports for the current process.
 * @returns Array of port numbers the process is listening on, in deterministic order.
 */
async function getAllPorts() {
    const { pid, platform } = process;
    try {
        switch (platform) {
            case 'linux':
                return await getLinuxPorts(pid);
            case 'darwin':
                return await getDarwinPorts(pid);
            case 'win32':
                return await getWindowsPorts(pid);
            default:
                return [];
        }
    }
    catch (error) {
        if (process.env.NODE_ENV === 'development') {
            console.debug('[getAllPorts] Detection failed:', error);
        }
        return [];
    }
}
/**
 * Gets the port number that the process is listening on.
 * @returns The port number that the process is listening on, or undefined if the process is not listening on any port.
 */
async function getPort() {
    const ports = await getAllPorts();
    return ports[0];
}
// Configuration for HTTP probing
const PROBE_TIMEOUT_MS = 500;
const PROBE_ENDPOINT = '/.well-known/workflow/v1/flow?__health';
/**
 * Probes a port to check if it's serving the workflow HTTP server.
 * Uses HEAD request to minimize overhead.
 *
 * @returns true if the port responds with a 200 status from the health check endpoint
 */
async function probePort(port, options = {}) {
    const { endpoint = PROBE_ENDPOINT, timeout = PROBE_TIMEOUT_MS } = options;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(`http://localhost:${port}${endpoint}`, {
            method: 'HEAD',
            signal: controller.signal,
        });
        // The workflow health endpoint returns 200 for healthy
        return response.status === 200;
    }
    catch {
        // Connection refused, timeout, or other error
        return false;
    }
    finally {
        clearTimeout(timeoutId);
    }
}
/**
 * Gets the workflow server port by probing all listening ports.
 * This is more reliable than getPort() when other services (like Node.js inspector)
 * may also be listening on ports.
 *
 * @param options - Optional configuration for probing
 * @returns The port number of the workflow server, or undefined if not found
 */
async function getWorkflowPort(options) {
    const ports = await getAllPorts();
    if (ports.length === 0) {
        return undefined;
    }
    if (ports.length === 1) {
        // Only one port, no need to probe
        return ports[0];
    }
    // Probe all ports in parallel
    const probeResults = await Promise.all(ports.map(async (port) => ({
        port,
        isWorkflow: await probePort(port, options),
    })));
    // Return first port that responded as workflow server
    const workflowPort = probeResults.find((r) => r.isWorkflow);
    if (workflowPort) {
        return workflowPort.port;
    }
    // Fallback to first port if probing doesn't identify workflow server
    // This handles cases where:
    // - Server hasn't started workflow routes yet
    // - Network issues during probing
    if (process.env.NODE_ENV === 'development') {
        console.debug('[getWorkflowPort] Probing failed, falling back to first port:', ports[0]);
    }
    return ports[0];
}

export { pluralize as a, parseWorkflowName as b, getWorkflowPort as c, getPort as g, once as o, parseDurationToDate as p, withResolvers as w };
