/**
 * A porta da agenda do escritório e a implementação na Tramitação Inteligente.
 *
 * `AgendaDoEscritorio` é a interface que o resto da Sophia conhece (ocupação de um advogado, evento já existente, criar evento). Trocar de
 * agenda (Google Calendar, por exemplo) é escrever outra implementação, sem mexer na regra do atendimento.
 *
 * Na Tramitação:
 *  - o advogado é um USUÁRIO (`GET /v2/usuarios`), achado pelo nome configurado. Nome que bate em mais de um usuário, ou em nenhum, é erro:
 *    nunca se escolhe "o primeiro" (palpite virando agenda errada);
 *  - a ocupação vem de `GET /v1/atividades?user_id=…&from=…&to=…` (criador OU atribuído), todas as páginas até um teto;
 *  - o evento é `POST /v1/atividades` com o advogado como criador e executor.
 */
import { chaveDaUnidade } from '../integracoes/chaves.js';
import { tramitacaoGet } from '../integracoes/tramitacao.js';
import { criarAtividadeTramitacao } from '../integracoes/tramitacao-escrita.js';
import { logger } from '../logger.js';
import { OFFSET_DO_ESCRITORIO, type Advogado } from './config.js';
import { intervalosOcupados, type Intervalo } from './horarios.js';
import { normalizar } from './texto.js';

export class ErroDaAgenda extends Error {}

export interface EventoNovo {
  titulo: string;
  descricao: string;
  inicio: number;
  fim: number;
}

export interface AgendaDoEscritorio {
  /** Intervalos com hora marcada do advogado entre as duas datas (inclusive). Lança `ErroDaAgenda` se não conseguiu ler. */
  ocupacao(adv: Advogado, deData: string, ateData: string): Promise<Intervalo[]>;
  /** Já existe evento com este título começando neste instante? (idempotência: a tool chamada duas vezes não duplica) */
  jaExiste(adv: Advogado, titulo: string, inicio: number): Promise<boolean>;
  /** Cria o evento com o advogado como responsável. Lança `ErroDaAgenda`. */
  criar(adv: Advogado, evento: EventoNovo): Promise<{ id: string | null }>;
}

interface UsuarioTramitacao {
  id: string;
  name?: string;
}
interface AtividadeLida {
  title?: string;
  start?: string | null;
  end?: string | null;
  all_day?: boolean | null;
  archived_at?: string | null;
}

const MAX_PAGINAS = 5;

export const isoLocal = (ms: number): string => {
  const d = new Date(ms - 3 * 3_600_000).toISOString().slice(0, 19);
  return `${d}${OFFSET_DO_ESCRITORIO}`;
};

/** O usuário pelo nome: todas as palavras do nome configurado têm de estar no nome do usuário. Zero ou mais de um = erro. */
export function acharUsuario(usuarios: readonly UsuarioTramitacao[], adv: Pick<Advogado, 'tramitacao' | 'tramitacaoId' | 'nome'>): string {
  if (adv.tramitacaoId) return adv.tramitacaoId;
  const palavras = normalizar(adv.tramitacao ?? '').split(' ').filter(Boolean);
  if (palavras.length === 0) throw new ErroDaAgenda(`${adv.nome} sem nome configurado para a Tramitação`);
  const achados = usuarios.filter((u) => {
    const nome = ` ${normalizar(u.name ?? '')} `;
    return palavras.every((p) => nome.includes(` ${p} `));
  });
  if (achados.length !== 1) throw new ErroDaAgenda(`${achados.length === 0 ? 'nenhum' : 'mais de um'} usuário da Tramitação bate com o nome de ${adv.nome}: ajuste SOPHIA_ADVOGADOS (tramitacao ou tramitacaoId)`);
  return achados[0]!.id;
}

export function agendaDaTramitacao(unit: { id: string; slug: string }): AgendaDoEscritorio {
  let chave: string | null = null;
  let usuarios: UsuarioTramitacao[] | null = null;
  const ids = new Map<string, string>();

  const chaveDoEscritorio = async (): Promise<string> => {
    if (chave) return chave;
    const c = await chaveDaUnidade(unit.id, 'tramitacao').catch(() => null);
    if (!c) throw new ErroDaAgenda('o escritório não tem a chave da Tramitação cadastrada (painel de integrações)');
    return (chave = c.chave);
  };

  const idDoAdvogado = async (adv: Advogado): Promise<string> => {
    const feito = ids.get(adv.chave);
    if (feito) return feito;
    if (!adv.tramitacaoId && !usuarios) {
      try {
        const r = await tramitacaoGet<{ users?: UsuarioTramitacao[] }>(unit.id, await chaveDoEscritorio(), '/v2/usuarios', { per_page: 100 });
        usuarios = r?.users ?? [];
      } catch (err) {
        throw new ErroDaAgenda(`não consegui listar os usuários da Tramitação: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const id = acharUsuario(usuarios ?? [], adv);
    ids.set(adv.chave, id);
    return id;
  };

  const atividades = async (adv: Advogado, deData: string, ateData: string): Promise<AtividadeLida[]> => {
    const userId = await idDoAdvogado(adv);
    const k = await chaveDoEscritorio();
    const todas: AtividadeLida[] = [];
    try {
      for (let page = 1; page <= MAX_PAGINAS; page++) {
        const r = await tramitacaoGet<{ activities?: AtividadeLida[]; pagination?: { next?: number | null } }>(unit.id, k, '/v1/atividades', {
          user_id: userId,
          from: deData,
          to: ateData,
          per_page: 100,
          page,
        });
        todas.push(...(r?.activities ?? []));
        if (!r?.pagination?.next) return todas;
      }
    } catch (err) {
      throw new ErroDaAgenda(`não consegui ler a agenda de ${adv.nome} na Tramitação: ${err instanceof Error ? err.message : String(err)}`);
    }
    // passou do teto de páginas: agenda lida pela metade NÃO serve para dizer "livre"
    throw new ErroDaAgenda(`a agenda de ${adv.nome} tem atividades demais no período para conferir com segurança`);
  };

  return {
    async ocupacao(adv, deData, ateData) {
      return intervalosOcupados(await atividades(adv, deData, ateData));
    },
    async jaExiste(adv, titulo, inicio) {
      const dia = isoLocal(inicio).slice(0, 10);
      const lidas = await atividades(adv, dia, dia);
      return lidas.some((a) => a.title === titulo && !a.archived_at && a.start && Date.parse(a.start) === inicio);
    },
    async criar(adv, e) {
      const userId = await idDoAdvogado(adv);
      try {
        const r = await criarAtividadeTramitacao(await chaveDoEscritorio(), {
          title: e.titulo,
          description: e.descricao,
          type: 'Event',
          start: isoLocal(e.inicio),
          end: isoLocal(e.fim),
          creator_id: userId,
          assignments: [{ user_id: userId, role: 'executor' }],
        });
        return { id: r.id === null ? null : String(r.id) };
      } catch (err) {
        logger.warn({ unit: unit.slug, err: String(err) }, 'sophia: evento não foi criado na Tramitação');
        throw new ErroDaAgenda(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
