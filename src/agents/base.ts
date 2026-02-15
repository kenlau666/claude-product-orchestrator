import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import { EXIT_CODES } from "../blocking";
import { ORCHESTRATOR_DIR } from "../types";

/**
 * Agent configuration for spawning Claude Code CLI
 */
export interface AgentConfig {
  /** Agent name (e.g., "po", "tech_lead", "dev-frontend") */
  name: string;
  /** Path to the prompt markdown file */
  promptFile: string;
  /** Context to pass to the agent */
  context: string;
  /** stdio mode: "inherit" for interactive, "pipe" for background */
  stdio: "inherit" | "pipe";
  /** Optional additional environment variables */
  env?: Record<string, string>;
}

/**
 * Result from agent execution
 */
export interface AgentResult {
  /** Exit code: 0=success, 1=error, 2=blocked */
  exitCode: number;
  /** Captured stdout (only available when stdio: "pipe") */
  stdout: string;
  /** Captured stderr (only available when stdio: "pipe") */
  stderr: string;
  /** Whether the agent was killed */
  killed: boolean;
}

/**
 * Handle to a running agent process
 */
export interface AgentHandle {
  /** The agent name */
  name: string;
  /** The underlying child process */
  process: ChildProcess;
  /** Promise that resolves when the agent exits */
  result: Promise<AgentResult>;
  /** Kill the agent gracefully */
  kill: () => void;
}

/**
 * Error thrown when agent spawning fails
 */
export class AgentSpawnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSpawnError";
  }
}

/**
 * Validate agent configuration
 */
function validateConfig(config: AgentConfig): void {
  if (!config.name || config.name.trim() === "") {
    throw new AgentSpawnError("Agent name is required");
  }

  if (!config.promptFile || config.promptFile.trim() === "") {
    throw new AgentSpawnError("Prompt file path is required");
  }

  if (!fs.existsSync(config.promptFile)) {
    throw new AgentSpawnError(`Prompt file not found: ${config.promptFile}`);
  }

  if (config.stdio !== "inherit" && config.stdio !== "pipe") {
    throw new AgentSpawnError('stdio must be "inherit" or "pipe"');
  }
}

/**
 * Read prompt file content
 */
function readPromptFile(promptFile: string): string {
  return fs.readFileSync(promptFile, "utf-8");
}

/**
 * Build environment variables for the agent process
 */
function buildEnv(config: AgentConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ORCHESTRATOR_DIR,
    ...config.env,
  };
}

/**
 * Build command line arguments for Claude Code CLI
 */
function buildArgs(prompt: string, context: string): string[] {
  const args: string[] = [];

  // Pass the prompt
  args.push("--prompt", prompt);

  // Pass the context if provided
  if (context && context.trim() !== "") {
    args.push("--context", context);
  }

  return args;
}

/**
 * Spawn a Claude Code CLI agent
 *
 * @param config - Agent configuration
 * @returns Handle to the running agent process
 *
 * @example
 * // Foreground mode (interactive)
 * const handle = spawnAgent({
 *   name: "po",
 *   promptFile: "prompts/po.md",
 *   context: "README: ...",
 *   stdio: "inherit"
 * });
 * const result = await handle.result;
 *
 * @example
 * // Background mode (capture output)
 * const handle = spawnAgent({
 *   name: "tech_lead",
 *   promptFile: "prompts/tech-lead.md",
 *   context: "PRD: ...",
 *   stdio: "pipe"
 * });
 * const result = await handle.result;
 * console.log(result.stdout);
 */
export function spawnAgent(config: AgentConfig): AgentHandle {
  validateConfig(config);

  const prompt = readPromptFile(config.promptFile);
  const args = buildArgs(prompt, config.context);
  const env = buildEnv(config);

  // Spawn the Claude Code CLI process
  const childProcess = spawn("claude", args, {
    stdio: config.stdio,
    env,
    // Use shell on Windows for proper PATH resolution
    shell: process.platform === "win32",
  });

  // Track stdout/stderr for pipe mode
  let stdout = "";
  let stderr = "";

  if (config.stdio === "pipe") {
    childProcess.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    childProcess.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
  }

  // Create result promise
  const result = new Promise<AgentResult>((resolve, reject) => {
    childProcess.on("error", (error) => {
      reject(new AgentSpawnError(`Failed to spawn agent: ${error.message}`));
    });

    childProcess.on("close", (code, signal) => {
      const exitCode = code ?? (signal ? 1 : 0);
      resolve({
        exitCode,
        stdout,
        stderr,
        killed: childProcess.killed || signal !== null,
      });
    });
  });

  // Kill function for graceful termination
  const kill = () => {
    if (!childProcess.killed) {
      // Send SIGTERM for graceful shutdown
      childProcess.kill("SIGTERM");

      // Force kill after timeout if still running
      setTimeout(() => {
        if (!childProcess.killed) {
          childProcess.kill("SIGKILL");
        }
      }, 5000);
    }
  };

  return {
    name: config.name,
    process: childProcess,
    result,
    kill,
  };
}

/**
 * Spawn an agent and wait for completion
 *
 * Convenience function that spawns an agent and returns the result.
 *
 * @param config - Agent configuration
 * @returns Promise that resolves with the agent result
 */
export async function runAgent(config: AgentConfig): Promise<AgentResult> {
  const handle = spawnAgent(config);
  return handle.result;
}

/**
 * Check if an agent result indicates success
 */
export function isSuccess(result: AgentResult): boolean {
  return result.exitCode === EXIT_CODES.SUCCESS;
}

/**
 * Check if an agent result indicates blocked status
 */
export function isBlocked(result: AgentResult): boolean {
  return result.exitCode === EXIT_CODES.BLOCKED;
}

/**
 * Check if an agent result indicates an error
 */
export function isError(result: AgentResult): boolean {
  return result.exitCode === EXIT_CODES.ERROR;
}

/**
 * Get a human-readable status from an agent result
 */
export function getResultStatus(result: AgentResult): string {
  if (result.killed) {
    return "killed";
  }

  switch (result.exitCode) {
    case EXIT_CODES.SUCCESS:
      return "success";
    case EXIT_CODES.BLOCKED:
      return "blocked";
    case EXIT_CODES.ERROR:
      return "error";
    default:
      return `unknown (exit code: ${result.exitCode})`;
  }
}
