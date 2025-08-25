// sonar-reviewer.js
import fetch from "node-fetch";
import { Octokit } from "@octokit/rest";
import OpenAI from "openai";

// --- 1. Setup clients ---
const SONARQUBE_URL = process.env.SONARQUBE_URL; // e.g. http://localhost:9000
const SONARQUBE_PROJECT = process.env.SONARQUBE_PROJECT; // project key in SonarQube
const SONARQUBE_TOKEN = process.env.SONARQUBE_TOKEN; // user token (for private server)

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  baseURL: `https://${process.env.AZURE_OPENAI_RESOURCE}.openai.azure.com/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}`,
  defaultQuery: { "api-version": process.env.AZURE_OPENAI_API_VERSION ?? "2024-02-15-preview" },
  defaultHeaders: { "api-key": process.env.AZURE_OPENAI_API_KEY },
});

// GitHub client
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
const pull_number = process.env.PR_NUMBER;

// --- 2. Fetch issues from SonarQube ---
async function fetchSonarIssues() {
  const res = await fetch(
    `${SONARQUBE_URL}/api/issues/search?componentKeys=${SONARQUBE_PROJECT}&resolved=false`,
    {
      headers: {
        Authorization: "Basic " + Buffer.from(SONARQUBE_TOKEN + ":").toString("base64"),
      },
    }
  );

  if (!res.ok) {
    throw new Error(`SonarQube API error: ${res.statusText}`);
  }

  const data = await res.json();
  return data.issues || [];
}

// --- 3. Enhance issue using GPT ---
async function enhanceWithGPT(issue) {
  const prompt = `
You are a code reviewer. Summarize this SonarQube issue into a clear GitHub PR comment.
Explain in simple language, give reasoning, and suggest a fix.

Issue:
Rule: ${issue.rule}
Severity: ${issue.severity}
File: ${issue.component}
Line: ${issue.line || "N/A"}
Message: ${issue.message}
  `;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
    });

    return response.choices[0].message.content.trim();
  } catch (err) {
    console.error("GPT Error:", err);
    return issue.message;
  }
}

// --- 4. Post comment on GitHub PR ---
async function postComment(body, path, line) {
  try {
    await octokit.pulls.createReviewComment({
      owner,
      repo,
      pull_number,
      body,
      commit_id: process.env.GITHUB_SHA,
      path,
      line: line || 1,
    });
  } catch (err) {
    console.error("GitHub Comment Error:", err);
  }
}

// --- 5. Main Runner ---
async function run() {
  const issues = await fetchSonarIssues();

  for (const issue of issues) {
    const gptComment = await enhanceWithGPT(issue);
    console.log("💬", gptComment);

    // SonarQube components look like "projectKey:src/file.ts"
    const path = issue.component.split(":")[1];

    await postComment(gptComment, path, issue.line);
  }
}

run().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
