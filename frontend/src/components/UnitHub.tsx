// ============================================================================
// UnitHub — landing pós-login: escolher uma unidade existente, criar uma nova
// (atribuindo categoria) ou entrar no painel geral (todas as unidades).
//
// Aparece pro SUPER_ADMIN quando nenhuma unidade está selecionada. Selecionar
// uma unidade (ou criá-la) entra no app já no contexto dela. A categoria define
// a identidade da IA (Saúde → Dra. Sofia, Energia Solar → Dr. João).
// ============================================================================

import { useState } from 'react';
import { ArrowRight, Building2, Check, LayoutGrid, Loader2, Plus, X } from 'lucide-react';
import { useUnit } from '../context/UnitContext';
import { useToast } from '../context/ToastContext';
import { api } from '../lib/api';
import { CATEGORY_OPTIONS } from './WizardPanel';

const LOGO_URL = 'https://i.postimg.cc/9fkz8kVx/DESIGN-(1).png';
const SKY =
  'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?auto=format&fit=crop&w=2000&q=70';

function categoryLabel(cat: string | null): string {
  const o = CATEGORY_OPTIONS.find((c) => c.value === (cat ?? ''));
  return o && o.value ? o.label : 'Genérica';
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function UnitHub({ onViewAll }: { onViewAll: () => void }) {
  const { units, loading, setSelectedUnitId, refresh } = useUnit();
  const toast = useToast();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error('Dê um nome à unidade.');
      return;
    }
    setSaving(true);
    try {
      const created = await api.createUnit({
        name: trimmed,
        slug: slugify(trimmed) || `unidade-${Date.now()}`,
        category: category || null,
      });
      await refresh();
      toast.success(`Unidade "${created.name}" criada!`);
      setSelectedUnitId(created.id); // entra direto na nova unidade
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Falha ao criar unidade: ${msg}`);
      setSaving(false);
    }
  }

  return (
    <div
      className="h-screen w-screen overflow-y-auto bg-cover bg-center bg-[#0a1628]"
      style={{
        backgroundImage: `linear-gradient(to bottom, rgba(8,8,12,0.82), rgba(8,8,12,0.94)), url(${SKY})`,
      }}
    >
      <div className="max-w-5xl mx-auto px-6 py-12">
        {/* Header */}
        <div className="flex flex-col items-center text-center mb-10">
          <img src={LOGO_URL} alt="Agente DT" className="w-14 h-14 object-contain mb-3" />
          <h1 className="text-2xl md:text-3xl font-bold text-white tracking-tight">
            Escolha uma unidade
          </h1>
          <p className="text-sm text-zinc-300/90 mt-1">
            Cada unidade tem sua própria IA. A categoria define a identidade dela.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20 text-zinc-300">
            <Loader2 className="animate-spin mr-2" size={18} /> Carregando unidades…
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {units.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => setSelectedUnitId(u.id)}
                className="group text-left rounded-2xl bg-zinc-900/55 ring-1 ring-white/10 hover:ring-brand-400/50 hover:bg-zinc-900/70 backdrop-blur p-5 transition-all"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="w-10 h-10 rounded-xl bg-brand-500/15 ring-1 ring-brand-400/30 flex items-center justify-center text-brand-300">
                    <Building2 size={18} />
                  </div>
                  <ArrowRight
                    size={16}
                    className="text-zinc-500 group-hover:text-brand-300 group-hover:translate-x-0.5 transition-all"
                  />
                </div>
                <div className="mt-3 text-zinc-100 font-semibold truncate">{u.name}</div>
                <div className="text-[11px] text-zinc-500 truncate">{u.slug}</div>
                <div className="mt-3 inline-flex items-center text-[11px] px-2 py-0.5 rounded-full bg-white/5 ring-1 ring-white/10 text-zinc-300">
                  {categoryLabel(u.category)}
                </div>
              </button>
            ))}

            {/* Card de criar nova unidade */}
            {!showForm ? (
              <button
                type="button"
                onClick={() => setShowForm(true)}
                className="rounded-2xl border-2 border-dashed border-white/15 hover:border-brand-400/50 hover:bg-white/5 p-5 flex flex-col items-center justify-center gap-2 text-zinc-400 hover:text-brand-200 transition-all min-h-[150px]"
              >
                <Plus size={22} />
                <span className="text-sm font-medium">Criar nova unidade</span>
              </button>
            ) : (
              <div className="rounded-2xl bg-zinc-900/70 ring-1 ring-white/10 backdrop-blur p-5 space-y-3 sm:col-span-2 lg:col-span-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-zinc-100">Nova unidade</span>
                  <button
                    type="button"
                    onClick={() => setShowForm(false)}
                    className="text-zinc-500 hover:text-zinc-200"
                  >
                    <X size={15} />
                  </button>
                </div>
                <div>
                  <label className="text-[11px] uppercase tracking-wider text-zinc-400 block mb-1">
                    Nome
                  </label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoFocus
                    placeholder="ex: Clínica Sorriso"
                    className="w-full rounded-md bg-zinc-950/60 ring-1 ring-white/10 px-3 py-2 text-sm text-zinc-100 focus:ring-2 focus:ring-brand-500/50 focus:outline-none"
                  />
                  {name.trim() && (
                    <div className="text-[10px] text-zinc-500 mt-1">slug: {slugify(name) || '—'}</div>
                  )}
                </div>
                <div>
                  <label className="text-[11px] uppercase tracking-wider text-zinc-400 block mb-1">
                    Categoria
                  </label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className="w-full rounded-md bg-zinc-950/60 ring-1 ring-white/10 px-3 py-2 text-sm text-zinc-100 focus:ring-2 focus:ring-brand-500/50 focus:outline-none"
                  >
                    {CATEGORY_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value} className="bg-zinc-900">
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  onClick={() => void handleCreate()}
                  disabled={saving || !name.trim()}
                  className="w-full px-4 py-2 rounded-md bg-brand-600 text-white inline-flex items-center justify-center gap-2 hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed font-semibold text-sm transition-colors"
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  Criar e entrar
                </button>
              </div>
            )}
          </div>
        )}

        {/* Painel geral */}
        <div className="flex justify-center mt-10">
          <button
            type="button"
            onClick={onViewAll}
            className="inline-flex items-center gap-2 text-sm px-4 py-2 rounded-full bg-white/5 ring-1 ring-white/10 text-zinc-300 hover:text-white hover:bg-white/10 transition"
          >
            <LayoutGrid size={15} />
            Ver painel geral (todas as unidades)
          </button>
        </div>
      </div>
    </div>
  );
}
