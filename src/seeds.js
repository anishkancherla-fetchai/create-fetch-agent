import { randomBytes } from "node:crypto";

/**
 * Generate a unique, high-entropy seed for an agent.
 *
 * Each uAgent derives its on-network identity (and therefore its address) from
 * its seed via `Identity.from_seed`. Generating these for the user means the
 * scaffolded project runs immediately — nobody has to invent seed phrases.
 *
 * @returns {string} a 32-char hex string (16 random bytes)
 */
export const seed = () => randomBytes(16).toString("hex");
