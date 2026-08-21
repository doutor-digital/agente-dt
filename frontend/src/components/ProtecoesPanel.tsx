// ============================================================================
// ProtecoesPanel — mostra as TRAVAS de segurança da IA da unidade, em
// linguagem de dono de clínica. Status lido direto do `selectedUnit` (category
// + Fontes), sem backend novo. O registro de QUANDO cada trava foi ligada está
// na aba Histórico.
// ============================================================================

import { ShieldCheck, Stethoscope, Target, CircleCheck, CircleSlash } from 'lucide-react';
import clsx from 'clsx';
import { useUnit } from '../context/UnitContext';

// Espelha o parse do backend (guardrail.ts): extrai valores R$ do texto.
function parseAmounts(text: string | null | undefined): number[] {
  if (!text) return [];
  const out = new Set<number>();
  const re = /R\$\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{2})?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(m[1].replace(/\./g, ''));
    if (!Number.isNaN(n) && n > 0) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

function StatusPill({ on }: { on: boolean }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ring-1',
        on
          ? 'text-emerald-300 bg-emerald-500/10 ring-emerald-500/30'
          : 'text-zinc-400 bg-zinc-500/10 ring-zinc-500/30',
      )}
    >
      {on ? <CircleCheck size={11} /> : <CircleSlash size={11} />}
      {on ? 'Ativa' : 'Inativa'}
    </span>
  );
}

interface CardProps {
  icon: typeof ShieldCheck;
  title: string;
  on: boolean;
  children: React.ReactNode;
  accent: string;
}
function ProtCard({ icon: Icon, title, on, children, accent }: CardProps) {
  return (
    <div className={clsx('surface p-5', !on && 'opacity-70')}>
      <div className="flex items-center gap-3 mb-2.5">
        <span className={clsx('w-9 h-9 rounded-xl flex items-center justify-center', accent)}>
          <Icon size={18} />
        </span>
        <h3 className="text-[15px] font-semibold text-zinc-100 flex-1">{title}</h3>
        <StatusPill on={on} />
      </div>
      <div className="text-[13px] text-zinc-400 leading-relaxed space-y-2">{children}</div>
    </div>
  );
}

export function ProtecoesPanel() {
  const { selectedUnit } = useUnit();

  if (!selectedUnit) {
    return <div className="p-8 text-sm text-zinc-500">Selecione um agente pra ver as proteções.</div>;
  }

  const isSaude = selectedUnit.category?.trim() === 'saude';
  const precos = parseAmounts(selectedUnit.sourceProdutos);
  const precoOn = precos.length > 0;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-10">
        <div className="flex items-center gap-2.5 mb-1.5">
          <ShieldCheck size={18} className="text-brand-400" />
          <h1 className="text-xl font-semibold text-zinc-100">Proteções da IA</h1>
        </div>
        <p className="text-[13px] text-zinc-500 mb-8">
          Travas duras que rodam por baixo da IA desta clínica — não são só instruções no prompt,
          são regras que a IA <span className="text-zinc-300">não consegue furar</span>. Cada vez
          que uma trava age, fica registrada.
        </p>

        <div className="grid gap-4">
          {/* Preço */}
          <ProtCard
            icon={ShieldCheck}
            title="Trava de preço"
            on={precoOn}
            accent="bg-sky-500/15 text-sky-300"
          >
            <p>
              A IA <span className="text-zinc-200">não pode dizer um valor que não está no catálogo</span> da
              unidade. Se ela tentar inventar um preço, a mensagem é bloqueada e trocada por uma
              resposta segura.
            </p>
            {precoOn ? (
              <div className="flex items-center gap-2 flex-wrap pt-1">
                <span className="text-[11px] text-zinc-500">Valores que a IA pode dizer:</span>
                {precos.map((p) => (
                  <span
                    key={p}
                    className="px-2 py-0.5 rounded-md text-[12px] font-semibold bg-zinc-800 text-zinc-100 ring-1 ring-zinc-700"
                  >
                    R$ {p.toLocaleString('pt-BR')}
                  </span>
                ))}
                <span className="text-[11px] text-zinc-600">(parcelas desses valores também passam)</span>
              </div>
            ) : (
              <p className="text-amber-300/90 text-[12px]">
                ⚠️ Nenhum valor cadastrado nas Fontes desta unidade — a trava de preço fica em
                espera. Coloque os valores em <span className="font-medium">Conhecimento › Fontes › Produtos</span> pra ativar.
              </p>
            )}
          </ProtCard>

          {/* Clínico */}
          <ProtCard
            icon={Stethoscope}
            title="Trava clínica"
            on={isSaude}
            accent="bg-rose-500/15 text-rose-300"
          >
            <p>
              A IA <span className="text-zinc-200">não dá diagnóstico, não prescreve remédio</span> e
              não promete cura nem "sem cirurgia". Se escorregar, a mensagem é trocada por um
              redirecionamento pro especialista.
            </p>
            {!isSaude && (
              <p className="text-[12px] text-zinc-600">
                Ativa só em unidades de saúde. Esta unidade está na categoria
                {selectedUnit.category ? ` "${selectedUnit.category}"` : ' não definida'}.
              </p>
            )}
          </ProtCard>

          {/* Knockout */}
          <ProtCard
            icon={Target}
            title="Qualificação — descarte de fora do escopo"
            on={isSaude}
            accent="bg-violet-500/15 text-violet-300"
          >
            <p>
              A IA pergunta cedo <span className="text-zinc-200">qual é o incômodo e onde dói</span> e,
              se o caso for claramente fora do escopo (ex.: joelho, ombro, fratura, hérnia umbilical),
              declina com acolhimento e marca a tag <span className="text-zinc-200">"Fora do escopo"</span> —
              sem marcar consulta pra quem não vamos poder ajudar. Na dúvida, ela qualifica normal.
            </p>
          </ProtCard>
        </div>

        <p className="text-[12px] text-zinc-600 mt-6">
          📜 O registro de quando cada proteção foi ligada está na aba <span className="text-zinc-400">Histórico</span>.
          O feed ao vivo de cada disparo entra numa próxima atualização.
        </p>
      </div>
    </div>
  );
}
