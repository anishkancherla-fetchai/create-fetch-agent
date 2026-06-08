import { execa } from "execa";
import ora from "ora";
import chalk from "chalk";

/**
 * Convert a pinned requirements.txt into a Poetry pyproject.toml.
 *
 * @param {string} projectName
 * @param {string} requirementsText contents of requirements.txt
 * @returns {string} pyproject.toml contents
 */
export function renderPyproject(projectName, requirementsText) {
  const pkgName = String(projectName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "fetch-agent";

  const deps = [];
  for (const rawLine of requirementsText.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z0-9._-]+)\s*==\s*(.+)$/);
    if (m) {
      deps.push(`${m[1]} = "${m[2]}"`);
    } else {
      const name = line.split(/[<>=!~ ]/)[0];
      if (name) deps.push(`${name} = "*"`);
    }
  }

  return `[tool.poetry]
name = "${pkgName}"
version = "0.1.0"
description = "A Fetch.ai uAgents project."
authors = []
package-mode = false

[tool.poetry.dependencies]
python = "^3.12"
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
      return ["uv venv", "uv pip install -r requirements.txt"];
    case "poetry":
      return ["poetry install"];
    default:
      return [
        "python3.12 -m venv .venv",
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
      await runStep({ label: "Creating virtual environment (uv venv)", cmd: "uv", args: ["venv"], cwd, logger });
      await runStep({
        label: "Installing dependencies (uv pip install)",
        cmd: "uv",
        args: ["pip", "install", "-r", "requirements.txt"],
        cwd,
        logger,
      });
      return { ok: true };
    }

    if (pm === "poetry") {
      if (!(await commandExists("poetry"))) {
        return printManual(logger, manual, "`poetry` was not found on your PATH.");
      }
      await runStep({ label: "Installing dependencies (poetry install)", cmd: "poetry", args: ["install"], cwd, logger });
      return { ok: true };
    }

    // pip (default fallback)
    const python = (await commandExists("python3.12"))
      ? "python3.12"
      : (await commandExists("python3"))
        ? "python3"
        : null;
    if (!python) {
      return printManual(logger, manual, "No `python3.12` / `python3` found on your PATH.");
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
