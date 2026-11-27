/**
 * PONTO DE ENTRADA do vigia da rede (PR `feat(vigia-rede)`, outro pleno). Quem detecta um problema chama
 * `registrarEventoDaVigia` e pronto: o evento entra na fila do Joaoof, que o lê na próxima triagem junto com os grupos e decide se é demanda
 * (e se é urgente). Nada aqui manda Telegram: o aviso é decisão da triagem + `avisos.ts` (um por assunto, com teto por dia).
 *
 *   import { registrarEventoDaVigia } from '../joaoof/vigia.js';
 *   await registrarEventoDaVigia({ id: 'sofia-parou:parauapebas:2026-11-27T14', unidadeSlug: 'doutor-hernia-parauapebas',
 *                                  tipo: 'sofia_parada', severidade: 'critico', texto: 'Sofia sem responder há 42 min (7 conversas)' });
 *
 * `id` deve ser ESTÁVEL para o mesmo problema (o par fonte+id é único): o mesmo evento repetido a cada varredura não vira dez.
 * Desligado (JOAOOF_LIGADO) não grava nada; nunca lança (o vigia não pode cair por causa do Joaoof).
 */
import { cortar, mascarar, trechoCurto } from './privacidade.js';
import type { EntradaRepo } from './entrada.js';
import type { ModoJoaoof } from './config.js';

export interface EventoDaVigia {
  id: string;
  unidadeSlug?: string | null;
  /** livre, curto: sofia_parada, token_vencido, backup_falhou, webhook_mudo… */
  tipo: string;
  severidade: 'info' | 'aviso' | 'critico';
  texto: string;
  em?: Date;
}

export interface DepsVigia {
  entradas: EntradaRepo;
  modo: () => ModoJoaoof;
  agora: () => Date;
}

export async function registrarEvento(deps: DepsVigia, e: EventoDaVigia): Promise<'registrado' | 'repetido' | 'desligado' | 'invalido'> {
  if (deps.modo() === 'desligado') return 'desligado';
  const id = cortar(String(e.id ?? '').trim(), 160);
  if (!id || !String(e.texto ?? '').trim()) return 'invalido';
  try {
    const n = await deps.entradas.inserir([
      {
        fonte: 'vigia',
        ref: `vigia:${id}`,
        unidadeSlug: e.unidadeSlug ?? null,
        autorNome: 'vigia',
        autorChave: null,
        severidade: e.severidade,
        texto: trechoCurto(`[${cortar(mascarar(e.tipo), 40)}] ${e.texto}`, 1000),
        escritaEm: e.em ?? deps.agora(),
      },
    ]);
    return n > 0 ? 'registrado' : 'repetido';
  } catch {
    return 'invalido';
  }
}

/** A porta para quem está fora do módulo: fiação real (banco + chave), carregada só no uso, e que NUNCA lança. */
export async function registrarEventoDaVigia(e: EventoDaVigia): Promise<'registrado' | 'repetido' | 'desligado' | 'invalido'> {
  try {
    const { registrarEventoReal } = await import('./producao.js');
    return await registrarEventoReal(e);
  } catch {
    return 'invalido';
  }
}
