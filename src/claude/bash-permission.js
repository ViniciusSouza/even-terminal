const AUTO_ALLOWED_BASH = /^\s*(ls|cat|head|tail|wc|pwd|echo|printf|date|whoami|which|where|type|file|stat|du|df|printenv|uname|hostname|id|git\s+(status|log|diff|show|rev-parse))\b/;
const BASH_CONTROL_SYNTAX = /[;&|<>`\r\n]|\$\(/;
export function isAutoAllowedBashCommand(value) {
    const command = String(value ?? "").trim();
    return AUTO_ALLOWED_BASH.test(command) && !BASH_CONTROL_SYNTAX.test(command);
}
