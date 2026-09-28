import { createWriteStream } from "node:fs";
import { format } from "node:util";
import { getCurrentAppVersion } from "./update.js";
const methods = ["log", "info", "warn", "error", "debug"];
let installed = false;
let fileStream = null;
let fileLogLevel = "debug";
const stdoutLog = console.log.bind(console);
function ts() {
    return new Date().toLocaleString("sv");
}
function getArgValue(name) {
    const prefix = `${name}=`;
    for (let i = process.argv.length - 1; i >= 0; i--) {
        const arg = process.argv[i];
        if (arg === name)
            return process.argv[i + 1];
        if (arg.startsWith(prefix))
            return arg.slice(prefix.length);
    }
    return undefined;
}
/** Route raw diagnostics independently to verbose stdout and debug log files. */
export function writeDebugLog(...args) {
    const stamp = `[${ts()}]`;
    if (process.env.VERBOSE === "1")
        stdoutLog(stamp, ...args);
    if (fileStream && fileLogLevel === "debug") {
        fileStream.write(format(stamp, ...args) + "\n");
    }
}
/** Monkey-patch console.* to prepend an ISO timestamp. If --log-file is on
 *  argv, also tee every line to that file. */
export function installTimestampLogging() {
    if (installed)
        return;
    installed = true;
    const logFile = getArgValue("--log-file");
    fileLogLevel = getArgValue("--log-level") === "info" ? "info" : "debug";
    if (logFile) {
        try {
            const stream = createWriteStream(logFile, { flags: "a" });
            fileStream = stream;
            stream.on("open", () => {
                console.log(`[server] Logging to ${logFile} (level=${fileLogLevel})`);
            });
            stream.on("error", (err) => {
                if (fileStream === stream)
                    fileStream = null;
                console.error(`error: failed to open log file ${logFile}: ${err.message}`);
            });
        }
        catch (err) {
            console.error(`error: failed to open log file ${logFile}: ${err.message}`);
        }
    }
    for (const m of methods) {
        const orig = console[m].bind(console);
        console[m] = (...args) => {
            const stamp = `[${ts()}]`;
            orig(stamp, ...args);
            if (fileStream)
                fileStream.write(format(stamp, ...args) + "\n");
        };
    }
    console.log(`[server] Even Terminal v${getCurrentAppVersion().currentVersion}`);
}
