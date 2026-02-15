import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import {
  Config,
  State,
  ORCHESTRATOR_DIR,
  CONFIG_FILE,
  STATE_FILE,
} from "./types";
import {
  runOrchestration,
  resumeOrchestration,
  stopOrchestration,
} from "./orchestrator";

/**
 * Create the CLI program with all commands
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name("orchestrator")
    .description("AI dev team orchestrator using Claude Code")
    .version("0.1.0");

  // init command
  program
    .command("init")
    .description("Initialize orchestrator for a repository")
    .argument("<repo-url>", "GitHub repository URL")
    .requiredOption("--token <github-token>", "GitHub personal access token")
    .action((repoUrl: string, options: { token: string }) => {
      initCommand(repoUrl, options.token);
    });

  // run command
  program
    .command("run")
    .description("Start orchestration (PO conversation, then background agents)")
    .action(async () => {
      await runCommand();
    });

  // stop command
  program
    .command("stop")
    .description("Stop all running agents and save state")
    .action(async () => {
      await stopCommand();
    });

  // resume command
  program
    .command("resume")
    .description("Resume orchestration from saved state")
    .action(async () => {
      await resumeCommand();
    });

  // status command
  program
    .command("status")
    .description("Show current orchestration state")
    .action(() => {
      statusCommand();
    });

  return program;
}

/**
 * Initialize orchestrator configuration
 */
function initCommand(repoUrl: string, token: string): void {
  // Validate repo URL format
  if (!repoUrl.includes("github.com")) {
    console.error("Error: Invalid repository URL. Must be a GitHub URL.");
    process.exit(1);
  }

  // Create .orchestrator directory
  if (!fs.existsSync(ORCHESTRATOR_DIR)) {
    fs.mkdirSync(ORCHESTRATOR_DIR, { recursive: true });
  }

  // Create subdirectories
  const subdirs = ["questions", "sessions"];
  for (const subdir of subdirs) {
    const dirPath = path.join(ORCHESTRATOR_DIR, subdir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  // Write config
  const config: Config = {
    repoUrl,
    token,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

  console.log(`Initialized orchestrator for: ${repoUrl}`);
  console.log(`Config saved to: ${CONFIG_FILE}`);
}

/**
 * Start orchestration
 */
async function runCommand(): Promise<void> {
  // Check if initialized
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error("Error: Orchestrator not initialized.");
    console.error("Run: orchestrator init <repo-url> --token <token>");
    process.exit(1);
  }

  // Read config
  const config: Config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  console.log(`Starting orchestration for: ${config.repoUrl}`);

  // Run the orchestration loop
  const result = await runOrchestration({ verbose: true });

  if (result.success) {
    console.log("\nOrchestration completed successfully!");
    process.exit(0);
  } else {
    console.error(`\nOrchestration failed: ${result.error}`);
    console.log(`Stopped at phase: ${result.finalPhase}`);
    process.exit(1);
  }
}

/**
 * Stop all running agents
 */
async function stopCommand(): Promise<void> {
  // Check if initialized
  if (!fs.existsSync(STATE_FILE)) {
    console.error("Error: No active orchestration found.");
    process.exit(1);
  }

  console.log("Stopping orchestration...");
  await stopOrchestration();
}

/**
 * Resume orchestration from saved state
 */
async function resumeCommand(): Promise<void> {
  // Check if state exists
  if (!fs.existsSync(STATE_FILE)) {
    console.error("Error: No saved state found.");
    console.error("Run: orchestrator run to start fresh.");
    process.exit(1);
  }

  // Read state
  const state: State = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  console.log(`Resuming orchestration from phase: ${state.phase}`);

  // Resume the orchestration loop
  const result = await resumeOrchestration({ verbose: true });

  if (result.success) {
    console.log("\nOrchestration completed successfully!");
    process.exit(0);
  } else {
    console.error(`\nOrchestration failed: ${result.error}`);
    console.log(`Stopped at phase: ${result.finalPhase}`);
    process.exit(1);
  }
}

/**
 * Show current orchestration status
 */
function statusCommand(): void {
  // Check if initialized
  if (!fs.existsSync(CONFIG_FILE)) {
    console.log("Status: Not initialized");
    console.log("Run: orchestrator init <repo-url> --token <token>");
    return;
  }

  const config: Config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));

  // Check if state exists
  if (!fs.existsSync(STATE_FILE)) {
    console.log("Status: Initialized but not running");
    console.log(`Repository: ${config.repoUrl}`);
    console.log("Run: orchestrator run to start");
    return;
  }

  // Read and display state
  const state: State = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));

  console.log("=== Orchestrator Status ===");
  console.log(`Repository: ${config.repoUrl}`);
  console.log(`Phase: ${state.phase}`);
  console.log(`Current Agent: ${state.currentAgent || "none"}`);
  console.log(`Blocked: ${state.blocked.isBlocked ? "yes" : "no"}`);

  if (state.blocked.isBlocked) {
    console.log(`  Blocked Agent: ${state.blocked.blockedAgent}`);
    console.log(`  Waiting For: ${state.blocked.waitingFor}`);
    console.log(`  Question File: ${state.blocked.questionFile}`);
  }

  console.log(`Dev Sessions: ${state.devSessions.length}`);
  for (const session of state.devSessions) {
    console.log(`  - ${session.area}: ${session.status} (${session.tickets.length} tickets)`);
  }

  console.log(`Last Updated: ${state.lastUpdated}`);
}
