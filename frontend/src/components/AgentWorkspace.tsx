// ============================================================================
// AgentWorkspace — tudo que configura UM agente num só lugar, com abas internas.
// Antes cada coisa era uma aba solta na sidebar (Configurar IA, Fontes, Ações,
// Captura, Ferramentas, Testar, Treinar) — ficava espalhado. Aqui reúne os
// mesmos painéis (que já funcionam) sob uma navegação horizontal única.
// ============================================================================

import { useState } from 'react';
import clsx from 'clsx';
import {
  Wand2,
  FileText,
  Zap,
  Database,
  Wrench,
  TestTube2,
  GraduationCap,
} from 'lucide-react';
import { WizardPanel } from './WizardPanel';
import { FontesPanel } from './FontesPanel';
import { AcoesPanel } from './AcoesPanel';
import { CapturesPanel } from './CapturesPanel';
import { FerramentasPanel } from './FerramentasPanel';
import { PlaygroundPanel } from './PlaygroundPanel';
import { TrainingPanel } from './TrainingPanel';

type Sub = 'configurar' | 'fontes' | 'acoes' | 'captura' | 'ferramentas' | 'testar' | 'treinar';

const TABS: { id: Sub; label: string; icon: typeof Wand2 }[] = [
  { id: 'configurar', label: 'Configurar', icon: Wand2 },
  { id: 'fontes', label: 'Fontes', icon: FileText },
  { id: 'acoes', label: 'Ações', icon: Zap },
  { id: 'captura', label: 'Captura', icon: Database },
  { id: 'ferramentas', label: 'Ferramentas', icon: Wrench },
  { id: 'testar', label: 'Testar', icon: TestTube2 },
  { id: 'treinar', label: 'Treinar', icon: GraduationCap },
];

export function AgentWorkspace() {
  const [sub, setSub] = useState<Sub>('configurar');
  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <div className="flex items-center gap-1 px-3 pt-2 border-b border-zinc-800 bg-zinc-950 overflow-x-auto shrink-0">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = sub === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setSub(t.id)}
              className={clsx(
                'flex items-center gap-1.5 px-3.5 py-2 text-sm rounded-t-md border-b-2 whitespace-nowrap transition-colors',
                active
                  ? 'border-brand-500 text-brand-300'
                  : 'border-transparent text-zinc-400 hover:text-zinc-100',
              )}
            >
              <Icon size={15} />
              {t.label}
            </button>
          );
        })}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {sub === 'configurar' && <WizardPanel />}
        {sub === 'fontes' && <FontesPanel />}
        {sub === 'acoes' && <AcoesPanel />}
        {sub === 'captura' && <CapturesPanel />}
        {sub === 'ferramentas' && <FerramentasPanel />}
        {sub === 'testar' && <PlaygroundPanel />}
        {sub === 'treinar' && <TrainingPanel onNavigate={() => setSub('testar')} />}
      </div>
    </div>
  );
}
