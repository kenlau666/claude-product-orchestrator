import * as fs from "fs";
import * as path from "path";
import { spawnAgent, runAgent, AgentResult, isSuccess, isBlocked, isError } from "./base";
import { ORCHESTRATOR_DIR } from "../types";

/**
 * PO Agent constants
 */
export const PO_PROMPT_FILE = "prompts/po.md";
export const PRD_OUTPUT_FILE = path.join(ORCHESTRATOR_DIR, "prd.md");

/**
 * Configuration for running the PO agent
 */
export interface POAgentConfig {
  /** Path to README.md file (defaults to "README.md") */
  readmeFile?: string;
  /** Path to PO prompt file (defaults to "prompts/po.md") */
  promptFile?: string;
  /** Additional context to pass to PO */
  additionalContext?: string;
}

/**
 * Result from PO agent execution
 */
export interface POAgentResult {
  /** The underlying agent result */
  agentResult: AgentResult;
  /** Whether the PRD was created */
  prdCreated: boolean;
  /** Path to the PRD file (if created) */
  prdPath: string | null;
  /** Status: "success" | "blocked" | "error" */
  status: "success" | "blocked" | "error";
}

/**
 * Error thrown for PO agent operations
 */
export class POAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "POAgentError";
  }
}

/**
 * Read README.md file content
 * @throws POAgentError if README.md doesn't exist
 */
export function readReadmeFile(readmeFile: string = "README.md"): string {
  if (!fs.existsSync(readmeFile)) {
    throw new POAgentError(`README file not found: ${readmeFile}`);
  }
  return fs.readFileSync(readmeFile, "utf-8");
}

/**
 * Build context for PO agent from README and additional context
 */
export function buildPOContext(
  readmeContent: string,
  additionalContext?: string
): string {
  const parts: string[] = [];

  parts.push("# README");
  parts.push("");
  parts.push(readmeContent);

  if (additionalContext && additionalContext.trim() !== "") {
    parts.push("");
    parts.push("# Additional Context");
    parts.push("");
    parts.push(additionalContext);
  }

  return parts.join("\n");
}

/**
 * Check if PRD file was created
 */
export function checkPRDCreated(prdPath: string = PRD_OUTPUT_FILE): boolean {
  return fs.existsSync(prdPath);
}

/**
 * Read the PRD file content
 */
export function readPRD(prdPath: string = PRD_OUTPUT_FILE): string | null {
  if (!fs.existsSync(prdPath)) {
    return null;
  }
  return fs.readFileSync(prdPath, "utf-8");
}

/**
 * Ensure the orchestrator directory exists
 */
function ensureOrchestratorDir(): void {
  if (!fs.existsSync(ORCHESTRATOR_DIR)) {
    fs.mkdirSync(ORCHESTRATOR_DIR, { recursive: true });
  }
}

/**
 * Run the PO agent
 *
 * Spawns the PO agent in foreground mode for interactive conversation.
 * The PO reads the README, asks clarifying questions, and produces a PRD.
 *
 * @param config - Optional configuration
 * @returns Promise that resolves with the PO agent result
 *
 * @example
 * const result = await runPOAgent();
 * if (result.status === "success" && result.prdCreated) {
 *   console.log("PRD created at:", result.prdPath);
 * }
 */
export async function runPOAgent(
  config: POAgentConfig = {}
): Promise<POAgentResult> {
  const {
    readmeFile = "README.md",
    promptFile = PO_PROMPT_FILE,
    additionalContext,
  } = config;

  // Ensure orchestrator directory exists for PRD output
  ensureOrchestratorDir();

  // Validate prompt file exists
  if (!fs.existsSync(promptFile)) {
    throw new POAgentError(`PO prompt file not found: ${promptFile}`);
  }

  // Read README and build context
  const readmeContent = readReadmeFile(readmeFile);
  const context = buildPOContext(readmeContent, additionalContext);

  // Run PO agent in foreground mode (interactive)
  const agentResult = await runAgent({
    name: "po",
    promptFile,
    context,
    stdio: "inherit",
  });

  // Check if PRD was created
  const prdCreated = checkPRDCreated();
  const prdPath = prdCreated ? PRD_OUTPUT_FILE : null;

  // Determine status
  let status: POAgentResult["status"];
  if (isSuccess(agentResult)) {
    status = "success";
  } else if (isBlocked(agentResult)) {
    status = "blocked";
  } else {
    status = "error";
  }

  return {
    agentResult,
    prdCreated,
    prdPath,
    status,
  };
}

/**
 * Spawn PO agent without waiting for completion
 *
 * Returns a handle that can be used to monitor or kill the process.
 * Useful when you need to manage the process lifecycle manually.
 *
 * @param config - Optional configuration
 * @returns Agent handle with process and result promise
 */
export function spawnPOAgent(config: POAgentConfig = {}) {
  const {
    readmeFile = "README.md",
    promptFile = PO_PROMPT_FILE,
    additionalContext,
  } = config;

  // Ensure orchestrator directory exists
  ensureOrchestratorDir();

  // Validate prompt file exists
  if (!fs.existsSync(promptFile)) {
    throw new POAgentError(`PO prompt file not found: ${promptFile}`);
  }

  // Read README and build context
  const readmeContent = readReadmeFile(readmeFile);
  const context = buildPOContext(readmeContent, additionalContext);

  // Spawn PO agent in foreground mode
  return spawnAgent({
    name: "po",
    promptFile,
    context,
    stdio: "inherit",
  });
}

/**
 * Validate that the PRD was properly created and has content
 */
export function validatePRD(prdPath: string = PRD_OUTPUT_FILE): {
  valid: boolean;
  error?: string;
} {
  if (!fs.existsSync(prdPath)) {
    return { valid: false, error: "PRD file not found" };
  }

  const content = fs.readFileSync(prdPath, "utf-8");

  if (content.trim() === "") {
    return { valid: false, error: "PRD file is empty" };
  }

  // Check for basic PRD structure (at minimum should have a heading)
  if (!content.includes("#")) {
    return { valid: false, error: "PRD file appears to be malformed (no headings)" };
  }

  return { valid: true };
}
