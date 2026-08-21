// ============================================================================
// AprendizadosPanel — memória procedural da clínica: as regras que a IA aplica
// pra ESTA unidade (além da persona/fontes). O dono vê, adiciona, liga/desliga
// e apaga. Cada regra ativa entra no prompt da IA como <aprendizados>.
// ============================================================================

import { useEffect, useState, useCallback } from 'react';
import { Lightbulb, Plus, Trash2, Loader2, Sparkles } from 'lucide-react';
import clsx from 'clsx';
import { useUnit } from '../context/UnitContext';
import { api } from '../lib/api';
import type { LessonEntry } from '../types/api';

export function AprendizadosPanel() {
  const { selectedUnitId } = useUnit();
  const [lessons, setLessons] = useState<LessonEntry[] | null>(null);
  const [novo, setNovo] = useState('');
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [reflecting, setReflecting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!selectedUnitId) {
      setLessons([]);
      return;
    }
    try {
      setLessons(await api.getLessons(selectedUnitId));
    } catch {
      setLessons([]);
    }
  }, [selectedUnitId]);

  useEffect(() => {
    setLessons(null);
    void load();
  }, [load]);

  async function adicionar() {
    const content = novo.trim();
    if (!content || !selectedUnitId || saving) return;
    setSaving(true);
    try {
      await api.createLesson(selectedUnitId, content);
      setNovo('');
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function toggle(l: LessonEntry) {
    if (!selectedUnitId) return;
    setBusy(l.id);
    try {
      await api.updateLesson(selectedUnitId, l.id, { enabled: !l.enabled });
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function remover(l: LessonEntry) {
    if (!selectedUnitId) return;
    setBusy(l.id);
    try {
      await api.deleteLesson(selectedUnitId, l.id);
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function refletir() {
    if (!selectedUnitId || reflecting) return;
    setReflecting(true);
    setMsg(null);
    try {
      const r = await api.reflectLessons(selectedUnitId);
      setMsg(
        r.proposed > 0
          ? `✨ ${r.proposed} sugestã${r.proposed === 1 ? 'o nova' : 'oes novas'} — role e ligue as que fizerem sentido.`
          : r.analisadas < 3
            ? 'Ainda há poucas conversas pra analisar. Volte depois de mais atendimentos.'
            : 'Nenhum padrão novo desta vez — a IA já está bem afiada aqui 👏'
      );
      await load();
    } catch {
      setMsg('Não consegui gerar sugestões agora. Tente de novo em instantes.');
    } finally {
      setReflecting(false);
    }
  }

  if (!selectedUnitId) {
    return <div className="p-8 text-sm text-zinc-500">Selecione um agente pra ver os aprendizados.</div>;
  }

  const ativos = lessons?.filter((l) => l.enabled).length ?? 0;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-10">
        <div className="flex items-center gap-2.5 mb-1.5">
          <Lightbulb size={18} className="text-brand-400" />
          <h1 className="text-xl font-semibold text-zinc-100">Aprendizados da IA</h1>
        </div>
        <p className="text-[13px] text-zinc-500 mb-6">
          Regras curtas que a IA aplica <span className="text-zinc-300">só nesta clínica</span> — o que
          ela aprendeu na prática. Cada regra ativa entra no cérebro da IA na próxima mensagem.
          {lessons && lessons.length > 0 && (
            <span className="text-zinc-400"> {ativos} ativa{ativos === 1 ? '' : 's'} de {lessons.length}.</span>
          )}
        </p>

        {/* reflexão — a IA relê as conversas e sugere regras */}
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <button
            onClick={refletir}
            disabled={reflecting}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-[13px] font-semibold bg-violet-500/15 text-violet-300 ring-1 ring-violet-500/30 hover:bg-violet-500/25 disabled:opacity-50"
          >
            {reflecting ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
            {reflecting ? 'Analisando conversas…' : 'Gerar sugestões da IA'}
          </button>
          {msg && <span className="text-[12px] text-zinc-400">{msg}</span>}
        </div>

        {/* adicionar */}
        <div className="surface p-4 mb-6">
          <div className="flex gap-2 items-start">
            <input
              value={novo}
              onChange={(e) => setNovo(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && adicionar()}
              placeholder='Ex.: "Sempre confirme o bairro antes de oferecer horário"'
              className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-[14px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-brand-500"
            />
            <button
              onClick={adicionar}
              disabled={!novo.trim() || saving}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[13px] font-semibold bg-brand-500 text-white hover:bg-brand-400 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
              Adicionar
            </button>
          </div>
          <p className="text-[11px] text-zinc-600 mt-2">Escreva no imperativo, curto e direto. Uma regra por vez.</p>
        </div>

        {/* lista */}
        {lessons === null && (
          <div className="flex justify-center py-10"><Loader2 className="animate-spin text-zinc-500" size={18} /></div>
        )}
        {lessons && lessons.length === 0 && (
          <div className="surface p-10 text-center text-sm text-zinc-500">
            Nenhum aprendizado ainda. Adicione a primeira regra acima — ela passa a valer na próxima mensagem da IA.
          </div>
        )}
        {lessons && lessons.length > 0 && (
          <ul className="grid gap-2.5">
            {lessons.map((l) => (
              <li
                key={l.id}
                className={clsx(
                  'px-4 py-3 flex items-start gap-3 transition-all',
                  l.source === 'reflexao' && !l.enabled
                    ? 'rounded-xl bg-violet-500/10 ring-1 ring-violet-500/30'
                    : clsx('surface', !l.enabled && 'opacity-55'),
                )}
              >
                <button
                  onClick={() => toggle(l)}
                  disabled={busy === l.id}
                  title={l.enabled ? 'Desligar (a IA para de aplicar)' : 'Ligar'}
                  className={clsx(
                    'flex-none mt-0.5 w-9 h-5 rounded-full relative transition-colors',
                    l.enabled ? 'bg-emerald-500/80' : 'bg-zinc-700',
                  )}
                >
                  <span
                    className={clsx(
                      'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all',
                      l.enabled ? 'left-[18px]' : 'left-0.5',
                    )}
                  />
                </button>
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] text-zinc-100 leading-snug">{l.content}</div>
                  {l.source === 'reflexao' && (
                    <span className="inline-flex items-center gap-1 mt-1 text-[10px] font-semibold uppercase tracking-wide text-violet-300">
                      <Sparkles size={10} />
                      {l.enabled ? 'aprendido pela reflexão' : 'sugestão da IA — ligue pra aplicar'}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => remover(l)}
                  disabled={busy === l.id}
                  title="Apagar"
                  className="flex-none text-zinc-600 hover:text-rose-400 transition-colors p-1"
                >
                  {busy === l.id ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
