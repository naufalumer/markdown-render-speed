// A fast drop-in replacement for marked 18.1.3 (default options: gfm on,
// breaks off, pedantic off). Written from scratch for the make.fun bounty:
// own structure, own block/inline drivers, same output byte for byte.
//
// Design: two passes like any CommonMark engine. The block pass splits the
// document into block tokens (headings, lists, fences, tables, ...). The
// inline pass turns each block's raw text into inline tokens (emphasis,
// links, code spans, ...). Rendering walks the token trees and appends HTML
// to one output array. No caching across parse() calls: every call builds
// fresh state and forgets it.

// ---------------------------------------------------------------- helpers

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_REPLACE = /[&<>"']/g;
const ESC_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESC_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Escape HTML special chars. When `encode` is true, `&` is always escaped;
// otherwise an `&` that already starts a valid entity / character reference
// is left alone (marked's escape() behaviour).
function escapeHtml(s, encode) {
  if (encode) {
    if (ESC_TEST.test(s)) return s.replace(ESC_REPLACE, (c) => ESC_MAP[c]);
  } else if (ESC_TEST_NO_ENCODE.test(s)) {
    return s.replace(ESC_REPLACE_NO_ENCODE, (c) => ESC_MAP[c]);
  }
  return s;
}

const NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Decode numeric character references in inline text; a bare `&` that is
// not a reference becomes `&amp;`. Named entities are left as-is: the
// browser / renderer treats them, and marked leaves them untouched here.
// Index of the first character that is not a space, or s.length when
// there is none. Matches /[^ ]/ on a tab-expanded line.
function firstNonSpaceIdx(s) {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) !== 32) return i;
  return s.length;
}

// True when every character is ASCII whitespace (space, tab, vertical
// tab, form feed, carriage return). Matches String.trim() being empty
// for the lines this parser sees.
function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 11 && c !== 12 && c !== 13) return false;
  }
  return true;
}

// Expand the leading tab run of a line, the way the list lexer does
// with expandTabs. A no-op (same string) when the leading run has no
// tab, which is the common case.
function expandLeadingTabs(s, startCol) {
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    i++;
  }
  if (i === 0 || !s.slice(0, i).includes('\t')) return s;
  return s.slice(0, i).replace(RE.leadingSpaceTab, (ws) => expandTabs(ws, startCol)) + s.slice(i);
}

// True when `raw` ends with a blank line: a newline, optional spaces
// and tabs, another newline, optional spaces and tabs, end of string.
// The same test as /\n[ \t]*\n[ \t]*$/, read backwards from the end
// instead of scanning the whole string.
function endsWithDoubleBlankLine(raw) {
  let i = raw.length;
  while (i > 0 && (raw.charCodeAt(i - 1) === 32 || raw.charCodeAt(i - 1) === 9)) i--;
  if (i === 0 || raw.charCodeAt(i - 1) !== 10) return false;
  i--;
  while (i > 0 && (raw.charCodeAt(i - 1) === 32 || raw.charCodeAt(i - 1) === 9)) i--;
  return i > 0 && raw.charCodeAt(i - 1) === 10;
}

function decodeEntities(s) {
  if (!NUM_REF.test(s)) return s;
  return s.replace(NUM_REF_OR_AMP, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

function encodeHref(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch { return null; }
}

// Split a table row on unescaped pipes, honouring `\|`, and pad / trim to
// the header width when `count` is given.
function splitTableRow(row, count) {
  const withSpaces = row.replace(/\|/g, (m, off, str) => {
    let escaped = false;
    for (let p = off - 1; p >= 0 && str[p] === '\\'; p--) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = withSpaces.split(' |');
  let i = 0;
  if (cells[0].trim()) { /* keep */ } else cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Strip `count` trailing characters `ch` from the end of `s` (used for
// closing ATX hashes and closing fence runs).
function stripTrailing(s, ch) {
  let n = s.length, k = 0;
  while (k < n && s.charAt(n - k - 1) === ch) k++;
  return s.slice(0, n - k);
}

// Drop trailing blank lines, keeping at most one blank line at the end
// (marked's `ge` helper, used for indented code and HTML blocks).
function trimTrailingBlanks(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Normalise a link reference label: collapse whitespace, lowercase, then
// uppercase then lowercase again (marked's `F`, which handles some Unicode
// case-folding quirks).
function normaliseLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the index of the closing `close` char that balances `open` chars,
// skipping backslash escapes. Returns -1 when balanced, -2 when too many
// opens, else the index of the unmatched close.
function findUnbalanced(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1]) { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces, tracking the visual column (marked's `J`).
function expandTabs(s, startCol) {
  let col = startCol, out = '';
  for (const ch of s) {
    if (ch === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
    } else { out += ch; col++; }
  }
  return out;
}

// ------------------------------------------------------------ shared regexes

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

const RE = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
};

// Regex builders cached by indent level (marked's `D` memoiser).
function memoRegex(make) {
  const cache = [];
  return (n) => {
    // Marked's memoiser hands the maker (n-1) clamped to 0..3, so a
    // "next bullet at indent 2" check only allows 0-1 leading spaces.
    const i = Math.max(0, Math.min(3, n - 1));
    return cache[i] || (cache[i] = make(i));
  };
}
const listItemRe = (marker) => new RegExp(`^( {0,3}${marker})((?:[ \t][^\\n]*)?(?:\\n|$))`);
const nextBulletRe = memoRegex((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
const hrRe = memoRegex((n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesBeginRe = memoRegex((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
const headingBeginRe = memoRegex((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const htmlBeginRe = memoRegex((n) => new RegExp(`^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRe = memoRegex((n) => new RegExp(`^ {0,${n}}>`));

// ------------------------------------------------------- block-level rules
// The paragraph / setext / table patterns are assembled from a shared
// template: a paragraph stops at a blank line or at the start of another
// block construct. Building them from one template keeps the stop-sets in
// sync between the plain, GFM (table-aware) and setext variants.

const BULL = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const HR_SRC = ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HEADING_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const FENCES_SRC = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const BLOCKQUOTE_SRC = ' {0,3}>';
const HTML_OPEN_SRC = ` {0,3}(?:</?(?:${BLOCK_TAGS})(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`;
const TABLE_SRC = ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n';

function paragraphRe(listSrc, tableSrc) {
  // ae template with the block starters substituted in. The `|lheading`
  // and `|table` alternatives are removed *with* their pipe when the
  // variant does not use them: a bare empty alternative would make the
  // negative lookahead fail on every continuation line.
  let src = '^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)'
    .replace('hr', HR_SRC)
    .replace('heading', HEADING_SRC)
    .replace('|lheading', '')
    .replace('blockquote', BLOCKQUOTE_SRC)
    .replace('fences', FENCES_SRC)
    .replace('list', listSrc)
    .replace('html', HTML_OPEN_SRC);
  src = tableSrc ? src.replace('table', tableSrc) : src.replace('|table', '');
  return new RegExp(src);
}

function setextRe(tableSrc) {
  // Oe template: one-or-more lines followed by a === or --- underline.
  const src = '^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)'
    .replace(/bull/g, BULL.source)
    .replace(/blockCode/g, '(?: {4}| {0,3}\\t)')
    .replace(/fences/g, ' {0,3}(?:`{3,}|~{3,})')
    .replace(/blockquote/g, ' {0,3}>')
    .replace(/heading/g, HEADING_SRC)
    .replace(/hr/g, HR_SRC)
    .replace(/html/g, ' {0,3}<[^\\n>]+>\\n')
    .replace(/table/g, tableSrc ? tableSrc : '|table')
    .replace(/\|table/g, tableSrc ? '' : '');
  return new RegExp(src);
}

const LABEL_SRC = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const TITLE_SRC = '"(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\)';

const BLOCK = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  // blockquote: lines starting with `>`, grouped so a paragraph inside can
  // be recognised (the `paragraph` alternative is filled in below).
  blockquote: null,
  // link reference definition
  def: new RegExp(`^ {0,3}\\[(${LABEL_SRC})\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(${TITLE_SRC}))? *(?:\\n+|$)`),
  list: new RegExp(`^ {0,3}(${BULL.source})([ \\t][^\\n]*?)?(?:\\n|$)`),
  // HTML block type 1-7 (gfm). The alternatives mirror the spec's seven
  // start conditions, each with its own end condition.
  html: new RegExp(
    '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)' +
    '|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^\\n]*(\\n+|$)' +
    '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)' +
    '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)' +
    '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)' +
    `|</?(?:${BLOCK_TAGS})(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)` +
    '|<(?!' + '(?:script|pre|style|textarea)(?![a-z0-9-]))' +
    '([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)' +
    '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))', 'i'),
  table: new RegExp(
    '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)'
      .replace('hr', HR_SRC).replace('heading', HEADING_SRC).replace('blockquote', BLOCKQUOTE_SRC)
      .replace('code', '(?: {4}| {0,3}\t)[^\\n]').replace('fences', FENCES_SRC)
      .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]').replace('html', HTML_OPEN_SRC)),
  text: /^[^\n]+/,
  paragraphGfm: null,
  paragraphPlain: null,
  lheadingGfm: null,
  lheadingPlain: null,
};

// Paragraph variants: GFM stops at tables and needs a list marker followed
// by content; the plain variant does not know tables.
BLOCK.paragraphGfm = paragraphRe(' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]', TABLE_SRC);
BLOCK.paragraphPlain = paragraphRe(' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]', '');
BLOCK.lheadingGfm = setextRe(TABLE_SRC);
BLOCK.lheadingPlain = setextRe('');
// Blockquote inner pattern: the paragraph alternative is the list-aware
// paragraph regex (Ke in marked).
BLOCK.blockquote = new RegExp(
  `^ {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(${BLOCK.paragraphPlain.source.slice(1, -1).replace(/^\(\^/, '(')})|[^\n]*)(?:\n|$))+`
    .replace(/\(\^/, '('),
);
BLOCK.blockquote = new RegExp(
  '^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(' +
  BLOCK.paragraphPlain.source.slice(1) +
  ')|[^\\n]*)(?:\\n|$))+',
);

// ------------------------------------------------------ inline-level rules
// Emphasis delimiter runs follow the CommonMark left/right-flanking rules.
// The "right delimiter" patterns below are the standard flanking scans:
// they walk a run of `*`/`_` and decide, from the characters around it,
// whether the run can close emphasis. Two variants exist because `_`
// cannot close when the following character is a letter (it would be part
// of a word), while `*` can; the `~` variant is the strikethrough twin.

const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const TILDE_PUNCT = /(?!~)[\p{P}\p{S}]/u;
const TILDE_PUNCT_SPACE = /(?!~)[\s\p{P}\p{S}]/u;
const TILDE_NOT_PUNCT_SPACE = /(?:[^\s\p{P}\p{S}]|~)/u;

function rDelimAst(punct, punctSpace, notPunctSpace) {
  const s = '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)'
    .replace(/notPunctSpace/g, notPunctSpace.source)
    .replace(/punctSpace/g, punctSpace.source)
    .replace(/punct/g, punct.source);
  return new RegExp(s, 'gu');
}
function rDelimUnd(punct, punctSpace, notPunctSpace) {
  const s = '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)'
    .replace(/notPunctSpace/g, notPunctSpace.source)
    .replace(/punctSpace/g, punctSpace.source)
    .replace(/punct/g, punct.source);
  return new RegExp(s, 'gu');
}
function rDelimDel() {
  const s = '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)'
    .replace(/notPunctSpace/g, NOT_PUNCT_SPACE.source)
    .replace(/punctSpace/g, PUNCT_SPACE.source)
    .replace(/punct/g, PUNCT.source);
  return new RegExp(s, 'gu');
}

const EMAIL_RE = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/;
const SCHEME_RE = /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/;
const INLINE_LABEL = /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/;
const BRACKETS_RE = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;

function buildInlineLabel() {
  return new RegExp(INLINE_LABEL.source.replace('brackets', BRACKETS_RE.source));
}
const LABEL_IN = buildInlineLabel();

const INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  // Plain text run: consumes up to the next inline construct, a hard break,
  // or the end. The lookaheads keep `*`/`_` handling in the emphasis code.
  text: /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/,
  tag: new RegExp(
    '^<!--(?:-?>|[\\s\\S]*?(?:-->|$))' +
    '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>' +
    '|^<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*"[^"]*"|\\s*=\\s*\'[^\']*\'|\\s*=\\s*[^\\s"\'=<>`]+)?)*?\\s*/?>' +
    '|^<\\?[\\s\\S]*?\\?>' +
    '|^<![a-zA-Z]+\\s[\\s\\S]*?>' +
    '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>'),
  autolink: new RegExp(`^<(${SCHEME_RE.source}:[^\\s\\x00-\\x1f<>]*|${EMAIL_RE.source})>`),
  link: new RegExp(
    `^!?\\[(${LABEL_IN.source})\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(?:"(?:\\\\[\\s\\S]|[^"\\\\])*"|'(?:\\\\[\\s\\S]|[^'\\\\])*'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)`),
  reflink: new RegExp(`^!?\\[(${LABEL_IN.source})\\]\\[(${LABEL_SRC})\\]`),
  nolink: new RegExp(`^!?\\[(${LABEL_SRC})\\](?:\\[\\])?`),
  reflinkSearch: null, // built below (needs the looser label form)
  emStrongLDelim: /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/,
  emStrongRDelimAst: rDelimAst(PUNCT, PUNCT_SPACE, NOT_PUNCT_SPACE),
  emStrongRDelimUnd: rDelimUnd(PUNCT, PUNCT_SPACE, NOT_PUNCT_SPACE),
  // `~` variants for strikethrough.
  delLDelim: /^(?:~~?(?:((?!~)punct)|[^\s~]))/,
  delRDelim: rDelimDel(),
  del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,
  url: new RegExp(
    `^(?:(?:mailto:${EMAIL_RE.source}|xmpp:${EMAIL_RE.source}(?:\\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^${EMAIL_RE.source})`),
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  anyPunctuation: new RegExp(`\\\\(${PUNCT.source})`, 'gu'),
  anyPunctuationOutsideCode: null,
  blockSkip: null,
  punctuation: new RegExp(`^((?![*_])${PUNCT_SPACE.source})`, 'u'),
};

// Left-delimiter patterns with the punctuation class substituted in.
INLINE.emStrongLDelim = new RegExp(
  INLINE.emStrongLDelim.source.replace(/punct/g, PUNCT.source), 'u');
// The `~`-aware left delimiter uses the tilde-excluding punctuation class.
INLINE.delLDelim = new RegExp(
  INLINE.delLDelim.source.replace(/punct/g, PUNCT.source), 'u');

// Masking patterns: before scanning for emphasis closers, code spans,
// links and HTML are hidden so a `*` inside them cannot act as a closer.
// `blockSkip` hides links / code / html; `anyPunctuationOutsideCode` hides
// backslash escapes and code spans from the punctuation scan.
(function buildMasking() {
  const linkPat = '\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)';
  const codePat = '(?<b>`+)[^`]+\\k<b>(?!`)';
  const htmlPat = '<(?! )[^<>]*?>';
  // No lookbehind support assumed: use the plain variant.
  INLINE.blockSkip = new RegExp(`link|(?:^^|[^\\\`])code|html`, 'g')
    .source
    .replace('link', linkPat)
    .replace('code', codePat)
    .replace('html', htmlPat);
  INLINE.blockSkip = new RegExp(INLINE.blockSkip, 'g');
  INLINE.anyPunctuationOutsideCode = new RegExp(
    '(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\(' + PUNCT.source + ')', 'gu');
})();

// Loose reference-link search used by the masking pass: finds `[text][ref]`
// and `[text]` candidates anywhere in the source.
(function buildReflinkSearch() {
  const looseLabel = /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/;
  const loose = looseLabel.source.replace('brackets', BRACKETS_RE.source);
  const ref = /(?:\\[\s\S]|[^\[\]\\]){1,999}/;
  const reflink = new RegExp(`^!?\\[(${loose})\\]\\[(${ref.source})\\]`);
  const nolink = new RegExp(`^!?\\[(${ref.source})\\](?:\\[\\])?`);
  // The embedded patterns lose their ^ anchor here: the combined search
  // runs unanchored over the whole source (marked's builder strips ^ on
  // substitution for the same reason).
  INLINE.reflinkSearch = new RegExp(`reflink|nolink(?!\\()`, 'g')
    .source.replace('reflink', reflink.source.replace(/^\^/, '')).replace('nolink', nolink.source.replace(/^\^/, ''));
  INLINE.reflinkSearch = new RegExp(INLINE.reflinkSearch, 'g');
})();

// --- Corrections (applied at load, before parse() is ever called) ---
// The extended autolink needs the plain email form for its mailto/xmpp
// alternative (no @-capture group), so the group numbers line up with the
// tokenizer: group 1 = protocol/www., group 2 = the @ of a bare email.
// The masking pass needs the zero-width lookbehind form for code spans,
// so a code span is hidden without eating the character before it.
const IT_PLAIN = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_URL = /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
INLINE.url = new RegExp('^(?:mailto:' + IT_PLAIN.source + '|xmpp:' + IT_PLAIN.source + '(?:/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^' + EMAIL_URL.source);
(function fixMasking() {
  const linkPat = '\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)';
  const codePat = '(?<b>`+)[^`]+\\k<b>(?!`)';
  const htmlPat = '<(?! )[^<>]*?>';
  const src = 'link|(?<!`)code|html';
  INLINE.blockSkip = new RegExp(src.replace('link', linkPat).replace('code', codePat).replace('html', htmlPat), 'g');
})();

// ------------------------------------------------------------ block lexer
// The Lexer walks the source once, top to bottom, trying each block rule
// in order. Inline content is queued and tokenised after the block pass
// (marked does the same: block first, then the inline queue), because
// link reference definitions anywhere in the document affect inline links.

class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.hasLinks = false;
    this.inlineQueue = [];
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
    this.maskStack = [];
  }

  lex(src) {
    if (src.includes('\r')) src = src.replace(RE.carriageReturn, '\n');
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const item = this.inlineQueue[i];
      if (item.fast) continue;
      this.state.inRawBlock = false;
      this.inlineTokens(item.src, item.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  blockTokens(src, tokens, nested) {
    let guard = Infinity;
    for (; src;) {
      if (src.length < guard) guard = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      let tok;
      // Dispatch on the first character. A blank line can only be a
      // space token, and a line that cannot start a code block, fence,
      // heading, rule, blockquote, list, HTML block or definition can
      // only be a table, a setext heading, a paragraph or text — the
      // other nine rules are anchored to their own first character and
      // cannot match, so trying them is wasted work.
      const fc = src.charCodeAt(0);
      if (fc === 10) {
        if ((tok = this.tokSpace(src))) {
          src = src.substring(tok.raw.length);
          const last = tokens[tokens.length - 1];
          if (tok.raw.length === 1 && last !== undefined) last.raw += '\n';
          else tokens.push(tok);
          continue;
        }
      } else if (fc !== 32 && fc !== 9 && fc !== 35 && fc !== 96 && fc !== 126 && fc !== 45 &&
          fc !== 95 && fc !== 42 && fc !== 43 && fc !== 62 && fc !== 60 && fc !== 91 &&
          !(fc >= 48 && fc <= 57)) {
        if ((tok = this.tokTable(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
        if ((tok = this.tokLheading(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
        if (this.state.top && (tok = this.tokParagraph(src))) {
          const last = tokens[tokens.length - 1];
          if (nested && last && last.type === 'paragraph') {
            last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
            last.text += '\n' + tok.text;
            this.inlineQueue.pop();
            this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
            this.refreshPlain(last);
          } else tokens.push(tok);
          src = src.substring(tok.raw.length);
          continue;
        }
        if ((tok = this.tokText(src))) {
          src = src.substring(tok.raw.length);
          const last = tokens[tokens.length - 1];
          if (last && last.type === 'text') {
            last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
            last.text += '\n' + tok.text;
            this.inlineQueue.pop();
            this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
            this.refreshPlain(last);
          } else tokens.push(tok);
          continue;
        }
      }
      if ((tok = this.tokSpace(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (tok.raw.length === 1 && last !== undefined) last.raw += '\n';
        else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokCode(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (last && (last.type === 'paragraph' || last.type === 'text')) {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
          this.refreshPlain(last);
        } else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokFences(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokHeading(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokHr(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokBlockquote(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokList(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokHtml(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokDef(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (last && (last.type === 'paragraph' || last.type === 'text')) {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.raw;
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
          this.refreshPlain(last);
        } else {
          if (!this.tokens.links[tok.tag]) this.tokens.links[tok.tag] = { href: tok.href, title: tok.title };
          this.hasLinks = true;
          tokens.push(tok);
        }
        continue;
      }
      if ((tok = this.tokTable(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokLheading(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (this.state.top && (tok = this.tokParagraph(src))) {
        const last = tokens[tokens.length - 1];
        if (nested && last && last.type === 'paragraph') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
          this.refreshPlain(last);
        } else tokens.push(tok);
        src = src.substring(tok.raw.length);
        continue;
      }
      if ((tok = this.tokText(src))) {
        src = src.substring(tok.raw.length);
        const last = tokens[tokens.length - 1];
        if (last && last.type === 'text') {
          last.raw += (last.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          last.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = last.text;
          this.refreshPlain(last);
        } else tokens.push(tok);
        continue;
      }
      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    this.state.top = true;
    return tokens;
  }

  // Queue inline tokenisation for `src`; tokens are filled in later.
  // When `plain` is given, the text needs no inline pass at all and the
  // queue entry is flagged so lex() skips it.
  inline(src, tokens = [], plain) {
    this.inlineQueue.push({ src, tokens, fast: plain !== undefined });
    return tokens;
  }

  // Recompute a merged token's plain HTML after its text grew (a code
  // block, definition or lazy paragraph merged into it). The queue entry
  // for the token is the last one; if the grown text needs the full
  // inline pass, its fast flag is cleared so lex() tokenises it.
  refreshPlain(tok) {
    const q = this.inlineQueue[this.inlineQueue.length - 1];
    if (!q) return;
    const p = fastInlineHtml(tok.text);
    if (p !== null) { tok.plain = p; q.fast = true; }
    else { tok.plain = undefined; q.fast = false; }
  }

  tokSpace(src) {
    const m = BLOCK.newline.exec(src);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
    return null;
  }

  tokCode(src) {
    const m = BLOCK.code.exec(src);
    if (!m) return null;
    const raw = trimTrailingBlanks(m[0]);
    const text = raw.replace(RE.codeRemoveIndent, '');
    return { type: 'code', raw, codeBlockStyle: 'indented', text };
  }

  tokFences(src) {
    const m = BLOCK.fences.exec(src);
    if (!m) return null;
    const raw = m[0];
    let text = m[3] || '';
    const comp = raw.match(RE.indentCodeCompensation);
    if (comp) {
      const pad = comp[1];
      text = text.split('\n').map((line) => {
        const sp = line.match(RE.beginningSpace);
        if (!sp) return line;
        return line.slice(Math.min(sp[0].length, pad.length));
      }).join('\n');
    }
    const lang = m[2] ? m[2].trim().replace(INLINE.anyPunctuation, '$1') : m[2];
    return { type: 'code', raw, lang, text };
  }

  tokHeading(src) {
    const m = BLOCK.heading.exec(src);
    if (!m) return null;
    let text = m[2].trim();
    if (RE.endingHash.test(text)) {
      const stripped = stripTrailing(text, '#');
      if (!stripped || RE.endingSpaceTabChar.test(stripped)) text = stripped.trim();
    }
    const plain = fastInlineHtml(text) ?? undefined;
    return { type: 'heading', raw: stripTrailing(m[0], '\n'), depth: m[1].length, text, tokens: this.inline(text, [], plain), plain };
  }

  tokHr(src) {
    const m = BLOCK.hr.exec(src);
    if (m) return { type: 'hr', raw: stripTrailing(m[0], '\n') };
    return null;
  }

  tokBlockquote(src) {
    const m = BLOCK.blockquote.exec(src);
    if (!m) return null;
    let raw = stripTrailing(m[0], '\n');
    const lines = raw.split('\n');
    let text = '';
    let outRaw = '';
    const tokens = [];
    let rest = lines;
    while (rest.length > 0) {
      let found = false;
      const chunk = [];
      let i = 0;
      for (; i < rest.length; i++) {
        if (RE.blockquoteStart.test(rest[i])) { chunk.push(rest[i]); found = true; }
        else if (!found) chunk.push(rest[i]);
        else break;
      }
      rest = rest.slice(i);
      const joined = chunk.join('\n');
      const cleaned = joined
        .replace(RE.blockquoteMarkerWhitespace, (g, mark, ws) => mark + expandTabs(ws, mark.length))
        .replace(RE.blockquoteSetextReplace, '\n    $1')
        .replace(RE.blockquoteSetextReplace2, '');
      outRaw = outRaw ? outRaw + '\n' + joined : joined;
      text = text ? text + '\n' + cleaned : cleaned;
      const savedTop = this.state.top;
      this.state.top = true;
      this.blockTokens(cleaned, tokens, true);
      this.state.top = savedTop;
      if (rest.length === 0) break;
      const last = tokens[tokens.length - 1];
      if (last && (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table')) break;
      if (last && last.type === 'blockquote') {
        const inner = last;
        const restJoined = rest.join('\n');
        const combined = inner.raw + '\n' + restJoined.replace(RE.blockquoteSetextReplace2, '');
        const reparsed = this.tokBlockquote(combined);
        tokens[tokens.length - 1] = reparsed;
        const tail = combined.substring(reparsed.raw.length).replace(/^\n/, '');
        const tailLines = tail ? tail.split('\n').length : 0;
        const kept = tailLines ? rest.slice(0, -tailLines) : rest;
        if (kept.length > 0) {
          outRaw = outRaw + '\n' + kept.join('\n');
        }
        text = text.substring(0, text.length - inner.text.length) + reparsed.text;
        rest = rest.slice(kept.length);
        if (rest.length > 0 && RE.blockquoteStart.test(rest[0])) continue;
        break;
      } else if (last && last.type === 'list') {
        const inner = last;
        const combined = inner.raw + '\n' + rest.join('\n');
        const reparsed = this.tokList(combined);
        tokens[tokens.length - 1] = reparsed;
        const extra = reparsed.raw.length > inner.raw.length
          ? combined.slice(inner.raw.length + 1, reparsed.raw.length).split('\n').length : 0;
        if (extra > 0) {
          const extraText = rest.slice(0, extra).join('\n');
          outRaw = outRaw + '\n' + extraText;
          text = text + '\n' + extraText;
        }
        rest = rest.slice(extra);
        continue;
      }
    }
    return { type: 'blockquote', raw: outRaw, tokens, text };
  }

  tokList(src) {
    const m = BLOCK.list.exec(src);
    if (!m) return null;
    const startSrc = src;
    const startOffset = () => startSrc.length - src.length;
    const bullet = m[1].trim();
    const ordered = bullet.length > 1;
    const list = { type: 'list', raw: '', ordered, start: ordered ? +bullet.slice(0, -1) : '', loose: false, items: [] };
    const markerRe = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
    const itemRe = listItemRe(markerRe);
    let isLoose = false;
    let srcLeft = src;
    for (; srcLeft;) {
      let emptyItem = false;
      let itemText = '';
      const itemMatch = itemRe.exec(srcLeft);
      if (!itemMatch || BLOCK.hr.test(srcLeft)) break;
      const consumedBefore = startSrc.length - srcLeft.length;
      srcLeft = srcLeft.substring(itemMatch[0].length);
      const markerLen = itemMatch[1].length;
      // First line after the marker (group 2 is one line plus a
      // trailing newline, if any).
      let firstLine = itemMatch[2];
      if (firstLine.charCodeAt(firstLine.length - 1) === 10) firstLine = firstLine.slice(0, -1);
      let content = expandLeadingTabs(firstLine, markerLen);
      const nl0 = srcLeft.indexOf('\n');
      const nextLine = nl0 === -1 ? srcLeft : srcLeft.slice(0, nl0);
      let isEmpty = isBlankLine(content);
      if (isEmpty && RE.blankLine.test(nextLine)) {
        srcLeft = srcLeft.substring(nextLine.length + 1);
        emptyItem = true;
      }
      if (!emptyItem) {
        let ind;
        const parts = [];
        if (isEmpty) { ind = markerLen + 1; parts.push(content.trimStart()); }
        else {
          ind = firstNonSpaceIdx(content);
          ind = ind > 4 ? 1 : ind;
          parts.push(content.slice(ind));
          ind += markerLen;
        }
        const nb = nextBulletRe(ind), hr2 = hrRe(ind), fe2 = fencesBeginRe(ind),
          he2 = headingBeginRe(ind), ht2 = htmlBeginRe(ind), bq2 = blockquoteBeginRe(ind);
        let pos = 0;
        for (; pos < srcLeft.length;) {
          const lineEnd = srcLeft.indexOf('\n', pos);
          const line = lineEnd === -1 ? srcLeft.slice(pos) : srcLeft.slice(pos, lineEnd);
          // First non-space character of the raw line (the break-test
          // gate): tabs count as indentation here, as the regexes do.
          let i = 0;
          while (i < line.length) {
            const c = line.charCodeAt(i);
            if (c !== 32 && c !== 9) break;
            i++;
          }
          const fc = line.charCodeAt(i);
          const mayBreak = fc === 96 || fc === 126 || fc === 35 || fc === 60 || fc === 62 ||
            fc === 42 || fc === 43 || fc === 45 || fc === 95 || (fc >= 48 && fc <= 57);
          const expanded = expandLeadingTabs(line, 0);
          if (mayBreak && (fe2.test(line) || he2.test(line) || ht2.test(line) || bq2.test(line) || nb.test(line) || hr2.test(line))) break;
          const ni = firstNonSpaceIdx(expanded);
          if (ni >= ind || isBlankLine(line)) {
            parts.push(expanded.slice(ind));
          } else {
            if (isEmpty || (content.includes('\t') ? content.replace(RE.tabCharGlobal, '    ') : content).search(RE.nonSpaceChar) >= 4 ||
                fe2.test(content) || he2.test(content) || ht2.test(content) || hr2.test(content)) break;
            const maybeSetext = !/^ {0,3}(?:=+|-+) *$/.test(line) ? line :
              (BLOCK.lheadingPlain.test(content + '\n' + line) ? '    ' + expanded.replace(/^ {0,3}/, '') : line);
            parts.push(maybeSetext);
          }
          isEmpty = isBlankLine(line);
          pos = lineEnd === -1 ? srcLeft.length : lineEnd + 1;
          content = expanded.slice(ind);
        }
        itemText = parts.join('\n');
        srcLeft = srcLeft.substring(pos);
      }
      const rawEnd = startSrc.length - srcLeft.length;
      const raw = startSrc.slice(consumedBefore, rawEnd);
      if (!list.loose) {
        if (isLoose) list.loose = true;
        else if (endsWithDoubleBlankLine(raw)) isLoose = true;
      }
      list.items.push({
        type: 'list_item', raw, task: RE.listIsTask.test(itemText), loose: false, text: itemText, tokens: [],
      });
    }
    const lastItem = list.items[list.items.length - 1];
    if (!lastItem) return null;
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
    list.raw = startSrc.slice(0, startSrc.length - srcLeft.length).trimEnd();
    for (const item of list.items) {
      this.state.top = false;
      item.tokens = this.blockTokens(item.text, []);
      if (!list.loose) {
        const spaces = item.tokens.filter((t) => t.type === 'space');
        if (spaces.length > 0 && spaces.some((t) => RE.anyLine.test(t.raw))) list.loose = true;
      }
    }
    for (const item of list.items) {
      const first = item.tokens[0];
      if (item.task && (first && (first.type === 'text' || first.type === 'paragraph'))) {
        item.text = item.text.replace(RE.listReplaceTask, '');
        first.raw = first.raw.replace(RE.listReplaceTask, '');
        first.text = first.text.replace(RE.listReplaceTask, '');
        for (let q = this.inlineQueue.length - 1; q >= 0; q--) {
          if (RE.listIsTask.test(this.inlineQueue[q].src)) {
            this.inlineQueue[q].src = this.inlineQueue[q].src.replace(RE.listReplaceTask, '');
            break;
          }
        }
        const cb = RE.listTaskCheckbox.exec(item.raw);
        if (cb) {
          const check = { type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
          item.checked = check.checked;
          if (list.loose) {
            if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0]) {
              item.tokens[0].raw = check.raw + item.tokens[0].raw;
              item.tokens[0].text = check.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(check);
            } else item.tokens.unshift({ type: 'paragraph', raw: check.raw, text: check.raw, tokens: [check] });
          } else item.tokens.unshift(check);
        }
        // The first token's text changed (task marker removed, and in a
        // loose list a checkbox was prepended into it): refresh its plain
        // HTML, clearing it when the new text needs the full inline pass.
        const head0 = item.tokens[0];
        if (head0 && head0.plain !== undefined) {
          const p = fastInlineHtml(head0.text);
          if (p !== null) head0.plain = p;
          else {
            head0.plain = undefined;
            for (const q of this.inlineQueue) {
              if (q.tokens === head0.tokens) { q.fast = false; break; }
            }
          }
        }
      } else if (item.task) item.task = false;
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
      }
    }
    return list;
  }

  tokHtml(src) {
    const m = BLOCK.html.exec(src);
    if (!m) return null;
    const raw = trimTrailingBlanks(m[0]);
    return { type: 'html', block: true, raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text: raw };
  }

  tokDef(src) {
    const m = BLOCK.def.exec(src);
    if (!m) return null;
    if (!RE.startAngleBracket.test(m[2]) && findUnbalanced(m[2], '()') !== -1) return null;
    const tag = normaliseLabel(m[1]);
    const href = m[2] ? m[2].replace(RE.hrefBrackets, '$1').replace(INLINE.anyPunctuation, '$1') : '';
    const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(INLINE.anyPunctuation, '$1') : m[3];
    return { type: 'def', tag, raw: stripTrailing(m[0], '\n'), href, title };
  }

  tokTable(src) {
    // A table's delimiter row is the second line. A valid one holds
    // only spaces, pipes, colons and dashes, starts with at most three
    // spaces, and has at least one dash; anything else cannot match the
    // table rule, so the regex never runs.
    const nl = src.indexOf('\n');
    if (nl === -1) return null;
    const nl2 = src.indexOf('\n', nl + 1);
    const line2 = src.slice(nl + 1, nl2 === -1 ? src.length : nl2);
    let i = 0;
    while (i < line2.length && line2.charCodeAt(i) === 32) i++;
    if (i > 3) return null;
    let hasDash = false;
    for (; i < line2.length; i++) {
      const c = line2.charCodeAt(i);
      if (c === 45) hasDash = true;
      else if (c !== 32 && c !== 124 && c !== 58) return null;
    }
    if (!hasDash) return null;
    const m = BLOCK.table.exec(src);
    if (!m || !RE.tableDelimiter.test(m[2])) return null;
    const headerCells = splitTableRow(m[1]);
    const alignsRaw = m[2].replace(RE.tableAlignChars, '').split('|');
    const bodyLines = m[3] && m[3].trim() ? m[3].replace(RE.tableRowBlankLine, '').split('\n') : [];
    const table = { type: 'table', raw: stripTrailing(m[0], '\n'), header: [], align: [], rows: [] };
    if (headerCells.length !== alignsRaw.length) return null;
    for (const cell of alignsRaw) {
      if (RE.tableAlignRight.test(cell)) table.align.push('right');
      else if (RE.tableAlignCenter.test(cell)) table.align.push('center');
      else if (RE.tableAlignLeft.test(cell)) table.align.push('left');
      else table.align.push(null);
    }
    for (let i = 0; i < headerCells.length; i++) {
      const plain = fastInlineHtml(headerCells[i]) ?? undefined;
      table.header.push({ text: headerCells[i], tokens: this.inline(headerCells[i], [], plain), header: true, align: table.align[i], plain });
    }
    for (const line of bodyLines) {
      table.rows.push(splitTableRow(line, table.header.length).map((cell, j) => {
        const plain = fastInlineHtml(cell) ?? undefined;
        return { text: cell, tokens: this.inline(cell, [], plain), header: false, align: table.align[j], plain };
      }));
    }
    return table;
  }

  tokLheading(src) {
    // A setext underline lives on a later line starting with = or -.
    // Scan for one (stopping at the first blank line, which a setext
    // heading cannot span); without a candidate, the rule cannot match.
    let idx = src.indexOf('\n');
    let found = false;
    while (idx !== -1) {
      let j = idx + 1;
      let spaces = 0;
      while (src.charCodeAt(j) === 32 && spaces < 3) { j++; spaces++; }
      const c = src.charCodeAt(j);
      if (c === 61 || c === 45) { found = true; break; }
      if (c === 10 || j >= src.length) break;
      idx = src.indexOf('\n', idx + 1);
    }
    if (!found) return null;
    const m = BLOCK.lheadingGfm.exec(src);
    if (!m) return null;
    const text = m[1].trim();
    const plain = fastInlineHtml(text) ?? undefined;
    return { type: 'heading', raw: stripTrailing(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text, tokens: this.inline(text, [], plain), plain };
  }

  tokParagraph(src) {
    // A single line with no newline is the whole paragraph: the
    // paragraph pattern matches every character of it, so the regex
    // run is redundant.
    if (!src.includes('\n')) {
      const plain = fastInlineHtml(src) ?? undefined;
      return { type: 'paragraph', raw: src, text: src, tokens: this.inline(src, [], plain), plain };
    }
    const m = BLOCK.paragraphGfm.exec(src);
    if (!m) return null;
    const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
    const plain = fastInlineHtml(text) ?? undefined;
    return { type: 'paragraph', raw: m[0], text, tokens: this.inline(text, [], plain), plain };
  }

  tokText(src) {
    const m = BLOCK.text.exec(src);
    if (!m) return null;
    const plain = fastInlineHtml(m[0]) ?? undefined;
    return { type: 'text', raw: m[0], text: m[0], tokens: this.inline(m[0], [], plain), plain };
  }
}

// ---------------------------------------------------------- inline lexer
// Inline tokenisation runs over one block's text at a time. Before the
// scan, code spans, links and HTML are *masked* (replaced by same-length
// filler) so a `*` inside a code span cannot act as an emphasis closer;
// the mask is computed once per inlineTokens() call and kept on a stack
// so nested calls (emphasis content re-tokenised) see their own mask.

function scanDelimiters(src) {
  // Last index in `src` that could close an emphasis / strikethrough run:
  // the start of a run of *, _ or ~ whose preceding character is not
  // whitespace (marked's `fe`).
  const lastEm = { '*': -1, '_': -1 };
  let lastDel = -1;
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < n && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastDel = i;
      else lastEm[ch] = i;
    }
    i = j - 1;
  }
  return { maskedSrc: src, lastEm, lastDel };
}

function maskForEmphasis(lexer, src) {
  // Nothing to hide when the source holds no code span, link, HTML tag
  // or backslash escape: the delimiters it shows are all real.
  if (!src.includes('`') && !src.includes('<') && !src.includes('[') && !src.includes('\\')) return src;
  // Hide reference links whose label resolves, so `[a *b*][ref]` does not
  // let the emphasis scanner see the `*`s inside the brackets. Only
  // when a definition exists can a label resolve, so without one this
  // pass is a no-op.
  let out = src;
  if (lexer.hasLinks && src.includes('[')) {
    const replaceRef = (match) => {
      const open = match.lastIndexOf('[');
      if (!Object.hasOwn(lexer.tokens.links, normaliseLabel(match.slice(open + 1, -1)))) return match;
      if (open > 1 && match.charAt(0) !== '!') {
        const inner = match.slice(1, open - 1);
        if (lexer.linkInText(inner)) {
          return '[' + inner.replace(INLINE.reflinkSearch, replaceRef) + '][' + 'a'.repeat(match.length - open - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match.length - 2) + ']';
    };
    out = out.replace(INLINE.reflinkSearch, replaceRef);
  }
  // Hide backslash escapes and code spans from the punctuation scan
  // (only when the source actually holds one).
  if (out.includes('\\') || out.includes('`')) {
    out = out.replace(INLINE.anyPunctuationOutsideCode, (match, ticks, punct) => {
      if (punct) return '+'.repeat(match.length);
      if (ticks) return ticks + match.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks;
      return match;
    });
  }
  // Hide links, code spans and HTML tags (only when one could be there).
  if (out.includes('`') || out.includes('<') || out.includes('[')) {
    out = out.replace(INLINE.blockSkip, (match, aGrp, bGrp) => {
      const keep = bGrp ? bGrp.length : 0;
      return match.slice(0, keep) + '[' + 'a'.repeat(match.length - keep - 2) + ']';
    });
  }
  return out;
}

// Additional Lexer methods (inline side). Defined here to keep the block
// and inline code in separate, readable sections.
Object.assign(Lexer.prototype, {
  linkInText(src) {
    if (!src.includes('[')) return false;
    for (const m of src.matchAll(INLINE.blockSkip)) {
      if (INLINE.link.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
    }
    for (const m of src.matchAll(INLINE.reflinkSearch)) {
      const s = m[0];
      const open = s.lastIndexOf('[');
      if (!(s.charAt(0) === '!' || !Object.hasOwn(this.tokens.links, normaliseLabel(s.slice(open + 1, -1)))) &&
          !(open > 1 && this.linkInText(s.slice(1, open - 1)))) return true;
    }
    return false;
  },

  inlineTokens(src, tokens = []) {
    const savedParen = this.state.linkParenPossible;
    this.state.linkParenPossible = savedParen && src.includes(')');
    try {
      return this.inlineScan(src, tokens);
    } finally {
      this.state.linkParenPossible = savedParen;
    }
  },

  inlineScan(src, tokens) {
    const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
    const masked = needsMask ? maskForEmphasis(this, src) : src;
    this.maskStack.push(scanDelimiters(masked));
    try {
      return this.inlineLoop(src, masked, tokens);
    } finally {
      this.maskStack.pop();
    }
  },

  lastEmIndex(maskedSrc, ch) {
    const top = this.maskStack[this.maskStack.length - 1];
    if (top && top.maskedSrc === maskedSrc) return top.lastEm[ch];
    return scanDelimiters(maskedSrc).lastEm[ch];
  },

  lastDelIndex(maskedSrc) {
    const top = this.maskStack[this.maskStack.length - 1];
    if (top && top.maskedSrc === maskedSrc) return top.lastDel;
    return scanDelimiters(maskedSrc).lastDel;
  },

  inlineLoop(src, masked, tokens) {
    let prevChar = '';
    let mergedText = false;
    let guard = Infinity;
    for (; src;) {
      if (src.length < guard) guard = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      if (!mergedText) prevChar = '';
      mergedText = false;
      // Dispatch on the first character: marked tries the tokenisers in
      // a fixed order, but each of them can only match when the source
      // starts with its own character, so trying the others is wasted
      // work. The order inside each branch is marked's order.
      const c0 = src.charCodeAt(0);
      let tok = null;
      if (c0 === 92) { // backslash: escape, then a backslash hard break
        tok = this.tokEscape(src) || this.tokBr(src);
      } else if (c0 === 60) { // <: tag, then autolink
        tok = this.tokTag(src) || this.tokAutolink(src);
      } else if (c0 === 91 || (c0 === 33 && src.charCodeAt(1) === 91)) { // [ or ![
        tok = this.tokLink(src) || this.tokReflink(src);
      } else if (c0 === 42 || c0 === 95) { // * _: emphasis
        tok = this.tokEmStrong(src, masked, prevChar);
      } else if (c0 === 96) { // `: code span
        tok = this.tokCodespan(src);
      } else if (c0 === 126) { // ~: strikethrough
        tok = this.tokDel(src, masked, prevChar);
      } else if (c0 === 32) { // space: a two-space hard break
        tok = this.tokBr(src);
      } else if (!this.state.inLink) {
        tok = this.tokUrl(src);
      }
      if (!tok) tok = this.tokInlineText(src);
      if (!tok) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      src = src.substring(tok.raw.length);
      if (tok.type === 'text') {
        if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
        mergedText = true;
        const last = tokens[tokens.length - 1];
        if (last && last.type === 'text') { last.raw += tok.raw; last.text += tok.text; }
        else tokens.push(tok);
      } else {
        tokens.push(tok);
      }
    }
    return tokens;
  },

  tokEscape(src) {
    const m = INLINE.escape.exec(src);
    if (m) return { type: 'escape', raw: m[0], text: m[1] };
    return null;
  },

  tokTag(src) {
    const m = INLINE.tag.exec(src);
    if (!m) return null;
    if (!this.state.inLink && RE.startATag.test(m[0])) this.state.inLink = true;
    else if (this.state.inLink && RE.endATag.test(m[0])) this.state.inLink = false;
    if (!this.state.inRawBlock && RE.startPreScriptTag.test(m[0])) this.state.inRawBlock = true;
    else if (this.state.inRawBlock && RE.endPreScriptTag.test(m[0])) this.state.inRawBlock = false;
    return { type: 'html', raw: m[0], inLink: this.state.inLink, inRawBlock: this.state.inRawBlock, block: false, text: m[0] };
  },

  tokLink(src) {
    if (this.state.linkParenPossible === false) return null;
    const m = INLINE.link.exec(src);
    if (!m) return null;
    const bang = m[0].charAt(0) === '!' ? 2 : 1;
    if (hasHtmlBeforeLinkEnd(src, m[1], bang)) return null;
    let href = m[2].trim();
    if (RE.startAngleBracket.test(href)) {
      if (!RE.endAngleBracket.test(href)) return null;
      const unesc = stripTrailing(href.slice(0, -1), '\\');
      if ((href.length - unesc.length) % 2 === 0) return null;
    } else {
      const unbal = findUnbalanced(m[2], '()');
      if (unbal === -2) return null;
      if (unbal > -1) {
        const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + unbal;
        m[2] = m[2].substring(0, unbal);
        m[0] = m[0].substring(0, cut).trim();
        m[3] = '';
      }
    }
    const tail = stripTrailing(m[0].slice(0, -1), '\\');
    if ((m[0].length - tail.length) % 2 === 0) return null;
    let dest = m[2].trim();
    let title = '';
    title = m[3] ? m[3].slice(1, -1) : '';
    dest = dest.trim();
    if (RE.startAngleBracket.test(dest)) dest = dest.slice(1, -1);
    return makeLink(this, m, {
      href: dest && dest.replace(INLINE.anyPunctuation, '$1'),
      title: title && title.replace(INLINE.anyPunctuation, '$1'),
    }, m[0]);
  },

  tokReflink(src) {
    let m = INLINE.reflink.exec(src) || INLINE.nolink.exec(src);
    if (!m) return null;
    const bang = m[0].charAt(0) === '!' ? 2 : 1;
    if (hasHtmlBeforeLinkEnd(src, m[1], bang)) return null;
    const ref = this.tokens.links[normaliseLabel(m[2] || m[1])];
    if (!ref) {
      const ch = m[0].charAt(0);
      return { type: 'text', raw: ch, text: ch };
    }
    return makeLink(this, m, ref, m[0]);
  },

  tokEmStrong(src, masked, prevChar) {
    const m = INLINE.emStrongLDelim.exec(src);
    if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
    const delim = m[0][0];
    const isSame = prevChar === delim;
    const fullLen = masked.length;
    const at = fullLen - src.length;
    let left = at;
    while (left > 0 && masked[left - 1] === delim) left--;
    const beforeRun = [...masked.slice(Math.max(0, left - 2), left)].at(-1) ?? '';
    const beforeIsPunct = beforeRun === '*' || beforeRun === '_' || INLINE.punctuation.test(beforeRun);
    if (left < at) prevChar = beforeRun;
    const prevIsPunct = left < at ? beforeIsPunct : !!INLINE.punctuation.exec(prevChar);
    if (m[4] && prevChar.match(RE.unicodeAlphaNumeric)) return null;
    const openerPunct = m[1] || m[3] || '';
    if (!openerPunct || !prevChar || prevIsPunct) {
      const runLen = [...m[0]].length - 1;
      let openCount = runLen;
      let used = 0;
      let extra = 0;
      const y = at - left + runLen;
      const canOpenMid = !!beforeRun.trim() && (!!openerPunct || (delim === '*' && !beforeIsPunct));
      if (delim !== '*' && delim !== '_') return null;
      const closerRe = delim === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
      const lastPossible = this.lastEmIndex(masked, delim);
      const limit = fullLen - src.length + runLen;
      if (lastPossible < limit) return null;
      const rest = masked.slice(-src.length + runLen);
      const slack = lastPossible - limit;
      closerRe.lastIndex = 0;
      let cm;
      while ((cm = closerRe.exec(rest)) !== null && !(cm.index > slack)) {
        const g = cm[1] || cm[2] || cm[3] || cm[4] || cm[5] || cm[6];
        if (!g) continue;
        const glen = [...g].length;
        if (cm[3] || cm[4]) { openCount += glen; continue; }
        else if (cm[5] || cm[6] || canOpenMid) {
          if (isSame && (cm[5] || cm[6])) break;
          if (y % 3 && !((y + glen) % 3)) { extra += glen; continue; }
        }
        if (openCount - glen > 0) { openCount -= glen; continue; }
        openCount -= glen;
        const take = Math.min(glen, glen + openCount + extra);
        const firstLen = [...cm[0]][0].length;
        const raw = src.slice(0, runLen + cm.index + firstLen + take);
        if (Math.min(runLen, take) % 2) {
          const inner = raw.slice(1, -1);
          return { type: 'em', raw, text: inner, tokens: this.inlineTokens(inner) };
        }
        const inner = raw.slice(2, -2);
        return { type: 'strong', raw, text: inner, tokens: this.inlineTokens(inner) };
      }
    }
    return null;
  },

  tokCodespan(src) {
    const m = INLINE.code.exec(src);
    if (!m) return null;
    let text = m[2].replace(RE.newLineCharGlobal, ' ');
    const hasNonSpace = RE.nonSpaceChar.test(text);
    const wrapped = RE.startingSpaceChar.test(text) && RE.endingSpaceChar.test(text);
    if (hasNonSpace && wrapped) text = text.substring(1, text.length - 1);
    return { type: 'codespan', raw: m[0], text };
  },

  tokBr(src) {
    const m = INLINE.br.exec(src);
    if (m) return { type: 'br', raw: m[0] };
    return null;
  },

  tokDel(src, masked, prevChar) {
    const m = INLINE.delLDelim.exec(src);
    if (!m) return null;
    if (m[1] && prevChar && !INLINE.punctuation.exec(prevChar)) return null;
    const runLen = [...m[0]].length - 1;
    let openCount = runLen;
    const closerRe = INLINE.delRDelim;
    const lastPossible = this.lastDelIndex(masked);
    const limit = masked.length - src.length + runLen;
    if (lastPossible < limit) return null;
    const rest = masked.slice(-src.length + runLen);
    const slack = lastPossible - limit;
    closerRe.lastIndex = 0;
    let cm;
    while ((cm = closerRe.exec(rest)) !== null && !(cm.index > slack)) {
      const g = cm[1] || cm[2] || cm[3] || cm[4] || cm[5] || cm[6];
      if (!g) continue;
      const glen = [...g].length;
      if (glen !== runLen) continue;
      if (cm[3] || cm[4]) { openCount += glen; continue; }
      openCount -= glen;
      if (openCount > 0) continue;
      const take = Math.min(glen, glen + openCount);
      const firstLen = [...cm[0]][0].length;
      const raw = src.slice(0, runLen + cm.index + firstLen + take);
      const inner = raw.slice(runLen, -runLen);
      return { type: 'del', raw, text: inner, tokens: this.inlineTokens(inner) };
    }
    return null;
  },

  tokAutolink(src) {
    const m = INLINE.autolink.exec(src);
    if (!m) return null;
    let text, href;
    if (m[2] === '@') { text = m[1]; href = 'mailto:' + text; }
    else { text = m[1]; href = text; }
    return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  },

  tokUrl(src) {
    const m = INLINE.url.exec(src);
    if (!m) return null;
    let text, href;
    if (m[2] === '@') { text = m[0]; href = 'mailto:' + text; }
    else {
      let raw = m[0];
      let prev;
      do { prev = raw; raw = INLINE.backpedal.exec(raw)?.[0] ?? ''; } while (prev !== raw);
      text = raw;
      href = m[1] === 'www.' ? 'http://' + raw : raw;
      m[0] = raw;
    }
    return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  },

  tokInlineText(src) {
    // Fast path: a run with no inline-starter character at all. It is
    // valid as-is unless it hides a URL, an email, a www. autolink or a
    // hard break, in which case the full pattern below decides.
    const simple = /^[^\\<!\[`*_~]+/.exec(src);
    if (simple) {
      const run = simple[0];
      if (!run.includes('www.') && !run.includes('://') && !run.includes('@') && !run.includes('  \n')) {
        const inRaw = this.state.inRawBlock;
        return { type: 'text', raw: run, text: inRaw ? run : decodeEntities(run), escaped: inRaw };
      }
    }
    const m = INLINE.text.exec(src);
    if (!m) return null;
    const inRaw = this.state.inRawBlock;
    return { type: 'text', raw: m[0], text: inRaw ? m[0] : decodeEntities(m[0]), escaped: inRaw };
  },
});

// A link is not a link when an HTML tag or autolink opens before the
// closing `]` of its text (marked's `Be` guard): e.g. `[a <b>c](d)` is
// plain text, not a link.
function hasHtmlBeforeLinkEnd(src, labelText, bangOffset) {
  if (!labelText.includes('<')) return false;
  for (let i = 0; i < labelText.length; i++) {
    if (labelText[i] === '\\') { i++; continue; }
    if (labelText[i] === '`') {
      const code = INLINE.code.exec(labelText.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (labelText[i] !== '<') continue;
    const rest = src.slice(bangOffset + i);
    const tag = INLINE.tag.exec(rest) || INLINE.autolink.exec(rest);
    if (tag) {
      if (tag[0].length > labelText.length - i) return true;
      i += tag[0].length - 1;
    }
  }
  return false;
}

// Build a link / image token from a matched `[text](href "title")` or
// `[text][ref]`, tokenising the link text inline. When the text itself
// already emitted a link (nested links are not allowed), the outer match
// is dropped.
function makeLink(lexer, match, ref, raw) {
  const text = match[1].replace(RE.outputLinkReplace, '$1');
  const isImage = match[0].charAt(0) === '!';
  const savedInLink = lexer.state.inLink;
  const savedEmitted = lexer.state.linkEmitted;
  const savedRaw = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const tokens = lexer.inlineTokens(text);
  const emitted = lexer.state.linkEmitted;
  lexer.state.linkEmitted = savedEmitted;
  lexer.state.inLink = savedInLink;
  if (!isImage) {
    if (emitted) { lexer.state.inRawBlock = savedRaw; return null; }
    lexer.state.linkEmitted = true;
  }
  return {
    type: isImage ? 'image' : 'link',
    raw,
    href: ref.href,
    title: ref.title || null,
    text,
    tokens,
  };
}

// -------------------------------------------------------------- rendering
// Rendering walks the token trees and appends HTML fragments to one array
// per parse() call, joined at the end. A second, plain-text renderer is
// used for image alt text (and link text inside images), where markup is
// stripped instead of rendered.

function renderTokens(tokens) {
  let out = '';
  for (const tok of tokens) out += renderToken(tok);
  return out;
}

function renderInline(tokens) {
  let out = '';
  for (const tok of tokens) out += renderInlineToken(tok);
  return out;
}

function renderToken(tok) {
  switch (tok.type) {
    case 'space': return '';
    case 'hr': return '<hr>\n';
    case 'heading': return tok.plain !== undefined ? `<h${tok.depth}>${tok.plain}</h${tok.depth}>\n` : `<h${tok.depth}>${renderInline(tok.tokens)}</h${tok.depth}>\n`;
    case 'code': {
      const first = (tok.lang || '').match(RE.notSpaceStart)?.[0];
      let text = tok.text ? tok.text.replace(RE.endingNewline, '') + '\n' : '';
      text = escapeHtml(text, true);
      return first
        ? `<pre><code class="language-${escapeHtml(first)}">${text}</code></pre>\n`
        : `<pre><code>${text}</code></pre>\n`;
    }
    case 'table': {
      let head = '';
      for (const cell of tok.header) head += renderCell(cell);
      let body = '';
      for (const row of tok.rows) {
        let cells = '';
        for (const cell of row) cells += renderCell(cell);
        body += `<tr>\n${cells}</tr>\n`;
      }
      if (body) body = `<tbody>${body}</tbody>`;
      return `<table>\n<thead>\n<tr>\n${head}</tr>\n</thead>\n${body}</table>\n`;
    }
    case 'blockquote': return `<blockquote>\n${renderTokens(tok.tokens)}</blockquote>\n`;
    case 'list': {
      let items = '';
      for (const item of tok.items) items += renderListItem(item);
      const tag = tok.ordered ? 'ol' : 'ul';
      const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
      return `<${tag}${start}>\n${items}</${tag}>\n`;
    }
    case 'html': return tok.text;
    case 'checkbox': return `<input ${tok.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
    case 'def': return '';
    case 'paragraph': return tok.plain !== undefined ? `<p>${tok.plain}</p>\n` : `<p>${renderInline(tok.tokens)}</p>\n`;
    case 'text': return tok.plain !== undefined ? tok.plain : renderInline(tok.tokens);
    default: throw new Error(`Token with "${tok.type}" type was not found.`);
  }
}

function renderListItem(item) {
  return `<li>${renderTokens(item.tokens)}</li>\n`;
}

function renderCell(cell) {
  const tag = cell.header ? 'th' : 'td';
  const align = cell.align ? ` align="${cell.align}"` : '';
  const inner = cell.plain !== undefined ? cell.plain : renderInline(cell.tokens);
  return `<${tag}${align}>${inner}</${tag}>\n`;
}

function renderInlineToken(tok) {
  switch (tok.type) {
    case 'escape': return escapeHtml(tok.text);
    case 'html': return tok.text;
    case 'link': {
      const inner = tok.autolink ? escapeHtml(tok.text, true) : renderInline(tok.tokens);
      const href = encodeHref(tok.href);
      if (href === null) return inner;
      let out = `<a href="${escapeHtml(href, tok.autolink)}"`;
      if (tok.title) out += ` title="${escapeHtml(tok.title)}"`;
      return out + `>${inner}</a>`;
    }
    case 'image': {
      const alt = tok.tokens ? renderText(tok.tokens) : '';
      const href = encodeHref(tok.href);
      if (href === null) return escapeHtml(alt);
      let out = `<img src="${escapeHtml(href)}" alt="${escapeHtml(alt)}"`;
      if (tok.title) out += ` title="${escapeHtml(tok.title)}"`;
      return out + '>';
    }
    case 'checkbox': return `<input ${tok.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
    case 'strong': return `<strong>${renderInline(tok.tokens)}</strong>`;
    case 'em': return `<em>${renderInline(tok.tokens)}</em>`;
    case 'codespan': return `<code>${escapeHtml(tok.text, true)}</code>`;
    case 'br': return '<br>';
    case 'del': return `<del>${renderInline(tok.tokens)}</del>`;
    case 'text': return tok.tokens ? renderInline(tok.tokens) : ('escaped' in tok && tok.escaped ? tok.text : escapeHtml(tok.text));
    default: throw new Error(`Token with "${tok.type}" type was not found.`);
  }
}

// Plain-text rendering: used for image alt text, where nested markup is
// flattened (links become their text, code spans become their text, ...).
function renderText(tokens) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'strong': case 'em': case 'del': case 'link': case 'image':
        out += tok.tokens ? renderText(tok.tokens) : tok.text; break;
      case 'codespan': out += tok.text; break;
      case 'html': out += tok.text; break;
      case 'text': out += tok.text; break;
      case 'br': break;
      case 'checkbox': out += tok.raw; break;
      default: out += tok.text ?? ''; break;
    }
  }
  return out;
}

// ------------------------------------------------------------ public entry
// parse() is stateless: a fresh Lexer (fresh links, queue, masks, state)
// is built for every call and discarded when it returns.
export function parse(markdown) {
  if (typeof markdown !== 'string') {
    throw new Error('marked(): input parameter is of type ' + Object.prototype.toString.call(markdown) + ', string expected');
  }
  const lexer = new Lexer();
  const tokens = lexer.lex(markdown);
  return renderTokens(tokens);
}

// --- Link title fix: the title (quoted or parenthesised) is capture
// group 3, so tokLink can slice its quotes off. The earlier definition
// left it non-capturing, which dropped every title.
INLINE.link = new RegExp('^!?\\[(' + LABEL_IN.source + ')\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)');

// --- GFM inline text: the plain-text run must stop before a `~` (so
// strikethrough is seen), before www./protocol URLs and before email
// addresses (so extended autolinks are seen), and before a backtick.
// The earlier definition was the non-GFM text pattern, which swallowed
// all of those as plain text.
INLINE.text = /^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/;

// --- Plain-text fast path -------------------------------------------
// Most paragraph / heading / table-cell text contains no inline markup
// at all. When it contains none of the characters that can start an
// inline construct, and no hard break, email or extended autolink, its
// HTML is just its escaped self: no tokenisation, no masking, no
// emphasis scan. Returns the escaped HTML, or null when the text needs
// the full inline pass.
function fastInlineHtml(text) {
  if (!text) return '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // \ ` * _ ~ [ < & and backslash can all start inline constructs or
    // entities; a hard break needs "  \n" (backslash is caught above).
    if (c === 92 || c === 96 || c === 42 || c === 95 || c === 126 || c === 91 || c === 60 || c === 38) return null;
    if (c === 32 && text.charCodeAt(i + 1) === 32 && text.charCodeAt(i + 2) === 10) return null;
  }
  if (text.includes('www.') || text.includes('://') || text.includes('@')) return null;
  return escapeHtml(text);
}
