import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import { ChildProcess } from "child_process";
import {
  TechLeadAgentConfig,
  TechLeadAgentError,
  TECH_LEAD_PROMPT_FILE,
  PRD_FILE,
  ARCHITECTURE_OUTPUT_FILE,
  readPRDFile,
  buildTechLeadContext,
  checkArchitectureCreated,
  readArchitecture,
  runTechLeadAgent,
  spawnTechLeadAgent,
  validateArchitecture,
  parseAreasFromIssues,
  areasToDevSessionInput,
  AreaWithIssues,
} from "../../src/agents/tech-lead";
import { EXIT_CODES } from "../../src/blocking";
import { Issue } from "../../src/github";

// Test directory for isolation
const TEST_DIR = path.join(__dirname, ".test-tech-lead-agent");
const TEST_PROMPTS_DIR = path.join(TEST_DIR, "prompts");
const TEST_ORCHESTRATOR_DIR = path.join(TEST_DIR, ".orchestrator");

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
  const testDir = require("path").join(__dirname, ".test-tech-lead-agent");
  return {
    ...originalModule,
    ORCHESTRATOR_DIR: require("path").join(testDir, ".orchestrator"),
  };
});

// Mock GitHub module
jest.mock("../../src/github", () => ({
  getAreas: jest.fn(),
  getIssuesByArea: jest.fn(),
}));

// Get mocked functions
import { spawn as mockSpawn } from "child_process";
import { getAreas as mockGetAreas, getIssuesByArea as mockGetIssuesByArea } from "../../src/github";
const mockedSpawn = mockSpawn as jest.MockedFunction<typeof mockSpawn>;
const mockedGetAreas = mockGetAreas as jest.MockedFunction<typeof mockGetAreas>;
const mockedGetIssuesByArea = mockGetIssuesByArea as jest.MockedFunction<typeof mockGetIssuesByArea>;

// Helper to create a mock child process
function createMockProcess(
  exitCode: number = 0,
  stdout: string = "",
  stderr: string = ""
): ChildProcess {
  const process = new EventEmitter() as ChildProcess;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();

  (process as any).stdout = stdoutEmitter;
  (process as any).stderr = stderrEmitter;
  (process as any).killed = false;
  (process as any).pid = 12345;

  (process as any).kill = jest.fn((signal?: string) => {
    (process as any).killed = true;
    process.emit("close", null, signal || "SIGTERM");
    return true;
  });

  setImmediate(() => {
    if (stdout) {
      stdoutEmitter.emit("data", Buffer.from(stdout));
    }
    if (stderr) {
      stderrEmitter.emit("data", Buffer.from(stderr));
    }
    if (!(process as any).killed) {
      process.emit("close", exitCode, null);
    }
  });

  return process;
}

describe("Tech Lead Agent", () => {
  beforeEach(() => {
    // Clean up and create test directory
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
    fs.mkdirSync(TEST_PROMPTS_DIR, { recursive: true });
    fs.mkdirSync(TEST_ORCHESTRATOR_DIR, { recursive: true });

    // Reset mocks
    mockedSpawn.mockReset();
    mockedGetAreas.mockReset();
    mockedGetIssuesByArea.mockReset();
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
      fs.writeFileSync(prdPath, "# PRD\n\n## Features\n\n- Feature 1");

      const content = readPRDFile(prdPath);

      expect(content).toBe("# PRD\n\n## Features\n\n- Feature 1");
    });

    it("should throw TechLeadAgentError if PRD not found", () => {
      expect(() => readPRDFile("/nonexistent/prd.md")).toThrow(TechLeadAgentError);
      expect(() => readPRDFile("/nonexistent/prd.md")).toThrow("PRD file not found");
    });
  });

  describe("buildTechLeadContext", () => {
    it("should build context with PRD only", () => {
      const prdContent = "# PRD\n\nFeatures here";

      const context = buildTechLeadContext(prdContent);

      expect(context).toContain("# PRD (Product Requirements Document)");
      expect(context).toContain("# PRD");
      expect(context).toContain("Features here");
      expect(context).not.toContain("# Additional Context");
    });

    it("should build context with PRD and additional context", () => {
      const prdContent = "# PRD";
      const additional = "Extra info";

      const context = buildTechLeadContext(prdContent, additional);

      expect(context).toContain("# PRD (Product Requirements Document)");
      expect(context).toContain("# Additional Context");
      expect(context).toContain("Extra info");
    });

    it("should ignore empty additional context", () => {
      const prdContent = "# PRD";

      const context = buildTechLeadContext(prdContent, "   ");

      expect(context).not.toContain("# Additional Context");
    });
  });

  describe("checkArchitectureCreated", () => {
    it("should return true if architecture file exists", () => {
      const archPath = path.join(TEST_ORCHESTRATOR_DIR, "architecture.md");
      fs.writeFileSync(archPath, "# Architecture");

      expect(checkArchitectureCreated(archPath)).toBe(true);
    });

    it("should return false if architecture file does not exist", () => {
      const archPath = path.join(TEST_ORCHESTRATOR_DIR, "architecture.md");

      expect(checkArchitectureCreated(archPath)).toBe(false);
    });
  });

  describe("readArchitecture", () => {
    it("should read architecture content", () => {
      const archPath = path.join(TEST_ORCHESTRATOR_DIR, "architecture.md");
      fs.writeFileSync(archPath, "# Architecture\n\n## Tech Stack");

      const content = readArchitecture(archPath);

      expect(content).toBe("# Architecture\n\n## Tech Stack");
    });

    it("should return null if architecture does not exist", () => {
      const archPath = path.join(TEST_ORCHESTRATOR_DIR, "nonexistent.md");

      expect(readArchitecture(archPath)).toBeNull();
    });
  });

  describe("validateArchitecture", () => {
    it("should return valid for properly formatted architecture", () => {
      const archPath = path.join(TEST_ORCHESTRATOR_DIR, "architecture.md");
      fs.writeFileSync(archPath, "# Architecture\n\n## Tech Stack\n\n- TypeScript");

      const result = validateArchitecture(archPath);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("should return invalid if architecture file not found", () => {
      const archPath = path.join(TEST_ORCHESTRATOR_DIR, "nonexistent.md");

      const result = validateArchitecture(archPath);

      expect(result.valid).toBe(false);
      expect(result.error).toBe("Architecture file not found");
    });

    it("should return invalid if architecture file is empty", () => {
      const archPath = path.join(TEST_ORCHESTRATOR_DIR, "architecture.md");
      fs.writeFileSync(archPath, "   ");

      const result = validateArchitecture(archPath);

      expect(result.valid).toBe(false);
      expect(result.error).toBe("Architecture file is empty");
    });

    it("should return invalid if architecture has no headings", () => {
      const archPath = path.join(TEST_ORCHESTRATOR_DIR, "architecture.md");
      fs.writeFileSync(archPath, "Just some text without headings");

      const result = validateArchitecture(archPath);

      expect(result.valid).toBe(false);
      expect(result.error).toBe("Architecture file appears to be malformed (no headings)");
    });
  });

  describe("runTechLeadAgent", () => {
    const setupTestFiles = () => {
      const prdPath = path.join(TEST_ORCHESTRATOR_DIR, "prd.md");
      const promptPath = path.join(TEST_PROMPTS_DIR, "tech-lead.md");

      fs.writeFileSync(prdPath, "# PRD\n\n## Features");
      fs.writeFileSync(promptPath, "You are a Tech Lead agent");

      return { prdPath, promptPath };
    };

    it("should run Tech Lead agent and return success when exit code 0", async () => {
      const { prdPath, promptPath } = setupTestFiles();
      const mockProcess = createMockProcess(EXIT_CODES.SUCCESS);
      mockedSpawn.mockReturnValue(mockProcess);

      const result = await runTechLeadAgent({
        prdFile: prdPath,
        promptFile: promptPath,
      });

      expect(result.status).toBe("success");
      expect(result.agentResult.exitCode).toBe(0);
    });

    it("should spawn agent with pipe stdio (background)", async () => {
      const { prdPath, promptPath } = setupTestFiles();
      const mockProcess = createMockProcess(EXIT_CODES.SUCCESS);
      mockedSpawn.mockReturnValue(mockProcess);

      await runTechLeadAgent({
        prdFile: prdPath,
        promptFile: promptPath,
      });

      expect(mockedSpawn).toHaveBeenCalledWith(
        "claude",
        expect.any(Array),
        expect.objectContaining({
          stdio: "pipe",
        })
      );
    });

    it("should pass PRD content in context", async () => {
      const { prdPath, promptPath } = setupTestFiles();
      const mockProcess = createMockProcess(EXIT_CODES.SUCCESS);
      mockedSpawn.mockReturnValue(mockProcess);

      await runTechLeadAgent({
        prdFile: prdPath,
        promptFile: promptPath,
      });

      const callArgs = mockedSpawn.mock.calls[0][1];
      const contextIndex = callArgs.indexOf("--context");
      expect(contextIndex).toBeGreaterThan(-1);

      const contextValue = callArgs[contextIndex + 1];
      expect(contextValue).toContain("# PRD (Product Requirements Document)");
      expect(contextValue).toContain("## Features");
    });

    it("should return blocked status for exit code 2", async () => {
      const { prdPath, promptPath } = setupTestFiles();
      const mockProcess = createMockProcess(EXIT_CODES.BLOCKED);
      mockedSpawn.mockReturnValue(mockProcess);

      const result = await runTechLeadAgent({
        prdFile: prdPath,
        promptFile: promptPath,
      });

      expect(result.status).toBe("blocked");
      expect(result.agentResult.exitCode).toBe(2);
    });

    it("should return error status for exit code 1", async () => {
      const { prdPath, promptPath } = setupTestFiles();
      const mockProcess = createMockProcess(EXIT_CODES.ERROR);
      mockedSpawn.mockReturnValue(mockProcess);

      const result = await runTechLeadAgent({
        prdFile: prdPath,
        promptFile: promptPath,
      });

      expect(result.status).toBe("error");
      expect(result.agentResult.exitCode).toBe(1);
    });

    it("should throw TechLeadAgentError if PRD not found", async () => {
      const promptPath = path.join(TEST_PROMPTS_DIR, "tech-lead.md");
      fs.writeFileSync(promptPath, "prompt");

      await expect(
        runTechLeadAgent({
          prdFile: "/nonexistent/prd.md",
          promptFile: promptPath,
        })
      ).rejects.toThrow(TechLeadAgentError);
    });

    it("should throw TechLeadAgentError if prompt file not found", async () => {
      const prdPath = path.join(TEST_ORCHESTRATOR_DIR, "prd.md");
      fs.writeFileSync(prdPath, "prd content");

      await expect(
        runTechLeadAgent({
          prdFile: prdPath,
          promptFile: "/nonexistent/prompt.md",
        })
      ).rejects.toThrow(TechLeadAgentError);
    });

    it("should include additional context if provided", async () => {
      const { prdPath, promptPath } = setupTestFiles();
      const mockProcess = createMockProcess(EXIT_CODES.SUCCESS);
      mockedSpawn.mockReturnValue(mockProcess);

      await runTechLeadAgent({
        prdFile: prdPath,
        promptFile: promptPath,
        additionalContext: "Previous architecture decisions",
      });

      const callArgs = mockedSpawn.mock.calls[0][1];
      const contextIndex = callArgs.indexOf("--context");
      const contextValue = callArgs[contextIndex + 1];
      expect(contextValue).toContain("# Additional Context");
      expect(contextValue).toContain("Previous architecture decisions");
    });

    it("should capture stdout/stderr in background mode", async () => {
      const { prdPath, promptPath } = setupTestFiles();
      const mockProcess = createMockProcess(EXIT_CODES.SUCCESS, "Agent output", "Agent errors");
      mockedSpawn.mockReturnValue(mockProcess);

      const result = await runTechLeadAgent({
        prdFile: prdPath,
        promptFile: promptPath,
      });

      expect(result.agentResult.stdout).toBe("Agent output");
      expect(result.agentResult.stderr).toBe("Agent errors");
    });
  });

  describe("spawnTechLeadAgent", () => {
    it("should spawn agent and return handle", () => {
      const prdPath = path.join(TEST_ORCHESTRATOR_DIR, "prd.md");
      const promptPath = path.join(TEST_PROMPTS_DIR, "tech-lead.md");
      fs.writeFileSync(prdPath, "# PRD");
      fs.writeFileSync(promptPath, "prompt");

      const mockProcess = createMockProcess(0);
      mockedSpawn.mockReturnValue(mockProcess);

      const handle = spawnTechLeadAgent({
        prdFile: prdPath,
        promptFile: promptPath,
      });

      expect(handle.name).toBe("tech_lead");
      expect(handle.process).toBe(mockProcess);
      expect(handle.result).toBeInstanceOf(Promise);
      expect(typeof handle.kill).toBe("function");
    });

    it("should throw TechLeadAgentError if prompt file not found", () => {
      const prdPath = path.join(TEST_ORCHESTRATOR_DIR, "prd.md");
      fs.writeFileSync(prdPath, "prd");

      expect(() =>
        spawnTechLeadAgent({
          prdFile: prdPath,
          promptFile: "/nonexistent/prompt.md",
        })
      ).toThrow(TechLeadAgentError);
    });
  });

  describe("parseAreasFromIssues", () => {
    it("should parse areas and their open issues", async () => {
      mockedGetAreas.mockResolvedValue(["frontend", "backend"]);

      const frontendIssues: Issue[] = [
        {
          number: 1,
          title: "Build login page",
          body: "Details",
          state: "open",
          labels: ["area:frontend"],
          createdAt: "2024-01-01",
          updatedAt: "2024-01-01",
        },
        {
          number: 3,
          title: "Build dashboard",
          body: "Details",
          state: "open",
          labels: ["area:frontend"],
          createdAt: "2024-01-01",
          updatedAt: "2024-01-01",
        },
      ];

      const backendIssues: Issue[] = [
        {
          number: 2,
          title: "Create API",
          body: "Details",
          state: "open",
          labels: ["area:backend"],
          createdAt: "2024-01-01",
          updatedAt: "2024-01-01",
        },
      ];

      mockedGetIssuesByArea.mockImplementation(async (area: string) => {
        if (area === "frontend") return frontendIssues;
        if (area === "backend") return backendIssues;
        return [];
      });

      const result = await parseAreasFromIssues();

      expect(result).toHaveLength(2);
      expect(result[0].area).toBe("frontend");
      expect(result[0].ticketNumbers).toEqual([1, 3]);
      expect(result[1].area).toBe("backend");
      expect(result[1].ticketNumbers).toEqual([2]);
    });

    it("should exclude closed issues", async () => {
      mockedGetAreas.mockResolvedValue(["frontend"]);

      const issues: Issue[] = [
        {
          number: 1,
          title: "Open issue",
          body: "",
          state: "open",
          labels: ["area:frontend"],
          createdAt: "2024-01-01",
          updatedAt: "2024-01-01",
        },
        {
          number: 2,
          title: "Closed issue",
          body: "",
          state: "closed",
          labels: ["area:frontend"],
          createdAt: "2024-01-01",
          updatedAt: "2024-01-01",
        },
      ];

      mockedGetIssuesByArea.mockResolvedValue(issues);

      const result = await parseAreasFromIssues();

      expect(result).toHaveLength(1);
      expect(result[0].ticketNumbers).toEqual([1]);
    });

    it("should exclude areas with no open issues", async () => {
      mockedGetAreas.mockResolvedValue(["frontend", "backend"]);

      mockedGetIssuesByArea.mockImplementation(async (area: string) => {
        if (area === "frontend") {
          return [
            {
              number: 1,
              title: "Closed",
              body: "",
              state: "closed" as const,
              labels: [],
              createdAt: "",
              updatedAt: "",
            },
          ];
        }
        return [];
      });

      const result = await parseAreasFromIssues();

      expect(result).toHaveLength(0);
    });

    it("should return empty array when no areas exist", async () => {
      mockedGetAreas.mockResolvedValue([]);

      const result = await parseAreasFromIssues();

      expect(result).toEqual([]);
    });
  });

  describe("areasToDevSessionInput", () => {
    it("should convert areas to DevSession input format", () => {
      const areasWithIssues: AreaWithIssues[] = [
        {
          area: "frontend",
          issues: [],
          ticketNumbers: [1, 3, 5],
        },
        {
          area: "backend",
          issues: [],
          ticketNumbers: [2, 4],
        },
      ];

      const result = areasToDevSessionInput(areasWithIssues);

      expect(result).toEqual([
        { area: "frontend", tickets: [1, 3, 5] },
        { area: "backend", tickets: [2, 4] },
      ]);
    });

    it("should return empty array for empty input", () => {
      const result = areasToDevSessionInput([]);

      expect(result).toEqual([]);
    });
  });
});
