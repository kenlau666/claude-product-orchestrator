import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import { ChildProcess } from "child_process";
import {
  POAgentConfig,
  POAgentError,
  PO_PROMPT_FILE,
  PRD_OUTPUT_FILE,
  readReadmeFile,
  buildPOContext,
  checkPRDCreated,
  readPRD,
  runPOAgent,
  spawnPOAgent,
  validatePRD,
} from "../../src/agents/po";
import { EXIT_CODES } from "../../src/blocking";

// Test directory for isolation
const TEST_DIR = path.join(__dirname, ".test-po-agent");
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
  const testDir = require("path").join(__dirname, ".test-po-agent");
  return {
    ...originalModule,
    ORCHESTRATOR_DIR: require("path").join(testDir, ".orchestrator"),
  };
});

// Get the mocked spawn
import { spawn as mockSpawn } from "child_process";
const mockedSpawn = mockSpawn as jest.MockedFunction<typeof mockSpawn>;

// Helper to create a mock child process
function createMockProcess(exitCode: number = 0): ChildProcess {
  const process = new EventEmitter() as ChildProcess;
  (process as any).stdout = null;
  (process as any).stderr = null;
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

describe("PO Agent", () => {
  beforeEach(() => {
    // Clean up and create test directory
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
    fs.mkdirSync(TEST_PROMPTS_DIR, { recursive: true });
    fs.mkdirSync(TEST_ORCHESTRATOR_DIR, { recursive: true });

    // Reset mock
    mockedSpawn.mockReset();
  });

  afterAll(() => {
    // Clean up test directory
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("readReadmeFile", () => {
    it("should read README.md content", () => {
      const readmePath = path.join(TEST_DIR, "README.md");
      fs.writeFileSync(readmePath, "# My Project\n\nDescription here.");

      const content = readReadmeFile(readmePath);

      expect(content).toBe("# My Project\n\nDescription here.");
    });

    it("should throw POAgentError if README not found", () => {
      expect(() => readReadmeFile("/nonexistent/README.md")).toThrow(
        POAgentError
      );
      expect(() => readReadmeFile("/nonexistent/README.md")).toThrow(
        "README file not found"
      );
    });
  });

  describe("buildPOContext", () => {
    it("should build context with README only", () => {
      const readmeContent = "# Project\n\nDetails";

      const context = buildPOContext(readmeContent);

      expect(context).toContain("# README");
      expect(context).toContain("# Project");
      expect(context).toContain("Details");
      expect(context).not.toContain("# Additional Context");
    });

    it("should build context with README and additional context", () => {
      const readmeContent = "# Project";
      const additional = "Extra info here";

      const context = buildPOContext(readmeContent, additional);

      expect(context).toContain("# README");
      expect(context).toContain("# Project");
      expect(context).toContain("# Additional Context");
      expect(context).toContain("Extra info here");
    });

    it("should ignore empty additional context", () => {
      const readmeContent = "# Project";

      const context = buildPOContext(readmeContent, "   ");

      expect(context).not.toContain("# Additional Context");
    });
  });

  describe("checkPRDCreated", () => {
    it("should return true if PRD file exists", () => {
      const prdPath = path.join(TEST_ORCHESTRATOR_DIR, "prd.md");
      fs.writeFileSync(prdPath, "# PRD Content");

      expect(checkPRDCreated(prdPath)).toBe(true);
    });

    it("should return false if PRD file does not exist", () => {
      const prdPath = path.join(TEST_ORCHESTRATOR_DIR, "prd.md");

      expect(checkPRDCreated(prdPath)).toBe(false);
    });
  });

  describe("readPRD", () => {
    it("should read PRD content", () => {
      const prdPath = path.join(TEST_ORCHESTRATOR_DIR, "prd.md");
      fs.writeFileSync(prdPath, "# PRD\n\n## Features");

      const content = readPRD(prdPath);

      expect(content).toBe("# PRD\n\n## Features");
    });

    it("should return null if PRD does not exist", () => {
      const prdPath = path.join(TEST_ORCHESTRATOR_DIR, "nonexistent.md");

      expect(readPRD(prdPath)).toBeNull();
    });
  });

  describe("validatePRD", () => {
    it("should return valid for properly formatted PRD", () => {
      const prdPath = path.join(TEST_ORCHESTRATOR_DIR, "prd.md");
      fs.writeFileSync(prdPath, "# PRD\n\n## Features\n\n- Feature 1");

      const result = validatePRD(prdPath);

      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("should return invalid if PRD file not found", () => {
      const prdPath = path.join(TEST_ORCHESTRATOR_DIR, "nonexistent.md");

      const result = validatePRD(prdPath);

      expect(result.valid).toBe(false);
      expect(result.error).toBe("PRD file not found");
    });

    it("should return invalid if PRD file is empty", () => {
      const prdPath = path.join(TEST_ORCHESTRATOR_DIR, "prd.md");
      fs.writeFileSync(prdPath, "   ");

      const result = validatePRD(prdPath);

      expect(result.valid).toBe(false);
      expect(result.error).toBe("PRD file is empty");
    });

    it("should return invalid if PRD has no headings", () => {
      const prdPath = path.join(TEST_ORCHESTRATOR_DIR, "prd.md");
      fs.writeFileSync(prdPath, "Just some text without headings");

      const result = validatePRD(prdPath);

      expect(result.valid).toBe(false);
      expect(result.error).toBe("PRD file appears to be malformed (no headings)");
    });
  });

  describe("runPOAgent", () => {
    const setupTestFiles = () => {
      const readmePath = path.join(TEST_DIR, "README.md");
      const promptPath = path.join(TEST_PROMPTS_DIR, "po.md");

      fs.writeFileSync(readmePath, "# Test Project\n\nDescription");
      fs.writeFileSync(promptPath, "You are a PO agent");

      return { readmePath, promptPath };
    };

    it("should run PO agent and return success when exit code 0", async () => {
      const { readmePath, promptPath } = setupTestFiles();
      const mockProcess = createMockProcess(EXIT_CODES.SUCCESS);
      mockedSpawn.mockReturnValue(mockProcess);

      // Simulate PRD creation
      const prdPath = path.join(TEST_ORCHESTRATOR_DIR, "prd.md");
      setImmediate(() => {
        fs.writeFileSync(prdPath, "# Generated PRD");
      });

      const result = await runPOAgent({
        readmeFile: readmePath,
        promptFile: promptPath,
      });

      expect(result.status).toBe("success");
      expect(result.agentResult.exitCode).toBe(0);
    });

    it("should spawn agent with inherit stdio (foreground)", async () => {
      const { readmePath, promptPath } = setupTestFiles();
      const mockProcess = createMockProcess(EXIT_CODES.SUCCESS);
      mockedSpawn.mockReturnValue(mockProcess);

      await runPOAgent({
        readmeFile: readmePath,
        promptFile: promptPath,
      });

      expect(mockedSpawn).toHaveBeenCalledWith(
        "claude",
        expect.any(Array),
        expect.objectContaining({
          stdio: "inherit",
        })
      );
    });

    it("should pass README content in context", async () => {
      const { readmePath, promptPath } = setupTestFiles();
      const mockProcess = createMockProcess(EXIT_CODES.SUCCESS);
      mockedSpawn.mockReturnValue(mockProcess);

      await runPOAgent({
        readmeFile: readmePath,
        promptFile: promptPath,
      });

      const callArgs = mockedSpawn.mock.calls[0][1];
      const contextIndex = callArgs.indexOf("--context");
      expect(contextIndex).toBeGreaterThan(-1);

      const contextValue = callArgs[contextIndex + 1];
      expect(contextValue).toContain("# README");
      expect(contextValue).toContain("# Test Project");
    });

    it("should return blocked status for exit code 2", async () => {
      const { readmePath, promptPath } = setupTestFiles();
      const mockProcess = createMockProcess(EXIT_CODES.BLOCKED);
      mockedSpawn.mockReturnValue(mockProcess);

      const result = await runPOAgent({
        readmeFile: readmePath,
        promptFile: promptPath,
      });

      expect(result.status).toBe("blocked");
      expect(result.agentResult.exitCode).toBe(2);
    });

    it("should return error status for exit code 1", async () => {
      const { readmePath, promptPath } = setupTestFiles();
      const mockProcess = createMockProcess(EXIT_CODES.ERROR);
      mockedSpawn.mockReturnValue(mockProcess);

      const result = await runPOAgent({
        readmeFile: readmePath,
        promptFile: promptPath,
      });

      expect(result.status).toBe("error");
      expect(result.agentResult.exitCode).toBe(1);
    });

    it("should throw POAgentError if README not found", async () => {
      const promptPath = path.join(TEST_PROMPTS_DIR, "po.md");
      fs.writeFileSync(promptPath, "prompt");

      await expect(
        runPOAgent({
          readmeFile: "/nonexistent/README.md",
          promptFile: promptPath,
        })
      ).rejects.toThrow(POAgentError);
    });

    it("should throw POAgentError if prompt file not found", async () => {
      const readmePath = path.join(TEST_DIR, "README.md");
      fs.writeFileSync(readmePath, "readme");

      await expect(
        runPOAgent({
          readmeFile: readmePath,
          promptFile: "/nonexistent/prompt.md",
        })
      ).rejects.toThrow(POAgentError);
    });

    it("should include additional context if provided", async () => {
      const { readmePath, promptPath } = setupTestFiles();
      const mockProcess = createMockProcess(EXIT_CODES.SUCCESS);
      mockedSpawn.mockReturnValue(mockProcess);

      await runPOAgent({
        readmeFile: readmePath,
        promptFile: promptPath,
        additionalContext: "User wants MVP fast",
      });

      const callArgs = mockedSpawn.mock.calls[0][1];
      const contextIndex = callArgs.indexOf("--context");
      const contextValue = callArgs[contextIndex + 1];
      expect(contextValue).toContain("# Additional Context");
      expect(contextValue).toContain("User wants MVP fast");
    });

    it("should check if PRD was created after agent exits", async () => {
      const { readmePath, promptPath } = setupTestFiles();
      const mockProcess = createMockProcess(EXIT_CODES.SUCCESS);
      mockedSpawn.mockReturnValue(mockProcess);

      // No PRD created
      const result = await runPOAgent({
        readmeFile: readmePath,
        promptFile: promptPath,
      });

      expect(result.prdCreated).toBe(false);
      expect(result.prdPath).toBeNull();
    });
  });

  describe("spawnPOAgent", () => {
    it("should spawn agent and return handle", () => {
      const readmePath = path.join(TEST_DIR, "README.md");
      const promptPath = path.join(TEST_PROMPTS_DIR, "po.md");
      fs.writeFileSync(readmePath, "# README");
      fs.writeFileSync(promptPath, "prompt");

      const mockProcess = createMockProcess(0);
      mockedSpawn.mockReturnValue(mockProcess);

      const handle = spawnPOAgent({
        readmeFile: readmePath,
        promptFile: promptPath,
      });

      expect(handle.name).toBe("po");
      expect(handle.process).toBe(mockProcess);
      expect(handle.result).toBeInstanceOf(Promise);
      expect(typeof handle.kill).toBe("function");
    });

    it("should throw POAgentError if prompt file not found", () => {
      const readmePath = path.join(TEST_DIR, "README.md");
      fs.writeFileSync(readmePath, "readme");

      expect(() =>
        spawnPOAgent({
          readmeFile: readmePath,
          promptFile: "/nonexistent/prompt.md",
        })
      ).toThrow(POAgentError);
    });
  });
});
