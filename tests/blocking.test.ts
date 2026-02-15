import * as fs from "fs";
import * as path from "path";
import { Readable, Writable } from "stream";
import {
  BlockingHandler,
  BlockingError,
  EXIT_CODES,
  QUESTIONS_DIR,
  isBlockedExitCode,
  isSuccessExitCode,
  isErrorExitCode,
  ensureQuestionsDir,
  listQuestionFiles,
  findLatestUnansweredQuestion,
  getResponseFilePath,
  generateQuestionFileName,
  parseQuestionFile,
  writeResponse,
  readResponse,
  hasResponse,
  routeQuestion,
  formatQuestionForDisplay,
  promptUser,
  writeQuestionFile,
  getBlockedAgentType,
  ParsedQuestion,
} from "../src/blocking";

// Test directory for isolation
const TEST_DIR = path.join(__dirname, ".test-orchestrator");
const TEST_QUESTIONS_DIR = path.join(TEST_DIR, "questions");

// Mock the constants to use test directory
jest.mock("../src/types", () => {
  const originalModule = jest.requireActual("../src/types");
  const testDir = require("path").join(__dirname, ".test-orchestrator");
  return {
    ...originalModule,
    ORCHESTRATOR_DIR: testDir,
  };
});

// We need to also update the QUESTIONS_DIR in blocking module
// This is done by the mock above affecting the import

describe("Blocking Module", () => {
  beforeEach(() => {
    // Clean up test directory before each test
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_QUESTIONS_DIR, { recursive: true });
  });

  afterAll(() => {
    // Clean up test directory after all tests
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe("Exit Code Detection", () => {
    describe("isBlockedExitCode", () => {
      it("should return true for exit code 2", () => {
        expect(isBlockedExitCode(2)).toBe(true);
      });

      it("should return false for exit code 0", () => {
        expect(isBlockedExitCode(0)).toBe(false);
      });

      it("should return false for exit code 1", () => {
        expect(isBlockedExitCode(1)).toBe(false);
      });
    });

    describe("isSuccessExitCode", () => {
      it("should return true for exit code 0", () => {
        expect(isSuccessExitCode(0)).toBe(true);
      });

      it("should return false for exit code 1", () => {
        expect(isSuccessExitCode(1)).toBe(false);
      });

      it("should return false for exit code 2", () => {
        expect(isSuccessExitCode(2)).toBe(false);
      });
    });

    describe("isErrorExitCode", () => {
      it("should return true for exit code 1", () => {
        expect(isErrorExitCode(1)).toBe(true);
      });

      it("should return false for exit code 0", () => {
        expect(isErrorExitCode(0)).toBe(false);
      });

      it("should return false for exit code 2", () => {
        expect(isErrorExitCode(2)).toBe(false);
      });
    });

    it("should have correct EXIT_CODES constants", () => {
      expect(EXIT_CODES.SUCCESS).toBe(0);
      expect(EXIT_CODES.ERROR).toBe(1);
      expect(EXIT_CODES.BLOCKED).toBe(2);
    });
  });

  describe("Question File Operations", () => {
    describe("listQuestionFiles", () => {
      it("should return empty array when no question files exist", () => {
        const files = listQuestionFiles();
        expect(files).toEqual([]);
      });

      it("should list question files sorted by modification time", () => {
        // Create test files with slight delay
        const file1 = path.join(TEST_QUESTIONS_DIR, "q-001.md");
        const file2 = path.join(TEST_QUESTIONS_DIR, "q-002.md");

        fs.writeFileSync(file1, "test 1");
        // Touch file2 slightly later
        fs.writeFileSync(file2, "test 2");

        const files = listQuestionFiles();
        expect(files).toHaveLength(2);
        // Most recent first
        expect(files[0]).toContain("q-002.md");
      });

      it("should ignore non-question files", () => {
        fs.writeFileSync(path.join(TEST_QUESTIONS_DIR, "q-001.md"), "test");
        fs.writeFileSync(path.join(TEST_QUESTIONS_DIR, "other.txt"), "test");
        fs.writeFileSync(path.join(TEST_QUESTIONS_DIR, "q-001.response"), "test");

        const files = listQuestionFiles();
        expect(files).toHaveLength(1);
      });
    });

    describe("generateQuestionFileName", () => {
      it("should generate q-001.md for first question", () => {
        const fileName = generateQuestionFileName();
        expect(fileName).toContain("q-001.md");
      });

      it("should increment number for subsequent questions", () => {
        fs.writeFileSync(path.join(TEST_QUESTIONS_DIR, "q-001.md"), "test");
        fs.writeFileSync(path.join(TEST_QUESTIONS_DIR, "q-002.md"), "test");

        const fileName = generateQuestionFileName();
        expect(fileName).toContain("q-003.md");
      });
    });

    describe("getResponseFilePath", () => {
      it("should replace .md with .response", () => {
        const questionFile = "/path/to/q-001.md";
        const responseFile = getResponseFilePath(questionFile);
        expect(responseFile).toBe("/path/to/q-001.response");
      });
    });

    describe("findLatestUnansweredQuestion", () => {
      it("should return null when no questions exist", () => {
        const result = findLatestUnansweredQuestion();
        expect(result).toBeNull();
      });

      it("should return latest unanswered question", () => {
        const q1 = path.join(TEST_QUESTIONS_DIR, "q-001.md");
        const q2 = path.join(TEST_QUESTIONS_DIR, "q-002.md");
        const r1 = path.join(TEST_QUESTIONS_DIR, "q-001.response");

        fs.writeFileSync(q1, "test 1");
        fs.writeFileSync(q2, "test 2");
        fs.writeFileSync(r1, "response 1"); // q-001 is answered

        const result = findLatestUnansweredQuestion();
        expect(result).toContain("q-002.md");
      });

      it("should return null when all questions are answered", () => {
        const q1 = path.join(TEST_QUESTIONS_DIR, "q-001.md");
        const r1 = path.join(TEST_QUESTIONS_DIR, "q-001.response");

        fs.writeFileSync(q1, "test 1");
        fs.writeFileSync(r1, "response 1");

        const result = findLatestUnansweredQuestion();
        expect(result).toBeNull();
      });
    });
  });

  describe("parseQuestionFile", () => {
    const createQuestionFile = (content: string): string => {
      const filePath = path.join(TEST_QUESTIONS_DIR, "q-test.md");
      fs.writeFileSync(filePath, content);
      return filePath;
    };

    it("should parse a complete question file", () => {
      const content = `# Question from: dev-frontend

## For: tech_lead

## Context

Working on ticket #3

## Question

Should login use OAuth or email?

## Options

A: OAuth only
B: Email/password only
C: Both
`;

      const filePath = createQuestionFile(content);
      const parsed = parseQuestionFile(filePath);

      expect(parsed.fromAgent).toBe("dev-frontend");
      expect(parsed.forRecipient).toBe("tech_lead");
      expect(parsed.context).toBe("Working on ticket #3");
      expect(parsed.question).toBe("Should login use OAuth or email?");
      expect(parsed.options).toEqual([
        "A: OAuth only",
        "B: Email/password only",
        "C: Both",
      ]);
    });

    it("should parse question file for user recipient", () => {
      const content = `# Question from: po

## For: user

## Context

Gathering requirements

## Question

What is your target audience?
`;

      const filePath = createQuestionFile(content);
      const parsed = parseQuestionFile(filePath);

      expect(parsed.forRecipient).toBe("user");
    });

    it("should parse question file for po recipient", () => {
      const content = `# Question from: tech_lead

## For: po

## Context

Clarifying PRD

## Question

Should we include mobile support?
`;

      const filePath = createQuestionFile(content);
      const parsed = parseQuestionFile(filePath);

      expect(parsed.forRecipient).toBe("po");
    });

    it("should default to user for unknown recipient", () => {
      const content = `# Question from: agent

## For: unknown_recipient

## Question

Test question
`;

      const filePath = createQuestionFile(content);
      const parsed = parseQuestionFile(filePath);

      expect(parsed.forRecipient).toBe("user");
    });

    it("should throw BlockingError for non-existent file", () => {
      expect(() => parseQuestionFile("/nonexistent/file.md")).toThrow(
        BlockingError
      );
    });

    it("should handle question file without options", () => {
      const content = `# Question from: agent

## For: user

## Question

Simple question without options
`;

      const filePath = createQuestionFile(content);
      const parsed = parseQuestionFile(filePath);

      expect(parsed.options).toEqual([]);
    });
  });

  describe("Response Operations", () => {
    describe("writeResponse", () => {
      it("should write response to .response file", () => {
        const questionFile = path.join(TEST_QUESTIONS_DIR, "q-001.md");
        fs.writeFileSync(questionFile, "test question");

        const responseFile = writeResponse(questionFile, "My answer is B");

        expect(fs.existsSync(responseFile)).toBe(true);
        expect(responseFile).toContain("q-001.response");

        const content = fs.readFileSync(responseFile, "utf-8");
        expect(content).toContain("My answer is B");
        expect(content).toContain("Answered:");
      });

      it("should use atomic write (no temp files left behind)", () => {
        const questionFile = path.join(TEST_QUESTIONS_DIR, "q-001.md");
        fs.writeFileSync(questionFile, "test question");

        writeResponse(questionFile, "test response");

        const files = fs.readdirSync(TEST_QUESTIONS_DIR);
        const tempFiles = files.filter((f) => f.includes(".tmp."));
        expect(tempFiles).toHaveLength(0);
      });
    });

    describe("readResponse", () => {
      it("should read response content", () => {
        const questionFile = path.join(TEST_QUESTIONS_DIR, "q-001.md");
        fs.writeFileSync(questionFile, "test question");
        writeResponse(questionFile, "My answer is A");

        const response = readResponse(questionFile);
        expect(response).toBe("My answer is A");
      });

      it("should return null if response doesn't exist", () => {
        const questionFile = path.join(TEST_QUESTIONS_DIR, "q-001.md");
        fs.writeFileSync(questionFile, "test question");

        const response = readResponse(questionFile);
        expect(response).toBeNull();
      });
    });

    describe("hasResponse", () => {
      it("should return true if response exists", () => {
        const questionFile = path.join(TEST_QUESTIONS_DIR, "q-001.md");
        fs.writeFileSync(questionFile, "test question");
        writeResponse(questionFile, "answer");

        expect(hasResponse(questionFile)).toBe(true);
      });

      it("should return false if response doesn't exist", () => {
        const questionFile = path.join(TEST_QUESTIONS_DIR, "q-001.md");
        fs.writeFileSync(questionFile, "test question");

        expect(hasResponse(questionFile)).toBe(false);
      });
    });
  });

  describe("routeQuestion", () => {
    it("should route user recipient to prompt_user", () => {
      const question: ParsedQuestion = {
        filePath: "",
        fromAgent: "agent",
        forRecipient: "user",
        context: "",
        question: "",
        options: [],
        rawContent: "",
      };

      expect(routeQuestion(question)).toBe("prompt_user");
    });

    it("should route po recipient to spawn_po", () => {
      const question: ParsedQuestion = {
        filePath: "",
        fromAgent: "agent",
        forRecipient: "po",
        context: "",
        question: "",
        options: [],
        rawContent: "",
      };

      expect(routeQuestion(question)).toBe("spawn_po");
    });

    it("should route tech_lead recipient to spawn_tech_lead", () => {
      const question: ParsedQuestion = {
        filePath: "",
        fromAgent: "agent",
        forRecipient: "tech_lead",
        context: "",
        question: "",
        options: [],
        rawContent: "",
      };

      expect(routeQuestion(question)).toBe("spawn_tech_lead");
    });
  });

  describe("formatQuestionForDisplay", () => {
    it("should format question with all fields", () => {
      const question: ParsedQuestion = {
        filePath: "",
        fromAgent: "dev-frontend",
        forRecipient: "user",
        context: "Working on login",
        question: "Should we use OAuth?",
        options: ["A: Yes", "B: No"],
        rawContent: "",
      };

      const formatted = formatQuestionForDisplay(question);

      expect(formatted).toContain("dev-frontend");
      expect(formatted).toContain("Working on login");
      expect(formatted).toContain("Should we use OAuth?");
      expect(formatted).toContain("A: Yes");
      expect(formatted).toContain("B: No");
    });

    it("should handle missing context", () => {
      const question: ParsedQuestion = {
        filePath: "",
        fromAgent: "agent",
        forRecipient: "user",
        context: "",
        question: "Simple question",
        options: [],
        rawContent: "",
      };

      const formatted = formatQuestionForDisplay(question);

      expect(formatted).toContain("Simple question");
      expect(formatted).not.toContain("Context:");
    });
  });

  describe("writeQuestionFile", () => {
    it("should create a properly formatted question file", () => {
      const filePath = writeQuestionFile(
        "dev-backend",
        "tech_lead",
        "Working on API",
        "How should we handle auth?",
        ["A: JWT", "B: Sessions"]
      );

      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, "utf-8");
      expect(content).toContain("# Question from: dev-backend");
      expect(content).toContain("## For: tech_lead");
      expect(content).toContain("Working on API");
      expect(content).toContain("How should we handle auth?");
      expect(content).toContain("A: JWT");
      expect(content).toContain("B: Sessions");
    });

    it("should create question file without options", () => {
      const filePath = writeQuestionFile(
        "po",
        "user",
        "Requirements gathering",
        "What is your budget?"
      );

      const content = fs.readFileSync(filePath, "utf-8");
      expect(content).not.toContain("## Options");
    });
  });

  describe("getBlockedAgentType", () => {
    it("should identify po agent", () => {
      expect(getBlockedAgentType("po")).toBe("po");
      expect(getBlockedAgentType("PO")).toBe("po");
      expect(getBlockedAgentType("po-agent")).toBe("po");
    });

    it("should identify tech_lead agent", () => {
      expect(getBlockedAgentType("tech_lead")).toBe("tech_lead");
      expect(getBlockedAgentType("tech-lead")).toBe("tech_lead");
      expect(getBlockedAgentType("Tech Lead")).toBe("tech_lead");
    });

    it("should identify dev agent", () => {
      expect(getBlockedAgentType("dev")).toBe("dev");
      expect(getBlockedAgentType("dev-frontend")).toBe("dev");
      expect(getBlockedAgentType("dev-backend")).toBe("dev");
    });

    it("should return null for unknown agent", () => {
      expect(getBlockedAgentType("unknown")).toBeNull();
    });
  });

  describe("promptUser", () => {
    it("should prompt user and return response", async () => {
      const question: ParsedQuestion = {
        filePath: "",
        fromAgent: "agent",
        forRecipient: "user",
        context: "",
        question: "Test question",
        options: [],
        rawContent: "",
      };

      // Create mock streams
      const mockInput = new Readable({
        read() {
          this.push("user response\n");
          this.push(null);
        },
      });

      let output = "";
      const mockOutput = new Writable({
        write(chunk, encoding, callback) {
          output += chunk.toString();
          callback();
        },
      });

      const response = await promptUser(question, mockInput, mockOutput);

      expect(response).toBe("user response");
      expect(output).toContain("Test question");
    });
  });

  describe("BlockingHandler", () => {
    let handler: BlockingHandler;

    beforeEach(() => {
      handler = new BlockingHandler();
    });

    describe("handleAgentExit", () => {
      it("should return null for non-blocked exit code", () => {
        const result = handler.handleAgentExit(0, "dev-frontend");
        expect(result).toBeNull();
      });

      it("should return question file for blocked exit code", () => {
        // Create an unanswered question
        const questionFile = writeQuestionFile(
          "dev-frontend",
          "user",
          "context",
          "question"
        );

        const result = handler.handleAgentExit(2, "dev-frontend");
        expect(result).toBe(questionFile);
      });

      it("should return null if no unanswered questions", () => {
        const result = handler.handleAgentExit(2, "dev-frontend");
        expect(result).toBeNull();
      });
    });

    describe("processQuestion", () => {
      it("should prompt user and return response for user routing", async () => {
        const questionFile = writeQuestionFile(
          "agent",
          "user",
          "context",
          "question",
          ["A: Option A", "B: Option B"]
        );

        const mockInput = new Readable({
          read() {
            this.push("A\n");
            this.push(null);
          },
        });

        const mockOutput = new Writable({
          write(chunk, encoding, callback) {
            callback();
          },
        });

        const result = await handler.processQuestion(
          questionFile,
          mockInput,
          mockOutput
        );

        expect(result.routing).toBe("prompt_user");
        expect(result.response).toBe("A");
        expect(result.responseFile).not.toBeNull();
      });

      it("should return spawn_po routing for po recipient", async () => {
        const questionFile = writeQuestionFile(
          "dev",
          "po",
          "context",
          "question"
        );

        const result = await handler.processQuestion(questionFile);

        expect(result.routing).toBe("spawn_po");
        expect(result.response).toBeNull();
      });

      it("should return spawn_tech_lead routing for tech_lead recipient", async () => {
        const questionFile = writeQuestionFile(
          "dev",
          "tech_lead",
          "context",
          "question"
        );

        const result = await handler.processQuestion(questionFile);

        expect(result.routing).toBe("spawn_tech_lead");
        expect(result.response).toBeNull();
      });
    });

    describe("getResponse", () => {
      it("should return response content", () => {
        const questionFile = writeQuestionFile(
          "agent",
          "user",
          "context",
          "question"
        );
        writeResponse(questionFile, "test response");

        const response = handler.getResponse(questionFile);
        expect(response).toBe("test response");
      });

      it("should return null if no response exists", () => {
        const questionFile = writeQuestionFile(
          "agent",
          "user",
          "context",
          "question"
        );

        const response = handler.getResponse(questionFile);
        expect(response).toBeNull();
      });
    });

    describe("isAnswered", () => {
      it("should return true if question is answered", () => {
        const questionFile = writeQuestionFile(
          "agent",
          "user",
          "context",
          "question"
        );
        writeResponse(questionFile, "answer");

        expect(handler.isAnswered(questionFile)).toBe(true);
      });

      it("should return false if question is not answered", () => {
        const questionFile = writeQuestionFile(
          "agent",
          "user",
          "context",
          "question"
        );

        expect(handler.isAnswered(questionFile)).toBe(false);
      });
    });

    describe("createQuestion", () => {
      it("should create a question file", () => {
        const questionFile = handler.createQuestion(
          "test-agent",
          "user",
          "test context",
          "test question",
          ["A: Option A"]
        );

        expect(fs.existsSync(questionFile)).toBe(true);

        const parsed = parseQuestionFile(questionFile);
        expect(parsed.fromAgent).toBe("test-agent");
        expect(parsed.forRecipient).toBe("user");
      });
    });
  });
});
