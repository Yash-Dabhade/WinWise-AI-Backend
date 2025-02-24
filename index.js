const express = require("express");
const axios = require("axios"); // Replace node-fetch with axios
const dotenv = require("dotenv");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

// Load environment variables from .env file
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware to parse JSON bodies and enable CORS
app.use(express.json());
app.use(cors());

// Utility function to get IAM token
const getIAMToken = async (apiKey) => {
  const tokenUrl = "https://iam.cloud.ibm.com/identity/token";
  const params = new URLSearchParams();
  params.append("grant_type", "urn:ibm:params:oauth:grant-type:apikey");
  params.append("apikey", apiKey);

  try {
    const response = await axios.post(tokenUrl, params.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
    });
    return response.data.access_token;
  } catch (error) {
    throw new Error(
      `Failed to get IAM token: ${error.response?.status || "Unknown"} - ${
        error.response?.data || error.message
      }`
    );
  }
};

// Utility function to get embeddings
const getEmbeddings = async (texts, iamToken) => {
  const url =
    "https://us-south.ml.cloud.ibm.com/ml/v1/text/embeddings?version=2023-10-25";
  const body = {
    inputs: texts,
    model_id: "ibm/granite-embedding-278m-multilingual",
    project_id: process.env.IBM_PROJECT_ID,
  };

  try {
    const response = await axios.post(url, body, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${iamToken}`,
      },
    });
    return response.data;
  } catch (error) {
    throw new Error(
      `HTTP error! status: ${error.response?.status || "Unknown"} - ${
        error.response?.data || error.message
      }`
    );
  }
};

// Utility function to compute cosine similarity
const cosineSimilarity = (vecA, vecB) => {
  const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
  const normA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
  const normB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
  return dotProduct / (normA * normB);
};

// Utility function to format proposal for PDF
const formatProposalForPDF = (text) => {
  const sections = text.split(/##\s+/).filter(Boolean);
  return {
    title: "Business Proposal",
    date: new Date().toLocaleDateString("en-GB"),
    sections: sections
      .map((section) => {
        const [title, ...content] = section
          .split("\n")
          .filter((line) => line.trim());
        return {
          title: title?.trim() || "",
          content: content.join("\n").trim(),
        };
      })
      .filter((section) => section.title && section.content),
  };
};

// Knowledge base for RAG analysis
const knowledgeBase = {
  executiveSummary: [
    "Executive summaries must include clear ROI metrics and quantifiable business impact",
    "Value proposition should highlight unique differentiators and competitive advantages",
    "Summary should address key stakeholder concerns and business objectives",
  ],
  technical: [
    "Technical specifications must include detailed system architecture and integration points",
    "Performance metrics and SLAs should be clearly defined with measurement criteria",
    "Security and compliance requirements must be explicitly addressed",
  ],
  timeline: [
    "Project timeline should include risk buffers and contingency planning",
    "Dependencies between phases must be clearly mapped with critical path identified",
    "Resource allocation should be specified for each project phase",
  ],
  budget: [
    "Budget breakdown should include both direct and indirect costs",
    "ROI calculations must consider both quantitative and qualitative benefits",
    "Payment milestones should align with deliverable completion",
  ],
  riskMitigation: [
    "Risk assessment should cover technical, operational, and business risks",
    "Mitigation strategies must include preventive and reactive measures",
    "Impact analysis should quantify potential losses and mitigation costs",
  ],
};

// Load historical proposals (ensure the file exists in server/data/)
const historicalData = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "data", "synthetic_proposals.json"),
    "utf8"
  )
);

// Endpoint to generate a proposal
app.post("/generate-proposal", async (req, res) => {
  try {
    const {
      clientName,
      industry,
      companySize,
      projectRequirements,
      budget,
      timeline,
    } = req.body;
    const apiKey = process.env.IBM_API_KEY;
    const projectId = process.env.IBM_PROJECT_ID;

    if (!apiKey || !projectId) {
      return res.status(500).json({ error: "Missing API_KEY or projectId" });
    }

    const iamToken = await getIAMToken(apiKey);

    const proposalPrompt = `Generate a professional business proposal with the following details:
      
          Company: ${clientName}
          Industry: ${industry}
          Company Size: ${companySize}
          Project Requirements: ${projectRequirements}
          Budget: ${budget}
          Timeline: ${timeline}
      
          Format the proposal with the following sections:
          1. Executive Summary
          2. Project Overview
          3. Proposed Solution
          4. Timeline and Milestones
          5. Investment and ROI
          6. Next Steps
      
          Make it formal, professional, and detailed while keeping each section clearly separated with markdown formatting (use ## for section titles).`;

    const url =
      "https://us-south.ml.cloud.ibm.com/ml/v1/text/generation?version=2023-05-29";

    const response = await axios.post(
      url,
      {
        input: proposalPrompt,
        parameters: {
          decoding_method: "greedy",
          max_new_tokens: 1000,
          min_new_tokens: 100,
          stop_sequences: [],
          repetition_penalty: 1.2,
        },
        model_id: "ibm/granite-3-8b-instruct",
        project_id: projectId,
      },
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${iamToken}`,
        },
      }
    );

    const generatedText = response.data.results[0].generated_text;
    const formattedProposal = formatProposalForPDF(generatedText);

    res.json(formattedProposal);
  } catch (error) {
    console.error("Error generating proposal:", error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to analyze proposal outcome
app.post("/analyze-outcome", async (req, res) => {
  try {
    const newProposal = req.body;
    const apiKey = process.env.IBM_API_KEY;

    const iamToken = await getIAMToken(apiKey);

    const historicalTexts = historicalData.map(
      (p) =>
        `Executive Summary: ${p.executive_summary}\nProject Scope: ${p.project_scope}\nTechnical Details: ${p.technical_details}`
    );

    const newProposalText = `Executive Summary: ${newProposal.executive_summary}\nProject Scope: ${newProposal.project_scope}\nTechnical Details: ${newProposal.technical_details}`;

    const historicalEmbeddings = await getEmbeddings(historicalTexts, iamToken);
    const newProposalEmbedding = await getEmbeddings(
      [newProposalText],
      iamToken
    );

    const similarities = historicalData.map((proposal, index) => ({
      similarity: cosineSimilarity(
        newProposalEmbedding.results[0].embedding,
        historicalEmbeddings.results[index].embedding
      ),
      proposal: proposal,
    }));

    similarities.sort((a, b) => b.similarity - a.similarity);
    const topSimilar = similarities.slice(0, 3);

    const winCount = topSimilar.filter(
      (s) => s.proposal.metadata && s.proposal.metadata.outcome === "win"
    ).length;

    const winProbability = (winCount + 1) / (topSimilar.length + 2);

    res.json({
      outcome: winProbability >= 0.5 ? "win" : "loss",
      probability: winProbability,
    });
  } catch (error) {
    console.error("Error in outcome analysis:", error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to analyze proposal with RAG
app.post("/analyze-proposal", async (req, res) => {
  try {
    const { proposalText } = req.body;
    const apiKey = process.env.IBM_API_KEY;

    const iamToken = await getIAMToken(apiKey);

    const allPractices = Object.values(knowledgeBase).flat();

    const proposalEmbeddingResult = await getEmbeddings(
      [proposalText],
      iamToken
    );
    const knowledgeBaseEmbeddingResult = await getEmbeddings(
      allPractices,
      iamToken
    );

    const proposalEmbedding = proposalEmbeddingResult.results[0].embedding;
    const knowledgeBaseEmbeddings = knowledgeBaseEmbeddingResult.results.map(
      (r) => r.embedding
    );

    const similarities = allPractices.map((text, index) => ({
      text,
      similarity: cosineSimilarity(
        proposalEmbedding,
        knowledgeBaseEmbeddings[index]
      ),
    }));

    const topPractices = similarities
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5);

    const response = await axios.post(
      "https://us-south.ml.cloud.ibm.com/ml/v1/text/generation?version=2023-05-29",
      {
        input: `As an expert business proposal analyst, review this proposal using these best practices:
${topPractices.map((p) => `- ${p.text}`).join("\n")}

Proposal to analyze:
${proposalText}

Provide a comprehensive analysis in this format:

QUANTITATIVE SCORING
Rate each aspect from 1-10 and provide brief justification:
- Clarity: [score] - [justification]
- Completeness: [score] - [justification]
- Feasibility: [score] - [justification]
- Value Proposition: [score] - [justification]
Overall Score: [weighted average]

DETAILED ANALYSIS
For each section below, provide specific findings and recommendations:

AREA: [section name]
CURRENT STATE: [detailed current analysis]
GAPS: [identified gaps]
IMPACT: [business impact of gaps]
PRIORITY: [High/Medium/Low]
RECOMMENDATIONS: [specific, actionable improvements]
IMPLEMENTATION COMPLEXITY: [Easy/Medium/Hard]
EXPECTED ROI: [Low/Medium/High with justification]
---`,
        model_id: "ibm/granite-3-8b-instruct",
        project_id: process.env.IBM_PROJECT_ID,
        parameters: {
          decoding_method: "greedy",
          max_new_tokens: 1500,
          min_new_tokens: 200,
          temperature: 0.7,
          repetition_penalty: 1.2,
        },
      },
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${iamToken}`,
        },
      }
    );

    const analysisResult = response.data;

    res.json({
      relevantPractices: topPractices,
      analysis: analysisResult.results[0].generated_text,
      metadata: {
        analysisDate: new Date().toISOString(),
        modelVersion: "granite-3-8b-instruct",
        knowledgeBaseCategories: Object.keys(knowledgeBase),
      },
    });
  } catch (error) {
    console.error("Error in RAG analysis:", error);
    res.status(500).json({ error: error.message });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
