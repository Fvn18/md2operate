/**
 * web/src/components/CommandBar.tsx — 命令行操作条。
 *
 * 这是"图形界面不掩盖底层"的具体体现：接受 md2pdf 风格的参数，实时显示将要
 * 执行的等价命令。熟悉 CLI 的人可以完全不碰表单。
 */

import React, { useRef, useState } from 'react';
import { COMMAND_HINTS } from '../lib/commandbar';
import { Icon } from './Icons';

interface Props {
  open: boolean;
  onToggle: (open: boolean) => void;
  onSubmit: (input: string) => void;
  lastMessage?: string;
  commands: Array<{ target: string; engine: string; command: string }>;
}

export function CommandBar({ open, onToggle, onSubmit, lastMessage, commands }: Props) {
  const [value, setValue] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [hIndex, setHIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = (text: string) => {
    const v = text.trim();
    if (!v) return;
    setHistory((h) => [v, ...h].slice(0, 60));
    setHIndex(-1);
    onSubmit(v);
    setValue('');
  };

  if (!open) {
    return (
      <button
        className="btn btn-ghost btn-sm"
        style={{ position: 'absolute', right: 12, bottom: 10, zIndex: 20, background: 'var(--bg-2)', border: '1px solid var(--border-strong)' }}
        onClick={() => { onToggle(true); setTimeout(() => inputRef.current?.focus(), 30); }}
        title="命令栏 (⌘K)"
      >
        <Icon name="terminal" size={12} /> 命令栏
      </button>
    );
  }

  return (
    <div style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-1)' }}>
      <div className="commandbar" style={{ borderBottom: 0 }}>
        <span className="caret">$</span>
        <input
          ref={inputRef}
          autoFocus
          placeholder="md2pdf 风格参数，例如： -q cn --toc --dpi 400 -t png,pdf    或   :render / :theme ink"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(value); }
            else if (e.key === 'Escape') { onToggle(false); }
            else if (e.key === 'ArrowUp' && history.length) {
              e.preventDefault();
              const next = Math.min(history.length - 1, hIndex + 1);
              setHIndex(next);
              setValue(history[next]);
            } else if (e.key === 'ArrowDown' && history.length) {
              e.preventDefault();
              const next = Math.max(-1, hIndex - 1);
              setHIndex(next);
              setValue(next < 0 ? '' : history[next]);
            }
          }}
        />
        <button className="btn btn-sm btn-primary" onClick={() => submit(value)}>执行</button>
        <button className="btn btn-sm btn-ghost" onClick={() => onToggle(false)} title="关闭 (Esc)">
          <Icon name="x" size={12} />
        </button>
      </div>
      <div style={{ padding: '0 12px 8px' }}>
        <div className="command-hints">
          {COMMAND_HINTS.map((h) => (
            <button key={h} className="command-hint" onClick={() => setValue(h)} title="点击填入">{h}</button>
          ))}
        </div>
        {lastMessage && (
          <div className="mono" style={{ fontSize: 11, color: 'var(--fg-mute)', marginTop: 6 }}>
            {lastMessage}
          </div>
        )}
        {commands.length > 0 && (
          <details style={{ marginTop: 6 }}>
            <summary style={{ fontSize: 11, color: 'var(--fg-mute)', cursor: 'pointer' }}>
              等价的底层命令（{commands.length}）
            </summary>
            <pre className="cmd-box" style={{ marginTop: 6 }}>{commands.map((c) => `# ${c.target} · ${c.engine}\n${c.command}`).join('\n\n')}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

export default CommandBar;
