/**
 * A porta do webhook para `calar-paciente-em-tratamento`: junta o que a decisão pura (`paciente-em-tratamento.ts`) precisa
 * (telefone, funil, vínculo com a franquia) e, quando manda calar, deixa a nota. Nunca lança: qualquer falha = a Sofia responde.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient } from '../services/kommo.service.js';
import { esquemaDaUnidade } from './kommo-schema.js';
import { contatoPrincipal } from './kommo-lead-util.js';
import { avisoRecente, marcarAviso } from './aviso-dedupe.js';
import { agendarIndice } from './franquia-indice-telefones.js';
import { ehNumeroInterno, lerNumerosInternos } from './numeros-internos.js';
import {
  calarPacienteEstado,
  consultarFranquia,
  decidir,
  notaNumeroInterno,
  notaPacienteEmTratamento,
  ehFunilComercial,
  precisaConsultarFranquia,
  REGRA_NOTA_INTERNO,
  REGRA_NOTA_PACIENTE,
  type Decisao,
  type SinalDaFranquia,
} from './paciente-em-tratamento.js';
import type { Estado } from './automacoes-estado.js';

export interface ResultadoDaPorta {
  estado: Exclude<Estado, 'desligado'>;
  decisao: Decisao;
  sinal: SinalDaFranquia | null;
  /** a nota foi deixada agora (só no estado ligado, 1x/dia por lead) */
  anotou: boolean;
}

/** `null` = chave desligada, ou nada a decidir (falha ao ler o cartão): a Sofia segue como sempre. */
export async function portaPacienteEmTratamento(args: { unit: Unit; leadId: number; contactId: string | null; humanMessage: string }): Promise<ResultadoDaPorta | null> {
  const { unit, leadId, contactId, humanMessage } = args;
  const estado = calarPacienteEstado(unit.slug);
  if (estado === 'desligado') return null;
  try {
    const kommo = createKommoClient(unit);
    const lead = await kommo.getLead(leadId);
    let funil: string | null = null;
    try {
      if (lead.pipeline_id && lead.status_id) funil = (await esquemaDaUnidade(unit, kommo)).nomeDoStatus(lead.pipeline_id, lead.status_id)?.pipeline ?? null;
    } catch (err) {
      logger.warn({ err: String(err), unit: unit.slug, leadId }, 'paciente-em-tratamento: não li o esquema da conta (segue sem calar)');
    }
    // fora do COMERCIAL e sem lista de internos não há o que decidir: nem telefone, nem banco, nem franquia
    if (!ehFunilComercial(funil) && lerNumerosInternos().chaves.size === 0) return null;

    const idContato = contactId && Number.isFinite(Number(contactId)) ? Number(contactId) : contatoPrincipal(lead);
    const telefone = idContato ? await kommo.getContactPhone(idContato).catch(() => null) : null;

    const interno = !!telefone && ehNumeroInterno(telefone);
    const temIdClient = interno
      ? false
      : !!(await prisma.spineLeadLink.findFirst({ where: { unitId: unit.id, kommoLeadId: leadId, spineIdClient: { not: null } }, select: { id: true } }));
    const base = { interno, temIdClient, funil };
    let sinal: SinalDaFranquia | null = null;
    if (precisaConsultarFranquia(base)) {
      // o índice de telefones da franquia precisa existir para a pergunta ter resposta; é idempotente (1 carga por dia)
      agendarIndice(unit);
      sinal = await consultarFranquia(unit, telefone);
    }
    const decisao = decidir({ ...base, sinal });

    let anotou = false;
    if (decisao.calar && estado === 'ligado') {
      const regra = decisao.motivo === 'numero_interno' ? REGRA_NOTA_INTERNO : REGRA_NOTA_PACIENTE;
      if (!(await avisoRecente(unit.id, leadId, regra))) {
        const texto = decisao.motivo === 'numero_interno' ? notaNumeroInterno(humanMessage) : notaPacienteEmTratamento(humanMessage);
        try {
          const nota = await kommo.addLeadNote(leadId, texto);
          if (nota?.id) {
            await marcarAviso(unit.id, leadId, regra);
            anotou = true;
          }
        } catch (err) {
          logger.warn({ err: String(err), unit: unit.slug, leadId }, 'paciente-em-tratamento: falha ao deixar a nota (segue calada)');
        }
      }
    }
    return { estado, decisao, sinal, anotou };
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId }, 'paciente-em-tratamento: porta falhou — a Sofia responde como sempre');
    return null;
  }
}
