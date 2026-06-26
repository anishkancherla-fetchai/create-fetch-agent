import path from "node:path";
import fs from "fs-extra";
import { input, select, checkbox, confirm, number } from "@inquirer/prompts";

export const defaultPrompts = { input, select, checkbox, confirm, number };

const DEFAULT_WORKER_NAMES = ["alice", "bob", "carol", "dave", "erin", "frank"];

/**
 * Validate a project name: no spaces, and not pointing at an existing non-empty
 * directory. Returns true or an error string (inquirer validate convention).
 */
export function validateProjectName(name, cwd = process.cwd()) {
  if (!name || !name.trim()) return "Project name is required.";
  if (/\s/.test(name)) return "Project name cannot contain spaces.";
  if (name === "." || name === "..") return "Pick a real directory name.";
  if (/[/\\]/.test(name)) return "Project name cannot contain path separators.";
  const target = path.resolve(cwd, name);
  if (fs.existsSync(target)) {
    const entries = fs.readdirSync(target);
    if (entries.length > 0) return `Directory "${name}" already exists and is not empty.`;
  }
  return true;
}

/**
 * Normalize a worker name to a python-identifier-safe token.
 */
export function normalizeWorkerName(raw) {
  return String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^([0-9])/, "w_$1");
}

/**
 * Run the interactive wizard. All I/O is injectable so it can run headlessly
 * in tests (pass a `prompts` object whose methods return canned answers).
 *
 * @returns {Promise<object>} the answers object consumed by scaffold/skills/env
 */
export async function runWizard({
  argv = [],
  prompts = defaultPrompts,
  logger = console,
  cwd = process.cwd(),
} = {}) {
  let projectName = argv[0];
  if (projectName) {
    const valid = validateProjectName(projectName, cwd);
    if (valid !== true) {
      logger.log(valid);
      projectName = undefined;
    }
  }
  if (!projectName) {
    projectName = await prompts.input({
      message: "Project name:",
      default: "my-fetch-agent",
      validate: (v) => validateProjectName(v, cwd),
    });
  }

  const buildType = await prompts.select({
    message: "What are you building?",
    choices: [
      { name: "Single agent", value: "single_agent" },
      { name: "Chat agent (ASI:One ready)", value: "chat_agent" },
      { name: "Multiple agents (ASI:One routes between them)", value: "multi_agent" },
      { name: "Payment agent (FET)", value: "payment_agent" },
    ],
  });

  let workers = [];
  if (buildType === "multi_agent") {
    const count = await prompts.number({
      message: "How many agents?",
      default: 2,
      min: 1,
      max: 10,
    });
    const n = Number(count) || 2;
    const taken = new Set();
    for (let i = 0; i < n; i += 1) {
      // Find a default that isn't already taken.
      let bump = i;
      let def = DEFAULT_WORKER_NAMES[bump] || `agent${bump + 1}`;
      while (taken.has(def)) {
        bump += 1;
        def = DEFAULT_WORKER_NAMES[bump] || `agent${bump + 1}`;
      }
      const raw = await prompts.input({
        message: `Agent ${i + 1} name:`,
        default: def,
        validate: (v) => {
          const norm = normalizeWorkerName(v);
          if (!norm) return "Enter a valid name (letters/numbers).";
          if (taken.has(norm)) return `"${norm}" is already used.`;
          return true;
        },
      });
      const norm = normalizeWorkerName(raw);
      taken.add(norm);
      workers.push(norm);
    }
  }

  const pythonManager = await prompts.select({
    message: "Python setup:",
    choices: [
      { name: "uv (fast, recommended)", value: "uv" },
      { name: "poetry", value: "poetry" },
      { name: "pip + venv", value: "pip" },
    ],
    default: "uv",
  });

  const aiTargets = await prompts.checkbox({
    message: "Add AI-editor context? (Space to select, Enter to confirm; none = skip)",
    choices: [
      { name: "Cursor", value: "cursor" },
      { name: "Claude Code", value: "claude" },
      { name: "Antigravity", value: "antigravity" },
      { name: "AGENTS.md", value: "agents" },
    ],
    required: false,
  });

  const registerNow = await prompts.select({
    message: "Register on Agentverse now?",
    choices: [
      { name: "Later (just show me the steps)", value: false },
      { name: "Yes, show me now", value: true },
    ],
    default: false,
  });

  const installNow = await prompts.confirm({
    message: "Install Python dependencies now?",
    default: true,
  });

  return {
    projectName,
    buildType,
    workers,
    pythonManager,
    aiTargets: aiTargets || [],
    registerNow,
    installNow,
  };
}
