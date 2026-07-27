// ============================================================================
// UnitHub — landing pós-login: as CLÍNICAS e, dentro de cada uma, seus AGENTES.
// Cada agente é uma unidade; agentes da mesma clínica compartilham o nome da
// clínica (personaCompanyName) e o mesmo Kommo. Clicar num agente entra na
// configuração dele.
// ============================================================================

import { useMemo, useState } from 'react';
import { Bot, Check, LayoutGrid, Loader2, Plus, X } from 'lucide-react';
import { useUnit } from '../context/UnitContext';
import { useToast } from '../context/ToastContext';
import { api } from '../lib/api';
import { CATEGORY_OPTIONS } from './WizardPanel';
import type { Unit } from '../types/api';

const LOGO_URL = '/logo-dd.png';

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

  // Agrupa as unidades (agentes) por clínica: personaCompanyName é o nome da
  // clínica; cai pra kommoSubdomain / nome quando não houver.
  const groups = useMemo(() => {
    const m = new Map<string, { label: string; units: Unit[] }>();
    for (const u of units) {
      const key = u.personaCompanyName?.trim() || u.kommoSubdomain?.trim() || u.name;
      const label = u.personaCompanyName?.trim() || u.name;
      if (!m.has(key)) m.set(key, { label, units: [] });
      m.get(key)!.units.push(u);
    }
    return [...m.values()].sort((a, b) => b.units.length - a.units.length);
  }, [units]);

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error('Dê um nome ao agente.');
      return;
    }
    setSaving(true);
    try {
      const created = await api.createUnit({
        name: trimmed,
        slug: slugify(trimmed) || `agente-${Date.now()}`,
        category: category || null,
      });
      await refresh();
      toast.success(`Agente "${created.name}" criado!`);
      setSelectedUnitId(created.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Falha ao criar agente: ${msg}`);
      setSaving(false);
    }
  }

  return (
    <div className="dark h-screen w-screen overflow-y-auto" style={{ background: '#0e0c16' }}>
      <div className="max-w-4xl mx-auto px-6 py-12">
        {/* Header */}
        <div className="flex flex-col items-center text-center mb-10">
          <img src={LOGO_URL} alt="Doutor Digital" className="w-14 h-14 object-contain mb-3" />
          <h1 className="text-2xl md:text-3xl font-bold text-white tracking-tight">
            Clínicas e agentes
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            Escolha a clínica e clique no agente para configurá-lo.
          </p>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20 text-zinc-400">
            <Loader2 className="animate-spin mr-2" size={18} /> Carregando…
          </div>
        ) : (
          <div className="space-y-8">
            {groups.map((g) => (
              <section
                key={g.label}
                className="rounded-2xl ring-1 ring-white/10 bg-white/[0.03] p-5"
              >
                <div className="flex items-baseline gap-2 mb-4">
                  <h2 className="text-base font-semibold text-white">{g.label}</h2>
                  <span className="text-xs text-zinc-500">
                    {g.units.length} {g.units.length === 1 ? 'agente' : 'agentes'}
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                  {g.units.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => setSelectedUnitId(u.id)}
                      className="group flex flex-col items-start text-left rounded-xl bg-zinc-900/60 ring-1 ring-white/10 hover:ring-brand-400/60 hover:bg-zinc-900 p-4 transition-all duration-200 hover:-translate-y-0.5"
                    >
                      <div className="w-9 h-9 rounded-lg bg-brand-500/15 ring-1 ring-brand-400/30 flex items-center justify-center text-brand-300 group-hover:bg-brand-500/25 transition">
                        <Bot size={18} />
                      </div>
                      <div className="mt-3 text-sm font-semibold text-zinc-100 truncate w-full">
                        {u.name}
                      </div>
                      <div className="text-[11px] text-zinc-500 truncate w-full">
                        {categoryLabel(u.category)}
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            ))}

            {/* Criar novo agente */}
            {!showForm ? (
              <button
                type="button"
                onClick={() => setShowForm(true)}
                className="w-full rounded-2xl ring-1 ring-dashed ring-white/15 hover:ring-brand-400/50 bg-white/[0.02] hover:bg-white/[0.04] p-4 flex items-center justify-center gap-2 text-zinc-400 hover:text-brand-200 transition"
              >
                <Plus size={18} /> Novo agente
              </button>
            ) : (
              <div className="rounded-2xl bg-zinc-900/70 ring-1 ring-white/10 p-5 space-y-3 max-w-md mx-auto">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-zinc-100">Novo agente</span>
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
                    placeholder="ex: Resgate"
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

        <div className="flex justify-center mt-10">
          <button
            type="button"
            onClick={onViewAll}
            className="inline-flex items-center gap-2 text-sm px-4 py-2 rounded-full bg-white/5 ring-1 ring-white/10 text-zinc-400 hover:text-white hover:bg-white/10 transition"
          >
            <LayoutGrid size={15} />
            Ver painel geral
          </button>
        </div>
      </div>
    </div>
  );
}
