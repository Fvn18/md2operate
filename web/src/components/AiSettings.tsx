/**
 * web/src/components/AiSettings.tsx — AI 设置。
 *
 * 安全提示写进了界面本身：密钥只保存到**本机后台的配置文件**（权限 0600），
 * 浏览器拿不到明文（`/api/config` 只返回 apiKeySet）。若走环境变量
 * `GEMINI_API_KEY`，密钥连配置文件都不落盘——界面上会明确标出当前来源。
 *
 * 模型列表来自 gemini-api-dev skill 的「Current Models」，不是记忆：
 *   gemini-3.8-flash（默认）/ gemini-3.5-flash-lite（最快最省）/
 *   gemini-3.1-pro-preview（复杂推理）/ gemini-3.1-flash-lite
 * 注意 temperature / top_p / top_k 在现行 Interactions API 里**已删除**，
 * 思考强度用 thinking_level。
 */

import React, { useEffect, useState } from 'react';
import { aiApi } from '../lib/ai';
import type { AiStatus, PublicConfig } from '../lib/types';
import { Icon } from './Icons';
import { Modal } from './Toasts';

const MODELS = [
  { id: 'gemini-3.8-flash', label: 'gemini-3.8-flash', desc: '默认：1M 上下文，多模态与 agent 任务均衡' },
  { id: 'gemini-3.5-flash-lite', label: 'gemini-3.5-flash-lite', desc: '最快最省，适合高频补全' },
  { id: 'gemini-3.1-pro-preview', label: 'gemini-3.1-pro-preview', desc: '复杂推理与公式推导' },
  { id: 'gemini-3.1-flash-lite', label: 'gemini-3.1-flash-lite', desc: '轻量高吞吐' },
];

const TASKS: Array<{ key: keyof AiStatus['tasks']; label: string; hint: string }> = [
  { key: 'complete', label: '智能补全', hint: '在光标处续写 Markdown / LaTeX（流式）' },
  { key: 'formula', label: '文本转公式', hint: '把选中的描述转成 LaTeX（流式）' },
  { key: 'image', label: '截图转公式', hint: '粘贴截图 → 可编辑 LaTeX（结构化输出）' },
  { key: 'polish', label: '润色', hint: '优化表达、修错别字，保留公式与结构（流式）' },
  { key: 'fix', label: '公式纠错', hint: '渲染失败的公式 → 修正版，一键替换（结构化输出）' },
];

interface Props {
  status: AiStatus | null;
  onClose: () => void;
  onSaved: (next: AiStatus) => void;
  onToast: (kind: 'ok' | 'err' | 'warn' | 'info', title: string, msg?: string) => void;
}

export function AiSettings({ status, onClose, onSaved, onToast }: Props) {
  const [cfg, setCfg] = useState<PublicConfig | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    aiApi.config().then(setCfg).catch(() => setCfg(null));
  }, []);

  const save = async (patch: Record<string, unknown>) => {
    setSaving(true);
    try {
      const next = await aiApi.saveConfig(patch);
      setCfg(next);
      const st = await aiApi.status();
      onSaved(st);
    } catch (err) {
      onToast('err', '保存失败', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const ai = cfg?.ai;

  return (
    <Modal title="AI 设置（Gemini）" onClose={onClose} width={680}>
      <div className="row" style={{ gap: 8, marginBottom: 14 }}>
        <span className={`chip ${status?.ready ? 'ok' : status?.enabled ? 'warn' : ''}`}>
          {status?.ready ? '已就绪' : status?.enabled ? '待配置密钥' : '未启用'}
        </span>
        {status?.mock && <span className="chip warn">mock 模式（不调用真实 API）</span>}
        {status?.keySource && (
          <span className="chip" title="环境变量优先；env 表示密钥不落盘">
            密钥来源：{status.keySource === 'env' ? '环境变量 GEMINI_API_KEY' : '配置文件'}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <label className="switch">
          <input
            type="checkbox"
            checked={Boolean(ai?.enabled)}
            disabled={saving}
            onChange={(e) => save({ ai: { enabled: e.target.checked } })}
          />
          <span className="switch-track" />
          <span className="switch-label">启用 AI</span>
        </label>
      </div>

      <div className="field">
        <span className="field-label">
          API 密钥
          <span className="val">{ai?.apiKeySet ? '已设置（浏览器看不到明文）' : '未设置'}</span>
        </span>
        <div className="row">
          <input
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={ai?.apiKeySet ? '••••••••••••（输入新值可覆盖）' : '粘贴 Gemini API key'}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
          />
          <button
            className="btn"
            disabled={saving || !keyInput.trim()}
            onClick={async () => { await save({ ai: { apiKey: keyInput.trim() } }); setKeyInput(''); onToast('ok', '密钥已保存到本机后台'); }}
          >保存</button>
          <button
            className="btn btn-danger"
            disabled={saving || !ai?.apiKeySet || status?.keySource === 'env'}
            title={status?.keySource === 'env' ? '当前来自环境变量，请修改环境变量' : '清除配置文件里的密钥'}
            onClick={async () => { await save({ ai: { apiKey: '' } }); onToast('ok', '已清除配置中的密钥'); }}
          >清除</button>
        </div>
        <span className="field-hint">
          密钥只写入本机后台的配置文件（<span className="mono">{cfg?.path || '…'}</span>，权限 0600），
          浏览器与前端产物中**不含密钥**。更推荐用环境变量：
          <code>export GEMINI_API_KEY=…</code> 后重启 <code>mdp serve</code>（这样连配置文件都不落盘）。
        </span>
      </div>

      <div className="grid-2">
        <label className="field">
          <span className="field-label">模型</span>
          <select
            className="select"
            value={ai?.model || 'gemini-3.8-flash'}
            disabled={saving}
            onChange={(e) => save({ ai: { model: e.target.value } })}
          >
            {MODELS.map((m) => <option key={m.id} value={m.id}>{m.label} — {m.desc}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">思考强度<span className="val">thinking_level</span></span>
          <select
            className="select"
            value={ai?.thinkingLevel || 'low'}
            disabled={saving}
            onChange={(e) => save({ ai: { thinkingLevel: e.target.value } })}
          >
            {['minimal', 'low', 'medium', 'high'].map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <span className="field-hint">越低越快。补全类任务用 minimal/low 即可。</span>
        </label>
      </div>

      <div className="side-section-title" style={{ marginTop: 6 }}>
        <Icon name="sliders" size={11} /> 能力开关（可逐项关闭，互不影响纯写作模式）
      </div>
      <div className="col" style={{ gap: 2 }}>
        {TASKS.map((t) => (
          <label className="switch" key={t.key} title={t.hint}>
            <input
              type="checkbox"
              checked={ai?.tasks?.[t.key] !== false}
              disabled={saving}
              onChange={(e) => save({ ai: { tasks: { [t.key]: e.target.checked } } })}
            />
            <span className="switch-track" />
            <span className="switch-label">{t.label}</span>
            <span className="field-hint" style={{ marginLeft: 6 }}>{t.hint}</span>
          </label>
        ))}
      </div>

      <div className="side-section-title" style={{ marginTop: 14 }}>
        <Icon name="info" size={11} /> 说明
      </div>
      <div className="empty-note" style={{ paddingTop: 0 }}>
        后台调用的是现行的 <b>Interactions API</b>（<span className="mono">POST /v1beta/interactions</span>）。
        注意 <span className="mono">temperature / top_p / top_k</span> 在该 API 中已删除，
        思考强度由 <span className="mono">thinking_level</span> 控制；
        <span className="mono">gemini-2.5-* / 1.5-*</span> 已废弃。
        <br />
        没有密钥时可用 <span className="mono">mock</span> 模式把整条链路（流式 → 结果卡片 → 一键替换）跑通：
        <span className="mono">MDP_AI_MOCK=1 mdp serve</span>。
      </div>
    </Modal>
  );
}

export default AiSettings;
