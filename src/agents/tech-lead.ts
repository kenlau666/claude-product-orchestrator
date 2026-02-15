import * as fs from "fs";
import * as path from "path";
import { spawnAgent, runAgent, AgentResult, isSuccess, isBlocked, isError } from "./base";
import { ORCHESTRATOR_DIR } from "../types";
import { getAreas, getIssuesByArea, Issue } from "../github";

/**
 * Tech Lead Agent constants
 */
export const TECH_LEAD_PROMPT_FILE = "prompts/tech-lead.md";
export const PRD_FILE = path.join(ORCHESTRATOR_DIR, "prd.md");
export const ARCHITECTURE_OUTPUT_FILE = path.join(ORCHESTRATOR_DIR, "architecture.md");

/**
 * Configuration for running the Tech Lead agent
 */
export interface TechLeadAgentConfig {
  /** Path to PRD file (defaults to ".orchestrator/prd.md") */
  prdFile?: string;
  /** Path to Tech Lead prompt file (defaults to "prompts/tech-lead.md") */
  promptFile?: string;
  /** Additional context to pass to Tech Lead */
  additionalContext?: string;
}

/**
 * Parsed area with its associated issues
 */
export interface AreaWithIssues {
  area: string;
  issues: Issue[];
  ticketNumbers: number[];
}

/**
 * Result from Tech Lead agent execution
 */
export interface TechLeadAgentResult {
  /** The underlying agent result */
  agentResult: AgentResult;
  /** Whether the architecture file was created */
  architectureCreated: boolean;
  /** Path to the architecture file (if created) */
  architecturePath: string | null;
  /** Status: "success" | "blocked" | "error" */
  status: "success" | "blocked" | "error";
}

/**
 * Error thrown for Tech Lead agent operations
 */
export class TechLeadAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TechLeadAgentError";
  }
}

/**
 * Read PRD file content
 * @throws TechLeadAgentError if PRD doesn't exist
 */
export function readPRDFile(prdFile: string = PRD_FILE): string {
  if (!fs.existsSync(prdFile)) {
    throw new TechLeadAgentError(`PRD file not found: ${prdFile}`);
  }
  return fs.readFileSync(prdFile, "utf-8");
}

/**
 * Build context for Tech Lead agent from PRD and additional context
 */
export function buildTechLeadContext(
  prdContent: string,
  additionalContext?: string
): string {
  const parts: string[] = [];

  parts.push("# PRD (Product Requirements Document)");
  parts.push("");
  parts.push(prdContent);

  if (additionalContext && additionalContext.trim() !== "") {
    parts.push("");
    parts.push("# Additional Context");
    parts.push("");
    parts.push(additionalContext);
  }

  return parts.join("\n");
}

/**
 * Check if architecture file was created
 */
export function checkArchitectureCreated(
  architecturePath: string = ARCHITECTURE_OUTPUT_FILE
): boolean {
  return fs.existsSync(architecturePath);
}

/**
 * Read the architecture file content
 */
export function readArchitecture(
  architecturePath: string = ARCHITECTURE_OUTPUT_FILE
): string | null {
  if (!fs.existsSync(architecturePath)) {
    return null;
  }
  return fs.readFileSync(architecturePath, "utf-8");
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
 * Run the Tech Lead agent
 *
 * Spawns the Tech Lead agent in background mode.
 * The Tech Lead reads the PRD, designs architecture, and creates GitHub issues.
 *
 * @param config - Optional configuration
 * @returns Promise that resolves with the Tech Lead agent result
 *
 * @example
 * const result = await runTechLeadAgent();
 * if (result.status === "success" && result.architectureCreated) {
 *   console.log("Architecture created, now parse issues");
 *   const areas = await parseAreasFromIssues();
 * }
 */
export async function runTechLeadAgent(
  config: TechLeadAgentConfig = {}
): Promise<TechLeadAgentResult> {
  const {
    prdFile = PRD_FILE,
    promptFile = TECH_LEAD_PROMPT_FILE,
    additionalContext,
  } = config;

  // Ensure orchestrator directory exists
  ensureOrchestratorDir();

  // Validate prompt file exists
  if (!fs.existsSync(promptFile)) {
    throw new TechLeadAgentError(`Tech Lead prompt file not found: ${promptFile}`);
  }

  // Read PRD and build context
  const prdContent = readPRDFile(prdFile);
  const context = buildTechLeadContext(prdContent, additionalContext);

  // Run Tech Lead agent in background mode (pipe stdio)
  const agentResult = await runAgent({
    name: "tech_lead",
    promptFile,
    context,
    stdio: "pipe",
  });

  // Check if architecture was created
  const architectureCreated = checkArchitectureCreated();
  const architecturePath = architectureCreated ? ARCHITECTURE_OUTPUT_FILE : null;

  // Determine status
  let status: TechLeadAgentResult["status"];
  if (isSuccess(agentResult)) {
    status = "success";
  } else if (isBlocked(agentResult)) {
    status = "blocked";
  } else {
    status = "error";
  }

  return {
    agentResult,
    architectureCreated,
    architecturePath,
    status,
  };
}

/**
 * Spawn Tech Lead agent without waiting for completion
 *
 * Returns a handle that can be used to monitor or kill the process.
 * Useful when you need to manage the process lifecycle manually.
 *
 * @param config - Optional configuration
 * @returns Agent handle with process and result promise
 */
export function spawnTechLeadAgent(config: TechLeadAgentConfig = {}) {
  const {
    prdFile = PRD_FILE,
    promptFile = TECH_LEAD_PROMPT_FILE,
    additionalContext,
  } = config;

  // Ensure orchestrator directory exists
  ensureOrchestratorDir();

  // Validate prompt file exists
  if (!fs.existsSync(promptFile)) {
    throw new TechLeadAgentError(`Tech Lead prompt file not found: ${promptFile}`);
  }

  // Read PRD and build context
  const prdContent = readPRDFile(prdFile);
  const context = buildTechLeadContext(prdContent, additionalContext);

  // Spawn Tech Lead agent in background mode
  return spawnAgent({
    name: "tech_lead",
    promptFile,
    context,
    stdio: "pipe",
  });
}

/**
 * Validate that the architecture file was properly created and has content
 */
export function validateArchitecture(
  architecturePath: string = ARCHITECTURE_OUTPUT_FILE
): { valid: boolean; error?: string } {
  if (!fs.existsSync(architecturePath)) {
    return { valid: false, error: "Architecture file not found" };
  }

  const content = fs.readFileSync(architecturePath, "utf-8");

  if (content.trim() === "") {
    return { valid: false, error: "Architecture file is empty" };
  }

  // Check for basic architecture structure (should have headings)
  if (!content.includes("#")) {
    return { valid: false, error: "Architecture file appears to be malformed (no headings)" };
  }

  return { valid: true };
}

/**
 * Parse GitHub issues into areas with their ticket numbers
 *
 * This fetches all area labels from GitHub and retrieves
 * the issues for each area. Used to populate DevSessions.
 *
 * @returns Promise that resolves with array of areas and their issues
 */
export async function parseAreasFromIssues(): Promise<AreaWithIssues[]> {
  const areas = await getAreas();
  const result: AreaWithIssues[] = [];

  for (const area of areas) {
    const issues = await getIssuesByArea(area);
    // Only include open issues
    const openIssues = issues.filter((issue) => issue.state === "open");

    if (openIssues.length > 0) {
      result.push({
        area,
        issues: openIssues,
        ticketNumbers: openIssues.map((issue) => issue.number),
      });
    }
  }

  return result;
}

/**
 * Convert parsed areas to DevSession format
 *
 * Helper to transform AreaWithIssues into the format
 * expected by the state machine's addDevSession.
 *
 * @param areasWithIssues - Parsed areas from GitHub
 * @returns Array of {area, tickets} for DevSession creation
 */
export function areasToDevSessionInput(
  areasWithIssues: AreaWithIssues[]
): Array<{ area: string; tickets: number[] }> {
  return areasWithIssues.map(({ area, ticketNumbers }) => ({
    area,
    tickets: ticketNumbers,
  }));
}
