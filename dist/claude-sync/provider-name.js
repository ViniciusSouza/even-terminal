// Read once at module load; shared by routing, messages, and session lists.
export const USE_ORIGINAL_CLAUDE = process.env.USE_ORIGINAL_CLAUDE === "1";
export const PROVIDER_NAME = USE_ORIGINAL_CLAUDE ? "claude-sync" : "claude";
