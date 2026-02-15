import { Octokit } from "@octokit/rest";
import * as fs from "fs";
import { Config, CONFIG_FILE } from "./types";

/**
 * GitHub issue representation
 */
export interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Area label prefix
 */
const AREA_LABEL_PREFIX = "area:";

/**
 * Rate limit configuration
 */
const RATE_LIMIT_RETRY_DELAY_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_RETRIES = 3;

/**
 * Parse GitHub repository URL to extract owner and repo name
 */
function parseRepoUrl(repoUrl: string): { owner: string; repo: string } {
  // Handle various GitHub URL formats:
  // https://github.com/owner/repo
  // https://github.com/owner/repo.git
  // git@github.com:owner/repo.git
  const httpsMatch = repoUrl.match(
    /github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/
  );
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  const sshMatch = repoUrl.match(/github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  throw new Error(`Invalid GitHub repository URL: ${repoUrl}`);
}

/**
 * Load configuration and create Octokit client
 */
function loadConfig(): { octokit: Octokit; owner: string; repo: string } {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(
      "Orchestrator not initialized. Run: orchestrator init <repo-url> --token <token>"
    );
  }

  const config: Config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  const { owner, repo } = parseRepoUrl(config.repoUrl);
  const octokit = new Octokit({ auth: config.token });

  return { octokit, owner, repo };
}

/**
 * Sleep helper for rate limit handling
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a GitHub API call with rate limit handling
 */
async function withRateLimitRetry<T>(
  operation: () => Promise<T>,
  operationName: string
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < RATE_LIMIT_MAX_RETRIES; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      const err = error as { status?: number; message?: string };

      // Check for rate limit errors (403 with rate limit message or 429)
      if (
        err.status === 403 &&
        err.message?.toLowerCase().includes("rate limit")
      ) {
        console.warn(
          `Rate limit hit during ${operationName}. Attempt ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES}. Waiting ${RATE_LIMIT_RETRY_DELAY_MS / 1000}s...`
        );
        await sleep(RATE_LIMIT_RETRY_DELAY_MS);
        lastError = error as Error;
        continue;
      }

      if (err.status === 429) {
        console.warn(
          `Rate limit (429) during ${operationName}. Attempt ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES}. Waiting ${RATE_LIMIT_RETRY_DELAY_MS / 1000}s...`
        );
        await sleep(RATE_LIMIT_RETRY_DELAY_MS);
        lastError = error as Error;
        continue;
      }

      // Re-throw non-rate-limit errors immediately
      throw error;
    }
  }

  throw new Error(
    `${operationName} failed after ${RATE_LIMIT_MAX_RETRIES} rate limit retries: ${lastError?.message}`
  );
}

/**
 * Create a GitHub issue with an area label
 *
 * @param title - Issue title
 * @param body - Issue body/description
 * @param area - Area for the issue (e.g., "frontend", "backend")
 * @returns The created issue number
 */
export async function createIssue(
  title: string,
  body: string,
  area: string
): Promise<number> {
  const { octokit, owner, repo } = loadConfig();
  const areaLabel = `${AREA_LABEL_PREFIX}${area}`;

  const response = await withRateLimitRetry(
    () =>
      octokit.issues.create({
        owner,
        repo,
        title,
        body,
        labels: [areaLabel],
      }),
    "createIssue"
  );

  return response.data.number;
}

/**
 * Get issues filtered by area label
 *
 * @param area - Area to filter by (e.g., "frontend", "backend")
 * @returns Array of issues with the specified area label
 */
export async function getIssuesByArea(area: string): Promise<Issue[]> {
  const { octokit, owner, repo } = loadConfig();
  const areaLabel = `${AREA_LABEL_PREFIX}${area}`;

  const response = await withRateLimitRetry(
    () =>
      octokit.issues.listForRepo({
        owner,
        repo,
        labels: areaLabel,
        state: "all",
        per_page: 100,
      }),
    "getIssuesByArea"
  );

  return response.data
    .filter((issue) => !issue.pull_request) // Exclude PRs (they show as issues too)
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      body: issue.body ?? null,
      state: issue.state as "open" | "closed",
      labels: issue.labels
        .map((label) => (typeof label === "string" ? label : label.name || ""))
        .filter(Boolean),
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
    }));
}

/**
 * Get all unique area labels from the repository
 *
 * @returns Array of area names (without the "area:" prefix)
 */
export async function getAreas(): Promise<string[]> {
  const { octokit, owner, repo } = loadConfig();

  const response = await withRateLimitRetry(
    () =>
      octokit.issues.listLabelsForRepo({
        owner,
        repo,
        per_page: 100,
      }),
    "getAreas"
  );

  return response.data
    .map((label) => label.name)
    .filter((name) => name.startsWith(AREA_LABEL_PREFIX))
    .map((name) => name.slice(AREA_LABEL_PREFIX.length));
}

/**
 * Close a GitHub issue
 *
 * @param issueNumber - The issue number to close
 */
export async function closeIssue(issueNumber: number): Promise<void> {
  const { octokit, owner, repo } = loadConfig();

  await withRateLimitRetry(
    () =>
      octokit.issues.update({
        owner,
        repo,
        issue_number: issueNumber,
        state: "closed",
      }),
    "closeIssue"
  );
}

/**
 * Get a single issue by number
 *
 * @param issueNumber - The issue number to retrieve
 * @returns The issue details
 */
export async function getIssue(issueNumber: number): Promise<Issue> {
  const { octokit, owner, repo } = loadConfig();

  const response = await withRateLimitRetry(
    () =>
      octokit.issues.get({
        owner,
        repo,
        issue_number: issueNumber,
      }),
    "getIssue"
  );

  const issue = response.data;
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body ?? null,
    state: issue.state as "open" | "closed",
    labels: issue.labels
      .map((label) => (typeof label === "string" ? label : label.name || ""))
      .filter(Boolean),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
  };
}
