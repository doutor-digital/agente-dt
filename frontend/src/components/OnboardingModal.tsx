// ============================================================================
// OnboardingModal — tutorial guiado de 5 passos pra primeira Unit.
//
// LÓGICA DE ENGENHARIA
// --------------------
// Aparece automaticamente quando:
//   - Não há nenhuma Unit, OU
//   - A Unit selecionada não tem credenciais Kommo + OpenAI setadas
// (heurística: olhamos kommoAccessToken vazio).
//
// Pode ser dispensado (×) e fica em localStorage marcado como "dismissed"
// pra essa Unit. Mesmo sem completar.
//
// 5 passos:
//   1. Boas-vindas + visão geral
//   2. Como pegar token Kommo (link pro Kommo settings)
//   3. Como pegar API key OpenAI
//   4. Onde configurar a IA (Configurar IA tab)
//   5. Como testar (mandar uma mensagem WhatsApp)
//
// É puramente educacional. Não força configuração — só orienta.
// ============================================================================

import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  KeyRound,
  Rocket,
  Send,
  Wand2,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { useUnit } from '../context/UnitContext';

const DISMISS_KEY = 'agente-dt-onboarding-dismissed-v1';

interface Step {
  title: string;
  description: string;
  icon: React.ReactNode;
  body: React.ReactNode;
}

export function OnboardingModal() {
  const { units, selectedUnitId } = useUnit();
  const [step, setStep] = useState(0);
  const [visible, setVisible] = useState(false);

  // Decide se deve mostrar.
  useEffect(() => {
    const dismissed = localStorage.getItem(DISMISS_KEY) === '1';
    if (dismissed) {
      setVisible(false);
      return;
    }
    const noUnits = units.length === 0;
    const selectedUnit = units.find((u) => u.id === selectedUnitId);
    const incomplete = selectedUnit && !selectedUnit._hasSecrets?.kommoAccessToken;
    setVisible(!!(noUnits || incomplete));
  }, [units, selectedUnitId]);

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, '1');
    setVisible(false);
  }

  const steps: Step[] = [
    {
      title: 'Bem-vindo ao Agente DT!',
      description: 'Em 4 passos rápidos você coloca uma IA atendendo seus leads 24/7.',
      icon: <Rocket size={28} className="text-brand-300" />,
      body: (
        <div className="space-y-3 text-sm text-zinc-300">
          <p>O Agente DT conecta:</p>
          <ul className="space-y-1.5 ml-4">
            <li className="flex items-center gap-2">
              <Check size={14} className="text-emerald-400" />
              Seu CRM Kommo (com WhatsApp/Instagram nativos)
            </li>
            <li className="flex items-center gap-2">
              <Check size={14} className="text-emerald-400" />
              Uma IA da OpenAI configurável (sem código)
            </li>
            <li className="flex items-center gap-2">
              <Check size={14} className="text-emerald-400" />
              Painel pra monitorar tudo em tempo real
            </li>
          </ul>
          <p className="text-zinc-400 text-xs mt-3">
            Cada passo a seguir explica onde pegar uma chave/ID que vamos colar no painel.
            Você pode pular este tutorial a qualquer momento.
          </p>
        </div>
      ),
    },
    {
      title: 'Passo 1: Token do Kommo',
      description: 'Crie uma "Integração Privada" no Kommo e gere um token de longa duração.',
      icon: <KeyRound size={28} className="text-amber-300" />,
      body: (
        <div className="space-y-3 text-sm text-zinc-300">
          <ol className="space-y-2 ml-4 list-decimal">
            <li>No Kommo: <strong>Configurações → Integrações → + Criar Integração → Privada</strong></li>
            <li>Nome: "Agente DT". Salvar.</li>
            <li>Abra a integração → aba <strong>Chaves e escopos</strong></li>
            <li>Procure <strong>"Token de longa duração"</strong> → gere com validade de 5 anos</li>
            <li>Marque TODOS os escopos disponíveis</li>
            <li><strong>Copie o token</strong> (só aparece uma vez!)</li>
          </ol>
          <p className="mt-2 text-xs text-zinc-400">
            Depois cole na aba <strong>Unidades → sua Unit → Access Token</strong>.
          </p>
          <a
            href="https://www.kommo.com/help/integrations/"
            target="_blank"
            rel="noopener"
            className="inline-flex items-center gap-1 text-xs text-brand-300 hover:text-brand-200"
          >
            Ajuda oficial do Kommo <ExternalLink size={11} />
          </a>
        </div>
      ),
    },
    {
      title: 'Passo 2: API Key da OpenAI',
      description: 'Pegue sua chave em platform.openai.com pra cobrar uso da IA.',
      icon: <Bot size={28} className="text-emerald-300" />,
      body: (
        <div className="space-y-3 text-sm text-zinc-300">
          <ol className="space-y-2 ml-4 list-decimal">
            <li>Vá em <strong>platform.openai.com</strong> → Login</li>
            <li>Menu lateral: <strong>API keys → + Create new secret key</strong></li>
            <li>Tipo: <strong>"Project"</strong> (não "Default")</li>
            <li>Copie a chave (começa com <code className="text-amber-300">sk-proj-...</code>)</li>
            <li>Cole em <strong>Unidades → sua Unit → API Key</strong></li>
          </ol>
          <p className="text-xs text-zinc-400 mt-2">
            💡 Defina um orçamento mensal no campo "Orçamento $USD/mês" — o painel te alerta se passar.
          </p>
          <a
            href="https://platform.openai.com/api-keys"
            target="_blank"
            rel="noopener"
            className="inline-flex items-center gap-1 text-xs text-brand-300 hover:text-brand-200"
          >
            Abrir platform.openai.com/api-keys <ExternalLink size={11} />
          </a>
        </div>
      ),
    },
    {
      title: 'Passo 3: Configurar a IA',
      description: 'Defina persona, gatilhos e features pelo Wizard — sem digitar prompt.',
      icon: <Wand2 size={28} className="text-cyan-300" />,
      body: (
        <div className="space-y-3 text-sm text-zinc-300">
          <p>Na aba <strong>Configurar IA</strong> você ativa as features que quiser:</p>
          <ul className="space-y-1 ml-4 text-xs">
            <li>🤖 <strong>Persona</strong> — nome da empresa, tom de voz</li>
            <li>🔥 <strong>Auto-qualificação</strong> — IA aplica tag Quente/Frio</li>
            <li>👤 <strong>Handoff humano</strong> — palavras-chave pausam a IA</li>
            <li>⏰ <strong>Horário comercial</strong> — IA só responde em horário</li>
            <li>📞 <strong>Coleta de contato</strong> — IA pede email/WhatsApp</li>
            <li>🎁 <strong>Cupom boas-vindas</strong> — primeiro contato recebe cupom</li>
            <li>📝 <strong>Templates</strong> — respostas prontas pra FAQs</li>
          </ul>
          <p className="text-xs text-zinc-400 mt-2">
            Cada feature é um toggle + dropdowns. Sem mexer em prompt cru. Veja preview ao vivo no rodapé.
          </p>
        </div>
      ),
    },
    {
      title: 'Passo 4: Testar com WhatsApp real',
      description: 'Mande mensagem pro número conectado e veja a IA responder.',
      icon: <Send size={28} className="text-rose-300" />,
      body: (
        <div className="space-y-3 text-sm text-zinc-300">
          <ol className="space-y-2 ml-4 list-decimal">
            <li>Pelo celular, mande uma mensagem pro WhatsApp conectado no Kommo</li>
            <li>Abra a aba <strong>Conversas</strong> aqui — o lead aparece em segundos</li>
            <li>Veja a IA respondendo automaticamente (5-15s tipicamente)</li>
            <li>Aba <strong>Execuções</strong> mostra o "raciocínio" da IA passo a passo</li>
            <li>Marca respostas ruins com 👎 — a IA aprende a evitar</li>
          </ol>
          <div className="mt-3 p-3 rounded-md bg-emerald-500/10 ring-1 ring-emerald-500/30 text-xs text-emerald-200">
            <strong>Pronto!</strong> Você acabou de colocar uma IA atendendo seus leads 24/7. 🚀
            <br />
            <span className="text-emerald-300/80">
              Use o <strong>Dashboard</strong> pra acompanhar KPIs e o funil.
            </span>
          </div>
        </div>
      ),
    },
  ];

  if (!visible) return null;

  const current = steps[step];
  const isFirst = step === 0;
  const isLast = step === steps.length - 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl rounded-2xl bg-zinc-900 ring-1 ring-zinc-800 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between p-6 border-b border-zinc-800/60">
          <div className="flex items-start gap-4">
            <div className="shrink-0 mt-0.5">{current.icon}</div>
            <div>
              <h2 className="text-lg font-display font-bold text-zinc-100 tracking-tight">
                {current.title}
              </h2>
              <p className="text-sm text-zinc-400 mt-0.5">{current.description}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={dismiss}
            className="text-zinc-500 hover:text-zinc-200 p-1"
            title="Pular tutorial"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="p-6">{current.body}</div>

        {/* Steps indicator */}
        <div className="px-6 pb-2 flex items-center justify-center gap-1.5">
          {steps.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setStep(i)}
              className={clsx(
                'h-1.5 rounded-full transition-all',
                i === step ? 'w-8 bg-brand-400' : 'w-1.5 bg-zinc-700 hover:bg-zinc-600',
              )}
            />
          ))}
        </div>

        {/* Nav */}
        <div className="flex items-center justify-between p-6 border-t border-zinc-800/60">
          <button
            type="button"
            onClick={() => setStep(Math.max(0, step - 1))}
            disabled={isFirst}
            className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded-md text-zinc-300 hover:bg-zinc-800 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <ChevronLeft size={14} />
            Voltar
          </button>
          <span className="text-xs text-zinc-500">
            Passo {step + 1} de {steps.length}
          </span>
          {isLast ? (
            <button
              type="button"
              onClick={dismiss}
              className="inline-flex items-center gap-1 text-sm px-4 py-1.5 rounded-md bg-brand-600 hover:bg-brand-500 text-white font-medium"
            >
              Começar
              <ArrowRight size={14} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setStep(step + 1)}
              className="inline-flex items-center gap-1 text-sm px-3 py-1.5 rounded-md bg-brand-600 hover:bg-brand-500 text-white"
            >
              Próximo
              <ChevronRight size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
