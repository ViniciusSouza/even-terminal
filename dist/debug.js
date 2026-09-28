import { writeDebugLog } from "./logger.js";
export function debugLog(tag, ...args) {
    writeDebugLog(`[${tag}]`, ...args);
}
