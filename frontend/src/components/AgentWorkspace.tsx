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
  FileText,
  GraduationCap,
  Database,
  Wrench,
} from 'lucide-react';
import { WizardPanel } from './WizardPanel';
import { FontesPanel } from './FontesPanel';
import { AcoesPanel } from './AcoesPanel';
import { CapturesPanel } from './CapturesPanel';
import { FerramentasPanel } from './FerramentasPanel';
import { PlaygroundPanel } from './PlaygroundPanel';
import { TrainingPanel } from './TrainingPanel';
import { AgentConfigPanel } from './AgentConfigPanel';

type SegId = 'identidade' | 'conhecimento' | 'acoes' | 'kommo' | 'testar';

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
    subs: [{ id: 'conexao', label: 'Conexão', icon: Cable, render: () => <AgentConfigPanel /> }],
  },
  {
    id: 'testar',
    label: 'Testar',
    icon: TestTube2,
    hint: 'Converse com o agente e veja as ações que ele dispara — antes de colocar no ar.',
    subs: [{ id: 'playground', label: 'Playground', icon: TestTube2, render: () => <PlaygroundPanel /> }],
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

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Barra de seções */}
      <div className="shrink-0 border-b border-zinc-800 bg-zinc-950 px-4 pt-3 pb-3">
        <div className="inline-flex gap-1 p-1 rounded-xl bg-zinc-900 border border-zinc-800 overflow-x-auto max-w-full">
          {SEGMENTS.map((s) => {
            const Icon = s.icon;
            const active = s.id === segId;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => goSeg(s.id)}
                className={clsx(
                  'inline-flex items-center gap-2 px-4 py-2 text-sm rounded-lg whitespace-nowrap transition-colors',
                  active
                    ? 'bg-brand-500/15 text-brand-200 font-semibold'
                    : 'text-zinc-400 hover:text-zinc-100',
                )}
              >
                <Icon size={15} className={active ? 'text-brand-400' : 'text-zinc-500'} />
                {s.label}
              </button>
            );
          })}
        </div>

        <p className="mt-2 text-xs text-zinc-500">{seg.hint}</p>

        {/* Sub-navegação (só quando a seção tem mais de um painel) */}
        {seg.subs.length > 1 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {seg.subs.map((su) => {
              const SubIcon = su.icon;
              const active = su.id === sub.id;
              return (
                <button
                  key={su.id}
                  type="button"
                  onClick={() => setSubId(su.id)}
                  className={clsx(
                    'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md transition-colors',
                    active
                      ? 'bg-zinc-800 text-zinc-100'
                      : 'text-zinc-500 hover:text-zinc-200 hover:bg-zinc-900',
                  )}
                >
                  <SubIcon size={13} />
                  {su.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Conteúdo da seção ativa */}
      <div className="flex-1 min-h-0 overflow-auto">{sub.render(goSeg)}</div>
    </div>
  );
}
