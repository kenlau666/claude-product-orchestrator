import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { ORCHESTRATOR_DIR, BlockedState } from "./types";

/**
 * Exit codes for agent processes
 */
export const EXIT_CODES = {
  SUCCESS: 0,
  ERROR: 1,
  BLOCKED: 2,
} as const;

/**
 * Questions directory path
 */
export const QUESTIONS_DIR = path.join(ORCHESTRATOR_DIR, "questions");

/**
 * Recipient types for question routing
 */
export type QuestionRecipient = "user" | "po" | "tech_lead";

/**
 * Parsed question file structure
 */
export interface ParsedQuestion {
  filePath: string;
  fromAgent: string;
  forRecipient: QuestionRecipient;
  context: string;
  question: string;
  options: string[];
  rawContent: string;
}

/**
 * Error thrown for blocking handler operations
 */
export class BlockingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockingError";
  }
}

/**
 * Check if an exit code indicates blocked status
 */
export function isBlockedExitCode(exitCode: number): boolean {
  return exitCode === EXIT_CODES.BLOCKED;
}

/**
 * Check if an exit code indicates success
 */
export function isSuccessExitCode(exitCode: number): boolean {
  return exitCode === EXIT_CODES.SUCCESS;
}

/**
 * Check if an exit code indicates error
 */
export function isErrorExitCode(exitCode: number): boolean {
  return exitCode === EXIT_CODES.ERROR;
}

/**
 * Ensure questions directory exists
 */
export function ensureQuestionsDir(): void {
  if (!fs.existsSync(QUESTIONS_DIR)) {
    fs.mkdirSync(QUESTIONS_DIR, { recursive: true });
  }
}

/**
 * List all question files in the questions directory
 * Returns files sorted by modification time (newest first)
 */
export function listQuestionFiles(): string[] {
  ensureQuestionsDir();

  const files = fs.readdirSync(QUESTIONS_DIR);
  const questionFiles = files
    .filter((f) => f.endsWith(".md") && f.startsWith("q-"))
    .map((f) => path.join(QUESTIONS_DIR, f))
    .sort((a, b) => {
      const statA = fs.statSync(a);
      const statB = fs.statSync(b);
      return statB.mtimeMs - statA.mtimeMs;
    });

  return questionFiles;
}

/**
 * Find the latest question file without a response
 */
export function findLatestUnansweredQuestion(): string | null {
  const questionFiles = listQuestionFiles();

  for (const questionFile of questionFiles) {
    const responseFile = getResponseFilePath(questionFile);
    if (!fs.existsSync(responseFile)) {
      return questionFile;
    }
  }

  return null;
}

/**
 * Get the response file path for a question file
 */
export function getResponseFilePath(questionFile: string): string {
  return questionFile.replace(/\.md$/, ".response");
}

/**
 * Generate the next question file name
 */
export function generateQuestionFileName(): string {
  ensureQuestionsDir();

  const files = fs.readdirSync(QUESTIONS_DIR);
  const questionNumbers = files
    .filter((f) => f.match(/^q-\d+\.md$/))
    .map((f) => parseInt(f.match(/^q-(\d+)\.md$/)![1], 10));

  const nextNumber = questionNumbers.length > 0 ? Math.max(...questionNumbers) + 1 : 1;
  const paddedNumber = String(nextNumber).padStart(3, "0");

  return path.join(QUESTIONS_DIR, `q-${paddedNumber}.md`);
}

/**
 * Parse a question file and extract metadata
 */
export function parseQuestionFile(filePath: string): ParsedQuestion {
  if (!fs.existsSync(filePath)) {
    throw new BlockingError(`Question file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  let fromAgent = "";
  let forRecipient: QuestionRecipient = "user";
  let context = "";
  let question = "";
  const options: string[] = [];

  let currentSection = "";
  let sectionContent: string[] = [];

  const saveSection = () => {
    const text = sectionContent.join("\n").trim();
    if (currentSection === "context") {
      context = text;
    } else if (currentSection === "question") {
      question = text;
    } else if (currentSection === "options") {
      // Parse options from the collected text
      const optionLines = text.split("\n").filter((l) => l.trim());
      options.push(...optionLines);
    }
    sectionContent = [];
  };

  for (const line of lines) {
    // Parse "# Question from: agent-name"
    const fromMatch = line.match(/^#\s*Question from:\s*(.+)$/i);
    if (fromMatch) {
      fromAgent = fromMatch[1].trim();
      continue;
    }

    // Parse "## For: recipient"
    const forMatch = line.match(/^##\s*For:\s*(.+)$/i);
    if (forMatch) {
      const recipient = forMatch[1].trim().toLowerCase();
      if (recipient === "user" || recipient === "po" || recipient === "tech_lead") {
        forRecipient = recipient;
      } else {
        // Default to user for unknown recipients
        forRecipient = "user";
      }
      continue;
    }

    // Parse section headers
    const sectionMatch = line.match(/^##\s*(.+)$/i);
    if (sectionMatch) {
      saveSection();
      const sectionName = sectionMatch[1].trim().toLowerCase();
      if (sectionName.includes("context")) {
        currentSection = "context";
      } else if (sectionName.includes("question")) {
        currentSection = "question";
      } else if (sectionName.includes("option")) {
        currentSection = "options";
      } else {
        currentSection = "";
      }
      continue;
    }

    // Accumulate section content
    if (currentSection) {
      sectionContent.push(line);
    }
  }

  // Save last section
  saveSection();

  return {
    filePath,
    fromAgent,
    forRecipient,
    context,
    question,
    options,
    rawContent: content,
  };
}

/**
 * Write a response to a question file
 */
export function writeResponse(questionFile: string, response: string): string {
  const responseFile = getResponseFilePath(questionFile);

  // Use atomic write
  const tempFile = `${responseFile}.tmp.${Date.now()}`;
  const content = `# Response\n\n${response}\n\nAnswered: ${new Date().toISOString()}\n`;

  fs.writeFileSync(tempFile, content, { encoding: "utf-8" });
  fs.renameSync(tempFile, responseFile);

  return responseFile;
}

/**
 * Read a response file
 */
export function readResponse(questionFile: string): string | null {
  const responseFile = getResponseFilePath(questionFile);

  if (!fs.existsSync(responseFile)) {
    return null;
  }

  const content = fs.readFileSync(responseFile, "utf-8");

  // Extract the response text (between "# Response" and "Answered:")
  const lines = content.split("\n");
  const responseLines: string[] = [];
  let inResponse = false;

  for (const line of lines) {
    if (line.startsWith("# Response")) {
      inResponse = true;
      continue;
    }
    if (line.startsWith("Answered:")) {
      break;
    }
    if (inResponse) {
      responseLines.push(line);
    }
  }

  return responseLines.join("\n").trim();
}

/**
 * Check if a question has been answered
 */
export function hasResponse(questionFile: string): boolean {
  const responseFile = getResponseFilePath(questionFile);
  return fs.existsSync(responseFile);
}

/**
 * Determine routing for a question based on recipient
 */
export function routeQuestion(
  parsedQuestion: ParsedQuestion
): "prompt_user" | "spawn_po" | "spawn_tech_lead" {
  switch (parsedQuestion.forRecipient) {
    case "user":
      return "prompt_user";
    case "po":
      return "spawn_po";
    case "tech_lead":
      return "spawn_tech_lead";
    default:
      return "prompt_user";
  }
}

/**
 * Format a question for display to the user
 */
export function formatQuestionForDisplay(parsedQuestion: ParsedQuestion): string {
  const lines: string[] = [];

  lines.push("");
  lines.push("━".repeat(60));
  lines.push(`Question from: ${parsedQuestion.fromAgent || "Unknown Agent"}`);
  lines.push("━".repeat(60));

  if (parsedQuestion.context) {
    lines.push("");
    lines.push("Context:");
    lines.push(parsedQuestion.context);
  }

  lines.push("");
  lines.push("Question:");
  lines.push(parsedQuestion.question);

  if (parsedQuestion.options.length > 0) {
    lines.push("");
    lines.push("Options:");
    for (const option of parsedQuestion.options) {
      lines.push(`  ${option}`);
    }
  }

  lines.push("");
  lines.push("━".repeat(60));

  return lines.join("\n");
}

/**
 * Prompt the user for input via terminal
 * Returns a promise that resolves with the user's response
 */
export function promptUser(
  parsedQuestion: ParsedQuestion,
  inputStream: NodeJS.ReadableStream = process.stdin,
  outputStream: NodeJS.WritableStream = process.stdout
): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: inputStream,
      output: outputStream,
    });

    // Display the question
    outputStream.write(formatQuestionForDisplay(parsedQuestion));
    outputStream.write("\nYour answer: ");

    rl.question("", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Write a question file (for agents to use)
 */
export function writeQuestionFile(
  fromAgent: string,
  forRecipient: QuestionRecipient,
  context: string,
  question: string,
  options: string[] = []
): string {
  const filePath = generateQuestionFileName();

  const lines: string[] = [];
  lines.push(`# Question from: ${fromAgent}`);
  lines.push("");
  lines.push(`## For: ${forRecipient}`);
  lines.push("");
  lines.push("## Context");
  lines.push("");
  lines.push(context);
  lines.push("");
  lines.push("## Question");
  lines.push("");
  lines.push(question);

  if (options.length > 0) {
    lines.push("");
    lines.push("## Options");
    lines.push("");
    for (const option of options) {
      lines.push(option);
    }
  }

  const content = lines.join("\n") + "\n";

  // Use atomic write
  const tempFile = `${filePath}.tmp.${Date.now()}`;
  fs.writeFileSync(tempFile, content, { encoding: "utf-8" });
  fs.renameSync(tempFile, filePath);

  return filePath;
}

/**
 * Get the blocked agent type from agent name
 */
export function getBlockedAgentType(
  agentName: string
): BlockedState["blockedAgent"] {
  const name = agentName.toLowerCase();
  if (name.includes("po")) {
    return "po";
  }
  if (name.includes("tech") || name.includes("lead")) {
    return "tech_lead";
  }
  if (name.includes("dev")) {
    return "dev";
  }
  return null;
}

/**
 * BlockingHandler class to manage the full blocking workflow
 */
export class BlockingHandler {
  /**
   * Handle an agent exit with blocked status
   * Returns the question file path if blocking was detected
   */
  handleAgentExit(exitCode: number, agentName: string): string | null {
    if (!isBlockedExitCode(exitCode)) {
      return null;
    }

    // Find the latest unanswered question
    const questionFile = findLatestUnansweredQuestion();
    return questionFile;
  }

  /**
   * Process a blocking question
   * Routes to appropriate handler and returns the response
   */
  async processQuestion(
    questionFile: string,
    inputStream?: NodeJS.ReadableStream,
    outputStream?: NodeJS.WritableStream
  ): Promise<{
    routing: "prompt_user" | "spawn_po" | "spawn_tech_lead";
    response: string | null;
    responseFile: string | null;
  }> {
    const parsedQuestion = parseQuestionFile(questionFile);
    const routing = routeQuestion(parsedQuestion);

    // For user routing, prompt directly
    if (routing === "prompt_user") {
      const response = await promptUser(parsedQuestion, inputStream, outputStream);
      const responseFile = writeResponse(questionFile, response);
      return { routing, response, responseFile };
    }

    // For agent routing, return null response (caller should spawn agent)
    return { routing, response: null, responseFile: null };
  }

  /**
   * Get the response for a question file (for resuming an agent)
   */
  getResponse(questionFile: string): string | null {
    return readResponse(questionFile);
  }

  /**
   * Check if a question has been answered
   */
  isAnswered(questionFile: string): boolean {
    return hasResponse(questionFile);
  }

  /**
   * Create a question file (for testing or agent use)
   */
  createQuestion(
    fromAgent: string,
    forRecipient: QuestionRecipient,
    context: string,
    question: string,
    options: string[] = []
  ): string {
    return writeQuestionFile(fromAgent, forRecipient, context, question, options);
  }
}
