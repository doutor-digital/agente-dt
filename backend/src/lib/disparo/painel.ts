/**
 * A tela de aprovação de uma onda, montada no servidor. Pura (sem banco), para o teste ler a página.
 *
 * Mostra o que o João precisa ver ANTES de liberar: a unidade, quantas pessoas, o texto final com as variáveis
 * resolvidas, quem ficou de fora e por quê, uma amostra de destinatários, os freios e em que modo a unidade está.
 * O botão manda de volta o `total` e a `impressao` que a página mostrou: se a lista mudou no meio, a aprovação é recusada.
 */
import { ROTULO_DA_EXCLUSAO, textoFinal, valoresDasVariaveis, type MotivoDeExclusao } from './regras.js';
import type { Freios } from './freios.js';
import type { Modo } from './lote.js';
import type { Definicao } from './modelo.js';
import type { QuemSaiu } from './saidas.js';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** +55 63 9••••-••43: dá para o João reconhecer, não para a página circular com o telefone inteiro. */
export function telefoneMascarado(tel: string): string {
  if (!/^\d{12,13}$/.test(tel)) return '••••';
  return `+${tel.slice(0, 2)} ${tel.slice(2, 4)} 9••••-••${tel.slice(-2)}`;
}

/** Quantas pessoas a tabela por pessoa mostra no máximo; passando disso a página avisa que cortou. */
export const LIMITE_DA_TABELA = 200;

/** Uma linha da tabela por pessoa. Só o que já está no banco: nada de entregue/lida (isso depende do webhook de status da Meta). */
export interface LinhaDoDestinatario {
  nome: string;
  telefone: string;
  estado: string;
  motivo: string | null;
  enviadoEm: Date | null;
  /** modo seco: quando o "receberia" foi gravado (não é envio) */
  simuladoEm: Date | null;
  kommoLeadId: number | null;
}

/** O que a ordenação precisa além da linha: quando a pessoa foi atualizada e criada. */
export type LinhaOrdenavel = Pick<LinhaDoDestinatario, 'estado' | 'enviadoEm'> & { atualizadoEm: Date; criadoEm: Date; id?: string };

/** 0 = enviados (e enviando), 1 = falhas e descartes, 2 = pendentes (inclui os adiados e o seco). */
function grupoDoEstado(estado: string): number {
  if (estado === 'enviado' || estado === 'enviando') return 0;
  if (estado === 'pendente') return 2;
  return 1;
}

/**
 * Mostra: enviados (o mais recente primeiro), depois falhas/saídas/descartes (o mais recente primeiro) e, por fim, os
 * pendentes na ordem da fila. Quando passa do `limite`, a PRIORIDADE de quem fica é outra: falhas primeiro (é o que o
 * João precisa ver e quase nunca são muitas), depois enviados, depois pendentes. Assim 300 enviados não escondem 3 falhas.
 * Pura: a tela busca um pedaço de cada grupo e esta função decide.
 */
export function ordenarDestinatarios<T extends LinhaOrdenavel>(linhas: T[], limite = LIMITE_DA_TABELA): T[] {
  // Enviado vale a hora do envio; falha/SAIR/descarte valem a última atualização (é quando aconteceu), como na consulta.
  const quando = (l: T) => (grupoDoEstado(l.estado) === 0 ? (l.enviadoEm ?? l.atualizadoEm) : l.atualizadoEm).getTime();
  // Pendentes na ordem em que o worker os pega (`porto.pendentes`: atualizadoEm, id): quem foi adiado vai para o fim da fila.
  const filaDoWorker = (a: T, b: T) => a.atualizadoEm.getTime() - b.atualizadoEm.getTime() || (a.id ?? '').localeCompare(b.id ?? '');
  const dentroDoGrupo = (a: T, b: T) => (grupoDoEstado(a.estado) === 2 ? filaDoWorker(a, b) : quando(b) - quando(a));
  const porGrupo = [0, 1, 2].map((g) => linhas.filter((l) => grupoDoEstado(l.estado) === g).sort(dentroDoGrupo));
  let sobra = limite;
  const fica = new Map<number, T[]>();
  for (const g of [1, 0, 2]) {
    const pegou = porGrupo[g]!.slice(0, Math.max(0, sobra));
    fica.set(g, pegou);
    sobra -= pegou.length;
  }
  return [...fica.get(0)!, ...fica.get(1)!, ...fica.get(2)!];
}

/** O motivo vem do banco (texto da Meta, erro interno): número comprido de telefone não circula pela página. */
export function motivoSemNumero(motivo: string | null | undefined): string {
  return String(motivo ?? '')
    // o id da mensagem na Meta (wamid.HBgM…) carrega o telefone do destinatário codificado
    .replace(/wamid\.[A-Za-z0-9+/=_-]+/gi, 'wamid.••••')
    // 10+ dígitos com separadores: +55 63 99102-1043, (63) 99102-1043, 63.99102.1043
    .replace(/\+?\(?\d(?:[\s().-]{0,2}\d){9,}/g, '••••');
}

const horaDeSaoPaulo = (d: Date) => d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Link do cartão no Kommo (mesmo padrão da ponte). Sem subdomínio válido, só o número. */
export function linkDoCartao(subdominio: string | null | undefined, leadId: number | null): string | null {
  if (!leadId || !subdominio || !/^[a-z0-9-]+$/i.test(subdominio)) return null;
  return `https://${subdominio}.kommo.com/leads/detail/${leadId}`;
}

export interface DadosDoPainel {
  onda: {
    id: string;
    estado: string;
    total: number;
    etiqueta: string;
    impressao: string;
    aprovadaPor: string | null;
    aprovadaEm: Date | null;
    pausaMotivo: string | null;
    /** 'sair' | 'falhas' | 'vencida' — só a por SAIR tem o botão Retomar */
    pausaCausa?: string | null;
    retomadaPor?: string | null;
    retomadaEm?: Date | null;
    sairAceitos?: number;
  } & Definicao;
  campanhaNome: string;
  /** a oferta que a Sofia lê quando quem recebeu responde (null = ela não sabe de oferta nenhuma) */
  oferta?: string | null;
  /** por quantos dias depois do envio a Sofia sabe da oferta (DISPARO_OFERTA_DIAS) */
  ofertaDias?: number;
  unidade: { slug: string; nome: string };
  modo: Modo;
  freios: Freios;
  resumo: { candidatos?: number; fora?: Partial<Record<MotivoDeExclusao, number>>; foraDoKommoDividido?: number };
  /** pessoas por estado: pendente, enviado, falhou… */
  contagem: Record<string, number>;
  /** quantas já têm o "receberia" gravado pelo modo seco */
  simulados: number;
  amostra: Array<{ nome: string; telefone: string }>;
  /** a tabela por pessoa (já na ordem de `ordenarDestinatarios` e cortada em LIMITE_DA_TABELA) */
  destinatarios?: LinhaDoDestinatario[];
  /** quantas pessoas a onda tem no banco, para avisar quando a tabela cortou */
  destinatariosTotal?: number;
  /** subdomínio do Kommo da unidade, para montar o link do cartão */
  kommoSubdominio?: string | null;
  /** quem recebeu a campanha nesta unidade e pediu SAIR (primeiro nome + o que escreveu) */
  saidas?: QuemSaiu[];
  conferenciaMeta: { ok: boolean; motivo?: string } | null;
  /** quem está olhando pode aprovar (sessão de um e-mail de DISPARO_APROVADORES) */
  podeAprovar: boolean;
  listaDeTeste: string[] | null;
}

const ESTADO: Record<string, string> = {
  montando: 'montando a lista…',
  montada: 'esperando a sua aprovação',
  aprovada: 'aprovada',
  pausada: 'PAUSADA',
  concluida: 'concluída',
  cancelada: 'cancelada',
};

function avisoDoModo(d: DadosDoPainel): string {
  if (d.modo === 'desligado') return '<div class="faixa seco"><b>Automação DESLIGADA nesta unidade.</b> Aprovar não manda nada; o worker ignora esta unidade.</div>';
  if (d.modo === 'seco') {
    return '<div class="faixa seco"><b>MODO SECO.</b> Esta unidade só decide e grava quem <i>receberia</i>. <b>Aprovar NÃO manda mensagem nenhuma.</b> Nada sai até alguém ligar a unidade.</div>';
  }
  if (d.listaDeTeste && d.listaDeTeste.length === 0) {
    return '<div class="faixa seco"><b>UNIDADE LIGADA, mas SEM lista de teste:</b> ninguém recebe até DISPARO_LISTA_DE_TESTE ter ESTA unidade (<code>slug=telefone,telefone</code>, ou <code>slug=*</code> para soltar a onda inteira só dela).</div>';
  }
  const teste = d.listaDeTeste ? ` Há lista de teste: só ${d.listaDeTeste.length} número(s) recebem de verdade (${d.listaDeTeste.map(telefoneMascarado).map(esc).join(', ')}).` : ' Esta unidade está com <code>*</code>: TODOS os aprovados recebem.';
  return `<div class="faixa vivo"><b>UNIDADE LIGADA.</b> Aprovando, as mensagens saem sozinhas dentro da janela e dos tetos abaixo.${teste}</div>`;
}

const ROTULO_DO_ESTADO: Record<string, { texto: string; classe: string }> = {
  enviado: { texto: 'enviado', classe: 'bom' },
  enviando: { texto: 'enviando…', classe: 'mudo' },
  falhou: { texto: 'FALHOU', classe: 'ruim' },
  saiu: { texto: 'pediu SAIR', classe: 'ruim' },
  descartado: { texto: 'descartado', classe: 'ruim' },
  pendente: { texto: 'pendente', classe: 'mudo' },
};

function tabelaPorPessoa(d: DadosDoPainel): string {
  const linhas = d.destinatarios ?? [];
  if (!linhas.length) return '<p class="mudo">Sem destinatários.</p>';
  const corpo = linhas
    .map((p) => {
      const r = ROTULO_DO_ESTADO[p.estado] ?? { texto: p.estado, classe: 'mudo' };
      // Seco: a pessoa segue pendente com o "receberia" gravado. Dizer isso, em vez de mostrar uma hora que pareça envio.
      const hora = p.enviadoEm ? horaDeSaoPaulo(p.enviadoEm) : p.simuladoEm ? `receberia (seco) ${horaDeSaoPaulo(p.simuladoEm)}` : '—';
      const url = linkDoCartao(d.kommoSubdominio, p.kommoLeadId);
      const cartao = p.kommoLeadId ? (url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${p.kommoLeadId}</a>` : String(p.kommoLeadId)) : '—';
      return `<tr><td class="esq">${esc(p.nome)}</td><td class="esq">${esc(telefoneMascarado(p.telefone))}</td><td class="esq ${r.classe}">${esc(r.texto)}</td><td class="esq">${esc(hora)}</td><td class="esq">${p.motivo ? esc(motivoSemNumero(p.motivo)) : '<span class="mudo">—</span>'}</td><td class="esq">${cartao}</td></tr>`;
    })
    .join('');
  const total = d.destinatariosTotal ?? linhas.length;
  const aviso = total > linhas.length ? `<p class="aviso">Mostrando ${linhas.length} de ${total} pessoas (enviados primeiro, depois falhas, depois pendentes). As outras ${total - linhas.length} não cabem na tabela.</p>` : '';
  return `${aviso}<div class="rolar"><table><thead><tr><th class="esq">Nome</th><th class="esq">Telefone</th><th class="esq">Estado</th><th class="esq">Hora (São Paulo)</th><th class="esq">Motivo</th><th class="esq">Cartão no Kommo</th></tr></thead><tbody>${corpo}</tbody></table></div>`;
}

export function montarPainelDaOnda(d: DadosDoPainel): string {
  const { onda, freios: f } = d;
  const saidas = d.saidas ?? [];
  const exemplos = d.amostra.slice(0, 3).map((p) => textoFinal(onda.textoModelo, valoresDasVariaveis(onda.variaveis, { primeiroNome: p.nome, unidade: d.unidade.nome })));
  const midia = onda.cabecalho ? `<p class="mudo">Cabeçalho: ${esc(onda.cabecalho.tipo)} — ${esc(onda.cabecalho.link)}</p>` : '';
  const fora = Object.entries(d.resumo.fora ?? {}).filter(([, n]) => n);
  const tabelaFora = fora.length
    ? `<table><tbody>${fora.map(([m, n]) => `<tr><td class="esq">${esc(ROTULO_DA_EXCLUSAO[m as MotivoDeExclusao] ?? m)}</td><td>${n}</td></tr>`).join('')}</tbody></table>`
    : '<p class="mudo">Ninguém ficou de fora pelas regras.</p>';
  const amostra = d.amostra.length
    ? `<table><thead><tr><th class="esq">Nome na saudação</th><th>Telefone</th></tr></thead><tbody>${d.amostra.map((p) => `<tr><td class="esq">${esc(p.nome)}</td><td>${esc(telefoneMascarado(p.telefone))}</td></tr>`).join('')}</tbody></table>`
    : '<p class="mudo">Sem destinatários.</p>';
  const contagem = Object.entries(d.contagem).filter(([, n]) => n).map(([e, n]) => `${esc(e)}: ${n}`).join(' · ');

  const meta = d.conferenciaMeta
    ? d.conferenciaMeta.ok
      ? '<p class="bom">Conferido na Meta: o modelo está APROVADO, o texto e o cabeçalho batem.</p>'
      : `<p class="ruim"><b>A Meta não confere:</b> ${esc(d.conferenciaMeta.motivo)}</p>`
    : '';

  let acao = '';
  if (onda.estado === 'montada') {
    const pode = d.podeAprovar && (d.conferenciaMeta?.ok ?? false);
    acao = `<div class="acoes">
      <button id="aprovar" ${pode ? '' : 'disabled'}>Aprovar esta onda (${onda.total} pessoas)</button>
      <button id="cancelar" class="sec">Cancelar</button>
      <p class="mudo">${!d.podeAprovar ? 'Para aprovar, entre no console com o seu e-mail de aprovador (DISPARO_APROVADORES). Quem abriu esta página com a chave de serviço só consegue ler.' : !pode ? 'A aprovação fica travada até a Meta conferir o modelo.' : 'Um clique. Sem código por e-mail.'}</p><p id="retorno" role="status"></p></div>`;
  } else if (onda.estado === 'pausada' && onda.pausaCausa === 'sair') {
    const pode = d.podeAprovar && (d.conferenciaMeta?.ok ?? false);
    acao = `<div class="acoes">
      <button id="retomar" ${pode ? '' : 'disabled'}>Retomar esta onda (aceito os ${saidas.length} pedidos de SAIR acima)</button>
      <button id="cancelar" class="sec">Cancelar esta onda</button>
      <p class="mudo">${!d.podeAprovar ? 'Só quem está em DISPARO_APROVADORES retoma, entrando no console com o seu e-mail. O Claude e a chave de serviço não retomam.' : !pode ? 'A retomada fica travada até a Meta conferir o modelo.' : `Depois de retomar, a unidade só para de novo se mais de ${f.maxSair} pessoas pedirem SAIR além destas.`}</p><p id="retorno" role="status"></p></div>`;
  } else if (onda.estado === 'aprovada' || onda.estado === 'pausada') {
    acao = `<div class="acoes"><button id="cancelar" class="sec">Parar e cancelar esta onda</button>${onda.estado === 'pausada' ? '<p class="mudo">Esta pausa não é por SAIR: não tem retomada. Cancele e monte a onda de novo depois de resolver o motivo.</p>' : ''}<p id="retorno" role="status"></p></div>`;
  }
  const blocoOferta = d.oferta
    ? `<section><h2>O que a Sofia vai saber da oferta</h2><div class="zap">${esc(d.oferta)}</div><p class="mudo">Quem receber esta mensagem e responder nos próximos ${d.ofertaDias ?? 14} dias terá esta oferta no prompt da Sofia, e o preço dela passa pela trava de preço. Ela foi copiada da campanha na montagem e vale como está: mudar a campanha depois não muda esta onda.</p></section>`
    : '<section><h2>O que a Sofia vai saber da oferta</h2><p class="mudo">Esta campanha não tem texto de oferta: a Sofia responde pela ficha de preços da unidade, e um preço diferente do da ficha, se ela o repetir, é cortado.</p></section>';
  const tabelaSaidas = saidas.length
    ? `<section><h2>Quem pediu SAIR (${saidas.length})</h2><table><thead><tr><th class="esq">Primeiro nome</th><th class="esq">O que escreveu</th></tr></thead><tbody>${saidas.map((x) => `<tr><td class="esq">${esc(x.nome)}</td><td class="esq">${x.resposta ? esc(x.resposta) : '<span class="mudo">(a mensagem não está gravada)</span>'}</td></tr>`).join('')}</tbody></table>${onda.sairAceitos ? `<p class="mudo">${onda.sairAceitos} destes já foram vistos na última retomada${onda.retomadaPor ? `, por ${esc(onda.retomadaPor)}` : ''}.</p>` : ''}</section>`
    : '';
  const retomada = onda.retomadaPor && onda.retomadaEm ? `<p class="mudo">Retomada por ${esc(onda.retomadaPor)} em ${esc(onda.retomadaEm.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }))}, vendo ${onda.sairAceitos ?? 0} pedido(s) de SAIR.</p>` : '';
  const quem = onda.aprovadaPor ? `<p class="mudo">Aprovada por ${esc(onda.aprovadaPor)} em ${esc(onda.aprovadaEm?.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) ?? '')}.</p>` : '';
  const pausa = onda.pausaMotivo ? `<p class="ruim"><b>${onda.estado === 'cancelada' ? 'Motivo' : 'Parada'}:</b> ${esc(onda.pausaMotivo)}</p>` : '';

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aprovar onda · ${esc(d.unidade.nome)}</title><style>
:root{--papel:#FBF8F9;--painel:#F4EDF0;--tinta:#2A1F25;--mudo:#6E5F67;--linha:#E5DAE0;--rosa:#B83A66;--bom:#2F7D5B;--ruim:#B4372F;--aviso:#8A5A00;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--papel:#18131A;--painel:#221B23;--tinta:#F2EAEE;--mudo:#A9989F;--linha:#3A2E36;--rosa:#EC7FA5;--bom:#63BD92;--ruim:#EE7366;--aviso:#E8B84A;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--papel);color:var(--tinta);font:16px/1.5 "Segoe UI",system-ui,sans-serif;padding:32px 16px 64px}
main{max-width:860px;margin:0 auto;display:flex;flex-direction:column;gap:26px}h1{font-size:2rem;margin:0;line-height:1.15}h2{margin:0 0 8px;font-size:1.15rem}
.olho{color:var(--rosa);font-weight:700;font-size:.78rem;letter-spacing:.08em;text-transform:uppercase}.mudo{color:var(--mudo)}.bom{color:var(--bom)}.ruim{color:var(--ruim)}p{margin:6px 0}
.fatos{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}.fatos div{background:var(--painel);border-radius:6px;padding:12px 14px;display:flex;flex-direction:column}.fatos b{font-size:1.5rem;font-variant-numeric:tabular-nums}.fatos span{color:var(--mudo);font-size:.88rem}
.faixa{border-radius:6px;padding:12px 14px;border:2px solid}.faixa.seco{border-color:var(--aviso);background:var(--painel)}.faixa.vivo{border-color:var(--ruim);background:var(--painel)}
.zap{background:var(--painel);border-left:4px solid var(--rosa);border-radius:6px;padding:14px 16px;white-space:pre-wrap;margin:8px 0}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:7px 9px;border-bottom:1px solid var(--linha);text-align:right}th{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--mudo)}.esq{text-align:left}.rolar{overflow-x:auto}.rolar td,.rolar th{font-size:.85rem}.aviso{color:var(--aviso);font-weight:700}a{color:var(--rosa)}
ul{margin:0;padding-left:1.2em}.acoes{display:flex;flex-wrap:wrap;gap:12px;align-items:center}button{font:inherit;font-weight:700;border:0;border-radius:6px;padding:12px 20px;background:var(--rosa);color:#fff;cursor:pointer}button.sec{background:var(--painel);color:var(--tinta);border:1px solid var(--linha)}button:disabled{opacity:.45;cursor:not-allowed}
</style></head><body><main>
<header><div class="olho">Disparo de campanha · aprovação</div><h1>${esc(d.campanhaNome)} · ${esc(d.unidade.nome)}</h1>
<p class="mudo">Onda ${esc(ESTADO[onda.estado] ?? onda.estado)} · lista do Kommo: etiqueta “${esc(onda.etiqueta)}” · modelo ${esc(onda.template)} (${esc(onda.idioma)})</p></header>
${avisoDoModo(d)}
<div class="fatos"><div><b>${onda.total}</b><span>pessoas vão receber</span></div><div><b>${esc(d.unidade.nome)}</b><span>unidade</span></div><div><b>${d.resumo.candidatos ?? '—'}</b><span>cartões na etiqueta</span></div><div><b>${d.simulados}</b><span>com “receberia” gravado (seco)</span></div></div>
${pausa}${quem}${retomada}
<section><h2>O texto que cada pessoa vai ler</h2>${midia}${exemplos.map((t) => `<div class="zap">${esc(t)}</div>`).join('') || '<p class="mudo">Sem destinatários para exemplificar.</p>'}<p class="mudo">Três exemplos, com o primeiro nome de cada uma já no lugar.</p>${meta}</section>
<section><h2>Quem ficou de fora, e por quê</h2>${tabelaFora}${d.resumo.foraDoKommoDividido ? `<p class="mudo">${d.resumo.foraDoKommoDividido} cartão(ões) são de outra unidade que divide este Kommo.</p>` : ''}</section>
<section><h2>Amostra de quem vai receber</h2>${amostra}<p class="mudo">${contagem ? `Estado de todos: ${contagem}.` : ''}</p></section>
<section><h2>Pessoa por pessoa</h2>${tabelaPorPessoa(d)}<p class="mudo">Hora do envio no fuso de São Paulo. “Entregue”, “lida” e “respondeu” não aparecem aqui: dependem do aviso de status da Meta, que esta tela ainda não lê.</p></section>
${blocoOferta}
${tabelaSaidas}
<section><h2>Os freios</h2><ul>
<li>Janela: ${f.janelaInicio}h às ${f.janelaFim}h${f.soDiasUteis ? ', segunda a sexta, sem feriado nacional' : ''}.</li>
<li>Teto desta unidade: ${f.tetoPorHora} por hora e ${f.tetoPorDia} por 24 horas.</li>
<li>Para a unidade se mais de ${f.maxSair} pessoas responderem SAIR.</li>
<li>Pausa a onda se ${f.falhasSeguidas} envios seguidos falharem na Meta.</li>
<li>Reconfere a franquia (consulta marcada, tratamento aberto) e o SAIR na hora de cada envio. Nunca duas vezes para a mesma pessoa na campanha.</li></ul></section>
${acao}
<script>
const id=${JSON.stringify(onda.id)},total=${JSON.stringify(onda.total)},impressao=${JSON.stringify(onda.impressao)};
const ret=document.getElementById('retorno');
async function chamar(acao,corpo){ret.textContent='…';const r=await fetch('/api/disparo/ondas/'+id+'/'+acao,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(corpo)});const j=await r.json().catch(()=>({}));ret.textContent=r.ok?'Feito. Recarregue a página.':(j.erro||j.error||('Erro '+r.status));if(r.ok)setTimeout(()=>location.reload(),900)}
document.getElementById('aprovar')?.addEventListener('click',()=>{if(confirm('Aprovar a onda de '+total+' pessoas?'))chamar('aprovar',{total,impressao})});
const saiu=${JSON.stringify(saidas.length)};
document.getElementById('retomar')?.addEventListener('click',()=>{if(confirm('Retomar a onda sabendo dos '+saiu+' pedidos de SAIR?'))chamar('retomar',{sairam:saiu})});
document.getElementById('cancelar')?.addEventListener('click',()=>{if(confirm('Cancelar esta onda?'))chamar('cancelar',{motivo:'cancelada na tela de aprovação'})});
</script>
</main></body></html>`;
}

/**
 * O que a chave de serviço (as sessões do Claude, as rotinas) NÃO recebe: o texto que o paciente escreveu ao pedir SAIR.
 * É texto livre de paciente e só o João, com a sessão dele, precisa lê-lo (para decidir a retomada). Fica o primeiro nome.
 */
export function semTextoDeSair(d: DadosDoPainel): DadosDoPainel {
  return { ...d, saidas: d.saidas?.map((s) => ({ ...s, resposta: '' })) };
}
