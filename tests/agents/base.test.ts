import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";
import { ChildProcess } from "child_process";
import {
  AgentConfig,
  AgentResult,
  AgentSpawnError,
  spawnAgent,
  runAgent,
  isSuccess,
  isBlocked,
  isError,
  getResultStatus,
} from "../../src/agents/base";
import { EXIT_CODES } from "../../src/blocking";

// Test directory for isolation
const TEST_DIR = path.join(__dirname, ".test-agents");
const TEST_PROMPTS_DIR = path.join(TEST_DIR, "prompts");

// Mock child_process
jest.mock("child_process", () => {
  const originalModule = jest.requireActual("child_process");
  return {
    ...originalModule,
    spawn: jest.fn(),
  };
});

// Get the mocked spawn
import { spawn as mockSpawn } from "child_process";
const mockedSpawn = mockSpawn as jest.MockedFunction<typeof mockSpawn>;

// Helper to create a mock child process
function createMockProcess(
  exitCode: number = 0,
  stdout: string = "",
  stderr: string = ""
): ChildProcess {
  const process = new EventEmitter() as ChildProcess;

  // Mock stdout/stderr streams for pipe mode
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();

  (process as any).stdout = stdoutEmitter;
  (process as any).stderr = stderrEmitter;
  (process as any).killed = false;
  (process as any).pid = 12345;

  // Mock kill function
  (process as any).kill = jest.fn((signal?: string) => {
    (process as any).killed = true;
    process.emit("close", null, signal || "SIGTERM");
    return true;
  });

  // Emit exit after a tick (simulating async process)
  setImmediate(() => {
    if (stdout) {
      stdoutEmitter.emit("data", Buffer.from(stdout));
    }
    if (stderr) {
      stderrEmitter.emit("data", Buffer.from(stderr));
    }
    // Only emit close if not killed
    if (!(process as any).killed) {
      process.emit("close", exitCode, null);
    }
  });

  return process;
}

describe("Base Agent Spawner", () => {
  beforeEach(() => {
    // Clean up and create test directory
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
    fs.mkdirSync(TEST_PROMPTS_DIR, { recursive: true });

    // Reset mock
    mockedSpawn.mockReset();
  });

  afterAll(() => {
    // Clean up test directory
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("spawnAgent", () => {
    const createTestPrompt = (content: string = "Test prompt content"): string => {
      const filePath = path.join(TEST_PROMPTS_DIR, "test-prompt.md");
      fs.writeFileSync(filePath, content);
      return filePath;
    };

    describe("validation", () => {
      it("should throw AgentSpawnError if name is missing", () => {
        const promptFile = createTestPrompt();
        const config: AgentConfig = {
          name: "",
          promptFile,
          context: "test context",
          stdio: "pipe",
        };

        expect(() => spawnAgent(config)).toThrow(AgentSpawnError);
        expect(() => spawnAgent(config)).toThrow("Agent name is required");
      });

      it("should throw AgentSpawnError if promptFile is missing", () => {
        const config: AgentConfig = {
          name: "test-agent",
          promptFile: "",
          context: "test context",
          stdio: "pipe",
        };

        expect(() => spawnAgent(config)).toThrow(AgentSpawnError);
        expect(() => spawnAgent(config)).toThrow("Prompt file path is required");
      });

      it("should throw AgentSpawnError if prompt file does not exist", () => {
        const config: AgentConfig = {
          name: "test-agent",
          promptFile: "/nonexistent/prompt.md",
          context: "test context",
          stdio: "pipe",
        };

        expect(() => spawnAgent(config)).toThrow(AgentSpawnError);
        expect(() => spawnAgent(config)).toThrow("Prompt file not found");
      });

      it("should throw AgentSpawnError for invalid stdio mode", () => {
        const promptFile = createTestPrompt();
        const config = {
          name: "test-agent",
          promptFile,
          context: "test context",
          stdio: "invalid" as any,
        };

        expect(() => spawnAgent(config)).toThrow(AgentSpawnError);
        expect(() => spawnAgent(config)).toThrow('stdio must be "inherit" or "pipe"');
      });
    });

    describe("spawn execution", () => {
      it("should spawn claude with correct arguments", () => {
        const promptFile = createTestPrompt("My prompt content");
        const mockProcess = createMockProcess();
        mockedSpawn.mockReturnValue(mockProcess);

        const config: AgentConfig = {
          name: "test-agent",
          promptFile,
          context: "test context",
          stdio: "pipe",
        };

        spawnAgent(config);

        expect(mockedSpawn).toHaveBeenCalledWith(
          "claude",
          expect.arrayContaining([
            "--prompt",
            "My prompt content",
            "--context",
            "test context",
          ]),
          expect.objectContaining({
            stdio: "pipe",
            env: expect.objectContaining({
              ORCHESTRATOR_DIR: ".orchestrator",
            }),
          })
        );
      });

      it("should pass custom environment variables", () => {
        const promptFile = createTestPrompt();
        const mockProcess = createMockProcess();
        mockedSpawn.mockReturnValue(mockProcess);

        const config: AgentConfig = {
          name: "test-agent",
          promptFile,
          context: "",
          stdio: "pipe",
          env: {
            GITHUB_TOKEN: "test-token",
            CUSTOM_VAR: "custom-value",
          },
        };

        spawnAgent(config);

        expect(mockedSpawn).toHaveBeenCalledWith(
          "claude",
          expect.any(Array),
          expect.objectContaining({
            env: expect.objectContaining({
              GITHUB_TOKEN: "test-token",
              CUSTOM_VAR: "custom-value",
            }),
          })
        );
      });

      it("should not include context arg when context is empty", () => {
        const promptFile = createTestPrompt();
        const mockProcess = createMockProcess();
        mockedSpawn.mockReturnValue(mockProcess);

        const config: AgentConfig = {
          name: "test-agent",
          promptFile,
          context: "",
          stdio: "pipe",
        };

        spawnAgent(config);

        const callArgs = mockedSpawn.mock.calls[0][1];
        expect(callArgs).not.toContain("--context");
      });

      it("should use stdio inherit for foreground mode", () => {
        const promptFile = createTestPrompt();
        const mockProcess = createMockProcess();
        mockedSpawn.mockReturnValue(mockProcess);

        const config: AgentConfig = {
          name: "test-agent",
          promptFile,
          context: "test",
          stdio: "inherit",
        };

        spawnAgent(config);

        expect(mockedSpawn).toHaveBeenCalledWith(
          "claude",
          expect.any(Array),
          expect.objectContaining({
            stdio: "inherit",
          })
        );
      });
    });

    describe("result handling", () => {
      it("should resolve with exit code 0 on success", async () => {
        const promptFile = createTestPrompt();
        const mockProcess = createMockProcess(0);
        mockedSpawn.mockReturnValue(mockProcess);

        const config: AgentConfig = {
          name: "test-agent",
          promptFile,
          context: "test",
          stdio: "pipe",
        };

        const handle = spawnAgent(config);
        const result = await handle.result;

        expect(result.exitCode).toBe(0);
        expect(result.killed).toBe(false);
      });

      it("should resolve with exit code 1 on error", async () => {
        const promptFile = createTestPrompt();
        const mockProcess = createMockProcess(1);
        mockedSpawn.mockReturnValue(mockProcess);

        const config: AgentConfig = {
          name: "test-agent",
          promptFile,
          context: "test",
          stdio: "pipe",
        };

        const handle = spawnAgent(config);
        const result = await handle.result;

        expect(result.exitCode).toBe(1);
      });

      it("should resolve with exit code 2 on blocked", async () => {
        const promptFile = createTestPrompt();
        const mockProcess = createMockProcess(2);
        mockedSpawn.mockReturnValue(mockProcess);

        const config: AgentConfig = {
          name: "test-agent",
          promptFile,
          context: "test",
          stdio: "pipe",
        };

        const handle = spawnAgent(config);
        const result = await handle.result;

        expect(result.exitCode).toBe(2);
      });

      it("should capture stdout in pipe mode", async () => {
        const promptFile = createTestPrompt();
        const mockProcess = createMockProcess(0, "Hello from agent", "");
        mockedSpawn.mockReturnValue(mockProcess);

        const config: AgentConfig = {
          name: "test-agent",
          promptFile,
          context: "test",
          stdio: "pipe",
        };

        const handle = spawnAgent(config);
        const result = await handle.result;

        expect(result.stdout).toBe("Hello from agent");
      });

      it("should capture stderr in pipe mode", async () => {
        const promptFile = createTestPrompt();
        const mockProcess = createMockProcess(0, "", "Error message");
        mockedSpawn.mockReturnValue(mockProcess);

        const config: AgentConfig = {
          name: "test-agent",
          promptFile,
          context: "test",
          stdio: "pipe",
        };

        const handle = spawnAgent(config);
        const result = await handle.result;

        expect(result.stderr).toBe("Error message");
      });

      it("should reject on spawn error", async () => {
        const promptFile = createTestPrompt();
        const mockProcess = new EventEmitter() as ChildProcess;
        (mockProcess as any).stdout = null;
        (mockProcess as any).stderr = null;
        mockedSpawn.mockReturnValue(mockProcess);

        const config: AgentConfig = {
          name: "test-agent",
          promptFile,
          context: "test",
          stdio: "pipe",
        };

        const handle = spawnAgent(config);

        // Emit error after a tick
        setImmediate(() => {
          mockProcess.emit("error", new Error("spawn failed"));
        });

        await expect(handle.result).rejects.toThrow(AgentSpawnError);
        await expect(handle.result).rejects.toThrow("Failed to spawn agent");
      });
    });

    describe("kill functionality", () => {
      it("should kill the process gracefully", async () => {
        const promptFile = createTestPrompt();
        const mockProcess = createMockProcess(0);
        mockedSpawn.mockReturnValue(mockProcess);

        const config: AgentConfig = {
          name: "test-agent",
          promptFile,
          context: "test",
          stdio: "pipe",
        };

        const handle = spawnAgent(config);

        // Kill immediately
        handle.kill();

        const result = await handle.result;
        expect(result.killed).toBe(true);
        expect((mockProcess as any).kill).toHaveBeenCalledWith("SIGTERM");
      });

      it("should not kill if already killed", async () => {
        const promptFile = createTestPrompt();
        const mockProcess = createMockProcess(0);
        (mockProcess as any).killed = true;
        mockedSpawn.mockReturnValue(mockProcess);

        const config: AgentConfig = {
          name: "test-agent",
          promptFile,
          context: "test",
          stdio: "pipe",
        };

        const handle = spawnAgent(config);
        handle.kill();

        // kill should not be called since process is already killed
        expect((mockProcess as any).kill).not.toHaveBeenCalled();
      });
    });

    describe("agent handle properties", () => {
      it("should return agent name in handle", () => {
        const promptFile = createTestPrompt();
        const mockProcess = createMockProcess(0);
        mockedSpawn.mockReturnValue(mockProcess);

        const config: AgentConfig = {
          name: "my-test-agent",
          promptFile,
          context: "test",
          stdio: "pipe",
        };

        const handle = spawnAgent(config);
        expect(handle.name).toBe("my-test-agent");
      });

      it("should expose the child process", () => {
        const promptFile = createTestPrompt();
        const mockProcess = createMockProcess(0);
        mockedSpawn.mockReturnValue(mockProcess);

        const config: AgentConfig = {
          name: "test-agent",
          promptFile,
          context: "test",
          stdio: "pipe",
        };

        const handle = spawnAgent(config);
        expect(handle.process).toBe(mockProcess);
      });
    });
  });

  describe("runAgent", () => {
    const createTestPrompt = (): string => {
      const filePath = path.join(TEST_PROMPTS_DIR, "test-prompt.md");
      fs.writeFileSync(filePath, "Test prompt");
      return filePath;
    };

    it("should spawn and wait for agent completion", async () => {
      const promptFile = createTestPrompt();
      const mockProcess = createMockProcess(0, "output", "");
      mockedSpawn.mockReturnValue(mockProcess);

      const config: AgentConfig = {
        name: "test-agent",
        promptFile,
        context: "test",
        stdio: "pipe",
      };

      const result = await runAgent(config);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("output");
    });
  });

  describe("Result Status Functions", () => {
    describe("isSuccess", () => {
      it("should return true for exit code 0", () => {
        const result: AgentResult = {
          exitCode: EXIT_CODES.SUCCESS,
          stdout: "",
          stderr: "",
          killed: false,
        };
        expect(isSuccess(result)).toBe(true);
      });

      it("should return false for exit code 1", () => {
        const result: AgentResult = {
          exitCode: EXIT_CODES.ERROR,
          stdout: "",
          stderr: "",
          killed: false,
        };
        expect(isSuccess(result)).toBe(false);
      });

      it("should return false for exit code 2", () => {
        const result: AgentResult = {
          exitCode: EXIT_CODES.BLOCKED,
          stdout: "",
          stderr: "",
          killed: false,
        };
        expect(isSuccess(result)).toBe(false);
      });
    });

    describe("isBlocked", () => {
      it("should return true for exit code 2", () => {
        const result: AgentResult = {
          exitCode: EXIT_CODES.BLOCKED,
          stdout: "",
          stderr: "",
          killed: false,
        };
        expect(isBlocked(result)).toBe(true);
      });

      it("should return false for exit code 0", () => {
        const result: AgentResult = {
          exitCode: EXIT_CODES.SUCCESS,
          stdout: "",
          stderr: "",
          killed: false,
        };
        expect(isBlocked(result)).toBe(false);
      });
    });

    describe("isError", () => {
      it("should return true for exit code 1", () => {
        const result: AgentResult = {
          exitCode: EXIT_CODES.ERROR,
          stdout: "",
          stderr: "",
          killed: false,
        };
        expect(isError(result)).toBe(true);
      });

      it("should return false for exit code 0", () => {
        const result: AgentResult = {
          exitCode: EXIT_CODES.SUCCESS,
          stdout: "",
          stderr: "",
          killed: false,
        };
        expect(isError(result)).toBe(false);
      });
    });

    describe("getResultStatus", () => {
      it("should return 'success' for exit code 0", () => {
        const result: AgentResult = {
          exitCode: EXIT_CODES.SUCCESS,
          stdout: "",
          stderr: "",
          killed: false,
        };
        expect(getResultStatus(result)).toBe("success");
      });

      it("should return 'error' for exit code 1", () => {
        const result: AgentResult = {
          exitCode: EXIT_CODES.ERROR,
          stdout: "",
          stderr: "",
          killed: false,
        };
        expect(getResultStatus(result)).toBe("error");
      });

      it("should return 'blocked' for exit code 2", () => {
        const result: AgentResult = {
          exitCode: EXIT_CODES.BLOCKED,
          stdout: "",
          stderr: "",
          killed: false,
        };
        expect(getResultStatus(result)).toBe("blocked");
      });

      it("should return 'killed' if process was killed", () => {
        const result: AgentResult = {
          exitCode: 0,
          stdout: "",
          stderr: "",
          killed: true,
        };
        expect(getResultStatus(result)).toBe("killed");
      });

      it("should return 'unknown' for unexpected exit code", () => {
        const result: AgentResult = {
          exitCode: 42,
          stdout: "",
          stderr: "",
          killed: false,
        };
        expect(getResultStatus(result)).toBe("unknown (exit code: 42)");
      });
    });
  });
});
