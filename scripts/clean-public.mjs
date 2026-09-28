import { rm } from "node:fs/promises";

await rm(new URL("../public", import.meta.url), { force: true, recursive: true });
