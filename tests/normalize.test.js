const test = require("node:test");
const assert = require("node:assert");
const { normalize, tokenize, fuzzyContains, editDistance, segments } = require("../src/normalize");

test("归一化：全角/半角统一", () => {
  assert.strictEqual(normalize("ＴＰ－清　０１４"), normalize("TP-清 014"));
  assert.strictEqual(normalize("（虫蛀）"), normalize("(虫蛀)"));
});

test("归一化：大小写统一", () => {
  assert.strictEqual(normalize("ABCxyz"), "abcxyz");
  assert.strictEqual(normalize("Tp-Q-01"), normalize("tp-q-01"));
});

test("归一化：繁简统一", () => {
  assert.strictEqual(normalize("蟲蛀孔與撕裂"), normalize("虫蛀孔与撕裂"));
  assert.strictEqual(normalize("舊紙張發黴"), normalize("旧纸张发霉"));
  assert.strictEqual(normalize("裝幀損傷"), normalize("装帧损伤"));
});

test("归一化：忽略各类空格与标点", () => {
  assert.strictEqual(normalize(" 虫  蛀　孔 "), "虫蛀孔");
  assert.strictEqual(normalize("TP\t清-014/①"), normalize("tp清014①"));
  assert.strictEqual(normalize("虫蛀孔、（撕裂）"), normalize("虫蛀孔撕裂"));
});

test("分词：拉丁 token 与 CJK bigram", () => {
  const toks = tokenize(normalize("TP-清-014"));
  assert.ok(toks.includes("tp"));
  assert.ok(toks.includes("014"));
  assert.ok(toks.includes("清"));
});

test("编辑距离", () => {
  assert.strictEqual(editDistance("虫蛀孔", "虫柱孔"), 1);
  assert.strictEqual(editDistance("abc", "abc"), 0);
  assert.strictEqual(editDistance("撕裂", "裂开"), 2);
});

test("fuzzyContains：错一个字命中，给出窗口", () => {
  assert.deepStrictEqual(fuzzyContains("虫蛀孔", "左上角虫柱孔处", 1).matched, true);
  assert.strictEqual(fuzzyContains("虫蛀孔", "左上角虫柱孔处", 1).distance, 1);
  assert.strictEqual(fuzzyContains("撕裂", "下边缘斯裂", 1).matched, true);
});

test("fuzzyContains：单字不做容错；错两个字不命中", () => {
  assert.strictEqual(fuzzyContains("虫", "柱", 1).matched, false);
  assert.strictEqual(fuzzyContains("虫蛀孔", "虫某某", 1).matched, false);
  assert.strictEqual(fuzzyContains("撕裂", "裂开", 1).matched, false);
});

test("segments：拉丁与汉字分段", () => {
  const s = segments(normalize("TP-清-014虫蛀"));
  assert.deepStrictEqual(s.latin.sort(), ["014", "tp"]);
  assert.ok(s.cjk.includes("清"));
  assert.ok(s.cjk.includes("虫蛀"));
});
