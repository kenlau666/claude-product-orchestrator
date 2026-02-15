import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import { ChildProcess } from "child_process";
import {
  DevAgentConfig,
  DevAgentError,
  DevAgentResult,
  DEV_PROMPT_FILE,
  PRD_FILE,
  ARCHITECTURE_FILE,
  readPRDFile,
  readArchitectureFile,
  buildDevContext,
  checkBlockingForTechLead,
  runDevAgent,
  spawnDevAgent,
  runDevSessions,
  spawnDevSessions,
  getBlockedSessionForTechLead,
  allSessionsCompleted,
  getSessionsByStatus,
} from "../../src/agents/dev";
import { EXIT_CODES } from "../../src/blocking";

// Test directory for isolation
const TEST_DIR = path.join(__dirname, ".test-dev-agent");
const TEST_PROMPTS_DIR = path.join(TEST_DIR, "prompts");
const TEST_ORCHESTRATOR_DIR = path.join(TEST_DIR, ".orchestrator");
const TEST_QUESTIONS_DIR = path.join(TEST_ORCHESTRATOR_DIR, "questions");

// Mock child_process
jest.mock("child_process", () => {
  const originalModule = jest.requireActual("child_process");
  return {
    ...originalModule,
    spawn: jest.fn(),
  };
});

// Mock types to use test directory
jest.mock("../../src/types", () => {
  const originalModule = jest.requireActual("../../src/types");
  const testDir = require("path").join(__dirname, ".test-dev-agent");
  return {
    ...originalModule,
    ORCHESTRATOR_DIR: require("path").join(testDir, ".orchestrator"),
  };
});

// Mock blocking module for question routing tests
jest.mock("../../src/blocking", () => {
  const originalModule = jest.requireActual("../../src/blocking");
  return {
    ...originalModule,
    findLatestUnansweredQuestion: jest.fn(),
    parseQuestionFile: jest.fn(),
    routeQuestion: jest.fn(),
  };
});

// Get the mocked spawn
import { spawn as mockSpawn } from "child_process";
const mockedSpawn = mockSpawn as jest.MockedFunction<typeof mockSpawn>;

// Get mocked blocking functions
import {
  findLatestUnansweredQuestion,
  parseQuestionFile,
  routeQuestion,
} from "../../src/blocking";
const mockedFindLatestUnansweredQuestion = findLatestUnansweredQuestion as jest.MockedFunction<
  typeof findLatestUnansweredQuestion
>;
const mockedParseQuestionFile = parseQuestionFile as jest.MockedFunction<
  typeof parseQuestionFile
>;
const mockedRouteQuestion = routeQuestion as jest.MockedFunction<
  typeof routeQuestion
>;

// Helper to create a mock child process
function createMockProcess(exitCode: number = 0): ChildProcess {
  const process = new EventEmitter() as ChildProcess;
  (process as any).stdout = new EventEmitter();
  (process as any).stderr = new EventEmitter();
  (process as any).killed = false;
  (process as any).pid = 12345;

  (process as any).kill = jest.fn((signal?: string) => {
    (process as any).killed = true;
    process.emit("close", null, signal || "SIGTERM");
    return true;
  });

  // Emit close after a tick
  setImmediate(() => {
    if (!(process as any).killed) {
      process.emit("close", exitCode, null);
    }
  });

  return process;
}

describe("Dev Agent", () => {
  beforeEach(() => {
    // Clean up and create test directory
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
    fs.mkdirSync(TEST_PROMPTS_DIR, { recursive: true });
    fs.mkdirSync(TEST_ORCHESTRATOR_DIR, { recursive: true });
    fs.mkdirSync(TEST_QUESTIONS_DIR, { recursive: true });

    // Reset mocks
    mockedSpawn.mockReset();
    mockedFindLatestUnansweredQuestion.mockReset();
    mockedParseQuestionFile.mockReset();
    mockedRouteQuestion.mockReset();
  });

  afterAll(() => {
    // Clean up test directory
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("readPRDFile", () => {
    it("should read PRD content", () => {
      const prdPath = path.join(TEST_ORCHESTRATOR_DIR, "prd.md");
      fs.writeFileSync(prdPath, "# PRD\n\n## Features");

      const content = readPRDFile(prdPath);

      expect(content).toBe("# PRD\n\n## Features");
    });

    it("should throw DevAgentError if PRD not found", () => {
      expect(() => readPRDFile("/nonexistent/prd.md")).toThrow(DevAgentError);
      expect(() => readPRDFile("/nonexistent/prd.md")).toThrow(
        "PRD file not found"
      );
    });
  });

  describe("readArchitectureFile", () => {
    it("should read architecture content", () => {
      const archPath = path.join(TEST_ORCHESTRATOR_DIR, "architecture.md");
      fs.writeFileSync(archPath, "# Architecture\n\n## Components");

      const content = readArchitectureFile(archPath);

      expect(content).toBe("# Architecture\n\n## Components");
    });

    it("should throw DevAgentError if architecture not found", () => {
      expect(() => readArchitectureFile("/nonexistent/architecture.md")).toThrow(
        DevAgentError
      );
      expect(() => readArchitectureFile("/nonexistent/architecture.md")).toThrow(
        "Architecture file not found"
      );
    });
  });

  describe("buildDevContext", () => {
    it("should build context with area, tickets, PRD, and architecture", () => {
      const context = buildDevContext(
        "frontend",
        [10, 11, 12],
        "# PRD Content",
        "# Arch Content"
      );

      expect(context).toContain("# Your Assignment");
      expect(context).toContain("Area: frontend");
      expect(context).toContain("Tickets: #10, #11, #12");
      expect(context).toContain("# PRD (Product Requirements Document)");
      expect(context).toContain("# PRD Content");
      expect(context).toContain("# Architecture");
      expect(context).toContain("# Arch Content");
      expect(context).not.toContain("# Additional Context");
    });

    it("should include additional context when provided", () => {
      const context = buildDevContext(
        "backend",
        [20],
        "PRD",
        "Arch",
        "Extra instructions"
      );

      expect(context).toContain("# Additional Context");
      expect(context).toContain("Extra instructions");
    });

    it("should ignore empty additional context", () => {
      const context = buildDevContext("api", [1], "PRD", "Arch", "   ");

      expect(context).not.toContain("# Additional Context");
    });
  });

  describe("checkBlockingForTechLead", () => {
    it("should return needsTechLead true when question routes to tech_lead", () => {
      const questionFile = path.join(TEST_QUESTIONS_DIR, "q-001.md");
      mockedFindLatestUnansweredQuestion.mockReturnValue(questionFile);
      mockedParseQuestionFile.mockReturnValue({
        filePath: questionFile,
        fromAgent: "dev-frontend",
        forRecipient: "tech_lead",
        context: "",
        question: "How to structure?",
        options: [],
        rawContent: "",
      });
      mockedRouteQuestion.mockReturnValue("spawn_tech_lead");

      const result = checkBlockingForTechLead();

      expect(result.questionFile).toBe(questionFile);
      expect(result.needsTechLead).toBe(true);
    });

    it("should return needsTechLead false when question routes to user", () => {
      const questionFile = path.join(TEST_QUESTIONS_DIR, "q-002.md");
      mockedFindLatestUnansweredQuestion.mockReturnValue(questionFile);
      mockedParseQuestionFile.mockReturnValue({
        filePath: questionFile,
        fromAgent: "dev-frontend",
        forRecipient: "user",
        context: "",
        question: "Which approach?",
        options: [],
        rawContent: "",
      });
      mockedRouteQuestion.mockReturnValue("prompt_user");

      const result = checkBlockingForTechLead();

      expect(result.questionFile).toBe(questionFile);
      expect(result.needsTechLead).toBe(false);
    });

    it("should return null questionFile when no unanswered questions", () => {
      mockedFindLatestUnansweredQuestion.mockReturnValue(null);

      const result = checkBlockingForTechLead();

      expect(result.questionFile).toBeNull();
      expect(result.needsTechLead).toBe(false);
    });
  });

  describe("runDevAgent", () => {
    const setupTestFiles = () => {
      const promptPath = path.join(TEST_PROMPTS_DIR, "dev.md");
      const prdPath = path.join(TEST_ORCHESTRATOR_DIR, "prd.md");
      const archPath = path.join(TEST_ORCHESTRATOR_DIR, "architecture.md");

      fs.writeFileSync(promptPath, "You are a Dev agent");
      fs.writeFileSync(prdPath, "# PRD\n\n## Features");
      fs.writeFileSync(archPath, "# Architecture\n\n## Components");

      return { promptPath, prdPath, archPath };
    };

    it("should run Dev agent and return success when exit code 0", async () => {
      const { promptPath, prdPath, archPath } = setupTestFiles();
      const mockProcess = createMockProcess(EXIT_CODES.SUCCESS);
      mockedSpawn.mockReturnValue(mockProcess);
      mockedFindLatestUnansweredQuestion.mockReturnValue(null);

      const result = await runDevAgent({
        area: "frontend",
        tickets: [10, 11],
        promptFile: promptPath,
        prdFile: prdPath,
        architectureFile: archPath,
      });

      expect(result.area).toBe("frontend");
      expect(result.status).toBe("success");
      expect(result.agentResult.exitCode).toBe(0);
      expect(result.questionFile).toBeNull();
      expect(result.needsTechLead).toBe(false);
    });

    it("should spawn agent with pipe stdio (background)", async () => {
      const { promptPath, prdPath, archPath } = setupTestFiles();
      const mockProcess = createMockProcess(EXIT_CODES.SUCCESS);
      mockedSpawn.mockReturnValue(mockProcess);
      mockedFindLatestUnansweredQuestion.mockReturnValue(null);

      await runDevAgent({
        area: "backend",
        tickets: [20],
        promptFile: promptPath,
        prdFile: prdPath,
        architectureFile: archPath,
      });

      expect(mockedSpawn).toHaveBeenCalledWith(
        "claude",
        expect.any(Array),
        expect.objectContaining({
          stdio: "pipe",
        })
      );
    });

    it("should pass area, tickets, PRD, and architecture in context", async () => {
      const { promptPath, prdPath, archPath } = setupTestFiles();
      const mockProcess = createMockProcess(EXIT_CODES.SUCCESS);
      mockedSpawn.mockReturnValue(mockProcess);
      mockedFindLatestUnansweredQuestion.mockReturnValue(null);

      await runDevAgent({
        area: "api",
        tickets: [1, 2, 3],
        promptFile: promptPath,
        prdFile: prdPath,
        architectureFile: archPath,
      });

      const callArgs = mockedSpawn.mock.calls[0][1];
      const contextIndex = callArgs.indexOf("--context");
      expect(contextIndex).toBeGreaterThan(-1);

      const contextValue = callArgs[contextIndex + 1];
      expect(contextValue).toContain("Area: api");
      expect(contextValue).toContain("Tickets: #1, #2, #3");
      expect(contextValue).toContain("# PRD");
      expect(contextValue).toContain("# Architecture");
    });

    it("should return blocked status with Tech Lead routing for exit code 2", async () => {
      const { promptPath, prdPath, archPath } = setupTestFiles();
      const mockProcess = createMockProcess(EXIT_CODES.BLOCKED);
      mockedSpawn.mockReturnValue(mockProcess);

      const questionFile = path.join(TEST_QUESTIONS_DIR, "q-001.md");
      mockedFindLatestUnansweredQuestion.mockReturnValue(questionFile);
      mockedParseQuestionFile.mockReturnValue({
        filePath: questionFile,
        fromAgent: "dev-frontend",
        forRecipient: "tech_lead",
        context: "",
        question: "Architecture question",
        options: [],
        rawContent: "",
      });
      mockedRouteQuestion.mockReturnValue("spawn_tech_lead");

      const result = await runDevAgent({
        area: "frontend",
        tickets: [10],
        promptFile: promptPath,
        prdFile: prdPath,
        architectureFile: archPath,
      });

      expect(result.status).toBe("blocked");
      expect(result.agentResult.exitCode).toBe(2);
      expect(result.questionFile).toBe(questionFile);
      expect(result.needsTechLead).toBe(true);
    });

    it("should return error status for exit code 1", async () => {
      const { promptPath, prdPath, archPath } = setupTestFiles();
      const mockProcess = createMockProcess(EXIT_CODES.ERROR);
      mockedSpawn.mockReturnValue(mockProcess);

      const result = await runDevAgent({
        area: "frontend",
        tickets: [10],
        promptFile: promptPath,
        prdFile: prdPath,
        architectureFile: archPath,
      });

      expect(result.status).toBe("error");
      expect(result.agentResult.exitCode).toBe(1);
    });

    it("should throw DevAgentError if area is empty", async () => {
      const { promptPath, prdPath, archPath } = setupTestFiles();

      await expect(
        runDevAgent({
          area: "",
          tickets: [10],
          promptFile: promptPath,
          prdFile: prdPath,
          architectureFile: archPath,
        })
      ).rejects.toThrow(DevAgentError);
      await expect(
        runDevAgent({
          area: "",
          tickets: [10],
          promptFile: promptPath,
          prdFile: prdPath,
          architectureFile: archPath,
        })
      ).rejects.toThrow("Area is required");
    });

    it("should throw DevAgentError if tickets array is empty", async () => {
      const { promptPath, prdPath, archPath } = setupTestFiles();

      await expect(
        runDevAgent({
          area: "frontend",
          tickets: [],
          promptFile: promptPath,
          prdFile: prdPath,
          architectureFile: archPath,
        })
      ).rejects.toThrow(DevAgentError);
      await expect(
        runDevAgent({
          area: "frontend",
          tickets: [],
          promptFile: promptPath,
          prdFile: prdPath,
          architectureFile: archPath,
        })
      ).rejects.toThrow("At least one ticket is required");
    });

    it("should throw DevAgentError if prompt file not found", async () => {
      const { prdPath, archPath } = setupTestFiles();

      await expect(
        runDevAgent({
          area: "frontend",
          tickets: [10],
          promptFile: "/nonexistent/prompt.md",
          prdFile: prdPath,
          architectureFile: archPath,
        })
      ).rejects.toThrow(DevAgentError);
    });

    it("should throw DevAgentError if PRD not found", async () => {
      const { promptPath, archPath } = setupTestFiles();

      await expect(
        runDevAgent({
          area: "frontend",
          tickets: [10],
          promptFile: promptPath,
          prdFile: "/nonexistent/prd.md",
          architectureFile: archPath,
        })
      ).rejects.toThrow(DevAgentError);
    });

    it("should throw DevAgentError if architecture not found", async () => {
      const { promptPath, prdPath } = setupTestFiles();

      await expect(
        runDevAgent({
          area: "frontend",
          tickets: [10],
          promptFile: promptPath,
          prdFile: prdPath,
          architectureFile: "/nonexistent/architecture.md",
        })
      ).rejects.toThrow(DevAgentError);
    });

    it("should include additional context if provided", async () => {
      const { promptPath, prdPath, archPath } = setupTestFiles();
      const mockProcess = createMockProcess(EXIT_CODES.SUCCESS);
      mockedSpawn.mockReturnValue(mockProcess);
      mockedFindLatestUnansweredQuestion.mockReturnValue(null);

      await runDevAgent({
        area: "frontend",
        tickets: [10],
        promptFile: promptPath,
        prdFile: prdPath,
        architectureFile: archPath,
        additionalContext: "Focus on performance",
      });

      const callArgs = mockedSpawn.mock.calls[0][1];
      const contextIndex = callArgs.indexOf("--context");
      const contextValue = callArgs[contextIndex + 1];
      expect(contextValue).toContain("# Additional Context");
      expect(contextValue).toContain("Focus on performance");
    });
  });

  describe("spawnDevAgent", () => {
    it("should spawn agent and return handle", () => {
      const promptPath = path.join(TEST_PROMPTS_DIR, "dev.md");
      const prdPath = path.join(TEST_ORCHESTRATOR_DIR, "prd.md");
      const archPath = path.join(TEST_ORCHESTRATOR_DIR, "architecture.md");
      fs.writeFileSync(promptPath, "prompt");
      fs.writeFileSync(prdPath, "prd");
      fs.writeFileSync(archPath, "arch");

      const mockProcess = createMockProcess(0);
      mockedSpawn.mockReturnValue(mockProcess);
      mockedFindLatestUnansweredQuestion.mockReturnValue(null);

      const handle = spawnDevAgent({
        area: "frontend",
        tickets: [10, 11],
        promptFile: promptPath,
        prdFile: prdPath,
        architectureFile: archPath,
      });

      expect(handle.area).toBe("frontend");
      expect(handle.tickets).toEqual([10, 11]);
      expect(handle.agentHandle.name).toBe("dev-frontend");
      expect(handle.result).toBeInstanceOf(Promise);
    });

    it("should throw DevAgentError if area is empty", () => {
      const promptPath = path.join(TEST_PROMPTS_DIR, "dev.md");
      const prdPath = path.join(TEST_ORCHESTRATOR_DIR, "prd.md");
      const archPath = path.join(TEST_ORCHESTRATOR_DIR, "architecture.md");
      fs.writeFileSync(promptPath, "prompt");
      fs.writeFileSync(prdPath, "prd");
      fs.writeFileSync(archPath, "arch");

      expect(() =>
        spawnDevAgent({
          area: "",
          tickets: [10],
          promptFile: promptPath,
          prdFile: prdPath,
          architectureFile: archPath,
        })
      ).toThrow(DevAgentError);
    });
  });

  describe("runDevSessions", () => {
    const setupTestFiles = () => {
      const promptPath = path.join(TEST_PROMPTS_DIR, "dev.md");
      const prdPath = path.join(TEST_ORCHESTRATOR_DIR, "prd.md");
      const archPath = path.join(TEST_ORCHESTRATOR_DIR, "architecture.md");

      fs.writeFileSync(promptPath, "You are a Dev agent");
      fs.writeFileSync(prdPath, "# PRD");
      fs.writeFileSync(archPath, "# Architecture");

      return { promptPath, prdPath, archPath };
    };

    it("should run multiple sessions in parallel by default", async () => {
      const { promptPath, prdPath, archPath } = setupTestFiles();

      // Create separate mock processes for each session
      mockedSpawn
        .mockReturnValueOnce(createMockProcess(EXIT_CODES.SUCCESS))
        .mockReturnValueOnce(createMockProcess(EXIT_CODES.SUCCESS));
      mockedFindLatestUnansweredQuestion.mockReturnValue(null);

      const results = await runDevSessions(
        [
          { area: "frontend", tickets: [10] },
          { area: "backend", tickets: [20] },
        ],
        { promptFile: promptPath, prdFile: prdPath, architectureFile: archPath }
      );

      expect(results).toHaveLength(2);
      expect(results[0].area).toBe("frontend");
      expect(results[0].status).toBe("success");
      expect(results[1].area).toBe("backend");
      expect(results[1].status).toBe("success");

      // Both spawns should have been called
      expect(mockedSpawn).toHaveBeenCalledTimes(2);
    });

    it("should run sessions sequentially when parallel=false", async () => {
      const { promptPath, prdPath, archPath } = setupTestFiles();

      mockedSpawn
        .mockReturnValueOnce(createMockProcess(EXIT_CODES.SUCCESS))
        .mockReturnValueOnce(createMockProcess(EXIT_CODES.SUCCESS));
      mockedFindLatestUnansweredQuestion.mockReturnValue(null);

      const results = await runDevSessions(
        [
          { area: "frontend", tickets: [10] },
          { area: "backend", tickets: [20] },
        ],
        {
          parallel: false,
          promptFile: promptPath,
          prdFile: prdPath,
          architectureFile: archPath,
        }
      );

      expect(results).toHaveLength(2);
      expect(results[0].area).toBe("frontend");
      expect(results[1].area).toBe("backend");
    });

    it("should return empty array for empty sessions", async () => {
      const results = await runDevSessions([]);

      expect(results).toEqual([]);
    });

    it("should handle mixed success/blocked/error results", async () => {
      const { promptPath, prdPath, archPath } = setupTestFiles();

      mockedSpawn
        .mockReturnValueOnce(createMockProcess(EXIT_CODES.SUCCESS))
        .mockReturnValueOnce(createMockProcess(EXIT_CODES.BLOCKED))
        .mockReturnValueOnce(createMockProcess(EXIT_CODES.ERROR));

      mockedFindLatestUnansweredQuestion
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(path.join(TEST_QUESTIONS_DIR, "q-001.md"))
        .mockReturnValueOnce(null);

      mockedParseQuestionFile.mockReturnValue({
        filePath: "",
        fromAgent: "dev",
        forRecipient: "tech_lead",
        context: "",
        question: "",
        options: [],
        rawContent: "",
      });
      mockedRouteQuestion.mockReturnValue("spawn_tech_lead");

      const results = await runDevSessions(
        [
          { area: "frontend", tickets: [10] },
          { area: "backend", tickets: [20] },
          { area: "api", tickets: [30] },
        ],
        { promptFile: promptPath, prdFile: prdPath, architectureFile: archPath }
      );

      expect(results).toHaveLength(3);
      expect(results[0].status).toBe("success");
      expect(results[1].status).toBe("blocked");
      expect(results[2].status).toBe("error");
    });
  });

  describe("spawnDevSessions", () => {
    it("should spawn multiple sessions and return handles", () => {
      const promptPath = path.join(TEST_PROMPTS_DIR, "dev.md");
      const prdPath = path.join(TEST_ORCHESTRATOR_DIR, "prd.md");
      const archPath = path.join(TEST_ORCHESTRATOR_DIR, "architecture.md");
      fs.writeFileSync(promptPath, "prompt");
      fs.writeFileSync(prdPath, "prd");
      fs.writeFileSync(archPath, "arch");

      mockedSpawn
        .mockReturnValueOnce(createMockProcess(0))
        .mockReturnValueOnce(createMockProcess(0));

      const handles = spawnDevSessions(
        [
          { area: "frontend", tickets: [10] },
          { area: "backend", tickets: [20] },
        ],
        { promptFile: promptPath, prdFile: prdPath, architectureFile: archPath }
      );

      expect(handles).toHaveLength(2);
      expect(handles[0].area).toBe("frontend");
      expect(handles[1].area).toBe("backend");
    });
  });

  describe("Helper functions", () => {
    describe("getBlockedSessionForTechLead", () => {
      it("should return first blocked session needing Tech Lead", () => {
        const results: DevAgentResult[] = [
          {
            area: "frontend",
            status: "success",
            agentResult: { exitCode: 0, stdout: "", stderr: "", killed: false },
            questionFile: null,
            needsTechLead: false,
          },
          {
            area: "backend",
            status: "blocked",
            agentResult: { exitCode: 2, stdout: "", stderr: "", killed: false },
            questionFile: "/q-001.md",
            needsTechLead: true,
          },
          {
            area: "api",
            status: "blocked",
            agentResult: { exitCode: 2, stdout: "", stderr: "", killed: false },
            questionFile: "/q-002.md",
            needsTechLead: true,
          },
        ];

        const blocked = getBlockedSessionForTechLead(results);

        expect(blocked).not.toBeNull();
        expect(blocked!.area).toBe("backend");
      });

      it("should return null when no blocked sessions need Tech Lead", () => {
        const results: DevAgentResult[] = [
          {
            area: "frontend",
            status: "success",
            agentResult: { exitCode: 0, stdout: "", stderr: "", killed: false },
            questionFile: null,
            needsTechLead: false,
          },
          {
            area: "backend",
            status: "blocked",
            agentResult: { exitCode: 2, stdout: "", stderr: "", killed: false },
            questionFile: "/q-001.md",
            needsTechLead: false, // Routes to user, not Tech Lead
          },
        ];

        const blocked = getBlockedSessionForTechLead(results);

        expect(blocked).toBeNull();
      });
    });

    describe("allSessionsCompleted", () => {
      it("should return true when all sessions succeeded", () => {
        const results: DevAgentResult[] = [
          {
            area: "frontend",
            status: "success",
            agentResult: { exitCode: 0, stdout: "", stderr: "", killed: false },
            questionFile: null,
            needsTechLead: false,
          },
          {
            area: "backend",
            status: "success",
            agentResult: { exitCode: 0, stdout: "", stderr: "", killed: false },
            questionFile: null,
            needsTechLead: false,
          },
        ];

        expect(allSessionsCompleted(results)).toBe(true);
      });

      it("should return false when any session is blocked or error", () => {
        const results: DevAgentResult[] = [
          {
            area: "frontend",
            status: "success",
            agentResult: { exitCode: 0, stdout: "", stderr: "", killed: false },
            questionFile: null,
            needsTechLead: false,
          },
          {
            area: "backend",
            status: "blocked",
            agentResult: { exitCode: 2, stdout: "", stderr: "", killed: false },
            questionFile: "/q-001.md",
            needsTechLead: true,
          },
        ];

        expect(allSessionsCompleted(results)).toBe(false);
      });

      it("should return true for empty results", () => {
        expect(allSessionsCompleted([])).toBe(true);
      });
    });

    describe("getSessionsByStatus", () => {
      it("should filter sessions by status", () => {
        const results: DevAgentResult[] = [
          {
            area: "frontend",
            status: "success",
            agentResult: { exitCode: 0, stdout: "", stderr: "", killed: false },
            questionFile: null,
            needsTechLead: false,
          },
          {
            area: "backend",
            status: "blocked",
            agentResult: { exitCode: 2, stdout: "", stderr: "", killed: false },
            questionFile: "/q-001.md",
            needsTechLead: true,
          },
          {
            area: "api",
            status: "error",
            agentResult: { exitCode: 1, stdout: "", stderr: "", killed: false },
            questionFile: null,
            needsTechLead: false,
          },
        ];

        expect(getSessionsByStatus(results, "success")).toHaveLength(1);
        expect(getSessionsByStatus(results, "success")[0].area).toBe("frontend");

        expect(getSessionsByStatus(results, "blocked")).toHaveLength(1);
        expect(getSessionsByStatus(results, "blocked")[0].area).toBe("backend");

        expect(getSessionsByStatus(results, "error")).toHaveLength(1);
        expect(getSessionsByStatus(results, "error")[0].area).toBe("api");
      });
    });
  });
});
