/**
 * A página do placar de campanha, montada no servidor a partir da foto do dia. Pura (sem banco), para
 * testar com dados de exemplo.
 */
import type { Campanha } from './campanhas.js';
import type { LinhaDoPlacar, PlacarDaUnidade } from './coleta.js';

export type Foto = PlacarDaUnidade & { cambio: number | null };

/**
 * Entregues, lidas, falhas e custo vivem só no relatório da tela "Transmissões" do Kommo: a API pública
 * responde "This is a private API" ao token. Quem tem a tela aberta grava os números aqui (linha `dia = 'tela'`
 * por unidade) e a página junta com a foto do robô.
 */
export const DIA_DA_TELA = 'tela';
export type DaTela = Record<string, { enviadas?: number; entregues?: number; lidas?: number; respondidas?: number; falhas?: number; custoUsd?: number }>;

export function juntarComATela(foto: Foto, tela: DaTela | undefined): Foto {
  if (!tela) return foto;
  return {
    ...foto,
    linhas: foto.linhas.map((l) => {
      const t = tela[l.grupo];
      if (!t) return l;
      return {
        ...l,
        enviadas: t.enviadas ?? l.enviadas,
        entregues: t.entregues ?? l.entregues,
        lidas: t.lidas ?? l.lidas,
        falhas: t.falhas ?? l.falhas,
        custoUsd: t.custoUsd ?? l.custoUsd,
        respondidasKommo: t.respondidas ?? l.respondidasKommo,
      };
    }),
  };
}


const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const n = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString('pt-BR'));
const reais = (usd: number | null, cambio: number | null) =>
  usd == null ? '—' : cambio ? `R$ ${(usd * cambio).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `US$ ${usd.toFixed(2)}`;
const minutos = (m: number | null) => (m == null ? '—' : m < 60 ? `${m} min` : `${Math.round(m / 60)} h`);
const COR: Record<string, string> = { GREEN: 'verde', YELLOW: 'amarelo', RED: 'vermelho', UNKNOWN: 'sem leitura' };

type Soma = Pick<LinhaDoPlacar, 'naTransmissao' | 'enviadas' | 'entregues' | 'lidas' | 'falhas' | 'custoUsd' | 'responderam' | 'sairam' | 'agendaram' | 'compareceram' | 'tratamentos' | 'receita' | 'equipeEntrou'>;

function somar(linhas: LinhaDoPlacar[]): Soma {
  const s = (k: keyof Soma) => {
    const vs = linhas.map((l) => l[k] as number | null);
    return vs.some((v) => v == null) && vs.every((v) => v == null) ? null : vs.reduce<number>((a, v) => a + (v ?? 0), 0);
  };
  return {
    naTransmissao: s('naTransmissao') ?? 0, enviadas: s('enviadas'), entregues: s('entregues'), lidas: s('lidas'), falhas: s('falhas'),
    custoUsd: s('custoUsd'), responderam: s('responderam') ?? 0, sairam: s('sairam') ?? 0, agendaram: s('agendaram') ?? 0,
    compareceram: s('compareceram') ?? 0, tratamentos: s('tratamentos') ?? 0, receita: s('receita') ?? 0, equipeEntrou: s('equipeEntrou') ?? 0,
  };
}

function funil(s: Soma): string {
  const etapas: Array<[string, number | null]> = [
    ['Na transmissão', s.naTransmissao], ['Enviadas', s.enviadas], ['Entregues', s.entregues], ['Lidas', s.lidas],
    ['Responderam', s.responderam], ['Agendaram', s.agendaram], ['Compareceram', s.compareceram], ['Fecharam tratamento', s.tratamentos],
  ];
  const max = Math.max(1, ...etapas.map(([, v]) => v ?? 0));
  return `<div class="funil">${etapas
    .map(([rot, v]) => `<div class="rot">${rot}</div><div class="trilho"><div class="barra${v === 0 ? ' zero' : ''}" style="width:${v ? Math.max(1, (100 * v) / max).toFixed(1) : 0}%"></div></div><div class="num${v === 0 ? ' zero' : ''}">${n(v)}</div>`)
    .join('')}</div>`;
}

export function montarPainel(campanha: Pick<Campanha, 'nome' | 'fim'>, dia: string | null, unidades: Foto[]): string {
  const cambio = unidades.find((u) => u.cambio)?.cambio ?? null;
  const grupos = new Map<string, { rotulo: string; ordem: number; linhas: Array<LinhaDoPlacar & { unidade: string; nomeUnidade: string }> }>();
  for (const u of unidades) {
    for (const l of u.linhas) {
      const g = grupos.get(l.grupo) ?? { rotulo: l.rotulo, ordem: l.ordem, linhas: [] };
      g.linhas.push({ ...l, unidade: u.unidade, nomeUnidade: u.nome });
      grupos.set(l.grupo, g);
    }
  }
  const ordenados = [...grupos.entries()].sort((a, b) => b[1].ordem - a[1].ordem);

  const secoes = ordenados
    .map(([chave, g]) => {
      const s = somar(g.linhas);
      const conversas = unidades.flatMap((u) => u.conversas.filter((c) => c.grupo === chave).map((c) => ({ ...c, nomeUnidade: u.nome })));
      const tabela = g.linhas
        .map(
          (l) => `<tr><td>${esc(l.nomeUnidade)}</td><td>${n(l.enviadas)}</td><td>${n(l.entregues)}</td><td>${n(l.lidas)}</td><td>${n(l.responderam)}</td><td>${n(l.sairam)}</td><td class="${l.agendaram ? 'bom' : ''}">${n(l.agendaram)}</td><td>${n(l.compareceram)}</td><td>${n(l.tratamentos)}</td><td>${n(l.falhas)}</td><td>${reais(l.custoUsd, cambio)}</td></tr>`,
        )
        .join('');
      const lista = conversas.length
        ? `<table><thead><tr><th>Quem</th><th class="esq">Unidade</th><th>Sofia respondeu</th><th>Equipe entrou</th><th>Resultado</th></tr></thead><tbody>${conversas
            .sort((a, b) => a.respondeuEm - b.respondeuEm)
            .map((c) => `<tr><td>${esc(c.nome)}</td><td class="esq">${esc(c.nomeUnidade)}</td><td>${minutos(c.sofiaMin)}</td><td>${c.equipeMin == null ? '<span class="ruim">não</span>' : minutos(c.equipeMin)}</td><td>${c.compareceu ? '<span class="bom">compareceu</span>' : c.agendou ? '<span class="bom">agendou</span>' : c.saiu ? 'pediu para sair' : '—'}</td></tr>`)
            .join('')}</tbody></table>`
        : '<p class="mudo">Ninguém respondeu ainda.</p>';
      return `<section><h2>${esc(g.rotulo)}</h2>
        <div class="fatos"><div><b>${reais(s.custoUsd, cambio)}</b><span>custo na Meta</span></div><div><b>${n(s.sairam)}</b><span>pediram para sair</span></div><div><b>${s.receita ? `R$ ${s.receita.toLocaleString('pt-BR')}` : '—'}</b><span>em tratamentos fechados</span></div><div><b>${n(s.equipeEntrou)} de ${n(s.responderam)}</b><span>conversas com alguém da equipe</span></div></div>
        ${funil(s)}
        <div class="rolar"><table><thead><tr><th>Unidade</th><th>Enviadas</th><th>Entregues</th><th>Lidas</th><th>Responderam</th><th>Saíram</th><th>Agendaram</th><th>Compareceram</th><th>Tratamento</th><th>Falhas</th><th>Custo</th></tr></thead><tbody>${tabela}</tbody></table></div>
        <h3>Quem respondeu</h3><div class="rolar">${lista}</div></section>`;
    })
    .join('');

  const saude = unidades
    .filter((u) => u.qualidade || u.avisos.length)
    .map((u) => `<li><b>${esc(u.nome)}</b>: ${u.qualidade ? `número ${esc(COR[u.qualidade] ?? u.qualidade)}${u.limiteDeEnvio ? ` · limite ${esc(u.limiteDeEnvio)}` : ''}` : ''}${u.avisos.length ? ` <span class="ruim">${esc(u.avisos.join('; '))}</span>` : ''}</li>`)
    .join('');

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Placar · ${esc(campanha.nome)}</title><style>
:root{--papel:#FBF8F9;--painel:#F4EDF0;--tinta:#2A1F25;--mudo:#6E5F67;--linha:#E5DAE0;--rosa:#B83A66;--bom:#2F7D5B;--ruim:#B4372F;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--papel:#18131A;--painel:#221B23;--tinta:#F2EAEE;--mudo:#A9989F;--linha:#3A2E36;--rosa:#EC7FA5;--bom:#63BD92;--ruim:#EE7366;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--papel);color:var(--tinta);font:16px/1.5 "Segoe UI",system-ui,sans-serif;padding:32px max(16px,env(safe-area-inset-left)) 64px}
main{max-width:1000px;margin:0 auto;display:flex;flex-direction:column;gap:40px}h1{font-size:2.2rem;margin:0;line-height:1.1}h2{margin:0 0 12px;font-size:1.4rem}h3{margin:18px 0 6px;font-size:1rem}
.olho{color:var(--rosa);font-weight:700;font-size:.78rem;letter-spacing:.08em;text-transform:uppercase}.mudo{color:var(--mudo)}section{display:flex;flex-direction:column;gap:14px}
.fatos{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px}.fatos div{background:var(--painel);border-radius:6px;padding:12px 14px;display:flex;flex-direction:column}.fatos b{font-size:1.4rem;font-variant-numeric:tabular-nums}.fatos span{color:var(--mudo);font-size:.88rem}
.funil{display:grid;grid-template-columns:minmax(110px,160px) 1fr 60px;gap:8px 12px;align-items:center}.trilho{height:22px;background:var(--painel);border-radius:3px;overflow:hidden}.barra{height:100%;background:var(--rosa)}.barra.zero{width:3px!important;background:var(--ruim)}.num{text-align:right;font-weight:700;font-variant-numeric:tabular-nums}.num.zero{color:var(--ruim)}
.rolar{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:8px 9px;border-bottom:1px solid var(--linha);text-align:right;white-space:nowrap}th{font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;color:var(--mudo)}th:first-child,td:first-child,.esq{text-align:left}
.bom{color:var(--bom);font-weight:700}.ruim{color:var(--ruim)}ul{margin:0;padding-left:1.2em}footer{font-size:.85rem;color:var(--mudo);border-top:1px solid var(--linha);padding-top:14px}
</style></head><body><main>
<header><div class="olho">Placar de disparo</div><h1>${esc(campanha.nome)}</h1><p class="mudo">${dia ? `Foto de ${esc(dia.split('-').reverse().join('/'))}. Agendamento conta até ${esc(campanha.fim.split('-').reverse().join('/'))}.` : 'Ainda sem coleta.'} O robô atualiza todo dia às 17h.</p></header>
${secoes || '<p class="mudo">Nenhum dado ainda.</p>'}
${saude ? `<section><h2>Avisos</h2><ul>${saude}</ul></section>` : ''}
<footer>Enviadas: quem recebeu a mensagem automática da transmissão. Entregues, lidas e custo: relatório da tela Transmissões do Kommo, gravado quando alguém confere (a API não entrega esse relatório). Respostas: mensagens de cada cartão (Kommo e o banco da Sofia). Agendou e compareceu: avaliações na agenda da franquia, cruzadas pelo nome e confirmadas pelo telefone. ${cambio ? `Dólar a R$ ${cambio.toFixed(2)}.` : ''}</footer>
</main></body></html>`;
}
