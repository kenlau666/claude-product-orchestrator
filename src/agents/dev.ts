import * as fs from "fs";
import * as path from "path";
import { spawnAgent, runAgent, AgentResult, AgentHandle, isSuccess, isBlocked, isError } from "./base";
import { ORCHESTRATOR_DIR } from "../types";
import { findLatestUnansweredQuestion, parseQuestionFile, routeQuestion } from "../blocking";

/**
 * Dev Agent constants
 */
export const DEV_PROMPT_FILE = "prompts/dev.md";
export const PRD_FILE = path.join(ORCHESTRATOR_DIR, "prd.md");
export const ARCHITECTURE_FILE = path.join(ORCHESTRATOR_DIR, "architecture.md");

/**
 * Configuration for running a Dev agent
 */
export interface DevAgentConfig {
  /** Area this Dev session handles (e.g., "frontend", "backend") */
  area: string;
  /** Ticket numbers assigned to this Dev session */
  tickets: number[];
  /** Path to PRD file (defaults to ".orchestrator/prd.md") */
  prdFile?: string;
  /** Path to architecture file (defaults to ".orchestrator/architecture.md") */
  architectureFile?: string;
  /** Path to Dev prompt file (defaults to "prompts/dev.md") */
  promptFile?: string;
  /** Additional context to pass to Dev */
  additionalContext?: string;
}

/**
 * Result from Dev agent execution
 */
export interface DevAgentResult {
  /** The area this Dev session handled */
  area: string;
  /** The underlying agent result */
  agentResult: AgentResult;
  /** Status: "success" | "blocked" | "error" */
  status: "success" | "blocked" | "error";
  /** Question file path if blocked */
  questionFile: string | null;
  /** Whether the question is for Tech Lead */
  needsTechLead: boolean;
}

/**
 * Handle to a running Dev agent
 */
export interface DevSessionHandle {
  /** The area this Dev session handles */
  area: string;
  /** The underlying agent handle */
  agentHandle: AgentHandle;
  /** Ticket numbers assigned to this session */
  tickets: number[];
  /** Promise that resolves with the Dev agent result */
  result: Promise<DevAgentResult>;
}

/**
 * Error thrown for Dev agent operations
 */
export class DevAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevAgentError";
  }
}

/**
 * Read PRD file content
 * @throws DevAgentError if PRD doesn't exist
 */
export function readPRDFile(prdFile: string = PRD_FILE): string {
  if (!fs.existsSync(prdFile)) {
    throw new DevAgentError(`PRD file not found: ${prdFile}`);
  }
  return fs.readFileSync(prdFile, "utf-8");
}

/**
 * Read architecture file content
 * @throws DevAgentError if architecture file doesn't exist
 */
export function readArchitectureFile(architectureFile: string = ARCHITECTURE_FILE): string {
  if (!fs.existsSync(architectureFile)) {
    throw new DevAgentError(`Architecture file not found: ${architectureFile}`);
  }
  return fs.readFileSync(architectureFile, "utf-8");
}

/**
 * Build context for Dev agent from area, PRD, architecture, and tickets
 */
export function buildDevContext(
  area: string,
  tickets: number[],
  prdContent: string,
  architectureContent: string,
  additionalContext?: string
): string {
  const parts: string[] = [];

  parts.push("# Your Assignment");
  parts.push("");
  parts.push(`Area: ${area}`);
  parts.push(`Tickets: ${tickets.map((t) => `#${t}`).join(", ")}`);

  parts.push("");
  parts.push("# PRD (Product Requirements Document)");
  parts.push("");
  parts.push(prdContent);

  parts.push("");
  parts.push("# Architecture");
  parts.push("");
  parts.push(architectureContent);

  if (additionalContext && additionalContext.trim() !== "") {
    parts.push("");
    parts.push("# Additional Context");
    parts.push("");
    parts.push(additionalContext);
  }

  return parts.join("\n");
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
 * Check if a blocked Dev needs Tech Lead
 * Returns the question file and routing info
 */
export function checkBlockingForTechLead(): {
  questionFile: string | null;
  needsTechLead: boolean;
} {
  const questionFile = findLatestUnansweredQuestion();

  if (!questionFile) {
    return { questionFile: null, needsTechLead: false };
  }

  const parsedQuestion = parseQuestionFile(questionFile);
  const routing = routeQuestion(parsedQuestion);

  return {
    questionFile,
    needsTechLead: routing === "spawn_tech_lead",
  };
}

/**
 * Convert agent result to Dev agent result
 */
function toDevAgentResult(
  area: string,
  agentResult: AgentResult
): DevAgentResult {
  let status: DevAgentResult["status"];
  let questionFile: string | null = null;
  let needsTechLead = false;

  if (isSuccess(agentResult)) {
    status = "success";
  } else if (isBlocked(agentResult)) {
    status = "blocked";
    const blockingInfo = checkBlockingForTechLead();
    questionFile = blockingInfo.questionFile;
    needsTechLead = blockingInfo.needsTechLead;
  } else {
    status = "error";
  }

  return {
    area,
    agentResult,
    status,
    questionFile,
    needsTechLead,
  };
}

/**
 * Run a Dev agent for a specific area
 *
 * Spawns a Dev agent in background mode (stdio: "pipe").
 * The Dev reads the PRD, architecture, and ticket list, then implements.
 *
 * @param config - Dev agent configuration
 * @returns Promise that resolves with the Dev agent result
 *
 * @example
 * const result = await runDevAgent({
 *   area: "frontend",
 *   tickets: [10, 11, 12]
 * });
 * if (result.status === "blocked" && result.needsTechLead) {
 *   // Route to Tech Lead
 * }
 */
export async function runDevAgent(
  config: DevAgentConfig
): Promise<DevAgentResult> {
  const {
    area,
    tickets,
    prdFile = PRD_FILE,
    architectureFile = ARCHITECTURE_FILE,
    promptFile = DEV_PROMPT_FILE,
    additionalContext,
  } = config;

  // Validate configuration
  if (!area || area.trim() === "") {
    throw new DevAgentError("Area is required");
  }

  if (!tickets || tickets.length === 0) {
    throw new DevAgentError("At least one ticket is required");
  }

  // Ensure orchestrator directory exists
  ensureOrchestratorDir();

  // Validate prompt file exists
  if (!fs.existsSync(promptFile)) {
    throw new DevAgentError(`Dev prompt file not found: ${promptFile}`);
  }

  // Read PRD and architecture, build context
  const prdContent = readPRDFile(prdFile);
  const architectureContent = readArchitectureFile(architectureFile);
  const context = buildDevContext(area, tickets, prdContent, architectureContent, additionalContext);

  // Run Dev agent in background mode (capture output)
  const agentResult = await runAgent({
    name: `dev-${area}`,
    promptFile,
    context,
    stdio: "pipe",
  });

  return toDevAgentResult(area, agentResult);
}

/**
 * Spawn a Dev agent without waiting for completion
 *
 * Returns a handle that can be used to monitor or kill the process.
 * Useful for running multiple Dev sessions in parallel.
 *
 * @param config - Dev agent configuration
 * @returns Dev session handle with process and result promise
 *
 * @example
 * // Spawn multiple Dev sessions in parallel
 * const handles = areas.map(area => spawnDevAgent({ area, tickets: [...] }));
 * const results = await Promise.all(handles.map(h => h.result));
 */
export function spawnDevAgent(config: DevAgentConfig): DevSessionHandle {
  const {
    area,
    tickets,
    prdFile = PRD_FILE,
    architectureFile = ARCHITECTURE_FILE,
    promptFile = DEV_PROMPT_FILE,
    additionalContext,
  } = config;

  // Validate configuration
  if (!area || area.trim() === "") {
    throw new DevAgentError("Area is required");
  }

  if (!tickets || tickets.length === 0) {
    throw new DevAgentError("At least one ticket is required");
  }

  // Ensure orchestrator directory exists
  ensureOrchestratorDir();

  // Validate prompt file exists
  if (!fs.existsSync(promptFile)) {
    throw new DevAgentError(`Dev prompt file not found: ${promptFile}`);
  }

  // Read PRD and architecture, build context
  const prdContent = readPRDFile(prdFile);
  const architectureContent = readArchitectureFile(architectureFile);
  const context = buildDevContext(area, tickets, prdContent, architectureContent, additionalContext);

  // Spawn Dev agent in background mode
  const agentHandle = spawnAgent({
    name: `dev-${area}`,
    promptFile,
    context,
    stdio: "pipe",
  });

  // Create result promise that wraps the agent result
  const result = agentHandle.result.then((agentResult) =>
    toDevAgentResult(area, agentResult)
  );

  return {
    area,
    agentHandle,
    tickets,
    result,
  };
}

/**
 * Input for running multiple Dev sessions
 */
export interface DevSessionInput {
  area: string;
  tickets: number[];
}

/**
 * Options for running multiple Dev sessions
 */
export interface RunDevSessionsOptions {
  /** Whether to run sessions in parallel (default: true) */
  parallel?: boolean;
  /** Path to PRD file */
  prdFile?: string;
  /** Path to architecture file */
  architectureFile?: string;
  /** Path to Dev prompt file */
  promptFile?: string;
}

/**
 * Run multiple Dev sessions
 *
 * Spawns Dev agents for each area. By default runs in parallel.
 *
 * @param sessions - Array of session inputs with area and tickets
 * @param options - Options for running sessions
 * @returns Promise that resolves with array of Dev agent results
 *
 * @example
 * const results = await runDevSessions([
 *   { area: "frontend", tickets: [10, 11] },
 *   { area: "backend", tickets: [12, 13] }
 * ]);
 *
 * // Check for any blocked sessions needing Tech Lead
 * const blockedForTechLead = results.filter(r =>
 *   r.status === "blocked" && r.needsTechLead
 * );
 */
export async function runDevSessions(
  sessions: DevSessionInput[],
  options: RunDevSessionsOptions = {}
): Promise<DevAgentResult[]> {
  const {
    parallel = true,
    prdFile,
    architectureFile,
    promptFile,
  } = options;

  if (sessions.length === 0) {
    return [];
  }

  if (parallel) {
    // Spawn all sessions and wait for all to complete
    const handles = sessions.map((session) =>
      spawnDevAgent({
        area: session.area,
        tickets: session.tickets,
        prdFile,
        architectureFile,
        promptFile,
      })
    );

    return Promise.all(handles.map((h) => h.result));
  } else {
    // Run sessions sequentially
    const results: DevAgentResult[] = [];
    for (const session of sessions) {
      const result = await runDevAgent({
        area: session.area,
        tickets: session.tickets,
        prdFile,
        architectureFile,
        promptFile,
      });
      results.push(result);
    }
    return results;
  }
}

/**
 * Spawn multiple Dev sessions without waiting
 *
 * Returns handles for all sessions that can be individually monitored.
 *
 * @param sessions - Array of session inputs
 * @param options - Options for spawning sessions
 * @returns Array of Dev session handles
 */
export function spawnDevSessions(
  sessions: DevSessionInput[],
  options: RunDevSessionsOptions = {}
): DevSessionHandle[] {
  const { prdFile, architectureFile, promptFile } = options;

  return sessions.map((session) =>
    spawnDevAgent({
      area: session.area,
      tickets: session.tickets,
      prdFile,
      architectureFile,
      promptFile,
    })
  );
}

/**
 * Get the first blocked session that needs Tech Lead intervention
 */
export function getBlockedSessionForTechLead(
  results: DevAgentResult[]
): DevAgentResult | null {
  return results.find((r) => r.status === "blocked" && r.needsTechLead) || null;
}

/**
 * Check if all sessions completed successfully
 */
export function allSessionsCompleted(results: DevAgentResult[]): boolean {
  return results.every((r) => r.status === "success");
}

/**
 * Get sessions by status
 */
export function getSessionsByStatus(
  results: DevAgentResult[],
  status: DevAgentResult["status"]
): DevAgentResult[] {
  return results.filter((r) => r.status === status);
}
