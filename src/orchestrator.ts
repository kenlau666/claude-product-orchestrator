import { StateManager } from "./state";
import { Phase, DevSession, ORCHESTRATOR_DIR } from "./types";
import {
  BlockingHandler,
  parseQuestionFile,
  routeQuestion,
  findLatestUnansweredQuestion,
  writeResponse,
  readResponse,
} from "./blocking";
import { runPOAgent, POAgentResult } from "./agents/po";
import {
  runTechLeadAgent,
  parseAreasFromIssues,
  areasToDevSessionInput,
  TechLeadAgentResult,
} from "./agents/tech-lead";
import {
  spawnDevSessions,
  DevSessionHandle,
  DevAgentResult,
} from "./agents/dev";
import { AgentHandle } from "./agents/base";

/**
 * Orchestrator configuration
 */
export interface OrchestratorConfig {
  /** Whether to run in verbose mode */
  verbose?: boolean;
}

/**
 * Orchestrator result
 */
export interface OrchestratorResult {
  /** Final phase reached */
  finalPhase: Phase;
  /** Whether orchestration completed successfully */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/**
 * Active agent handles for cleanup
 */
interface ActiveHandles {
  devSessions: DevSessionHandle[];
}

/**
 * Main Orchestrator class
 *
 * Coordinates all agents and phases:
 * - init: Setup phase
 * - po_conversation: Interactive PO session (foreground)
 * - tech_lead_design: Tech Lead designs architecture (background)
 * - dev_sessions: Parallel Dev sessions (background)
 * - completed: All done
 */
export class Orchestrator {
  private stateManager: StateManager;
  private blockingHandler: BlockingHandler;
  private config: OrchestratorConfig;
  private isRunning: boolean = false;
  private activeHandles: ActiveHandles = { devSessions: [] };

  constructor(config: OrchestratorConfig = {}) {
    this.stateManager = new StateManager();
    this.blockingHandler = new BlockingHandler();
    this.config = config;
  }

  /**
   * Log message if verbose mode is enabled
   */
  private log(message: string): void {
    if (this.config.verbose) {
      console.log(`[orchestrator] ${message}`);
    }
  }

  /**
   * Log status message (always shown)
   */
  private status(message: string): void {
    console.log(message);
  }

  /**
   * Setup signal handlers for graceful shutdown
   */
  private setupSignalHandlers(): void {
    const shutdown = async (signal: string) => {
      this.status(`\nReceived ${signal}. Saving state and shutting down...`);
      await this.stop();
      process.exit(0);
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  }

  /**
   * Stop all running agents and save state
   */
  async stop(): Promise<void> {
    this.isRunning = false;

    // Kill all active Dev sessions
    for (const handle of this.activeHandles.devSessions) {
      this.log(`Killing dev session: ${handle.area}`);
      handle.agentHandle.kill();
    }

    // Clear active handles
    this.activeHandles.devSessions = [];

    // State is automatically saved by StateManager
    this.status("State saved. Run 'orchestrator resume' to continue.");
  }

  /**
   * Run the main orchestration loop
   */
  async run(): Promise<OrchestratorResult> {
    this.isRunning = true;
    this.setupSignalHandlers();

    this.status("Starting orchestration...");
    this.log(`Current phase: ${this.stateManager.getPhase()}`);

    try {
      while (this.isRunning && !this.stateManager.isComplete()) {
        const phase = this.stateManager.getPhase();
        this.log(`Executing phase: ${phase}`);

        switch (phase) {
          case "init":
            await this.initPhase();
            break;
          case "po_conversation":
            await this.poPhase();
            break;
          case "tech_lead_design":
            await this.techLeadPhase();
            break;
          case "dev_sessions":
            await this.devSessionsPhase();
            break;
          case "completed":
            // Should not reach here due to while condition
            break;
        }
      }

      if (this.stateManager.isComplete()) {
        this.status("Orchestration complete!");
        return {
          finalPhase: "completed",
          success: true,
        };
      }

      // Stopped before completion
      return {
        finalPhase: this.stateManager.getPhase(),
        success: false,
        error: "Orchestration stopped before completion",
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.status(`Orchestration error: ${errorMessage}`);
      return {
        finalPhase: this.stateManager.getPhase(),
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Resume orchestration from current state
   */
  async resume(): Promise<OrchestratorResult> {
    const phase = this.stateManager.getPhase();
    this.status(`Resuming orchestration from phase: ${phase}`);

    // Check if blocked and handle
    if (this.stateManager.isBlocked()) {
      await this.handleBlockedState();
    }

    return this.run();
  }

  /**
   * Init phase - transition to PO conversation
   */
  private async initPhase(): Promise<void> {
    this.status("Initializing orchestration...");
    this.stateManager.transitionTo("po_conversation");
    this.log("Transitioned to po_conversation phase");
  }

  /**
   * PO phase - interactive conversation (foreground)
   */
  private async poPhase(): Promise<void> {
    this.status("\n=== PO Conversation ===");
    this.status("Starting interactive PO session...");
    this.status("(PO will ask clarifying questions to build the PRD)\n");

    this.stateManager.setCurrentAgent("po");

    try {
      const result: POAgentResult = await runPOAgent();

      if (result.status === "success" && result.prdCreated) {
        this.status("\nPRD created successfully!");
        this.stateManager.setCurrentAgent(null);
        this.stateManager.transitionTo("tech_lead_design");
        this.log("Transitioned to tech_lead_design phase");
      } else if (result.status === "blocked") {
        this.status("\nPO is blocked and needs user input.");
        await this.handleBlockingForAgent("po");
      } else {
        throw new Error("PO agent failed to complete. Check logs for details.");
      }
    } catch (error) {
      this.stateManager.setCurrentAgent(null);
      throw error;
    }
  }

  /**
   * Tech Lead phase - design and create tickets (background)
   */
  private async techLeadPhase(): Promise<void> {
    this.status("\n=== Tech Lead Design ===");
    this.status("Tech Lead is designing architecture and creating tickets...");
    this.status("(This runs in the background)\n");

    this.stateManager.setCurrentAgent("tech_lead");

    try {
      const result: TechLeadAgentResult = await runTechLeadAgent();

      if (result.status === "success" && result.architectureCreated) {
        this.status("Architecture created successfully!");

        // Parse issues and create dev sessions
        this.status("Parsing GitHub issues for dev sessions...");
        const areasWithIssues = await parseAreasFromIssues();
        const sessionInputs = areasToDevSessionInput(areasWithIssues);

        if (sessionInputs.length === 0) {
          this.status("No issues found with area labels. Skipping dev sessions.");
        } else {
          for (const input of sessionInputs) {
            this.stateManager.addDevSession(input.area, input.tickets);
            this.status(`  Added dev session: ${input.area} (${input.tickets.length} tickets)`);
          }
        }

        this.stateManager.setCurrentAgent(null);
        this.stateManager.transitionTo("dev_sessions");
        this.log("Transitioned to dev_sessions phase");
      } else if (result.status === "blocked") {
        this.status("\nTech Lead is blocked and needs clarification.");
        await this.handleBlockingForAgent("tech_lead");
      } else {
        throw new Error("Tech Lead agent failed. Check logs for details.");
      }
    } catch (error) {
      this.stateManager.setCurrentAgent(null);
      throw error;
    }
  }

  /**
   * Dev Sessions phase - parallel dev work (background)
   */
  private async devSessionsPhase(): Promise<void> {
    this.status("\n=== Dev Sessions ===");

    const pendingSessions = this.stateManager.getDevSessionsByStatus("pending");
    const runningSessions = this.stateManager.getDevSessionsByStatus("running");

    if (pendingSessions.length === 0 && runningSessions.length === 0) {
      this.status("No dev sessions to run. Completing orchestration.");
      this.stateManager.transitionTo("completed");
      return;
    }

    // Start pending sessions
    if (pendingSessions.length > 0) {
      this.status(`Starting ${pendingSessions.length} dev session(s) in parallel...`);

      const sessionInputs = pendingSessions.map((s) => ({
        area: s.area,
        tickets: s.tickets,
      }));

      // Mark sessions as running
      for (const session of pendingSessions) {
        this.stateManager.updateDevSession(session.area, { status: "running" });
      }

      // Spawn dev sessions
      this.activeHandles.devSessions = spawnDevSessions(sessionInputs);

      for (const handle of this.activeHandles.devSessions) {
        this.status(`  Started: dev-${handle.area}`);
      }
    }

    // Wait for sessions and handle blocking
    await this.monitorDevSessions();
  }

  /**
   * Monitor running dev sessions and handle blocking
   */
  private async monitorDevSessions(): Promise<void> {
    const handles = this.activeHandles.devSessions;

    if (handles.length === 0) {
      // Check if all sessions completed
      const allSessions = this.stateManager.getState().devSessions;
      const allCompleted = allSessions.every((s) => s.status === "completed");

      if (allCompleted) {
        this.status("All dev sessions completed!");
        this.stateManager.transitionTo("completed");
      }
      return;
    }

    this.status("Monitoring dev sessions... (run 'orchestrator status' to check progress)");

    // Wait for any session to complete
    const results = await Promise.all(handles.map((h) => h.result));

    // Process results
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const handle = handles[i];

      if (result.status === "success") {
        this.status(`Dev session completed: ${result.area}`);
        this.stateManager.updateDevSession(result.area, { status: "completed" });
      } else if (result.status === "blocked") {
        this.status(`Dev session blocked: ${result.area}`);
        this.stateManager.updateDevSession(result.area, { status: "blocked" });

        // Handle blocking
        if (result.questionFile) {
          await this.handleBlockingQuestion(result.questionFile, `dev-${result.area}`);
          // Mark as pending to retry
          this.stateManager.updateDevSession(result.area, { status: "pending" });
        }
      } else {
        this.status(`Dev session error: ${result.area}`);
        // Keep as running, may need manual intervention
      }
    }

    // Clear completed handles
    this.activeHandles.devSessions = [];

    // Check if there are more sessions to run or if all completed
    const remainingSessions = this.stateManager
      .getState()
      .devSessions.filter((s) => s.status !== "completed");

    if (remainingSessions.length === 0) {
      this.status("All dev sessions completed!");
      this.stateManager.transitionTo("completed");
    } else {
      // Recursively continue with remaining sessions
      this.log(`${remainingSessions.length} session(s) remaining`);
    }
  }

  /**
   * Handle blocking for a specific agent
   */
  private async handleBlockingForAgent(
    agentType: "po" | "tech_lead" | "dev"
  ): Promise<void> {
    const questionFile = findLatestUnansweredQuestion();

    if (!questionFile) {
      this.log("No question file found for blocking");
      return;
    }

    await this.handleBlockingQuestion(questionFile, agentType);
  }

  /**
   * Handle a blocking question
   */
  private async handleBlockingQuestion(
    questionFile: string,
    agentName: string
  ): Promise<void> {
    const parsedQuestion = parseQuestionFile(questionFile);
    const routing = routeQuestion(parsedQuestion);

    this.log(`Question routing: ${routing}`);

    switch (routing) {
      case "prompt_user":
        this.stateManager.setBlocked(
          this.getBlockedAgentType(agentName),
          questionFile,
          "user"
        );

        // Prompt user directly
        const result = await this.blockingHandler.processQuestion(questionFile);
        if (result.response) {
          this.status(`Answer recorded. Resuming ${agentName}...`);
          this.stateManager.clearBlocked();
        }
        break;

      case "spawn_po":
        this.status("Routing question to PO for clarification...");
        this.stateManager.setBlocked(
          this.getBlockedAgentType(agentName),
          questionFile,
          "po"
        );
        // PO will answer during next po_conversation phase
        // For now, prompt user as fallback
        const poResult = await this.blockingHandler.processQuestion(questionFile);
        if (poResult.response) {
          this.stateManager.clearBlocked();
        }
        break;

      case "spawn_tech_lead":
        this.status("Routing question to Tech Lead...");
        this.stateManager.setBlocked(
          this.getBlockedAgentType(agentName),
          questionFile,
          "tech_lead"
        );
        // Tech Lead will answer
        // For now, prompt user as fallback
        const tlResult = await this.blockingHandler.processQuestion(questionFile);
        if (tlResult.response) {
          this.stateManager.clearBlocked();
        }
        break;
    }
  }

  /**
   * Handle blocked state on resume
   */
  private async handleBlockedState(): Promise<void> {
    const state = this.stateManager.getState();
    const { questionFile, waitingFor } = state.blocked;

    if (!questionFile) {
      this.stateManager.clearBlocked();
      return;
    }

    // Check if already answered
    const response = readResponse(questionFile);
    if (response) {
      this.status("Previous question already answered. Continuing...");
      this.stateManager.clearBlocked();
      return;
    }

    this.status(`Blocked state detected. Waiting for: ${waitingFor}`);

    // Handle based on who we're waiting for
    if (waitingFor === "user") {
      const result = await this.blockingHandler.processQuestion(questionFile);
      if (result.response) {
        this.stateManager.clearBlocked();
      }
    } else {
      // For PO/Tech Lead routing, prompt user as fallback
      const result = await this.blockingHandler.processQuestion(questionFile);
      if (result.response) {
        this.stateManager.clearBlocked();
      }
    }
  }

  /**
   * Get blocked agent type from agent name
   */
  private getBlockedAgentType(
    agentName: string
  ): "po" | "tech_lead" | "dev" | null {
    if (agentName === "po") return "po";
    if (agentName === "tech_lead") return "tech_lead";
    if (agentName.startsWith("dev")) return "dev";
    return null;
  }

  /**
   * Get current state (for status display)
   */
  getState() {
    return this.stateManager.getState();
  }
}

/**
 * Run orchestration (convenience function)
 */
export async function runOrchestration(
  config?: OrchestratorConfig
): Promise<OrchestratorResult> {
  const orchestrator = new Orchestrator(config);
  return orchestrator.run();
}

/**
 * Resume orchestration (convenience function)
 */
export async function resumeOrchestration(
  config?: OrchestratorConfig
): Promise<OrchestratorResult> {
  const orchestrator = new Orchestrator(config);
  return orchestrator.resume();
}

/**
 * Stop orchestration (convenience function)
 */
export async function stopOrchestration(): Promise<void> {
  const orchestrator = new Orchestrator();
  return orchestrator.stop();
}
