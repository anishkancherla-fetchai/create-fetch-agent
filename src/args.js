/**
 * Argument parsing + validation for the CLI. Kept separate from `bin/cli.js`
 * (which has side effects) so it can be unit-tested in isolation.
 */

export const BUILD_TYPES = [
  "single_agent",
  "chat_agent",
  "multi_agent",
  "payment_agent",
];

export const PYTHON_MANAGERS = ["uv", "poetry", "pip"];

export const AI_TARGETS = ["cursor", "claude", "antigravity", "agents"];

// Flags that consume the following token as their value (e.g. `--ai cursor`).
const VALUE_FLAGS = new Set(["ai", "type", "python"]);

const TYPE_ALIASES = {
  single: "single_agent",
  single_agent: "single_agent",
  chat: "chat_agent",
  chat_agent: "chat_agent",
  multi: "multi_agent",
  multiple: "multi_agent",
  multi_agent: "multi_agent",
  payment: "payment_agent",
  payment_agent: "payment_agent",
};

const MANAGER_ALIASES = {
  uv: "uv",
  poetry: "poetry",
  pip: "pip",
  venv: "pip",
};

const AI_ALIASES = {
  cursor: "cursor",
  claude: "claude",
  "claude-code": "claude",
  antigravity: "antigravity",
  agents: "agents",
  "agents.md": "agents",
  agentsmd: "agents",
};

/**
 * Parse argv into positionals + a flag map.
 *
 * Supports `--flag`, `--flag value`, `--flag=value`, `--no-flag`, `-h`, `-y`,
 * and a `--` terminator (everything after is positional).
 *
 * @param {string[]} argv
 * @returns {{positionals: string[], flags: Record<string, string|boolean>}}
 */
export function parseArgs(argv) {
  const flags = {};
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];

    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (VALUE_FLAGS.has(body) && next !== undefined && !next.startsWith("-")) {
        flags[body] = next;
        i += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }

    if (a.startsWith("-") && a.length > 1) {
      const short = a.slice(1);
      if (short === "h") flags.help = true;
      else if (short === "y") flags.yes = true;
      else flags[short] = true;
      continue;
    }

    positionals.push(a);
  }

  return { positionals, flags };
}

/**
 * Normalize a `--type` value to a canonical build type. Throws on unknown.
 */
export function normalizeType(value) {
  const key = String(value).trim().toLowerCase();
  const canonical = TYPE_ALIASES[key];
  if (!canonical) {
    throw new Error(
      `Unknown --type "${value}". Use one of: single, chat, multi, payment.`,
    );
  }
  return canonical;
}

/**
 * Normalize a `--python` value to a canonical manager. Throws on unknown.
 */
export function normalizeManager(value) {
  const key = String(value).trim().toLowerCase();
  const canonical = MANAGER_ALIASES[key];
  if (!canonical) {
    throw new Error(
      `Unknown --python "${value}". Use one of: uv, poetry, pip.`,
    );
  }
  return canonical;
}

/**
 * Parse a `--ai` value (comma-separated) into a target list. "none" -> [].
 * Throws on any unknown target.
 */
export function parseAiTargets(value) {
  const raw = String(value).trim().toLowerCase();
  if (raw === "" || raw === "none") return [];

  const seen = new Set();
  const targets = [];
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (!token) continue;
    const canonical = AI_ALIASES[token];
    if (!canonical) {
      throw new Error(
        `Unknown --ai target "${token}". Use any of: cursor, claude, antigravity, agents (or none).`,
      );
    }
    if (!seen.has(canonical)) {
      seen.add(canonical);
      targets.push(canonical);
    }
  }
  return targets;
}

/**
 * Map parsed flags to wizard `overrides` (only keys that were actually passed).
 * Prompts are skipped for any key present here. Throws on invalid values.
 *
 * @param {Record<string, string|boolean>} flags
 * @returns {object} overrides
 */
export function flagsToOverrides(flags) {
  const overrides = {};

  if (flags.type !== undefined && flags.type !== true) {
    overrides.buildType = normalizeType(flags.type);
  }
  if (flags.python !== undefined && flags.python !== true) {
    overrides.pythonManager = normalizeManager(flags.python);
  }
  if (flags.ai !== undefined && flags.ai !== true) {
    overrides.aiTargets = parseAiTargets(flags.ai);
  }
  if (flags["no-install"]) overrides.installNow = false;
  if (flags.install) overrides.installNow = true;
  if (flags["no-register"]) overrides.registerNow = false;
  if (flags.register) overrides.registerNow = true;

  return overrides;
}

/**
 * Whether the user asked for the skills-only mode (add AI context to an
 * existing project without scaffolding).
 */
export function isSkillsOnly(flags) {
  return Boolean(flags["skills-only"] || flags["add-skills"]);
}
