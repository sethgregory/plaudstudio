import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { marked } from 'marked';
import katex from 'katex';
import { getRecording, updateRecording, getSetting } from './db.js';
import { TMP_DIR, MODELS_DIR } from './config.js';
import { logger } from './logger.js';

function runLlamaCli(promptFile, modelPath, contextSize = 65536) {
  return new Promise((resolve, reject) => {
    const args = [
      '-m', modelPath,
      '-ngl', '99',
      '-fa', 'on',
      '-t', '6',
      '-tb', '6',
      '-b', '2048',
      '-ub', '2048',
      '-f', promptFile,
      '-c', String(contextSize),
      '-n', '-1', // unlimited generation until EOS
      '-st', // single turn
      '--simple-io',
      '--no-display-prompt',
      '--no-warmup',
      '--reasoning', 'off' // direct generation without token-wasting internal loops
    ];

    const proc = spawn('llama-cli', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `/opt/homebrew/bin:${path.join(os.homedir(), '.local', 'bin')}:${process.env.PATH || ''}`
      }
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });

    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`llama-cli failed with code ${code}: ${stderr || stdout}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

export function curlRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-s', '-k', '--connect-timeout', '10', '-m', String(options.timeout || 300)];
    if (options.method) args.push('-X', options.method);
    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) {
        args.push('-H', `${k}: ${v}`);
      }
    }
    if (options.body) {
      args.push('-d', typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    args.push(url);

    const p = spawn('curl', args);
    let out = '';
    let err = '';

    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));

    p.on('close', (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(out));
        } catch (_) {
          resolve(out);
        }
      } else {
        reject(new Error(err || `curl exited with code ${code}`));
      }
    });

    p.on('error', (err) => reject(err));
  });
}

async function callOpenAICompatible(apiUrl, apiKey, model, systemPrompt, userPrompt) {
  let cleanUrl = apiUrl.trim().replace(/\/+$/, '');
  let endpoint = cleanUrl.endsWith('/chat/completions')
    ? cleanUrl
    : cleanUrl.endsWith('/v1')
    ? `${cleanUrl}/chat/completions`
    : `${cleanUrl}/v1/chat/completions`;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey && apiKey.trim()) {
    headers['Authorization'] = `Bearer ${apiKey.trim()}`;
  }

  const payload = {
    model: model || 'Qwen3.8-27B-UD-IQ4_XS.gguf',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.3,
    max_tokens: 16384
  };

  let data;
  try {
    data = await curlRequest(endpoint, {
      method: 'POST',
      headers,
      body: payload,
      timeout: 300
    });
  } catch (err) {
    if (endpoint.startsWith('https://')) {
      const fallbackEndpoint = endpoint.replace('https://', 'http://');
      try {
        data = await curlRequest(fallbackEndpoint, {
          method: 'POST',
          headers,
          body: payload,
          timeout: 300
        });
      } catch (_) {
        throw err;
      }
    } else {
      throw err;
    }
  }

  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (_) {}
  }

  if (data?.error) {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }

  const choice = data?.choices?.[0];
  const msg = choice?.message || {};
  return {
    content: msg.content || '',
    reasoning: msg.reasoning_content || ''
  };
}

async function callGemini(apiKey, systemPrompt, userPrompt, model = 'gemini-3-flash-preview') {
  const modelsToTry = [
    model,
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite',
    'gemini-3.8-flash',
    'gemini-3.5-flash'
  ];
  const uniqueModels = [...new Set(modelsToTry.filter(Boolean))];

  let lastError = null;
  for (const m of uniqueModels) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
    try {
      const data = await curlRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: {
          contents: [
            { role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }
          ]
        },
        timeout: 300
      });

      if (data?.error) {
        throw new Error(data.error.message || JSON.stringify(data.error));
      }

      const candidate = data?.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text || '';
      if (!text) {
        throw new Error(`Gemini returned an empty response with model ${m}.`);
      }

      return {
        content: text,
        reasoning: candidate?.content?.parts?.[0]?.thought || ''
      };
    } catch (err) {
      lastError = err;
      console.warn(`[Gemini] Model ${m} attempt failed: ${err.message}. Trying next candidate...`);
    }
  }

  throw lastError || new Error('All Gemini candidate models failed.');
}

function buildPrompts(category, recordingName, transcriptText, customInstructions) {
  let systemPrompt = '';
  let formatGuide = '';

  if (category === 'lecture') {
    systemPrompt = `You are an elite academic professor and master note-taker specializing in higher education.
Your mission is to convert the spoken audio transcript of a university lecture into comprehensive, rigorous, and beautifully structured LESSON NOTES.
The notes must be thorough and educational—not merely high-level bullet points. Explain concepts clearly, preserve technical terminology and equations/theorems if mentioned, and provide clear structure for studying and active recall.
The transcript includes speaker diarization tags (e.g., [Speaker 1], [Speaker 2], or lecturer/student names). Distinguish between primary lecturer instruction and student questions, answers, or discussions.`;

    formatGuide = `Please structure the lesson notes with the following sections in clean Markdown:

# 🎓 Lesson Notes: [Clear Descriptive Lecture Title]
*Date/Time or Recording: ${recordingName}*

## 🎯 Executive Overview & Learning Objectives
- Brief overview of what this lecture is about
- Bulleted primary learning objectives (what students should understand after this lecture)

## 💡 Core Concepts & Glossary
| Concept / Term | Definition | Academic Context & Significance |
| :--- | :--- | :--- |
| [Term 1] | [Clear definition] | [Why it matters / context] |
*(Add rows for all key terms and definitions introduced in the lecture)*

## 📖 Detailed Lesson Notes
*(Break down the lecture content chronologically or thematically into major conceptual sections with detailed explanations, mechanisms, arguments, and derivations.)*
### 1. [First Major Topic]
- Detailed conceptual breakdown
- Detailed reasoning and background
> **Key Insight / Lecturer Note:** [Highlight critical takeaways or lecturer emphases]

### 2. [Second Major Topic]
- In-depth elaboration, examples, or proofs discussed

## 🔬 Practical Examples & Case Studies
- Specific real-world examples, illustrations, or problem walkthroughs provided during the lecture

## 🙋 Student Questions & Class Discussions
- Key questions asked by students/audience (Speaker tags) and the lecturer's answers/explanations

## 📌 Summary of Core Takeaways
- 4-6 concise bullet points synthesizing the essential knowledge

## 🧠 Active Recall & Exam Study Questions
- **Conceptual Questions:** (Questions students should test themselves on)
- **Practice / Exam Scenarios:** (Questions that test deeper application of the lecture's principles)`;
  } else {
    // Work Meeting
    systemPrompt = `You are an expert executive project manager and operations chief.
Your mission is to convert the audio transcript of a business or technical meeting into pristine, actionable, and executive-ready MEETING MINUTES.
Highlight decisions, commitments, responsibilities, blockers, and next steps with utmost clarity.
The transcript features multi-speaker diarization tags (e.g., [Speaker 1], [Speaker 2], etc. or named participants). Explicitly attribute arguments, commitments, and action items to the specific speakers who took ownership or voiced them.`;

    formatGuide = `Please structure the meeting minutes with the following sections in clean Markdown:

# 💼 Meeting Minutes: [Clear Descriptive Meeting Title]
*Date/Time or Recording: ${recordingName}*

## 🎯 Executive Summary & Purpose
- 1-2 concise paragraphs summarizing the context, core purpose, and primary outcomes of the meeting.

## 👥 Attendees & Active Participants
- List the detected speakers/participants and their apparent roles or primary contributions based on the discussion.

## ✅ Key Decisions Made
- Clear, unambiguous bullet points of all agreements, architectural decisions, policy calls, or approvals made during this discussion (attribute to speakers where appropriate).

## 💬 Discussion Points by Topic
### 1. [First Major Agenda Item / Discussion Thread]
- Key discussion points, context, and resolutions.
- Explicitly note differing perspectives or proposals by speaker (e.g., "Speaker 2 proposed... while Speaker 1 emphasized...").

### 2. [Second Major Agenda Item]
- Summary of technical/business points raised.

## 📋 Action Items & Deliverables
| Task / Deliverable | Owner / Assignee | Priority / Target Date | Context / Details |
| :--- | :--- | :--- | :--- |
| [Task 1] | [Speaker / Person] | [High/Med/Low or Date] | [Specific deliverable notes and dependencies] |
*(List every explicit or implied action item identified in the transcript, attributed to the responsible speaker)*

## ❓ Open Questions & Blockers
- Unresolved dilemmas, questions awaiting data, or dependencies flagged for follow-up.

## ⏭️ Next Steps & Next Sync
- Immediate milestones and when the team reconvenes.`;
  }

  const customSection = customInstructions?.trim()
    ? `\n\nUSER'S SPECIAL FOCUS INSTRUCTIONS:\n${customInstructions.trim()}\n`
    : '';

  const userPrompt = `Recording Title/Date: ${recordingName}
${customSection}
Transcript:
"""
${transcriptText}
"""

${formatGuide}

Generate the full markdown notes now:`;

  return { systemPrompt, userPrompt };
}

export function enhanceMarkdownToHTML(markdown) {
  if (!markdown) return '';
  const mathPlaceholders = [];

  // 1. Extract Display Math: $$...$$ or \[...\]
  let text = markdown.replace(/\$\$([\s\S]+?)\$\$/g, (match, math) => {
    try {
      const rendered = katex.renderToString(math.trim(), {
        displayMode: true,
        throwOnError: false,
        trust: true
      });
      mathPlaceholders.push(rendered);
      return `@@KATEX_BLOCK_${mathPlaceholders.length - 1}@@`;
    } catch (err) {
      return match;
    }
  });

  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (match, math) => {
    try {
      const rendered = katex.renderToString(math.trim(), {
        displayMode: true,
        throwOnError: false,
        trust: true
      });
      mathPlaceholders.push(rendered);
      return `@@KATEX_BLOCK_${mathPlaceholders.length - 1}@@`;
    } catch (err) {
      return match;
    }
  });

  // 2. Extract Inline Math: \(...\)
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (match, math) => {
    try {
      const rendered = katex.renderToString(math.trim(), {
        displayMode: false,
        throwOnError: false,
        trust: true
      });
      mathPlaceholders.push(rendered);
      return `@@KATEX_INLINE_${mathPlaceholders.length - 1}@@`;
    } catch (err) {
      return match;
    }
  });

  // 3. Extract Inline Math: $...$
  text = text.replace(/(?<![\$\w])\$([^\$\n]+?)\$(?![\$\w])/g, (match, math) => {
    const trimmed = math.trim();
    // Exclude plain currency amounts like $50, $4.99, etc.
    if (/^\d+(?:[.,]\d+)?$/.test(trimmed)) {
      return match;
    }
    try {
      const rendered = katex.renderToString(trimmed, {
        displayMode: false,
        throwOnError: false,
        trust: true
      });
      mathPlaceholders.push(rendered);
      return `@@KATEX_INLINE_${mathPlaceholders.length - 1}@@`;
    } catch (err) {
      return match;
    }
  });

  // 4. Convert markdown to HTML using marked
  let html = marked.parse(text, {
    gfm: true,
    breaks: true
  });

  // 5. Restore rendered KaTeX HTML
  html = html.replace(/@@KATEX_BLOCK_(\d+)@@/g, (_, id) => mathPlaceholders[parseInt(id, 10)]);
  html = html.replace(/@@KATEX_INLINE_(\d+)@@/g, (_, id) => mathPlaceholders[parseInt(id, 10)]);

  // Convert checkbox items into modern interactive-ready HTML
  html = html.replace(/\[ \]/g, '<input type="checkbox" disabled class="task-checkbox">');
  html = html.replace(/\[x\]/gi, '<input type="checkbox" checked disabled class="task-checkbox">');

  // Wrap tables in responsive container
  html = html.replace(/<table>/g, '<div class="table-container"><table>');
  html = html.replace(/<\/table>/g, '</table></div>');

  return html;
}

function parseThinkingAndContent(rawText) {
  let reasoning = '';
  let content = rawText;

  // If llama-cli output contains Qwen assistant turn, take everything after it
  const assistantMarker = '<|im_start|>assistant';
  const lastAssistant = content.lastIndexOf(assistantMarker);
  if (lastAssistant !== -1) {
    content = content.slice(lastAssistant + assistantMarker.length).trim();
  }

  // Handle <think>...</think>
  const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/i);
  if (thinkMatch) {
    reasoning = thinkMatch[1].trim();
    content = content.replace(/<think>[\s\S]*?<\/think>/i, '').trim();
  }

  // Handle [Start thinking]...[End thinking]
  const qwenThinkMatch = content.match(/\[Start thinking\]([\s\S]*?)(\[End thinking\]|\n\n# |\n\n## )/i);
  if (qwenThinkMatch) {
    reasoning = (reasoning ? reasoning + '\n\n' : '') + qwenThinkMatch[1].trim();
    content = content.replace(/\[Start thinking\][\s\S]*?(\[End thinking\]|(?=\n\n# |\n\n## ))/i, '').trim();
  }

  // Strip leading llama-cli banner / echoed prompt before the first markdown heading
  const firstHeader = content.search(/(^|\n)#[#\s]/);
  if (firstHeader !== -1) {
    content = content.slice(firstHeader).trim();
  }

  // Strip trailing "Exiting..." or token stats from llama-cli
  content = content.replace(/\[ Prompt:.*?\].*$/s, '').trim();
  content = content.replace(/Exiting\.\.\..*$/s, '').trim();

  return { reasoning, content };
}

export async function summarizeRecording(recordingId, { category, customInstructions, engine } = {}, onProgress = null) {
  const recording = getRecording(recordingId);
  if (!recording) {
    throw new Error(`Recording ${recordingId} not found.`);
  }

  if (!recording.transcript_text || recording.transcript_text.trim().length === 0) {
    throw new Error(`Recording ${recordingId} does not have a transcript yet. Please transcribe it first.`);
  }

  // Determine category & LLM provider
  const effectiveCategory = category || (recording.category !== 'unassigned' ? recording.category : 'lecture');
  const provider = engine && engine !== 'default' ? engine : getSetting('llm_provider', 'custom_api');

  updateRecording(recordingId, {
    status: 'summarizing',
    category: effectiveCategory
  });

  if (onProgress) onProgress('summarizing', `Generating ${effectiveCategory === 'lecture' ? 'Lecture Lesson Notes' : 'Meeting Minutes'}...`);
  logger.stage('summarizing', `Generating ${effectiveCategory === 'lecture' ? 'Lecture Lesson Notes' : 'Meeting Minutes'} for "${recording.name}" via ${provider}...`, { recordingId, recordingName: recording.name });

  const { systemPrompt, userPrompt } = buildPrompts(
    effectiveCategory,
    recording.name,
    recording.transcript_text,
    customInstructions
  );

  let rawOutput = '';
  let extractedReasoning = '';

  try {
    if (provider === 'gemini') {
      const apiKey = getSetting('gemini_api_key');
      if (!apiKey) throw new Error('Gemini API key is not configured in settings.');
      const geminiModel = getSetting('gemini_model', 'gemini-3-flash-preview');
      logger.llm(`Sending prompt to Google Gemini (${geminiModel})...`);
      const res = await callGemini(apiKey, systemPrompt, userPrompt, geminiModel);
      rawOutput = res.content;
      extractedReasoning = res.reasoning;
      logger.llm(`Gemini response received (${rawOutput.length} chars).`);
    } else if (provider === 'custom_api' || provider === 'remote_api') {
      const apiUrl = getSetting('custom_api_url', 'http://localhost:8081/v1');
      const apiKey = getSetting('custom_api_key', '');
      const model = getSetting('custom_api_model', '');
      logger.llm(`Sending prompt to remote LLM server at ${apiUrl} (${model})...`);
      const res = await callOpenAICompatible(apiUrl, apiKey, model, systemPrompt, userPrompt);
      rawOutput = res.content;
      extractedReasoning = res.reasoning;
      logger.llm(`Remote API response received (${rawOutput.length} chars).`);
    } else {
      // Local Llama via llama-cli
      const localModel = getSetting(
        'local_model_path',
        path.join(MODELS_DIR, 'Qwen3.5-4B-Q4_K_M.gguf')
      );
      if (!fs.existsSync(localModel)) {
        throw new Error(`Local model not found at: ${localModel}`);
      }

      // Write prompt to tmp file to handle large transcripts without shell arg limits
      const promptFile = path.join(TMP_DIR, `${recordingId}_prompt.txt`);
      const fullLlamaPrompt = `<|im_start|>system\n${systemPrompt}<|im_end|>\n<|im_start|>user\n${userPrompt}<|im_end|>\n<|im_start|>assistant\n`;
      fs.writeFileSync(promptFile, fullLlamaPrompt, 'utf8');

      // Dynamically calculate context size: prompt tokens + 16,384 output tokens
      const estPromptTokens = Math.ceil(fullLlamaPrompt.length / 3.0);
      const targetCtx = Math.max(65536, Math.min(131072, Math.pow(2, Math.ceil(Math.log2(estPromptTokens + 16384)))));
      logger.llm(`Running llama-cli Metal GPU inference (ctx: ${targetCtx})...`);

      try {
        rawOutput = await runLlamaCli(promptFile, localModel, targetCtx);
        if (rawOutput.includes('exceeds the available context size')) {
          throw new Error('Transcript exceeds the model context size limit.');
        }
        logger.llm(`llama-cli generated output (${rawOutput.length} chars).`);
      } finally {
        if (fs.existsSync(promptFile)) fs.unlinkSync(promptFile);
      }
    }

    const { reasoning: parsedReasoning, content } = parseThinkingAndContent(rawOutput);
    const reasoning = extractedReasoning || parsedReasoning;
    if (!content || content.length < 50) {
      throw new Error('LLM failed to generate a valid summary. Output was empty or too short.');
    }
    const html = enhanceMarkdownToHTML(content);

    updateRecording(recordingId, {
      status: 'ready',
      error_message: '',
      summary_type: effectiveCategory,
      summary_markdown: content,
      summary_html: html,
      reasoning_text: reasoning,
      processed_at: new Date().toISOString()
    });

    if (onProgress) onProgress('ready', 'Summary generation complete.');
    logger.stage('ready', `✅ Summary generation completed for "${recording.name}".`, { recordingId, recordingName: recording.name });

    return {
      success: true,
      category: effectiveCategory,
      summaryMarkdown: content,
      summaryHtml: html,
      reasoning
    };
  } catch (err) {
    updateRecording(recordingId, {
      status: 'error',
      error_message: err.message
    });
    throw err;
  }
}
