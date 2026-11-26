/**
 * A porta da NOTA FISCAL do Caixa no agente-dt (separada da porta do link: caixa-interno.ts). Pede e consulta a nota de um LANÇAMENTO do Caixa e avisa quando o lançamento muda depois da nota.
 * Mesma porta de serviço (pedido ASSINADO, x-dd-timestamp + x-dd-assinatura) e mesmo contador de erros por IP do link.
 *
 *  - EMITIR só nas unidades de CAIXA_NOTA_UNIDADES (vazio = nenhuma) E com um emissor registrado (lib/caixa-nota.ts; a Focus, PR #500). Sem emissor: 501 e nada é emitido.
 *    Tirar a unidade da lista fecha SÓ a emissão: consultar uma nota que já saiu e AVISAR «cancelar a nota» seguem valendo (uma nota válida não pode ficar sem alerta);
 *  - a nota é por lançamento (`lanc_id`): a idempotência é do emissor; o valor vem da função do RH, que o leu no banco dela (o agente-dt não acessa o banco do Caixa);
 *  - o CPF/CNPJ e o nome de quem paga passam só na memória até o emissor: nunca no log, no Telegram nem na resposta;
 *  - `/nota/revisao` só AVISA («cancelar a nota»); nunca cancela nada.
 */
import type { Express } from 'express';
import { z } from 'zod';
import { emissorDeNotaDoCaixa, unidadesComNotaDoCaixa } from '../lib/caixa-nota.js';
import { criarPorta, Recusa, SLUG, type DepsCaixaInterno } from './caixa-interno.js';
import type { JanelaDeContagem } from './limites.js';

const CorpoNota = z.object({
  unidade: SLUG,
  lanc_id: z.string().uuid(),
  valor_centavos: z.number().int().min(100).max(100_000_000),
  competencia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => { const t = Date.parse(`${d}T00:00:00Z`); return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d; }, { message: 'data inválida' }),
  tomador: z.object({ nome: z.string().trim().min(3).max(120), documento: z.string().max(20) }),
});

const CorpoRevisao = z.object({
  unidade: SLUG,
  lanc_id: z.string().uuid(),
  motivo: z.enum(['cancelado', 'divergente', 'valor_alterado']),
});

const CONSULTA_NOTA = z.object({ unidade: SLUG, lanc_id: z.string().uuid() });

/** CPF (11) ou CNPJ (14) com os dígitos verificadores certos. Sem isso o emissor recusaria depois, e o erro apareceria longe da tela. */
export function documentoValido(bruto: string): string | null {
  const d = bruto.replace(/\D/g, '');
  if (d.length === 11) {
    if (/^(\d)\1+$/.test(d)) return null;
    const dv = (n: number) => {
      let s = 0;
      for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i);
      const r = (s * 10) % 11;
      return r === 10 ? 0 : r;
    };
    return dv(9) === Number(d[9]) && dv(10) === Number(d[10]) ? d : null;
  }
  if (d.length === 14) {
    if (/^(\d)\1+$/.test(d)) return null;
    const dv = (n: number) => {
      const pesos = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
      const s = pesos.reduce((acc, p, i) => acc + p * Number(d[i]), 0);
      const r = s % 11;
      return r < 2 ? 0 : 11 - r;
    };
    return dv(12) === Number(d[12]) && dv(13) === Number(d[13]) ? d : null;
  }
  return null;
}

const curto = (id: string) => id.slice(0, 8);

export interface DepsNotaInterno extends Pick<DepsCaixaInterno, 'token' | 'alertar' | 'agora' | 'log'> {
  unidadesNota?: () => Set<string>;
}

export function montarRotasDaNotaDoCaixa(app: Express, d: DepsNotaInterno, o: { falhasPorIp?: JanelaDeContagem } = {}): boolean {
  if (!d.token) return false;
  const { porta, responder } = criarPorta(d, o);
  const agora = d.agora ?? Date.now;
  const unidadesNota = d.unidadesNota ?? (() => unidadesComNotaDoCaixa());
  const avisados = new Map<string, number>();

  const unidadeDaNota = (slug: string): string => {
    if (!unidadesNota().has(slug)) throw new Recusa(403, `a nota fiscal do Caixa não está ligada na unidade ${slug} (CAIXA_NOTA_UNIDADES; só o João liga)`);
    return slug;
  };
  const emissor = () => {
    const e = emissorDeNotaDoCaixa();
    if (!e) throw new Recusa(501, 'a nota fiscal (Focus NFe) ainda não está no ar neste servidor: nada foi emitido');
    return e;
  };

  app.post('/interno/caixa/nota', porta, (req, res) =>
    responder(res, async () => {
      const c = CorpoNota.parse(req.body);
      const unidade = unidadeDaNota(c.unidade);
      const documento = documentoValido(c.tomador.documento);
      if (!documento) throw new Recusa(422, 'CPF ou CNPJ de quem paga inválido (confira os dígitos): nenhuma nota foi pedida');
      const r = await emissor().emitir({ unidade, lancId: c.lanc_id, valorCentavos: c.valor_centavos, competencia: c.competencia, tomador: { nome: c.tomador.nome, documento } });
      return { nota: r };
    }),
  );

  app.get('/interno/caixa/nota', porta, (req, res) =>
    responder(res, async () => {
      const q = CONSULTA_NOTA.parse(req.query);
      // consultar NÃO depende da lista de unidades (só da emissão)
      return { nota: await emissor().consultar(q.unidade, q.lanc_id) };
    }),
  );

  // O lançamento da nota foi cancelado ou mudou depois que a nota saiu: avisa a pessoa de carne e osso. NUNCA cancela nada sozinho (cancelar nota tem prazo e regra da prefeitura).
  app.post('/interno/caixa/nota/revisao', porta, (req, res) =>
    responder(res, async () => {
      const c = CorpoRevisao.parse(req.body);
      emissor(); // sem emissor não há nota para revisar (501)
      const unidade = c.unidade; // avisar NÃO depende da lista de unidades (só da emissão)
      const chave = `${unidade}|${c.lanc_id}|${c.motivo}`;
      const t = agora();
      for (const [k, em] of avisados) if (t - em > 3_600_000) avisados.delete(k);
      const repetido = avisados.has(chave);
      if (!repetido) {
        const motivo = c.motivo === 'cancelado' ? 'o lançamento foi CANCELADO' : c.motivo === 'divergente' ? 'o lançamento foi marcado DIVERGENTE' : 'o VALOR do lançamento mudou';
        avisados.set(chave, t); // marca ANTES de esperar o Telegram: duas chamadas ao mesmo tempo não mandam o alerta duas vezes
        const saiu = await d.alertar(`🧾 Caixa (${unidade}): ${motivo} depois de a nota fiscal ser pedida. CANCELAR A NOTA do lançamento ${curto(c.lanc_id)} (a nota não é cancelada sozinha).`).catch(() => false);
        // o aviso que NÃO saiu não conta como avisado: o RH recebe 502 e repete (a marca no banco dele continua aberta)
        if (!saiu) { avisados.delete(chave); throw new Recusa(502, 'o aviso ao João não saiu (Telegram); tente de novo'); }
      }
      return { avisado: !repetido };
    }),
  );

  return true;
}
