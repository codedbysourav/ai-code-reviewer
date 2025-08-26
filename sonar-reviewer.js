// sonar-reviewer.js
import fetch from "node-fetch";
import { AzureOpenAI } from "openai";
import * as dotenv from "dotenv";
dotenv.config();

// --- 1. Setup clients ---
const SONARQUBE_URL = process.env.SONARQUBE_URL; // e.g. http://localhost:9000
const SONARQUBE_PROJECT = process.env.SONARQUBE_PROJECT; // project key in SonarQube
const SONARQUBE_TOKEN = process.env.SONARQUBE_TOKEN; // user token (for private server)
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY;
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT;
const AZURE_OPENAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GIT_USERNAME = process.env.GIT_USERNAME;

// Validate required environment variables
const requiredEnvVars = {
  SONARQUBE_URL,
  SONARQUBE_PROJECT,
  SONARQUBE_TOKEN,
  AZURE_OPENAI_API_KEY,
  AZURE_OPENAI_ENDPOINT,
  AZURE_OPENAI_DEPLOYMENT,
  AZURE_OPENAI_API_VERSION,
  GITHUB_TOKEN,
  GIT_USERNAME,
};

const missingVars = Object.entries(requiredEnvVars)
  .filter(([key, value]) => !value)
  .map(([key]) => key);

if (missingVars.length > 0) {
  console.error("❌ Missing required environment variables:");
  missingVars.forEach(varName => console.error(`   - ${varName}`));
  console.error("\nPlease create a .env file with these variables.");
  process.exit(1);
}

console.log(`🔧 Azure endpoint: ${AZURE_OPENAI_ENDPOINT}`);

// Azure OpenAI client
const openai = new AzureOpenAI({
  apiKey: AZURE_OPENAI_API_KEY,
  endpoint: AZURE_OPENAI_ENDPOINT,
  deployment: AZURE_OPENAI_DEPLOYMENT,
  apiVersion: AZURE_OPENAI_API_VERSION,
});

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

// Utility: retry with exponential backoff
async function withRetry(fn, options = { retries: 2, baseDelayMs: 500 }) {
  let attempt = 0;
  let lastErr;
  while (attempt <= options.retries) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || "");
      const isConn = msg.includes("APIConnectionError") || msg.includes("fetch failed") || msg.includes("ENOTFOUND") || msg.includes("ETIMEDOUT");
      if (!isConn || attempt === options.retries) break;
      const delay = options.baseDelayMs * Math.pow(2, attempt);
      await new Promise(r => setTimeout(r, delay));
      attempt += 1;
    }
  }
  throw lastErr;
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
    const response = await withRetry(() => openai.chat.completions.create({
      model: AZURE_OPENAI_DEPLOYMENT,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
    }));
    return response.choices[0].message.content.trim();
  } catch (err) {
    console.error("GPT Error:", err);
    return issue.message;
  }
}

// --- 4. Main Runner ---
async function run() {
  console.log("🔍 Fetching SonarQube issues...");
  const issues = await fetchSonarIssues();
  
  console.log(`📊 Found ${issues.length} issues in SonarQube`);
  
  if (issues.length === 0) {
    console.log("✅ No issues found! Code looks clean.");
    return;
  }

  console.log("\n🤖 Enhancing issues with GPT...\n");
  
  for (const issue of issues) {
    console.log("=".repeat(80));
    console.log(`📁 File: ${issue.component.split(":")[1] || issue.component}`);
    console.log(`📍 Line: ${issue.line || "N/A"}`);
    console.log(`⚠️  Severity: ${issue.severity}`);
    console.log(`🔧 Rule: ${issue.rule}`);
    console.log(`💬 Original Message: ${issue.message}`);
    
    const gptComment = await enhanceWithGPT(issue);
    console.log(`\n🤖 GPT Enhanced Review:`);
    console.log(gptComment);
    console.log("\n");
  }
  
  console.log("=".repeat(80));
  console.log(`🎉 Review complete! Processed ${issues.length} issues.`);
}

run().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
