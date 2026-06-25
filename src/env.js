import { execa } from "execa";
import ora from "ora";
import chalk from "chalk";

/** Pinned Python version the generated projects target. */
export const PYTHON_VERSION = "3.12";

/** Direct (top-level) dependencies — everything else in requirements.txt is the transitive freeze. */
const DIRECT_DEPS = ["uagents", "uagents-core", "python-dotenv"];

function normalizePkgName(projectName) {
  return (
    String(projectName)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "fetch-agent"
  );
}

/**
 * Pull the pinned versions of the direct dependencies out of a requirements.txt
 * freeze, so generated manifests stay in sync with the template lockfile.
 *
 * @param {string} requirementsText
 * @returns {Array<{name: string, version: string|null}>}
 */
function directDeps(requirementsText) {
  const pinned = new Map();
  for (const rawLine of requirementsText.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z0-9._-]+)\s*==\s*(.+)$/);
    if (m) pinned.set(m[1].toLowerCase(), m[2]);
  }
  return DIRECT_DEPS.map((name) => ({ name, version: pinned.get(name.toLowerCase()) || null }));
}

/**
 * Render a PEP 621 pyproject.toml for a uv-managed project. `tool.uv.package =
 * false` keeps the project as a runnable app (uv manages deps + .venv + uv.lock
 * via `uv sync`, but never tries to build/install the project itself).
 *
 * @param {string} projectName
 * @param {string} requirementsText contents of requirements.txt (dep source)
 * @returns {string} pyproject.toml contents
 */
export function renderUvPyproject(projectName, requirementsText, extraDeps = []) {
  const baseDeps = directDeps(requirementsText).map(({ name, version }) =>
    version ? `    "${name}==${version}",` : `    "${name}",`,
  );
  const extra = extraDeps.map((d) => `    "${d}",`);
  const deps = [...baseDeps, ...extra].join("\n");

  return `[project]
name = "${normalizePkgName(projectName)}"
version = "0.1.0"
description = "A Fetch.ai uAgents project."
requires-python = ">=${PYTHON_VERSION}"
dependencies = [
${deps}
]

[tool.uv]
package = false
`;
}

/**
 * Convert a pinned requirements.txt into a Poetry pyproject.toml.
 *
 * @param {string} projectName
 * @param {string} requirementsText contents of requirements.txt
 * @returns {string} pyproject.toml contents
 */
export function renderPyproject(projectName, requirementsText, extraDeps = []) {
  const pkgName = normalizePkgName(projectName);

  const deps = [];
  const pushDep = (spec) => {
    const line = spec.trim();
    if (!line || line.startsWith("#")) return;
    const m = line.match(/^([A-Za-z0-9._-]+)\s*==\s*(.+)$/);
    if (m) {
      deps.push(`${m[1]} = "${m[2]}"`);
    } else {
      const name = line.split(/[<>=!~ ]/)[0];
      if (name) deps.push(`${name} = "*"`);
    }
  };

  for (const rawLine of requirementsText.split("\n")) pushDep(rawLine);
  for (const extra of extraDeps) pushDep(extra);

  return `[tool.poetry]
name = "${pkgName}"
version = "0.1.0"
description = "A Fetch.ai uAgents project."
authors = []
package-mode = false

[tool.poetry.dependencies]
python = "^${PYTHON_VERSION}"
${deps.join("\n")}

[build-system]
requires = ["poetry-core"]
build-backend = "poetry.core.masonry.api"
`;
}

/**
 * Manual commands to print when an automated install can't run.
 */
export function manualInstallCommands(pythonManager) {
  switch (pythonManager) {
    case "uv":
      return ["uv sync"];
    case "poetry":
      return [`poetry env use python${PYTHON_VERSION}`, "poetry install"];
    default:
      return [
        `python${PYTHON_VERSION} -m venv .venv`,
        "source .venv/bin/activate",
        "pip install -r requirements.txt",
      ];
  }
}

async function runStep({ label, cmd, args, cwd, logger }) {
  const interactive = logger === console && Boolean(process.stdout.isTTY);
  const spinner = interactive ? ora({ text: label, color: "cyan" }).start() : null;
  if (!spinner) logger.log(`  ${label}`);
  try {
    await execa(cmd, args, { cwd, all: true });
    if (spinner) spinner.succeed(label);
    else logger.log(`  ✔ ${label}`);
    return true;
  } catch (err) {
    if (spinner) spinner.fail(label);
    else logger.log(`  ✖ ${label}`);
    const detail = (err.all || err.shortMessage || err.message || "").trim();
    if (detail) logger.log(chalk.dim(detail.split("\n").slice(-12).join("\n")));
    throw err;
  }
}

async function commandExists(cmd) {
  try {
    await execa(cmd, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Bootstrap the Python environment + dependencies for a generated project.
 *
 * Branches on the chosen package manager. Never throws on a missing tool —
 * instead prints the exact manual commands so the user can finish by hand.
 *
 * @returns {Promise<{ok: boolean, manual?: string[]}>}
 */
export async function bootstrap(answers, { cwd, logger = console } = {}) {
  const pm = answers.pythonManager;
  const manual = manualInstallCommands(pm);

  try {
    if (pm === "uv") {
      if (!(await commandExists("uv"))) {
        return printManual(logger, manual, "`uv` was not found on your PATH.");
      }
      // `uv sync` reads pyproject.toml + .python-version, creates .venv (fetching
      // Python 3.12 if needed), resolves deps, and writes uv.lock — one step.
      await runStep({
        label: "Resolving environment + dependencies (uv sync)",
        cmd: "uv",
        args: ["sync"],
        cwd,
        logger,
      });
      return { ok: true };
    }

    if (pm === "poetry") {
      if (!(await commandExists("poetry"))) {
        return printManual(logger, manual, "`poetry` was not found on your PATH.");
      }
      // Pin the interpreter so Poetry doesn't silently grab a newer system Python
      // (e.g. 3.14) that lacks prebuilt wheels for the pinned deps.
      if (await commandExists(`python${PYTHON_VERSION}`)) {
        await runStep({
          label: `Selecting Python ${PYTHON_VERSION} (poetry env use)`,
          cmd: "poetry",
          args: ["env", "use", `python${PYTHON_VERSION}`],
          cwd,
          logger,
        });
      }
      await runStep({ label: "Installing dependencies (poetry install)", cmd: "poetry", args: ["install"], cwd, logger });
      return { ok: true };
    }

    // pip (default fallback)
    const python = (await commandExists(`python${PYTHON_VERSION}`))
      ? `python${PYTHON_VERSION}`
      : (await commandExists("python3"))
        ? "python3"
        : null;
    if (!python) {
      return printManual(logger, manual, `No \`python${PYTHON_VERSION}\` / \`python3\` found on your PATH.`);
    }
    await runStep({ label: `Creating virtual environment (${python} -m venv .venv)`, cmd: python, args: ["-m", "venv", ".venv"], cwd, logger });
    await runStep({
      label: "Installing dependencies (.venv/bin/pip install)",
      cmd: ".venv/bin/pip",
      args: ["install", "-r", "requirements.txt"],
      cwd,
      logger,
    });
    return { ok: true };
  } catch (err) {
    logger.log(chalk.yellow("\nAutomated install did not complete. Run these manually:"));
    for (const c of manual) logger.log(chalk.cyan(`  ${c}`));
    return { ok: false, manual };
  }
}

function printManual(logger, manual, reason) {
  logger.log(chalk.yellow(`\n${reason} Run these manually:`));
  for (const c of manual) logger.log(chalk.cyan(`  ${c}`));
  return { ok: false, manual };
}
