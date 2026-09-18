/**
 * "Digitando…" e confirmação de leitura, disparados pelo n8n.
 *
 * Por que o n8n e não daqui: a Meta EXIGE o id da mensagem do paciente (`wamid`)
 * junto com `status:'read'` — testado em 18/09/2026, não existe caminho só com o
 * telefone. E o `wamid` só existe no webhook cru da Meta, que chega no workflow
 * de rastreio CTWA. O nosso webhook vem do Kommo e não carrega esse id.
 *
 * Então a divisão fica: o n8n tem o dado, nós temos a DECISÃO. Ele manda o
 * `wamid`; aqui a gente checa se a IA vai mesmo responder antes de acender o
 * tique azul — porque tique azul é promessa, e promessa sem resposta atrás é
 * pior do que silêncio.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { emPausa } from '../lib/pausa-unidade.js';
import { checkBusinessHours } from '../agent/prompt-composer.js';
import {
  credenciaisDaUnidade,
  devoAvisarQueEstouDigitando,
  marcarLidaEDigitando,
} from '../lib/whatsapp-meta.js';

const esquema = z.object({
  wamid: z.string().min(10).max(300),
  /** Telefone do paciente, só para achar a conversa e ver se um humano assumiu. */
  telefone: z.string().min(8).max(20).optional(),
});

/** Últimos 8 dígitos: o mesmo casamento usado no resto do sistema. */
function chaveTelefone(t: string): string {
  return t.replace(/\D/g, '').slice(-8);
}

export async function digitandoHandler(req: Request, res: Response): Promise<void> {
  const slug = String(req.params.slug ?? '');
  const parsed = esquema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ erro: 'wamid obrigatório' });
    return;
  }

  const unit = await prisma.unit.findUnique({ where: { slug } });
  if (!unit || !unit.isActive) {
    res.status(404).json({ erro: 'unidade não encontrada' });
    return;
  }

  const cred = credenciaisDaUnidade(unit);
  if (!cred) {
    // Não é erro: a maioria das unidades ainda não tem a conta da Meta atribuída.
    res.json({ enviado: false, motivo: 'unidade sem credencial da Meta' });
    return;
  }

  // Um humano assumiu esta conversa? Aí o tique azul mente — quem responde não
  // é a IA, e pode demorar.
  let comHumano = false;
  if (parsed.data.telefone) {
    const chave = chaveTelefone(parsed.data.telefone);
    if (chave.length === 8) {
      const conversa = await prisma.conversation
        .findFirst({
          where: { unitId: unit.id, leadId: { endsWith: chave } },
          orderBy: { lastMessageAt: 'desc' },
          select: { handoffAt: true },
        })
        .catch(() => null);
      comHumano = Boolean(conversa?.handoffAt);
    }
  }

  const horas = checkBusinessHours(unit);
  const pode = devoAvisarQueEstouDigitando({
    pausada: emPausa(unit),
    foraDoHorario: horas.enabled && !horas.isOpen,
    comHumano,
  });

  if (!pode) {
    res.json({ enviado: false, motivo: 'a IA não vai responder agora' });
    return;
  }

  const ok = await marcarLidaEDigitando(cred, parsed.data.wamid).catch((err) => {
    logger.warn({ err: String(err), unit: slug }, 'digitando: chamada à Meta falhou');
    return false;
  });
  res.json({ enviado: ok });
}
