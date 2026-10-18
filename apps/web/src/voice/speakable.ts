/**
 * Markdown to speech: voice mode reads assistant replies aloud, so this module strips
 * Markdown down to plain prose and cuts a streaming reply into speakable chunks.
 */

/** Plain prose prepared for text-to-speech, plus whether long-form Markdown was dropped. */
export type PreparedSpeech = {
  text: string;
  truncated: boolean;
};

/** Incremental chunker over a growing Markdown reply. */
export type SpeechChunker = {
  /** Adds the full Markdown seen so far and returns newly speakable chunks. */
  push: (markdownSoFar: string) => string[];
  /** Flushes whatever is left when the stream ends. */
  finish: () => string[];
};

const TRUNCATION_NOTICE = "Details are in the thread.";
const MAX_SPEAKABLE_LIST_ITEMS = 5;
const FIRST_CHUNK_MIN_WORDS = 6;
const MAX_CHUNK_CHARACTERS = 220;

const LIST_ITEM_PATTERN = /^\s*(?:[-*+]|\d+[.)])\s+/;
const HEADING_PATTERN = /^\s{0,3}(#{1,6})\s+(.*)$/;
const HORIZONTAL_RULE_PATTERN = /^\s*(?:[-*_]\s*){3,}$/;
const BLOCKQUOTE_PATTERN = /^(\s*>\s?)+/;
const IMAGE_PATTERN = /!\[[^\]]*\]\([^)]*\)/g;
const LINK_PATTERN = /\[([^\]]*)\]\([^)]*\)/g;
// A link or image that is still being typed when the stream ends: keep the label, drop the rest.
const UNCLOSED_IMAGE_PATTERN = /!\[[^\]]*\]\([^)\s]*$/;
const UNCLOSED_LINK_PATTERN = /\[([^\]]*)\]\([^)\s]*$/;
const INLINE_CODE_PATTERN = /`([^`]*)`/g;
const BARE_URL_PATTERN = /https?:\/\/\S*[^\s.,;:!?)\]]/g;
const HTML_TAG_PATTERN = /<\/?[A-Za-z][^<>]*>/g;
const HEX_TOKEN_PATTERN = /\b[0-9a-f]{7,}\b/g;
const EMPHASIS_MARKER_PATTERN = /\*\*|~~|\*/g;
const UNDERSCORE_MARKER_PATTERN = /(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g;
const TERMINAL_PUNCTUATION_PATTERN = /[.!?…]$/;
const TRAILING_CLAUSE_PATTERN = /[,;:]+$/;
const SENTENCE_TERMINATORS = new Set([".", "!", "?"]);
const CLAUSE_TERMINATORS = new Set([",", ";", ":"]);
const ABBREVIATIONS = new Set(["e.g", "i.e", "etc", "vs", "Mr", "Mrs", "Dr"]);

function isWhitespace(char: string): boolean {
  return char.length > 0 && /\s/.test(char);
}

function isSpeechHashToken(token: string): boolean {
  return /^[0-9a-f]{7,}$/.test(token) && /[0-9]/.test(token);
}

function speakInlineCode(code: string): string {
  const slashIndex = code.lastIndexOf("/");
  const segment = slashIndex >= 0 ? code.slice(slashIndex + 1) : code;
  if (isSpeechHashToken(segment)) {
    return "a hash";
  }
  return segment.replace(/\./g, " dot ");
}

function replaceHexTokens(text: string): string {
  return text.replace(HEX_TOKEN_PATTERN, (token) => (isSpeechHashToken(token) ? "a hash" : token));
}

/** Converts one Markdown block (paragraph, heading or list item) to plain prose. */
function toSpeakableText(block: string): string {
  const result = block
    .replace(UNCLOSED_IMAGE_PATTERN, "")
    .replace(UNCLOSED_LINK_PATTERN, "$1")
    .replace(IMAGE_PATTERN, "")
    .replace(LINK_PATTERN, "$1")
    .replace(INLINE_CODE_PATTERN, (_match, code: string) => speakInlineCode(code))
    .replace(/`/g, "")
    .replace(BARE_URL_PATTERN, "a link")
    .replace(EMPHASIS_MARKER_PATTERN, "")
    .replace(UNDERSCORE_MARKER_PATTERN, "")
    .replace(HTML_TAG_PATTERN, "");
  return replaceHexTokens(result).replace(/\s+/g, " ").trim();
}

function ensureSentenceEnd(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return "";
  }
  return TERMINAL_PUNCTUATION_PATTERN.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Splits Markdown into block-level units and joins their speakable form with single spaces.
 * Headings and list items become sentences (a period is added when they lack terminal
 * punctuation); paragraphs keep the punctuation they were written with.
 */
function markdownToSpeakable(markdown: string): string {
  const units: string[] = [];
  let paragraph: string[] = [];

  function flushParagraph(): void {
    if (paragraph.length > 0) {
      units.push(toSpeakableText(paragraph.join(" ")));
      paragraph = [];
    }
  }

  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.replace(BLOCKQUOTE_PATTERN, "");
    if (line.trim().length === 0 || HORIZONTAL_RULE_PATTERN.test(line)) {
      flushParagraph();
      continue;
    }
    const heading = HEADING_PATTERN.exec(line);
    if (heading) {
      flushParagraph();
      units.push(ensureSentenceEnd(toSpeakableText(heading[2] ?? "")));
      continue;
    }
    const listItem = LIST_ITEM_PATTERN.exec(line);
    if (listItem) {
      flushParagraph();
      units.push(ensureSentenceEnd(toSpeakableText(line.slice(listItem[0].length))));
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();

  return units
    .filter((unit) => unit.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Index just after the last list item of the block starting at `start`, or `start + 1`. */
function listBlockEnd(lines: readonly string[], start: number): number {
  let end = start + 1;
  let index = start + 1;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (LIST_ITEM_PATTERN.test(line)) {
      end = index + 1;
      index += 1;
      continue;
    }
    if (line.trim().length === 0) {
      let next = index;
      while (next < lines.length && (lines[next] ?? "").trim().length === 0) {
        next += 1;
      }
      if (next < lines.length && LIST_ITEM_PATTERN.test(lines[next] ?? "")) {
        index = next;
        continue;
      }
    }
    break;
  }
  return end;
}

/**
 * Finds where reading should stop, as a character offset into the Markdown: the first fenced
 * code block (closed or not), the first table row, or the first list with more than five items.
 */
function findStopPoint(markdown: string): number | null {
  const lines = markdown.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~") || trimmed.startsWith("|")) {
      return lineStarts[index] ?? 0;
    }
    if (LIST_ITEM_PATTERN.test(line)) {
      const end = listBlockEnd(lines, index);
      let items = 0;
      for (let cursor = index; cursor < end; cursor += 1) {
        if (LIST_ITEM_PATTERN.test(lines[cursor] ?? "")) {
          items += 1;
        }
      }
      if (items > MAX_SPEAKABLE_LIST_ITEMS) {
        return lineStarts[index] ?? 0;
      }
      index = end - 1;
    }
  }
  return null;
}

/** Appends the truncation notice as its own sentence. */
function appendTruncationNotice(text: string): string {
  if (TERMINAL_PUNCTUATION_PATTERN.test(text)) {
    return `${text} ${TRUNCATION_NOTICE}`;
  }
  return `${text.replace(TRAILING_CLAUSE_PATTERN, "")}. ${TRUNCATION_NOTICE}`;
}

/**
 * Converts Markdown into plain speakable prose, stopping at the first block that does not
 * sound good read aloud (code, tables, long lists) and saying so instead.
 */
export function prepareSpeech(markdown: string): PreparedSpeech {
  const stop = findStopPoint(markdown);
  if (stop === null) {
    return { text: markdownToSpeakable(markdown), truncated: false };
  }
  const body = markdownToSpeakable(markdown.slice(0, stop));
  if (body.length === 0) {
    return { text: "", truncated: true };
  }
  return { text: appendTruncationNotice(body), truncated: true };
}

/** Index of the first still-open `open` without a matching `close`, or -1. */
function firstUnmatchedOpen(text: string, open: string, close: string): number {
  const stack: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === open) {
      stack.push(index);
    } else if (char === close && stack.length > 0) {
      stack.pop();
    }
  }
  return stack.length > 0 ? (stack[0] ?? -1) : -1;
}

function countOccurrences(text: string, token: string): number {
  let count = 0;
  let index = text.indexOf(token);
  while (index >= 0) {
    count += 1;
    index = text.indexOf(token, index + token.length);
  }
  return count;
}

/**
 * The prefix of a streaming reply whose Markdown is certainly closed, so converting it cannot
 * change once more text arrives: everything before the first still-open `[`, `(`, backtick, or
 * `**`. Text after that point (for example `[label](htt` or `**bol`) is withheld until the
 * construct closes or the stream finishes, because it would otherwise be spoken as garbage.
 */
function stableMarkdownPrefix(markdown: string): string {
  let cut = markdown.length;
  const bracket = firstUnmatchedOpen(markdown, "[", "]");
  if (bracket >= 0) {
    cut = Math.min(cut, bracket);
  }
  const parenthesis = firstUnmatchedOpen(markdown, "(", ")");
  if (parenthesis >= 0) {
    cut = Math.min(cut, parenthesis);
  }
  if (countOccurrences(markdown, "`") % 2 === 1) {
    cut = Math.min(cut, markdown.lastIndexOf("`"));
  }
  if (countOccurrences(markdown, "**") % 2 === 1) {
    cut = Math.min(cut, markdown.lastIndexOf("**"));
  }
  return markdown.slice(0, cut);
}

/** True when the text right before a `.` ends in a listed abbreviation such as `e.g.` or `Dr.`. */
function endsWithAbbreviation(text: string): boolean {
  const match = /([A-Za-z][A-Za-z.]*)$/.exec(text);
  return match?.[1] !== undefined && ABBREVIATIONS.has(match[1]);
}

/** Index just after the last complete sentence before `limit`, or 0 when there is none. */
function lastSentenceEnd(text: string, limit: number): number {
  const last = Math.min(limit, text.length - 2);
  for (let index = last; index >= 0; index -= 1) {
    const char = text[index] ?? "";
    if (!SENTENCE_TERMINATORS.has(char)) {
      continue;
    }
    if (!isWhitespace(text[index + 1] ?? "")) {
      continue;
    }
    if (char === "." && endsWithAbbreviation(text.slice(0, index))) {
      continue;
    }
    return index + 1;
  }
  return 0;
}

/** Index just after the last clause boundary before `limit`, or 0 when there is none. */
function lastClauseEnd(text: string, limit: number): number {
  const last = Math.min(limit, text.length - 2);
  for (let index = last; index > 0; index -= 1) {
    const char = text[index] ?? "";
    if (!isWhitespace(text[index + 1] ?? "")) {
      continue;
    }
    if (CLAUSE_TERMINATORS.has(char)) {
      return index + 1;
    }
    if (char === "—" && isWhitespace(text[index - 1] ?? "")) {
      return index;
    }
  }
  return 0;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/** Splits at the last clause boundary before the limit, else the last space, else hard. */
function findSplitIndex(text: string): number {
  for (let index = MAX_CHUNK_CHARACTERS - 1; index > 0; index -= 1) {
    const char = text[index] ?? "";
    if (CLAUSE_TERMINATORS.has(char) && isWhitespace(text[index + 1] ?? "")) {
      return index + 1;
    }
    if (
      char === "—" &&
      isWhitespace(text[index - 1] ?? "") &&
      isWhitespace(text[index + 1] ?? "")
    ) {
      return index;
    }
  }
  for (let index = MAX_CHUNK_CHARACTERS - 1; index > 0; index -= 1) {
    if (isWhitespace(text[index] ?? "")) {
      return index;
    }
  }
  return MAX_CHUNK_CHARACTERS;
}

/** Breaks one spoken run into pieces a synthesizer can handle, keeping every piece ≤220 chars. */
function splitLongChunk(chunk: string): string[] {
  const chunks: string[] = [];
  let rest = chunk.trim();
  while (rest.length > MAX_CHUNK_CHARACTERS) {
    const cut = findSplitIndex(rest);
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) {
    chunks.push(rest);
  }
  return chunks;
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

/**
 * Incremental chunker for a streaming reply: each `push` receives the full Markdown so far and
 * returns only the newly complete, speakable text. Text is never retracted; a chunk is released
 * only up to a boundary whose remaining text is still safely convertible.
 */
export function createSpeechChunker(): SpeechChunker {
  let markdownSoFar = "";
  let emitted = "";
  let finished = false;
  let emittedFirstChunk = false;
  let diverged = false;

  function emitUpTo(text: string, end: number): string[] {
    const fresh = text.slice(emitted.length, end).trim();
    let next = end;
    while (next < text.length && isWhitespace(text[next] ?? "")) {
      next += 1;
    }
    emitted = text.slice(0, next);
    return fresh.length === 0 ? [] : splitLongChunk(fresh);
  }

  function push(markdown: string): string[] {
    if (finished) {
      return [];
    }
    markdownSoFar = markdown;
    const prepared = prepareSpeech(markdown);
    if (!prepared.text.startsWith(emitted)) {
      // A late construct rewrote text we already spoke. Nothing can be retracted, so stay quiet
      // and let `finish` release only the part after the longest shared prefix.
      diverged = true;
      return [];
    }
    if (prepared.truncated) {
      const chunks = emitUpTo(prepared.text, prepared.text.length);
      finished = true;
      return chunks;
    }
    if (diverged) {
      return [];
    }

    const limit = Math.min(
      prepared.text.length,
      prepareSpeech(stableMarkdownPrefix(markdown)).text.length,
    );
    let end = lastSentenceEnd(prepared.text, limit);
    if (!emittedFirstChunk) {
      const clauseEnd = lastClauseEnd(prepared.text, limit);
      if (clauseEnd > 0 && countWords(prepared.text.slice(0, clauseEnd)) >= FIRST_CHUNK_MIN_WORDS) {
        end = Math.max(end, clauseEnd);
      }
    }
    if (end <= emitted.length) {
      return [];
    }
    const chunks = emitUpTo(prepared.text, end);
    if (chunks.length > 0) {
      emittedFirstChunk = true;
    }
    return chunks;
  }

  function finish(): string[] {
    if (finished) {
      return [];
    }
    finished = true;
    const { text } = prepareSpeech(markdownSoFar);
    const common = commonPrefixLength(emitted, text);
    emitted = text;
    const fresh = text.slice(common).trim();
    return fresh.length === 0 ? [] : splitLongChunk(fresh);
  }

  return { push, finish };
}
