// ============================================================================
// nav.ts — REGISTRO ÚNICO de navegação do console.
//
// Antes cada peça do chrome tinha a própria lista de abas. Agora existe uma só:
// a sidebar, o breadcrumb do TopBar e a paleta de comandos (⌘K) leem daqui.
// Adicionar uma página = uma linha nesta lista (+ o slug em useRoute).
//
// `section` agrupa na sidebar; `keywords` alimenta a busca da paleta (inclui
// sinônimos que o usuário digitaria em PT-BR sem acento).
// ============================================================================

import {
  AlertOctagon,
  Building2,
  Cable,
  Cpu,
  FileBarChart,
  Globe,
  LayoutDashboard,
  MessageCircle,
  MessagesSquare,
  Settings2,
  Sparkles,
  Terminal,
  Truck,
  UserCog,
  Wand2,
} from 'lucide-react';
import { FaFacebookF, FaInstagram } from 'react-icons/fa6';
import { PiCalendarBlankBold } from 'react-icons/pi';
import type { ComponentType } from 'react';

/**
 * As duas bibliotecas de ícone convivem: lucide no chrome antigo, react-icons
 * nas telas novas (e nas marcas, que o lucide deprecou). Tipar pela FORMA da
 * prop, e não pela lib, é o que permite migrar uma tela por vez sem quebrar as
 * outras.
 */
export type IconComponent = ComponentType<{
  size?: number | string;
  className?: string;
  strokeWidth?: number;
}>;

export type AppTab =
  | 'dashboard'
  | 'configure'
  | 'traces'
  | 'conversations'
  | 'llm'
  | 'prompts'
  | 'integrations'
  | 'wizard'
  | 'playground'
  | 'training'
  | 'sources'
  | 'actions'
  | 'global-actions'
  | 'captures'
  | 'tools'
  | 'reports'
  | 'config'
  | 'units'
  | 'users'
  | 'errors'
  | 'delivery'
  | 'whatsapp'
  | 'instagram'
  | 'facebook'
  | 'agenda';

/** Grupos da sidebar, na ordem em que aparecem. */
export type NavSection = 'operacao' | 'agente' | 'analise' | 'plataforma';

export const SECTION_LABEL: Record<NavSection, string> = {
  operacao: 'Operação',
  agente: 'Agente',
  analise: 'Análise',
  plataforma: 'Plataforma',
};

export interface NavItem {
  id: AppTab;
  label: string;
  /** Uma linha explicando a página — usada na paleta de comandos. */
  hint: string;
  icon: IconComponent;
  section: NavSection;
  superOnly?: boolean;
  keywords?: string[];
}

export const NAV_ITEMS: NavItem[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    hint: 'Visão geral de leads, mensagens e custo do período.',
    icon: LayoutDashboard,
    section: 'operacao',
    keywords: ['inicio', 'home', 'kpi', 'metricas', 'visao geral'],
  },
  {
    id: 'conversations',
    label: 'Conversas',
    hint: 'Histórico de conversas do agente com os leads.',
    icon: MessagesSquare,
    section: 'operacao',
    keywords: ['chat', 'mensagens', 'leads', 'whatsapp'],
  },
  {
    id: 'traces',
    label: 'Execuções',
    hint: 'Trace passo a passo de cada execução do agente.',
    icon: Terminal,
    section: 'operacao',
    keywords: ['trace', 'logs', 'debug', 'runs'],
  },
  {
    id: 'errors',
    label: 'Erros',
    hint: 'Falhas recentes agrupadas por tipo e integração.',
    icon: AlertOctagon,
    section: 'operacao',
    keywords: ['falhas', 'exception', 'incidentes'],
  },
  {
    id: 'delivery',
    label: 'Entrega',
    hint: 'Monitor do caminho de entrega das respostas (Salesbot / widget).',
    icon: Truck,
    section: 'operacao',
    superOnly: true,
    keywords: ['salesbot', 'widget', 'envio', 'delivery'],
  },

  {
    id: 'configure',
    label: 'Configurar agente',
    hint: 'Persona, conhecimento, ações, conexão com o Kommo e testes.',
    icon: Wand2,
    section: 'agente',
    keywords: ['persona', 'prompt', 'fontes', 'acoes', 'playground', 'treinar'],
  },
  {
    id: 'instagram',
    label: 'Instagram',
    hint: 'Comentários respondidos pelo agente e fila de aprovação.',
    icon: FaInstagram,
    section: 'agente',
    keywords: ['comentarios', 'insta', 'direct', 'dm', 'post', 'reels'],
  },
  {
    id: 'agenda',
    label: 'Agenda',
    hint: 'Horários da franquia e o botão de pausa da IA.',
    icon: PiCalendarBlankBold,
    section: 'operacao',
    keywords: ['agendamento', 'spine', 'pausar', 'kill switch', 'recepcao', 'horarios'],
  },
  {
    id: 'facebook',
    label: 'Facebook',
    hint: 'Comentários da Página respondidos pelo agente e fila de aprovação.',
    icon: FaFacebookF,
    section: 'agente',
    keywords: ['comentarios', 'face', 'fb', 'pagina', 'post', 'inbox'],
  },
  {
    id: 'units',
    label: 'Agentes',
    hint: 'Todos os agentes e clínicas cadastrados.',
    icon: Building2,
    section: 'agente',
    superOnly: true,
    keywords: ['unidades', 'clinicas', 'tenants'],
  },
  {
    id: 'integrations',
    label: 'Integrações',
    hint: 'Kommo, WhatsApp e provedores de IA.',
    icon: Cable,
    section: 'agente',
    keywords: ['kommo', 'api', 'credenciais', 'tokens'],
  },
  {
    id: 'global-actions',
    label: 'Regras globais',
    hint: 'Ações que valem para todos os agentes.',
    icon: Globe,
    section: 'agente',
    superOnly: true,
    keywords: ['acoes globais', 'regras'],
  },

  {
    id: 'reports',
    label: 'Relatórios',
    hint: 'Relatórios consolidados por período.',
    icon: FileBarChart,
    section: 'analise',
    keywords: ['export', 'csv', 'periodo'],
  },
  {
    id: 'whatsapp',
    label: 'Custo WhatsApp',
    hint: 'Custo por conversa e template na Graph API da Meta.',
    icon: MessageCircle,
    section: 'analise',
    keywords: ['meta', 'billing', 'template', 'custo'],
  },
  {
    id: 'llm',
    label: 'Chamadas IA',
    hint: 'Cada chamada ao modelo, com tokens, latência e custo.',
    icon: Cpu,
    section: 'analise',
    keywords: ['llm', 'openai', 'tokens', 'latencia', 'custo'],
  },
  {
    id: 'prompts',
    label: 'Prompts',
    hint: 'Versões de prompt e o que mudou entre elas.',
    icon: Sparkles,
    section: 'analise',
    keywords: ['versao', 'system prompt', 'historico'],
  },

  {
    id: 'config',
    label: 'Avançado',
    hint: 'Configuração técnica de baixo nível do agente.',
    icon: Settings2,
    section: 'plataforma',
    keywords: ['tecnico', 'config', 'campos'],
  },
  {
    id: 'users',
    label: 'Usuários',
    hint: 'Quem tem acesso ao console e com qual papel.',
    icon: UserCog,
    section: 'plataforma',
    superOnly: true,
    keywords: ['admins', 'permissoes', 'acesso', 'time'],
  },
];

/** Metadados de UMA aba — inclui as que não aparecem na sidebar. */
const EXTRA_LABELS: Partial<Record<AppTab, string>> = {
  wizard: 'Persona',
  playground: 'Playground',
  training: 'Treinar',
  sources: 'Fontes',
  actions: 'Ações',
  captures: 'Captura',
  tools: 'Ferramentas',
};

export function navItem(tab: AppTab): NavItem | undefined {
  return NAV_ITEMS.find((n) => n.id === tab);
}

/** Título humano de qualquer aba — usado no breadcrumb do TopBar. */
export function tabLabel(tab: AppTab): string {
  return navItem(tab)?.label ?? EXTRA_LABELS[tab] ?? 'Console';
}

/** Normaliza pra busca: minúsculo e sem acento. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}
