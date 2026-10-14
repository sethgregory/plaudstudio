import { listRecordings } from './db.js';
import { runLLM } from './summarize.js';
import { logger } from './logger.js';

export function parseFolders(projectOrClass) {
  if (!projectOrClass) return [];
  try {
    const parsed = JSON.parse(projectOrClass);
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
    if (typeof parsed === 'string' && parsed) return [parsed];
  } catch (_) {
    if (typeof projectOrClass === 'string' && projectOrClass.trim()) {
      return [projectOrClass.trim()];
    }
  }
  return [];
}

/**
 * Extracts structured concepts, decisions, actions, and topics from a recording's markdown summary.
 */
export function extractNodesFromRecording(rec) {
  const md = [rec.summary_markdown || '', rec.plaud_summary_markdown || ''].filter(Boolean).join('\n\n');
  if (!md.trim()) return { concepts: [], decisions: [], actions: [], topics: [], questions: [] };

  const folders = parseFolders(rec.project_or_class);
  const primaryFolder = folders[0] || 'General';
  const recDate = rec.start_at || rec.created_at || '';
  const dateFormatted = recDate ? new Date(recDate).toLocaleDateString() : '';

  const concepts = [];
  const decisions = [];
  const actions = [];
  const topics = [];
  const questions = [];

  // 1. Parse Glossary / Concept Tables (| Term | Definition | Context |)
  const tableRowRegex = /\|([^|\n]+)\|([^|\n]+)\|([^|\n]+)\|/g;
  let match;
  while ((match = tableRowRegex.exec(md)) !== null) {
    const col1 = match[1].trim();
    const col2 = match[2].trim();
    const col3 = match[3].trim();
    const c1Low = col1.toLowerCase();

    // Check if this is a concept table row
    if (
      !col1.includes('---') &&
      !c1Low.includes('concept') &&
      !c1Low.includes('term') &&
      !c1Low.includes('task') &&
      !c1Low.includes('deliverable') &&
      col1.length >= 2
    ) {
      concepts.push({
        name: col1.replace(/\*\*/g, '').trim(),
        definition: col2.replace(/\*\*/g, '').trim(),
        context: col3.replace(/\*\*/g, '').trim(),
        recordingId: rec.id,
        recordingTitle: rec.name,
        date: dateFormatted,
        folder: primaryFolder
      });
    }

    // Check if this is an action item table row (| Task | Owner | Priority | Details |)
    if (
      !col1.includes('---') &&
      (c1Low.includes('task') || c1Low.includes('action') || col2.length < 30) &&
      !c1Low.includes('concept')
    ) {
      // Possible action item row
    }
  }

  // 2. Parse Section Headings & Subtopics (### Heading)
  const lines = md.split('\n');
  let currentSection = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('## ')) {
      currentSection = line.replace(/^##\s+/, '').trim();
      continue;
    }

    if (line.startsWith('### ')) {
      const topicName = line.replace(/^###\s+/, '').replace(/^\d+\.\s*/, '').replace(/\[|\]/g, '').trim();
      if (topicName.length > 2 && !topicName.includes('First Major') && !topicName.includes('Second Major')) {
        // Collect following bullets for context
        const bullets = [];
        for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
          const nextL = lines[j].trim();
          if (nextL.startsWith('#')) break;
          if (nextL.startsWith('- ') || nextL.startsWith('* ')) {
            bullets.push(nextL.replace(/^[-*]\s+/, ''));
          }
        }
        topics.push({
          title: topicName,
          section: currentSection,
          recordingId: rec.id,
          recordingTitle: rec.name,
          date: dateFormatted,
          folder: primaryFolder,
          summary: bullets.slice(0, 3).join(' ')
        });
      }
      continue;
    }

    // Parse Key Decisions Made bullets
    if (currentSection.toLowerCase().includes('decision') && (line.startsWith('- ') || line.startsWith('* '))) {
      const decText = line.replace(/^[-*]\s+/, '').trim();
      if (decText.length > 5) {
        decisions.push({
          text: decText,
          recordingId: rec.id,
          recordingTitle: rec.name,
          date: dateFormatted,
          folder: primaryFolder
        });
      }
    }

    // Parse Action Items bullets or rows
    if (currentSection.toLowerCase().includes('action') && (line.startsWith('- ') || line.startsWith('* '))) {
      const actText = line.replace(/^[-*]\s+/, '').trim();
      if (actText.length > 5) {
        actions.push({
          task: actText,
          recordingId: rec.id,
          recordingTitle: rec.name,
          date: dateFormatted,
          folder: primaryFolder
        });
      }
    }

    // Parse Study Questions / Open Questions
    if ((currentSection.toLowerCase().includes('question') || currentSection.toLowerCase().includes('recall')) && (line.startsWith('- ') || line.startsWith('* '))) {
      const qText = line.replace(/^[-*]\s+/, '').trim();
      if (qText.length > 5) {
        questions.push({
          text: qText,
          recordingId: rec.id,
          recordingTitle: rec.name,
          date: dateFormatted,
          folder: primaryFolder
        });
      }
    }
  }

  return { concepts, decisions, actions, topics, questions };
}

/**
 * Builds a comprehensive Knowledge Graph data structure across a set of recordings.
 */
export function buildKnowledgeGraph(recordings) {
  const nodes = [];
  const edges = [];
  const conceptMap = new Map();
  const folderSet = new Set();

  let totalDecisions = 0;
  let totalActions = 0;

  recordings.forEach((rec) => {
    const folders = parseFolders(rec.project_or_class);
    folders.forEach(f => folderSet.add(f));
    const primaryFolder = folders[0] || 'General';

    // Add Recording Node
    const recNodeId = `rec_${rec.id}`;
    nodes.push({
      id: recNodeId,
      label: rec.name,
      type: 'recording',
      category: rec.category || 'unassigned',
      folder: primaryFolder,
      date: rec.start_at || rec.created_at || '',
      durationMin: rec.duration ? (rec.duration / 60000).toFixed(1) : '0'
    });

    const extracted = extractNodesFromRecording(rec);

    // Merge and link concepts
    extracted.concepts.forEach((c) => {
      const normKey = c.name.toLowerCase().trim();
      if (!conceptMap.has(normKey)) {
        const conceptNodeId = `concept_${normKey.replace(/[^a-z0-9_-]/g, '_')}`;
        conceptMap.set(normKey, {
          id: conceptNodeId,
          label: c.name,
          type: 'concept',
          definition: c.definition,
          context: c.context,
          folders: new Set([c.folder]),
          recordingIds: new Set([rec.id]),
          recordingTitles: new Set([rec.name])
        });
      } else {
        const existing = conceptMap.get(normKey);
        existing.folders.add(c.folder);
        existing.recordingIds.add(rec.id);
        existing.recordingTitles.add(rec.name);
        if (!existing.definition && c.definition) existing.definition = c.definition;
      }

      edges.push({
        source: recNodeId,
        target: conceptMap.get(normKey).id,
        label: 'discusses'
      });
    });

    // Add topics as concept nodes if not already added
    extracted.topics.forEach((t) => {
      const normKey = t.title.toLowerCase().trim();
      if (!conceptMap.has(normKey) && normKey.length > 3) {
        const topicNodeId = `topic_${normKey.replace(/[^a-z0-9_-]/g, '_')}`;
        conceptMap.set(normKey, {
          id: topicNodeId,
          label: t.title,
          type: 'topic',
          definition: t.summary || `Topic explored in ${rec.name}`,
          context: t.section,
          folders: new Set([t.folder]),
          recordingIds: new Set([rec.id]),
          recordingTitles: new Set([rec.name])
        });

        edges.push({
          source: recNodeId,
          target: topicNodeId,
          label: 'covers_topic'
        });
      } else if (conceptMap.has(normKey)) {
        conceptMap.get(normKey).recordingIds.add(rec.id);
        conceptMap.get(normKey).recordingTitles.add(rec.name);
      }
    });

    // Add decisions
    extracted.decisions.forEach((d, idx) => {
      totalDecisions++;
      const decNodeId = `dec_${rec.id}_${idx}`;
      nodes.push({
        id: decNodeId,
        label: d.text.slice(0, 60) + (d.text.length > 60 ? '...' : ''),
        fullText: d.text,
        type: 'decision',
        folder: primaryFolder,
        recordingId: rec.id,
        recordingTitle: rec.name
      });
      edges.push({
        source: recNodeId,
        target: decNodeId,
        label: 'decided'
      });
    });

    // Add actions
    extracted.actions.forEach((a, idx) => {
      totalActions++;
      const actNodeId = `act_${rec.id}_${idx}`;
      nodes.push({
        id: actNodeId,
        label: a.task.slice(0, 60) + (a.task.length > 60 ? '...' : ''),
        fullText: a.task,
        type: 'action',
        folder: primaryFolder,
        recordingId: rec.id,
        recordingTitle: rec.name
      });
      edges.push({
        source: recNodeId,
        target: actNodeId,
        label: 'action_item'
      });
    });
  });

  // Convert conceptMap to nodes array
  for (const c of conceptMap.values()) {
    nodes.push({
      id: c.id,
      label: c.label,
      type: c.type || 'concept',
      definition: c.definition,
      context: c.context,
      folders: Array.from(c.folders),
      recordingCount: c.recordingIds.size,
      recordingTitles: Array.from(c.recordingTitles)
    });
  }

  return {
    nodes,
    edges,
    stats: {
      totalRecordings: recordings.length,
      totalConcepts: conceptMap.size,
      totalEdges: edges.length,
      totalDecisions,
      totalActions,
      folders: Array.from(folderSet)
    }
  };
}

/**
 * Searches the recordings and knowledge graph for relevant context matching a query.
 */
export function searchKnowledge({ query, folder, recordings, topK = 6 }) {
  const queryTokens = (query || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);

  // Filter recordings by folder if specified
  const filteredRecs = recordings.filter((r) => {
    if (!folder || folder === 'all') return true;
    const folders = parseFolders(r.project_or_class);
    return folders.includes(folder);
  });

  const scoredRecs = filteredRecs.map((rec) => {
    let score = 0;
    const recNameLow = rec.name.toLowerCase();
    const md = [rec.summary_markdown || '', rec.plaud_summary_markdown || ''].join(' ').toLowerCase();

    queryTokens.forEach((token) => {
      if (recNameLow.includes(token)) score += 10;
      const count = (md.match(new RegExp(token, 'g')) || []).length;
      score += Math.min(count * 2, 20);
    });

    return { rec, score };
  });

  scoredRecs.sort((a, b) => b.score - a.score);

  // If no query tokens matched strongly, include the most recent recordings in scope
  const selected = (scoredRecs.some(s => s.score > 0))
    ? scoredRecs.filter(s => s.score > 0).slice(0, topK).map(s => s.rec)
    : filteredRecs.slice(0, topK);

  // Extract concepts from all recordings in scope
  const allExtractedConcepts = [];
  const allExtractedDecisions = [];
  const allExtractedActions = [];

  filteredRecs.forEach((r) => {
    const ext = extractNodesFromRecording(r);
    allExtractedConcepts.push(...ext.concepts);
    allExtractedDecisions.push(...ext.decisions);
    allExtractedActions.push(...ext.actions);
  });

  // Score concepts
  const scoredConcepts = allExtractedConcepts.map((c) => {
    let score = 0;
    const cLow = (c.name + ' ' + c.definition + ' ' + c.context).toLowerCase();
    queryTokens.forEach((t) => {
      if (c.name.toLowerCase().includes(t)) score += 8;
      if (cLow.includes(t)) score += 3;
    });
    return { concept: c, score };
  });

  scoredConcepts.sort((a, b) => b.score - a.score);
  const matchedConcepts = scoredConcepts
    .filter(sc => sc.score > 0)
    .slice(0, 15)
    .map(sc => sc.concept);

  return {
    recordings: selected,
    concepts: matchedConcepts,
    decisions: allExtractedDecisions,
    actions: allExtractedActions,
    totalInScope: filteredRecs.length
  };
}

/**
 * Queries the knowledge graph and relevant summaries using the configured LLM.
 */
export async function queryKnowledgeGraphWithLLM({ query, folder, engine }) {
  if (!query || !query.trim()) {
    throw new Error('Please enter a question to ask the Knowledge Graph.');
  }

  const allRecs = listRecordings();
  const recsWithSummaries = allRecs.filter(r => r.summary_markdown || r.plaud_summary_markdown);

  if (recsWithSummaries.length === 0) {
    throw new Error('No recordings with summaries found yet. Generate summaries for your recordings before querying the Knowledge Graph.');
  }

  const searchResults = searchKnowledge({
    query,
    folder,
    recordings: recsWithSummaries,
    topK: 6
  });

  const { recordings: relevantRecs, concepts: relevantConcepts, decisions, actions, totalInScope } = searchResults;

  if (relevantRecs.length === 0) {
    throw new Error(`No recordings found matching folder "${folder}".`);
  }

  // Build Context for LLM
  const scopeLabel = folder && folder !== 'all' ? `Folder "${folder}"` : 'All Recordings';

  // Format Knowledge Graph Concepts
  let conceptsSection = '';
  if (relevantConcepts.length > 0) {
    conceptsSection = `### 💡 Related Knowledge Graph Concepts & Glossary:\n` +
      relevantConcepts.map(c => `- **${c.name}**: ${c.definition} *(Context: ${c.context} | From: "${c.recordingTitle}")*`).join('\n') + '\n\n';
  }

  // Format Decisions / Actions if relevant
  let decisionsSection = '';
  const isActionQuery = /decision|action|todo|deliverable|next step|task|plan/i.test(query);
  if (isActionQuery && (decisions.length > 0 || actions.length > 0)) {
    decisionsSection = `### 📋 Key Decisions & Action Items in Scope:\n` +
      decisions.slice(0, 8).map(d => `- **Decision**: ${d.text} *(From: "${d.recordingTitle}", ${d.date})*`).join('\n') + '\n' +
      actions.slice(0, 8).map(a => `- **Action**: ${a.task} *(From: "${a.recordingTitle}", ${a.date})*`).join('\n') + '\n\n';
  }

  // Format Excerpts from Relevant Recordings
  const recordingExcerpts = relevantRecs.map((r) => {
    const folders = parseFolders(r.project_or_class);
    const dateFormatted = r.start_at || r.created_at ? new Date(r.start_at || r.created_at).toLocaleDateString() : '';
    const summaryText = r.summary_markdown || r.plaud_summary_markdown || '';
    // Trim summary text to top 3500 chars to avoid prompt bloat while giving deep detail
    const trimmed = summaryText.length > 4000 ? summaryText.slice(0, 4000) + '\n... [summary continues] ...' : summaryText;

    return `=== RECORDING: "${r.name}" ===
Date: ${dateFormatted} | Category: ${r.category} | Folders: ${folders.join(', ') || 'None'}
Summary Excerpt:
${trimmed}
`;
  }).join('\n\n----------------------------------------\n\n');

  const systemPrompt = `You are the master Knowledge Graph & Research Assistant for Plaud Studio.
You have direct access to the user's audio recordings, lecture lesson notes, meeting minutes, and extracted concepts in ${scopeLabel}.

Your task is to provide an articulate, authoritative, and comprehensive answer to the user's question, grounded strictly in the provided Knowledge Graph concepts and recording summaries.

CRITICAL INSTRUCTIONS:
1. Grounding & Truthfulness: Base your answers ONLY on the provided recordings and knowledge graph concepts. Do not invent facts or cite nonexistent meetings/lectures.
2. Explicit Citations: Whenever you state a principle, decision, equation, or fact, explicitly cite the source recording title and date in bold brackets, e.g. **["Reaction Stoichiometry" - 2026-10-13]** or **["Acquia Partner Strategy" - 2026-04-27]**.
3. Cross-Recording Synthesis: If multiple recordings touch upon the question, compare and connect them chronologically or thematically.
4. Mathematical & Scientific Rigor: If the question involves chemistry, physics, math, or technical derivations, preserve exact scientific notation and KaTeX equations ($inline$ or $$display$$).
5. Clean Structure: Use Markdown formatting (headers, bold key terms, bullet points, and tables where helpful) for high readability.
6. Honest Limits: If the provided recordings do not contain the answer, state that clearly and suggest what related information is available in the knowledge graph.`;

  const userPrompt = `USER QUESTION:
"${query}"

SCOPE: ${scopeLabel} (${totalInScope} recordings available)

${conceptsSection}${decisionsSection}DETAILED RECORDING SUMMARIES IN SCOPE:
${recordingExcerpts}

Please synthesize your complete, cited answer now:`;

  logger.llm(`[Knowledge Q&A] Querying Knowledge Graph (${relevantRecs.length} relevant recordings) with: "${query.slice(0, 60)}..."`);

  const { reasoning, content } = await runLLM({
    systemPrompt,
    userPrompt,
    engine,
    contextTag: 'knowledge-qa'
  });

  // Extract cited recording IDs
  const citedRecordings = relevantRecs.map(r => ({
    id: r.id,
    name: r.name,
    date: r.start_at || r.created_at || '',
    category: r.category || 'unassigned',
    folder: (parseFolders(r.project_or_class)[0]) || 'General'
  }));

  return {
    answer: content,
    reasoning,
    citedRecordings,
    matchedConcepts: relevantConcepts.slice(0, 8),
    stats: {
      totalInScope,
      recordingsQueried: relevantRecs.length,
      scope: scopeLabel
    }
  };
}
