/**
 * Lê o histórico da Kommo de UMA unidade e escreve o arquivo que o importador do CRM (ops/crm-historico-kommo, Ruby) lê. Roda DENTRO do
 * contêiner do agente, na VPS: nome, telefone e mensagem de paciente nunca saem dela. A tela e o log levam só contagens; o token da Kommo nunca é impresso.
 *
 *   node dist/scripts/kommo-historico-exportar.js --unidade=doutor-hernia-timbo --so-conferir             # só conta (e mede uma amostra de conversas)
 *   node dist/scripts/kommo-historico-exportar.js --unidade=doutor-hernia-timbo --saida=/tmp/x.jsonl      # lê tudo e escreve o arquivo (modo 600)
 *   opções: --limite=N (só os N cartões mais recentes; N > 0)
 *
 * Escopo (escolha B do João, 25/11/2026): TODOS os cartões abertos (Comercial e Tratamento) + ganhos e perdidos dos últimos 6 meses.
 * Linhas começando com `LOG ` são as que o ops/*.sh mostra.
 */
import { closeSync, openSync, writeSync } from 'node:fs';
import { prisma } from '../lib/prisma.js';
import { createKommoClientSemFreio } from '../services/kommo.service.js';
import { ehArquivo } from '../lib/chatwoot-regua.js';
import { eventosAlcancados } from '../lib/chatwoot-capi.js';
import { exportar, inicioDosFechados, type Ambiente, type PortaKommo } from '../lib/kommo-historico-leitura.js';

const arg = (nome: string): string | undefined => process.argv.find((a) => a.startsWith(`--${nome}=`))?.slice(nome.length + 3);
class ErroDeUso extends Error {}
const SECO = process.argv.includes('--so-conferir');
const log = (t: string) => console.log(`LOG ${new Date().toISOString().slice(11, 19)} ${t}`);

async function main(): Promise<void> {
  const slug = arg('unidade') ?? '';
  if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(slug)) throw new ErroDeUso('falta --unidade=<slug> válido');
  const limiteTxt = arg('limite');
  const limite = limiteTxt === undefined ? undefined : Number(limiteTxt);
  if (limiteTxt !== undefined && (!Number.isInteger(limite) || (limite as number) <= 0)) throw new ErroDeUso('--limite precisa ser um inteiro maior que zero (0 não significa «sem limite»: tire a opção)');
  const saida = arg('saida');
  if (!SECO && !saida) throw new ErroDeUso('falta --saida=<arquivo> (ou use --so-conferir)');

  const unit = await prisma.unit.findUnique({ where: { slug } });
  if (!unit?.kommoSubdomain || !unit.kommoAccessToken) throw new ErroDeUso('unidade ou credencial da Kommo ausente');
  const kommo = createKommoClientSemFreio(unit);
  const amb: Ambiente = { porta: kommo as unknown as PortaKommo, eventosCapi: eventosAlcancados, pausa: (ms) => new Promise((r) => setTimeout(r, ms)), agora: () => new Date(), log };

  log(`${SECO ? 'CONFERÊNCIA EM SECO (nada é escrito)' : 'EXPORTANDO'} — unidade ${slug}${limite ? `, limite ${limite} cartões` : ''}; fechados desde ${new Date(inicioDosFechados(new Date()) * 1000).toISOString().slice(0, 10)}`);
  // a conta do Chatwoot desta unidade (unit_chatwoot): vai no cabeçalho e o importador RECUSA gravar em outra (nunca a 1, a de Parauapebas)
  const cfg = await prisma.unitChatwoot.findUnique({ where: { unitId: unit.id } });
  const contaId = cfg?.contaId ?? null;
  if (!contaId || contaId <= 1) throw new ErroDeUso('a unidade não tem conta própria do Chatwoot em unit_chatwoot (conta_id vazio ou 1): não exporto');
  const fd = saida ? openSync(saida, 'w', 0o600) : null;
  try {
    if (fd !== null) writeSync(fd, `${JSON.stringify({ tipo: 'cabecalho', v: 1, unidade: slug, conta_id: contaId, gerado_em: Math.floor(Date.now() / 1000), fechados_desde: inicioDosFechados(new Date()) })}\n`);
    const r = await exportar(amb, { gravar: !SECO, arquivo: ehArquivo, ...(limite ? { limite } : {}), entregar: (l) => { if (fd !== null) writeSync(fd, `${JSON.stringify(l)}\n`); } });
    log(`RESUMO cartões=${r.cartoes} abertos=${r.abertos} fechados_6m=${r.fechados} fechados_fora_da_janela=${r.fechadosForaDaJanela} cartoes_lidos_na_conta=${r.lidosNaConta} recuperados_na_2a_passada=${r.recuperadosNaPaginacao} sem_etapa_conhecida=${r.semEtapaConhecida}`);
    for (const [etapa, n] of Object.entries(r.porEtapa).sort()) log(`ETAPA ${etapa} = ${n}`);
    log(`TELEFONE sem=${r.semTelefone} invalido=${r.telefoneInvalido} sem_contato=${r.semContato} distintos=${r.telefonesDistintos} repetidos_em_mais_de_um_cartao=${r.telefonesRepetidos}`);
    log(`CONVERSA ${SECO ? `amostra=${r.amostra}` : `lidas=${r.amostra}`} sem_conversa=${r.semConversa} falhas_de_leitura=${r.falhasDeLeitura} com_mensagem=${r.cartoesComMensagem} mensagens=${r.mensagens}${SECO ? ` estimativa_total=${r.mensagensEstimadas}` : ''} segundos_por_cartao=${r.segundosPorCartao}`);
    log(`CONSULTA_DE_PE_FORA_DO_DESTINO = ${r.consultaDePeForaDoDestino} (telefones com consulta de pé em que a próxima mensagem do paciente cairia em OUTRO cartão; meta 0) · telefones_com_varias_consultas_de_pe=${r.telefonesComVariasConsultasDePe}`);
    log(`VIVAS_FORA_DAS_200_MAIS_RECENTES = ${r.vivasForaDoTopo} (conversas que nascem vivas e o quadro/Hoje não mostrariam; meta 0; só conta as importadas, não as que já existem na caixa)`);
    log(`NASCEM_VIVAS = ${r.nascemVivas} (ESTIMATIVA MÁXIMA: cartões com consulta de pé, cuja conversa já nasce VIVA e recebe os lembretes do CRM — só se a conta definir os atributos de consulta; as demais nascem arquivo até o paciente voltar)`);
    if (SECO) log(`DURACAO estimada da exportação = ${r.duracaoEstimadaMin} min`);
    for (const [a, n] of Object.entries(r.avisos).sort()) log(`AVISO ${a} = ${n}`);
    if (!SECO) log(`ARQUIVO linhas=${r.linhasGravadas}`);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    log('FIM');
  })
  .catch(async (e) => {
    // só a mensagem das NOSSAS recusas de uso; erro da Kommo/axios pode trazer URL com telefone: vai só a classe e o status
    // KommoApiError traz `.status`; o axios cru traz `.response.status`
    const status = (e as { status?: number })?.status ?? (e as { response?: { status?: number } })?.response?.status;
    log(`ERRO FATAL (${e instanceof ErroDeUso ? e.message : `${e instanceof Error ? e.name : 'erro'}${status ? ` http ${status}` : ''}`})`);
    await prisma.$disconnect().catch(() => undefined);
    log('FIM');
    process.exit(1);
  });
