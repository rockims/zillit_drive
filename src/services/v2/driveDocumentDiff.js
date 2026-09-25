import DriveDocumentText from './driveDocumentText.js';

/**
 * Paragraph-by-paragraph comparison of two document or presentation
 * versions.
 *
 * Pure, like the spreadsheet comparison, and returns the same shape so
 * both are stored and served alike: each "sheet" is a section (the
 * document body, or one slide) and each change is one paragraph:
 *   added    a new paragraph
 *   removed  a paragraph that's gone
 *   changed  a paragraph that was edited; before and after are trimmed to
 *            the edited part with a little text either side
 * `c` is the paragraph's number within its section (1-based) and `r` the
 * same, zero-based, in the version the paragraph belongs to.
 */

const DEFAULT_MAX_CHANGES = 1000;
// Longest text kept per side of a change.
const MAX_TEXT = 400;
// Unchanged text kept either side of an edit.
const CONTEXT = 60;
// Paragraph pairs compared exactly; beyond this, a block that differs is
// reported as removed and added.
const MAX_ALIGN_CELLS = 4000000;
// Word overlap above which a removed and an added paragraph are one edit.
const SIMILAR = 0.5;
const MAX_PAIRING = 40000;

const trimEnd = (text) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text);

// Up to CONTEXT characters of unchanged text, cut at a word boundary.
const leadingContext = (text) => {
  if (text.length <= CONTEXT) return text;
  const tail = text.slice(-CONTEXT);
  const space = tail.indexOf(' ');
  return `…${space >= 0 ? tail.slice(space + 1) : tail}`;
};

const trailingContext = (text) => {
  if (text.length <= CONTEXT) return text;
  const head = text.slice(0, CONTEXT);
  const space = head.lastIndexOf(' ');
  return `${space > 0 ? head.slice(0, space) : head}…`;
};

/**
 * Before and after of an edited paragraph, trimmed to the part that
 * changed plus some unchanged text either side. Both sides share that
 * unchanged text, so they can be compared word by word.
 */
const focusEdit = (before, after) => {
  const shorter = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shorter && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < shorter - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;

  // Start and end on whole words so the unchanged text reads cleanly.
  while (prefix > 0 && /\S/.test(before[prefix - 1])) prefix -= 1;
  while (suffix > 0 && /\S/.test(before[before.length - suffix])) suffix -= 1;

  const lead = leadingContext(before.slice(0, prefix));
  const trail = trailingContext(before.slice(before.length - suffix));
  const middle = (text) => {
    const part = text.slice(prefix, text.length - suffix);
    return part.length > MAX_TEXT ? `${part.slice(0, MAX_TEXT - 1)}…` : part;
  };
  return { b: `${lead}${middle(before)}${trail}`, a: `${lead}${middle(after)}${trail}` };
};

const wordsOf = (text) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

// Share of words two paragraphs have in common (0 to 1).
const similarity = (x, y) => {
  const a = wordsOf(x);
  const b = wordsOf(y);
  if (!a.length || !b.length) return 0;
  const counts = new Map();
  a.forEach((word) => counts.set(word, (counts.get(word) || 0) + 1));
  let common = 0;
  b.forEach((word) => {
    const left = counts.get(word);
    if (left) {
      common += 1;
      counts.set(word, left - 1);
    }
  });
  return (2 * common) / (a.length + b.length);
};

/**
 * Line up two lists of paragraph texts. Returns steps in document order:
 * { type: 'same', i, j } | { type: 'removed', i } | { type: 'added', j },
 * where i indexes `before` and j indexes `after`.
 */
const alignParagraphs = (before, after) => {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1;
    endAfter -= 1;
  }

  const steps = [];
  for (let k = 0; k < start; k += 1) steps.push({ type: 'same', i: k, j: k });

  const rows = endBefore - start;
  const cols = endAfter - start;
  if (rows && cols && rows * cols <= MAX_ALIGN_CELLS) {
    // Longest common subsequence of the differing middle, from the end.
    const width = cols + 1;
    const lcs = new Uint32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i -= 1) {
      for (let j = cols - 1; j >= 0; j -= 1) {
        lcs[i * width + j] = before[start + i] === after[start + j]
          ? lcs[(i + 1) * width + j + 1] + 1
          : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < rows && j < cols) {
      if (before[start + i] === after[start + j]) {
        steps.push({ type: 'same', i: start + i, j: start + j });
        i += 1;
        j += 1;
      } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
        steps.push({ type: 'removed', i: start + i });
        i += 1;
      } else {
        steps.push({ type: 'added', j: start + j });
        j += 1;
      }
    }
    for (; i < rows; i += 1) steps.push({ type: 'removed', i: start + i });
    for (; j < cols; j += 1) steps.push({ type: 'added', j: start + j });
  } else {
    for (let i = start; i < endBefore; i += 1) steps.push({ type: 'removed', i });
    for (let j = start; j < endAfter; j += 1) steps.push({ type: 'added', j });
  }

  for (let k = 0; k < before.length - endBefore; k += 1) {
    steps.push({ type: 'same', i: endBefore + k, j: endAfter + k });
  }
  return steps;
};

/**
 * Within one run of removed and added paragraphs, decide which removed
 * paragraph became which added one. The same number on both sides pair up
 * in order; otherwise a pair needs enough words in common. Returns the run
 * as changes in document order.
 */
const pairRun = (removed, added, beforeTexts, afterTexts) => {
  const partner = new Map();
  if (removed.length === added.length) {
    removed.forEach((i, k) => partner.set(i, added[k]));
  } else if (removed.length * added.length <= MAX_PAIRING) {
    let from = 0;
    removed.forEach((i) => {
      let best = -1;
      let bestScore = SIMILAR;
      for (let k = from; k < added.length; k += 1) {
        const score = similarity(beforeTexts[i], afterTexts[added[k]]);
        if (score >= bestScore) {
          best = k;
          bestScore = score;
          if (score === 1) break;
        }
      }
      if (best >= 0) {
        partner.set(i, added[best]);
        from = best + 1;
      }
    });
  }

  const run = [];
  let next = 0;
  removed.forEach((i) => {
    const j = partner.get(i);
    if (j == null) {
      run.push({ type: 'removed', i });
      return;
    }
    while (added[next] !== j) {
      run.push({ type: 'added', j: added[next] });
      next += 1;
    }
    run.push({ type: 'changed', i, j });
    next += 1;
  });
  for (; next < added.length; next += 1) run.push({ type: 'added', j: added[next] });
  return run;
};

// Each paragraph's position within its section.
const positionsIn = (paragraphs) => {
  const counts = new Map();
  return paragraphs.map((p) => {
    const n = counts.get(p.section) || 0;
    counts.set(p.section, n + 1);
    return n;
  });
};

/**
 * Compare two versions of a document or presentation. Sections appear in
 * document order; unchanged ones are left out.
 */
const diffDocumentBuffers = (bufferBefore, bufferAfter, { extension, maxChanges = DEFAULT_MAX_CHANGES } = {}) => {
  const before = DriveDocumentText.readParagraphs(bufferBefore, extension);
  const after = DriveDocumentText.readParagraphs(bufferAfter, extension);
  const beforeTexts = before.map((p) => p.text);
  const afterTexts = after.map((p) => p.text);
  const beforeAt = positionsIn(before);
  const afterAt = positionsIn(after);

  // Group each run of removed/added steps, then pair within it.
  const changes = [];
  let removed = [];
  let added = [];
  const flushRun = () => {
    if (removed.length || added.length) changes.push(...pairRun(removed, added, beforeTexts, afterTexts));
    removed = [];
    added = [];
  };
  alignParagraphs(beforeTexts, afterTexts).forEach((step) => {
    if (step.type === 'same') flushRun();
    else if (step.type === 'removed') removed.push(step.i);
    else added.push(step.j);
  });
  flushRun();

  const sections = [];
  const bySection = new Map();
  let left = maxChanges;
  changes.forEach((change) => {
    const inBefore = change.type === 'removed';
    const name = inBefore ? before[change.i].section : after[change.j].section;
    let section = bySection.get(name);
    if (!section) {
      section = {
        name, status: 'changed', total: 0, changes: [],
      };
      bySection.set(name, section);
      sections.push(section);
    }
    section.total += 1;
    if (left <= 0) return;
    left -= 1;

    const r = inBefore ? beforeAt[change.i] : afterAt[change.j];
    let texts;
    if (change.type === 'changed') texts = focusEdit(beforeTexts[change.i], afterTexts[change.j]);
    else if (inBefore) texts = { b: trimEnd(beforeTexts[change.i]), a: '' };
    else texts = { b: '', a: trimEnd(afterTexts[change.j]) };

    section.changes.push({
      c: String(r + 1), r, col: 0, k: change.type, ...texts,
    });
  });

  return {
    total: changes.length,
    truncated: changes.length > maxChanges,
    sheets: sections,
  };
};

export {
  alignParagraphs,
  focusEdit,
  similarity,
  DEFAULT_MAX_CHANGES,
};

export default {
  diffDocumentBuffers,
};
