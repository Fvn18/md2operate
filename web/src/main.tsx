import React from 'react';
import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import './styles.css';
import { StudioProvider } from './lib/store';
import { installBenchHooks } from './lib/diagnostics';
import App from './App';

// 让 scripts/bench.mjs 能在真实页面里复现性能数字（无业务逻辑，见 lib/diagnostics.ts）
installBenchHooks();

/**
 * 顶层错误边界：任何组件抛错都在此兜底显示，而不是留下一个白屏。
 * 对一个本地工作台来说，"看得见的报错 + 一键重载" 比"安静地坏掉"重要得多。
 */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 同时打到控制台，方便用 DevTools 追栈
    console.error('[MDP Studio] 界面异常', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 32, fontFamily: 'var(--font-ui)', color: 'var(--fg)' }}>
        <h2 style={{ margin: '0 0 8px' }}>界面出现异常</h2>
        <p style={{ color: 'var(--fg-dim)', fontSize: 13 }}>
          文档内容已自动保存在浏览器本地，不会丢失。可以把下面的信息反馈出来。
        </p>
        <pre style={{
          background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8,
          padding: 12, fontSize: 12, overflow: 'auto', maxHeight: 260, whiteSpace: 'pre-wrap',
        }}>{String(this.state.error?.stack || this.state.error)}</pre>
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ padding: '6px 12px', borderRadius: 7, border: '1px solid var(--border-strong)', background: 'var(--bg-2)', color: 'var(--fg)', cursor: 'pointer' }}
          >重试渲染</button>
          <button
            onClick={() => window.location.reload()}
            style={{ padding: '6px 12px', borderRadius: 7, border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff', cursor: 'pointer' }}
          >重新加载</button>
        </div>
      </div>
    );
  }
}

const el = document.getElementById('root');
if (!el) throw new Error('缺少 #root 容器');

createRoot(el).render(
  <React.StrictMode>
    <ErrorBoundary>
      <StudioProvider>
        <App />
      </StudioProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
