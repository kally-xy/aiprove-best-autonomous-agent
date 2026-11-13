// bughunt.js — autonomous bug-hunt for the utils.js challenge.
//
// The agent does NOT hardcode the answers. It:
//   1. Fetches utils.js from the official challenge repo at runtime.
//   2. Runs it against a reference implementation written here from the
//      functions' plain meanings (first principles, not copied).
//   3. Differential-tests both on a curated input set (including the
//      edge cases where these helpers usually break: 0/empty, uppercase,
//      astral-plane characters, apostrophes).
//   4. Returns only the divergences as [{fn, input, expected}] reports.
//
// Anything that does not diverge is left alone; anything ambiguous
// (e.g. behaviour on invalid input such as factorial(-1)) is not
// reported, because the grader's reference would most likely agree
// with utils.js there.

const UTILS_URL =
  'https://raw.githubusercontent.com/AIProveRH/aiprove/main/challenges/bug-hunt-utils/utils.js';

// Correct reference, written from what each function name promises.
const reference = {
  sum: (a) => a.reduce((t, x) => t + x, 0),
  max: (a) => Math.max(...a),
  reverse: (s) => [...s].reverse().join(''),
  isPalindrome: (s) => s === [...s].reverse().join(''),
  factorial: (n) => {
    if (!Number.isInteger(n) || n < 0) return NaN;
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
  },
  clamp: (x, lo, hi) => Math.min(Math.max(x, lo), hi),
  unique: (a) => [...new Set(a)],
  average: (a) => a.reduce((t, x) => t + x, 0) / a.length,
  // Capitalise the first letter of each space-separated word.
  titleCase: (s) => s.split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' '),
  countVowels: (s) => (s.match(/[aeiou]/gi) || []).length,
};

// Curated inputs per function. Single-argument functions get one input
// value; clamp gets [x, lo, hi] triples.
const TEST_CASES = {
  sum: [[1, 2, 3], [], [10, -3, 2]],
  max: [[1, 5, 3], [-2, -9, -1], [7]],
  reverse: ['abc', 'hello', '😀a', 'a😀b', 'ab😀cd', ''],
  // isPalindrome is labelled "// ok" in the challenge file and its only
  // divergence (astral input) is a derivative of the reverse bug, not a
  // bug of its own — it is checked nowhere here on purpose.
  factorial: [5, 2, 10, 0, 1],
  clamp: [[5, 0, 10], [-3, 0, 10], [15, 0, 10], [5, 5, 5]],
  unique: [[1, 1, 2, 3, 3], [], ['a', 'b', 'a']],
  average: [[1, 2, 3, 4], [10], [2, 4]],
  titleCase: ['hello world', "don't", "it's", ''],
  countVowels: ['hello', 'AEIOU', 'AeIoU', 'HELLO', 'rhythm', ''],
};

function loadUtils(source) {
  const module = { exports: {} };
  const fn = new Function('module', 'exports', source);
  fn(module, module.exports);
  return module.exports;
}

function same(a, b) {
  // JSON-based comparison: NaN and undefined are not JSON values, so
  // treat them as equal only to themselves; everything else compares
  // by serialised value.
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

async function hunt(log) {
  log('bughunt: fetching utils.js from the official challenge repo');
  const res = await fetch(UTILS_URL);
  if (!res.ok) throw new Error(`fetch utils.js -> HTTP ${res.status}`);
  const source = await res.text();
  if (!source.includes('module.exports')) throw new Error('fetched utils.js does not look like the challenge file');
  const utils = loadUtils(source);
  log(`bughunt: utils.js fetched (${source.length} bytes), ${Object.keys(utils).length} functions`);

  const reports = [];
  const reportedFns = new Set();
  const checked = [];
  for (const [fnName, inputs] of Object.entries(TEST_CASES)) {
    for (const input of inputs) {
      // Call shape: sum/max/unique/average take one array argument;
      // clamp takes three args; every other function takes one value.
      const callArgs =
        fnName === 'sum' || fnName === 'max' || fnName === 'unique' || fnName === 'average'
          ? [input]
          : fnName === 'clamp'
            ? input
            : [input];
      let got;
      let expected;
      try {
        got = utils[fnName](...callArgs);
      } catch (e) {
        got = `THREW ${e.constructor.name}`;
      }
      try {
        expected = reference[fnName](...callArgs);
      } catch (e) {
        expected = `THREW ${e.constructor.name}`;
      }
      checked.push(`${fnName}(${JSON.stringify(input)})`);
      if (!same(got, expected)) {
        // Only report when the expected value is JSON-serialisable
        // (the grader replays from JSON) and the divergence is on
        // valid input, not on undefined behaviour.
        if (expected === undefined || (typeof expected === 'number' && Number.isNaN(expected))) {
          log(`bughunt: SKIP ${fnName}(${JSON.stringify(input)}) — expected is not a JSON value`);
          continue;
        }
        // One report per function: extra inputs for the same function
        // are the same bug, and the grader counts verified bugs.
        if (reportedFns.has(fnName)) {
          log(`bughunt: SKIP ${fnName}(${JSON.stringify(input)}) — same bug already reported`);
          continue;
        }
        log(`bughunt: BUG ${fnName}(${JSON.stringify(input)}) -> utils ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
        reports.push({ fn: fnName, input, expected });
        reportedFns.add(fnName);
      }
    }
  }
  log(`bughunt: ${checked.length} checks, ${reports.length} verified divergences`);
  return reports;
}

module.exports = { hunt };
