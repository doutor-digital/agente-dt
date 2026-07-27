// ============================================================================
// UnitHub — landing pós-login: escolha do agente.
//
// As CLÍNICAS e, dentro de cada uma, seus AGENTES. Cada agente é uma unidade;
// agentes da mesma clínica compartilham o nome da clínica (personaCompanyName)
// e o mesmo Kommo. Clicar num agente entra na configuração dele.
//
// A tela é a primeira coisa que o usuário vê logado, então carrega mais peso
// visual que os painéis internos: correntes de espaço latente animadas ao
// fundo, ilustração no cabeçalho, cartões com entrada escalonada e o ícone da
// categoria em cada agente. O fundo é DIFERENTE do login de propósito — duas
// telas seguidas com a mesma animação lêem como uma só.
// ============================================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Bot,
  Check,
  LayoutGrid,
  Loader2,
  Plus,
  Scale,
  Search,
  Stethoscope,
  Sun,
  X,
  type LucideIcon,
} from 'lucide-react';
import clsx from 'clsx';
import { useUnit } from '../context/UnitContext';
import { useToast } from '../context/ToastContext';
import { api } from '../lib/api';
import { normalize } from '../lib/nav';
import { LatentField } from './LatentField';
import { CATEGORY_OPTIONS } from './WizardPanel';
import type { Unit } from '../types/api';

/** Ilustração do cabeçalho. Se o arquivo não existir, cai na logo (ver onError). */
const HERO_IMG = '/agent-illustration.png';
const LOGO_IMG = '/logo-dd.png';

/** Cada categoria tem seu ícone — 12 cartões com o mesmo robô não informam nada. */
const CATEGORY_ICON: Record<string, LucideIcon> = {
  saude: Stethoscope,
  energia_solar: Sun,
  advocacia: Scale,
};

function categoryLabel(cat: string | null): string {
  const o = CATEGORY_OPTIONS.find((c) => c.value === (cat ?? ''));
  return o && o.value ? o.label : 'Genérica';
}

function categoryIcon(cat: string | null): LucideIcon {
  return CATEGORY_ICON[cat ?? ''] ?? Bot;
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
  const [heroBroken, setHeroBroken] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // "/" foca a busca — atalho de teclado que todo diretório de itens tem.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Agrupa as unidades (agentes) por clínica: personaCompanyName é o nome da
  // clínica; cai pra kommoSubdomain / nome quando não houver.
  const groups = useMemo(() => {
    const q = normalize(query.trim());
    const matching = q
      ? units.filter((u) =>
          normalize(`${u.name} ${u.slug} ${u.personaCompanyName ?? ''}`).includes(q),
        )
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

  const shown = groups.reduce((acc, g) => acc + g.units.length, 0);
  const active = units.filter((u) => u.isActive).length;
  const clinics = useMemo(
    () =>
      new Set(
        units.map((u) => u.personaCompanyName?.trim() || u.kommoSubdomain?.trim() || u.name),
      ).size,
    [units],
  );

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

  // Índice contínuo entre grupos: o escalonamento cascateia pela página toda em
  // vez de reiniciar a cada clínica.
  let cardIndex = -1;

  return (
    <div className="dark relative h-screen w-screen overflow-y-auto bg-zinc-950 text-zinc-100">
      {/* ── Ambiente ─────────────────────────────────────────────────────── */}
      <div className="fixed inset-x-0 top-0 h-140 pointer-events-none">
        <LatentField
          className="absolute inset-0 w-full h-full opacity-70"
          style={{
            maskImage: 'radial-gradient(ellipse 85% 100% at 50% 0%, #000 8%, transparent 76%)',
            WebkitMaskImage:
              'radial-gradient(ellipse 85% 100% at 50% 0%, #000 8%, transparent 76%)',
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(50% 100% at 50% 0%, color-mix(in oklab, var(--b-500) 12%, transparent), transparent 70%)',
          }}
        />
      </div>

      <div className="relative max-w-5xl mx-auto px-6 py-14">
        {/* ── Cabeçalho ──────────────────────────────────────────────────── */}
        <header className="flex flex-col items-center text-center mb-10 animate-fade-in-up">
          <img
            src={heroBroken ? LOGO_IMG : HERO_IMG}
            alt=""
            onError={() => setHeroBroken(true)}
            className={clsx(
              'object-contain mb-5 drop-shadow-[0_12px_32px_rgba(0,0,0,0.5)]',
              heroBroken ? 'w-14 h-14 rounded-2xl ring-1 ring-zinc-800 bg-zinc-900 p-2' : 'w-28 h-28',
            )}
          />
          <h1 className="text-[2.15rem] font-semibold tracking-tight leading-none">
            Escolha um agente
          </h1>
          <p className="mt-3 text-sm text-zinc-400 max-w-md">
            {units.length === 0
              ? 'Nenhum agente por aqui ainda — crie o primeiro abaixo.'
              : 'Clique num agente para entrar na configuração dele.'}
          </p>

          {units.length > 0 && (
            <div className="mt-5 flex items-center gap-2 flex-wrap justify-center">
              <Stat value={units.length} label={units.length === 1 ? 'agente' : 'agentes'} />
              <Stat value={clinics} label={clinics === 1 ? 'clínica' : 'clínicas'} />
              <Stat value={active} label="ativos" tone="accent" />
            </div>
          )}
        </header>

        {/* ── Busca + ações ──────────────────────────────────────────────── */}
        <div
          className="flex flex-col sm:flex-row gap-2.5 mb-8 animate-fade-in-up"
          style={{ animationDelay: '60ms' }}
        >
          <div className="relative flex-1">
            <Search
              size={15}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none"
            />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar agente ou clínica…"
              className="field pl-9 pr-16 py-2.5"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                title="Limpar busca"
              >
                <X size={13} />
              </button>
            ) : (
              <span className="kbd absolute right-2.5 top-1/2 -translate-y-1/2">/</span>
            )}
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

        {query && !loading && (
          <div className="text-[12px] text-zinc-500 mb-4 -mt-4">
            {shown === 0
              ? 'Nenhum resultado.'
              : `${shown} ${shown === 1 ? 'agente' : 'agentes'} em ${groups.length} ${groups.length === 1 ? 'clínica' : 'clínicas'}.`}
          </div>
        )}

        {/* ── Formulário de criação ──────────────────────────────────────── */}
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
                  {name.trim() ? `/${slugify(name) || '—'}` : ' '}
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

        {/* ── Clínicas → agentes ─────────────────────────────────────────── */}
        {loading ? (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="h-32 rounded-xl bg-zinc-900 animate-pulse"
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
            {groups.map((g) => (
              <section key={g.label}>
                <div className="flex items-center gap-2.5 mb-3 px-0.5">
                  <h2 className="text-[13px] font-semibold text-zinc-200 tracking-tight">
                    {g.label}
                  </h2>
                  <span className="text-[10px] font-medium text-zinc-500 px-1.5 py-0.5 rounded-md bg-zinc-900 border border-zinc-800">
                    {g.units.length}
                  </span>
                  <span className="flex-1 h-px bg-linear-to-r from-zinc-800 to-transparent" />
                </div>

                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {g.units.map((u) => {
                    cardIndex += 1;
                    return (
                      <AgentCard
                        key={u.id}
                        unit={u}
                        delayMs={cardIndex * 45}
                        onClick={() => setSelectedUnitId(u.id)}
                      />
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({
  value,
  label,
  tone = 'default',
}: {
  value: number;
  label: string;
  tone?: 'default' | 'accent';
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-baseline gap-1.5 text-[12px] px-2.5 py-1 rounded-full border',
        tone === 'accent'
          ? 'border-brand-500/25 bg-brand-500/10 text-brand-300'
          : 'border-zinc-800 bg-zinc-900/60 text-zinc-400',
      )}
    >
      <span className="font-semibold tabular-nums text-zinc-100">{value}</span>
      {label}
    </span>
  );
}

function AgentCard({
  unit,
  delayMs,
  onClick,
}: {
  unit: Unit;
  delayMs: number;
  onClick: () => void;
}) {
  const Icon = categoryIcon(unit.category);
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ animationDelay: `${delayMs}ms` }}
      className="group relative overflow-hidden text-left surface p-4 animate-fade-in-up transition-[transform,border-color] duration-200 hover:-translate-y-0.5 hover:border-brand-500/40"
    >
      {/* Brilho de acento que acende no hover — nasce no canto do ícone. */}
      <span
        aria-hidden
        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
        style={{
          background:
            'radial-gradient(120% 90% at 0% 0%, color-mix(in oklab, var(--b-500) 14%, transparent), transparent 62%)',
        }}
      />

      <div className="relative flex items-start gap-3">
        <span className="w-10 h-10 rounded-xl bg-brand-500/12 ring-1 ring-brand-500/25 flex items-center justify-center text-brand-400 shrink-0 transition-all duration-200 group-hover:bg-brand-500/20 group-hover:ring-brand-400/50 group-hover:scale-105">
          <Icon size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-zinc-100 truncate">{unit.name}</span>
          <span className="block text-[11px] text-zinc-500 truncate mt-0.5">
            {categoryLabel(unit.category)}
          </span>
        </span>
        <ArrowRight
          size={14}
          className="text-zinc-600 opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 group-hover:text-brand-400 transition-all duration-200 shrink-0"
        />
      </div>

      <div className="relative mt-4 flex items-center gap-1.5">
        <span className="relative flex w-1.5 h-1.5 shrink-0">
          {unit.isActive && (
            <span className="absolute inline-flex w-full h-full rounded-full bg-brand-400 opacity-60 animate-ping" />
          )}
          <span
            className={clsx(
              'relative inline-flex w-1.5 h-1.5 rounded-full',
              unit.isActive ? 'bg-brand-400' : 'bg-zinc-600',
            )}
          />
        </span>
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">
          {unit.isActive ? 'Ativo' : 'Desativado'}
        </span>
        <span className="ml-auto text-[10px] text-zinc-600 font-mono truncate max-w-[50%]">
          {unit.slug}
        </span>
      </div>
    </button>
  );
}
