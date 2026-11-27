import type { DiagnosticEntry, DiagnosticLevel } from './types';

export const DEFAULT_LM_STUDIO_ENDPOINT = 'http://127.0.0.1:1234/v1';

export function normalizeApiEndpoint(endpoint: string): string {
  let trimmed = endpoint.trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_LM_STUDIO_ENDPOINT;
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `http://${trimmed}`;
  }
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

export function isLocalEndpoint(endpoint: string): boolean {
  try {
    const trimmed = endpoint.trim();
    if (!trimmed) return false;
    const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    const parsed = new URL(withProto);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host === '127.0.0.1' ||
      host === 'localhost' ||
      host === '::1' ||
      host === '[::1]'
    );
  } catch {
    return false;
  }
}

export function safeTruncateChars(input: string, maxChars: number): string {
  const chars = Array.from(input);
  if (chars.length <= maxChars) {
    return input;
  }
  if (maxChars <= 3) {
    return chars.slice(0, Math.max(0, maxChars)).join('');
  }
  return `${chars.slice(0, maxChars - 3).join('')}...`;
}

export function formatNumber(n: number): string {
  return Math.max(0, Math.floor(n)).toLocaleString('en-US');
}

export function formatRelativeTime(timestampMs: number, nowMs = Date.now()): string {
  const diffSec = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
  if (diffSec < 60) return 'Just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

/**
 * Unicode-safe diagnostic redactor. Uses regex over UTF-16 code units cleanly
 * instead of mutating original strings with lowercased byte offsets.
 */
export function sanitizeDiagnosticMessage(input: string): string {
  let text = input;

  // JSON-formatted secrets / sensitive fields ("api_key": "...", "password": "...", "prompt": "...")
  text = text.replace(
    /("(?:password|passphrase|token|api_key|apiKey|secret|authorization|prompt|content|memory_text|user_message|assistant_response)"\s*:\s*")([^"\\]*(?:\\.[^"\\]*)*)(")/gi,
    '$1[REDACTED]$3',
  );

  // Authorization header lines
  text = text.replace(/(authorization\s*:\s*)[^\n]+/gi, '$1[REDACTED]');

  // Line-scoped sensitive fields (prompt/content/passphrase)
  const linePrefixes = [
    'password=',
    'password:',
    'passphrase=',
    'passphrase:',
    'prompt:',
    'user_message:',
    'assistant_response:',
    'content:',
    'memory_text:',
  ];

  for (const prefix of linePrefixes) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped})[^\\n]*`, 'gi');
    text = text.replace(regex, '$1 [REDACTED]');
  }

  // Token-scoped credentials
  const tokenKeywords = ['bearer ', 'token=', 'api_key=', 'secret='];
  for (const kw of tokenKeywords) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped})[^\\s,&"']+`, 'gi');
    text = text.replace(regex, '$1[REDACTED]');
  }

  // Common standalone API key / access token patterns
  text = text.replace(
    /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|AIza[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    '[REDACTED_KEY]',
  );

  return text;
}

export class DiagnosticLogger {
  private level: DiagnosticLevel;
  private entries: DiagnosticEntry[] = [];
  private readonly maxEntries: number;
  private listeners: Set<() => void> = new Set();

  constructor(level: DiagnosticLevel = 'disabled', maxEntries = 500) {
    this.level = level;
    this.maxEntries = maxEntries;
  }

  setLevel(level: DiagnosticLevel): void {
    this.level = level;
    this.notify();
  }

  getLevel(): DiagnosticLevel {
    return this.level;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  log(level: 'INFO' | 'WARN' | 'ERROR', module: string, rawMessage: string): void {
    if (this.level === 'disabled') {
      return;
    }
    if (this.level === 'minimal_redacted' && level === 'INFO' && module === 'debug') {
      return;
    }

    const entry: DiagnosticEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      level,
      module,
      message: sanitizeDiagnosticMessage(rawMessage),
    };

    if (this.entries.length >= this.maxEntries) {
      this.entries.shift();
    }
    this.entries.push(entry);
    this.notify();
  }

  info(module: string, message: string): void {
    this.log('INFO', module, message);
  }

  warn(module: string, message: string): void {
    this.log('WARN', module, message);
  }

  error(module: string, message: string): void {
    this.log('ERROR', module, message);
  }

  getEntries(): DiagnosticEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
    this.notify();
  }
}
