/** web/src/components/ConsolePanel.tsx — 实时日志控制台（pandoc / XeLaTeX 原始输出）。 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStudio } from '../lib/store';
import { Icon } from './Icons';
import type { Job, LogEntry } from '../lib/types';

interface Props {
  logs: LogEntry[];
  job: Job | null;
  onClear: () => void;
  onCancel: () => void;
  onRetry: () => void;
}

const LEVEL_LABEL: Record<string, string> = {
  info: 'INFO', ok: ' OK ', warn: 'WARN', err: 'ERR ', cmd: ' CMD', out: 'OUT ', debug: 'DBG ',
};

/** 去掉 ANSI 转义（md2pdf 带色输出在网页里应显示为纯文本或按级别着色）。 */
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function fmtEta(ms?: number | null) {
  if (ms == null || !Number.isFinite(ms)) return '';
  if (ms < 1000) return '即将完成';
  if (ms < 60000) return `约 ${Math.ceil(ms / 1000)} 秒`;
  return `约 ${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒`;
}

export function ConsolePanel({ logs, job, onClear, onCancel, onRetry }: Props) {
  const { state, patchUi } = useStudio();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<'all' | 'info' | 'warn'>('all');
  const [wrap, setWrap] = useState(true);

  const visible = useMemo(() => {
    const list = filter === 'all' ? logs : logs.filter((l) => (filter === 'warn' ? l.level === 'warn' || l.level === 'err' : l.level !== 'out' && l.level !== 'debug'));
    return list.slice(-1500);
  }, [logs, filter]);

  useEffect(() => {
    if (!state.ui.autoScrollConsole) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, state.ui.autoScrollConsole]);

  const running = job?.status === 'running' || job?.status === 'queued';
  const counts = useMemo(() => ({
    err: logs.filter((l) => l.level === 'err').length,
    warn: logs.filter((l) => l.level === 'warn').length,
  }), [logs]);

  return (
    <div className="console" style={{ height: state.ui.showConsole ? state.ui.consoleHeight : 0, display: state.ui.showConsole ? 'flex' : 'none' }}>
      <div className="console-head">
        <Icon name="terminal" size={12} />
        <span>控制台</span>
        {running && <span className="dot busy" />}
        {job && (
          <span className="mono" style={{ fontSize: 10, textTransform: 'none', letterSpacing: 0 }}>
            {job.id.slice(0, 6)} · {job.status}
            {job.elapsedMs != null ? ` · ${(job.elapsedMs / 1000).toFixed(1)}s` : ''}
            {running && job.progressLabel ? ` · ${job.progressLabel}` : ''}
            {running && job.etaMs != null ? ` · 预计还需 ${fmtEta(job.etaMs)}` : ''}
            {job.queuePosition > 0 ? ` · 队列第 ${job.queuePosition} 位` : ''}
          </span>
        )}
        <span className="spacer" />
        {counts.err > 0 && <span className="chip err">{counts.err} 错误</span>}
        {counts.warn > 0 && <span className="chip warn">{counts.warn} 警告</span>}
        <select
          className="select"
          style={{ width: 96, height: 22, padding: '0 22px 0 6px', fontSize: 11 }}
          value={filter}
          onChange={(e) => setFilter(e.target.value as typeof filter)}
          title="日志过滤"
        >
          <option value="all">全部</option>
          <option value="info">要点</option>
          <option value="warn">警告</option>
        </select>
        <button className={`btn btn-ghost btn-sm ${state.ui.autoScrollConsole ? 'active' : ''}`} title="自动滚到底部"
          onClick={() => patchUi({ autoScrollConsole: !state.ui.autoScrollConsole })}>
          <Icon name="chevronDown" size={12} />
        </button>
        <button className={`btn btn-ghost btn-sm ${wrap ? 'active' : ''}`} title="自动折行" onClick={() => setWrap((w) => !w)}>
          <Icon name="list" size={12} />
        </button>
        <button className="btn btn-ghost btn-sm" title="复制全部日志"
          onClick={() => navigator.clipboard?.writeText(logs.map((l) => `${LEVEL_LABEL[l.level] || l.level} ${stripAnsi(l.msg)}`).join('\n'))}>
          <Icon name="copy" size={12} />
        </button>
        <button className="btn btn-ghost btn-sm" title="清空" onClick={onClear}>
          <Icon name="trash" size={12} />
        </button>
        {running && <button className="btn btn-sm btn-danger" onClick={onCancel}>取消</button>}
        {job?.status === 'error' && <button className="btn btn-sm" onClick={onRetry} title="用同样的参数再跑一次（Chromium 崩溃、LaTeX 偶发失败常能一次通过）">
          <Icon name="refresh" size={11} /> 重试
        </button>}
        <button className="btn btn-ghost btn-sm" title="收起控制台" onClick={() => patchUi({ showConsole: false })}>
          <Icon name="chevronDown" size={12} />
        </button>
      </div>
      {running && (
        <div className="progress-track" style={{ margin: '4px 12px 2px' }} title={`${Math.round((job?.progress || 0) * 100)}%`}>
          <div className="progress-fill" style={{ width: `${Math.round((job?.progress || 0) * 100)}%` }} />
        </div>
      )}
      <div className="console-body" ref={bodyRef}>
        {visible.length === 0 && (
          <div className="log-line log-debug">
            <span className="log-msg">
              控制台会把 pandoc / XeLaTeX 的原始输出按行显示在这里。按 ⌘↵ 开始一次渲染。
            </span>
          </div>
        )}
        {visible.map((l) => (
          <div className={`log-line log-${l.level}`} key={l.seq}>
            <span className="log-time">{new Date(l.t).toLocaleTimeString('zh-CN', { hour12: false })}</span>
            <span className="log-msg" style={wrap ? undefined : { whiteSpace: 'pre', overflowX: 'auto' }}>
              {stripAnsi(l.msg)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default ConsolePanel;
