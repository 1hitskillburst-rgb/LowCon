import type { MemoryNote } from './types';

export interface ScoringWeights {
  keywordWeight: number;
  sessionWeight: number;
  pinnedWeight: number;
  recencyWeight: number;
  recencyHalfLifeSecs: number;
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  keywordWeight: 1.0,
  sessionWeight: 0.4,
  pinnedWeight: 0.8,
  recencyWeight: 0.3,
  recencyHalfLifeSecs: 7 * 86400, // 7 days
};

export interface ScoredMemoryNote {
  note: MemoryNote;
  finalScore: number;
  keywordScore: number;
  sessionScore: number;
  pinScore: number;
  recencyScore: number;
  rank: number;
}

export interface RetrievalQueryOptions {
  query?: string;
  sessionId?: string;
  limit?: number;
  includeDisabled?: boolean;
  requireApproved?: boolean;
  pinnedOnly?: boolean;
  excludePinned?: boolean;
  summariesOnly?: boolean;
  weights?: ScoringWeights;
  nowMs?: number;
}

/**
 * Tokenizes and sanitizes raw text for full-text matching (strips FTS5 operators & punctuation).
 */
export function tokenizeSearchTerms(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/["*:()^[\]{}.,!?;:/\\|<>~`@#$%&+=_-]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
}

/**
 * Exponential half-life recency decay: 2^(-age / halfLifeSecs).
 */
export function calculateRecencyScore(
  updatedAtMs: number,
  nowMs: number,
  halfLifeSecs: number,
): number {
  if (halfLifeSecs <= 0) return 1.0;
  const ageSecs = Math.max(0, (nowMs - updatedAtMs) / 1000);
  return Math.min(1.0, Math.max(0.0, Math.pow(0.5, ageSecs / halfLifeSecs)));
}

/**
 * Computes Okapi BM25 relevance score for a note against a corpus of notes.
 */
function computeBm25(
  queryTerms: string[],
  docText: string,
  avgDocLen: number,
  docFreqs: Map<string, number>,
  totalDocs: number,
): number {
  if (queryTerms.length === 0 || totalDocs === 0) return 0;

  const docTokens = tokenizeSearchTerms(docText);
  if (docTokens.length === 0) return 0;

  const termCounts = new Map<string, number>();
  for (const tok of docTokens) {
    termCounts.set(tok, (termCounts.get(tok) ?? 0) + 1);
  }

  const k1 = 1.5;
  const b = 0.75;
  const docLen = docTokens.length;
  let score = 0;

  for (const qTerm of new Set(queryTerms)) {
    // Support exact token match or prefix substring match for interactive FTS feel
    let tf = termCounts.get(qTerm) ?? 0;
    if (tf === 0) {
      for (const [docTok, count] of termCounts.entries()) {
        if (docTok.startsWith(qTerm) || docTok.includes(qTerm)) {
          tf += count * 0.75;
        }
      }
    }
    if (tf <= 0) continue;

    const df = docFreqs.get(qTerm) ?? 1;
    const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
    const denom = tf + k1 * (1 - b + b * (docLen / Math.max(1, avgDocLen)));
    score += idf * ((tf * (k1 + 1)) / denom);
  }

  return score;
}

/**
 * Returns all active pinned rules so they are ALWAYS packed into prompt context
 * regardless of whether their text lexically matches the current user query.
 */
export function getPinnedNotesForPrompt(
  notes: MemoryNote[],
  sessionId?: string,
): MemoryNote[] {
  return notes
    .filter((n) => {
      if (!n.isPinned || n.isDisabled) return false;
      if (n.isSummary && !n.userApproved) return false;
      if (sessionId && n.sessionId && n.sessionId !== sessionId) return false;
      return true;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

/**
 * Full-text BM25 + session + pin + recency retrieval across ALL notes (no arbitrary 50-row cap).
 */
export function retrieveMemoryNotes(
  notes: MemoryNote[],
  options: RetrievalQueryOptions = {},
): ScoredMemoryNote[] {
  const weights = options.weights ?? DEFAULT_SCORING_WEIGHTS;
  const nowMs = options.nowMs ?? Date.now();
  const limit = options.limit ?? notes.length;

  const eligible = notes.filter((n) => {
    if (!options.includeDisabled && n.isDisabled) return false;
    if (options.requireApproved && n.isSummary && !n.userApproved) return false;
    if (options.pinnedOnly && !n.isPinned) return false;
    if (options.excludePinned && n.isPinned) return false;
    if (options.summariesOnly && !n.isSummary) return false;
    if (options.sessionId && n.sessionId && n.sessionId !== options.sessionId) return false;
    return true;
  });

  if (eligible.length === 0) return [];

  const queryTerms = options.query ? tokenizeSearchTerms(options.query) : [];
  const hasQuery = queryTerms.length > 0;

  // Build corpus statistics for BM25
  const docTexts = eligible.map((n) => `${n.title} ${n.content} ${n.sourceReference}`);
  const tokenizedDocs = docTexts.map(tokenizeSearchTerms);
  const totalLen = tokenizedDocs.reduce((sum, toks) => sum + toks.length, 0);
  const avgDocLen = totalLen / Math.max(1, eligible.length);

  const docFreqs = new Map<string, number>();
  if (hasQuery) {
    for (const qTerm of new Set(queryTerms)) {
      let count = 0;
      for (const toks of tokenizedDocs) {
        if (toks.some((t) => t === qTerm || t.startsWith(qTerm) || t.includes(qTerm))) {
          count += 1;
        }
      }
      docFreqs.set(qTerm, count);
    }
  }

  const scored: ScoredMemoryNote[] = [];

  for (let i = 0; i < eligible.length; i++) {
    const note = eligible[i];
    const bm25Raw = hasQuery
      ? computeBm25(queryTerms, docTexts[i], avgDocLen, docFreqs, eligible.length)
      : 0;

    // When a search query is present, only include notes with a positive lexical match
    if (hasQuery && bm25Raw <= 0) {
      continue;
    }

    const keywordNorm = bm25Raw > 0 ? bm25Raw / (1 + bm25Raw) : 0;
    const keywordScore = keywordNorm * weights.keywordWeight;

    const sessionFactor =
      note.sessionId && options.sessionId && note.sessionId === options.sessionId
        ? 1.0
        : !note.sessionId
          ? 0.5
          : 0.0;
    const sessionScore = sessionFactor * weights.sessionWeight;

    const pinScore = note.isPinned ? weights.pinnedWeight : 0;
    const recencyScore =
      calculateRecencyScore(note.updatedAt, nowMs, weights.recencyHalfLifeSecs) *
      weights.recencyWeight;

    const finalScore = keywordScore + sessionScore + pinScore + recencyScore;

    scored.push({
      note,
      finalScore,
      keywordScore,
      sessionScore,
      pinScore,
      recencyScore,
      rank: 0,
    });
  }

  scored.sort((a, b) => {
    if (a.note.isPinned !== b.note.isPinned) return a.note.isPinned ? -1 : 1;
    if (Math.abs(b.finalScore - a.finalScore) > 1e-9) return b.finalScore - a.finalScore;
    if (b.note.updatedAt !== a.note.updatedAt) return b.note.updatedAt - a.note.updatedAt;
    return a.note.id.localeCompare(b.note.id);
  });

  const sliced = limit > 0 ? scored.slice(0, limit) : scored;
  return sliced.map((item, idx) => ({ ...item, rank: idx + 1 }));
}
