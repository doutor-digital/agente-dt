// ============================================================================
// AgentWorkspace — tudo que configura UM agente num só lugar, em 5 SEÇÕES com
// nome humano (não em 20 abas de sistema):
//
//   Identidade   → quem é o agente (persona)
//   Conhecimento → o que ele sabe (fontes + treino)
//   Ações        → o que ele faz (ações, captura, ferramentas)
//   Kommo        → a conexão (resposta, pausa, Salesbot, etapas)
//   Testar       → conversar com ele antes de ativar
//
// Cada seção reúne os painéis que já funcionam. Seções com mais de um painel
// ganham uma sub-navegação leve. A ideia é "uma coisa de cada vez".
// ============================================================================

import { useState } from 'react';
import type { ReactNode } from 'react';
import clsx from 'clsx';
import {
  UserRound,
  BookOpen,
  Zap,
  Cable,
  TestTube2,
  Wand2,
  Power,
  FileText,
  GraduationCap,
  Database,
  Wrench,
  History,
  ShieldCheck,
} from 'lucide-react';
import { WizardPanel } from './WizardPanel';
import { FontesPanel } from './FontesPanel';
import { AcoesPanel } from './AcoesPanel';
import { CapturesPanel } from './CapturesPanel';
import { FerramentasPanel } from './FerramentasPanel';
import { PlaygroundPanel } from './PlaygroundPanel';
import { TrainingPanel } from './TrainingPanel';
import { AgentConfigPanel } from './AgentConfigPanel';
import { ActivationPanel } from './ActivationPanel';
import { HistoricoPanel } from './HistoricoPanel';
import { ProtecoesPanel } from './ProtecoesPanel';

type SegId = 'identidade' | 'conhecimento' | 'acoes' | 'kommo' | 'protecoes' | 'testar' | 'historico';

interface SubPanel {
  id: string;
  label: string;
  icon: typeof Wand2;
  render: (go: (seg: SegId) => void) => ReactNode;
}
interface Segment {
  id: SegId;
  label: string;
  icon: typeof Wand2;
  hint: string;
  subs: SubPanel[];
}

const SEGMENTS: Segment[] = [
  {
    id: 'identidade',
    label: 'Identidade',
    icon: UserRound,
    hint: 'Quem é o agente — nome, tom, persona e o que ele sabe fazer.',
    subs: [{ id: 'persona', label: 'Persona', icon: Wand2, render: () => <WizardPanel /> }],
  },
  {
    id: 'conhecimento',
    label: 'Conhecimento',
    icon: BookOpen,
    hint: 'O que o agente sabe — fontes de informação e material de treino.',
    subs: [
      { id: 'fontes', label: 'Fontes', icon: FileText, render: () => <FontesPanel /> },
      {
        id: 'treinar',
        label: 'Treinar',
        icon: GraduationCap,
        render: (go) => <TrainingPanel onNavigate={() => go('testar')} />,
      },
    ],
  },
  {
    id: 'acoes',
    label: 'Ações',
    icon: Zap,
    hint: 'O que o agente faz — ações no CRM, captura de dados e ferramentas.',
    subs: [
      { id: 'acoes', label: 'Ações', icon: Zap, render: () => <AcoesPanel /> },
      { id: 'captura', label: 'Captura', icon: Database, render: () => <CapturesPanel /> },
      { id: 'ferramentas', label: 'Ferramentas', icon: Wrench, render: () => <FerramentasPanel /> },
    ],
  },
  {
    id: 'kommo',
    label: 'Kommo',
    icon: Cable,
    hint: 'A conexão — campo de resposta e pausa, Salesbot e etapas em que responde.',
    subs: [
      { id: 'conexao', label: 'Conexão', icon: Cable, render: () => <AgentConfigPanel /> },
      { id: 'ativacao', label: 'Etapas & Ativação', icon: Power, render: () => <ActivationPanel /> },
    ],
  },
  {
    id: 'protecoes',
    label: 'Proteções',
    icon: ShieldCheck,
    hint: 'As travas de segurança da IA — preço fora do catálogo, conduta clínica e descarte de fora do escopo.',
    subs: [{ id: 'protecoes', label: 'Proteções', icon: ShieldCheck, render: () => <ProtecoesPanel /> }],
  },
  {
    id: 'testar',
    label: 'Testar',
    icon: TestTube2,
    hint: 'Converse com o agente e veja as ações que ele dispara — antes de colocar no ar.',
    subs: [{ id: 'playground', label: 'Playground', icon: TestTube2, render: () => <PlaygroundPanel /> }],
  },
  {
    id: 'historico',
    label: 'Histórico',
    icon: History,
    hint: 'Tudo que já foi treinado, ajustado ou corrigido na IA desta clínica.',
    subs: [{ id: 'melhorias', label: 'Melhorias', icon: History, render: () => <HistoricoPanel /> }],
  },
];

export function AgentWorkspace() {
  const [segId, setSegId] = useState<SegId>('identidade');
  const [subId, setSubId] = useState<string>(SEGMENTS[0].subs[0].id);

  const seg = SEGMENTS.find((s) => s.id === segId) ?? SEGMENTS[0];
  const sub = seg.subs.find((s) => s.id === subId) ?? seg.subs[0];

  function goSeg(id: SegId) {
    const target = SEGMENTS.find((s) => s.id === id) ?? SEGMENTS[0];
    setSegId(target.id);
    setSubId(target.subs[0].id);
  }

  const stepIndex = SEGMENTS.findIndex((s) => s.id === segId);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* ── Barra de seções: passos numerados, estilo "setup guiado" ──────── */}
      <div className="shrink-0 border-b border-zinc-800 px-4 pt-3.5 pb-0">
        <div className="flex items-center gap-1 overflow-x-auto pb-3.5">
          {SEGMENTS.map((s, i) => {
            const Icon = s.icon;
            const active = s.id === segId;
            const done = i < stepIndex;
            return (
              <div key={s.id} className="flex items-center shrink-0">
                <button
                  type="button"
                  onClick={() => goSeg(s.id)}
                  className={clsx(
                    'inline-flex items-center gap-2 pl-2 pr-3.5 py-1.5 text-[13px] rounded-full whitespace-nowrap transition-colors border',
                    active
                      ? 'border-brand-500/40 bg-brand-500/12 text-brand-200 font-medium'
                      : 'border-transparent text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60',
                  )}
                >
                  <span
                    className={clsx(
                      'w-5 h-5 rounded-full flex items-center justify-center shrink-0',
                      active
                        ? 'bg-brand-500/20 text-brand-300'
                        : done
                          ? 'bg-zinc-800 text-zinc-300'
                          : 'bg-zinc-800/70 text-zinc-500',
                    )}
                  >
                    <Icon size={12} />
                  </span>
                  {s.label}
                </button>
                {i < SEGMENTS.length - 1 && (
                  <span className="w-4 h-px bg-zinc-800 mx-0.5 shrink-0" />
                )}
              </div>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-4 pb-3">
          <p className="text-[12px] text-zinc-500">{seg.hint}</p>

          {/* Sub-navegação (só quando a seção tem mais de um painel) */}
          {seg.subs.length > 1 && (
            <div className="inline-flex gap-0.5 p-0.5 rounded-lg bg-zinc-900 border border-zinc-800 shrink-0">
              {seg.subs.map((su) => {
                const SubIcon = su.icon;
                const active = su.id === sub.id;
                return (
                  <button
                    key={su.id}
                    type="button"
                    onClick={() => setSubId(su.id)}
                    className={clsx(
                      'inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12px] rounded-md transition-colors',
                      active
                        ? 'bg-zinc-800 text-zinc-100 font-medium'
                        : 'text-zinc-500 hover:text-zinc-200',
                    )}
                  >
                    <SubIcon size={12} />
                    {su.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Conteúdo da seção ativa */}
      <div key={`${segId}:${sub.id}`} className="flex-1 min-h-0 overflow-auto animate-fade-in-up">
        {sub.render(goSeg)}
      </div>
    </div>
  );
}
