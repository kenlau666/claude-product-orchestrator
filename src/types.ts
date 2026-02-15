/**
 * Shared types for the AI Orchestrator
 */

/**
 * Orchestration phases
 */
export type Phase =
  | "init"
  | "po_conversation"
  | "tech_lead_design"
  | "dev_sessions"
  | "completed";

/**
 * Blocked state information
 */
export interface BlockedState {
  isBlocked: boolean;
  blockedAgent: "po" | "tech_lead" | "dev" | null;
  questionFile: string | null;
  waitingFor: "user" | "po" | "tech_lead" | null;
}

/**
 * Dev session tracking
 */
export interface DevSession {
  area: string;
  tickets: number[];
  status: "pending" | "running" | "blocked" | "completed";
}

/**
 * Main orchestrator state
 */
export interface State {
  phase: Phase;
  blocked: BlockedState;
  devSessions: DevSession[];
  currentAgent: string | null;
  lastUpdated: string;
}

/**
 * Orchestrator configuration
 */
export interface Config {
  repoUrl: string;
  token: string;
  createdAt: string;
}

/**
 * Directory constants
 */
export const ORCHESTRATOR_DIR = ".orchestrator";
export const CONFIG_FILE = `${ORCHESTRATOR_DIR}/config.json`;
export const STATE_FILE = `${ORCHESTRATOR_DIR}/state.json`;
