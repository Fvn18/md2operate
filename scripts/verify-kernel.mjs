#!/usr/bin/env node
/**
 * scripts/verify-kernel.mjs — md2pdf shell 内核的「极端」自检套件。
 *
 * 这里不测"能不能出图"（那是 verify.mjs 的事），测的是**只有在极端条件下才会暴露**
 * 的内核行为。四组用例各自钉住一类真实发生过的故障：
 *
 *   1. 微秒级链路探针   每次调用的固定开销。缓存命中本该"零感"，却曾经因为无条件
 *                       解析 pandoc 而白付 31ms；渲染路径还曾经多付一次
 *                       `pandoc --version` 去问一个谁也没用的版本号。
 *   2. 并发调度压力     槽位有没有空转、临时目录有没有泄漏、并发上限守没守住。
 *   3. 疯狂打字机       -w 监听下高频保存：会不会攒一堆 xelatex 把内存打爆、退出时
 *                       有没有留下孤儿进程与 FIFO 临时目录。
 *   4. 环境剥夺         把 PATH 砍到只剩系统自带（gs/pdftoppm/fc-list 全没了）：
 *                       要能降级到 sips 并如实警告，中文要能回退到内置字体。
 *
 * 判据符号：
 *   ✔ 通过     ✖ 失败     ▲ 已记录但未达目标（不判失败，把差距钉在明面上）
 *
 * 阈值的来源：先测"地板"再定护栏。从 Node spawn 一个 `sh -c true` 本身就要 ~4ms，
 * 再加上 shell 启动（~8ms），所以"命令 → pandoc 拉起"不可能低于 ~12ms；
 * 目标行标的是理想值，达标与否都如实打印。
 *
 * 用法：node scripts/verify-kernel.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MD2PDF = path.join(ROOT, 'md2pdf');
const BARE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

let pass = 0, fail = 0, goalMiss = 0;
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const chk = (cond, label, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? ok('✔') : bad('✖')} ${label}${extra ? `  ${dim(extra)}` : ''}`);
};
const goal = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ${ok('✔')} ${label}${extra ? `  ${dim(extra)}` : ''}`); }
  else { goalMiss++; console.log(`  \x1b[33m▲\x1b[0m ${label}${extra ? `  ${dim(extra)}` : ''}`); }
};
const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const p50 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const tmpdir = (tag) => fsp.mkdtemp(path.join(os.tmpdir(), `md2pdf-kernel-${tag}-`));
const which = (c) => spawnSync('sh', ['-c', `command -v ${c}`], { encoding: 'utf8' }).stdout.trim();

/** 跑一次 md2pdf（子进程），返回墙钟毫秒与输出 */
function runMd2pdf(args, { cwd, env = {}, timeoutMs = 300000 } = {}) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn('sh', [MD2PDF, ...args], {
      cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => { clearTimeout(killer); resolve({ code, ms: Date.now() - t0, out }); });
  });
}

const countProcs = (name) => {
  const r = spawnSync('pgrep', ['-x', name], { encoding: 'utf8' });
  return (r.stdout || '').split('\n').filter(Boolean).length;
};

/**
 * 可显式停止的并发采样器。
 * 不写成"采样固定 N 毫秒再返回"：调用方没法预知被采样的那段工作要跑多久，
 * 用 Promise.race 去抢一个固定窗口几乎总会抢输（窗口比工作短），只能拿到空结果。
 */
function peakSampler(names, stepMs = 80) {
  const peak = Object.fromEntries(names.map((n) => [n, 0]));
  let stop = false;
  const done = (async () => {
    while (!stop) {
      for (const n of names) {
        const c = countProcs(n);
        if (c > peak[n]) peak[n] = c;
      }
      await sleep(stepMs);
    }
  })();
  return { peak, stop: async () => { stop = true; await done; return peak; } };
}

const countDirs = async (prefix) =>
  (await fsp.readdir(os.tmpdir())).filter((n) => n.startsWith(prefix)).length;

const SMALL_DOC = '# 标题\n\n一段正文，含公式 $x^2$ 与中文。\n';

/* ===================================================== 1. 微秒级链路探针 === */
head('[1] 微秒级链路探针（每次调用的固定开销）');

{
  const d = await tmpdir('probe');
  const stub = path.join(d, 'bin');
  await fsp.mkdir(stub, { recursive: true });
  await fsp.writeFile(path.join(d, 'doc.md'), SMALL_DOC);

  const realPandoc = which('pandoc');
  const log = path.join(d, 'pandoc.log');
  await fsp.writeFile(log, '');
  // 假 pandoc：先记下"被拉起"的时刻，再交给真的 pandoc。于是测到的是
  // 「shell 从启动到真正要渲染」的净开销，不含 pandoc 自己的启动时间。
  await fsp.writeFile(path.join(stub, 'pandoc'), `#!/bin/sh
perl -MTime::HiRes=time -e 'printf "%.6f\\n", time' >> ${JSON.stringify(log)}
exec ${JSON.stringify(realPandoc)} "$@"
`);
  await fsp.chmod(path.join(stub, 'pandoc'), 0o755);

  const env = { PATH: `${stub}:${process.env.PATH}`, SIG_CACHE_DIR: path.join(d, 'cache') };

  // 地板：什么都不做的 sh。用来解释上面那个数字里有多少根本不是"我们的开销"。
  const floor = [];
  for (let i = 0; i < 9; i++) {
    const t0 = Date.now();
    const c = spawn('sh', ['-c', 'true'], { stdio: 'ignore' });
    await once(c, 'close');
    floor.push(Date.now() - t0);
  }
  const floorMed = p50(floor);

  // ---- 1a. 启动 → 真正调用 pandoc ----
  const calls = [];
  const launch = [];
  for (let i = 0; i < 7; i++) {
    await fsp.writeFile(log, '');
    const before = Date.now();
    await runMd2pdf(['-f', '-o', path.join(d, `out${i}.pdf`), path.join(d, 'doc.md')], { cwd: d, env });
    const stamps = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(Number);
    calls.push(stamps.length);
    if (stamps.length) launch.push(stamps[stamps.length - 1] * 1000 - before);
  }
  const launchMed = launch.length ? Math.round(p50(launch)) : -1;

  chk(calls.every((c) => c >= 1), '假 pandoc 确实被拉起（探针本身有效）', `每次 ${calls[0]} 次`);
  chk(calls.every((c) => c === 1), '渲染路径上 pandoc 只被拉起**一次**（不做多余的版本探测）',
    `实际 ${calls.join('/')} 次`);
  goal(launchMed < 15, '命令 → pandoc 拉起 < 15ms（目标）', `p50=${launchMed}ms`);
  chk(launchMed < 100, '同一条链路没有退化（护栏 < 100ms）',
    `p50=${launchMed}ms（其中子进程地板 ${floorMed}ms + shell 启动）`);

  // ---- 1b. 缓存命中 ----
  await runMd2pdf(['-o', path.join(d, 'cached.pdf'), path.join(d, 'doc.md')], { cwd: d, env });
  const hits = [];
  for (let i = 0; i < 9; i++) {
    hits.push((await runMd2pdf(['-o', path.join(d, 'cached.pdf'), path.join(d, 'doc.md')], { cwd: d, env })).ms);
  }
  const hitMed = p50(hits);
  goal(hitMed < 20, '缓存命中端到端 < 20ms（目标）', `p50=${hitMed}ms`);
  chk(hitMed < 60, '缓存命中没有退化（护栏 < 60ms）', `p50=${hitMed}ms`);

  // ---- 1c. 缓存命中路径不得启动 pandoc ----
  await fsp.writeFile(log, '');
  await runMd2pdf(['-o', path.join(d, 'cached.pdf'), path.join(d, 'doc.md')], { cwd: d, env });
  const touched = fs.readFileSync(log, 'utf8').trim();
  chk(touched === '', '缓存命中时一次都不碰 pandoc', touched ? `实际 ${touched.split('\n').length} 次` : '零次');

  await fsp.rm(d, { recursive: true, force: true });
}

/* ==================================================== 2. 并发调度压力 === */
head('[2] 并发调度压力（并发上限 / 空转 / 泄漏）');

{
  const d = await tmpdir('conc');
  // 2 个慢文件 + 6 个快文件，慢的排前面 —— 批次屏障在这里最容易暴露：
  // 慢文件会拖着同批里已经跑完的槽位一起等。
  const big = ['# 大\n'];
  for (let k = 0; k < 120; k++) big.push(`段落 ${k}：设 $f$ 连续。\n\n$$\n\\int_0^1 x^{${k}}\\,dx\n$$\n`);
  const files = ['big1.md', 'big2.md'];
  await fsp.writeFile(path.join(d, 'big1.md'), big.join('\n'));
  await fsp.writeFile(path.join(d, 'big2.md'), big.join('\n'));
  for (let i = 1; i <= 6; i++) {
    await fsp.writeFile(path.join(d, `s${i}.md`), `# 小 ${i}\n\n一句话。\n`);
    files.push(`s${i}.md`);
  }

  const env = { SIG_CACHE_DIR: path.join(d, 'cache') };
  const jobs = 4;
  const clean = async () => {
    for (const f of files) await fsp.rm(path.join(d, f.replace(/\.md$/, '.pdf')), { force: true });
  };

  // ---- 2a. 串行基线 ----
  await clean();
  const t0 = Date.now();
  const rs = await runMd2pdf(['-f', '-j', '1', ...files], { cwd: d, env });
  const serial = (Date.now() - t0) / 1000;
  chk(rs.code === 0, '串行跑完 8 个文件', `${serial.toFixed(1)}s`);

  // ---- 2b. 并行 + 采样并发峰值 ----
  await clean();
  const sampler = peakSampler(['pandoc', 'xelatex']);
  const t1 = Date.now();
  const rp = await runMd2pdf(['-f', '-j', String(jobs), ...files], { cwd: d, env });
  const par = (Date.now() - t1) / 1000;
  const peak = await sampler.stop();

  const produced = files.filter((f) => fs.existsSync(path.join(d, f.replace(/\.md$/, '.pdf'))));
  chk(rp.code === 0 && produced.length === files.length, '并行全部产出且退出码 0',
    `${produced.length}/${files.length} · ${par.toFixed(1)}s`);
  chk(peak.pandoc <= jobs, `并发上限守住：同时运行的 pandoc ≤ ${jobs}`, `峰值 ${peak.pandoc}`);
  chk(par < serial, '并行确实比串行快（滑动窗口没有退化成串行）',
    `${par.toFixed(1)}s vs ${serial.toFixed(1)}s · 加速 ${(serial / par).toFixed(2)}×`);
  goal(serial / par >= jobs * 0.6, `加速比 ≥ ${(jobs * 0.6).toFixed(1)}×（目标，受 CPU 争用限制）`,
    `${(serial / par).toFixed(2)}×`);

  const leaks = await countDirs('md2pdf-jobs.');
  chk(leaks === 0, '没有留下 md2pdf-jobs 临时目录', `${leaks} 个`);

  await fsp.rm(d, { recursive: true, force: true });
}

/* ================================================== 3. 疯狂打字机热重载 === */
head('[3] 疯狂打字机热重载（kill-and-restart / 负载归零）');

{
  const d = await tmpdir('watch');
  const doc = path.join(d, 'doc.md');
  await fsp.writeFile(doc, '# 标题\n\n初始\n');
  const env = { SIG_CACHE_DIR: path.join(d, 'cache') };

  const fifoBefore = await countDirs('md2pdf-watch.');

  const watcher = spawn('sh', [MD2PDF, '-w', 'doc.md'], {
    cwd: d, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let wlog = '';
  watcher.stdout.on('data', (x) => { wlog += x; });
  watcher.stderr.on('data', (x) => { wlog += x; });

  const sampler = peakSampler(['xelatex', 'pandoc']);

  await sleep(2500);
  for (let i = 1; i <= 60; i++) {           // 每 50ms 写一次 —— 远超人类保存频率
    await fsp.writeFile(doc, `# 标题\n\n第 ${i} 次写入\n`);
    await sleep(50);
  }
  await fsp.writeFile(doc, '# 标题\n\n最终内容：最后一次写入。\n\n额外一段用于区分体积。\n');
  await sleep(6000);

  const peak = await sampler.stop();
  chk(peak.xelatex <= 2 && peak.pandoc <= 2, '高频保存期间编译进程不堆积（不会被拉起几十个）',
    `峰值 xelatex=${peak.xelatex} pandoc=${peak.pandoc}`);
  chk(/初次编译|检测到改动/.test(wlog), '监听循环确实触发了重编',
    `重编 ${(wlog.match(/检测到改动/g) || []).length} 次`);

  watcher.kill('SIGTERM');
  await Promise.race([once(watcher, 'close'), sleep(4000)]);
  if (watcher.exitCode === null) watcher.kill('SIGKILL');
  await sleep(1200);

  const after = spawnSync('sh', ['-c', 'pgrep -x xelatex | wc -l; pgrep -x pandoc | wc -l'], { encoding: 'utf8' })
    .stdout.trim().split('\n').map(Number);
  chk(after[0] === 0 && after[1] === 0, '停止 1 秒后负载归零', `xelatex=${after[0]} pandoc=${after[1]}`);

  const fifoAfter = await countDirs('md2pdf-watch.');
  chk(fifoAfter <= fifoBefore, '没有留下监听用的 FIFO 临时目录（按前后差值判定）',
    `${fifoBefore} → ${fifoAfter}`);

  // 最终产物必须与"同内容独立编译"完全一致。PDF 里内嵌 CreationDate，直接比字节
  // 会有 1 字节之差（元数据，不是内容），所以比光栅化结果 —— 逐像素。
  const ref = path.join(d, 'ref.pdf');
  await runMd2pdf(['-f', '-o', ref, doc], { cwd: d, env: { ...env, SIG_CACHE_DIR: path.join(d, 'cache2') } });
  const raster = (pdf) => {
    const out = pdf.replace(/\.pdf$/, '.png');
    spawnSync('gs', ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-sDEVICE=png16m', '-r100',
      '-dFirstPage=1', '-dLastPage=1', `-sOutputFile=${out}`, pdf], { stdio: 'ignore' });
    return fs.existsSync(out) ? fs.readFileSync(out) : null;
  };
  const a = raster(path.join(d, 'doc.pdf'));
  const b = raster(ref);
  chk(Boolean(a && b) && a.equals(b), '最终产物 == 同内容独立编译（像素级）',
    a && b ? `${a.length}B vs ${b.length}B` : '光栅化失败');

  await fsp.rm(d, { recursive: true, force: true });
}

/* ==================================================== 4. 极端环境剥夺 === */
head('[4] 极端环境剥夺（gs / pdftoppm / fc-list 全部不可用）');

{
  const d = await tmpdir('deprived');
  await fsp.writeFile(path.join(d, 'doc.md'),
    '# 中文标题\n\n公式 $\\alpha$ 与代码：\n\n```js\nconst a = 1;\n```\n');

  // 不能直接砍 PATH：pandoc 与 gs 同在 /opt/homebrew/bin，砍掉家目录等于把 pandoc
  // 也砍了，那测的就不是"降级"而是"没法跑"。做法是把真正需要的那两个二进制
  // 软链进一个私有 bin，PATH 只留它 + 系统目录 —— gs/pdftoppm/fc-list 因此不可达。
  const shim = path.join(d, 'shim');
  await fsp.mkdir(shim, { recursive: true });
  const linked = [];
  for (const t of ['pandoc', 'xelatex']) {
    const real = which(t);
    if (real) { await fsp.symlink(real, path.join(shim, t)); linked.push(t); }
  }
  const PATH_DEPRIVED = `${shim}:${BARE_PATH}`;
  const env = { PATH: PATH_DEPRIVED, SIG_CACHE_DIR: path.join(d, 'cache') };
  const has = (c) => spawnSync('sh', ['-c', `command -v ${c}`], { env: { ...process.env, ...env }, encoding: 'utf8' }).status === 0;

  chk(linked.length === 2, 'shim 里备好了 pandoc 与 xelatex', linked.join(' + '));
  chk(!has('gs') && !has('pdftoppm') && !has('pdftocairo') && !has('fc-list'),
    'gs / pdftoppm / pdftocairo / fc-list 全部不可达');

  // ---- 4a. 只剩 sips 时必须降级并如实警告 ----
  const png = await runMd2pdf(['-t', 'png', '--dpi', '200', '-f', '-o', path.join(d, 'a.png'), path.join(d, 'doc.md')],
    { cwd: d, env });
  chk(fs.existsSync(path.join(d, 'a.png')), 'PNG 仍然产出（降级而不是罢工）',
    `退出码 ${png.code}`);
  chk(/sips 降级渲染/.test(png.out), '如实报告降级与质量损失',
    (png.out.split('\n').find((l) => /sips/.test(l)) || '').trim().slice(0, 48));

  // ---- 4b. 没有 fc-list 时中文必须回退到内置字体 ----
  // 观察点用干跑输出的 pandoc 参数：含 CJK 的文档在**默认档位**下会带上
  // `-V CJKmainfont=<字体名>`。
  // 注意不能用 `-q cn`：那一档走 ctexart，USE_CJK_VAR=0，ctex 自己管中文字体，
  // 本来就不该出现 CJKmainfont —— 拿它当观察点会测出"未出现"而误判成失败。
  const dry = await runMd2pdf(['-n', path.join(d, 'doc.md')], { cwd: d, env });
  chk(/CJKmainfont=PingFang SC/.test(dry.out), '无 fc-list 时回退到 PingFang SC',
    (dry.out.match(/CJKmainfont=[^'"‘’]*/g) || ['(未出现)'])[0]);

  // ---- 4c. 真正排版一次，确认中文没乱码也没崩 ----
  const pdf = await runMd2pdf(['-f', '-o', path.join(d, 'b.pdf'), path.join(d, 'doc.md')], { cwd: d, env });
  chk(pdf.code === 0 && fs.existsSync(path.join(d, 'b.pdf')) && fs.statSync(path.join(d, 'b.pdf')).size > 5000,
    '极端环境下 PDF 仍然正常产出', `退出码 ${pdf.code} · ${fs.existsSync(path.join(d, 'b.pdf')) ? fs.statSync(path.join(d, 'b.pdf')).size + 'B' : '无文件'}`);

  await fsp.rm(d, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ 汇总 */
console.log('');
if (fail === 0) {
  console.log(`${ok(`全部通过：${pass} 通过 / 0 失败`)}${goalMiss ? `  （另 ${goalMiss} 项记录为未达目标，见 ▲）` : ''}`);
} else {
  console.log(`${bad(`${fail} 项失败`)} / ${pass + fail} 项`);
}
process.exit(fail === 0 ? 0 : 1);
