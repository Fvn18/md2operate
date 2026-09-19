/** web/src/components/Toasts.tsx + ShortcutsModal — 通知与小尺寸弹窗。 */

import React, { useEffect } from 'react';
import type { Toast } from '../lib/store';
import { Icon } from './Icons';

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => onDismiss(t.id)} role="status">
          <span style={{ color: `var(--${t.kind === 'ok' ? 'ok' : t.kind === 'err' ? 'err' : t.kind === 'warn' ? 'warn' : 'info'})`, paddingTop: 1 }}>
            <Icon name={t.kind === 'ok' ? 'check' : t.kind === 'err' ? 'x' : 'info'} size={14} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="toast-title">{t.title}</div>
            {t.msg && <div className="toast-msg">{t.msg}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, width = 640 }: {
  title: string; onClose: () => void; children: React.ReactNode; width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: width }}>
        <div className="modal-head">
          <span>{title}</span>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><Icon name="x" size={13} /></button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

const MOD_LABEL = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl';

const SHORTCUTS: Array<[string, string]> = [
  [`${MOD_LABEL} ↵`, '渲染并导出当前文档'],
  [`${MOD_LABEL} S`, '保存到浏览器本地（自动保存已开启）'],
  [`${MOD_LABEL} J`, '命令栏（md2pdf 风格参数）'],
  [`${MOD_LABEL} ⇧ B`, '显示 / 隐藏侧栏'],
  [`${MOD_LABEL} ⇧ E`, '显示 / 隐藏导出面板'],
  [`${MOD_LABEL} ⇧ C`, '显示 / 隐藏控制台'],
  [`${MOD_LABEL} ⇧ N`, '新建文档'],
  [`${MOD_LABEL} ⇧ F`, '在编辑器中查找'],
  [`${MOD_LABEL} /`, '显示本帮助'],
  ['', ''],
  [`${MOD_LABEL} B`, '加粗'],
  [`${MOD_LABEL} I`, '斜体'],
  [`${MOD_LABEL} E`, '行内代码'],
  [`${MOD_LABEL} K`, '插入链接'],
  [`${MOD_LABEL} ⇧ M`, '插入行间公式 $$…$$'],
  [`${MOD_LABEL} ⇧ T`, '插入定理容器'],
  [`${MOD_LABEL} ⇧ P`, '插入证明容器'],
  [`${MOD_LABEL} ⇧ K`, '插入代码块'],
  ['', ''],
  ['Vim 模式', '在编辑器右下角切换；支持 :w 保存、/ 搜索、dd/ciw 等'],
  ['命令栏', '例如  -q cn --toc --dpi 400 -t png,pdf   或   :theme ink'],
];

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="键盘快捷键" onClose={onClose}>
      <div className="kbd-grid">
        {SHORTCUTS.map(([k, v], i) => (
          k === '' ? <div key={i} style={{ gridColumn: '1 / -1', height: 8 }} /> : (
            <React.Fragment key={i}>
              <kbd>{k}</kbd>
              <span style={{ color: 'var(--fg-dim)' }}>{v}</span>
            </React.Fragment>
          )
        ))}
      </div>
    </Modal>
  );
}
