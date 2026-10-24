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

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** +55 63 9••••-••43: dá para o João reconhecer, não para a página circular com o telefone inteiro. */
export function telefoneMascarado(tel: string): string {
  if (!/^\d{12,13}$/.test(tel)) return '••••';
  return `+${tel.slice(0, 2)} ${tel.slice(2, 4)} 9••••-••${tel.slice(-2)}`;
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
  } & Definicao;
  campanhaNome: string;
  unidade: { slug: string; nome: string };
  modo: Modo;
  freios: Freios;
  resumo: { candidatos?: number; fora?: Partial<Record<MotivoDeExclusao, number>>; foraDoKommoDividido?: number };
  /** pessoas por estado: pendente, enviado, falhou… */
  contagem: Record<string, number>;
  /** quantas já têm o "receberia" gravado pelo modo seco */
  simulados: number;
  amostra: Array<{ nome: string; telefone: string }>;
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
  const teste = d.listaDeTeste ? ` Há lista de teste: só ${d.listaDeTeste.length} número(s) recebem de verdade (${d.listaDeTeste.map(telefoneMascarado).map(esc).join(', ') || 'nenhum'}).` : '';
  return `<div class="faixa vivo"><b>UNIDADE LIGADA.</b> Aprovando, as mensagens saem sozinhas dentro da janela e dos tetos abaixo.${teste}</div>`;
}

export function montarPainelDaOnda(d: DadosDoPainel): string {
  const { onda, freios: f } = d;
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
  } else if (onda.estado === 'aprovada' || onda.estado === 'pausada') {
    acao = `<div class="acoes"><button id="cancelar" class="sec">Parar e cancelar esta onda</button><p id="retorno" role="status"></p></div>`;
  }
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
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:7px 9px;border-bottom:1px solid var(--linha);text-align:right}th{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--mudo)}.esq{text-align:left}
ul{margin:0;padding-left:1.2em}.acoes{display:flex;flex-wrap:wrap;gap:12px;align-items:center}button{font:inherit;font-weight:700;border:0;border-radius:6px;padding:12px 20px;background:var(--rosa);color:#fff;cursor:pointer}button.sec{background:var(--painel);color:var(--tinta);border:1px solid var(--linha)}button:disabled{opacity:.45;cursor:not-allowed}
</style></head><body><main>
<header><div class="olho">Disparo de campanha · aprovação</div><h1>${esc(d.campanhaNome)} · ${esc(d.unidade.nome)}</h1>
<p class="mudo">Onda ${esc(ESTADO[onda.estado] ?? onda.estado)} · lista do Kommo: etiqueta “${esc(onda.etiqueta)}” · modelo ${esc(onda.template)} (${esc(onda.idioma)})</p></header>
${avisoDoModo(d)}
<div class="fatos"><div><b>${onda.total}</b><span>pessoas vão receber</span></div><div><b>${esc(d.unidade.nome)}</b><span>unidade</span></div><div><b>${d.resumo.candidatos ?? '—'}</b><span>cartões na etiqueta</span></div><div><b>${d.simulados}</b><span>com “receberia” gravado (seco)</span></div></div>
${pausa}${quem}
<section><h2>O texto que cada pessoa vai ler</h2>${midia}${exemplos.map((t) => `<div class="zap">${esc(t)}</div>`).join('') || '<p class="mudo">Sem destinatários para exemplificar.</p>'}<p class="mudo">Três exemplos, com o primeiro nome de cada uma já no lugar.</p>${meta}</section>
<section><h2>Quem ficou de fora, e por quê</h2>${tabelaFora}${d.resumo.foraDoKommoDividido ? `<p class="mudo">${d.resumo.foraDoKommoDividido} cartão(ões) são de outra unidade que divide este Kommo.</p>` : ''}</section>
<section><h2>Amostra de quem vai receber</h2>${amostra}<p class="mudo">${contagem ? `Estado de todos: ${contagem}.` : ''}</p></section>
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
document.getElementById('cancelar')?.addEventListener('click',()=>{if(confirm('Cancelar esta onda?'))chamar('cancelar',{motivo:'cancelada na tela de aprovação'})});
</script>
</main></body></html>`;
}
