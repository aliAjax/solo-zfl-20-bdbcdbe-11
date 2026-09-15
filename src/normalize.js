/**
 * 查询/档案文本归一化与分词。
 *
 * 归一化（normalize）依次处理：
 *   1. NFKC：全角/半角统一（ＴＰ→TP、０１４→014、（）→()、－→-）
 *   2. 繁→简（src/t2s 单字表）
 *   3. 小写（ASCII A-Z → a-z）
 *   4. 去除所有空白与 CJK 标点/连字符等分隔符号差异
 *
 * 因此查询忽略：全半角、大小写、繁简、空格（含全角空格、Tab、分隔符）差异。
 */
const { t2s } = require("./t2s");

// 归一化时直接删除的字符：各类空白、CJK 标点、ASCII 标点/连字符。
const DROP_CHARS =
  /[\s   -   　\p{P}\p{S}]/gu;

function normalize(input) {
  if (input === undefined || input === null) return "";
  return t2s(String(input).normalize("NFKC"))
    .toLowerCase()
    .replace(DROP_CHARS, "");
}

const CJK = /[一-鿿㐀-䶿]/;
const LATIN = /[a-z0-9]/;

/**
 * 把归一化后的字符串切成检索 gram：
 *   - 连续拉丁/数字串整体作为一个 token（tp清014 中的 tp、014）
 *   - CJK 段生成 bigram（中文按两字滑窗），单字 CJK 退化为 unigram
 *
 * bigram 能让「虫蛀」「蛀孔」这类词通过共享字窗命中，
 * 单字输入时仍可用 unigram 兜底（buildCjkGrams 同时产出 unigram）。
 */
function tokenize(normalized) {
  const tokens = [];
  const push = (t) => {
    if (t) tokens.push(t);
  };
  const cjkBuf = [];
  let latinBuf = "";

  const flushLatin = () => {
    if (latinBuf) {
      push(latinBuf);
      latinBuf = "";
    }
  };
  const flushCjk = () => {
    if (cjkBuf.length) {
      for (const g of cjkGrams(cjkBuf)) push(g);
      cjkBuf.length = 0;
    }
  };

  for (const ch of normalized) {
    if (LATIN.test(ch)) {
      flushCjk();
      latinBuf += ch;
    } else if (CJK.test(ch)) {
      flushLatin();
      cjkBuf.push(ch);
    } else {
      flushLatin();
      flushCjk();
    }
  }
  flushLatin();
  flushCjk();
  return [...new Set(tokens)];
}

/**
 * CJK gram 集合：bigram 为主，同时保留 unigram。
 * 对长度 1：[字]；长度 2：[两字, 字1, 字2]；更长再加全部 bigram。
 */
function cjkGrams(chars) {
  const grams = [];
  if (chars.length === 1) {
    grams.push(chars[0]);
    return grams;
  }
  for (let i = 0; i < chars.length - 1; i++) {
    grams.push(chars[i] + chars[i + 1]);
  }
  for (const ch of chars) grams.push(ch);
  return grams;
}

/**
 * 标准 Levenshtein 编辑距离（迭代两行）。
 */
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let row = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, row] = [row, prev];
  }
  return prev[b.length];
}

/**
 * 短串（查询）在长串（字段值）中做「错一个字」滑窗匹配。
 * 窗口长度围绕查询长度 ±1，任一窗口编辑距离 <= maxDistance 即命中。
 *
 * @returns {{matched:boolean, distance:number, window:string}} distance 取最优窗口
 */
function fuzzyContains(needle, haystack, maxDistance = 1) {
  if (!needle) return { matched: false, distance: Infinity, window: "" };
  if (haystack.includes(needle)) {
    return { matched: true, distance: 0, window: needle };
  }
  if (needle.length < 2) {
    // 单字查询不允许「错一个字」，否则任意单字都会命中，失去检索意义。
    return { matched: false, distance: Infinity, window: "" };
  }
  let best = { matched: false, distance: Infinity, window: "" };
  // 窗口长度围绕查询长度 ±1；窗口至少 2 字符，避免短窗退化为单字符泛匹配。
  const minLen = Math.max(2, needle.length - 1);
  for (let len = minLen; len <= needle.length + 1; len++) {
    if (len > haystack.length) continue;
    for (let start = 0; start + len <= haystack.length; start++) {
      const window = haystack.slice(start, start + len);
      const d = editDistance(needle, window);
      if (d <= maxDistance && d < best.distance) {
        best = { matched: true, distance: d, window };
      }
    }
  }
  return best;
}

/**
 * 把归一化串拆成语义分段：
 *   latin: 连续拉丁/数字 token（tp、014）
 *   cjk:   连续汉字段（保留整段，供生成 bigram/unigram）
 * 查询时每个分段应同时出现（分段间 AND），分段内各 gram 取并集（容错 OR）。
 */
function segments(normalized) {
  const latin = [];
  const cjk = [];
  let latinBuf = "";
  let cjkBuf = "";
  const flushLatin = () => {
    if (latinBuf) {
      latin.push(latinBuf);
      latinBuf = "";
    }
  };
  const flushCjk = () => {
    if (cjkBuf) {
      cjk.push(cjkBuf);
      cjkBuf = "";
    }
  };
  for (const ch of normalized) {
    if (LATIN.test(ch)) {
      flushCjk();
      latinBuf += ch;
    } else if (CJK.test(ch)) {
      flushLatin();
      cjkBuf += ch;
    } else {
      flushLatin();
      flushCjk();
    }
  }
  flushLatin();
  flushCjk();
  return { latin, cjk };
}

module.exports = { normalize, tokenize, segments, editDistance, fuzzyContains, cjkGrams };
