// PROTOTYPE — throwaway. Validates: is ocask abstention an EXTRACTION-side failure
// that a two-step (free-form review -> tolerant + cheap extract) recovers?
// Run: node .model-flow/t07/proto/two-step-proto.mjs   (live, ~$0.10)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseVerdict } from '../../../eval/parse.mjs';

const WT = process.cwd();
const OCASK = path.join(WT, 'ocask.mjs');
const MODEL = 'deepseek-v4-pro';

// DEEP validation: full 20-case corpus, control arm — two-step vs strict one-step,
// compared to the frozen control baseline (recall 0.60 / FP 0.10 / abstention 0.15).
const ALL_IDS = Array.from({ length: 20 }, (_, i) => `js-${String(i + 1).padStart(3, '0')}`);
const SAMPLE = ALL_IDS.map((id) => ({ id, arm: 'control' }));
const CONCURRENCY = 5;
const lensFlag = (arm) => (arm === 'lens' ? ['--lens', 'code-review'] : ['--lens', 'general']);

let tmpN = 0;
const tmp = (s) => { const p = path.join(os.tmpdir(), `proto-${tmpN++}.txt`); fs.writeFileSync(p, s); return p; };

function run(args) {
  return new Promise((res) => {
    const c = spawn('node', [OCASK, ...args], { cwd: WT });
    let out = '', err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) => res({ code, out, err }));
  });
}

// tolerant extraction from free-form prose: last explicit verdict word wins; else infer.
function tolerantExtract(prose) {
  const m = [...prose.matchAll(/\b(APPROVED|WARNING|BLOCKED)\b/gi)];
  if (m.length) return m[m.length - 1][1].toUpperCase();
  const t = prose.toLowerCase();
  if (/\b(bug|off-by-one|incorrect|error|vulnerab|breaks|regression|missing|wrong)\b/.test(t)
      && !/\bno (bug|issue|problem)s?\b/.test(t)) return 'BLOCKED';
  if (/\b(looks good|no issues|correct|safe|lgtm|approve)\b/.test(t)) return 'APPROVED';
  return null;
}

async function main() {
  const corpus = JSON.parse(fs.readFileSync(path.join(WT, 'eval/corpus/cases.json'), 'utf8'));
  const cases = Array.isArray(corpus) ? corpus : corpus.cases;
  const rows = [];
  let idx = 0;
  async function worker() {
    while (idx < SAMPLE.length) {
    const s = SAMPLE[idx++];
    const c = cases.find((x) => (x.id || x.case_id) === s.id);
    const diff = tmp(c.diff), spec = tmp(c.spec || '');
    const base = ['--model', MODEL, '--task', diff, '--context', spec, ...lensFlag(s.arm),
      '--temperature', '0', '--timeout-ms', '900000'];

    // 1) STRICT one-step (reproduce abstention)
    const strict = await run([...base, '--require-verdict', '--json']);
    const strictV = parseVerdict(strict.out).verdict;

    // 2) FREE-FORM prose review (unconstrained FORMAT, but review INTENT re-asserted
    //    via --system to prevent task-drift where the model "applies" the diff).
    const reviewSys = tmp('You are a senior code reviewer. You are given a DIFF that is UNDER REVIEW '
      + '(a proposed change). Your ONLY job is to critique it for defects — bugs, off-by-one errors, '
      + 'inverted conditions, dropped guards, regressions, security issues, broken logic. Do NOT apply, '
      + 'rewrite, accept, or restate the change as already done. If the diff INTRODUCES a defect, say so '
      + 'clearly and explain the bug and where it is. If the diff is genuinely safe, say it looks correct. '
      + 'Assume the diff may be intentionally buggy.');
    const free = await run([...base, '--system', reviewSys]);
    const prose = (() => { try { return JSON.parse(free.out).output || free.out; } catch { return free.out; } })();
    const tolerantV = tolerantExtract(prose);

    // 3) cheap SECOND-PASS extraction: classify the review into one word
    const clsTask = tmp(`A senior engineer wrote this code review:\n\n${prose}\n\n`
      + `Based only on the review above, reply with exactly one word — APPROVED, WARNING, or BLOCKED.`);
    const cls = await run(['--model', MODEL, '--task', clsTask, '--temperature', '0', '--timeout-ms', '300000']);
    const clsOut = (() => { try { return JSON.parse(cls.out).output || cls.out; } catch { return cls.out; } })();
    const twoStepV = tolerantExtract(clsOut) || tolerantV;

    const caught = (v) => v === 'BLOCKED' || v === 'WARNING';
    const correct = (v) => c.ground_truth === 'buggy' ? caught(v) : v === 'APPROVED';
    rows.push({ id: s.id, arm: s.arm, gt: c.ground_truth, strictV, tolerantV, twoStepV,
      strict_ok: correct(strictV), twostep_ok: correct(twoStepV),
      recovered: strictV == null && correct(twoStepV) });

    const proseHead = prose.replace(/\s+/g, ' ').slice(0, 90);
    console.log(`\n[${s.id}/${s.arm}] gt=${c.ground_truth}`);
    console.log(`  strict:    ${strictV ?? 'ABSTAINED'}   ${correct(strictV) ? 'ok' : 'X'}`);
    console.log(`  free-form: "${proseHead}..."`);
    console.log(`  tolerant:  ${tolerantV ?? 'none'}   |  two-step: ${twoStepV ?? 'none'}   ${correct(twoStepV) ? 'ok' : 'X'}${strictV == null && correct(twoStepV) ? '  <-- RECOVERED' : ''}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const nBuggy = rows.filter((r) => r.gt === 'buggy').length;
  const nClean = rows.filter((r) => r.gt === 'clean').length;
  const strictCatch = rows.filter((r) => r.gt === 'buggy' && r.strict_ok).length;
  const twoCatch = rows.filter((r) => r.gt === 'buggy' && r.twostep_ok).length;
  const strictFP = rows.filter((r) => r.gt === 'clean' && !r.strict_ok).length;
  const twoFP = rows.filter((r) => r.gt === 'clean' && !r.twostep_ok).length;
  const abst = rows.filter((r) => r.strictV == null).length;
  const recovered = rows.filter((r) => r.recovered).length;
  console.log(`\n===== SUMMARY (${rows.length} case/arm pairs: ${nBuggy} buggy, ${nClean} clean) =====`);
  console.log(`strict abstentions: ${abst}  |  of those RECOVERED correctly by two-step: ${recovered}`);
  console.log(`buggy recall:  strict ${strictCatch}/${nBuggy}  ->  two-step ${twoCatch}/${nBuggy}`);
  console.log(`clean FP:      strict ${strictFP}/${nClean}  ->  two-step ${twoFP}/${nClean}`);
  fs.writeFileSync(path.join(WT, '.model-flow/t07/proto/proto-result.json'), JSON.stringify(rows, null, 1));
}
main();
