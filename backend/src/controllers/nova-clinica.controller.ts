/**
 * Formulário público «nova clínica» (16/11/2026): `GET /nova-clinica/:codigo` (a página) e `POST /api/public/nova-clinica/:codigo` (o envio).
 * Molde: as páginas /pausa e /aprendizados (rota pública protegida por código), com três diferenças de segurança de propósito:
 *   - o código é de USO ÚNICO, vale 14 dias e é guardado só como hash (ver `lib/kit-unidade/convites.ts`);
 *   - código errado, vencido, usado ou revogado dão EXATAMENTE a mesma resposta (404 igual): quem chuta não descobre qual existe;
 *   - limite de taxa por IP (e um teto global no envio), corpo máximo de 64 KB e a página nunca é guardada em cache nem indexada.
 *
 * O envio grava as respostas no banco do agente e AVISA o João pelo canal de sempre (`avisarJoao`: WhatsApp). O aviso leva só nome da clínica, cidade e quem
 * preencheu — nunca e-mail, telefone nem Pix. Nada do corpo vai para o log.
 */
import { randomBytes } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { avisarJoao } from '../lib/alerta-whatsapp.js';
import { logger } from '../lib/logger.js';
import { criarLimitador, ipDoCliente, type Limitador } from '../lib/limite-taxa.js';
import { conviteAberto, registrarEnvio, type BancoConvites } from '../lib/kit-unidade/convites.js';
import { bancoConvitesPrisma } from '../lib/kit-unidade/convites-prisma.js';
import { validarFormulario } from '../lib/kit-unidade/formulario.js';
import { paginaDoFormulario, paginaLinkInvalido, paginaMuitasTentativas } from '../lib/kit-unidade/formulario-pagina.js';

export const LIMITE_DO_CORPO = '64kb';

export interface DepsNovaClinica {
  banco: BancoConvites;
  avisar: (texto: string, chave: string) => Promise<unknown>;
  agora: () => Date;
  limites: { pagina: Limitador; codigoErrado: Limitador; envio: Limitador; tentativas: Limitador; envioGlobal: Limitador };
}

export function limitesPadrao(agora: () => number = Date.now): DepsNovaClinica['limites'] {
  return {
    pagina: criarLimitador({ max: 60, janelaMs: 10 * 60_000, agora }), // abrir a página
    codigoErrado: criarLimitador({ max: 10, janelaMs: 10 * 60_000, agora }), // chutes de código por IP
    envio: criarLimitador({ max: 10, janelaMs: 60 * 60_000, agora }), // envios ACEITOS por IP (quem erra o formulário e corrige não fica preso)
    tentativas: criarLimitador({ max: 60, janelaMs: 60 * 60_000, agora }), // QUALQUER POST por IP, aceito ou não (inclusive os 422): folga larga para corrigir erros
    envioGlobal: criarLimitador({ max: 100, janelaMs: 60 * 60_000, agora }), // envios no total: cobre IP mal detectado
  };
}

const padrao = (): DepsNovaClinica => ({
  banco: bancoConvitesPrisma,
  avisar: (texto, chave) => avisarJoao(texto, chave, 1),
  agora: () => new Date(),
  limites: limitesPadrao(),
});

/** Cabeçalhos de toda resposta: sem cache, sem indexar, sem vazar o endereço (que leva o código) por Referer. `nonce` libera só o script/estilo da própria página. */
function cabecalhos(res: Response, nonce?: string): void {
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': nonce
      ? `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`
      : "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  });
}

function muitasTentativas(res: Response, esperarSeg: number): void {
  cabecalhos(res);
  res.set('Retry-After', String(esperarSeg)).status(429).json({ erro: 'muitas_tentativas', esperarSeg });
}

/** O 429 da PÁGINA (quem abre o link no navegador) é uma tela amigável, não JSON cru. */
function muitasTentativasNaPagina(res: Response, esperarSeg: number): void {
  const nonce = randomBytes(16).toString('base64');
  cabecalhos(res, nonce);
  res.set('Retry-After', String(esperarSeg)).status(429).type('html').send(paginaMuitasTentativas(nonce, esperarSeg));
}

export function criarManipuladores(deps: DepsNovaClinica = padrao()) {
  /** O IP já passou do limite de chutes? Confere ANTES de olhar o código (bloqueado é bloqueado, com código certo ou errado: não há oráculo). */
  const bloqueadoPorChutes = (ip: string) => deps.limites.codigoErrado.espiar(ip);
  /** Conta um chute errado. */
  const contarChute = (ip: string) => void deps.limites.codigoErrado.tentar(ip);

  async function pagina(req: Request, res: Response): Promise<void> {
    const ip = ipDoCliente(req);
    const lim = deps.limites.pagina.tentar(ip);
    if (!lim.ok) return muitasTentativasNaPagina(res, lim.esperarSeg);
    const bloqueio = bloqueadoPorChutes(ip);
    if (!bloqueio.ok) return muitasTentativasNaPagina(res, bloqueio.esperarSeg);
    const nonce = randomBytes(16).toString('base64');
    const aberto = await conviteAberto(deps.banco, req.params.codigo, deps.agora());
    if (!aberto) {
      contarChute(ip);
      cabecalhos(res, nonce);
      res.status(404).type('html').send(paginaLinkInvalido(nonce));
      return;
    }
    cabecalhos(res, nonce);
    res.type('html').send(paginaDoFormulario(nonce));
  }

  async function enviar(req: Request, res: Response): Promise<void> {
    const ip = ipDoCliente(req);
    const codigo = req.params.codigo;
    const bloqueio = bloqueadoPorChutes(ip);
    if (!bloqueio.ok) return muitasTentativas(res, bloqueio.esperarSeg);
    const aberto = await conviteAberto(deps.banco, codigo, deps.agora());
    if (!aberto) {
      contarChute(ip);
      cabecalhos(res);
      res.status(404).json({ erro: 'link_invalido' });
      return;
    }
    // o teto GLOBAL só conta envio ACEITO (código válido E dados certos): quem chuta, ou erra o formulário, não gasta a vez dos franqueados de verdade
    const global = deps.limites.envioGlobal.espiar('global');
    if (!global.ok) return muitasTentativas(res, global.esperarSeg);
    const v = validarFormulario(req.body);
    if (!v.ok) {
      cabecalhos(res);
      res.status(422).json({ erro: 'dados_invalidos', campos: v.campos });
      return;
    }
    const gravado = await registrarEnvio(deps.banco, codigo, v.respostas, deps.agora());
    if (gravado) {
      // só o envio ACEITO conta (para o limite de 10 por hora por IP e para o teto global)
      deps.limites.envio.tentar(ip);
      deps.limites.envioGlobal.tentar('global');
    }
    if (!gravado) {
      // perdeu a corrida (outro envio ou vencimento entre a conferência e a gravação): mesma resposta de link inválido
      cabecalhos(res);
      res.status(404).json({ erro: 'link_invalido' });
      return;
    }
    const r = v.respostas;
    // só o id vai para o log; nome de pessoa, e-mail, telefone e Pix nunca (o aviso leva só o nome da clínica e a cidade, que são públicos, sem quebra de linha)
    logger.info({ convite: gravado.id }, 'nova-clinica: formulário recebido');
    const umaLinha = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, 80);
    void deps
      .avisar(`📝 Formulário de nova clínica recebido: ${umaLinha(r.clinica.nome)} (${umaLinha(r.clinica.cidade)}/${r.clinica.uf}). Código do formulário: ${gravado.id}.`, `nova-clinica:${gravado.id}`)
      .catch((err) => logger.warn({ err: String(err) }, 'nova-clinica: aviso ao João falhou (o formulário está gravado)'));
    cabecalhos(res);
    res.json({ ok: true, referencia: gravado.id.slice(-6).toLowerCase() });
  }

  /** Antes de ler o corpo: um envio gigante ou repetido também conta. */
  function limitarEnvio(req: Request, res: Response, next: NextFunction): void {
    const ip = ipDoCliente(req);
    const todas = deps.limites.tentativas.tentar(ip);
    if (!todas.ok) return muitasTentativas(res, todas.esperarSeg);
    const aceitos = deps.limites.envio.espiar(ip);
    if (!aceitos.ok) return muitasTentativas(res, aceitos.esperarSeg);
    next();
  }

  /** Corpo grande ou JSON quebrado: resposta curta e igual para todos, sem eco do que veio. */
  function erroDoCorpo(err: unknown, _req: Request, res: Response, next: NextFunction): void {
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.too.large') {
      cabecalhos(res);
      res.status(413).json({ erro: 'corpo_grande_demais' });
      return;
    }
    if (e?.type === 'entity.parse.failed' || e?.status === 400) {
      cabecalhos(res);
      res.status(400).json({ erro: 'corpo_invalido' });
      return;
    }
    next(err);
  }

  return { pagina, enviar, erroDoCorpo, limitarEnvio };
}

/**
 * Liga as duas rotas. Tem de entrar ANTES do `express.json` geral do servidor: o corpo é lido aqui com teto de 64 KB (o geral aceita 1 MB), e o geral não relê
 * o que já foi lido. Os limites de taxa rodam antes do parser, então um envio gigante também conta.
 */
export function ligarNovaClinica(app: Express, deps: DepsNovaClinica = padrao()): void {
  const h = criarManipuladores(deps);
  const trata = (f: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
    f(req, res).catch((err) => {
      logger.error({ err: String(err) }, 'nova-clinica: erro inesperado');
      if (!res.headersSent) {
        cabecalhos(res);
        res.status(500).json({ erro: 'erro_interno' });
      } else next(err);
    });
  };
  app.get('/nova-clinica/:codigo', trata(h.pagina));
  app.post('/api/public/nova-clinica/:codigo', h.limitarEnvio, express.json({ limit: LIMITE_DO_CORPO }), h.erroDoCorpo, trata(h.enviar));
}
