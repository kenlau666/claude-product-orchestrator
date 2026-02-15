import * as fs from "fs";
import * as path from "path";
import {
  State,
  Phase,
  BlockedState,
  DevSession,
  ORCHESTRATOR_DIR,
  STATE_FILE,
} from "./types";

/**
 * Valid phase transitions map
 * Each phase maps to the phases it can transition to
 */
const VALID_TRANSITIONS: Record<Phase, Phase[]> = {
  init: ["po_conversation"],
  po_conversation: ["tech_lead_design"],
  tech_lead_design: ["dev_sessions"],
  dev_sessions: ["completed"],
  completed: [],
};

/**
 * Error thrown for invalid state operations
 */
export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}

/**
 * Create a default initial state
 */
export function createInitialState(): State {
  return {
    phase: "init",
    blocked: {
      isBlocked: false,
      blockedAgent: null,
      questionFile: null,
      waitingFor: null,
    },
    devSessions: [],
    currentAgent: null,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Load state from the state file
 * Returns null if the file doesn't exist
 */
export function loadState(): State | null {
  if (!fs.existsSync(STATE_FILE)) {
    return null;
  }

  const content = fs.readFileSync(STATE_FILE, "utf-8");
  return JSON.parse(content) as State;
}

/**
 * Save state to the state file using atomic write pattern
 * Uses temp file + rename to ensure crash safety
 */
export function saveState(state: State): void {
  // Ensure directory exists
  if (!fs.existsSync(ORCHESTRATOR_DIR)) {
    fs.mkdirSync(ORCHESTRATOR_DIR, { recursive: true });
  }

  // Update timestamp
  state.lastUpdated = new Date().toISOString();

  // Atomic write: write to temp file, then rename
  const tempFile = `${STATE_FILE}.tmp.${Date.now()}`;
  const content = JSON.stringify(state, null, 2);

  fs.writeFileSync(tempFile, content, { encoding: "utf-8" });
  fs.renameSync(tempFile, STATE_FILE);
}

/**
 * Check if a phase transition is valid
 */
export function isValidTransition(from: Phase, to: Phase): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

/**
 * Transition to a new phase
 * Throws StateError if the transition is invalid
 */
export function transitionPhase(state: State, newPhase: Phase): State {
  if (!isValidTransition(state.phase, newPhase)) {
    throw new StateError(
      `Invalid phase transition: ${state.phase} -> ${newPhase}. ` +
        `Valid transitions from ${state.phase}: ${VALID_TRANSITIONS[state.phase].join(", ") || "none"}`
    );
  }

  return {
    ...state,
    phase: newPhase,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Set the blocked state
 */
export function setBlocked(
  state: State,
  blockedAgent: BlockedState["blockedAgent"],
  questionFile: string,
  waitingFor: BlockedState["waitingFor"]
): State {
  return {
    ...state,
    blocked: {
      isBlocked: true,
      blockedAgent,
      questionFile,
      waitingFor,
    },
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Clear the blocked state
 */
export function clearBlocked(state: State): State {
  return {
    ...state,
    blocked: {
      isBlocked: false,
      blockedAgent: null,
      questionFile: null,
      waitingFor: null,
    },
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Set the current agent
 */
export function setCurrentAgent(state: State, agent: string | null): State {
  return {
    ...state,
    currentAgent: agent,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Add a new dev session
 */
export function addDevSession(
  state: State,
  area: string,
  tickets: number[]
): State {
  // Check if session with this area already exists
  const existingIndex = state.devSessions.findIndex((s) => s.area === area);
  if (existingIndex !== -1) {
    throw new StateError(`Dev session for area "${area}" already exists`);
  }

  const newSession: DevSession = {
    area,
    tickets,
    status: "pending",
  };

  return {
    ...state,
    devSessions: [...state.devSessions, newSession],
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Update a dev session by area
 */
export function updateDevSession(
  state: State,
  area: string,
  updates: Partial<Pick<DevSession, "tickets" | "status">>
): State {
  const sessionIndex = state.devSessions.findIndex((s) => s.area === area);
  if (sessionIndex === -1) {
    throw new StateError(`Dev session for area "${area}" not found`);
  }

  const updatedSessions = [...state.devSessions];
  updatedSessions[sessionIndex] = {
    ...updatedSessions[sessionIndex],
    ...updates,
  };

  return {
    ...state,
    devSessions: updatedSessions,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Remove a dev session by area
 */
export function removeDevSession(state: State, area: string): State {
  const sessionIndex = state.devSessions.findIndex((s) => s.area === area);
  if (sessionIndex === -1) {
    throw new StateError(`Dev session for area "${area}" not found`);
  }

  return {
    ...state,
    devSessions: state.devSessions.filter((s) => s.area !== area),
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Get a dev session by area
 */
export function getDevSession(state: State, area: string): DevSession | null {
  return state.devSessions.find((s) => s.area === area) || null;
}

/**
 * Get all dev sessions with a specific status
 */
export function getDevSessionsByStatus(
  state: State,
  status: DevSession["status"]
): DevSession[] {
  return state.devSessions.filter((s) => s.status === status);
}

/**
 * StateManager class for convenient state management
 * Automatically persists state after each operation
 */
export class StateManager {
  private state: State;

  constructor(state?: State) {
    this.state = state || loadState() || createInitialState();
  }

  /**
   * Get the current state (read-only copy)
   */
  getState(): Readonly<State> {
    return { ...this.state };
  }

  /**
   * Save current state to disk
   */
  save(): void {
    saveState(this.state);
  }

  /**
   * Transition to a new phase and save
   */
  transitionTo(newPhase: Phase): void {
    this.state = transitionPhase(this.state, newPhase);
    this.save();
  }

  /**
   * Set blocked state and save
   */
  setBlocked(
    blockedAgent: BlockedState["blockedAgent"],
    questionFile: string,
    waitingFor: BlockedState["waitingFor"]
  ): void {
    this.state = setBlocked(this.state, blockedAgent, questionFile, waitingFor);
    this.save();
  }

  /**
   * Clear blocked state and save
   */
  clearBlocked(): void {
    this.state = clearBlocked(this.state);
    this.save();
  }

  /**
   * Set current agent and save
   */
  setCurrentAgent(agent: string | null): void {
    this.state = setCurrentAgent(this.state, agent);
    this.save();
  }

  /**
   * Add a dev session and save
   */
  addDevSession(area: string, tickets: number[]): void {
    this.state = addDevSession(this.state, area, tickets);
    this.save();
  }

  /**
   * Update a dev session and save
   */
  updateDevSession(
    area: string,
    updates: Partial<Pick<DevSession, "tickets" | "status">>
  ): void {
    this.state = updateDevSession(this.state, area, updates);
    this.save();
  }

  /**
   * Remove a dev session and save
   */
  removeDevSession(area: string): void {
    this.state = removeDevSession(this.state, area);
    this.save();
  }

  /**
   * Get a dev session by area
   */
  getDevSession(area: string): DevSession | null {
    return getDevSession(this.state, area);
  }

  /**
   * Get all dev sessions with a specific status
   */
  getDevSessionsByStatus(status: DevSession["status"]): DevSession[] {
    return getDevSessionsByStatus(this.state, status);
  }

  /**
   * Check if currently blocked
   */
  isBlocked(): boolean {
    return this.state.blocked.isBlocked;
  }

  /**
   * Get current phase
   */
  getPhase(): Phase {
    return this.state.phase;
  }

  /**
   * Check if orchestration is complete
   */
  isComplete(): boolean {
    return this.state.phase === "completed";
  }
}
