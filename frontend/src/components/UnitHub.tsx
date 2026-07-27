// ============================================================================
// UnitHub — landing pós-login: escolha do "workspace".
//
// As CLÍNICAS e, dentro de cada uma, seus AGENTES. Cada agente é uma unidade;
// agentes da mesma clínica compartilham o nome da clínica (personaCompanyName)
// e o mesmo Kommo. Clicar num agente entra na configuração dele.
//
// Layout no formato "seletor de projeto" das plataformas de IA: busca no topo,
// clínicas como seções, agentes como cards com estado visível (ativo/off).
// ============================================================================

import { useMemo, useState } from 'react';
import { ArrowRight, Bot, Check, LayoutGrid, Loader2, Plus, Search, X } from 'lucide-react';
import clsx from 'clsx';
import { useUnit } from '../context/UnitContext';
import { useToast } from '../context/ToastContext';
import { api } from '../lib/api';
import { normalize } from '../lib/nav';
import { CATEGORY_OPTIONS } from './WizardPanel';
import type { Unit } from '../types/api';

function categoryLabel(cat: string | null): string {
  const o = CATEGORY_OPTIONS.find((c) => c.value === (cat ?? ''));
  return o && o.value ? o.label : 'Genérica';
}

function slugify(s: string): string {
  return normalize(s)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function UnitHub({ onViewAll }: { onViewAll: () => void }) {
  const { units, loading, setSelectedUnitId, refresh } = useUnit();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [saving, setSaving] = useState(false);

  // Agrupa as unidades (agentes) por clínica: personaCompanyName é o nome da
  // clínica; cai pra kommoSubdomain / nome quando não houver.
  const groups = useMemo(() => {
    const q = normalize(query.trim());
    const matching = q
      ? units.filter((u) => normalize(`${u.name} ${u.slug} ${u.personaCompanyName ?? ''}`).includes(q))
      : units;

    const m = new Map<string, { label: string; units: Unit[] }>();
    for (const u of matching) {
      const key = u.personaCompanyName?.trim() || u.kommoSubdomain?.trim() || u.name;
      const label = u.personaCompanyName?.trim() || u.name;
      if (!m.has(key)) m.set(key, { label, units: [] });
      m.get(key)!.units.push(u);
    }
    return [...m.values()].sort((a, b) => b.units.length - a.units.length);
  }, [units, query]);

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

  const total = units.length;

  return (
    <div className="dark relative h-screen w-screen overflow-y-auto bg-zinc-950 text-zinc-100">
      <div className="absolute inset-x-0 top-0 h-[460px] grid-mesh opacity-50 pointer-events-none" />
      <div
        className="absolute inset-x-0 top-0 h-[460px] pointer-events-none"
        style={{
          background:
            'radial-gradient(55% 100% at 50% 0%, color-mix(in oklab, var(--b-500) 13%, transparent), transparent 70%)',
        }}
      />

      <div className="relative max-w-5xl mx-auto px-6 py-14">
        {/* ── Cabeçalho ────────────────────────────────────────────────────── */}
        <header className="flex flex-col items-center text-center mb-9">
          <img
            src="/logo-dd.png"
            alt=""
            className="w-12 h-12 rounded-2xl object-contain ring-1 ring-zinc-800 bg-zinc-900 p-2 mb-4"
          />
          <h1 className="text-3xl font-semibold tracking-tight">Escolha um agente</h1>
          <p className="mt-2 text-sm text-zinc-400 max-w-md">
            {total === 0
              ? 'Nenhum agente por aqui ainda — crie o primeiro abaixo.'
              : `${total} ${total === 1 ? 'agente' : 'agentes'} em ${groups.length} ${groups.length === 1 ? 'clínica' : 'clínicas'}. Clique para entrar na configuração.`}
          </p>
        </header>

        {/* ── Busca + ações ────────────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row gap-2.5 mb-8">
          <div className="relative flex-1">
            <Search
              size={15}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar agente ou clínica…"
              className="field pl-9 py-2.5"
            />
          </div>
          <button type="button" onClick={onViewAll} className="btn-ghost py-2.5 shrink-0">
            <LayoutGrid size={15} />
            Painel geral
          </button>
          {!showForm && (
            <button
              type="button"
              onClick={() => setShowForm(true)}
              className="btn-primary py-2.5 shrink-0"
            >
              <Plus size={15} />
              Novo agente
            </button>
          )}
        </div>

        {/* ── Formulário de criação ────────────────────────────────────────── */}
        {showForm && (
          <div className="surface p-5 mb-8 animate-fade-in-up">
            <div className="flex items-center justify-between mb-4">
              <div>
                <div className="text-sm font-semibold text-zinc-100">Novo agente</div>
                <div className="text-[12px] text-zinc-500 mt-0.5">
                  A categoria define a persona inicial — dá pra ajustar depois.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
              >
                <X size={15} />
              </button>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[12px] font-medium text-zinc-400">Nome</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                  placeholder="ex: Resgate"
                  className="field mt-1.5"
                />
                <span className="block text-[11px] text-zinc-600 mt-1 font-mono">
                  {name.trim() ? `/${slugify(name) || '—'}` : ' '}
                </span>
              </label>

              <label className="block">
                <span className="text-[12px] font-medium text-zinc-400">Categoria</span>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="field mt-1.5"
                >
                  {CATEGORY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={saving || !name.trim()}
              className="btn-primary mt-4 py-2.5"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              Criar e entrar
            </button>
          </div>
        )}

        {/* ── Clínicas → agentes ───────────────────────────────────────────── */}
        {loading ? (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="h-28 rounded-xl bg-zinc-900 animate-pulse"
                style={{ animationDelay: `${i * 70}ms` }}
              />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <div className="surface p-12 text-center">
            <Bot size={28} className="mx-auto text-zinc-600 mb-3" />
            <div className="text-sm text-zinc-300">
              {query ? 'Nenhum agente com esse nome.' : 'Nenhum agente cadastrado ainda.'}
            </div>
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="mt-3 text-[12px] text-brand-300 hover:underline"
              >
                Limpar busca
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-9">
            {groups.map((g, gi) => (
              <section key={g.label} className="animate-fade-in-up" style={{ animationDelay: `${gi * 60}ms` }}>
                <div className="flex items-baseline gap-2.5 mb-3 px-0.5">
                  <h2 className="text-[13px] font-semibold text-zinc-200 tracking-tight">{g.label}</h2>
                  <span className="text-[11px] text-zinc-600">
                    {g.units.length} {g.units.length === 1 ? 'agente' : 'agentes'}
                  </span>
                  <span className="flex-1 h-px bg-zinc-800" />
                </div>

                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {g.units.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => setSelectedUnitId(u.id)}
                      className="group relative text-left surface p-4 hover:border-zinc-700 hover:bg-zinc-800/40 transition-all duration-200"
                    >
                      <div className="flex items-start gap-3">
                        <span className="w-9 h-9 rounded-xl bg-brand-500/12 ring-1 ring-brand-500/25 flex items-center justify-center text-brand-400 shrink-0 group-hover:bg-brand-500/20 transition-colors">
                          <Bot size={17} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] font-medium text-zinc-100 truncate">
                            {u.name}
                          </span>
                          <span className="block text-[11px] text-zinc-500 truncate mt-0.5">
                            {categoryLabel(u.category)}
                          </span>
                        </span>
                        <ArrowRight
                          size={14}
                          className="text-zinc-600 opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all shrink-0"
                        />
                      </div>

                      <div className="mt-3.5 flex items-center gap-1.5">
                        <span
                          className={clsx(
                            'w-1.5 h-1.5 rounded-full',
                            u.isActive ? 'bg-brand-400' : 'bg-zinc-600',
                          )}
                        />
                        <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                          {u.isActive ? 'Ativo' : 'Desativado'}
                        </span>
                        <span className="ml-auto text-[10px] text-zinc-600 font-mono truncate max-w-[45%]">
                          {u.slug}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
